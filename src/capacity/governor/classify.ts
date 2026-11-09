import fs from "node:fs";
import path from "node:path";
import {
  isLiveState,
  parseProcStat,
  type ProcEntry,
  queueOwnerTokenState,
} from "../../process-tree-reap.js";

/**
 * CONCEPTION 5d7a23b6 §3 — what the governor may kill: POSITIVE ORIGIN. A session (sid) is governed
 * only when the governor can say where it came from and the answer is "a command". Anything it
 * cannot place is left alone, so a classification error removes a session from the kill set and
 * never adds one.
 *
 * The unit is the session id: Claude Code runs every Bash tool command as its own session, job
 * control gives each pipeline its own process group inside it, and a sid cannot be reused while any
 * member lives (F1, F2, F4). A session's kind is decided ONCE, by the scan that first saw it, and
 * remembered (`groups.json`); losing that memory costs attribution, never safety.
 *
 * 🛑 Reads only `/proc/<pid>/stat`, plus `cmdline` through `queueOwnerTokenState` (match-only, a
 * three-way answer; the content never leaves that function). Never `environ`.
 */

export type GovProc = ProcEntry & { readonly ttyNr: number; readonly threads: number };

/** {@link parseProcStat} plus `tty_nr` (field 7) and `num_threads` (field 20). */
export function parseGovProcStat(payload: string): GovProc | undefined {
  const entry = parseProcStat(payload);
  if (!entry) {
    return undefined;
  }
  const fields = payload
    .slice(payload.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/u);
  const ttyNr = Number(fields[4]);
  const threads = Number(fields[17]);
  return {
    ...entry,
    ttyNr: Number.isSafeInteger(ttyNr) ? ttyNr : 0,
    threads: Number.isSafeInteger(threads) && threads > 0 ? threads : 1,
  };
}

export type SessionKind = "tool" | "terminal" | "derived" | "leaderless";

/**
 * Who a governed session belongs to (§6.1), from lineage only. `label` is the ClickHouse
 * `attribution` column: `acpx-session` (sessionId known), `pid:<n>` (an owner recognised only by its
 * argv token), `atrium`, `ttyd`, `vscode`, `ssh` or `unknown`.
 */
export type Attribution = {
  readonly label: string;
  readonly sessionId?: string;
  readonly seatId?: string;
};

export type Placement =
  | {
      readonly governed: true;
      readonly kind: SessionKind;
      /** The kind at the root of the lineage: a derived session inherits its parent's. */
      readonly root: "tool" | "terminal" | "unknown";
      readonly attribution: Attribution;
    }
  | { readonly governed: false; readonly reason: "system" | "owner" | "outside" };

/** One remembered session (`groups.json`). */
export type GroupRecord = {
  readonly sid: number;
  /** Undefined when the session was first seen without a live leader. */
  readonly leaderStartTicks?: string;
  readonly leaderPpid?: number;
  readonly firstSeenMs: number;
  readonly placement: Placement;
};

export type SessionView = {
  readonly sid: number;
  readonly record: GroupRecord;
  /** Live members (zombies excluded). */
  readonly members: readonly GovProc[];
  readonly leader: GovProc | undefined;
  /** Its leader died, or was reparented since first sight: the tool call had already ended. */
  readonly orphaned: boolean;
  readonly threads: number;
};

export type OwnerFacts = { readonly sessionId?: string; readonly seatId?: string };

export type TokenState = "owner" | "absent" | "unreadable";

export type ClassifyContext = {
  /** The governor's own session: in production the entrypoint's (§3.3). Never governed. */
  readonly systemSid: number;
  /** Lease-verified owner pids (each leads its own session) → record facts. */
  readonly leaseOwners: ReadonlyMap<number, OwnerFacts>;
  /** The match-only `__queue-owner` argv check (`queueOwnerTokenState`). */
  readonly tokenState: (pid: number) => TokenState;
};

export const HARNESS_COMMS: ReadonlySet<string> = new Set(["claude", "codex"]);
export const SHELL_COMMS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "fish", "dash"]);

/**
 * A token-check cache keyed by (pid, start ticks) that remembers ONLY a positive answer: an owner's argv
 * never changes once it carries `__queue-owner`.
 *
 * ⚠️ DO NOT CACHE `absent` (TE F12, CONCEPTION §19). `exec` keeps the pid AND the start ticks, so a
 * process read as `absent` in the instant between node's fork and its exec into `__queue-owner` would
 * keep reading `absent` for life — and the guard would then treat a fresh queue owner as signallable.
 * A negative is therefore re-read every time, i.e. before every signal. Row: "F12 …".
 */
export function cachedTokenState(
  procRoot: string,
  byPid: () => ReadonlyMap<number, GovProc>,
  cache: Map<string, TokenState> = new Map(),
): (pid: number) => TokenState {
  return (pid) => {
    const entry = byPid().get(pid);
    const key = entry ? `${pid}:${entry.startTicks}` : undefined;
    const hit = key ? cache.get(key) : undefined;
    if (hit) {
      return hit;
    }
    const state = queueOwnerTokenState(pid, procRoot);
    if (key && state === "owner") {
      cache.set(key, state);
    }
    return state;
  };
}

export function liveLeader(byPid: ReadonlyMap<number, GovProc>, sid: number): GovProc | undefined {
  const leader = byPid.get(sid);
  return leader && leader.sid === sid && isLiveState(leader.state) ? leader : undefined;
}

type Classifier = {
  readonly byPid: ReadonlyMap<number, GovProc>;
  readonly bySid: ReadonlyMap<number, GovProc[]>;
  readonly ctx: ClassifyContext;
  readonly memory: Map<number, GroupRecord>;
  readonly nowMs: number;
  /** Sessions being placed right now: a parent chain that loops back is unplaceable. */
  readonly inProgress: Set<number>;
  changed: boolean;
};

function isOwnerSession(c: Classifier, sid: number): boolean {
  return c.ctx.leaseOwners.has(sid) || c.ctx.tokenState(sid) === "owner";
}

function ownerAttribution(c: Classifier, ownerSid: number): Attribution {
  const facts = c.ctx.leaseOwners.get(ownerSid);
  if (facts?.sessionId) {
    return { label: "acpx-session", sessionId: facts.sessionId, seatId: facts.seatId };
  }
  return { label: `pid:${ownerSid}` };
}

/** A `node` at the harness position of an owner session: owner → adapter → harness (Pi). */
function isNodeHarness(c: Classifier, proc: GovProc): boolean {
  if (proc.comm !== "node" || proc.pid === proc.sid) {
    return false;
  }
  const adapter = c.byPid.get(proc.ppid);
  return (
    adapter !== undefined &&
    adapter.sid === proc.sid &&
    adapter.ppid === proc.sid &&
    isOwnerSession(c, proc.sid)
  );
}

function isHarness(c: Classifier, proc: GovProc): boolean {
  return HARNESS_COMMS.has(proc.comm) || isNodeHarness(c, proc);
}

/** §3.2 tool-session attribution: the owner holding the harness, else where the harness lives. */
function harnessAttribution(c: Classifier, harness: GovProc): Attribution {
  if (harness.sid === c.ctx.systemSid) {
    return { label: "atrium" };
  }
  if (isOwnerSession(c, harness.sid)) {
    return ownerAttribution(c, harness.sid);
  }
  const placement = placementOf(c, harness.sid);
  return placement?.governed ? placement.attribution : { label: "unknown" };
}

function terminalAttribution(parent: GovProc): Attribution {
  if (parent.comm === "ttyd") {
    return { label: "ttyd" };
  }
  return parent.comm.startsWith("sshd") ? { label: "ssh" } : { label: "vscode" };
}

const OUTSIDE: Placement = { governed: false, reason: "outside" };

/**
 * A leaderless session (§3.2, as ruled in §19 D1): governed unless a live member is a VERIFIED owner —
 * it carries the `__queue-owner` argv token, or a lease names it.
 *
 * ⚠️ DO NOT ADD A COMM-NAME TEST BACK ("a member named `claude` means owner remains"). It looks like
 * protection for a dead owner's adapter and harness, and it is the bug: any binary renamed `claude`, or a
 * backgrounded nested `claude`, made a 403-process storm unkillable and silent (TE X6, finding F1). A name
 * never exempts (§12). Real owner remains are governed; R1 never reaches a handful of processes, and at
 * R2's line a dead owner's leftovers are the right victim. Row: "classify: LEADERLESS …".
 */
function placeLeaderless(c: Classifier, members: readonly GovProc[]): Placement {
  const ownerRemains = members.some(
    (m) => c.ctx.leaseOwners.has(m.pid) || c.ctx.tokenState(m.pid) === "owner",
  );
  return ownerRemains
    ? { governed: false, reason: "owner" }
    : { governed: true, kind: "leaderless", root: "unknown", attribution: { label: "unknown" } };
}

function isTerminalLeader(c: Classifier, leader: GovProc, parent: GovProc): boolean {
  return (
    SHELL_COMMS.has(leader.comm) &&
    (parent.sid === c.ctx.systemSid || parent.comm.startsWith("sshd"))
  );
}

function placeLed(c: Classifier, leader: GovProc): Placement {
  const parent = c.byPid.get(leader.ppid);
  if (!parent || parent.pid <= 1) {
    return OUTSIDE;
  }
  if (isHarness(c, parent)) {
    const attribution = harnessAttribution(c, parent);
    return { governed: true, kind: "tool", root: "tool", attribution };
  }
  if (isTerminalLeader(c, leader, parent)) {
    const attribution = terminalAttribution(parent);
    return { governed: true, kind: "terminal", root: "terminal", attribution };
  }
  const from = placementOf(c, parent.sid);
  return from?.governed
    ? { governed: true, kind: "derived", root: from.root, attribution: from.attribution }
    : OUTSIDE;
}

function place(c: Classifier, sid: number, members: readonly GovProc[]): Placement {
  // §3.3 always wins: the system session, PID 1's, and every owner session are never governed.
  if (sid === c.ctx.systemSid || sid <= 1 || members.some((m) => m.pid <= 1)) {
    return { governed: false, reason: "system" };
  }
  const leader = liveLeader(c.byPid, sid);
  if (leader && isOwnerSession(c, sid)) {
    return { governed: false, reason: "owner" };
  }
  return leader ? placeLed(c, leader) : placeLeaderless(c, members);
}

/** The remembered record is still this session: same leader start, or still leaderless. */
function recordStillValid(record: GroupRecord, leader: GovProc | undefined): boolean {
  if (record.leaderStartTicks === undefined) {
    return leader === undefined;
  }
  return leader === undefined || leader.startTicks === record.leaderStartTicks;
}

/**
 * The remembered record of `sid` if it still describes this session (same leader start, or still
 * leaderless) — the §19 D5 crossing kill acts only on a session placed by an earlier FULL scan.
 */
export function rememberedRecord(
  memory: ReadonlyMap<number, GroupRecord>,
  sid: number,
  leader: GovProc | undefined,
): GroupRecord | undefined {
  const record = memory.get(sid);
  return record && recordStillValid(record, leader) ? record : undefined;
}

/** The session's placement, from memory or decided now (first sight); undefined if it has no member. */
function placementOf(c: Classifier, sid: number): Placement | undefined {
  const members = c.bySid.get(sid);
  if (!members || members.length === 0) {
    return undefined;
  }
  const leader = liveLeader(c.byPid, sid);
  const remembered = c.memory.get(sid);
  if (remembered && recordStillValid(remembered, leader)) {
    return remembered.placement;
  }
  if (c.inProgress.has(sid)) {
    return OUTSIDE;
  }
  c.inProgress.add(sid);
  const placement = place(c, sid, members);
  c.inProgress.delete(sid);
  c.memory.set(sid, {
    sid,
    leaderStartTicks: leader?.startTicks,
    leaderPpid: leader?.ppid,
    firstSeenMs: c.nowMs,
    placement,
  });
  c.changed = true;
  return placement;
}

export type Classification = {
  readonly sessions: ReadonlyMap<number, SessionView>;
  /** True when `memory` gained or lost an entry (persist `groups.json`). */
  readonly memoryChanged: boolean;
};

/**
 * Every live session of the scan, placed. `memory` is updated in place: first-sight records are
 * added, sessions with no live member are forgotten (a sid is free again once its last member dies).
 */
function groupBySid(byPid: ReadonlyMap<number, GovProc>): Map<number, GovProc[]> {
  const bySid = new Map<number, GovProc[]>();
  for (const entry of byPid.values()) {
    if (!isLiveState(entry.state)) {
      continue;
    }
    const list = bySid.get(entry.sid);
    if (list) {
      list.push(entry);
    } else {
      bySid.set(entry.sid, [entry]);
    }
  }
  return bySid;
}

function isOrphaned(record: GroupRecord, leader: GovProc | undefined): boolean {
  if (!record.placement.governed) {
    return false;
  }
  return (
    leader === undefined || (record.leaderPpid !== undefined && leader.ppid !== record.leaderPpid)
  );
}

/**
 * §19 D7: place ONE session from a partial scan (the mid-scan crossing on first sight). The caller has read
 * the leader and its ancestors fresh, so the placement inputs are present; the result is remembered like any
 * first-sight placement. Undefined when the session has no member in `byPid`.
 */
export function placeSession(
  byPid: ReadonlyMap<number, GovProc>,
  ctx: ClassifyContext,
  memory: Map<number, GroupRecord>,
  nowMs: number,
  sid: number,
): Placement | undefined {
  const c: Classifier = {
    byPid,
    bySid: groupBySid(byPid),
    ctx,
    memory,
    nowMs,
    inProgress: new Set(),
    changed: false,
  };
  return placementOf(c, sid);
}

export function sessionView(
  sid: number,
  record: GroupRecord,
  members: readonly GovProc[],
  leader: GovProc | undefined,
): SessionView {
  return {
    sid,
    record,
    members,
    leader,
    orphaned: isOrphaned(record, leader),
    threads: members.reduce((sum, m) => sum + m.threads, 0),
  };
}

export function classifySessions(
  byPid: ReadonlyMap<number, GovProc>,
  ctx: ClassifyContext,
  memory: Map<number, GroupRecord>,
  nowMs: number,
  /** False when a scan reader's share was left out: then a session not seen is NOT forgotten. */
  complete = true,
): Classification {
  const bySid = groupBySid(byPid);
  const c: Classifier = { byPid, bySid, ctx, memory, nowMs, inProgress: new Set(), changed: false };
  for (const sid of complete ? memory.keys() : []) {
    if (!bySid.has(sid)) {
      memory.delete(sid);
      c.changed = true;
    }
  }
  const sessions = new Map<number, SessionView>();
  for (const [sid, members] of bySid) {
    placementOf(c, sid);
    const record = memory.get(sid) as GroupRecord;
    sessions.set(sid, sessionView(sid, record, members, liveLeader(byPid, sid)));
  }
  return { sessions, memoryChanged: c.changed };
}

/**
 * D1 axis `governTerminals:false` (§18 C3): a ttyd or VS Code terminal session, or one derived from
 * it, is exempt. ssh logins stay governed.
 */
export function isExemptTerminal(placement: Placement, governTerminals: boolean): boolean {
  return (
    !governTerminals &&
    placement.governed &&
    placement.root === "terminal" &&
    (placement.attribution.label === "ttyd" || placement.attribution.label === "vscode")
  );
}

/** The sid of PID 1's earliest child (lowest start ticks) — the entrypoint's session (§3.3). */
export function entrypointSid(byPid: ReadonlyMap<number, GovProc>): number | undefined {
  let earliest: GovProc | undefined;
  for (const entry of byPid.values()) {
    if (entry.ppid === 1 && (!earliest || BigInt(entry.startTicks) < BigInt(earliest.startTicks))) {
      earliest = entry;
    }
  }
  return earliest?.sid;
}

// ---------------------------------------------------------------------------
// groups.json — attribution memory across restarts
// ---------------------------------------------------------------------------

const GOVERNED_KINDS: ReadonlySet<string> = new Set(["tool", "terminal", "derived", "leaderless"]);
const ROOTS: ReadonlySet<string> = new Set(["tool", "terminal", "unknown"]);
const UNGOVERNED_REASONS: ReadonlySet<string> = new Set(["system", "owner", "outside"]);

function isPlacement(value: unknown): value is Placement {
  const p = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (p.governed === false) {
    return UNGOVERNED_REASONS.has(String(p.reason));
  }
  const a = p.attribution as Record<string, unknown> | undefined;
  return (
    p.governed === true &&
    GOVERNED_KINDS.has(String(p.kind)) &&
    ROOTS.has(String(p.root)) &&
    typeof a?.label === "string"
  );
}

const isSid = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 1;

function parseGroupRecord(item: unknown): GroupRecord | undefined {
  const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
  if (!isSid(r.sid) || typeof r.firstSeenMs !== "number" || !isPlacement(r.placement)) {
    return undefined;
  }
  return {
    sid: r.sid,
    leaderStartTicks: typeof r.leaderStartTicks === "string" ? r.leaderStartTicks : undefined,
    leaderPpid: typeof r.leaderPpid === "number" ? r.leaderPpid : undefined,
    firstSeenMs: r.firstSeenMs,
    placement: r.placement,
  };
}

export function loadGroupMemory(file: string): Map<number, GroupRecord> {
  const memory = new Map<number, GroupRecord>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return memory;
  }
  for (const item of Array.isArray(parsed) ? parsed : []) {
    const record = parseGroupRecord(item);
    if (record) {
      memory.set(record.sid, record);
    }
  }
  return memory;
}

export function saveGroupMemory(file: string, memory: ReadonlyMap<number, GroupRecord>): void {
  writeFileAtomic(file, `${JSON.stringify([...memory.values()])}\n`);
}

/** Write via a temp file + rename, so a reader never sees half a file. Best effort. */
export function writeFileAtomic(file: string, body: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, body);
    fs.renameSync(temp, file);
  } catch {
    // The governor runs on; state is attribution, never safety (E20).
  }
}
