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
};

export function partitionPending(
  reservations: readonly PendingReservation[],
  liveSessionIds: ReadonlySet<string>,
): PendingPartition {
  const ownerReserved = new Map<string, number>();
  const keptKeys = new Set<string>();
  let pendingBytes = 0;
  let starting = 0;
  for (const reservation of reservations) {
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
  return { ownerReserved, pendingBytes, starting, keptKeys };
}
