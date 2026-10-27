import fs from "node:fs";
import path from "node:path";
import { acpAdapterKind } from "../acp/agent-command.js";
import { type Harness, isHarness } from "./constants.js";

/**
 * The live-owner census: lease files → owner pid (verified by start time) → its process tree via
 * `/proc/<pid>/stat` ppid links → Σ (`RssAnon` + `VmPTE`) from `/proc/<pid>/status`
 * (CONCEPTION f7587c86 §3.1, §4.1, §5, §16).
 *
 * 🛑 ONLY `stat` AND `status` ARE READ UNDER /proc — NEVER `cmdline` OR `environ`. An owner's
 * environment carries the credential payload, and its argv can too. The harness is taken from the
 * session RECORD's `agent_command` instead. `test/capacity.test.ts` plants a `cmdline` and an
 * `environ` that would throw if opened and asserts the census never touches them.
 *
 * Owners are identified ONLY through leases, never by process name: one live tree on devbox had no
 * `claude` process at all (a Node-based harness, or an adapter not started yet).
 */

export type OwnerTree = {
  readonly sessionId: string;
  readonly pid: number;
  readonly harness: Harness | "unknown";
  readonly processes: number;
  /** `m_i` = Σ over the tree of RssAnon + VmPTE (page tables go with the session, §4.1). */
  readonly measuredBytes: number;
};

export type LeaseExclusion =
  | "unparsable"
  | "dead"
  | "identity-mismatch"
  | "identity-unverified"
  | "foreign";

export type OwnerCensus = {
  readonly owners: readonly OwnerTree[];
  /** Every `*.lock` in the queue dir — dead owners' leases pile up (372 on devbox, ~10 live). */
  readonly leaseFiles: number;
  /** Those rewritten within the freshness window, i.e. the ones parsed and judged. */
  readonly freshLeases: number;
  readonly excluded: Readonly<Record<LeaseExclusion, number>>;
  readonly warnings: readonly string[];
};

export type CensusInputs = {
  readonly queueDir: string;
  readonly sessionsDir: string;
  readonly procRoot: string;
  readonly nowMs: number;
  readonly freshMs: number;
};

type ProcEntry = { pid: number; ppid: number; startTicks: string };

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

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function readProcessTable(procRoot: string): Map<number, ProcEntry> {
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

type LeaseBody = {
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

/** The harness from the session record's `agent_command`; unknown ⇒ charged the largest floor. */
function harnessForSession(sessionsDir: string, sessionId: string): Harness | "unknown" {
  if (!/^[A-Za-z0-9._-]+$/u.test(sessionId)) {
    return "unknown";
  }
  const command = parseJsonRecord(
    readText(path.join(sessionsDir, `${sessionId}.json`)),
  )?.agent_command;
  const kind = typeof command === "string" ? acpAdapterKind(command) : undefined;
  return kind !== undefined && isHarness(kind) ? kind : "unknown";
}

function listLeaseFiles(queueDir: string): string[] {
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
function freshLeaseFiles(inputs: CensusInputs, names: readonly string[]): string[] {
  return names.filter((name) => {
    try {
      return inputs.nowMs - fs.statSync(path.join(inputs.queueDir, name)).mtimeMs <= inputs.freshMs;
    } catch {
      return false; // reaped between readdir and stat
    }
  });
}

function childrenByParent(table: ReadonlyMap<number, ProcEntry>): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const entry of table.values()) {
    children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry.pid]);
  }
  return children;
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

type TreeWalk = {
  readonly procRoot: string;
  readonly children: ReadonlyMap<number, number[]>;
  /** Pids already attributed — no process is counted for two owners. */
  readonly claimed: Set<number>;
};

function measureTree(walk: TreeWalk, root: number): { processes: number; measuredBytes: number } {
  let measuredBytes = 0;
  let processes = 0;
  const stack = [root];
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    if (walk.claimed.has(pid)) {
      continue;
    }
    walk.claimed.add(pid);
    const status = readText(path.join(walk.procRoot, String(pid), "status"));
    if (status === undefined) {
      continue; // exited mid-walk
    }
    processes += 1;
    measuredBytes += parseStatusMemory(status);
    stack.push(...(walk.children.get(pid) ?? []));
  }
  return { processes, measuredBytes };
}

export function censusOwners(inputs: CensusInputs): OwnerCensus {
  const excluded: Record<LeaseExclusion, number> = {
    unparsable: 0,
    dead: 0,
    "identity-mismatch": 0,
    "identity-unverified": 0,
    foreign: 0,
  };
  const names = listLeaseFiles(inputs.queueDir);
  const fresh = freshLeaseFiles(inputs, names);
  const owners: OwnerTree[] = [];
  const census = { owners, leaseFiles: names.length, freshLeases: fresh.length, excluded };
  if (fresh.length === 0) {
    return { ...census, warnings: [] };
  }

  const table = readProcessTable(inputs.procRoot);
  const ownNamespace = ownPidNamespace(inputs.procRoot);
  const walk: TreeWalk = {
    procRoot: inputs.procRoot,
    children: childrenByParent(table),
    claimed: new Set<number>(),
  };
  for (const name of fresh) {
    const lease = parseLeaseBody(readText(path.join(inputs.queueDir, name)));
    const exclusion = lease ? judgeLease(lease, table, ownNamespace) : "unparsable";
    if (exclusion) {
      excluded[exclusion] += 1;
    } else if (lease && !walk.claimed.has(lease.pid)) {
      owners.push({
        sessionId: lease.sessionId,
        pid: lease.pid,
        harness: harnessForSession(inputs.sessionsDir, lease.sessionId),
        ...measureTree(walk, lease.pid),
      });
    }
  }
  const warnings =
    excluded.unparsable > 0
      ? [`${excluded.unparsable} fresh lease file(s) could not be parsed`]
      : [];
  return { ...census, warnings };
}
