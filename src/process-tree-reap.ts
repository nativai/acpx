import fs from "node:fs";

/**
 * brick ad6ba1c2 — reap a session's process tree, including the task processes
 * that a process-group kill can never reach.
 *
 * WHY NOT A PROCESS-GROUP KILL. Claude Code runs every Bash and Monitor command in
 * a `detached:true` (setsid) shell: a NEW session and group under `claude`, outside
 * the queue owner's group by construction. The command inside sits in a THIRD
 * process group (bash job control), so even `kill(-shellPgid)` misses it. Only the
 * SESSION ID ties the command to its shell (measured, CONCEPTION §3 / REPRODUCTION).
 * So the reap identifies the tree by a /proc descendant walk PLUS session id.
 *
 * WHY THESE RULES ARE SAFE:
 *   - Snapshot BEFORE anything is ended, kill by verified pid AFTER. Every signal
 *     re-reads `/proc/<pid>/stat` start ticks immediately before `kill`, so a reused
 *     pid number is never signalled.
 *   - A sid's members are collected only while the session LEADER is verified alive
 *     (pid === sid, same start ticks). A sid number stays allocated while any member
 *     lives, but once the leader is gone and every member died the number can be
 *     reused by an unrelated session; the leader check closes that.
 *   - A nested acpx queue owner (an agent in this session ran `acpx prompt` / `sessions
 *     new` for ANOTHER session) is a descendant while its spawning CLI lives. It is
 *     pruned by the argv token `__queue-owner`, matched and never printed (D12).
 *
 * 🛑 NEVER LOG ARGV OR ENVIRON from here. `comm` (the kernel's 15-byte name) is the
 * only process label this module ever returns.
 *
 * `measured:false` means NOT MEASURED, never "nothing is running" — the doctrine of
 * `process-population.ts`. Every consumer branches on `measured` first.
 */

export type ProcEntry = {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  state: string;
  startTicks: string;
  comm: string;
};

export type ProcScan = { measured: boolean; byPid: Map<number, ProcEntry> };

export type ReapSkipReason =
  | "no-owner"
  | "foreign-owner"
  | "identity-unverified"
  | "owner-survived"
  | "self-close"
  | "not-linux";

export type TaskSessionMemo = {
  sid: number;
  leaderStartTicks?: string;
  members: Array<{ pid: number; startTicks: string }>;
};

export type ReapMember = {
  pid: number;
  pgid: number;
  startTicks: string;
  comm: string;
  inTaskSession: boolean;
};

export type ReapSnapshot = {
  measured: boolean;
  skipped?: ReapSkipReason;
  members: ReapMember[];
  taskSessions: TaskSessionMemo[];
  /** pids never to signal: the reaper itself, its ancestors, pid 1. Carried for the re-collection. */
  exclude: ReadonlySet<number>;
  /** Members in this process group are never signalled (the owner side, CONCEPTION §5.2 E/G). */
  spareProcessGroup?: number;
  procRoot: string;
};

export type SurvivorDetail = { pid: number; comm: string; startTicks: string };

/** The `reap` object of the CLI JSON (Contract C2). */
export type ReapSummary = {
  measured: boolean;
  taskProcesses: number;
  survivors: number;
  survivorPids: number[];
  skipped?: ReapSkipReason;
};

export type ReapReport = ReapSummary & { survivorDetails: SurvivorDetail[] };

export type Signaller = (pid: number, signal: NodeJS.Signals) => void;

const DEFAULT_PROC_ROOT = "/proc";
const REAP_POLL_MS = 100;
export const REAP_GRACE_MS = 1_500;
export const REAP_KILL_WAIT_MS = 200;
const QUEUE_OWNER_ARGV_TOKEN = "\0__queue-owner";

const realSignaller: Signaller = (pid, signal) => {
  process.kill(pid, signal);
};

const DIGITS = /^\d+$/;

function positiveInt(value: string | undefined): number | undefined {
  return value !== undefined && DIGITS.test(value) && Number(value) > 0 ? Number(value) : undefined;
}

/** `/proc/<pid>/stat` → entry. `comm` may hold spaces and ')': fields are parsed after the LAST ')'. */
export function parseProcStat(payload: string): ProcEntry | undefined {
  const open = payload.indexOf(" (");
  const close = payload.lastIndexOf(")");
  if (open < 0 || close < open) {
    return undefined;
  }
  const fields = payload
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  const ids = [payload.slice(0, open), fields[1], fields[2], fields[3]].map(positiveInt);
  const startTicks = fields[19] ?? "";
  // ppid, pgid and sid are 0 for kernel threads: those are no reap's business.
  if (ids.some((id) => id === undefined) || !DIGITS.test(startTicks)) {
    return undefined;
  }
  const [pid, ppid, pgid, sid] = ids as number[];
  return {
    pid,
    ppid,
    pgid,
    sid,
    state: fields[0],
    startTicks,
    comm: payload.slice(open + 2, close),
  };
}

function readEntry(procRoot: string, pid: number): ProcEntry | undefined {
  try {
    const entry = parseProcStat(fs.readFileSync(`${procRoot}/${pid}/stat`, "utf8"));
    return entry?.pid === pid ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** Running, sleeping, stopped… — anything but a zombie or a dead task is a live process. */
function isLiveState(state: string): boolean {
  return state !== "Z" && state !== "X" && state !== "x";
}

/** The process at `pid` is still the one born at `startTicks`, and not a zombie. */
function isSameLiveProcess(procRoot: string, pid: number, startTicks: string): boolean {
  const entry = readEntry(procRoot, pid);
  return entry !== undefined && entry.startTicks === startTicks && isLiveState(entry.state);
}

function listProcNames(procRoot: string): string[] | undefined {
  try {
    return fs.readdirSync(procRoot);
  } catch {
    return undefined;
  }
}

/**
 * One synchronous pass over `/proc/[0-9]*`. Unmeasured when the directory cannot be read,
 * nothing parses, or (on the real `/proc`) the scan does not contain this process — a /proc
 * that is not our own pid namespace's names nothing we may signal.
 */
export function scanProcTable(procRoot: string = DEFAULT_PROC_ROOT): ProcScan {
  const realProc = procRoot === DEFAULT_PROC_ROOT;
  if (realProc && process.platform !== "linux") {
    return { measured: false, byPid: new Map() };
  }
  const byPid = readAllEntries(procRoot);
  const selfSeen = !realProc || byPid.has(process.pid);
  return { measured: byPid.size > 0 && selfSeen, byPid };
}

function readAllEntries(procRoot: string): Map<number, ProcEntry> {
  const byPid = new Map<number, ProcEntry>();
  for (const name of listProcNames(procRoot) ?? []) {
    const entry = DIGITS.test(name) ? readEntry(procRoot, Number(name)) : undefined;
    if (entry) {
      byPid.set(entry.pid, entry);
    }
  }
  return byPid;
}

/** Default nested-owner test: the process's argv carries `__queue-owner`. Match only, never print. */
export function argvCarriesQueueOwnerToken(pid: number, procRoot = DEFAULT_PROC_ROOT): boolean {
  try {
    const cmdline = fs.readFileSync(`${procRoot}/${pid}/cmdline`, "latin1");
    const at = cmdline.indexOf(QUEUE_OWNER_ARGV_TOKEN);
    if (at < 0) {
      return false;
    }
    const after = cmdline.charAt(at + QUEUE_OWNER_ARGV_TOKEN.length);
    return after === "" || after === "\0";
  } catch {
    return false;
  }
}

function childrenByParent(scan: ProcScan): Map<number, ProcEntry[]> {
  const children = new Map<number, ProcEntry[]>();
  for (const entry of scan.byPid.values()) {
    const list = children.get(entry.ppid);
    if (list) {
      list.push(entry);
    } else {
      children.set(entry.ppid, [entry]);
    }
  }
  return children;
}

type WalkInput = {
  root: ProcEntry | undefined;
  scan: ProcScan;
  exclude: ReadonlySet<number>;
  isNestedOwner: (pid: number) => boolean;
};

/** D12: a nested queue owner is a session leader whose argv carries the owner token. */
function isPrunedOwner(entry: ProcEntry, isNestedOwner: (pid: number) => boolean): boolean {
  return entry.pid === entry.sid && isNestedOwner(entry.pid);
}

/** BFS over ppid from the root. A nested owner (a session leader whose argv says so) is never entered. */
function walkTree({ root, scan, exclude, isNestedOwner }: WalkInput): ProcEntry[] {
  if (!root) {
    return [];
  }
  const children = childrenByParent(scan);
  const tree: ProcEntry[] = [];
  const queue = [root];
  const seen = new Set<number>([root.pid]);
  while (queue.length > 0) {
    const node = queue.shift() as ProcEntry;
    tree.push(node);
    for (const child of children.get(node.pid) ?? []) {
      if (!seen.has(child.pid) && !exclude.has(child.pid) && !isPrunedOwner(child, isNestedOwner)) {
        queue.push(child);
      }
      seen.add(child.pid);
    }
  }
  return tree;
}

function leaderAlive(scan: ProcScan, memo: TaskSessionMemo): boolean {
  const leader = scan.byPid.get(memo.sid);
  return (
    leader !== undefined &&
    leader.sid === memo.sid &&
    isLiveState(leader.state) &&
    (memo.leaderStartTicks === undefined || leader.startTicks === memo.leaderStartTicks)
  );
}

function memoKey(memo: TaskSessionMemo): string {
  return `${memo.sid}:${memo.leaderStartTicks ?? ""}`;
}

/** Union of memo lists, deduplicated by sid + leader start ticks; members are merged. */
export function mergeTaskSessions(
  left: readonly TaskSessionMemo[],
  right: readonly TaskSessionMemo[],
): TaskSessionMemo[] {
  const merged = new Map<string, TaskSessionMemo>();
  for (const memo of [...left, ...right]) {
    const key = memoKey(memo);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...memo, members: [...memo.members] });
      continue;
    }
    for (const member of memo.members) {
      if (
        !existing.members.some((m) => m.pid === member.pid && m.startTicks === member.startTicks)
      ) {
        existing.members.push(member);
      }
    }
  }
  return [...merged.values()];
}

/** Drops memos none of whose members (leader included) is alive any more. */
export function pruneDeadTaskSessions(
  memos: readonly TaskSessionMemo[],
  procRoot: string = DEFAULT_PROC_ROOT,
): TaskSessionMemo[] {
  return memos.filter((memo) =>
    memo.members.some((m) => isSameLiveProcess(procRoot, m.pid, m.startTicks)),
  );
}

function taskSessionsOf(tree: ProcEntry[], rootSid: number | undefined, scan: ProcScan) {
  const memos = new Map<number, TaskSessionMemo>();
  for (const node of tree) {
    if (node.sid === rootSid || node.sid <= 1) {
      continue;
    }
    const leader = scan.byPid.get(node.sid);
    const memo = memos.get(node.sid) ?? {
      sid: node.sid,
      ...(leader && leader.sid === node.sid ? { leaderStartTicks: leader.startTicks } : {}),
      members: [],
    };
    memo.members.push({ pid: node.pid, startTicks: node.startTicks });
    memos.set(node.sid, memo);
  }
  return [...memos.values()];
}

type CollectInput = {
  scan: ProcScan;
  tree: ProcEntry[];
  taskSessions: TaskSessionMemo[];
  exclude: ReadonlySet<number>;
};

function addMember(into: Map<number, ReapMember>, entry: ProcEntry, inTaskSession: boolean) {
  if (!into.has(entry.pid) && isLiveState(entry.state)) {
    into.set(entry.pid, {
      pid: entry.pid,
      pgid: entry.pgid,
      startTicks: entry.startTicks,
      comm: entry.comm,
      inTaskSession,
    });
  }
}

function addLiveSessionMembers(
  into: Map<number, ReapMember>,
  scan: ProcScan,
  taskSessions: TaskSessionMemo[],
): void {
  const liveSids = new Set(
    taskSessions.filter((memo) => leaderAlive(scan, memo)).map((memo) => memo.sid),
  );
  for (const entry of scan.byPid.values()) {
    if (liveSids.has(entry.sid)) {
      addMember(into, entry, true);
    }
  }
}

function addRememberedMembers(
  into: Map<number, ReapMember>,
  scan: ProcScan,
  taskSessions: TaskSessionMemo[],
): void {
  for (const remembered of taskSessions.flatMap((memo) => memo.members)) {
    const entry = scan.byPid.get(remembered.pid);
    if (entry?.startTicks === remembered.startTicks) {
      addMember(into, entry, true);
    }
  }
}

function isNeverSignalled(pid: number, exclude: ReadonlySet<number>): boolean {
  return exclude.has(pid) || pid <= 1 || pid === process.pid;
}

/** Tree nodes, every live member of a verified-alive task session, and remembered members still alive. */
function collectMembers({ scan, tree, taskSessions, exclude }: CollectInput): ReapMember[] {
  const sids = new Set(taskSessions.map((memo) => memo.sid));
  const members = new Map<number, ReapMember>();
  for (const node of tree) {
    addMember(members, node, sids.has(node.sid));
  }
  addLiveSessionMembers(members, scan, taskSessions);
  addRememberedMembers(members, scan, taskSessions);
  return [...members.values()].filter((member) => !isNeverSignalled(member.pid, exclude));
}

const MAX_ANCESTRY_DEPTH = 64;

/** This process and its ppid chain (bounded), so a reaper never signals what runs it. */
function addSelfAncestry(scan: ProcScan, into: Set<number>): void {
  let pid = process.pid;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH && pid > 1; depth += 1) {
    into.add(pid);
    const entry = scan.byPid.get(pid);
    if (!entry) {
      return;
    }
    pid = entry.ppid;
  }
}

export type SnapshotInput = {
  /** The owner (closer side and owner side) or the OLD adapter (a client switch). */
  rootPid: number | undefined;
  rootStartTicks?: string;
  /** false on the owner side: an owner never signals itself early. */
  includeRoot: boolean;
  /** Owner side only (§5.4): task sessions seen earlier, which may have left the tree since. */
  remembered?: readonly TaskSessionMemo[];
  /** pids never to enter or signal. pid 1 and this process are always excluded. */
  exclude?: ReadonlySet<number>;
  /** Closer side (§5.3): also exclude this process's whole ancestor chain, read from the same scan. */
  excludeSelfAncestry?: boolean;
  /** Members in this process group are never signalled — the owner's own group (§5.2 E, G). */
  spareProcessGroup?: number;
  isNestedOwner?: (pid: number) => boolean;
  procRoot?: string;
};

function resolveRoot(scan: ProcScan, input: SnapshotInput): ProcEntry | undefined {
  const candidate = input.rootPid !== undefined ? scan.byPid.get(input.rootPid) : undefined;
  if (!candidate) {
    return undefined;
  }
  return input.rootStartTicks === undefined || candidate.startTicks === input.rootStartTicks
    ? candidate
    : undefined;
}

function inSparedGroup(member: { pgid: number }, spareProcessGroup: number | undefined): boolean {
  return spareProcessGroup !== undefined && member.pgid === spareProcessGroup;
}

function measuredSnapshot(scan: ProcScan, input: SnapshotInput, base: SnapshotBase): ReapSnapshot {
  if (input.excludeSelfAncestry) {
    addSelfAncestry(scan, base.exclude);
  }
  const root = resolveRoot(scan, input);
  const isNestedOwner =
    input.isNestedOwner ?? ((pid: number) => argvCarriesQueueOwnerToken(pid, base.procRoot));
  const tree = walkTree({ root, scan, exclude: base.exclude, isNestedOwner });
  const taskSessions = mergeTaskSessions(
    taskSessionsOf(tree, root?.sid, scan),
    input.remembered ?? [],
  );
  const nodes = input.includeRoot ? tree : tree.filter((node) => node !== root);
  const members = collectMembers({ scan, tree: nodes, taskSessions, exclude: base.exclude }).filter(
    (member) => !inSparedGroup(member, input.spareProcessGroup),
  );
  return { ...base, measured: true, members, taskSessions };
}

type SnapshotBase = Pick<ReapSnapshot, "procRoot" | "spareProcessGroup"> & { exclude: Set<number> };

/** One synchronous scan: who belongs to this session's tree right now (CONCEPTION §5.1). */
export function snapshotSessionTree(input: SnapshotInput): ReapSnapshot {
  const procRoot = input.procRoot ?? DEFAULT_PROC_ROOT;
  const base: SnapshotBase = {
    exclude: new Set(input.exclude ?? []),
    procRoot,
    spareProcessGroup: input.spareProcessGroup,
  };
  const empty = { ...base, measured: false, members: [], taskSessions: [] };
  if (procRoot === DEFAULT_PROC_ROOT && process.platform !== "linux") {
    return { ...empty, skipped: "not-linux" };
  }
  const scan = scanProcTable(procRoot);
  // /proc could not be censused here: nothing it names may be signalled or claimed absent.
  return scan.measured
    ? measuredSnapshot(scan, input, base)
    : { ...empty, skipped: "identity-unverified" };
}

/**
 * Re-collects the snapshot's members against a fresh scan: snapshot members still alive with the
 * same start ticks, plus every member of a task session whose leader is verified alive (a fork
 * during the grace period, or a command moved to its own group).
 */
function currentMembers(snapshot: ReapSnapshot): ReapMember[] {
  const scan = scanProcTable(snapshot.procRoot);
  if (!scan.measured) {
    return snapshot.members.filter((m) =>
      isSameLiveProcess(snapshot.procRoot, m.pid, m.startTicks),
    );
  }
  const alive = snapshot.members.filter((member) => {
    const entry = scan.byPid.get(member.pid);
    return (
      entry !== undefined && entry.startTicks === member.startTicks && isLiveState(entry.state)
    );
  });
  const fresh = collectMembers({
    scan,
    tree: [],
    taskSessions: snapshot.taskSessions,
    exclude: snapshot.exclude,
  });
  const byPid = new Map(alive.map((member) => [member.pid, member]));
  for (const member of fresh) {
    if (!byPid.has(member.pid) && !inSparedGroup(member, snapshot.spareProcessGroup)) {
      byPid.set(member.pid, member);
    }
  }
  return [...byPid.values()];
}

/**
 * Sends `signal` to every current member, each re-verified (start ticks) immediately before its
 * `kill`. Synchronous and never throws — safe inside the owner's signal handler. Returns the count
 * signalled.
 */
export function signalSnapshot(
  snapshot: ReapSnapshot,
  signal: NodeJS.Signals,
  signaller: Signaller = realSignaller,
): number {
  if (!snapshot.measured) {
    return 0;
  }
  let signalled = 0;
  try {
    for (const member of currentMembers(snapshot)) {
      if (!isSameLiveProcess(snapshot.procRoot, member.pid, member.startTicks)) {
        continue;
      }
      try {
        signaller(member.pid, signal);
        signalled += 1;
      } catch {
        // ESRCH (it just exited) or EPERM: the survivor census below is the truth.
      }
    }
  } catch {
    // Never throw from a reap: a teardown that wedges is worse than a reported survivor.
  }
  return signalled;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The members still alive (same start ticks, not a zombie). */
export function liveMembers(snapshot: ReapSnapshot): ReapMember[] {
  return snapshot.measured ? currentMembers(snapshot) : [];
}

export function unmeasuredReap(skipped?: ReapSkipReason): ReapReport {
  return {
    measured: false,
    taskProcesses: 0,
    survivors: 0,
    survivorPids: [],
    survivorDetails: [],
    ...(skipped ? { skipped } : {}),
  };
}

/** Polls every 100 ms; true once no member is alive, false at the deadline. */
async function waitForMembersToExit(snapshot: ReapSnapshot, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  while (liveMembers(snapshot).length > 0) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(REAP_POLL_MS);
  }
  return true;
}

/**
 * SIGTERM all members → poll every 100 ms up to `graceMs` → SIGKILL the rest → wait `killWaitMs`
 * → census. `taskProcesses` counts the snapshot's members in a task session; `survivors` are the
 * members (any) still alive after the SIGKILL.
 */
export async function reapSnapshot(
  snapshot: ReapSnapshot,
  options: { graceMs?: number; killWaitMs?: number; signal?: Signaller } = {},
): Promise<ReapReport> {
  if (!snapshot.measured) {
    return unmeasuredReap(snapshot.skipped);
  }
  const signaller = options.signal ?? realSignaller;
  const taskProcesses = snapshot.members.filter((member) => member.inTaskSession).length;
  signalSnapshot(snapshot, "SIGTERM", signaller);
  if (!(await waitForMembersToExit(snapshot, options.graceMs ?? REAP_GRACE_MS))) {
    signalSnapshot(snapshot, "SIGKILL", signaller);
    await sleep(options.killWaitMs ?? REAP_KILL_WAIT_MS);
  }
  return reportFromSurvivors(taskProcesses, liveMembers(snapshot));
}

export function reportFromSurvivors(taskProcesses: number, survivors: ReapMember[]): ReapReport {
  return {
    measured: true,
    taskProcesses,
    survivors: survivors.length,
    survivorPids: survivors.map((member) => member.pid),
    survivorDetails: survivors.map(({ pid, comm, startTicks }) => ({ pid, comm, startTicks })),
  };
}

/** The Contract C2 `reap` object — what goes on the wire (no comm, no start ticks). */
export function publicReap(report: ReapReport): ReapSummary {
  return {
    measured: report.measured,
    taskProcesses: report.measured ? report.taskProcesses : 0,
    survivors: report.measured ? report.survivors : 0,
    survivorPids: report.measured ? report.survivorPids : [],
    ...(!report.measured && report.skipped ? { skipped: report.skipped } : {}),
  };
}

/** `pid 123 (sleep, start 4567), …` — comm only, never argv. */
export function formatSurvivors(details: readonly SurvivorDetail[]): string {
  return details
    .map((detail) => `pid ${detail.pid} (${detail.comm}, start ${detail.startTicks})`)
    .join(", ");
}
