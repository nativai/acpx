/**
 * THE FULL TOP-LEVEL SESSIONRECORD CONTRACT (brick 5ad22d5d, G1b fix).
 *
 * ## Why this file exists
 *
 * `persisted-seat-contract.ts` is exhaustive over `Pick<SessionRecord, 4 seat
 * field names>` — a HAND-WRITTEN list. Adding a field to `SessionRecord` does
 * NOTHING to that Pick; nothing forces a future field into it. A real
 * test-engineer proved the consequence: `holderRetiredAt` added to
 * `SessionRecord` + `serialize.ts` alone, never touched `parse.ts` or any
 * contract file, and was silently destroyed on every round trip — build
 * green, typecheck green, all 19 existing seat tests green throughout.
 *
 * This file closes that gap **for the whole top-level record**, not just the
 * seat fields: `RECORD_FIELD_PLAN` is `satisfies { [K in keyof
 * Required<SessionRecord>]: FieldPlan }` — add ANY new top-level field to
 * `SessionRecord` and this file fails to compile until you classify it.
 *
 * ## The classification, and why it is not simply "must round-trip"
 *
 * Every field is either:
 *   - `{ persisted: true }` — a fully-populated record must carry this field,
 *     unchanged, through serialize → parse → serialize (proven by
 *     `test/full-record-roundtrip.test.ts`, driven from `FULL_RECORD_SENTINEL`
 *     below).
 *   - `{ persisted: false, reason: string }` — deliberately exempted, with a
 *     STATED reason. An exemption is a decision, not a shrug — the round-trip
 *     test asserts every exemption here is still true (a field that starts
 *     surviving must have its exemption removed, or a fixed bug looks like a
 *     structural drop forever).
 *
 * This is the SAME two-sided discipline `persisted-allowlist-roundtrip.test.ts`
 * already applies to `EXEMPT` for the nested `acpx.*` blob — copied here for
 * the top-level record, not invented fresh.
 *
 * ## Scope — read before assuming this covers something it does not
 *
 * This file covers ONLY the top-level `SessionRecord` ↔ on-disk-record round
 * trip (serialize.ts / parse.ts). It does NOT cover:
 *   - `record.acpx.*` (nested) — `persisted-acpx-contract.ts`'s job.
 *   - The `index.json` projection — `persisted-seat-contract.ts` covers the
 *     four seat fields there; no file covers the REST of the index-entry
 *     field set exhaustively (a gap this fix does not claim to close — out of
 *     the approved scope, ERRATA §E12).
 * `persisted-seat-contract.ts` still exists and is not redundant: it is what
 * the seat-specific round-trip test (`persisted-seat-roundtrip.test.ts`)
 * drives for its INDEX-leg assertions, which this file's fixture does not
 * attempt (a fully-populated record is not written through the index
 * projection here).
 */

import type { SessionRecord } from "../../types.js";

export type FieldPlan =
  | { readonly persisted: true }
  | { readonly persisted: false; readonly reason: string };

export const RECORD_FIELD_PLAN = {
  schema: { persisted: true },
  acpxRecordId: { persisted: true },
  acpSessionId: { persisted: true },
  agentSessionId: { persisted: true },
  agentName: { persisted: true },
  agentCommand: { persisted: true },
  cwd: { persisted: true },
  name: { persisted: true },
  createdAt: { persisted: true },
  lastUsedAt: { persisted: true },
  lastSeq: { persisted: true },
  lastRequestId: { persisted: true },
  eventLog: { persisted: true },
  closed: { persisted: true },
  closedAt: { persisted: true },
  favorite: { persisted: true },
  favoritedAt: { persisted: true },
  pid: { persisted: true },
  agentStartedAt: { persisted: true },
  lastPromptAt: { persisted: true },
  lastAgentExitCode: { persisted: true },
  lastAgentExitSignal: { persisted: true },
  lastAgentExitAt: { persisted: true },
  lastAgentDisconnectReason: { persisted: true },
  lastAgentUnexpectedDuringPrompt: { persisted: true },
  protocolVersion: { persisted: true },
  agentCapabilities: { persisted: true },
  title: { persisted: true },
  messages: { persisted: true },
  messagesLog: {
    persisted: false,
    reason:
      "serializeSessionRecordForDisk only writes messages_log when called with " +
      "{ messages: 'split-tail' } (serialize.ts's useSplitTail branch) — the " +
      "default call this guard's round-trip test uses omits it unconditionally, " +
      "by the existing (pre-B1) design of that option. Not a drop; a different " +
      "call convention this guard does not exercise.",
  },
  updated_at: { persisted: true },
  cumulative_token_usage: { persisted: true },
  request_token_usage: { persisted: true },
  acpx: { persisted: true },
  kind: { persisted: true },
  parentSessionId: { persisted: true },
  parentSessionUrl: { persisted: true },
  parentSetAt: { persisted: true },
  spawnedBySessionId: { persisted: true },
  forkedFromSessionId: { persisted: true },
  forkedAtMessageIndex: { persisted: true },
  forkedAtMessageIndexRequested: { persisted: true },
  subagents: { persisted: true },
  metadata: { persisted: true },
  importedFrom: { persisted: true },
  template: { persisted: true },
  seatId: { persisted: true },
  holderOrdinal: { persisted: true },
  holderActive: { persisted: true },
  parentSeatId: { persisted: true },
} as const satisfies { [K in keyof Required<SessionRecord>]: FieldPlan };
