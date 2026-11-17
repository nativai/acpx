/**
 * Pending reservations (CONCEPTION f7587c86 §4.1, §5): what an admitted create has reserved and not
 * yet shown as a measured owner. One rule decides how each reservation is charged, and BOTH the
 * reading (`acpx capacity`, the gate's decision) and the ledger's pruning use it, so the probe and
 * the gate can never disagree about what is pending.
 *
 *   its session has a live owner           → that owner is charged max(r_live, m, reservation)
 *   no owner yet, its admitter still lives  → counted in P (the transient adapter, the starting owner)
 *   no owner, admitter gone, BOUND, unspent → counted in P (CONCEPTION e8abe1e8 §3.2.2): the record
 *                                             exists and its first prompt is still to come — atrium
 *                                             creates with one process and prompts with another,
 *                                             possibly after a restart's bind window
 *   anything else                           → dropped: nothing was created, or the job already ran
 *
 * A RELEASE BUILD's entry (`acpx capacity run-build`, CONCEPTION 25479d40 §3.2) has its own rule: it
 * is kept while its admitter (`run-build`) OR its identity-checked build child lives (review R3), so
 * a SIGKILLed `run-build` leaves the room reserved for as long as the build it started runs. It is
 * charged in `P` like every pending entry — at its full bytes while it waits, at the remainder
 * `reading.ts` computes while it builds (R12) — and is NEVER counted in `starting`: no session is
 * starting, and refusal texts print that count (R12).
 *
 * "Bound" = `ticket.bind` ran (`boundAt`), never "has a sessionId": a `--record-id` create carries
 * its id from admission on, so a create killed before it created anything must still drop (R14).
 * "Spent" = the record shows a turn at or after `boundAt`, or is closed (N1): once the job ran, its
 * owner was charged while it lived, and a bound reservation that outlived it would hold a slot for
 * the rest of its TTL (10 min for `automation`) against nothing.
 *
 * TTL and container-instance expiry are applied by the ledger before this partition (§5).
 */

export type PendingReservation = {
  readonly key: string;
  /** The session's record id, once known (`--record-id`, or bound after `createSession`). */
  readonly sessionId?: string;
  readonly bytes: number;
  /** False only when the admitter is PROVABLY gone; an unjudgeable admitter counts as alive. */
  readonly admitterAlive: boolean;
  /** `ticket.bind` ran: the record exists (`boundAt` in the ledger). */
  readonly bound: boolean;
  /** Bound, and its record shows a turn at or after `boundAt`, or is closed. */
  readonly spent: boolean;
  /** Present only on a release build's entry (`kind: "build"`). */
  readonly build?: BuildReservation;
};

/** A release build's reservation (CONCEPTION 25479d40 §3.2, §5.1 `build.holder`). */
export type BuildReservation = {
  readonly phase: "waiting" | "building";
  /** `admittedAt` while waiting, the child's start while building. */
  readonly since: string;
  readonly admitterPid: number;
  readonly buildPid?: number;
  /** A build child is recorded and is NOT provably gone (an unjudgeable one counts as alive). */
  readonly buildAlive: boolean;
  /** `C` when the build started — the base of the cgroup-rise remainder (R12). */
  readonly committedAtStartBytes?: number;
  /** What `P` charges; absent ⇒ the entry's full `bytes` (waiting, or no reading to judge by). */
  readonly chargedBytes?: number;
};

export type PendingPartition = {
  /** Reservation per live owner's session id — raises that owner's charge while within TTL. */
  readonly ownerReserved: ReadonlyMap<string, number>;
  /** `P`: reservations with no owner yet whose admitter still lives, or that are bound and unspent. */
  readonly pendingBytes: number;
  /** How many reservations make up `P` (`owners.starting`). */
  readonly starting: number;
  /** Keys still charged one way or the other — everything else may be pruned from the ledger. */
  readonly keptKeys: ReadonlySet<string>;
  /** The part of `pendingBytes` that release builds hold — K without it is the build test's K. */
  readonly buildBytes: number;
  /** The kept release-build reservations (at most one, by `run-build`'s own rule). */
  readonly builds: readonly PendingReservation[];
};

/**
 * ⚠️ DO NOT FOLD THIS INTO THE CREATE RULE. A build entry is never bound, so that rule drops it the
 * moment `run-build` dies — while the build it started keeps running with no reservation, the very
 * race with R2 that B exists to prevent (review R3). Rows "partitionPending build:" in
 * test/capacity-run-build.test.ts.
 */
function buildKept(reservation: PendingReservation): boolean {
  return reservation.admitterAlive || reservation.build?.buildAlive === true;
}

/** Release builds first: kept by their own rule, charged in `P`, never counted as `starting`. */
function partitionBuilds(reservations: readonly PendingReservation[]): {
  readonly builds: PendingReservation[];
  readonly buildBytes: number;
} {
  const builds = reservations.filter((r) => r.build !== undefined && buildKept(r));
  const buildBytes = builds.reduce((sum, r) => sum + (r.build?.chargedBytes ?? r.bytes), 0);
  return { builds, buildBytes };
}

export function partitionPending(
  reservations: readonly PendingReservation[],
  liveSessionIds: ReadonlySet<string>,
): PendingPartition {
  const ownerReserved = new Map<string, number>();
  const { builds, buildBytes } = partitionBuilds(reservations);
  const keptKeys = new Set<string>(builds.map((build) => build.key));
  let pendingBytes = buildBytes;
  let starting = 0;
  for (const reservation of reservations.filter((r) => r.build === undefined)) {
    if (reservation.sessionId !== undefined && liveSessionIds.has(reservation.sessionId)) {
      const previous = ownerReserved.get(reservation.sessionId) ?? 0;
      ownerReserved.set(reservation.sessionId, Math.max(previous, reservation.bytes));
      keptKeys.add(reservation.key);
    } else if (reservation.admitterAlive || (reservation.bound && !reservation.spent)) {
      pendingBytes += reservation.bytes;
      starting += 1;
      keptKeys.add(reservation.key);
    }
  }
  return { ownerReserved, pendingBytes, starting, keptKeys, buildBytes, builds };
}
