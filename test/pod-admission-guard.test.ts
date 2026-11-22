import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
  "withAdmissionLock",
  "writeLedgerFile",
  "appendDecisionLog",
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

function ledgerCallers(files: Iterable<[string, string]>): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const importRe =
    /\{([^{}]*)\}\s*(?:=\s*await\s+import\(\s*|from\s+)["'][^"']*(?:capacity\/|\.\/)(?:admission|ledger)\.js["']/gu;
  for (const [rel, text] of files) {
    if (rel === "capacity/admission.ts" || rel === "capacity/ledger.ts") {
      continue;
    }
    for (const match of text.matchAll(importRe)) {
      const names = match[1]
        .split(",")
        .map((name) => name.trim().replace(/^type\s+/u, ""))
        .filter((name) => LEDGER_ENTRIES.has(name));
      if (names.length > 0) {
        found.set(rel, new Set([...(found.get(rel) ?? []), ...names]));
      }
    }
  }
  return found;
}

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

test("CONFORMANCE negative cases: a fresh caller is flagged; a local-class caller of a guarded entry is flagged", () => {
  const fresh = `import { admitCreate } from "../capacity/admission.js";\nexport const f = () => admitCreate({});\n`;
  const found = ledgerCallers([["cli/brand-new.ts", fresh]]);
  assert.deepEqual(
    [...found.keys()],
    ["cli/brand-new.ts"],
    "found without being registered anywhere",
  );
  assert.equal(Object.keys(CALLERS).includes("cli/brand-new.ts"), false);
  // dynamic-import form (wake-gate's shape) is discovered too
  const dynamic = `const { admitWake, releaseAdmittedWake } = await import("../../capacity/admission.js");`;
  assert.deepEqual([...(ledgerCallers([["cli/x.ts", dynamic]]).get("cli/x.ts") ?? [])].toSorted(), [
    "admitWake",
    "releaseAdmittedWake",
  ]);
  // the rule: `owner-ensure` is LOCAL in an agent pod, so a caller serving it may not call `admitCreate`
  assert.equal(localInAgentPod("owner-ensure"), true);
  assert.equal(localInAgentPod("create"), false);
  assert.equal(localInAgentPod("control-store"), false);
  assert.equal(SAFE_IN_AGENT_POD.has("admitCreate"), false);
});
