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
