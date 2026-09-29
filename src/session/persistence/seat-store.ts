import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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
export type SeatRecord = {
  /** Identity. A UUID (C1) — validated at the ORIGIN and nowhere else (D8). */
  seatId: string;
  createdAt: string;
  /** THE AUTHORITY for who holds this seat. **`null` = nobody home** — a
   * first-class, non-error state, not an absence to be repaired. */
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
  brickId: string | undefined;
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
  constructor(readonly seatId: string) {
    super(
      `seat ${JSON.stringify(seatId)} is PRESENT in the seat store but its row is malformed. ` +
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
    throw new MalformedSeatRowError(seatId);
  }
  // 🛑 AN UNHEALTHY FILE MUST NEVER ANSWER "ABSENT" (F1). The row may well be in there;
  // we cannot read it. Returning `undefined` here would send the caller down the
  // "predates the store, run the backfill" path — and the backfill cannot repair a
  // corrupt file, so that is a confident instruction to do the wrong thing.
  if (store.fileState === "malformed" || store.fileState === "unreadable") {
    throw new SeatStoreUnhealthyError(store.fileState);
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
  constructor(readonly fileState: "malformed" | "unreadable") {
    super(seatStoreUnhealthyMessage(fileState));
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
};

/**
 * The ONE place that knows the persisted spelling of a seat.
 *
 * ⚠️ THE ABSENT/NULL DISTINCTION IS DELIBERATE AND LOAD-BEARING. `active_holder_id`
 * and `closed_at` are always WRITTEN, `null` included, because `null` is a value
 * there — "nobody home" and "not closed" are facts, and a reader must be able to
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
    brick_id: seat.brickId,
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
  return isOmittableString(row.name) && isOmittableString(row.brick_id);
}

export function parseSeatFromPersisted(raw: unknown): SeatRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  if (!hasValidRequiredSeatFields(row) || !hasValidOmittableSeatFields(row)) {
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
    brickId: row.brick_id as string | undefined,
  };
}

function emptyStore(fileState: SeatStore["fileState"]): SeatStore {
  return { seats: new Map(), malformedSeatIds: [], unparsedRows: new Map(), fileState };
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
export function parseSeatStore(payload: string): SeatStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return emptyStore("malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return emptyStore("malformed");
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
  return { seats, malformedSeatIds, unparsedRows, fileState: "ok" };
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
      return emptyStore("absent");
    }
    // (c) UNREADABLE (EACCES, EIO, …) — THE READER DOES NOT THROW, and that is what
    // "reader fails open" means: routing continues via the `holder_active` mirror
    // rather than the whole box becoming unroutable over one bad permission bit. What
    // it must NOT do is pretend the store is empty, so the state travels with the
    // result and every caller can tell the two apart.
    return emptyStore("unreadable");
  }
  return parseSeatStore(payload);
}

/** Raised when a write would destroy a store that exists but could not be read. */
export class SeatStoreUnwritableError extends Error {
  constructor(
    readonly filePath: string,
    readonly fileState: "malformed" | "unreadable",
  ) {
    super(
      `refusing to write the seat store at ${filePath}: writing would DESTROY every seat ` +
        `in it. This store is the authority for each seat's active holder and next ordinal — ` +
        `nothing else holds them, so unlike index.json it cannot be rebuilt from a ` +
        `projection, and restarting ordinals would re-issue labels that must never repeat. ` +
        `Do not delete it to clear this error. ${seatStoreUnhealthyMessage(fileState)}`,
    );
    this.name = "SeatStoreUnwritableError";
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
      // D9 phase (i): the name is written to the seat AND still to the session record,
      // and the SEAT is authoritative wherever the two disagree.
      name: params.name,
      // `brick attach` is this field's writer (C4 / Cluster A requirement 5) and that is
      // not this pass. Absent, deliberately — not an empty string.
      brickId: undefined,
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
      throw new MalformedSeatRowError(row.seatId);
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
        `succeeded until one exists. ${seatStoreFailureRemedy(error)}`,
    };
  }
}

/** The remedy for whatever actually went wrong — (c)'s two sub-cases differ, and a
 * generic "run the backfill" would be wrong for both of them. */
function seatStoreFailureRemedy(error: unknown): string {
  if (error instanceof SeatStoreUnwritableError) {
    return seatStoreUnhealthyMessage(error.fileState);
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EACCES" || code === "EPERM" || code === "ENOSPC" || code === "EROFS") {
    return (
      `The store could not be written (${code}). Repair the filesystem — permissions or ` +
      `free space — then run the seat backfill for the rows missed while it was unwritable.`
    );
  }
  return (
    `The row write failed: ${error instanceof Error ? error.message : String(error)}. ` +
    `Once the cause is fixed, run the seat backfill to mint the missing rows.`
  );
}

/**
 * The message a "seat has no row" refusal must carry — **AP17**.
 *
 * 🛑 NEVER A BARE "seat not found". Every seat minted BEFORE D13 landed has a record and
 * **no row**; that population is B10's backfill and §14 cannot reach it. So an operator
 * hitting this meets a session that looks healthy, a seat id that looks valid, and a
 * refusal that looks like a bug in our code. The message has to name the CAUSE and the
 * REMEDY — which is the "never silently unusable" standard applied to the message rather
 * than to the state.
 *
 * Shared by D11's `--seat` refusal and the activation's phase-0.2 refusal so the two
 * cannot drift into saying different things about the same condition.
 */
export function seatRowMissingMessage(seatId: string): string {
  return (
    `seat ${JSON.stringify(seatId)} has no row in ${SEAT_STORE_FILE}. Two origins, one ` +
    `remedy: either the seat PREDATES the seat store, or its row write failed at creation. ` +
    `Either way, RUN THE SEAT BACKFILL — it mints a row for every seat-bearing record that ` +
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
 */
export function seatStoreUnhealthyMessage(fileState: "malformed" | "unreadable"): string {
  if (fileState === "malformed") {
    return (
      `${SEAT_STORE_FILE} EXISTS but its top level does not parse, so no seat in it can be ` +
      `read — this is NOT an empty store and NOT a missing seat. Repair: QUARANTINE the ` +
      `file (rename ${SEAT_STORE_FILE} to ${SEAT_STORE_FILE}.corrupt-<timestamp>, keeping ` +
      `it — it may hold hand-recoverable rows), THEN run the seat backfill, which rebuilds ` +
      `every row from the session records. Do not delete it, and do not expect the ` +
      `backfill alone to fix this: it refuses to run against a malformed store rather ` +
      `than overwrite one.`
    );
  }
  return (
    `${SEAT_STORE_FILE} could not be read (a permission or I/O failure, not a missing ` +
    `file), so no seat in it can be read — this is NOT an empty store and NOT a missing ` +
    `seat. Repair the filesystem first, then run the seat backfill for any rows missed ` +
    `while it was unreadable.`
  );
}
