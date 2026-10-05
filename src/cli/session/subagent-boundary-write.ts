import type { SessionRecord } from "../../types.js";

/**
 * How long a sub-agent's latest state may wait before its shadow record is
 * saved (brick://5e7c2a85).
 *
 * The transcript tailer delivers a batch every 300 ms per child
 * (`src/claude-jsonl.ts` POLL_INTERVAL_MS), and every batch used to become one
 * FULL record save. With 7 children that is ~23 saves/s, which held the
 * brick-outbox write lock 58–61 % of the time on the production volume (lane A
 * probe, brick://eb4c8d06 `verification/probes/RESULTS.md`). At 2 s a child
 * costs at most one save per window, a ~7× cut in save demand, and a crash
 * loses at most 2 s of that child's shadow record. The live per-message event
 * stream is NOT behind this window: `SessionEventWriter.appendMessage` still
 * runs per batch.
 */
export const SUBAGENT_RECORD_SAVE_INTERVAL_MS = 2_000;

export interface SubagentBoundaryWriter {
  /**
   * Record `childRecord` as the child's latest state. It is saved within one
   * interval, coalesced with every later call that arrives first. The promise
   * settles with the save that carries this state.
   */
  enqueue: (childAcpxRecordId: string, childRecord: SessionRecord) => Promise<void>;
  /**
   * Save pending state now, for one child or for all, and wait until nothing
   * enqueued before this call is still unwritten. Never rejects: a failed save
   * is reported through `onWriteError`.
   */
  flush: (childAcpxRecordId?: string) => Promise<void>;
  /** Children with a save scheduled or in flight. */
  pendingCount: () => number;
}

interface PendingSave {
  record: SessionRecord;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface ChildSaveState {
  /** Latest state not yet picked up by a save. Replaced, never queued. */
  pending: PendingSave | undefined;
  /** The one save in flight for this child, if any. Never rejects. */
  inFlight: Promise<void> | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  flushRequested: boolean;
}

function newPendingSave(record: SessionRecord): PendingSave {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Every caller of `enqueue` shares this promise. Production callers
  // `.catch()` it, but one that `void`s it must not turn a failed save into an
  // unhandled rejection: acpx installs no `unhandledRejection` handler, so under
  // Node's default that kills the queue owner mid-turn. Nine owners died that
  // way on devbox on 2026-09-22 (brick://da3d7c95). The failure itself is
  // reported once, through `onWriteError`.
  promise.catch(() => {});
  return { record, promise, resolve, reject };
}

/**
 * Coalesces the shadow-record saves for each sub-agent: latest state wins, at
 * most one save in flight and one pending per child, and a pending save waits
 * at most `intervalMs`.
 *
 * Saves for one child never overlap, and each save takes the newest state
 * enqueued before it starts. So a slow save can delay a newer state but never
 * overwrite it with an older one.
 *
 * Extracted from the queue-owner runtime closure so it is reachable from a test
 * with a slow or rejecting `write`.
 */
export function createSubagentBoundaryWriteEnqueuer(deps: {
  write: (record: SessionRecord) => Promise<void>;
  onWriteError: (childAcpxRecordId: string, error: unknown) => void;
  intervalMs?: number;
}): SubagentBoundaryWriter {
  const intervalMs = deps.intervalMs ?? SUBAGENT_RECORD_SAVE_INTERVAL_MS;
  const children = new Map<string, ChildSaveState>();

  const startSave = (childAcpxRecordId: string, state: ChildSaveState): void => {
    if (state.inFlight || !state.pending) {
      return;
    }
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    const save = state.pending;
    const { record } = save;
    state.pending = undefined;
    state.flushRequested = false;
    // `.then` so a `write` that throws synchronously still settles `save`.
    state.inFlight = Promise.resolve()
      .then(async () => {
        await deps.write(record);
      })
      .then(
        () => {
          save.resolve();
        },
        (error: unknown) => {
          save.reject(error);
          try {
            deps.onWriteError(childAcpxRecordId, error);
          } catch {
            // A throwing reporter must not reject `inFlight`: nothing awaits it
            // with a handler, and this child's saves would stop for good.
          }
        },
      )
      .then(() => {
        state.inFlight = undefined;
        afterSave(childAcpxRecordId, state);
      });
  };

  const afterSave = (childAcpxRecordId: string, state: ChildSaveState): void => {
    if (!state.pending) {
      children.delete(childAcpxRecordId);
      return;
    }
    if (state.flushRequested) {
      startSave(childAcpxRecordId, state);
      return;
    }
    scheduleSave(childAcpxRecordId, state);
  };

  const scheduleSave = (childAcpxRecordId: string, state: ChildSaveState): void => {
    if (state.timer || state.inFlight) {
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      startSave(childAcpxRecordId, state);
    }, intervalMs);
  };

  const enqueue = (childAcpxRecordId: string, childRecord: SessionRecord): Promise<void> => {
    let state = children.get(childAcpxRecordId);
    if (!state) {
      state = { pending: undefined, inFlight: undefined, timer: undefined, flushRequested: false };
      children.set(childAcpxRecordId, state);
    }
    if (state.pending) {
      state.pending.record = childRecord;
    } else {
      state.pending = newPendingSave(childRecord);
    }
    const { promise } = state.pending;
    scheduleSave(childAcpxRecordId, state);
    return promise;
  };

  const flushOne = async (childAcpxRecordId: string): Promise<void> => {
    const state = children.get(childAcpxRecordId);
    if (!state) {
      return;
    }
    if (state.pending) {
      const { promise } = state.pending;
      state.flushRequested = true;
      startSave(childAcpxRecordId, state);
      await promise.catch(() => {});
      return;
    }
    await state.inFlight;
  };

  const flush = async (childAcpxRecordId?: string): Promise<void> => {
    const ids = childAcpxRecordId === undefined ? [...children.keys()] : [childAcpxRecordId];
    await Promise.all(ids.map(flushOne));
  };

  return { enqueue, flush, pendingCount: () => children.size };
}
