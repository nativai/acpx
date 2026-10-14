import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  readProcessBirthIdentity,
  serializeProcessBirthIdentity,
} from "../src/process-identity.js";
import {
  IndexLockTimeoutError,
  sessionIndexLockPath,
  withSessionIndexLock,
} from "../src/session/persistence/index-lock.js";
import {
  ChildLines,
  childEnv,
  holdLiveIndexLock,
  readIndexEntry,
  readRecordOnDisk,
  seedOpenSessions,
  sessionsDirOf,
} from "./index-lock-holder-helpers.js";

const MONOTONIC_CHILD_PATH = fileURLToPath(new URL("./index-monotonic-child.js", import.meta.url));

// perf-loadfix W2.2 — index.json.lock. brick ae547131 §6.2 (T15) made it STRICT: identity body,
// takeover only of a provably dead local holder (at once) or an unjudgeable one older than 15 s,
// and a typed IndexLockTimeoutError after 20 s instead of the old ~2 s proceed-unlocked fallback.
//
// REWRITTEN (listed in the PR, CONCEPT §13.3): "a live foreign lock older than 5 s is taken over"
// (now: a LIVE local holder is never taken over; an unjudgeable one only after 15 s), "a live fresh
// foreign lock makes the caller proceed unlocked after ~2 s" (now: IndexLockTimeoutError at ~20 s,
// index untouched), and the directory-squat / unreadable-lock rows (no busy spin is still asserted;
// the outcome is now a timeout or an age-bounded break, never an unlocked write).

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

test("lock file is created with {pid, ts, host, processIdentity} during the callback and removed after", async () => {
  await withSessionDir(async (sessionDir) => {
    const lockPath = sessionIndexLockPath(sessionDir);
    await withSessionIndexLock(sessionDir, async () => {
      const body = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
        pid: number;
        ts: string;
        host: string;
        processIdentity?: { kind: string; startTimeTicks: string; pidNamespace?: string };
      };
      assert.equal(body.pid, process.pid);
      assert.ok(Number.isFinite(Date.parse(body.ts)));
      assert.equal(body.host, os.hostname());
      if (process.platform === "linux") {
        // pre-0a readers keep parsing kind + startTimeTicks; 0a readers read the scope beside them
        assert.equal(body.processIdentity?.kind, "linux-proc-stat-starttime");
        assert.match(body.processIdentity?.startTimeTicks ?? "", /^\d+$/);
        assert.match(body.processIdentity?.pidNamespace ?? "", /^pid:\[\d+\]$/);
      }
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

function sleeper() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { stdio: "ignore" });
}

/** A 0a lock body for a live process, in this reader's scope unless `scope` overrides it. */
function identityBody(pid: number, scope: Record<string, string> = {}): string {
  const identity = readProcessBirthIdentity(pid);
  assert.ok(identity, `identity of ${pid}`);
  return `${JSON.stringify({
    pid,
    ts: new Date().toISOString(),
    host: os.hostname(),
    processIdentity: { ...serializeProcessBirthIdentity(identity), ...scope },
  })}\n`;
}

async function writeAged(lockPath: string, body: string, ageMs: number): Promise<void> {
  await fs.writeFile(lockPath, body, "utf8");
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(lockPath, when, when);
}

async function timeAcquire(
  sessionDir: string,
): Promise<{ ran: boolean; ms: number; error?: unknown }> {
  const startedAt = Date.now();
  let ran = false;
  try {
    await withSessionIndexLock(sessionDir, async () => {
      ran = true;
    });
    return { ran, ms: Date.now() - startedAt };
  } catch (error) {
    return { ran, ms: Date.now() - startedAt, error };
  }
}

/**
 * T15 (⊗ — d9ab5c0d writes after ~2 s). Every slow holder shape at once, each in its own dir, so
 * the 15–20 s bounds cost one wait rather than five.
 */
test("T15 index lock: never proceeds unlocked; takeover only on proof or after 15 s", async (t) => {
  if (process.platform !== "linux") {
    t.skip("linux identity");
    return;
  }
  const holder = sleeper();
  try {
    assert.ok(holder.pid);
    const dirs = await Promise.all(
      Array.from({ length: 5 }, () => fs.mkdtemp(path.join(os.tmpdir(), "acpx-index-lock-t15-"))),
    );
    const [liveDir, foreignDir, legacyDir, squatDir, unreadableDir] = dirs;
    const lock = (dir: string) => sessionIndexLockPath(dir);

    // (1) a LIVE holder in our own scope — must never be broken; the writer times out at ~20 s and
    //     the index is never written.
    const liveBody = identityBody(holder.pid);
    await fs.writeFile(lock(liveDir), liveBody, "utf8");
    await fs.writeFile(path.join(liveDir, "index.json"), "ORIGINAL", "utf8");
    // (2) a holder in ANOTHER pid namespace whose pid is dead here — unjudgeable: not before 15 s.
    const foreignDead = spawn("true");
    await new Promise((resolve) => foreignDead.once("exit", resolve));
    await writeAged(
      lock(foreignDir),
      `${JSON.stringify({ pid: foreignDead.pid, ts: new Date().toISOString(), host: "other-pod", processIdentity: { ...serializeProcessBirthIdentity(readProcessBirthIdentity(holder.pid)!), pidNamespace: "pid:[1]" } })}\n`,
      0,
    );
    // (3) a LEGACY {pid,ts} body whose pid is alive — unjudgeable: broken once 15 s old (10 s now).
    await writeAged(
      lock(legacyDir),
      `${JSON.stringify({ pid: holder.pid, ts: new Date().toISOString() })}\n`,
      10_000,
    );
    // (4) a directory squatting the lock path — no busy spin, no unlocked write: a timeout.
    await fs.mkdir(lock(squatDir));
    // (5) an unreadable lock file — an unidentified holder: broken once 15 s old.
    const unreadable = process.getuid?.() !== 0;
    if (unreadable) {
      await fs.writeFile(lock(unreadableDir), `${JSON.stringify({ pid: holder.pid })}\n`);
      await fs.chmod(lock(unreadableDir), 0o000);
    }

    const [live, foreign, legacy, squat, unreadableResult] = await Promise.all(
      dirs.map((dir) => timeAcquire(dir)),
    );

    assert.ok(live.error instanceof IndexLockTimeoutError, `live: ${String(live.error)}`);
    assert.equal(live.ran, false);
    assert.ok(live.ms >= 19_500 && live.ms < 25_000, `live waited ${live.ms} ms`);
    assert.equal(await fs.readFile(lock(liveDir), "utf8"), liveBody, "live holder's lock broken");
    assert.equal(await fs.readFile(path.join(liveDir, "index.json"), "utf8"), "ORIGINAL");

    assert.equal(foreign.ran, true, String(foreign.error));
    assert.ok(foreign.ms >= 14_500, `foreign holder broken early: ${foreign.ms} ms`);

    assert.equal(legacy.ran, true, String(legacy.error));
    assert.ok(legacy.ms >= 4_500 && legacy.ms < 9_000, `legacy-alive broken at ${legacy.ms} ms`);

    assert.ok(squat.error instanceof IndexLockTimeoutError, `squat: ${String(squat.error)}`);
    assert.equal((await fs.stat(lock(squatDir))).isDirectory(), true);

    if (unreadable) {
      assert.equal(unreadableResult.ran, true, String(unreadableResult.error));
      assert.ok(unreadableResult.ms >= 14_500, `unreadable broken early: ${unreadableResult.ms}`);
    }
    for (const dir of dirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  } finally {
    holder.kill("SIGKILL");
  }
});

test("T15 index lock: a dead holder in our own scope (0a body) is taken over at once", async (t) => {
  if (process.platform !== "linux") {
    t.skip("linux identity");
    return;
  }
  await withSessionDir(async (sessionDir) => {
    const child = sleeper();
    assert.ok(child.pid);
    const body = identityBody(child.pid);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    await fs.writeFile(sessionIndexLockPath(sessionDir), body, "utf8");
    const result = await timeAcquire(sessionDir);
    assert.equal(result.ran, true);
    assert.ok(result.ms < 1_000, `dead holder not taken over at once (${result.ms} ms)`);
  });
});

/**
 * T3 (brick 19ee17ab; ⊗ on production `main` 1d0f93fd / RCA d9ab5c0, whose waiters write
 * UNLOCKED after ~2 s — RCA R1: 2/20 closes reverted at W=12). Six cross-process writers and one
 * close queue behind a LIVE holder: nothing is written while it holds, and once it releases every
 * write lands and the close survives the six whole-index rewrites that follow it.
 */
test("T3 index lock: cross-process writers and a close wait out a live holder; the close survives", async (t) => {
  if (process.platform !== "linux") {
    t.skip("linux identity");
    return;
  }
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-index-lock-t3-"));
  try {
    const writers = Array.from({ length: 6 }, (_, i) => `t3-writer-${i}`);
    const victim = "t3-victim";
    await seedOpenSessions(homeDir, [...writers, victim]);
    const dir = sessionsDirOf(homeDir);
    const indexFile = path.join(dir, "index.json");
    const before = await fs.stat(indexFile);
    const beforeBytes = await fs.readFile(indexFile, "utf8");

    const lock = await holdLiveIndexLock(dir);
    let children: ChildLines[] = [];
    try {
      children = [...writers.map((id) => ["write", id]), ["close", victim]].map(
        (args) =>
          new ChildLines(
            spawn(process.execPath, [MONOTONIC_CHILD_PATH, ...args], {
              env: childEnv(homeDir),
              stdio: ["ignore", "pipe", "pipe"],
            }),
          ),
      );
      await Promise.all(children.map((child) => child.line("WRITING", 30_000)));
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      const held = await fs.stat(indexFile);
      assert.equal(
        held.ino,
        before.ino,
        "index.json was replaced while a live holder held the lock",
      );
      assert.equal(held.mtimeMs, before.mtimeMs, "index.json was written while the lock was held");
      assert.equal(await fs.readFile(indexFile, "utf8"), beforeBytes);
      assert.equal(await fs.readFile(sessionIndexLockPath(dir), "utf8"), lock.body);
    } finally {
      await lock.release();
    }
    const exits = await Promise.all(children.map((child) => child.exited));
    exits.forEach((exit, i) => assert.equal(exit.code, 0, children[i]?.stderr));

    for (const id of writers) {
      const record = await readRecordOnDisk(homeDir, id);
      assert.equal((await readIndexEntry(homeDir, id))?.lastUsedAt, record.last_used_at, id);
    }
    assert.equal((await readRecordOnDisk(homeDir, victim)).closed, true);
    assert.equal((await readIndexEntry(homeDir, victim))?.closed, true, "the close was reverted");
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
});
