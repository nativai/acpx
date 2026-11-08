/**
 * The admission model's constants (CONCEPTION f7587c86 §4.4, from DATA a6a2f2b3 §7). Per-box
 * variation comes from the pod's memory REQUEST, never from tuning these.
 */

export const MIB = 1024 * 1024;

export const HARNESSES = ["claude", "codex", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];

export type PerHarness<T> = Record<Harness, T>;

export type CapacityConstants = {
  /** `r_new_h` — what a newcomer (and every pending entry) is charged. */
  readonly reserveNewBytes: PerHarness<number>;
  /** `r_live_h` — the floor charge of a running owner: it is charged `max(floor, measured)`. */
  readonly liveFloorBytes: PerHarness<number>;
  /** `M = max(marginFloor, marginFraction × B)`. */
  readonly marginFloorBytes: number;
  readonly marginFraction: number;
  /** `M_oom = max(oomMarginFloor, oomMarginFraction × L)` — distance kept from the cgroup OOM line. */
  readonly oomMarginFloorBytes: number;
  readonly oomMarginFraction: number;
  /** `Q` — one Claude session kept for humans (D3). */
  readonly interactiveReserveBytes: number;
  /** `b_floor` — atrium's restart dip. */
  readonly baseFloorBytes: number;
  /** `N_floor` — node MemAvailable kept free while the box borrows above its request (G3). */
  readonly nodeFloorBytes: number;
  /** `psi_hold` — PSI memory `full` avg10 (%) at which nothing is admitted (G4). */
  readonly psiHold: number;
  /** A podinfo budget below this is a unit error (wrong `divisor`), not a box size (§3.3). */
  readonly budgetMinBytes: number;
  /** Leases older than this are not parsed: a live owner rewrites its lease every 5 s (§5). */
  readonly leaseFreshMs: number;
  /** The runaway process-tree governor (CONCEPTION 5d7a23b6 §4, §13.2). */
  readonly governor: GovernorConstants;
};

/**
 * Daniel's open decision D1 (CONCEPTION 5d7a23b6 §14) is CONFIGURATION, in git: flipping `mode` or
 * `governTerminals` is a one-line commit that ships by box refresh, and the governor restarts itself
 * on the new build (§7.2).
 */
export type GovernorConstants = {
  /**
   * `observe`: zero signals, zero in-band lines, zero seat messages — only `would_kill` events and
   * log lines (§6). `enforce`: R1/R2 kill. Committed negative: test/governor-*.test.ts "U2".
   */
  readonly mode: "observe" | "enforce";
  /**
   * `false`: ttyd and VS Code terminal sessions (and sessions derived from them) are never signalled
   * and never chosen by R2; they still appear in `scan` and `peaks`. ssh logins stay governed either
   * way (CONCEPTION §18 C3: they are mostly agents on other boxes using ssh-remote).
   */
  readonly governTerminals: boolean;
  /** R1: a governed session with at least this many live processes is killed at once. */
  readonly maxGroupProcesses: number;
  readonly scanIntervalMs: number;
  readonly fastScanIntervalMs: number;
  /** Fast mode starts when a governed session grows by this many processes between two scans… */
  readonly fastGrowthProcesses: number;
  /** …or first crosses this size, and lasts until no session has grown for `fastHoldMs`. */
  readonly fastSizeProcesses: number;
  readonly fastHoldMs: number;
  /** R2's victim must free at least `max(victimFloorBytes, victimFloorFraction × L)`. */
  readonly victimFloorBytes: number;
  readonly victimFloorFraction: number;
  readonly emergencyKillSpacingMs: number;
  readonly r2SkipWindowMs: number;
  readonly sweepRounds: number;
  readonly sweepRoundIntervalMs: number;
  readonly terminalLeaderGraceMs: number;
  readonly ownerCensusRefreshMs: number;
  readonly ungovernedBurstProcesses: number;
  readonly ungovernedBurstWindowMs: number;
  readonly nice: number;
  readonly messageDedupeMs: number;
  readonly outboxTtlMs: number;
  readonly outboxRetryMs: number;
  /** A `pressure_no_victim` / `r2_blind` / `ungoverned_burst` event at most this often. */
  readonly alarmRepeatMs: number;
  readonly eventsRotateBytes: number;
};

export const CAPACITY_CONSTANTS: CapacityConstants = {
  reserveNewBytes: { claude: 450 * MIB, codex: 340 * MIB, pi: 450 * MIB },
  liveFloorBytes: { claude: 300 * MIB, codex: 290 * MIB, pi: 300 * MIB },
  marginFloorBytes: 512 * MIB,
  marginFraction: 0.1,
  oomMarginFloorBytes: 512 * MIB,
  oomMarginFraction: 0.05,
  interactiveReserveBytes: 450 * MIB,
  baseFloorBytes: 512 * MIB,
  nodeFloorBytes: 3 * 1024 * MIB,
  psiHold: 10,
  budgetMinBytes: 256 * MIB,
  leaseFreshMs: 5 * 60_000,
  governor: {
    mode: "enforce",
    governTerminals: true,
    maxGroupProcesses: 128,
    scanIntervalMs: 1000,
    fastScanIntervalMs: 100,
    fastGrowthProcesses: 16,
    fastSizeProcesses: 32,
    fastHoldMs: 5000,
    victimFloorBytes: 256 * MIB,
    victimFloorFraction: 0.025,
    emergencyKillSpacingMs: 2000,
    r2SkipWindowMs: 30_000,
    sweepRounds: 10,
    sweepRoundIntervalMs: 10,
    terminalLeaderGraceMs: 60_000,
    ownerCensusRefreshMs: 5000,
    ungovernedBurstProcesses: 64,
    ungovernedBurstWindowMs: 60_000,
    nice: -20,
    messageDedupeMs: 600_000,
    outboxTtlMs: 3_600_000,
    outboxRetryMs: 30_000,
    alarmRepeatMs: 60_000,
    eventsRotateBytes: 10 * MIB,
  },
};

export function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}

/** An owner whose harness is unknown is charged the LARGEST floor: every estimate rounds up (§9). */
export function liveFloorFor(harness: Harness | "unknown", constants: CapacityConstants): number {
  return harness === "unknown"
    ? Math.max(...HARNESSES.map((h) => constants.liveFloorBytes[h]))
    : constants.liveFloorBytes[harness];
}
