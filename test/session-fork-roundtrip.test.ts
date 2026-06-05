import assert from "node:assert/strict";
import test from "node:test";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// Part B: minimal fork-field round-trip (forked_from_session_id /
// forked_at_message_index) so a fork's lineage survives a daemon rewrite.

function baseRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    ...makeSessionRecord({
      acpxRecordId: "fork-rt",
      acpSessionId: "fork-rt",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: "/workspace/x",
    }),
    ...overrides,
  };
}

/** Simulate the on-disk write: `undefined` keys are dropped by JSON.stringify. */
function toDisk(persisted: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(persisted)) as Record<string, unknown>;
}

test("fork fields survive serialize → disk → parse with identical values", () => {
  const record = baseRecord({ forkedFromSessionId: "parent-xyz", forkedAtMessageIndex: 42 });
  const persisted = serializeSessionRecordForDisk(record);
  assert.equal(persisted.forked_from_session_id, "parent-xyz");
  assert.equal(persisted.forked_at_message_index, 42);

  const parsed = parseSessionRecord(toDisk(persisted));
  assert.ok(parsed);
  assert.equal(parsed.forkedFromSessionId, "parent-xyz");
  assert.equal(parsed.forkedAtMessageIndex, 42);
});

test("fork lineage is durable across a parse → serialize → parse rewrite", () => {
  const record = baseRecord({ forkedFromSessionId: "src-abc", forkedAtMessageIndex: 7 });
  // First write, then a daemon-style read+rewrite.
  const first = parseSessionRecord(toDisk(serializeSessionRecordForDisk(record)));
  assert.ok(first);
  const rewritten = parseSessionRecord(toDisk(serializeSessionRecordForDisk(first)));
  assert.ok(rewritten);
  assert.equal(rewritten.forkedFromSessionId, "src-abc");
  assert.equal(rewritten.forkedAtMessageIndex, 7);
});

test("forked_at_message_index: 0 survives (no falsy-drop)", () => {
  const record = baseRecord({ forkedFromSessionId: "p", forkedAtMessageIndex: 0 });
  const persisted = serializeSessionRecordForDisk(record);
  assert.equal(persisted.forked_at_message_index, 0); // emitted, not dropped

  const onDisk = toDisk(persisted);
  assert.equal(onDisk.forked_at_message_index, 0); // survives the write
  assert.ok("forked_at_message_index" in onDisk);

  const parsed = parseSessionRecord(onDisk);
  assert.ok(parsed);
  assert.equal(parsed.forkedAtMessageIndex, 0);
});

test("a record without fork fields stays clean (no null keys on disk)", () => {
  const record = baseRecord();
  const persisted = serializeSessionRecordForDisk(record);
  // Absent → undefined in the serialized object, never null.
  assert.equal(persisted.forked_from_session_id, undefined);
  assert.equal(persisted.forked_at_message_index, undefined);

  const onDisk = toDisk(persisted);
  assert.ok(!("forked_from_session_id" in onDisk));
  assert.ok(!("forked_at_message_index" in onDisk));

  const parsed = parseSessionRecord(onDisk);
  assert.ok(parsed);
  assert.equal(parsed.forkedFromSessionId, undefined);
  assert.equal(parsed.forkedAtMessageIndex, undefined);
});

test("wrong fork-field types are rejected (parse returns null)", () => {
  const clean = toDisk(serializeSessionRecordForDisk(baseRecord()));

  assert.equal(parseSessionRecord({ ...clean, forked_from_session_id: 123 }), null);
  assert.equal(parseSessionRecord({ ...clean, forked_at_message_index: -5 }), null);
  assert.equal(parseSessionRecord({ ...clean, forked_at_message_index: 1.5 }), null);
  assert.equal(parseSessionRecord({ ...clean, forked_at_message_index: "2" }), null);
});
