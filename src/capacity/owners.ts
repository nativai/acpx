import fs from "node:fs";
import path from "node:path";
import { acpAdapterKind } from "../acp/agent-command.js";
import { type Harness, isHarness } from "./constants.js";
import {
  factsOf,
  freshLeaseFiles,
  type LeaseExclusion,
  listLeaseFiles,
  type OwnerRecordFacts,
  type ProcEntry,
  parseStatusMemory,
  readProcessTable,
  readSessionRecord,
  readText,
  verifiedLeases,
} from "./leases.js";

// The lease and record pieces live in `leases.ts`, which imports no `node:child_process` path, so the
// process-tree governor can use them without this module's harness classifier (`acpAdapterKind` →
// `acp/agent-command`). Re-exported unchanged for every existing caller.
export {
  type LeaseExclusion,
  type OwnerRecordFacts,
  parseLeaseBody,
  parseProcStat,
  parseStatusMemory,
} from "./leases.js";

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
  /** True for the owner whose tree holds the reading process — the CALLER's own session. */
  readonly self: boolean;
  /**
   * A pending reservation for this session that is still within its TTL (§5): the owner is charged
   * `max(r_live, m, reserved)`, so a fresh owner keeps its newcomer reservation while it ramps up
   * instead of dropping to its first-second ~50 MiB (§9).
   */
  readonly reservedBytes?: number;
  /** From the same record read as the harness (brick 2b3b259f §3.3, §3.4); absent when unreadable. */
  readonly facts?: OwnerRecordFacts;
};

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
  /** Never attributed to any owner: the reading process itself ({@link readReaderFootprint}). */
  readonly readerPid?: number;
};

/**
 * The reading process ITSELF — `acpx capacity`, a ~50 MiB node process that sits inside the cgroup
 * and inside its caller's owner tree while it measures. Left in, it inflates committed memory by
 * ~15 % on a 2 GiB box (devbox-staging, 2026-10-27: 416 MB read vs 361 MB by hand) and charges the
 * calling agent's owner for the instrument. It is gone the moment the reading is printed, so it is
 * measured here and taken out of both. Fixture trees have no `self` link: nothing is excluded.
 */
export type ReaderFootprint = { readonly pid: number | undefined; readonly bytes: number };

export function readReaderFootprint(procRoot: string): ReaderFootprint {
  let pid: number | undefined;
  try {
    const link = fs.readlinkSync(path.join(procRoot, "self"));
    pid = /^\d+$/u.test(link) ? Number(link) : undefined;
  } catch {
    return { pid: undefined, bytes: 0 };
  }
  const status =
    pid === undefined ? undefined : readText(path.join(procRoot, String(pid), "status"));
  return { pid, bytes: status === undefined ? 0 : parseStatusMemory(status) };
}

/**
 * The harness from the session record's `agent_command` (unknown ⇒ charged the largest floor), and
 * the record's seat and idleness facts — one read.
 */
function recordOfSession(
  sessionsDir: string,
  sessionId: string,
): { harness: Harness | "unknown"; facts?: OwnerRecordFacts } {
  const record = readSessionRecord(sessionsDir, sessionId);
  if (!record) {
    return { harness: "unknown" };
  }
  const command = record.agent_command;
  const kind = typeof command === "string" ? acpAdapterKind(command) : undefined;
  return {
    harness: kind !== undefined && isHarness(kind) ? kind : "unknown",
    facts: factsOf(record),
  };
}

function childrenByParent(table: ReadonlyMap<number, ProcEntry>): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const entry of table.values()) {
    children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry.pid]);
  }
  return children;
}

type TreeWalk = {
  readonly procRoot: string;
  readonly children: ReadonlyMap<number, number[]>;
  /** Every verified owner pid: a walk never descends into ANOTHER owner's subtree. */
  readonly ownerPids: ReadonlySet<number>;
  /** The reading process — never attributed; finding it marks the walked tree as the caller's. */
  readonly readerPid: number | undefined;
  /** Pids already attributed — no process is counted for two owners. */
  readonly claimed: Set<number>;
};

type TreeMeasure = { processes: number; measuredBytes: number; self: boolean };

/**
 * One owner's tree, stopping at every OTHER owner's pid. An agent's blocking `acpx prompt` spawns
 * the child's queue owner under the waiting CLI, i.e. INSIDE the agent's own owner tree, for the
 * length of that turn (TE finding D3, devbox 2026-10-27). That nested owner is its own owner with its
 * own floor charge: the outer tree must exclude its subtree, whichever lease is read first.
 */
/** Push `pid`'s children that belong to THIS tree; true when one of them is the reader. */
function descend(walk: TreeWalk, pid: number, stack: number[]): boolean {
  let sawReader = false;
  for (const child of walk.children.get(pid) ?? []) {
    if (child === walk.readerPid) {
      sawReader = true;
    } else if (!walk.ownerPids.has(child)) {
      stack.push(child);
    }
  }
  return sawReader;
}

function measureTree(walk: TreeWalk, root: number): TreeMeasure {
  const result: TreeMeasure = { processes: 0, measuredBytes: 0, self: false };
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
    result.processes += 1;
    result.measuredBytes += parseStatusMemory(status);
    // ⚠️ DO NOT FOLD THIS INTO `result.self ||= descend(…)`. `||=` short-circuits: once the walk
    // has met the reader, `descend` would never run again and every not-yet-expanded branch of the
    // CALLER's own tree is silently dropped (TE D4: a blocking `acpx prompt`, 87 MiB, vanished).
    // Row "owners D4: a branch expanded AFTER the reader is still counted".
    const sawReader = descend(walk, pid, stack);
    result.self ||= sawReader;
  }
  return result;
}

export function censusOwners(inputs: CensusInputs): OwnerCensus {
  const excluded: Record<LeaseExclusion, number> = {
    unparsable: 0,
    dead: 0,
    "identity-mismatch": 0,
    "identity-unverified": 0,
    foreign: 0,
    "duplicate-pid": 0,
  };
  const names = listLeaseFiles(inputs.queueDir);
  const fresh = freshLeaseFiles(inputs, names);
  const census = { leaseFiles: names.length, freshLeases: fresh.length, excluded };
  if (fresh.length === 0) {
    return { ...census, owners: [], warnings: [] };
  }

  const table = readProcessTable(inputs.procRoot);
  const leases = verifiedLeases(inputs, fresh, table, excluded);
  const walk: TreeWalk = {
    procRoot: inputs.procRoot,
    children: childrenByParent(table),
    ownerPids: new Set(leases.map((lease) => lease.pid)),
    readerPid: inputs.readerPid,
    claimed: new Set<number>(),
  };
  // Pass 2: each owner measured separately — no order dependence between leases.
  const owners: OwnerTree[] = leases.map((lease) => {
    const tree = measureTree(walk, lease.pid);
    const { harness, facts } = recordOfSession(inputs.sessionsDir, lease.sessionId);
    return {
      sessionId: lease.sessionId,
      pid: lease.pid,
      harness,
      processes: tree.processes,
      measuredBytes: tree.measuredBytes,
      self: tree.self,
      facts,
    };
  });
  const warnings =
    excluded.unparsable > 0
      ? [`${excluded.unparsable} fresh lease file(s) could not be parsed`]
      : [];
  return { ...census, owners, warnings };
}
