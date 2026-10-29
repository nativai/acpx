import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  classifyRecordedIdentity,
  getOwnProcessIdentity,
  getOwnProcessScope,
  identityScope,
  isOwnProcessScopeVerified,
  observeProcessIncarnation,
  processHostName,
  readProcessBirthIdentity,
  serializeProcessBirthIdentity,
  type ProcessBirthIdentity,
  type RecordedIdentity,
} from "../../process-identity.js";
import { isProcessAlive, isProcessDefinitelyDead } from "../../process-liveness.js";
import { terminateVerifiedProcess } from "../../process-signal.js";
import {
  reapSnapshot,
  snapshotSessionTree,
  unmeasuredReap,
  type BackgroundTaskSet,
  type ReapReport,
  type ReapSnapshot,
} from "../../process-tree-reap.js";

/**
 * brick ad6ba1c2 v3 — what a CLOSER knows about the session's background tasks: the live set `BG`
 * (the gate's answer, or a `query_background_tasks` made just before the stop) and S, the record's
 * `acp_session_id`. Without `bg` the closer can prove nothing, so it signals nothing and reports
 * `skipped:"no-task-set"` (RV-5); the owner's own handler still reaps whenever it runs.
 */
export type CloserTaskContext = {
  bg: BackgroundTaskSet | undefined;
  acpSessionId: string | undefined;
};

const NO_TASK_CONTEXT: CloserTaskContext = { bg: undefined, acpSessionId: undefined };
import { tryCreateLockFile } from "../../session/persistence/identity-file-lock.js";
import { pingQueueSocket, type QueueSocketPing } from "./ipc-transport.js";
import { isQueueLeaseGuardTimeout, withQueueLeaseMutation } from "./lease-mutation.js";
import {
  isReapableQueueSocketPath,
  isSharedQueueSocketPath,
  queueBaseDir,
  queueLockFilePath,
  queueSharedSocketDir,
  queueSocketBaseDir,
  queueSocketPath,
} from "./paths.js";

export { isProcessAlive } from "../../process-liveness.js";

/**
 * The queue-owner LEASE (`~/.acpx/queues/<sha24>.lock`) and every judgement made from it.
 *
 * 🛑 brick ae547131 — A LEASE'S PID IS JUDGED BY PID ONLY IN THE READER'S OWN SCOPE (boot + pid
 * namespace + time namespace, process-identity.ts). Seen from another pod (or from this container
 * after a restart) a healthy owner's pid reads ESRCH; the old pid-only rule then called it
 * `dead_owner`, and even READ verbs unlinked its lease and socket, so the next prompt started a SECOND
 * owner. Now a FOREIGN owner is judged by time alone — heartbeat age plus one socket ping — and
 * nothing here signals or unlinks anything without proof (CONCEPT §5.2 decision table, rows L1–L4,
 * F1–F5, G1; each row is a test in test/queue-lease-identity.test.ts).
 *
 * North Star (unchanged): a stale heartbeat ≠ a dead process; never auto-act on a live owner. Only a
 * PROVABLY gone owner is reaped — and only through the lease guard, as a compare-and-delete of the
 * generation that was judged dead, so a successor is never hit.
 */

const PROCESS_EXIT_GRACE_MS = 1_500;
/** FRESH: three missed 5 s beats (Q5). */
const QUEUE_OWNER_STALE_HEARTBEAT_MS = 15_000;
/** FOREIGN_DEAD: six missed beats, AND no listener at a shared socket path (Q5). */
const QUEUE_OWNER_FOREIGN_DEAD_MS = 30_000;
/** An unparsable lease is removed only once older than this and unchanged (port of 92cd5f8d). */
const UNPARSABLE_LEASE_STALE_MS = 15_000;

/** The lease's on-disk identity: the fork's legacy kind + scope (Q1), or a timestamp kind. */
export type QueueOwnerProcessIdentity = Record<string, string>;

export type QueueOwnerStateKind =
  | "no_owner"
  | "healthy"
  | "dead_owner"
  | "stale_owner"
  | "socket_unreachable"
  | "pid_reused"
  | "foreign_owner"
  | "owner_unverified";

/** How the lease's recorded identity relates to this reader. */
export type QueueOwnerScope = "local" | "foreign" | "legacy";

export type QueueOwnerRecord = {
  pid: number;
  sessionId: string;
  socketPath: string;
  createdAt: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
  processIdentity?: QueueOwnerProcessIdentity;
  /** Pod name of the writer. Diagnostics only — no decision reads it. */
  host?: string;
};

export type QueueOwnerLease = {
  sessionId: string;
  lockPath: string;
  socketPath: string;
  createdAt: string;
  ownerGeneration: number;
  processIdentity?: QueueOwnerProcessIdentity;
  host?: string;
};

export type QueueOwnerStatus = {
  pid: number;
  socketPath: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
  alive: boolean | null;
  stale: boolean;
  state: Exclude<QueueOwnerStateKind, "no_owner">;
  recoverable: boolean;
  pidAlive: boolean;
  heartbeatAgeMs: number | null;
  processIdentity?: QueueOwnerProcessIdentity;
  currentProcessIdentity?: QueueOwnerProcessIdentity;
  processIdentityMatched: boolean | null;
  socketReachable: boolean | null;
  scope: QueueOwnerScope;
  host: string | null;
};

/** Read-only owner liveness snapshot — never mutates/reaps the lease. */
export type QueueOwnerLiveness = {
  sessionId: string;
  ownerFound: boolean;
  state: QueueOwnerStateKind;
  recoverable: boolean;
  pid: number | null;
  /** The lease's pid exists IN THIS PID NAMESPACE. Meaningless for a foreign owner (false). */
  pidAlive: boolean;
  /** true = alive; false = provably gone; null = cannot be told from here (CONCEPT §5.2). */
  alive: boolean | null;
  stale: boolean;
  socketPath: string | null;
  socketReachable: boolean | null;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  createdAt: string | null;
  ownerGeneration: number | null;
  queueDepth: number;
  processIdentity?: QueueOwnerProcessIdentity;
  currentProcessIdentity?: QueueOwnerProcessIdentity;
  processIdentityMatched: boolean | null;
  /** `local` — judged by pid + start ticks; `foreign` — by time; `legacy` — pre-0a lease, today's rule. */
  scope: QueueOwnerScope | null;
  host: string | null;
  /** Why a foreign owner reads dead: `foreign-stale-no-listener` (row F4). */
  deathReason?: string;
};

export type QueueOwnerSkipReason = "foreign-owner" | "identity-unverified";

/** Outcome of a force-restart (recover) of a session's queue owner. */
export type QueueOwnerRecoveryResult = {
  /** The session id whose lease was targeted (acpx record id). */
  sessionId: string;
  /** A lease/owner record existed when recovery started. */
  ownerFound: boolean;
  /** The owner pid from the lease, if any. */
  pid: number | undefined;
  /** The owner was alive (or could not be proven dead) when recovery started. */
  wasAlive: boolean;
  /** A live owner was found and is now confirmed gone. */
  killed: boolean;
  /** The owner is STILL alive after recovery (true), or cannot be told (null). Non-false ⇒ exit 1. */
  alive: boolean | null;
  /** Precise owner-state classification observed before recovery. */
  state: QueueOwnerStateKind;
  /** The pid in the lease was alive in THIS pid namespace. */
  pidAlive: boolean;
  /** True when a live pid matched the persisted process identity, false on PID reuse, null when unknown. */
  processIdentityMatched: boolean | null;
  /** True when a live (or unprovably dead) owner was deliberately NOT signalled. Exit 1. */
  killSkipped: boolean;
  /** Why it was not signalled: it lives in another pid namespace, or its identity cannot be proven. */
  skipReason?: QueueOwnerSkipReason;
  ownerHost?: string | null;
  ownerScope?: QueueOwnerScope | null;
  /** brick ad6ba1c2 — the session's task processes after the recover. `measured:false` is no census. */
  reap: ReapReport;
};

/** What `terminateQueueOwnerForSession` did (CONCEPT §8.4) — callers report it honestly. */
export type QueueOwnerStopOutcome = {
  stopped: boolean;
  /** brick ad6ba1c2 — the session's task processes after the stop. `measured:false` is no census. */
  reap: ReapReport;
  reason:
    | "no-owner"
    | "released"
    | "stopped"
    | "already-gone"
    | "successor"
    | "survived"
    | QueueOwnerSkipReason;
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseIdentityField(value: unknown): QueueOwnerProcessIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseQueueOwnerRecord(raw: unknown): QueueOwnerRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (!hasValidQueueOwnerRecordFields(record)) {
    return null;
  }
  const processIdentity = parseIdentityField(record.processIdentity);
  return {
    pid: record.pid,
    sessionId: record.sessionId,
    socketPath: record.socketPath,
    createdAt: record.createdAt,
    heartbeatAt: record.heartbeatAt,
    ownerGeneration: record.ownerGeneration,
    queueDepth: record.queueDepth,
    ...(processIdentity ? { processIdentity } : {}),
    ...(typeof record.host === "string" ? { host: record.host } : {}),
  };
}

function hasValidQueueOwnerRecordFields(record: Record<string, unknown>): record is Record<
  string,
  unknown
> & {
  pid: number;
  sessionId: string;
  socketPath: string;
  createdAt: string;
  heartbeatAt: string;
  ownerGeneration: number;
  queueDepth: number;
} {
  return (
    isPositiveInteger(record.pid) &&
    typeof record.sessionId === "string" &&
    typeof record.socketPath === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.heartbeatAt === "string" &&
    isPositiveInteger(record.ownerGeneration) &&
    isNonNegativeInteger(record.queueDepth)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function createOwnerGeneration(): number {
  return randomInt(1, 2 ** 48);
}

function nowIso(): string {
  return new Date().toISOString();
}

function heartbeatAgeMs(owner: QueueOwnerRecord, nowMs: number = Date.now()): number | null {
  const heartbeatMs = Date.parse(owner.heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) {
    return null;
  }
  return Math.max(0, nowMs - heartbeatMs);
}

function isQueueOwnerHeartbeatStale(owner: QueueOwnerRecord): boolean {
  const ageMs = heartbeatAgeMs(owner);
  return ageMs == null || ageMs > QUEUE_OWNER_STALE_HEARTBEAT_MS;
}

/** `pid`'s current identity in the lease's on-disk form, or undefined when unreadable. */
export async function readQueueOwnerProcessIdentity(
  pid: number,
): Promise<QueueOwnerProcessIdentity | undefined> {
  const identity = readProcessBirthIdentity(pid);
  return identity ? serializeProcessBirthIdentity(identity) : undefined;
}

type LeaseFile =
  | { kind: "missing" }
  | { kind: "unparsable" }
  | { kind: "ok"; record: QueueOwnerRecord };

async function readLeaseFile(lockPath: string): Promise<LeaseFile> {
  let payload: string;
  try {
    payload = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unparsable" };
  }
  try {
    const record = parseQueueOwnerRecord(JSON.parse(payload));
    return record ? { kind: "ok", record } : { kind: "unparsable" };
  } catch {
    return { kind: "unparsable" };
  }
}

export async function readQueueOwnerRecord(
  sessionId: string,
): Promise<QueueOwnerRecord | undefined> {
  const file = await readLeaseFile(queueLockFilePath(sessionId));
  return file.kind === "ok" ? file.record : undefined;
}

/** `matchesQueueOwner` (port of openclaw/acpx 92cd5f8d): one tenure of one owner process. */
export function matchesQueueOwner(
  lease: Pick<QueueOwnerLease, "sessionId" | "ownerGeneration">,
  record: QueueOwnerRecord,
  pid: number = process.pid,
): boolean {
  return (
    record.sessionId === lease.sessionId &&
    record.pid === pid &&
    record.ownerGeneration === lease.ownerGeneration
  );
}

// ---------------------------------------------------------------------------
// Socket and filesystem helpers
// ---------------------------------------------------------------------------

async function isQueueSocketPresent(socketPath: string): Promise<boolean | null> {
  if (process.platform === "win32") {
    return null;
  }
  try {
    await fs.stat(socketPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureQueueDir(): Promise<void> {
  const baseDir = queueBaseDir();
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
  await fs.chmod(baseDir, 0o700);
  const socketDirs = [queueSocketBaseDir(), queueSharedSocketDir()];
  for (const socketDir of socketDirs) {
    if (socketDir && process.platform !== "win32") {
      await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
      await fs.chmod(socketDir, 0o700);
    }
  }
}

async function removeSocketFile(socketPath: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  try {
    await fs.unlink(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function unlinkIgnoringMissing(filePath: string): Promise<void> {
  await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

/** The `dev:ino` of whatever is at `socketPath` now, or undefined. */
export async function socketInode(socketPath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(socketPath);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Classification (CONCEPT §5.2)
// ---------------------------------------------------------------------------

type LeaseJudgement = {
  liveness: QueueOwnerLiveness;
  /** Present only when the owner may be signalled: local scope, and provably the recorded process. */
  signalIdentity?: ProcessBirthIdentity;
  /** Why it may not be, when it is alive or unprovable. */
  skipReason?: QueueOwnerSkipReason;
};

type StateInputs = {
  pidAlive: boolean;
  stale: boolean;
  socketReachable: boolean | null;
  processIdentityMatched: boolean | null;
};

function classifyLocalState(inputs: StateInputs): QueueOwnerStateKind {
  if (inputs.processIdentityMatched === false) {
    return "pid_reused";
  }
  if (!inputs.pidAlive) {
    return "dead_owner";
  }
  if (inputs.stale) {
    return "stale_owner";
  }
  if (inputs.socketReachable === false) {
    return "socket_unreachable";
  }
  return "healthy";
}

function isRecoverableQueueOwnerState(state: QueueOwnerStateKind): boolean {
  // North Star: a stale heartbeat != a dead process; never auto-act on a live owner. Only a
  // provably gone owner is auto-cleanable: dead_owner (dead in its own scope, or a foreign owner
  // with a 30 s silent heartbeat and no listener at a shared path — row F4) or pid_reused.
  return state === "dead_owner" || state === "pid_reused";
}

function baseLiveness(
  sessionId: string,
  owner: QueueOwnerRecord,
  scope: QueueOwnerScope,
): Omit<
  QueueOwnerLiveness,
  "state" | "recoverable" | "pidAlive" | "alive" | "socketReachable" | "processIdentityMatched"
> {
  return {
    sessionId,
    ownerFound: true,
    pid: owner.pid,
    stale: isQueueOwnerHeartbeatStale(owner),
    socketPath: owner.socketPath,
    heartbeatAt: owner.heartbeatAt,
    heartbeatAgeMs: heartbeatAgeMs(owner),
    createdAt: owner.createdAt,
    ownerGeneration: owner.ownerGeneration,
    queueDepth: owner.queueDepth,
    ...(owner.processIdentity ? { processIdentity: owner.processIdentity } : {}),
    scope,
    host: owner.host ?? null,
  };
}

function currentIdentityField(
  pid: number,
  pidAlive: boolean,
): { currentProcessIdentity?: QueueOwnerProcessIdentity } {
  const current = pidAlive ? readProcessBirthIdentity(pid) : undefined;
  return current ? { currentProcessIdentity: serializeProcessBirthIdentity(current) } : {};
}

function localIncarnationFacts(
  pid: number,
  birth: ProcessBirthIdentity,
): { pidAlive: boolean; matched: boolean | null } {
  const incarnation = observeProcessIncarnation(pid, birth);
  if (incarnation === "matching") {
    return { pidAlive: true, matched: true };
  }
  const dead = isProcessDefinitelyDead(pid);
  if (incarnation === "gone") {
    return { pidAlive: !dead, matched: dead ? null : false };
  }
  return { pidAlive: !dead, matched: null };
}

/** Rows L1–L4: the recorded scope is ours, so the pid is judged — by pid AND start ticks. */
async function judgeLocalLease(
  sessionId: string,
  owner: QueueOwnerRecord,
  birth: ProcessBirthIdentity,
): Promise<LeaseJudgement> {
  const base = baseLiveness(sessionId, owner, "local");
  const { pidAlive, matched } = localIncarnationFacts(owner.pid, birth);
  const socketReachable = await isQueueSocketPresent(owner.socketPath);
  const unverified = pidAlive && matched === null;
  const state: QueueOwnerStateKind = unverified
    ? "owner_unverified"
    : classifyLocalState({
        pidAlive,
        stale: base.stale,
        socketReachable,
        processIdentityMatched: matched,
      });
  return {
    liveness: {
      ...base,
      ...currentIdentityField(owner.pid, pidAlive),
      state,
      recoverable: isRecoverableQueueOwnerState(state),
      pidAlive,
      alive: unverified ? null : matched === true,
      socketReachable,
      processIdentityMatched: matched,
    },
    ...(matched === true ? { signalIdentity: birth } : {}),
    ...(unverified ? { skipReason: "identity-unverified" as const } : {}),
  };
}

/**
 * Scope fields equal to ours but no start ticks (HoD alignment): ESRCH is proof of death, a live
 * pid is alive-but-unverifiable — never signalled.
 */
async function judgeScopeOnlyLocalLease(
  sessionId: string,
  owner: QueueOwnerRecord,
): Promise<LeaseJudgement> {
  const base = baseLiveness(sessionId, owner, "local");
  const dead = isProcessDefinitelyDead(owner.pid);
  const state: QueueOwnerStateKind = dead ? "dead_owner" : "owner_unverified";
  return {
    liveness: {
      ...base,
      state,
      recoverable: dead,
      pidAlive: !dead,
      alive: !dead,
      socketReachable: await isQueueSocketPresent(owner.socketPath),
      processIdentityMatched: null,
    },
    ...(dead ? {} : { skipReason: "identity-unverified" as const }),
  };
}

type LegacyFacts = { pidAlive: boolean; matched: boolean | null };

function legacyIncarnationFacts(pid: number, legacyStartTicks: string | undefined): LegacyFacts {
  const pidAlive = isProcessAlive(pid);
  const current = pidAlive ? readProcessBirthIdentity(pid) : undefined;
  const currentTicks = current?.kind === "linux-proc" ? current.startTicks : undefined;
  if (!legacyStartTicks || !currentTicks) {
    return { pidAlive, matched: null };
  }
  return { pidAlive, matched: legacyStartTicks === currentTicks };
}

/** Signalled only with start ticks that still match — pre-0a code also signalled on `null`. */
function legacySignalIdentity(
  facts: LegacyFacts,
  legacyStartTicks: string | undefined,
): ProcessBirthIdentity | undefined {
  const own = getOwnProcessScope();
  if (!facts.pidAlive || facts.matched !== true || !own || !legacyStartTicks) {
    return undefined;
  }
  return { kind: "linux-proc", ...own, startTicks: legacyStartTicks };
}

/** Row G1: a pre-0a lease with no scope — today's rule, legitimate under the §4.5 invariant. */
async function judgeLegacyLease(
  sessionId: string,
  owner: QueueOwnerRecord,
  legacyStartTicks: string | undefined,
): Promise<LeaseJudgement> {
  const base = baseLiveness(sessionId, owner, "legacy");
  const facts = legacyIncarnationFacts(owner.pid, legacyStartTicks);
  const socketReachable = await isQueueSocketPresent(owner.socketPath);
  const state = classifyLocalState({
    pidAlive: facts.pidAlive,
    stale: base.stale,
    socketReachable,
    processIdentityMatched: facts.matched,
  });
  const alive = facts.pidAlive && facts.matched !== false;
  const signalIdentity = legacySignalIdentity(facts, legacyStartTicks);
  return {
    liveness: {
      ...base,
      ...currentIdentityField(owner.pid, facts.pidAlive),
      state,
      recoverable: isRecoverableQueueOwnerState(state),
      pidAlive: facts.pidAlive,
      alive,
      socketReachable,
      processIdentityMatched: facts.matched,
    },
    ...(signalIdentity ? { signalIdentity } : {}),
    ...(alive && !signalIdentity ? { skipReason: "identity-unverified" as const } : {}),
  };
}

type ForeignRow = { state: QueueOwnerStateKind; alive: boolean | null; deathReason?: string };

function isFresh(ageMs: number | null, limitMs: number): boolean {
  return ageMs !== null && ageMs <= limitMs;
}

function foreignRow(
  ageMs: number | null,
  shared: boolean,
  ping: QueueSocketPing | null,
): ForeignRow {
  if (isFresh(ageMs, QUEUE_OWNER_STALE_HEARTBEAT_MS)) {
    return { state: "foreign_owner", alive: true }; // F1
  }
  if (!shared || ping === null) {
    return { state: "foreign_owner", alive: null }; // F5: a pod-local socket proves nothing here
  }
  if (ping === "listening" || ping === "inconclusive") {
    return { state: "foreign_owner", alive: true }; // F2: a listener means a live (maybe wedged) owner
  }
  if (isFresh(ageMs, QUEUE_OWNER_FOREIGN_DEAD_MS)) {
    return { state: "foreign_owner", alive: null }; // F3: not yet
  }
  return { state: "dead_owner", alive: false, deathReason: "foreign-stale-no-listener" }; // F4
}

/**
 * Rows F1–F5: the owner lives in another pid namespace (or another boot, or this reader's own scope
 * is unverified). Its pid means nothing here, so it is judged by TIME: heartbeat age, and — once the
 * heartbeat is stale — one ping of a socket path both pods can see.
 */
async function judgeForeignLease(
  sessionId: string,
  owner: QueueOwnerRecord,
): Promise<LeaseJudgement> {
  const base = baseLiveness(sessionId, owner, "foreign");
  const ageMs = base.heartbeatAgeMs;
  const shared = isSharedQueueSocketPath(owner.socketPath);
  const needsPing = shared && (ageMs === null || ageMs > QUEUE_OWNER_STALE_HEARTBEAT_MS);
  const ping = needsPing ? await pingQueueSocket(owner.socketPath) : null;
  const row = foreignRow(ageMs, shared, ping);
  return {
    liveness: {
      ...base,
      state: row.state,
      recoverable: isRecoverableQueueOwnerState(row.state),
      pidAlive: false,
      alive: row.alive,
      socketReachable: ping === null ? null : ping === "listening",
      processIdentityMatched: null,
      ...(row.deathReason ? { deathReason: row.deathReason } : {}),
    },
    ...(row.alive !== false
      ? {
          // An unverified OWN scope (§3.3) also lands here: then the reason is ours, not theirs.
          skipReason: isOwnProcessScopeVerified()
            ? ("foreign-owner" as const)
            : ("identity-unverified" as const),
        }
      : {}),
  };
}

function leaseScopeFor(recorded: RecordedIdentity): QueueOwnerScope | "scope-only-local" {
  if (!isOwnProcessScopeVerified()) {
    // §3.3: with an unverified own scope every lease takes the foreign rows, legacy included.
    return "foreign";
  }
  if (recorded.kind === "legacy") {
    return "legacy";
  }
  if (recorded.kind === "scope-only") {
    return recorded.local ? "scope-only-local" : "foreign";
  }
  return identityScope(recorded.birth) === "local" ? "local" : "foreign";
}

async function judgeLease(sessionId: string, owner: QueueOwnerRecord): Promise<LeaseJudgement> {
  const recorded = classifyRecordedIdentity(owner.processIdentity);
  const scope = leaseScopeFor(recorded);
  if (scope === "local" && recorded.kind === "birth") {
    return await judgeLocalLease(sessionId, owner, recorded.birth);
  }
  if (scope === "scope-only-local") {
    return await judgeScopeOnlyLocalLease(sessionId, owner);
  }
  if (scope === "legacy" && recorded.kind === "legacy") {
    return await judgeLegacyLease(sessionId, owner, recorded.startTicks);
  }
  return await judgeForeignLease(sessionId, owner);
}

function noQueueOwnerState(sessionId: string): QueueOwnerLiveness {
  return {
    sessionId,
    ownerFound: false,
    state: "no_owner",
    recoverable: false,
    pid: null,
    pidAlive: false,
    alive: false,
    stale: false,
    socketPath: null,
    socketReachable: null,
    heartbeatAt: null,
    heartbeatAgeMs: null,
    createdAt: null,
    ownerGeneration: null,
    queueDepth: 0,
    processIdentityMatched: null,
    scope: null,
    host: null,
  };
}

// ---------------------------------------------------------------------------
// Guarded, generation-checked reap (CONCEPT §7.2)
// ---------------------------------------------------------------------------

/** Inside the guard: removes the lease (and its socket) ONLY if it still holds the judged generation. */
async function reapJudgedLeaseUnderGuard(
  sessionId: string,
  judged: QueueOwnerRecord,
): Promise<boolean> {
  const current = await readQueueOwnerRecord(sessionId);
  if (
    !current ||
    current.ownerGeneration !== judged.ownerGeneration ||
    current.pid !== judged.pid
  ) {
    return false; // a successor holds it, or it is already gone
  }
  await unlinkIgnoringMissing(queueLockFilePath(sessionId));
  if (isReapableQueueSocketPath(judged.socketPath)) {
    await removeSocketFile(judged.socketPath).catch(() => {
      // best effort: the lease is what gates the next owner
    });
  }
  return true;
}

async function reapJudgedLease(sessionId: string, judged: QueueOwnerRecord): Promise<boolean> {
  try {
    return await withQueueLeaseMutation(
      sessionId,
      async () => await reapJudgedLeaseUnderGuard(sessionId, judged),
    );
  } catch (error) {
    if (isQueueLeaseGuardTimeout(error)) {
      return false; // the reap does not happen this time
    }
    throw error;
  }
}

async function cleanupRecoverableQueueOwner(
  sessionId: string,
  owner: QueueOwnerRecord,
  state: QueueOwnerLiveness,
): Promise<boolean> {
  if (!state.recoverable) {
    return false;
  }
  // INVARIANT (North Star): cleanup NEVER signals a process, and removes only the generation that
  // was judged provably gone.
  return await reapJudgedLease(sessionId, owner);
}

// ---------------------------------------------------------------------------
// Read verbs — never unlink a live lease (T05)
// ---------------------------------------------------------------------------

export async function ensureOwnerIsUsable(
  sessionId: string,
  owner: QueueOwnerRecord,
): Promise<boolean> {
  const { liveness } = await judgeLease(sessionId, owner);
  if (liveness.state === "healthy") {
    return true;
  }
  await cleanupRecoverableQueueOwner(sessionId, owner, liveness);
  return false;
}

export async function readQueueOwnerStatus(
  sessionId: string,
): Promise<QueueOwnerStatus | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }
  const { liveness } = await judgeLease(sessionId, owner);
  if (liveness.recoverable) {
    await cleanupRecoverableQueueOwner(sessionId, owner, liveness);
    return undefined;
  }
  return {
    pid: owner.pid,
    socketPath: owner.socketPath,
    heartbeatAt: owner.heartbeatAt,
    ownerGeneration: owner.ownerGeneration,
    queueDepth: owner.queueDepth,
    alive: liveness.alive,
    stale: liveness.stale,
    state: liveness.state as Exclude<QueueOwnerStateKind, "no_owner">,
    recoverable: liveness.recoverable,
    pidAlive: liveness.pidAlive,
    heartbeatAgeMs: liveness.heartbeatAgeMs,
    ...(owner.processIdentity ? { processIdentity: owner.processIdentity } : {}),
    ...(liveness.currentProcessIdentity
      ? { currentProcessIdentity: liveness.currentProcessIdentity }
      : {}),
    processIdentityMatched: liveness.processIdentityMatched,
    socketReachable: liveness.socketReachable,
    scope: liveness.scope ?? "legacy",
    host: liveness.host,
  };
}

export async function readQueueOwnerState(sessionId: string): Promise<QueueOwnerLiveness> {
  const owner = await readQueueOwnerRecord(sessionId);
  return owner ? (await judgeLease(sessionId, owner)).liveness : noQueueOwnerState(sessionId);
}

// Read-only owner liveness — never calls ensureOwnerIsUsable() and therefore never terminates or
// removes a lease. Safe for the acpx-ui server or heartbeat tooling to poll.
export async function readQueueOwnerLiveness(sessionId: string): Promise<QueueOwnerLiveness> {
  return await readQueueOwnerState(sessionId);
}

// ---------------------------------------------------------------------------
// The owner's own lease: acquire, refresh, release (CONCEPT §7)
// ---------------------------------------------------------------------------

function ownLeaseIdentity(): { processIdentity?: QueueOwnerProcessIdentity } {
  const identity = getOwnProcessIdentity();
  return identity ? { processIdentity: serializeProcessBirthIdentity(identity) } : {};
}

function leasePayload(lease: QueueOwnerLease, heartbeatAt: string, queueDepth: number): string {
  return `${JSON.stringify(
    {
      pid: process.pid,
      sessionId: lease.sessionId,
      socketPath: lease.socketPath,
      createdAt: lease.createdAt,
      heartbeatAt,
      ownerGeneration: lease.ownerGeneration,
      queueDepth: Math.max(0, Math.round(queueDepth)),
      ...(lease.processIdentity ? { processIdentity: lease.processIdentity } : {}),
      ...(lease.host ? { host: lease.host } : {}),
    },
    null,
    2,
  )}\n`;
}

/**
 * An unparsable lease is removed only once it is older than 15 s AND unchanged (dev, ino, mtime and
 * content re-checked). A pre-0a owner creates its lease with `writeFile(wx)`, which exists EMPTY for
 * a moment — the old code unlinked it at once and so deleted a starting owner's lease. Port of
 * openclaw/acpx 92cd5f8d.
 */
async function removeUnparsableLeaseIfStale(lockPath: string): Promise<void> {
  const before = await fs.stat(lockPath).catch(() => undefined);
  if (!before || Date.now() - before.mtimeMs <= UNPARSABLE_LEASE_STALE_MS) {
    return;
  }
  if (
    (await isLeaseFileUnchanged(lockPath, before)) &&
    (await readLeaseFile(lockPath)).kind === "unparsable"
  ) {
    await unlinkIgnoringMissing(lockPath);
  }
}

/** dev, ino, mtime and content are all unchanged across two reads. */
async function isLeaseFileUnchanged(
  lockPath: string,
  before: { dev: number; ino: number; mtimeMs: number },
): Promise<boolean> {
  const raw = await fs.readFile(lockPath, "utf8").catch(() => undefined);
  const after = await fs.stat(lockPath).catch(() => undefined);
  const again = await fs.readFile(lockPath, "utf8").catch(() => undefined);
  if (!after || raw === undefined || raw !== again) {
    return false;
  }
  return after.dev === before.dev && after.ino === before.ino && after.mtimeMs === before.mtimeMs;
}

async function acquireUnderGuard(
  sessionId: string,
  nowIsoFactory: () => string,
): Promise<QueueOwnerLease | undefined> {
  const createdAt = nowIsoFactory();
  const lease: QueueOwnerLease = {
    sessionId,
    lockPath: queueLockFilePath(sessionId),
    socketPath: queueSocketPath(sessionId),
    createdAt,
    ownerGeneration: createOwnerGeneration(),
    ...ownLeaseIdentity(),
    host: processHostName(),
  };
  // Exclusive hardlink acquire (port of 92cd5f8d): the lease never exists without its content.
  if (await tryCreateLockFile(lease.lockPath, leasePayload(lease, createdAt, 0))) {
    await removeSocketFile(lease.socketPath).catch(() => {
      // best-effort stale socket cleanup after ownership is acquired
    });
    return lease;
  }
  const existing = await readLeaseFile(lease.lockPath);
  if (existing.kind === "unparsable") {
    await removeUnparsableLeaseIfStale(lease.lockPath);
  } else if (existing.kind === "ok") {
    const { liveness } = await judgeLease(sessionId, existing.record);
    if (liveness.recoverable) {
      await reapJudgedLeaseUnderGuard(sessionId, existing.record);
    }
  }
  return undefined; // the caller's existing handshake retries
}

export async function tryAcquireQueueOwnerLease(
  sessionId: string,
  nowIsoFactory: () => string = nowIso,
): Promise<QueueOwnerLease | undefined> {
  await ensureQueueDir();
  try {
    return await withQueueLeaseMutation(
      sessionId,
      async () => await acquireUnderGuard(sessionId, nowIsoFactory),
    );
  } catch (error) {
    if (isQueueLeaseGuardTimeout(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * What a heartbeat did. `superseded` is the fence: the lease names ANOTHER owner generation or pid,
 * so this owner must stop touching the lease and the socket path and exit (CONCEPT §7.4).
 */
export type QueueOwnerLeaseRefresh = "refreshed" | "republished" | "superseded" | "skipped";

async function renameLeasePayload(lease: QueueOwnerLease, payload: string): Promise<void> {
  // Readers use a malformed/missing lease as the machine signal for `no_owner`. Rewriting the live
  // pathname with writeFile() truncates it before the new JSON is complete, so publish a complete
  // sibling inode in one rename. A unique name: heartbeat and queue-depth refreshes may overlap.
  const tempPath = `${lease.lockPath}.${String(process.pid)}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(tempPath, lease.lockPath);
  } finally {
    await unlinkIgnoringMissing(tempPath);
  }
}

async function refreshUnderGuard(
  lease: QueueOwnerLease,
  payload: string,
  isCurrent: () => boolean,
): Promise<QueueOwnerLeaseRefresh> {
  if (!isCurrent()) {
    return "skipped";
  }
  let current = await readLeaseFile(lease.lockPath);
  if (current.kind === "missing") {
    // Re-publish the SAME generation with the atomic create; EEXIST falls through to the fence.
    if (await tryCreateLockFile(lease.lockPath, payload)) {
      return "republished";
    }
    current = await readLeaseFile(lease.lockPath);
  }
  if (current.kind !== "ok") {
    return "skipped";
  }
  if (!matchesQueueOwner(lease, current.record)) {
    return "superseded";
  }
  await renameLeasePayload(lease, payload);
  return "refreshed";
}

/**
 * The heartbeat (port of openclaw/acpx 92cd5f8d's fence-on-refresh). Under the lease guard it
 * rewrites the lease ONLY while it is still this owner's generation, re-publishes it if it vanished,
 * and otherwise reports `superseded` — it never renames over a successor's lease, which is what the
 * old unconditional temp+rename did.
 */
export async function refreshQueueOwnerLease(
  lease: QueueOwnerLease,
  options: {
    queueDepth: number;
    /** Re-checked inside the guard: false ⇒ the owner has stopped beating, write nothing. */
    isCurrent?: () => boolean;
  },
  nowIsoFactory: () => string = nowIso,
): Promise<QueueOwnerLeaseRefresh> {
  const payload = leasePayload(lease, nowIsoFactory(), options.queueDepth);
  const isCurrent = options.isCurrent ?? (() => true);
  try {
    return await withQueueLeaseMutation(
      lease.sessionId,
      async () => await refreshUnderGuard(lease, payload, isCurrent),
    );
  } catch (error) {
    if (isQueueLeaseGuardTimeout(error)) {
      return "skipped"; // one beat skipped
    }
    throw error;
  }
}

async function releaseUnderGuard(
  lease: QueueOwnerLease,
  ownSocketInode: string | undefined,
): Promise<boolean> {
  const current = await readLeaseFile(lease.lockPath);
  if (current.kind !== "ok" || !matchesQueueOwner(lease, current.record)) {
    return false; // not ours (any more): unlink nothing
  }
  await unlinkIgnoringMissing(lease.lockPath);
  if (ownSocketInode !== undefined && (await socketInode(lease.socketPath)) === ownSocketInode) {
    await removeSocketFile(lease.socketPath).catch(() => {});
  }
  return true;
}

/**
 * Releases THIS owner's lease (CONCEPT §7.2 release row): the lease only if it is still our
 * generation, the socket path only if it still holds the inode this owner bound. Never a successor's
 * files. Retries the guard 3× and then leaves the lease for a reaper. Returns whether it was ours.
 */
export async function releaseQueueOwnerLease(
  lease: QueueOwnerLease,
  ownSocketInode?: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await withQueueLeaseMutation(
        lease.sessionId,
        async () => await releaseUnderGuard(lease, ownSocketInode),
      );
    } catch (error) {
      if (!isQueueLeaseGuardTimeout(error)) {
        throw error;
      }
    }
  }
  return false;
}

/**
 * The fatal-signal path's own release (CONCEPT §7.3): SYNCHRONOUS — a signal handler cannot await —
 * compare-and-unlink of this owner's lease and socket inode. No guard; the window is microseconds
 * and every reaper re-checks the generation anyway. A superseded owner finds another generation and
 * unlinks nothing. Aligns with openclaw/acpx 87327c6e / bad3e934.
 */
export function releaseQueueOwnerLeaseSync(
  lease: QueueOwnerLease,
  ownSocketInode: string | undefined,
  syncFs: {
    readFileSync: (path: string, encoding: "utf8") => string;
    unlinkSync: (path: string) => void;
    statSync: (path: string) => { dev: number; ino: number };
  },
): boolean {
  try {
    const record = parseQueueOwnerRecord(JSON.parse(syncFs.readFileSync(lease.lockPath, "utf8")));
    if (!record || !matchesQueueOwner(lease, record)) {
      return false;
    }
    syncFs.unlinkSync(lease.lockPath);
  } catch {
    return false;
  }
  try {
    const stat = syncFs.statSync(lease.socketPath);
    if (ownSocketInode !== undefined && `${stat.dev}:${stat.ino}` === ownSocketInode) {
      syncFs.unlinkSync(lease.socketPath);
    }
  } catch {
    // no socket, or already gone
  }
  return true;
}

// ---------------------------------------------------------------------------
// Signalling: terminate, recover (CONCEPT §8)
// ---------------------------------------------------------------------------

/** Re-verifies the generation under the guard, then sends the first SIGTERM-to-exit sequence. */
async function stopVerifiedOwner(
  sessionId: string,
  owner: QueueOwnerRecord,
  identity: ProcessBirthIdentity,
): Promise<{ gone: boolean; signalled: boolean }> {
  const stillSame = await withQueueLeaseMutation(sessionId, async () => {
    const current = await readQueueOwnerRecord(sessionId);
    return !current || current.ownerGeneration === owner.ownerGeneration;
  }).catch(() => false);
  if (!stillSame) {
    return { gone: false, signalled: false };
  }
  // Waiting for the exit happens OUTSIDE the guard; every signal re-verifies the identity first.
  const outcome = await terminateVerifiedProcess(owner.pid, identity, PROCESS_EXIT_GRACE_MS);
  return { gone: outcome.gone, signalled: outcome.signalled };
}

async function waitForReleasedOwner(expected: QueueOwnerRecord): Promise<void> {
  const recorded = classifyRecordedIdentity(expected.processIdentity);
  if (recorded.kind !== "birth" || identityScope(recorded.birth) !== "local") {
    return;
  }
  const deadline = Date.now() + PROCESS_EXIT_GRACE_MS;
  while (
    Date.now() < deadline &&
    observeProcessIncarnation(expected.pid, recorded.birth) === "matching"
  ) {
    await waitMs(50);
  }
}

function isSuccessor(
  expectedOwner: QueueOwnerRecord | null | undefined,
  owner: QueueOwnerRecord,
): boolean {
  if (expectedOwner === undefined) {
    return false;
  }
  return (
    expectedOwner === null ||
    expectedOwner.ownerGeneration !== owner.ownerGeneration ||
    expectedOwner.pid !== owner.pid
  );
}

/**
 * Stops a session's queue owner — and says whether it did (CONCEPT §8.4, port of openclaw/acpx
 * 44a0a18e). With `expectedOwner` (the generation a close drained and sent `close_session` to, or
 * `null` when there was none), a DIFFERENT generation now in the lease is a successor and is never
 * signalled; a released lease is waited on (local) without a signal.
 */
export async function terminateQueueOwnerForSession(
  sessionId: string,
  expectedOwner?: QueueOwnerRecord | null,
  tasks?: CloserTaskContext,
): Promise<QueueOwnerStopOutcome> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    if (expectedOwner) {
      // The owner released its own lease: its own exit path reaps (§5.2 E).
      await waitForReleasedOwner(expectedOwner);
      return { stopped: true, reason: "released", reap: unmeasuredReap("no-owner") };
    }
    return { stopped: true, reason: "no-owner", reap: unmeasuredReap("no-owner") };
  }
  if (isSuccessor(expectedOwner, owner)) {
    return { stopped: false, reason: "successor", reap: unmeasuredReap("no-owner") };
  }
  return await stopJudgedOwner(sessionId, owner, tasks);
}

/**
 * brick ad6ba1c2 v3 §5.2 A/C/D — the closer's ADMISSION for a VERIFIED local owner, taken BEFORE it
 * is signalled: only processes proven to be a live background task's (§5.1). The owner's whole
 * session (owner, adapter, claude) is spared; so are this process and its ancestors (§5.3).
 */
function snapshotOwnerTasks(
  pid: number,
  identity: ProcessBirthIdentity,
  context: CloserTaskContext | undefined,
): ReapSnapshot {
  const tasks = context ?? NO_TASK_CONTEXT;
  return snapshotSessionTree({
    bg: tasks.bg,
    acpSessionId: tasks.acpSessionId,
    ownerPid: pid,
    ownerStartTicks: identity.kind === "linux-proc" ? identity.startTicks : undefined,
    excludeSelfAncestry: true,
  });
}

/** Reap only once the owner is proven gone; a surviving owner still holds its tree. */
async function reapAfterOwnerStop(snapshot: ReapSnapshot, ownerGone: boolean): Promise<ReapReport> {
  return ownerGone ? await reapSnapshot(snapshot) : unmeasuredReap("owner-survived");
}

async function stopJudgedOwner(
  sessionId: string,
  owner: QueueOwnerRecord,
  tasks: CloserTaskContext | undefined,
): Promise<QueueOwnerStopOutcome> {
  const judgement = await judgeLease(sessionId, owner);
  if (judgement.liveness.recoverable) {
    await reapJudgedLease(sessionId, owner);
    return { stopped: true, reason: "already-gone", reap: unmeasuredReap("no-owner") };
  }
  if (!judgement.signalIdentity) {
    const reason = judgement.skipReason ?? "identity-unverified";
    return { stopped: false, reason, reap: unmeasuredReap(reason) };
  }
  const snapshot = snapshotOwnerTasks(owner.pid, judgement.signalIdentity, tasks);
  const { gone } = await stopVerifiedOwner(sessionId, owner, judgement.signalIdentity);
  if (!gone) {
    return { stopped: false, reason: "survived", reap: unmeasuredReap("owner-survived") };
  }
  const reap = await reapAfterOwnerStop(snapshot, true);
  // Cleanup only on proven death, and only of the generation we stopped.
  await reapJudgedLease(sessionId, owner);
  return { stopped: true, reason: "stopped", reap };
}

// True when the process GROUP led by `pid` still has at least one live member. The queue owner is
// spawned `detached: true`, so it is a process-group leader and its pgid equals its pid.
export function hasLiveProcessGroup(pid: number): boolean {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Best-effort signal to the whole process group led by `pid` (negative pid).
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // best-effort: process group cleanup races with members exiting on their own
  }
}

/**
 * The group sweep after a VERIFIED leader kill (CONCEPT §8.3). Leader still alive ⇒ it must still be
 * the recorded process. Leader ESRCH ⇒ the sweep is safe: Linux keeps a pid number allocated while
 * any task still uses it as a pgid, so no new process can lead a group with that number while
 * members of the old group live.
 */
async function sweepVerifiedOwnerGroup(pid: number, identity: ProcessBirthIdentity): Promise<void> {
  const leaderOk =
    isProcessDefinitelyDead(pid) || observeProcessIncarnation(pid, identity) === "matching";
  if (leaderOk && hasLiveProcessGroup(pid)) {
    signalProcessGroup(pid, "SIGKILL");
    await waitMs(Math.min(200, PROCESS_EXIT_GRACE_MS));
  }
}

function skippedRecovery(
  sessionId: string,
  owner: QueueOwnerRecord,
  judgement: LeaseJudgement,
): QueueOwnerRecoveryResult {
  const { liveness } = judgement;
  return {
    sessionId,
    ownerFound: true,
    pid: owner.pid,
    wasAlive: liveness.alive !== false,
    killed: false,
    alive: liveness.alive,
    state: liveness.state,
    pidAlive: liveness.pidAlive,
    processIdentityMatched: liveness.processIdentityMatched,
    killSkipped: true,
    skipReason: judgement.skipReason ?? "identity-unverified",
    ownerHost: liveness.host,
    ownerScope: liveness.scope,
    reap: unmeasuredReap(judgement.skipReason ?? "identity-unverified"),
  };
}

// Force-restart primitive (the un-wedge): kill the session's queue-owner process GROUP and clear its
// lease so the next submit_prompt cold-spawns a fresh owner — ONLY for an owner provably in this
// reader's scope and provably the recorded process (§8.2). A foreign or unverifiable owner is NOT
// signalled and its lease is NOT touched: `killSkipped`, exit 1. The old code reported a foreign
// owner as "already gone; cleared stale lease" with exit 0, and acpx-ui then re-drove into it.
export async function recoverQueueOwnerForSession(
  sessionId: string,
  tasks?: CloserTaskContext,
): Promise<QueueOwnerRecoveryResult> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    // Idempotent: no lease means there is no owner to kill. "Already gone" is success.
    return noQueueOwnerRecoveryResult(sessionId);
  }
  const judgement = await judgeLease(sessionId, owner);
  const { liveness } = judgement;
  if (liveness.recoverable) {
    await reapJudgedLease(sessionId, owner);
    return deadOwnerRecovery(sessionId, owner, liveness);
  }
  if (!judgement.signalIdentity) {
    return skippedRecovery(sessionId, owner, judgement);
  }
  const identity = judgement.signalIdentity;
  const snapshot = snapshotOwnerTasks(owner.pid, identity, tasks);
  const { gone, signalled } = await stopVerifiedOwner(sessionId, owner, identity);
  if (signalled) {
    await sweepVerifiedOwnerGroup(owner.pid, identity);
  }
  const alive = observeProcessIncarnation(owner.pid, identity) === "matching";
  const reap = await reapAfterOwnerStop(snapshot, !alive);
  if (gone || !alive) {
    await reapJudgedLease(sessionId, owner);
  }
  return {
    sessionId,
    ownerFound: true,
    pid: owner.pid,
    wasAlive: true,
    killed: signalled && !alive,
    alive,
    state: liveness.state,
    pidAlive: liveness.pidAlive,
    processIdentityMatched: liveness.processIdentityMatched,
    killSkipped: false,
    ownerHost: liveness.host,
    ownerScope: liveness.scope,
    reap,
  };
}

function deadOwnerRecovery(
  sessionId: string,
  owner: QueueOwnerRecord,
  liveness: QueueOwnerLiveness,
): QueueOwnerRecoveryResult {
  return {
    sessionId,
    ownerFound: true,
    pid: owner.pid,
    // The pid NUMBER may be alive (pid_reused) — the owner is not.
    wasAlive: liveness.pidAlive,
    killed: false,
    alive: false,
    state: liveness.state,
    pidAlive: liveness.pidAlive,
    processIdentityMatched: liveness.processIdentityMatched,
    killSkipped: false,
    ownerHost: liveness.host,
    ownerScope: liveness.scope,
    reap: unmeasuredReap("no-owner"),
  };
}

function noQueueOwnerRecoveryResult(sessionId: string): QueueOwnerRecoveryResult {
  return {
    sessionId,
    ownerFound: false,
    pid: undefined,
    wasAlive: false,
    killed: false,
    alive: false,
    state: "no_owner",
    pidAlive: false,
    processIdentityMatched: null,
    killSkipped: false,
    reap: unmeasuredReap("no-owner"),
  };
}

/**
 * The startup grace a not-yet-accepting lease still has (S-33): a LOCAL lease must belong to the
 * recorded live process; a FOREIGN one is alive while its heartbeat is fresh. Then it must be
 * younger than the budget.
 */
export async function leaseIsAliveForStartup(owner: QueueOwnerRecord): Promise<boolean> {
  const { liveness } = await judgeLease(owner.sessionId, owner);
  return liveness.alive !== false && !liveness.recoverable;
}

export async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
