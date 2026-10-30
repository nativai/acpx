import fs from "node:fs";
import { sessionUsesClaudeCredentials } from "../../acp/agent-command.js";
import { subscriptionIdFromRecord } from "../../config/subscription-transcript.js";
import {
  formatTranscriptReapLines,
  hasLeftBehindTranscript,
  reapLeftBehindTranscripts,
  type TranscriptReapSummary,
} from "../../config/transcript-reap.js";
import {
  isRecordedPidPossiblyAlive,
  observeProcessIncarnation,
  parseProcessBirthIdentity,
  type ProcessBirthIdentity,
  type RecordPidIdentity,
} from "../../process-identity.js";
import { parseProcStat } from "../../process-tree-reap.js";
import { resolveSessionRecord } from "../../session/persistence.js";
import type { SessionRecord } from "../../types.js";
import type { QueueOwnerRecord } from "../queue/lease-store.js";
import { queueOwnerLogPath } from "./queue-owner-process.js";

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

export function listLiveGroupMembers(pgid: number, selfPid: number): number[] {
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

// ---------------------------------------------------------------------------
// D5 (brick 1e77037f, option b2) — the NON-SELF close removes the left-behind copy too.
//
// A close ends the owner by SIGTERM (the fatal-signal path), which never reaps, so a session
// closed without an idle release after its last switch kept its copy until someone ran
// `acpx transcripts dedup` (77 % of closed switched sessions measured). The closer runs the same
// reaper as its LAST step, once it has PROVEN — from outside the owner — everything D2 proves from
// inside: the record is durably `closed:true` (no turn can start), the owner it observed is gone by
// identity and its whole process group is empty (no signal sent here: the fatal path already
// SIGKILLed the group), and the recorded adapter is gone. Any doubt skips the step with a reason.
//
// ⚠️ DO NOT RUN THIS BEFORE THE OWNER IS PROVEN DEAD, AND DO NOT HOLD THE QUEUE LEASE FOR IT. A live
// Claude Code re-stamps its exit block by PATH and would recreate a removed copy as a fragment; and a
// lease held by a non-owner reads as a live owner everywhere (submit may force-restart the closer,
// `set profile` would recycle it). The self-close arm never calls this (it dies with its own owner).
// ---------------------------------------------------------------------------

/** A left-behind copy must be this quiet before the close removes it (D2's idle exit: 10 min). */
export const CLOSE_REAP_QUIET_MS = 60_000;
/** The close's own budget; the rest waits for `acpx transcripts dedup`. */
export const CLOSE_REAP_BUDGET = { wallMs: 2_000, bytes: 256 * 1024 * 1024 };
/** A close that has already run this long gets no reap at all (acpx-ui budgets 15 s per close). */
export const CLOSE_REAP_SLOW_CLOSE_MS = 8_000;
/** How long the closer waits for the observed owner's process group to show no live member. */
export const CLOSE_GROUP_EMPTY_WAIT_MS = 500;

/** The owner the close observed ALIVE and verified before stopping it, and whether it led its group. */
export type PreStopOwnerObservation = {
  pid: number;
  identity: ProcessBirthIdentity;
  groupLeader: boolean;
};

/**
 * One `/proc/<pid>/stat` read right after the close read the lease. Only a local owner whose
 * identity matches before AND after the read is observed; anything else is `undefined`.
 */
export function observeOwnerBeforeStop(
  owner: Pick<QueueOwnerRecord, "pid" | "processIdentity"> | null,
): PreStopOwnerObservation | undefined {
  const identity = owner ? parseProcessBirthIdentity(owner.processIdentity) : undefined;
  if (!owner || !identity || observeProcessIncarnation(owner.pid, identity) !== "matching") {
    return undefined;
  }
  const stat = readOwnStat(owner.pid);
  if (!stat || observeProcessIncarnation(owner.pid, identity) !== "matching") {
    return undefined;
  }
  return { pid: owner.pid, identity, groupLeader: stat.pgid === owner.pid };
}

function readOwnStat(pid: number): { pgid: number } | undefined {
  try {
    return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

export type CloseReapInput = {
  /** The acpx record id (the owner.log key). */
  sessionId: string;
  closeStartedAt: number;
  observation: PreStopOwnerObservation | undefined;
  ownerStop: { stopped: boolean; reason: string };
  /** The record's adapter pid/identity captured BEFORE the close cleared them. */
  adapter: { pid: number | undefined; pidIdentity: RecordPidIdentity | undefined };
  recordClosedState:
    | { status: "read"; closed: { present: boolean; value?: unknown } }
    | { status: "read_failed" };
  verbose?: boolean;
};

export type CloseReapDeps = {
  now: () => number;
  resolveRecord: (sessionId: string) => Promise<SessionRecord>;
  isOwnerGone: (pid: number, identity: ProcessBirthIdentity) => boolean;
  listMembers: (pgid: number, selfPid: number) => number[];
  isAdapterAlive: (pid: number, identity: RecordPidIdentity | undefined) => boolean;
  sleep: (ms: number) => Promise<void>;
  hasLeftBehind: (record: SessionRecord) => Promise<boolean>;
  reap: typeof reapLeftBehindTranscripts;
  writeLog: (sessionId: string, line: string) => Promise<void>;
};

const defaultCloseReapDeps: CloseReapDeps = {
  now: Date.now,
  resolveRecord: resolveSessionRecord,
  isOwnerGone: (pid, identity) => observeProcessIncarnation(pid, identity) === "gone",
  listMembers: listLiveGroupMembers,
  isAdapterAlive: isRecordedPidPossiblyAlive,
  sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
  hasLeftBehind: async (record) => await hasLeftBehindTranscript(record),
  reap: reapLeftBehindTranscripts,
  writeLog: async (sessionId, line) =>
    await fs.promises.appendFile(queueOwnerLogPath(sessionId), line),
};

export type CloseReapOutcome =
  | { ran: true; summary: TranscriptReapSummary }
  | { ran: false; reason: string }
  | undefined;

/**
 * The close's last step (non-self arm only). Never throws: every failure is a skip with a reason,
 * and the close's own result and output are unchanged. Returns what happened, for tests.
 */
export async function reapTranscriptsAfterClose(
  input: CloseReapInput,
  overrides: Partial<CloseReapDeps> = {},
): Promise<CloseReapOutcome> {
  const deps: CloseReapDeps = { ...defaultCloseReapDeps, ...overrides };
  try {
    return await runCloseReap(input, deps);
  } catch (error) {
    await emitCloseLine(input, deps, `skipped=error:${(error as Error).message}`).catch(() => {});
    return { ran: false, reason: "error" };
  }
}

async function runCloseReap(input: CloseReapInput, deps: CloseReapDeps): Promise<CloseReapOutcome> {
  const record = await deps.resolveRecord(input.sessionId);
  if (ownerExitReapGateReason(record)) {
    return undefined;
  }
  if (deps.now() - input.closeStartedAt >= CLOSE_REAP_SLOW_CLOSE_MS) {
    // No probe either: a close that is already slow must not get slower.
    await emitCloseLine(input, deps, `session=${record.acpSessionId} skipped=close-slow`);
    return { ran: false, reason: "close-slow" };
  }
  const reason = await closeProofReason(input, deps);
  if (reason) {
    if (await deps.hasLeftBehind(record)) {
      await emitCloseLine(input, deps, `session=${record.acpSessionId} skipped=${reason}`);
    }
    return { ran: false, reason };
  }
  const summary = await deps.reap({
    record,
    quietMs: CLOSE_REAP_QUIET_MS,
    budget: CLOSE_REAP_BUDGET,
    reducedBy: "session-close",
  });
  for (const line of formatTranscriptReapLines(summary, { trigger: "session-close" })) {
    await writeLine(input, deps, line);
  }
  return { ran: true, summary };
}

/** §3.2 items 2–4, in order; the first failing condition names the skip. */
async function closeProofReason(
  input: CloseReapInput,
  deps: CloseReapDeps,
): Promise<string | undefined> {
  if (!recordReadBackClosed(input.recordClosedState)) {
    return "not-closed";
  }
  return (await ownerProofReason(input, deps)) ?? adapterProofReason(input, deps);
}

function recordReadBackClosed(state: CloseReapInput["recordClosedState"]): boolean {
  return state.status === "read" && state.closed.present && state.closed.value === true;
}

async function ownerProofReason(
  input: CloseReapInput,
  deps: CloseReapDeps,
): Promise<string | undefined> {
  if (!input.ownerStop.stopped) {
    return input.ownerStop.reason === "successor" ? "successor-owner" : "owner-alive";
  }
  const observed = input.observation;
  if (!observed) {
    // No owner was alive and verified at the close (idle-released or crashed earlier): no group
    // to prove; the adapter check, the quiet guard and D4 cover that generation.
    return undefined;
  }
  if (!deps.isOwnerGone(observed.pid, observed.identity)) {
    return "owner-alive";
  }
  if (!observed.groupLeader) {
    return "no-leader";
  }
  return (await groupEmptied(observed.pid, deps)) ? undefined : "group-busy";
}

/**
 * Linux keeps a pgid allocated while ANY member lives, so an empty group proves every adapter and
 * Claude Code the observed owner started is dead. Waits, never signals.
 */
async function groupEmptied(pgid: number, deps: CloseReapDeps): Promise<boolean> {
  const deadline = deps.now() + CLOSE_GROUP_EMPTY_WAIT_MS;
  while (deps.listMembers(pgid, process.pid).length > 0) {
    if (deps.now() >= deadline) {
      return false;
    }
    await deps.sleep(GROUP_POLL_MS / 2);
  }
  return true;
}

function adapterProofReason(input: CloseReapInput, deps: CloseReapDeps): string | undefined {
  const { pid, pidIdentity } = input.adapter;
  return pid !== undefined && deps.isAdapterAlive(pid, pidIdentity) ? "adapter-alive" : undefined;
}

async function emitCloseLine(input: CloseReapInput, deps: CloseReapDeps, fields: string) {
  await writeLine(input, deps, `[acpx] transcript-reap ${fields} trigger=session-close\n`);
}

/** owner.log always (append); the closer's stderr only with `--verbose`. */
async function writeLine(input: CloseReapInput, deps: CloseReapDeps, line: string): Promise<void> {
  await deps.writeLog(input.sessionId, line).catch(() => {});
  if (input.verbose) {
    process.stderr.write(line);
  }
}
