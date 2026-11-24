// A-65 / C3.5 (iv) — the carrier and the known-key list: what only exists with the fix. The behavioural rows
// (the writers, the stale copy, the removed key, the fork and import decisions) are in
// unknown-top-level-fields.test.ts and run unchanged on the tree before the fix.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  flushPendingSessionIndexUpdates,
  parseSessionRecord,
  readPersistedLifecycle,
  serializeSessionRecordForDisk,
  writeSessionRecord,
} from "../src/session/persistence.js";
import { toSessionIndexEntry } from "../src/session/persistence/index.js";
import { KNOWN_TOP_LEVEL_KEYS } from "../src/session/persistence/parse.js";
import { UNKNOWN_TOP_LEVEL_FIELDS } from "../src/types.js";
import { withTempHome } from "./runtime-test-helpers.js";
import { PLANTED, newRecord, readRaw, seeded } from "./unknown-top-level-fields-fixtures.js";

test("65.2 · a carried camelCase key beside a clean record is not refused by the key policy", () => {
  const clean = newRecord("/tmp", "policy-ok");
  clean[UNKNOWN_TOP_LEVEL_FIELDS] = { teCamelField: "x" };
  assert.equal(serializeSessionRecordForDisk(clean).teCamelField, "x");
});

test("65.4 (control): a record on a file that does not exist yet is written with the keys its own carrier holds", async () => {
  await withTempHome("acpx-a65-newfile-", async (homeDir) => {
    const record = newRecord(homeDir, "newfile");
    record[UNKNOWN_TOP_LEVEL_FIELDS] = { te_unknown_future_field: { a: 1 } };
    await writeSessionRecord(record);
    assert.deepEqual((await readRaw(homeDir, "newfile")).te_unknown_future_field, { a: 1 });
  });
});

test("the carrier stays out of JSON output, own-key listings and the index entry (a leak is a camelCase surface)", async () => {
  await withTempHome("acpx-a65-leak-", async (homeDir) => {
    const record = await seeded(homeDir, "leak");
    assert.ok(record[UNKNOWN_TOP_LEVEL_FIELDS], "positive control: the carrier is set");
    const json = JSON.stringify(record);
    for (const key of ["te_unknown_future_field", "teCamelField", "Odd-Key 1"]) {
      assert.ok(!json.includes(key), `\`sessions show --format json\` leaks ${key}`);
    }
    assert.ok(!Object.keys(record).some((key) => key.includes("unknown")));
    const entry = JSON.stringify(toSessionIndexEntry(record, "leak.json"));
    assert.ok(!entry.includes("te_unknown_future_field") && !entry.includes("teCamelField"));
    // The index file the write produced.
    record.title = "indexed";
    await writeSessionRecord(record);
    await flushPendingSessionIndexUpdates();
    const index = await fs.readFile(path.join(homeDir, ".acpx", "sessions", "index.json"), "utf8");
    assert.ok(index.includes('"leak"') || index.includes("leak.json"), "positive control: indexed");
    assert.ok(!index.includes("te_unknown_future_field") && !index.includes("teCamelField"));
  });
});

test("an object spread of a parsed record keeps the carrier (most rebuilds of a record in this code use one)", async () => {
  await withTempHome("acpx-a65-spread-", async (homeDir) => {
    const record = await seeded(homeDir, "spread");
    const persisted = serializeSessionRecordForDisk({ ...record, title: "spread" });
    assert.equal(persisted.title, "spread");
    assert.deepEqual(persisted.te_unknown_future_field, PLANTED.te_unknown_future_field);
  });
});

test("a carried key never overrides a key the serializer writes, so a cleared field cannot come back", () => {
  const record = newRecord("/tmp", "known-wins", { title: "own-title" });
  record[UNKNOWN_TOP_LEVEL_FIELDS] = {
    title: "stale-title",
    closed_at: "stale",
    messages_log: { v: 1 },
    te_kept: 1,
  };
  const persisted = serializeSessionRecordForDisk(record);
  assert.equal(persisted.title, "own-title");
  assert.equal(persisted.closed_at, undefined, "cleared stays cleared");
  assert.ok(
    !Object.hasOwn(persisted, "messages_log"),
    "a key the serializer owns is never carried",
  );
  assert.equal(persisted.te_kept, 1);
});

test("readPersistedLifecycle reports the disk record's unknown keys (the source of the locked write's)", async () => {
  await withTempHome("acpx-a65-lifecycle-", async (homeDir) => {
    await seeded(homeDir, "lifecycle");
    const lifecycle = await readPersistedLifecycle("lifecycle");
    assert.deepEqual(
      Object.keys(lifecycle?.unknownTopLevelFields ?? {}).toSorted(),
      Object.keys(PLANTED).toSorted(),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// KNOWN_TOP_LEVEL_KEYS is exact — checked against the code, not against a second list
// ---------------------------------------------------------------------------------------------

function fullOnDiskRecord(): Record<string, unknown> {
  const record = newRecord("/tmp", "structural", {
    seatId: "s",
    holderOrdinal: 1,
    holderActive: true,
    parentSeatId: "p",
    importedFrom: {
      recordId: "r",
      cwdOriginal: "/c",
      exportedBy: "e",
      exportedAt: "2026-01-01T00:00:00.000Z",
    },
    title: "t",
  });
  record.messagesLog = { v: 1, count: 1, base_index: 0, bytes: 10 };
  return JSON.parse(
    JSON.stringify(serializeSessionRecordForDisk(record, { messages: "split-tail" })),
  ) as Record<string, unknown>;
}

test("every top-level key the serializer emits is in KNOWN_TOP_LEVEL_KEYS, and nothing else is", () => {
  // `JSON.stringify` drops undefined values; the serializer's object has them as keys, so read them off it.
  const record = newRecord("/tmp", "structural");
  record.messagesLog = { v: 1, count: 1, base_index: 0, bytes: 10 };
  const emitted = new Set(
    Object.keys(serializeSessionRecordForDisk(record, { messages: "split-tail" })),
  );
  assert.deepEqual(
    [...emitted].filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key)),
    [],
    "an emitted key is unlisted",
  );
  assert.deepEqual(
    [...KNOWN_TOP_LEVEL_KEYS].filter((key) => !emitted.has(key)),
    [],
    "a listed key the serializer never writes is dropped on a rewrite",
  );
});

test("every top-level key parseSessionRecord READS is in KNOWN_TOP_LEVEL_KEYS, and every listed key is read", () => {
  const reads = new Set<string>();
  const proxy = new Proxy(fullOnDiskRecord(), {
    get(target, key, receiver) {
      if (typeof key === "string") {
        reads.add(key);
      }
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === "string") {
        reads.add(key);
      }
      return Reflect.has(target, key);
    },
  });
  assert.ok(parseSessionRecord(proxy), "the full record parses");
  assert.deepEqual(
    [...reads].filter((key) => !KNOWN_TOP_LEVEL_KEYS.has(key)),
    [],
    "a read key is unlisted",
  );
  assert.deepEqual(
    [...KNOWN_TOP_LEVEL_KEYS].filter((key) => !reads.has(key)),
    [],
    "a listed key nothing reads is not carried and not kept",
  );
});

test("a NEW top-level key is unknown: it is carried by parse and nothing but the planted key differs", () => {
  const onDisk = { ...fullOnDiskRecord(), te_new_key: { v: [1] } };
  const parsed = parseSessionRecord(onDisk);
  assert.deepEqual(parsed?.[UNKNOWN_TOP_LEVEL_FIELDS], { te_new_key: { v: [1] } });
  const without = parseSessionRecord(fullOnDiskRecord());
  assert.equal(without?.[UNKNOWN_TOP_LEVEL_FIELDS], undefined, "no unknown key, no carrier");
});

test("65.5 (control): the parsed copy DOES carry the key a newer release later removes", async () => {
  await withTempHome("acpx-a65-removed-control-", async (homeDir) => {
    const copy = await seeded(homeDir, "removed-control");
    assert.ok(Object.hasOwn(copy[UNKNOWN_TOP_LEVEL_FIELDS] ?? {}, "te_unknown_future_field"));
  });
});
