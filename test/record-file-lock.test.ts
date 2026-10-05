import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withRecordFileLock } from "../src/session/persistence/record-file-lock.js";

async function tempRecordFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-record-lock-"));
  return path.join(dir, "rec.json");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The identity a lock written on THIS host and boot carries. */
const LOCAL = {
  host: os.hostname(),
  boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
};

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid!;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

test("record lock: two writers of one record never overlap, and the lock is gone afterwards", async () => {
  const file = await tempRecordFile();
  let active = 0;
  let maxActive = 0;
  const writer = async () =>
    await withRecordFileLock(file, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(20);
      active--;
    });
  await Promise.all([writer(), writer(), writer(), writer()]);
  assert.equal(maxActive, 1, "two holders were inside the critical section at once");
  await assert.rejects(fs.stat(`${file}.lock`), /ENOENT/, "the lock file outlived its holder");
});

test("record lock: released when the action throws", async () => {
  const file = await tempRecordFile();
  await assert.rejects(
    withRecordFileLock(file, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  await assert.rejects(fs.stat(`${file}.lock`), /ENOENT/);
});

test("record lock: a lock left by a DEAD process is broken", async () => {
  const file = await tempRecordFile();
  await fs.writeFile(
    `${file}.lock`,
    JSON.stringify({ pid: await deadPid(), start: null, ...LOCAL }),
  );
  const started = Date.now();
  let ran = false;
  await withRecordFileLock(file, async () => {
    ran = true;
  });
  assert.ok(ran);
  assert.ok(Date.now() - started < 2000, "a dead holder's lock was not broken promptly");
});

test("record lock: a LIVE pid whose start time differs (pid reuse) is treated as dead", async () => {
  const file = await tempRecordFile();
  // This process is alive, but the recorded start time is not ours: a different process once
  // held this pid. Linux-only evidence (/proc); elsewhere the start time is unknown and the
  // holder is (correctly) never assumed dead.
  if (process.platform !== "linux") {
    return;
  }
  await fs.writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, start: "0", ...LOCAL }));
  let ran = false;
  await withRecordFileLock(file, async () => {
    ran = true;
  });
  assert.ok(ran);
});

/**
 * NEGATIVE CASE — the one that matters: a lock held by a LIVE process is never broken and never
 * bypassed. The writer waits its full budget and then REFUSES (`record-lock-timeout`); it does not
 * proceed unlocked, which is the silent lost-update this lock exists to prevent.
 */
test("record lock: a LIVE holder is never broken or bypassed — the writer refuses after its budget", async () => {
  const file = await tempRecordFile();
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  try {
    const start = await fs
      .readFile(`/proc/${holder.pid}/stat`, "utf8")
      .then((stat) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null)
      .catch(() => null);
    await fs.writeFile(`${file}.lock`, JSON.stringify({ pid: holder.pid, start, ...LOCAL }));
    let ran = false;
    await assert.rejects(
      withRecordFileLock(file, async () => {
        ran = true;
      }),
      (error: Error & { code?: string }) => error.code === "record-lock-timeout",
    );
    assert.equal(ran, false, "the action ran without the lock");
    const lock = JSON.parse(await fs.readFile(`${file}.lock`, "utf8")) as { pid: number };
    assert.equal(lock.pid, holder.pid, "the live holder's lock was broken");
  } finally {
    holder.kill("SIGKILL");
  }
});

async function writeLock(file: string, content: object, ageMs: number): Promise<string> {
  const lock = JSON.stringify(content);
  await fs.writeFile(`${file}.lock`, lock);
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(`${file}.lock`, when, when);
  return lock;
}

/**
 * THE OTHER POD. A lock from a different host (or boot, or with no identity) cannot be judged by
 * its pid — that pid lives in another pid namespace, so ESRCH proves nothing. It is broken only by
 * AGE (> 15 s; a legitimate hold lasts milliseconds), which is also what clears the orphan a pod
 * restart leaves behind.
 */
for (const [label, identity] of [
  ["a foreign host", { host: "dev-server-workbench-other-pod", boot: LOCAL.boot }],
  ["no host identity", {}],
] as const) {
  test(`record lock: a 16 s old lock from ${label} IS broken and the write lands`, async () => {
    const file = await tempRecordFile();
    await writeLock(file, { pid: await deadPid(), start: null, ...identity }, 16_000);
    let ran = false;
    await withRecordFileLock(file, async () => {
      ran = true;
    });
    assert.ok(ran, "the write did not land");
  });
}

for (const [label, identity] of [
  ["a foreign host", { host: "dev-server-workbench-other-pod", boot: LOCAL.boot }],
  ["a foreign boot", { host: LOCAL.host, boot: "00000000-0000-0000-0000-000000000000" }],
  ["no host identity", {}],
] as const) {
  test(`record lock: a 1 s old lock from ${label} with a dead-looking pid is NOT broken — the writer waits`, async () => {
    const file = await tempRecordFile();
    const lock = await writeLock(file, { pid: await deadPid(), start: null, ...identity }, 1_000);
    let ran = false;
    const writing = withRecordFileLock(file, async () => {
      ran = true;
    });
    await sleep(2_000);
    assert.equal(ran, false, "the writer did not wait for a young foreign lock");
    assert.equal(
      await fs.readFile(`${file}.lock`, "utf8"),
      lock,
      "a young foreign lock was broken",
    );
    // The holder releases: the waiting writer must now acquire and land.
    await fs.rm(`${file}.lock`);
    await writing;
    assert.equal(ran, true);
  });
}

type Mutable = { rm: typeof fs.rm; rename: typeof fs.rename };
type Gate = { open: () => void; opened: Promise<void> };

function gate(): Gate {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/**
 * Holds the FIRST destructive call on the lock path (`rm` or `rename`, whichever the code uses) until
 * `release` is opened, and reports when that call has completed. This is te-A's attack-F
 * choreography — a breaker Y that judged the dead lock D, delayed between judgement and removal —
 * done in-process, by gate rather than by sleep.
 */
function delayFirstRemoval(lockPath: string): {
  reached: Gate;
  release: Gate;
  done: Gate;
  restore: () => void;
} {
  const mutable = fs as unknown as Mutable;
  const original = { rm: mutable.rm, rename: mutable.rename };
  const reached = gate();
  const release = gate();
  const done = gate();
  let first = true;
  const hold = async <R>(target: unknown, call: () => Promise<R>): Promise<R> => {
    if (!first || target !== lockPath) {
      return await call();
    }
    first = false;
    reached.open();
    await release.opened;
    try {
      return await call();
    } finally {
      done.open();
    }
  };
  mutable.rm = (async (target: string, ...rest: unknown[]) =>
    await hold(target, async () =>
      (original.rm as (...a: unknown[]) => Promise<void>)(target, ...rest),
    )) as typeof fs.rm;
  mutable.rename = (async (from: string, to: string) =>
    await hold(from, async () => original.rename(from, to))) as typeof fs.rename;
  return {
    reached,
    release,
    done,
    restore: () => {
      mutable.rm = original.rm;
      mutable.rename = original.rename;
    },
  };
}

/**
 * te-A F1 (brick eb4c8d06). D is a dead local lock. Breaker Y judges it and is delayed before its
 * removal; meanwhile X breaks D itself and takes a fresh lock. Y's removal then takes X's LIVE lock
 * by mistake, and a contender (Y, re-judging) acquires the empty path while X is still inside.
 *
 * Required: X's commit never happens on the lock it lost — its fence refuses, X re-runs after Y,
 * and the two commits are strictly ordered. RED on main 532ec129: X commits while Y holds the lock.
 */
test("record lock: F1 — a holder whose lock was taken by a mistaken breaker never commits on it", async () => {
  const file = await tempRecordFile();
  const lockPath = `${file}.lock`;
  await fs.writeFile(lockPath, JSON.stringify({ pid: await deadPid(), start: null, ...LOCAL }));
  const injected = delayFirstRemoval(lockPath);
  const events: string[] = [];
  const xInside = gate();
  const xMayCommit = gate();
  let xAttempts = 0;
  try {
    const y = withRecordFileLock(file, async (fence) => {
      events.push("Y inside");
      fence?.();
      events.push("Y commit");
    });
    await injected.reached.opened; // Y judged D dead and is about to remove it.
    const x = withRecordFileLock(file, async (fence) => {
      xAttempts++;
      events.push(`X inside #${xAttempts}`);
      xInside.open();
      await xMayCommit.opened;
      fence?.();
      events.push(`X commit #${xAttempts}`);
    });
    await xInside.opened; // X broke D and holds a fresh lock.
    injected.release.open(); // Y's removal now takes X's live lock.
    await injected.done.opened;
    // Y re-judges, finds the path empty, acquires and commits while X is still inside.
    await y;
    xMayCommit.open();
    await x;
  } finally {
    injected.restore();
  }
  assert.deepEqual(
    events.filter((event) => event.includes("commit")),
    ["Y commit", `X commit #${xAttempts}`],
    `commits not ordered: ${events.join(", ")}`,
  );
  assert.equal(xAttempts, 2, `X committed on the lock it had lost: ${events.join(", ")}`);
  await assert.rejects(fs.stat(lockPath), /ENOENT/, "a lock was left behind");
});

/**
 * te-A F2. As F1, but the mistaken removal lands AFTER X has committed and BEFORE X releases. With a
 * hand-back, X's lock was re-created after X released — a phantom naming a live pid that nothing may
 * break, wedging the record for X's lifetime (RED on 6ad6bfb4). Required: no lock is left, and the
 * next writer acquires within one backoff step.
 */
test("record lock: F2 — a holder releasing inside a mistaken removal leaves no phantom lock", async () => {
  const file = await tempRecordFile();
  const lockPath = `${file}.lock`;
  await fs.writeFile(lockPath, JSON.stringify({ pid: await deadPid(), start: null, ...LOCAL }));
  const injected = delayFirstRemoval(lockPath);
  let xCommits = 0;
  try {
    const y = withRecordFileLock(file, async () => {});
    await injected.reached.opened;
    await withRecordFileLock(file, async (fence) => {
      fence?.();
      xCommits++;
      // X has committed. Y's mistaken removal of X's lock lands now, before X's release.
      injected.release.open();
      await injected.done.opened;
    });
    await y;
  } finally {
    injected.restore();
  }
  assert.equal(xCommits, 1);
  await assert.rejects(
    fs.stat(lockPath),
    /ENOENT/,
    "PHANTOM: a lock outlived its holder's release",
  );
  const started = Date.now();
  await withRecordFileLock(file, async () => {});
  assert.ok(Date.now() - started < 200, "the next writer did not acquire within one backoff step");
});

/** The fence itself: a holder whose lock was replaced is refused at its fence and re-runs once. */
test("record lock: fence refuses a holder whose lock was replaced, and the attempt re-runs", async () => {
  const file = await tempRecordFile();
  const lockPath = `${file}.lock`;
  let attempts = 0;
  await withRecordFileLock(file, async (fence) => {
    attempts++;
    if (attempts === 1) {
      // Someone took our lock and another writer now holds it — then released it.
      await fs.rm(lockPath);
    }
    fence();
  });
  assert.equal(attempts, 2);
  await assert.rejects(fs.stat(lockPath), /ENOENT/);
});
