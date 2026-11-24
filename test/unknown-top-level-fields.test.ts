// A-65 / C3.5 (iv) — a writer of a session record keeps each top-level field it does not know, and the
// `metadata` map whole. Rows 65.1, 65.2 of the committed test plan (brick 5861c3d2), plus the rows the lane
// added: 65.4 (a copy that predates the field), 65.5 (a key a newer release REMOVED stays removed), 65.6
// (fork and import do not carry — the sub-HoD's decision, pinned) and the structural checks that keep
// `KNOWN_TOP_LEVEL_KEYS` exact. The production-shape rows (a real turn, a real close, `set-*`, recover, the
// index) are in unknown-top-level-fields-cli.test.ts.
//
// The loss these rows pin: `serializeSessionRecordForDisk` writes a fixed key list and `parseSessionRecord`
// reads known fields only, so EVERY writer through the pair dropped a key a newer release added (red at
// acpx agent-pods c88fccb1: 65.1 on every writer but the raw-JSON close).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createFileSessionStore } from "../src/runtime/public/file-session-store.js";
import { exportSession } from "../src/session/export.js";
import { importSession } from "../src/session/import.js";
import {
  resolveSessionRecord,
  serializeSessionRecordForDisk,
  writeSessionRecord,
} from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { WRITERS } from "./record-writers-fixture.js";
import { sessionFilePath, withTempHome } from "./runtime-test-helpers.js";
import {
  PLANTED,
  assertPlantedKept,
  newRecord,
  plant,
  readRaw,
  seeded,
  writeRaw,
  type Raw,
} from "./unknown-top-level-fields-fixtures.js";

for (const writer of WRITERS) {
  test(`65.1 · ${writer.name} keeps every unknown top-level key and the unknown metadata key`, async () => {
    await withTempHome("acpx-a65-writers-", async (homeDir) => {
      const record = await seeded(homeDir, "w-rec");
      record.title = "w1";
      await writer.write(record);
      const raw = await readRaw(homeDir, "w-rec");
      assert.ok(writer.landed(raw), `${writer.name}: its own change is on disk`);
      assertPlantedKept(raw, writer.name);
      assert.equal(raw.metadata?.own, "1", "the known metadata key stays beside it");
    });
  });
}

test("65.1 · a writer that REBUILT its record without the parsed original keeps the disk record's keys", async () => {
  await withTempHome("acpx-a65-rebuilt-", async (homeDir) => {
    await seeded(homeDir, "rebuilt");
    // Same id, no carrier: what a writer that builds its record from scratch over an existing file is.
    const fresh = newRecord(homeDir, "rebuilt", { title: "rebuilt-title" });
    await writeSessionRecord(fresh);
    const raw = await readRaw(homeDir, "rebuilt");
    assert.equal(raw.title, "rebuilt-title");
    assertPlantedKept(raw, "rebuilt");
  });
});

test("65.1 · the public file session store (load, then save) keeps them", async () => {
  await withTempHome("acpx-a65-store-", async (homeDir) => {
    await seeded(homeDir, "store-rec");
    const store = createFileSessionStore({ stateDir: path.join(homeDir, ".acpx") });
    const loaded = await store.load("store-rec");
    assert.ok(loaded);
    loaded.title = "via-store";
    await store.save(loaded);
    const raw = await readRaw(homeDir, "store-rec");
    assert.equal(raw.title, "via-store");
    assertPlantedKept(raw, "file session store");
  });
});

test("65.1 · export keeps them in the bundle (the record's state)", async () => {
  await withTempHome("acpx-a65-export-", async (homeDir) => {
    await seeded(homeDir, "export-rec");
    const archive = path.join(homeDir, "out.acpx.json");
    await exportSession({ sessionId: "export-rec" }, archive);
    const state = (JSON.parse(await fs.readFile(archive, "utf8")) as { session: { state: Raw } })
      .session.state;
    assertPlantedKept(state, "export bundle");
  });
});

test("65.2 · a carried key is never a refusal: every spelling is written as read", async () => {
  await withTempHome("acpx-a65-spelling-", async (homeDir) => {
    const record = await seeded(homeDir, "spelling");
    // Every planted key but one is not snake_case (teCamelField, `Odd-Key 1`, `a.b`, ``): the policy would
    // refuse each if it checked carried keys.
    assert.ok(
      Object.keys(PLANTED).filter((key) => !/^[a-z][a-z0-9_]*$/.test(key)).length >= 3,
      "the fixture carries several keys the key policy would refuse",
    );
    record.title = "spelled";
    await writeSessionRecord(record);
    assertPlantedKept(await readRaw(homeDir, "spelling"), "spelling");
  });
});

test("65.2 · a key named `__proto__` is carried as an ordinary key, never as a prototype", async () => {
  await withTempHome("acpx-a65-proto-", async (homeDir) => {
    await writeSessionRecord(newRecord(homeDir, "proto"));
    const text = (await fs.readFile(sessionFilePath(homeDir, "proto"), "utf8")).trimEnd();
    await fs.writeFile(
      sessionFilePath(homeDir, "proto"),
      `${text.slice(0, -1)},"__proto__":{"polluted":true}}\n`,
      "utf8",
    );
    const record = await resolveSessionRecord("proto");
    record.title = "after";
    await writeSessionRecord(record);
    const onDisk = await fs.readFile(sessionFilePath(homeDir, "proto"), "utf8");
    assert.ok(
      onDisk.includes('"__proto__":{"polluted":true}'),
      "the key is on disk, value unchanged",
    );
    assert.equal(
      ({} as Record<string, unknown>).polluted,
      undefined,
      "Object.prototype is untouched",
    );
    assert.equal(Object.getPrototypeOf(JSON.parse(onDisk)), Object.prototype);
  });
});

test("65.4 · a copy loaded BEFORE a newer release added the field still keeps it (disk wins under the lock)", async () => {
  await withTempHome("acpx-a65-stale-", async (homeDir) => {
    await writeSessionRecord(newRecord(homeDir, "stale"));
    // The owner's copy, loaded at the start of a long turn: it carries nothing.
    const copy = await resolveSessionRecord("stale");
    // A newer release writes the field while the turn runs.
    await plant(homeDir, "stale");
    copy.title = "turn-checkpoint";
    await writeSessionRecord(copy);
    const raw = await readRaw(homeDir, "stale");
    assert.equal(raw.title, "turn-checkpoint");
    assertPlantedKept(raw, "stale copy");
  });
});

test("65.5 · a key a newer release REMOVED from disk is not brought back by an older writer's stale carrier", async () => {
  await withTempHome("acpx-a65-removed-", async (homeDir) => {
    const copy = await seeded(homeDir, "removed");
    // The newer release removes the field (and keeps one other it still uses).
    const raw = await readRaw(homeDir, "removed");
    assert.ok(Object.hasOwn(raw, "te_unknown_future_field"), "positive control: it was on disk");
    delete raw.te_unknown_future_field;
    await writeRaw(homeDir, "removed", raw);
    copy.title = "older-writer";
    await writeSessionRecord(copy);
    const after = await readRaw(homeDir, "removed");
    assert.equal(after.title, "older-writer", "the older writer's own change landed");
    assert.ok(!Object.hasOwn(after, "te_unknown_future_field"), "the removed key stays removed");
    assert.equal(after.teCamelField, "camel", "the keys still on disk are kept");
  });
});

test("65.6 · DECISION: a fork does not carry the source's unknown keys (a new session is not the old one)", async () => {
  // The fork's record is built from scratch (`session-management.ts`, the shared create literal): nothing
  // reads the source's carrier. This row pins the property at the only seam a later lane could change: the
  // carrier is never part of what a create copies. The production-shape row (a real `sessions copy`) is in
  // unknown-top-level-fields-cli.test.ts.
  await withTempHome("acpx-a65-fork-", async (homeDir) => {
    await seeded(homeDir, "fork-source");
    assert.ok(
      Object.hasOwn(await readRaw(homeDir, "fork-source"), "te_unknown_future_field"),
      "positive control: the source has them",
    );
    const child = newRecord(homeDir, "fork-child", {
      kind: "session",
      forkedFromSessionId: "fork-source",
    });
    await writeSessionRecord(child);
    const raw = await readRaw(homeDir, "fork-child");
    for (const key of Object.keys(PLANTED)) {
      assert.ok(!Object.hasOwn(raw, key), `fork child must not carry ${JSON.stringify(key)}`);
    }
  });
});

test("65.6 · DECISION: an import does not carry the exported session's unknown keys", async () => {
  await withTempHome("acpx-a65-import-", async (homeDir) => {
    await seeded(homeDir, "import-source");
    const archive = path.join(homeDir, "import.acpx.json");
    await exportSession({ sessionId: "import-source" }, archive);
    const state = (JSON.parse(await fs.readFile(archive, "utf8")) as { session: { state: Raw } })
      .session.state;
    assert.ok(
      Object.hasOwn(state, "te_unknown_future_field"),
      "positive control: the bundle holds the key",
    );
    // The import refuses a provider session id a local record already uses: the source goes first.
    await fs.rm(sessionFilePath(homeDir, "import-source"));
    const imported = await importSession(archive, { recordId: "import-child" });
    assert.equal(imported.record_id, "import-child");
    const raw = await readRaw(homeDir, "import-child");
    for (const key of Object.keys(PLANTED)) {
      assert.ok(
        !Object.hasOwn(raw, key),
        `the imported session must not carry ${JSON.stringify(key)}`,
      );
    }
  });
});

test("65.2 (negative control): the key policy still refuses a key THIS release writes", () => {
  const record = newRecord("/tmp", "policy", {
    acpx: { camelCaseKeyOfOurs: 1 } as unknown as SessionRecord["acpx"],
  });
  assert.throws(() => serializeSessionRecordForDisk(record), /Persisted key policy violation/);
});
