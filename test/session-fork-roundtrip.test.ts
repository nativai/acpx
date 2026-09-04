import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import {
  readSessionIndex,
  sessionIndexPath,
  toSessionIndexEntry,
  writeSessionIndex,
} from "../src/session/persistence/index.js";
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

// ── B0.2: `forkedAtMessageIndexRequested`, the new sibling field ──────────────
//
// ⚠️ CONCEPTION §9.3's transform-leg checklist, walked in full. The project page
// records FOUR separate silent drops from exactly this class (brick 07dd62c9),
// each on a DIFFERENT leg — and every one of them is green through typecheck and
// build, because a dropped field is a missing assignment, not a type error. The
// legs asserted below are: serialize → disk → parse (record space) and
// toSessionIndexEntry → index parse (LIST space, which is what the chat header
// reads on acpx-ui's enriched hot path where `sessionData` is null).

test("forkedAtMessageIndexRequested survives serialize → disk → parse", () => {
  const record = baseRecord({
    forkedFromSessionId: "src-codex",
    forkedAtMessageIndex: 2,
    forkedAtMessageIndexRequested: 3,
  });
  const persisted = serializeSessionRecordForDisk(record);
  assert.equal(persisted.forked_at_message_index, 2, "the EFFECTIVE index is the primary field");
  assert.equal(persisted.forked_at_message_index_requested, 3);

  const parsed = parseSessionRecord(toDisk(persisted));
  assert.ok(parsed);
  assert.equal(parsed.forkedAtMessageIndex, 2);
  assert.equal(parsed.forkedAtMessageIndexRequested, 3);
});

test("forkedAtMessageIndexRequested reaches the INDEX ENTRY — the leg the chat header reads", async () => {
  const record = baseRecord({
    forkedFromSessionId: "src-codex",
    forkedAtMessageIndex: 2,
    forkedAtMessageIndexRequested: 3,
  });
  // toSessionIndexEntry is CONCEPTION §9.3 leg 4 and is mandatory for anything a
  // header displays: acpx-ui's enriched path sets `sessionData = null` and reads
  // its view from the entry, so a field that stops at the detail view fails only
  // at runtime.
  const entry = toSessionIndexEntry(record, "fork-rt.json");
  assert.equal(entry.forkedAtMessageIndex, 2);
  assert.equal(entry.forkedAtMessageIndexRequested, 3);

  // …and back out of the index's own parse leg (§9.3 leg 4's other half),
  // through a REAL write + read of index.json rather than a hand-built object.
  // An in-memory assertion would false-pass the leg that actually drops fields.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fork-index-"));
  try {
    await writeSessionIndex(dir, { files: [entry.file], entries: [entry] });
    const onDiskIndex = JSON.parse(await fs.readFile(sessionIndexPath(dir), "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    assert.equal(
      onDiskIndex.entries[0]?.forkedAtMessageIndexRequested,
      3,
      "the field must reach index.json on disk, not just the in-memory entry",
    );
    const reread = await readSessionIndex(dir);
    assert.equal(reread?.entries[0]?.forkedAtMessageIndexRequested, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the requested field is ABSENT when the fork landed where it was asked to", () => {
  // THE POSITIVE CONTROL for the whole design: populated only on a mismatch, so a
  // claude/exact record stays byte-identical to a pre-B0.2 one. Without this,
  // "the requested index is recorded" passes trivially by recording it always —
  // which breaks the byte-identical regression leg for EVERY fork rather than the
  // odd-index ones.
  const record = baseRecord({ forkedFromSessionId: "src-claude", forkedAtMessageIndex: 4 });
  const persisted = serializeSessionRecordForDisk(record);
  const onDisk = toDisk(persisted);
  assert.equal("forked_at_message_index_requested" in onDisk, false);

  const parsed = parseSessionRecord(onDisk);
  assert.ok(parsed);
  assert.equal(parsed.forkedAtMessageIndexRequested, undefined);
  assert.equal(
    toSessionIndexEntry(parsed, "fork-rt.json").forkedAtMessageIndexRequested,
    undefined,
  );
});

test("forked_at_message_index_requested: 0 survives (no falsy-drop) and a bad value is rejected", () => {
  const record = baseRecord({
    forkedFromSessionId: "p",
    forkedAtMessageIndex: 0,
    forkedAtMessageIndexRequested: 0,
  });
  const onDisk = toDisk(serializeSessionRecordForDisk(record));
  assert.ok("forked_at_message_index_requested" in onDisk);
  assert.equal(parseSessionRecord(onDisk)?.forkedAtMessageIndexRequested, 0);

  // The parse leg validates, it does not merely copy: a negative or non-integer
  // value rejects the whole record rather than landing on it.
  assert.equal(parseSessionRecord({ ...onDisk, forked_at_message_index_requested: -1 }), null);
  assert.equal(parseSessionRecord({ ...onDisk, forked_at_message_index_requested: 1.5 }), null);
});
