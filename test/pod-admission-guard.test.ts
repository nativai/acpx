import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  admitCreate,
  admitWake,
  releaseAdmittedWake,
  ticketFor,
} from "../src/capacity/admission.js";
import { appendDecisionLog } from "../src/capacity/ledger.js";
import {
  COMMAND_TABLE,
  PRE_COMMANDER_PATHS,
  type CommandClass,
} from "../src/pod/command-classes.js";
import { PodForeignWriteError } from "../src/pod/foreign-write-guard.js";
import { routeFor } from "../src/pod/placement-step.js";

// Block A9 — carried from the A8 TE (F4, F5): the admission path must not swallow the A-8 guard.
//   F5: `admitWake`, `admitCreate`, `releaseAdmittedWake` and a ticket's `bind`/`release` caught every
//       fault of the ledger lock and failed OPEN (admitted without a check, or went silent) — so in an
//       agent pod `pod_foreign_write` was swallowed.
//   F4: `appendDecisionLog` appended from an agent pod with no guard on the lock-free wake paths.
// The agent pod is C1.1's test seam: `ACPX_POD_TEST_HOME` leads into a sandbox whose `.nv-agent` is the
// place file; the admission dir is a path UNDER that sandbox's state home.

const SAVED = {
  HOME: process.env.HOME,
  ACPX_STATE_HOME: process.env.ACPX_STATE_HOME,
  ACPX_POD_TEST_HOME: process.env.ACPX_POD_TEST_HOME,
  ACPX_ADMISSION_DIR: process.env.ACPX_ADMISSION_DIR,
};

function sandbox(place: "agent-pod" | "control"): { env: NodeJS.ProcessEnv; dir: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpx-adg-")));
  if (place === "agent-pod") {
    fs.writeFileSync(path.join(home, ".nv-agent"), "ag-adg\n");
  }
  const dir = path.join(home, ".acpx", "admission");
  process.env.HOME = home;
  delete process.env.ACPX_STATE_HOME;
  process.env.ACPX_POD_TEST_HOME = home;
  process.env.ACPX_ADMISSION_DIR = dir;
  return { env: { ...process.env }, dir };
}

test.afterEach(() => {
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const refused = (error: unknown) =>
  error instanceof PodForeignWriteError &&
  error.file === "ledger" &&
  error.message.startsWith("acpx: REFUSED reason=pod_foreign_write file=ledger") &&
  error.outputCode === "USAGE";

const wakeTarget = { id: "target-1", agentCommand: "claude" };
const withIdentity = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...env,
  ACPX_SESSION_RECORD_ID: "caller-1",
});

function noTrace(dir: string): void {
  assert.equal(fs.existsSync(dir), false, "not even the admission directory was created");
}

test("K1: admitWake in an agent pod answers not-gated `agent-pod` for every class and verb, with NO ledger, lock or log I/O (flips the first A9 build's F5-1)", async () => {
  const { env, dir } = sandbox("agent-pod");
  const target = wakeTarget;
  const expected = { decision: "not-gated", why: "agent-pod" };
  for (const flagClass of ["delivery", "automation"] as const) {
    assert.deepEqual(
      await admitWake({ verb: "capacity admit-wake", target, flagClass }, env),
      expected,
      flagClass,
    );
  }
  // inferred class (an agent identity), no class at all (a person), a `set` and a closed record with a message id
  assert.deepEqual(await admitWake({ verb: "prompt", target }, withIdentity(env)), expected);
  assert.deepEqual(await admitWake({ verb: "prompt", target }, env), expected);
  assert.deepEqual(await admitWake({ verb: "set", setting: "effort", target }, env), expected);
  assert.deepEqual(
    await admitWake({ verb: "prompt", target, closedWithMessageId: true }, withIdentity(env)),
    expected,
  );
  noTrace(dir);
});

test("F5: admitCreate in an agent pod still rejects pod_foreign_write — an unconfigured box is not an excuse to pass", async () => {
  const { env, dir } = sandbox("agent-pod");
  await assert.rejects(
    admitCreate({ verb: "sessions new", agentCommand: "claude" }, withIdentity(env)),
    refused,
  );
  noTrace(dir);
});

test("F5: releaseAdmittedWake and a ticket's bind / release reject in an agent pod instead of going silent", async () => {
  const { env, dir } = sandbox("agent-pod");
  await assert.rejects(
    releaseAdmittedWake(
      { key: "wake:x", expiresAt: new Date(Date.now() + 1000).toISOString() },
      env,
    ),
    refused,
  );
  const ticket = ticketFor(dir, "adm-1");
  await assert.rejects(ticket.release(), refused);
  await assert.rejects(ticket.bind("session-1"), refused);
  noTrace(dir);
});

test("F4: the decision log's appender rejects in an agent pod before it creates the log directory", async () => {
  const { dir } = sandbox("agent-pod");
  await assert.rejects(appendDecisionLog(dir, { decision: "x" }, new Date()), refused);
  noTrace(dir);
});

test("NEGATIVE: on the control pod the same calls behave as before (the guard is the agent pod's alone)", async () => {
  const { env, dir } = sandbox("control");
  // unconfigured box (no /etc/podinfo): not gated, and the wake is still LOGGED — the append works.
  const decision = await admitWake(
    { verb: "capacity admit-wake", target: wakeTarget, flagClass: "delivery" },
    { ...env, ACPX_CAPACITY_PODINFO_DIR: path.join(dir, "no-podinfo") },
  );
  assert.deepEqual(decision, { decision: "not-gated", why: "unconfigured" });
  const logs = fs.readdirSync(path.join(dir, "log"));
  assert.equal(logs.length, 1);
  assert.match(fs.readFileSync(path.join(dir, "log", logs[0]), "utf8"), /"why":"unconfigured"/u);
  assert.equal(
    await admitCreate(
      { verb: "sessions new", agentCommand: "claude" },
      { ...withIdentity(env), ACPX_CAPACITY_PODINFO_DIR: path.join(dir, "no-podinfo") },
    ),
    undefined,
  );
  await releaseAdmittedWake({ key: "wake:x", expiresAt: new Date().toISOString() }, env);
});

test("NEGATIVE: an agent pod using an admission dir OF ITS OWN (a suite, a rig) is not stopped (A-26)", async () => {
  const { env } = sandbox("agent-pod");
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-adg-own-"));
  await appendDecisionLog(own, { decision: "x" }, new Date());
  assert.equal(fs.existsSync(path.join(own, "log")), true);
  assert.equal(typeof env, "object");
});

// ── conformance: A-8's claim "no classified command reaches the guard", for the wake gate's own path ──
// A-8's row (pod-command-classes.test.ts) covers the classes that may touch box-wide stores (`create`,
// `control-store`: never LOCAL in an agent pod). K1 was the path it could not see: a class that IS local in
// an agent pod (`owner-ensure`, `owner-if-pod`, `one-shot`) reaching the ledger through the wake gate. So
// the callers of the ledger's entry points are DISCOVERED, and each registered caller says which commands
// it serves; a caller that serves a command LOCAL in either agent-pod place may only call an entry that is
// answered without ledger I/O in an agent pod. A fresh caller, registered nowhere, is red.

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const LEDGER_ENTRIES = new Set([
  "admitWake",
  "admitCreate",
  "releaseAdmittedWake",
  "ticketFor",
  "withAdmissionLock",
  "writeLedgerFile",
  "appendDecisionLog",
]);
/**
 * Every OTHER value exported by the two ledger modules — none of them writes the ledger, takes its lock or
 * appends its log (pure builders, readers, constants). A fresh export is in neither set until someone
 * classifies it: the completeness row below is red for it (K4: `ticketFor` was exported and unlisted).
 */
const NOT_LEDGER_ENTRIES = new Set([
  "takeAdmissionClassFromEnv",
  "declaredAdmissionClass",
  "buildClause",
  "capacityRefusal",
  "cpuRefuses",
  "readPendingReservationsForProbe",
  "readWaitingForProbe",
  "isFreshSuccessor",
  "wakeRefusal",
  "ADMISSION_TTL_MS",
  "ADMISSION_TTL_AUTOMATION_MS",
  "admissionDir",
  "AdmissionLockTimeoutError",
  "readAdmissionLockState",
  "ADMISSION_BUSY_RETRY_AFTER_S",
  "containerInstance",
  "readLedgerFile",
  "liveEntries",
  "ttlFor",
  "boundEntry",
  "reservationsOf",
  "newBuildEntry",
  "buildExpiry",
  "newEntry",
]);
/** Entries a LOCAL-in-an-agent-pod command may reach. `releaseAdmittedWake` only follows an `admitted` decision, which `admitWake` never yields in an agent pod (row K1 above). */
const SAFE_IN_AGENT_POD = new Set(["admitWake", "releaseAdmittedWake"]);
type Caller = { entries: string[]; classes: CommandClass[]; verbs?: string[]; why: string };
const CALLERS: Record<string, Caller> = {
  "cli/session/wake-gate.ts": {
    entries: ["admitWake", "releaseAdmittedWake"],
    classes: ["owner-ensure", "owner-if-pod", "one-shot"],
    why: "the send and set wake gates",
  },
  "cli/command-handlers.ts": {
    entries: ["admitCreate"],
    classes: ["create"],
    why: "the create gate (class create passes through in an agent pod)",
  },
  "cli/capacity-command.ts": {
    entries: ["admitWake"],
    classes: ["control-store"],
    why: "capacity admit-wake",
  },
  "capacity/run-build.ts": {
    entries: ["appendDecisionLog", "withAdmissionLock", "writeLedgerFile"],
    classes: [],
    verbs: ["capacity run-build"],
    why: "release builds (controlPodOnly)",
  },
};

// ── discovery by a REAL PARSE (K4) ───────────────────────────────────────────────────────────────────
// The first version of this row read importers with a regex over `{ … } from "…"`, which cannot see a
// namespace import (`import * as ledger`), an import gathered by `Promise.all([import(…), …])`, a
// `.then(m => m.f())`, a re-export or an alias. Every form below is read from the TypeScript AST, and a
// form whose use cannot be followed (a namespace that escapes, an unawaited `import()`) counts as the
// WHOLE entry set — never as nothing: a caller we cannot read is a caller we must see registered.

const LEDGER_MODULES = new Set(["capacity/admission.js", "capacity/ledger.js"]);

function resolvesToLedger(rel: string, specifier: string): boolean {
  return (
    specifier.startsWith(".") &&
    LEDGER_MODULES.has(path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier)))
  );
}

const stringOf = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;

/** The entries a binding pattern takes out of the module: `{a, b: c}` is a and b; a rest or a computed key is all. */
function patternEntries(pattern: ts.BindingName, sf: ts.SourceFile, add: Adder): void {
  if (ts.isIdentifier(pattern)) {
    identifierUses(pattern.text, sf, add);
    return;
  }
  if (!ts.isObjectBindingPattern(pattern)) {
    add(undefined);
    return;
  }
  for (const element of pattern.elements) {
    const key = element.propertyName ?? element.name;
    const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
    add(element.dotDotDotToken || name === undefined ? undefined : name);
  }
}

/** `undefined` adds EVERY entry (an unreadable use); a name adds itself if it is a ledger entry. */
type Adder = (name: string | undefined) => void;

/** How an identifier bound to the module namespace is used: `ns.f` is f; any other use lets it escape. */
function identifierUses(local: string, sf: ts.SourceFile, add: Adder): void {
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === local) {
      const parent = node.parent;
      const declaresIt =
        ts.isNamespaceImport(parent) ||
        (ts.isBindingElement(parent) && parent.name === node) ||
        (ts.isVariableDeclaration(parent) && parent.name === node);
      if (declaresIt) {
        // the binding's own declaration: not a use
      } else if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        add(parent.name.text);
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        add(stringOf(parent.argumentExpression));
      } else {
        add(undefined);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const PROMISE_COMBINATORS = new Set(["all", "allSettled"]);

/** What `import("…")` hands to its surroundings. */
function dynamicImportEntries(call: ts.CallExpression, sf: ts.SourceFile, add: Adder): void {
  let node: ts.Node = call;
  let awaited = false;
  const lift = () => {
    while (
      node.parent &&
      (ts.isAwaitExpression(node.parent) ||
        ts.isParenthesizedExpression(node.parent) ||
        ts.isAsExpression(node.parent))
    ) {
      awaited ||= ts.isAwaitExpression(node.parent);
      node = node.parent;
    }
  };
  lift();
  let parent = node.parent;
  // a stored PROMISE (`const p = import(…)`) is not the module: only an awaited one can be followed
  if (awaited && ts.isVariableDeclaration(parent) && parent.initializer === node) {
    patternEntries(parent.name, sf, add);
    return;
  }
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === node &&
    parent.name.text !== "then"
  ) {
    add(parent.name.text);
    return;
  }
  if (ts.isArrayLiteralExpression(parent)) {
    // `await Promise.all([import(a), import(b)])`, destructured at once
    // A spread anywhere in the array shifts the indexes the destructuring is read against: not followed → everything (K4-2).
    if (parent.elements.some((element) => ts.isSpreadElement(element))) {
      add(undefined);
      return;
    }
    const index = parent.elements.indexOf(node as ts.Expression);
    const combinator = parent.parent;
    if (
      ts.isCallExpression(combinator) &&
      ts.isPropertyAccessExpression(combinator.expression) &&
      PROMISE_COMBINATORS.has(combinator.expression.name.text) &&
      combinator.arguments[0] === parent
    ) {
      node = combinator;
      lift();
      parent = node.parent;
      if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        ts.isArrayBindingPattern(parent.name)
      ) {
        const element = parent.name.elements[index];
        if (element !== undefined && ts.isBindingElement(element)) {
          patternEntries(element.name, sf, add);
          return;
        }
      }
    }
  }
  add(undefined); // `.then(…)`, a returned or stored promise, …: not followed — counts as everything
}

/** Every ledger entry each source file imports, by any import form. `capacity/admission|ledger.ts` themselves are skipped. */
function ledgerCallers(files: Iterable<[string, string]>): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const [rel, text] of files) {
    if (rel === "capacity/admission.ts" || rel === "capacity/ledger.ts") {
      continue;
    }
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const names = new Set<string>();
    const add: Adder = (name) => {
      if (name === undefined) {
        for (const entry of LEDGER_ENTRIES) {
          names.add(entry);
        }
      } else if (LEDGER_ENTRIES.has(name)) {
        names.add(name);
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isImportDeclaration(node) &&
        resolvesToLedger(rel, stringOf(node.moduleSpecifier) ?? "")
      ) {
        const clause = node.importClause;
        const bindings = clause?.namedBindings;
        if (clause && !clause.isTypeOnly && bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            add(element.isTypeOnly ? "" : (element.propertyName ?? element.name).text);
          }
        } else if (clause && !clause.isTypeOnly && bindings && ts.isNamespaceImport(bindings)) {
          identifierUses(bindings.name.text, sf, add);
        }
      } else if (ts.isImportEqualsDeclaration(node)) {
        const reference = node.moduleReference;
        if (
          ts.isExternalModuleReference(reference) &&
          resolvesToLedger(rel, stringOf(reference.expression) ?? "")
        ) {
          add(undefined);
        }
      } else if (
        ts.isExportDeclaration(node) &&
        resolvesToLedger(rel, stringOf(node.moduleSpecifier) ?? "")
      ) {
        const clause = node.exportClause;
        if (!node.isTypeOnly && clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            add(element.isTypeOnly ? "" : (element.propertyName ?? element.name).text);
          }
        } else if (!node.isTypeOnly) {
          add(undefined); // `export * from` / `export * as ns from`
        }
      } else if (ts.isCallExpression(node)) {
        const specifier = stringOf(node.arguments[0]);
        const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
        if (
          (isDynamic || isRequire) &&
          specifier !== undefined &&
          resolvesToLedger(rel, specifier)
        ) {
          if (isDynamic) {
            dynamicImportEntries(node, sf, add);
          } else {
            add(undefined);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (names.size > 0) {
      found.set(rel, names);
    }
  }
  return found;
}

/** Every identifier a binding name declares (`{ a, b: [c, ...d] }` → a, c, d). */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : [],
  );
}

/**
 * The values a module exports, in EVERY form (K4-1). A form it cannot enumerate is returned as a marker that no set
 * contains (`*:<specifier>` for `export * from` / `export * as ns from`), so the completeness row is RED on it —
 * "classify or enumerate" — instead of passing blind: a ledger function re-exported through `export *` from a submodule
 * was invisible to the first version. Forms: `export function|class|enum|namespace|const|let|var` (destructuring
 * included), `export default <declaration or expression>`, `export { a as b }`, `export * from`, `export * as ns from`
 * and `export =`. Type-only forms export no value and are skipped.
 */
function exportedValues(text: string): string[] {
  const sf = ts.createSourceFile("m.ts", text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const statement of sf.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (ts.isExportAssignment(statement)) {
      out.push(statement.isExportEquals === true ? "export=" : "default");
    } else if (exported && isDefault) {
      out.push("default");
    } else if (
      exported &&
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.name &&
      ts.isIdentifier(statement.name)
    ) {
      out.push(statement.name.text);
    } else if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        out.push(...bindingNames(declaration.name));
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        out.push(...clause.elements.filter((e) => !e.isTypeOnly).map((e) => e.name.text));
      } else {
        const from = ts.isStringLiteralLike(statement.moduleSpecifier ?? sf)
          ? (statement.moduleSpecifier as ts.StringLiteral).text
          : "?";
        out.push(`*:${from}`); // `export * from` / `export * as ns from`: not enumerable here
      }
    }
  }
  return out;
}

/**
 * Uses of a module system this discovery cannot follow (K4-2, FN-2/FN-3): code that could load the ledger under a name
 * no specifier shows. Each SITE is returned as `<file> | <kind> | <the call as written>` with how many times it occurs, so
 * the registry below can pin every site exactly (a second site in a registered file is a new key, or a higher count).
 *
 * Kinds: a non-literal `import(x)`; `createRequire` however it is reached — a named import (aliased or not), a
 * `node:module` default or namespace binding's `.createRequire`, `process.getBuiltinModule(…).createRequire`;
 * `getBuiltinModule(…)` itself; `new Function(…)` / `Function(…)` / `eval(…)`; a non-literal `require(x)`; and a custom
 * loader's `.import(…)` / `.require(…)`, also as `loader["import"](…)`; and `new Worker(…)` of `node:worker_threads`
 * (aliased, or reached as `wt.Worker`) — a worker loads whatever it likes, by path or as `eval: true` code (lows-r3 FN-2a).
 *
 * NOT seen — named so nobody reads the registry as a proof of absence: indirect eval `(0, eval)(…)`, `globalThis.eval` /
 * `globalThis.Function` / `(() => {}).constructor(…)`; `node:vm` (`runInThisContext`, `new vm.Script`, `compileFunction`);
 * a `createRequire` held in a variable or destructured / renamed out of a DYNAMIC `node:module` load (`const { createRequire:
 * mk } = await import("node:module")`), `createRequire.call(…)`; a loader member not called directly (`loader.import.call(…)`,
 * `Reflect.apply(loader.import, …)`, a computed key); `module.register(…)` (loader hooks); `child_process.fork(modulePath)`.
 * Also unseen, for `Worker` itself (R2-I2): a `Worker` destructured out of a dynamic `import("node:worker_threads")` /
 * `require("node:worker_threads")`, held in a variable (`const W = wt.Worker; new W(…)`), re-exported under another name by a
 * local module, reached as `wt["Worker"]`, or built with `Reflect.construct(Worker, […])`. Also unseen (TE-7115-2):
 * `class T extends Worker`; `new (wt.Worker)(…)`; `new (Worker as any)(…)`; a non-destructured namespace from
 * `await import("node:worker_threads")` / `require(…)`; `import wt = require("node:worker_threads")`;
 * `import("node:worker_threads").then((m) => new m.Worker(…))`. And (TE-61de-5) the namespace used INLINE, never held —
 * `new (require("node:worker_threads").Worker)(…)`, `new (await import("node:worker_threads")).Worker(…)`; other callee
 * wrappers — `new Worker!(…)`, `new (<any>Worker)(…)`, `new wt?.Worker(…)`; a `Worker` taken out of a STATIC namespace by
 * destructuring (`const { Worker: W } = wt`); and the other ways to start a thread or process that is not `Worker` or
 * `child_process.fork`: `cluster.fork` / `cluster.setupPrimary({ execArgv })` and `spawn(process.execPath, …)`. The lists above
 * are EXAMPLES of what is unseen, not its boundary: this scan is a guard against the plain forms, not a proof of absence.
 * None of those is in `src/` today (`grep -rnE` over src/, lows-r3 TE).
 *
 * The KEY is the FULL call text as written, never a prefix, normalised by TOKEN (`normalizedCallText`): an edit anywhere in a
 * registered call — a preload in `execArgv`, a raised `resourceLimits`, a changed string/template literal, a line moved into or
 * out of a `//` comment, a line break that ASI reads as a statement end — is a new key and so red (bricks 7115375b, 61de55d6).
 * What a `new Worker(SRC, { eval: true })` RUNS is pinned separately: `workerSourceModules` / `KNOWN_WORKER_SOURCE_MODULES`.
 */
function unfollowableSites(files: Iterable<[string, string]>): Map<string, number> {
  const found = new Map<string, number>();
  for (const [rel, text] of files) {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    // bindings of `node:module` / `module`: the aliases of createRequire, and the names of the module object itself
    const createRequireNames = new Set<string>(["createRequire"]);
    const moduleObjects = new Set<string>();
    // bindings of `node:worker_threads`: the aliases of `Worker`, and the names of the module object itself
    const workerNames = new Set<string>();
    const workerModules = new Set<string>();
    for (const statement of sf.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ["node:worker_threads", "worker_threads"].includes(
          stringOf(statement.moduleSpecifier) ?? "",
        )
      ) {
        const bindings = statement.importClause?.namedBindings;
        if (statement.importClause?.name) {
          workerModules.add(statement.importClause.name.text);
        }
        if (bindings && ts.isNamespaceImport(bindings)) {
          workerModules.add(bindings.name.text);
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text === "Worker") {
              workerNames.add(element.name.text);
            }
          }
        }
      }
      if (
        ts.isImportDeclaration(statement) &&
        ["node:module", "module"].includes(stringOf(statement.moduleSpecifier) ?? "")
      ) {
        const bindings = statement.importClause?.namedBindings;
        if (statement.importClause?.name) {
          moduleObjects.add(statement.importClause.name.text);
        }
        if (bindings && ts.isNamespaceImport(bindings)) {
          moduleObjects.add(bindings.name.text);
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text === "createRequire") {
              createRequireNames.add(element.name.text);
            }
          }
        }
      }
    }
    const note = (kind: string, node: ts.Node): void => {
      const written = normalizedCallText(node, sf);
      const key = `${rel} | ${kind} | ${written}`;
      found.set(key, (found.get(key) ?? 0) + 1);
    };
    const memberName = (callee: ts.Expression): string | undefined => {
      if (ts.isPropertyAccessExpression(callee)) {
        return callee.name.text;
      }
      return ts.isElementAccessExpression(callee) ? stringOf(callee.argumentExpression) : undefined;
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Function"
      ) {
        note("new Function", node);
      } else if (
        ts.isNewExpression(node) &&
        ((ts.isIdentifier(node.expression) && workerNames.has(node.expression.text)) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "Worker" &&
            ts.isIdentifier(node.expression.expression) &&
            workerModules.has(node.expression.expression.text)))
      ) {
        note("new Worker", node);
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const member = memberName(callee);
        const receiver =
          ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
            ? callee.expression
            : undefined;
        if (callee.kind === ts.SyntaxKind.ImportKeyword) {
          if (stringOf(node.arguments[0]) === undefined) {
            note("non-literal import()", node);
          }
        } else if (ts.isIdentifier(callee) && createRequireNames.has(callee.text)) {
          note("createRequire", node);
        } else if (member === "createRequire") {
          note("createRequire", node); // module.createRequire(…), process.getBuiltinModule("node:module").createRequire(…)
        } else if (
          member === "getBuiltinModule" ||
          (ts.isIdentifier(callee) && callee.text === "getBuiltinModule")
        ) {
          note("getBuiltinModule", node);
        } else if (ts.isIdentifier(callee) && ["Function", "eval"].includes(callee.text)) {
          note(callee.text === "eval" ? "eval" : "new Function", node);
        } else if (ts.isIdentifier(callee) && callee.text === "require") {
          if (stringOf(node.arguments[0]) === undefined) {
            note("non-literal require()", node);
          }
        } else if (member === "import" || member === "require") {
          // a custom loader's `.import(…)` / `.require(…)` — except a call ON a `node:module` object's own members
          if (
            !(
              receiver &&
              ts.isIdentifier(receiver) &&
              moduleObjects.has(receiver.text) &&
              member === "require"
            )
          ) {
            note(
              member === "import" ? "custom loader .import()" : "custom loader .require()",
              node,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

/**
 * A call as written, normalised BY TOKEN (brick 61de55d6, TE-7115-1): string / template / regex literals and comments are kept
 * VERBATIM; spaces and line breaks between tokens collapse to one space — except a line break that carries meaning, which stays
 * a "\n": the one that ends a `//` comment (collapsing it would pull the next token INTO the comment), and one where
 * automatic semicolon insertion could act (the previous token can end a statement and the next is not a continuer: `return\n x`
 * is not `return x`; likewise before a block comment, and for CR / U+2028 / U+2029). A re-wrap where whitespace ALREADY separates
 * the tokens (after `,` `:` or at `{ ` / `( ` that carry a space) keys the same; a break introduced where the one-line form has
 * NO space — `(` / `[` / `{` against its first token — is a different key (a false red, the safe direction: a re-registration),
 * and so is an added trailing comma. An edit inside a literal or across a comment is red (TE-61de-4).
 */
/** The JS line terminators: LF, CR, U+2028, U+2029 (TE-61de-3b: not only "\n"). */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/u;

function normalizedCallText(node: ts.Node, sf: ts.SourceFile): string {
  const leaves: ts.Node[] = [];
  const collect = (n: ts.Node): void => {
    if (n.kind >= ts.SyntaxKind.FirstJSDocNode && n.kind <= ts.SyntaxKind.LastJSDocNode) {
      return;
    }
    const children = n.getChildren(sf);
    if (children.length === 0) {
      leaves.push(n);
    } else {
      children.forEach(collect);
    }
  };
  collect(node);
  const text = sf.text;
  const canEnd = (kind: ts.SyntaxKind): boolean =>
    !(kind >= ts.SyntaxKind.FirstPunctuation && kind <= ts.SyntaxKind.LastPunctuation) ||
    [
      ts.SyntaxKind.CloseParenToken,
      ts.SyntaxKind.CloseBracketToken,
      ts.SyntaxKind.CloseBraceToken,
      ts.SyntaxKind.PlusPlusToken,
      ts.SyntaxKind.MinusMinusToken,
    ].includes(kind);
  const continuers = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.CommaToken,
    ts.SyntaxKind.CloseParenToken,
    ts.SyntaxKind.CloseBracketToken,
    ts.SyntaxKind.CloseBraceToken,
    ts.SyntaxKind.DotToken,
    ts.SyntaxKind.QuestionDotToken,
    ts.SyntaxKind.QuestionToken,
    ts.SyntaxKind.ColonToken,
    ts.SyntaxKind.SemicolonToken,
    ts.SyntaxKind.EqualsToken,
    ts.SyntaxKind.EqualsGreaterThanToken,
  ]);
  let out = "";
  let prevKind: ts.SyntaxKind | undefined;
  let prevLineComment = false;
  const emit = (piece: string, kind: ts.SyntaxKind | undefined, sep: "" | " " | "\n") => {
    out += out === "" ? piece : `${sep}${piece}`;
    prevKind = kind ?? prevKind;
  };
  for (const leaf of leaves) {
    const start = leaf.getStart(sf);
    const from = leaf.pos;
    const trivia = text.slice(from, start);
    let sep: "" | " " | "\n" = "";
    let broke = false;
    for (let i = 0; i < trivia.length; ) {
      const ch = trivia[i] ?? "";
      if (/\s/u.test(ch)) {
        let j = i;
        while (j < trivia.length && /\s/u.test(trivia[j] ?? "")) {
          j += 1;
        }
        broke = broke || LINE_TERMINATOR.test(trivia.slice(i, j));
        sep = sep === "" ? " " : sep;
        i = j;
      } else if (trivia.startsWith("//", i)) {
        let j = trivia.slice(i).search(LINE_TERMINATOR);
        j = j === -1 ? trivia.length : i + j;
        emit(trivia.slice(i, j), undefined, prevLineComment || broke ? "\n" : " ");
        prevLineComment = true;
        sep = "";
        broke = false;
        i = j;
      } else if (trivia.startsWith("/*", i)) {
        const j = trivia.indexOf("*/", i) + 2;
        // a line break BEFORE a block comment still ends a statement (TE-61de-3a): it must survive the comment
        emit(
          trivia.slice(i, j),
          undefined,
          broke && prevKind !== undefined && canEnd(prevKind) ? "\n" : " ",
        );
        prevLineComment = false;
        sep = "";
        broke = false;
        i = j;
      } else {
        i += 1;
      }
    }
    let gap: "" | " " | "\n" = sep === "" ? "" : " ";
    if (prevLineComment && out !== "") {
      gap = "\n";
    } else if (
      broke &&
      prevKind !== undefined &&
      canEnd(prevKind) &&
      !continuers.has(leaf.kind) &&
      out !== ""
    ) {
      gap = "\n";
    }
    emit(text.slice(start, leaf.end), leaf.kind, gap);
    prevLineComment = false;
  }
  return out;
}

/** The unfollowable SITES in `src/` today, each READ and none of them the ledger — keyed `<file> | <kind> | <call as written>`, with an exact count. */
const KNOWN_NON_LEDGER_UNFOLLOWABLE: Readonly<Record<string, number>> = {
  // loads the harness's own fork-index module by a specifier it computes
  "acp/claude-fork-index.ts | non-literal import() | import(specifier)": 1,
  // a flow file's URL, loaded by the flow runner through tsx's loader (`.import()` for ESM, `.require()` for CJS) and a plain import()
  "flows/cli.ts | custom loader .import() | loader.import(flowUrl, import.meta.url)": 1,
  "flows/cli.ts | custom loader .require() | loader.require(flowUrl, import.meta.url)": 1,
  "flows/cli.ts | non-literal import() | import(flowUrl)": 1,
  // the capacity governor's /proc readers: a worker run from a template-literal source (`READER_SOURCE`) that requires only node:fs / node:os /
  // node:worker_threads and reads /proc/<pid>/stat — not a ledger use
  "capacity/governor/scan.ts | new Worker | new Worker(READER_SOURCE, { eval: true, workerData: { ctl, port: port2, index, count: options.readers, procRoot, nice: options.nice }, transferList: [port2], resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 }, })": 1,
  // `node:sqlite`, loaded once by `loadSqlite`
  "pod/sqlite-loader.ts | createRequire | createRequire(import.meta.url)": 1,
};

/**
 * What an `eval: true` Worker RUNS (bricks 61de55d6, TE-7115-3 / TE-61de-1 / TE-61de-2). The call is keyed above; the code it
 * runs is a string constant elsewhere in the file. For each `new Worker(SRC, { eval: true, … })` whose first argument is an
 * identifier bound — by its ONE `const` declaration in the file, never reassigned — to a string / template constant, this
 * RESOLVES the source (every `${…}` span is evaluated statically: a numeric or string literal, or an identifier bound to a
 * `const` of those, recursively), PARSES it as code, and walks the syntax tree:
 *  - `require("x")` → `require:x`; `import("x")` → `import:x`; `import … from "x"` / `import "x"` → `import:x`;
 *  - FAIL CLOSED, by name: a `require` that is anything but the callee of a call with ONE string-literal argument (an alias,
 *    `.call`, `Reflect.apply`, `(0, require)`, `require?.(…)`) → `<non-literal require>`; a non-literal `import()`; a computed
 *    member `x[expr]` whose key is not a literal; and any identifier, property or string named in `WORKER_DENIED_NAMES`
 *    (`eval`, `Function`, `getBuiltinModule`, `createRequire`, `binding`, `_load`, `process`, `module`, `globalThis`, `Worker`, …);
 *  - a span that cannot be resolved, a source that does not parse, a `new Worker` whose first argument is not such a constant
 *    (a path, a URL, a call, a constant declared twice, a `let`, one assigned elsewhere), or one without `eval: true`, is
 *    `<unresolved …>` — red until read and registered. A span can be allowed by name in `KNOWN_WORKER_SOURCE_SPANS`.
 * Because the walk is over the PARSED code, a comment, an escaped identifier (`require`) and `require/**\/(` read as what they are.
 * Keyed `<file> | <IDENT>`, value the sorted list.
 *
 * NAMED LIMIT (pinned by its own row): what the call hands the worker through `workerData` is not examined here — the call's key
 * pins it (an edit of `workerData` is an edit of the call, so red there).
 */
const WORKER_DENIED_NAMES: ReadonlySet<string> = new Set([
  "eval",
  "Function",
  "getBuiltinModule",
  "createRequire",
  "binding",
  "_linkedBinding",
  "dlopen",
  "_load",
  "constructor",
  "globalThis",
  "global",
  "module",
  "exports",
  "process",
  "Reflect",
  "Worker",
  "child_process",
  "node:child_process",
]);

function workerSourceModules(
  files: Iterable<[string, string]>,
  allowedSpans: ReadonlySet<string> = KNOWN_WORKER_SOURCE_SPANS,
): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const [rel, text] of files) {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    const bindWorker = new Set<string>();
    const workerModules = new Set<string>();
    for (const statement of sf.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ["node:worker_threads", "worker_threads"].includes(
          stringOf(statement.moduleSpecifier) ?? "",
        )
      ) {
        const bindings = statement.importClause?.namedBindings;
        if (statement.importClause?.name) {
          workerModules.add(statement.importClause.name.text);
        }
        if (bindings && ts.isNamespaceImport(bindings)) {
          workerModules.add(bindings.name.text);
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text === "Worker") {
              bindWorker.add(element.name.text);
            }
          }
        }
      }
    }
    // every declaration of a name, and every name that is assigned, anywhere in the file
    const declarations = new Map<string, ts.VariableDeclaration[]>();
    const assigned = new Set<string>();
    const gather = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        declarations.set(node.name.text, [...(declarations.get(node.name.text) ?? []), node]);
      } else if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)) {
        const op = node.operatorToken.kind;
        if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
          assigned.add(node.left.text);
        }
      }
      ts.forEachChild(node, gather);
    };
    gather(sf);
    const constantOf = (name: string): ts.Expression | undefined => {
      const all = declarations.get(name) ?? [];
      const only = all.length === 1 ? all[0] : undefined;
      const list = only?.parent;
      return only !== undefined &&
        !assigned.has(name) &&
        list !== undefined &&
        ts.isVariableDeclarationList(list) &&
        (list.flags & ts.NodeFlags.Const) !== 0
        ? only.initializer
        : undefined;
    };
    /** The static text of an expression, or undefined; `unresolved` collects the spans that could not be evaluated. */
    const valueOf = (
      expr: ts.Expression | undefined,
      unresolved: string[],
      depth = 0,
    ): string | undefined => {
      if (expr === undefined || depth > 8) {
        return undefined;
      }
      if (ts.isStringLiteralLike(expr)) {
        return expr.text;
      }
      if (ts.isNumericLiteral(expr)) {
        return expr.text;
      }
      if (ts.isParenthesizedExpression(expr)) {
        return valueOf(expr.expression, unresolved, depth + 1);
      }
      if (ts.isIdentifier(expr)) {
        return valueOf(constantOf(expr.text), unresolved, depth + 1);
      }
      if (ts.isTemplateExpression(expr)) {
        let out = expr.head.text;
        for (const span of expr.templateSpans) {
          const value = valueOf(span.expression, unresolved, depth + 1);
          if (value === undefined) {
            unresolved.push(span.expression.getText(sf));
          }
          out += (value ?? "0") + span.literal.text;
        }
        return out;
      }
      return undefined;
    };
    const loadsOf = (source: string): string[] => {
      const loads = new Set<string>();
      const code = ts.createSourceFile(
        "worker.js",
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      );
      const syntaxErrors =
        (code as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
      if (syntaxErrors.length > 0) {
        loads.add("<unparseable source>");
      }
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const argument = node.arguments[0];
          if (callee.kind === ts.SyntaxKind.ImportKeyword) {
            const spec = node.arguments.length === 1 ? stringOf(argument) : undefined;
            loads.add(spec === undefined ? "<non-literal import>" : `import:${spec}`);
          } else if (ts.isIdentifier(callee) && callee.text === "require") {
            const spec = node.arguments.length === 1 ? stringOf(argument) : undefined;
            loads.add(spec === undefined ? "<non-literal require>" : `require:${spec}`);
          }
        } else if (ts.isImportDeclaration(node)) {
          loads.add(`import:${stringOf(node.moduleSpecifier) ?? "?"}`);
        } else if (ts.isIdentifier(node) && node.text === "require") {
          // legal only as the callee of a literal call (handled above): anything else is an alias
          const parent = node.parent;
          if (!(ts.isCallExpression(parent) && parent.expression === node)) {
            loads.add("<non-literal require>");
          }
        } else if (ts.isElementAccessExpression(node)) {
          const key = node.argumentExpression;
          if (!(ts.isStringLiteralLike(key) || ts.isNumericLiteral(key))) {
            loads.add("<computed member>");
          }
        }
        const named = ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
        if (named !== undefined && WORKER_DENIED_NAMES.has(named)) {
          loads.add(`<${named}>`);
        }
        ts.forEachChild(node, visit);
      };
      visit(code);
      return [...loads].toSorted();
    };
    const walk = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ((ts.isIdentifier(node.expression) && bindWorker.has(node.expression.text)) ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "Worker" &&
            ts.isIdentifier(node.expression.expression) &&
            workerModules.has(node.expression.expression.text)))
      ) {
        const first = node.arguments?.[0];
        const options = node.arguments?.[1];
        const evalTrue =
          options !== undefined &&
          ts.isObjectLiteralExpression(options) &&
          options.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
              property.name.text === "eval" &&
              property.initializer.kind === ts.SyntaxKind.TrueKeyword,
          );
        const unresolved: string[] = [];
        const source = first !== undefined && evalTrue ? valueOf(first, unresolved) : undefined;
        const label =
          first !== undefined && ts.isIdentifier(first) ? first.text : "<inline source>";
        if (source === undefined) {
          found.set(
            `${rel} | <unresolved: ${first ? normalizedCallText(first, sf) : ""}${evalTrue ? "" : " (no eval: true — a file path)"}>`,
            ["<unresolved>"],
          );
        } else {
          const loads = loadsOf(source);
          for (const span of unresolved) {
            if (!allowedSpans.has(`${rel} | ${label} | ${span}`)) {
              loads.push(`<unresolved span: ${span}>`);
            }
          }
          found.set(`${rel} | ${label}`, loads.toSorted());
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
  }
  return found;
}

/** Template spans of a registered Worker source that cannot be evaluated statically but were READ and allowed: `<file> | <IDENT> | <span text>`. */
const KNOWN_WORKER_SOURCE_SPANS: ReadonlySet<string> = new Set<string>();

/** The module loads of each Worker source in `src/` today, READ: the capacity governor's /proc readers use node built-ins only — never the ledger. */
const KNOWN_WORKER_SOURCE_MODULES: Readonly<Record<string, readonly string[]>> = {
  "capacity/governor/scan.ts | READER_SOURCE": [
    "require:node:fs",
    "require:node:os",
    "require:node:worker_threads",
  ],
};

function* srcFiles(dir: string): Generator<[string, string]> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* srcFiles(full);
    } else if (entry.name.endsWith(".ts")) {
      yield [path.relative(SRC, full), fs.readFileSync(full, "utf8")];
    }
  }
}

const localInAgentPod = (cls: CommandClass): boolean =>
  (["own-pod", "other-pod"] as const).some((place) => routeFor(cls, place).kind === "local");

test("CONFORMANCE: every caller of a ledger entry is registered, and one that serves a command LOCAL in an agent pod calls only entries safe there", () => {
  const found = ledgerCallers(srcFiles(SRC));
  assert.ok(found.size >= 3, `positive control: ${found.size} callers discovered`);
  assert.deepEqual(
    [...found.keys()].toSorted(),
    Object.keys(CALLERS).toSorted(),
    "an unregistered caller",
  );
  const offenders: string[] = [];
  for (const [rel, caller] of Object.entries(CALLERS)) {
    assert.deepEqual([...(found.get(rel) ?? [])].toSorted(), [...caller.entries].toSorted(), rel);
    const table = { ...COMMAND_TABLE, ...PRE_COMMANDER_PATHS };
    const verbsLocal = (caller.verbs ?? []).filter((verb) => {
      const entry = table[verb];
      assert.ok(entry, `${rel}: ${verb} is not a classified command`);
      return entry.controlPodOnly !== true && localInAgentPod(entry.class);
    });
    const servesLocal = caller.classes.some(localInAgentPod) || verbsLocal.length > 0;
    for (const entry of caller.entries) {
      if (servesLocal && !SAFE_IN_AGENT_POD.has(entry)) {
        offenders.push(`${rel} calls ${entry}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("CONFORMANCE: every value the two ledger modules export is a ledger entry or named as one that is not (a fresh export is red until classified)", () => {
  const exported = ["capacity/admission.ts", "capacity/ledger.ts"].flatMap((rel) =>
    exportedValues(fs.readFileSync(path.join(SRC, rel), "utf8")),
  );
  assert.ok(exported.length >= 30, `positive control: ${exported.length} exports read`);
  const unclassified = exported.filter(
    (name) => !LEDGER_ENTRIES.has(name) && !NOT_LEDGER_ENTRIES.has(name),
  );
  assert.deepEqual(unclassified, [], "an exported value that is in neither set");
  for (const entry of LEDGER_ENTRIES) {
    assert.ok(exported.includes(entry), `${entry} is no longer exported — drop it from the set`);
  }
  for (const name of NOT_LEDGER_ENTRIES) {
    assert.ok(exported.includes(name), `${name} is no longer exported — drop it from the set`);
  }
  // NEGATIVE: a fresh export is read, and is in neither set.
  const fresh = exportedValues("export async function sneakyLedgerWrite() {}\nexport const x = 1;");
  assert.deepEqual(fresh, ["sneakyLedgerWrite", "x"]);
  assert.equal(
    LEDGER_ENTRIES.has("sneakyLedgerWrite") || NOT_LEDGER_ENTRIES.has("sneakyLedgerWrite"),
    false,
  );
  assert.ok(
    LEDGER_ENTRIES.has("ticketFor"),
    "ticketFor (a ticket's bind / release write the ledger) is an entry",
  );
});

/** One source text, as a file of `cli/`: which ledger entries does the discovery find in it? */
const entriesOf = (text: string): string[] =>
  [...(ledgerCallers([["cli/new-caller.ts", text]]).get("cli/new-caller.ts") ?? [])].toSorted();
const ALL_ENTRIES = [...LEDGER_ENTRIES].toSorted();
const ADM = "../capacity/admission.js";
const LED = "../capacity/ledger.js";

test("CONFORMANCE negative cases (K4): every import form is discovered — each was invisible to the first, regex-based row", () => {
  // named, aliased and `type`-qualified specifiers
  assert.deepEqual(entriesOf(`import { admitCreate } from "${ADM}";`), ["admitCreate"]);
  assert.deepEqual(entriesOf(`import { admitCreate as go, newEntry } from "${ADM}";`), [
    "admitCreate",
  ]);
  assert.deepEqual(entriesOf(`import { type admitWake, ticketFor } from "${ADM}";`), ["ticketFor"]);
  assert.deepEqual(
    entriesOf(`import type { admitWake } from "${ADM}";`),
    [],
    "a type-only import is erased",
  );
  // NAMESPACE import: the uses are followed; an escaping namespace is everything
  assert.deepEqual(
    entriesOf(`import * as ledger from "${LED}";\nawait ledger.appendDecisionLog(d, {}, now);`),
    ["appendDecisionLog"],
  );
  assert.deepEqual(
    entriesOf(`import * as ledger from "${LED}";\nconst w = ledger["writeLedgerFile"];`),
    ["writeLedgerFile"],
  );
  assert.deepEqual(entriesOf(`import * as ledger from "${LED}";\nuse(ledger);`), ALL_ENTRIES);
  assert.deepEqual(entriesOf(`import * as ledger from "${LED}";\nconst l = ledger;`), ALL_ENTRIES);
  // DYNAMIC import: destructured, member access, and the unfollowed `.then` / stored promise
  assert.deepEqual(
    entriesOf(`const { admitWake, releaseAdmittedWake } = await import("${ADM}");`),
    ["admitWake", "releaseAdmittedWake"],
  );
  assert.deepEqual(entriesOf(`const m = await import("${ADM}");\nm.admitCreate({});`), [
    "admitCreate",
  ]);
  assert.deepEqual(entriesOf(`const f = (await import("${ADM}")).admitCreate;`), ["admitCreate"]);
  assert.deepEqual(entriesOf(`import("${ADM}").then((m) => m.admitCreate({}));`), ALL_ENTRIES);
  assert.deepEqual(entriesOf(`const p = import("${ADM}");`), ALL_ENTRIES);
  // PROMISE.ALL of dynamic imports, destructured at once
  assert.deepEqual(
    entriesOf(
      `const [{ admitCreate }, other] = await Promise.all([import("${ADM}"), import("./other.js")]);`,
    ),
    ["admitCreate"],
  );
  assert.deepEqual(
    entriesOf(
      `const [other, { appendDecisionLog }] = await Promise.all([import("./other.js"), import("${LED}")]);`,
    ),
    ["appendDecisionLog"],
  );
  assert.deepEqual(
    entriesOf(`const [ns] = await Promise.allSettled([import("${LED}")]);\nns.writeLedgerFile();`),
    ["writeLedgerFile"],
  );
  assert.deepEqual(
    entriesOf(`await Promise.all([import("${ADM}")]).then(([m]) => m.admitCreate({}));`),
    ALL_ENTRIES,
    "a Promise.all that is not destructured at once is not followed",
  );
  // RE-EXPORTS and the legacy forms
  assert.deepEqual(entriesOf(`export { admitCreate, newEntry } from "${ADM}";`), ["admitCreate"]);
  assert.deepEqual(entriesOf(`export * from "${LED}";`), ALL_ENTRIES);
  assert.deepEqual(entriesOf(`import ledger = require("${LED}");`), ALL_ENTRIES);
  assert.deepEqual(entriesOf(`const l = require("${LED}");`), ALL_ENTRIES);
  // ticketFor is one of the entries
  assert.deepEqual(entriesOf(`const { ticketFor } = await import("${ADM}");`), ["ticketFor"]);
  // CONTROLS: the same names from another module, and a path that only looks alike, are not callers
  assert.deepEqual(entriesOf(`import { admitCreate } from "./other.js";`), []);
  assert.deepEqual(
    entriesOf(`import * as m from "../spawn-ledger.js";\nm.appendDecisionLog();`),
    [],
  );
  assert.deepEqual(entriesOf(`const { admitWake } = await import("../other/admission.js");`), []);
});

test("CONFORMANCE negative cases: a fresh caller is flagged; a local-class caller of a guarded entry is flagged", () => {
  const fresh = `import * as admission from "../capacity/admission.js";\nexport const f = () => admission.admitCreate({});\n`;
  const found = ledgerCallers([["cli/brand-new.ts", fresh]]);
  assert.deepEqual(
    [...found.keys()],
    ["cli/brand-new.ts"],
    "found without being registered anywhere",
  );
  assert.equal(Object.keys(CALLERS).includes("cli/brand-new.ts"), false);
  // the rule: `owner-ensure` is LOCAL in an agent pod, so a caller serving it may not call `admitCreate`
  assert.equal(localInAgentPod("owner-ensure"), true);
  assert.equal(localInAgentPod("create"), false);
  assert.equal(localInAgentPod("control-store"), false);
  assert.equal(SAFE_IN_AGENT_POD.has("admitCreate"), false);
  assert.equal(
    SAFE_IN_AGENT_POD.has("ticketFor"),
    false,
    "a ticket writes the ledger: not safe in an agent pod",
  );
});

// ── K4-1: the completeness row reads EVERY export form, and is red on one it cannot enumerate ─────────────

/** What the completeness row calls unclassified: an exported name in neither set. */
const unclassifiedOf = (exported: string[]): string[] =>
  exported.filter((name) => !LEDGER_ENTRIES.has(name) && !NOT_LEDGER_ENTRIES.has(name));

test("K4-1: exportedValues reads destructured consts, enums, namespaces, defaults and aliases; `export *` comes back as a marker no set contains", () => {
  const cases: Array<[string, string[]]> = [
    ["export const { a, b: c, ...rest } = source;", ["a", "c", "rest"]],
    ["export const [first, , third] = list;", ["first", "third"]],
    ["export enum Mode { A, B }", ["Mode"]],
    ["export namespace Space { export const inner = 1; }", ["Space"]],
    ["export default function main() {}", ["default"]],
    ["export default class {}", ["default"]],
    ["export default 41 + 1;", ["default"]],
    ["const v = 1; export { v as renamed, v };", ["renamed", "v"]],
    ['export * from "./split.js";', ["*:./split.js"]],
    ['export * as ns from "./split.js";', ["*:./split.js"]],
    ["export = something;", ["export="]],
    // type-only forms export no VALUE
    ["export type T = 1; export interface I {} export type { T as U };", []],
    ['export type * from "./types.js";', []],
  ];
  for (const [text, want] of cases) {
    assert.deepEqual(exportedValues(text), want, text);
  }
});

test("K4-1 NEGATIVE: a ledger function re-exported through `export *` (or `export * as`) is flagged UNCLASSIFIED — the first row passed it", () => {
  for (const text of [
    'export * from "./ledger-split.js";\nexport const ok = 1;',
    'export * as split from "./ledger-split.js";',
  ]) {
    const flagged = unclassifiedOf(exportedValues(text));
    assert.ok(
      flagged.includes("*:./ledger-split.js"),
      `the unenumerable export is red until classified: ${text}`,
    );
  }
  // the OLD reader dropped these forms entirely (so the row stayed green): the same texts read as nothing there
  const oldReader = (text: string): string[] => {
    const sf = ts.createSourceFile("m.ts", text, ts.ScriptTarget.Latest, true);
    return sf.statements.flatMap((statement) =>
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((e) => e.name.text)
        : [],
    );
  };
  assert.deepEqual(oldReader('export * from "./ledger-split.js";'), []);
  // control: a plain classified export is not flagged
  assert.deepEqual(unclassifiedOf(["ticketFor"]), []);
  assert.deepEqual(unclassifiedOf(["teSneakyDestructured"]), ["teSneakyDestructured"]);
});

// ── K4-2: an array with a spread, and the module systems this discovery cannot follow ──────────────────────

test("K4-2: a `Promise.all` array with a spread anywhere counts as the WHOLE entry set (the index it is read against is gone)", () => {
  const spread = `const [a, b] = await Promise.all([...pre, import("${ADM}"), import("${LED}")]);\nb.releaseWake();`;
  assert.deepEqual(entriesOf(spread), ALL_ENTRIES);
  // the same without the spread is read precisely (control: the spread, not the form, makes it everything)
  const plain = `const [a, b] = await Promise.all([import("${ADM}"), import("${LED}")]);\na.admitCreate();`;
  assert.notDeepEqual(entriesOf(plain), ALL_ENTRIES);
  assert.deepEqual(entriesOf(plain), ["admitCreate"]);
  // a spread AFTER the import shifts nothing, but is as unreadable as one before: also everything
  const after = `const [a] = await Promise.all([import("${ADM}"), ...rest]);\na.admitCreate();`;
  assert.deepEqual(entriesOf(after), ALL_ENTRIES);
});

/** The kinds found in one source text (as a file of `cli/`), sorted, with duplicates kept. */
const siteKinds = (text: string): string[] =>
  [...unfollowableSites([["cli/x.ts", text]]).entries()]
    .flatMap(([key, count]) => Array.from({ length: count }, () => key.split(" | ")[1] ?? ""))
    .toSorted();

test("K4-2 / FN-2: every way to load a module this discovery cannot follow is found — the plain forms and the aliased, qualified, built-in-reached and loader forms the first version missed", () => {
  const cases: Array<[string, string[]]> = [
    ["const m = await import(specifier);", ["non-literal import()"]],
    ["const m = await import(`./${name}.js`);", ["non-literal import()"]],
    [
      'import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);',
      ["createRequire"],
    ],
    ["const m = await loader.import(url, base);", ["custom loader .import()"]],
    // FN-2: the forms nobody listed
    [
      'import { createRequire as mk } from "node:module";\nconst r = mk(import.meta.url);',
      ["createRequire"],
    ],
    [
      'import mod from "node:module";\nconst r = mod.createRequire(import.meta.url);',
      ["createRequire"],
    ],
    [
      'import * as ns from "node:module";\nconst r = ns.createRequire(import.meta.url);',
      ["createRequire"],
    ],
    [
      'const r = process.getBuiltinModule("node:module").createRequire(import.meta.url);',
      ["createRequire", "getBuiltinModule"],
    ],
    ['const m = process.getBuiltinModule("node:fs");', ["getBuiltinModule"]],
    ['const load = new Function("s", "return import(s)");', ["new Function"]],
    ['const load = Function("s", "return import(s)");', ["new Function"]],
    ["const x = eval(code);", ["eval"]],
    ["const m = require(spec);", ["non-literal require()"]],
    ['const m = await loader["import"](url);', ["custom loader .import()"]],
    ["const m = loader.require(url, base);", ["custom loader .require()"]],
    // FN-2a: a worker, by path or as eval code, aliased or reached through the module object
    [
      'import { Worker } from "node:worker_threads";\nconst w = new Worker(new URL("./x.js", import.meta.url));',
      ["new Worker"],
    ],
    [
      'import { Worker as W } from "node:worker_threads";\nconst w = new W(code, { eval: true });',
      ["new Worker"],
    ],
    [
      'import * as wt from "node:worker_threads";\nconst w = new wt.Worker(code, { eval: true });',
      ["new Worker"],
    ],
    ['import wt from "worker_threads";\nconst w = new wt.Worker(file);', ["new Worker"]],
    ['const m = loader["require"](url);', ["custom loader .require()"]],
  ];
  for (const [text, want] of cases) {
    assert.deepEqual(siteKinds(text), want, text);
  }
  // controls: a LITERAL import() / require(), a plain file, a createRequire-named local that is not called, are not flagged
  assert.deepEqual(siteKinds('const m = await import("./a.js");'), []);
  assert.deepEqual(siteKinds('const m = require("./a.js");'), []);
  // a `Worker` that is not node's (no `node:worker_threads` import), and an import of it that is never constructed
  assert.deepEqual(siteKinds("class Worker {}\nconst w = new Worker();"), []);
  assert.deepEqual(siteKinds('import { Worker } from "node:worker_threads";\nlet x: Worker;'), []);
  assert.deepEqual(siteKinds("const x = 1; const createRequireLater = 2;"), []);
});

test("K4-2 / FN-3: the unfollowable SITES in src/ today are exactly the registered ones — each pinned by its call text and an exact count — none the ledger; a second site, even in a registered file, is red", () => {
  const found = unfollowableSites(srcFiles(SRC));
  const actual = Object.fromEntries(
    [...found.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
  );
  assert.deepEqual(actual, KNOWN_NON_LEDGER_UNFOLLOWABLE);
  // none of the registered files is a ledger caller (so "known non-ledger" is checked, not asserted)
  const callers = ledgerCallers(srcFiles(SRC));
  for (const key of Object.keys(KNOWN_NON_LEDGER_UNFOLLOWABLE)) {
    const rel = key.split(" | ")[0] ?? "";
    assert.equal(
      callers.has(rel),
      false,
      `${rel} is registered as non-ledger but calls a ledger entry`,
    );
  }
  // NEGATIVES, on in-memory copies of REGISTERED files with one more site (the TE's FN-3 measurement):
  const registered = [
    ...new Set(Object.keys(KNOWN_NON_LEDGER_UNFOLLOWABLE).map((key) => key.split(" | ")[0] ?? "")),
  ];
  for (const rel of registered) {
    const source = [...srcFiles(SRC)].find(([file]) => file === rel)?.[1] ?? "";
    for (const extra of [
      "\nexport const sneakyLoad = (p: string) => import(p);\n", // a different call text: a new key
      "\nexport const again = async () => (await import(specifier));\n", // the SAME text as a registered one, if any: a higher count
    ]) {
      const grown = unfollowableSites([[rel, source + extra]]);
      assert.notDeepEqual(
        Object.fromEntries([...grown.entries()].toSorted(([a], [b]) => a.localeCompare(b))),
        Object.fromEntries(
          Object.entries(KNOWN_NON_LEDGER_UNFOLLOWABLE).filter(([key]) =>
            key.startsWith(`${rel} | `),
          ),
        ),
        `${rel}: one more site is NOT green`,
      );
    }
    // and a duplicate of an existing registered call text raises its count
    const firstKey = Object.keys(KNOWN_NON_LEDGER_UNFOLLOWABLE).find((key) =>
      key.startsWith(`${rel} | `),
    );
    const written = (firstKey ?? "").split(" | ").slice(2).join(" | ");
    const doubled = unfollowableSites([[rel, `${source}\nconst dup = ${written};\n`]]);
    assert.ok(
      (doubled.get(firstKey ?? "") ?? 0) > (KNOWN_NON_LEDGER_UNFOLLOWABLE[firstKey ?? ""] ?? 0),
      `${firstKey}: the count rises`,
    );
  }
  // a fresh FILE is also red (it is in no registry)
  const fresh = unfollowableSites([
    ["cli/brand-new.ts", "export const load = (s: string) => import(s);"],
  ]);
  assert.equal(fresh.size, 1);
  assert.equal(
    Object.keys(KNOWN_NON_LEDGER_UNFOLLOWABLE).some((key) => key.startsWith("cli/brand-new.ts")),
    false,
  );
});

test("K4-2 / R2-F2: the registry keys the FULL call text — an edit to the registered Worker call PAST the old 160-char mark (a ledger preload in `execArgv`, a raised `resourceLimits`) is red, as is one before it", () => {
  const rel = "capacity/governor/scan.ts";
  const source = [...srcFiles(SRC)].find(([file]) => file === rel)?.[1] ?? "";
  const registered = Object.fromEntries(
    Object.entries(KNOWN_NON_LEDGER_UNFOLLOWABLE).filter(([key]) => key.startsWith(`${rel} | `)),
  );
  const keysOf = (text: string): Record<string, number> =>
    Object.fromEntries(
      [...unfollowableSites([[rel, text]]).entries()].toSorted(([a], [b]) => a.localeCompare(b)),
    );
  // control: the real file IS the registry (so a red below is the edit's, nothing else's)
  assert.deepEqual(keysOf(source), registered);
  const [key] = Object.keys(registered);
  assert.ok(
    (key ?? "").split(" | ").slice(2).join(" | ").length > 160,
    "the registered call is longer than the old 160-char cut: the edits below land PAST it",
  );
  const edits: Array<[string, string, string]> = [
    // the TE's two measured edits: both stayed GREEN under slice(0, 160)
    [
      "resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },",
      'resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 }, execArgv: ["--import", "../capacity/ledger.js"],',
      "a ledger preload appended after resourceLimits",
    ],
    ["maxOldGenerationSizeMb: 16", "maxOldGenerationSizeMb: 4096", "resourceLimits 16 -> 4096"],
    // and one BEFORE the old mark
    ["eval: true,", "eval: true, name: 'x',", "an option edit near the start"],
  ];
  for (const [from, to, what] of edits) {
    const edited = source.replace(from, to);
    assert.notEqual(edited, source, `the edit applied: ${what}`);
    assert.notDeepEqual(keysOf(edited), registered, `${what}: is NOT green`);
  }
  // control: a whitespace-only re-wrap keys the same (the key collapses whitespace)
  const rewrapped = source.replace("eval: true,\n", "eval: true,\n\n  ");
  assert.notEqual(rewrapped, source, "the re-wrap applied (TE-7115-4)");
  assert.deepEqual(keysOf(rewrapped), registered);
});

test("K4-2 / TE-7115-3: the code a registered Worker RUNS is pinned — a ledger require (or any module outside the allowlist) added to READER_SOURCE is red, though the call and ledgerCallers are unchanged", () => {
  const rel = "capacity/governor/scan.ts";
  const source = [...srcFiles(SRC)].find(([file]) => file === rel)?.[1] ?? "";
  const modulesOf = (text: string): Record<string, string[]> =>
    Object.fromEntries(
      [...workerSourceModules([[rel, text]]).entries()].toSorted(([a], [b]) => a.localeCompare(b)),
    );
  const registered = Object.fromEntries(
    Object.entries(KNOWN_WORKER_SOURCE_MODULES).map(([key, value]) => [key, [...value]]),
  );
  // control: the real src/ equals the registry, and the registry names no ledger
  assert.deepEqual(
    Object.fromEntries(workerSourceModules(srcFiles(SRC)).entries()),
    registered,
    "the Worker sources in src/ are exactly the registered ones",
  );
  assert.deepEqual(modulesOf(source), registered);
  assert.ok(
    !JSON.stringify(registered).includes("ledger"),
    "no registered Worker source loads a ledger module",
  );
  const marker = 'const fs = require("node:fs");';
  const edits: Array<[string, string]> = [
    [
      'const fs = require("node:fs");\nconst ledger = require("../capacity/ledger.js");',
      "a ledger require inside READER_SOURCE",
    ],
    [
      'const fs = require("node:fs");\nrequire("node:child_process");',
      "a built-in outside the allowlist",
    ],
    ['const fs = require("node:fs");\nrequire(process.env.PRELOAD);', "a non-literal require"],
    ['const fs = require("node:fs");\nimport("../capacity/ledger.js");', "a dynamic import"],
    [
      'const fs = require("node:fs");\nprocess.getBuiltinModule("node:module");',
      "getBuiltinModule",
    ],
  ];
  for (const [to, what] of edits) {
    const edited = source.replace(marker, to);
    assert.notEqual(edited, source, `the edit applied: ${what}`);
    assert.notDeepEqual(modulesOf(edited), registered, `${what}: is NOT green`);
    // and the CALL's own key is unchanged — which is why the call registry alone could not see it
    assert.deepEqual(
      [...unfollowableSites([[rel, edited]]).keys()].toSorted(),
      [...unfollowableSites([[rel, source]]).keys()].toSorted(),
      `${what}: the call registry stays green`,
    );
  }
  // controls: a module removed is red too (the allowlist is exact), and a whitespace-only edit of the source is not an edit of its loads
  const removed = source.replace('const os = require("node:os");\n', "");
  assert.notEqual(removed, source, "the removal applied");
  assert.notDeepEqual(modulesOf(removed), registered, "a dropped module: the registry is stale");
  const spaced = source.replace(marker, 'const fs   =   require( "node:fs" );');
  assert.notEqual(spaced, source, "the spacing edit applied");
  assert.deepEqual(modulesOf(spaced), registered);
  // a Worker whose first argument is a path (loads a FILE) or a call is `<unresolved>` — red until someone reads and registers it
  const byPath = workerSourceModules([
    [
      "x.ts",
      'import { Worker } from "node:worker_threads";\nconst w = new Worker(new URL("./w.js", import.meta.url));',
    ],
  ]);
  assert.deepEqual([...byPath.values()], [["<unresolved>"]]);
});

test("K4-2 / TE-7115-1: the call key is normalised by TOKEN — an edit inside a string or template literal, a line moved into a `//` comment, and an ASI-significant line break are each red; a re-wrap after a comma keys the same", () => {
  const head = 'import { Worker } from "node:worker_threads";\n';
  const keyOf = (body: string): string[] =>
    [...unfollowableSites([["x.ts", head + body]]).keys()].map((key) => key.split(" | ")[2] ?? "");
  const differ = (a: string, b: string, what: string): void => {
    assert.notDeepEqual(keyOf(a), keyOf(b), `${what}: is NOT green`);
    assert.equal(keyOf(a).length, 1, `${what}: the call is found`);
  };
  // string / template literals keep their whitespace
  differ(
    'new Worker("a  b", { eval: true });',
    'new Worker("a b", { eval: true });',
    "a string literal",
  );
  differ(
    "new Worker(`a  b`, { eval: true });",
    "new Worker(`a b`, { eval: true });",
    "a template literal",
  );
  differ(
    "new Worker(`a ${1}  b`, { eval: true });",
    "new Worker(`a ${1} b`, { eval: true });",
    "a template span",
  );
  // a line pulled INTO a `//` comment goes dead, with the old key unchanged
  differ(
    "new Worker(S, { eval: true, // note\n execArgv: ['--import', 'x'] });",
    "new Worker(S, { eval: true, // note execArgv: ['--import', 'x'] });",
    "a line joined into a line comment",
  );
  // a commented-out option moved onto its own line (live) vs left in the comment
  differ(
    "new Worker(S, { eval: true, // execArgv: ['--import', 'x'],\n });",
    "new Worker(S, { eval: true,\n execArgv: ['--import', 'x'],\n });",
    "a commented-out option moved live",
  );
  // block comments are kept verbatim
  differ(
    "new Worker(S, { eval: true, /* a */ x: 1 });",
    "new Worker(S, { eval: true, /* b */ x: 1 });",
    "a block comment",
  );
  // ASI: a line break after `return` ends the statement; a space does not
  differ(
    "new Worker(S, { f: () => { return\n 1; } });",
    "new Worker(S, { f: () => { return 1; } });",
    "an ASI line break",
  );
  // controls: whitespace between tokens, and a re-wrap after `,` `(` `{`, key the same
  assert.deepEqual(
    keyOf("new Worker(S,   { eval:   true });"),
    keyOf("new Worker(S, { eval: true });"),
  );
  assert.deepEqual(
    keyOf("new Worker(S, {\n  eval: true,\n\n  x: 1\n});"),
    keyOf("new Worker(S, { eval: true, x: 1 });"),
  );
  // …and the registered real call still keys as registered (the registry test above covers the whole of src/)
});

/** The real scan.ts text, and what `workerSourceModules` / `unfollowableSites` say of an edited copy. */
const SCAN_REL = "capacity/governor/scan.ts";
/** U+2028 / U+2029, built — never typed — so the file holds no raw line separators. */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const scanSource = (): string => [...srcFiles(SRC)].find(([file]) => file === SCAN_REL)?.[1] ?? "";
const workerLoads = (text: string): Record<string, string[]> =>
  Object.fromEntries(
    [...workerSourceModules([[SCAN_REL, text]]).entries()].toSorted(([a], [b]) =>
      a.localeCompare(b),
    ),
  );
const registeredLoads = (): Record<string, string[]> =>
  Object.fromEntries(
    Object.entries(KNOWN_WORKER_SOURCE_MODULES).map(([key, value]) => [key, [...value]]),
  );
const ANCHOR = 'const fs = require("node:fs");';
const LEDGER_REQ = 'require("../capacity/ledger.js")';

test("K4-2 / TE-61de-1,2: EVERY way the TE found to change what READER_SOURCE loads — a template span, an aliased or escaped `require`, `process.binding`, indirect eval, `module.constructor._load`, a shadowing decoy, `let … +=` — turns the module pin red, with the call key unchanged", () => {
  const source = scanSource();
  const registered = registeredLoads();
  assert.equal(
    source.split(ANCHOR).length - 1,
    1,
    "the anchor is unique in the real READER_SOURCE",
  );
  assert.deepEqual(workerLoads(source), registered, "control: the real file IS the registry");
  const callKeys = (text: string): string[] =>
    [...unfollowableSites([[SCAN_REL, text]]).keys()].toSorted();
  const inside = (code: string): string => source.replace(ANCHOR, `${ANCHOR}\n${code}`);
  const edits: Array<[string, string]> = [
    // what the TE-7115-3 row already holds, now read from the syntax tree
    ["L1 literal require", inside(`const l = ${LEDGER_REQ};`)],
    ["L2 bare import", inside('import "../capacity/ledger.js";')],
    ["L2b import-from", inside('import x from "../capacity/ledger.js";')],
    ["L3 dynamic import", inside('import("../capacity/ledger.js");')],
    ["L4 getBuiltinModule", inside('process.getBuiltinModule("node:module");')],
    [
      "L4b bracket-built getBuiltinModule",
      inside('process["getBuiltin" + "Module"]("node:module");'),
    ],
    [
      "L5 module.constructor.createRequire",
      inside('module.constructor.createRequire(__filename)("../capacity/ledger.js");'),
    ],
    // the TE's hidden forms
    ["L6 process.binding", inside('process.binding("fs");')],
    ["L6b process.dlopen", inside('process.dlopen(module, "x");')],
    ["L7 aliased require", inside(`const r = require; r("../capacity/ledger.js");`)],
    ["L7b require.call", inside('require.call(null, "../capacity/ledger.js");')],
    ["L7c Reflect.apply", inside('Reflect.apply(require, null, ["../capacity/ledger.js"]);')],
    ["L7d (0, require)", inside('(0, require)("../capacity/ledger.js");')],
    ["L7e require?.()", inside('require?.("../capacity/ledger.js");')],
    ["L7f require/**/(", inside('require/**/("../capacity/ledger.js");')],
    ["L7g escaped identifier", inside(String.raw`\\u0072equire("../capacity/ledger.js");`)],
    [
      "L7h module.constructor._load",
      inside('module.constructor._load("../capacity/ledger.js", module);'),
    ],
    ["L8 eval-built require", inside('eval("req" + "uire")("../capacity/ledger.js");')],
    ["L8b indirect eval", inside('(0, eval)("req" + "uire")("../capacity/ledger.js");')],
    ["L8c new Function", inside('new Function("return req" + "uire")()("../capacity/ledger.js");')],
    ["L8d constructor chain", inside('[].constructor.constructor("return 1")();')],
    ["L8e globalThis[...]", inside('globalThis["req" + "uire"]("../capacity/ledger.js");')],
    ["L10 template specifier", inside('require(`../capacity/${"ledger"}.js`);')],
    ["L14 require(workerData.x)", inside("require(workerData.preload);")],
    // template SPANS (TE-61de-1)
    ["L9 span holding a string literal of code", inside(`\${'${LEDGER_REQ};'}`)],
    [
      "L9b span holding a const",
      source
        .replace(
          "const READER_SOURCE = `",
          `const LEDGER = '${LEDGER_REQ};';\nconst READER_SOURCE = \``,
        )
        .replace(ANCHOR, `${ANCHOR}\n\${LEDGER}`),
    ],
    [
      "L9c span holding a const of a const (nested template)",
      source
        .replace(
          "const READER_SOURCE = `",
          `const INNER = '${LEDGER_REQ};';\nconst OUTER = \`\${INNER}\`;\nconst READER_SOURCE = \``,
        )
        .replace(ANCHOR, `${ANCHOR}\n\${OUTER}`),
    ],
    ["L9d span that cannot be resolved (a call)", inside("${compute()}")],
    ["L9e span that cannot be resolved (a property)", inside("${options.nice}")],
    // the declaration games (TE-61de-2)
    [
      "L11 shadowing decoy declaration",
      `${source}\nfunction decoy() { const READER_SOURCE = \`const x = 1;\`; return READER_SOURCE; }\n`,
    ],
    [
      "L12 let + `+=`",
      `${source.replace("const READER_SOURCE = `", "let READER_SOURCE = `")}\nREADER_SOURCE += '${LEDGER_REQ}';\n`,
    ],
    ["L12b const reassigned", `${source}\nREADER_SOURCE += '${LEDGER_REQ}';\n`],
    [
      "L13 initializer is no longer a plain template",
      source.replace("const READER_SOURCE = `", 'const READER_SOURCE = "" + `'),
    ],
    [
      "L15 no `eval: true`: the argument is a file path",
      source.replace("eval: true,", "eval: false,"),
    ],
  ];
  for (const [what, edited] of edits) {
    assert.notEqual(edited, source, `the edit applied: ${what}`);
    assert.notDeepEqual(workerLoads(edited), registered, `${what}: is NOT green`);
  }
  // the pure LOAD edits leave the call key where it was — which is why the call registry could not see them
  for (const [what, edited] of edits.slice(0, 23)) {
    assert.deepEqual(callKeys(edited), callKeys(source), `${what}: the call key is unchanged`);
  }
  // controls: a comment (even one that SAYS require(...)), spacing, a renamed local — are not loads
  const controls: Array<[string, string]> = [
    ["a comment naming a ledger require", inside(`// never ${LEDGER_REQ}`)],
    ["a block comment", inside(`/* ${LEDGER_REQ} */`)],
    ["extra spacing", source.replace(ANCHOR, 'const   fs   =   require( "node:fs" );')],
    [
      "a string that merely contains the words",
      inside('const note = "see ../capacity/ledger.js";'),
    ],
  ];
  for (const [what, edited] of controls) {
    assert.notEqual(edited, source, `the control edit applied: ${what}`);
    assert.deepEqual(workerLoads(edited), registered, `${what}: stays green`);
  }
});

test("K4-2 / TE-61de-1: a template span that cannot be evaluated is red UNLESS it is named in the allowlist; spans that resolve (numbers, strings, consts of consts) are SCANNED, not skipped", () => {
  const head = 'import { Worker } from "node:worker_threads";\n';
  const loads = (body: string, allowed?: ReadonlySet<string>): string[] =>
    [...workerSourceModules([["x.ts", head + body]], allowed).values()].flat();
  // resolved spans: a number is fine, a string const is scanned
  assert.deepEqual(
    loads(
      'const N = 3;\nconst S = `require("node:fs"); post(${N});`;\nnew Worker(S, { eval: true });',
    ),
    ["require:node:fs"],
  );
  assert.deepEqual(
    loads(
      'const C = "require(\\"../capacity/ledger.js\\")";\nconst S = `${C};`;\nnew Worker(S, { eval: true });',
    ),
    ["require:../capacity/ledger.js"],
    "a span that carries a require is read",
  );
  // an unresolvable span is red, and the allowlist names it
  const body = 'const S = `require("node:fs"); ${compute()}`;\nnew Worker(S, { eval: true });';
  assert.deepEqual(loads(body), ["<unresolved span: compute()>", "require:node:fs"]);
  assert.deepEqual(loads(body, new Set(["x.ts | S | compute()"])), ["require:node:fs"]);
  assert.deepEqual(
    loads(body, new Set(["x.ts | S | somethingElse()"])),
    ["<unresolved span: compute()>", "require:node:fs"],
    "an allowlist entry for a DIFFERENT span does not cover it",
  );
  // a span bound to something that is not a const literal fails closed too
  assert.deepEqual(
    loads('let N = 1;\nconst S = `require("node:fs"); ${N}`;\nnew Worker(S, { eval: true });'),
    ["<unresolved span: N>", "require:node:fs"],
  );
  // the real READER_SOURCE has spans, and every one of them resolves (nothing is allowlisted today)
  assert.equal(KNOWN_WORKER_SOURCE_SPANS.size, 0);
  assert.ok(scanSource().includes("${SEQ}"), "the real source has spans");
  assert.deepEqual(workerLoads(scanSource()), registeredLoads());
});

test("K4-2 / TE-61de-2: the NAMED limit — what the call hands the worker through `workerData` is not read by the module pin, so it is pinned by the CALL's key: an edit of `workerData` is red there and green here", () => {
  const source = scanSource();
  const edited = source.replace(
    "workerData: { ctl,",
    'workerData: { preload: "../capacity/ledger.js", ctl,',
  );
  assert.notEqual(edited, source, "the edit applied");
  assert.deepEqual(
    workerLoads(edited),
    registeredLoads(),
    "the module pin does not see workerData",
  );
  const registeredKeys = Object.fromEntries(
    Object.entries(KNOWN_NON_LEDGER_UNFOLLOWABLE).filter(([key]) =>
      key.startsWith(`${SCAN_REL} | `),
    ),
  );
  assert.deepEqual(
    Object.fromEntries(unfollowableSites([[SCAN_REL, source]])),
    registeredKeys,
    "control",
  );
  assert.notDeepEqual(
    Object.fromEntries(unfollowableSites([[SCAN_REL, edited]])),
    registeredKeys,
    "the call's own key is red",
  );
});

test("K4-2 / TE-61de-3: ASI — a line break before a block comment survives, and a lone CR, U+2028 and U+2029 are line terminators (the TE's T1, T1b, T2, T2b probes)", () => {
  const head = 'import { Worker } from "node:worker_threads";\n';
  const keyOf = (body: string): string[] =>
    [...unfollowableSites([["x.ts", head + body]]).keys()].map((key) => key.split(" | ")[2] ?? "");
  const wrap = (inner: string): string => `new Worker(S, { f: () => { ${inner} } });`;
  const differ = (a: string, b: string, what: string): void => {
    assert.equal(keyOf(wrap(a)).length, 1, `${what}: the call is found`);
    assert.notDeepEqual(keyOf(wrap(a)), keyOf(wrap(b)), `${what}: is NOT green`);
  };
  differ("return\n /* x */ 1;", "return /* x */ 1;", "T1 a break before a block comment");
  differ(
    "return /* a */\n/* b */ 1;",
    "return /* a */ /* b */ 1;",
    "T1b a break between two block comments",
  );
  differ(`return${LS}1;`, "return 1;", "T2 U+2028");
  differ(`return${PS}1;`, "return 1;", "U+2029");
  differ("return\r1;", "return 1;", "T2b a lone CR");
  differ("a = 1; // note\r b = 2;", "a = 1; // note b = 2;", "a lone CR ends a line comment");
  differ(`a = 1; // note${LS} b = 2;`, "a = 1; // note b = 2;", "U+2028 ends a line comment");
  // controls: a comment with the SAME spacing keys the same, and a break after `,` is a re-wrap
  assert.deepEqual(keyOf(wrap("return /* x */ 1;")), keyOf(wrap("return  /* x */   1;")));
  assert.deepEqual(keyOf(wrap("f(a,\r\n b);")), keyOf(wrap("f(a, b);")));
});
