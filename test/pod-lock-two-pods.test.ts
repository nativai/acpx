import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  clearNodes,
  clearPods,
  failWith,
  putNode,
  putPod,
  requestLines,
  startKitApi,
  type FakeApiServer,
} from "./pod-kit-api-helpers.js";
import {
  KIT_NAMESPACE,
  makePod,
  makeServiceAccountDir,
  makeTestHome,
  podEnv,
  runInPod,
  type KitPod,
  type PodEnvOptions,
} from "./pod-kit/two-pods.js";

// C3.2 as amended (A-4) across REAL processes with pod identities over one directory (brick
// 8d85cb47, TEST-PLAN NG-K7.2a/b/c at U). A control pod and agent pods are told apart by the C1.1
// test seam (`ACPX_POD_TEST_HOME`, `.nv-agent`). The cross-MACHINE run (control pod ↔ workbench over
// NFS) is the evidence script under the brick's verification/ folder; the same kit drives it.

const CHILD = fileURLToPath(new URL("./fixtures/pod-lock-child.js", import.meta.url));

let api: FakeApiServer;
let root: string;
let saDir: string;
let control: KitPod;
let controlHome: string;
test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-twopods-"));
  saDir = makeServiceAccountDir(root);
  api = await startKitApi(KIT_NAMESPACE);
  control = makePod("control");
  controlHome = makeTestHome(root, "control");
});
test.after(async () => {
  await api.close();
});
test.beforeEach(() => {
  clearPods(api);
  clearNodes(api);
  failWith(api, undefined);
  api.reset();
});

function asControl(): PodEnvOptions {
  return { saDir, apiUrl: api.url, testHome: controlHome, stateHome: root };
}
function asAgentPod(pod: KitPod): PodEnvOptions {
  return {
    saDir,
    apiUrl: api.url,
    testHome: makeTestHome(root, "agent-pod", pod),
    stateHome: root,
  };
}
function registerLive(...pods: KitPod[]): void {
  for (const pod of pods) {
    putPod(api, pod.name, { uid: pod.uid, phase: "Running" });
    putNode(api, pod.node, "True");
  }
}
function deadBodyOf(pod: KitPod): string {
  return JSON.stringify({
    pid: 2_147_483_000,
    host: "gone-machine",
    pod,
    token: `t-${Math.random()}`,
  });
}
function ledger(pod: KitPod): Record<string, unknown>[] {
  const file = path.join(root, ".acpx", "lock-breaks", `${pod.uid}.ndjson`);
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
}

test("NG-K7.2a: a LIVE holder in agent pod A, its lock aged 10 min, is not broken by the control pod (proof: exists)", async () => {
  const a = makePod("a");
  registerLive(a, control);
  const lock = path.join(fs.mkdtempSync(path.join(root, "live-")), "x.json.lock");
  const holder = spawn(process.execPath, [CHILD, "hold", lock, "6000"], {
    env: podEnv(a, asAgentPod(a)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let holderOut = "";
  holder.stdout.on("data", (chunk: Buffer) => (holderOut += chunk.toString("utf8")));
  const holderDone = new Promise<number | null>((resolve) => holder.on("close", resolve));
  while (!holderOut.includes("\n")) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const held = fs.readFileSync(lock, "utf8");
  assert.deepEqual(JSON.parse(held).pod, a, "the body names pod A");
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, old, old);

  const waiter = await runInPod(control, CHILD, ["acquire", lock, "2500"], asControl());
  assert.equal(JSON.parse(waiter.stdout).timeout, true, waiter.stdout + waiter.stderr);
  assert.equal(waiter.stderr.includes("broke"), false);
  assert.equal(fs.readFileSync(lock, "utf8"), held, "still pod A's lock, byte for byte");
  assert.equal(await holderDone, 0);
  assert.equal(fs.existsSync(lock), false, "pod A released its own lock (it was never replaced)");
  assert.deepEqual(ledger(control), []);
});

test("NEVER: a waiter in agent pod B does not break pod A's lock although A is proven gone — and never asks the API", async () => {
  const a = makePod("a");
  const b = makePod("b");
  putNode(api, a.node, "True"); // A absent, its node Ready ⇒ gone, if anyone asked
  const lock = path.join(fs.mkdtempSync(path.join(root, "agent-never-")), "x.json.lock");
  const raw = deadBodyOf(a);
  fs.writeFileSync(lock, raw);
  const run = await runInPod(b, CHILD, ["acquire", lock, "1500"], asAgentPod(b));
  assert.equal(JSON.parse(run.stdout).timeout, true, run.stdout + run.stderr);
  assert.equal(fs.readFileSync(lock, "utf8"), raw);
  assert.deepEqual(requestLines(api), [], "no request from an agent pod");
  assert.deepEqual(ledger(b), []);
});

test("NG-K7.2b: pod A gone but its node NotReady → the control pod does not break (unknown is alive)", async () => {
  const a = makePod("a");
  putNode(api, a.node, "False");
  const lock = path.join(fs.mkdtempSync(path.join(root, "notready-")), "x.json.lock");
  const raw = deadBodyOf(a);
  fs.writeFileSync(lock, raw);
  const run = await runInPod(control, CHILD, ["acquire", lock, "1500"], asControl());
  assert.equal(JSON.parse(run.stdout).timeout, true);
  assert.equal(fs.readFileSync(lock, "utf8"), raw);
  assert.ok(requestLines(api).length >= 2, "the control pod asked");
});

test("NG-K7.2c: 20 rounds × (6 control-pod + 6 agent-pod-B racers) on a proven-dead pod-A holder — one break per round, by the control pod, never two inside", async () => {
  const a = makePod("a");
  const b = makePod("b");
  putNode(api, a.node, "True"); // pod A absent from the API, its node Ready ⇒ gone
  registerLive(b, control); // the racers' own pods exist: a racer holding the lock is a LIVE holder
  const bOptions = asAgentPod(b);
  for (let round = 0; round < 20; round += 1) {
    const dir = fs.mkdtempSync(path.join(root, `race-${round}-`));
    const markers = path.join(dir, "markers");
    fs.mkdirSync(markers);
    const lock = path.join(dir, "x.json.lock");
    fs.writeFileSync(lock, deadBodyOf(a));
    const runs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0
          ? runInPod(control, CHILD, ["race", lock, markers, `ctl${i}`, "20000"], asControl())
          : runInPod(b, CHILD, ["race", lock, markers, `b${i}`, "20000"], bOptions),
      ),
    );
    for (const run of runs) {
      assert.equal(run.code, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).overlap, 0, `round ${round}: two racers inside`);
    }
    assert.equal(fs.existsSync(lock), false, "the last racer released");
  }
  const breaks = ledger(control);
  assert.equal(breaks.length, 20, "exactly one break per round, all in the control pod's ledger");
  assert.deepEqual([...new Set(breaks.map((line) => line.proof))], ["pod-gone"]);
  assert.deepEqual(ledger(b), [], "agent pod B never broke anything");
});
