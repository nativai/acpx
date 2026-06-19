import { randomInt } from "node:crypto";
import fs from "node:fs/promises";
import { isProcessAlive } from "../../process-liveness.js";
import { queueBaseDir, queueLockFilePath, queueSocketBaseDir, queueSocketPath } from "./paths.js";

export { isProcessAlive } from "../../process-liveness.js";

const PROCESS_EXIT_GRACE_MS = 1_500;
const PROCESS_POLL_MS = 50;
const QUEUE_OWNER_STALE_HEARTBEAT_MS = 15_000;

export type QueueOwnerProcessIdentity = {
  kind: "linux-proc-stat-starttime";
  startTimeTicks: string;
};

export type QueueOwnerStateKind =
  | "no_owner"
  | "healthy"
  | "dead_owner"
  | "stale_owner"
  | "socket_unreachable"
  | "pid_reused";

export type QueueOwnerRecord = {
  pid: number;
  sessionId: string;
  socketPath: string;
  createdAt: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
  processIdentity?: QueueOwnerProcessIdentity;
};

export type QueueOwnerLease = {
  sessionId: string;
  lockPath: string;
  socketPath: string;
  createdAt: string;
  ownerGeneration: number;
  processIdentity?: QueueOwnerProcessIdentity;
};

export type QueueOwnerStatus = {
  pid: number;
  socketPath: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
  alive: boolean;
  stale: boolean;
  state: Exclude<QueueOwnerStateKind, "no_owner">;
  recoverable: boolean;
  pidAlive: boolean;
  heartbeatAgeMs: number | null;
  processIdentity?: QueueOwnerProcessIdentity;
  currentProcessIdentity?: QueueOwnerProcessIdentity;
  processIdentityMatched: boolean | null;
  socketReachable: boolean | null;
};

/** Read-only owner liveness snapshot — never mutates/reaps the lease. */
export type QueueOwnerLiveness = {
  sessionId: string;
  ownerFound: boolean;
  state: QueueOwnerStateKind;
  recoverable: boolean;
  pid: number | null;
  pidAlive: boolean;
  alive: boolean;
  stale: boolean;
  socketPath: string | null;
  socketReachable: boolean | null;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  createdAt: string | null;
  ownerGeneration: number | null;
  queueDepth: number;
  processIdentity?: QueueOwnerProcessIdentity;
  currentProcessIdentity?: QueueOwnerProcessIdentity;
  processIdentityMatched: boolean | null;
};

/** Outcome of a force-restart (recover) of a session's queue owner. */
export type QueueOwnerRecoveryResult = {
  /** The session id whose lease was targeted (acpx record id). */
  sessionId: string;
  /** A lease/owner record existed when recovery started. */
  ownerFound: boolean;
  /** The owner pid from the lease, if any. */
  pid: number | undefined;
  /** The owner pid was alive when recovery started. */
  wasAlive: boolean;
  /** A live owner was found and is now confirmed gone. */
  killed: boolean;
  /** The owner pid is STILL alive after recovery — true means the kill failed. */
  alive: boolean;
  /** Precise owner-state classification observed before recovery. */
  state: QueueOwnerStateKind;
  /** The pid in the lease was alive, even if it no longer belonged to this owner. */
  pidAlive: boolean;
  /** True when a live pid matched the persisted process identity, false on PID reuse, null when unknown. */
  processIdentityMatched: boolean | null;
  /** True when a live pid was deliberately not signalled because it failed the identity guard. */
  killSkipped: boolean;
};

function parseQueueOwnerRecord(raw: unknown): QueueOwnerRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;

  if (!hasValidQueueOwnerRecordFields(record)) {
    return null;
  }

  return {
    pid: record.pid,
    sessionId: record.sessionId,
    socketPath: record.socketPath,
    createdAt: record.createdAt,
    heartbeatAt: record.heartbeatAt,
    ownerGeneration: record.ownerGeneration,
    queueDepth: record.queueDepth,
    ...(parseQueueOwnerProcessIdentity(record.processIdentity)
      ? { processIdentity: parseQueueOwnerProcessIdentity(record.processIdentity) }
      : {}),
  };
}

function parseQueueOwnerProcessIdentity(value: unknown): QueueOwnerProcessIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    record.kind === "linux-proc-stat-starttime" &&
    typeof record.startTimeTicks === "string" &&
    /^\d+$/.test(record.startTimeTicks)
  ) {
    return {
      kind: "linux-proc-stat-starttime",
      startTimeTicks: record.startTimeTicks,
    };
  }

  return undefined;
}

function hasValidQueueOwnerRecordFields(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  pid: number;
  sessionId: string;
  socketPath: string;
  createdAt: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
} {
  return (
    isPositiveInteger(record.pid) &&
    typeof record.sessionId === "string" &&
    typeof record.socketPath === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.heartbeatAt === "string" &&
    isPositiveInteger(record.ownerGeneration) &&
    isNonNegativeInteger(record.queueDepth)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function createOwnerGeneration(): number {
  return randomInt(1, 2 ** 48);
}

function nowIso(): string {
  return new Date().toISOString();
}

function heartbeatAgeMs(owner: QueueOwnerRecord, nowMs: number = Date.now()): number | null {
  const heartbeatMs = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    return null;
  }
  return Math.max(0, nowMs - heartbeatMs);
}

function isQueueOwnerHeartbeatStale(owner: QueueOwnerRecord): boolean {
  const ageMs = heartbeatAgeMs(owner);
  if (ageMs == null) {
    return true;
  }
  return ageMs > QUEUE_OWNER_STALE_HEARTBEAT_MS;
}

function parseLinuxProcStatStartTime(payload: string): string | undefined {
  const endCommandIndex = payload.lastIndexOf(")");
  if (endCommandIndex < 0) {
    return undefined;
  }

  const fieldsFromState = payload
    .slice(endCommandIndex + 1)
    .trim()
    .split(/\s+/);
  const startTime = fieldsFromState[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
}

export async function readQueueOwnerProcessIdentity(
  pid: number,
): Promise<QueueOwnerProcessIdentity | undefined> {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }

  try {
    const payload = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const startTimeTicks = parseLinuxProcStatStartTime(payload);
    return startTimeTicks
      ? {
          kind: "linux-proc-stat-starttime",
          startTimeTicks,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function processIdentitiesMatch(
  expected: QueueOwnerProcessIdentity | undefined,
  current: QueueOwnerProcessIdentity | undefined,
): boolean | null {
  if (!expected || !current) {
    return null;
  }
  return expected.kind === current.kind && expected.startTimeTicks === current.startTimeTicks;
}

async function isQueueSocketReachable(owner: QueueOwnerRecord): Promise<boolean | null> {
  if (process.platform === "win32") {
    return null;
  }

  try {
    await fs.stat(owner.socketPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    return false;
  }
}

async function ensureQueueDir(): Promise<void> {
  const baseDir = queueBaseDir();
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
  await fs.chmod(baseDir, 0o700);
  const socketDir = queueSocketBaseDir();
  if (socketDir) {
    await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
    await fs.chmod(socketDir, 0o700);
  }
}

async function removeSocketFile(socketPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  try {
    await fs.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await waitMs(PROCESS_POLL_MS);
  }

  return !isProcessAlive(pid);
}

async function cleanupStaleQueueOwner(
  sessionId: string,
  owner: QueueOwnerRecord | undefined,
): Promise<void> {
  const lockPath = queueLockFilePath(sessionId);
  const socketPath = owner?.socketPath ?? queueSocketPath(sessionId);

  await removeSocketFile(socketPath).catch(() => {
    // ignore stale socket cleanup failures
  });

  await fs.unlink(lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

type QueueOwnerStateInputs = {
  pidAlive: boolean;
  stale: boolean;
  socketReachable: boolean | null;
  processIdentityMatched: boolean | null;
};

function classifyQueueOwnerState(inputs: QueueOwnerStateInputs): QueueOwnerStateKind {
  if (inputs.processIdentityMatched === false) {
    return "pid_reused";
  }
  if (!inputs.pidAlive) {
    return "dead_owner";
  }
  if (inputs.stale) {
    return "stale_owner";
  }
  if (inputs.socketReachable === false) {
    return "socket_unreachable";
  }
  return "healthy";
}

function isRecoverableQueueOwnerState(state: QueueOwnerStateKind): boolean {
  return state === "dead_owner" || state === "stale_owner" || state === "pid_reused";
}

async function queueOwnerStateFromRecord(
  sessionId: string,
  owner: QueueOwnerRecord,
): Promise<QueueOwnerLiveness> {
  const pidAlive = isProcessAlive(owner.pid);
  const currentProcessIdentity = pidAlive
    ? await readQueueOwnerProcessIdentity(owner.pid)
    : undefined;
  const processIdentityMatched = processIdentitiesMatch(
    owner.processIdentity,
    currentProcessIdentity,
  );
  const stale = isQueueOwnerHeartbeatStale(owner);
  const socketReachable = await isQueueSocketReachable(owner);
  const state = classifyQueueOwnerState({
    pidAlive,
    stale,
    socketReachable,
    processIdentityMatched,
  });

  return {
    sessionId,
    ownerFound: true,
    state,
    recoverable: isRecoverableQueueOwnerState(state),
    pid: owner.pid,
    pidAlive,
    alive: pidAlive && processIdentityMatched !== false,
    stale,
    socketPath: owner.socketPath,
    socketReachable,
    heartbeatAt: owner.heartbeatAt,
    heartbeatAgeMs: heartbeatAgeMs(owner),
    createdAt: owner.createdAt,
    ownerGeneration: owner.ownerGeneration,
    queueDepth: owner.queueDepth,
    ...(owner.processIdentity ? { processIdentity: owner.processIdentity } : {}),
    ...(currentProcessIdentity ? { currentProcessIdentity } : {}),
    processIdentityMatched,
  };
}

function noQueueOwnerState(sessionId: string): QueueOwnerLiveness {
  return {
    sessionId,
    ownerFound: false,
    state: "no_owner",
    recoverable: false,
    pid: null,
    pidAlive: false,
    alive: false,
    stale: false,
    socketPath: null,
    socketReachable: null,
    heartbeatAt: null,
    heartbeatAgeMs: null,
    createdAt: null,
    ownerGeneration: null,
    queueDepth: 0,
    processIdentityMatched: null,
  };
}

async function readQueueOwnerStateForRecord(
  sessionId: string,
  owner: QueueOwnerRecord | undefined,
): Promise<QueueOwnerLiveness> {
  return owner ? await queueOwnerStateFromRecord(sessionId, owner) : noQueueOwnerState(sessionId);
}

function canSignalQueueOwner(state: QueueOwnerLiveness): boolean {
  return state.pid !== null && state.pidAlive && state.processIdentityMatched !== false;
}

function noQueueOwnerRecoveryResult(sessionId: string): QueueOwnerRecoveryResult {
  return {
    sessionId,
    ownerFound: false,
    pid: undefined,
    wasAlive: false,
    killed: false,
    alive: false,
    state: "no_owner",
    pidAlive: false,
    processIdentityMatched: null,
    killSkipped: false,
  };
}

async function terminateConfirmedQueueOwnerProcessGroup(
  pid: number,
  shouldSignalOwner: boolean,
): Promise<boolean> {
  if (!shouldSignalOwner) {
    return false;
  }

  // SIGTERM -> grace -> SIGKILL on the owner (the group leader). Reuses the
  // audited single-pid primitive; the owner shuts the adapter down on exit.
  await terminateProcess(pid);

  // Process-group sweep (R2): reap any group member (e.g. a native-blocked SDK
  // grandchild) that outlived the leader. The group still exists as long as any
  // member is alive, even once the leader pid is gone.
  if (hasLiveProcessGroup(pid)) {
    signalProcessGroup(pid, "SIGKILL");
    await waitForProcessExit(pid, PROCESS_EXIT_GRACE_MS);
  }

  return isProcessAlive(pid);
}

async function cleanupRecoverableQueueOwner(
  sessionId: string,
  owner: QueueOwnerRecord,
  state: QueueOwnerLiveness,
): Promise<boolean> {
  if (!state.recoverable) {
    return false;
  }

  if (state.state === "stale_owner" && canSignalQueueOwner(state)) {
    await terminateProcess(owner.pid).catch(() => {
      // best effort stale owner termination
    });
  }

  await cleanupStaleQueueOwner(sessionId, owner);
  return true;
}

export async function readQueueOwnerRecord(
  sessionId: string,
): Promise<QueueOwnerRecord | undefined> {
  const lockPath = queueLockFilePath(sessionId);
  try {
    const payload = await fs.readFile(lockPath, "utf8");
    const parsed = parseQueueOwnerRecord(JSON.parse(payload));
    return parsed ?? undefined;
  } catch {
    return undefined;
  }
}

export async function terminateProcess(pid: number): Promise<boolean> {
  if (!isProcessAlive(pid)) {
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }

  if (await waitForProcessExit(pid, PROCESS_EXIT_GRACE_MS)) {
    return true;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return false;
  }

  await waitForProcessExit(pid, PROCESS_EXIT_GRACE_MS);
  return true;
}

// True when the process GROUP led by `pid` still has at least one live member.
// The queue owner is spawned `detached: true` (queue-owner-process.ts), so it is
// a process-group leader and its pgid equals its pid. Mirrors the liveness probe
// in acp/terminal-manager.ts.
export function hasLiveProcessGroup(pid: number): boolean {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Best-effort signal to the whole process group led by `pid` (negative pid).
// Swallows errors: the group may already be gone (ESRCH) or unkillable (EPERM).
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // best-effort: process group cleanup races with members exiting on their own
  }
}

export async function ensureOwnerIsUsable(
  sessionId: string,
  owner: QueueOwnerRecord,
): Promise<boolean> {
  const state = await queueOwnerStateFromRecord(sessionId, owner);
  if (state.state === "healthy" || state.state === "socket_unreachable") {
    return true;
  }

  await cleanupRecoverableQueueOwner(sessionId, owner, state);
  return false;
}

export async function readQueueOwnerStatus(
  sessionId: string,
): Promise<QueueOwnerStatus | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  const state = await queueOwnerStateFromRecord(sessionId, owner);
  if (state.recoverable) {
    await cleanupRecoverableQueueOwner(sessionId, owner, state);
    return undefined;
  }

  return {
    pid: owner.pid,
    socketPath: owner.socketPath,
    heartbeatAt: owner.heartbeatAt,
    ownerGeneration: owner.ownerGeneration,
    queueDepth: owner.queueDepth,
    alive: state.alive,
    stale: state.stale,
    state: state.state as Exclude<QueueOwnerStateKind, "no_owner">,
    recoverable: state.recoverable,
    pidAlive: state.pidAlive,
    heartbeatAgeMs: state.heartbeatAgeMs,
    ...(owner.processIdentity ? { processIdentity: owner.processIdentity } : {}),
    ...(state.currentProcessIdentity
      ? { currentProcessIdentity: state.currentProcessIdentity }
      : {}),
    processIdentityMatched: state.processIdentityMatched,
    socketReachable: state.socketReachable,
  };
}

export async function tryAcquireQueueOwnerLease(
  sessionId: string,
  nowIsoFactory: () => string = nowIso,
): Promise<QueueOwnerLease | undefined> {
  await ensureQueueDir();
  const lockPath = queueLockFilePath(sessionId);
  const socketPath = queueSocketPath(sessionId);
  const createdAt = nowIsoFactory();
  const ownerGeneration = createOwnerGeneration();
  const processIdentity = await readQueueOwnerProcessIdentity(process.pid);
  const payload = JSON.stringify(
    {
      pid: process.pid,
      sessionId,
      socketPath,
      createdAt,
      heartbeatAt: createdAt,
      ownerGeneration,
      queueDepth: 0,
      ...(processIdentity ? { processIdentity } : {}),
    },
    null,
    2,
  );

  try {
    await fs.writeFile(lockPath, `${payload}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await removeSocketFile(socketPath).catch(() => {
      // best-effort stale socket cleanup after ownership is acquired
    });
    return {
      sessionId,
      lockPath,
      socketPath,
      createdAt,
      ownerGeneration,
      ...(processIdentity ? { processIdentity } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    const owner = await readQueueOwnerRecord(sessionId);
    if (!owner) {
      await cleanupStaleQueueOwner(sessionId, owner);
      return undefined;
    }

    const state = await queueOwnerStateFromRecord(sessionId, owner);
    await cleanupRecoverableQueueOwner(sessionId, owner, state);
    return undefined;
  }
}

export async function refreshQueueOwnerLease(
  lease: QueueOwnerLease,
  options: {
    queueDepth: number;
  },
  nowIsoFactory: () => string = nowIso,
): Promise<void> {
  const payload = JSON.stringify(
    {
      pid: process.pid,
      sessionId: lease.sessionId,
      socketPath: lease.socketPath,
      createdAt: lease.createdAt,
      heartbeatAt: nowIsoFactory(),
      ownerGeneration: lease.ownerGeneration,
      queueDepth: Math.max(0, Math.round(options.queueDepth)),
      ...(lease.processIdentity ? { processIdentity: lease.processIdentity } : {}),
    },
    null,
    2,
  );
  await fs.writeFile(lease.lockPath, `${payload}\n`, {
    encoding: "utf8",
  });
}

export async function releaseQueueOwnerLease(lease: QueueOwnerLease): Promise<void> {
  await removeSocketFile(lease.socketPath).catch(() => {
    // ignore best-effort cleanup failures
  });

  await fs.unlink(lease.lockPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

export async function terminateQueueOwnerForSession(sessionId: string): Promise<void> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return;
  }

  const state = await queueOwnerStateFromRecord(sessionId, owner);
  if (canSignalQueueOwner(state)) {
    await terminateProcess(owner.pid);
  }

  await cleanupStaleQueueOwner(sessionId, owner);
}

export async function readQueueOwnerState(sessionId: string): Promise<QueueOwnerLiveness> {
  return await readQueueOwnerStateForRecord(sessionId, await readQueueOwnerRecord(sessionId));
}

// Read-only owner liveness — unlike readQueueOwnerStatus(), this never calls
// ensureOwnerIsUsable() and therefore never terminates or removes a stale lease.
// Safe for the acpx-ui server or heartbeat tooling to poll.
export async function readQueueOwnerLiveness(sessionId: string): Promise<QueueOwnerLiveness> {
  return await readQueueOwnerState(sessionId);
}

// Force-restart primitive (the un-wedge): kill the session's queue-owner process
// GROUP and clear its lease so the next submit_prompt cold-spawns a fresh owner.
//
// Goes beyond terminateQueueOwnerForSession() (single-pid SIGTERM->SIGKILL) by
// also SIGKILL-ing the owner's process group. The owner spawns the ACP adapter,
// which runs the agent SDK child; a natively-blocked grandchild can survive a
// single-pid kill but stays in the owner's process group, so the group sweep
// guarantees it is reaped rather than orphaned (risk R2). Mirrors the
// process-group kill pattern in acp/terminal-manager.ts.
//
// Idempotent: a missing lease (nothing to kill) is success. The result reports
// `alive: true` only when the owner pid genuinely survived the kill.
export async function recoverQueueOwnerForSession(
  sessionId: string,
): Promise<QueueOwnerRecoveryResult> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    // Idempotent: no lease means there is no owner to kill. "Already gone" is success.
    return noQueueOwnerRecoveryResult(sessionId);
  }

  const pid = owner.pid;
  const state = await queueOwnerStateFromRecord(sessionId, owner);
  const shouldSignalOwner = canSignalQueueOwner(state);
  const wasAlive = state.pidAlive;
  const alive = await terminateConfirmedQueueOwnerProcessGroup(pid, shouldSignalOwner);

  await cleanupStaleQueueOwner(sessionId, owner);

  return {
    sessionId,
    ownerFound: true,
    pid,
    wasAlive,
    killed: shouldSignalOwner && wasAlive && !alive,
    alive,
    state: state.state,
    pidAlive: state.pidAlive,
    processIdentityMatched: state.processIdentityMatched,
    killSkipped: state.pidAlive && !shouldSignalOwner,
  };
}

export async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
