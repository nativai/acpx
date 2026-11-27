import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withAdmissionLock } from "../src/capacity/ledger.js";
import type { LockHostPlace, PodIdentity } from "../src/pod/identity.js";
import {
  getOwnProcessIdentity,
  getOwnProcessScope,
  type LinuxProcessScope,
} from "../src/process-identity.js";
import {
  acquireIdentityFileLock,
  releaseIdentityFileLock,
  setPodLockDepsForTests,
  sweepOwnPodLocks,
  type IdentityLockPolicy,
} from "../src/session/persistence/identity-file-lock.js";

// A-94 / row 94.6 (brick 14901ced), a C3.2 A-4 correction. An IN-PLACE container restart keeps the
// pod UID and gives the acpx container a NEW pid namespace (and a new time namespace). A body that
// names THIS pod and records a scope other than the reader's therefore belongs to a previous
// incarnation of the pod's one acpx container — its pid reads `unknown` here, which used to mean
// "never broken": one stale `admission.lock` refused every create as `admission_busy`.
// The published guarantee's NEGATIVE: the SAME scope + a LIVE pid is never broken, by anybody.

const OWN: PodIdentity = { name: "ag-own", uid: "own-uid-0000", node: "node-own", namespace: "ns" };
const PLACES: LockHostPlace[] = ["control", "agent-pod"];

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "0"]);
  assert.ok(child.pid, "spawned a short-lived process");
  return child.pid;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "acpx-samepod-"));
}

function plant(lockPath: string, body: Record<string, unknown>, ageMs = 10 * 60_000): string {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const raw = JSON.stringify(body);
  fs.writeFileSync(lockPath, raw);
  const old = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, old, old);
  return raw;
}

function policy(budgetMs = 700): IdentityLockPolicy {
  return {
    label: "test lock",
    budgetMs,
    staleMs: 100, // far below the planted age: an age rule WOULD break, if it applied
    legacyBody: () => ({ pid: process.pid }),
    makeTimeoutError: (file, holder) =>
      Object.assign(new Error(`test-timeout ${file}: ${holder}`), { code: "test-timeout" }),
  };
}

function ownScope() {
  const scope = getOwnProcessScope();
  assert.ok(scope, "this host can read its own scope (/proc self-check)");
  return scope;
}

type Variant = "birth" | "scope-only";

/** A same-pod body whose holder recorded `scope` (the fork's on-disk spelling). */
function podBody(variant: Variant, scope: LinuxProcessScope, pid: number): Record<string, unknown> {
  const identity = getOwnProcessIdentity();
  assert.equal(identity?.kind, "linux-proc");
  return {
    pid,
    host: "ag-own",
    pod: OWN,
    token: `t-${Math.random()}`,
    processIdentity:
      variant === "birth"
        ? {
            kind: "linux-proc-stat-starttime",
            startTimeTicks: (identity as { startTicks: string }).startTicks,
            ...scope,
          }
        : { ...scope },
  };
}

const PREVIOUS_INCARNATIONS: Array<[string, () => LinuxProcessScope]> = [
  ["another pid namespace", () => ({ ...ownScope(), pidNamespace: "pid:[4026539999]" })],
  ["another boot", () => ({ ...ownScope(), bootId: "00000000-0000-4000-8000-000000000000" })],
  [
    "another pid AND time namespace (what a container restart gives)",
    () => ({ ...ownScope(), pidNamespace: "pid:[4026539999]", timeNamespace: "time:[4026539998]" }),
  ],
];

const savedStateHome = process.env.ACPX_STATE_HOME;
const savedTestHome = process.env.ACPX_POD_TEST_HOME;
let stderr: string[];
const realWrite = process.stderr.write.bind(process.stderr);

test.beforeEach(() => {
  process.env.ACPX_POD_TEST_HOME = tmpDir();
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
  for (const [key, saved] of [
    ["ACPX_POD_TEST_HOME", savedTestHome],
    ["ACPX_STATE_HOME", savedStateHome],
  ] as const) {
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
});

function asPod(place: LockHostPlace): void {
  setPodLockDepsForTests({
    ownPod: () => OWN,
    lockPod: () => OWN,
    podModeRequested: () => false,
    place: () => place,
    proveDeath: async () => {
      throw new Error("a same-pod judgement never asks the API server");
    },
  });
}

async function expectNotBrokenByAcquirer(lock: string, raw: string): Promise<void> {
  await assert.rejects(acquireIdentityFileLock(lock, policy()), { code: "test-timeout" });
  assert.equal(fs.readFileSync(lock, "utf8"), raw, "the lock is byte-identical");
  assert.equal(stderr.join("").includes("broke"), false, "no break line on stderr");
}

async function expectNotSwept(dir: string, lock: string, raw: string): Promise<void> {
  const result = await sweepOwnPodLocks({ dirs: [dir] });
  assert.deepEqual(result.removed, [], "the sweep removed nothing");
  assert.equal(fs.readFileSync(lock, "utf8"), raw, "the lock is byte-identical");
}

// ---- (a) a previous incarnation of this pod's acpx container: BROKEN, by the acquirer and the sweep ----

for (const place of PLACES) {
  for (const variant of ["birth", "scope-only"] as const) {
    for (const [label, scope] of PREVIOUS_INCARNATIONS) {
      test(`94.6a: ${place}, same-pod ${variant} body from ${label}, holder pid unreadable here → the ACQUIRER breaks it`, async () => {
        asPod(place);
        const lock = path.join(tmpDir(), "x.json.lock");
        // pid 1 exists here: in THIS namespace it is somebody else — which is exactly the trap.
        plant(lock, podBody(variant, scope(), 1), 0);
        const content = await acquireIdentityFileLock(lock, policy());
        assert.notEqual(content, "", "the waiter took the lock over");
        await releaseIdentityFileLock(lock, content);
      });

      test(`94.6a: ${place}, same-pod ${variant} body from ${label} → the SWEEP removes it`, async () => {
        asPod(place);
        const dir = tmpDir();
        const lock = path.join(dir, "x.json.lock");
        plant(lock, podBody(variant, scope(), 1), 0);
        const result = await sweepOwnPodLocks({ dirs: [dir] });
        assert.deepEqual(result.removed, [lock]);
        assert.equal(fs.existsSync(lock), false);
      });
    }
  }
}

// ---- (b) THE NEGATIVE of the published guarantee: same scope + a LIVE pid is never broken ----

for (const place of PLACES) {
  for (const variant of ["birth", "scope-only"] as const) {
    test(`94.6b: ${place}, same-pod ${variant} body, SAME scope, LIVE pid, 10 min old → NOT broken by the acquirer`, async () => {
      asPod(place);
      const lock = path.join(tmpDir(), "x.json.lock");
      const raw = plant(lock, podBody(variant, ownScope(), process.pid));
      await expectNotBrokenByAcquirer(lock, raw);
    });

    test(`94.6b: ${place}, same-pod ${variant} body, SAME scope, LIVE pid, 10 min old → NOT swept`, async () => {
      asPod(place);
      const dir = tmpDir();
      const lock = path.join(dir, "x.json.lock");
      const raw = plant(lock, podBody(variant, ownScope(), process.pid));
      await expectNotSwept(dir, lock, raw);
    });
  }

  test(`94.6b: ${place}, a LEGACY same-pod body (no scope at all), live pid, 10 min old → NOT broken, NOT swept`, async () => {
    asPod(place);
    const dir = tmpDir();
    const lock = path.join(dir, "x.json.lock");
    const raw = plant(lock, { pid: process.pid, host: "ag-own", pod: OWN, token: "t-legacy" });
    await expectNotBrokenByAcquirer(lock, raw);
    await expectNotSwept(dir, lock, raw);
  });

  test(`94.6b: ${place}, a LEGACY same-pod body whose pid is unknowable (pid 1, no scope), 10 min old → NOT broken, NOT swept`, async () => {
    asPod(place);
    const dir = tmpDir();
    const lock = path.join(dir, "x.json.lock");
    const raw = plant(lock, { pid: 1, host: "ag-own", pod: OWN, token: "t-legacy-1" });
    await expectNotBrokenByAcquirer(lock, raw);
    await expectNotSwept(dir, lock, raw);
  });
}

// ---- (c) today's rule, kept: same scope + a DEAD pid is broken ----

for (const place of PLACES) {
  for (const variant of ["birth", "scope-only"] as const) {
    test(`94.6c: ${place}, same-pod ${variant} body, SAME scope, DEAD pid → broken by the acquirer`, async () => {
      asPod(place);
      const lock = path.join(tmpDir(), "x.json.lock");
      plant(lock, podBody(variant, ownScope(), deadPid()), 0);
      const content = await acquireIdentityFileLock(lock, policy());
      await releaseIdentityFileLock(lock, content);
    });

    test(`94.6c: ${place}, same-pod ${variant} body, SAME scope, DEAD pid → swept`, async () => {
      asPod(place);
      const dir = tmpDir();
      const lock = path.join(dir, "x.json.lock");
      plant(lock, podBody(variant, ownScope(), deadPid()), 0);
      assert.deepEqual((await sweepOwnPodLocks({ dirs: [dir] })).removed, [lock]);
    });
  }
}

// ---- (d) `admission.lock`: the same primitive and rule, and the sweep must list it ----

for (const place of PLACES) {
  test(`94.6d: ${place}, a stale previous-incarnation admission.lock is swept`, async () => {
    asPod(place);
    const dir = tmpDir();
    const lock = path.join(dir, "admission.lock");
    plant(lock, podBody("birth", PREVIOUS_INCARNATIONS[0][1](), 1), 0);
    assert.deepEqual((await sweepOwnPodLocks({ dirs: [dir] })).removed, [lock]);
  });

  test(`94.6d: ${place}, admission.lock of a DEAD same-scope holder is swept (today's rule, now reaching this file)`, async () => {
    asPod(place);
    const dir = tmpDir();
    const lock = path.join(dir, "admission.lock");
    plant(lock, podBody("birth", ownScope(), deadPid()), 0);
    assert.deepEqual((await sweepOwnPodLocks({ dirs: [dir] })).removed, [lock]);
  });

  test(`94.6d: ${place}, admission.lock of a LIVE same-scope holder is NOT swept`, async () => {
    asPod(place);
    const dir = tmpDir();
    const lock = path.join(dir, "admission.lock");
    const raw = plant(lock, podBody("birth", ownScope(), process.pid));
    await expectNotSwept(dir, lock, raw);
  });
}

test("94.6d: the admission gate itself (withAdmissionLock) takes over a previous-incarnation lock instead of timing out", async () => {
  asPod("control");
  const dir = tmpDir();
  plant(path.join(dir, "admission.lock"), podBody("birth", PREVIOUS_INCARNATIONS[0][1](), 1));
  assert.equal(await withAdmissionLock(dir, async () => "admitted"), "admitted");
});
