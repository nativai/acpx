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

/**
 * NEGATIVE CASE — the other pod. A lock naming a DIFFERENT host (or boot) with a pid that looks
 * dead here is NOT broken: that pid lives in another pid namespace, so ESRCH proves nothing. The
 * writer waits its budget and refuses. Same for a lock with no host at all (unknown provenance).
 */
for (const [label, identity] of [
  ["a foreign host", { host: "dev-server-workbench-other-pod", boot: LOCAL.boot }],
  ["a foreign boot", { host: LOCAL.host, boot: "00000000-0000-0000-0000-000000000000" }],
  ["no host identity", {}],
] as const) {
  test(`record lock: a dead-looking pid from ${label} is NEVER broken — the writer refuses`, async () => {
    const file = await tempRecordFile();
    const lock = JSON.stringify({ pid: await deadPid(), start: null, ...identity });
    await fs.writeFile(`${file}.lock`, lock);
    let ran = false;
    await assert.rejects(
      withRecordFileLock(file, async () => {
        ran = true;
      }),
      (error: Error & { code?: string }) => error.code === "record-lock-timeout",
    );
    assert.equal(ran, false, "the action ran without the lock");
    assert.equal(await fs.readFile(`${file}.lock`, "utf8"), lock, "a foreign lock was broken");
  });
}
