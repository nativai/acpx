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
  type SessionIndexEntry,
} from "../src/session/persistence/index.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// Slice 4 (brick 514c0a29): atrium's session list row and chat header read ONLY the
// index entry, so the record's `started_by_*` metadata must be projected onto it as
// `startedBy`, verbatim, on BOTH index legs. No compiler check covers index fields
// (full-record-contract.ts scope note), so these tests are the guard.

// Deliberately NOT alphabetical: the projection must keep the record's key order.
const STARTED_BY: Record<string, string> = {
  started_by_name: "Ada Lovelace",
  started_by_kind: "human",
  started_by_channel: "atrium",
  started_by_verified: "true",
  started_by_subject: "sub|1234",
  started_by_issuer: "https://issuer.example/",
  started_by_box: "devbox",
  started_by_session_id: "5727c06f",
  started_by_seat_id: "282911ca",
};

function startedByRecord(
  id: string,
  metadata: Record<string, string> | undefined,
  lastUsedAt = "2026-06-01T00:00:00.000Z",
): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand: "agent",
    cwd: "/tmp/started-by",
    lastUsedAt,
    metadata,
  });
}

async function withSessionDir<T>(run: (sessionDir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-index-started-by-"));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeRecordFile(sessionDir: string, record: SessionRecord): Promise<string> {
  const fileName = `${encodeURIComponent(record.acpxRecordId)}.json`;
  await fs.writeFile(
    path.join(sessionDir, fileName),
    `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
    "utf8",
  );
  return fileName;
}

test("toSessionIndexEntry projects exactly the started_by_* metadata, verbatim, in key order", () => {
  const entry = toSessionIndexEntry(
    startedByRecord("sb-1", {
      brick: "11111111-2222-3333-4444-555555555555",
      ...STARTED_BY,
      infra: "1",
    }),
    "sb-1.json",
  );
  assert.deepEqual(entry.startedBy, STARTED_BY);
  assert.deepEqual(Object.keys(entry.startedBy ?? {}), Object.keys(STARTED_BY));
});

test("a record without started_by_* metadata gets no startedBy, and other metadata never leaks in", () => {
  const without = toSessionIndexEntry(startedByRecord("sb-2", undefined), "sb-2.json");
  assert.equal(Object.prototype.hasOwnProperty.call(without, "startedBy"), true);
  assert.equal(without.startedBy, undefined);
  assert.equal(JSON.stringify(without).includes("startedBy"), false);

  const unrelated = toSessionIndexEntry(
    startedByRecord("sb-3", {
      brick: "b",
      infra: "1",
      // near-misses: wrong prefix, wrong case, prefix not at the start
      startedby_name: "x",
      Started_By_name: "x",
      not_started_by_name: "x",
      started_by: "x",
    }),
    "sb-3.json",
  );
  assert.equal(unrelated.startedBy, undefined);
  assert.equal(JSON.stringify(unrelated).includes("startedBy"), false);

  const mixed = toSessionIndexEntry(
    startedByRecord("sb-4", { brick: "b", started_by_name: "Ada", infra: "1" }),
    "sb-4.json",
  );
  assert.deepEqual(mixed.startedBy, { started_by_name: "Ada" });
});

test("startedBy round-trips index.json write → parseIndexEntry → rewrite byte-identically", async () => {
  await withSessionDir(async (sessionDir) => {
    const entry = toSessionIndexEntry(startedByRecord("sb-5", STARTED_BY), "sb-5.json");
    await writeSessionIndex(sessionDir, { files: ["sb-5.json"], entries: [entry] });
    const firstBytes = await fs.readFile(path.join(sessionDir, "index.json"), "utf8");
    assert.ok(firstBytes.includes('"startedBy"'), "startedBy reached index.json");

    const parsed = await readSessionIndex(sessionDir);
    assert.ok(parsed);
    assert.deepEqual(parsed.entries[0]?.startedBy, STARTED_BY);

    await writeSessionIndex(sessionDir, { files: parsed.files, entries: parsed.entries });
    const secondBytes = await fs.readFile(path.join(sessionDir, "index.json"), "utf8");
    assert.equal(secondBytes, firstBytes);
  });
});

test("parseIndexEntry drops non-string startedBy values and an empty or non-object startedBy", async () => {
  await withSessionDir(async (sessionDir) => {
    const good = toSessionIndexEntry(startedByRecord("sb-6", STARTED_BY), "sb-6.json");
    const dirty = {
      ...good,
      file: "sb-7.json",
      acpxRecordId: "sb-7",
      startedBy: { started_by_name: "Ada", started_by_verified: true, started_by_n: 7 },
    } as unknown as SessionIndexEntry;
    const allBad = {
      ...good,
      file: "sb-8.json",
      acpxRecordId: "sb-8",
      startedBy: { started_by_verified: true },
    } as unknown as SessionIndexEntry;
    const notObject = {
      ...good,
      file: "sb-9.json",
      acpxRecordId: "sb-9",
      startedBy: "Ada",
    } as unknown as SessionIndexEntry;
    const foreignKey = {
      ...good,
      file: "sb-10.json",
      acpxRecordId: "sb-10",
      startedBy: { started_by_name: "Ada", other: "x" },
    } as unknown as SessionIndexEntry;
    await writeSessionIndex(sessionDir, {
      files: ["sb-6.json", "sb-7.json", "sb-8.json", "sb-9.json", "sb-10.json"],
      entries: [good, dirty, allBad, notObject, foreignKey],
    });
    const parsed = await readSessionIndex(sessionDir);
    assert.ok(parsed, "index still parses");
    const byFile = new Map(parsed.entries.map((entry) => [entry.file, entry]));
    assert.deepEqual(byFile.get("sb-6.json")?.startedBy, STARTED_BY);
    assert.deepEqual(byFile.get("sb-7.json")?.startedBy, { started_by_name: "Ada" });
    assert.equal(byFile.get("sb-8.json")?.startedBy, undefined);
    assert.equal(byFile.get("sb-9.json")?.startedBy, undefined);
    assert.deepEqual(byFile.get("sb-10.json")?.startedBy, { started_by_name: "Ada" });
  });
});

test("an untouched entry keeps startedBy through an incremental reconcile rewrite", async () => {
  await withSessionDir(async (sessionDir) => {
    const a = startedByRecord("sb-a", STARTED_BY);
    const fileA = await writeRecordFile(sessionDir, a);
    // The entry carries a marker the on-disk record lacks: incremental reconcile
    // writes it back as parsed, so the marker AND startedBy survive only through
    // parseIndexEntry.
    const markedA = { ...toSessionIndexEntry(a, fileA), agentName: "marker-not-on-disk" };
    await writeSessionIndex(sessionDir, { files: [fileA], entries: [markedA] });

    const b = startedByRecord("sb-b", undefined, "2026-06-02T00:00:00.000Z");
    const fileB = await writeRecordFile(sessionDir, b);

    const { index, drift } = await reconcileSessionIndex(sessionDir);
    assert.equal(drift, true);
    await writeSessionIndex(sessionDir, index);

    const reread = await readSessionIndex(sessionDir);
    assert.ok(reread);
    const entryA = reread.entries.find((entry) => entry.file === fileA);
    const entryB = reread.entries.find((entry) => entry.file === fileB);
    assert.equal(entryA?.agentName, "marker-not-on-disk");
    assert.deepEqual(entryA?.startedBy, STARTED_BY);
    assert.equal(entryB?.startedBy, undefined);
  });
});

test("a full index rebuild projects startedBy from the record on disk", async () => {
  await withSessionDir(async (sessionDir) => {
    const withIdentity = startedByRecord("sb-r1", STARTED_BY);
    const without = startedByRecord("sb-r2", { brick: "b" }, "2026-06-02T00:00:00.000Z");
    const fileWith = await writeRecordFile(sessionDir, withIdentity);
    const fileWithout = await writeRecordFile(sessionDir, without);

    const index = await loadOrRebuildSessionIndex(sessionDir);
    assert.deepEqual(index.entries.find((entry) => entry.file === fileWith)?.startedBy, STARTED_BY);
    assert.equal(index.entries.find((entry) => entry.file === fileWithout)?.startedBy, undefined);
  });
});
