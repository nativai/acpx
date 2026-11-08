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

function ownerReason(proc: GovProc, guard: GuardContext): string | undefined {
  if (guard.leaseOwnerPids.has(proc.pid) || guard.leaseOwnerPids.has(proc.sid)) {
    return "owner-lease";
  }
  const token = guard.tokenState(proc.pid);
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
export function finishStops(deps: SweepDeps, stops: readonly StopRecord[]): number {
  let killed = 0;
  for (const record of stops) {
    if (sameLive(deps, record)) {
      send(deps, record.pid, "SIGKILL");
      killed += 1;
    }
  }
  deps.recordStops([]);
  return killed;
}

/**
 * §5.1 steps 2–5: scan the session's members, `kill(-pgid, SIGKILL)` every pgid that passes the
 * guard, repeat every `roundIntervalMs` until no member remains (at most `rounds`), then the
 * fallback for guarded pgids. Synchronous: nothing else runs on the governor's thread meanwhile.
 */
export function sweepSession(deps: SweepDeps, options: SweepOptions): SweepResult {
  const started = deps.now();
  const guarded = new Set<number>();
  /** Groups whose kill was refused (EPERM): retrying them every round changes nothing. */
  const refused = new Set<number>();
  let rounds = 0;
  let groupsSignalled = 0;
  for (let round = 0; round < options.rounds; round += 1) {
    const members = sessionMembers(deps.scan(), options.sid, options.sparePgid);
    const targets = roundTargets(members, deps.guard, guarded).filter((pgid) => !refused.has(pgid));
    if (targets.length === 0) {
      break;
    }
    rounds += 1;
    for (const pgid of targets) {
      if (send(deps, -pgid, "SIGKILL")) {
        refused.add(pgid);
      }
    }
    groupsSignalled += targets.length;
    deps.sleepSync(options.roundIntervalMs);
  }
  const fallback =
    guarded.size > 0 ? stopThenKill(deps, options.sid, guarded) : { stops: 0, eperm: false };
  const survivors = sessionMembers(deps.scan(), options.sid, options.sparePgid).length;
  return {
    rounds,
    killMs: Math.max(0, deps.now() - started),
    survivors,
    groupsSignalled,
    eperm: refused.size > 0 || fallback.eperm,
    guardedPgids: [...guarded],
    fallbackStops: fallback.stops,
  };
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
  const targets: number[] = [];
  for (const [pgid, group] of byPgid) {
    if (pgid <= 1 || group.some((m) => protectedReason(m, guard) !== undefined)) {
      guarded.add(pgid);
    } else if (!guarded.has(pgid)) {
      targets.push(pgid);
    }
  }
  return targets;
}
