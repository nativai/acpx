import { isLiveState } from "../../process-tree-reap.js";
import type { GovProc, TokenState } from "./classify.js";

/**
 * CONCEPTION 5d7a23b6 §5.1 — the kill. SIGKILL every process group of the session, repeated until
 * the session is empty. The kernel walks a group under the tasklist lock and aborts (or carries the
 * signal into) a fork in flight, so a group kill cannot be outrun by forking; a list-then-kill walk
 * can, and did on 2026-11-08 (F3, F4: 10/10 vs 4/10 in the capped replica).
 *
 * 🛑 THE GUARD (§3.3, hard rule of every kill): in a scan taken immediately before the signal, no
 * member of the target pgid is PID 1, a system-session member, the governor, or a queue owner
 * (argv token or lease). A pgid that fails it is NEVER group-signalled — its unprotected members get
 * the defensive STOP-then-KILL fallback, its protected members nothing. Committed negative: "U1".
 */

/** `target < 0` signals the process group `-target`; injectable so tests record instead of kill. */
export type Signaller = (target: number, signal: NodeJS.Signals) => void;

export const realSignaller: Signaller = (target, signal) => {
  process.kill(target, signal);
};

export type GuardContext = {
  readonly systemSid: number;
  readonly selfPid: number;
  readonly leaseOwnerPids: ReadonlySet<number>;
  readonly tokenState: (pid: number) => TokenState;
  /** The process at `proc.pid` is still the one born at `proc.startTicks`. */
  readonly stillAlive: (proc: GovProc) => boolean;
};

function structuralReason(proc: GovProc, guard: GuardContext): string | undefined {
  if (proc.pid <= 1 || proc.pgid <= 1 || proc.sid <= 1) {
    return "pid1";
  }
  if (proc.sid === guard.systemSid) {
    return "system";
  }
  return proc.pid === guard.selfPid ? "governor" : undefined;
}

/**
 * CONCEPTION §19 D5 — the owner-token argv read happens only for a member that COULD be an owner: the
 * session leader (an owner session protects every member through it) or a process named `node`
 * (F12's fork → setsid → exec window: the future owner is still the forked node CLI). Every member
 * still gets the structural guard and the lease check (pid and sid).
 *
 * The invariant that makes this safe (§3.3): a process group never spans sessions (`setpgid` into
 * another session's group fails EPERM; `setsid` makes a new group), and every acpx queue owner is
 * spawned detached, so it LEADS its own session. Hence no pgid of a governed session holds a running
 * owner. Premise pinned by "integration: GOVERNOR PREMISE (§19 D5) …".
 *
 * ⚠️ DO NOT "restore" the per-member read for every member. It looks like extra safety and it is the
 * D3a latency bug: ~1,000 argv reads under a storm cost 57–213 ms before the first signal, while the
 * bomb kept forking (TE re-verify of D3a; profile in impl-evidence/fix-round/d3a-latency-profile).
 */
function mayBeOwner(proc: GovProc): boolean {
  return proc.pid === proc.sid || proc.comm === "node";
}

function tokenIfMayBeOwner(proc: GovProc, guard: GuardContext): TokenState {
  return mayBeOwner(proc) ? guard.tokenState(proc.pid) : "absent";
}

function ownerReason(proc: GovProc, guard: GuardContext): string | undefined {
  if (guard.leaseOwnerPids.has(proc.pid) || guard.leaseOwnerPids.has(proc.sid)) {
    return "owner-lease";
  }
  const token = tokenIfMayBeOwner(proc, guard);
  // An owner leads its own session, so its adapter and harness are protected through the leader:
  // "queue-owner sessions are never touched" (§3.3), not just the owner process itself.
  if (token === "owner" || (proc.sid !== proc.pid && guard.tokenState(proc.sid) === "owner")) {
    return "owner-token";
  }
  // Uncertainty means no group kill: a LIVE process whose argv cannot be read is not proven a
  // non-owner. One that exited since the scan reads `unreadable` too and protects nothing — in a
  // storm members die every millisecond, and treating them as owners would push every group onto
  // the slow per-pid fallback.
  return token === "unreadable" && guard.stillAlive(proc) ? "owner-unverified" : undefined;
}

/** Why `proc` may never be signalled, or undefined when it may. */
export function protectedReason(proc: GovProc, guard: GuardContext): string | undefined {
  return structuralReason(proc, guard) ?? ownerReason(proc, guard);
}

export type StopRecord = { readonly pid: number; readonly startTicks: string };

export type SweepDeps = {
  /** A fresh `/proc` stat scan. */
  readonly scan: () => ReadonlyMap<number, GovProc>;
  readonly signal: Signaller;
  readonly guard: GuardContext;
  readonly sleepSync: (ms: number) => void;
  readonly now: () => number;
  /** Persist the stops in flight BEFORE the first SIGSTOP; called with [] once they are killed. */
  readonly recordStops: (stops: readonly StopRecord[]) => void;
};

export type SweepOptions = {
  readonly sid: number;
  /** A terminal's interactive shell keeps its own group on the first sweep (§5.1). */
  readonly sparePgid?: number;
  readonly rounds: number;
  readonly roundIntervalMs: number;
  /**
   * The scan the kill DECISION was taken on. Round 1 signals from it — its guard is evaluated on it,
   * right before the signal — instead of re-scanning /proc first; later rounds re-scan. Any process
   * born since is a fork of a member: it inherits the member's pgid (so the group kill reaches it) and
   * cannot become an owner without exec'ing acpx (round 2 re-guards it). Measured on a ~8,000/s bomb:
   * the round-1 re-scan cost 30–214 ms before the first signal (CONCEPTION §19, TE re-verify of D3a).
   */
  readonly decisionScan?: ReadonlyMap<number, GovProc>;
};

export type SweepResult = {
  /** Rounds that signalled at least one group (1–2 measured). */
  readonly rounds: number;
  readonly killMs: number;
  /** Members still alive in the final scan (the spared leader group excluded). */
  readonly survivors: number;
  readonly groupsSignalled: number;
  /** A group or pid signal was refused with EPERM (a root-owned member, E19). */
  readonly eperm: boolean;
  /** Pgids that failed the guard — should never happen for a governed session. */
  readonly guardedPgids: readonly number[];
  readonly fallbackStops: number;
  /** Distinct members of the signalled groups, across all rounds — what the sweep actually killed. */
  readonly signalled: number;
};

function sessionMembers(
  byPid: ReadonlyMap<number, GovProc>,
  sid: number,
  sparePgid: number | undefined,
): GovProc[] {
  return [...byPid.values()].filter(
    (p) => p.sid === sid && isLiveState(p.state) && p.pgid !== sparePgid,
  );
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/** Signal; true on EPERM. ESRCH (it just died) is success. */
function send(deps: SweepDeps, target: number, sig: NodeJS.Signals): boolean {
  try {
    deps.signal(target, sig);
    return false;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function sameLive(deps: SweepDeps, proc: StopRecord): GovProc | undefined {
  const now = deps.scan().get(proc.pid);
  return now && now.startTicks === proc.startTicks && isLiveState(now.state) ? now : undefined;
}

/** Depth of `pid` in the scan's parent chain — STOP parents before children (top-down). */
function depthOf(byPid: ReadonlyMap<number, GovProc>, pid: number): number {
  let depth = 0;
  for (let p = byPid.get(pid); p && depth < 4096; p = byPid.get(p.ppid)) {
    depth += 1;
  }
  return depth;
}

/**
 * §5.1 step 5, the defensive fallback: freeze the unprotected members of a guarded pgid top-down
 * (a stopped process cannot fork), pick up children born meanwhile, then SIGKILL one by one, each
 * re-checked by start ticks. Every stop is recorded before it is sent, so a governor that dies here
 * finishes the job on restart ({@link finishStops}) and never leaves a frozen process.
 */
function stopThenKill(
  deps: SweepDeps,
  sid: number,
  pgids: ReadonlySet<number>,
): { stops: number; eperm: boolean } {
  const stopped = new Map<number, StopRecord>();
  let eperm = false;
  for (let pass = 0; pass < 3; pass += 1) {
    const result = stopPass(deps, sid, pgids, stopped);
    eperm ||= result.eperm;
    if (result.stopped === 0) {
      break;
    }
  }
  for (const record of stopped.values()) {
    if (sameLive(deps, record)) {
      eperm = send(deps, record.pid, "SIGKILL") || eperm;
    }
  }
  deps.recordStops([]);
  return { stops: stopped.size, eperm };
}

/** One top-down SIGSTOP pass over the not-yet-stopped, unprotected members of `pgids`. */
function stopPass(
  deps: SweepDeps,
  sid: number,
  pgids: ReadonlySet<number>,
  stopped: Map<number, StopRecord>,
): { stopped: number; eperm: boolean } {
  const byPid = deps.scan();
  const fresh = [...byPid.values()]
    .filter(
      (p) =>
        p.sid === sid &&
        pgids.has(p.pgid) &&
        isLiveState(p.state) &&
        !stopped.has(p.pid) &&
        protectedReason(p, deps.guard) === undefined,
    )
    .toSorted((a, b) => depthOf(byPid, a.pid) - depthOf(byPid, b.pid));
  for (const p of fresh) {
    stopped.set(p.pid, { pid: p.pid, startTicks: p.startTicks });
  }
  if (fresh.length > 0) {
    deps.recordStops([...stopped.values()]);
  }
  let eperm = false;
  for (const p of fresh) {
    if (sameLive(deps, p)) {
      eperm = send(deps, p.pid, "SIGSTOP") || eperm;
    }
  }
  return { stopped: fresh.length, eperm };
}

/** On start-up: SIGKILL every recorded stop that is still the same live process. */
export type StopOutcome = {
  readonly pid: number;
  /** `killed` — finished; `released` — SIGCONT, never killed; `gone` — no longer the recorded process. */
  readonly outcome: "killed" | "released" | "gone";
  readonly reason?: string;
};

/**
 * On start-up, the stops a dead governor left in flight (§5.1 step 5). Each one is judged AGAIN, on a
 * fresh scan: the start ticks must still match, and the FULL §3.3 guard must still hold — the pid can
 * have been recycled into an owner or the system session, or an owner can have been recognised since.
 * A stop that fails the guard (or any stop when `kill` is false, i.e. observe mode) gets SIGCONT and is
 * reported, never SIGKILL. Committed negative: "a recorded stop whose pid now belongs to an owner or the
 * system session is never killed" (test/governor-daemon.test.ts).
 */
export function finishStops(
  deps: SweepDeps,
  stops: readonly StopRecord[],
  options: { readonly kill: boolean },
): StopOutcome[] {
  const outcomes: StopOutcome[] = [];
  for (const record of stops) {
    const live = sameLive(deps, record);
    if (!live) {
      outcomes.push({ pid: record.pid, outcome: "gone" });
      continue;
    }
    const reason = protectedReason(live, deps.guard) ?? (options.kill ? undefined : "observe");
    send(deps, record.pid, reason === undefined ? "SIGKILL" : "SIGCONT");
    outcomes.push({
      pid: record.pid,
      outcome: reason === undefined ? "killed" : "released",
      reason,
    });
  }
  deps.recordStops([]);
  return outcomes;
}

/**
 * §5.1 steps 2–5: scan the session's members, `kill(-pgid, SIGKILL)` every pgid that passes the
 * guard, repeat every `roundIntervalMs` until no member remains (at most `rounds`), then the
 * fallback for guarded pgids. Synchronous: nothing else runs on the governor's thread meanwhile.
 */
export function sweepSession(deps: SweepDeps, options: SweepOptions): SweepResult {
  const started = deps.now();
  const run: SweepRun = {
    guarded: new Set(),
    refused: new Set(),
    signalled: new Set(),
    rounds: 0,
    groups: 0,
  };
  for (let round = 0; round < options.rounds; round += 1) {
    if (!sweepRound(deps, options, round, run)) {
      break;
    }
    deps.sleepSync(options.roundIntervalMs);
  }
  const fallback =
    run.guarded.size > 0
      ? stopThenKill(deps, options.sid, run.guarded)
      : { stops: 0, eperm: false };
  const survivors = sessionMembers(deps.scan(), options.sid, options.sparePgid).length;
  return {
    rounds: run.rounds,
    killMs: Math.max(0, deps.now() - started),
    survivors,
    groupsSignalled: run.groups,
    eperm: run.refused.size > 0 || fallback.eperm,
    guardedPgids: [...run.guarded],
    fallbackStops: fallback.stops,
    signalled: run.signalled.size + fallback.stops,
  };
}

type SweepRun = {
  /** Pgids that failed the guard: never group-signalled. */
  readonly guarded: Set<number>;
  /** Groups whose kill was refused (EPERM): retrying them every round changes nothing. */
  readonly refused: Set<number>;
  readonly signalled: Set<number>;
  rounds: number;
  groups: number;
};

/** One round; false when there was nothing left to signal. */
function sweepRound(deps: SweepDeps, options: SweepOptions, round: number, run: SweepRun): boolean {
  const scan = round === 0 && options.decisionScan ? options.decisionScan : deps.scan();
  const members = sessionMembers(scan, options.sid, options.sparePgid);
  const targets = roundTargets(members, deps.guard, run.guarded).filter(
    (pgid) => !run.refused.has(pgid),
  );
  if (targets.length === 0) {
    return false;
  }
  const targeted = new Set(targets);
  for (const m of members) {
    if (targeted.has(m.pgid)) {
      run.signalled.add(m.pid);
    }
  }
  run.rounds += 1;
  for (const pgid of targets) {
    if (send(deps, -pgid, "SIGKILL")) {
      run.refused.add(pgid);
    }
  }
  run.groups += targets.length;
  return true;
}

/** The pgids this round may group-signal; a pgid failing the guard joins `guarded` for good. */
function roundTargets(
  members: readonly GovProc[],
  guard: GuardContext,
  guarded: Set<number>,
): number[] {
  const byPgid = new Map<number, GovProc[]>();
  for (const m of members) {
    const group = byPgid.get(m.pgid);
    if (group) {
      group.push(m);
    } else {
      byPgid.set(m.pgid, [m]);
    }
  }
  // Each pid's argv is read at most ONCE per guard pass (still right before this round's signals):
  // without it the session leader's negative was re-read for every one of ~1,000 members.
  const memo = new Map<number, TokenState>();
  const once: GuardContext = {
    ...guard,
    tokenState: (pid) => {
      const known = memo.get(pid);
      if (known !== undefined) {
        return known;
      }
      const state = guard.tokenState(pid);
      memo.set(pid, state);
      return state;
    },
  };
  const targets: number[] = [];
  for (const [pgid, group] of byPgid) {
    if (pgid <= 1 || group.some((m) => protectedReason(m, once) !== undefined)) {
      guarded.add(pgid);
    } else if (!guarded.has(pgid)) {
      targets.push(pgid);
    }
  }
  return targets;
}
