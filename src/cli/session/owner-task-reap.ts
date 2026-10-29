import { appendFile } from "node:fs/promises";
import {
  followUntilQuietSync,
  formatSurvivors,
  reapSnapshot,
  signalSnapshot,
  snapshotSessionTree,
  unprovenTaskWarning,
  type BackgroundTaskSet,
  type ReapReport,
  type ReapSnapshot,
  type Signaller,
} from "../../process-tree-reap.js";
import { sessionEventActivePath } from "../../session/event-log.js";
import { resolveSessionRecord } from "../../session/persistence.js";

/**
 * brick ad6ba1c2 — the queue owner's side of the reap (CONCEPTION v3 §5.2 E, F, G).
 *
 * On every owner exit the owner admits, BEFORE it closes anything, the processes PROVABLY of its
 * live background tasks (v3 §5.1 proofs, from the tracker's live set), and reaps them after. Its own
 * session (the owner, the adapter, claude) is never signalled by these passes: the existing group
 * SIGKILL keeps owning them, so their teardown is exactly today's.
 *
 * ⚠️ NO REMEMBERED STATE (v3 §5.4). v2 memoized every session under claude at each task-set change,
 * foreground tool shells included, and later killed a FOREGROUND call's deliberate daemon on a
 * release of a still-open session (TE ADV-DAEMON). The proofs are session-unique and box-wide, so a
 * task a `claude` crash orphaned still proves itself here (path I) without a memo.
 */
export type OwnerTaskReaper = {
  /** Sync. Admission for this owner's live background tasks (its own session spared). */
  snapshot: () => ReapSnapshot;
};

export function createOwnerTaskReaper(params: {
  getTaskSet: () => BackgroundTaskSet;
  getAcpSessionId: () => string | undefined;
  procRoot?: string;
}): OwnerTaskReaper {
  const exclude = new Set([process.pid]);
  return {
    snapshot: () =>
      snapshotSessionTree({
        bg: params.getTaskSet(),
        acpSessionId: params.getAcpSessionId(),
        ownerPid: process.pid,
        exclude,
        procRoot: params.procRoot,
      }),
  };
}

/** HoD (v3): the K-of-N proof warning, on the owner's stderr (owner.log). Never throws. */
function warnUnproven(sessionId: string, facts: Parameters<typeof unprovenTaskWarning>[1]): void {
  const warning = unprovenTaskWarning(sessionId, facts);
  if (warning) {
    process.stderr.write(warning);
  }
}

/** A line is due when anything was found, anything survived, or nothing could be measured. */
export function ownerReapLineDue(report: ReapReport): boolean {
  return !report.measured || report.taskProcesses > 0 || report.survivors > 0;
}

/** The owner.log line (Contract C6 / §5.5). Never argv, never environ: pid and comm only. */
export function formatOwnerReapLine(sessionId: string, reason: string, report: ReapReport): string {
  if (!report.measured) {
    return (
      `[acpx] queue owner could NOT census the background task processes of session ${sessionId} ` +
      `after ${reason} (measured=false${report.skipped ? `, skipped=${report.skipped}` : ""}); ` +
      `task processes may survive\n`
    );
  }
  const survivors =
    report.survivors > 0
      ? `survivors=${report.survivors}: ${formatSurvivors(report.survivorDetails)}`
      : "survivors=0";
  return (
    `[acpx] queue owner reaped ${report.taskProcesses} background task process(es) of session ` +
    `${sessionId} after ${reason} (${survivors})\n`
  );
}

/** Reap a snapshot taken before the teardown, and log it on the owner's stderr (owner.log). */
export async function reapAndLogOnOwnerExit(
  sessionId: string,
  reason: string,
  snapshot: ReapSnapshot,
  options: { signal?: Signaller } = {},
): Promise<ReapReport | undefined> {
  try {
    const report = await reapSnapshot(snapshot, options);
    warnUnproven(sessionId, report);
    if (ownerReapLineDue(report)) {
      process.stderr.write(formatOwnerReapLine(sessionId, reason, report));
    }
    return report;
  } catch {
    // Never let a reap failure stop an owner from releasing its lease.
    return undefined;
  }
}

/**
 * The signal handler's two synchronous passes (§5.2 G). TERM at entry, so the tasks get their
 * cleanup chance while the custody sweep runs; KILL right before the group SIGKILL. Never throws.
 */
/**
 * The signal handler's bounded follow between its TERM and KILL passes. Inside the 1.5 s the closer
 * gives an owner after SIGTERM (`PROCESS_EXIT_GRACE_MS`), with room for the custody sweep and the scans.
 */
const SIGNAL_FOLLOW_BUDGET_MS = 500;

export function createOwnerSignalReap(sessionId: string, reaper: OwnerTaskReaper | undefined) {
  let snapshot: ReapSnapshot | undefined;
  return {
    term: (): void => {
      try {
        snapshot = reaper?.snapshot();
        if (snapshot) {
          signalSnapshot(snapshot, "SIGTERM");
        }
      } catch {
        snapshot = undefined;
      }
    },
    kill: (signal: string): void => {
      if (!snapshot) {
        return;
      }
      try {
        writeSignalReapLine(sessionId, signal, snapshot);
        // Let a task's TERM handler finish (and TERM what it forks) before the KILL pass, bounded.
        followUntilQuietSync(snapshot, SIGNAL_FOLLOW_BUDGET_MS);
        signalSnapshot(snapshot, "SIGKILL");
      } catch {
        // Never throw from a signal handler.
      }
    },
  };
}

function writeSignalReapLine(sessionId: string, signal: string, snapshot: ReapSnapshot): void {
  warnUnproven(sessionId, snapshot);
  if (!snapshot.measured) {
    process.stderr.write(
      `[acpx] queue owner could NOT census the background task processes of session ` +
        `${sessionId} after ${signal} (measured=false${snapshot.skipped ? `, skipped=${snapshot.skipped}` : ""}); ` +
        `task processes may survive\n`,
    );
    return;
  }
  if (snapshot.members.length > 0) {
    process.stderr.write(
      `[acpx] queue owner reaped ${snapshot.members.length} background task process(es) of session ` +
        `${sessionId} after ${signal} (SIGTERM sent; SIGKILL follows)\n`,
    );
  }
}

/**
 * HoD Q4 — after an owner-side reap while the session stays OPEN, an empty
 * `_claude/backgroundTasks` line clears acpx-ui's "⧖ running" chip at once: otherwise the stream's
 * last set line keeps claiming the killed tasks run until the next respawn. Same shape as the
 * adapter's own line (`fixtures/s1-claude-backgroundTasks.ndjson`). Best effort, never throws.
 */
export async function appendClearedBackgroundTasksLine(
  sessionId: string,
  acpSessionId: string,
): Promise<void> {
  const line = `${JSON.stringify({
    jsonrpc: "2.0",
    method: "_claude/backgroundTasks",
    params: { sessionId: acpSessionId, at: new Date().toISOString(), tasks: [] },
  })}\n`;
  await appendFile(sessionEventActivePath(sessionId), line, "utf8").catch(() => {});
}

/**
 * HoD Q4 (brick ad6ba1c2) — a recycle ended task processes while the session stays open: append an
 * empty `_claude/backgroundTasks` line so acpx-ui's "⧖ running" chip clears at once instead of
 * claiming the killed tasks still run until the next respawn.
 */
export async function clearBackgroundTaskChipAfterReap(
  sessionId: string,
  reap: ReapReport,
): Promise<void> {
  if (reap.measured && reap.taskProcesses > 0) {
    await clearBackgroundTaskChip(sessionId);
  }
}

/** Appends the empty set line only while the record is still open (a close needs no chip). */
export async function clearBackgroundTaskChip(sessionId: string): Promise<void> {
  const record = await resolveSessionRecord(sessionId).catch(() => undefined);
  if (record && record.closed !== true) {
    await appendClearedBackgroundTasksLine(record.acpxRecordId, record.acpSessionId);
  }
}
