import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AcpxOperationalError } from "../../errors.js";
import { withSessionIndexLock } from "./index-lock.js";
import { SEAT_STORE_FILE } from "./session-dir-files.js";

/**
 * THE SEAT STORE — the authority for who holds each seat.
 *
 * Placement, path and shape are RATIFIED, not chosen here:
 * `Bricks/0d2b83f0-.../conception/SEAT-STORE.md` (programme owner, 2026-09-28),
 * option (a) — a single-file, acpx-owned store keyed by `seat_id`, living INSIDE
 * `SESSIONS_DIR`, written only by read-modify-write under the `index.json` lock
 * through the one exported helper below. B2's activation write is its FIRST writer.
 *
 * ## Why a separate file at all, stated so it is not re-litigated
 *
 * The pointer used to be derived from holder flags projected into `index.json`.
 * Two measured facts killed that: `index.json` is **1.94 MB, parsed at 25-45 ms,
 * UNCACHED on the `resolveSeat` delivery path, up to twice per delivery** — while
 * this store holding the same 389 seats is **113 KB, parsed in 0.83 ms, one key
 * access**; and `index.json` is itself **rewritten from stale in-memory state by
 * long-running `__queue-owner` processes**, so a routing pointer projected into it
 * inherits that hazard (`SEAT-STORE.md` F4, F5, F6).
 *
 * 🛑 **THE IMMUNITY IS A PROPERTY OF THE WRITE DISCIPLINE, NOT OF THE FILE.**
 * F6's hazard is *"a live process holds a copy in memory and rewrites the whole
 * artefact from it."* A file that **no process caches**, written only by
 * read-modify-write under the lock, cannot be clobbered that way. **The moment any
 * process caches this store and flushes its copy, the hazard is back, in the most
 * load-bearing place in the design.** So: **nothing here memoises the store, and
 * nothing outside it may either.** `readSeatStore` goes to disk every time,
 * deliberately — at 0.83 ms that is not a cost worth a cache.
 *
 * ## The lock is on a PATH, which makes this a convention
 *
 * `withSessionIndexLock` locks `index.json.lock` — not this file
 * (`SEAT-STORE.md` F2(i)). Writing `seats.json` "under the index lock" is therefore
 * **a convention every writer must honour**, enforced by there being exactly ONE
 * writer (`withSeatStoreWrite`) and nothing else opening this file for writing —
 * never by the lock itself. The lock is also **advisory**: after
 * `INDEX_LOCK_MAX_WAIT_MS = 2_000` of contention a writer PROCEEDS UNLOCKED
 * (`index-lock.ts:13`). Inherited, explicitly ratified (item 5), and the mitigation
 * is the narrow critical section below.
 *
 * ## The critical section is bounded STRUCTURALLY, not by an adjective
 *
 * 🛑 "Narrow" that is only prose decays the first time someone adds one convenient
 * read. So the hold's body is **one `seats.json` read and at most one
 * `seats.json` write, and nothing else** — and the mechanism keeping it that way is
 * that **`mutate` returns a VALUE, never a Promise**. A synchronous callback cannot
 * `await`, and every form of record I/O, index I/O, network call, drain, signal and
 * process wait in this codebase is async, so none of them is reachable from inside
 * the hold BY TYPE. That is compiler-enforced, not reviewed. `test/seat-store.test.ts`
 * asserts the type; `test/seat-store-hold.test.ts` (AP11) counts the I/O the hold
 * actually performs and carries a control proving the count is not vacuous.
 *
 * ## 🛑 THE READER FAILS OPEN AND THE WRITER FAILS CLOSED — AND THAT ASYMMETRY IS
 * DELIBERATE. DO NOT "FIX" IT INTO SYMMETRY.
 *
 * The reader RETURNS rather than throws for an unhealthy file; `withSeatStoreWrite`
 * REFUSES to write over one (`SeatStoreUnwritableError`). Each leg fails in the
 * direction that is recoverable:
 *
 * - a reader that failed closed would make the whole box **unroutable over one bad
 *   byte** — every delivery on every seat, for a defect in one row;
 * - a writer that failed open would **destroy the authority**.
 *
 * 🛑 **BUT "FAILS OPEN" MEANS *ROUTING CONTINUES VIA THE MIRROR*, NEVER *THE STORE IS
 * SILENTLY EMPTY*** — and an earlier version of this module got that wrong, which is
 * finding F1. It returned a plain empty store for a corrupt file, so a lookup found
 * the seat in neither `seats` nor `malformedSeatIds` and answered **ABSENT** — and the
 * refusal then told an operator whose file was present and corrupt to *"run the
 * backfill"*, which **cannot repair corruption** and refuses to run against a
 * malformed store. A confident instruction to do the wrong thing is worse than an
 * error. The file's own state now travels on `SeatStore.fileState`, so absent,
 * malformed and unreadable stay three distinct answers with three distinct remedies.
 *
 * ⚠️ **THIS STORE IS THE ONE ARTIFACT IN THE DESIGN WITH NO RECOVERY PATH, AND THAT
 * IS WHY.** Everything else here is a projection: `index.json`, the index entries, the
 * `holder_active` mirror, the archive projections — all rebuildable from the records
 * that remain. **These seven fields are rebuildable from nothing.** Two of them
 * specifically cannot be reconstructed even in principle: `active_holder_id`, because
 * a mirror that disagreed with it is by definition not evidence of what it said; and
 * `next_ordinal`, because a re-minted counter RE-ISSUES labels, and "a number is never
 * re-issued" is the one guarantee Daniel stated outright (D4a). A rebuilt index costs a
 * scan; a rebuilt seat store costs the guarantee.
 *
 * ## Scaling — the ceiling is inherited rather than rediscovered
 *
 * Read-modify-write is **O(ALL SEATS) per write**: one JSON object, so every write
 * parses and rewrites every seat. At 389 seats that is 113 KB / 0.83 ms, and seat
 * writes are human/agent-frequency, so it is not a problem — `SEAT-STORE.md` §2(a)
 * rejected per-seat files for reasons that still stand, and names **~10 MB**
 * (~35,000 seats at ~290 bytes each) as the revisit point.
 * ⚠️ **What would break it EARLIER than size is FREQUENCY.** If anything ever
 * activates on a loop, the O(all seats) rewrite becomes a hot path and the
 * per-seat-file option has to be re-argued on new evidence. Neither condition is
 * near today; both are measurable, and neither is a date.
 */

/** The store's filename inside `SESSIONS_DIR`.
 *
 * Re-exported from `session-dir-files.ts` rather than defined here, so there is ONE
 * definition in the repo and every enumerator of `SESSIONS_DIR` consults the same
 * registry. A filename hand-copied per call site is §E72's shape — and worse, a
 * deny-list that spells it breaks again the next time a file joins that directory. */
export { SEAT_STORE_FILE };

/**
 * A seat. **THE FIELD SET IS CLOSED AND COMPLETE AT SEVEN** — Daniel, 2026-09-28
 * (`Bricks/346ae7cf-.../decision/DECISION.md` §3, Cluster A requirement 1).
 *
 * Struck, with his reasons on the record: `state`, `default_options`,
 * `default_cwd`, `description`, `total_cost`, `holder_count`. His governing
 * principle, verbatim: *"a seat is just something which ties together seat holders
 * and everything else regarding configuration and passing on configurations should
 * be something which we need to take care of doing the handover."*
 *
 * 🛑 **NOTHING BEHAVIOURAL, NOTHING CONFIGURATION-SHAPED, NOTHING DERIVABLE GOES
 * ON A SEAT — AND A PROPOSAL TO ADD A FIELD IS ANSWERED ON BRICK `346ae7cf`, NOT
 * HERE.** Two live consequences a reader will otherwise try to "fix":
 *
 * - **There is no `state` field, and that is not an omission.** The seat's state IS
 *   its current holder's state; `activeHolderId === null` is the whole vacancy rule.
 *   `closedAt` is a different fact (the seat abolished) and does not reintroduce
 *   one.
 * - **There is no divergence counter.** A per-seat `mirror_divergences` field was
 *   ruled in and then WITHDRAWN on 2026-09-28T13:30Z — an eighth field for a
 *   diagnostic whose whole lifetime is the write-both window, structurally the same
 *   shape as the `holder_count` Daniel struck as derivable. The visible metric is
 *   **derived, never stored**: one structured line at the flip, and a
 *   count-of-currently-divergent-seats computed on demand.
 */
/**
 * The seat's canonical brick link, carrying HOW IT WAS OBTAINED — brick
 * `9984c510`. Before this type existed, `brickId` was a bare `string`, which
 * could only say ABSENT or A REF, so the only honest option under a degraded
 * `brick show` was to withhold the ref — recreating the very defect (F1)
 * writing it fixed. This gives the field a third thing to say: the ref is
 * present AND we know whether `brick show` actually resolved it.
 *
 * ⚠️ **A TYPE CHANGE ON THE EXISTING SLOT, DELIBERATELY NOT A SECOND
 * INDEPENDENT FIELD.** Two independent fields (`brickId` + a new
 * `brickValidated`) would leave every existing read site compiling while
 * silently ignoring the new flag — this repo's own documented, already-paid-
 * for failure (`persisted-seat-contract.ts`: "writes are total, reads are
 * allowlists" lost four `acpx.*` fields exactly that way). A type change
 * makes every read site fail `pnpm run typecheck` BY NAME until repaired, so
 * invariant (i) — an unvalidated ref is never presented as validated
 * anywhere it is copied — is enforced by the compiler, not by diligence.
 *
 * 🔑 **A REAL BOOLEAN HERE, A STATE WORD ON THE HOLDER
 * (`session-management.ts`'s `metadata.brick_validation`) — DELIBERATE, NOT
 * AN INCONSISTENCY TO HARMONISE.** The asymmetry is forced by each field's
 * CARRIER, not by sloppiness: `metadata` is `Record<string,string>`, where
 * `"false"` is a non-empty, TRUTHY string — a boolean-string there would let
 * `if (md.brick_validation)` read the one value meaning "do not trust this"
 * as true. A typed JSON field has no such trap, PROVIDED two things hold —
 * both true here and both load-bearing: every read is an EQUALITY
 * (`row.brick_id_validated === true`, never a bare `if (row.brick_id_validated)`
 * truthiness check), and a malformed value is REJECTED by `isOmittableBoolean`
 * rather than coerced. Collapsing THIS side to a word would be harmless;
 * collapsing the holder side to a boolean-string reintroduces the truthy
 * trap. Rewriting this field's read as truthiness would ALSO break something
 * real — invariant (ii): `undefined` (not-yet-known) and `false`
 * (known-unvalidated) are different facts, and truthiness collapses them.
 */
export type SeatBrickLink = {
  readonly ref: string;
  /** TRUE only where `brick show` RESOLVED the ref. A timeout is not a
   * validation, and absence of this flag ON DISK is UNVALIDATED, never
   * validated-by-assumption (invariant (ii)). */
  readonly validated: boolean;
};

/** Build a {@link SeatBrickLink} from a possibly-empty ref, trimming it the
 * same way every other `brickId`-adjacent site in this codebase does.
 * `undefined`/empty ⇒ `undefined` — "absent", never an empty-string ref. */
export function seatBrickLinkFromRef(
  ref: string | undefined,
  validated: boolean,
): SeatBrickLink | undefined {
  const trimmed = ref?.trim();
  return trimmed ? { ref: trimmed, validated } : undefined;
}

export type SeatRecord = {
  /** Identity. A UUID (C1) — validated at the ORIGIN and nowhere else (D8). */
  seatId: string;
  createdAt: string;
  /** THE AUTHORITY for who holds this seat. A holder that has CLOSED still holds
   * it until a successor is activated (D-SEAT-HOLD). **`null` = vacant** — a
   * non-error state, which no product path writes any more (a close keeps the
   * pointer); it survives on a row the backfill has not yet filled. */
  activeHolderId: string | null;
  /** Monotonic counter. **Only ever increases**; read-incremented inside the write
   * hold so two concurrent activations cannot take the same number. Gaps are
   * LEGAL, repeats are DEFECTS (D4a): the guarantee is that a number is never
   * re-issued, not that none is ever skipped. */
  nextOrdinal: number;
  /** A deliberate SEAT closure — the seat abolished. `null` when open. Distinct
   * from a holder's `closed`, and distinct from vacancy. */
  closedAt: string | null;
  name: string | undefined;
  /**
   * THE SEAT'S CANONICAL BRICK LINK, QUALIFIED BY HOW IT WAS OBTAINED —
   * brick `9984c510`. The field set stays closed at EIGHT (below); this is a
   * TYPE change on the existing `brickId` slot, not a ninth field. See
   * {@link SeatBrickLink} for why a type change was chosen over a second,
   * independent field.
   */
  brickId: SeatBrickLink | undefined;
  /**
   * THE STAR, MOVED HERE FROM THE SESSION RECORD — Daniel's ruling D-STAR
   * (2026-09-30, relayed `Bricks/693ed2a9-.../` 22:09:40Z): *"the star actually
   * belongs to the seat and not to the session."* Cluster A's closed seven-field
   * set is reopened for this ONE additive field only — his decision, not a
   * precedent for an eighth-field proposal to point at.
   *
   * 🛑 TRI-STATE, DELIBERATELY — `undefined` IS A THIRD ANSWER, NOT A COERCED
   * `false`. It means "this row has not been through the favorite migration yet",
   * which is a DIFFERENT fact from "explicitly un-starred". A reader that collapses
   * the two (a first cut of this field did exactly that, caught by the L0
   * 2026-09-30T23:39Z on brick `6adabe72`) makes every currently-starred seat read
   * as unstarred for every box between deploying this field and running
   * `seats backfill`'s migration leg — a real, scheduled-sweep-facing window, not a
   * hypothetical one. `mintSeatRow` and `migrateSeatFavorite` always write an
   * explicit boolean, so `undefined` is reachable only on a row that predates this
   * field or has not yet been migrated — see `parseSeatFromPersisted` and the
   * archiver's `recordBlockerFor` (`retention.ts`) for what a caller must do with
   * that third state: fall back to the record's own legacy `favorite`, never treat
   * it as `false`.
   */
  favorite: boolean | undefined;
};

type SeatFieldPlan = { readonly persisted: true };

/**
 * ⚠️ COMPILER-FORCED EXHAUSTIVE OVER `SeatRecord` — requirement 1's closed field
 * set expressed as a build failure rather than a comment. Add an eighth field to
 * `SeatRecord` and this object fails `pnpm run typecheck` BY NAME until it is
 * registered, at which point the reader meets the closure rule above. Same
 * mechanism as `full-record-contract.ts`'s `RECORD_FIELD_PLAN`, at seat scope.
 *
 * The COUNT is asserted separately in `test/seat-store.test.ts`, because the
 * compiler can force exhaustiveness but cannot object to the set GROWING — and
 * growing is the thing Daniel closed. Two eighth-field proposals have already been
 * made and withdrawn, so that is a live pressure, not a hypothetical.
 */
export const SEAT_RECORD_FIELD_PLAN = {
  seatId: { persisted: true },
  createdAt: { persisted: true },
  activeHolderId: { persisted: true },
  nextOrdinal: { persisted: true },
  closedAt: { persisted: true },
  name: { persisted: true },
  brickId: { persisted: true },
  favorite: { persisted: true },
} as const satisfies { [K in keyof Required<SeatRecord>]: SeatFieldPlan };

/**
 * Raised by `seatFromStore` for a seat whose row is PRESENT and unreadable.
 *
 * 🛑 THE WHOLE POINT IS THAT MALFORMED NEVER READS AS ABSENT. D8's shape is that
 * *absent*, *malformed* and *present* are three states collapsed into one value by
 * layers that each pick a different one — and the expensive collapse here is
 * malformed→absent, because a caller told "no such seat" will happily create a
 * seat on top of a row that is still there.
 */
export class MalformedSeatRowError extends Error {
  constructor(
    readonly seatId: string,
    readonly storePath: string,
  ) {
    super(
      `seat ${JSON.stringify(seatId)} is PRESENT in the seat store ${storePath} but its row is malformed. ` +
        `This is not an absent seat and must not be treated as one: the row is still on disk. ` +
        `Repair or remove it deliberately — the store is the authority for this seat's active ` +
        `holder and next ordinal, and nothing else holds either.`,
    );
    this.name = "MalformedSeatRowError";
  }
}

/**
 * The parsed store.
 *
 * `seats` holds every row that parsed. `malformedSeatIds` names every row that did
 * not — **carried and visible, never repaired**, which is D8(4) applied to the
 * store itself. That list is also the derived, non-stored metric: a count of
 * unreadable rows, computed on demand, with nothing accumulating anywhere.
 */
export type SeatStore = {
  readonly seats: ReadonlyMap<string, SeatRecord>;
  readonly malformedSeatIds: readonly string[];
  /**
   * The rows that did not parse, kept EXACTLY AS READ.
   *
   * 🛑 THIS IS A DATA-LOSS DEFENCE, NOT BOOKKEEPING. A write re-emits these
   * verbatim. Without it, one malformed row would be silently DELETED by the next
   * write performed for any other seat — because a mutator naturally builds its
   * next state from `seats`, which by definition excludes them. "Carried, never
   * repaired" has to mean carried across a write, or it means nothing.
   */
  readonly unparsedRows: ReadonlyMap<string, unknown>;
  /**
   * THE STATE OF THE FILE ITSELF, which is a different question from the state of any
   * row in it.
   *
   * - `absent` — no `seats.json`. **NOT an error**: the first `withSeatStoreWrite`
   *   creates it, which on a fresh box is the first `sessions new` after deploy (or
   *   B10's backfill, if it runs first — same helper, same lock).
   * - `ok` — read and parsed. Individual rows may still be malformed; that is
   *   `malformedSeatIds`.
   * - `malformed` — the file exists and its top level does not parse.
   * - `unreadable` — the read itself failed for something other than "not there"
   *   (EACCES, EIO, …).
   *
   * 🛑 THIS EXISTS BECAUSE "MALFORMED NEVER READS AS ABSENT" HELD AT ROW SCOPE AND
   * INVERTED AT FILE SCOPE (F1, found by the test-engineer). A corrupt store used to
   * yield an empty store with zero malformed ids, so a lookup found the seat in
   * neither collection and answered ABSENT — and the refusal then prescribed *"this
   * seat predates the store; run the backfill"* to an operator whose file was present
   * and corrupt. **The backfill mints rows for records that lack them; it cannot
   * repair a malformed file** — so that was not merely an unhelpful message, it was a
   * confident instruction to do the wrong thing.
   *
   * ⚠️ AND THIS IS WHAT "READER FAILS OPEN" ACTUALLY MEANS: routing CONTINUES via the
   * `holder_active` mirror, never *the store is silently empty*. The reader keeps
   * working; it just stops lying about why.
   */
  readonly fileState: "absent" | "ok" | "malformed" | "unreadable";
  /**
   * The store's ABSOLUTE path, carried on the value so that every refusal built from a
   * store can name the file an operator must open (brick `6391b51b`). On a box with
   * more than one session directory a bare `seats.json` — or a UUID — is no address.
   */
  readonly storePath: string;
};

export function seatStorePath(sessionDir: string): string {
  return path.join(sessionDir, SEAT_STORE_FILE);
}

/** A seat id is a UUID (C1). Deliberately anchored and case-sensitive-lowercase:
 * every seat id in existence is a `crypto.randomUUID()`, which is lowercase. */
const SEAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Validate a seat reference AT THE ORIGIN — **D8**, and this is the only place it
 * happens (brick b64dfbb3; `ACTIVATION-PROTOCOL.md` §7).
 *
 * 🛑 **REJECTED, NOT REPAIRED. NOT TRIMMED, NOT LOWERCASED, NOT COERCED.** The value
 * that gets written is byte-identical to the value accepted, and an accepted value is
 * a UUID, which by definition has no surrounding whitespace.
 *
 * **A REPAIR AT THE ORIGIN IS WHAT CREATES THE COLLAPSE THIS EXISTS TO PREVENT.**
 * Normalising makes the stored value differ from the submitted one, so the layers
 * downstream end up disagreeing about which of the two they are looking at — and that
 * disagreement is the measured defect: *absent*, *malformed* and *valid* are three
 * states collapsed into one value, with each layer already picking a different one.
 * Measured at `db49b08b` on a whitespace-only seat id: `auth-env.ts:856-861` trims
 * then length-gates it, so it is ABSENT and no `ACPX_SEAT_URL` is emitted, silently;
 * `parseSeatFieldsFromPersistedRecord` type-checks only, so a whitespace string is
 * PRESENT AND VALID and rides onto the record; the index projection carries it
 * verbatim; acpx-ui's PUT boundary rejects it as MALFORMED; and B6's
 * `COALESCE(excluded.seat_id, seat_id)` coerces the absence away. Every layer is
 * individually consistent; jointly they contradict, which is why no single-site review
 * finds it.
 *
 * ⇒ If a malformed value can never ENTER, what each layer would do with one stops
 * mattering. That is why this closes the ORIGIN only, and why it costs nothing: the
 * invariant already held by construction — the sole minter is `crypto.randomUUID()` —
 * so this makes an incidental invariant a stated one rather than constraining anything
 * that works today.
 *
 * ⚠️ `auth-env.ts`'s `.trim()` is RECLASSIFIED, NOT REMOVED: it is a PRESENCE GUARD
 * for the transient creation spawn (where `seatId` is `""`/unset), and it is correct
 * as one because a valid UUID is unaffected by it. It is not the validator.
 */
export function parseSeatRefOrThrow(label: string, value: string): string {
  if (SEAT_ID_RE.test(value)) {
    return value;
  }
  throw new Error(
    `${label} must be a seat id in lowercase UUID form, got ${JSON.stringify(value)}. ` +
      `It is rejected rather than repaired: a seat id is never trimmed, lowercased or ` +
      `otherwise normalised, because a value that is stored differently from how it was ` +
      `submitted is exactly what makes the layers downstream disagree about whether it ` +
      `is absent, malformed or valid. Pass the seat id exactly as the seat store holds it.`,
  );
}

/**
 * Look a seat up. `undefined` means ABSENT; a malformed row THROWS.
 *
 * The signature is the enforcement: a caller cannot accidentally treat "present but
 * unreadable" as "not there", because the two do not share a return value.
 */
export function seatFromStore(store: SeatStore, seatId: string): SeatRecord | undefined {
  if (store.malformedSeatIds.includes(seatId)) {
    throw new MalformedSeatRowError(seatId, store.storePath);
  }
  // 🛑 AN UNHEALTHY FILE MUST NEVER ANSWER "ABSENT" (F1). The row may well be in there;
  // we cannot read it. Returning `undefined` here would send the caller down the
  // "predates the store, run the backfill" path — and the backfill cannot repair a
  // corrupt file, so that is a confident instruction to do the wrong thing.
  if (store.fileState === "malformed" || store.fileState === "unreadable") {
    throw new SeatStoreUnhealthyError(store.fileState, store.storePath);
  }
  return store.seats.get(seatId);
}

/**
 * The store's FILE could not be read, so nothing can be said about any row in it.
 *
 * Distinct from `MalformedSeatRowError` (one bad row in a readable file) and from a
 * genuinely absent seat, because the three demand different actions — which is the
 * whole of F1.
 */
export class SeatStoreUnhealthyError extends Error {
  constructor(
    readonly fileState: "malformed" | "unreadable",
    readonly storePath: string,
  ) {
    super(seatStoreUnhealthyMessage(fileState, storePath));
    this.name = "SeatStoreUnhealthyError";
  }
}

// ─── The C2 carrier: one helper, both legs, never re-derived per call site ────
//
// On-disk spelling is snake_case, following the RECORD leg (`SEAT-STORE.md`
// ratification item 4), so the two functions below are the only place that knows
// how a seat is spelled on disk — exactly as `seat-fields.ts` is for the four
// holder fields on a session record.

type PersistedSeat = {
  seat_id: string;
  created_at: string;
  active_holder_id: string | null;
  next_ordinal: number;
  closed_at: string | null;
  name?: string;
  brick_id?: string;
  /**
   * Brick `9984c510` — OMITTED when `brick_id` is absent. Absent WHILE
   * `brick_id` is present ⇒ the row reads as `{ref, validated:false}` on the
   * way back in (invariant (ii)) — a legacy row that predates this field, not
   * a malformed one; see {@link SeatBrickLink}.
   */
  brick_id_validated?: boolean;
  favorite?: boolean;
};

/**
 * The ONE place that knows the persisted spelling of a seat.
 *
 * ⚠️ THE ABSENT/NULL DISTINCTION IS DELIBERATE AND LOAD-BEARING. `active_holder_id`
 * and `closed_at` are always WRITTEN, `null` included, because `null` is a value
 * there — "vacant" and "not closed" are facts, and a reader must be able to
 * tell them from a field nobody wrote. `name` and `brick_id` are OMITTED when
 * unset, because for them absence is the fact. `JSON.stringify` drops
 * undefined-valued keys, which is what makes the second half work — so do NOT
 * "tidy" this by building the object with an assign-only-defined helper, which
 * would silently turn the two meaningful nulls into omissions.
 */
export function seatToPersisted(seat: SeatRecord): PersistedSeat {
  return {
    seat_id: seat.seatId,
    created_at: seat.createdAt,
    active_holder_id: seat.activeHolderId,
    next_ordinal: seat.nextOrdinal,
    closed_at: seat.closedAt,
    name: seat.name,
    brick_id: seat.brickId?.ref,
    // Travels WITH the ref, never independently of it — `seat.brickId?.validated`
    // is `undefined` exactly when `seat.brickId` itself is, so the two keys are
    // always omitted or present TOGETHER (brick `9984c510`).
    brick_id_validated: seat.brickId?.validated,
    // OMITTED WHEN UNDEFINED — same shape as `name`/`brick_id` above, not the two
    // meaningful nulls: `undefined` here means "not yet migrated", a fact whose
    // absence IS the fact, not a value nobody wrote. Once `mintSeatRow` or
    // `migrateSeatFavorite` has touched a row it carries an explicit `true`/`false`
    // forever after — this line is what lets that explicit value keep surviving
    // every subsequent whole-store rewrite, exactly as an explicit `name` does.
    favorite: seat.favorite,
  };
}

/**
 * The parse leg for one row. `undefined` means the row is malformed.
 *
 * ⚠️ STRICT ON EVERY FIELD, and that is the D8 choice rather than laziness: a
 * wrong-typed value anywhere in a routing authority's row makes the row
 * untrustworthy as a whole, and the caller's contract is that malformed is a third
 * state it must handle — so there is nothing to gain by half-admitting a row.
 * `closed_at` must be PRESENT (as `null` or a string), which additionally catches a
 * truncated or partially-written row that happens to still parse as JSON.
 */
/** A field whose `null` is a VALUE, not an absence: present, string or explicit null. */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** An OMITTABLE field: absent, or a string. `null` is rejected — it would be a third
 * state for a field whose meaning has only two, and `seatToPersisted` omits rather
 * than nulls precisely so that third state never reaches disk. */
function isOmittableString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** An OMITTABLE boolean — absent, or a boolean. A PRESENT wrong-typed value still
 * rejects the row (D8), exactly as a wrong-typed `brick_id` already does — no new
 * failure mode, same discipline one field over. */
function isOmittableBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

/** The ordinal counter. Starts at 1 and only ever increases, so 0 and negatives are
 * not "unset" — they are unreadable, and a store that handed one out would re-issue
 * a label that must never repeat. */
function isOrdinalCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** The five fields a seat cannot mean anything without. Split from the omittable half
 * only to keep each predicate readable at a glance (and under the complexity bound). */
function hasValidRequiredSeatFields(row: Record<string, unknown>): boolean {
  return (
    typeof row.seat_id === "string" &&
    row.seat_id.length > 0 &&
    typeof row.created_at === "string" &&
    isNullableString(row.active_holder_id) &&
    isOrdinalCounter(row.next_ordinal) &&
    isNullableString(row.closed_at)
  );
}

function hasValidOmittableSeatFields(row: Record<string, unknown>): boolean {
  return (
    isOmittableString(row.name) &&
    isOmittableString(row.brick_id) &&
    isOmittableBoolean(row.brick_id_validated)
  );
}

/**
 * `favorite` is PRESENT-AND-BOOLEAN on every row this store has ever written, and
 * ABSENT on every row written before D-STAR — which, on a box that has not yet run
 * `seats backfill`'s migration leg, is every existing seat. Rejecting that absence
 * as malformed would turn every seat on the fleet into `MalformedSeatRowError` the
 * instant this code deploys, before the migration that is supposed to fix it has
 * had a chance to run — `withSeatStoreWrite`'s own read path included, which is
 * what the migration itself calls. So absence is tolerated here — and, per the
 * field's own doc comment, PRESERVED AS `undefined` rather than coerced to `false`:
 * "not yet migrated" and "explicitly un-starred" are different facts, and a caller
 * that cannot tell them apart (the archiver's guard, first built to coerce this to
 * `false` and corrected 2026-09-30T23:39Z) silently unprotects every currently
 * starred seat for as long as the box has not migrated. A PRESENT wrong-typed value
 * still rejects the row, per the same D8 strictness every other field on it gets.
 */
function hasValidFavoriteField(row: Record<string, unknown>): boolean {
  return row.favorite === undefined || typeof row.favorite === "boolean";
}

export function parseSeatFromPersisted(raw: unknown): SeatRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  if (
    !hasValidRequiredSeatFields(row) ||
    !hasValidOmittableSeatFields(row) ||
    !hasValidFavoriteField(row)
  ) {
    return undefined;
  }
  // The two predicates above have validated every field; the assertions here carry
  // that knowledge across the boolean return, which is the cost of splitting the
  // checks out of this function. Each cast mirrors exactly one check above — change
  // one and change the other.
  return {
    seatId: row.seat_id as string,
    createdAt: row.created_at as string,
    activeHolderId: row.active_holder_id as string | null,
    nextOrdinal: row.next_ordinal as number,
    closedAt: row.closed_at as string | null,
    name: row.name as string | undefined,
    // Invariant (ii), brick `9984c510`: ABSENT `brick_id_validated` reads as
    // UNVALIDATED, never validated-by-assumption — the `=== true` test turns a
    // missing/legacy sibling into `false` rather than `undefined`, so a row
    // written before this field existed is never silently trusted.
    //
    // TE Gap C: routed through `seatBrickLinkFromRef` rather than built
    // inline, so an empty-string `brick_id` — unreachable from any writer
    // here (`seatToPersisted` only ever writes a trimmed, non-empty ref) but
    // reachable from a hand-written store — collapses to `undefined` instead
    // of becoming a truthy link with nothing in it. Without this, `show`
    // rendered `⚠ UNVALIDATED` with no ref, `list` rendered a bare `⚠`, and
    // (d′) could never fill the row at all (`brickId !== undefined` already
    // reads as "has a link").
    brickId: seatBrickLinkFromRef(
      row.brick_id as string | undefined,
      row.brick_id_validated === true,
    ),
    // ABSENT reads as `undefined`, NOT `false` — D8's absent/malformed/valid split
    // does not apply here (absence is a KNOWN, pre-migration state, never an
    // unreadable one), but coercing it to `false` collapses "not yet migrated" and
    // "explicitly un-starred" into one value, which is the defect the L0 caught.
    favorite: row.favorite as boolean | undefined,
  };
}

function emptyStore(fileState: SeatStore["fileState"], storePath: string): SeatStore {
  return { seats: new Map(), malformedSeatIds: [], unparsedRows: new Map(), fileState, storePath };
}

/**
 * Parse a store payload. Pure, so every row-level policy above is testable without
 * touching a filesystem.
 *
 * 🛑 A FILE WHOSE TOP LEVEL DOES NOT PARSE RETURNS `fileState: "malformed"`, NOT AN
 * INDISTINGUISHABLE EMPTY STORE. There are no rows to attribute, so
 * `malformedSeatIds` is legitimately empty — which is exactly why the FILE's state
 * has to be carried separately (F1). An empty store and a corrupt one demand
 * different actions, and the earlier shape made them the same value.
 *
 * **That is a READ policy only.** Writing over such a file would destroy every seat
 * in it, so `withSeatStoreWrite` refuses instead; see `SeatStoreUnwritableError`. The
 * split matters: a reader that fails closed makes the whole box unroutable over one
 * bad byte, while a writer that fails open destroys the authority. Each leg fails in
 * the direction that is recoverable.
 */
export function parseSeatStore(payload: string, storePath: string): SeatStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return emptyStore("malformed", storePath);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptyStore("malformed", storePath);
  }
  const seats = new Map<string, SeatRecord>();
  const malformedSeatIds: string[] = [];
  const unparsedRows = new Map<string, unknown>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const seat = parseSeatFromPersisted(value);
    // The key IS the identity, so a row whose `seat_id` disagrees with its key is
    // malformed however well-formed it looks on its own: one of the two is wrong and
    // nothing here can tell which.
    if (!seat || seat.seatId !== key) {
      malformedSeatIds.push(key);
      unparsedRows.set(key, value);
      continue;
    }
    seats.set(key, seat);
  }
  return { seats, malformedSeatIds, unparsedRows, fileState: "ok", storePath };
}

/**
 * Read the store from disk. **No cache, by design** — see the header.
 *
 * A MISSING FILE IS AN EMPTY STORE. That is not the same as an unreadable one; see
 * `parseSeatStore` for the read/write asymmetry.
 */
export async function readSeatStore(sessionDir: string): Promise<SeatStore> {
  let payload: string;
  try {
    payload = await fs.readFile(seatStorePath(sessionDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // (a) STORE ABSENT — not an error. The first write creates the file.
      return emptyStore("absent", seatStorePath(sessionDir));
    }
    // (c) UNREADABLE (EACCES, EIO, …) — THE READER DOES NOT THROW, and that is what
    // "reader fails open" means: routing continues via the `holder_active` mirror
    // rather than the whole box becoming unroutable over one bad permission bit. What
    // it must NOT do is pretend the store is empty, so the state travels with the
    // result and every caller can tell the two apart.
    return emptyStore("unreadable", seatStorePath(sessionDir));
  }
  return parseSeatStore(payload, seatStorePath(sessionDir));
}

/**
 * Raised when a write would destroy a store that exists but could not be read.
 *
 * `AcpxOperationalError`, not a plain `Error` (1dd9ae9a) — this is the WRITE SEAM
 * refusing, and it is thrown from three call sites (`withSeatStoreWrite`,
 * `refuseUnwritableStore` in `seats-command.ts`, and the backfill's own preflight),
 * only one of which previously wrapped it with a code. `SEAT_STORE_UNWRITABLE` is
 * REUSED verbatim from `seats-command.ts`'s established `SeatMutationRefusalCode` —
 * the code names WHICH SEAM refused, not which verb called it, so every raise site
 * carries the same code and the message text is unchanged either way.
 */
export class SeatStoreUnwritableError extends AcpxOperationalError {
  constructor(
    readonly filePath: string,
    readonly fileState: "malformed" | "unreadable",
  ) {
    super(
      `refusing to write the seat store at ${filePath}: writing would DESTROY every seat ` +
        `in it. This store is the authority for each seat's active holder and next ordinal — ` +
        `nothing else holds them, so unlike index.json it cannot be rebuilt from a ` +
        `projection, and restarting ordinals would re-issue labels that must never repeat. ` +
        `Do not delete it to clear this error. ${seatStoreUnhealthyMessage(fileState, filePath)}`,
      { outputCode: "RUNTIME", detailCode: "SEAT_STORE_UNWRITABLE", origin: "runtime" },
    );
  }
}

/** A no-op mutation: the hold is taken, the store is read, and NOTHING is written.
 * Distinct from writing an unchanged store — an O(all seats) rewrite that changes
 * nothing is pure cost, and on a missing store it would also create the file. */
export const SEAT_STORE_NO_CHANGE = { kind: "no-change" } as const;

export type SeatStoreMutation =
  | typeof SEAT_STORE_NO_CHANGE
  | { readonly kind: "write"; readonly seats: ReadonlyMap<string, SeatRecord> };

async function writeSeatStoreAtomically(
  sessionDir: string,
  seats: ReadonlyMap<string, SeatRecord>,
  unparsedRows: ReadonlyMap<string, unknown>,
): Promise<void> {
  const filePath = seatStorePath(sessionDir);
  // Per-call randomUUID for the reason `writeSessionIndex` documents:
  // `${pid}.${Date.now()}` alone is NOT unique, so two writes from this process in
  // the same millisecond build the identical temp path, the first rename wins and
  // the second hits ENOENT — turning a concurrent write into a thrown error.
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const payload: Record<string, unknown> = {};
  // Malformed rows first, then parsed ones — so a parsed row always wins a key
  // collision, and a row the caller has legitimately repaired replaces its own
  // unparsed predecessor instead of being shadowed by it.
  for (const [seatId, raw] of unparsedRows) {
    payload[seatId] = raw;
  }
  for (const [seatId, seat] of seats) {
    payload[seatId] = seatToPersisted(seat);
  }
  const ordered: Record<string, unknown> = {};
  for (const seatId of Object.keys(payload).toSorted()) {
    ordered[seatId] = payload[seatId];
  }
  await fs.writeFile(tempFile, `${JSON.stringify(ordered)}\n`, "utf8");
  // temp + rename, the shape `writeSessionIndex` already uses: no reader ever
  // observes a partially-written store, so no individual artefact is ever torn. The
  // torn states this design must survive are BETWEEN artefacts, never inside one (D4).
  await fs.rename(tempFile, filePath);
}

/**
 * THE ONE WRITER OF THE SEAT STORE. Every mutation goes through here.
 *
 * Takes the `index.json` lock, reads the store **fresh from disk inside the hold**,
 * hands it to `mutate`, and writes back whatever `mutate` asks for — one read, at
 * most one write, one hold.
 *
 * 🛑 **`mutate` RETURNS A VALUE, NEVER A PROMISE, AND THAT IS THE BOUND.** It cannot
 * `await`, so it cannot perform record I/O, index I/O, a network call, a drain, a
 * signal, a process wait or notice composition inside the hold — all of those are
 * async here. Making this signature `async` would delete a compiler-enforced
 * guarantee and replace it with a comment asking people to be careful. **If you want
 * to await inside `mutate`, the work belongs OUTSIDE the hold** — which is exactly
 * where the activation protocol puts its record writes and its index projection
 * (§2.7: the record writes fall between two holds; only the seat row is inside one).
 *
 * 🛑 **NEVER DECIDE FROM A VALUE CAPTURED BEFORE THE LOCK.** The store is read late,
 * inside the hold, and the whole guarantee lives in reading late — the rule
 * `index-overlay.ts`'s contract states for its own group. `mutate` is handed the
 * fresh store for precisely this reason; a mutator that consults an earlier snapshot
 * is a lost update waiting for a second writer.
 *
 * **To ABORT without writing, throw from `mutate`** — nothing is written and the lock
 * is released, which is how the activation's compare-and-swap refuses when a
 * concurrent activation won. To finish cleanly without writing, return
 * `SEAT_STORE_NO_CHANGE`.
 *
 * `result` comes back to the caller, so a decision taken against the fresh store —
 * the allocated ordinal, say — leaves the hold with it.
 */
export async function withSeatStoreWrite<T>(
  sessionDir: string,
  mutate: (store: SeatStore) => { mutation: SeatStoreMutation; result: T },
): Promise<T> {
  // OUTSIDE the hold, deliberately: directory creation is I/O, and the hold's body
  // is operations on one file and nothing else.
  await fs.mkdir(sessionDir, { recursive: true });
  return await withSessionIndexLock(sessionDir, async () => {
    const store = await readSeatStore(sessionDir);
    const { mutation, result } = mutate(store);
    if (mutation.kind === "no-change") {
      return result;
    }
    // 🛑 THE WRITER FAILS CLOSED ON AN UNHEALTHY FILE, and this is the asymmetry's other
    // half: writing over a store whose contents could not be read would DESTROY every
    // seat in it — and unlike `index.json` this file is rebuildable from nothing, since
    // it holds each seat's active holder and next ordinal and nothing else holds either.
    // `absent` is NOT unhealthy: creating the file is exactly what the first write on a
    // fresh box is for.
    //
    // ⚠️ THIS USED TO BE A SECOND `readFile` INSIDE THE HOLD (to tell an absent file
    // from an unparseable one), which quietly broke AP11's "exactly one read and one
    // write" bound on the create path — where the store IS empty, so the extra read
    // always fired. F1's typed `fileState` makes the distinction available from the read
    // already taken, so the bound now holds UNCONDITIONALLY rather than only when the
    // store happens to be non-empty.
    if (store.fileState === "malformed" || store.fileState === "unreadable") {
      throw new SeatStoreUnwritableError(seatStorePath(sessionDir), store.fileState);
    }
    await writeSeatStoreAtomically(sessionDir, mutation.seats, store.unparsedRows);
    return result;
  });
}

/**
 * Mint the seat ROW for a freshly-minted seat — **D13 (§14), brick b64dfbb3**.
 *
 * Called on the **fresh-mint** create paths only. `--seat` (D11) mints nothing: it
 * JOINS an existing row, and joining must never mint one.
 *
 * 🛑 **THE CALLER MUST WRITE THIS BEFORE THE SESSION RECORD (D13a), AND THE ORDER IS
 * THE WHOLE DESIGN.** The two writes can tear, and they are NOT symmetric:
 *
 * - **record first** ⇒ a session carrying a `seatId` with **no row** — a fully working
 *   session that can **never be succeeded**. Every other operation behaves normally and
 *   the damage surfaces only when someone first tries to hand over. **Silent, permanent,
 *   and it is exactly the gap §14 exists to delete, reproduced by a crash.**
 * - **row first** ⇒ an orphan row nobody references. Creation failed, the caller holds
 *   no seat id, no session claims it: ~290 bytes, inert, and **enumerable from the
 *   store**. ⚠️ NOT yet visible in any verb: `acpx seats list` is D12's and IS NOT BUILT
 *   (measured at the CLI: rc 4, "No acpx session found" — the token is not a registered
 *   verb, so it is absorbed as an agent name). Said as not-yet-built rather than reworded,
 *   so nobody reads this as a capability that exists
 *   as a seat with an unresolvable holder.
 *
 * ⇒ Row-first makes the SILENT state structurally unreachable and leaves only the loud
 * one. Same argument as D3's retire-before-point, same standard: every torn state reads
 * correct or loud, never silently unusable. The record id is available before either
 * write, so the row can name its holder before that holder exists on disk.
 *
 * ⚠️ Its own hold (D13b): one `seats.json` read, one write, **no record I/O inside** —
 * the record write happens outside it. The index lock is re-entrant and would permit
 * nesting the record write here; **do not.** §2.6.1's structural bound governs the
 * phase-2 activation hold, and this hold inherits the same discipline rather than being
 * exempted from it.
 */
export async function mintSeatRow(
  sessionDir: string,
  params: {
    readonly seatId: string;
    readonly holderId: string;
    readonly name: string | undefined;
    readonly createdAt: string;
    // F1 fix (brick 3dff714d) — the resolved `--brick` (explicit or
    // parent-inherited) for the founding holder, written onto the SEAT at mint
    // time. `undefined` when the holder itself carries none, matching the
    // "absent, not an empty string" discipline the field has always had.
    // Brick `9984c510` widened the TYPE: the caller must say HOW it was
    // obtained (validated vs unvalidated), never leave it to be re-guessed here.
    readonly brickId: SeatBrickLink | undefined;
  },
): Promise<void> {
  await withSeatStoreWrite(sessionDir, (store) => {
    // A freshly-minted `crypto.randomUUID()` cannot already be in the store. If it is,
    // something is badly wrong — a double-mint, or a caller passing a seat id it did not
    // mint — and silently overwriting would destroy a live seat's pointer and counter.
    if (store.seats.has(params.seatId) || store.malformedSeatIds.includes(params.seatId)) {
      throw new Error(
        `refusing to mint seat ${JSON.stringify(params.seatId)}: a row for it already ` +
          `exists. A freshly minted seat id cannot collide, so this is a double-mint or a ` +
          `caller minting an id it did not generate. Overwriting would discard that seat's ` +
          `active holder and next ordinal, neither of which can be reconstructed.`,
      );
    }
    const seats = new Map(store.seats);
    seats.set(params.seatId, {
      seatId: params.seatId,
      createdAt: params.createdAt,
      // B1 ships the founding holder as `holderActive: true, holderOrdinal: 1`, so it IS
      // the active holder from the first instant; a null here would make a brand-new
      // seat read as vacant.
      activeHolderId: params.holderId,
      // 🔑 TWO, NOT ONE — AND THIS IS THE ONE VALUE SOMEONE WILL "FIX" TO 1.
      // `next_ordinal` means THE NEXT ORDINAL TO HAND OUT, not how many holders exist.
      // Ordinal 1 is ALREADY TAKEN by the founding holder, which consumed it at creation
      // without ever passing through the activation hold. A row created with 1 therefore
      // makes the FIRST SUCCESSION ALLOCATE 1 A SECOND TIME — and D4a is explicit that a
      // gap is legal while a REPEAT IS A DEFECT. `1` looks right to anyone reading this
      // field as a count, which is exactly why it carries this comment.
      nextOrdinal: 2,
      closedAt: null,
      // CONCEPTION §4 contract C2, name removal, phase (i): the name is written to the seat
      // AND still to the session record, and the SEAT is authoritative wherever the two
      // disagree. Phase (ii)'s gate is a measured condition on the fleet, never a date.
      name: params.name,
      // F1 fix (brick 3dff714d) — the founding holder's resolved brick, so a
      // fresh `sessions new --brick <uuid>` writes the SEAT's `brick_id` rather
      // than leaving it for `brick attach` to set later (C4 / Cluster A
      // requirement 5 is still true for a seat minted with NO `--brick`:
      // `params.brickId` is `undefined` there, same as before this fix).
      brickId: params.brickId,
      // A freshly-minted seat has no holder history to derive a star from —
      // `false`, not absent (D-STAR moves the field onto the seat; there is no
      // legacy per-record value to carry forward for a seat that did not exist a
      // moment ago).
      favorite: false,
    });
    return { mutation: { kind: "write", seats }, result: undefined };
  });
}

/**
 * Mint the row for a seat that ALREADY EXISTS ON RECORDS — **B10's backfill leg**
 * (`acpx seats backfill`), and the second operation on the single-writer helper's
 * list (`SEAT-STORE.md` ratification item 2).
 *
 * 🛑 **IT LIVES HERE, BESIDE `mintSeatRow`, BECAUSE THE SINGLE-WRITER RULE IS ABOUT
 * THE WRITE PATH AND THE ROW SHAPE TOGETHER.** A bulk writer that touches every row
 * is the case item 2 exists for, and the conception ruling of 2026-09-29 is explicit
 * that the backfill uses *the same row code the box's own sessions use* — D8
 * strictness, `null` as a value, `closed_at` present — *"so there is no second
 * implementation of the row shape to drift"*. Putting this in the backfill module
 * would have created exactly that second implementation.
 *
 * ## How it differs from `mintSeatRow`, and why each difference is required
 *
 * - **It takes a whole computed row instead of minting one.** `mintSeatRow` knows
 *   its seat has exactly one holder, so it can hard-code `nextOrdinal: 2`. A
 *   backfilled seat may have SEVERAL holders already on disk, and AC11 (f) requires
 *   `next_ordinal = max(holder_ordinal) + 1` over that seat's records — **never a
 *   constant**. On a box where every existing seat happens to have one holder a
 *   hard-coded `2` passes against live data, which is exactly why the rule is
 *   stated as a rule and tested against a synthetic multi-holder rig.
 * - **An existing row is LEFT ALONE rather than a refusal.** `mintSeatRow` throws on
 *   a collision because a freshly minted `randomUUID()` cannot collide, so a
 *   collision there means a double-mint. Here a present row is the NORMAL case on
 *   every run after the first: it is what makes a second `--apply` report `0` and
 *   leave the store byte-identical. `SEAT_STORE_NO_CHANGE`, not a rewrite of an
 *   unchanged store — an O(all seats) rewrite that changes nothing is pure cost and
 *   would break the byte-identical row outright.
 * - **A MALFORMED row still throws.** "Carried, never repaired" (D8(4)) does not stop
 *   at the file: a seat whose row is present and unreadable is not a seat lacking a
 *   row, and minting over it would discard an active holder and an ordinal that
 *   nothing else holds.
 *
 * ⚠️ **THE ROW IS COMPUTED OUTSIDE THE HOLD AND THAT IS NOT OPTIONAL** — the
 * derivation reads session records, which is async, and `mutate` returns a VALUE.
 * The ruling's *"computes inside the critical section (or re-reads under the lock)"*
 * is satisfied by its second limb: the store is re-read under the lock on every
 * single call, and the PRESENT/MINT decision is taken inside the hold against that
 * fresh store. Nothing is cached across records and nothing is flushed at the end.
 */
export async function backfillSeatRow(
  sessionDir: string,
  row: SeatRecord,
): Promise<"minted" | "present"> {
  return await withSeatStoreWrite(sessionDir, (store) => {
    if (store.malformedSeatIds.includes(row.seatId)) {
      throw new MalformedSeatRowError(row.seatId, store.storePath);
    }
    if (store.seats.has(row.seatId)) {
      return { mutation: SEAT_STORE_NO_CHANGE, result: "present" as const };
    }
    const seats = new Map(store.seats);
    seats.set(row.seatId, row);
    return { mutation: { kind: "write", seats } as const, result: "minted" as const };
  });
}

/**
 * THE ONE-TIME `favorite` MIGRATION — D-STAR, `Bricks/6adabe72-.../CONTENT.md`
 * item 3. Called by `seat-backfill.ts` for every seat that ALREADY HAS a row (a
 * fresh mint gets its `favorite` baked into the whole row by `planSeatRow`
 * instead, via `backfillSeatRow` above — this function is the other half, for
 * rows that predate the field entirely).
 *
 * 🛑 **TOUCHES `favorite` AND NOTHING ELSE.** Every other field on an existing row
 * is left exactly as it stands — this is a migration of one field, not a
 * reconciliation of the whole row, and spreading the fresh row (never rebuilding
 * it) is what keeps `closed_at`'s "always present, `null` included" guarantee
 * intact across the write.
 *
 * IDEMPOTENT AND CHEAP TO CALL REPEATEDLY: `SEAT_STORE_NO_CHANGE` the moment the
 * on-disk value already matches, which is every seat's steady state after its
 * first migrating run — the property AC4 measures as "re-run touches zero rows".
 *
 * A MALFORMED row still throws (D8(4), same as `backfillSeatRow`): a row that is
 * present and unreadable is not a row lacking a migration, and writing over it
 * would discard whatever is still recoverable from it.
 */
export async function migrateSeatFavorite(
  sessionDir: string,
  seatId: string,
  desiredFavorite: boolean,
): Promise<"migrated" | "unchanged" | "no-row"> {
  return await withSeatStoreWrite(sessionDir, (store) => {
    if (store.malformedSeatIds.includes(seatId)) {
      throw new MalformedSeatRowError(seatId, store.storePath);
    }
    const row = store.seats.get(seatId);
    if (!row) {
      // No row yet — nothing to migrate. `backfillSeatRow` (run first, in the same
      // pass) is what mints one, already carrying the right `favorite`.
      return { mutation: SEAT_STORE_NO_CHANGE, result: "no-row" as const };
    }
    if (row.favorite === desiredFavorite) {
      return { mutation: SEAT_STORE_NO_CHANGE, result: "unchanged" as const };
    }
    const seats = new Map(store.seats);
    seats.set(seatId, { ...row, favorite: desiredFavorite });
    return { mutation: { kind: "write", seats } as const, result: "migrated" as const };
  });
}

/**
 * (d′), brick `9984c510` — FILL an ABSENT seat `brick_id` from the active
 * holder's own derived link, for a seat row that ALREADY EXISTS. Mirrors
 * `migrateSeatFavorite`'s shape one field over (a fresh mint gets its
 * `brickId` baked into the whole row by `planSeatRow` via `backfillSeatRow`
 * instead — this is the other half, for rows that predate the fix).
 *
 * 🛑 **NEVER OVERWRITES A PRESENT LINK (BRK2).** Unlike `favorite`'s
 * "any holder's star wins, even disagreeing with the stored value" rule,
 * there is no reconciliation leg here: an existing VALIDATED or UNVALIDATED
 * link is left EXACTLY as it stands, because this backfill has no way to
 * re-validate it and silently replacing a sibling link would be exactly the
 * laundering invariant (i) forbids. Only ABSENT → present is in scope.
 *
 * Always writes UNVALIDATED (R28 (5), CONTENT.md §4(E)) — this promotes the
 * holder's own derived copy verbatim and validates nothing; the caller
 * passes the already-derived ref, never re-deriving it here.
 *
 * IDEMPOTENT AND CHEAP TO CALL REPEATEDLY, same contract as
 * `migrateSeatFavorite`: `SEAT_STORE_NO_CHANGE` the moment there is nothing
 * left to fill — a seat with a present link, or a derived ref of `undefined`.
 *
 * A MALFORMED row still throws (D8(4), same as `migrateSeatFavorite`).
 */
export async function fillSeatBrickLink(
  sessionDir: string,
  seatId: string,
  derivedRef: string | undefined,
): Promise<"filled" | "unchanged" | "no-row"> {
  return await withSeatStoreWrite(sessionDir, (store) => {
    if (store.malformedSeatIds.includes(seatId)) {
      throw new MalformedSeatRowError(seatId, store.storePath);
    }
    const row = store.seats.get(seatId);
    if (!row) {
      // No row yet — nothing to fill. `backfillSeatRow` (run first, in the same
      // pass) is what mints one, already carrying the derived link.
      return { mutation: SEAT_STORE_NO_CHANGE, result: "no-row" as const };
    }
    if (row.brickId !== undefined || derivedRef === undefined) {
      return { mutation: SEAT_STORE_NO_CHANGE, result: "unchanged" as const };
    }
    const seats = new Map(store.seats);
    seats.set(seatId, { ...row, brickId: { ref: derivedRef, validated: false } });
    return { mutation: { kind: "write", seats } as const, result: "filled" as const };
  });
}

/**
 * D-SEAT-HOLD, brick `eca085bb` — POINT a NULL `active_holder_id` at the seat's
 * holder, for a seat row that ALREADY EXISTS and is not itself closed. A closed
 * session keeps holding its seat until a successor is activated, so a null pointer
 * on an open seat is the active-only backfill's leftover (brick `5c4b8c4a`).
 *
 * 🛑 **NEVER OVERWRITES A NON-NULL POINTER** — only activation replaces one — and
 * never touches a seat whose `closed_at` is set (an abolished seat's vacancy is
 * not this backfill's to repair). Writes the pointer and nothing else. Same
 * idempotent, malformed-row-throws contract as `fillSeatBrickLink`.
 */
export async function fillSeatActiveHolder(
  sessionDir: string,
  seatId: string,
  holderId: string,
): Promise<"filled" | "unchanged" | "no-row"> {
  return await withSeatStoreWrite(sessionDir, (store) => {
    if (store.malformedSeatIds.includes(seatId)) {
      throw new MalformedSeatRowError(seatId, store.storePath);
    }
    const row = store.seats.get(seatId);
    if (!row) {
      return { mutation: SEAT_STORE_NO_CHANGE, result: "no-row" as const };
    }
    if (row.activeHolderId !== null || row.closedAt !== null) {
      return { mutation: SEAT_STORE_NO_CHANGE, result: "unchanged" as const };
    }
    const seats = new Map(store.seats);
    seats.set(seatId, { ...row, activeHolderId: holderId });
    return { mutation: { kind: "write", seats } as const, result: "filled" as const };
  });
}

/**
 * Mint the row BEST-EFFORT AND LOUD — **ratification item 8, amended 2026-09-28.**
 *
 * 🛑 **SESSION CREATION NEVER DEPENDS ON THE SEAT STORE.** This is the call-site half of
 * the asymmetry: `withSeatStoreWrite` keeps failing CLOSED (it will not corrupt the
 * authority), and the create path decides that its own success does not depend on the
 * store. Two reasons, both permanent:
 *
 * 1. **FAIL-CLOSED IS A BOOTSTRAP TRAP.** Every recovery path on these boxes runs
 *    through creating an agent session. A store that stops `sessions new` stops its own
 *    repair — the remedy requires the thing the failure prevents, and the only actor
 *    left is a human by hand on a box where no agent can start. **A perfectly worded
 *    error does not create the session needed to act on it.**
 * 2. **THE "seat_id WITH NO ROW" STATE IS NEITHER SILENT NOR PERMANENT.** D13a priced it
 *    as both — correctly, when it was written. **AP17 was decided afterwards and makes
 *    it LOUD**, and B10's backfill repairs it. Nobody re-checked D13a's price against
 *    AP17; the ORDERING still stands, only the price on one branch changed.
 *
 * 🛑 **NEVER A BARE `.catch(() => {})`.** A neighbouring write in `runtime.ts` swallows
 * silently; that is the defect in that code, not the model to copy. This returns the
 * failure so the caller emits ONE diagnostic naming the condition and the REAL remedy.
 *
 * ✅ **THE `seat_id` STAYS ON THE RECORD** — the caller must not "tidy it up" because
 * `seatId?` is optional. It is the handle that makes the session repairable (B10 keys on
 * it), and it keeps the children's `parent_seat_id` chain intact: dropping it would not
 * only hide the session from the backfill, it would **orphan its descendants' seat
 * edges**.
 *
 * Returns the condition rather than throwing, so the caller cannot accidentally treat a
 * store failure as a creation failure.
 */
export async function mintSeatRowBestEffort(
  sessionDir: string,
  params: Parameters<typeof mintSeatRow>[1],
): Promise<{ minted: true } | { minted: false; diagnostic: string }> {
  try {
    await mintSeatRow(sessionDir, params);
    return { minted: true };
  } catch (error) {
    return {
      minted: false,
      diagnostic:
        `acpx seat-row-not-minted: seat=${params.seatId} holder=${params.holderId} ` +
        `store=${seatStorePath(sessionDir)} — the session was created and IS USABLE, and it ` +
        `keeps its seat id, but its seat has no row yet, so it cannot be joined or ` +
        `succeeded until one exists. ${brickConsequenceClause(params)}${seatStoreFailureRemedy(error)}`,
    };
  }
}

/**
 * F1 (brick `3dff714d`) widened what a failed mint costs: the SEAT's `brick_id`
 * is now written at mint time too (same row, same write), so a mint that fails
 * loses the canonical link, not only the row — while the holder's OWN
 * `metadata.brick` already landed (it was written before this call, on the
 * record itself, which did not fail). **This is exactly the findings' F4
 * class** ("a confident instruction to do the wrong thing is worse than an
 * error") if the message does not name it: an operator reading only the
 * generic remedy below has no way to know a brick link is even at stake.
 *
 * 🛑 **ONLY `seats backfill` IS A TRUE REMEDY HERE — `seats set-brick` IS NOT,
 * AND NAMING IT WOULD BE A SECOND F4.** `mintSeatRow` is one atomic write of
 * the WHOLE row; a failure means NO row exists for this seat at all, not a
 * row missing one field. `seats set-brick` requires a pre-existing row
 * (`requireSeatRow` refuses `SEAT_ROW_MISSING` otherwise), so it cannot act
 * until something else has minted one — which is exactly `seats backfill`'s
 * job (item (d): it now derives `brick_id` from the active holder, the same
 * holder this diagnostic names). Do not "helpfully" add `set-brick` to this
 * message; it is advice the operator cannot yet follow.
 *
 * Empty string when no brick was being minted at all, so a plain `sessions
 * new` failure keeps its original, unwidened message.
 */
function brickConsequenceClause(params: Parameters<typeof mintSeatRow>[1]): string {
  if (params.brickId === undefined) {
    return "";
  }
  return (
    `The seat's brick_id was NOT written — it is the CANONICAL copy (CONCEPTION C4) — even ` +
    `though the holder's own metadata.brick is already set to ${params.brickId.ref}. `
  );
}

/** The remedy for whatever actually went wrong — (c)'s two sub-cases differ, and a
 * generic "run the backfill" would be wrong for both of them. */
function seatStoreFailureRemedy(error: unknown): string {
  if (error instanceof SeatStoreUnwritableError) {
    return seatStoreUnhealthyMessage(error.fileState, error.filePath);
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "ENOSPC" || code === "EROFS") {
    return (
      `The store could not be written (${code}). Repair the filesystem — permissions or ` +
      `free space — then run \`acpx seats backfill --apply\` for the rows missed while it was unwritable.`
    );
  }
  return (
    `The row write failed: ${error instanceof Error ? error.message : String(error)}. ` +
    `Once the cause is fixed, run \`acpx seats backfill --apply\` to mint the missing rows.`
  );
}

/**
 * Thrown by a lookup that found NO ROW for a seat id — **by a call site that cannot
 * decide the origin itself.**
 *
 * 🛑 WHY THIS IS AN ERROR AND NOT A FINISHED MESSAGE. The advice depends on whether any
 * session record references the id (`seatRowMissingMessage`), and answering that reads
 * session records — async, and forbidden inside `withSeatStoreWrite`'s hold (one
 * `seats.json` read, at most one write, nothing else). So the hold throws this, carrying
 * only what it knows, and the layer OUTSIDE the hold turns it into the refusal.
 */
export class SeatRowMissingError extends Error {
  constructor(
    readonly seatId: string,
    readonly storePath: string,
  ) {
    super(`seat ${JSON.stringify(seatId)} has no row in ${storePath}.`);
    this.name = "SeatRowMissingError";
  }
}

/**
 * The message a "seat has no row" refusal must carry — **AP17**, and **R21**: the advice
 * follows the PROPERTY that makes the case repairable, never an enumeration of origins.
 *
 * 🛑 THE PROPERTY IS "A SESSION RECORD STILL CARRIES THIS SEAT ID". The backfill mints a
 * row for every seat-bearing record that lacks one, so it can heal exactly the seats some
 * record references — whether the seat predates the store or its row write failed — and
 * it cannot mint a seat nobody created. A message that sent every missing row to the
 * backfill was F4 (brick `bf454a2c`): precise, confident, and wrong for a mistyped id.
 * The caller supplies `referencedByRecord`; this function only words the two answers.
 *
 * ⚠️ THE BACKFILL ADVICE IS `acpx seats backfill --apply`, NOT `acpx seats backfill`: the
 * bare verb is a DRY RUN that writes nothing, so advising it would be a remedy that, run
 * as printed, changes nothing. Nor does the backfill establish a seat's brick link
 * (R26) — this message says nothing about migration state beyond the row.
 *
 * Never a bare "seat not found": every seat minted BEFORE D13 landed has a record and
 * **no row**, which makes a session that looks healthy meet a refusal that looks like a
 * bug in our code. Shared by D11's `--seat` refusal, the activation's phase-0.1 refusal
 * and the `seats` verbs so they cannot drift into describing one condition differently.
 */
export function seatRowMissingMessage(
  seatId: string,
  storePath: string,
  referencedByRecord: boolean,
): string {
  const subject = `seat ${JSON.stringify(seatId)} has no row in ${storePath}`;
  if (!referencedByRecord) {
    // 🛑 STATES ONLY WHAT THE SCAN MEASURED. It reads the hot tier through the same
    // enumeration and reader as the backfill, so "no READABLE record carries this id"
    // is true; "this seat was never minted" is NOT — a record that does not parse (or
    // one that only lives in the archive) is invisible to the scan and may well be the
    // seat's holder (L4 verification case C, 2026-10-03).
    return (
      `${subject}, and no readable session record in ${path.dirname(storePath)} carries that ` +
      `seat id. Check the id for a typo (\`acpx seats list\` shows the seats that exist).`
    );
  }
  return (
    `${subject}, but a session record still references it. Two origins, one remedy: either ` +
    `the seat PREDATES the seat store, or its row write failed at creation. Either way, ` +
    `RUN \`acpx seats backfill --apply\` — it mints a row for every seat-bearing record that ` +
    `lacks one, whatever the origin. The session itself is not broken and nothing is lost; ` +
    `until the row exists it simply cannot be joined or succeeded.`
  );
}

/**
 * The message for an UNHEALTHY STORE FILE — condition (c), and it is a **different
 * remedy** from a missing row (AP17 covers both, with their different remedies).
 *
 * 🛑 THE BACKFILL IS NOT THE REMEDY FOR CORRUPTION ON ITS OWN, and saying so is the
 * whole point. The backfill REFUSES to run against a malformed store — it names the
 * file, prints the quarantine step, and never overwrites, because a corrupt file may
 * hold hand-recoverable rows. Telling an operator with a corrupt store to "run the
 * backfill" is a confident instruction to do the wrong thing (F1).
 *
 * The ABSOLUTE path is spelled out everywhere the operator must act on the file —
 * including the quarantine target — so the step can be pasted (brick `6391b51b`).
 */
export function seatStoreUnhealthyMessage(
  fileState: "malformed" | "unreadable",
  storePath: string,
): string {
  if (fileState === "malformed") {
    return (
      `${storePath} EXISTS but its top level does not parse, so no seat in it can be ` +
      `read — this is NOT an empty store and NOT a missing seat. Repair: QUARANTINE the ` +
      `file (rename ${storePath} to ${storePath}.corrupt-<timestamp>, keeping ` +
      `it — it may hold hand-recoverable rows), THEN run \`acpx seats backfill --apply\`, ` +
      `which rebuilds every row from the session records. Do not delete it, and do not ` +
      `expect the backfill alone to fix this: it refuses to run against a malformed store ` +
      `rather than overwrite one.`
    );
  }
  return (
    `${storePath} could not be read (a permission or I/O failure, not a missing ` +
    `file), so no seat in it can be read — this is NOT an empty store and NOT a missing ` +
    `seat. Repair the filesystem first, then run \`acpx seats backfill --apply\` for any rows ` +
    `missed while it was unreadable.`
  );
}
