import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { isProcessDefinitelyDead } from "./process-liveness.js";

/**
 * Process BIRTH identity — the thing that makes a recorded pid mean one process (brick ae547131).
 *
 * Port of openclaw/acpx c4f3a9d1 + a8fe1987 (`src/process-identity.ts`): the same types, the same
 * scope comparison and the same `matching | gone | unknown` verdict, so the upstream sync finds the
 * same concepts under the same names. ONE deliberate difference: upstream observes Linux identities
 * through a short-lived `node -e` helper per query; this observes IN-PROCESS (`kill(pid,0)` plus one
 * `/proc/<pid>/stat` read), because every `prompt`, `status` and `sessions list` judges leases and a
 * helper spawn per judgement costs ≈50–80 ms and a node process (CONCEPT §3.3).
 *
 * 🛑 A PID NUMBER NAMES A PROCESS ONLY INSIDE ONE PID NAMESPACE, AND ONLY UNTIL IT IS REUSED. A
 * control-container restart starts a new pid namespace whose counter begins at 1, with the SAME
 * hostname and the SAME boot id, and the workbench pod shares the boot id while having its own pid
 * namespace. So a recorded pid may be judged by pid ONLY when the reader's own boot, pid namespace
 * AND time namespace equal the recorded ones. Anything else is foreign: ESRCH here proves nothing.
 * ⚠️ DO NOT "SIMPLIFY" THIS TO HOSTNAME + BOOT ID — that is exactly the rule that misjudges both
 * cases above (`test/process-identity.test.ts`, the `pid:[1]` rows).
 */

export type TimestampIdentity = {
  kind: "posix-lstart" | "windows-creation";
  value: string;
};

export type LinuxProcessScope = {
  bootId: string;
  pidNamespace: string;
  timeNamespace: string;
};

export type LinuxProcessIdentity = LinuxProcessScope & { kind: "linux-proc"; startTicks: string };

export type ProcessBirthIdentity = TimestampIdentity | LinuxProcessIdentity;
export type ProcessIdentityComparison = "matching" | "different" | "unknown";
export type ProcessIncarnation = "matching" | "gone" | "unknown";

/** How a recorded identity relates to the reader. `none` = a legacy artefact with no scope. */
export type IdentityScope = "local" | "foreign" | "other-boot" | "none" | "unverified";

/** The fork's pre-0a lease spelling. Kept as the WRITE spelling during 0a (CONCEPT §4.1, Q1). */
export const LEGACY_LINUX_IDENTITY_KIND = "linux-proc-stat-starttime";

/** The `/proc` reads this module makes. Swappable ONLY by tests (the /proc self-check, T35). */
export type ProcReader = {
  readFile(path: string): string;
  readLink(path: string): string;
};

const realProcReader: ProcReader = {
  readFile: (path) => fs.readFileSync(path, "utf8"),
  readLink: (path) => fs.readlinkSync(path),
};

let procReader: ProcReader = realProcReader;

type OwnScope = { verified: true; scope: LinuxProcessScope } | { verified: false };
let ownScopeCache: OwnScope | undefined;
let ownIdentityCache: { identity: ProcessBirthIdentity | undefined } | undefined;

/** A SEAM, NOT API. Replaces the `/proc` reader and drops the cached own scope. */
export function setProcReaderForTests(reader: ProcReader | undefined): void {
  procReader = reader ?? realProcReader;
  ownScopeCache = undefined;
  ownIdentityCache = undefined;
}

const BOOT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const PID_NAMESPACE_PATTERN = /^pid:\[[1-9]\d*\]$/;
const TIME_NAMESPACE_PATTERN = /^time:\[[1-9]\d*\]$/;
const POSIX_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStartTicks(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value);
}

function isTimeNamespace(value: unknown): value is string {
  // Kernels without CONFIG_TIME_NS have no /proc/PID/ns/time entry (upstream a8fe1987).
  return (
    typeof value === "string" && (value === "unsupported" || TIME_NAMESPACE_PATTERN.test(value))
  );
}

function parseLinuxScope(raw: Record<string, unknown>): LinuxProcessScope | undefined {
  const { bootId, pidNamespace, timeNamespace } = raw;
  if (
    typeof bootId !== "string" ||
    !BOOT_ID_PATTERN.test(bootId) ||
    typeof pidNamespace !== "string" ||
    !PID_NAMESPACE_PATTERN.test(pidNamespace) ||
    !isTimeNamespace(timeNamespace)
  ) {
    return undefined;
  }
  return { bootId, pidNamespace, timeNamespace };
}

function isCanonicalBirth(value: unknown, kind: TimestampIdentity["kind"]): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return false;
  }
  const canonical = new Date(value).toISOString();
  if (canonical.slice(0, 19) !== value.slice(0, 19)) {
    return false;
  }
  return kind === "posix-lstart"
    ? value === canonical && value.endsWith(".000Z")
    : /\.\d{7}Z$/.test(value);
}

function parseTimestampIdentity(raw: Record<string, unknown>): TimestampIdentity | undefined {
  const kind = raw.kind;
  if (kind !== "posix-lstart" && kind !== "windows-creation") {
    return undefined;
  }
  return isCanonicalBirth(raw.value, kind) ? { kind, value: raw.value } : undefined;
}

function parseScopedLinux(
  raw: Record<string, unknown>,
  startTicks: unknown,
): LinuxProcessIdentity | undefined {
  const scope = parseLinuxScope(raw);
  return scope && isStartTicks(startTicks)
    ? { kind: "linux-proc", ...scope, startTicks }
    : undefined;
}

/**
 * Parses an identity in either on-disk spelling into the in-memory birth identity:
 * - upstream's `{kind:"linux-proc", bootId, pidNamespace, timeNamespace, startTicks}`;
 * - the fork's `{kind:"linux-proc-stat-starttime", startTimeTicks, bootId, pidNamespace,
 *   timeNamespace}` (0a writes this, so pre-0a readers keep their start-tick guard);
 * - `posix-lstart` / `windows-creation`.
 * A legacy-kind identity WITHOUT a valid scope is not a birth identity: see
 * {@link parseLegacyStartTimeTicks}.
 */
export function parseProcessBirthIdentity(raw: unknown): ProcessBirthIdentity | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw.kind === "linux-proc") {
    return parseScopedLinux(raw, raw.startTicks);
  }
  if (raw.kind === LEGACY_LINUX_IDENTITY_KIND) {
    return parseScopedLinux(raw, raw.startTimeTicks);
  }
  return parseTimestampIdentity(raw);
}

/** The pre-0a lease identity's start ticks — what a LEGACY artefact is judged by (CONCEPT §5.2 G1). */
export function parseLegacyStartTimeTicks(raw: unknown): string | undefined {
  if (!isRecord(raw) || raw.kind !== LEGACY_LINUX_IDENTITY_KIND) {
    return undefined;
  }
  return isStartTicks(raw.startTimeTicks) ? raw.startTimeTicks : undefined;
}

/** The camelCase on-disk form used by the lease and every lock body (CONCEPT §4.1, §4.3). */
export function serializeProcessBirthIdentity(
  identity: ProcessBirthIdentity,
): Record<string, string> {
  if (identity.kind !== "linux-proc") {
    return { kind: identity.kind, value: identity.value };
  }
  return {
    kind: LEGACY_LINUX_IDENTITY_KIND,
    startTimeTicks: identity.startTicks,
    bootId: identity.bootId,
    pidNamespace: identity.pidNamespace,
    timeNamespace: identity.timeNamespace,
  };
}

/** `/proc/<pid>/stat` → start ticks (field 22). comm may hold spaces and ')'; parse after the last. */
export function parseLinuxStatStartTicks(
  payload: string,
  expectedPid?: number,
): string | undefined {
  const prefix = /^(\d+) \(/.exec(payload);
  const close = payload.lastIndexOf(")");
  if (!prefix || close < 0) {
    return undefined;
  }
  if (expectedPid !== undefined && Number(prefix[1]) !== expectedPid) {
    return undefined;
  }
  const startTicks = payload
    .slice(close + 2)
    .trim()
    .split(/\s+/u)[19];
  return isStartTicks(startTicks) ? startTicks : undefined;
}

function readStatPid(payload: string): number | undefined {
  const prefix = /^(\d+) \(/.exec(payload);
  return prefix ? Number(prefix[1]) : undefined;
}

function readOwnTimeNamespace(): string {
  try {
    return procReader.readLink("/proc/self/ns/time");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "unsupported";
    }
    throw error;
  }
}

function discoverOwnScope(): OwnScope {
  try {
    const scope = parseLinuxScope({
      bootId: procReader.readFile("/proc/sys/kernel/random/boot_id").trim(),
      pidNamespace: procReader.readLink("/proc/self/ns/pid"),
      timeNamespace: readOwnTimeNamespace(),
    });
    // The /proc self-check (upstream verifies the same through its helper): the /proc this
    // process reads must be the one of its OWN pid namespace, or no pid it reads means anything.
    const selfPid = readStatPid(procReader.readFile("/proc/self/stat"));
    return scope && selfPid === process.pid ? { verified: true, scope } : { verified: false };
  } catch {
    return { verified: false };
  }
}

/**
 * The reader's own `{bootId, pidNamespace, timeNamespace}`, cached once per process. `undefined`
 * off Linux, and on Linux when it could not be read or failed the /proc self-check — then EVERY
 * recorded identity is judged `unknown`, and nothing is signalled or reaped by pid (CONCEPT §3.3).
 */
export function getOwnProcessScope(): LinuxProcessScope | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  ownScopeCache ??= discoverOwnScope();
  return ownScopeCache.verified ? ownScopeCache.scope : undefined;
}

/** False only on Linux when the own scope could not be established (§3.3). */
export function isOwnProcessScopeVerified(): boolean {
  return process.platform !== "linux" || getOwnProcessScope() !== undefined;
}

function readLinuxStartTicks(pid: number): string | undefined {
  try {
    return parseLinuxStatStartTicks(procReader.readFile(`/proc/${pid}/stat`), pid);
  } catch {
    return undefined;
  }
}

function posixBirth(value: string): string | undefined {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(
    value.trim(),
  );
  const month = match ? POSIX_MONTHS.indexOf(match[1]) : -1;
  if (!match || month < 0) {
    return undefined;
  }
  // lstart has one-second precision; explicit UTC keeps identities stable across timezones.
  const valueUtc = `${match[6]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}T${match[3]}:${match[4]}:${match[5]}.000Z`;
  return isCanonicalBirth(valueUtc, "posix-lstart") ? valueUtc : undefined;
}

function readPosixBirth(pid: number): TimestampIdentity | undefined {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    const value = posixBirth(output);
    return value ? { kind: "posix-lstart", value } : undefined;
  } catch {
    return undefined;
  }
}

/** The CURRENT birth identity of `pid` as this process sees it, or undefined when unreadable. */
export function readProcessBirthIdentity(pid: number): ProcessBirthIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined;
  }
  if (process.platform === "linux") {
    const scope = getOwnProcessScope();
    const startTicks = scope ? readLinuxStartTicks(pid) : undefined;
    return scope && startTicks ? { kind: "linux-proc", ...scope, startTicks } : undefined;
  }
  return process.platform === "win32" ? undefined : readPosixBirth(pid);
}

/** This process's own birth identity, cached (it cannot change). */
export function getOwnProcessIdentity(): ProcessBirthIdentity | undefined {
  ownIdentityCache ??= { identity: readProcessBirthIdentity(process.pid) };
  return ownIdentityCache.identity;
}

export function compareLinuxScope(
  expected: LinuxProcessScope,
  observed: LinuxProcessScope,
): ProcessIdentityComparison {
  // Queue homes are local to one machine: a prior boot cannot retain a live process, while a
  // different namespace in this boot cannot establish its absence (upstream c4f3a9d1).
  if (expected.bootId !== observed.bootId) {
    return "different";
  }
  if (
    expected.pidNamespace !== observed.pidNamespace ||
    expected.timeNamespace !== observed.timeNamespace
  ) {
    return "unknown";
  }
  return "matching";
}

function compareLinuxIdentity(
  expected: LinuxProcessIdentity,
  observed: LinuxProcessIdentity,
): ProcessIdentityComparison {
  const scope = compareLinuxScope(expected, observed);
  if (scope !== "matching") {
    return scope;
  }
  return expected.startTicks === observed.startTicks ? "matching" : "different";
}

export function compareProcessBirthIdentity(
  expected: ProcessBirthIdentity | undefined,
  observed: ProcessBirthIdentity,
): ProcessIdentityComparison {
  if (!expected || expected.kind !== observed.kind) {
    return "unknown";
  }
  if (expected.kind === "linux-proc") {
    return compareLinuxIdentity(expected, observed as LinuxProcessIdentity);
  }
  return expected.value === (observed as TimestampIdentity).value ? "matching" : "different";
}

/**
 * How `identity` relates to this reader. `local` is the ONLY scope in which a pid may be judged:
 * same boot, same pid namespace, same time namespace (or a timestamp identity off Linux).
 */
export function identityScope(identity: ProcessBirthIdentity | undefined): IdentityScope {
  if (!identity) {
    return isOwnProcessScopeVerified() ? "none" : "unverified";
  }
  if (identity.kind !== "linux-proc") {
    return process.platform === "linux" ? "foreign" : "local";
  }
  const own = getOwnProcessScope();
  if (!own) {
    return "unverified";
  }
  const scope = compareLinuxScope(identity, own);
  if (scope === "different") {
    return "other-boot";
  }
  return scope === "matching" ? "local" : "foreign";
}

function comparisonToIncarnation(comparison: ProcessIdentityComparison): ProcessIncarnation {
  return comparison === "different" ? "gone" : comparison;
}

function observeLinuxIncarnation(pid: number, expected: LinuxProcessIdentity): ProcessIncarnation {
  const own = getOwnProcessScope();
  if (!own) {
    return "unknown";
  }
  const scope = compareLinuxScope(expected, own);
  if (scope !== "matching") {
    return comparisonToIncarnation(scope);
  }
  // A PID missing in this namespace says nothing about one in another: ESRCH counts only now.
  if (isProcessDefinitelyDead(pid)) {
    return "gone";
  }
  const startTicks = readLinuxStartTicks(pid);
  if (startTicks === undefined) {
    return isProcessDefinitelyDead(pid) ? "gone" : "unknown";
  }
  return startTicks === expected.startTicks ? "matching" : "gone";
}

function observeTimestampIncarnation(pid: number, expected: TimestampIdentity): ProcessIncarnation {
  if (process.platform === "linux" || process.platform === "win32") {
    // posix-lstart is the macOS/BSD kind; windows-creation is never observed in-process.
    return "unknown";
  }
  if (isProcessDefinitelyDead(pid)) {
    return "gone";
  }
  const observed = readPosixBirth(pid);
  if (!observed) {
    return isProcessDefinitelyDead(pid) ? "gone" : "unknown";
  }
  return comparisonToIncarnation(compareProcessBirthIdentity(expected, observed));
}

/**
 * Upstream's `observeProcessIncarnation`, synchronous and in-process: is `pid` still the process
 * born as `expected`? `matching` — yes; `gone` — provably not (dead in its own scope, reused, or
 * from a prior boot); `unknown` — cannot be told from here (another pid/time namespace, an
 * unreadable `/proc`, a failed self-check). Only `matching` licenses a signal; only `gone`
 * licenses a cleanup; `unknown` keeps everything (CONCEPT §8.0).
 */
export function observeProcessIncarnation(
  pid: number,
  expected: ProcessBirthIdentity | undefined,
): ProcessIncarnation {
  if (!expected || !Number.isSafeInteger(pid) || pid <= 0) {
    return "unknown";
  }
  return expected.kind === "linux-proc"
    ? observeLinuxIncarnation(pid, expected)
    : observeTimestampIncarnation(pid, expected);
}

/** The pod name — travels beside every identity for diagnostics only. NO decision reads it. */
export function processHostName(): string {
  return os.hostname();
}

// ---------------------------------------------------------------------------
// Session-record form (`pid_identity`, snake_case at every depth — persisted-key-policy.ts)
// ---------------------------------------------------------------------------

export type RecordPidIdentity = {
  pid: number;
  identity: ProcessBirthIdentity;
  host?: string;
};

/** The record's `pid_identity` body (CONCEPT §4.2). */
export function serializeRecordPidIdentity(value: RecordPidIdentity): Record<string, unknown> {
  const host = value.host === undefined ? {} : { host: value.host };
  if (value.identity.kind !== "linux-proc") {
    return { pid: value.pid, kind: value.identity.kind, value: value.identity.value, ...host };
  }
  return {
    pid: value.pid,
    kind: "linux-proc",
    boot_id: value.identity.bootId,
    pid_namespace: value.identity.pidNamespace,
    time_namespace: value.identity.timeNamespace,
    start_ticks: value.identity.startTicks,
    ...host,
  };
}

export function parseRecordPidIdentity(raw: unknown): RecordPidIdentity | undefined {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 0) {
    return undefined;
  }
  const identity =
    raw.kind === "linux-proc"
      ? parseScopedLinux(
          {
            bootId: raw.boot_id,
            pidNamespace: raw.pid_namespace,
            timeNamespace: raw.time_namespace,
          },
          raw.start_ticks,
        )
      : parseTimestampIdentity(raw);
  if (!identity) {
    return undefined;
  }
  return {
    pid: raw.pid as number,
    identity,
    ...(typeof raw.host === "string" ? { host: raw.host } : {}),
  };
}

/**
 * The identity that may be used to judge `record.pid`: present ONLY when `pid_identity.pid`
 * equals `pid`. A disagreement means some writer moved `pid` without the identity, so it is
 * treated as absent — and no identity ⇒ never signalled (CONCEPT §4.2 validity rule).
 */
export function validRecordPidIdentity(
  pid: number | undefined,
  pidIdentity: RecordPidIdentity | undefined,
): ProcessBirthIdentity | undefined {
  return pid !== undefined && pidIdentity?.pid === pid ? pidIdentity.identity : undefined;
}

/** Captures `pid`'s current identity for a record — what a writer stores beside `record.pid`. */
export function captureRecordPidIdentity(pid: number | undefined): RecordPidIdentity | undefined {
  if (pid === undefined) {
    return undefined;
  }
  const identity = readProcessBirthIdentity(pid);
  return identity ? { pid, identity, host: processHostName() } : undefined;
}
