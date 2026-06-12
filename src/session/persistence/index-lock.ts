import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Advisory cross-process lock for the session-index read-modify-write window.
 *
 * Protocol (mirrored by acpx-ui's index-write helper — keep in sync):
 * - lock file: `<sessionDir>/index.json.lock`, created with O_CREAT|O_EXCL
 *   (`flag: "wx"`), body `{"pid":<number>,"ts":"<ISO-8601>"}`
 * - stale takeover: holder pid dead, or lock older than 5 s (body `ts`,
 *   falling back to file mtime when the body is unreadable)
 * - contention: retry with backoff for up to ~2 s, then PROCEED WITHOUT the
 *   lock — availability over strictness. A missed lock degrades to the
 *   pre-lock behaviour (racing read-modify-write), whose damage incremental
 *   reconcile has already made cheap. Locking must never wedge a daemon.
 *
 * Within a process, acquisitions on the same lock path are serialized by a
 * promise queue, and nested acquisition (re-entrancy) is detected via
 * AsyncLocalStorage and runs the callback directly under the held lock.
 */

const INDEX_LOCK_STALE_MS = 5_000;
const INDEX_LOCK_MAX_WAIT_MS = 2_000;
const INDEX_LOCK_RETRY_DELAY_MS = 100;

const heldLockPaths = new AsyncLocalStorage<Set<string>>();
const inProcessQueues = new Map<string, Promise<void>>();

export function sessionIndexLockPath(sessionDir: string): string {
  return path.join(sessionDir, "index.json.lock");
}

function delay(ms: number): Promise<void> {
  // Deliberately NOT unref'd: this timer is awaited inline by a foreground
  // write. With unref, a process whose only pending work is the lock backoff
  // sees its event loop empty and node exits mid-write (observed as
  // "unsettled top-level await" in the D1 self-test).
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLockBody(payload: string): { pid: number; tsMs: number | undefined } | undefined {
  try {
    const parsed = JSON.parse(payload) as { pid?: unknown; ts?: unknown };
    if (typeof parsed.pid !== "number") {
      return undefined;
    }
    const tsMs = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : Number.NaN;
    return { pid: parsed.pid, tsMs: Number.isFinite(tsMs) ? tsMs : undefined };
  } catch {
    return undefined;
  }
}

/** Returns true when the caller should immediately retry acquisition. */
async function takeOverStaleLock(lockPath: string): Promise<boolean> {
  try {
    const payload = await fs.readFile(lockPath, "utf8");
    const stat = await fs.stat(lockPath);
    const holder = parseLockBody(payload);
    const age = Date.now() - (holder?.tsMs ?? stat.mtimeMs);
    const holderDead = holder !== undefined && !isPidAlive(holder.pid);
    if (!holderDead && age < INDEX_LOCK_STALE_MS) {
      return false;
    }
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    // ENOENT only: the holder released between our EEXIST and this read —
    // safe to retry the create immediately. Any OTHER error (EISDIR when a
    // directory squats the lock path, EACCES on an unreadable lock, a failed
    // unlink, ...) must NOT short-circuit back to the create: the
    // retry-immediately `continue` skips the caller's deadline check and
    // backoff sleep, so a persistent error becomes a busy spin and the write
    // never completes. Report no-takeover instead — the caller backs off and
    // proceeds unlocked after ~2 s.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function acquireLockFile(lockPath: string): Promise<boolean> {
  const deadline = Date.now() + INDEX_LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ pid: process.pid, ts: new Date().toISOString() })}\n`,
        { flag: "wx" },
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // Unexpected failure (permissions, missing dir) — proceed unlocked.
        return false;
      }
    }
    if (await takeOverStaleLock(lockPath)) {
      continue;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await delay(INDEX_LOCK_RETRY_DELAY_MS);
  }
}

async function releaseLockFile(lockPath: string): Promise<void> {
  try {
    const holder = parseLockBody(await fs.readFile(lockPath, "utf8"));
    if (!holder || holder.pid === process.pid) {
      await fs.unlink(lockPath);
    }
  } catch {
    // best effort — a stale-takeover by another process may have replaced it
  }
}

export async function withSessionIndexLock<T>(
  sessionDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = sessionIndexLockPath(sessionDir);
  const held = heldLockPaths.getStore();
  if (held?.has(lockPath)) {
    return await fn();
  }

  const previous = inProcessQueues.get(lockPath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  inProcessQueues.set(
    lockPath,
    previous.then(() => gate),
  );
  await previous;

  try {
    const acquired = await acquireLockFile(lockPath);
    try {
      const nextHeld = new Set(held ?? []);
      nextHeld.add(lockPath);
      return await heldLockPaths.run(nextHeld, fn);
    } finally {
      if (acquired) {
        await releaseLockFile(lockPath);
      }
    }
  } finally {
    releaseQueue();
  }
}
