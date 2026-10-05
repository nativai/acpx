import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
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
 * Breaking a stale lock is ACQUIRING it (exclusive removal, then the atomic create), never
 * writing without it.
 *
 * 🛑 EVERY REMOVAL OF THE LOCK FILE GOES THROUGH `removeIfStill` — the stale-break AND the release.
 * Never `rm` the lock path directly. A read-then-`rm` deletes whatever file is at the path at the
 * moment of the `rm`, and several waiters judge the same dead holder at once: one breaks it, a
 * second contender links a fresh lock, and a third waiter whose re-read still saw the dead holder
 * `rm`s the FRESH lock — two live holders (te-A attack E: 3 overlaps per 1,500 critical sections
 * with a holder SIGKILLed every 300 ms; `test/record-file-lock.test.ts` "attack E" row). `rename` is
 * atomic, so exactly one remover takes the file, and it then checks that the file it took is the
 * one it judged (content + inode + mtime) and hands anything else straight back with `link`, which
 * never overwrites.
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

/** One lock FILE, identified by content AND inode AND mtime — a fresh file can reuse an inode. */
type LockSnapshot = { raw: string; ino: number; mtimeMs: number };

/** Reads content and stat through ONE file handle, so both describe the same file. */
async function snapshot(file: string): Promise<LockSnapshot | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const [stat, raw] = await Promise.all([handle.stat(), handle.readFile("utf8")]);
    return { raw, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function sameLock(a: LockSnapshot | null, b: LockSnapshot): boolean {
  return a !== null && a.raw === b.raw && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
}

type ReadHolder = { snapshot: LockSnapshot; raw: string; ageMs: number; holder: LockHolder };

async function readHolder(lockPath: string): Promise<ReadHolder | null> {
  const current = await snapshot(lockPath);
  if (!current) {
    return null;
  }
  // Unparseable content is treated as an UNIDENTIFIED holder, so the age bound still clears it.
  const parsed = parseHolder(current.raw);
  return {
    snapshot: current,
    raw: current.raw,
    ageMs: Date.now() - current.mtimeMs,
    holder: {
      pid: typeof parsed.pid === "number" ? parsed.pid : -1,
      start: parsed.start ?? null,
      host: parsed.host ?? null,
      boot: parsed.boot ?? null,
    },
  };
}

/**
 * Creates the lock atomically WITH its content: the holder record is written to a unique temp
 * file and hard-linked to the lock path, which fails with EEXIST if the lock exists. A lock file
 * therefore never exists without the pid that owns it, so it can always be judged dead or alive.
 */
async function tryAcquire(lockPath: string, content: string): Promise<LockSnapshot | null> {
  const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  try {
    // Snapshot BEFORE the link: the link shares this inode and mtime, so this is exactly the
    // identity our release must find at the lock path.
    const mine = await snapshot(temporary);
    await fs.link(temporary, lockPath);
    return mine;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

type Removal = "removed" | "absent" | "not-expected";

/**
 * Removes the lock file ONLY if it is still `expected`. Exclusive by construction: `rename` moves
 * whatever is at the path to a name unique to this call, so of several concurrent removers exactly
 * one gets the file. The taken file is then checked against `expected`; anything else — a fresh
 * lock a contender linked after another remover took the stale one — is handed back at once with
 * `link`, which never overwrites. Nothing is put back blindly: if the path is already occupied
 * again, the taken file is dropped (its holder's lock was gone the moment another remover took the
 * stale one; restoring over the newer lock would make it worse).
 */
async function removeIfStill(lockPath: string, expected: LockSnapshot): Promise<Removal> {
  const tombstone = `${lockPath}.${process.pid}.${randomUUID()}.removed`;
  try {
    await fs.rename(lockPath, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "absent";
    }
    throw error;
  }
  try {
    if (sameLock(await snapshot(tombstone), expected)) {
      return "removed";
    }
    await fs.link(tombstone, lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") {
        throw error;
      }
    });
    return "not-expected";
  } finally {
    await fs.rm(tombstone, { force: true });
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

/** Removes a breakable lock through `removeIfStill`, so a fresh holder's lock is never deleted. */
async function breakStaleHolder(lockPath: string): Promise<{ broken: boolean; holder: string }> {
  const current = await readHolder(lockPath);
  const reason = current ? breakReason(current) : null;
  if (!current || !reason) {
    return { broken: false, holder: current?.raw ?? "unreadable holder" };
  }
  const removal = await removeIfStill(lockPath, current.snapshot);
  if (removal === "removed") {
    warnIfUnjudged(lockPath, reason, current);
  }
  // "absent": someone else broke or released it — retry the create at once. "not-expected": a
  // fresh lock is in place and was handed back — wait for it like any live holder.
  return { broken: removal !== "not-expected", holder: current.raw };
}

/** Releases OUR lock through `removeIfStill`; a lock that is no longer ours is never deleted. */
async function release(lockPath: string, mine: LockSnapshot): Promise<void> {
  const removal = await removeIfStill(lockPath, mine);
  if (removal !== "removed") {
    process.stderr.write(
      `[acpx] WARNING: session record lock ${lockPath} was broken while this process held it ` +
        `(${removal}); another writer may have overlapped this write.\n`,
    );
  }
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
  let mine: LockSnapshot | null;
  while (!(mine = await tryAcquire(lockPath, content))) {
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
    await release(lockPath, mine);
  }
}
