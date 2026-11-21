import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { withStageLock, stageLockPath } from "../src/acp/fork-source-staging.js";
import { queueLeaseGuardPath, withQueueLeaseMutation } from "../src/cli/queue/lease-mutation.js";
import type { DeathProofDetail } from "../src/pod/death-proof.js";
import { lockHostPlace, type LockHostPlace, type PodIdentity } from "../src/pod/identity.js";
import {
  BREAK_MUTEX_NAME,
  breakMutexNameFor,
  acquireIdentityFileLock,
  identityLockBody,
  lockBreakLedgerPath,
  releaseIdentityFileLock,
  setPodLockDepsForTests,
  sweepOwnPodLocks,
  withBreakMutex,
  type IdentityLockPolicy,
} from "../src/session/persistence/identity-file-lock.js";
import { withRecordFileLock } from "../src/session/persistence/record-file-lock.js";
import { makeServiceAccountDir, makeTestHome, runInPod } from "./pod-kit/two-pods.js";

const CHILD = fileURLToPath(new URL("./fixtures/pod-lock-child.js", import.meta.url));

// C3.2 as amended (A-3, A-4, A-5) — the lock primitive across pods (brick 8d85cb47; TEST-PLAN
// NG-K7.2a/b/c/e/f). One committed negative case per "never" of the contract. The two-process rows
// are test/pod-lock-two-pods.test.ts; "no pod ⇒ today" is test/pod-lock-no-pod.test.ts.

const OWN: PodIdentity = { name: "ag-own", uid: "own-uid-0000", node: "node-own", namespace: "ns" };
const OTHER: PodIdentity = {
  name: "ag-other",
  uid: "other-uid-0000",
  node: "node-other",
  namespace: "ns",
};
const THIRD: PodIdentity = {
  name: "ag-third",
  uid: "third-uid-0000",
  node: "node-3",
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
const savedStateHome = process.env.ACPX_STATE_HOME;

/** Puts this process in `place`, as pod OWN; the API answers `proof` about the pods asked. */
function asPod(
  place: LockHostPlace,
  proof: DeathProofDetail | ((uid: string) => DeathProofDetail),
  extra: Parameters<typeof setPodLockDepsForTests>[0] = {},
) {
  proofCalls = 0;
  setPodLockDepsForTests({
    ownPod: () => OWN,
    lockPod: () => OWN,
    podModeRequested: () => false,
    place: () => place,
    proveDeath: async (pod) => {
      proofCalls += 1;
      return typeof proof === "function" ? proof(pod.uid) : proof;
    },
    ...extra,
  });
}
const GONE: DeathProofDetail = { answer: "gone", proof: "pod-gone" };
const TERMINAL: DeathProofDetail = { answer: "gone", proof: "pod-terminal" };
const EXISTS: DeathProofDetail = { answer: "exists" };
const UNKNOWN: DeathProofDetail = { answer: "unknown" };

function ledgerLines(uid = OWN.uid): Record<string, unknown>[] {
  const file = lockBreakLedgerPath(uid);
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
}

let stderr: string[];
const realWrite = process.stderr.write.bind(process.stderr);
test.beforeEach(() => {
  process.env.ACPX_STATE_HOME = tmpDir();
  stderr = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});
test.afterEach(() => {
  process.stderr.write = realWrite;
  setPodLockDepsForTests(undefined);
  if (savedStateHome === undefined) {
    delete process.env.ACPX_STATE_HOME;
  } else {
    process.env.ACPX_STATE_HOME = savedStateHome;
  }
});

async function expectNotBroken(lock: string, raw: string, budgetMs = 1_500): Promise<void> {
  await assert.rejects(acquireIdentityFileLock(lock, policy(budgetMs)), { code: "test-timeout" });
  assert.equal(fs.readFileSync(lock, "utf8"), raw, "the lock is byte-identical");
  assert.equal(stderr.join("").includes("broke"), false, "no break line on stderr");
  assert.deepEqual(ledgerLines(), [], "no break in the ledger");
}

// ---- another pod: never by pid, never by age, only the control pod, only on proof ----

for (const proof of [EXISTS, UNKNOWN]) {
  test(`NG-K7.2a: control pod, a holder in ANOTHER pod, 10 min old, pid dead here, proof=${proof.answer} → NOT broken`, async () => {
    asPod("control", proof);
    const lock = path.join(tmpDir(), "x.json.lock");
    const raw = bodyIn(OTHER);
    plant(lock, raw);
    await expectNotBroken(lock, raw);
    assert.ok(proofCalls >= 1 && proofCalls <= 3, `death proof asked at most ~1/s (${proofCalls})`);
  });
}

test("NEVER: an agent-pod waiter never breaks an other-pod holder EVEN WHOSE POD IS GONE — and never asks the API", async () => {
  asPod("agent-pod", GONE);
  const lock = path.join(tmpDir(), "x.json.lock");
  const raw = bodyIn(OTHER);
  plant(lock, raw);
  await expectNotBroken(lock, raw);
  assert.equal(proofCalls, 0, "an agent pod never asks the API server about a lock holder");
});

test("NEVER: a process outside both (a workbench, a suite) never breaks an other-pod holder and never asks", async () => {
  asPod("elsewhere", GONE);
  const lock = path.join(tmpDir(), "x.json.lock");
  const raw = bodyIn(OTHER);
  plant(lock, raw);
  await expectNotBroken(lock, raw);
  assert.equal(proofCalls, 0);
});

test("NG-K7.2a: the real record lock (20 s) on the control pod waits out a live foreign holder and throws record-lock-timeout", async () => {
  asPod("control", EXISTS);
  const record = path.join(tmpDir(), "rec.json");
  const raw = bodyIn(OTHER);
  plant(`${record}.lock`, raw);
  await assert.rejects(
    withRecordFileLock(record, async () => "wrote"),
    {
      code: "record-lock-timeout",
    },
  );
  assert.equal(fs.readFileSync(`${record}.lock`, "utf8"), raw);
});

test("NG-K7.2a: the queue lease guard is not broken by its 10 s age rule for a foreign holder", async () => {
  asPod("control", UNKNOWN);
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
});

test("NG-K7.2f: the fork-source stage lock is on the primitive — a foreign holder 10 min old is not taken over", async () => {
  asPod("control", EXISTS);
  const staged = path.join(tmpDir(), "dest", "src.jsonl");
  const raw = bodyIn(OTHER);
  plant(stageLockPath(staged), raw);
  await assert.rejects(
    withStageLock(staged, async () => "ran", { staleMs: 100, maxWaitMs: 300, pollMs: 20 }),
    /Timed out waiting for another copy/,
  );
  assert.equal(fs.readFileSync(stageLockPath(staged), "utf8"), raw);
});

test("NG-K7.2f positive: a stage lock left by a dead process of THIS pod is broken at once and reported as taken over", async () => {
  asPod("agent-pod", UNKNOWN);
  const staged = path.join(tmpDir(), "dest", "src.jsonl");
  plant(stageLockPath(staged), bodyIn(OWN), 0);
  const tookOver = await withStageLock(staged, async (lock) => lock.tookOverStale, {
    maxWaitMs: 2_000,
  });
  assert.equal(tookOver, true);
  assert.equal(fs.existsSync(stageLockPath(staged)), false, "released");
});

for (const proof of [GONE, TERMINAL]) {
  test(`NG-K7.2b: the CONTROL POD breaks a foreign holder proven gone (${proof.answer === "gone" ? proof.proof : ""}) — one break line, exact shape`, async () => {
    asPod("control", proof);
    const lock = path.join(tmpDir(), "x.json.lock");
    const raw = bodyIn(OTHER);
    plant(lock, raw);
    const content = await acquireIdentityFileLock(lock, policy());
    assert.equal(fs.readFileSync(lock, "utf8"), content, "we hold it now");
    const lines = ledgerLines();
    assert.equal(lines.length, 1);
    const judged = JSON.parse(raw) as { pid: number; token: string };
    assert.deepEqual(lines[0], {
      v: 1,
      ts: lines[0].ts,
      lock,
      holder: { pod: OTHER, pid: judged.pid, token: judged.token },
      breaker: { pod: OWN, pid: process.pid },
      proof: proof.answer === "gone" ? proof.proof : "",
    });
    assert.match(String(lines[0].ts), /^\d{4}-\d\d-\d\dT/);
    assert.match(
      stderr.join(""),
      /broke test lock .*holder pod ag-other .*is gone — proven by the API server/,
    );
    await releaseIdentityFileLock(lock, content);
  });
}

// ---- the same pod: pid and start time, by any process of that pod, no age ----

for (const place of ["agent-pod", "control"] as const) {
  test(`same pod (${place}): a holder whose pid is dead here is broken on local proof, the API never asked, one line (proof pid)`, async () => {
    asPod(place, EXISTS);
    const lock = path.join(tmpDir(), "x.json.lock");
    plant(lock, bodyIn(OWN), 0);
    const content = await acquireIdentityFileLock(lock, policy());
    assert.equal(fs.readFileSync(lock, "utf8"), content);
    assert.equal(proofCalls, 0);
    assert.deepEqual(
      ledgerLines().map((line) => line.proof),
      ["pid"],
    );
  });
}

test("same pod (negative): a LIVE holder of this pod is never broken at any age", async () => {
  asPod("control", GONE);
  const lock = path.join(tmpDir(), "x.json.lock");
  const raw = JSON.stringify(identityLockBody({ pid: process.pid }));
  plant(lock, raw);
  await expectNotBroken(lock, raw, 400);
});

test("same pod (negative): an unjudgeable holder of this pod (no pid) is never broken by AGE — age is only for bodies without `pod`", async () => {
  asPod("control", GONE);
  const lock = path.join(tmpDir(), "x.json.lock");
  const raw = JSON.stringify({ host: "x", pod: OWN, token: "t-unjudgeable" });
  plant(lock, raw);
  await expectNotBroken(lock, raw, 400);
});

test("a malformed `pod` field is still a pod field: foreign, never provable, never broken — even on the control pod with proof gone", async () => {
  asPod("control", GONE);
  const lock = path.join(tmpDir(), "x.json.lock");
  const raw = JSON.stringify({ pid: deadPid(), pod: { name: "ag-x" }, token: "t" });
  plant(lock, raw);
  await expectNotBroken(lock, raw, 400);
});

// ---- a body without `pod` ----

test("NEVER: in an AGENT POD a body without `pod` is never judged and never broken — dead pid, 10 min old", async () => {
  asPod("agent-pod", GONE);
  const lock = path.join(tmpDir(), "x.json.lock");
  const raw = JSON.stringify({ pid: deadPid(), host: "x" });
  plant(lock, raw);
  await expectNotBroken(lock, raw, 400);
  assert.equal(proofCalls, 0);
});

test("on the control pod a body without `pod` follows today's rules: dead pid broken, one line (proof pid, holder pod null)", async () => {
  asPod("control", UNKNOWN);
  const lock = path.join(tmpDir(), "x.json.lock");
  plant(lock, JSON.stringify({ pid: deadPid(), host: "x" }), 0);
  await releaseIdentityFileLock(lock, await acquireIdentityFileLock(lock, policy()));
  assert.deepEqual(
    ledgerLines().map((line) => [line.proof, (line.holder as { pod: unknown }).pod]),
    [["pid", null]],
  );
});

test("on the control pod an unjudgeable body without `pod` past the age bound is broken with today's WARNING (proof age)", async () => {
  asPod("control", UNKNOWN);
  const lock = path.join(tmpDir(), "x.json.lock");
  plant(lock, "{}");
  await releaseIdentityFileLock(lock, await acquireIdentityFileLock(lock, policy()));
  assert.match(
    stderr.join(""),
    /\[acpx\] WARNING: broke stale test lock .*holder cannot be judged from here/,
  );
  assert.deepEqual(
    ledgerLines().map((line) => line.proof),
    ["age"],
  );
});

// ---- the body ----

test("A-3: a body names the pod (name, uid, node, namespace) and a random token per acquisition", () => {
  asPod("control", UNKNOWN);
  const a = identityLockBody({ pid: 1 });
  const b = identityLockBody({ pid: 1 });
  assert.deepEqual(a.pod, OWN);
  assert.equal(typeof a.token, "string");
  assert.notEqual(a.token, b.token, "two acquisitions never write the same bytes");
});

test("A-5 NEVER: in pod mode without an identity the module throws pod_identity_missing and writes no lock", async () => {
  setPodLockDepsForTests({
    ownPod: () => undefined,
    lockPod: () => undefined,
    podModeRequested: () => true,
  });
  const lock = path.join(tmpDir(), "x.json.lock");
  await assert.rejects(acquireIdentityFileLock(lock, policy()), { code: "pod_identity_missing" });
  assert.equal(fs.existsSync(lock), false);
});

// ---- breaking: the re-read token, the mutex ----

test("NEVER: a break whose re-read token differs leaves the lock alone", async () => {
  const lock = path.join(tmpDir(), "x.json.lock");
  const judged = bodyIn(OTHER);
  const successor = bodyIn(THIRD); // a live holder that took the path between proof and re-read
  plant(lock, judged);
  let swapped = false;
  asPod("control", (uid) => (uid === OTHER.uid ? GONE : EXISTS), {
    insideBreakMutex: async () => {
      if (!swapped) {
        swapped = true;
        fs.writeFileSync(lock, successor);
      }
    },
  });
  await expectNotBroken(lock, successor, 1_500);
  assert.equal(swapped, true, "the break reached its re-read");
});

test("two breakers in one pod serialize on the break mutex: never two inside, exactly one break", async () => {
  const lock = path.join(tmpDir(), "x.json.lock");
  plant(lock, bodyIn(OWN), 0);
  let inside = 0;
  let maxInside = 0;
  asPod("agent-pod", EXISTS, {
    insideBreakMutex: async () => {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inside -= 1;
    },
  });
  let holding = 0;
  let overlap = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      const content = await acquireIdentityFileLock(lock, policy(10_000));
      holding += 1;
      overlap += holding > 1 ? 1 : 0;
      await new Promise((resolve) => setTimeout(resolve, 2));
      holding -= 1;
      await releaseIdentityFileLock(lock, content);
    }),
  );
  assert.equal(maxInside, 1, "the mutex let one breaker in at a time");
  assert.equal(overlap, 0);
  assert.equal(ledgerLines().length, 1, "exactly one break");
});

test("the break mutex is released by the KERNEL when its holder dies (SIGKILL)", async () => {
  asPod("control", UNKNOWN);
  const holder = spawn(
    process.execPath,
    [
      "-e",
      'require("net").createServer().listen({ path: "\\0acpx-lock-break." + process.argv[1] }, () => console.log("bound"))',
      OWN.uid,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
  assert.equal(await withBreakMutex(200, async () => "ran"), undefined, "busy while it lives");
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  assert.equal(await withBreakMutex(2_000, async () => "ran"), "ran", "free once it died");
});

test("NFS: a re-read that fails with ESTALE (another client unlinked the lock) is a retry, never a crash", async () => {
  // Measured across the control pod and a workbench (verification/cross-machine): errno 116.
  // ⚠️ KEEP THE MOCK'S SHAPE REAL: libuv has no name for 116, so `code` is NOT "ESTALE" — a mock with
  // code "ESTALE" stayed green while 12 of 160 real racers still crashed.
  asPod("agent-pod", EXISTS);
  const lock = path.join(tmpDir(), "x.json.lock");
  plant(lock, bodyIn(OWN), 0);
  const realReadFile = fsp.readFile.bind(fsp);
  let stale = 0;
  const readFile = mock.method(fsp, "readFile", async (file: string, options: unknown) => {
    if (file === lock && stale === 0) {
      stale += 1;
      throw Object.assign(
        new Error(`Unknown system error -116: Unknown system error -116, open '${file}'`),
        { code: "Unknown system error -116", errno: -116, syscall: "open" },
      );
    }
    return await realReadFile(file, options as BufferEncoding);
  });
  try {
    const content = await acquireIdentityFileLock(lock, policy(5_000));
    assert.equal(stale, 1, "the ESTALE path was taken");
    assert.equal(fs.readFileSync(lock, "utf8"), content, "and the acquire still succeeded");
    await releaseIdentityFileLock(lock, content);
  } finally {
    readFile.mock.restore();
  }
});

// ---- the sweep ----

function sweepFixture() {
  const dir = tmpDir();
  const files = {
    dir,
    ownDead: path.join(dir, "a.json.lock"),
    ownDeadGuard: path.join(dir, "k.lock.guard"),
    ownLive: path.join(dir, "b.json.lock"),
    foreignGone: path.join(dir, "c.json.lock"),
    foreignLive: path.join(dir, "d.json.lock"),
    noPodDead: path.join(dir, "e.json.lock"),
    lease: path.join(dir, "k.lock"), // the queue LEASE — not a lock of the primitive
  };
  plant(files.ownDead, bodyIn(OWN));
  plant(files.ownDeadGuard, bodyIn(OWN));
  plant(files.ownLive, JSON.stringify(identityLockBody({ pid: process.pid })));
  plant(files.foreignGone, bodyIn(OTHER));
  plant(files.foreignLive, bodyIn(THIRD));
  plant(files.noPodDead, JSON.stringify({ pid: deadPid(), host: "x" }));
  plant(files.lease, bodyIn(OWN));
  return files;
}

const goneIsOther = (uid: string) => (uid === OTHER.uid ? GONE : EXISTS);

test("NG-K7.2e: an AGENT POD's sweep removes only its own pod's dead processes — never a foreign one (even gone), a no-pod leftover, or a lease", async () => {
  asPod("agent-pod", goneIsOther);
  const f = sweepFixture();
  const result = await sweepOwnPodLocks({ dirs: [f.dir, path.join(f.dir, "missing")] });
  assert.deepEqual(result.removed.toSorted(), [f.ownDead, f.ownDeadGuard].toSorted());
  for (const kept of [f.ownLive, f.foreignGone, f.foreignLive, f.noPodDead, f.lease]) {
    assert.equal(fs.existsSync(kept), true, `${kept} kept`);
  }
  assert.equal(proofCalls, 0);
});

test("NG-K7.2e: the CONTROL POD's sweep also removes holders whose pod is gone and no-pod leftovers — every break in the ledger", async () => {
  asPod("control", goneIsOther);
  const f = sweepFixture();
  const result = await sweepOwnPodLocks({ dirs: [f.dir] });
  assert.deepEqual(
    result.removed.toSorted(),
    [f.ownDead, f.ownDeadGuard, f.foreignGone, f.noPodDead].toSorted(),
  );
  for (const kept of [f.ownLive, f.foreignLive, f.lease]) {
    assert.equal(fs.existsSync(kept), true, `${kept} kept`);
  }
  assert.deepEqual(
    ledgerLines()
      .map((line) => `${path.basename(String(line.lock))}:${String(line.proof)}`)
      .toSorted(),
    ["a.json.lock:pid", "c.json.lock:pod-gone", "e.json.lock:pid", "k.lock.guard:pid"],
  );
});

test("NG-K7.2e negative: a process with no own pod identity removes no lock that carries `pod`", async () => {
  setPodLockDepsForTests({
    ownPod: () => undefined,
    lockPod: () => undefined,
    place: () => "agent-pod",
  });
  const dir = tmpDir();
  const lock = path.join(dir, "a.json.lock");
  plant(lock, bodyIn(OWN));
  assert.deepEqual((await sweepOwnPodLocks({ dirs: [dir] })).removed, []);
  assert.equal(fs.existsSync(lock), true);
});

// ---- F2 (test-engineer, 175aa1cc): one break mutex per pod; no identity, no break of a `pod` body ----

test("F2 NEVER: a process without its own identity never breaks a lock that carries `pod` — even on the control pod with proof gone", async () => {
  asPod("control", GONE, { ownPod: () => undefined, lockPod: () => undefined });
  const lock = path.join(tmpDir(), "x.json.lock");
  const raw = bodyIn(OTHER);
  plant(lock, raw);
  await expectNotBroken(lock, raw, 600);
  assert.equal(proofCalls, 0, "it does not even ask");
});

test("F2: the PRODUCTION break-mutex name is one fixed string, whatever the environment; only node --test appends the uid", () => {
  assert.equal(breakMutexNameFor({}, OWN), BREAK_MUTEX_NAME);
  assert.equal(breakMutexNameFor({}, undefined), BREAK_MUTEX_NAME);
  assert.equal(breakMutexNameFor({ NV_POD_UID: "x", HOSTNAME: "h" }, OTHER), BREAK_MUTEX_NAME);
  assert.equal(
    breakMutexNameFor({ NODE_TEST_CONTEXT: "child" }, OWN),
    `${BREAK_MUTEX_NAME}.${OWN.uid}`,
  );
  assert.notEqual(
    breakMutexNameFor({ NODE_TEST_CONTEXT: "child" }, OWN),
    breakMutexNameFor({ NODE_TEST_CONTEXT: "child" }, OTHER),
    "two test pods in one network namespace stay apart",
  );
});

test("F2 NEVER: a breaker stalled AFTER its re-read — no identity-less process, and no second breaker of its pod, can take the lock meanwhile; one holder, one line", async () => {
  const dir = tmpDir();
  const lock = path.join(dir, "x.json.lock");
  const judged = bodyIn(OTHER);
  plant(lock, judged);
  let reachedUnlink!: () => void;
  const atUnlink = new Promise<void>((resolve) => (reachedUnlink = resolve));
  let resume!: () => void;
  const stall = new Promise<void>((resolve) => (resume = resolve));
  let stalls = 0;
  asPod("control", (uid) => (uid === OTHER.uid ? GONE : EXISTS), {
    beforeUnlink: async () => {
      stalls += 1;
      if (stalls === 1) {
        reachedUnlink();
        await stall; // c1 holds the mutex, past its re-read, before its unlink
      }
    },
  });
  let holding = 0;
  let overlap = 0;
  const holdBriefly = async (content: string) => {
    holding += 1;
    overlap += holding > 1 ? 1 : 0;
    await new Promise((resolve) => setTimeout(resolve, 20));
    holding -= 1;
    await releaseIdentityFileLock(lock, content);
  };
  const c1 = acquireIdentityFileLock(lock, policy(15_000)).then(holdBriefly);
  await atUnlink;

  // (a) a control-pod process WITHOUT NV_POD_* (a scrubbed env, an ssh shell) — another process.
  const saDir = makeServiceAccountDir(dir);
  const run = await runInPod(undefined, CHILD, ["acquire", lock, "1500"], {
    saDir,
    testHome: makeTestHome(dir, "control"),
    stateHome: dir,
    timeoutMs: 20_000,
  });
  assert.equal(JSON.parse(run.stdout).timeout, true, run.stdout + run.stderr);
  assert.equal(fs.readFileSync(lock, "utf8"), judged, "still the judged lock while c1 stalls");
  // (b) a second breaker of the SAME pod, in this process: it waits on the one mutex.
  const c2 = acquireIdentityFileLock(lock, policy(15_000)).then(holdBriefly);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fs.readFileSync(lock, "utf8"), judged, "c2 could not interleave");

  resume();
  await Promise.all([c1, c2]);
  assert.equal(overlap, 0, "never two holders");
  assert.equal(ledgerLines().length, 1, "exactly one break, recorded");
  assert.equal((ledgerLines()[0].holder as { token: string }).token, JSON.parse(judged).token);
  assert.equal(
    fs.existsSync(path.join(dir, ".acpx", "lock-breaks")),
    false,
    "the child broke nothing",
  );
});

test("F2: on the control pod WITHOUT an identity the sweep keeps every `pod` body and removes no-pod leftovers by today's rules", async () => {
  asPod("control", goneIsOther, { ownPod: () => undefined, lockPod: () => undefined });
  const f = sweepFixture();
  const result = await sweepOwnPodLocks({ dirs: [f.dir] });
  assert.deepEqual(result.removed, [f.noPodDead]);
  for (const kept of [
    f.ownDead,
    f.ownDeadGuard,
    f.ownLive,
    f.foreignGone,
    f.foreignLive,
    f.lease,
  ]) {
    assert.equal(fs.existsSync(kept), true, `${kept} kept`);
  }
  assert.equal(proofCalls, 0);
});

test("an EMPTY NODE_TEST_CONTEXT honours no seam: neither the place seam nor the mutex-name suffix", () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, ".nv-agent"), "ag-x\n"); // the seam would make this an agent pod
  const base = { ACPX_POD_TEST_HOME: home, NV_DEV_SERVER_ROLE: "workbench" };
  assert.equal(
    lockHostPlace({ ...base, NODE_TEST_CONTEXT: "child" }),
    "agent-pod",
    "positive control",
  );
  assert.notEqual(lockHostPlace({ ...base, NODE_TEST_CONTEXT: "" }), "agent-pod");
  assert.equal(breakMutexNameFor({ NODE_TEST_CONTEXT: "" }, OWN), BREAK_MUTEX_NAME);
});
