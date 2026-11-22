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
 * loader's `.import(…)` / `.require(…)`, also as `loader["import"](…)`.
 */
function unfollowableSites(files: Iterable<[string, string]>): Map<string, number> {
  const found = new Map<string, number>();
  for (const [rel, text] of files) {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
    // bindings of `node:module` / `module`: the aliases of createRequire, and the names of the module object itself
    const createRequireNames = new Set<string>(["createRequire"]);
    const moduleObjects = new Set<string>();
    for (const statement of sf.statements) {
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
      const written = node.getText(sf).replace(/\s+/gu, " ").slice(0, 160);
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

/** The unfollowable SITES in `src/` today, each READ and none of them the ledger — keyed `<file> | <kind> | <call as written>`, with an exact count. */
const KNOWN_NON_LEDGER_UNFOLLOWABLE: Readonly<Record<string, number>> = {
  // loads the harness's own fork-index module by a specifier it computes
  "acp/claude-fork-index.ts | non-literal import() | import(specifier)": 1,
  // a flow file's URL, loaded by the flow runner through tsx's loader (`.import()` for ESM, `.require()` for CJS) and a plain import()
  "flows/cli.ts | custom loader .import() | loader.import(flowUrl, import.meta.url)": 1,
  "flows/cli.ts | custom loader .require() | loader.require(flowUrl, import.meta.url)": 1,
  "flows/cli.ts | non-literal import() | import(flowUrl)": 1,
  // `node:sqlite`, loaded once by `loadSqlite`
  "pod/sqlite-loader.ts | createRequire | createRequire(import.meta.url)": 1,
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
    ['const m = loader["require"](url);', ["custom loader .require()"]],
  ];
  for (const [text, want] of cases) {
    assert.deepEqual(siteKinds(text), want, text);
  }
  // controls: a LITERAL import() / require(), a plain file, a createRequire-named local that is not called, are not flagged
  assert.deepEqual(siteKinds('const m = await import("./a.js");'), []);
  assert.deepEqual(siteKinds('const m = require("./a.js");'), []);
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
