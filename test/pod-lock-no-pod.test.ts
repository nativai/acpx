import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  makePod,
  makeServiceAccountDir,
  makeTestHome,
  runInPod,
  type PodEnvOptions,
} from "./pod-kit/two-pods.js";

// Program HoD constraint, 2026-11-21 (brick 8d85cb47): until a box is switched, nothing in A5 may
// require `NV_POD_*` on a control pod (with the switch on, C1.1 A-5 makes the identity a condition).
// A CONTROL-POD-SHAPED host (NV_DEV_SERVER_ROLE=control) with pod mode off and no NV_POD_* writes
// exactly today's record-lock body and judges exactly by today's rules — compare by content, the age
// bound, its WARNING line, and (pinned on purpose, because it is today's behaviour and the reason the
// identity must land before the switch) an other-boot holder judged dead at once. No break-ledger
// file is written on this path: the ledger is named by a pod uid this host does not have.

const CHILD = fileURLToPath(new URL("./fixtures/pod-lock-child.js", import.meta.url));
const TODAY_KEYS = ["pid", "start", "host", "boot", "processIdentity"];

function setup(): { dir: string; options: PodEnvOptions; record: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-nopod-"));
  const options = { saDir: makeServiceAccountDir(dir), stateHome: dir };
  return { dir, options, record: path.join(dir, "rec.json") };
}

function controlShaped(options: PodEnvOptions): PodEnvOptions {
  // `runInPod(undefined, …)` strips NV_POD_* and ACPX_OWNER_PLACEMENT; the role is set here.
  // ⚠️ A-26: an UNSEAMED control-role host reads what its process lacks from PID 1 — and the
  // workbench this suite runs in has NV_POD_* in its PID 1. No service-account namespace means the
  // fourth identity source is missing everywhere, so these rows still measure a host that cannot
  // name its pod (the production "unswitched, no identity" shape) whatever box they run on.
  process.env.NV_DEV_SERVER_ROLE = "control";
  return { ...options, saDir: "/nonexistent/acpx-test/serviceaccount" };
}

test.afterEach(() => {
  delete process.env.NV_DEV_SERVER_ROLE;
});

function noLedger(dir: string): void {
  assert.equal(fs.existsSync(path.join(dir, ".acpx", "lock-breaks")), false, "no break ledger");
}

async function bodyOf(pod: ReturnType<typeof makePod> | undefined, options: PodEnvOptions) {
  const { record } = setup();
  const run = await runInPod(pod, CHILD, ["record-body", record], options);
  assert.equal(run.code, 0, run.stderr);
  return JSON.parse(JSON.parse(run.stdout).raw) as Record<string, unknown>;
}

function childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "child-v8",
    NV_POD_NAME: "",
    NV_POD_UID: "",
    ...extra,
  };
}

test("control-pod-shaped, pod mode off, no NV_POD_*: the record-lock body is today's, key for key", async () => {
  const { options } = setup();
  const body = await bodyOf(undefined, controlShaped(options));
  assert.deepEqual(Object.keys(body), TODAY_KEYS);
  assert.equal(typeof body.pid, "number");
  assert.equal(body.host, os.hostname());
});

test("control-pod-shaped, pod mode ON but a NON-canonical state home, no NV_POD_*: pod mode is not honoured — today's body", async () => {
  const { dir, record } = setup();
  const run = spawnSync(process.execPath, [CHILD, "record-body", record], {
    env: childEnv({
      NV_DEV_SERVER_ROLE: "control",
      ACPX_OWNER_PLACEMENT: "pod",
      ACPX_STATE_HOME: dir, // not /home/node: C1.1 leaves pod mode off
      ACPX_POD_SA_DIR: "/nonexistent/acpx-test/serviceaccount", // see controlShaped (A-26)
    }),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(Object.keys(JSON.parse(JSON.parse(run.stdout).raw) as object), TODAY_KEYS);
});

test("A-5 NEVER: pod mode ON (canonical home via ACPX_POD_TEST_HOME) WITHOUT the identity → pod_identity_missing, no lock written", async () => {
  const { dir, options, record } = setup();
  const home = makeTestHome(dir, "control");
  const run = spawnSync(process.execPath, [CHILD, "record-acquire", record], {
    env: childEnv({
      ACPX_OWNER_PLACEMENT: "pod",
      ACPX_POD_TEST_HOME: home,
      ACPX_STATE_HOME: home, // <home>/.acpx IS the canonical state home under the seam
      ACPX_POD_SA_DIR: options.saDir,
    }),
    encoding: "utf8",
  });
  assert.equal(JSON.parse(run.stdout).code, "pod_identity_missing", run.stdout + run.stderr);
  assert.equal(fs.existsSync(`${record}.lock`), false);
});

test("A-5: a COMPLETE identity writes `pod` and a token even with pod mode OFF (the rollback window keeps the cross-pod rules)", async () => {
  const { options } = setup();
  const pod = makePod("wb");
  const body = await bodyOf(pod, { ...options, podMode: false });
  assert.deepEqual(Object.keys(body), [...TODAY_KEYS, "pod", "token"]);
  assert.deepEqual(body.pod, pod);
});

test("an INCOMPLETE identity (no service-account namespace — today's workbench) writes today's body", async () => {
  const { options } = setup();
  const body = await bodyOf(makePod("wb"), {
    ...options,
    saDir: "/nonexistent/sa",
    podMode: false,
  });
  assert.deepEqual(Object.keys(body), TODAY_KEYS);
});

test("no pod: an unjudgeable holder older than the age bound is broken by content compare with today's WARNING", async () => {
  const { dir, options, record } = setup();
  const raw = JSON.stringify({ pid: 1, start: "x", host: "some-other-host", boot: "b" });
  fs.writeFileSync(`${record}.lock`, raw);
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(`${record}.lock`, old, old);
  const run = await runInPod(undefined, CHILD, ["record-acquire", record], controlShaped(options));
  assert.deepEqual(JSON.parse(run.stdout), { acquired: true });
  assert.match(
    run.stderr,
    /\[acpx\] WARNING: broke stale session record lock .*holder cannot be judged from here/,
  );
  noLedger(dir);
});

test("no pod: an unjudgeable holder YOUNGER than the age bound is broken only after the 15 s bound, with the warning (today)", async () => {
  const { dir, options, record } = setup();
  const raw = JSON.stringify({ pid: 1, start: "x", host: "some-other-host", boot: "b" });
  fs.writeFileSync(`${record}.lock`, raw);
  const old = new Date(Date.now() - 1_000);
  fs.utimesSync(`${record}.lock`, old, old);
  // The record budget (20 s) outlasts the 15 s bound, so the waiter ends up breaking it by age —
  // today's behaviour: it MUST print the age warning, never break it silently or earlier.
  const started = Date.now();
  const run = await runInPod(undefined, CHILD, ["record-acquire", record], controlShaped(options));
  assert.deepEqual(JSON.parse(run.stdout), { acquired: true });
  assert.ok(
    Date.now() - started >= 13_000,
    `broken after ${Date.now() - started} ms, not before the bound`,
  );
  assert.match(run.stderr, /WARNING: broke stale session record lock/);
  noLedger(dir);
});

test("no pod: a holder on ANOTHER BOOT is UNJUDGEABLE, never dead (A-80, C3.2 row 3): broken only past the stale age, with the warning", async () => {
  const { dir, options, record } = setup();
  const raw = JSON.stringify({
    pid: process.pid,
    host: "other-machine",
    processIdentity: {
      kind: "linux-proc-stat-starttime",
      startTimeTicks: "1",
      bootId: "00000000-0000-4000-8000-000000000000",
      pidNamespace: "pid:[4026531836]",
      timeNamespace: "time:[4026531834]",
    },
  });
  // Across NFS clients another boot id means ANOTHER MACHINE, not a reboot: its holder may be alive (X-NFS F1,
  // taken over in 21-28 ms). Today's "judged dead at once" is the defect this row used to pin.
  fs.writeFileSync(`${record}.lock`, raw);
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(`${record}.lock`, old, old);
  const run = await runInPod(undefined, CHILD, ["record-acquire", record], controlShaped(options));
  assert.deepEqual(JSON.parse(run.stdout), { acquired: true });
  assert.match(
    run.stderr,
    /\[acpx\] WARNING: broke stale session record lock .*holder cannot be judged from here/,
    "past the stale age it is broken by AGE, loudly — not silently as a dead holder",
  );
  noLedger(dir);
});
