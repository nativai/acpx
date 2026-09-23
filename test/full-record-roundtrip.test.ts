import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import { RECORD_FIELD_PLAN } from "../src/session/persistence/full-record-contract.js";
import { PERSISTED_ACPX_SENTINEL } from "../src/session/persistence/persisted-acpx-contract.js";
import type { SessionAcpxState, SessionRecord } from "../src/types.js";

// Brick 5ad22d5d, G1b FIX — a real test-engineer falsified the original claim
// that persisted-seat-contract.ts "keeps covering every top-level seat-scoped
// field a LATER block adds": it added `holderRetiredAt` to SessionRecord and
// serialize.ts alone, never touched parse.ts or any contract file, and the
// field was silently destroyed on every round trip while build, typecheck and
// all 19 existing seat tests stayed green.
//
// THIS FILE closes that gap for the WHOLE top-level record, not just the
// seat fields: full-record-contract.ts's `RECORD_FIELD_PLAN` is
// compiler-forced exhaustive over EVERY key of `SessionRecord` (add a field,
// typecheck fails here until it is classified `persisted: true` or
// `persisted: false, reason: ...`). This file is what proves every field
// classified `persisted: true` actually survives serialize -> parse.
//
// Scope: the RECORD leg only (serialize.ts / parse.ts), per the approved
// boundary (ERRATA §E12) — not the index projection, not a persistence-layer
// refactor, not a fourth scope.

// `FieldPlan`'s `persisted` is a non-nullable boolean-literal discriminant
// (`{ persisted: true } | { persisted: false; reason: string }`), so truthiness
// narrows identically to `=== true` / `=== false` here. The exhaustiveness that
// matters does NOT live in these filters — it lives in RECORD_FIELD_PLAN's own
// `satisfies { [K in keyof Required<SessionRecord>]: FieldPlan }`, which fails to
// compile when a field is added unclassified.
const PERSISTED_TRUE_KEYS = (Object.keys(RECORD_FIELD_PLAN) as (keyof SessionRecord)[]).filter(
  (key) => RECORD_FIELD_PLAN[key].persisted,
);
const PERSISTED_FALSE_KEYS = (Object.keys(RECORD_FIELD_PLAN) as (keyof SessionRecord)[]).filter(
  (key) => !RECORD_FIELD_PLAN[key].persisted,
);

/**
 * Fields exempt from the CONTENT (deep-equal) check below, though still
 * required to be PRESENT (not undefined) — `acpx` is the one case: its
 * nested `progress` field has its own separate, already-covered exemption
 * (`persisted-allowlist-roundtrip.test.ts`'s EXEMPT list — "LIVE turn state
 * ... deliberately not round-tripped"), so a strict deep-equal against the
 * full `PERSISTED_ACPX_SENTINEL` here would red on a KNOWN, correct
 * behaviour this guard does not own. Scope: this file proves the record's
 * top-level fields survive; `acpx.*` internal content fidelity is
 * `persisted-acpx-contract.ts`'s job, not duplicated here.
 */
const CONTENT_CHECK_EXEMPT = new Set<keyof SessionRecord>(["acpx"]);

/**
 * A FULLY POPULATED SessionRecord — every `persisted: true` field carries a
 * distinct, non-default, realistic sentinel value. `messagesLog` (the sole
 * `persisted: false` field today) is deliberately left undefined; see its
 * reason in full-record-contract.ts.
 */
function fullRecordSentinel(): SessionRecord {
  return {
    schema: "acpx.session.v1",
    acpxRecordId: "full-record-guard-1",
    acpSessionId: "acp-full-record-guard-1",
    agentSessionId: "agent-session-sentinel",
    agentName: "sentinel-agent-name",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace/sentinel-cwd",
    name: "sentinel-name",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:01.000Z",
    lastSeq: 42,
    lastRequestId: "sentinel-request-id",
    eventLog: {
      active_path: "sentinel.stream.ndjson",
      segment_count: 3,
      max_segment_bytes: 1024,
      max_segments: 5,
      last_write_at: "2026-01-01T00:00:02.000Z",
      last_write_error: "sentinel-write-error",
    },
    closed: true,
    closedAt: "2026-01-01T00:00:03.000Z",
    favorite: true,
    favoritedAt: "2026-01-01T00:00:04.000Z",
    pid: 12345,
    agentStartedAt: "2026-01-01T00:00:05.000Z",
    lastPromptAt: "2026-01-01T00:00:06.000Z",
    lastAgentExitCode: 1,
    lastAgentExitSignal: "SIGTERM",
    lastAgentExitAt: "2026-01-01T00:00:07.000Z",
    lastAgentDisconnectReason: "sentinel-disconnect-reason",
    lastAgentUnexpectedDuringPrompt: true,
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: true, audio: false, embeddedContext: true } },
    title: "sentinel-title",
    messages: [],
    updated_at: "2026-01-01T00:00:08.000Z",
    cumulative_token_usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 20,
    },
    request_token_usage: {
      "req-1": { input_tokens: 5, output_tokens: 6 },
    },
    acpx: structuredClone(PERSISTED_ACPX_SENTINEL) as SessionAcpxState,
    kind: "session",
    parentSessionId: "sentinel-parent-id",
    parentSessionUrl: "https://atrium.example.test/?session=sentinel-parent-id",
    parentSetAt: "2026-01-01T00:00:09.000Z",
    spawnedBySessionId: "sentinel-spawned-by-id",
    forkedFromSessionId: "sentinel-forked-from-id",
    forkedAtMessageIndex: 3,
    forkedAtMessageIndexRequested: 5,
    subagents: [
      {
        acpxRecordId: "sentinel-subagent-id",
        name: "sentinel-subagent-name",
        color: "blue",
        spawnedAt: "2026-01-01T00:00:10.000Z",
        claudeJsonlPath: "/tmp/sentinel-subagent.jsonl",
      },
    ],
    metadata: { brick: "sentinel-brick-id" },
    importedFrom: {
      recordId: "sentinel-imported-record-id",
      cwdOriginal: "/original/sentinel/cwd",
      exportedBy: "sentinel-exporter",
      exportedAt: "2026-01-01T00:00:11.000Z",
    },
    template: {
      enabled: true,
      created_at: "2026-01-01T00:00:12.000Z",
      source_session_id: "sentinel-template-source-id",
      auto_prompt: "sentinel-auto-prompt",
      slug: "sentinel-template-slug",
      version: 2,
    },
    seatId: "sentinel-seat-id",
    holderOrdinal: 1,
    holderActive: true,
    parentSeatId: "sentinel-parent-seat-id",
    // messagesLog deliberately absent — persisted: false, see full-record-contract.ts.
  };
}

test("full-record guard 1 · every `persisted: true` field survives serialize → parse", () => {
  const onDisk = JSON.parse(JSON.stringify(serializeSessionRecordForDisk(fullRecordSentinel())));
  const parsed = parseSessionRecord(onDisk);
  assert.ok(parsed, "the whole record is gone");

  const sentinel = fullRecordSentinel();
  const missing: string[] = [];
  const changed: string[] = [];
  for (const key of PERSISTED_TRUE_KEYS) {
    const actual: unknown = parsed[key];
    const expected: unknown = sentinel[key];
    if (actual === undefined) {
      missing.push(key);
      continue;
    }
    if (CONTENT_CHECK_EXEMPT.has(key)) {
      continue;
    }
    try {
      assert.deepEqual(actual, expected);
    } catch {
      changed.push(key);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `DROPPED ${missing.length} field(s) classified persisted:true in full-record-contract.ts: ` +
      `${missing.join(", ")}. That transform is an allowlist — add the field to serialize.ts ` +
      `and parse.ts, or reclassify it persisted:false with a stated reason.`,
  );
  assert.deepEqual(
    changed,
    [],
    `field(s) came back CHANGED, not merely dropped: ${changed.join(", ")}`,
  );
});

test("full-record guard 2 · a SECOND round trip keeps them — the write-back that persists a loss", () => {
  const first = parseSessionRecord(
    JSON.parse(JSON.stringify(serializeSessionRecordForDisk(fullRecordSentinel()))),
  );
  assert.ok(first);
  const second = parseSessionRecord(
    JSON.parse(JSON.stringify(serializeSessionRecordForDisk(first))),
  );
  assert.ok(second);

  const sentinel = fullRecordSentinel();
  const missing: string[] = [];
  for (const key of PERSISTED_TRUE_KEYS) {
    if (second[key] === undefined) {
      missing.push(key);
    }
  }
  assert.deepEqual(missing, [], `DROPPED on the SECOND round trip: ${missing.join(", ")}`);
  void sentinel; // referenced for readability/symmetry with guard 1; equality already covered there
});

test("full-record guard 3 · every exemption is still USED — a stale exemption hides a real regression", () => {
  const onDisk = JSON.parse(JSON.stringify(serializeSessionRecordForDisk(fullRecordSentinel())));
  const parsed = parseSessionRecord(onDisk);
  assert.ok(parsed);

  const staleExemptions = PERSISTED_FALSE_KEYS.filter((key) => parsed[key] !== undefined);
  assert.deepEqual(
    staleExemptions,
    [],
    `field(s) marked persisted:false in full-record-contract.ts now SURVIVE the round trip: ` +
      `${staleExemptions.join(", ")}. Remove the exemption — a stale one hides a real regression later.`,
  );
});

test("full-record guard 4 · the plan is non-trivial and covers every SessionRecord key", () => {
  // Belt for the compile-time half: `satisfies { [K in keyof Required<SessionRecord>]: FieldPlan }`
  // already makes a missing OR excess key a TYPE error (verified by mutation
  // probe during implementation — both directions red). This row states the
  // count so a silent shrink is visible in a diff.
  const total = PERSISTED_TRUE_KEYS.length + PERSISTED_FALSE_KEYS.length;
  assert.equal(
    total,
    50,
    `RECORD_FIELD_PLAN has ${total} classified keys, this test expected 50. If you added a field ` +
      `to SessionRecord: classify it in full-record-contract.ts, then run guards 1-3 above. If you ` +
      `removed one: update this count deliberately.`,
  );
  assert.equal(
    PERSISTED_FALSE_KEYS.length,
    1,
    `expected exactly 1 exempt field (messagesLog), found ${PERSISTED_FALSE_KEYS.length}: ${PERSISTED_FALSE_KEYS.join(", ")}`,
  );
});
