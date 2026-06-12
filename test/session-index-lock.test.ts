import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  sessionIndexLockPath,
  withSessionIndexLock,
} from "../src/session/persistence/index-lock.js";

// perf-loadfix W2.2 — advisory index.json.lock: O_CREAT|O_EXCL with {pid, ts}
// body, 5 s stale takeover, ~2 s bounded wait then proceed-unlocked.

async function withSessionDir<T>(run: (sessionDir: string) => Promise<T>): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-index-lock-"));
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

test("lock file is created with {pid, ts} during the callback and removed after", async () => {
  await withSessionDir(async (sessionDir) => {
    const lockPath = sessionIndexLockPath(sessionDir);
    await withSessionIndexLock(sessionDir, async () => {
      const body = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
        pid: number;
        ts: string;
      };
      assert.equal(body.pid, process.pid);
      assert.ok(Number.isFinite(Date.parse(body.ts)));
    });
    assert.equal(await fileExists(lockPath), false);
  });
});

test("nested acquisition is re-entrant (no deadlock, single lock file)", async () => {
  await withSessionDir(async (sessionDir) => {
    const result = await withSessionIndexLock(sessionDir, async () => {
      return await withSessionIndexLock(sessionDir, async () => "inner-ran");
    });
    assert.equal(result, "inner-ran");
    assert.equal(await fileExists(sessionIndexLockPath(sessionDir)), false);
  });
});

test("concurrent in-process acquisitions are serialized", async () => {
  await withSessionDir(async (sessionDir) => {
    const order: string[] = [];
    await Promise.all([
      withSessionIndexLock(sessionDir, async () => {
        order.push("a-start");
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push("a-end");
      }),
      withSessionIndexLock(sessionDir, async () => {
        order.push("b-start");
        order.push("b-end");
      }),
    ]);
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  });
});

test("a foreign lock with a dead pid is taken over immediately", async () => {
  await withSessionDir(async (sessionDir) => {
    const lockPath = sessionIndexLockPath(sessionDir);
    // Spawn-and-reap a child to get a pid that is certainly dead.
    const { spawn } = await import("node:child_process");
    const child = spawn("true");
    const deadPid = child.pid!;
    await new Promise((resolve) => child.once("exit", resolve));

    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ pid: deadPid, ts: new Date().toISOString() })}\n`,
      "utf8",
    );

    const startedAt = Date.now();
    let ran = false;
    await withSessionIndexLock(sessionDir, async () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.ok(Date.now() - startedAt < 1000, "dead-pid takeover must not wait out the backoff");
    assert.equal(await fileExists(lockPath), false);
  });
});

test("a live foreign lock older than 5 s is taken over", async () => {
  await withSessionDir(async (sessionDir) => {
    const lockPath = sessionIndexLockPath(sessionDir);
    const staleTs = new Date(Date.now() - 10_000).toISOString();
    // pid 1 is alive (init) — staleness must come from the ts age.
    await fs.writeFile(lockPath, `${JSON.stringify({ pid: 1, ts: staleTs })}\n`, "utf8");

    let ran = false;
    await withSessionIndexLock(sessionDir, async () => {
      ran = true;
    });
    assert.equal(ran, true);
    assert.equal(await fileExists(lockPath), false);
  });
});

test("a live fresh foreign lock makes the caller proceed unlocked after ~2 s", async () => {
  await withSessionDir(async (sessionDir) => {
    const lockPath = sessionIndexLockPath(sessionDir);
    const foreignBody = `${JSON.stringify({ pid: 1, ts: new Date().toISOString() })}\n`;
    await fs.writeFile(lockPath, foreignBody, "utf8");
    // Keep the foreign lock fresh so the stale takeover never fires.
    const refresher = setInterval(() => {
      void fs.writeFile(lockPath, `${JSON.stringify({ pid: 1, ts: new Date().toISOString() })}\n`);
    }, 500);

    try {
      const startedAt = Date.now();
      let ran = false;
      await withSessionIndexLock(sessionDir, async () => {
        ran = true;
      });
      const waited = Date.now() - startedAt;
      assert.equal(ran, true, "must proceed without the lock instead of wedging");
      assert.ok(waited >= 1900, `must back off ~2 s before proceeding (waited ${waited} ms)`);
      assert.ok(waited < 4000, `must not wait much past the 2 s bound (waited ${waited} ms)`);
      // The foreign lock was not ours to remove.
      assert.equal(await fileExists(lockPath), true);
    } finally {
      clearInterval(refresher);
    }
  });
});
