// A-65 correction (C3.5 (iv) "`metadata` keys", brick 1948e346; rows 65.4 and 65.5 of the committed test plan).
//
// 65.4 — a writer never refuses for a `metadata` key it carries unchanged, whatever its spelling. Red at acpx
//        agent-pods 33fc6460: the persisted-key policy walked the whole record, `metadata` included, so one
//        carried `teMetaCamel` made EVERY writer throw `Persisted key policy violation`.
// 65.5 — acpx, as a producer, refuses a `metadata` key it would write itself that is not
//        `^[a-z][a-z0-9_]*$`, at the input (`sessions set-metadata`, `--metadata`), before any write.
//
// The two halves land in ONE change: an acpx that exempted carried keys and did not check its own would write
// keys every older release refuses. The real-CLI rows are in metadata-key-rule-cli.test.ts.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { InvalidArgumentError } from "commander";
import {
  ATRIUM_OS_FALLBACK_KEY,
  ATRIUM_OS_KEY,
  ATRIUM_OS_PRIMER_ERROR_KEY,
  ATRIUM_OS_REVISION_KEY,
} from "../src/acp/atrium-os.js";
import { parseMetadataEntry } from "../src/cli/flags.js";
import { validateSessionMetadataValue } from "../src/cli/session/session-metadata.js";
import {
  assertPersistedKeyPolicy,
  findPersistedKeyPolicyViolations,
  metadataKeyRuleViolation,
} from "../src/persisted-key-policy.js";
import { createFileSessionStore } from "../src/runtime/public/file-session-store.js";
import { exportSession } from "../src/session/export.js";
import {
  resolveSessionRecord,
  serializeSessionRecordForDisk,
  writeSessionRecord,
} from "../src/session/persistence.js";
import {
  ATRIUM_OS_METADATA_PREFIX,
  PRINCIPAL_METADATA_PREFIX,
} from "../src/session/persistence/principal.js";
import { WRITERS } from "./record-writers-fixture.js";
import { withTempHome } from "./runtime-test-helpers.js";
import { newRecord, readRaw, writeRaw, type Raw } from "./unknown-top-level-fields-fixtures.js";

/** What the A-65 TE planted (probe run 1): a camelCase key and a non-ASCII one, beside a snake_case one. */
const CARRIED: Readonly<Record<string, string>> = {
  teMetaCamel: "camel-value",
  te_meta_ünï: "unicode-value",
  "te-meta": "dash-value",
  "Te Meta 1": "spaces-value",
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

// ---------------------------------------------------------------------------------------------
// 65.5 — acpx as a producer refuses a key that breaks the rule, at the input
// ---------------------------------------------------------------------------------------------

const BAD_KEYS = [
  "teMetaCamel",
  "te-meta",
  "te meta",
  "Te",
  "1te",
  "_te",
  "te_meta_ünï",
  "te.meta",
  "te_meta ",
  "TE_META",
];

test("65.5 · the rule: lower-case ASCII, digits and underscores, starting with a letter", () => {
  for (const key of ["te_meta", "a", "a1", "brick", "byway_view_at", "atrium_os"]) {
    assert.equal(metadataKeyRuleViolation(key), undefined, key);
  }
  for (const key of [...BAD_KEYS, ""]) {
    const violation = metadataKeyRuleViolation(key);
    assert.ok(violation, `${JSON.stringify(key)} is refused`);
    assert.ok(violation.includes("^[a-z][a-z0-9_]*$"), "names the rule");
    assert.ok(violation.includes(JSON.stringify(key)), "names the key");
  }
});

test("65.5 · `set-metadata` refuses each bad key before the value is looked at, naming key and rule", () => {
  for (const key of BAD_KEYS) {
    assert.throws(
      () => validateSessionMetadataValue(key, "x"),
      (error: unknown) =>
        error instanceof InvalidArgumentError &&
        error.message.includes(JSON.stringify(key)) &&
        error.message.includes("^[a-z][a-z0-9_]*$"),
      key,
    );
  }
  // The key is judged first: a bad key with a bad value reports the key, and a good key still reports the value.
  assert.throws(() => validateSessionMetadataValue("teMetaCamel", "  "), /teMetaCamel/);
  assert.throws(() => validateSessionMetadataValue("te_meta", "  "), /must not be empty/);
  // Well-formed otherwise: these write as before.
  assert.equal(validateSessionMetadataValue("te_meta", " x "), "x");
  assert.equal(
    validateSessionMetadataValue("brick", "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"),
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
});

test("65.5 · `--metadata key=value` refuses each bad key at option parse, and accepts a good one", () => {
  for (const key of BAD_KEYS.map((candidate) => candidate.trim()).filter((k) => k.length > 0)) {
    if (metadataKeyRuleViolation(key) === undefined) {
      continue; // `te_meta ` trims to a good key: the parser trims the key, as it always did
    }
    assert.throws(
      () => parseMetadataEntry(`${key}=x`, undefined),
      (error: unknown) =>
        error instanceof InvalidArgumentError &&
        error.message.includes(JSON.stringify(key)) &&
        error.message.includes("^[a-z][a-z0-9_]*$"),
      key,
    );
  }
  assert.throws(() => parseMetadataEntry("teMetaCamel=x", { te_meta: "1" }), /teMetaCamel/);
  assert.deepEqual(parseMetadataEntry("te_meta=x", { other_key: "1" }), {
    other_key: "1",
    te_meta: "x",
  });
});

// ---------------------------------------------------------------------------------------------
// 65.5 — acpx's OWN fixed keys: found by scanning src/, never by a list
// ---------------------------------------------------------------------------------------------
//
// The two inputs above (`set-metadata`, `--metadata`) take a key a caller chose. The rest of what acpx writes
// into `metadata` are fixed names in its own source: `created_by_call`, `byway_parent`, `spawn_state`,
// `atrium_os_*`, `principal_*`, `template_source`, …. The write path no longer judges them, so a camelCase
// one added tomorrow would reach disk and be refused by every older release. This scan finds them by
// discovery — each assignment shape below, over every file in src/ — and requires the rule of each; a
// shape it cannot resolve to a literal is reported, not skipped.

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

/** A key some `metadata` the scan reads is NOT a session record's: the account-switch seam's own fields. */
const NOT_A_RECORD_METADATA_KEY: ReadonlyMap<string, string> = new Map([
  [
    "effectiveResolutionMethod",
    "a field of the account-switch seam (`SessionIndexAccountSwitch`, `acpx.session_options.account_switch`), held in a local variable that happens to be named `metadata`",
  ],
]);

type ScannedKey = { file: string; key: string; shape: string };

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files.toSorted();
}

/** `NAME = "literal"` constants, by name, over a set of sources — what `metadata[NAME]` / `[NAME]:` resolve to. */
function stringConstants(sources: ReadonlyArray<{ text: string }>): Map<string, string> {
  const constants = new Map<string, string>();
  for (const { text } of sources) {
    for (const match of text.matchAll(
      /\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=\n]+)?=\s*"([^"]*)"/g,
    )) {
      constants.set(match[1], match[2]);
    }
  }
  return constants;
}

/** Every `metadata` key one source assigns, by the four shapes it is assigned in. Pure: a string in, keys out. */
function scanMetadataKeyWrites(
  file: string,
  text: string,
  constants: ReadonlyMap<string, string>,
): ScannedKey[] {
  const found: ScannedKey[] = [];
  const resolve = (name: string, shape: string): void => {
    found.push({ file, key: constants.get(name) ?? `<unresolved ${name}>`, shape });
  };
  for (const match of text.matchAll(/\bmetadata\.([A-Za-z0-9_]+)\s*=(?!=)/g)) {
    found.push({ file, key: match[1], shape: "metadata.key =" });
  }
  for (const match of text.matchAll(/\bmetadata\[\s*"([^"]+)"\s*\]\s*=(?!=)/g)) {
    found.push({ file, key: match[1], shape: 'metadata["key"] =' });
  }
  for (const match of text.matchAll(/\bmetadata\[\s*([A-Z][A-Z0-9_]*)\s*\]\s*=(?!=)/g)) {
    resolve(match[1], "metadata[CONST] =");
  }
  for (const block of text.matchAll(/\bmetadata\s*[:=]\s*\{([^{}]*)\}/g)) {
    for (const match of block[1].matchAll(
      /(?:^|[{,])\s*(?:\[([A-Z][A-Z0-9_]*)\]|"?([A-Za-z0-9_]+)"?)\s*:/gm,
    )) {
      if (match[1] !== undefined) {
        resolve(match[1], "metadata: { [CONST]: … }");
      } else {
        found.push({ file, key: match[2], shape: "metadata: { key: … }" });
      }
    }
  }
  return found;
}

test("65.5 · every metadata key acpx's own source writes is spelled by the rule (found by scanning src/)", async () => {
  const files = await sourceFiles(SRC_DIR);
  const sources = await Promise.all(
    files.map(async (file) => ({ file, text: await fs.readFile(file, "utf8") })),
  );
  const constants = stringConstants(sources);
  const keys = sources.flatMap(({ file, text }) =>
    scanMetadataKeyWrites(path.relative(SRC_DIR, file), text, constants),
  );
  // Positive control: the scan finds the keys we know are written, so an empty scan cannot pass.
  const names = new Set(keys.map((entry) => entry.key));
  for (const known of [
    "created_by_call",
    "byway_parent",
    "spawn_state",
    "template_source",
    "principal_id",
    "atrium_os",
  ]) {
    assert.ok(names.has(known), `control: the scan finds ${known}`);
  }
  const offenders = keys.filter(
    (entry) =>
      metadataKeyRuleViolation(entry.key) !== undefined &&
      !NOT_A_RECORD_METADATA_KEY.has(entry.key),
  );
  assert.deepEqual(
    offenders.map((entry) => `${entry.file}: ${entry.key} (${entry.shape})`),
    [],
    "a metadata key written by acpx's source breaks ^[a-z][a-z0-9_]*$ — spell it snake_case",
  );
  // The constants acpx hands out by name (imported where the scan cannot follow a call's argument).
  for (const key of [
    ATRIUM_OS_KEY,
    ATRIUM_OS_REVISION_KEY,
    ATRIUM_OS_FALLBACK_KEY,
    ATRIUM_OS_PRIMER_ERROR_KEY,
    ATRIUM_OS_METADATA_PREFIX,
    PRINCIPAL_METADATA_PREFIX,
  ]) {
    assert.equal(metadataKeyRuleViolation(key), undefined, key);
  }
});

// The committed negative cases of the scan: a fresh camelCase key, written in each shape, is flagged without
// being registered anywhere — so the scan above goes red the day someone adds one.
test("65.5 · negative: the scan flags a fresh non-snake_case key in every shape it reads", () => {
  const constants = new Map([["FRESH_KEY", "teFreshKey"]]);
  const text = [
    'record.metadata.teFreshA = "x";',
    'metadata["teFresh-b"] = "x";',
    'metadata[FRESH_KEY] = "x";',
    'record.metadata = { ...record.metadata, teFreshC: "x", [FRESH_KEY]: "y" };',
    "metadata: {\n  teFreshD: 1,\n  te_fine: 2,\n},",
  ].join("\n");
  const flagged = scanMetadataKeyWrites("fresh.ts", text, constants)
    .map((entry) => entry.key)
    .filter((key) => metadataKeyRuleViolation(key) !== undefined);
  assert.deepEqual(flagged.toSorted(), [
    "teFresh-b",
    "teFreshA",
    "teFreshC",
    "teFreshD",
    "teFreshKey",
    "teFreshKey",
  ]);
});
