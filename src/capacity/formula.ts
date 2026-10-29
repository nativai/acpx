import {
  type CapacityConstants,
  HARNESSES,
  type Harness,
  liveFloorFor,
  type PerHarness,
} from "./constants.js";
import type { OwnerTree } from "./owners.js";

/**
 * The charged admission formula, read-only (CONCEPTION f7587c86 §4.1, §4.2). `P` comes from the
 * admission ledger (`pending.ts`); there is no make-room yet, so nothing is releasable for room.
 *
 *   b = max(b_floor, C − Σ m_i)                    measured base
 *   K = b + Σ max(r_live_h(i), m_i, reserved_i) + P   charged total
 *   free slots for h = min of
 *     ⌊(B − M − Q − K) / r_new_h⌋                  G1 (agent class; interactive drops Q)
 *     ⌊(L − M_oom − C − P) / r_new_h⌋              G2, the cgroup-OOM guard
 *     ⌊(MemAvailable − (K − C) − N_floor) / r_new_h⌋   G3, only while borrowing (B > R)
 *   and 0 while G4 fails (PSI memory full avg10 ≥ psi_hold).
 */

export type FormulaInputs = {
  readonly budgetBytes: number;
  /** `R`; undefined when unknown (an unconfigured box) — then G3 applies as if borrowing. */
  readonly requestBytes: number | undefined;
  readonly limitBytes: number;
  readonly committedBytes: number;
  readonly owners: readonly OwnerTree[];
  readonly pendingBytes: number;
  readonly nodeAvailableBytes: number | undefined;
  readonly psiFullAvg10: number | undefined;
  readonly constants: CapacityConstants;
};

export type FormulaResult = {
  readonly marginBytes: number;
  readonly oomMarginBytes: number;
  readonly baseBytes: number;
  /** Σ over owners of max(r_live_h, m_i). */
  readonly ownerChargeBytes: number;
  readonly chargedBytes: number;
  /** `B − M − Q − K`: what agent fan-out may still use; negative = over budget. */
  readonly freeBytes: number;
  readonly freeSlots: PerHarness<number>;
  readonly freeSlotsInteractive: PerHarness<number>;
  /** Which guard bound the agent-class slot count, per harness. */
  readonly bindingGuard: PerHarness<"G1" | "G2" | "G3" | "G4">;
};

export function ownerCharge(owner: OwnerTree, constants: CapacityConstants): number {
  return Math.max(
    liveFloorFor(owner.harness, constants),
    owner.measuredBytes,
    owner.reservedBytes ?? 0,
  );
}

function perHarness<T>(fn: (h: Harness) => T): PerHarness<T> {
  return Object.fromEntries(HARNESSES.map((h) => [h, fn(h)])) as PerHarness<T>;
}

export function computeFormula(inputs: FormulaInputs): FormulaResult {
  const { constants: k } = inputs;
  const B = inputs.budgetBytes;
  const L = inputs.limitBytes;
  const C = inputs.committedBytes;
  const P = inputs.pendingBytes;
  const M = Math.max(k.marginFloorBytes, Math.floor(k.marginFraction * B));
  const Moom = Math.max(k.oomMarginFloorBytes, Math.floor(k.oomMarginFraction * L));
  const Q = k.interactiveReserveBytes;

  const sumMeasured = inputs.owners.reduce((sum, o) => sum + o.measuredBytes, 0);
  const ownerChargeBytes = inputs.owners.reduce((sum, o) => sum + ownerCharge(o, k), 0);
  const baseBytes = Math.max(k.baseFloorBytes, C - sumMeasured);
  const K = baseBytes + ownerChargeBytes + P;

  const borrowing = inputs.requestBytes === undefined || B > inputs.requestBytes;
  const stalled = inputs.psiFullAvg10 !== undefined && inputs.psiFullAvg10 >= k.psiHold;

  const slots = (h: Harness, reserve: number): { n: number; guard: "G1" | "G2" | "G3" | "G4" } => {
    if (stalled) {
      return { n: 0, guard: "G4" };
    }
    const r = k.reserveNewBytes[h];
    const terms: Array<["G1" | "G2" | "G3", number]> = [
      ["G1", Math.floor((B - M - reserve - K) / r)],
      ["G2", Math.floor((L - Moom - C - P) / r)],
    ];
    if (borrowing && inputs.nodeAvailableBytes !== undefined) {
      terms.push(["G3", Math.floor((inputs.nodeAvailableBytes - (K - C) - k.nodeFloorBytes) / r)]);
    }
    const [guard, n] = terms.reduce((min, term) => (term[1] < min[1] ? term : min));
    return { n: Math.max(0, n), guard };
  };

  return {
    marginBytes: M,
    oomMarginBytes: Moom,
    baseBytes,
    ownerChargeBytes,
    chargedBytes: K,
    freeBytes: B - M - Q - K,
    freeSlots: perHarness((h) => slots(h, Q).n),
    freeSlotsInteractive: perHarness((h) => slots(h, 0).n),
    bindingGuard: perHarness((h) => slots(h, Q).guard),
  };
}

export type Verdict = "room" | "tight" | "full" | "unconfigured" | "unmeasured";

/**
 * `room` ≥ 2 agent slots after make-room; `tight` 1, or only the human reserve left; `full` 0
 * even after make-room. Only a MEASURED, CONFIGURED box can be `full` (§3.3: fail open).
 */
export function verdictFor(slotsAfterMakeRoom: number, interactiveSlots: number): Verdict {
  if (slotsAfterMakeRoom >= 2) {
    return "room";
  }
  if (slotsAfterMakeRoom === 1 || interactiveSlots > 0) {
    return "tight";
  }
  return "full";
}
