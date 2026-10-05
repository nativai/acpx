import { SpawnLedgerError } from "../spawn-ledger.js";

const DEFAULT_LIVE_CHECKPOINT_INTERVAL_MS = 500;

export type LiveSessionCheckpointOptions = {
  save: () => Promise<void>;
  intervalMs?: number;
  /**
   * Override the failure report. Omitting it does NOT mean "stay quiet" — see
   * {@link LiveSessionCheckpoint} — because a swallowed checkpoint failure is
   * indistinguishable from a healthy session.
   */
  onError?: (error: unknown) => void;
};

/**
 * 🛑 A FAILING CHECKPOINT IS A SESSION WHOSE RECORD HAS SILENTLY STOPPED
 * ADVANCING — SAY SO, ALWAYS (brick://48aca560).
 *
 * This class is the last thing standing between a save that throws and nobody
 * ever finding out. It swallowed one for four bisect sessions: a single
 * camelCase key made `assertPersistedKeyPolicy` throw inside the write, and the
 * session's record froze at its pre-turn state while every in-memory value
 * stayed correct, no exception surfaced, and the whole unit suite was green.
 *
 * The reporting therefore lives HERE and not in the callers, because that is
 * what made it fail: `runtime/engine/manager.ts` passed no `onError` at all,
 * and `cli/session/runtime.ts` gated its own behind `options.verbose` — so the
 * ordinary, non-verbose queue-owner turn, which is every real turn, said
 * nothing. A default that reports cannot be forgotten by a new call site.
 *
 * Reported once per distinct message per checkpoint: the condition is durable
 * and persistent, so repeating it every 500 ms would bury it rather than
 * surface it, while a NEW failure mode still gets its own line.
 */
function reportCheckpointFailure(error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(
    `[acpx] 🛑 session record checkpoint FAILED — this session's record has stopped ` +
      `being written to disk, so state changed from here on is being lost even though ` +
      `it looks correct in memory. ${checkpointFailureCause(error)} ${detail}\n`,
  );
}

const KEY_POLICY_VIOLATION_PREFIX = "Persisted key policy violation";

/**
 * Name the failure for what it IS (brick://b8e251eb). This line used to blame "a
 * non-snake_case persisted key" for every failure, and on 2026-10-05 it said so
 * for an `outbox-busy` lock timeout — pointing a diagnosis at the key policy
 * while the real cause was another process holding the outbox write lock.
 */
export function checkpointFailureCause(error: unknown): string {
  if (error instanceof SpawnLedgerError && error.code === "outbox-busy") {
    return (
      "Cause: SpawnLedgerError outbox-busy — another writer held the spawn-ledger lock " +
      "(~/.acpx/brick-outbox.db) past the retry budget; lock contention, not a record defect."
    );
  }
  if (error instanceof SpawnLedgerError) {
    return `Cause: SpawnLedgerError ${error.code}.`;
  }
  if (error instanceof Error && error.message.startsWith(KEY_POLICY_VIOLATION_PREFIX)) {
    return "Cause: a non-snake_case persisted key (see src/persisted-key-policy.ts).";
  }
  const name = error instanceof Error ? error.name : typeof error;
  return `Cause: ${name} — not a persisted-key violation.`;
}

export class LiveSessionCheckpoint {
  private readonly save: () => Promise<void>;
  private readonly intervalMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly reported = new Set<string>();
  private dirty = false;
  private flushing: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: LiveSessionCheckpointOptions) {
    this.save = options.save;
    this.intervalMs = options.intervalMs ?? DEFAULT_LIVE_CHECKPOINT_INTERVAL_MS;
    this.onError = options.onError ?? reportCheckpointFailure;
  }

  /** Deduplicate on the message, so a persistent failure is loud once, not 120×/min. */
  private reportOnce(error: unknown): void {
    const key = error instanceof Error ? error.message : String(error);
    if (this.reported.has(key)) {
      return;
    }
    this.reported.add(key);
    this.onError(error);
  }

  request(): void {
    this.dirty = true;
    if (this.timer) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch((error: unknown) => {
        this.reportOnce(error);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async checkpoint(): Promise<void> {
    this.dirty = true;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.flushing) {
      await this.flushing;
      if (!this.dirty) {
        return;
      }
    }

    this.flushing = this.flushDirty();
    try {
      await this.flushing;
    } finally {
      this.flushing = undefined;
    }
  }

  private async flushDirty(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      await this.save();
    }
  }
}
