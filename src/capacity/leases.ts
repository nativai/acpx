import fs from "node:fs";
import path from "node:path";

/**
 * The PURE half of the live-owner census (`owners.ts`): lease files → verified owner pids, the
 * `/proc` reads the census needs, and the session record's facts. CONCEPTION f7587c86 §3.1, §5, §16.
 *
 * 🛑 THIS MODULE MUST NOT REACH `node:child_process`, directly or through an import: the process-tree
 * governor (brick 5d7a23b6, §16 "never fork") loads it, and `test/governor-import-graph.test.ts` walks
 * the built governor entry's static import graph and fails on any `child_process`. The harness
 * classifier (`acpAdapterKind`, which pulls `acp/agent-command`) therefore stays in `owners.ts`.
 *
 * 🛑 ONLY `stat` AND `status` ARE READ UNDER /proc — NEVER `cmdline` OR `environ` (owners.ts).
 */

/** What lease verification reads: the queue dir, /proc, and the census's clock and freshness window. */
export type LeaseInputs = {
  readonly queueDir: string;
  readonly procRoot: string;
  readonly nowMs: number;
  readonly freshMs: number;
};

/**
 * The live owner's record fields the wake gate needs: its seat succession (§3.3 — is the target a
 * fresh successor of this live seat-mate?) and its idleness (§3.4 make-room instrumentation). Read
 * by the census's one record parse, root-level snake_case on disk.
 */
export type OwnerRecordFacts = {
  readonly seatId?: string;
  readonly holderOrdinal?: number;
  readonly holderActive?: boolean;
  readonly lastUsedAt?: string;
  readonly lastPromptAt?: string;
};

export type LeaseExclusion =
  | "unparsable"
  | "dead"
  | "identity-mismatch"
  | "identity-unverified"
  | "foreign"
  /** A second fresh lease naming a pid already counted (fresh = live + Σ excluded always holds). */
  | "duplicate-pid";

export type ProcEntry = { pid: number; ppid: number; startTicks: string };

/** `/proc/<pid>/stat`: comm may hold spaces and ')' — fields are parsed after the LAST ')'. */
export function parseProcStat(payload: string): ProcEntry | undefined {
  const prefix = /^(\d+) \(/u.exec(payload);
  const close = payload.lastIndexOf(")");
  if (!prefix || close < 0) {
    return undefined;
  }
  const fields = payload
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  // fields[0] = state (field 3), fields[1] = ppid (field 4), fields[19] = starttime (field 22).
  const ppid = Number(fields[1]);
  const startTicks = fields[19];
  if (!Number.isSafeInteger(ppid) || !startTicks || !/^\d+$/u.test(startTicks)) {
    return undefined;
  }
  return { pid: Number(prefix[1]), ppid, startTicks };
}

/** `RssAnon` + `VmPTE` in bytes. A kernel thread has neither: 0. */
export function parseStatusMemory(payload: string): number {
  let kb = 0;
  for (const key of ["RssAnon", "VmPTE"]) {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "mu").exec(payload);
    if (match) {
      kb += Number(match[1]);
    }
  }
  return kb * 1024;
}

export function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function readProcessTable(procRoot: string): Map<number, ProcEntry> {
  const table = new Map<number, ProcEntry>();
  let names: string[];
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return table;
  }
  for (const name of names) {
    if (!/^\d+$/u.test(name)) {
      continue;
    }
    const raw = readText(path.join(procRoot, name, "stat"));
    const entry = raw === undefined ? undefined : parseProcStat(raw);
    if (entry && entry.pid === Number(name)) {
      table.set(entry.pid, entry);
    }
  }
  return table;
}

function ownPidNamespace(procRoot: string): string | undefined {
  try {
    return fs.readlinkSync(path.join(procRoot, "self", "ns", "pid"));
  } catch {
    return undefined;
  }
}

export type LeaseBody = {
  pid: number;
  sessionId: string;
  startTicks?: string;
  pidNamespace?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Both on-disk identity spellings: the fork's `startTimeTicks` and upstream's `startTicks`. */
function leaseIdentity(raw: unknown): Pick<LeaseBody, "startTicks" | "pidNamespace"> {
  const identity = isRecord(raw) ? raw : {};
  const ticks = identity.startTimeTicks ?? identity.startTicks;
  return {
    startTicks: typeof ticks === "string" && /^\d+$/u.test(ticks) ? ticks : undefined,
    pidNamespace: typeof identity.pidNamespace === "string" ? identity.pidNamespace : undefined,
  };
}

/** The lease body (`src/cli/queue/lease-store.ts` `leasePayload`). */
export function parseLeaseBody(raw: string | undefined): LeaseBody | undefined {
  const parsed = parseJsonRecord(raw);
  if (!parsed || !isPid(parsed.pid)) {
    return undefined;
  }
  const { sessionId } = parsed;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return undefined;
  }
  return { pid: parsed.pid, sessionId, ...leaseIdentity(parsed.processIdentity) };
}

const stringField = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export function factsOf(record: Record<string, unknown>): OwnerRecordFacts {
  const ordinal = record.holder_ordinal;
  return {
    seatId: stringField(record.seat_id),
    holderOrdinal: typeof ordinal === "number" && Number.isFinite(ordinal) ? ordinal : undefined,
    holderActive: typeof record.holder_active === "boolean" ? record.holder_active : undefined,
    lastUsedAt: stringField(record.last_used_at),
    lastPromptAt: stringField(record.last_prompt_at),
  };
}

export function listLeaseFiles(queueDir: string): string[] {
  try {
    return fs.readdirSync(queueDir).filter((name) => name.endsWith(".lock"));
  } catch {
    return [];
  }
}

/**
 * The mtime prefilter: a stat-only pass costs ~6 ms where parsing all 372 leases on devbox cost
 * 122–530 ms (§5). The window is generous (5 min) — a stale heartbeat is not a dead process.
 */
export function freshLeaseFiles(inputs: LeaseInputs, names: readonly string[]): string[] {
  return names.filter((name) => {
    try {
      return inputs.nowMs - fs.statSync(path.join(inputs.queueDir, name)).mtimeMs <= inputs.freshMs;
    } catch {
      return false; // reaped between readdir and stat
    }
  });
}

/** Why a parsed lease does NOT name a live owner here, or undefined when it does. */
function judgeLease(
  lease: LeaseBody,
  table: ReadonlyMap<number, ProcEntry>,
  ownNamespace: string | undefined,
): LeaseExclusion | undefined {
  // A pid names a process only inside ONE pid namespace (src/process-identity.ts): a lease
  // written in another pod, or by a previous container, says nothing about the pid here.
  if (lease.pidNamespace && ownNamespace && lease.pidNamespace !== ownNamespace) {
    return "foreign";
  }
  const entry = table.get(lease.pid);
  if (!entry) {
    return "dead";
  }
  if (lease.startTicks === undefined) {
    return "identity-unverified";
  }
  return entry.startTicks === lease.startTicks ? undefined : "identity-mismatch";
}

/** Pass 1: every fresh lease judged; the verified ones, one per pid, in a stable order. */
export function verifiedLeases(
  inputs: LeaseInputs,
  fresh: readonly string[],
  table: ReadonlyMap<number, ProcEntry>,
  excluded: Record<LeaseExclusion, number>,
): LeaseBody[] {
  const ownNamespace = ownPidNamespace(inputs.procRoot);
  const byPid = new Map<number, LeaseBody>();
  for (const name of fresh) {
    const lease = parseLeaseBody(readText(path.join(inputs.queueDir, name)));
    const exclusion = lease ? judgeLease(lease, table, ownNamespace) : "unparsable";
    if (exclusion) {
      excluded[exclusion] += 1;
    } else if (lease && byPid.has(lease.pid)) {
      excluded["duplicate-pid"] += 1;
    } else if (lease) {
      byPid.set(lease.pid, lease);
    }
  }
  return [...byPid.values()].toSorted((a, b) => a.pid - b.pid);
}

/** The session record `<sessionsDir>/<id>.json`, parsed; undefined for an unsafe id or no record. */
export function readSessionRecord(
  sessionsDir: string,
  sessionId: string,
): Record<string, unknown> | undefined {
  if (!/^[A-Za-z0-9._-]+$/u.test(sessionId)) {
    return undefined;
  }
  return parseJsonRecord(readText(path.join(sessionsDir, `${sessionId}.json`)));
}

export function emptyExclusions(): Record<LeaseExclusion, number> {
  return {
    unparsable: 0,
    dead: 0,
    "identity-mismatch": 0,
    "identity-unverified": 0,
    foreign: 0,
    "duplicate-pid": 0,
  };
}

export type LeaseOwner = {
  readonly pid: number;
  readonly sessionId: string;
  readonly seatId?: string;
};

/**
 * The verified live queue owners (pid + start ticks + pid namespace, exactly the census's judgement)
 * and each one's seat from its record — what the governor needs, without the harness classifier or the
 * process-tree measurement.
 */
export function verifiedLeaseOwners(
  inputs: LeaseInputs & { readonly sessionsDir: string },
): LeaseOwner[] {
  const fresh = freshLeaseFiles(inputs, listLeaseFiles(inputs.queueDir));
  if (fresh.length === 0) {
    return [];
  }
  const table = readProcessTable(inputs.procRoot);
  return verifiedLeases(inputs, fresh, table, emptyExclusions()).map((lease) => {
    const record = readSessionRecord(inputs.sessionsDir, lease.sessionId);
    return {
      pid: lease.pid,
      sessionId: lease.sessionId,
      seatId: record ? factsOf(record).seatId : undefined,
    };
  });
}

/**
 * UMQ D1 / R12 — is the READING process inside a live queue owner's process tree?
 *
 * The census answers this as `OwnerTree.self` (`owners.ts`), but only after reading the whole `/proc`
 * table and measuring every owner's tree. This answers the same boolean from the reader's own
 * ANCESTRY: a reader is in an owner's walked tree iff that owner's pid is among its ancestors (the
 * walk starts at the owner and descends through `ppid` links, never past another owner — and the
 * nearest owner ancestor is the one that matters). So only the ancestors' `stat` files are read, and
 * the leases are judged by the SAME `judgeLease` (pid namespace, start ticks) against that partial
 * table. Row "owner tree: the ancestry check agrees with the census" in test/prompt-routing.test.ts.
 */
export function readerIsInsideLiveOwnerTree(inputs: LeaseInputs): boolean {
  const fresh = freshLeaseFiles(inputs, listLeaseFiles(inputs.queueDir));
  if (fresh.length === 0) {
    return false;
  }
  const ancestors = readerAncestry(inputs.procRoot);
  if (ancestors.size === 0) {
    return false;
  }
  const owners = verifiedLeases(inputs, fresh, ancestors, emptyExclusions());
  return owners.some((owner) => ancestors.has(owner.pid));
}

/** The reader's ancestors (never the reader itself), by `stat`: pid → entry, nearest first. */
function readerAncestry(procRoot: string): Map<number, ProcEntry> {
  const table = new Map<number, ProcEntry>();
  const reader = readerPid(procRoot);
  let entry = reader === undefined ? undefined : readStat(procRoot, reader);
  for (let hops = 0; entry !== undefined && entry.ppid > 0 && hops < 64; hops += 1) {
    entry = table.has(entry.ppid) ? undefined : readStat(procRoot, entry.ppid);
    if (entry) {
      table.set(entry.pid, entry);
    }
  }
  return table;
}

function readStat(procRoot: string, pid: number): ProcEntry | undefined {
  const raw = readText(path.join(procRoot, String(pid), "stat"));
  const entry = raw === undefined ? undefined : parseProcStat(raw);
  return entry?.pid === pid ? entry : undefined;
}

function readerPid(procRoot: string): number | undefined {
  try {
    const link = fs.readlinkSync(path.join(procRoot, "self"));
    return /^\d+$/u.test(link) ? Number(link) : undefined;
  } catch {
    return process.pid;
  }
}
