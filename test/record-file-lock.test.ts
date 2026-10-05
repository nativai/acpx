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

/** A live process on THIS host and boot, and the lock content it would write — never breakable. */
async function liveHolder(): Promise<{ lock: string; stop: () => void }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  return {
    lock: JSON.stringify({ pid: child.pid, start, ...LOCAL }),
    stop: () => child.kill("SIGKILL"),
  };
}

/** Puts `content` at the lock path the way a contender does: write a temp, then an atomic link. */
async function linkLock(lockPath: string, content: string): Promise<void> {
  const temporary = `${lockPath}.contender.tmp`;
  await fs.writeFile(temporary, content);
  await fs.link(temporary, lockPath);
  await fs.rm(temporary);
}

type Mutable = { rm: typeof fs.rm; rename: typeof fs.rename };

/**
 * te-A ATTACK E, deterministically (brick eb4c8d06). Several waiters judge one DEAD holder at
 * once. Waiter A has judged the stale lock X and re-read it; at the very moment A acts on the lock
 * path, another breaker removes X and a contender C links its FRESH lock Y. This row performs that
 * swap at A's first destructive call on the lock path (`rm` or `rename` — whichever the code uses),
 * which is the exact interleaving the stochastic harness hits ~3 times per 1,500 critical sections.
 *
 * RED on a3139b7f: A's read-then-`rm` deletes Y, A acquires at once and runs while C still holds —
 * two live holders. GREEN with the exclusive break: A takes the file by `rename`, sees it is not
 * the X it judged, links Y straight back and waits for C like any live holder.
 */
test("record lock: attack E — a breaker never deletes a fresh lock that replaced the stale one it judged", async () => {
  const file = await tempRecordFile();
  const lockPath = `${file}.lock`;
  await fs.writeFile(lockPath, JSON.stringify({ pid: await deadPid(), start: null, ...LOCAL }));
  const contender = await liveHolder();
  const mutable = fs as unknown as Mutable;
  const original = { rm: mutable.rm, rename: mutable.rename };
  let swapped = false;
  const swapFirst = async (target: unknown) => {
    if (!swapped && target === lockPath) {
      swapped = true;
      await original.rm(lockPath);
      await linkLock(lockPath, contender.lock);
    }
  };
  mutable.rm = (async (target: string, ...rest: unknown[]) => {
    await swapFirst(target);
    return await (original.rm as (...a: unknown[]) => Promise<void>)(target, ...rest);
  }) as typeof fs.rm;
  mutable.rename = (async (from: string, to: string) => {
    await swapFirst(from);
    return await original.rename(from, to);
  }) as typeof fs.rename;
  let ran = false;
  let writing: Promise<void> | undefined;
  try {
    writing = withRecordFileLock(file, async () => {
      ran = true;
    });
    await sleep(1_000);
  } finally {
    mutable.rm = original.rm;
    mutable.rename = original.rename;
  }
  try {
    assert.equal(swapped, true, "the break never touched the lock path — this row tested nothing");
    assert.equal(ran, false, "TWO LIVE HOLDERS: the breaker deleted the contender's fresh lock");
    assert.equal(
      await fs.readFile(lockPath, "utf8"),
      contender.lock,
      "the contender's fresh lock was removed",
    );
    // The contender releases: the waiting writer must now acquire and land.
    await fs.rm(lockPath);
    await writing;
    assert.equal(ran, true);
  } finally {
    contender.stop();
  }
});

/**
 * The same hazard on RELEASE: if our lock was broken while we held it and a contender has linked
 * its own, our release must not delete theirs. RED on a3139b7f (release was a plain `rm`).
 */
test("record lock: release never deletes a lock that is no longer ours", async () => {
  const file = await tempRecordFile();
  const lockPath = `${file}.lock`;
  const contender = await liveHolder();
  try {
    await withRecordFileLock(file, async () => {
      // Our lock is broken and a contender links its own while we are still inside.
      await fs.rm(lockPath);
      await linkLock(lockPath, contender.lock);
    });
    assert.equal(
      await fs.readFile(lockPath, "utf8"),
      contender.lock,
      "our release deleted the contender's lock",
    );
  } finally {
    contender.stop();
  }
});
