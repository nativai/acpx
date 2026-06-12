import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serializeSessionRecordForDisk } from "../src/session/persistence.js";
import {
  loadOrRebuildSessionIndex,
  readSessionIndex,
  reconcileSessionIndex,
  toSessionIndexEntry,
  writeSessionIndex,
} from "../src/session/persistence/index.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// perf-loadfix W2.1 — loadOrRebuildSessionIndex must reconcile file-list drift
// incrementally (read only missing records, drop vanished rows) instead of
// re-parsing the whole store. The full rebuild is reserved for a missing or
// unparseable index.json.

async function withSessionDir<T>(run: (sessionDir: string) => Promise<T>): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-index-reconcile-"));
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function record(id: string, lastUsedAt = "2026-06-01T00:00:00.000Z"): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand: "agent",
    cwd: "/tmp/reconcile",
    lastUsedAt,
  });
}

async function writeRecordFile(sessionDir: string, sessionRecord: SessionRecord): Promise<string> {
  const fileName = `${encodeURIComponent(sessionRecord.acpxRecordId)}.json`;
  await fs.writeFile(
    path.join(sessionDir, fileName),
    `${JSON.stringify(serializeSessionRecordForDisk(sessionRecord))}\n`,
    "utf8",
  );
  return fileName;
}

test("unchanged file list returns the existing index without rewriting it", async () => {
  await withSessionDir(async (sessionDir) => {
    const a = record("rec-a");
    const fileA = await writeRecordFile(sessionDir, a);
    await writeSessionIndex(sessionDir, {
      files: [fileA],
      entries: [toSessionIndexEntry(a, fileA)],
    });
    const statBefore = await fs.stat(path.join(sessionDir, "index.json"));

    const { index, drift } = await reconcileSessionIndex(sessionDir);

    assert.equal(drift, false);
    assert.deepEqual(index.files, [fileA]);
    const statAfter = await fs.stat(path.join(sessionDir, "index.json"));
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs);
  });
});

test("a new record file is reconciled in without a full rebuild", async () => {
  await withSessionDir(async (sessionDir) => {
    const a = record("rec-a");
    const fileA = await writeRecordFile(sessionDir, a);
    // Entry for a deliberately carries a marker name the on-disk record does
    // NOT have — a full rebuild would lose it, incremental reconcile keeps it.
    const markedEntryA = { ...toSessionIndexEntry(a, fileA), name: "marker-not-on-disk" };
    await writeSessionIndex(sessionDir, { files: [fileA], entries: [markedEntryA] });

    const b = record("rec-b");
    const fileB = await writeRecordFile(sessionDir, b);

    const { index, drift } = await reconcileSessionIndex(sessionDir);

    assert.equal(drift, true);
    assert.deepEqual(index.files, [fileA, fileB].toSorted());
    const entryA = index.entries.find((entry) => entry.file === fileA);
    const entryB = index.entries.find((entry) => entry.file === fileB);
    assert.equal(entryA?.name, "marker-not-on-disk", "existing entry must not be re-read");
    assert.equal(entryB?.acpxRecordId, "rec-b");
  });
});

test("a vanished record file drops its entry without any read", async () => {
  await withSessionDir(async (sessionDir) => {
    const a = record("rec-a");
    const b = record("rec-b");
    const fileA = await writeRecordFile(sessionDir, a);
    const fileB = await writeRecordFile(sessionDir, b);
    await writeSessionIndex(sessionDir, {
      files: [fileA, fileB],
      entries: [toSessionIndexEntry(a, fileA), toSessionIndexEntry(b, fileB)],
    });

    await fs.unlink(path.join(sessionDir, fileB));
    const { index, drift } = await reconcileSessionIndex(sessionDir);

    assert.equal(drift, true);
    assert.deepEqual(index.files, [fileA]);
    assert.deepEqual(
      index.entries.map((entry) => entry.file),
      [fileA],
    );
  });
});

test("a corrupt new record keeps its file-list row but gets no entry (rebuild parity)", async () => {
  await withSessionDir(async (sessionDir) => {
    const a = record("rec-a");
    const fileA = await writeRecordFile(sessionDir, a);
    await writeSessionIndex(sessionDir, {
      files: [fileA],
      entries: [toSessionIndexEntry(a, fileA)],
    });

    await fs.writeFile(path.join(sessionDir, "rec-corrupt.json"), "{ not json", "utf8");
    const { index } = await reconcileSessionIndex(sessionDir);

    assert.deepEqual(index.files, [fileA, "rec-corrupt.json"].toSorted());
    assert.deepEqual(
      index.entries.map((entry) => entry.file),
      [fileA],
    );
  });
});

test("providedEntries are used for new files instead of re-reading the record", async () => {
  await withSessionDir(async (sessionDir) => {
    await writeSessionIndex(sessionDir, { files: [], entries: [] });
    const a = record("rec-a");
    const fileA = await writeRecordFile(sessionDir, a);
    const provided = { ...toSessionIndexEntry(a, fileA), name: "provided-entry-wins" };

    const { index } = await reconcileSessionIndex(sessionDir, new Map([[fileA, provided]]));

    assert.equal(index.entries.find((entry) => entry.file === fileA)?.name, "provided-entry-wins");
  });
});

test("missing index.json triggers exactly one full rebuild, then the fast path", async () => {
  await withSessionDir(async (sessionDir) => {
    const a = record("rec-a");
    const fileA = await writeRecordFile(sessionDir, a);

    const rebuilt = await loadOrRebuildSessionIndex(sessionDir);
    assert.deepEqual(rebuilt.files, [fileA]);
    assert.equal(rebuilt.entries[0]?.acpxRecordId, "rec-a");
    // Rebuild persisted the index — the next load takes the unchanged fast path.
    const statBefore = await fs.stat(path.join(sessionDir, "index.json"));
    const again = await reconcileSessionIndex(sessionDir);
    assert.equal(again.drift, false);
    const statAfter = await fs.stat(path.join(sessionDir, "index.json"));
    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs);
  });
});

test("unparseable index.json triggers a full rebuild", async () => {
  await withSessionDir(async (sessionDir) => {
    const a = record("rec-a");
    const fileA = await writeRecordFile(sessionDir, a);
    await fs.writeFile(path.join(sessionDir, "index.json"), "definitely { not json", "utf8");

    const { index, drift } = await reconcileSessionIndex(sessionDir);

    assert.equal(drift, true);
    assert.deepEqual(index.files, [fileA]);
    const persisted = await readSessionIndex(sessionDir);
    assert.deepEqual(persisted?.files, [fileA]);
  });
});
