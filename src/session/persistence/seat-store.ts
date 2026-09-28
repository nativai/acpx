import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withSessionIndexLock } from "./index-lock.js";

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

/** The store's filename inside `SESSIONS_DIR`. Exported because acpx-ui's watcher
 * classifier and its orphan filters must name the same file — a filename
 * hand-copied per call site is §E72's shape. */
export const SEAT_STORE_FILE = "seats.json";

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
 *   `closedAt` is a different fact (the office abolished) and does not reintroduce
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
  /** A deliberate SEAT closure — the office abolished. `null` when open. Distinct
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
};

export function seatStorePath(sessionDir: string): string {
  return path.join(sessionDir, SEAT_STORE_FILE);
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
  return store.seats.get(seatId);
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

const EMPTY_STORE: SeatStore = {
  seats: new Map(),
  malformedSeatIds: [],
  unparsedRows: new Map(),
};

/**
 * Parse a store payload. Pure, so every row-level policy above is testable without
 * touching a filesystem.
 *
 * 🛑 A FILE WHOSE TOP LEVEL IS NOT AN OBJECT YIELDS AN EMPTY STORE WITH NO
 * MALFORMED IDS — there are no rows to attribute, so claiming one would be a lie.
 * **That is a READ policy only.** Writing over such a file would destroy every seat
 * in it, so `withSeatStoreWrite` refuses instead; see `SeatStoreUnwritableError`.
 * The split matters: a reader that fails closed makes the whole box unroutable over
 * one bad byte, while a writer that fails open destroys the authority. Each leg
 * fails in the direction that is recoverable.
 */
export function parseSeatStore(payload: string): SeatStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return EMPTY_STORE;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return EMPTY_STORE;
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
  return { seats, malformedSeatIds, unparsedRows };
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
      return EMPTY_STORE;
    }
    throw error;
  }
  return parseSeatStore(payload);
}

/** Raised when a write would destroy a store that exists but could not be read. */
export class SeatStoreUnwritableError extends Error {
  constructor(filePath: string) {
    super(
      `refusing to write the seat store at ${filePath}: the file exists but its top-level ` +
        `structure could not be read, so writing would DESTROY every seat in it. This store is ` +
        `the authority for each seat's active holder and next ordinal — nothing else holds ` +
        `them, so unlike index.json it cannot be rebuilt from a projection, and restarting ` +
        `ordinals would re-issue labels that must never repeat. Repair or move the file ` +
        `deliberately; do not delete it to clear this error.`,
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
    if (store.seats.size === 0 && store.malformedSeatIds.length === 0) {
      // Nothing parsed AND nothing attributable: either the file is absent (fine,
      // we are creating it) or its top level was unreadable (not fine — writing
      // would destroy it). Only a stat can tell those apart, and it costs one
      // syscall on the create path alone.
      await refuseIfUnreadableFileExists(sessionDir);
    }
    await writeSeatStoreAtomically(sessionDir, mutation.seats, store.unparsedRows);
    return result;
  });
}

async function refuseIfUnreadableFileExists(sessionDir: string): Promise<void> {
  const filePath = seatStorePath(sessionDir);
  let payload: string;
  try {
    payload = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  // The file is there and `readSeatStore` found nothing in it. An empty object is a
  // legitimately empty store; anything else did not parse.
  const trimmed = payload.trim();
  if (trimmed.length === 0 || trimmed === "{}") {
    return;
  }
  throw new SeatStoreUnwritableError(filePath);
}
