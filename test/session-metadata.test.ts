import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeSessionMetadata,
  validateSessionMetadataValue,
} from "../src/cli/session/session-metadata.js";
import type { SessionRecord } from "../src/types.js";

function recordWith(metadata?: Record<string, string>): SessionRecord {
  return { acpxRecordId: "rec-1", acpSessionId: "rec-1", metadata } as unknown as SessionRecord;
}

// --- validateSessionMetadataValue ---

test("validateSessionMetadataValue trims and returns a generic value", () => {
  assert.equal(validateSessionMetadataValue("anything", "  hello  "), "hello");
});

test("validateSessionMetadataValue rejects empty / whitespace-only values", () => {
  assert.throws(() => validateSessionMetadataValue("k", ""), /must not be empty/);
  assert.throws(() => validateSessionMetadataValue("task_folder", "   "), /must not be empty/);
});

test("validateSessionMetadataValue requires task_folder to be an absolute path", () => {
  assert.throws(() => validateSessionMetadataValue("task_folder", "relative/path"), /absolute/);
  assert.equal(validateSessionMetadataValue("task_folder", "  /abs/task  "), "/abs/task");
});

test("validateSessionMetadataValue does not enforce absoluteness for other keys", () => {
  assert.equal(validateSessionMetadataValue("note", "relative/is/fine"), "relative/is/fine");
});

// --- mergeSessionMetadata ---

test("mergeSessionMetadata adds the key when the record has no metadata", () => {
  const out = mergeSessionMetadata(recordWith(undefined), "task_folder", "/abs");
  assert.deepEqual(out.metadata, { task_folder: "/abs" });
});

test("mergeSessionMetadata overwrites in place and preserves other keys", () => {
  const out = mergeSessionMetadata(
    recordWith({ task_folder: "/old", keep: "1" }),
    "task_folder",
    "/new",
  );
  assert.deepEqual(out.metadata, { task_folder: "/new", keep: "1" });
});

test("mergeSessionMetadata returns a new record and does not mutate the input", () => {
  const rec = recordWith({ a: "1" });
  const out = mergeSessionMetadata(rec, "b", "2");
  assert.notEqual(out, rec);
  assert.deepEqual(rec.metadata, { a: "1" });
  assert.deepEqual(out.metadata, { a: "1", b: "2" });
});
