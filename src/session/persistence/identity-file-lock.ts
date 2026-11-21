import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  DEATH_PROOF_TIMEOUT_MS,
  proveDeathDetailed,
  type DeathProofDetail,
} from "../../pod/death-proof.js";
import {
  lockHostPlace,
  lockPodIdentity,
  ownPodIdentity,
  parsePodRef,
  podModeRequested,
  podTestHome,
  type LockHostPlace,
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
 * - An unjudgeable holder WITHOUT `pod` is broken only once the lock is older than `staleMs`, with
 *   a stderr warning naming the file, holder and age. Legitimate holds are milliseconds.
 *
 * ACROSS PODS (C3.2 as amended by A-3/A-4, brick 8d85cb47). A process that knows its pod writes
 * `pod` (name, uid, node, namespace) and a random `token` into every body. Judging and breaking:
 *
 *   | holder is…                  | judged by            | broken when — and by whom                         |
 *   | in the reader's own pod     | pid and start time   | the process is gone — by any process of that pod  |
 *   | in another pod, any machine | never pid, NEVER AGE | its pod is gone (C3.3) — ONLY by the CONTROL POD   |
 *   | without a `pod` field       | control pod / elsewhere: today's rules · an AGENT POD: never judged/broken |
 *
 * HOW A LOCK IS BROKEN: proof first; then, inside this pod's BREAK MUTEX (a kernel-released abstract
 * socket, `withBreakMutex`), the lock is read again by open-and-read and unlinked only if it still
 * carries the judged `token`; then one line goes to the break ledger. Nothing is left behind — no
 * tombstone, no marker (the first cut's tombstone is withdrawn, A-4). And the HOLDER checks its own
 * token immediately before it publishes (`assertLockHeld`; `updateRecordFile` in record-file-lock.ts).
 *
 * ⚠️ DO NOT LET AN AGENT POD BREAK A FOREIGN HOLDER, EVEN ONE WHOSE POD IS GONE, AND DO NOT GIVE THE
 * FOREIGN ROW AN AGE RULE. Only one place may break a given lock — that is what makes the token
 * re-read sufficient without a tombstone. The spike measured what age does to a live holder in
 * another pod: broken after 10 s while alive and holding (SPIKE-REPORT §(d)).
 * `test/pod-lock-primitive.test.ts` pins every "never" here.
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
  /** Age (lock-file mtime) past which an UNJUDGEABLE holder WITHOUT `pod` may be broken. */
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

/** C1.1 A-5: in pod mode the module throws rather than write a body without `pod`. */
export const POD_IDENTITY_MISSING_CODE = "pod_identity_missing";
export class PodIdentityMissingError extends Error {
  readonly code = POD_IDENTITY_MISSING_CODE;
  constructor() {
    super(
      "acpx: REFUSED reason=pod_identity_missing — pod mode is on but this process cannot name its " +
        "pod (NV_POD_NAME, NV_POD_UID, NV_NODE_NAME, service-account namespace); no lock is written " +
        "without `pod` (C1.1 A-5)",
    );
  }
}

/** The holder found its lock no longer carries its own token: it must not publish (C3.2 A-4). */
export const LOCK_LOST_CODE = "lock-lost";
export class LockLostError extends Error {
  readonly code: string = LOCK_LOST_CODE;
  constructor(lockPath: string, found: string) {
    super(
      `lock ${lockPath} no longer carries this holder's token (now: ${found || "absent"}); not publishing`,
    );
  }
}

/** Everything the cross-pod rules read from outside. Swappable ONLY by tests. */
type PodLockDeps = {
  /** This process's pod (same pod? the mutex name, the ledger file). */
  ownPod: () => PodIdentity | undefined;
  /** The pod a NEW body names. */
  lockPod: () => PodIdentity | undefined;
  /** Pod mode requested without identity ⇒ refuse (C1.1 A-5). */
  podModeRequested: () => boolean;
  place: () => LockHostPlace;
  proveDeath: (pod: PodRef, timeoutMs: number) => Promise<DeathProofDetail>;
  nowMs: () => number;
  /** Runs inside the break mutex, after the proof and before the re-read — a test's stall point. */
  insideBreakMutex: () => Promise<void>;
  /** Runs after the re-read matched the judged token, right before `unlink` — the F2 stall point. */
  beforeUnlink: () => Promise<void>;
};

const realDeps: PodLockDeps = {
  ownPod: () => ownPodIdentity(),
  lockPod: () => lockPodIdentity(),
  podModeRequested: () => podModeRequested(),
  place: () => lockHostPlace(),
  proveDeath: (pod, timeoutMs) => proveDeathDetailed(pod, { timeoutMs }),
  nowMs: () => Date.now(),
  insideBreakMutex: async () => {},
  beforeUnlink: async () => {},
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

function bodyToken(body: Record<string, unknown> | undefined): string | undefined {
  return typeof body?.token === "string" && body.token !== "" ? body.token : undefined;
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
 * in another pod cannot be judged without the death proof (async, control pod only), so it is
 * `unjudgeable` here; the primitive itself never age-breaks it (`planBreak`).
 */
export function judgeLockHolder(
  body: Record<string, unknown> | undefined,
  judgeLegacy?: (body: Record<string, unknown>) => LockHolderVerdict,
): LockHolderVerdict {
  return holderPlace(body).kind === "foreign" ? "unjudgeable" : judgeByPid(body, judgeLegacy);
}

/**
 * The full body: the lock's old fields, then the holder's `host` and birth identity — and, when this
 * process knows its pod, `pod` plus a random `token` (C3.2 A-3), so no two acquisitions ever write
 * the same bytes. Without a pod the body is exactly today's — except in pod mode, where it throws.
 */
export function identityLockBody(legacyBody: Record<string, unknown>): Record<string, unknown> {
  const identity = getOwnProcessIdentity();
  const pod = deps.lockPod();
  // C1.1 A-5, sharpened (HoD ruling P1, test-engineer 0b53d599): in pod mode — AND whenever the place
  // file says this is an agent pod, whatever the switch and whatever env is missing — a writer
  // without a complete identity refuses and holds nothing. Otherwise a scrubbed env (`env -i`, a
  // login shell, a missing SA mount) writes a body WITHOUT `pod`, and the control pod takes that
  // LIVE holder over in milliseconds by today's rule (a different boot ⇒ "gone").
  if (!pod && (deps.podModeRequested() || deps.place() === "agent-pod")) {
    throw new PodIdentityMissingError();
  }
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
 * held its file handle (measured across the control pod and a workbench, brick 8d85cb47).
 * ⚠️ MATCH ESTALE BY ERRNO, NOT BY `code`: libuv has no name for it, so Node reports
 * `code: "Unknown system error -116"` (measured) — a `code === "ESTALE"` check never fires.
 */
const ESTALE_ERRNO = os.constants.errno.ESTALE ?? 116;
function isGoneError(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as NodeJS.ErrnoException;
  return code === "ENOENT" || code === "ESTALE" || errno === -ESTALE_ERRNO;
}

/**
 * The current holder, or null ONLY when the lock file is gone (ENOENT / ESTALE). Any other read
 * failure — a directory squatting the path, an unreadable file — is an UNIDENTIFIED holder (raw ""),
 * judged by age like any unjudgeable one. ⚠️ Do not fold those into "gone": the caller retries the
 * create at once on null, so that would be a busy spin.
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

// ---------------------------------------------------------------------------------------------
// The break mutex (C3.2 A-4): ONE per pod, not on the shared volume, released by the kernel when
// its holder dies — the bind of an abstract-namespace socket. An abstract socket is already scoped
// to its network namespace, which IS the pod, so in production the name is ONE FIXED STRING.
// ⚠️ DO NOT PUT THE POD UID, THE HOSTNAME OR ANYTHING FROM THE ENVIRONMENT INTO THE PRODUCTION NAME.
// It looks like harmless disambiguation and it is the F2 bug (test-engineer, 175aa1cc): a control-pod
// process with `NV_POD_*` and one without bound two different names, so they never serialized; a
// breaker stalled between its re-read and its unlink then deleted the fresh lock the other had just
// taken — two holders of one lock. `test/pod-lock-primitive.test.ts` "F2" rows pin it.
// Only under the explicit test-pod seam (`ACPX_POD_TEST_HOME`, honoured under `node --test` only) is
// the uid appended, so two test "pods" that share one network namespace stay apart
// (test/pod-kit/two-pods.ts).
// ---------------------------------------------------------------------------------------------

export const BREAK_MUTEX_NAME = "\0acpx-lock-break";

/**
 * The break mutex's socket name for this process (see above). ⚠️ THE SUFFIX COMES ONLY FROM THE
 * EXPLICIT TEST-POD SEAM (`ACPX_POD_TEST_HOME`, itself honoured only under a truthy
 * `NODE_TEST_CONTEXT`) — NEVER from `NODE_TEST_CONTEXT` ALONE (test-engineer H1): a leaked
 * `NODE_TEST_CONTEXT=" "`, `"0"`, `"false"` or `"child"` in ONE process of a pod would otherwise split
 * it from the rest and bring F2 back. `test/pod-lock-primitive.test.ts` "H1" pins it.
 */
export function breakMutexNameFor(env: NodeJS.ProcessEnv, own: PodIdentity | undefined): string {
  if (podTestHome(env) === undefined) {
    return BREAK_MUTEX_NAME;
  }
  return `${BREAK_MUTEX_NAME}.${own ? own.uid : "no-identity"}`;
}

function tryBind(name: string): Promise<net.Server | "busy" | "unavailable"> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "EADDRINUSE" ? "busy" : "unavailable"),
    );
    server.listen({ path: name, exclusive: true }, () => {
      server.unref();
      resolve(server);
    });
  });
}

let mutexUnavailableWarned = false;

function warnMutexUnavailable(): void {
  if (!mutexUnavailableWarned) {
    mutexUnavailableWarned = true;
    process.stderr.write("[acpx] WARNING: lock break mutex unavailable; breaking without it\n");
  }
}

/**
 * Runs `fn` holding this pod's break mutex; undefined when it could not be had within `waitMs`.
 * Off Linux (no abstract sockets) or where the bind is refused for another reason, it runs `fn`
 * alone — the in-pod break is then as racy as before this block, never wedged.
 */
export async function withBreakMutex<T>(
  waitMs: number,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (process.platform !== "linux") {
    return await fn();
  }
  const name = breakMutexNameFor(process.env, deps.ownPod());
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const bound = await tryBind(name);
    if (bound === "unavailable") {
      warnMutexUnavailable();
      return await fn();
    }
    if (bound !== "busy") {
      try {
        return await fn();
      } finally {
        await new Promise<void>((resolve) => bound.close(() => resolve()));
      }
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 2 + Math.floor(Math.random() * 4)));
  }
}

// ---------------------------------------------------------------------------------------------
// Judging and breaking
// ---------------------------------------------------------------------------------------------

export type BreakProof = "pid" | "pod-gone" | "pod-terminal" | "age";

type BreakPlan = { kind: "none" } | { kind: "break"; proof: BreakProof; reason: string };
type DecidedBreak = Extract<BreakPlan, { kind: "break" }>;

/** The death-proof answer about one judged body, asked at most once per DEATH_PROOF_RETRY_MS. */
type ProofMemo = { raw?: string; at?: number; detail?: DeathProofDetail };

function describePod(pod: PodRef | undefined): string {
  return pod ? `${pod.name} (uid ${pod.uid}${pod.node ? `, node ${pod.node}` : ""})` : "none";
}

async function foreignProof(
  current: ReadHolder,
  pod: PodRef,
  memo: ProofMemo,
  remainingMs: number,
): Promise<DeathProofDetail> {
  const now = deps.nowMs();
  if (memo.raw === current.raw && memo.at !== undefined && now - memo.at < DEATH_PROOF_RETRY_MS) {
    return memo.detail ?? { answer: "unknown" };
  }
  const timeoutMs = Math.max(1, Math.min(DEATH_PROOF_TIMEOUT_MS, remainingMs));
  const detail = await deps
    .proveDeath(pod, timeoutMs)
    .catch((): DeathProofDetail => ({ answer: "unknown" }));
  Object.assign(memo, { raw: current.raw, at: deps.nowMs(), detail });
  return detail;
}

/** Today's rules for a body without `pod` (control pod and elsewhere; never in an agent pod). */
function planNoPod(current: ReadHolder, policy: IdentityLockPolicy): BreakPlan {
  const verdict = judgeByPid(current.body, policy.judgeLegacy);
  if (verdict === "breakable") {
    return { kind: "break", proof: "pid", reason: "holder is dead" };
  }
  if (verdict === "unjudgeable" && current.ageMs > policy.staleMs) {
    const reason = `holder cannot be judged from here (another pid namespace, legacy or unidentified), lock is ${Math.round(current.ageMs)} ms old`;
    return { kind: "break", proof: "age", reason };
  }
  return { kind: "none" };
}

async function planForeign(
  current: ReadHolder,
  pod: PodRef | undefined,
  memo: ProofMemo,
  remainingMs: number,
): Promise<BreakPlan> {
  // Another pod: only the control pod may break it, only on proof, and nobody else ever asks.
  if (deps.place() !== "control" || !pod) {
    return { kind: "none" };
  }
  const detail = await foreignProof(current, pod, memo, remainingMs);
  if (detail.answer !== "gone") {
    return { kind: "none" };
  }
  return { kind: "break", proof: detail.proof, reason: `holder pod ${describePod(pod)} is gone` };
}

async function planBreak(
  current: ReadHolder,
  policy: IdentityLockPolicy,
  memo: ProofMemo,
  remainingMs: number,
): Promise<BreakPlan> {
  const holder = holderPlace(current.body);
  if (holder.kind === "no-pod") {
    return deps.place() === "agent-pod" ? { kind: "none" } : planNoPod(current, policy);
  }
  // A process that cannot name its own pod cannot place itself: it never breaks a body that carries
  // `pod` — not as "the same pod", not as the control pod (HoD ruling on F2, 2026-11-21).
  if (!deps.ownPod()) {
    return { kind: "none" };
  }
  if (holder.kind === "same-pod") {
    // pid and start time only — no age rule for a body that carries `pod` (C3.2 A-4).
    return judgeByPid(current.body, policy.judgeLegacy) === "breakable"
      ? { kind: "break", proof: "pid", reason: "holder is dead" }
      : { kind: "none" };
  }
  return await planForeign(current, holder.pod, memo, remainingMs);
}

function stateHomeDir(): string {
  return path.join(process.env.ACPX_STATE_HOME || os.homedir(), ".acpx");
}

/** `<state home>/lock-breaks/<breaker's pod uid>.ndjson` — one file per writing pod (C3.2 A-4). */
export function lockBreakLedgerPath(podUid: string): string {
  return path.join(stateHomeDir(), "lock-breaks", `${podUid}.ndjson`);
}

/** The holder's boot id: the legacy `boot` field, else the birth identity's. */
function holderBoot(body: Record<string, unknown> | undefined): string | undefined {
  if (typeof body?.boot === "string") {
    return body.boot;
  }
  const identity = body?.processIdentity;
  const boot =
    identity && typeof identity === "object"
      ? (identity as { bootId?: unknown }).bootId
      : undefined;
  return typeof boot === "string" ? boot : undefined;
}

function holderHost(body: Record<string, unknown> | undefined): string | null {
  return typeof body?.host === "string" ? body.host : null;
}

/** The broken holder as the ledger records it. L1: host and boot too, so a cross-pod break is readable. */
function holderRecord(body: Record<string, unknown> | undefined) {
  return {
    pod: parsePodRef(body?.pod) ?? null,
    pid: (body && holderPid(body)) ?? null,
    token: bodyToken(body) ?? null,
    host: holderHost(body),
    boot: holderBoot(body) ?? null,
  };
}

function breakLine(
  lockPath: string,
  body: Record<string, unknown> | undefined,
  proof: BreakProof,
  own: PodIdentity,
) {
  return {
    v: 1,
    ts: new Date(deps.nowMs()).toISOString(),
    lock: lockPath,
    holder: holderRecord(body),
    breaker: { pod: own, pid: process.pid },
    proof,
  };
}

/**
 * One line per break (C3.2 A-4). Only a breaker that knows its pod writes one — the file is named
 * by its uid; a box whose control pod has no identity yet keeps today's behaviour exactly (no new
 * file). A failed ledger write is reported on stderr and never undoes or blocks the break.
 */
async function writeBreakLine(
  lockPath: string,
  body: Record<string, unknown> | undefined,
  proof: BreakProof,
): Promise<void> {
  const own = deps.ownPod();
  if (!own) {
    return;
  }
  const file = lockBreakLedgerPath(own.uid);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.appendFile(file, `${JSON.stringify(breakLine(lockPath, body, proof, own))}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    process.stderr.write(
      `[acpx] WARNING: lock break ledger ${file} not written: ${(error as Error).message}\n`,
    );
  }
}

/** Does `raw` (read again, by open-and-read) still carry the judged holder? Token, else bytes. */
function sameHolder(
  raw: string,
  judgedRaw: string,
  judgedBody: Record<string, unknown> | undefined,
): boolean {
  const token = bodyToken(judgedBody);
  return token ? bodyToken(parseBody(raw)) === token : raw === judgedRaw;
}

/** Inside the mutex: read again (open-and-read, never `stat`), unlink only the judged holder. */
async function removeJudgedHolder(
  lockPath: string,
  plan: DecidedBreak,
  judged: ReadHolder,
): Promise<"broken" | "gone" | "changed"> {
  await deps.insideBreakMutex();
  // The same read as the judgement (open and read — never `stat`): an unreadable lock reads as the
  // unidentified holder "" there and here, so today's age rule still clears it (T15 "unreadable").
  const current = await readHolder(lockPath);
  if (!current) {
    return "gone";
  }
  const again = current.raw;
  if (!sameHolder(again, judged.raw, judged.body)) {
    return "changed";
  }
  await deps.beforeUnlink();
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    return isGoneError(error) ? "gone" : "changed";
  }
  await writeBreakLine(lockPath, judged.body, plan.proof);
  return "broken";
}

/** Carries out a decided break inside the break mutex. True when the lock is gone after it. */
async function executeBreak(
  lockPath: string,
  policy: IdentityLockPolicy,
  plan: DecidedBreak,
  judged: ReadHolder,
  waitMs: number,
): Promise<boolean> {
  const outcome = await withBreakMutex(waitMs, () => removeJudgedHolder(lockPath, plan, judged));
  if (outcome === "broken") {
    reportBreak(policy, lockPath, plan, judged.raw);
  }
  return outcome === "broken" || outcome === "gone";
}

function reportBreak(
  policy: IdentityLockPolicy,
  lockPath: string,
  plan: DecidedBreak,
  raw: string,
): void {
  if (plan.proof === "age") {
    process.stderr.write(
      `[acpx] WARNING: broke stale ${policy.label} ${lockPath} (${plan.reason}); holder ${raw}\n`,
    );
  } else if (plan.proof !== "pid") {
    process.stderr.write(
      `[acpx] broke ${policy.label} ${lockPath}: ${plan.reason} — proven by the API server ` +
        `(${plan.proof}, C3.3); breaker pod ${describePod(deps.ownPod())} pid ${process.pid}; holder ${raw}\n`,
    );
  }
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
  const broken = await executeBreak(lockPath, policy, plan, current, remainingMs);
  return { broken, tookOver: broken, holder: current.raw };
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
      throw policy.makeTimeoutError(lockPath, outcome.holder);
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

function heldBy(raw: string | undefined, content: string): boolean {
  return raw !== undefined && sameHolder(raw, content, parseBody(content));
}

/**
 * C3.2 A-4 "the holder checks before it publishes": read the lock again (open and read) and throw
 * LockLostError unless it still carries this holder's token. Call it IMMEDIATELY before the rename.
 */
export async function assertLockHeld(lockPath: string, content: string): Promise<void> {
  const raw = await fs.readFile(lockPath, "utf8").catch(() => undefined);
  if (!heldBy(raw, content)) {
    throw new LockLostError(lockPath, raw ?? "");
  }
}

/** `assertLockHeld` for a synchronous publisher (the spawn ledger's rename). */
export function assertLockHeldSync(lockPath: string, content: string): void {
  let raw: string | undefined;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    raw = undefined;
  }
  if (!heldBy(raw, content)) {
    throw new LockLostError(lockPath, raw ?? "");
  }
}

/** What a holder may do with its lock while it holds it. */
export type HeldLock = {
  /** Throws LockLostError unless the lock still carries this holder's token. */
  assertHeld: () => Promise<void>;
  assertHeldSync: () => void;
};

export async function withIdentityFileLock<T>(
  lockPath: string,
  policy: IdentityLockPolicy,
  action: (lock: HeldLock) => Promise<T>,
): Promise<T> {
  const content = await acquireIdentityFileLock(lockPath, policy);
  try {
    return await action({
      assertHeld: () => assertLockHeld(lockPath, content),
      assertHeldSync: () => assertLockHeldSync(lockPath, content),
    });
  } finally {
    await releaseIdentityFileLock(lockPath, content);
  }
}

// ---------------------------------------------------------------------------------------------
// The sweep (C3.2 "Sweeps, every 5 s")
// ---------------------------------------------------------------------------------------------

/**
 * The file names the sweep treats as locks of this primitive, with each one's age bound for a
 * leftover without `pod` (the bound its own policy uses). ⚠️ NOT a bare `.lock`: the queue LEASE is
 * `queues/<key>.lock` — a different file with its own rules, removed only under its guard (C3.1).
 */
const SWEPT_LOCKS: ReadonlyArray<{ suffix: string; staleMs: number }> = [
  { suffix: ".json.lock", staleMs: 15_000 }, // record, index, seats
  { suffix: ".lock.guard", staleMs: 10_000 }, // lease guard
  { suffix: ".acpx-stage.lock", staleMs: 120_000 }, // fork-source stage lock
];

export type PodLockSweepResult = { removed: string[] };

/**
 * One pass of C3.2's sweep, by the same rules a waiter uses — so in an AGENT POD it removes only
 * locks of this pod's dead processes; on the CONTROL POD also locks whose holder's pod is gone
 * (C3.3) and leftovers without `pod`, by today's rules. Callers: the atrium server every 5 s on the
 * control pod (EXPORT-lock-module.md), the agent pod's idle loop through `acpx __pod-lock-sweep`.
 */
export async function sweepOwnPodLocks(options: { dirs: string[] }): Promise<PodLockSweepResult> {
  const result: PodLockSweepResult = { removed: [] };
  for (const dir of options.dirs) {
    const names = await fs.readdir(dir).catch((): string[] => []);
    for (const name of names) {
      const kind = SWEPT_LOCKS.find((entry) => name.endsWith(entry.suffix));
      if (kind && (await sweepOne(path.join(dir, name), kind.staleMs))) {
        result.removed.push(path.join(dir, name));
      }
    }
  }
  return result;
}

async function sweepOne(lockPath: string, staleMs: number): Promise<boolean> {
  const current = await readHolder(lockPath);
  if (!current) {
    return false;
  }
  const policy: IdentityLockPolicy = {
    label: "lock (sweep)",
    budgetMs: DEATH_PROOF_TIMEOUT_MS,
    staleMs,
    legacyBody: () => ({}),
    makeTimeoutError: (file) => new Error(`sweep ${file}`),
  };
  const plan = await planBreak(current, policy, {}, DEATH_PROOF_TIMEOUT_MS);
  if (plan.kind === "none") {
    return false;
  }
  return await executeBreak(lockPath, policy, plan, current, 1_000);
}
