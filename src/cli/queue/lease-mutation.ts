import fs from "node:fs/promises";
import path from "node:path";
import { withIdentityFileLock } from "../../session/persistence/identity-file-lock.js";
import { queueLockFilePath } from "./paths.js";

/**
 * The per-lease mutation guard (brick ae547131 §7.1). Every lease mutation — acquire, refresh,
 * release, reap, the verify-and-signal step of terminate/recover and the cleanup after a kill — runs
 * inside it, so a judgement ("generation G is dead") and the delete it licenses cannot interleave
 * with a successor's acquire or a live owner's heartbeat. Waiting for a process to EXIT happens
 * outside it.
 *
 * Aligned with openclaw/acpx e1a0795b: upstream's name and guard path (`<lease>.guard`), but built on
 * the fork's own identity lock primitive instead of `@openclaw/fs-safe`, and — deliberately unlike
 * upstream — an UNJUDGEABLE holder (another pid namespace) is broken after 10 s rather than never:
 * a phase-1 seat pod that dies holding the guard must not wedge its lease forever.
 */

const GUARD_WAIT_MS = 2_000;
const GUARD_STALE_MS = 10_000;

export class QueueLeaseGuardTimeoutError extends Error {
  readonly code = "queue-lease-guard-timeout";
  constructor(guardPath: string, holder: string) {
    super(`queue lease guard ${guardPath} is held by ${holder}; mutation not performed`);
  }
}

export function isQueueLeaseGuardTimeout(error: unknown): error is QueueLeaseGuardTimeoutError {
  return error instanceof QueueLeaseGuardTimeoutError;
}

export function queueLeaseGuardPath(sessionId: string): string {
  return `${queueLockFilePath(sessionId)}.guard`;
}

// In-process serialization per guard path, so two mutations of one owner never contend on the file.
const localTails = new Map<string, Promise<void>>();

export async function withQueueLeaseMutation<T>(
  sessionId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const guardPath = queueLeaseGuardPath(sessionId);
  await fs.mkdir(path.dirname(guardPath), { recursive: true, mode: 0o700 });
  const previous = localTails.get(guardPath) ?? Promise.resolve();
  let releaseLocal!: () => void;
  const mine = new Promise<void>((resolve) => {
    releaseLocal = resolve;
  });
  const tail = previous.then(() => mine);
  localTails.set(guardPath, tail);
  await previous;
  try {
    return await withIdentityFileLock(
      guardPath,
      {
        label: "queue lease guard",
        budgetMs: GUARD_WAIT_MS,
        staleMs: GUARD_STALE_MS,
        legacyBody: () => ({ pid: process.pid, acquiredAt: new Date().toISOString() }),
        makeTimeoutError: (lockPath, holder) => new QueueLeaseGuardTimeoutError(lockPath, holder),
      },
      mutate,
    );
  } finally {
    releaseLocal();
    if (localTails.get(guardPath) === tail) {
      localTails.delete(guardPath);
    }
  }
}
