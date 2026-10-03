/**
 * THE SHARED SEAT-FIELD PROJECTION HELPER (C2, brick 5ad22d5d).
 *
 * C2's own words: "One shared projection helper feeds both legs, replacing
 * the two hand-maintained parallel field lists." This file IS that helper —
 * the single place that knows the seat/holder field set, rendering it into
 * each leg's own convention rather than being copy-pasted per leg:
 *
 *   - the RECORD leg is snake_case on disk (parse.ts / serialize.ts)
 *   - the INDEX leg is camelCase on disk (toSessionIndexEntry / parseIndexEntry
 *     in index.ts) — currently the SAME field set as the record leg; see
 *     `SeatIndexFields`'s own doc comment below for why `parentSeatId` is on
 *     it (D-B1-14: the F4 divergence-healing hazard, not the hot-path UI)
 *
 * A future seat/holder field is added HERE — one place — not independently
 * re-derived in parse.ts, serialize.ts, toSessionIndexEntry and
 * parseIndexEntry the way every other persisted field on this record still
 * is. `persisted-seat-contract.ts`'s exhaustiveness guard is what PROVES this
 * file's two legs actually cross every transform; this file is what makes
 * "crossing every transform" mean editing one function instead of four.
 */

import type { SessionRecord } from "../../types.js";
import type { SessionIndexEntry } from "./index.js";

export type SeatRecordFields = Pick<
  SessionRecord,
  "seatId" | "holderOrdinal" | "holderActive" | "parentSeatId"
>;

// ─── WRITE-AUTHORITY PARTITION (D1, brick b64dfbb3) ─────────────────────────

/**
 * THE SEAT GROUP HAS TWO WRITERS, NOT ONE — and this partition is the anchor
 * that says which field belongs to which (D1, `ACTIVATION-PROTOCOL.md` §3.5).
 *
 * The set above is a PROJECTION set: which fields travel together onto the
 * index. Authority is a different question, and it follows the WRITER:
 *
 *   - `holder`  — `seatId` / `holderOrdinal` / `holderActive`. Written at
 *     record construction, then by B2's activation (succession) write and
 *     nothing else. Protected across the privileged close by
 *     `preserveSeatHolderFieldsForPersist`, bypassed by `authoritative.seatHolder`.
 *   - `linkage` — `parentSeatId`. Written at record construction, then by
 *     `sessions set-parent` — `applyParentToRecord` sets it on the same line as
 *     `parentSessionId`, one writer, one call site, one fact. Protected by
 *     `preserveParentLinkageForPersist`, bypassed by `authoritative.parent`.
 *
 * 🛑 WHY NOT ONE COARSE `seat?: true` AUTHORITATIVE FLAG. The preserves return
 * early on their flag for the WHOLE function, not one field. With a single flag
 * `set-parent` must declare it to write `parentSeatId` — and that same flag
 * would hand `set-parent` authority over `holderActive`, reintroducing a second
 * writer of the active-holder mirror through the very mechanism meant to
 * protect it. That is Cluster A requirement 3's single-writer clause broken by
 * its own fix. The partition makes the coupling STRUCTURAL instead of remembered.
 *
 * ⚠️ THIS OBJECT IS THE ANCHOR AND IT IS COMPILER-FORCED EXHAUSTIVE. Adding a
 * fifth field to `SeatRecordFields` fails `pnpm run typecheck` BY NAME here
 * until it is classified into one half — the same `RECORD_FIELD_PLAN` mechanism
 * `full-record-contract.ts` uses, at seat scope. An anchor going red on a change
 * to its source IS the anchor working; repair it by classifying the new field
 * after confirming the change was intended.
 *
 * ⚠️ THIS DOES NOT SPLIT WHAT TRAVELS. `SeatIndexFields` and
 * `seatFieldsToIndexEntry` still carry all four as one group — the index is a
 * projection of the record and has no authority question at all. A reader who
 * splits the index projection too has misread D1.
 */
export type SeatFieldHalf = "holder" | "linkage";

export const SEAT_FIELD_PARTITION = {
  seatId: "holder",
  holderOrdinal: "holder",
  holderActive: "holder",
  parentSeatId: "linkage",
} as const satisfies { [K in keyof Required<SeatRecordFields>]: SeatFieldHalf };

/** The field names of one half, as a type — derived FROM the partition, so a
 * newly classified field joins its half with no second list to update. */
type SeatFieldsInHalf<H extends SeatFieldHalf> = {
  [K in keyof typeof SEAT_FIELD_PARTITION]: (typeof SEAT_FIELD_PARTITION)[K] extends H ? K : never;
}[keyof typeof SEAT_FIELD_PARTITION];

/** The two halves as record-field types. Derived, never hand-listed: these are
 * what the two preserve functions take, so classifying a new field into a half
 * widens that preserve automatically. */
export type SeatHolderFields = Pick<SessionRecord, SeatFieldsInHalf<"holder">>;
export type SeatLinkageFields = Pick<SessionRecord, SeatFieldsInHalf<"linkage">>;

/** The field names of one half, at runtime — the list both preserves iterate.
 * Derived from the partition for the same reason the types are: a hand list
 * "is correct the day it is written and silently wrong the day a field is
 * added" (§E72), and this is the list a preserve would otherwise hard-code. */
function seatFieldNamesInHalf<H extends SeatFieldHalf>(half: H): SeatFieldsInHalf<H>[] {
  const names: SeatFieldsInHalf<H>[] = [];
  for (const key of Object.keys(SEAT_FIELD_PARTITION) as (keyof SeatRecordFields)[]) {
    if (SEAT_FIELD_PARTITION[key] === half) {
      names.push(key as SeatFieldsInHalf<H>);
    }
  }
  return names;
}

const SEAT_HOLDER_FIELD_NAMES = seatFieldNamesInHalf("holder");
const SEAT_LINKAGE_FIELD_NAMES = seatFieldNamesInHalf("linkage");

/** Copy ONE seat field from source to target, keeping the per-field type. Kept
 * generic so the copy below needs no `any` and no per-field branch. */
function assignSeatField<K extends keyof SeatRecordFields>(
  target: Pick<SeatRecordFields, K>,
  source: Pick<SeatRecordFields, K>,
  field: K,
): void {
  target[field] = source[field];
}

/**
 * Copy the `holder` half from `source` onto `target`.
 *
 * ⚠️ TOTAL OVER THE HALF, AND UNCONDITIONAL PER FIELD — it copies `undefined`
 * as `undefined` rather than skipping an absent value. That is deliberate and
 * it is the whole point of the preserve that calls it: the lost update being
 * defended IS a stale in-memory record carrying the OLD value, so a
 * fill-an-absence copy would let exactly that through unchanged. Absence is a
 * value here, as it is in the projection helpers above.
 */
export function copySeatHolderFields(target: SeatHolderFields, source: SeatHolderFields): void {
  for (const field of SEAT_HOLDER_FIELD_NAMES) {
    assignSeatField(target, source, field);
  }
}

/** Copy the `linkage` half. Same totality and the same reason as the holder
 * half above — `preserveParentLinkageForPersist` already documents it for the
 * `parentSessionId` group this field pairs with. */
export function copySeatLinkageFields(target: SeatLinkageFields, source: SeatLinkageFields): void {
  for (const field of SEAT_LINKAGE_FIELD_NAMES) {
    assignSeatField(target, source, field);
  }
}

/** The subset of SeatRecordFields projected onto the INDEX entry — currently
 * ALL of them. `parentSeatId` joined this set (D-B1-14 correction) so the F4
 * divergence-healing mechanism in session-reparent.ts, which compares the
 * record's parentSessionId against the index entry's, has a parentSeatId to
 * compare too — see SessionIndexEntry.parentSeatId's own doc comment. */
export type SeatIndexFields = Pick<
  SessionIndexEntry,
  "seatId" | "holderOrdinal" | "holderActive" | "parentSeatId"
>;

// ─── RECORD leg (snake_case on disk) ────────────────────────────────────────

/** serialize.ts calls this to render the seat fields into the persisted,
 * snake_case object — the ONE place that knows the persisted spelling. */
export function seatFieldsToPersistedRecord(record: SeatRecordFields): {
  seat_id: string | undefined;
  holder_ordinal: number | undefined;
  holder_active: boolean | undefined;
  parent_seat_id: string | undefined;
} {
  return {
    seat_id: record.seatId,
    holder_ordinal: record.holderOrdinal,
    holder_active: record.holderActive,
    parent_seat_id: record.parentSeatId,
  };
}

/** parse.ts calls this against the raw (already snake_case) on-disk object.
 * Returns `null` if any present field has the wrong type — the same
 * reject-the-whole-record discipline parse.ts already applies to every other
 * field, so a corrupt seat field behaves exactly like a corrupt name/pid/etc.
 * does today rather than as a special case. */
export function parseSeatFieldsFromPersistedRecord(raw: {
  seat_id?: unknown;
  holder_ordinal?: unknown;
  holder_active?: unknown;
  parent_seat_id?: unknown;
}): SeatRecordFields | null {
  const seatId = optionalString(raw.seat_id);
  const holderOrdinal = optionalNonNegativeInteger(raw.holder_ordinal);
  const holderActive = optionalBoolean(raw.holder_active);
  const parentSeatId = optionalString(raw.parent_seat_id);
  const anyRejected = [seatId, holderOrdinal, holderActive, parentSeatId].some((v) => v === null);
  if (anyRejected) {
    return null;
  }
  return {
    seatId: seatId ?? undefined,
    holderOrdinal: holderOrdinal ?? undefined,
    holderActive: holderActive ?? undefined,
    parentSeatId: parentSeatId ?? undefined,
  };
}

// ─── INDEX leg (camelCase on disk, narrower subset) ─────────────────────────

/** index.ts's toSessionIndexEntry calls this — the ONE place that knows
 * which seat fields reach the hot-path index projection. */
export function seatFieldsToIndexEntry(record: SeatRecordFields): SeatIndexFields {
  return {
    seatId: record.seatId,
    holderOrdinal: record.holderOrdinal,
    holderActive: record.holderActive,
    parentSeatId: record.parentSeatId,
  };
}

/** index.ts's parseIndexEntry calls this against the raw (already camelCase)
 * index-entry object. Lenient like every other hot-path enrichment field on
 * that parser: a wrong-typed value is dropped, never rejects the entry. */
export function parseSeatFieldsFromIndexEntry(raw: Record<string, unknown>): SeatIndexFields {
  return {
    seatId: typeof raw.seatId === "string" ? raw.seatId : undefined,
    holderOrdinal:
      typeof raw.holderOrdinal === "number" && Number.isFinite(raw.holderOrdinal)
        ? raw.holderOrdinal
        : undefined,
    holderActive: typeof raw.holderActive === "boolean" ? raw.holderActive : undefined,
    parentSeatId: typeof raw.parentSeatId === "string" ? raw.parentSeatId : undefined,
  };
}

// ─── the BRICK pair on the INDEX leg (brick fb1a7a9c / 9d0fb37c) ─────────────

/** The two index fields that carry a session's brick. They travel TOGETHER through the two
 * functions below, so a leg cannot project the ref and forget its state — the shape the
 * 9d0fb37c test-engineer measured (byte-identical index for a validated and an unvalidated
 * link). */
export type BrickIndexFields = Pick<SessionIndexEntry, "metadataBrick" | "metadataBrickValidation">;

/**
 * Projects the holder's brick CACHE (`metadata.brick`, written at mint and join from the seat)
 * and its validation state. 🛑 This is a PURE record→entry function with no seat access, and
 * three paths build entries from it (write, overlay, reconcile-from-disk) — so the index shows
 * the cache, not a fresh seat read. It is as current as the holder's last write.
 *
 * ⚠️ `unvalidated` is the DEFAULT, not `validated`: a holder with a brick and no state word
 * (every pre-9984c510 record) reads `unvalidated`. Assert the key with a specific value — a
 * skipped write and an unknown state would otherwise look the same.
 */
export function brickFieldsToIndexEntry(record: Pick<SessionRecord, "metadata">): BrickIndexFields {
  const metadata = record.metadata;
  const brick = metadata?.brick;
  return {
    metadataBrick: brick,
    metadataBrickValidation:
      typeof brick === "string" && brick.trim()
        ? metadata?.brick_validation === "validated"
          ? "validated"
          : "unvalidated"
        : undefined,
  };
}

/** Lenient like the rest of the hot-path parser: a legacy entry (a brick, no state key) and a
 * wrong-typed state both read `unvalidated`; no brick reads no state. */
export function parseBrickFieldsFromIndexEntry(raw: Record<string, unknown>): BrickIndexFields {
  const metadataBrick = typeof raw.metadataBrick === "string" ? raw.metadataBrick : undefined;
  return {
    metadataBrick,
    metadataBrickValidation: metadataBrick?.trim()
      ? raw.metadataBrickValidation === "validated"
        ? "validated"
        : "unvalidated"
      : undefined,
  };
}

// ─── local normalizers (deliberately NOT shared with parse.ts's — that
// file's helpers are private to it, and duplicating three trivial one-liners
// here is cheaper than exporting internals across a module boundary for it) ──

function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : null;
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "boolean" ? value : null;
}

function optionalNonNegativeInteger(value: unknown): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
