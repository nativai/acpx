import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// brick fb1a7a9c — a session's brick is decided by `decideSessionBrick` (its SEAT's brick_id,
// `metadata.brick` only as the fallback). The failure this guards is a NEW site that reads the
// record's `metadata.brick` cache directly and so reintroduces "the session has its own link".
// DISCOVERING, not a hand list: every src file is scanned, and a file is exempt only by an
// entry below that says WHY it may touch the cache. The negative case at the bottom feeds the
// scanner a fresh offender and expects it flagged without registering it anywhere.

/**
 * Every SPELLING of "read the brick off the record's metadata cache" the TE measured (te-fail on
 * 4423697c, C8: the old single regex caught ONE spelling and called itself "no src file reads the
 * cache"). Each spelling carries a fixture below that MUST be flagged — a negative control per
 * spelling, so a regex edited into silence goes red here rather than passing the sweep.
 *
 * ⚠️ NOT CATCHABLE BY NAME: a local alias (`const meta = record.metadata; meta.brick`). The
 * regexes key on an identifier ending in `metadata`; an alias with another name is invisible to a
 * text scan. The seat-brick.ts header says a new site must call the decider — this guard is the
 * net for the spellings that name the field, not a proof.
 */
const CACHE_READ_SPELLINGS: readonly { name: string; re: RegExp; fixture: string }[] = [
  {
    name: "member access",
    re: /\b\w*[Mm]etadata\??\.brick\b(?!_)/,
    fixture: "const b = record.metadata?.brick?.trim();",
  },
  {
    name: "bracket access",
    re: /\b\w*[Mm]etadata\??\.?\[\s*["']brick["']\s*\]/,
    fixture: 'const b = record.metadata["brick"];',
  },
  {
    name: "optional bracket access",
    re: /\b\w*[Mm]etadata\??\.?\[\s*["']brick["']\s*\]/,
    fixture: 'const b = record.metadata?.["brick"];',
  },
  {
    name: "destructuring",
    re: /\{[^}]*\bbrick\b[^}]*\}\s*=\s*[\w.?]*[Mm]etadata\b/,
    fixture: "const { brick } = record.metadata;",
  },
  {
    name: "metadataValue/metadataString helper",
    re: /\bmetadata(?:Value|String)\([^)]*["']brick["']\s*\)/,
    fixture: 'const b = metadataString(metadata, "brick");',
  },
  {
    name: "metadataValue on a disk record",
    re: /\bmetadata(?:Value|String)\([^)]*["']brick["']\s*\)/,
    fixture: 'if (!metadataValue(record, "brick")) {',
  },
  {
    name: "parent/child-prefixed metadata",
    re: /\b\w*[Mm]etadata\??\.brick\b(?!_)/,
    fixture: "const b = parentMetadata.brick;",
  },
];

/** file → why a raw `metadata.brick` is correct there. */
const MAY_TOUCH_THE_CACHE: Readonly<Record<string, string>> = {
  "src/session/seat-brick.ts": "the decider itself — the fallback leg",
  "src/session/persistence/seat-fields.ts":
    "the index projection of the cache (a pure record→entry function)",
  "src/session/seat-backfill.ts": "derives a seat's brick_id FROM its holder, once, at backfill",
  "src/cli/session/session-management.ts":
    "mint/join: writes the seat from the value the cache is about to carry",
  "src/session/persistence/seat-store.ts":
    "operator-facing MESSAGE text only (L4's surface, left untouched here); no read",
  "src/brick-outbox.ts": "WRITER: projects a brick CLI result onto the cache (and restores it)",
  "src/cli/session/runtime.ts":
    "subagent mint: the seat row's brick from the child's own (empty) cache",
};

function rawCacheReadLines(source: string): number[] {
  const hits: number[] = [];
  source.split("\n").forEach((line, index) => {
    const code = line.trimStart();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) {
      return;
    }
    if (CACHE_READ_SPELLINGS.some(({ re }) => re.test(line))) {
      hits.push(index + 1);
    }
  });
  return hits;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

test("no src file outside the allowlist reads the record's metadata.brick cache directly", async () => {
  const root = process.cwd();
  const files = await sourceFiles(path.join(root, "src"));
  assert.ok(files.length > 100, `scanned only ${files.length} files — the walk is broken`);
  const offenders: string[] = [];
  let allowlistedHits = 0;
  for (const file of files) {
    const rel = path.relative(root, file);
    const hits = rawCacheReadLines(await fs.readFile(file, "utf8"));
    if (rel in MAY_TOUCH_THE_CACHE) {
      allowlistedHits += hits.length;
    } else if (hits.length > 0) {
      offenders.push(`${rel}:${hits.join(",")}`);
    }
  }
  assert.ok(
    allowlistedHits > 0,
    "positive control: the scanner found no read in the allowlisted files",
  );
  assert.deepEqual(
    offenders,
    [],
    "these sites read metadata.brick directly — decide the brick through decideSessionBrick / " +
      "resolveSessionBrickContext (src/session/seat-brick.ts) instead",
  );
});

test("the scanner flags EVERY spelling's fixture, and ignores comments and metadata.brick_validation", () => {
  for (const { name, fixture } of CACHE_READ_SPELLINGS) {
    assert.deepEqual(rawCacheReadLines(fixture), [1], `spelling not flagged: ${name}`);
  }
  assert.deepEqual(
    rawCacheReadLines("// record.metadata?.brick is the link\n * metadata.brick"),
    [],
  );
  assert.deepEqual(rawCacheReadLines("const v = metadata?.brick_validation;"), []);
  assert.deepEqual(rawCacheReadLines('const v = metadata["brick_validation"];'), []);
});
