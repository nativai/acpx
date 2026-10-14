import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { acquireIdentityFileLock, releaseIdentityFileLock } from "./identity-file-lock.js";

/**
 * Cross-process lock for the session-index read-modify-write window.
 *
 * Protocol (mirrored by acpx-ui's index-write helper — keep in sync):
 * - lock file: `<sessionDir>/index.json.lock`, created atomically WITH its body (temp + link),
 *   body `{"pid":<number>,"ts":"<ISO-8601>","host":"…","processIdentity":{…}}` — `pid`/`ts` keep
 *   their pre-0a meaning, so a pre-0a reader still judges a 0a holder by pid and 5 s age.
 * - takeover: the shared identity rules (identity-file-lock.ts) — a holder in the reader's own
 *   pid namespace that is provably gone is taken over at once; a provably LIVE one never; a
 *   holder that cannot be judged from here (another pid namespace, a legacy body whose pid is
 *   alive) only once the lock is older than INDEX_LOCK_STALE_MS, with a warning.
 * - contention: wait up to INDEX_LOCK_BUDGET_MS, then THROW `IndexLockTimeoutError`.
 *
 * 🛑 THERE IS NO PROCEED-UNLOCKED FALLBACK ANY MORE (brick ae547131 §6.2). The old ~2 s "write
 * anyway" was availability over strictness, and it is exactly the lost update the lock exists to
 * prevent — including the seat store's compare-and-swap, which used to ride this lock. Each caller
 * decides what a timeout means: a write that only PROJECTS an already-durable record write logs and
 * defers it (the record stays authoritative; the deferred write re-projects from the record when it
 * lands, and is dropped loudly at exit if it never does — index-update-queue.ts; acpx's reconcile
 * repairs membership only, never an entry's fields, and a lost `closed:true` is repaired by
 * acpx-ui's closed-drift reconcile); a write that IS the operation fails.
 *
 * Within a process, acquisitions on the same lock path are serialized by a promise queue, and
 * nested acquisition (re-entrancy) is detected via AsyncLocalStorage and runs the callback directly
 * under the held lock.
 */

const INDEX_LOCK_STALE_MS = 15_000;
const INDEX_LOCK_BUDGET_MS = 20_000;

const heldLockPaths = new AsyncLocalStorage<Set<string>>();
const inProcessQueues = new Map<string, Promise<void>>();

export class IndexLockTimeoutError extends Error {
  readonly code = "index-lock-timeout";
  constructor(lockPath: string, holder: string) {
    super(
      `index lock ${lockPath} is held by ${holder} for over ${INDEX_LOCK_BUDGET_MS} ms; ` +
        `refusing to write unlocked`,
    );
  }
}

export function isIndexLockTimeoutError(error: unknown): error is IndexLockTimeoutError {
  return error instanceof IndexLockTimeoutError;
}

export function sessionIndexLockPath(sessionDir: string): string {
  return path.join(sessionDir, "index.json.lock");
}

/** True when this async context holds ANY `index.json.lock` — the seat lock's order check. */
export function isSessionIndexLockHeld(): boolean {
  const held = heldLockPaths.getStore();
  return held !== undefined && [...held].some((lockPath) => lockPath.endsWith("index.json.lock"));
}

export async function withSessionIndexLock<T>(
  sessionDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await withAdvisoryLock(sessionIndexLockPath(sessionDir), fn);
}

/**
 * The protocol above, at an arbitrary lock path.
 *
 * Extracted so the cold-archive tier's `ARCHIVE-INDEX/.lock` can REUSE this
 * implementation rather than re-derive it (conception `archive-formats.md` §4.4.1
 * is explicit: "Reuse, do not re-derive"). Every property documented at the top of
 * this file is the same code for both callers, which is the only way "the exact
 * protocol of index.json.lock" stays true as this file changes.
 */
export async function withAdvisoryLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
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
    const content = await acquireIdentityFileLock(lockPath, {
      label: "index lock",
      budgetMs: INDEX_LOCK_BUDGET_MS,
      staleMs: INDEX_LOCK_STALE_MS,
      legacyBody: () => ({ pid: process.pid, ts: new Date().toISOString() }),
      makeTimeoutError: (lock, holder) => new IndexLockTimeoutError(lock, holder),
    });
    try {
      const nextHeld = new Set(held ?? []);
      nextHeld.add(lockPath);
      return await heldLockPaths.run(nextHeld, fn);
    } finally {
      await releaseIdentityFileLock(lockPath, content);
    }
  } finally {
    releaseQueue();
  }
}
