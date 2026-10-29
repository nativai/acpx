import fs from "node:fs";
import { sessionUsesClaudeCredentials } from "../../acp/agent-command.js";
import { subscriptionIdFromRecord } from "../../config/subscription-transcript.js";
import {
  formatTranscriptReapLines,
  reapLeftBehindTranscripts,
} from "../../config/transcript-reap.js";
import { resolveSessionRecord } from "../../session/persistence.js";
import type { SessionRecord } from "../../types.js";

// D2 (brick 81433524, CONCEPTION §2.4) — the queue owner's exit removes the
// transcript copies its session left in other subscriptions, inside the held lease.
//
// WHICH EXITS REAP. Only an idle release (idle-memory, deploy-staleness, an idle-
// path output-style change, a closed record's release): nobody waits on it. A
// turn-boundary recycle (account switch, lock-blocked, output-style change after a
// turn) is waited on by the retry or the next prompt, so it takes no group step and
// no reap — its left-behind copy is handled at the next generation's idle exit. The
// fatal-signal and superseded exits never get here.
export type OwnerExitKind = "idle-release" | "turn-boundary-recycle" | "other";

export function ownerExitReapsTranscripts(kind: OwnerExitKind): boolean {
  return kind === "idle-release";
}

/** Wait this long for the owner's process group to empty on its own, then SIGKILL the rest. */
export const OWNER_GROUP_GRACE_MS = 3_000;
/** How long a SIGKILLed member gets to be gone (or a zombie) before the reap is skipped. */
export const OWNER_GROUP_KILL_CONFIRM_MS = 1_000;
const GROUP_POLL_MS = 50;

export type GroupSettleDeps = {
  /** Live (non-zombie) members of process group `pgid`, excluding `selfPid`. */
  listMembers: (pgid: number, selfPid: number) => number[];
  /** The current pgrp of `pid`, or undefined when it is gone. */
  readPgrp: (pid: number) => number | undefined;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type GroupSettleResult =
  | { settled: true; killed: number }
  | { settled: false; survivors: number[] };

/**
 * The group step. After it, no process this owner ever started can append to any
 * copy of its session. It MOVES the kill every normal exit already does
 * (`closeQueueOwnerRuntime`'s final group SIGKILL) to just before the release,
 * behind a grace; it never adds one, and it only runs inside an exit that already
 * happens — so it cannot shorten the background-task hold (brick 0c593c10).
 */
export async function settleOwnerProcessGroup(params: {
  pgid: number;
  selfPid: number;
  graceMs?: number;
  confirmMs?: number;
  deps?: Partial<GroupSettleDeps>;
}): Promise<GroupSettleResult> {
  const deps = { ...defaultGroupSettleDeps, ...params.deps };
  const { pgid, selfPid } = params;
  await waitForEmptyGroup(pgid, selfPid, params.graceMs ?? OWNER_GROUP_GRACE_MS, deps);
  let killed = 0;
  for (const pid of deps.listMembers(pgid, selfPid)) {
    // Re-read right before the kill: a reused pid cannot be in our group.
    if (deps.readPgrp(pid) === pgid) {
      deps.kill(pid, "SIGKILL");
      killed += 1;
    }
  }
  if (killed === 0) {
    return { settled: true, killed };
  }
  await waitForEmptyGroup(pgid, selfPid, params.confirmMs ?? OWNER_GROUP_KILL_CONFIRM_MS, deps);
  const survivors = deps.listMembers(pgid, selfPid);
  return survivors.length === 0 ? { settled: true, killed } : { settled: false, survivors };
}

async function waitForEmptyGroup(
  pgid: number,
  selfPid: number,
  budgetMs: number,
  deps: GroupSettleDeps,
): Promise<void> {
  const deadline = deps.now() + budgetMs;
  while (deps.listMembers(pgid, selfPid).length > 0 && deps.now() < deadline) {
    await deps.sleep(GROUP_POLL_MS);
  }
}

/** `/proc/<pid>/stat` after the `)` that ends `comm`: state, ppid, pgrp, … */
function readStatFields(pid: number): string[] | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
  } catch {
    return undefined;
  }
}

function listLiveGroupMembers(pgid: number, selfPid: number): number[] {
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return [];
  }
  return entries
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid !== selfPid && isLiveGroupMember(pid, pgid));
}

function isLiveGroupMember(pid: number, pgid: number): boolean {
  const fields = readStatFields(pid);
  // Zombies (Z) and dead (X) members can no longer write anything.
  return (
    fields !== undefined && Number(fields[2]) === pgid && fields[0] !== "Z" && fields[0] !== "X"
  );
}

const defaultGroupSettleDeps: GroupSettleDeps = {
  listMembers: listLiveGroupMembers,
  readPgrp: (pid) => {
    const fields = readStatFields(pid);
    return fields ? Number(fields[2]) : undefined;
  },
  kill: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch {
      // gone already
    }
  },
  sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

/** Why this session's exit must not reap at all, or undefined when it may. */
export function ownerExitReapGateReason(
  record: Pick<SessionRecord, "agentCommand" | "acpSessionId" | "acpx">,
): string | undefined {
  if (!sessionUsesClaudeCredentials(record)) {
    return "not-claude";
  }
  // Unbound: the spawn may substitute a known-dead default, so the active dir is
  // not something this exit can know.
  if (subscriptionIdFromRecord(record) === undefined) {
    return "unbound";
  }
  return record.acpSessionId.trim() ? undefined : "no-session-id";
}

export type OwnerExitReapDeps = {
  resolveRecord: (sessionId: string) => Promise<SessionRecord>;
  settle: () => Promise<GroupSettleResult>;
  reap: typeof reapLeftBehindTranscripts;
  write: (line: string) => void;
};

/**
 * Called by `closeQueueOwnerRuntime` after the shared client is closed and the
 * snapshot is flushed, BEFORE the lease is released. Never throws: a failed reap
 * leaves every file in place and the exit continues.
 */
export async function reapTranscriptsAtOwnerExit(params: {
  sessionId: string;
  exitKind: OwnerExitKind;
  isGroupLeader: () => boolean;
  superseded: boolean;
  deps?: Partial<OwnerExitReapDeps>;
}): Promise<void> {
  if (!ownerExitReapsTranscripts(params.exitKind) || params.superseded) {
    return;
  }
  const deps: OwnerExitReapDeps = {
    resolveRecord: resolveSessionRecord,
    settle: async () => await settleOwnerProcessGroup({ pgid: process.pid, selfPid: process.pid }),
    reap: reapLeftBehindTranscripts,
    write: (line) => process.stderr.write(line),
    ...params.deps,
  };
  try {
    await runOwnerExitReap(params.sessionId, params.isGroupLeader, deps);
  } catch (error) {
    deps.write(
      `[acpx] transcript-reap session=${params.sessionId} skipped=error:${(error as Error).message}\n`,
    );
  }
}

async function runOwnerExitReap(
  sessionId: string,
  isGroupLeader: () => boolean,
  deps: OwnerExitReapDeps,
): Promise<void> {
  const record = await deps.resolveRecord(sessionId);
  if (ownerExitReapGateReason(record)) {
    return;
  }
  if (!isGroupLeader()) {
    deps.write(`[acpx] transcript-reap session=${record.acpSessionId} skipped=no-leader\n`);
    return;
  }
  const settled = await deps.settle();
  if (!settled.settled) {
    deps.write(
      `[acpx] transcript-reap session=${record.acpSessionId} skipped=group-busy ` +
        `survivors=${settled.survivors.join(",")}\n`,
    );
    return;
  }
  // Re-read: the record may have moved (a manual switch) while the group settled.
  const latest = await deps.resolveRecord(sessionId);
  if (ownerExitReapGateReason(latest)) {
    return;
  }
  for (const line of formatTranscriptReapLines(await deps.reap({ record: latest }))) {
    deps.write(line);
  }
}
