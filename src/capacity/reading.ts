import fs from "node:fs";
import os from "node:os";
import { queueBaseDir } from "../cli/queue/paths.js";
import { sessionBaseDir } from "../session/persistence/repository.js";
import { type Basis, type BudgetResolution, readPodInfo, resolveBudget } from "./budget.js";
import { type CgroupReading, type NodeReading, readCgroup, readNode } from "./cgroup.js";
import {
  CAPACITY_CONSTANTS,
  type CapacityConstants,
  type Harness,
  type PerHarness,
} from "./constants.js";
import {
  computeFormula,
  type FormulaResult,
  ownerCharge,
  type Verdict,
  verdictFor,
} from "./formula.js";
import { censusOwners, type LeaseExclusion, type OwnerCensus, type OwnerTree } from "./owners.js";

/**
 * One read-only capacity reading of THIS box's control container — the numbers behind
 * `acpx capacity` (CONCEPTION f7587c86 §8.1). Phase 1: no pending ledger (`pendingBytes` 0,
 * `owners.starting` 0) and no make-room (`slotsAfterMakeRoom` = `freeSlots`, nothing releasable).
 */

export const DEFAULT_PODINFO_DIR = "/etc/podinfo";
export const DEFAULT_CGROUP_ROOT = "/sys/fs/cgroup";
export const DEFAULT_PROC_ROOT = "/proc";
const NAMESPACE_FILE = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";

export type CapacitySources = {
  readonly podinfoDir: string;
  readonly cgroupRoot: string;
  readonly procRoot: string;
  readonly queueDir: string;
  readonly sessionsDir: string;
};

/**
 * The fixture seams are env, so a CLI test (and the suite on a workbench, whose own cgroup is not
 * the box under test) can point every read at a fixture tree (§10.1).
 */
export function capacitySourcesFromEnv(env: NodeJS.ProcessEnv = process.env): CapacitySources {
  return {
    podinfoDir: env.ACPX_CAPACITY_PODINFO_DIR || DEFAULT_PODINFO_DIR,
    cgroupRoot: env.ACPX_CAPACITY_CGROUP_ROOT || DEFAULT_CGROUP_ROOT,
    procRoot: env.ACPX_CAPACITY_PROC_ROOT || DEFAULT_PROC_ROOT,
    queueDir: queueBaseDir(),
    sessionsDir: sessionBaseDir(),
  };
}

export type AlternativeBasis = {
  readonly basis: "request" | "limit";
  readonly budgetBytes: number;
  readonly marginBytes: number;
  readonly freeSlots: PerHarness<number>;
  readonly freeSlotsInteractive: PerHarness<number>;
};

export type OwnerSummary = {
  readonly sessionId: string;
  readonly pid: number;
  readonly harness: Harness | "unknown";
  readonly processes: number;
  readonly measuredBytes: number;
  readonly chargedBytes: number;
};

export type CapacitySnapshot = {
  readonly action: "capacity";
  readonly schema: 1;
  readonly box: string;
  readonly measuredAt: string;
  readonly agent: Harness;
  readonly basis: Basis;
  readonly verdict: Verdict;
  readonly budgetBytes: number | null;
  readonly requestBytes: number | null;
  readonly limitBytes: number | null;
  readonly marginBytes: number | null;
  readonly oomMarginBytes: number | null;
  readonly interactiveReserveBytes: number;
  readonly committedBytes: number | null;
  readonly workingSetBytes: number | null;
  readonly baseBytes: number | null;
  readonly chargedBytes: number | null;
  readonly pendingBytes: number;
  readonly freeBytes: number | null;
  readonly reserveNewBytes: PerHarness<number>;
  readonly liveFloorBytes: PerHarness<number>;
  readonly freeSlots: PerHarness<number> | null;
  readonly freeSlotsInteractive: PerHarness<number> | null;
  readonly slotsAfterMakeRoom: PerHarness<number> | null;
  readonly bindingGuard: PerHarness<"G1" | "G2" | "G3" | "G4"> | null;
  readonly owners: {
    readonly live: number;
    readonly starting: number;
    readonly idleReleasable: number;
    readonly releasableBytes: number;
    readonly byHarness: Readonly<Record<Harness | "unknown", number>>;
    readonly leaseFiles: number;
    readonly freshLeases: number;
    readonly excluded: Readonly<Record<LeaseExclusion, number>>;
    readonly trees: readonly OwnerSummary[];
  };
  readonly pressure: {
    readonly psiSomeAvg10: number | null;
    readonly psiFullAvg10: number | null;
    readonly nodeAvailableBytes: number | null;
    readonly oomKillsSinceContainerStart: number | null;
    readonly cpuPsiSomeAvg10: number | null;
    readonly nodeLoad1: number | null;
  };
  /** The same reading under the basis NOT in force, so request and limit are both visible. */
  readonly alternatives: readonly AlternativeBasis[];
  readonly warnings: readonly string[];
};

function boxName(): string {
  try {
    const namespace = fs.readFileSync(NAMESPACE_FILE, "utf8").trim();
    if (namespace) {
      return namespace.replace(/^dev-/u, "");
    }
  } catch {
    // not in a pod
  }
  return os.hostname();
}

export type ReadCapacityOptions = {
  readonly agent: Harness;
  readonly sources: CapacitySources;
  readonly constants?: CapacityConstants;
  readonly now?: Date;
  readonly box?: string;
};

const nul = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

type Gathered = {
  readonly constants: CapacityConstants;
  readonly now: Date;
  readonly sources: CapacitySources;
  readonly cgroup: CgroupReading;
  readonly node: NodeReading;
  readonly budget: BudgetResolution;
  readonly census: OwnerCensus;
};

function gather(options: ReadCapacityOptions): Gathered {
  const constants = options.constants ?? CAPACITY_CONSTANTS;
  const now = options.now ?? new Date();
  const { sources } = options;
  const cgroup = readCgroup(sources.cgroupRoot);
  return {
    constants,
    now,
    sources,
    cgroup,
    node: readNode(sources.procRoot),
    budget: resolveBudget({
      podinfo: readPodInfo(sources.podinfoDir),
      cgroupLimitBytes: cgroup.limitBytes,
      constants,
    }),
    census: censusOwners({
      queueDir: sources.queueDir,
      sessionsDir: sources.sessionsDir,
      procRoot: sources.procRoot,
      nowMs: now.getTime(),
      freshMs: constants.leaseFreshMs,
    }),
  };
}

/** C, L and B — all three are needed for any slot figure; any one missing ⇒ unmeasured. */
type Measured = { readonly committed: number; readonly limit: number; readonly budget: number };

function measuredOf(g: Gathered): Measured | undefined {
  const committed = g.cgroup.committed?.committedBytes;
  const limit = g.budget.limitBytes;
  const budget = g.budget.budgetBytes;
  return committed === undefined || limit === undefined || budget === undefined
    ? undefined
    : { committed, limit, budget };
}

function harnessCounts(owners: readonly OwnerTree[]): Record<Harness | "unknown", number> {
  const counts: Record<Harness | "unknown", number> = { claude: 0, codex: 0, pi: 0, unknown: 0 };
  for (const owner of owners) {
    counts[owner.harness] += 1;
  }
  return counts;
}

function measurementWarnings(g: Gathered): string[] {
  if (g.cgroup.committed === undefined) {
    return [
      `cannot read memory.stat under ${g.sources.cgroupRoot}: unmeasured, nothing is refused`,
    ];
  }
  return g.budget.limitBytes === undefined
    ? ["no memory limit is readable: unmeasured, nothing is refused"]
    : [];
}

function collectWarnings(g: Gathered, measured: Measured | undefined): string[] {
  const warnings = [
    ...g.budget.warnings,
    ...(g.cgroup.committed?.warnings ?? []),
    ...g.census.warnings,
  ];
  const unknown = harnessCounts(g.census.owners).unknown;
  if (unknown > 0) {
    warnings.push(`${unknown} live owner(s) of unknown harness, charged the largest floor`);
  }
  warnings.push(...measurementWarnings(g));
  if (!g.budget.configured) {
    const figures = measured ? "; the figures use the cgroup limit as the budget" : "";
    warnings.push(`no ${g.sources.podinfoDir}: unconfigured, nothing is refused${figures}`);
  }
  if (g.node.availableBytes === undefined) {
    warnings.push("node MemAvailable unreadable: the borrowing guard (G3) is not applied");
  }
  return warnings;
}

function formulaFor(g: Gathered, m: Measured, budgetBytes: number): FormulaResult {
  return computeFormula({
    budgetBytes,
    requestBytes: g.budget.requestBytes,
    limitBytes: m.limit,
    committedBytes: m.committed,
    owners: g.census.owners,
    pendingBytes: 0,
    nodeAvailableBytes: g.node.availableBytes,
    psiFullAvg10: g.cgroup.memoryPressure.fullAvg10,
    constants: g.constants,
  });
}

/** The reading under each basis NOT in force, so request and limit are both visible (§14 Q1). */
function alternativesFor(g: Gathered, m: Measured): AlternativeBasis[] {
  const active = g.budget.basis === "limit-fallback" ? "limit" : g.budget.basis;
  const candidates: Array<["request" | "limit", number | undefined]> = [
    ["request", g.budget.requestBytes],
    ["limit", m.limit],
  ];
  return candidates
    .filter(
      (c): c is ["request" | "limit", number] =>
        c[0] !== active && c[1] !== undefined && c[1] >= g.constants.budgetMinBytes,
    )
    .map(([basis, bytes]) => {
      const budgetBytes = Math.min(bytes, m.limit);
      const alt = formulaFor(g, m, budgetBytes);
      return {
        basis,
        budgetBytes,
        marginBytes: alt.marginBytes,
        freeSlots: alt.freeSlots,
        freeSlotsInteractive: alt.freeSlotsInteractive,
      };
    });
}

function verdictOf(g: Gathered, formula: FormulaResult | undefined, agent: Harness): Verdict {
  if (!g.budget.configured) {
    return "unconfigured";
  }
  return formula
    ? verdictFor(formula.freeSlots[agent], formula.freeSlotsInteractive[agent])
    : "unmeasured";
}

type FormulaFields = Pick<
  CapacitySnapshot,
  | "marginBytes"
  | "oomMarginBytes"
  | "baseBytes"
  | "chargedBytes"
  | "freeBytes"
  | "freeSlots"
  | "freeSlotsInteractive"
  | "slotsAfterMakeRoom"
  | "bindingGuard"
>;

function formulaFields(formula: FormulaResult | undefined): FormulaFields {
  if (!formula) {
    return {
      marginBytes: null,
      oomMarginBytes: null,
      baseBytes: null,
      chargedBytes: null,
      freeBytes: null,
      freeSlots: null,
      freeSlotsInteractive: null,
      slotsAfterMakeRoom: null,
      bindingGuard: null,
    };
  }
  return {
    marginBytes: formula.marginBytes,
    oomMarginBytes: formula.oomMarginBytes,
    baseBytes: formula.baseBytes,
    chargedBytes: formula.chargedBytes,
    freeBytes: formula.freeBytes,
    freeSlots: formula.freeSlots,
    freeSlotsInteractive: formula.freeSlotsInteractive,
    // Phase 1 has no make-room: releasing idle owners for room does not exist yet, so the count
    // after make-room IS the free count, and nothing is releasable for it.
    slotsAfterMakeRoom: formula.freeSlots,
    bindingGuard: formula.bindingGuard,
  };
}

function ownersField(g: Gathered): CapacitySnapshot["owners"] {
  return {
    live: g.census.owners.length,
    starting: 0,
    idleReleasable: 0,
    releasableBytes: 0,
    byHarness: harnessCounts(g.census.owners),
    leaseFiles: g.census.leaseFiles,
    freshLeases: g.census.freshLeases,
    excluded: g.census.excluded,
    trees: g.census.owners.map((owner) => ({
      sessionId: owner.sessionId,
      pid: owner.pid,
      harness: owner.harness,
      processes: owner.processes,
      measuredBytes: owner.measuredBytes,
      chargedBytes: ownerCharge(owner, g.constants),
    })),
  };
}

function pressureField(g: Gathered): CapacitySnapshot["pressure"] {
  return {
    psiSomeAvg10: nul(g.cgroup.memoryPressure.someAvg10),
    psiFullAvg10: nul(g.cgroup.memoryPressure.fullAvg10),
    nodeAvailableBytes: nul(g.node.availableBytes),
    oomKillsSinceContainerStart: nul(g.cgroup.oomKills),
    cpuPsiSomeAvg10: nul(g.cgroup.cpuPressure.someAvg10),
    nodeLoad1: nul(g.node.load1),
  };
}

export function readCapacity(options: ReadCapacityOptions): CapacitySnapshot {
  const g = gather(options);
  const measured = measuredOf(g);
  const formula = measured ? formulaFor(g, measured, measured.budget) : undefined;
  return {
    action: "capacity",
    schema: 1,
    box: options.box ?? boxName(),
    measuredAt: g.now.toISOString(),
    agent: options.agent,
    basis: g.budget.basis,
    verdict: verdictOf(g, formula, options.agent),
    budgetBytes: nul(g.budget.budgetBytes),
    requestBytes: nul(g.budget.requestBytes),
    limitBytes: nul(g.budget.limitBytes),
    interactiveReserveBytes: g.constants.interactiveReserveBytes,
    committedBytes: nul(g.cgroup.committed?.committedBytes),
    workingSetBytes: nul(g.cgroup.workingSetBytes),
    pendingBytes: 0,
    reserveNewBytes: { ...g.constants.reserveNewBytes },
    liveFloorBytes: { ...g.constants.liveFloorBytes },
    ...formulaFields(formula),
    owners: ownersField(g),
    pressure: pressureField(g),
    alternatives: g.budget.configured && measured ? alternativesFor(g, measured) : [],
    warnings: collectWarnings(g, measured),
  };
}

/**
 * Does this reading satisfy `--need n` for its agent? An unconfigured or unmeasured box always
 * does — fail open (§3.3, D6): a missing instrument must never stop the agents that could fix it.
 */
export function needMet(snapshot: CapacitySnapshot, need: number): boolean {
  if (snapshot.verdict === "unconfigured" || snapshot.verdict === "unmeasured") {
    return true;
  }
  return (snapshot.slotsAfterMakeRoom?.[snapshot.agent] ?? 0) >= need;
}
