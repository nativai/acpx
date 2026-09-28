/**
 * THE SEAT SUCCESSION WRITE — `ACTIVATION-PROTOCOL.md` §2.7, brick b64dfbb3 (B2).
 *
 * One seat, one predecessor `P` (possibly none), one successor `N` already created
 * INTO the seat. Retire `P`, point the seat at `N`, draw `N`'s ordinal, project both
 * records into the index once.
 *
 * ## The one thing that is atomic, and it is not the index
 *
 * The atomic object is **one row in `seats.json`**: the `next_ordinal`
 * read-increment and the `active_holder_id` move, under ONE hold. Everything else —
 * the `holderActive` mirror on two records, the index projection of both — is a
 * downstream projection of a decision already committed.
 *
 * That is what reconciles the two instructions this block inherits: *"the counter
 * read-increment and the pointer move are one atomic hold"* and *"never hold the
 * index lock across the record writes"*. **The hold is over the seat row; the record
 * writes fall BETWEEN two holds.** Both instructions are satisfied, and the critical
 * section is smaller than `persistTemplateMark`'s, which is the shipped precedent for
 * a counter under this lock.
 *
 * ## The phases, and why the ORDER is the design
 *
 *   0. pre-flight, no lock — resolve, validate, refuse
 *   1. retire `P` (record write, no lock)
 *   2. **THE ATOMIC HOLD** — seat row only: CAS, draw the ordinal, move the pointer
 *   3. activate `N` (record write, no lock)
 *   4. ONE index projection carrying both entries, in a `finally`
 *   5. the notice — outside every hold; its failure is not the activation's
 *
 * 🔑 **RETIRE BEFORE POINT (D3), AND EVERY TORN STATE IS THEREFORE LOUD OR CORRECT.**
 * A kill after phase 1 leaves the mirror reading VACANT — which is a first-class,
 * non-error state that fails loudly as "no current holder" — and a kill after phase 2
 * leaves the same. **Not one torn state routes to the RETIRED holder.** Reversing 1
 * and 2 would produce exactly that: a seat pointing at `N` while the mirror still
 * says `P` is active, i.e. the frozen-address disease this programme exists to cure.
 *
 * ## What this verb deliberately does NOT do
 *
 * - **It does not close the predecessor.** That is the handover party's duty (D7),
 *   documented in the verb's output and help rather than automated: Daniel said duty,
 *   not mechanism; an automatic close would terminate the caller's own process tree
 *   mid-verb when the handover party IS the predecessor; and the predecessor may
 *   legitimately need to stay open to finish writing its handover.
 * - **It does not re-seat anything.** `N` must already have been created into the
 *   seat (`sessions new --seat`). A session's seat never changes.
 * - **It does not check the caller's identity** (D5). Authority here is STRUCTURAL:
 *   `N` can only be activated into the seat it was created into, exactly one
 *   activation wins the compare-and-swap, and a closed seat or closed successor is
 *   refused. The acpx CLI is a local binary with no authentication layer, and every
 *   session-mutating verb it ships works the same way.
 */

import { resolveAcpxUiBaseUrl } from "../../acp/auth-env.js";
import {
  isArchivedRecord,
  listSessionIndexEntries,
  overlaySessionIndexEntries,
  parseSeatRefOrThrow,
  readSeatStore,
  resolveSessionRecord,
  seatFromStore,
  seatRowMissingMessage,
  sessionBaseDir,
  sessionRecordFileName,
  withSeatStoreWrite,
  writeSessionRecordAuthorizingSeatHolderWithoutIndex,
  type SeatRecord,
} from "../../session/persistence.js";
import { toSessionIndexEntry } from "../../session/persistence/index.js";
import type { SessionRecord } from "../../types.js";

/** Stable sentinel, first line of every activation notice, on its own line.
 *
 * ⚠️ DEFINED IN EXACTLY ONE PLACE PER REPO and keyed on by the frontend — the same
 * discipline `FORK_NOTICE_MARKER` already carries, for the same reason: a consumer
 * that matched on prose would break silently the first time the wording changed. */
export const SEAT_ACTIVATION_NOTICE_MARKER = "⟦SEAT-ACTIVATION⟧";

/** A divergence observed AT THE FLIP — the seat named `P` active while `P`'s own
 * mirror did not. Reported, never reconciled, and never accumulated anywhere. */
export type SeatMirrorDivergence = {
  readonly seatId: string;
  readonly predecessorId: string;
  /** The mirror value the flip is about to overwrite, as read in phase 0.2. */
  readonly overwrittenHolderActive: boolean | undefined;
};

export type SeatActivationOutcome = {
  readonly seatId: string;
  readonly predecessorId: string | null;
  readonly successorId: string;
  /** `N`'s holder ordinal after the run. */
  readonly ordinal: number;
  /**
   * `activated` — a fresh succession · `resumed` — D4's heal completing an
   * interrupted one · `already-active` — a no-op that wrote nothing and burned no
   * ordinal.
   */
  readonly kind: "activated" | "resumed" | "already-active";
  readonly divergence?: SeatMirrorDivergence;
  readonly notice: string;
};

/** Refusals carry a code so the CLI can render them without matching on prose. */
export class SeatActivationRefusalError extends Error {
  constructor(
    readonly code:
      | "SEAT_ROW_MISSING"
      | "SEAT_CLOSED"
      | "SUCCESSOR_NOT_IN_SEAT"
      | "SUCCESSOR_CLOSED"
      | "SUCCESSOR_ARCHIVED"
      | "PREDECESSOR_ARCHIVED"
      | "KIND_MISMATCH"
      | "CONCURRENT_ACTIVATION",
    message: string,
  ) {
    super(message);
    this.name = "SeatActivationRefusalError";
  }
}

async function resolveRecordOrRefuse(
  ref: string,
  code: "SUCCESSOR_ARCHIVED" | "PREDECESSOR_ARCHIVED",
  role: string,
): Promise<SessionRecord> {
  const record = await resolveSessionRecord(ref);
  // Checked HERE even though the write path's own archived guard would throw anyway
  // (`writeSessionRecordInternal` raises `SessionArchivedError` by construction on
  // every entrypoint, so the verb already fails safe BEFORE any write). What that
  // guard cannot do is say WHICH holder is archived or that a succession was being
  // attempted — so this converts an opaque failure into a refusal that names the
  // holder and the remedy.
  if (isArchivedRecord(record)) {
    throw new SeatActivationRefusalError(
      code,
      `the ${role} ${record.acpxRecordId} is ARCHIVED, so it cannot take part in a ` +
        `succession. Restore it first (\`acpx sessions restore ${record.acpxRecordId}\`), ` +
        `then retry. Nothing has been written.`,
    );
  }
  return record;
}

/** Phase 0.1 — the seat must exist in the store and must not be closed. */
async function resolveSeatOrRefuse(seatRef: string): Promise<SeatRecord> {
  // Seat-id syntax is validated HERE and nowhere else (D8): rejected, never repaired.
  const seatId = parseSeatRefOrThrow("Seat id", seatRef);
  const store = await readSeatStore(sessionBaseDir());
  const seat = seatFromStore(store, seatId);
  if (!seat) {
    // AP17 — the refusal names the cause and the remedy. Shared with D11's refusal so
    // the two cannot drift into describing the same condition differently.
    throw new SeatActivationRefusalError("SEAT_ROW_MISSING", seatRowMissingMessage(seatId));
  }
  if (seat.closedAt !== null && seat.closedAt !== undefined) {
    throw new SeatActivationRefusalError(
      "SEAT_CLOSED",
      `seat ${seatId} was closed at ${seat.closedAt} — the office is abolished and takes ` +
        `no further holders. Note this is NOT the same as the seat being vacant: a vacant ` +
        `seat (no active holder) still accepts one.`,
    );
  }
  return seat;
}

/** Phase 0.2 — the successor must be live and must ALREADY be in this seat. */
async function resolveSuccessorOrRefuse(
  seat: SeatRecord,
  successorRef: string,
): Promise<SessionRecord> {
  const successor = await resolveRecordOrRefuse(successorRef, "SUCCESSOR_ARCHIVED", "successor");
  if (successor.closed === true) {
    throw new SeatActivationRefusalError(
      "SUCCESSOR_CLOSED",
      `the successor ${successor.acpxRecordId} is closed; a closed session cannot become a ` +
        `seat's active holder. Create a new holder into the seat instead ` +
        `(\`acpx sessions new --seat ${seat.seatId}\`).`,
    );
  }
  // 🛑 THE SUCCESSOR MUST ALREADY HAVE BEEN CREATED INTO THE SEAT. Activate NEVER
  // re-seats a session — a session's seat never changes — so this enforces A4's
  // mandated two-step rather than assuming it. Without it, `activate` would become a
  // way to move a session between seats, which is the mis-seating D11's whole
  // asymmetry exists to prevent, reached by another route.
  if (successor.seatId !== seat.seatId) {
    throw new SeatActivationRefusalError(
      "SUCCESSOR_NOT_IN_SEAT",
      `session ${successor.acpxRecordId} belongs to seat ${successor.seatId ?? "(none)"}, not ` +
        `to ${seat.seatId}. Activate never re-seats a session: create the successor INTO the ` +
        `seat first with \`acpx sessions new --seat ${seat.seatId}\`, then activate it.`,
    );
  }
  return successor;
}

/** Phase 0.2 — the predecessor, where the seat has one. */
async function resolvePredecessorOrRefuse(
  seat: SeatRecord,
  successor: SessionRecord,
): Promise<SessionRecord | undefined> {
  if (seat.activeHolderId === null) {
    // A VACANT seat is a first-class state, not an error — nobody to retire.
    return undefined;
  }
  const predecessor = await resolveRecordOrRefuse(
    seat.activeHolderId,
    "PREDECESSOR_ARCHIVED",
    "predecessor",
  );
  // B1 ruling 4 — all holders of a seat share one kind. Cheap HERE, unlike on the
  // create path: the predecessor is named by the seat row, so no holder enumeration
  // is needed. (The create path's equivalent check is deferred for exactly that
  // reason — see `refuseUnjoinableSeat`.)
  if (successor.kind !== predecessor.kind) {
    throw new SeatActivationRefusalError(
      "KIND_MISMATCH",
      `the successor's kind (${successor.kind ?? "session"}) differs from the seat's current ` +
        `holder (${predecessor.kind ?? "session"}). All holders of one seat share one kind, ` +
        `so this successor cannot inherit this seat.`,
    );
  }
  return predecessor;
}

/** Phase 0 — every refusal, before any write. */
async function preflight(
  seatRef: string,
  successorRef: string,
): Promise<{
  seat: SeatRecord;
  successor: SessionRecord;
  predecessor: SessionRecord | undefined;
  /**
   * `P`'s `holderActive` AS READ IN PHASE 0.2 — the quantity D10 measures.
   *
   * 🛑 READ BEFORE ANYTHING IS WRITTEN, and that is what makes the divergence
   * observation meaningful rather than universal. Phase 1 retires `P` BEFORE phase 2
   * reads the seat row, so a comparison taken at phase 2 against the then-current
   * mirror would see the disagreement THIS VERB JUST CREATED and report every healthy
   * activation as a divergence. Using the pre-write value is not a "replay a snapshot"
   * violation: that rule governs what a WRITER writes, never what an OBSERVER
   * measures, and the pre-write value is precisely the quantity being measured.
   */
  predecessorMirrorActive: boolean | undefined;
}> {
  const seat = await resolveSeatOrRefuse(seatRef);
  const successor = await resolveSuccessorOrRefuse(seat, successorRef);
  const predecessor = await resolvePredecessorOrRefuse(seat, successor);
  return {
    seat,
    successor,
    predecessor,
    predecessorMirrorActive: predecessor?.holderActive,
  };
}

/** Phase 2 — THE ATOMIC HOLD. One `seats.json` read and one write, nothing else. */
async function drawOrdinalAndPointAtSuccessor(
  seatId: string,
  expectedPredecessorId: string | null,
  successorId: string,
): Promise<number> {
  return await withSeatStoreWrite(sessionBaseDir(), (store) => {
    // Read FRESH inside the hold — never a value captured in phase 0. A
    // compare-and-swap against a pre-hold snapshot is not a compare-and-swap.
    const row = seatFromStore(store, seatId);
    if (!row) {
      throw new SeatActivationRefusalError("SEAT_ROW_MISSING", seatRowMissingMessage(seatId));
    }
    // 🛑 THE COMPARE-AND-SWAP. Exactly one of two concurrent activations may win; the
    // loser aborts LOUDLY rather than overwriting a pointer that moved under it.
    if (row.activeHolderId !== expectedPredecessorId) {
      throw new SeatActivationRefusalError(
        "CONCURRENT_ACTIVATION",
        `seat ${seatId} moved while this activation was running: it now holds ` +
          `${row.activeHolderId ?? "(vacant)"}, not ${expectedPredecessorId ?? "(vacant)"}. ` +
          `A concurrent activation won. Nothing further has been written by this run; ` +
          `re-run to activate ${successorId} from the seat's current state.`,
      );
    }
    if (row.closedAt !== null && row.closedAt !== undefined) {
      // Re-checked here because phase 0's read is stale by now.
      throw new SeatActivationRefusalError(
        "SEAT_CLOSED",
        `seat ${seatId} was closed at ${row.closedAt} while this activation was running.`,
      );
    }
    const ordinal = row.nextOrdinal;
    const seats = new Map(store.seats);
    seats.set(seatId, { ...row, nextOrdinal: ordinal + 1, activeHolderId: successorId });
    return { mutation: { kind: "write", seats }, result: ordinal };
  });
}

/** Phases 1 and 3 — a holder's mirror write, through the ONE authorised writer. */
async function writeHolderMirror(
  record: SessionRecord,
  fields: { holderActive: boolean; holderOrdinal?: number },
): Promise<void> {
  record.holderActive = fields.holderActive;
  if (fields.holderOrdinal !== undefined) {
    record.holderOrdinal = fields.holderOrdinal;
  }
  // 🛑 RETIREMENT IS NOT A CLOSE. `closed` is untouched here, deliberately: the old
  // address must still RESOLVE so a sender addressing a retired holder can be WARNED.
  // A closed-check would reject first and the sender would get a bare closed error
  // instead. D7's duty is what makes "retired but open" transitional rather than a
  // resting state.
  await writeSessionRecordAuthorizingSeatHolderWithoutIndex(record);
}

/** Phase 4 — ONE index projection carrying both entries. */
async function projectBothEntries(records: readonly SessionRecord[]): Promise<void> {
  const overlays = new Map(
    records.map((record) => [
      sessionRecordFileName(record.acpxRecordId),
      // The helper reads the record FRESH from disk at flush time and hands it here,
      // so this projects the persisted bytes rather than anything captured earlier.
      {
        fields: (fresh: SessionRecord) =>
          toSessionIndexEntry(fresh, sessionRecordFileName(fresh.acpxRecordId)),
      },
    ]),
  );
  await overlaySessionIndexEntries(sessionBaseDir(), overlays);
}

/**
 * D4's heal — complete an interrupted activation idempotently.
 *
 * Reached when the seat row ALREADY names `N`: a previous run got through phase 2 and
 * died before its projections landed. **No divergence is observed on this branch, and
 * that exclusion is STRUCTURAL rather than a flag** — §3.6's torn states legitimately
 * disagree mid-heal, and counting them would measure crashes rather than the
 * two-source ambiguity the metric is about. The two branches are already
 * distinguished by `row.activeHolderId === N`, so there is no "am I healing" boolean
 * to get wrong.
 *
 * ⚠️ *"Every holder of the seat"* is a QUERY, not a field — a scan for
 * `seatId === S` over the index. **It is confined to this path and must never appear
 * on the activation or routing paths**, which is the whole of why the seat store
 * exists. In the overwhelmingly common case it yields one or two holders, and it runs
 * only after a crash.
 */
async function healInterruptedActivation(
  seat: SeatRecord,
  successor: SessionRecord,
): Promise<number> {
  const entries = await listSessionIndexEntries();
  const written: SessionRecord[] = [];
  for (const entry of entries) {
    if (entry.seatId !== seat.seatId || entry.acpxRecordId === successor.acpxRecordId) {
      continue;
    }
    const other = await resolveSessionRecord(entry.acpxRecordId);
    if (isArchivedRecord(other) || other.holderActive !== true) {
      continue;
    }
    await writeHolderMirror(other, { holderActive: false });
    written.push(other);
  }

  let ordinal = successor.holderOrdinal;
  if (ordinal === undefined) {
    // Killed between 2.5 and 3.1: the pointer moved but the successor never got its
    // number. Allocate a FRESH one, BURNING the number the crashed run took.
    // 🔑 D4a — GAPS ARE LEGAL, REPEATS ARE DEFECTS. Deriving the crashed run's ordinal
    // as `next_ordinal - 1` would be wrong the moment any other activation
    // interleaved; allocating fresh is correct under every interleaving and costs one
    // skipped integer in a display label.
    ordinal = await withSeatStoreWrite(sessionBaseDir(), (store) => {
      const row = seatFromStore(store, seat.seatId);
      if (!row) {
        throw new SeatActivationRefusalError(
          "SEAT_ROW_MISSING",
          seatRowMissingMessage(seat.seatId),
        );
      }
      const drawn = row.nextOrdinal;
      const seats = new Map(store.seats);
      seats.set(seat.seatId, { ...row, nextOrdinal: drawn + 1 });
      return { mutation: { kind: "write", seats }, result: drawn };
    });
  }
  await writeHolderMirror(successor, { holderActive: true, holderOrdinal: ordinal });
  written.push(successor);
  await projectBothEntries(written);
  return ordinal;
}

/**
 * Compose the activation notice — **D6: an ORIENTATION, not a HANDOVER.**
 *
 * Nothing here is fabricated: every field comes from the successor's own record and
 * the seat row. Where this box's acpx-ui host is unknown the seat is named by id
 * alone — a guessed host would be read by the successor as its own address and
 * reported onward as such.
 *
 * 🛑 WHAT IT MUST NOT SAY, and this is the load-bearing half:
 * 1. **No inherited context, and no instruction to resume anything.** A successor is
 *    a FRESH session — a fork mints a new seat, so an activated successor is by
 *    construction not a fork of its predecessor and carries none of its transcript.
 *    FORK-NOTICE says *"you are a divergent copy, do not resume"*; this says something
 *    structurally different — *"you have no inherited context at all"* — and must not
 *    borrow FORK-NOTICE's prose, which would be false here and would teach the
 *    successor to look for a transcript it does not have.
 * 2. **It must not say the predecessor is closed.** Retirement is not a close, and
 *    the duty to close is the handover party's, possibly undischarged. The notice must
 *    not assert an act that has not happened.
 * 3. **No standing briefing, seat purpose, or description.** Daniel struck a seat
 *    description at the root: *"this is not the way successors should boot up. This
 *    needs to be a deliberate controlled handover."* ⇒ the notice tells the successor
 *    what it now IS; it never tells it what to DO. A notice that starts summarising
 *    duties has become the description field he struck, by another route.
 * 4. **No claim that mail to the predecessor's address will follow.** It will not.
 *
 * Plain prose, no markdown — these bubbles render RAW. Ends with a blank line so a
 * following handover prompt starts on its own line.
 */
export function composeSeatActivationNotice(params: {
  readonly seat: SeatRecord;
  readonly successorId: string;
  readonly predecessorId: string | null;
  readonly ordinal: number;
}): string {
  const base = resolveAcpxUiBaseUrl(process.env);
  const seatAddress = base
    ? `${base}/?seat=${params.seat.seatId}`
    : `seat id ${params.seat.seatId}`;
  const seatLabel = params.seat.name ? `"${params.seat.name}"` : "(unnamed)";
  const predecessor =
    params.predecessorId === null
      ? "This seat was vacant before you; there is no predecessor."
      : `Your predecessor is ${params.predecessorId}. It is RETIRED and still readable. ` +
        `Its transcript is not yours.`;
  return (
    `${SEAT_ACTIVATION_NOTICE_MARKER}\n` +
    `You are now the active holder of seat ${seatLabel} (${seatAddress}), holder #${params.ordinal}.\n` +
    `${predecessor}\n` +
    `Mail addressed to the seat now arrives here.\n` +
    `You have no inherited context: you are a fresh session that has taken over an ` +
    `address, not a continuation of anything. Nothing is waiting for you to resume.\n` +
    `Your live identity remains your own $ACPX_SESSION_URL; the seat is an ADDRESS, ` +
    `not your identity.\n\n`
  );
}

/**
 * Run a succession. See this file's header for the phase order and why it is the order.
 */
export async function activateSeatHolder(
  seatRef: string,
  successorRef: string,
): Promise<SeatActivationOutcome> {
  const { seat, successor, predecessor, predecessorMirrorActive } = await preflight(
    seatRef,
    successorRef,
  );

  if (seat.activeHolderId === successor.acpxRecordId) {
    // The pointer already names `N`. Two sub-cases, and they must not be conflated:
    // a completed activation (do nothing, burn no ordinal) versus D4's torn one
    // (finish the projection half).
    return successor.holderActive === true && successor.holderOrdinal !== undefined
      ? outcome(seat, successor, null, successor.holderOrdinal, "already-active")
      : outcome(seat, successor, null, await healInterruptedActivation(seat, successor), "resumed");
  }
  return await runFreshActivation(seat, successor, predecessor, predecessorMirrorActive);
}

/** Build an outcome, so the three branches cannot describe themselves differently. */
function outcome(
  seat: SeatRecord,
  successor: SessionRecord,
  predecessorId: string | null,
  ordinal: number,
  kind: SeatActivationOutcome["kind"],
  divergence?: SeatMirrorDivergence,
): SeatActivationOutcome {
  return {
    seatId: seat.seatId,
    predecessorId,
    successorId: successor.acpxRecordId,
    ordinal,
    kind,
    divergence,
    notice: composeSeatActivationNotice({
      seat,
      successorId: successor.acpxRecordId,
      predecessorId,
      ordinal,
    }),
  };
}

/**
 * D10 — the divergence OBSERVATION. Exported so the rule is testable on its own.
 *
 * ONE EVENT = one FRESH activation at which the seat row named `P` as its active
 * holder (the compare-and-swap proves it) while `P`'s own `holder_active`, **as read in
 * phase 0.2**, was not `true`. That is the §3.4 clobber signature, and the flip is the
 * only point in this verb's window that sees both sides of the comparison.
 *
 * 🛑 **THE HEAL-PATH EXCLUSION IS STRUCTURAL, NOT A FLAG.** D4's torn states
 * legitimately disagree mid-heal, and counting them would measure crashes rather than
 * the two-source ambiguity this exists to surface. The resumption branch simply never
 * calls this — there is no "am I healing" boolean to get wrong, and if you find
 * yourself adding one, the shape has drifted.
 *
 * 🛑 **A LOST COMPARE-AND-SWAP IS A RACE, NOT A DIVERGENCE.** It aborts loudly before
 * reaching here: a different event with a different meaning, deliberately not folded
 * in for convenience.
 *
 * 🛑 **NOTHING ACCUMULATES.** One observation per event, reported by the caller. The
 * count of currently divergent seats is DERIVED on demand elsewhere — there is no
 * counter, no running total, and no field on the seat. A per-seat `mirror_divergences`
 * field was ruled in and then withdrawn on 2026-09-28T13:30Z precisely because a
 * stored count is the derivable state the closed seven-field set excludes.
 */
export function observeMirrorDivergence(
  seat: SeatRecord,
  predecessor: SessionRecord | undefined,
  predecessorMirrorActive: boolean | undefined,
): SeatMirrorDivergence | undefined {
  if (!predecessor || predecessorMirrorActive === true) {
    return undefined;
  }
  return {
    seatId: seat.seatId,
    predecessorId: predecessor.acpxRecordId,
    overwrittenHolderActive: predecessorMirrorActive,
  };
}

/** Phases 1-4 of a fresh succession. */
async function runFreshActivation(
  seat: SeatRecord,
  successor: SessionRecord,
  predecessor: SessionRecord | undefined,
  predecessorMirrorActive: boolean | undefined,
): Promise<SeatActivationOutcome> {
  const written: SessionRecord[] = [];
  try {
    // PHASE 1 — retire the predecessor. Before the pointer moves (D3), so no torn
    // state can ever route to the retired holder.
    if (predecessor) {
      await writeHolderMirror(predecessor, { holderActive: false });
      written.push(predecessor);
    }
    // PHASE 2 — the atomic hold.
    const ordinal = await drawOrdinalAndPointAtSuccessor(
      seat.seatId,
      predecessor?.acpxRecordId ?? null,
      successor.acpxRecordId,
    );
    // PHASE 3 — activate the successor.
    await writeHolderMirror(successor, { holderActive: true, holderOrdinal: ordinal });
    written.push(successor);

    return outcome(
      seat,
      successor,
      predecessor?.acpxRecordId ?? null,
      ordinal,
      "activated",
      observeMirrorDivergence(seat, predecessor, predecessorMirrorActive),
    );
  } finally {
    // PHASE 4 — in a `finally`, NEVER relying on `beforeExit`, which `SIGKILL` and
    // `process.exit()` skip. Until this lands each written record is torn
    // `record=NEW, index=OLD`, which is the direction a re-run heals — and never a
    // direction that routes to the retired holder.
    if (written.length > 0) {
      await projectBothEntries(written);
    }
  }
}
