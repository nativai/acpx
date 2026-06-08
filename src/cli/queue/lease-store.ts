import { randomInt } from "node:crypto";
import fs from "node:fs/promises";
import { isProcessAlive } from "../../process-liveness.js";
import { queueBaseDir, queueLockFilePath, queueSocketBaseDir, queueSocketPath } from "./paths.js";

export { isProcessAlive } from "../../process-liveness.js";

const PROCESS_EXIT_GRACE_MS = 1_500;
const PROCESS_POLL_MS = 50;
const QUEUE_OWNER_STALE_HEARTBEAT_MS = 15_000;

export type QueueOwnerRecord = {
  pid: number;
  sessionId: string;
  socketPath: string;
  createdAt: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
};

export type QueueOwnerLease = {
  sessionId: string;
  lockPath: string;
  socketPath: string;
  createdAt: string;
  ownerGeneration: number;
};

export type QueueOwnerStatus = {
  pid: number;
  socketPath: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
  alive: boolean;
  stale: boolean;
};

/** Read-only owner liveness snapshot — never mutates/reaps the lease. */
export type QueueOwnerLiveness = {
  pid: number;
  alive: boolean;
  stale: boolean;
  heartbeatAt: string;
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
  };
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

function isQueueOwnerHeartbeatStale(owner: QueueOwnerRecord): boolean {
  const heartbeatMs = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    return true;
  }
  return Date.now() - heartbeatMs > QUEUE_OWNER_STALE_HEARTBEAT_MS;
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
  const alive = isProcessAlive(owner.pid);
  const stale = isQueueOwnerHeartbeatStale(owner);
  if (alive && !stale) {
    return true;
  }

  if (alive) {
    await terminateProcess(owner.pid).catch(() => {
      // best effort stale owner termination
    });
  }
  await cleanupStaleQueueOwner(sessionId, owner);
  return false;
}

export async function readQueueOwnerStatus(
  sessionId: string,
): Promise<QueueOwnerStatus | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  const alive = await ensureOwnerIsUsable(sessionId, owner);
  if (!alive) {
    return undefined;
  }

  return {
    pid: owner.pid,
    socketPath: owner.socketPath,
    heartbeatAt: owner.heartbeatAt,
    ownerGeneration: owner.ownerGeneration,
    queueDepth: owner.queueDepth,
    alive,
    stale: isQueueOwnerHeartbeatStale(owner),
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
  const payload = JSON.stringify(
    {
      pid: process.pid,
      sessionId,
      socketPath,
      createdAt,
      heartbeatAt: createdAt,
      ownerGeneration,
      queueDepth: 0,
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

    if (!isProcessAlive(owner.pid) || isQueueOwnerHeartbeatStale(owner)) {
      if (isProcessAlive(owner.pid)) {
        await terminateProcess(owner.pid).catch(() => {
          // best effort stale owner termination
        });
      }
      await cleanupStaleQueueOwner(sessionId, owner);
    }
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

  if (isProcessAlive(owner.pid)) {
    await terminateProcess(owner.pid);
  }

  await cleanupStaleQueueOwner(sessionId, owner);
}

// Read-only owner liveness — unlike readQueueOwnerStatus(), this never calls
// ensureOwnerIsUsable() and therefore never terminates or removes a stale lease.
// Safe for the acpx-ui server to poll for the `ownerAlive` status input.
export async function readQueueOwnerLiveness(
  sessionId: string,
): Promise<QueueOwnerLiveness | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  return {
    pid: owner.pid,
    alive: isProcessAlive(owner.pid),
    stale: isQueueOwnerHeartbeatStale(owner),
    heartbeatAt: owner.heartbeatAt,
  };
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
    return {
      sessionId,
      ownerFound: false,
      pid: undefined,
      wasAlive: false,
      killed: false,
      alive: false,
    };
  }

  const pid = owner.pid;
  const wasAlive = isProcessAlive(pid);

  if (wasAlive) {
    // SIGTERM -> grace -> SIGKILL on the owner (the group leader). Reuses the
    // audited single-pid primitive; the owner shuts the adapter down on exit.
    await terminateProcess(pid);
  }

  // Process-group sweep (R2): reap any group member (e.g. a native-blocked SDK
  // grandchild) that outlived the leader. The group still exists as long as any
  // member is alive, even once the leader pid is gone.
  if (hasLiveProcessGroup(pid)) {
    signalProcessGroup(pid, "SIGKILL");
    await waitForProcessExit(pid, PROCESS_EXIT_GRACE_MS);
  }

  await cleanupStaleQueueOwner(sessionId, owner);

  const alive = isProcessAlive(pid);
  return {
    sessionId,
    ownerFound: true,
    pid,
    wasAlive,
    killed: wasAlive && !alive,
    alive,
  };
}

export async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
