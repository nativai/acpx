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
 * Breaking a stale lock is ACQUIRING it (exclusive removal, then the atomic create), never
 * writing without it.
 *
 * 🛑 FENCED, BECAUSE A REMOVAL CAN TAKE THE WRONG FILE. Several waiters judge one dead holder at once;
 * one removes it, a contender links a fresh lock, and a second remover — whose judgement predates
 * that — takes the FRESH lock (te-A attack E). No removal scheme on a path can rule that out, and
 * putting a taken lock back is worse: the hand-back can re-create a lock its holder already
 * released, a phantom naming a live pid that nothing may break (te-A F2, brick eb4c8d06). So:
 *  - every acquisition writes a unique `nonce` into its lock;
 *  - every removal (stale break and release) `rename`s the lock to a private tombstone, which is
 *    atomic, and deletes it. A breaker that finds it took a lock other than the one it judged puts
 *    NOTHING back — it re-judges from scratch; a release only ever starts on a lock carrying its own
 *    nonce;
 *  - the HOLDER is fenced: `fence()` re-reads the lock SYNCHRONOUSLY immediately before the
 *    record's commit rename and throws unless the lock still carries the holder's nonce. The caller
 *    issues the commit rename synchronously right after it, so no event-loop turn separates them. `withRecordFileLock` then
 *    re-runs the whole attempt — acquire, fresh read, merge, commit — so a holder whose lock was
 *    taken never commits on a stale read.
 * The window left is the holder's own fence-read -> commit-rename: two back-to-back syscalls
 * (measured with an awaited fence + awaited rename: p99 9 ms, max 59 ms at load1 19 — which is why
 * both are synchronous; see the fence-window probe in brick eb4c8d06 verification/probes).
 */

const RECORD_LOCK_BUDGET_MS = 20_000;
const RECORD_LOCK_STALE_MS = 15_000;
const RECORD_LOCK_CAP_MS = 50;

type LockHolder = {
  pid: number;
  start: string | null;
  host: string | null;
  boot: string | null;
  nonce: string | null;
};

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
        nonce: parsed.nonce ?? null,
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

/** Reads the nonce currently at the lock path, or null. */
async function nonceAt(lockPath: string): Promise<string | null> {
  try {
    return parseHolder(await fs.readFile(lockPath, "utf8")).nonce ?? null;
  } catch {
    return null;
  }
}

/**
 * Takes whatever lock file is at the path — atomically, so of several concurrent removers exactly
 * one gets it — deletes it, and returns its content (null if the path was already empty). Never
 * puts anything back: a caller that took the wrong lock must re-judge, and a holder that lost its
 * lock is caught by its fence.
 */
async function takeLock(lockPath: string): Promise<string | null> {
  const tombstone = `${lockPath}.${process.pid}.${randomUUID()}.removed`;
  try {
    await fs.rename(lockPath, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    return await fs.readFile(tombstone, "utf8");
  } finally {
    await fs.rm(tombstone, { force: true });
  }
}

/** The lock at the path if it may be broken now, re-checked once so a just-replaced lock is skipped. */
async function judgeBreakable(
  lockPath: string,
): Promise<{ current: ReadHolder | null; reason: string | null; changed: boolean }> {
  const current = await readHolder(lockPath);
  const reason = current ? breakReason(current) : null;
  if (!current || !reason) {
    return { current, reason: null, changed: false };
  }
  const again = await readHolder(lockPath);
  return { current, reason, changed: again?.raw !== current.raw };
}

/** Removes a breakable lock. Returns retry=true when the lock path should be re-tried at once. */
async function breakStaleHolder(lockPath: string): Promise<{ retry: boolean; holder: string }> {
  const { current, reason, changed } = await judgeBreakable(lockPath);
  const holder = current?.raw ?? "unreadable holder";
  if (!current || !reason || changed) {
    return { retry: changed, holder };
  }
  if ((await takeLock(lockPath)) === current.raw) {
    warnIfUnjudged(lockPath, reason, current);
  }
  // Taken the judged lock, found the path empty, or took a fresh lock by mistake: in every case
  // nothing is put back, and the loop re-judges from scratch.
  return { retry: true, holder };
}

class RecordLockFenceLost extends Error {}

function nonceAtSync(lockPath: string): string | null {
  try {
    return parseHolder(readFileSync(lockPath, "utf8")).nonce ?? null;
  } catch {
    return null;
  }
}

/** Releases our lock: only a lock carrying our nonce is ever taken. */
async function release(lockPath: string, nonce: string): Promise<void> {
  if ((await nonceAt(lockPath)) !== nonce) {
    return;
  }
  const taken = await takeLock(lockPath);
  if (taken !== null && parseHolder(taken).nonce !== nonce) {
    // Our lock was replaced in the read -> rename instant; the lock we took belongs to a holder
    // whose fence will now refuse its commit and retry. Nothing is put back.
    process.stderr.write(`[acpx] WARNING: released a foreign session record lock ${lockPath}\n`);
  }
}

async function acquire(lockPath: string, content: string, started: number): Promise<void> {
  let delay = 2 + Math.floor(Math.random() * 3);
  while (!(await tryAcquire(lockPath, content))) {
    const { retry, holder } = await breakStaleHolder(lockPath);
    if (retry) {
      continue;
    }
    if (Date.now() - started >= RECORD_LOCK_BUDGET_MS) {
      throw new RecordLockTimeoutError(lockPath, holder);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(RECORD_LOCK_CAP_MS, delay * 2 + Math.floor(Math.random() * 3));
  }
}

/**
 * Runs `action` holding the record's lock. `action` MUST call `fence()` — synchronous — and then
 * its commit (the record's temp -> rename) SYNCHRONOUSLY with nothing awaited in between, and must
 * be safe to re-run from scratch: when the fence finds the lock no longer ours, the whole attempt —
 * acquire, read, merge, commit — runs again.
 */
export async function withRecordFileLock<T>(
  recordFile: string,
  action: (fence: () => void) => Promise<T>,
): Promise<T> {
  const lockPath = `${recordFile}.lock`;
  const started = Date.now();
  for (;;) {
    const nonce = randomUUID();
    const content = JSON.stringify({
      pid: process.pid,
      start: processStartTime(process.pid),
      host: LOCAL_HOST,
      boot: LOCAL_BOOT,
      nonce,
    });
    await acquire(lockPath, content, started);
    const fence = (): void => {
      if (nonceAtSync(lockPath) !== nonce) {
        throw new RecordLockFenceLost();
      }
    };
    try {
      return await action(fence);
    } catch (error) {
      if (!(error instanceof RecordLockFenceLost)) {
        throw error;
      }
      // Our lock was taken while we held it; nothing was committed. Start over.
    } finally {
      await release(lockPath, nonce);
    }
  }
}
