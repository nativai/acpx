import { incrementPerfCounter } from "../../perf-metrics.js";
import { isIndexLockTimeoutError, withSessionIndexLock } from "./index-lock.js";
import {
  readIndexEntryFromDisk,
  reconcileSessionIndex,
  writeSessionIndex,
  type SessionIndexEntry,
} from "./index.js";

/**
 * Per-process index write policy (perf-loadfix W2.3):
 *
 * - **Membership-immediate**: a record file not yet present in index.files
 *   (new session / first touch by this process) writes the index right away —
 *   membership must propagate fast, or every other writer keeps reconciling
 *   the mismatch and UI freshness starves.
 * - **Scalars throttled per file**: repeat writes of the same file (the
 *   500 ms live-checkpoint stream) coalesce to at most one index write per
 *   5 s per file — leading edge immediate, latest entry wins, trailing flush.
 *   A crash before the flush loses that file's index projection. The session
 *   record — written before the index on every path — stays the source of
 *   truth; an OPEN session's entry is re-projected on its next write, but a
 *   CLOSED session never writes again, so its lost projection stays stale
 *   (acpx's reconcile repairs membership only, never entry fields). A lost
 *   `closed:true` is repaired by acpx-ui's closed-drift reconcile.
 * - **The index follows the record (brick 19ee17ab, M2).** `pending` is a
 *   DIRTY-SET: each flush re-projects every pending file from its record as it
 *   stands on disk, read INSIDE the index lock (`writeEntriesUnderLock`). The
 *   queued entry is only a fallback for a record that cannot be read. So a
 *   flush that waited (trailing timer, lock queue, deferral) can never write a
 *   pre-close snapshot over a later close: the record's monotonicity guard is
 *   the only one, and the index inherits it.
 * - Pending state flushes on owner exit (explicit call), on process
 *   `beforeExit`, and before any same-process index read
 *   (read-your-writes within the process).
 * - **Exit is bounded.** A lock timeout defers the write (never an unlocked
 *   write, never a throw). `beforeExit` makes ONE exit-time flush attempt per
 *   process; whatever is still pending after it is dropped with a WARNING that
 *   names the sessions, and a `process.exit()` with deferred entries pending
 *   prints the same WARNING synchronously. Worst case per CLI: 20 s inline +
 *   20 s at exit.
 */

const SCALAR_FLUSH_INTERVAL_MS = 5_000;

/** Counter name for one deferred index write batch (lock timeout). Read it via
 * `getPerfMetricsSnapshot()`, or across processes via `ACPX_PERF_METRICS_FILE`
 * — a CLI's capture is written once in `main`'s `finally`, so a deferral during
 * the EXIT-time attempt is not in it; the stderr WARNING covers both. */
export const SESSION_INDEX_UPDATE_DEFERRED_COUNTER = "session.index_update_deferred";

type DirState = {
  /** Dirty-set: file → its last queued entry (a fallback only, see module doc). */
  pending: Map<string, SessionIndexEntry>;
  /** Pending files whose write already hit a lock timeout at least once. */
  deferred: Set<string>;
  /** index.files as of this process's last flush — membership knowledge. */
  knownFiles: Set<string>;
  /** Last time this process wrote each file's entry into the index. */
  lastWrittenAt: Map<string, number>;
  timer: NodeJS.Timeout | undefined;
  flushing: Promise<void> | undefined;
};

const dirStates = new Map<string, DirState>();
let exitHooksInstalled = false;
let exitFlushAttempted = false;

function stateFor(sessionDir: string): DirState {
  let state = dirStates.get(sessionDir);
  if (!state) {
    state = {
      pending: new Map(),
      deferred: new Set(),
      knownFiles: new Set(),
      lastWrittenAt: new Map(),
      timer: undefined,
      flushing: undefined,
    };
    dirStates.set(sessionDir, state);
    installExitHooks();
  }
  return state;
}

function hasPendingEntries(): boolean {
  for (const state of dirStates.values()) {
    if (state.pending.size > 0) {
      return true;
    }
  }
  return false;
}

function installExitHooks(): void {
  if (exitHooksInstalled) {
    return;
  }
  exitHooksInstalled = true;
  // beforeExit fires again each time the async flush drains the loop. ONE
  // attempt per process, then drop loudly: the pre-19ee17ab handler retried in
  // 20 s rounds for as long as a live holder kept the lock, so a wedged holder
  // hung every index-writing CLI on the box (measured: 87 s behind a 90 s hold).
  process.on("beforeExit", () => {
    if (!hasPendingEntries()) {
      return;
    }
    if (exitFlushAttempted) {
      abandonPendingSessionIndexUpdates("at exit");
      return;
    }
    exitFlushAttempted = true;
    void flushPendingSessionIndexUpdates()
      .catch(() => {
        // best effort at exit — whatever is left is reported just below
      })
      .then(() => {
        abandonPendingSessionIndexUpdates("at exit");
      });
  });
  // A process.exit() skips beforeExit: report entries that were DEFERRED and
  // are still pending (synchronous — 'exit' runs no async work). Ordinary
  // throttled scalars dropped by an owner's exit stay quiet: they are the
  // documented ≤ 5 s class.
  process.on("exit", () => {
    reportDroppedSessionIndexUpdates("at exit", deferredPendingIds());
  });
}

function deferredPendingIds(): string[] {
  const ids: string[] = [];
  for (const state of dirStates.values()) {
    for (const [file, entry] of state.pending) {
      if (state.deferred.has(file)) {
        ids.push(entry.acpxRecordId);
      }
    }
  }
  return ids;
}

function reportDroppedSessionIndexUpdates(when: string, ids: readonly string[]): void {
  if (ids.length === 0) {
    return;
  }
  process.stderr.write(
    `[acpx] WARNING: session index update dropped ${when} for ${ids.length} session(s) after ` +
      `the index lock stayed unavailable: ${ids.join(", ")}. The session records are written ` +
      `and authoritative; these index rows stay stale until the session's next write (a lost ` +
      `close is repaired by acpx-ui's closed-drift reconcile).\n`,
  );
}

/**
 * Drop every pending index update of this process, with ONE WARNING naming the
 * sessions, and stop their retry timers. Used when no further attempt can be
 * made: after the single exit-time attempt, and by the self-close arm right
 * before it terminates its own owner (which ends this process too). The
 * records stay the authority; nothing here touches them.
 */
export function abandonPendingSessionIndexUpdates(when: string): void {
  const ids: string[] = [];
  for (const state of dirStates.values()) {
    for (const entry of state.pending.values()) {
      ids.push(entry.acpxRecordId);
    }
    state.pending.clear();
    state.deferred.clear();
    clearDirTimer(state);
  }
  reportDroppedSessionIndexUpdates(when, ids);
}

function clearDirTimer(state: DirState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = undefined;
  }
}

async function flushDir(sessionDir: string, state: DirState): Promise<void> {
  clearDirTimer(state);
  while (state.pending.size > 0 || state.flushing) {
    if (state.flushing) {
      await state.flushing;
      continue;
    }
    let written = true;
    state.flushing = writePendingEntries(sessionDir, state).then((ok) => {
      written = ok;
    });
    try {
      await state.flushing;
    } finally {
      state.flushing = undefined;
    }
    if (!written) {
      armRetryTimer(sessionDir, state);
      return;
    }
  }
}

function armRetryTimer(sessionDir: string, state: DirState): void {
  if (state.timer) {
    return;
  }
  const timer = setTimeout(() => {
    state.timer = undefined;
    void flushDir(sessionDir, state).catch(() => {
      // best effort — the next write retries; the record stays the truth
    });
  }, SCALAR_FLUSH_INTERVAL_MS);
  timer.unref?.();
  state.timer = timer;
}

/**
 * Writes the pending entries under the index lock. A lock TIMEOUT (brick ae547131 §6.2 — the lock
 * no longer proceeds unlocked) is not a failure of the record write this projects: the entries go
 * back into `pending` (a newer entry for the same file wins) for the next flush, and the caller
 * is told nothing was written. Returns false then, true otherwise.
 */
async function writePendingEntries(sessionDir: string, state: DirState): Promise<boolean> {
  const pending = new Map(state.pending);
  state.pending.clear();
  try {
    await writeEntriesUnderLock(sessionDir, state, pending);
    return true;
  } catch (error) {
    if (!isIndexLockTimeoutError(error)) {
      throw error;
    }
    for (const [file, entry] of pending) {
      if (!state.pending.has(file)) {
        state.pending.set(file, entry);
      }
      state.deferred.add(file);
    }
    incrementPerfCounter(SESSION_INDEX_UPDATE_DEFERRED_COUNTER);
    process.stderr.write(
      `[acpx] WARNING: session index update deferred (${pending.size} entr${pending.size === 1 ? "y" : "ies"}): ${error.message}\n`,
    );
    return false;
  }
}

/**
 * The entry to write for one pending file (edge rules, CONCEPTION §3.1): the
 * record's fresh projection; if the record cannot be read, the index's existing
 * entry (never the snapshot over it); only a file new to the index falls back
 * to the queued snapshot — there is no close in the index for it to regress.
 */
function entryToWrite(
  fresh: SessionIndexEntry | undefined,
  existing: SessionIndexEntry | undefined,
  snapshot: SessionIndexEntry,
): SessionIndexEntry {
  return fresh ?? existing ?? snapshot;
}

async function writeEntriesUnderLock(
  sessionDir: string,
  state: DirState,
  pending: Map<string, SessionIndexEntry>,
): Promise<void> {
  await withSessionIndexLock(sessionDir, async () => {
    // 🛑 THE MERGE RULE (brick 19ee17ab, M2): the entry written is the record's
    // projection READ HERE, INSIDE the index lock — never the queued snapshot,
    // and never a read hoisted above `withSessionIndexLock`. The snapshot was
    // projected before this process waited (5 s trailing timer, the lock queue,
    // a deferral), and writing it wholesale is how a pre-close `closed:false`
    // landed over a later `closed:true` (RCA 2338b781 Path A; 3/3 on dev).
    // Reading BEFORE the lock only shrinks that window: a close renaming the
    // record after the read and taking the lock first is still overwritten.
    // Read under the lock, any close renaming the record after this read has
    // to wait for our release, so its own index write lands last. Tests:
    // test/session-index-closed-monotonic.test.ts (T1b fails a hoisted read).
    const fresh = new Map<string, SessionIndexEntry>();
    for (const file of pending.keys()) {
      const entry = await readIndexEntryFromDisk(sessionDir, file);
      if (entry) {
        fresh.set(file, entry);
      }
    }
    // Reconcile picks up concurrent writers' membership changes; the fresh
    // projections are handed in so new files are not read twice.
    const { index } = await reconcileSessionIndex(sessionDir, fresh);
    const diskFiles = new Set(index.files);
    const existing = new Map(index.entries.map((entry) => [entry.file, entry]));
    const entries = index.entries.filter((entry) => !pending.has(entry.file));
    for (const [file, snapshot] of pending) {
      // A pending file pruned by another process between queue and flush
      // stays dropped — never resurrect an index row for a vanished file.
      if (diskFiles.has(file)) {
        entries.push(entryToWrite(fresh.get(file), existing.get(file), snapshot));
      }
    }
    await writeSessionIndex(sessionDir, { files: index.files, entries });
    state.knownFiles = new Set(index.files);
    const now = Date.now();
    for (const file of pending.keys()) {
      state.lastWrittenAt.set(file, now);
      state.deferred.delete(file);
    }
  });
}

/**
 * Update the session index for a just-written record file. Decides between
 * the membership-immediate and scalar-throttled write classes (see module
 * doc). `options.immediate` forces the immediate class — used by the
 * privileged lifecycle write path (close/favorite/name are human-frequency
 * and freshness-sensitive).
 */
export async function updateSessionIndexForRecordWrite(
  sessionDir: string,
  entry: SessionIndexEntry,
  options: { immediate?: boolean } = {},
): Promise<void> {
  const state = stateFor(sessionDir);
  state.pending.set(entry.file, entry);

  const lastWrittenAt = state.lastWrittenAt.get(entry.file);
  const isMembershipUnknown = !state.knownFiles.has(entry.file);
  const elapsed =
    lastWrittenAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - lastWrittenAt;
  if (options.immediate || isMembershipUnknown || elapsed >= SCALAR_FLUSH_INTERVAL_MS) {
    await flushDir(sessionDir, state);
    return;
  }

  if (!state.timer) {
    const timer = setTimeout(() => {
      state.timer = undefined;
      void flushDir(sessionDir, state).catch(() => {
        // best effort — the next write retries; the record stays the truth
      });
    }, SCALAR_FLUSH_INTERVAL_MS - elapsed);
    timer.unref?.();
    state.timer = timer;
  }
}

/**
 * Flush pending coalesced index updates — for one session dir, or all of
 * them. Wired into: queue-owner shutdown (exit snapshot path), process
 * beforeExit, and same-process index reads.
 */
export async function flushPendingSessionIndexUpdates(sessionDir?: string): Promise<void> {
  if (sessionDir !== undefined) {
    const state = dirStates.get(sessionDir);
    if (state) {
      await flushDir(sessionDir, state);
    }
    return;
  }
  for (const [dir, state] of dirStates) {
    if (state.pending.size > 0 || state.flushing) {
      await flushDir(dir, state).catch(() => {
        // best effort (e.g. dir removed) — record files remain the truth
      });
    }
  }
}
