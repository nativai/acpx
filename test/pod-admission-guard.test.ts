import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  admitCreate,
  admitWake,
  releaseAdmittedWake,
  ticketFor,
} from "../src/capacity/admission.js";
import { appendDecisionLog } from "../src/capacity/ledger.js";
import { PodForeignWriteError } from "../src/pod/foreign-write-guard.js";

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

test("F5: admitWake in an agent pod rejects pod_foreign_write for every class — it does not fail open", async () => {
  const { env, dir } = sandbox("agent-pod");
  for (const flagClass of ["delivery", "automation"] as const) {
    await assert.rejects(
      admitWake({ verb: "capacity admit-wake", target: wakeTarget, flagClass }, env),
      refused,
      flagClass,
    );
  }
  // inferred class (an agent identity, no flag), and a closed record with a message id (logged, never gated)
  await assert.rejects(
    admitWake({ verb: "prompt", target: wakeTarget }, withIdentity(env)),
    refused,
  );
  await assert.rejects(
    admitWake({ verb: "prompt", target: wakeTarget, closedWithMessageId: true }, withIdentity(env)),
    refused,
  );
  noTrace(dir);
});

test("F5: admitCreate in an agent pod rejects pod_foreign_write — an unconfigured box is not an excuse to pass", async () => {
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
