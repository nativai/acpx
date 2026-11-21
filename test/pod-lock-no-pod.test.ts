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
  runInPod,
  type PodEnvOptions,
} from "./pod-kit/two-pods.js";

// Program HoD constraint, 2026-11-21 (brick 8d85cb47): until a box is switched, nothing in A5 may
// require `NV_POD_*` on a control pod. A CONTROL-POD-SHAPED host (NV_DEV_SERVER_ROLE=control) with pod
// mode off and no NV_POD_* writes exactly today's record-lock body and judges exactly by today's
// rules — compare-and-delete, the age bound, its WARNING line, and (pinned on purpose, because it is
// today's behaviour and the reason the switch commit must carry the variables) an other-boot holder
// judged dead at once. No tombstone is ever created on this path.

const CHILD = fileURLToPath(new URL("./fixtures/pod-lock-child.js", import.meta.url));
const TODAY_KEYS = ["pid", "start", "host", "boot", "processIdentity"];

function setup(): { dir: string; options: PodEnvOptions; record: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-nopod-"));
  const options = { saDir: makeServiceAccountDir(dir) };
  return { dir, options, record: path.join(dir, "rec.json") };
}

function controlShaped(options: PodEnvOptions): PodEnvOptions {
  // `runInPod(undefined, …)` strips NV_POD_* and ACPX_OWNER_PLACEMENT; the role is set here.
  process.env.NV_DEV_SERVER_ROLE = "control";
  return options;
}

test.afterEach(() => {
  delete process.env.NV_DEV_SERVER_ROLE;
});

async function bodyKeys(pod: ReturnType<typeof makePod> | undefined, options: PodEnvOptions) {
  const { dir, record } = setup();
  const run = await runInPod(pod, CHILD, ["record-body", record], options);
  assert.equal(run.code, 0, run.stderr);
  const body = JSON.parse(JSON.parse(run.stdout).raw) as Record<string, unknown>;
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.includes(".tomb.")),
    [],
  );
  return body;
}

test("control-pod-shaped, pod mode off, no NV_POD_*: the record-lock body is today's, key for key", async () => {
  const { options } = setup();
  const body = await bodyKeys(undefined, controlShaped(options));
  assert.deepEqual(Object.keys(body), TODAY_KEYS);
  assert.equal(typeof body.pid, "number");
  assert.equal(body.host, os.hostname());
});

test("control-pod-shaped, pod mode ON but no NV_POD_* (a box mid-switch): still today's body — nothing requires them", async () => {
  const { options } = setup();
  // runInPod strips ACPX_OWNER_PLACEMENT for a pod-less run, so this one spawns directly.
  const { dir, record } = setup();
  const run = spawnSync(process.execPath, [CHILD, "record-body", record], {
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "child-v8",
      NV_DEV_SERVER_ROLE: "control",
      ACPX_OWNER_PLACEMENT: "pod",
      ACPX_POD_SA_DIR: options.saDir,
      NV_POD_NAME: "",
      NV_POD_UID: "",
    },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.includes(".tomb.")),
    [],
  );
  const body = JSON.parse(JSON.parse(run.stdout).raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), TODAY_KEYS);
});

test("a pod (NV_POD_* set) with pod mode OFF — a workbench, C1.1 — writes today's body too", async () => {
  const { options } = setup();
  const body = await bodyKeys(makePod("wb"), { ...options, podMode: false });
  assert.deepEqual(Object.keys(body), TODAY_KEYS);
});

test("positive control: the same pod WITH pod mode writes `pod` (name, uid, node, namespace) and a token", async () => {
  const { options } = setup();
  const pod = makePod("agent");
  const body = await bodyKeys(pod, options);
  assert.deepEqual(Object.keys(body), [...TODAY_KEYS, "pod", "token"]);
  assert.deepEqual(body.pod, pod);
});

test("no pod: an unjudgeable holder older than the age bound is broken by compare-and-delete with today's WARNING", async () => {
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
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.includes(".tomb.")),
    [],
  );
});

test("no pod: an unjudgeable holder YOUNGER than the age bound is broken only after the 15 s bound, with the warning (today)", async () => {
  const { options, record } = setup();
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
});

test("no pod: a holder on ANOTHER BOOT is judged dead at once — today's rule, unchanged (why the switch needs NV_POD_*)", async () => {
  const { options, record } = setup();
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
  fs.writeFileSync(`${record}.lock`, raw);
  const started = Date.now();
  const run = await runInPod(undefined, CHILD, ["record-acquire", record], controlShaped(options));
  assert.deepEqual(JSON.parse(run.stdout), { acquired: true });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(
    run.stderr.includes("WARNING"),
    false,
    "a 'dead' holder is broken silently, as today",
  );
});
