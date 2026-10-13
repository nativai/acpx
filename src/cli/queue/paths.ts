import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function queueKeyForSession(sessionId: string): string {
  return shortHash(sessionId, 24);
}

export function queueBaseDir(
  homeDir: string = process.env.ACPX_STATE_HOME || os.homedir(),
): string {
  return path.join(homeDir, ".acpx", "queues");
}

export function queueSocketBaseDir(
  homeDir: string = process.env.ACPX_STATE_HOME || os.homedir(),
): string | undefined {
  if (process.platform === "win32") {
    return undefined;
  }
  return path.join("/tmp", `acpx-${shortHash(homeDir, 10)}`);
}

export function queueLockFilePath(
  sessionId: string,
  homeDir: string = process.env.ACPX_STATE_HOME || os.homedir(),
): string {
  return path.join(queueBaseDir(homeDir), `${queueKeyForSession(sessionId)}.lock`);
}

export function queueSocketPath(
  sessionId: string,
  homeDir: string = process.env.ACPX_STATE_HOME || os.homedir(),
): string {
  const key = queueKeyForSession(sessionId);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\acpx-${key}`;
  }
  return path.join(queueSocketBaseDir(homeDir) ?? "/tmp", `${key}.sock`);
}

/**
 * The queue socket dir on the SHARED state volume (`<stateHome>/.acpx/q/`, brick ae547131 §9). A
 * socket under it can be connected to from every pod that mounts `~/.acpx`, so ONLY there is a
 * refused/absent ping evidence about an owner in another pod (CONCEPT §5.2, `shared(socketPath)`).
 */
export function queueSharedSocketDir(
  homeDir: string = process.env.ACPX_STATE_HOME || os.homedir(),
): string {
  return path.join(homeDir, ".acpx", "q");
}

export function isSharedQueueSocketPath(
  socketPath: string,
  homeDir: string = process.env.ACPX_STATE_HOME || os.homedir(),
): boolean {
  return socketPath.startsWith(`${queueSharedSocketDir(homeDir)}${path.sep}`);
}

const LEGACY_TMP_SOCKET = /^\/tmp\/acpx-[0-9a-f]{10}\/[0-9a-f]{24}\.sock$/;

/** A reaper unlinks a dead lease's socket only at a path acpx itself could have bound (§7.2). */
export function isReapableQueueSocketPath(
  socketPath: string,
  homeDir: string = process.env.ACPX_STATE_HOME || os.homedir(),
): boolean {
  return isSharedQueueSocketPath(socketPath, homeDir) || LEGACY_TMP_SOCKET.test(socketPath);
}
