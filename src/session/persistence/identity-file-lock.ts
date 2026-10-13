import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  getOwnProcessIdentity,
  isOwnProcessScopeVerified,
  classifyRecordedIdentity,
  observeProcessIncarnation,
  processHostName,
  type ProcessBirthIdentity,
  serializeProcessBirthIdentity,
} from "../../process-identity.js";
import { isProcessDefinitelyDead } from "../../process-liveness.js";

/**
 * THE lock primitive for every cross-process file lock in acpx (brick ae547131 §6.1): the session
 * record lock, `index.json.lock`, the cold archive's `ARCHIVE-INDEX/.lock`, `seats.json.lock`, and
 * the queue lease guard. Generalized from `record-file-lock.ts` (brick eb4c8d06), which already had
 * the right shape — "reuse, do not re-derive" is the house rule for these locks, so there is ONE
 * implementation and every lock is a policy over it.
 *
 * - ACQUIRE is atomic WITH its content: the body goes to a unique temp file which is hard-linked to
 *   the lock path (EEXIST ⇒ held). A lock file therefore never exists without its holder.
 * - The body carries the holder's birth identity (`processIdentity`, process-identity.ts) beside the
 *   lock's old fields, whose meaning is unchanged so pre-0a readers keep working (CONCEPT §4.3).
 * - A holder is judged by pid ONLY in the reader's own scope (boot + pid ns + time ns):
 *   `gone` ⇒ breakable now; `matching` ⇒ NEVER breakable, at any age; `unknown` (foreign, or an
 *   unverified own scope) ⇒ unjudgeable. A legacy body (no identity — pre-0a code, which CONCEPT
 *   §4.5 places in the reader's own container) is breakable on ESRCH, and otherwise unjudgeable
 *   unless the policy keeps an older, stronger rule (the record lock does).
 * - An unjudgeable holder is broken only once the lock is older than `staleMs`, with a stderr
 *   warning naming the file, holder and age. Legitimate holds are milliseconds.
 * - BREAKING is compare-and-delete on the raw content, then a retry of the atomic create — never a
 *   write without the lock.
 *
 * 🛑 THERE IS NO PROCEED-UNLOCKED PATH. A waiter whose budget runs out THROWS the policy's typed
 * timeout. The index lock's old "give up after ~2 s and write anyway" re-admitted exactly the lost
 * update a lock exists to prevent (test/session-index-lock.test.ts, the 25 s holder rows).
 */

export type LockHolderVerdict = "breakable" | "live" | "unjudgeable";

export type IdentityLockPolicy = {
  /** Human name for warnings, e.g. "session record lock". */
  label: string;
  /** How long a waiter tries before it throws. Must exceed `staleMs` so a waiter clears an orphan. */
  budgetMs: number;
  /** Age (lock-file mtime) past which an UNJUDGEABLE holder may be broken. */
  staleMs: number;
  /** The lock's pre-0a fields, written first and unchanged in meaning (CONCEPT §4.3). */
  legacyBody: () => Record<string, unknown>;
  /** Judges a LEGACY body (no identity). Default: ESRCH ⇒ breakable, otherwise unjudgeable. */
  judgeLegacy?: (body: Record<string, unknown>) => LockHolderVerdict;
  makeTimeoutError: (lockPath: string, holder: string) => Error;
};

type ReadHolder = { raw: string; ageMs: number; body: Record<string, unknown> | undefined };

const MAX_BACKOFF_MS = 50;

function parseBody(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function holderPid(body: Record<string, unknown>): number | undefined {
  const pid = body.pid;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function verdictForIncarnation(pid: number, birth: ProcessBirthIdentity): LockHolderVerdict {
  const incarnation = observeProcessIncarnation(pid, birth);
  if (incarnation === "gone") {
    return "breakable";
  }
  return incarnation === "matching" ? "live" : "unjudgeable";
}

function verdictForLegacy(
  pid: number,
  body: Record<string, unknown>,
  judgeLegacy?: (body: Record<string, unknown>) => LockHolderVerdict,
): LockHolderVerdict {
  if (!isOwnProcessScopeVerified()) {
    return "unjudgeable";
  }
  if (judgeLegacy) {
    return judgeLegacy(body);
  }
  return isProcessDefinitelyDead(pid) ? "breakable" : "unjudgeable";
}

/**
 * Judges a lock body by the rules above. Shared by every lock — including the stream lock, which
 * applies its own age rule on top (events.ts) — so "same machine" is decided in exactly one place.
 */
export function judgeLockHolder(
  body: Record<string, unknown> | undefined,
  judgeLegacy?: (body: Record<string, unknown>) => LockHolderVerdict,
): LockHolderVerdict {
  const pid = body ? holderPid(body) : undefined;
  if (!body || pid === undefined) {
    return "unjudgeable";
  }
  const recorded = classifyRecordedIdentity(body.processIdentity);
  if (recorded.kind === "birth") {
    return verdictForIncarnation(pid, recorded.birth);
  }
  if (recorded.kind === "scope-only") {
    // Scope but no start ticks: foreign ⇒ never pid-judged; our own scope ⇒ ESRCH is proof of
    // death, but a live pid cannot be proven to be the holder.
    return recorded.local && isProcessDefinitelyDead(pid) ? "breakable" : "unjudgeable";
  }
  return verdictForLegacy(pid, body, judgeLegacy);
}

/** The full 0a body: the lock's old fields, then the holder's `host` and birth identity. */
export function identityLockBody(legacyBody: Record<string, unknown>): Record<string, unknown> {
  const identity = getOwnProcessIdentity();
  return {
    ...legacyBody,
    host: processHostName(),
    ...(identity ? { processIdentity: serializeProcessBirthIdentity(identity) } : {}),
  };
}

async function lockAgeMs(lockPath: string): Promise<number> {
  try {
    return Date.now() - (await fs.stat(lockPath)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The current holder, or null ONLY when the lock file is gone (ENOENT). Any other read failure — a
 * directory squatting the path, an unreadable file — is an UNIDENTIFIED holder (raw ""), judged by
 * age like any unjudgeable one. ⚠️ Do not fold those into "gone": the caller retries the create at
 * once on null, so that would be a busy spin.
 */
async function readHolder(lockPath: string): Promise<ReadHolder | null> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    raw = "";
  }
  return { raw, ageMs: await lockAgeMs(lockPath), body: parseBody(raw) };
}

/** Creates the lock atomically WITH its content (temp file + link). False when it is held. */
export async function tryCreateLockFile(lockPath: string, content: string): Promise<boolean> {
  const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
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

/** Why this lock may be broken now, or null. */
function breakReason(current: ReadHolder, policy: IdentityLockPolicy): string | null {
  const verdict = judgeLockHolder(current.body, policy.judgeLegacy);
  if (verdict === "breakable") {
    return "holder is dead";
  }
  if (verdict === "unjudgeable" && current.ageMs > policy.staleMs) {
    return `holder cannot be judged from here (another pid namespace, legacy or unidentified), lock is ${Math.round(current.ageMs)} ms old`;
  }
  return null;
}

/** Compare-and-delete: removes the lock only if it still holds exactly `raw`. False if it did not. */
export async function removeLockIfUnchanged(lockPath: string, raw: string): Promise<boolean> {
  const again = await readHolder(lockPath);
  if (again?.raw !== raw) {
    return false;
  }
  try {
    await fs.unlink(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function breakStaleHolder(
  lockPath: string,
  policy: IdentityLockPolicy,
): Promise<{ broken: boolean; holder: string }> {
  const current = await readHolder(lockPath);
  if (!current) {
    // Released between our EEXIST and this read: retry the create at once.
    return { broken: true, holder: "released" };
  }
  const reason = breakReason(current, policy);
  if (!reason) {
    return { broken: false, holder: current.raw };
  }
  const broken = await removeLockIfUnchanged(lockPath, current.raw);
  if (broken && reason !== "holder is dead") {
    process.stderr.write(
      `[acpx] WARNING: broke stale ${policy.label} ${lockPath} (${reason}); holder ${current.raw}\n`,
    );
  }
  return { broken, holder: current.raw };
}

/** Acquires the lock or throws the policy's timeout. Returns the content written (for release). */
export async function acquireIdentityFileLock(
  lockPath: string,
  policy: IdentityLockPolicy,
): Promise<string> {
  const content = JSON.stringify(identityLockBody(policy.legacyBody()));
  const started = Date.now();
  let delay = 2 + Math.floor(Math.random() * 3);
  while (!(await tryCreateLockFile(lockPath, content))) {
    const { broken, holder } = await breakStaleHolder(lockPath, policy);
    if (broken) {
      continue;
    }
    if (Date.now() - started >= policy.budgetMs) {
      throw policy.makeTimeoutError(lockPath, holder);
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(MAX_BACKOFF_MS, delay * 2 + Math.floor(Math.random() * 3));
  }
  return content;
}

/** Releases a lock this process holds — compare-and-delete, so a successor's lock survives. */
export async function releaseIdentityFileLock(lockPath: string, content: string): Promise<void> {
  await removeLockIfUnchanged(lockPath, content).catch(() => {
    // best effort: a stale takeover may already have replaced it
  });
}

export async function withIdentityFileLock<T>(
  lockPath: string,
  policy: IdentityLockPolicy,
  action: () => Promise<T>,
): Promise<T> {
  const content = await acquireIdentityFileLock(lockPath, policy);
  try {
    return await action();
  } finally {
    await releaseIdentityFileLock(lockPath, content);
  }
}
