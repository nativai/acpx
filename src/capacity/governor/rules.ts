import { type CapacityConstants, type GovernorConstants } from "../constants.js";
import { parseStatusMemory } from "../leases.js";
import type { SessionView } from "./classify.js";
import { type GuardContext, protectedReason } from "./sweep.js";

/**
 * CONCEPTION 5d7a23b6 §4.2 — the two rules.
 *
 * R1 (fork storm): a governed session with ≥ `maxGroupProcesses` live processes is killed at once.
 * 128 is 14× the largest tool session measured and 2× everything outside owner sessions on the
 * busiest box (F7, F8). One fleet-wide number: count is the signature of a storm, memory is R2's.
 *
 * R2 (memory emergency): when committed memory `C = anon + kernel` reaches the gate's G2 line
 * `L − M_oom`, the governed session holding the most memory it can FREE (≥ the floor) is killed, one
 * every 2 s. `C`, `L` and `M_oom` are the admission gate's own (`cgroup.ts`, `constants.ts`), so a
 * probe and the governor can never disagree about where the box is.
 */

/** `M_oom = max(oomMarginFloor, oomMarginFraction × L)` — the admission gate's G2 margin. */
export function oomMarginBytes(limitBytes: number, constants: CapacityConstants): number {
  return Math.max(constants.oomMarginFloorBytes, constants.oomMarginFraction * limitBytes);
}

/** R2's line: `L − M_oom`. */
export function emergencyLineBytes(limitBytes: number, constants: CapacityConstants): number {
  return limitBytes - oomMarginBytes(limitBytes, constants);
}

export function victimFloorBytes(limitBytes: number, g: GovernorConstants): number {
  return Math.max(g.victimFloorBytes, g.victimFloorFraction * limitBytes);
}

/** R1: governed sessions at or above the process limit. Zombies are not members. */
export function r1Matches(sessions: Iterable<SessionView>, g: GovernorConstants): SessionView[] {
  return [...sessions].filter(
    (view) => view.record.placement.governed && view.members.length >= g.maxGroupProcesses,
  );
}

/** A runtime rebuild in progress: killing it leaves a half-built runtime (§4.2 "Order", E10). */
export function isMaintenance(view: SessionView): boolean {
  return view.members.some((m) => m.comm === "refresh.sh" || m.comm === "bootstrap.sh");
}

/** `Uid:` real uid from `/proc/<pid>/status`. */
export function parseStatusUid(status: string): number | undefined {
  const match = /^Uid:\s+(\d+)/mu.exec(status);
  return match ? Number(match[1]) : undefined;
}

/**
 * Σ (`RssAnon` + `VmPTE`) over the members the governor may signal: same uid, not stopped by the
 * guard (§4.2). Σ RssAnon over-reads a forked tree (copy-on-write pages counted per process), which
 * errs towards picking the runaway — used for ranking only.
 */
export function freeableBytes(
  view: SessionView,
  guard: GuardContext,
  readStatus: (pid: number) => string | undefined,
  uid: number,
): number {
  let bytes = 0;
  for (const member of view.members) {
    if (protectedReason(member, guard) !== undefined) {
      continue;
    }
    const status = readStatus(member.pid);
    if (status !== undefined && parseStatusUid(status) === uid) {
      bytes += parseStatusMemory(status);
    }
  }
  return bytes;
}

/** Σ RssAnon + VmPTE of every member, for events and peaks (no uid or guard filter). */
export function sessionAnonBytes(
  view: SessionView,
  readStatus: (pid: number) => string | undefined,
): number {
  let bytes = 0;
  for (const member of view.members) {
    const status = readStatus(member.pid);
    bytes += status === undefined ? 0 : parseStatusMemory(status);
  }
  return bytes;
}

export type R2Candidate = {
  readonly view: SessionView;
  readonly freeable: number;
  readonly exempt: boolean;
};

/** R2's skip list (§4.2): swept within the window and its freeable memory did not fall. */
export type R2SkipEntry = {
  readonly sid: number;
  readonly atMs: number;
  readonly freeable: number;
};

export type R2Choice = {
  readonly victim?: R2Candidate;
  /** The largest consumer overall was an exempt terminal (governTerminals:false): log it (§18 C4). */
  readonly exemptLargest?: R2Candidate;
};

/**
 * The victim: a non-exempt governed session at or above the floor, not on the skip list, maintenance
 * sessions last, then the most freeable memory first.
 */
export function chooseR2Victim(
  candidates: readonly R2Candidate[],
  floorBytes: number,
  skip: readonly R2SkipEntry[],
  nowMs: number,
  g: GovernorConstants,
): R2Choice {
  const skipped = (c: R2Candidate) =>
    skip.some(
      (s) => s.sid === c.view.sid && nowMs - s.atMs < g.r2SkipWindowMs && c.freeable >= s.freeable,
    );
  const eligible = candidates.filter((c) => c.freeable >= floorBytes && !skipped(c));
  const largest = eligible.toSorted((a, b) => b.freeable - a.freeable)[0];
  const victim = eligible
    .filter((c) => !c.exempt)
    .toSorted((a, b) => {
      const order = Number(isMaintenance(a.view)) - Number(isMaintenance(b.view));
      return order !== 0 ? order : b.freeable - a.freeable;
    })[0];
  return { victim, exemptLargest: largest?.exempt ? largest : undefined };
}

/**
 * §3.4 — the alarm for what cannot be placed: ungoverned, non-exempt sessions ("outside") gaining
 * more than `ungovernedBurstProcesses` within `ungovernedBurstWindowMs`. It never kills.
 */
export class BurstTracker {
  private samples: Array<{ atMs: number; count: number }> = [];

  constructor(private readonly g: GovernorConstants) {}

  /** Record this scan's count; returns the gain over the window when it exceeds the limit. */
  observe(nowMs: number, count: number): number | undefined {
    this.samples = this.samples.filter((s) => nowMs - s.atMs <= this.g.ungovernedBurstWindowMs);
    this.samples.push({ atMs: nowMs, count });
    const low = Math.min(...this.samples.map((s) => s.count));
    const gain = count - low;
    return gain > this.g.ungovernedBurstProcesses ? gain : undefined;
  }
}
