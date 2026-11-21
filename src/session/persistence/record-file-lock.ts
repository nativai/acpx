import { readFileSync } from "node:fs";
import os from "node:os";
import { isProcessDefinitelyDead } from "../../process-liveness.js";
import { withIdentityFileLock, type LockHolderVerdict } from "./identity-file-lock.js";

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

export async function withRecordFileLock<T>(
  recordFile: string,
  action: () => Promise<T>,
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
    },
    action,
  );
}
