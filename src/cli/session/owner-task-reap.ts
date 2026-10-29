import fs from "node:fs";
import { appendFile } from "node:fs/promises";
import {
  formatSurvivors,
  mergeTaskSessions,
  parseProcStat,
  pruneDeadTaskSessions,
  reapSnapshot,
  signalSnapshot,
  snapshotSessionTree,
  type ReapReport,
  type ReapSnapshot,
  type Signaller,
  type TaskSessionMemo,
} from "../../process-tree-reap.js";
import { sessionEventActivePath } from "../../session/event-log.js";
import { resolveSessionRecord } from "../../session/persistence.js";

/**
 * brick ad6ba1c2 — the queue owner's side of the reap (CONCEPTION §5.2 E, F, G; §5.4).
 *
 * The owner remembers the task sessions its adapter's tree has created, so a task orphaned by a
 * `claude` crash (reparented to init, out of the tree) is still ended when the owner ends (path I).
 * On every owner exit the owner snapshots its own tree BEFORE it closes anything and reaps the
 * members OUTSIDE its own process group: the adapter and `claude` stay owned by the existing group
 * SIGKILL, so their teardown is exactly today's.
 */
export type OwnerTaskReaper = {
  /** A task-set change was observed: refresh the memos (coalesced, one scan per burst). */
  noteTaskSetChange: () => void;
  remembered: () => TaskSessionMemo[];
  /** The adapter that held the tasks was replaced: nothing it held is remembered any more. */
  resetRemembered: () => void;
  /** Sync. The owner's own tree minus itself and its own process group, plus the memos. */
  snapshotOwnerExit: () => ReapSnapshot;
  /** Sync. The (old) adapter's whole tree, plus the memos — a client switch (path F). */
  snapshotAdapter: (adapterPid: number | undefined) => ReapSnapshot;
};

function ownProcessGroup(): number | undefined {
  try {
    return parseProcStat(fs.readFileSync("/proc/self/stat", "utf8"))?.pgid;
  } catch {
    return undefined;
  }
}

export function createOwnerTaskReaper(params: {
  getAgentPid: () => number | undefined;
  procRoot?: string;
}): OwnerTaskReaper {
  let memos: TaskSessionMemo[] = [];
  let refreshScheduled = false;
  // Resolved once: a process's group does not change after start, and the exit path must not do
  // avoidable I/O.
  const spareProcessGroup = ownProcessGroup();
  const exclude = new Set([process.pid]);

  const refresh = (): void => {
    refreshScheduled = false;
    try {
      const snapshot = snapshotSessionTree({
        rootPid: params.getAgentPid(),
        includeRoot: false,
        exclude,
        procRoot: params.procRoot,
      });
      if (snapshot.measured) {
        memos = pruneDeadTaskSessions(
          mergeTaskSessions(memos, snapshot.taskSessions),
          params.procRoot,
        );
      }
    } catch {
      // Best effort: a missed refresh only weakens path I, never a turn.
    }
  };

  return {
    noteTaskSetChange: () => {
      if (refreshScheduled) {
        return;
      }
      refreshScheduled = true;
      setImmediate(refresh);
    },
    remembered: () => memos.map((memo) => ({ ...memo, members: [...memo.members] })),
    resetRemembered: () => {
      memos = [];
    },
    snapshotOwnerExit: () =>
      snapshotSessionTree({
        rootPid: process.pid,
        includeRoot: false,
        remembered: memos,
        exclude,
        spareProcessGroup,
        procRoot: params.procRoot,
      }),
    snapshotAdapter: (adapterPid) =>
      snapshotSessionTree({
        rootPid: adapterPid,
        includeRoot: true,
        remembered: memos,
        exclude,
        procRoot: params.procRoot,
      }),
  };
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
export function createOwnerSignalReap(sessionId: string, reaper: OwnerTaskReaper | undefined) {
  let snapshot: ReapSnapshot | undefined;
  return {
    term: (): void => {
      try {
        snapshot = reaper?.snapshotOwnerExit();
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
        const taskProcesses = snapshot.members.filter((m) => m.inTaskSession).length;
        if (!snapshot.measured || taskProcesses > 0) {
          process.stderr.write(
            snapshot.measured
              ? `[acpx] queue owner reaped ${taskProcesses} background task process(es) of session ` +
                  `${sessionId} after ${signal} (SIGTERM sent; SIGKILL follows)\n`
              : `[acpx] queue owner could NOT census the background task processes of session ` +
                  `${sessionId} after ${signal} (measured=false); task processes may survive\n`,
          );
        }
        signalSnapshot(snapshot, "SIGKILL");
      } catch {
        // Never throw from a signal handler.
      }
    },
  };
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
