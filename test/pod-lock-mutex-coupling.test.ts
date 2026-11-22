import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { queueLeaseGuardPath, withQueueLeaseMutation } from "../src/cli/queue/lease-mutation.js";
import type { PodIdentity } from "../src/pod/identity.js";
import {
  acquireIdentityFileLock,
  lockBreakLedgerPath,
  releaseIdentityFileLock,
  setPodLockDepsForTests,
  type IdentityLockPolicy,
} from "../src/session/persistence/identity-file-lock.js";

// C1 (test-engineer, round 3): the PRODUCTION coupling of the one break mutex, pinned WITHOUT the
// test-pod seam — so the mutex has its production name, the one name every lock of a pod shares.
// A breaker stalled inside it on lock X makes an unrelated waiter on lock Y — one that also needs to
// break something — wait for the mutex, and out of budget it fails with the typed timeout, never an
// unlocked write; and Y is acquired promptly once the stall ends.
//
// ⚠️ THIS ROW HOLDS THE POD-WIDE NAME FOR ~2.3 s. Concurrent test files share this network namespace,
// so a file whose ordinary break lands in that window waits a moment (session-index-lock T15 asserts
// 1 s). That is the coupling itself, pinned on purpose; it is the reason every OTHER in-process row
// runs under the seam (pod-lock-primitive.test.ts).

const OWN: PodIdentity = {
  name: "ag-own",
  uid: "own-uid-coupling",
  node: "node-own",
  namespace: "ns",
};

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(child.pid);
  return child.pid;
}

function deadBody(): string {
  return JSON.stringify({ pid: deadPid(), host: "gone", pod: OWN, token: `t-${Math.random()}` });
}

test("C1 (no seam): a breaker stalled inside the break mutex on X makes a waiter on Y time out TYPED (queue-lease-guard-timeout), never unlocked — and Y is acquired promptly after the stall", async () => {
  assert.equal(
    process.env.ACPX_POD_TEST_HOME,
    undefined,
    "this row must run WITHOUT the test-pod seam",
  );
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-coupling-"));
  const savedState = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = stateHome;
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  let stalls = 0;
  setPodLockDepsForTests({
    ownPod: () => OWN,
    lockPod: () => OWN,
    podModeRequested: () => false,
    place: () => "control",
    beforeUnlink: async () => {
      stalls += 1;
      if (stalls === 1) {
        entered();
        await stalled; // the breaker of X holds the one mutex, past its re-read, before its unlink
      }
    },
  });
  try {
    // X: an unrelated lock whose own-pod holder is dead — its breaker takes the mutex and stalls.
    const lockX = path.join(stateHome, "x.json.lock");
    fs.writeFileSync(lockX, deadBody());
    const policyX: IdentityLockPolicy = {
      label: "coupling X",
      budgetMs: 30_000,
      staleMs: 60_000,
      legacyBody: () => ({ pid: process.pid }),
      makeTimeoutError: (file) => new Error(`X timeout ${file}`),
    };
    const breakerOfX = acquireIdentityFileLock(lockX, policyX);
    await inside;

    // Y: the queue lease guard, its holder dead too, so the waiter needs the same mutex.
    const guardY = queueLeaseGuardPath("session-y");
    fs.mkdirSync(path.dirname(guardY), { recursive: true });
    const planted = deadBody();
    fs.writeFileSync(guardY, planted);
    let acted = false;
    const started = Date.now();
    await assert.rejects(
      withQueueLeaseMutation("session-y", async () => {
        acted = true;
      }),
      { code: "queue-lease-guard-timeout" },
    );
    const waited = Date.now() - started;
    assert.equal(acted, false, "never an unlocked mutation");
    assert.equal(
      fs.readFileSync(guardY, "utf8"),
      planted,
      "Y's lock untouched: its break never ran",
    );
    assert.ok(
      waited >= 1_500 && waited < 6_000,
      `typed timeout within the guard's bound, took ${waited} ms`,
    );

    // The stall ends: X completes, and Y is acquired promptly.
    release();
    await releaseIdentityFileLock(lockX, await breakerOfX);
    const resumed = Date.now();
    await withQueueLeaseMutation("session-y", async () => {
      acted = true;
    });
    assert.equal(acted, true);
    assert.ok(
      Date.now() - resumed < 1_500,
      `Y acquired promptly after the stall (${Date.now() - resumed} ms)`,
    );
    assert.equal(fs.existsSync(lockBreakLedgerPath(OWN.uid)), true, "both breaks were recorded");
  } finally {
    release();
    setPodLockDepsForTests(undefined);
    if (savedState === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = savedState;
    }
  }
});

test("C1: the break-ledger line is written AFTER the mutex is released — a waiter can take the mutex while the append is still in flight", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-coupling-ledger-"));
  const savedState = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = stateHome;
  const fsp = await import("node:fs/promises");
  const realAppend = fsp.default.appendFile.bind(fsp.default);
  let appendStarted!: () => void;
  const started = new Promise<void>((resolve) => (appendStarted = resolve));
  let releaseAppend!: () => void;
  const slowAppend = new Promise<void>((resolve) => (releaseAppend = resolve));
  const { mock } = await import("node:test");
  const spy = mock.method(fsp.default, "appendFile", async (file: string, ...rest: unknown[]) => {
    if (file.endsWith(".ndjson")) {
      appendStarted();
      await slowAppend; // a slow NFS append
    }
    return await (realAppend as (...args: unknown[]) => Promise<void>)(file, ...rest);
  });
  setPodLockDepsForTests({
    ownPod: () => OWN,
    lockPod: () => OWN,
    podModeRequested: () => false,
    place: () => "control",
  });
  try {
    const lock = path.join(stateHome, "z.json.lock");
    fs.writeFileSync(lock, deadBody());
    const breaking = acquireIdentityFileLock(lock, {
      label: "coupling Z",
      budgetMs: 30_000,
      staleMs: 60_000,
      legacyBody: () => ({ pid: process.pid }),
      makeTimeoutError: (file) => new Error(`Z timeout ${file}`),
    });
    await started; // the append is in flight …
    const { withBreakMutex } = await import("../src/session/persistence/identity-file-lock.js");
    // … and the mutex is already FREE: a waiter takes it at once.
    assert.equal(await withBreakMutex(500, async () => "got it"), "got it");
    releaseAppend();
    await releaseIdentityFileLock(lock, await breaking);
  } finally {
    releaseAppend();
    spy.mock.restore();
    setPodLockDepsForTests(undefined);
    if (savedState === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = savedState;
    }
  }
});
