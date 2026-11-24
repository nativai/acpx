// A-65 correction (C3.5 (iv) "`metadata` keys", brick 1948e346) — row 65.5, the producer half: acpx refuses a
// `metadata` key it would write itself that is not `^[a-z][a-z0-9_]*$`, at the input (`sessions set-metadata`,
// `--metadata`) and for its own fixed keys, before any write. It lands in the same change as the exemption of a
// carried key (row 65.4, metadata-key-rule.test.ts); the real-CLI rows are in metadata-key-rule-cli.test.ts.
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
import { metadataKeyRuleViolation } from "../src/persisted-key-policy.js";
import {
  ATRIUM_OS_METADATA_PREFIX,
  PRINCIPAL_METADATA_PREFIX,
} from "../src/session/persistence/principal.js";

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
