import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";

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
 * 🛑 NEVER A PROCEED-UNLOCKED FALLBACK. A writer that cannot get the lock waits (yielding, never
 * `Atomics.wait`), breaks it ONLY when the holder is provably dead, and otherwise fails with
 * `record-lock-timeout`. `index-lock.ts`'s ~2 s give-up-and-proceed is exactly the shape that
 * re-admits the lost update silently; do not copy it here.
 *
 * 🛑 "PROVABLY DEAD" IS ONLY PROVABLE ON THE HOLDER'S OWN HOST AND BOOT. A dev box is two pods
 * (control + workbench) with SEPARATE pid namespaces sharing one filesystem, so a live holder on
 * the other pod reads as ESRCH here. The lock therefore records `host` (hostname) and `boot`
 * (`/proc/sys/kernel/random/boot_id`), and a lock from a different — or unknown — host or boot is
 * never judged by its pid.
 *
 * ⚠️ BUT IT IS BOUNDED BY AGE. A pod restart changes the hostname and kills every owner mid-turn,
 * so "foreign host" is precisely the post-restart orphan; left unbounded it would recreate the
 * 2026-10-05 symptom — a session record that refuses every write until someone deletes a file.
 * Legitimate holds are milliseconds (read -> merge -> rename, no network), so a lock that cannot
 * be judged by pid is broken once it is older than RECORD_LOCK_STALE_MS, with a warning naming
 * the file, holder and age. The waiter's budget (RECORD_LOCK_BUDGET_MS) is deliberately LONGER
 * than that bound, so a waiting writer clears an orphan itself instead of refusing. A same-host,
 * same-boot holder that is provably ALIVE is never broken at any age.
 *
 * Breaking a stale lock is ACQUIRING it (compare-and-delete, then the atomic create), never
 * writing without it.
 */

const RECORD_LOCK_BUDGET_MS = 20_000;
const RECORD_LOCK_STALE_MS = 15_000;
const RECORD_LOCK_CAP_MS = 50;

type LockHolder = { pid: number; start: string | null; host: string | null; boot: string | null };

function bootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

const LOCAL_HOST = os.hostname();
const LOCAL_BOOT = bootId();

export class RecordLockTimeoutError extends Error {
  readonly code = "record-lock-timeout";
  constructor(lockPath: string, holder: string) {
    super(
      `session record lock ${lockPath} is held by ${holder} for over ` +
        `${RECORD_LOCK_BUDGET_MS} ms; refusing to write unlocked`,
    );
  }
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

/** Same host AND same boot, both known — the only case in which a pid can be judged at all. */
function isLocalHolder(holder: LockHolder): boolean {
  return LOCAL_BOOT !== null && holder.host === LOCAL_HOST && holder.boot === LOCAL_BOOT;
}

function holderIsProvablyDead(holder: LockHolder): boolean {
  if (!isLocalHolder(holder)) {
    return false;
  }
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  // The pid is alive. It is a DIFFERENT process only if both start times are known and differ.
  if (holder.start === null) {
    return false;
  }
  const current = processStartTime(holder.pid);
  return current !== null && current !== holder.start;
}

function parseHolder(raw: string): Partial<LockHolder> {
  try {
    return JSON.parse(raw) as Partial<LockHolder>;
  } catch {
    return {};
  }
}

type ReadHolder = { raw: string; ageMs: number; holder: LockHolder };

async function readHolder(lockPath: string): Promise<ReadHolder | null> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
    // Unparseable content is treated as an UNIDENTIFIED holder, so the age bound still clears it.
    const parsed = parseHolder(raw);
    return {
      raw,
      ageMs: Date.now() - stat.mtimeMs,
      holder: {
        pid: typeof parsed.pid === "number" ? parsed.pid : -1,
        start: parsed.start ?? null,
        host: parsed.host ?? null,
        boot: parsed.boot ?? null,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Creates the lock atomically WITH its content: the holder record is written to a unique temp
 * file and hard-linked to the lock path, which fails with EEXIST if the lock exists. A lock file
 * therefore never exists without the pid that owns it, so it can always be judged dead or alive.
 */
async function tryAcquire(lockPath: string, content: string): Promise<boolean> {
  const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  try {
    await fs.link(temporary, lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Why this lock may be broken, or null: a provably dead local holder, or an unjudgeable stale one. */
function breakReason(current: ReadHolder): string | null {
  if (current.holder.pid > 0 && holderIsProvablyDead(current.holder)) {
    return "holder is dead";
  }
  if (!isLocalHolder(current.holder) && current.ageMs > RECORD_LOCK_STALE_MS) {
    return `holder on another host/boot or unidentified, lock is ${Math.round(current.ageMs)} ms old`;
  }
  return null;
}

/** A break by AGE (not by a provably dead local pid) is named on stderr — the owner.log. */
function warnIfUnjudged(lockPath: string, reason: string, current: ReadHolder): void {
  if (isLocalHolder(current.holder)) {
    return;
  }
  process.stderr.write(
    `[acpx] WARNING: breaking stale session record lock ${lockPath} (${reason}); ` +
      `holder ${current.raw}\n`,
  );
}

/** Removes a breakable lock — compare-and-delete on its content, so a fresh holder is never hit. */
async function breakStaleHolder(lockPath: string): Promise<{ broken: boolean; holder: string }> {
  const current = await readHolder(lockPath);
  const reason = current ? breakReason(current) : null;
  if (!current || !reason) {
    return { broken: false, holder: current?.raw ?? "unreadable holder" };
  }
  warnIfUnjudged(lockPath, reason, current);
  const again = await readHolder(lockPath);
  if (again?.raw === current.raw) {
    await fs.rm(lockPath, { force: true });
  }
  return { broken: true, holder: current.raw };
}

export async function withRecordFileLock<T>(
  recordFile: string,
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = `${recordFile}.lock`;
  const content = JSON.stringify({
    pid: process.pid,
    start: processStartTime(process.pid),
    host: LOCAL_HOST,
    boot: LOCAL_BOOT,
  });
  const started = Date.now();
  let delay = 2 + Math.floor(Math.random() * 3);
  while (!(await tryAcquire(lockPath, content))) {
    const { broken, holder } = await breakStaleHolder(lockPath);
    if (broken) {
      continue;
    }
    if (Date.now() - started >= RECORD_LOCK_BUDGET_MS) {
      throw new RecordLockTimeoutError(lockPath, holder);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(RECORD_LOCK_CAP_MS, delay * 2 + Math.floor(Math.random() * 3));
  }
  try {
    return await action();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}
