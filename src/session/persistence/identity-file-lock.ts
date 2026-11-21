import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { proveDeath, DEATH_PROOF_TIMEOUT_MS, type DeathProof } from "../../pod/death-proof.js";
import {
  lockPodIdentity,
  ownPodIdentity,
  parsePodRef,
  type PodIdentity,
  type PodRef,
} from "../../pod/identity.js";
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
 * record lock, `index.json.lock`, the cold archive's `ARCHIVE-INDEX/.lock`, `seats.json.lock`, the
 * queue lease guard and the fork-source stage lock. Generalized from `record-file-lock.ts` (brick
 * eb4c8d06), which already had the right shape — "reuse, do not re-derive" is the house rule for
 * these locks, so there is ONE implementation and every lock is a policy over it.
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
 * ACROSS PODS (C3.2, brick 8d85cb47). In pod mode the body also names the holder's POD. Judging:
 *
 *   | holder is…                               | judged by                  | broken when                 |
 *   | in the reader's own pod (same pod uid)   | pid, as above              | as above                    |
 *   | in another pod — on ANY machine          | never pid, NEVER AGE       | the death proof says `gone` |
 *   | without a `pod` field                    | the rules above, unchanged | the rules above             |
 *
 * A body WITH a `pod` field is broken by TOMBSTONE, one winner (`breakByTombstone`); a body without
 * one keeps today's compare-and-delete byte for byte (program HoD, 2026-11-21: a control pod without
 * `NV_POD_*` must behave exactly as today — `test/pod-lock-no-pod.test.ts`).
 * ⚠️ DO NOT "UNIFY" THE FOREIGN ROW WITH THE AGE RULE. The spike measured what age does to a live
 * holder in another pod: broken after 10 s while alive and holding, two writers believing they hold
 * the lock (SPIKE-REPORT §(d)). `test/pod-lock-primitive.test.ts` "NG-K7.2a" pins it.
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
  /** Age (lock-file mtime) past which an UNJUDGEABLE holder may be broken. Never a foreign pod's. */
  staleMs: number;
  /** Longest pause between two attempts (default 50 ms). Long-held locks poll less. */
  pollMaxMs?: number;
  /** The lock's pre-0a fields, written first and unchanged in meaning (CONCEPT §4.3). */
  legacyBody: () => Record<string, unknown>;
  /** Judges a LEGACY body (no identity). Default: ESRCH ⇒ breakable, otherwise unjudgeable. */
  judgeLegacy?: (body: Record<string, unknown>) => LockHolderVerdict;
  makeTimeoutError: (lockPath: string, holder: string) => Error;
};

type ReadHolder = { raw: string; ageMs: number; body: Record<string, unknown> | undefined };

const MAX_BACKOFF_MS = 50;
/** A waiter asks the death proof about one judged body at most this often. */
const DEATH_PROOF_RETRY_MS = 1_000;
/**
 * A tombstone older than this (by ctime — the moment it was linked) WHOSE LOCK IS GONE (C3.2) is
 * removed by whoever sees it. "Gone" = the lock path is absent or names another file.
 * 🛑 A TOMBSTONE THAT IS STILL THE LOCK'S OWN FILE IS NEVER REMOVED BY AGE (program HoD ruling
 * 2026-11-21, referred to the architect). It means a breaker stopped between `link` and
 * `unlink(lock)` — and a breaker in a FROZEN pod (state-server stall, 60 s) is alive, not dead: its
 * already-decided `unlink(lock)` could land after a new holder took the lock and silently delete a
 * live lock. So that wedge stays, and every waiter reports it by name after its budget
 * (`describeWedge`). ⚠️ DO NOT "FIX" THE WEDGE BY AGE — `test/pod-lock-primitive.test.ts` "wedge".
 */
export const TOMBSTONE_STALE_MS = 60_000;
/** Linux `ESTALE` (116): an NFS file handle whose file another client removed. */
const ESTALE_ERRNO = os.constants.errno.ESTALE ?? 116;
const TOMBSTONE_PATTERN = /\.tomb\.[0-9a-f]{16}$/;

/** Everything the cross-pod rules read from outside. Swappable ONLY by tests. */
type PodLockDeps = {
  /** This process's pod, for "same pod?" (raw read — any mode). */
  ownPod: () => PodIdentity | undefined;
  /** The pod a NEW body names (pod mode only). */
  lockPod: () => PodIdentity | undefined;
  proveDeath: (pod: PodRef, timeoutMs: number) => Promise<DeathProof>;
  nowMs: () => number;
  /** Runs right after a breaker's `link(lock, tomb)` — a test's stand-in for a stalled breaker. */
  afterTombstoneLinked: () => Promise<void>;
};

const realDeps: PodLockDeps = {
  ownPod: () => ownPodIdentity(),
  lockPod: () => lockPodIdentity(),
  proveDeath: (pod, timeoutMs) => proveDeath(pod, { timeoutMs }),
  nowMs: () => Date.now(),
  afterTombstoneLinked: async () => {},
};
let deps: PodLockDeps = realDeps;

/** A SEAM, NOT API (precedent `setProcReaderForTests`). `undefined` restores the real ones. */
export function setPodLockDepsForTests(overrides: Partial<PodLockDeps> | undefined): void {
  deps = overrides ? { ...realDeps, ...overrides } : realDeps;
}

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

/** Today's pid rules — for a body without `pod`, and for a holder in the reader's own pod. */
function judgeByPid(
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

/** Where a body's holder lives relative to this reader (C3.2's three rows). */
type HolderPlace =
  | { kind: "no-pod" }
  | { kind: "same-pod"; pod: PodRef }
  | { kind: "foreign"; pod: PodRef | undefined };

function holderPlace(body: Record<string, unknown> | undefined): HolderPlace {
  if (!body || !Object.hasOwn(body, "pod")) {
    return { kind: "no-pod" };
  }
  const pod = parsePodRef(body.pod);
  const own = deps.ownPod();
  if (pod && own && own.uid === pod.uid) {
    return { kind: "same-pod", pod };
  }
  // A malformed `pod` field is still a pod field: foreign, and never provably gone.
  return { kind: "foreign", pod };
}

/**
 * Judges a lock body SYNCHRONOUSLY. Shared by every lock — including the stream lock, which applies
 * its own age rule on top (events.ts) — so "same machine" is decided in exactly one place. A holder
 * in another pod cannot be judged without the death proof (async), so it is `unjudgeable` here; the
 * primitive itself never age-breaks it (`planBreak`).
 */
export function judgeLockHolder(
  body: Record<string, unknown> | undefined,
  judgeLegacy?: (body: Record<string, unknown>) => LockHolderVerdict,
): LockHolderVerdict {
  return holderPlace(body).kind === "foreign" ? "unjudgeable" : judgeByPid(body, judgeLegacy);
}

/**
 * The full body: the lock's old fields, then the holder's `host` and birth identity — and in pod
 * mode its `pod` plus a random `token`, so no two acquisitions ever write the same bytes (the
 * tombstone name is a hash of the judged body). Without a pod the body is exactly today's.
 */
export function identityLockBody(legacyBody: Record<string, unknown>): Record<string, unknown> {
  const identity = getOwnProcessIdentity();
  // C3.2 amendment (pending record): `pod` carries `node` and `namespace` beside `name` and `uid` —
  // C3.3's "gone" needs the holder's node once its pod has left the API — and the body a `token`.
  const pod = deps.lockPod();
  return {
    ...legacyBody,
    host: processHostName(),
    ...(identity ? { processIdentity: serializeProcessBirthIdentity(identity) } : {}),
    ...(pod ? { pod, token: randomUUID() } : {}),
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
 * The file is gone — `ENOENT`, or on NFS `ESTALE`: another client unlinked it while this one still
 * held its file handle (measured across the control pod and a workbench, brick 8d85cb47: `link`
 * failed with errno 116 in 2 of 10 cross-machine race rounds, and the breaker crashed). Both mean
 * "the lock changed under us": retry.
 */
function isGoneError(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as NodeJS.ErrnoException;
  // ⚠️ MATCH ESTALE BY ERRNO, NOT BY `code`: libuv has no name for it, so Node reports
  // `code: "Unknown system error -116"` (measured) — a `code === "ESTALE"` check never fires.
  return code === "ENOENT" || code === "ESTALE" || errno === -ESTALE_ERRNO;
}

/**
 * The current holder, or null ONLY when the lock file is gone (ENOENT / ESTALE). Any other read failure — a
 * directory squatting the path, an unreadable file — is an UNIDENTIFIED holder (raw ""), judged by
 * age like any unjudgeable one. ⚠️ Do not fold those into "gone": the caller retries the create at
 * once on null, so that would be a busy spin.
 */
async function readHolder(lockPath: string): Promise<ReadHolder | null> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (isGoneError(error)) {
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

/** Today's reason to break a pid-judged holder, or null. */
function pidBreakReason(current: ReadHolder, policy: IdentityLockPolicy): string | null {
  const verdict = judgeByPid(current.body, policy.judgeLegacy);
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

/** `<lock>.tomb.<first 16 hex of SHA-256 of the judged body>` (C3.2). */
export function tombstonePath(lockPath: string, judgedRaw: string): string {
  const digest = createHash("sha256").update(judgedRaw, "utf8").digest("hex").slice(0, 16);
  return `${lockPath}.tomb.${digest}`;
}

async function unlinkQuietly(file: string): Promise<void> {
  await fs.unlink(file).catch(() => {});
}

async function statOrUndefined(file: string) {
  try {
    return await fs.stat(file);
  } catch {
    return undefined;
  }
}

/** Two stats name the same file (same device and inode). */
function sameFile(
  a: { ino: number; dev: number } | undefined,
  b: { ino: number; dev: number } | undefined,
) {
  return !!a && !!b && a.ino === b.ino && a.dev === b.dev;
}

/** `<lock>` for `<lock>.tomb.<hex>`. */
function lockOfTombstone(tomb: string): string {
  return tomb.replace(TOMBSTONE_PATTERN, "");
}

/** Removes `tomb` when it is older than TOMBSTONE_STALE_MS AND its lock is gone. True when removed. */
async function removeTombstoneIfStale(tomb: string): Promise<boolean> {
  const stat = await statOrUndefined(tomb);
  if (!stat || deps.nowMs() - stat.ctimeMs <= TOMBSTONE_STALE_MS) {
    return false;
  }
  if (sameFile(stat, await statOrUndefined(lockOfTombstone(tomb)))) {
    return false; // still the lock's own file: a wedge, never removed by age (see TOMBSTONE_STALE_MS)
  }
  await unlinkQuietly(tomb);
  return true;
}

/**
 * When the lock is held by a tombstone of its own judged body that is still the lock's own file —
 * a breaker stopped between `link` and `unlink(lock)` — the wedge in words, for the timeout.
 */
async function describeWedge(lockPath: string, holderRaw: string): Promise<string | null> {
  const tomb = tombstonePath(lockPath, holderRaw);
  const [tombStat, lockStat] = await Promise.all([
    statOrUndefined(tomb),
    statOrUndefined(lockPath),
  ]);
  if (!tombStat || !sameFile(tombStat, lockStat)) {
    return null;
  }
  const ageMs = Math.round(deps.nowMs() - tombStat.ctimeMs);
  return (
    `WEDGED: lock ${lockPath} is held open by tombstone ${tomb} (age ${ageMs} ms) — a breaker ` +
    `stopped between link and unlink; it is never removed by age, remove it by hand once that ` +
    `breaker is known dead`
  );
}

/**
 * C3.2's one-winner break. `link(lock, tomb)` succeeds for exactly one breaker of a given judged
 * body; the others get EEXIST and only retry their acquire. The winner checks the tombstone holds
 * the judged body (else: unlink the tombstone, stop), then RE-CHECKS that the lock path still names
 * the tombstone's own file before unlinking it — C3.2 amendment (pending record) — so a breaker can
 * never delete a lock that a faster breaker already replaced with a fresh one.
 */
export async function breakByTombstone(
  lockPath: string,
  judgedRaw: string,
): Promise<"broken" | "busy" | "changed"> {
  const tomb = tombstonePath(lockPath, judgedRaw);
  try {
    await fs.link(lockPath, tomb);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      await removeTombstoneIfStale(tomb);
      return "busy";
    }
    if (isGoneError(error)) {
      return "changed";
    }
    throw error;
  }
  await deps.afterTombstoneLinked();
  const linked = await fs.readFile(tomb, "utf8").catch(() => undefined);
  if (linked !== judgedRaw) {
    await unlinkQuietly(tomb);
    return "changed";
  }
  // C3.2 amendment (pending record): the re-check before the unlink.
  const [lockStat, tombStat] = await Promise.all([
    statOrUndefined(lockPath),
    statOrUndefined(tomb),
  ]);
  if (!sameFile(lockStat, tombStat)) {
    await unlinkQuietly(tomb);
    return "changed";
  }
  await unlinkQuietly(lockPath);
  await unlinkQuietly(tomb);
  return "broken";
}

type BreakPlan =
  | { kind: "none" }
  | { kind: "compare-and-delete"; reason: string }
  | { kind: "tombstone"; reason: string; notice: string | null };

/** The death-proof answer about one judged body, asked at most once per DEATH_PROOF_RETRY_MS. */
type ProofMemo = { raw?: string; at?: number; answer?: DeathProof };

function describePod(pod: PodRef | undefined): string {
  return pod ? `${pod.name} (uid ${pod.uid}${pod.node ? `, node ${pod.node}` : ""})` : "unknown";
}

async function foreignProof(
  current: ReadHolder,
  pod: PodRef,
  memo: ProofMemo,
  remainingMs: number,
): Promise<DeathProof> {
  const now = deps.nowMs();
  if (memo.raw === current.raw && memo.at !== undefined && now - memo.at < DEATH_PROOF_RETRY_MS) {
    return memo.answer ?? "unknown";
  }
  const timeoutMs = Math.max(1, Math.min(DEATH_PROOF_TIMEOUT_MS, remainingMs));
  const answer = await deps.proveDeath(pod, timeoutMs).catch((): DeathProof => "unknown");
  Object.assign(memo, { raw: current.raw, at: deps.nowMs(), answer });
  return answer;
}

async function planBreak(
  current: ReadHolder,
  policy: IdentityLockPolicy,
  memo: ProofMemo,
  remainingMs: number,
): Promise<BreakPlan> {
  const place = holderPlace(current.body);
  if (place.kind === "no-pod") {
    const reason = pidBreakReason(current, policy);
    return reason ? { kind: "compare-and-delete", reason } : { kind: "none" };
  }
  if (place.kind === "same-pod") {
    const reason = pidBreakReason(current, policy);
    return reason ? { kind: "tombstone", reason, notice: null } : { kind: "none" };
  }
  // Another pod, any machine: never by pid, never by age — only on proof that its pod is gone.
  if (!place.pod || (await foreignProof(current, place.pod, memo, remainingMs)) !== "gone") {
    return { kind: "none" };
  }
  const own = deps.ownPod();
  const notice =
    `holder pod ${describePod(place.pod)} proven gone by the API server (C3.3); ` +
    `breaker pod ${describePod(own)} pid ${process.pid}`;
  return { kind: "tombstone", reason: "holder pod is gone", notice };
}

function warnBreak(policy: IdentityLockPolicy, lockPath: string, reason: string, raw: string) {
  process.stderr.write(
    `[acpx] WARNING: broke stale ${policy.label} ${lockPath} (${reason}); holder ${raw}\n`,
  );
}

async function breakHolder(
  lockPath: string,
  policy: IdentityLockPolicy,
  memo: ProofMemo,
  remainingMs: number,
): Promise<{ broken: boolean; tookOver: boolean; holder: string }> {
  const current = await readHolder(lockPath);
  if (!current) {
    // Released between our EEXIST and this read: retry the create at once.
    return { broken: true, tookOver: false, holder: "released" };
  }
  const plan = await planBreak(current, policy, memo, remainingMs);
  if (plan.kind === "none") {
    return { broken: false, tookOver: false, holder: current.raw };
  }
  const broken = await executeBreak(lockPath, policy, plan, current.raw);
  return { broken, tookOver: broken, holder: current.raw };
}

/** Carries out a decided break: compare-and-delete for a body without `pod`, else the tombstone. */
async function executeBreak(
  lockPath: string,
  policy: IdentityLockPolicy,
  plan: Exclude<BreakPlan, { kind: "none" }>,
  raw: string,
): Promise<boolean> {
  const broken =
    plan.kind === "compare-and-delete"
      ? await removeLockIfUnchanged(lockPath, raw)
      : (await breakByTombstone(lockPath, raw)) === "broken";
  const notice = plan.kind === "tombstone" ? plan.notice : null;
  if (broken && notice) {
    process.stderr.write(`[acpx] broke ${policy.label} ${lockPath}: ${notice}; holder ${raw}\n`);
  } else if (broken && plan.reason !== "holder is dead") {
    warnBreak(policy, lockPath, plan.reason, raw);
  }
  return broken;
}

export type AcquiredLock = { content: string; tookOver: boolean };

/** Acquires the lock or throws the policy's timeout; also says whether a holder was broken. */
export async function acquireIdentityFileLockDetailed(
  lockPath: string,
  policy: IdentityLockPolicy,
): Promise<AcquiredLock> {
  const content = JSON.stringify(identityLockBody(policy.legacyBody()));
  const started = Date.now();
  const maxBackoff = policy.pollMaxMs ?? MAX_BACKOFF_MS;
  let delay = Math.min(maxBackoff, 2 + Math.floor(Math.random() * 3));
  let tookOver = false;
  const memo: ProofMemo = {};
  while (!(await tryCreateLockFile(lockPath, content))) {
    const remainingMs = policy.budgetMs - (Date.now() - started);
    const outcome = await breakHolder(lockPath, policy, memo, remainingMs);
    tookOver ||= outcome.tookOver;
    if (outcome.broken) {
      continue;
    }
    if (Date.now() - started >= policy.budgetMs) {
      const wedge = await describeWedge(lockPath, outcome.holder);
      throw policy.makeTimeoutError(
        lockPath,
        wedge ? `${outcome.holder} — ${wedge}` : outcome.holder,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(maxBackoff, delay * 2 + Math.floor(Math.random() * 3));
  }
  return { content, tookOver };
}

/** Acquires the lock or throws the policy's timeout. Returns the content written (for release). */
export async function acquireIdentityFileLock(
  lockPath: string,
  policy: IdentityLockPolicy,
): Promise<string> {
  return (await acquireIdentityFileLockDetailed(lockPath, policy)).content;
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

/**
 * The file names the sweep treats as locks of this primitive. ⚠️ NOT a bare `.lock`: the queue
 * LEASE is `queues/<key>.lock` — a different file with its own rules, removed only under its guard
 * (C3.1). Sweeping it here would delete a lease behind the lease store's back.
 */
const SWEPT_LOCK_SUFFIXES = [".json.lock", ".lock.guard", ".acpx-stage.lock"];

export type PodLockSweepResult = { removed: string[]; tombstonesRemoved: string[] };

/**
 * C3.2 "each pod removes the locks of its own dead processes, with local proof, every 5 s" — one
 * pass. Removes a lock only when its body names THIS pod and its pid is proven dead in this pid
 * namespace; removal is the tombstone break. Also removes tombstones older than TOMBSTONE_STALE_MS.
 * Callers: the atrium server every 5 s on the control pod (EXPORT-lock-module.md), the agent pod's
 * idle loop through `acpx __pod-lock-sweep`. With no own pod identity it removes no lock.
 */
export async function sweepOwnPodLocks(options: { dirs: string[] }): Promise<PodLockSweepResult> {
  const result: PodLockSweepResult = { removed: [], tombstonesRemoved: [] };
  const own = deps.ownPod();
  for (const dir of options.dirs) {
    const names = await fs.readdir(dir).catch((): string[] => []);
    for (const name of names) {
      const file = path.join(dir, name);
      if (TOMBSTONE_PATTERN.test(name)) {
        if (await removeTombstoneIfStale(file)) {
          result.tombstonesRemoved.push(file);
        }
        continue;
      }
      if (own && SWEPT_LOCK_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
        if (await removeOwnDeadLock(file, own)) {
          result.removed.push(file);
        }
      }
    }
  }
  return result;
}

async function removeOwnDeadLock(lockPath: string, own: PodIdentity): Promise<boolean> {
  const current = await readHolder(lockPath);
  if (!current?.body || parsePodRef(current.body.pod)?.uid !== own.uid) {
    return false;
  }
  if (judgeByPid(current.body) !== "breakable") {
    return false;
  }
  return (await breakByTombstone(lockPath, current.raw)) === "broken";
}
