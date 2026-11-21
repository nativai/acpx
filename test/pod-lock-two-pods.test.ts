import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  KIT_NAMESPACE,
  makePod,
  makeServiceAccountDir,
  podEnv,
  runInPod,
  type KitPod,
} from "./pod-kit/two-pods.js";
import { startFakeApi, type FakeApi } from "./pod-lock-fake-api.js";

// C3.2 across two REAL processes with two pod identities over one directory (brick 8d85cb47,
// TEST-PLAN NG-K7.2a/b/c at U). The cross-MACHINE run (control pod ↔ workbench over NFS) is the
// evidence script under the brick's verification/ folder; the same kit drives it.

const CHILD = fileURLToPath(new URL("./fixtures/pod-lock-child.js", import.meta.url));

let api: FakeApi;
let saDir: string;
let root: string;
test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-twopods-"));
  saDir = makeServiceAccountDir(root);
  api = await startFakeApi(KIT_NAMESPACE);
});
test.after(async () => {
  await api.close();
});
test.beforeEach(() => {
  api.state.pods.clear();
  api.state.nodes.clear();
  api.state.failure = undefined;
});

function deadBodyOf(pod: KitPod): string {
  return JSON.stringify({
    pid: 2_147_483_000,
    host: "gone-machine",
    pod,
    token: `t-${Math.random()}`,
  });
}

test("NG-K7.2a: a LIVE holder in pod A, its lock aged 10 min, is not broken by a waiter in pod B (proof: exists)", async () => {
  const a = makePod("a");
  const b = makePod("b");
  api.state.pods.set(a.name, { uid: a.uid, phase: "Running" });
  const lock = path.join(fs.mkdtempSync(path.join(root, "live-")), "x.json.lock");
  const holder = spawn(process.execPath, [CHILD, "hold", lock, "6000"], {
    env: podEnv(a, { saDir, apiUrl: api.url }),
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

  const waiter = await runInPod(b, CHILD, ["acquire", lock, "2500"], { saDir, apiUrl: api.url });
  assert.equal(JSON.parse(waiter.stdout).timeout, true, waiter.stdout + waiter.stderr);
  assert.equal(waiter.stderr.includes("broke"), false);
  assert.equal(fs.readFileSync(lock, "utf8"), held, "still pod A's lock, byte for byte");
  assert.equal(await holderDone, 0);
  assert.equal(fs.existsSync(lock), false, "pod A released its own lock (it was never replaced)");
});

test("NG-K7.2b: pod A gone but its node NotReady → a waiter in pod B does not break (unknown is alive)", async () => {
  const a = makePod("a");
  api.state.nodes.set(a.node, "False");
  const lock = path.join(fs.mkdtempSync(path.join(root, "notready-")), "x.json.lock");
  const raw = deadBodyOf(a);
  fs.writeFileSync(lock, raw);
  const run = await runInPod(makePod("b"), CHILD, ["acquire", lock, "1500"], {
    saDir,
    apiUrl: api.url,
  });
  assert.equal(JSON.parse(run.stdout).timeout, true);
  assert.equal(fs.readFileSync(lock, "utf8"), raw);
});

test("NG-K7.2c: 20 rounds × 12 breakers in two pods on a proven-dead pod-A holder — one break per round, never two inside", async () => {
  const a = makePod("a");
  const pods = [makePod("b"), makePod("c")];
  api.state.nodes.set(a.node, "True"); // pod A absent from the API, its node Ready ⇒ gone
  for (const pod of pods) {
    // The racers' own pods exist: a racer holding the lock is a LIVE foreign holder to the other pod.
    api.state.pods.set(pod.name, { uid: pod.uid, phase: "Running" });
    api.state.nodes.set(pod.node, "True");
  }
  for (let round = 0; round < 20; round += 1) {
    const dir = fs.mkdtempSync(path.join(root, `race-${round}-`));
    const markers = path.join(dir, "markers");
    fs.mkdirSync(markers);
    const lock = path.join(dir, "x.json.lock");
    fs.writeFileSync(lock, deadBodyOf(a));
    const runs = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        runInPod(pods[i % 2], CHILD, ["race", lock, markers, String(i), "20000"], {
          saDir,
          apiUrl: api.url,
        }),
      ),
    );
    for (const run of runs) {
      assert.equal(run.code, 0, run.stderr);
      assert.equal(JSON.parse(run.stdout).overlap, 0, `round ${round}: two racers inside`);
    }
    const breaks = runs.map((run) => run.stderr.match(/proven gone/g)?.length ?? 0);
    assert.equal(
      breaks.reduce((x, y) => x + y, 0),
      1,
      `round ${round}: exactly one breaker broke the dead holder`,
    );
    assert.deepEqual(
      fs.readdirSync(dir).filter((n) => n.includes(".tomb.")),
      [],
      `round ${round}`,
    );
    assert.equal(fs.existsSync(lock), false, "the last racer released");
  }
});
