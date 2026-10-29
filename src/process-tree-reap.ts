import fs from "node:fs";

/**
 * brick ad6ba1c2 (CONCEPTION v3 §5.1) — end a session's BACKGROUND-TASK processes, including the
 * ones a process-group kill can never reach.
 *
 * WHY NOT A PROCESS-GROUP KILL. Claude Code runs every Bash and Monitor command in a setsid shell: a
 * NEW session outside the queue owner's group, with the command in a THIRD group (job control). Only
 * the SESSION ID ties the command to its shell.
 *
 * ⚠️ WHY PROOF AND NOT POSITION (v3). FOREGROUND Bash calls are setsid sessions under `claude` too,
 * and a deliberate daemon a foreground call started (`nohup … &`) lives in that call's session. v2
 * admitted every session under `claude` and killed such daemons on a release of a STILL-OPEN session
 * (TE ADV-DAEMON). So a process is reaped only when it is PROVABLY a background task's:
 *   - Proof F: it holds an fd open for WRITING on `…/claude-<uid>/…/<S>/tasks/<taskId>.output` with
 *     `taskId` in the live background set. Foreground calls hold their own ids, never in the set.
 *   - Proof M: a Monitor shell — session leader, a shell `comm`, fd 1 a socket, its
 *     `CLAUDE_CODE_SESSION_ID` equal to S, and its argv containing a live Monitor's command.
 *   Both are session-unique (S), so they hold box-wide: a task orphaned by a `claude` crash still
 *   proves itself (path I), with no remembered state.
 *
 * ADMISSION happens once, at snapshot time, before anything is ended. FOLLOW then tracks every
 * admitted session by sid for the WHOLE reap, leader alive or not, so a `sleep` a task's TERM
 * handler forks after its leader died is still signalled and counted (TE ADV-FORK).
 *
 * WHY FOLLOWING A SID IS REUSE-SAFE. Linux releases a pid number only when no task is attached to it
 * under ANY type, session included (`kernel/pid.c` `__change_pid` → `free_pid`), and a session id is
 * always its creator's pid. So while any member of session S lives, no new session S can exist.
 * Following stops at the first pass with no member, or when a `pid == sid` process with different
 * start ticks appears. Every signal re-verifies (pid, start ticks) right before `kill`.
 *
 * 🛑 /proc `cmdline`, `environ` and a Monitor's command text are MATCH-ONLY: never printed, logged or
 * returned. A command can carry a credential. `comm` is the only process label this module returns.
 *
 * `measured:false` means NOT MEASURED, never "nothing is running" (`process-population.ts`).
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
  | "not-linux"
  | "no-task-set";

/** The session's live background task set `BG` (owner tracker, or `query_background_tasks`). */
export type BackgroundTaskSet = {
  tasks: ReadonlyArray<{ taskId: string; taskType: string; toolName?: string }>;
  /** Match-only input to Proof M. Never printed, logged or put in any JSON. */
  monitorCommands: ReadonlyArray<{ taskId: string; command: string }>;
};

export type ReapMember = { pid: number; startTicks: string; comm: string; taskId: string };

type AdmittedSession = { sid: number; leaderStartTicks: string; taskId: string };
type AdmittedSingle = { pid: number; startTicks: string; taskId: string };

export type ReapSnapshot = {
  measured: boolean;
  skipped?: ReapSkipReason;
  procRoot: string;
  /** Never entered or signalled: the reaper, its ancestors. pid 1 and this process always. */
  exclude: ReadonlySet<number>;
  /** Every process in this session is spared: the owner, the adapter, claude. */
  ownerSid?: number;
  isNestedOwner: (pid: number) => boolean;
  sessions: AdmittedSession[];
  singles: AdmittedSingle[];
  /** The members at admission time. */
  members: ReapMember[];
  /** Live process-backed tasks in `BG` (Bash, Monitor) and those a proof matched. */
  processTaskIds: string[];
  provenTaskIds: string[];
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

export type ReapReport = ReapSummary & {
  survivorDetails: SurvivorDetail[];
  /** Internal, never on the wire: per-task proof facts for the per-task outcome and the K-of-N warning. */
  processTaskIds: string[];
  provenTaskIds: string[];
  survivingTaskIds: string[];
};

export type Signaller = (pid: number, signal: NodeJS.Signals) => void;

const DEFAULT_PROC_ROOT = "/proc";
const REAP_POLL_MS = 100;
export const REAP_GRACE_MS = 1_500;
export const REAP_KILL_WAIT_MS = 200;
const QUEUE_OWNER_ARGV_TOKEN = "\0__queue-owner";
const SHELL_COMMS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash"]);
const MIN_MONITOR_COMMAND_CHARS = 6;
const O_ACCMODE = 3;
const DIGITS = /^\d+$/;

const realSignaller: Signaller = (pid, signal) => {
  process.kill(pid, signal);
};

// ---------------------------------------------------------------------------
// /proc reads
// ---------------------------------------------------------------------------

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

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readAllEntries(procRoot: string): Map<number, ProcEntry> {
  const byPid = new Map<number, ProcEntry>();
  for (const name of listDir(procRoot)) {
    const entry = DIGITS.test(name) ? readEntry(procRoot, Number(name)) : undefined;
    if (entry) {
      byPid.set(entry.pid, entry);
    }
  }
  return byPid;
}

/**
 * One synchronous pass over `/proc/[0-9]*`. Unmeasured when nothing parses, or (on the real `/proc`)
 * the scan does not contain this process — a /proc that is not our own pid namespace's names nothing
 * we may signal.
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

function readText(path: string, encoding: BufferEncoding = "utf8"): string | undefined {
  try {
    return fs.readFileSync(path, encoding);
  } catch {
    return undefined;
  }
}

function readLink(path: string): string | undefined {
  try {
    return fs.readlinkSync(path);
  } catch {
    return undefined;
  }
}

/** Default nested-owner test: the process's argv carries `__queue-owner`. Match only, never print. */
export function argvCarriesQueueOwnerToken(pid: number, procRoot = DEFAULT_PROC_ROOT): boolean {
  const cmdline = readText(`${procRoot}/${pid}/cmdline`, "latin1");
  const at = cmdline?.indexOf(QUEUE_OWNER_ARGV_TOKEN) ?? -1;
  if (cmdline === undefined || at < 0) {
    return false;
  }
  const after = cmdline.charAt(at + QUEUE_OWNER_ARGV_TOKEN.length);
  return after === "" || after === "\0";
}

// ---------------------------------------------------------------------------
// Proofs (match-only)
// ---------------------------------------------------------------------------

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** `…/claude-<uid>/…/<S>/tasks/<taskId>.output` → taskId. A " (deleted)" target still counts. */
function taskFilePattern(acpSessionId: string): RegExp {
  return new RegExp(
    `/claude-\\d+/(?:[^/]+/)*${escapeRegExp(acpSessionId)}/tasks/([^/]+)\\.output(?: \\(deleted\\))?$`,
    "u",
  );
}

function fdOpenForWriting(procRoot: string, pid: number, fd: string): boolean {
  const flags = /^flags:\s+([0-7]+)$/mu.exec(readText(`${procRoot}/${pid}/fdinfo/${fd}`) ?? "");
  return flags !== null && [1, 2].includes(Number.parseInt(flags[1], 8) & O_ACCMODE);
}

/** Proof F: the BG task id whose output file `pid` holds open for writing, if any. */
function proofFTaskId(
  procRoot: string,
  pid: number,
  pattern: RegExp,
  bgIds: ReadonlySet<string>,
): string | undefined {
  for (const fd of listDir(`${procRoot}/${pid}/fd`)) {
    const taskId = pattern.exec(readLink(`${procRoot}/${pid}/fd/${fd}`) ?? "")?.[1];
    if (taskId !== undefined && bgIds.has(taskId) && fdOpenForWriting(procRoot, pid, fd)) {
      return taskId;
    }
  }
  return undefined;
}

/** Quote-normalized for matching: drop `'`, `"` and `\`, collapse whitespace. */
export function normalizeCommandForMatch(text: string): string {
  return text
    .replaceAll(/['"\\]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function envValueEquals(procRoot: string, pid: number, name: string, expected: string): boolean {
  const environ = readText(`${procRoot}/${pid}/environ`, "latin1");
  return environ !== undefined && environ.split("\0").includes(`${name}=${expected}`);
}

type MonitorMatch = { taskId: string; normalized: string };

function monitorMatches(bg: BackgroundTaskSet): MonitorMatch[] {
  const live = new Set(bg.tasks.map((task) => task.taskId));
  return bg.monitorCommands
    .filter((entry) => live.has(entry.taskId))
    .map((entry) => ({ taskId: entry.taskId, normalized: normalizeCommandForMatch(entry.command) }))
    .filter((entry) => entry.normalized.length >= MIN_MONITOR_COMMAND_CHARS);
}

function isMonitorShaped(procRoot: string, entry: ProcEntry, acpSessionId: string): boolean {
  return (
    entry.pid === entry.sid &&
    SHELL_COMMS.has(entry.comm) &&
    (readLink(`${procRoot}/${entry.pid}/fd/1`) ?? "").startsWith("socket:") &&
    envValueEquals(procRoot, entry.pid, "CLAUDE_CODE_SESSION_ID", acpSessionId)
  );
}

/** Proof M: the Monitor task whose command this shell runs, if it is a Monitor shell of session S. */
function proofMTaskId(
  procRoot: string,
  entry: ProcEntry,
  acpSessionId: string,
  monitors: MonitorMatch[],
): string | undefined {
  if (monitors.length === 0 || !isMonitorShaped(procRoot, entry, acpSessionId)) {
    return undefined;
  }
  const argv = normalizeCommandForMatch(
    (readText(`${procRoot}/${entry.pid}/cmdline`, "latin1") ?? "").replaceAll("\0", " "),
  );
  return monitors.find((monitor) => argv.includes(monitor.normalized))?.taskId;
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export type SnapshotInput = {
  /** `undefined` = the task set is unknown: admit nothing, `skipped:"no-task-set"`. */
  bg: BackgroundTaskSet | undefined;
  /** S — the record's `acp_session_id`; the task path's session segment. */
  acpSessionId: string | undefined;
  /** The owner: its whole session (owner, adapter, claude) is spared. */
  ownerPid: number | undefined;
  ownerStartTicks?: string;
  exclude?: ReadonlySet<number>;
  /** Closer side (§5.3): also exclude this process's whole ancestor chain, read from the same scan. */
  excludeSelfAncestry?: boolean;
  isNestedOwner?: (pid: number) => boolean;
  procRoot?: string;
};

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

/** Bash and Monitor tasks run processes; in-process task types (sub-agents, workflows) do not. */
export function isProcessBackedTask(task: { taskType: string; toolName?: string }): boolean {
  return task.taskType === "local_bash" || task.toolName === "Bash" || task.toolName === "Monitor";
}

function ownerSidOf(scan: ProcScan, input: SnapshotInput): number | undefined {
  const owner = input.ownerPid !== undefined ? scan.byPid.get(input.ownerPid) : undefined;
  if (
    !owner ||
    (input.ownerStartTicks !== undefined && owner.startTicks !== input.ownerStartTicks)
  ) {
    return undefined;
  }
  return owner.sid;
}

type Proofs = { byPid: Map<number, string> };

/** Every process of the box that passes Proof F or Proof M, keyed by pid → the task id it proves. */
function evaluateProofs(
  scan: ProcScan,
  procRoot: string,
  bg: BackgroundTaskSet,
  acpSessionId: string,
): Proofs {
  const pattern = taskFilePattern(acpSessionId);
  const bgIds = new Set(bg.tasks.map((task) => task.taskId));
  const monitors = monitorMatches(bg);
  const byPid = new Map<number, string>();
  for (const entry of scan.byPid.values()) {
    const taskId =
      proofFTaskId(procRoot, entry.pid, pattern, bgIds) ??
      proofMTaskId(procRoot, entry, acpSessionId, monitors);
    if (taskId !== undefined) {
      byPid.set(entry.pid, taskId);
    }
  }
  return { byPid };
}

type SnapshotBase = Omit<ReapSnapshot, "measured" | "skipped"> & { exclude: Set<number> };

function isSpared(entry: ProcEntry, base: SnapshotBase): boolean {
  return (
    entry.pid <= 1 ||
    entry.pid === process.pid ||
    base.exclude.has(entry.pid) ||
    (base.ownerSid !== undefined && entry.sid === base.ownerSid)
  );
}

function provenEntries(scan: ProcScan, proofs: Proofs, base: SnapshotBase) {
  return [...proofs.byPid]
    .map(([pid, taskId]) => ({ entry: scan.byPid.get(pid) as ProcEntry, taskId }))
    .filter(({ entry }) => isLiveState(entry.state) && !isSpared(entry, base));
}

/**
 * Admitted sessions: a live, proven session LEADER (decided here, at snapshot time, only). Admitted
 * singles: a proven process whose session was not admitted (its leader is gone or unprovable).
 */
function admit(scan: ProcScan, proofs: Proofs, base: SnapshotBase): void {
  const proven = provenEntries(scan, proofs, base);
  for (const { entry, taskId } of proven.filter(({ entry }) => entry.pid === entry.sid)) {
    base.sessions.push({ sid: entry.sid, leaderStartTicks: entry.startTicks, taskId });
  }
  const admittedSids = new Set(base.sessions.map((session) => session.sid));
  for (const { entry, taskId } of proven.filter(({ entry }) => !admittedSids.has(entry.sid))) {
    base.singles.push({ pid: entry.pid, startTicks: entry.startTicks, taskId });
  }
}

function emptyBase(input: SnapshotInput, procRoot: string): SnapshotBase {
  return {
    procRoot,
    exclude: new Set(input.exclude ?? []),
    isNestedOwner:
      input.isNestedOwner ?? ((pid: number) => argvCarriesQueueOwnerToken(pid, procRoot)),
    sessions: [],
    singles: [],
    members: [],
    processTaskIds: (input.bg?.tasks ?? []).filter(isProcessBackedTask).map((t) => t.taskId),
    provenTaskIds: [],
  };
}

/** Why nothing may be admitted (`measured:false`), or undefined when the scan can proceed. */
function unmeasurableReason(
  input: SnapshotInput,
  procRoot: string,
  scan: ProcScan | undefined,
): ReapSkipReason | undefined {
  if (!scan) {
    return "not-linux";
  }
  if (!scan.measured) {
    // /proc could not be censused here: nothing it names may be signalled or claimed absent.
    return "identity-unverified";
  }
  return !input.bg || input.acpSessionId === undefined ? "no-task-set" : undefined;
}

function measuredSnapshot(
  scan: ProcScan,
  input: SnapshotInput & { bg: BackgroundTaskSet; acpSessionId: string },
  base: SnapshotBase,
): ReapSnapshot {
  if (input.excludeSelfAncestry) {
    addSelfAncestry(scan, base.exclude);
  }
  base.ownerSid = ownerSidOf(scan, input);
  if (input.bg.tasks.length > 0) {
    admit(scan, evaluateProofs(scan, base.procRoot, input.bg, input.acpSessionId), base);
  }
  const snapshot: ReapSnapshot = { ...base, measured: true };
  snapshot.members = followMembers(snapshot, scan, undefined);
  snapshot.provenTaskIds = [
    ...new Set([...snapshot.sessions, ...snapshot.singles].map((unit) => unit.taskId)),
  ];
  return snapshot;
}

/** ADMISSION (§5.1): decided once, by proof, before anything is ended. Synchronous. */
export function snapshotSessionTree(input: SnapshotInput): ReapSnapshot {
  const procRoot = input.procRoot ?? DEFAULT_PROC_ROOT;
  const base = emptyBase(input, procRoot);
  const linuxOrFake = procRoot !== DEFAULT_PROC_ROOT || process.platform === "linux";
  const scan = linuxOrFake ? scanProcTable(procRoot) : undefined;
  const skipped = unmeasurableReason(input, procRoot, scan);
  if (skipped || !scan) {
    return { ...base, measured: false, skipped: skipped ?? "not-linux" };
  }
  return measuredSnapshot(
    scan,
    input as SnapshotInput & { bg: BackgroundTaskSet; acpSessionId: string },
    base,
  );
}

// ---------------------------------------------------------------------------
// Follow
// ---------------------------------------------------------------------------

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

type BaseView = Pick<ReapSnapshot, "exclude" | "ownerSid" | "isNestedOwner">;

function isSkipped(entry: ProcEntry, snapshot: BaseView): boolean {
  return (
    !isLiveState(entry.state) ||
    entry.pid <= 1 ||
    entry.pid === process.pid ||
    snapshot.exclude.has(entry.pid) ||
    (snapshot.ownerSid !== undefined && entry.sid === snapshot.ownerSid)
  );
}

/** A single's CURRENT descendants, the walk pruned at nested owners (D12). */
function addDescendants(
  into: Map<number, ReapMember>,
  root: ProcEntry,
  taskId: string,
  context: { children: Map<number, ProcEntry[]>; snapshot: BaseView },
): void {
  const queue = [...(context.children.get(root.pid) ?? [])];
  while (queue.length > 0) {
    const child = queue.shift() as ProcEntry;
    if (into.has(child.pid) || child.pid === root.pid) {
      continue;
    }
    if (isSkipped(child, context.snapshot) || context.snapshot.isNestedOwner(child.pid)) {
      continue;
    }
    into.set(child.pid, toMember(child, taskId));
    queue.push(...(context.children.get(child.pid) ?? []));
  }
}

function toMember(entry: ProcEntry, taskId: string): ReapMember {
  return { pid: entry.pid, startTicks: entry.startTicks, comm: entry.comm, taskId };
}

/** The reuse guard: a `pid == sid` process with other start ticks means the number moved on. */
function sessionStillOurs(session: AdmittedSession, scan: ProcScan): boolean {
  const leader = scan.byPid.get(session.sid);
  return (
    leader === undefined ||
    leader.sid !== session.sid ||
    leader.startTicks === session.leaderStartTicks
  );
}

function sessionMembers(session: AdmittedSession, snapshot: ReapSnapshot, scan: ProcScan) {
  return [...scan.byPid.values()].filter(
    (entry) => entry.sid === session.sid && !isSkipped(entry, snapshot),
  );
}

function addSessionMembers(
  into: Map<number, ReapMember>,
  snapshot: ReapSnapshot,
  scan: ProcScan,
  ended: Set<number> | undefined,
): void {
  for (const session of snapshot.sessions) {
    const members =
      ended?.has(session.sid) || !sessionStillOurs(session, scan)
        ? []
        : sessionMembers(session, snapshot, scan);
    for (const entry of members) {
      into.set(entry.pid, toMember(entry, session.taskId));
    }
    if (members.length === 0) {
      // The first pass with no member (or a reused number) ends the following (§5.1 FOLLOW guard).
      ended?.add(session.sid);
    }
  }
}

/**
 * FOLLOW: every live process of an admitted session, every admitted single still alive (pid + start
 * ticks), and the singles' current descendants. `ended` carries the stop-following state of one reap.
 */
function followMembers(
  snapshot: ReapSnapshot,
  scan: ProcScan,
  ended: Set<number> | undefined,
): ReapMember[] {
  const members = new Map<number, ReapMember>();
  addSessionMembers(members, snapshot, scan, ended);
  const children = childrenByParent(scan);
  for (const single of snapshot.singles) {
    const entry = scan.byPid.get(single.pid);
    if (entry?.startTicks !== single.startTicks || isSkipped(entry, snapshot)) {
      continue;
    }
    members.set(entry.pid, toMember(entry, single.taskId));
    addDescendants(members, entry, single.taskId, { children, snapshot });
  }
  return [...members.values()];
}

/** The members alive right now (a fresh stat scan). */
export function liveMembers(snapshot: ReapSnapshot, ended?: Set<number>): ReapMember[] {
  if (!snapshot.measured) {
    return [];
  }
  const scan = scanProcTable(snapshot.procRoot);
  return scan.measured ? followMembers(snapshot, scan, ended) : [];
}

function signalMembers(
  snapshot: ReapSnapshot,
  members: ReapMember[],
  signal: NodeJS.Signals,
  signaller: Signaller,
): number {
  let signalled = 0;
  for (const member of members) {
    if (!isSameLiveProcess(snapshot.procRoot, member.pid, member.startTicks)) {
      continue;
    }
    try {
      signaller(member.pid, signal);
      signalled += 1;
    } catch {
      // ESRCH (it just exited) or EPERM: the survivor census is the truth.
    }
  }
  return signalled;
}

/**
 * One follow pass, then `signal` to every member, each re-verified (start ticks) right before its
 * `kill`. Synchronous, never throws — safe inside the owner's signal handler. Returns the count.
 */
export function signalSnapshot(
  snapshot: ReapSnapshot,
  signal: NodeJS.Signals,
  signaller: Signaller = realSignaller,
): number {
  try {
    return signalMembers(snapshot, liveMembers(snapshot), signal, signaller);
  } catch {
    return 0;
  }
}

/**
 * The signal-handler FOLLOW (§5.2 G, no closer): synchronous and bounded. Polls every 25 ms for at most
 * `budgetMs`, TERMing any member first seen in a later pass, until a pass finds no member. ⚠️ Measured
 * (brick ad6ba1c2 live rig `v3/fork-term`): a task's TERM handler forks AFTER a single immediate KILL
 * scan, so the fork escaped with no closer to follow it (CONCEPTION RV-6 called that window µs; it is
 * not). Blocks the owner's event loop by design: the owner is exiting and awaits nothing here.
 */
export function followUntilQuietSync(
  snapshot: ReapSnapshot,
  budgetMs: number,
  signaller: Signaller = realSignaller,
): void {
  if (!snapshot.measured) {
    return;
  }
  const termed = new Set(snapshot.members.map(memberKey));
  const ended = new Set<number>();
  const deadline = Date.now() + Math.max(0, budgetMs);
  for (;;) {
    const members = liveMembers(snapshot, ended);
    if (members.length === 0 || Date.now() >= deadline) {
      return;
    }
    const fresh = members.filter((member) => !termed.has(memberKey(member)));
    signalMembers(snapshot, fresh, "SIGTERM", signaller);
    for (const member of fresh) {
      termed.add(memberKey(member));
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, REAP_POLL_SYNC_MS);
  }
}

const REAP_POLL_SYNC_MS = 25;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function unmeasuredReap(skipped?: ReapSkipReason): ReapReport {
  return {
    measured: false,
    taskProcesses: 0,
    survivors: 0,
    survivorPids: [],
    survivorDetails: [],
    processTaskIds: [],
    provenTaskIds: [],
    survivingTaskIds: [],
    ...(skipped ? { skipped } : {}),
  };
}

type ReapRun = {
  snapshot: ReapSnapshot;
  signaller: Signaller;
  ended: Set<number>;
  seen: Map<string, ReapMember>;
  termed: Set<string>;
};

const memberKey = (member: ReapMember): string => `${member.pid}:${member.startTicks}`;

/** One pass: follow, record every member seen, TERM any not yet TERMed. Returns the live members. */
function termPass(run: ReapRun): ReapMember[] {
  const members = liveMembers(run.snapshot, run.ended);
  const fresh = members.filter((member) => !run.termed.has(memberKey(member)));
  for (const member of members) {
    run.seen.set(memberKey(member), member);
  }
  signalMembers(run.snapshot, fresh, "SIGTERM", run.signaller);
  for (const member of fresh) {
    run.termed.add(memberKey(member));
  }
  return members;
}

async function termUntilEmpty(run: ReapRun, graceMs: number): Promise<ReapMember[]> {
  const deadline = Date.now() + graceMs;
  let members = termPass(run);
  while (members.length > 0 && Date.now() < deadline) {
    await sleep(REAP_POLL_MS);
    members = termPass(run);
  }
  return members;
}

/**
 * SIGTERM every member → poll every 100 ms up to `graceMs`, TERMing members first seen later → SIGKILL
 * the rest → wait `killWaitMs` → final follow pass. `taskProcesses` counts every (pid, start) seen as
 * a member in ANY pass, admission included (a fork born at TERM counts). `survivors` are the final
 * pass's members: `survivors: 0` is never reported while one lives.
 */
export async function reapSnapshot(
  snapshot: ReapSnapshot,
  options: { graceMs?: number; killWaitMs?: number; signal?: Signaller } = {},
): Promise<ReapReport> {
  if (!snapshot.measured) {
    return unmeasuredReap(snapshot.skipped);
  }
  const run: ReapRun = {
    snapshot,
    signaller: options.signal ?? realSignaller,
    ended: new Set(),
    seen: new Map(snapshot.members.map((member) => [memberKey(member), member])),
    termed: new Set(),
  };
  const remaining = await termUntilEmpty(run, options.graceMs ?? REAP_GRACE_MS);
  if (remaining.length > 0) {
    signalMembers(snapshot, remaining, "SIGKILL", run.signaller);
    await sleep(options.killWaitMs ?? REAP_KILL_WAIT_MS);
  }
  // The final count must not stop at an "ended" session: count every live member of every admitted
  // session, so a late fork is never hidden.
  const survivors = liveMembers(snapshot);
  for (const member of survivors) {
    run.seen.set(memberKey(member), member);
  }
  return reportFor(snapshot, run.seen.size, survivors);
}

function reportFor(
  snapshot: ReapSnapshot,
  taskProcesses: number,
  survivors: ReapMember[],
): ReapReport {
  return {
    measured: true,
    taskProcesses,
    survivors: survivors.length,
    survivorPids: survivors.map((member) => member.pid),
    survivorDetails: survivors.map(({ pid, comm, startTicks }) => ({ pid, comm, startTicks })),
    processTaskIds: snapshot.processTaskIds,
    provenTaskIds: snapshot.provenTaskIds,
    survivingTaskIds: [...new Set(survivors.map((member) => member.taskId))],
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** The Contract C2 `reap` object — what goes on the wire (no comm, no start ticks, no task ids). */
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

/**
 * HoD (v3): proof failure must be LOUD. v3 proves tasks through Claude Code internals (the task
 * output layout, `CLAUDE_CODE_SESSION_ID`, the Monitor argv); an upstream change makes the proofs
 * fail SAFE (nothing wrongly killed) but would quietly bring the orphans back. So whenever the live
 * set lists N > 0 process-backed tasks and the proofs matched K < N of them, say so.
 */
export function unprovenTaskWarning(
  sessionId: string,
  facts: Pick<ReapReport, "measured" | "processTaskIds" | "provenTaskIds">,
): string | undefined {
  if (!facts.measured || facts.processTaskIds.length === 0) {
    return undefined;
  }
  const proven = new Set(facts.provenTaskIds);
  const matched = facts.processTaskIds.filter((taskId) => proven.has(taskId)).length;
  const total = facts.processTaskIds.length;
  return matched < total
    ? `[acpx] WARNING: session ${sessionId}: proof matched ${matched} of ${total} live background tasks — the unmatched ones may survive; Claude Code's task layout may have changed (brick ad6ba1c2)\n`
    : undefined;
}
