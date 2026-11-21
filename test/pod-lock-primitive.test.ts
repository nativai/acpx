import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { withStageLock, stageLockPath } from "../src/acp/fork-source-staging.js";
import { queueLeaseGuardPath, withQueueLeaseMutation } from "../src/cli/queue/lease-mutation.js";
import type { DeathProof } from "../src/pod/death-proof.js";
import type { PodIdentity } from "../src/pod/identity.js";
import {
  acquireIdentityFileLock,
  breakByTombstone,
  identityLockBody,
  releaseIdentityFileLock,
  setPodLockDepsForTests,
  sweepOwnPodLocks,
  TOMBSTONE_STALE_MS,
  tombstonePath,
  type IdentityLockPolicy,
} from "../src/session/persistence/identity-file-lock.js";
import { withRecordFileLock } from "../src/session/persistence/record-file-lock.js";

// C3.2 — the lock primitive across pods (brick 8d85cb47; TEST-PLAN NG-K7.2a/b/c/e/f). Each row is a
// committed negative case for one guarantee; the two-process and cross-machine rows live in
// test/pod-lock-two-pods.test.ts.

const OWN: PodIdentity = { name: "ag-own", uid: "own-uid-0000", node: "node-own", namespace: "ns" };
const OTHER: PodIdentity = {
  name: "ag-other",
  uid: "other-uid-0000",
  node: "node-other",
  namespace: "ns",
};

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(child.pid, "spawned a short-lived process");
  return child.pid;
}

/** A body naming `pod`, holder pid exited — what a crashed process in that pod leaves behind. */
function bodyIn(pod: PodIdentity, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: deadPid(),
    host: "elsewhere",
    pod,
    token: `t-${Math.random()}`,
    ...extra,
  });
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acpx-podlock-"));
}

function plant(lockPath: string, raw: string, ageMs = 10 * 60_000): void {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, raw);
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, old, old);
}

function policy(budgetMs = 400): IdentityLockPolicy {
  return {
    label: "test lock",
    budgetMs,
    staleMs: 100, // far below the planted age: the age rule WOULD break, if it applied
    legacyBody: () => ({ pid: process.pid }),
    makeTimeoutError: (file, holder) =>
      Object.assign(new Error(`test-timeout ${file}: ${holder}`), { code: "test-timeout" }),
  };
}

let proofCalls: number;
function useDeps(proof: DeathProof, extra: Parameters<typeof setPodLockDepsForTests>[0] = {}) {
  proofCalls = 0;
  setPodLockDepsForTests({
    ownPod: () => OWN,
    lockPod: () => OWN,
    proveDeath: async () => {
      proofCalls += 1;
      return proof;
    },
    ...extra,
  });
}

let stderr: string[];
const realWrite = process.stderr.write.bind(process.stderr);
test.beforeEach(() => {
  stderr = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});
test.afterEach(() => {
  process.stderr.write = realWrite;
  setPodLockDepsForTests(undefined);
});

function tombstones(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.includes(".tomb."));
}

for (const proof of ["exists", "unknown"] as const) {
  test(`NG-K7.2a: a holder in ANOTHER pod, 10 min old, pid dead here, proof=${proof} → NOT broken; the waiter times out`, async () => {
    useDeps(proof);
    const dir = tmpDir();
    const lock = path.join(dir, "x.json.lock");
    const raw = bodyIn(OTHER);
    plant(lock, raw);
    await assert.rejects(acquireIdentityFileLock(lock, policy(1_500)), { code: "test-timeout" });
    assert.equal(fs.readFileSync(lock, "utf8"), raw, "the lock is byte-identical");
    assert.deepEqual(tombstones(dir), []);
    assert.equal(stderr.join("").includes("broke"), false, "no break line at all");
    assert.ok(proofCalls >= 1 && proofCalls <= 3, `death proof asked at most ~1/s (${proofCalls})`);
  });
}

test("NG-K7.2a: the real record lock (20 s budget) waits it out against a foreign holder and throws record-lock-timeout", async () => {
  useDeps("exists");
  const dir = tmpDir();
  const record = path.join(dir, "rec.json");
  const raw = bodyIn(OTHER);
  plant(`${record}.lock`, raw);
  await assert.rejects(
    withRecordFileLock(record, async () => "wrote"),
    { code: "record-lock-timeout" },
  );
  assert.equal(fs.readFileSync(`${record}.lock`, "utf8"), raw);
});

test("NG-K7.2a: the queue lease guard (2 s / 10 s) is not broken by its 10 s age rule for a foreign holder", async () => {
  useDeps("unknown");
  const home = tmpDir();
  const saved = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = home;
  try {
    const guard = queueLeaseGuardPath("session-x");
    const raw = bodyIn(OTHER);
    plant(guard, raw);
    await assert.rejects(
      withQueueLeaseMutation("session-x", async () => "mutated"),
      {
        code: "queue-lease-guard-timeout",
      },
    );
    assert.equal(fs.readFileSync(guard, "utf8"), raw);
  } finally {
    if (saved === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = saved;
    }
  }
});

test("NG-K7.2f: the fork-source stage lock is on the primitive — a foreign holder 10 min old is not taken over", async () => {
  useDeps("exists");
  const dir = tmpDir();
  const staged = path.join(dir, "dest", "src.jsonl");
  const raw = bodyIn(OTHER);
  plant(stageLockPath(staged), raw);
  await assert.rejects(
    withStageLock(staged, async () => "ran", { staleMs: 100, maxWaitMs: 300, pollMs: 20 }),
    /Timed out waiting for another copy/,
  );
  assert.equal(fs.readFileSync(stageLockPath(staged), "utf8"), raw);
});

test("NG-K7.2f positive: a stage lock left by a dead process of THIS pod is broken at once and reported as taken over", async () => {
  useDeps("unknown");
  const dir = tmpDir();
  const staged = path.join(dir, "dest", "src.jsonl");
  plant(stageLockPath(staged), bodyIn(OWN), 0);
  const tookOver = await withStageLock(staged, async (lock) => lock.tookOverStale, {
    maxWaitMs: 2_000,
  });
  assert.equal(tookOver, true);
  assert.equal(fs.existsSync(stageLockPath(staged)), false, "released");
});

test("NG-K7.2b: a foreign holder whose pod is proven GONE is broken by tombstone, with a structured line", async () => {
  useDeps("gone");
  const dir = tmpDir();
  const lock = path.join(dir, "x.json.lock");
  plant(lock, bodyIn(OTHER));
  const content = await acquireIdentityFileLock(lock, policy());
  assert.equal(fs.readFileSync(lock, "utf8"), content, "we hold it now");
  assert.deepEqual(tombstones(dir), [], "the tombstone is removed");
  const line = stderr.join("");
  assert.match(
    line,
    /broke test lock .*holder pod ag-other \(uid other-uid-0000, node node-other\) proven gone/,
  );
  assert.match(line, /breaker pod ag-own/);
  await releaseIdentityFileLock(lock, content);
});

test("same pod: a holder whose pid is dead here is judged by pid, as today, and broken", async () => {
  useDeps("exists"); // never consulted for the own pod
  const dir = tmpDir();
  const lock = path.join(dir, "x.json.lock");
  plant(lock, bodyIn(OWN), 0);
  const content = await acquireIdentityFileLock(lock, policy());
  assert.equal(fs.readFileSync(lock, "utf8"), content);
  assert.equal(proofCalls, 0, "the death proof is not asked about our own pod");
  assert.deepEqual(tombstones(dir), []);
});

test("same pod (negative): a LIVE holder of this pod is never broken at any age", async () => {
  useDeps("gone");
  const dir = tmpDir();
  const lock = path.join(dir, "x.json.lock");
  const raw = JSON.stringify(identityLockBody({ pid: process.pid }));
  plant(lock, raw);
  await assert.rejects(acquireIdentityFileLock(lock, policy()), { code: "test-timeout" });
  assert.equal(fs.readFileSync(lock, "utf8"), raw);
});

test("a malformed `pod` field is still a pod field: foreign, never provable, never broken — even with proof gone", async () => {
  useDeps("gone");
  const dir = tmpDir();
  const lock = path.join(dir, "x.json.lock");
  const raw = JSON.stringify({ pid: deadPid(), pod: { name: "ag-x" } });
  plant(lock, raw);
  await assert.rejects(acquireIdentityFileLock(lock, policy()), { code: "test-timeout" });
  assert.equal(fs.readFileSync(lock, "utf8"), raw);
});

test("a pod-mode body names the pod with node and namespace, and a random token per acquisition", () => {
  useDeps("unknown");
  const a = identityLockBody({ pid: 1 });
  const b = identityLockBody({ pid: 1 });
  assert.deepEqual(a.pod, OWN);
  assert.equal(typeof a.token, "string");
  assert.notEqual(a.token, b.token, "two acquisitions never write the same bytes");
});

test("tombstone name: <lock>.tomb.<first 16 hex of SHA-256 of the judged body>", () => {
  assert.equal(
    tombstonePath("/d/x.lock", "abc"),
    "/d/x.lock.tomb.ba7816bf8f01cfea", // sha256("abc") = ba7816bf8f01cfea414140de5dae2223…
  );
});

test("NG-K7.2c negative: a tombstone whose content is NOT the judged body → the breaker unlinks it and stops", async () => {
  const dir = tmpDir();
  const lock = path.join(dir, "x.json.lock");
  const judged = bodyIn(OTHER);
  const successor = bodyIn(OWN);
  plant(lock, successor, 0); // a faster breaker already replaced the judged holder
  assert.equal(await breakByTombstone(lock, judged), "changed");
  assert.equal(fs.readFileSync(lock, "utf8"), successor, "the successor's lock survives");
  assert.deepEqual(tombstones(dir), []);
});

test("NG-K7.2c: a second breaker gets EEXIST on the tombstone and only retries — the lock untouched", async () => {
  const dir = tmpDir();
  const lock = path.join(dir, "x.json.lock");
  const judged = bodyIn(OTHER);
  plant(lock, judged);
  fs.linkSync(lock, tombstonePath(lock, judged)); // the first breaker, mid-break
  assert.equal(await breakByTombstone(lock, judged), "busy");
  assert.equal(fs.readFileSync(lock, "utf8"), judged);
});

test("wedge: a breaker killed between link and unlink leaves a wedge that a waiter reports BY NAME after its budget; nothing removes it by age", async () => {
  const later = Date.now() + 10 * TOMBSTONE_STALE_MS;
  useDeps("gone", { nowMs: () => later });
  const dir = tmpDir();
  const lock = path.join(dir, "x.json.lock");
  const judged = bodyIn(OTHER);
  plant(lock, judged);
  const tomb = tombstonePath(lock, judged);
  fs.linkSync(lock, tomb); // the killed breaker's link
  const error = await acquireIdentityFileLock(lock, policy()).then(
    () => assert.fail("must not acquire through a wedge"),
    (caught: Error & { code?: string }) => caught,
  );
  assert.equal(error.code, "test-timeout", "today's typed timeout");
  assert.ok(error.message.includes(`WEDGED: lock ${lock}`), error.message);
  assert.ok(error.message.includes(`tombstone ${tomb}`), error.message);
  assert.match(error.message, /\(age \d+ ms\)/);
  const swept = await sweepOwnPodLocks({ dirs: [dir] });
  assert.deepEqual(swept.tombstonesRemoved, [], "the sweep leaves a wedge alone too");
  assert.equal(fs.readFileSync(lock, "utf8"), judged);
  assert.equal(fs.existsSync(tomb), true);
});

test("stalled breaker: resuming after its tombstone's age, it never deletes a lock it did not judge (inode re-check)", async () => {
  const dir = tmpDir();
  const lock = path.join(dir, "x.json.lock");
  const judged = bodyIn(OTHER);
  const fresh = bodyIn(OWN);
  plant(lock, judged);
  let now = Date.now();
  useDeps("gone", {
    nowMs: () => now,
    afterTombstoneLinked: async () => {
      // While this breaker is frozen: the judged lock goes, a new holder takes the path, time passes.
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, fresh);
      now += 2 * TOMBSTONE_STALE_MS;
    },
  });
  assert.equal(await breakByTombstone(lock, judged), "changed");
  assert.equal(fs.readFileSync(lock, "utf8"), fresh, "the new holder's lock is intact");
  assert.deepEqual(tombstones(dir), []);
});

test("stalled breaker positive control: frozen past 60 s while the lock is unchanged, it completes its break", async () => {
  const dir = tmpDir();
  const lock = path.join(dir, "x.json.lock");
  const judged = bodyIn(OTHER);
  plant(lock, judged);
  let now = Date.now();
  useDeps("gone", {
    nowMs: () => now,
    afterTombstoneLinked: async () => {
      now += 2 * TOMBSTONE_STALE_MS;
    },
  });
  assert.equal(await breakByTombstone(lock, judged), "broken");
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(tombstones(dir), []);
});

test("a tombstone older than 60 s whose lock is GONE (absent, or another file) is removed by whoever sees it", async () => {
  let now = Date.now();
  useDeps("unknown", { nowMs: () => now });
  const dir = tmpDir();
  const orphan = tombstonePath(path.join(dir, "a.json.lock"), "body-a"); // its lock is absent
  fs.writeFileSync(orphan, "body-a");
  const replacedLock = path.join(dir, "b.json.lock");
  fs.writeFileSync(replacedLock, "new holder");
  const replaced = tombstonePath(replacedLock, "body-b"); // its lock is another file
  fs.writeFileSync(replaced, "body-b");
  now += TOMBSTONE_STALE_MS / 2;
  assert.deepEqual((await sweepOwnPodLocks({ dirs: [dir] })).tombstonesRemoved, [], "not yet 60 s");
  now += TOMBSTONE_STALE_MS;
  assert.deepEqual(
    (await sweepOwnPodLocks({ dirs: [dir] })).tombstonesRemoved.toSorted(),
    [orphan, replaced].toSorted(),
  );
  assert.equal(fs.readFileSync(replacedLock, "utf8"), "new holder");
});

test("one winner in-process: 16 concurrent acquirers on a proven-dead foreign holder — one break, never two inside", async () => {
  useDeps("gone");
  const dir = tmpDir();
  const lock = path.join(dir, "x.json.lock");
  plant(lock, bodyIn(OTHER));
  let inside = 0;
  let overlap = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      const content = await acquireIdentityFileLock(lock, policy(10_000));
      inside += 1;
      if (inside > 1) {
        overlap += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      inside -= 1;
      await releaseIdentityFileLock(lock, content);
    }),
  );
  assert.equal(overlap, 0);
  assert.equal(stderr.join("").match(/proven gone/g)?.length, 1, "exactly one break");
  assert.deepEqual(tombstones(dir), []);
});

test("NG-K7.2e: the sweep removes only THIS pod's locks whose pid is dead here — never a live one, a foreign one, or a lease", async () => {
  useDeps("gone"); // the sweep never asks: foreign holders are not its business
  const dir = tmpDir();
  const ownDead = path.join(dir, "a.json.lock");
  const ownDeadGuard = path.join(dir, "k.lock.guard");
  const ownLive = path.join(dir, "b.json.lock");
  const foreignDead = path.join(dir, "c.json.lock");
  const lease = path.join(dir, "k.lock"); // the queue LEASE — not a lock of the primitive
  plant(ownDead, bodyIn(OWN));
  plant(ownDeadGuard, bodyIn(OWN));
  plant(ownLive, JSON.stringify(identityLockBody({ pid: process.pid })));
  plant(foreignDead, bodyIn(OTHER));
  plant(lease, bodyIn(OWN));
  const result = await sweepOwnPodLocks({ dirs: [dir, path.join(dir, "missing")] });
  assert.deepEqual(result.removed.toSorted(), [ownDead, ownDeadGuard].toSorted());
  for (const kept of [ownLive, foreignDead, lease]) {
    assert.equal(fs.existsSync(kept), true, `${kept} kept`);
  }
  assert.equal(proofCalls, 0);
});

test("NG-K7.2e negative: with no own pod identity the sweep removes no lock", async () => {
  setPodLockDepsForTests({ ownPod: () => undefined, lockPod: () => undefined });
  const dir = tmpDir();
  const lock = path.join(dir, "a.json.lock");
  plant(lock, bodyIn(OWN));
  assert.deepEqual((await sweepOwnPodLocks({ dirs: [dir] })).removed, []);
  assert.equal(fs.existsSync(lock), true);
});

test("NFS: a tombstone link that fails with ESTALE (another client unlinked the lock) is a retry, never a crash", async () => {
  // Measured across the control pod and a workbench (verification/cross-machine, run 20261121T115728Z):
  // errno 116 from link(lock, tomb) crashed 8 of 80 racers before this was handled.
  // ⚠️ KEEP THE MOCK'S SHAPE REAL (below): the first version threw `code: "ESTALE"`, which Node never
  // produces, and stayed green while 12 of 160 racers still crashed on the real thing.
  useDeps("gone");
  const dir = tmpDir();
  const lock = path.join(dir, "x.json.lock");
  plant(lock, bodyIn(OTHER));
  const realLink = fsp.link.bind(fsp);
  let staleThrown = 0;
  const link = mock.method(fsp, "link", async (from: string, to: string) => {
    if (to.includes(".tomb.") && staleThrown === 0) {
      staleThrown += 1;
      // The REAL shape (measured on NFS, run 20261121T120254Z): libuv has no name for 116, so `code`
      // is NOT "ESTALE" — a mock with code "ESTALE" passed while the product still crashed.
      throw Object.assign(
        new Error(
          `Unknown system error -116: Unknown system error -116, link '${from}' -> '${to}'`,
        ),
        { code: "Unknown system error -116", errno: -116, syscall: "link" },
      );
    }
    return await realLink(from, to);
  });
  try {
    const content = await acquireIdentityFileLock(lock, policy(5_000));
    assert.equal(staleThrown, 1, "the ESTALE path was taken");
    assert.equal(fs.readFileSync(lock, "utf8"), content, "and the acquire still succeeded");
    await releaseIdentityFileLock(lock, content);
  } finally {
    link.mock.restore();
  }
});
