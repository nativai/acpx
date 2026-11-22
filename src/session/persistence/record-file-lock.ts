import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import { isTransientReadError } from "../../pod/spawn-state.js";
import { isProcessDefinitelyDead } from "../../process-liveness.js";
import {
  LOCK_LOST_CODE,
  withIdentityFileLock,
  type HeldLock,
  type LockHolderVerdict,
} from "./identity-file-lock.js";

/**
 * A per-record lock file, `<record>.json.lock`, held ONLY across a record write's
 * read -> merge -> temp-write -> rename (brick eb4c8d06).
 *
 * WHY IT EXISTS. Ordinary session writes no longer go through the box-wide SQLite lock, so two
 * PROCESSES writing one record are ordered only by the repository's merge rules, which merge
 * against a disk read. Whatever lands between that read and this write's rename is lost: a live
 * owner's checkpoint overwrote a concurrent `sessions close`, `set-parent`, favourite or metadata
 * patch in 3-4 of every 20 cross-process ops even with the read moved to right before the rename
 * (`test/outbox-writer-pairs.test.ts`). Holding this lock across read -> rename closes that
 * window for every writer that takes it. It is per record, so unrelated sessions never wait on
 * each other, and it is held for milliseconds, never across a messages-log flush.
 *
 * 🛑 NEVER A PROCEED-UNLOCKED FALLBACK. A writer that cannot get the lock waits, breaks it ONLY
 * when the holder is provably dead, and otherwise fails with `record-lock-timeout`.
 *
 * 🛑 "PROVABLY DEAD" IS ONLY PROVABLE IN THE HOLDER'S OWN PID NAMESPACE (brick ae547131 §5.1). The
 * lock used to trust hostname + boot id, which is wrong in two cases that hostname cannot see: a
 * sibling container of the same pod (same host, same boot, another pid namespace — a live holder
 * there reads ESRCH here) and this container before a restart (same host, same boot, a NEW pid
 * namespace). The body now carries the holder's birth identity and is judged by the shared
 * primitive (identity-file-lock.ts): pid-judged only in the reader's own boot + pid ns + time ns.
 *
 * ⚠️ BUT IT IS BOUNDED BY AGE — FOR A BODY WITHOUT A `pod` FIELD, OR A HOLDER IN THE READER'S OWN
 * POD. A holder that cannot be judged (another namespace, unidentified) is broken once the lock is
 * older than RECORD_LOCK_STALE_MS, with a warning. A holder in ANOTHER pod is never broken by age,
 * only on the death proof (C3.2, brick 8d85cb47; the primitive's table). The waiter's budget is
 * deliberately LONGER than that bound, so a waiting writer clears an orphan itself instead of
 * refusing. A provably ALIVE holder in the reader's own scope is never broken at any age.
 *
 * The body keeps the pre-0a `{pid,start,host,boot}` with their old meaning: a pre-0a writer still
 * judges a 0a holder by host + boot + start exactly as before.
 */

/** The record lock waiter's budget — ONE named constant (C3.2; fault 2 may raise it). */
export const RECORD_LOCK_BUDGET_MS = 20_000;
const RECORD_LOCK_STALE_MS = 15_000;

function bootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

const LOCAL_HOST = os.hostname();
const LOCAL_BOOT = bootId();

export const RECORD_LOCK_TIMEOUT_CODE = "record-lock-timeout";
export const RECORD_LOCK_UNAVAILABLE_CODE = "record-lock-unavailable";

/**
 * The record lock could not be TAKEN for a reason that passes — file descriptors for a moment (`EMFILE`,
 * `ENFILE`), memory, a mount's hiccup (`isTransientReadError`). Nothing was written; the next attempt (the
 * next checkpoint) may succeed, so it is RETRIED, like `spawn-state-missing` — not a raw errno (F-8).
 */
export class RecordLockUnavailableError extends Error {
  readonly code = RECORD_LOCK_UNAVAILABLE_CODE;
  constructor(lockPath: string, errno: string) {
    super(
      `session record lock ${lockPath} could not be taken just now (${errno}); nothing was written: retry`,
    );
  }
}

/** `code`, not `instanceof` — the atrium server loads this module through `pod-lock.ts` (a second load is a second class). */
export function isRecordLockUnavailable(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === RECORD_LOCK_UNAVAILABLE_CODE
  );
}

export class RecordLockTimeoutError extends Error {
  readonly code = RECORD_LOCK_TIMEOUT_CODE;
  constructor(lockPath: string, holder: string) {
    super(
      `session record lock ${lockPath} is held by ${holder} for over ` +
        `${RECORD_LOCK_BUDGET_MS} ms; refusing to write unlocked`,
    );
  }
}

/**
 * The waiter's typed timeout, recognised by its `code` — not `instanceof`, because the atrium
 * server loads this module through `pod-lock.ts` and a second load is a second class.
 */
export function isRecordLockTimeout(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === RECORD_LOCK_TIMEOUT_CODE
  );
}

/** Linux process start time (stat field 22), so a recycled pid is not mistaken for the holder. */
function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/**
 * The PRE-0a rule, kept for a legacy body (no `processIdentity`) so a legacy holder is judged no
 * more loosely than before: only a same-host, same-boot holder is judged by pid at all — ESRCH, or
 * a live pid whose known start time differs, is dead; a live one is otherwise live — and any other
 * host/boot is unjudgeable (age-bounded).
 */
function judgeLegacyRecordHolder(body: Record<string, unknown>): LockHolderVerdict {
  const local = LOCAL_BOOT !== null && body.host === LOCAL_HOST && body.boot === LOCAL_BOOT;
  if (!local) {
    return "unjudgeable";
  }
  if (isProcessDefinitelyDead(body.pid as number)) {
    return "breakable";
  }
  return judgeLiveLegacyStart(body.pid as number, body.start);
}

/** A live local pid is a DIFFERENT process only if both start times are known and differ. */
function judgeLiveLegacyStart(pid: number, start: unknown): LockHolderVerdict {
  if (typeof start !== "string") {
    return "live";
  }
  const current = processStartTime(pid);
  return current !== null && current !== start ? "breakable" : "live";
}

/**
 * Holds `<recordFile>.lock` across `action`. `action` gets the held lock: call `lock.assertHeld()`
 * (or `assertHeldSync`) IMMEDIATELY before the rename that publishes the record — C3.2 A-4 "the
 * holder checks before it publishes". Prefer `updateRecordFile`, which does that by construction.
 */
export async function withRecordFileLock<T>(
  recordFile: string,
  action: (lock: HeldLock) => Promise<T>,
): Promise<T> {
  return await withIdentityFileLock(
    `${recordFile}.lock`,
    {
      label: "session record lock",
      budgetMs: RECORD_LOCK_BUDGET_MS,
      staleMs: RECORD_LOCK_STALE_MS,
      legacyBody: () => ({
        pid: process.pid,
        start: processStartTime(process.pid),
        host: LOCAL_HOST,
        boot: LOCAL_BOOT,
      }),
      judgeLegacy: judgeLegacyRecordHolder,
      makeTimeoutError: (lockPath, holder) => new RecordLockTimeoutError(lockPath, holder),
      mapAcquireError: (error) => {
        const errno = (error as NodeJS.ErrnoException | undefined)?.code;
        return isTransientReadError(errno)
          ? new RecordLockUnavailableError(`${recordFile}.lock`, String(errno))
          : undefined;
      },
    },
    action,
  );
}

/** How often a publish that found its lock broken starts again before it gives up. */
export const RECORD_LOCK_LOST_ATTEMPTS = 3;
export const RECORD_LOCK_LOST_CODE = "record-lock-lost";

export class RecordLockLostError extends Error {
  readonly code = RECORD_LOCK_LOST_CODE;
  constructor(recordFile: string, attempts: number) {
    super(
      `session record lock for ${recordFile} was broken under its holder ${attempts} times; ` +
        "nothing published",
    );
  }
}

/** True for a publish refused because the lock was no longer ours (`code`, not `instanceof`). */
export function isRecordLockLost(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === RECORD_LOCK_LOST_CODE
  );
}

function isLockLost(error: unknown): boolean {
  return (
    !!error && typeof error === "object" && (error as { code?: unknown }).code === LOCK_LOST_CODE
  );
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * THE record-write entry (C3.2 A-4; shape agreed with atrium lane T, 2026-11-21). Under the record
 * lock: read the record's bytes (`undefined` = no file), let `change` return the new bytes
 * (`undefined` = write nothing), write them to a temp file beside it (mode 0600), check the lock
 * still carries our token, rename. "Re-read inside the lock" and "check before publish" hold by
 * construction. A lock found broken at the check: the temp file is removed and the whole write
 * starts again, up to RECORD_LOCK_LOST_ATTEMPTS times, then `record-lock-lost`. A waiter out of
 * budget throws `record-lock-timeout`. There is no unlocked path.
 */
export async function updateRecordFile(
  recordFile: string,
  change: (current: string | undefined) => Promise<string | undefined> | string | undefined,
): Promise<{ written: boolean }> {
  for (let attempt = 1; attempt <= RECORD_LOCK_LOST_ATTEMPTS; attempt += 1) {
    try {
      return await withRecordFileLock(recordFile, async (lock) => {
        const next = await change(await readOptional(recordFile));
        if (next === undefined) {
          return { written: false };
        }
        const temporary = `${recordFile}.${process.pid}.${randomUUID()}.tmp`;
        await fs.writeFile(temporary, next, { encoding: "utf8", mode: 0o600 });
        try {
          await lock.assertHeld();
          await fs.rename(temporary, recordFile);
        } catch (error) {
          await fs.rm(temporary, { force: true });
          throw error;
        }
        return { written: true };
      });
    } catch (error) {
      if (!isLockLost(error)) {
        throw error;
      }
    }
  }
  throw new RecordLockLostError(recordFile, RECORD_LOCK_LOST_ATTEMPTS);
}
