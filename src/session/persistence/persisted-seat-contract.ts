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
 * way before that guard existed; this file is the same guard for the
 * top-level seat/holder fields B1 introduces, and — same as its sibling — is
 * meant to keep covering every top-level seat-scoped field a LATER block
 * adds, not just the four registered here today.
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
 * in the `Pick<...>` below. It does **not** cover `record.acpx.*` (that is
 * `persisted-acpx-contract.ts`'s job) and it does **not** cover every
 * top-level `SessionRecord` field that existed before B1 — those are already
 * hand-enumerated field-by-field in `parseSessionRecord`'s single return
 * literal and are not the subject of the "writes are total, reads are
 * allowlists" hazard class this file exists to close (that class bites
 * fields parsed by a SEPARATE, more permissive sub-parser — `acpx.*` via
 * `parseAcpxState`, or these seat fields if a future reader ever grows one).
 * A block that adds another top-level, allowlist-parsed field should either
 * extend this file's `Pick<...>` (if it's seat/holder-shaped) or add its own
 * sibling contract file — never assume this file or its `acpx.*` sibling
 * already guards it.
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
