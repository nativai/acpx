// A-65 correction (C3.5 (iv) "`metadata` keys", brick 1948e346; rows 65.4 and 65.5 of the committed test plan).
//
// 65.4 — a writer never refuses for a `metadata` key it carries unchanged, whatever its spelling. Red at acpx
//        agent-pods 33fc6460: the persisted-key policy walked the whole record, `metadata` included, so one
//        carried `teMetaCamel` made EVERY writer throw `Persisted key policy violation`.
//
// This file holds the rows that compile and run on the tree before the fix. Row 65.5 (acpx, as a producer,
// refuses a `metadata` key it would write itself that is not `^[a-z][a-z0-9_]*$`) is in
// metadata-key-rule-input.test.ts, and the real-CLI rows of both are in metadata-key-rule-cli.test.ts. The
// two halves land in ONE change: an acpx that exempted carried keys and did not check its own would write
// keys every older release refuses.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertPersistedKeyPolicy,
  findPersistedKeyPolicyViolations,
} from "../src/persisted-key-policy.js";
import { createFileSessionStore } from "../src/runtime/public/file-session-store.js";
import { exportSession } from "../src/session/export.js";
import {
  resolveSessionRecord,
  serializeSessionRecordForDisk,
  writeSessionRecord,
} from "../src/session/persistence.js";
import { WRITERS } from "./record-writers-fixture.js";
import { withTempHome } from "./runtime-test-helpers.js";
import { newRecord, readRaw, writeRaw, type Raw } from "./unknown-top-level-fields-fixtures.js";

/** What the A-65 TE planted (probe run 1): a camelCase key and a non-ASCII one, beside a snake_case one. */
const CARRIED: Readonly<Record<string, string>> = {
  teMetaCamel: "camel-value",
  te_meta_ünï: "unicode-value",
  "te-meta": "dash-value",
  "Te Meta 1": "spaces-value",
  // The empty key: `parseMetadata` used to reject the WHOLE record for it, so the session read as missing
  // (the A-65 correction TE's F-1). Carried like any other rule-breaking key.
  "": "empty-key-value",
  te_meta_snake: "snake-value",
};

async function plantMetadata(homeDir: string, id: string): Promise<void> {
  const raw = await readRaw(homeDir, id);
  raw.metadata = { ...raw.metadata, ...CARRIED };
  await writeRaw(homeDir, id, raw);
}

function assertCarried(raw: Raw, label: string): void {
  for (const [key, value] of Object.entries(CARRIED)) {
    assert.equal(raw.metadata?.[key], value, `${label}: metadata ${JSON.stringify(key)} changed`);
  }
}

async function seededWithMetadata(homeDir: string, id: string) {
  await writeSessionRecord(newRecord(homeDir, id, { metadata: { own: "1" } }));
  await plantMetadata(homeDir, id);
  return await resolveSessionRecord(id);
}

// ---------------------------------------------------------------------------------------------
// 65.4 — a carried key never refuses a write
// ---------------------------------------------------------------------------------------------

for (const writer of WRITERS) {
  test(`65.4 · ${writer.name} carries every non-snake_case metadata key unchanged`, async () => {
    await withTempHome("acpx-a65m-writers-", async (homeDir) => {
      const record = await seededWithMetadata(homeDir, "m-rec");
      assert.equal(record.metadata?.teMetaCamel, "camel-value", "control: the parser read it");
      record.title = "w1";
      await writer.write(record);
      const raw = await readRaw(homeDir, "m-rec");
      assert.ok(writer.landed(raw), `${writer.name}: its own change is on disk`);
      assertCarried(raw, writer.name);
      assert.equal(raw.metadata?.own, "1", "the known key stays beside them");
    });
  });
}

test("65.4 · the public file session store (load, then save) carries them", async () => {
  await withTempHome("acpx-a65m-store-", async (homeDir) => {
    await seededWithMetadata(homeDir, "store-rec");
    const store = createFileSessionStore({ stateDir: path.join(homeDir, ".acpx") });
    const loaded = await store.load("store-rec");
    assert.ok(loaded);
    loaded.title = "via-store";
    await store.save(loaded);
    const raw = await readRaw(homeDir, "store-rec");
    assert.equal(raw.title, "via-store");
    assertCarried(raw, "file session store");
  });
});

test("65.4 · export carries them into the bundle", async () => {
  await withTempHome("acpx-a65m-export-", async (homeDir) => {
    await seededWithMetadata(homeDir, "export-rec");
    const archive = path.join(homeDir, "out.acpx.json");
    await exportSession({ sessionId: "export-rec" }, archive);
    const state = (JSON.parse(await fs.readFile(archive, "utf8")) as { session: { state: Raw } })
      .session.state;
    assertCarried(state, "export bundle");
  });
});

test("65.4 · a carried key is neither refused nor renamed: the serialized bytes hold the key as read", async () => {
  await withTempHome("acpx-a65m-bytes-", async (homeDir) => {
    const record = await seededWithMetadata(homeDir, "bytes-rec");
    const serialized = serializeSessionRecordForDisk(record);
    assert.deepEqual(
      Object.keys(serialized.metadata as Record<string, string>).toSorted(),
      ["own", ...Object.keys(CARRIED)].toSorted(),
      "no key dropped, none renamed (to snake_case or otherwise)",
    );
  });
});

// The exemption is `metadata` and nothing else: the key policy still judges every other key acpx writes. A
// carried-key exemption that went wider than `metadata` would pass the two rows above and fail this one.
test("65.4 · negative: the exemption is `metadata` alone — a non-snake_case key elsewhere is still refused", async () => {
  await withTempHome("acpx-a65m-scope-", async (homeDir) => {
    const record = newRecord(homeDir, "scope-rec", { metadata: { teMetaCamel: "x" } });
    assert.doesNotThrow(() => serializeSessionRecordForDisk(record), "control: metadata alone");
    for (const damaged of [
      { ...record, acpx: { ...record.acpx, teCamel: 1 } },
      { ...record, messages: [{ User: { id: "u", content: [], teCamel: 1 } }] },
      { ...record, template: { ...record.template, teCamel: 1 } },
    ] as unknown as Array<typeof record>) {
      assert.throws(
        () => serializeSessionRecordForDisk(damaged),
        /Persisted key policy violation.*teCamel/,
      );
    }
    // The raw policy function is unchanged: it still names a camelCase key wherever it is handed one, so the
    // exemption lives in what the serializer hands it, never in a weaker policy for other callers.
    assert.deepEqual(findPersistedKeyPolicyViolations({ metadata: { teMetaCamel: "x" } }), [
      "metadata.teMetaCamel",
    ]);
    assert.throws(() => assertPersistedKeyPolicy({ acpx: { teCamel: 1 } }), /snake_case/);
  });
});
