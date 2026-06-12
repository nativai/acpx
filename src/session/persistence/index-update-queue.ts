import { withSessionIndexLock } from "./index-lock.js";
import { reconcileSessionIndex, writeSessionIndex, type SessionIndexEntry } from "./index.js";

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
 *   A crash before the flush loses only index *scalar* freshness (≤ 5 s);
 *   the session record — written before the index on every path — stays the
 *   source of truth and heals the entry on the session's next write.
 * - Pending state flushes on owner exit (explicit call), on process
 *   `beforeExit`, and before any same-process index read
 *   (read-your-writes within the process).
 */

const SCALAR_FLUSH_INTERVAL_MS = 5_000;

type DirState = {
  pending: Map<string, SessionIndexEntry>;
  /** index.files as of this process's last flush — membership knowledge. */
  knownFiles: Set<string>;
  /** Last time this process wrote each file's entry into the index. */
  lastWrittenAt: Map<string, number>;
  timer: NodeJS.Timeout | undefined;
  flushing: Promise<void> | undefined;
};

const dirStates = new Map<string, DirState>();
let beforeExitHookInstalled = false;

function stateFor(sessionDir: string): DirState {
  let state = dirStates.get(sessionDir);
  if (!state) {
    state = {
      pending: new Map(),
      knownFiles: new Set(),
      lastWrittenAt: new Map(),
      timer: undefined,
      flushing: undefined,
    };
    dirStates.set(sessionDir, state);
    installBeforeExitHook();
  }
  return state;
}

function installBeforeExitHook(): void {
  if (beforeExitHookInstalled) {
    return;
  }
  beforeExitHookInstalled = true;
  // beforeExit may fire repeatedly (each async flush re-enters the loop);
  // the handler is a no-op once nothing is pending, so this terminates.
  // A hard process.exit()/SIGKILL skips it: ≤5 s scalar staleness, healed by
  // the session's next write (conception W2.3 / edge case D6).
  process.on("beforeExit", () => {
    void flushPendingSessionIndexUpdates().catch(() => {
      // best effort at exit
    });
  });
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
    state.flushing = writePendingEntries(sessionDir, state);
    try {
      await state.flushing;
    } finally {
      state.flushing = undefined;
    }
  }
}

async function writePendingEntries(sessionDir: string, state: DirState): Promise<void> {
  const pending = new Map(state.pending);
  state.pending.clear();
  await withSessionIndexLock(sessionDir, async () => {
    // Reconcile picks up concurrent writers' membership changes; pending
    // entries are handed in so new files are not re-read from disk.
    const { index } = await reconcileSessionIndex(sessionDir, pending);
    const diskFiles = new Set(index.files);
    const entries = index.entries.filter((entry) => !pending.has(entry.file));
    for (const [file, entry] of pending) {
      // A pending file pruned by another process between queue and flush
      // stays dropped — never resurrect an index row for a vanished file.
      if (diskFiles.has(file)) {
        entries.push(entry);
      }
    }
    await writeSessionIndex(sessionDir, { files: index.files, entries });
    state.knownFiles = new Set(index.files);
    const now = Date.now();
    for (const file of pending.keys()) {
      state.lastWrittenAt.set(file, now);
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
