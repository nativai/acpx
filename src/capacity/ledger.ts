import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getOwnProcessIdentity,
  getOwnProcessScope,
  observeProcessIncarnation,
  parseLinuxStatStartTicks,
  parseProcessBirthIdentity,
  serializeProcessBirthIdentity,
} from "../process-identity.js";
import {
  acquireIdentityFileLock,
  type IdentityLockPolicy,
  releaseIdentityFileLock,
} from "../session/persistence/identity-file-lock.js";
import type { Harness } from "./constants.js";
import type { PendingReservation } from "./pending.js";

/**
 * The admission ledger (CONCEPTION f7587c86 §5): box-global state under
 * `<passwd home>/.acpx/admission/` — `admission.lock`, `pending.json`, `log/<date>.ndjson`.
 *
 * ⚠️ THE PASSWD HOME, NOT `$HOME`. A process in this control pod with an isolated HOME (a test rig,
 * a harness config root) still shares the container's cgroup, so it must share the gate. Only
 * `ACPX_ADMISSION_DIR` moves it — the suite's isolation seam (`scripts/run-tests.mjs`).
 */

export const ADMISSION_TTL_MS = 180_000;
/**
 * An `automation` reservation lives 10 min from bind (CONCEPTION e8abe1e8 §3.2.2, R4): its owner
 * starts only when atrium delivers the first prompt, and no delivery runs before atrium's port latch
 * — a restart's bind window (~3–5 min under load) plus one 2-min delivery retry. 180 s would let two
 * back-to-back starts be admitted against the same memory.
 */
export const ADMISSION_TTL_AUTOMATION_MS = 600_000;
const LOCK_BUDGET_MS = 5_000;
/** Only an UNJUDGEABLE holder (another namespace, legacy body) is broken by age; a live one never. */
const LOCK_STALE_MS = 4_000;
const LOG_RETENTION_DAYS = 14;

export function admissionDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ACPX_ADMISSION_DIR?.trim();
  return override ? path.resolve(override) : path.join(passwdHome(), ".acpx", "admission");
}

/** `os.userInfo()` throws for a uid with no passwd entry; a gate must not crash a create on that. */
function passwdHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

export type AdmissionClass = "interactive" | "delivery" | "automation" | "spawn";

export type PendingEntry = {
  readonly key: string;
  readonly sessionId?: string;
  readonly harness: Harness;
  readonly bytes: number;
  readonly class: AdmissionClass;
  readonly origin: string;
  readonly admittedAt: string;
  readonly expiresAt: string;
  /** When `ticket.bind` tied it to its created record (CONCEPTION e8abe1e8 §3.2.2, R14). */
  readonly boundAt?: string;
  /** The container this entry was written in: pid namespace + PID 1's start time (§5). */
  readonly instance: string;
  readonly admitterPid: number;
  readonly admitterIdentity?: Record<string, unknown>;
  readonly kind: "create";
};

/** Thrown by the lock policy on timeout — the gate turns it into `admission_busy` (§3.3). */
export class AdmissionLockTimeoutError extends Error {
  constructor(lockPath: string, holder: string) {
    super(`admission lock ${lockPath} stayed busy for ${LOCK_BUDGET_MS} ms (holder ${holder})`);
    this.name = "AdmissionLockTimeoutError";
  }
}

const LOCK_POLICY: IdentityLockPolicy = {
  label: "admission lock",
  budgetMs: LOCK_BUDGET_MS,
  staleMs: LOCK_STALE_MS,
  legacyBody: () => ({ pid: process.pid, createdAt: new Date().toISOString() }),
  makeTimeoutError: (lockPath, holder) => new AdmissionLockTimeoutError(lockPath, holder),
};

/**
 * Runs `action` under the box-wide admission lock. Throws `AdmissionLockTimeoutError` on contention;
 * any other throw from the lock itself (EACCES, ENOSPC, EROFS) is an instrument fault the caller
 * fails OPEN on (§3.3).
 */
export async function withAdmissionLock<T>(dir: string, action: () => Promise<T>): Promise<T> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, "admission.lock");
  const content = await acquireIdentityFileLock(lockPath, LOCK_POLICY);
  try {
    return await action();
  } finally {
    await releaseIdentityFileLock(lockPath, content);
  }
}

let instanceCache: string | undefined;

/** pid-namespace inode + PID 1's start ticks: both change on every container restart; the boot id
 *  does not (review finding 13). "unknown" when either is unreadable — then nothing is dropped on it. */
export function containerInstance(): string {
  if (instanceCache === undefined) {
    let ticks: string | undefined;
    try {
      ticks = parseLinuxStatStartTicks(readFileSync("/proc/1/stat", "utf8"), 1);
    } catch {
      ticks = undefined;
    }
    const namespace = getOwnProcessScope()?.pidNamespace;
    instanceCache = namespace && ticks ? `${namespace}:${ticks}` : "unknown";
  }
  return instanceCache;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEntry(value: unknown): value is PendingEntry {
  if (!isRecordObject(value)) {
    return false;
  }
  const types: Array<[string, string]> = [
    ["key", "string"],
    ["bytes", "number"],
    ["expiresAt", "string"],
    ["instance", "string"],
    ["admitterPid", "number"],
  ];
  return (
    types.every(([field, type]) => typeof value[field] === type) && Number.isFinite(value.bytes)
  );
}

/** Every entry on disk; a missing or corrupt file is an empty ledger (it only ever holds ≤ 180 s). */
export async function readLedgerFile(dir: string): Promise<PendingEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, "pending.json"), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? parsed.entries.filter(isEntry) : [];
  } catch {
    return [];
  }
}

/** Temp file + rename: a reader without the lock (`acpx capacity`) never sees a torn file. */
export async function writeLedgerFile(
  dir: string,
  entries: readonly PendingEntry[],
): Promise<void> {
  const file = path.join(dir, "pending.json");
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ schema: 1, entries }, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.rename(temporary, file);
}

/** TTL and container instance (§5, drop rules 1 and 3). Rule 2 needs the census: `partitionPending`. */
export function liveEntries(entries: readonly PendingEntry[], nowMs: number): PendingEntry[] {
  const instance = containerInstance();
  return entries.filter(
    (entry) =>
      Date.parse(entry.expiresAt) > nowMs &&
      (instance === "unknown" || entry.instance === "unknown" || entry.instance === instance),
  );
}

/** `gone` is the only proof of death; an unjudgeable admitter keeps its reservation (rounds up, §9). */
function admitterAlive(entry: PendingEntry): boolean {
  const identity = parseProcessBirthIdentity(entry.admitterIdentity);
  return observeProcessIncarnation(entry.admitterPid, identity) !== "gone";
}

export function ttlFor(admissionClass: AdmissionClass | undefined): number {
  return admissionClass === "automation" ? ADMISSION_TTL_AUTOMATION_MS : ADMISSION_TTL_MS;
}

/** `ticket.bind`: tie the entry to its record and re-stamp its class TTL from now. */
export function boundEntry(entry: PendingEntry, sessionId: string, now: Date): PendingEntry {
  return {
    ...entry,
    sessionId,
    boundAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlFor(entry.class)).toISOString(),
  };
}

/**
 * N1 (CONCEPTION e8abe1e8, review re-check): has the bound session already RUN — a turn started at
 * or after `boundAt` (`last_prompt_at`), or the record is closed? A missing or unreadable record is
 * not spent: the reservation keeps counting until its TTL (rounds up, §9).
 */
function sessionSpent(sessionsDir: string, sessionId: string, boundAt: string): boolean {
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(path.join(sessionsDir, `${sessionId}.json`), "utf8"));
  } catch {
    return false;
  }
  if (!isRecordObject(record)) {
    return false;
  }
  if (record.closed === true) {
    return true;
  }
  const lastPrompt = typeof record.last_prompt_at === "string" ? record.last_prompt_at : "";
  return Date.parse(lastPrompt) >= Date.parse(boundAt);
}

export function reservationsOf(
  entries: readonly PendingEntry[],
  sessionsDir: string,
): PendingReservation[] {
  return entries.map((entry) => {
    const { sessionId, boundAt } = entry;
    const bound = typeof boundAt === "string" && sessionId !== undefined;
    return {
      key: entry.key,
      sessionId,
      bytes: entry.bytes,
      admitterAlive: admitterAlive(entry),
      bound,
      spent: bound && sessionSpent(sessionsDir, sessionId, boundAt),
    };
  });
}

export function newEntry(params: {
  key: string;
  sessionId?: string;
  harness: Harness;
  bytes: number;
  admissionClass: AdmissionClass;
  origin: string;
  now: Date;
}): PendingEntry {
  const identity = getOwnProcessIdentity();
  return {
    key: params.key,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    harness: params.harness,
    bytes: params.bytes,
    class: params.admissionClass,
    origin: params.origin,
    admittedAt: params.now.toISOString(),
    expiresAt: new Date(params.now.getTime() + ttlFor(params.admissionClass)).toISOString(),
    instance: containerInstance(),
    admitterPid: process.pid,
    ...(identity ? { admitterIdentity: serializeProcessBirthIdentity(identity) } : {}),
    kind: "create",
  };
}

/**
 * One O_APPEND line per decision (the `message-ledger.ts` pattern), 14-day retention. Best effort:
 * a log that cannot be written never changes a decision.
 */
export async function appendDecisionLog(
  dir: string,
  line: Record<string, unknown>,
  now: Date,
): Promise<void> {
  const logDir = path.join(dir, "log");
  const day = now.toISOString().slice(0, 10);
  const file = path.join(logDir, `${day}.ndjson`);
  try {
    await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
    const firstOfDay = await fs.stat(file).then(
      () => false,
      () => true,
    );
    await fs.appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    if (firstOfDay) {
      await pruneOldLogs(logDir, now);
    }
  } catch {
    // best effort
  }
}

async function pruneOldLogs(logDir: string, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - LOG_RETENTION_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  for (const name of await fs.readdir(logDir)) {
    const match = /^(\d{4}-\d{2}-\d{2})\.ndjson$/u.exec(name);
    if (match && match[1] < cutoff) {
      await fs.rm(path.join(logDir, name), { force: true });
    }
  }
}
