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
  /**
   * G5, the CPU guard (CONCEPTION 25479d40 §4.2; brick 4d74a0d9): container `cpu.pressure some` thresholds
   * in %. `busy` (avg60 ≥ `cpuBusyAvg60`) only warns; `saturated` (avg60 ≥ `cpuSaturatedAvg60` AND
   * avg300 ≥ `cpuSaturatedAvg300` — the persistence condition that keeps one build or test run from
   * refusing anyone) refuses an agent's own create. Re-derived by commit from the decision log, never
   * auto-tuned (K10).
   */
  readonly cpuBusyAvg60: number;
  readonly cpuSaturatedAvg60: number;
  readonly cpuSaturatedAvg300: number;
  /** A podinfo budget below this is a unit error (wrong `divisor`), not a box size (§3.3). */
  readonly budgetMinBytes: number;
  /** Leases older than this are not parsed: a live owner rewrites its lease every 5 s (§5). */
  readonly leaseFreshMs: number;
  /** The runaway process-tree governor (CONCEPTION 5d7a23b6 §4, §13.2). */
  readonly governor: GovernorConstants;
};

/**
 * D1 (CONCEPTION 5d7a23b6 §14) is CONFIGURATION, in git. Daniel decided "(a)" on 2026-11-08: enforce
 * both rules from the first deploy on each box, terminals and ssh logins governed (`decision/
 * DECISION.md` in the brick). Changing `mode` or `governTerminals` is a one-line commit that ships by
 * box refresh; the governor restarts itself on the new build (§7.2). `observe` survives only as a
 * re-tuning value of `mode` (§13.1) — there is no runtime switch.
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
  /**
   * §19 D3a — between scans, every `pidWatchIntervalMs` the governor reads the last pid allocated in its
   * own pid namespace (`/proc/loadavg`, last field); `pidWatchTrigger` or more pids allocated since the
   * LAST FULL SCAN (cumulative, so a storm trips it at any rate) force a scan at once and fast mode. 10 ms,
   * not 50: measured on a ~8,000 processes/s doubling bomb (CONCEPTION §19 D3a); ~0.3 % of one CPU.
   */
  readonly pidWatchIntervalMs: number;
  readonly pidWatchTrigger: number;
  /**
   * `/proc/<pid>/stat` reader threads (brick 07f4fde2): a read of a storm process mid-exec blocks in the
   * kernel for 50–466 ms, so the scan reads with this many threads and a blocked one stalls only itself.
   * Fixed, created at start-up. A reader silent `scanReaderStuckMs` inside a scan is left out of it.
   */
  readonly scanReaders: number;
  readonly scanReaderStuckMs: number;
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
  cpuBusyAvg60: 30,
  cpuSaturatedAvg60: 50,
  cpuSaturatedAvg300: 40,
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
    pidWatchIntervalMs: 10,
    pidWatchTrigger: 16,
    scanReaders: 4,
    scanReaderStuckMs: 250,
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

/**
 * The release build's admission (CONCEPTION 25479d40 §3.2, §3.3): `acpx capacity run-build`. Fleet
 * constants, re-derived by commit from `run-build`'s own `kind: "build"` log lines (peak rise of `C`
 * per build, 100 ms samples), never auto-tuned.
 */
export const BUILD_CONSTANTS = {
  /**
   * The heaviest project build's measured peak rise of `C`, rounded up to 64 MiB: acpx-ui's server
   * `tsc`, 1,878 MiB (§2.4) → 1,920. No extra percentage — agents' growth during the build is `G`'s.
   */
  buildReserveBytes: 1920 * MIB,
  /** `G = buildGrowthFraction × M`: what agents may grow while the build runs (§3.2 step 3). */
  buildGrowthFraction: 0.5,
  /** `--wait` default: past it, `run-build` exits 75 having run nothing (§3.2 step 6). */
  buildWaitDefaultS: 900,
  /**
   * The entry's `expiresAt` = now + this, re-stamped on every evaluation and every minute while
   * building (review R6), so expiry removes only an entry whose processes cannot be judged.
   */
  buildExpiryRestampS: 600,
} as const;
