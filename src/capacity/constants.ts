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
