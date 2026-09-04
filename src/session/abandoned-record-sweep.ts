import {
  type LiveProcessScan,
  scanIsMeasured,
  sessionOwnedByLiveProcess,
} from "../process-population.js";
import type { SessionRecord } from "../types.js";

/**
 * Close session records whose owner is gone (brick 7adac97e).
 *
 * ## ⚠️ WHY THIS EXISTS ONE LAYER ABOVE THE DIRECTORY SWEEP
 *
 * `pruneOrphanHarnessConfigDirs` now removes a directory only on POSITIVE
 * ownership, and one of its clauses is "the record is CLOSED". That is the right
 * safety rule and it is deliberately NOT weakened here. But it makes the
 * directory sweep's effectiveness a function of RECORD state — so a store full of
 * records that were abandoned rather than closed makes a *correct* sweep retain
 * every directory forever.
 *
 * That is exactly what was measured on the rig: **206 records, 118 closed, 88
 * still OPEN**, from lanes that had long since finished, each one pinning a
 * config dir at roughly 63 MB. The population is not a reason to relax the
 * deletion rule; it is a reason to fix the population.
 *
 * ## What "no live owner" means here, and why the pid alone will not do
 *
 * A record's `pid` is its AGENT. acpx also runs a per-session QUEUE OWNER, and an
 * agent that exited leaves a dead `pid` beside a live owner still holding
 * custody. Closing on the pid check alone would terminate sessions that are in
 * use — so ownership is pid **or** a live command line naming the session
 * ({@link sessionOwnedByLiveProcess}).
 *
 * ⚠️ AND IT REFUSES WITHOUT A POPULATION. `/proc` is read with a population
 * control; an unmeasurable scan closes NOTHING. A sweep that cannot see processes
 * and a box on which nothing is running produce the same empty evidence, and only
 * one of them is safe to act on.
 */
export interface AbandonedRecordSweepResult {
  /** OPEN records examined. ⚠️ 0 means NOT RUN, not "nothing to do". */
  scanned: number;
  /** Ids actually closed. */
  closed: string[];
  retained: number;
  retainedBy: {
    /** A live process still owns it — pid or command line. */
    liveOwner: number;
    /** Used too recently to be called abandoned. */
    tooYoung: number;
    /** The close itself failed. */
    closeFailed: number;
    /** No usable timestamp, so age could not be established — never guessed. */
    ageUnknown: number;
  };
  /** The idle age of the OLDEST record left open, in ms. */
  oldestRetainedIdleMs?: number;
  /** True when the sweep REFUSED because `/proc` was not measurable. */
  notMeasured: boolean;
}

/**
 * How long a record must sit unused before it is considered abandoned.
 *
 * ⚠️ STATED, NOT INFERRED — 24 hours. Longer than any working session this
 * programme has run, so a record idle this long is not one somebody is coming
 * back to mid-task. It is deliberately more generous than the directory sweep's
 * six hours, because closing a record is the more consequential of the two.
 */
export const DEFAULT_ABANDONED_IDLE_MS = 24 * 60 * 60 * 1000;

export async function sweepAbandonedSessionRecords(params: {
  records: readonly SessionRecord[];
  /** The `/proc` census. Absent or unmeasured ⇒ nothing is closed. */
  liveScan?: LiveProcessScan;
  /** Injected so this is testable without touching a real session. */
  closeSession: (sessionId: string) => Promise<unknown>;
  minIdleMs?: number;
  now?: number;
}): Promise<AbandonedRecordSweepResult> {
  const retainedBy = { liveOwner: 0, tooYoung: 0, closeFailed: 0, ageUnknown: 0 };
  const open = params.records.filter((record) => record.closed !== true);

  if (!scanIsMeasured(params.liveScan)) {
    return refusedSweep(open.length, retainedBy);
  }
  const liveScan = params.liveScan;
  const { now, minIdleMs } = resolveSweepDefaults(params);

  const closed: string[] = [];
  let retained = 0;
  let oldestRetainedIdleMs: number | undefined;
  for (const record of open) {
    const verdict = classifyRecord(record, { liveScan, now, minIdleMs });
    if (verdict.retain) {
      retained += 1;
      retainedBy[verdict.reason] += 1;
      if (verdict.idleMs !== undefined) {
        oldestRetainedIdleMs = Math.max(oldestRetainedIdleMs ?? 0, verdict.idleMs);
      }
      continue;
    }
    try {
      await params.closeSession(verdict.closeId);
      closed.push(verdict.closeId);
    } catch {
      retained += 1;
      retainedBy.closeFailed += 1;
    }
  }

  return {
    scanned: open.length,
    closed,
    retained,
    retainedBy,
    oldestRetainedIdleMs,
    notMeasured: false,
  };
}

/**
 * What the sweep returns when `/proc` was not measurable. It still reports the
 * CANDIDATE population, because a refusal that also printed `scanned=0` would be
 * indistinguishable from a store with nothing open.
 */
function refusedSweep(
  candidates: number,
  retainedBy: AbandonedRecordSweepResult["retainedBy"],
): AbandonedRecordSweepResult {
  return {
    scanned: candidates,
    closed: [],
    retained: candidates,
    retainedBy: { ...retainedBy, liveOwner: candidates },
    notMeasured: true,
  };
}

/** Defaults in one place, so the main function reads as the RULE. */
function resolveSweepDefaults(params: { now?: number; minIdleMs?: number }): {
  now: number;
  minIdleMs: number;
} {
  return {
    now: params.now ?? Date.now(),
    minIdleMs: params.minIdleMs ?? DEFAULT_ABANDONED_IDLE_MS,
  };
}

type RecordVerdict =
  | { retain: true; reason: "liveOwner" | "tooYoung" | "ageUnknown"; idleMs?: number }
  | { retain: false; closeId: string };

/**
 * Whether one record may be closed. Every retention names its reason, so
 * "retained 40" is diagnosable rather than merely reassuring.
 */
function classifyRecord(
  record: SessionRecord,
  ctx: { liveScan: LiveProcessScan; now: number; minIdleMs: number },
): RecordVerdict {
  if (sessionOwnedByLiveProcess(ctx.liveScan, record)) {
    return { retain: true, reason: "liveOwner" };
  }
  const idleMs = idleMillis(record, ctx.now);
  if (idleMs === undefined) {
    // ⚠️ NOT treated as infinitely old. A record with no usable timestamp is the
    // one we know least about, and "unknown" must never read as "stale".
    return { retain: true, reason: "ageUnknown" };
  }
  if (idleMs < ctx.minIdleMs) {
    return { retain: true, reason: "tooYoung", idleMs };
  }
  const closeId = record.acpxRecordId;
  if (!closeId) {
    return { retain: true, reason: "ageUnknown" };
  }
  return { retain: false, closeId };
}

/** Idle time from the most recent timestamp the record carries, or undefined. */
function idleMillis(record: SessionRecord, now: number): number | undefined {
  // The record's own field names, checked against `types.ts` rather than
  // guessed — `updatedAt` does not exist on `SessionRecord` and reading it would
  // have returned undefined for every record, silently narrowing the evidence.
  const stamps = [record.lastUsedAt, record.lastPromptAt, record.createdAt]
    .map((value) => (typeof value === "string" ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  if (stamps.length === 0) {
    return undefined;
  }
  return Math.max(0, now - Math.max(...stamps));
}

/** One line carrying every population, for the CLI's verbose output. */
export function describeAbandonedRecordSweep(result: AbandonedRecordSweepResult): string {
  const by = result.retainedBy;
  return (
    `[acpx] abandoned session records: scanned=${result.scanned} closed=${result.closed.length} ` +
    `retained=${result.retained} (liveOwner=${by.liveOwner} tooYoung=${by.tooYoung} ` +
    `ageUnknown=${by.ageUnknown} closeFailed=${by.closeFailed})` +
    (result.notMeasured ? " — REFUSED: /proc not measurable, nothing was closed" : "") +
    " (scanned=0 means NOT RUN, not clean)\n"
  );
}
