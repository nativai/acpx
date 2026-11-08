import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanProcTable } from "../../process-tree-reap.js";
import { readCgroup } from "../cgroup.js";
import { type CapacityConstants, type GovernorConstants } from "../constants.js";
import { verifiedLeaseOwners } from "../leases.js";
import {
  cachedTokenState,
  classifySessions,
  type ClassifyContext,
  entrypointSid,
  type GovProc,
  type GroupRecord,
  isExemptTerminal,
  loadGroupMemory,
  type OwnerFacts,
  parseGovProcStat,
  saveGroupMemory,
  type SessionView,
  type TokenState,
  writeFileAtomic,
} from "./classify.js";
import { inBandLine, type KillFacts, type MessageTarget, Notifier, writeInBand } from "./notify.js";
import {
  appendEventFile,
  ClickHouseWriter,
  clickhouseRow,
  clickhouseTime,
  emptyEvent,
  eventLogLine,
  type GovernorAction,
  type GovernorEvent,
  type GovernorRule,
  loadPeaksDay,
  type PeaksDay,
  peaksEvents,
  pendingPeaksDays,
  savePeaksDay,
  utcDay,
} from "./record.js";
import {
  BurstTracker,
  chooseR2Victim,
  emergencyLineBytes,
  freeableBytes,
  type R2Candidate,
  type R2SkipEntry,
  r1Matches,
  sessionAnonBytes,
  victimFloorBytes,
} from "./rules.js";
import type { GovernorHeartbeat, LastKill } from "./status.js";
import {
  finishStops,
  type GuardContext,
  type Signaller,
  type StopRecord,
  type SweepDeps,
  sweepSession,
} from "./sweep.js";

/**
 * CONCEPTION 5d7a23b6 §4 cadence, §7.2 process properties — the daemon.
 *
 * One scan per second reads only `/proc/<pid>/stat` and `memory.stat`; every 100 ms while a governed
 * session grows (fast mode). The scan and the kill run on the main thread with synchronous `fs`
 * (nice is per thread: `os.setPriority(0, −20)` raises this thread only, and libuv's pool is not
 * used for them). No child process, ever. Everything is imported at start-up, so a refresh rewriting
 * `dist/` underneath cannot break a running governor; it restarts itself between sweeps instead.
 */

export type GovernorMode = "enforce" | "observe";

/** Linux exports USER_HZ = 100 to userspace on every architecture we run: start ticks → ms. */
const USER_HZ = 100;
const HEARTBEAT_MIN_MS = 250;
const GROUPS_SAVE_MIN_MS = 1000;
const PEAKS_SAVE_MS = 60_000;
const SYSTEM_RECHECK_MS = 60_000;
const SELF_RESTART_STABLE_MS = 10_000;
const VERIFY_DELAYS_MS = [1000, 10_000] as const;
const MAX_SWEEPS = 3;
const DAY_MS = 86_400_000;

export type GovernorDeps = {
  readonly procRoot: string;
  readonly cgroupRoot: string;
  readonly queueDir: string;
  readonly sessionsDir: string;
  /** `~/.acpx/governor`. */
  readonly dir: string;
  readonly now: () => number;
  readonly signal: Signaller;
  readonly sleepSync: (ms: number) => void;
  readonly notifier: Notifier;
  readonly clickhouse: ClickHouseWriter;
  readonly log: (line: string) => void;
  /** `/proc/<pid>/status`, read only past R2's line and for sessions in an event. */
  readonly readStatus: (pid: number) => string | undefined;
  /** Raw match-only argv check (`queueOwnerTokenState`). */
  readonly tokenState: (pid: number) => TokenState;
  readonly selfPid: number;
  readonly uid: number;
  /** The entry file watched for a new build (§7.2 self-restart); undefined = never restart. */
  readonly entryFile?: string;
  readonly setPriority?: (nice: number) => void;
};

export type GovernorSettings = {
  /** `constants.governor.mode` is the ONLY source of the mode: no flag, no runtime switch (§13.1). */
  readonly constants: CapacityConstants;
  /** `ACPX_GOVERNOR_TEST=1`: every event is stamped `test`, every ClickHouse row a fixture box. */
  readonly testMode: boolean;
  /** `--test-rig`: the governor's own session is the system session, whatever PID 1's is. */
  readonly testRig: boolean;
  /** `--limit-bytes`: R2's `L` (test only); `C` stays real. */
  readonly limitBytes?: number;
  /** Resolved box identity for events ('' when unresolved). */
  readonly box: string;
  /** False until the system-session check passes: a non-supervised governor writes no rows. */
  readonly clickhouseAllowed: boolean;
};

type KillRecord = {
  atMs: number;
  rule: GovernorRule;
  processes: number;
  kind: string;
  eventId: string;
};

type GovernorState = {
  r2LastKillMs: number;
  r2Skip: R2SkipEntry[];
  terminalSweeps: Array<{ key: string; atMs: number }>;
  stopsInFlight: StopRecord[];
  kills: KillRecord[];
};

type Verification = {
  sid: number;
  key: string;
  dueMs: number;
  sweepNo: number;
  sparePgid: number | undefined;
  rule: GovernorRule;
};

/** The container's memory as R2 and events read it: `C`, `L` (or `--limit-bytes`), PSI full. */
type BoxReading = { committed?: number; limit?: number; psi?: number };

function boxFields(box: BoxReading): Partial<GovernorEvent> {
  return {
    box_committed_bytes: box.committed ?? null,
    box_limit_bytes: box.limit ?? null,
    psi_full_avg10: box.psi ?? null,
  };
}

/** Event attribution columns: the acpx session id goes in `session_id`, anything else in `attribution`. */
function attributionFields(view: SessionView): Partial<GovernorEvent> {
  const placement = view.record.placement;
  if (!placement.governed) {
    return { session_kind: "" };
  }
  const a = placement.attribution;
  return {
    session_kind: placement.kind,
    session_id: a.sessionId ?? "",
    seat_id: a.seatId ?? "",
    attribution: a.label === "acpx-session" ? "" : a.label,
  };
}

function messageTarget(view: SessionView): MessageTarget | undefined {
  const placement = view.record.placement;
  const a = placement.governed ? placement.attribution : undefined;
  if (a?.seatId) {
    return { kind: "seat", id: a.seatId };
  }
  return a?.sessionId ? { kind: "session", id: a.sessionId } : undefined;
}

/** Fast-mode trigger (§4.2): `start` on a jump of ≥ 16 or a first crossing of 32; `grew` on any rise. */
function growthOf(prev: number, count: number, g: GovernorConstants): "none" | "grew" | "start" {
  if (count <= prev) {
    return "none";
  }
  const crossed = prev < g.fastSizeProcesses && count >= g.fastSizeProcesses;
  return count - prev >= g.fastGrowthProcesses || crossed ? "start" : "grew";
}

function growthSummary(
  sessions: ReadonlyMap<number, SessionView>,
  prevCounts: ReadonlyMap<string, number>,
  g: GovernorConstants,
): { counts: Map<string, number>; started: boolean; grew: boolean } {
  const counts = new Map<string, number>();
  let started = false;
  let grew = false;
  for (const view of sessions.values()) {
    if (view.record.placement.governed) {
      const key = sessionKey(view);
      counts.set(key, view.members.length);
      const growth = growthOf(prevCounts.get(key) ?? 0, view.members.length, g);
      started ||= growth === "start";
      grew ||= growth !== "none";
    }
  }
  return { counts, started, grew };
}

/** A fresh state — fresh arrays every time: a shared constant's arrays would leak between runs. */
function emptyState(): GovernorState {
  return { r2LastKillMs: 0, r2Skip: [], terminalSweeps: [], stopsInFlight: [], kills: [] };
}

function loadState(file: string): GovernorState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<GovernorState>;
    return {
      r2LastKillMs: typeof parsed.r2LastKillMs === "number" ? parsed.r2LastKillMs : 0,
      r2Skip: Array.isArray(parsed.r2Skip) ? parsed.r2Skip : [],
      terminalSweeps: Array.isArray(parsed.terminalSweeps) ? parsed.terminalSweeps : [],
      stopsInFlight: Array.isArray(parsed.stopsInFlight) ? parsed.stopsInFlight : [],
      kills: Array.isArray(parsed.kills) ? parsed.kills : [],
    };
  } catch {
    return emptyState();
  }
}

function readBootTimeMs(procRoot: string): number | undefined {
  try {
    const match = /^btime\s+(\d+)$/mu.exec(fs.readFileSync(path.join(procRoot, "stat"), "utf8"));
    return match ? Number(match[1]) * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function fileSignature(file: string | undefined): string | undefined {
  if (!file) {
    return undefined;
  }
  try {
    const stat = fs.statSync(file);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function commTop(members: readonly GovProc[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const m of members) {
    counts.set(m.comm, (counts.get(m.comm) ?? 0) + 1);
  }
  return [...counts].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
}

export function sessionKey(view: SessionView): string {
  return `${view.sid}:${view.record.leaderStartTicks ?? `f${view.record.firstSeenMs}`}`;
}

export type StartOutcome = { readonly exitCode: number } | { readonly started: true };

export class Governor {
  readonly settings: GovernorSettings;
  private readonly deps: GovernorDeps;
  private readonly g: GovernorConstants;
  private state: GovernorState;
  private memory: Map<number, GroupRecord>;
  private systemSid = 0;
  private selfStartTicks = "";
  private observeReason: string | null = null;
  private clickhouseAllowed: boolean;
  private bootTimeMs: number | undefined;
  private latestByPid: ReadonlyMap<number, GovProc> = new Map();
  private readonly tokenCache = new Map<string, TokenState>();
  private leaseOwners = new Map<number, OwnerFacts>();
  private queueReadable = true;
  private lastCensusMs = Number.NEGATIVE_INFINITY;
  private lastGroupsSaveMs = Number.NEGATIVE_INFINITY;
  private lastHeartbeatMs = Number.NEGATIVE_INFINITY;
  private lastPeaksSaveMs = Number.NEGATIVE_INFINITY;
  private lastSystemCheckMs = 0;
  private groupsDirty = false;
  private readonly alarmAt = new Map<string, number>();
  private readonly wouldKillAt = new Map<string, number>();
  private readonly verifications: Verification[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private readonly burst: BurstTracker;
  private prevCounts = new Map<string, number>();
  /** Sessions swept in the current tick: R2 must not pick a session R1 just emptied. */
  private sweptThisTick = new Set<number>();
  private fastUntilMs = 0;
  private peaks: PeaksDay;
  private entrySignature: string | undefined;
  private entryChangedAtMs: number | undefined;
  private startedAtMs: number;
  private niceApplied: number | null = null;
  private lastScanMs = 0;
  private lastIntervalMs = 0;

  constructor(deps: GovernorDeps, settings: GovernorSettings) {
    this.deps = deps;
    this.settings = settings;
    this.g = settings.constants.governor;
    this.clickhouseAllowed = settings.clickhouseAllowed;
    this.state = loadState(this.file("state.json"));
    this.memory = loadGroupMemory(this.file("groups.json"));
    this.burst = new BurstTracker(this.g);
    this.startedAtMs = deps.now();
    this.peaks = loadPeaksDay(this.peaksFile(utcDay(this.startedAtMs)), utcDay(this.startedAtMs));
  }

  private file(name: string): string {
    return path.join(this.deps.dir, name);
  }

  private peaksFile(day: string): string {
    return path.join(this.deps.dir, "peaks", `${day}.json`);
  }

  get mode(): GovernorMode {
    return this.observeReason ? "observe" : this.g.mode;
  }

  // -------------------------------------------------------------------------
  // start-up: system-session check (§3.3, §18 C6), lock (§7.2), nice, unfinished work
  // -------------------------------------------------------------------------

  /** Exit codes: 2 = refused (not in the system session, or the lock is held by a live governor). */
  start(): StartOutcome {
    fs.mkdirSync(this.deps.dir, { recursive: true });
    const refused = this.identify();
    if (refused !== undefined) {
      return { exitCode: refused };
    }
    if (!this.takeLock()) {
      this.deps.log("process-governor: REFUSED — the lock is held by another live governor (E16)");
      return { exitCode: 2 };
    }
    this.resume();
    return { started: true };
  }

  /** Own identity and the system-session check; an exit code when the start is refused. */
  private identify(): number | undefined {
    const scan = scanProcTable(this.deps.procRoot, parseGovProcStat);
    const self = scan.byPid.get(this.deps.selfPid);
    if (!self) {
      this.deps.log("process-governor: cannot read its own /proc entry; refusing to start");
      return 2;
    }
    this.systemSid = self.sid;
    this.selfStartTicks = self.startTicks;
    const check = this.systemCheck(scan.measured ? scan.byPid : undefined);
    if (check === "mismatch") {
      this.deps.log(
        "process-governor: REFUSED — its session is not the entrypoint's (sid of PID 1's earliest child); a manual start cannot govern (E16)",
      );
      return 2;
    }
    if (check === "unavailable") {
      this.observeReason = "system-session-check-unavailable";
      this.clickhouseAllowed = false;
      this.deps.log(
        "process-governor: system-session check could not be made; observe-only, local events only, re-checking every minute",
      );
    }
    return undefined;
  }

  /** After the lock: priority, unfinished stops, pending peaks rows. */
  private resume(): void {
    this.applyNice();
    this.bootTimeMs = readBootTimeMs(this.deps.procRoot);
    if (this.state.stopsInFlight.length > 0) {
      this.finishStopsInFlight();
    }
    this.entrySignature = fileSignature(this.deps.entryFile);
    this.recordPendingPeaks(this.deps.now());
    const flags = `${this.settings.testMode ? " test=true" : ""}${this.settings.testRig ? " test-rig" : ""}`;
    this.deps.log(
      `process-governor: started pid=${this.deps.selfPid} mode=${this.mode} configured=${this.g.mode} governTerminals=${this.g.governTerminals} systemSid=${this.systemSid}${flags}`,
    );
  }

  /** `ok` · `mismatch` (definite) · `unavailable` (the check cannot be made). */
  private systemCheck(
    byPid: ReadonlyMap<number, GovProc> | undefined,
  ): "ok" | "mismatch" | "unavailable" {
    if (this.settings.testRig) {
      return "ok";
    }
    const sid = byPid ? entrypointSid(byPid) : undefined;
    if (sid === undefined) {
      return "unavailable";
    }
    return sid === this.systemSid ? "ok" : "mismatch";
  }

  private takeLock(): boolean {
    const lock = this.file("lock");
    const body = JSON.stringify({ pid: this.deps.selfPid, startTicks: this.selfStartTicks });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(lock, body, { flag: "wx" });
        return true;
      } catch {
        if (this.lockHeldByOtherLiveGovernor(lock)) {
          return false;
        }
        fs.rmSync(lock, { force: true });
      }
    }
    return false;
  }

  /** The lock names a live process (pid + start ticks, the lease rule) that is not this one. */
  private lockHeldByOtherLiveGovernor(lock: string): boolean {
    let holder: { pid?: unknown; startTicks?: unknown } = {};
    try {
      holder = JSON.parse(fs.readFileSync(lock, "utf8")) as typeof holder;
    } catch {
      return false; // unreadable or half-written: stale
    }
    if (typeof holder.pid !== "number" || holder.pid === this.deps.selfPid) {
      return false;
    }
    const entry = scanProcTable(this.deps.procRoot, parseGovProcStat).byPid.get(holder.pid);
    return entry !== undefined && entry.startTicks === holder.startTicks;
  }

  releaseLock(): void {
    try {
      const holder = JSON.parse(fs.readFileSync(this.file("lock"), "utf8")) as { pid?: number };
      if (holder.pid === this.deps.selfPid) {
        fs.rmSync(this.file("lock"), { force: true });
      }
    } catch {
      // not ours or gone
    }
  }

  /**
   * Stops a previous run left in flight: the owner census runs FIRST (lease-named owners are part of
   * the guard), then every stop is re-judged by `finishStops`; a released one becomes an event.
   */
  private finishStopsInFlight(): void {
    const nowMs = this.deps.now();
    this.latestByPid = scanProcTable(this.deps.procRoot, parseGovProcStat).byPid;
    this.refreshCensus(nowMs);
    const outcomes = finishStops(this.sweepDeps(), this.state.stopsInFlight, {
      kill: this.mode === "enforce",
    });
    for (const o of outcomes.filter((x) => x.outcome === "released")) {
      this.record({
        ...this.baseEvent("stop_released", nowMs),
        processes: 1,
        notify_status: o.reason ?? "",
      });
    }
    const killed = outcomes.filter((x) => x.outcome === "killed").length;
    this.deps.log(
      `process-governor: ${outcomes.length} stop(s) left in flight by a previous run: ${killed} killed, ${outcomes.length - killed} released or gone`,
    );
  }

  private applyNice(): void {
    try {
      (this.deps.setPriority ?? ((n: number) => os.setPriority(0, n)))(this.g.nice);
      this.niceApplied = this.g.nice;
      this.deps.log(`process-governor: priority set to nice ${this.g.nice}`);
    } catch (error) {
      this.deps.log(
        `process-governor: could not set nice ${this.g.nice} (${error instanceof Error ? error.message : String(error)}); running at the inherited priority`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // the loop
  // -------------------------------------------------------------------------

  private stillAlive = (proc: GovProc): boolean => {
    try {
      const fresh = parseGovProcStat(
        fs.readFileSync(`${this.deps.procRoot}/${proc.pid}/stat`, "utf8"),
      );
      return fresh?.startTicks === proc.startTicks && fresh.state !== "Z" && fresh.state !== "X";
    } catch {
      return false;
    }
  };

  private guard(): GuardContext {
    return {
      systemSid: this.systemSid,
      selfPid: this.deps.selfPid,
      leaseOwnerPids: new Set(this.leaseOwners.keys()),
      tokenState: cachedTokenState(this.deps.procRoot, () => this.latestByPid, this.tokenCache),
      stillAlive: this.stillAlive,
    };
  }

  private sweepDeps(): SweepDeps {
    return {
      scan: () => {
        this.latestByPid = scanProcTable(this.deps.procRoot, parseGovProcStat).byPid;
        return this.latestByPid;
      },
      signal: this.deps.signal,
      guard: this.guard(),
      sleepSync: this.deps.sleepSync,
      now: this.deps.now,
      recordStops: (stops) => {
        this.state.stopsInFlight = [...stops];
        this.saveState();
      },
    };
  }

  private refreshCensus(nowMs: number): void {
    if (nowMs - this.lastCensusMs < this.g.ownerCensusRefreshMs) {
      return;
    }
    this.lastCensusMs = nowMs;
    try {
      fs.readdirSync(this.deps.queueDir);
      this.queueReadable = true;
    } catch (error) {
      // No queue dir yet = no owner can hold a lease: the census is complete. Anything else is blind.
      this.queueReadable = (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    }
    const owners = verifiedLeaseOwners({
      queueDir: this.deps.queueDir,
      sessionsDir: this.deps.sessionsDir,
      procRoot: this.deps.procRoot,
      nowMs,
      freshMs: this.settings.constants.leaseFreshMs,
    });
    this.leaseOwners = new Map(
      owners.map((owner) => [owner.pid, { sessionId: owner.sessionId, seatId: owner.seatId }]),
    );
  }

  private classifyContext(): ClassifyContext {
    return {
      systemSid: this.systemSid,
      leaseOwners: this.leaseOwners,
      tokenState: cachedTokenState(this.deps.procRoot, () => this.latestByPid, this.tokenCache),
    };
  }

  /**
   * One scan and everything it triggers. Returns the delay to the next scan, or an exit code when
   * the governor should stop (self-restart on a new build, or a definite system-session mismatch).
   */
  tick(): { nextMs: number } | { exitCode: number } {
    const nowMs = this.deps.now();
    const scan = scanProcTable(this.deps.procRoot, parseGovProcStat);
    this.latestByPid = scan.byPid;
    const recheck = this.recheckSystem(nowMs, scan.measured ? scan.byPid : undefined);
    if (recheck !== undefined) {
      return { exitCode: recheck };
    }
    const cgroup = readCgroup(this.deps.cgroupRoot);
    this.refreshCensus(nowMs);
    const { sessions, memoryChanged } = classifySessions(
      scan.byPid,
      this.classifyContext(),
      this.memory,
      nowMs,
    );
    this.groupsDirty ||= memoryChanged;
    this.sweptThisTick = new Set();
    const box = {
      committed: cgroup.committed?.committedBytes,
      limit: this.settings.limitBytes ?? cgroup.limitBytes,
      psi: cgroup.memoryPressure.fullAvg10,
    };
    for (const view of r1Matches(sessions.values(), this.g)) {
      this.act(view, "fork-storm", nowMs, box);
    }
    this.memoryRule(scan.measured, sessions, nowMs, box);
    this.burstAlarm(sessions, nowMs);
    this.runVerifications(nowMs, box);
    this.trackPeaks(sessions, nowMs);
    this.persist(nowMs);
    this.lastScanMs = this.deps.now() - nowMs;
    const nextMs = this.cadence(sessions, nowMs);
    this.lastIntervalMs = nextMs;
    this.writeHeartbeat(nowMs, scan.measured, sessions);
    this.track(
      this.deps.notifier.tick(nowMs).then((dropped) => this.recordDropped(dropped, nowMs)),
    );
    this.track(this.deps.clickhouse.flush());
    const restart = this.selfRestartDue(nowMs);
    return restart ? { exitCode: 0 } : { nextMs };
  }

  /** §18 C6: an observe-only governor re-tries the check each minute. */
  private recheckSystem(
    nowMs: number,
    byPid: ReadonlyMap<number, GovProc> | undefined,
  ): number | undefined {
    if (this.observeReason !== "system-session-check-unavailable") {
      return undefined;
    }
    if (nowMs - this.lastSystemCheckMs < SYSTEM_RECHECK_MS) {
      return undefined;
    }
    this.lastSystemCheckMs = nowMs;
    const check = this.systemCheck(byPid);
    if (check === "mismatch") {
      this.deps.log(
        "process-governor: system-session check now FAILS (mismatch); releasing the lock, exit 2",
      );
      this.releaseLock();
      return 2;
    }
    if (check === "ok") {
      this.observeReason = null;
      this.clickhouseAllowed = this.settings.clickhouseAllowed;
      this.deps.log(`process-governor: system-session check passed; mode ${this.mode}`);
    } else {
      this.deps.log(
        "process-governor: system-session check still unavailable; observe-only, local events only",
      );
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // events
  // -------------------------------------------------------------------------

  private baseEvent(action: GovernorAction, nowMs: number): GovernorEvent {
    return emptyEvent(
      { box: this.settings.box, mode: this.mode, test: this.settings.testMode, action },
      nowMs,
    );
  }

  private startedAt(view: SessionView): string | null {
    const ticks = view.leader
      ? view.leader.startTicks
      : view.members
          .map((m) => m.startTicks)
          .toSorted((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))[0];
    if (ticks === undefined || this.bootTimeMs === undefined) {
      return null;
    }
    return clickhouseTime(this.bootTimeMs + Number(ticks) * (1000 / USER_HZ));
  }

  private sessionEvent(
    view: SessionView,
    rule: GovernorRule,
    action: GovernorAction,
    nowMs: number,
    box: BoxReading,
    anonBytes?: number,
  ): GovernorEvent {
    return {
      ...this.baseEvent(action, nowMs),
      ...attributionFields(view),
      ...boxFields(box),
      rule,
      orphaned: view.orphaned,
      processes: view.members.length,
      threads: view.threads,
      anon_bytes: anonBytes ?? sessionAnonBytes(view, this.deps.readStatus),
      comm_top: commTop(view.members),
      started_at: this.startedAt(view),
    };
  }

  private record(event: GovernorEvent, sid?: number): void {
    appendEventFile(this.file("events.ndjson"), event, this.g.eventsRotateBytes);
    this.deps.log(eventLogLine(event, sid));
    if (this.clickhouseAllowed) {
      this.deps.clickhouse.enqueue(clickhouseRow(event));
    }
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch((error: unknown) => {
      this.deps.log(
        `process-governor: async step failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    this.pending.add(tracked);
    void tracked.finally(() => this.pending.delete(tracked));
  }

  /** Every notification and ClickHouse write started so far (tests; a clean exit). */
  async settle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
    await this.deps.clickhouse.flush();
  }

  private recordDropped(dropped: number, nowMs: number): void {
    for (let i = 0; i < dropped; i += 1) {
      this.record({ ...this.baseEvent("notify_dropped", nowMs), notify_status: "expired" });
    }
  }

  /** At most one event per key per `alarmRepeatMs` (`pressure_no_victim`, `r2_blind`, bursts). */
  private alarm(key: string, nowMs: number, build: () => GovernorEvent): void {
    const last = this.alarmAt.get(key);
    if (last !== undefined && nowMs - last < this.g.alarmRepeatMs) {
      return;
    }
    this.alarmAt.set(key, nowMs);
    this.record(build());
  }

  // -------------------------------------------------------------------------
  // acting on a match: would_kill (observe / exempt) or the sweep (enforce)
  // -------------------------------------------------------------------------

  private wouldKill(
    view: SessionView,
    rule: GovernorRule,
    nowMs: number,
    box: { committed?: number; limit?: number; psi?: number },
    status: string,
    anonBytes?: number,
  ): void {
    const key = `${sessionKey(view)}\0${rule}\0${status}`;
    const last = this.wouldKillAt.get(key);
    if (last !== undefined && nowMs - last < this.g.messageDedupeMs) {
      return;
    }
    this.wouldKillAt.set(key, nowMs);
    const event = this.sessionEvent(view, rule, "would_kill", nowMs, box, anonBytes);
    this.record({ ...event, notify_status: status }, view.sid);
  }

  private act(
    view: SessionView,
    rule: "fork-storm" | "memory-emergency",
    nowMs: number,
    box: { committed?: number; limit?: number; psi?: number },
    anonBytes?: number,
  ): void {
    const placement = view.record.placement;
    if (!placement.governed) {
      return;
    }
    if (isExemptTerminal(placement, this.g.governTerminals)) {
      // §18 C4: no signal, no in-band line, no message — one would_kill, so a terminal storm is seen.
      this.wouldKill(view, rule, nowMs, box, "exempt-terminal", anonBytes);
      return;
    }
    if (this.mode === "observe") {
      // U2: observe mode emits ZERO signals, ZERO in-band lines, ZERO messages.
      this.wouldKill(view, rule, nowMs, box, "observe", anonBytes);
      return;
    }
    this.kill(view, rule, nowMs, box, anonBytes);
  }

  /** §5.1: a terminal's interactive shell keeps its own group once; within 60 s it goes too. */
  private terminalSpare(view: SessionView, nowMs: number): number | undefined {
    const placement = view.record.placement;
    if (
      !placement.governed ||
      placement.kind !== "terminal" ||
      !view.leader ||
      view.leader.ttyNr === 0
    ) {
      return undefined;
    }
    const key = sessionKey(view);
    const recent = this.state.terminalSweeps.filter(
      (t) => nowMs - t.atMs < this.g.terminalLeaderGraceMs,
    );
    const again = recent.some((t) => t.key === key);
    this.state.terminalSweeps = [...recent.filter((t) => t.key !== key), { key, atMs: nowMs }];
    return again ? undefined : view.leader.pgid;
  }

  private kill(
    view: SessionView,
    rule: "fork-storm" | "memory-emergency",
    nowMs: number,
    box: BoxReading,
    anonBytes?: number,
  ): void {
    const event = this.sessionEvent(view, rule, "killed", nowMs, box, anonBytes);
    const facts = this.killFacts(view, event, box);
    if (view.leader) {
      writeInBand(this.deps.procRoot, view.leader, inBandLine(facts), this.stillAlive);
    }
    const sparePgid = this.terminalSpare(view, nowMs);
    this.sweep(view, event, sparePgid);
    this.state.kills.push({
      atMs: nowMs,
      rule,
      processes: view.members.length,
      kind: event.session_kind,
      eventId: event.event_id,
    });
    for (const delay of VERIFY_DELAYS_MS) {
      const key = sessionKey(view);
      this.verifications.push({
        sid: view.sid,
        key,
        dueMs: nowMs + delay,
        sweepNo: 1,
        sparePgid,
        rule,
      });
    }
    this.peakKilled(view);
    this.saveState();
    const target = messageTarget(view);
    this.track(
      this.deps.notifier
        .notify(target?.id ?? sessionKey(view), target, facts, nowMs)
        .then((status) => {
          event.notify_status = status;
          event.notified = status === "sent";
          this.record(event, view.sid);
        }),
    );
  }

  private killFacts(view: SessionView, event: GovernorEvent, box: BoxReading): KillFacts {
    return {
      rule: event.rule === "memory-emergency" ? "memory-emergency" : "fork-storm",
      processes: view.members.length,
      limit: this.g.maxGroupProcesses,
      anonBytes: event.anon_bytes ?? undefined,
      committedBytes: box.committed,
      limitBytes: box.limit,
      commTop: event.comm_top,
      eventId: event.event_id,
      startedAt: event.started_at ?? undefined,
      orphaned: view.orphaned,
    };
  }

  /** §5.1 steps 2–5; fills the event's rounds, kill_ms and survivors. */
  private sweep(view: SessionView, event: GovernorEvent, sparePgid: number | undefined): void {
    this.sweptThisTick.add(view.sid);
    const result = sweepSession(this.sweepDeps(), {
      sid: view.sid,
      sparePgid,
      rounds: this.g.sweepRounds,
      roundIntervalMs: this.g.sweepRoundIntervalMs,
    });
    event.rounds = result.rounds;
    event.kill_ms = Math.round(result.killMs);
    event.survivors = result.survivors;
    if (result.eperm && result.survivors > 0) {
      event.action = "kill_failed_eperm";
    }
    const guarded =
      result.guardedPgids.length > 0
        ? ` GUARDED_PGIDS=${result.guardedPgids.length} fallback_stops=${result.fallbackStops}`
        : "";
    this.deps.log(
      `process-governor sweep sid=${view.sid} rule=${event.rule} rounds=${result.rounds} kill_ms=${event.kill_ms} survivors=${result.survivors} groups=${result.groupsSignalled}${guarded}`,
    );
  }

  /** §5.1 step 6: a fresh scan 1 s and 10 s after a sweep; survivors ⇒ kill_incomplete + resweep. */
  private runVerifications(nowMs: number, box: BoxReading): void {
    const due = this.verifications.filter((v) => v.dueMs <= nowMs);
    if (due.length === 0) {
      return;
    }
    for (const v of due) {
      this.verifications.splice(this.verifications.indexOf(v), 1);
    }
    const ctx = this.classifyContext();
    const { sessions } = classifySessions(this.latestByPid, ctx, this.memory, nowMs);
    for (const v of due) {
      const view = sessions.get(v.sid);
      if (view && sessionKey(view) === v.key) {
        this.verifyOne(view, v, nowMs, box);
      }
    }
  }

  private verifyOne(view: SessionView, v: Verification, nowMs: number, box: BoxReading): void {
    const survivors = view.members.filter((m) => m.pgid !== v.sparePgid).length;
    if (survivors === 0) {
      return;
    }
    const loud = v.sweepNo >= MAX_SWEEPS;
    const event = this.sessionEvent(view, v.rule, "kill_incomplete", nowMs, box);
    this.record(
      { ...event, survivors, rounds: v.sweepNo, notify_status: loud ? "loud" : "resweep" },
      v.sid,
    );
    if (loud) {
      this.deps.log(
        `process-governor: LOUD — ${survivors} survivor(s) of sid=${v.sid} after ${MAX_SWEEPS} sweeps`,
      );
      return;
    }
    sweepSession(this.sweepDeps(), {
      sid: v.sid,
      sparePgid: v.sparePgid,
      rounds: this.g.sweepRounds,
      roundIntervalMs: this.g.sweepRoundIntervalMs,
    });
    for (const delay of VERIFY_DELAYS_MS) {
      this.verifications.push({ ...v, dueMs: nowMs + delay, sweepNo: v.sweepNo + 1 });
    }
  }

  // -------------------------------------------------------------------------
  // R2 — memory emergency
  // -------------------------------------------------------------------------

  private memoryRule(
    measured: boolean,
    sessions: ReadonlyMap<number, SessionView>,
    nowMs: number,
    box: BoxReading,
  ): void {
    const limit = box.limit;
    if (limit === undefined || !this.r2Armed(measured, nowMs, box)) {
      return;
    }
    this.state.r2Skip = this.state.r2Skip.filter((s) => nowMs - s.atMs < this.g.r2SkipWindowMs);
    const choice = chooseR2Victim(
      this.r2Candidates(sessions),
      victimFloorBytes(limit, this.g),
      this.state.r2Skip,
      nowMs,
      this.g,
    );
    const exempt = choice.exemptLargest;
    if (exempt) {
      this.wouldKill(
        exempt.view,
        "memory-emergency",
        nowMs,
        box,
        "exempt-terminal",
        exempt.freeable,
      );
    }
    if (!choice.victim) {
      this.alarm("pressure_no_victim", nowMs, () => ({
        ...this.baseEvent("pressure_no_victim", nowMs),
        ...boxFields(box),
        rule: "memory-emergency",
      }));
      return;
    }
    const victim = choice.victim;
    this.state.r2LastKillMs = nowMs;
    if (this.mode === "enforce") {
      this.state.r2Skip.push({ sid: victim.view.sid, atMs: nowMs, freeable: victim.freeable });
    }
    this.act(victim.view, "memory-emergency", nowMs, box, victim.freeable);
  }

  /** `C` is at or past `L − M_oom`, R2 can see, and the 2 s kill spacing has elapsed. */
  private r2Armed(measured: boolean, nowMs: number, box: BoxReading): boolean {
    if (box.committed === undefined || box.limit === undefined) {
      return false;
    }
    if (box.committed < emergencyLineBytes(box.limit, this.settings.constants)) {
      return false;
    }
    if (this.r2Blind(measured, nowMs, box)) {
      return false;
    }
    return nowMs - this.state.r2LastKillMs >= this.g.emergencyKillSpacingMs;
  }

  /**
   * R2 acts only on a measured scan and only while owner identification works (the argv token is
   * readable, or the lease census is complete); otherwise `r2_blind` and nothing (§4.2).
   */
  private r2Blind(measured: boolean, nowMs: number, box: BoxReading): boolean {
    const ownerIdOk =
      this.queueReadable || this.deps.tokenState(this.deps.selfPid) !== "unreadable";
    if (measured && ownerIdOk) {
      return false;
    }
    this.alarm("r2_blind", nowMs, () => ({
      ...this.baseEvent("r2_blind", nowMs),
      ...boxFields(box),
      rule: "memory-emergency",
      notify_status: measured ? "owner-identification-unavailable" : "scan-unmeasured",
    }));
    return true;
  }

  private r2Candidates(sessions: ReadonlyMap<number, SessionView>): R2Candidate[] {
    const guard = this.guard();
    return [...sessions.values()]
      .filter((view) => view.record.placement.governed && !this.sweptThisTick.has(view.sid))
      .map((view) => ({
        view,
        freeable: freeableBytes(view, guard, this.deps.readStatus, this.deps.uid),
        exempt: isExemptTerminal(view.record.placement, this.g.governTerminals),
      }));
  }

  // -------------------------------------------------------------------------
  // the ungoverned-burst alarm (§3.4) and fast mode (§4.2 cadence)
  // -------------------------------------------------------------------------

  /**
   * §3.4 as ruled in §19 D1(c): growth in every non-system session that is NOT governed — `outside` AND
   * owner sessions (which also makes Codex/Pi commands run inside an owner's own session visible, E1).
   * The "box notice" is this event + its ClickHouse row + the log line (§19 D4); no human channel in v1.
   */
  private burstAlarm(sessions: ReadonlyMap<number, SessionView>, nowMs: number): void {
    let ungoverned = 0;
    for (const view of sessions.values()) {
      const p = view.record.placement;
      if (!p.governed && p.reason !== "system") {
        ungoverned += view.members.length;
      }
    }
    const gain = this.burst.observe(nowMs, ungoverned);
    if (gain !== undefined) {
      this.alarm("ungoverned_burst", nowMs, () => ({
        ...this.baseEvent("ungoverned_burst", nowMs),
        processes: gain,
        notify_status: "box-notice",
      }));
    }
  }

  private cadence(sessions: ReadonlyMap<number, SessionView>, nowMs: number): number {
    const { counts, started, grew } = growthSummary(sessions, this.prevCounts, this.g);
    this.prevCounts = counts;
    if (started || (grew && nowMs < this.fastUntilMs)) {
      this.fastUntilMs = nowMs + this.g.fastHoldMs;
    }
    return nowMs < this.fastUntilMs ? this.g.fastScanIntervalMs : this.g.scanIntervalMs;
  }

  // -------------------------------------------------------------------------
  // peaks (§6.4, §18 C1)
  // -------------------------------------------------------------------------

  private trackPeaks(sessions: ReadonlyMap<number, SessionView>, nowMs: number): void {
    const today = utcDay(nowMs);
    if (today !== this.peaks.day) {
      savePeaksDay(path.join(this.deps.dir, "peaks"), this.peaks);
      this.peaks = loadPeaksDay(this.peaksFile(today), today);
      this.recordPendingPeaks(nowMs);
    }
    const sampleMemory = nowMs - this.lastPeaksSaveMs >= PEAKS_SAVE_MS;
    for (const view of sessions.values()) {
      this.updatePeak(view, sampleMemory);
    }
    if (sampleMemory) {
      this.lastPeaksSaveMs = nowMs;
      savePeaksDay(path.join(this.deps.dir, "peaks"), this.peaks);
    }
  }

  /**
   * The kind's day maxima (§18 C1): `processes` (with that session's comm classes and attribution)
   * and `anonBytes` are INDEPENDENT maxima. Memory is sampled once a minute — a spike shorter than a
   * minute can be missed (events carry their own anon_bytes).
   */
  private updatePeak(view: SessionView, sampleMemory: boolean): void {
    const p = view.record.placement;
    if (!p.governed) {
      return;
    }
    const peak = (this.peaks.kinds[p.kind] ??= {
      processes: 0,
      threads: 0,
      commTop: [],
      sessionId: "",
      seatId: "",
      attribution: "",
      anonBytes: 0,
      killed: false,
    });
    if (view.members.length > peak.processes) {
      const fields = attributionFields(view);
      peak.processes = view.members.length;
      peak.threads = view.threads;
      peak.commTop = commTop(view.members);
      peak.sessionId = fields.session_id ?? "";
      peak.seatId = fields.seat_id ?? "";
      peak.attribution = fields.attribution ?? "";
    }
    if (sampleMemory) {
      peak.anonBytes = Math.max(peak.anonBytes, sessionAnonBytes(view, this.deps.readStatus));
    }
  }

  private peakKilled(view: SessionView): void {
    const p = view.record.placement;
    if (p.governed) {
      const peak = this.peaks.kinds[p.kind];
      if (peak) {
        peak.killed = true;
      }
    }
  }

  /** Finished days not yet recorded (or delivered): their rows, once each locally. */
  private recordPendingPeaks(nowMs: number): void {
    const dir = path.join(this.deps.dir, "peaks");
    for (const day of pendingPeaksDays(dir, utcDay(nowMs))) {
      const rows = peaksEvents(day, {
        box: this.settings.box,
        mode: this.mode,
        test: this.settings.testMode,
      });
      if (!day.recorded) {
        for (const row of rows) {
          appendEventFile(this.file("events.ndjson"), row, this.g.eventsRotateBytes);
          this.deps.log(eventLogLine(row));
        }
        day.recorded = true;
      }
      if (this.clickhouseAllowed && this.deps.clickhouse.enabled) {
        for (const row of rows) {
          this.deps.clickhouse.enqueue(clickhouseRow(row));
        }
        const finished = day;
        this.track(
          this.deps.clickhouse.flush().then((outcome) => {
            finished.delivered = outcome === "ok";
            savePeaksDay(dir, finished);
          }),
        );
      } else {
        day.delivered = !this.deps.clickhouse.enabled;
      }
      savePeaksDay(dir, day);
    }
  }

  // -------------------------------------------------------------------------
  // persistence, heartbeat, self-restart
  // -------------------------------------------------------------------------

  private saveState(): void {
    writeFileAtomic(this.file("state.json"), `${JSON.stringify(this.state)}\n`);
  }

  private persist(nowMs: number): void {
    this.state.kills = this.state.kills.filter((k) => nowMs - k.atMs < DAY_MS);
    if (this.groupsDirty && nowMs - this.lastGroupsSaveMs >= GROUPS_SAVE_MIN_MS) {
      saveGroupMemory(this.file("groups.json"), this.memory);
      this.lastGroupsSaveMs = nowMs;
      this.groupsDirty = false;
    }
  }

  private writeHeartbeat(
    nowMs: number,
    measured: boolean,
    sessions: ReadonlyMap<number, SessionView>,
  ): void {
    if (nowMs - this.lastHeartbeatMs < HEARTBEAT_MIN_MS) {
      return;
    }
    this.lastHeartbeatMs = nowMs;
    const last = this.state.kills.at(-1);
    const lastKill: LastKill | null = last
      ? {
          at: new Date(last.atMs).toISOString(),
          rule: last.rule,
          processes: last.processes,
          sessionKind: last.kind,
          eventId: last.eventId,
        }
      : null;
    let processes = 0;
    let governed = 0;
    for (const view of sessions.values()) {
      processes += view.members.length;
      governed += view.record.placement.governed ? 1 : 0;
    }
    const hb: GovernorHeartbeat = {
      pid: this.deps.selfPid,
      startTicks: this.selfStartTicks,
      startedAt: new Date(this.startedAtMs).toISOString(),
      lastScanAt: new Date(nowMs).toISOString(),
      scanMs: this.lastScanMs,
      intervalMs: this.lastIntervalMs,
      mode: this.mode,
      configuredMode: this.g.mode,
      observeReason: this.observeReason,
      governTerminals: this.g.governTerminals,
      test: this.settings.testMode,
      nice: this.niceApplied,
      measured,
      processes,
      sessions: sessions.size,
      governed,
      killsLast24h: this.state.kills.length,
      lastKill,
      clickhouse: this.clickhouseAllowed ? this.deps.clickhouse.lastStatus : "not-allowed",
    };
    writeFileAtomic(this.file("heartbeat.json"), `${JSON.stringify(hb)}\n`);
  }

  /**
   * §7.2: once the entry file has changed and then stayed unchanged for 10 s, and nothing is in
   * flight (no verification due, no stop recorded), exit 0 so the supervisor starts the new build.
   */
  private selfRestartDue(nowMs: number): boolean {
    if (!this.newBuildStable(nowMs)) {
      return false;
    }
    if (this.verifications.length > 0 || this.state.stopsInFlight.length > 0) {
      return false;
    }
    this.deps.log(
      "process-governor: new build detected and stable for 10 s; exiting for the supervisor to restart it",
    );
    return true;
  }

  private lastSeenSignature: string | undefined;

  /** The entry file differs from the one this process started from, unchanged for 10 s. */
  private newBuildStable(nowMs: number): boolean {
    const signature = fileSignature(this.deps.entryFile);
    const changed =
      signature !== undefined && signature !== "missing" && signature !== this.entrySignature;
    if (!changed || this.lastSeenSignature !== signature) {
      this.lastSeenSignature = changed ? signature : undefined;
      this.entryChangedAtMs = changed ? nowMs : undefined;
      return false;
    }
    return nowMs - (this.entryChangedAtMs ?? nowMs) >= SELF_RESTART_STABLE_MS;
  }

  /** Persist everything and release the lock (clean exit). */
  shutdown(): void {
    saveGroupMemory(this.file("groups.json"), this.memory);
    savePeaksDay(path.join(this.deps.dir, "peaks"), this.peaks);
    this.saveState();
    this.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// the entry's arguments (§7.2, §10): test-only flags, accepted only with ACPX_GOVERNOR_TEST=1
// ---------------------------------------------------------------------------

export type GovernorArgs = {
  readonly testRig: boolean;
  readonly limitBytes?: number;
};

/**
 * The production entry takes NO argv. `--test-rig` and `--limit-bytes <n>` exist for the rig (§10) and
 * are refused unless `ACPX_GOVERNOR_TEST=1`; with it, every event is stamped `test`. There is no
 * `--enforce`: the mode is `CAPACITY_CONSTANTS.governor.mode`, nothing else (D1 decided "(a)").
 */
export function parseGovernorArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): GovernorArgs | { error: string } {
  if (argv.length > 0 && env.ACPX_GOVERNOR_TEST !== "1") {
    return { error: `${argv[0]} is a test-only flag: refused without ACPX_GOVERNOR_TEST=1` };
  }
  const args: { testRig: boolean; limitBytes?: number } = { testRig: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [name, inline] = argv[i].split("=", 2);
    const value = name === "--limit-bytes" && inline === undefined ? argv[(i += 1)] : inline;
    const error = applyArg(args, name, value);
    if (error) {
      return { error };
    }
  }
  return args;
}

function applyArg(
  args: { testRig: boolean; limitBytes?: number },
  name: string,
  value: string | undefined,
): string | undefined {
  if (name === "--limit-bytes") {
    if (value === undefined || !/^[1-9]\d*$/u.test(value)) {
      return "--limit-bytes needs a positive integer";
    }
    args.limitBytes = Number(value);
    return undefined;
  }
  if (value !== undefined || name !== "--test-rig") {
    return `unknown argument ${name}`;
  }
  args.testRig = true;
  return undefined;
}
