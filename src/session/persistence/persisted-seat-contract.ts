/**
 * THE TOP-LEVEL SEAT-FIELD CONTRACT — the seat/holder sibling of
 * `persisted-acpx-contract.ts`, same mechanism, different scope.
 *
 * ## Why this file is separate from `persisted-acpx-contract.ts`
 *
 * That file's sentinel (`PERSISTED_ACPX_SENTINEL`) is `satisfies
 * Required<SessionAcpxState>` — it walks `record.acpx.*` ONLY. C2 (brick
 * 5ad22d5d) puts the seat/holder fields TOP-LEVEL on `SessionRecord`,
 * explicitly NOT nested inside `acpx.*` — so they are a THIRD scope the
 * existing sentinel does not and structurally cannot cover (the same reason
 * the `messages.Agent.claudeUuid` defect needed its own compile-time guard,
 * brick f575e22, rather than being folded into the `acpx.*` one).
 *
 * `persisted-allowlist-roundtrip.test.ts`'s own header names the hazard this
 * mechanism exists to close: **"writes are total, reads are allowlists"** —
 * `serializeSessionRecordForDisk` passes a field through wholesale while
 * every reader (parse, the index projection, ...) rebuilds it key by key, so
 * a write-only test round-trips in memory and passes while a real reader
 * drops the field in production. Four `acpx.*` fields were lost exactly this
 * way before that guard existed; this file is the same guard, scoped to the
 * four seat/holder fields B1 registers below.
 *
 * ⚠️ **THIS FILE DOES NOT COVER A FUTURE FIELD BY ITSELF — a real
 * test-engineer proved it (GATE-B1-FALSIFIABILITY G1b, brick 5ad22d5d).**
 * `PersistedSeatFields` is `Pick<SessionRecord, these 4 names>` — a
 * HAND-WRITTEN list. Adding a field to `SessionRecord` does nothing to this
 * Pick; nothing here forces a new field into it, unlike
 * `persisted-acpx-contract.ts`'s `Required<SessionAcpxState>`, which covers
 * its WHOLE type by construction. The TE proved this with a field added to
 * `SessionRecord` + `serialize.ts` alone, silently destroyed on every round
 * trip, while this file's own guard stayed green throughout (it was never
 * told the field existed). **`full-record-contract.ts` is the guard that
 * actually closes that gap** — it is exhaustive over every key of
 * `SessionRecord`, compiler-forced, so a new field must be classified there
 * or the build fails. Read that file, not this comment, for the guarantee
 * a future top-level field actually gets.
 *
 * ## How the guard works — two halves, and neither is sufficient alone
 *
 * 1. **THIS OBJECT IS EXHAUSTIVE BY COMPILATION.** `satisfies
 *    Required<Pick<SessionRecord, ...>>` means a new key added to the Pick
 *    below without a sentinel value **fails `pnpm run typecheck`**, by name.
 * 2. **`test/persisted-seat-roundtrip.test.ts` drives every transform leg
 *    with it** and asserts key by key, so a key registered here but missing
 *    from a leg's allowlist reds that row BY NAME.
 *
 * ## Scope, stated explicitly so nobody assumes coverage that isn't there
 *
 * This sentinel covers ONLY the seat/holder top-level record fields listed
 * in the `Pick<...>` below, and ONLY the ones already listed there today — it
 * does **not** automatically pick up a future field, seat-shaped or not (see
 * the warning above). It does **not** cover `record.acpx.*` (that is
 * `persisted-acpx-contract.ts`'s job). **`full-record-contract.ts` is the
 * file with the general guarantee** — it classifies every top-level
 * `SessionRecord` key, compiler-forced, so nothing added after this file was
 * written can silently go unregistered. This file remains useful as the
 * seat-specific fixture `persisted-seat-roundtrip.test.ts` drives for its
 * INDEX-leg assertions (`full-record-contract.ts`'s guard does not touch the
 * index projection — see its own Scope note) — it is a real, narrower guard,
 * not a decommissioned one.
 *
 * ⚠️ SENTINELS ARE DISTINCT ON PURPOSE, same reasoning as the sibling file:
 * an equality test over identical placeholders passes on a crossed wire (a
 * transform that copied `seatId` into `parentSeatId` would be invisible to a
 * guard whose sentinels happen to match).
 */

import type { SessionRecord } from "../../types.js";

export type PersistedSeatFields = Pick<
  SessionRecord,
  "seatId" | "holderOrdinal" | "holderActive" | "parentSeatId"
>;

export const PERSISTED_SEAT_SENTINEL = {
  seatId: "sentinel-seat-id",
  holderOrdinal: 987_654,
  holderActive: true,
  parentSeatId: "sentinel-parent-seat-id",
} as const satisfies Required<PersistedSeatFields>;
