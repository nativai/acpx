import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSessionRecord, serializeSessionRecordForDisk } from "../src/session/persistence.js";
import {
  readSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
  type SessionIndexEntry,
} from "../src/session/persistence/index.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// perf/index-entry-enrichment — the daemon side of Option 2: index.json entries
// now carry the ~15 hot scalars acpx-ui's session-list rebuild needs, so its hot
// path can skip the per-session multi-MB record decode+parse. These tests pin
// (a) the projection, (b) the new `template` round-trip, and (c) the load-bearing
// parseIndexEntry preservation that keeps enrichment on untouched entries when
// the daemon rewrites one entry.

/** Simulate on-disk JSON: undefined keys are dropped. */
function toDisk(persisted: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(persisted)) as Record<string, unknown>;
}

function enrichedRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  // makeSessionRecord only wires a subset of fields, so spread the rest on top
  // (the pattern session-fork-roundtrip.test.ts uses).
  return {
    ...makeSessionRecord(
      {
        acpxRecordId: "enrich-1",
        acpSessionId: "acp-enrich-1",
        agentCommand: "node /opt/codex-acp/dist/index.js",
        cwd: "/workspace/x",
        createdAt: "2026-06-01T00:00:00.000Z",
        lastUsedAt: "2026-06-02T00:00:00.000Z",
        lastPromptAt: "2026-06-02T01:00:00.000Z",
        favorite: true,
        title: "My session",
        eventLog: {
          active_path: "/abs/enrich-1.stream.ndjson",
          segment_count: 1,
          max_segment_bytes: 1024,
          max_segments: 1,
          last_write_at: "2026-06-02T02:00:00.000Z",
          last_write_error: null,
        },
        acpx: {
          current_model_id: "gpt-5.5[high]",
          desired_config_options: { effort: "high" },
          session_options: {
            model: "gpt-5.5[high]",
            subscription: "sub-a",
            profile: "prof-a",
            subscription_switch: {
              from: "sub-z",
              to: "sub-a",
              reason: "failover",
              at: "2026-06-02T00:30:00.000Z",
            },
          },
        },
      },
      { resolveCwd: false },
    ),
    parentSessionId: "parent-1",
    forkedFromSessionId: "src-1",
    forkedAtMessageIndex: 7,
    metadata: { task_folder: "/wisdom/x", byway: "1", byway_parent: "src-1", byway_at: "7" },
    template: {
      enabled: true,
      created_at: "2026-06-01T05:00:00.000Z",
      source_session_id: "tpl-src",
    },
    ...overrides,
  };
}

test("toSessionIndexEntry projects every hot scalar from the record", () => {
  const entry = toSessionIndexEntry(enrichedRecord(), "enrich-1.json");
  assert.equal(entry.lastWriteAt, "2026-06-02T02:00:00.000Z");
  assert.equal(entry.activePath, "/abs/enrich-1.stream.ndjson");
  assert.equal(entry.lastPromptAt, "2026-06-02T01:00:00.000Z");
  assert.equal(entry.favorite, true);
  assert.equal(entry.title, "My session");
  assert.equal(entry.createdAt, "2026-06-01T00:00:00.000Z");
  assert.equal(entry.parentSessionId, "parent-1");
  assert.equal(entry.forkedFromSessionId, "src-1");
  assert.equal(entry.forkedAtMessageIndex, 7);
  assert.equal(entry.metadataTaskFolder, "/wisdom/x");
  assert.equal(entry.byway, true);
  assert.equal(entry.currentModelId, "gpt-5.5[high]");
  assert.equal(entry.sessionModel, "gpt-5.5[high]");
  assert.equal(entry.desiredEffort, "high");
  assert.equal(entry.subscription, "sub-a");
  assert.equal(entry.profile, "prof-a");
  assert.deepEqual(entry.subscriptionSwitch, {
    from: "sub-z",
    to: "sub-a",
    reason: "failover",
    at: "2026-06-02T00:30:00.000Z",
  });
  assert.equal(entry.templateEnabled, true);
  assert.equal(entry.templateCreatedAt, "2026-06-01T05:00:00.000Z");
});

test("toSessionIndexEntry omits absent optionals (no byway flag, no acpx block)", () => {
  const record = makeSessionRecord(
    {
      acpxRecordId: "plain",
      acpSessionId: "acp-plain",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: "/workspace/y",
    },
    { resolveCwd: false, defaultAcpx: false },
  );
  const entry = toSessionIndexEntry(record, "plain.json");
  // undefined-valued fields drop out of the JSON written to disk.
  const onDisk = toDisk(entry as unknown as Record<string, unknown>);
  assert.equal("byway" in onDisk, false);
  assert.equal("subscription" in onDisk, false);
  assert.equal("templateEnabled" in onDisk, false);
  assert.equal("forkedFromSessionId" in onDisk, false);
  // required fields always present
  assert.equal(onDisk.acpxRecordId, "plain");
});

test("template block round-trips serialize → disk → parse (daemon no longer drops it)", () => {
  const record = enrichedRecord();
  const persisted = serializeSessionRecordForDisk(record);
  assert.deepEqual(persisted.template, {
    enabled: true,
    created_at: "2026-06-01T05:00:00.000Z",
    source_session_id: "tpl-src",
  });
  const reparsed = parseSessionRecord(toDisk(persisted));
  assert.ok(reparsed);
  assert.deepEqual(reparsed.template, {
    enabled: true,
    created_at: "2026-06-01T05:00:00.000Z",
    source_session_id: "tpl-src",
  });
});

test("parseSessionRecord drops a malformed template block without rejecting the record", () => {
  const persisted = serializeSessionRecordForDisk(enrichedRecord());
  persisted.template = "not-an-object";
  const reparsed = parseSessionRecord(toDisk(persisted));
  assert.ok(reparsed, "record still parses");
  assert.equal(reparsed.template, undefined);
});

test("parseIndexEntry preserves enrichment across a write→read round-trip (untouched-entry path)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-index-enrich-"));
  try {
    const entry = toSessionIndexEntry(enrichedRecord(), "enrich-1.json");
    await writeSessionIndex(dir, { files: ["enrich-1.json"], entries: [entry] });
    const reloaded = await readSessionIndex(dir);
    assert.ok(reloaded);
    assert.equal(reloaded.entries.length, 1);
    const back = reloaded.entries[0];
    // Every enriched field survives the read — else a daemon write that rebuilds
    // ONE entry would strip enrichment off all the others (it writes them back
    // exactly as parsed here).
    assert.equal(back.currentModelId, "gpt-5.5[high]");
    assert.equal(back.subscription, "sub-a");
    assert.equal(back.profile, "prof-a");
    assert.equal(back.desiredEffort, "high");
    assert.equal(back.byway, true);
    assert.equal(back.metadataTaskFolder, "/wisdom/x");
    assert.equal(back.templateEnabled, true);
    assert.equal(back.templateCreatedAt, "2026-06-01T05:00:00.000Z");
    assert.equal(back.forkedFromSessionId, "src-1");
    assert.equal(back.forkedAtMessageIndex, 7);
    assert.deepEqual(back.subscriptionSwitch, {
      from: "sub-z",
      to: "sub-a",
      reason: "failover",
      at: "2026-06-02T00:30:00.000Z",
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("parseIndexEntry is lenient: a wrong-typed optional is dropped, entry still parses", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-index-lenient-"));
  try {
    const entry = toSessionIndexEntry(enrichedRecord(), "enrich-1.json") as unknown as Record<
      string,
      unknown
    >;
    entry.favorite = "yes"; // wrong type
    entry.forkedAtMessageIndex = "seven"; // wrong type
    await writeSessionIndex(dir, {
      files: ["enrich-1.json"],
      entries: [entry as unknown as SessionIndexEntry],
    });
    const reloaded = await readSessionIndex(dir);
    assert.ok(reloaded, "index still parses despite bad optional fields");
    const back = reloaded.entries[0];
    assert.equal(back.favorite, undefined);
    assert.equal(back.forkedAtMessageIndex, undefined);
    // a good neighbour optional still comes through
    assert.equal(back.currentModelId, "gpt-5.5[high]");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
