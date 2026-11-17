import path from "node:path";
import { BUILD_CONSTANTS, MIB } from "./constants.js";
import { parseStatusMemory, readProcessTable, readText } from "./leases.js";
import type { PendingReservation } from "./pending.js";

/**
 * The release build's admission arithmetic (CONCEPTION 25479d40 §3.2 steps 3–4, §5.1), pure apart
 * from the `/proc` walk: what a build entry charges in `P`, and the build test `acpx capacity` shows
 * as `build` and `run-build` waits on.
 *
 *   G         = ½ M                                                   growth allowance
 *   room      = L − M_oom − G − K'                                    K' = K without any build entry
 *   node room = MemAvailable − (K' − C) − G − N_floor                 only while borrowing (B > R)
 *   fits      ⇔ room ≥ bytes  ∧  (not borrowing ∨ node room ≥ bytes)
 *
 * `room ≥ bytes` is `K + bytes + G ≤ L − M_oom`: R2's line, less the build, less what agents may grow
 * while it runs. The node term is admission's own G3 with the build in it (review R7).
 */

export type BuildHolder = {
  readonly key: string;
  readonly phase: "waiting" | "building";
  readonly since: string;
  /** The admitter: the `run-build` process. */
  readonly pid: number;
  readonly buildPid: number | null;
  readonly bytes: number;
  /** What `P` charges for it right now: `bytes` while waiting, the larger remainder while building. */
  readonly chargedBytes: number;
};

export type BuildFigure = {
  /** Both terms hold — or the box is unconfigured / unmeasured (fail open, never held). */
  readonly fits: boolean;
  readonly needBytes: number;
  /** `L − M_oom − ½M − K'`; null when unmeasured. */
  readonly roomBytes: number | null;
  /** `MemAvailable − (K' − C) − ½M − N_floor` on a borrowing box, else null. */
  readonly nodeRoomBytes: number | null;
  /** `½M`; null when unmeasured. */
  readonly growthBytes: number | null;
  readonly holder: BuildHolder | null;
  /** One line an agent can act on — the text output's "release build:" line and `--need-build`'s. */
  readonly reason: string;
};

export type BuildTestInputs = {
  readonly needBytes: number;
  /** False on an unconfigured box: nothing is ever held (§3.3 of f7587c86). */
  readonly configured: boolean;
  /** Absent ⇒ unmeasured: nothing is held. */
  readonly measured?: {
    readonly limitBytes: number;
    readonly committedBytes: number;
    readonly marginBytes: number;
    readonly oomMarginBytes: number;
    /** K, including every pending entry. */
    readonly chargedBytes: number;
    /** The build entries' share of K's `P`. */
    readonly buildBytes: number;
    /** B > R (or R unknown): the node guard applies. */
    readonly borrowing: boolean;
    readonly nodeAvailableBytes: number | undefined;
    readonly nodeFloorBytes: number;
  };
  readonly holder: BuildHolder | null;
};

const gib = (bytes: number): string => `${(Math.max(0, bytes) / (1024 * MIB)).toFixed(2)} GiB`;

export function buildTest(inputs: BuildTestInputs): BuildFigure {
  const { needBytes, holder } = inputs;
  const m = inputs.measured;
  if (!inputs.configured || m === undefined) {
    const why = inputs.configured
      ? "unmeasured box (memory unreadable): a release build is never held"
      : "unconfigured box (no /etc/podinfo): a release build is never held";
    return {
      fits: true,
      needBytes,
      roomBytes: null,
      nodeRoomBytes: null,
      growthBytes: null,
      holder,
      reason: why,
    };
  }
  const growthBytes = Math.floor(BUILD_CONSTANTS.buildGrowthFraction * m.marginBytes);
  const chargedWithoutBuild = m.chargedBytes - m.buildBytes;
  const roomBytes = m.limitBytes - m.oomMarginBytes - growthBytes - chargedWithoutBuild;
  const nodeRoomBytes =
    m.borrowing && m.nodeAvailableBytes !== undefined
      ? m.nodeAvailableBytes -
        (chargedWithoutBuild - m.committedBytes) -
        growthBytes -
        m.nodeFloorBytes
      : null;
  const boxFits = roomBytes >= needBytes;
  const nodeFits = nodeRoomBytes === null || nodeRoomBytes >= needBytes;
  return {
    fits: boxFits && nodeFits,
    needBytes,
    roomBytes,
    nodeRoomBytes,
    growthBytes,
    holder,
    reason: buildReason({ needBytes, roomBytes, nodeRoomBytes, boxFits, nodeFits }),
  };
}

function buildReason(r: {
  needBytes: number;
  roomBytes: number;
  nodeRoomBytes: number | null;
  boxFits: boolean;
  nodeFits: boolean;
}): string {
  const node = r.nodeRoomBytes === null ? "" : `, node room ${gib(r.nodeRoomBytes)}`;
  const figures = `room ${gib(r.roomBytes)}${node}, needs ${gib(r.needBytes)}`;
  if (r.boxFits && r.nodeFits) {
    return `fits — ${figures}`;
  }
  if (!r.boxFits) {
    return `waits — ${figures} (frees as sessions finish and idle 5 min)`;
  }
  return `waits — ${figures} (the node this box borrows from has too little available; its other pods decide when that frees)`;
}

/** The free room the build test sees: the smaller of its two terms (the node term when it applies). */
export function effectiveRoomBytes(figure: BuildFigure): number | null {
  if (figure.roomBytes === null) {
    return null;
  }
  return figure.nodeRoomBytes === null
    ? figure.roomBytes
    : Math.min(figure.roomBytes, figure.nodeRoomBytes);
}

/** Σ (RssAnon + VmPTE) over `root` and every descendant (ppid links), from `procRoot`. */
export function measureProcessTreeBytes(procRoot: string, root: number): number {
  const table = readProcessTable(procRoot);
  if (!table.has(root)) {
    return 0;
  }
  const children = new Map<number, number[]>();
  for (const entry of table.values()) {
    children.set(entry.ppid, [...(children.get(entry.ppid) ?? []), entry.pid]);
  }
  let total = 0;
  const seen = new Set<number>();
  const stack = [root];
  for (let pid = stack.pop(); pid !== undefined; pid = stack.pop()) {
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const status = readText(path.join(procRoot, String(pid), "status"));
    if (status !== undefined) {
      total += parseStatusMemory(status);
    }
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

/**
 * While building, a build entry is charged in `P` at the LARGER of two remainders (review R12):
 *   bytes − measured tree        (Σ RssAnon + VmPTE over the child's tree — over-reads forked trees)
 *   bytes − (C_now − C_start)    (the cgroup's rise since the build began — holds others' growth too)
 * Each errs in a different direction, so the larger remainder is conservative against both. Clamped
 * to [0, bytes]: a cgroup that FELL since the start (sessions idled out) never charges more than the
 * reservation itself. A waiting entry, or one with no child recorded, keeps its full bytes.
 */
export function buildRemainderBytes(params: {
  readonly bytes: number;
  readonly treeBytes: number;
  readonly committedNowBytes: number | undefined;
  readonly committedAtStartBytes: number | undefined;
}): number {
  const remainders = [params.bytes - params.treeBytes];
  if (params.committedNowBytes !== undefined && params.committedAtStartBytes !== undefined) {
    remainders.push(params.bytes - (params.committedNowBytes - params.committedAtStartBytes));
  }
  return Math.min(params.bytes, Math.max(0, ...remainders));
}

/** Every building reservation with its remainder charge filled in; the rest unchanged. */
export function chargeBuildReservations(
  reservations: readonly PendingReservation[],
  procRoot: string,
  committedNowBytes: number | undefined,
): PendingReservation[] {
  return reservations.map((reservation) => {
    const { build } = reservation;
    if (build?.phase !== "building" || build.buildPid === undefined) {
      return reservation;
    }
    const chargedBytes = buildRemainderBytes({
      bytes: reservation.bytes,
      treeBytes: measureProcessTreeBytes(procRoot, build.buildPid),
      committedNowBytes,
      committedAtStartBytes: build.committedAtStartBytes,
    });
    return { ...reservation, build: { ...build, chargedBytes } };
  });
}

/** `build.holder` from the kept build reservations — the building one first, else the oldest. */
export function holderOf(builds: readonly PendingReservation[]): BuildHolder | null {
  const ordered = builds.toSorted((a, b) => {
    const phase = Number(b.build?.phase === "building") - Number(a.build?.phase === "building");
    return phase !== 0 ? phase : (a.build?.since ?? "").localeCompare(b.build?.since ?? "");
  });
  const first = ordered[0];
  if (first?.build === undefined) {
    return null;
  }
  const { build } = first;
  return {
    key: first.key,
    phase: build.phase,
    since: build.since,
    pid: build.admitterPid,
    buildPid: build.buildPid ?? null,
    bytes: first.bytes,
    chargedBytes: build.chargedBytes ?? first.bytes,
  };
}
