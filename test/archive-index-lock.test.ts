import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withArchiveIndexLock } from "../src/session/archive/archive-index.js";
import { archiveIndexDir } from "../src/session/archive/paths.js";

// brick ae547131 §6.2 (TE finding F3) — the cold archive's `ARCHIVE-INDEX/.lock` never proceeds
// unlocked. It shares `withAdvisoryLock` with `index.json.lock` (T15), but a published guarantee
// needs its own negative case, mirroring T15. ⊗: d9ab5c0d runs the writer UNLOCKED after ~2 s.
//
// ⚠️ Deliberately imports ONLY what d9ab5c0d also exports, builds the lock body from /proc by hand
// and matches the timeout by its `code`, so this exact file compiles and runs against the baseline.

const linux = process.platform === "linux";

function startTicks(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

/** A 0a lock body naming `pid` in THIS reader's boot + pid ns + time ns. */
function localHolderBody(pid: number): string {
  return `${JSON.stringify({
    pid,
    ts: new Date().toISOString(),
    host: os.hostname(),
    processIdentity: {
      kind: "linux-proc-stat-starttime",
      startTimeTicks: startTicks(pid),
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      pidNamespace: readlinkSync("/proc/self/ns/pid"),
      timeNamespace: readlinkSync("/proc/self/ns/time"),
    },
  })}\n`;
}

async function archiveFixture(): Promise<{ archiveDir: string; lockPath: string; shard: string }> {
  const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-archive-index-lock-"));
  const indexDir = archiveIndexDir(archiveDir);
  await fs.mkdir(indexDir, { recursive: true });
  const shard = path.join(indexDir, "2026-10.json");
  await fs.writeFile(shard, "ORIGINAL-SHARD", "utf8");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(shard, old, old);
  return { archiveDir, lockPath: path.join(indexDir, ".lock"), shard };
}

test("F3 archive-index lock: a LIVE local holder past the budget ⇒ the writer fails index-lock-timeout; shard bytes and mtime unchanged", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  const { archiveDir, lockPath, shard } = await archiveFixture();
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
  try {
    assert.ok(holder.pid);
    const body = localHolderBody(holder.pid);
    await fs.writeFile(lockPath, body, "utf8");
    const shardBefore = await fs.stat(shard);
    const started = Date.now();
    let ran = false;
    await assert.rejects(
      withArchiveIndexLock(archiveDir, async () => {
        ran = true;
        await fs.writeFile(shard, "WRITTEN-UNLOCKED", "utf8");
      }),
      (error: unknown) => (error as { code?: string }).code === "index-lock-timeout",
    );
    const waited = Date.now() - started;
    assert.equal(ran, false, `the archive-index writer ran UNLOCKED after ${waited} ms`);
    assert.ok(waited >= 19_500 && waited < 25_000, `waited ${waited} ms`);
    assert.equal(await fs.readFile(shard, "utf8"), "ORIGINAL-SHARD", "shard bytes changed");
    assert.equal((await fs.stat(shard)).mtimeMs, shardBefore.mtimeMs, "shard mtime changed");
    assert.equal(await fs.readFile(lockPath, "utf8"), body, "the live holder's lock was broken");
  } finally {
    holder.kill("SIGKILL");
    await fs.rm(archiveDir, { recursive: true, force: true });
  }
});

test("F3 positive control: a DEAD local holder of ARCHIVE-INDEX/.lock is taken over at once and the write lands", async (t) => {
  if (!linux) {
    t.skip("linux identity");
    return;
  }
  const { archiveDir, lockPath, shard } = await archiveFixture();
  try {
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
    const deadPid = Number(child.stdout.toString());
    assert.ok(deadPid > 0);
    // a 0a body for a pid that is gone — start ticks of THIS process stand in (any value proves the
    // shape; the pid itself is ESRCH in our own scope, which is the proof of death)
    const body = localHolderBody(process.pid).replace(`"pid":${process.pid}`, `"pid":${deadPid}`);
    await fs.writeFile(lockPath, body, "utf8");
    const started = Date.now();
    await withArchiveIndexLock(archiveDir, async () => {
      await fs.writeFile(shard, "WRITTEN-UNDER-LOCK", "utf8");
    });
    assert.ok(Date.now() - started < 1_000, "a dead local holder was not taken over at once");
    assert.equal(await fs.readFile(shard, "utf8"), "WRITTEN-UNDER-LOCK");
    await assert.rejects(fs.access(lockPath), "the lock was not released");
  } finally {
    await fs.rm(archiveDir, { recursive: true, force: true });
  }
});
