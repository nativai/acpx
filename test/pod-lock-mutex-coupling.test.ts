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

type BreakLine = {
  ts: string;
  lock: string;
  holder: { token: string | null };
  breaker: { pod: PodIdentity };
  proof: string;
};

/**
 * T2: the coupling row's "both breaks recorded". EXACTLY one line per expected break (a count, not a
 * file-exists), each naming its own lock and holder token, proven by pid, by this pod as breaker. Its
 * committed negative cases are the T2 row below: a ledger of one line, an empty one, a duplicated one
 * and a wrong holder each make it throw.
 */
function assertBreaksRecorded(
  lines: readonly BreakLine[],
  expected: readonly { lock: string; token: string }[],
): void {
  assert.equal(
    lines.length,
    expected.length,
    `exactly ${expected.length} breaks, got ${lines.length}`,
  );
  const key = (lock: string, token: string | null, proof: string): string =>
    JSON.stringify([lock, token, proof]);
  assert.deepEqual(
    lines
      .map((line) => key(line.lock, line.holder.token, line.proof))
      .toSorted((a, b) => a.localeCompare(b)),
    expected.map((e) => key(e.lock, e.token, "pid")).toSorted((a, b) => a.localeCompare(b)),
    "one line per broken lock, each naming its own holder's token, proven by pid",
  );
  for (const line of lines) {
    assert.deepEqual(line.breaker.pod, OWN);
  }
}

/** The pod's break ledger, one parsed object per line. A missing file is an empty ledger. */
function ledger(uid: string): BreakLine[] {
  const file = lockBreakLedgerPath(uid);
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as BreakLine)
    : [];
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
    const plantedX = deadBody();
    fs.writeFileSync(lockX, plantedX);
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
    // T2 (TE2 round 4): the old check was `existsSync` — green with ONE line. Count them, read whose.
    assertBreaksRecorded(ledger(OWN.uid), [
      { lock: lockX, token: (JSON.parse(plantedX) as { token: string }).token },
      { lock: guardY, token: (JSON.parse(planted) as { token: string }).token },
    ]);
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

test("L2: a break's ledger `ts` is the time of ITS unlink, not of its write — a delayed append of the earlier break never lands a later time on it", async () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-coupling-ts-"));
  const savedState = process.env.ACPX_STATE_HOME;
  const savedHome = process.env.ACPX_POD_TEST_HOME;
  process.env.ACPX_STATE_HOME = stateHome;
  // The seam's own mutex name (carries the pod uid): this row only contends with itself.
  process.env.ACPX_POD_TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-coupling-ts-home-"));
  const fsp = await import("node:fs/promises");
  const realMkdir = fsp.default.mkdir.bind(fsp.default);
  const lockX = path.join(stateHome, "x.json.lock");
  const lockY = path.join(stateHome, "y.json.lock");
  let xAtLedger!: () => void;
  const xAppending = new Promise<void>((resolve) => (xAtLedger = resolve));
  let letXLand!: () => void;
  const xMayLand = new Promise<void>((resolve) => (letXLand = resolve));
  const { mock } = await import("node:test");
  // ⚠️ WHERE THE DELAY SITS MATTERS: the ledger line is BUILT when `appendFile` is called, so a delay
  // inside `appendFile` is too late — a write-time `ts` would already be fixed and the row would stay
  // green on the old code (measured on 6a49783a). The ledger writer's `mkdir` comes first; holding
  // the first one holds X's whole ledger write, line construction included.
  let ledgerWrites = 0;
  const spy = mock.method(fsp.default, "mkdir", async (dir: string, ...rest: unknown[]) => {
    if (dir.endsWith("lock-breaks")) {
      ledgerWrites += 1;
      if (ledgerWrites === 1) {
        xAtLedger(); // X has unlinked and released the mutex; its ledger write is a slow NFS call
        await xMayLand;
      }
    }
    return await (realMkdir as (...args: unknown[]) => Promise<unknown>)(dir, ...rest);
  });
  // A clock the test moves: X breaks at T1, Y at T2, and X's line is finally written at T3.
  const T1 = Date.UTC(2026, 10, 23, 12, 0, 0);
  const T2 = T1 + 60_000;
  const T3 = T1 + 6 * 60_000;
  let clock = T1;
  setPodLockDepsForTests({
    ownPod: () => OWN,
    lockPod: () => OWN,
    podModeRequested: () => false,
    place: () => "control",
    nowMs: () => clock,
  });
  const policyFor = (label: string): IdentityLockPolicy => ({
    label,
    budgetMs: 30_000,
    staleMs: 60_000,
    legacyBody: () => ({ pid: process.pid }),
    makeTimeoutError: (file) => new Error(`${label} timeout ${file}`),
  });
  try {
    fs.writeFileSync(lockX, deadBody());
    fs.writeFileSync(lockY, deadBody());
    const breakerOfX = acquireIdentityFileLock(lockX, policyFor("ts X"));
    await xAppending; // X's break happened at T1
    clock = T2;
    const heldY = await acquireIdentityFileLock(lockY, policyFor("ts Y")); // Y breaks at T2, writes at once
    clock = T3;
    letXLand(); // X's append finally lands, at T3
    const heldX = await breakerOfX;
    await releaseIdentityFileLock(lockX, heldX);
    await releaseIdentityFileLock(lockY, heldY);

    const lines = ledger(OWN.uid);
    assert.equal(lines.length, 2);
    // control: the delay really did swap the file order (Y's line first), so the row can see a wrong ts
    assert.deepEqual(
      lines.map((line) => line.lock),
      [lockY, lockX],
      "the delayed append landed second",
    );
    const byLock = new Map(lines.map((line) => [line.lock, line.ts]));
    assert.equal(
      byLock.get(lockX),
      new Date(T1).toISOString(),
      "X's ts is its unlink, not its write",
    );
    assert.equal(byLock.get(lockY), new Date(T2).toISOString());
    const inBreakOrder = [...lines]
      .toSorted((a, b) => a.ts.localeCompare(b.ts))
      .map((line) => line.lock);
    assert.deepEqual(inBreakOrder, [lockX, lockY], "sorting by ts gives the break order");
  } finally {
    letXLand();
    spy.mock.restore();
    setPodLockDepsForTests(undefined);
    for (const [name, saved] of [
      ["ACPX_STATE_HOME", savedState],
      ["ACPX_POD_TEST_HOME", savedHome],
    ] as const) {
      if (saved === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved;
      }
    }
  }
});

test("T2: the coupling row's ledger check fails on a ledger of ONE line, an empty one, a duplicated one, a wrong holder — and passes on the right two", () => {
  const line = (lock: string, token: string): BreakLine => ({
    ts: "2026-11-23T12:00:00.000Z",
    lock,
    holder: { token },
    breaker: { pod: OWN },
    proof: "pid",
  });
  const want = [
    { lock: "/x", token: "tx" },
    { lock: "/y", token: "ty" },
  ];
  assertBreaksRecorded([line("/y", "ty"), line("/x", "tx")], want); // either order: the control
  assert.throws(() => assertBreaksRecorded([line("/x", "tx")], want), /exactly 2 breaks, got 1/);
  assert.throws(() => assertBreaksRecorded([], want), /exactly 2 breaks, got 0/);
  assert.throws(() => assertBreaksRecorded([line("/x", "tx"), line("/x", "tx")], want));
  assert.throws(() => assertBreaksRecorded([line("/x", "tx"), line("/y", "WRONG")], want));
  assert.throws(() =>
    assertBreaksRecorded([{ ...line("/x", "tx"), proof: "age" }, line("/y", "ty")], want),
  );
});
