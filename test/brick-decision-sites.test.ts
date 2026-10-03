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

/**
 * file → { hits, why }: the EXACT number of cache-naming lines each file may carry, and why each is
 * not a "which brick does this session have" decision. An exact count, not a wholesale exemption
 * (te-fail C8: `brick-outbox.ts` was allowlisted whole and hid two deciding reads): a new site in an
 * allowlisted file changes the count and fails here until someone reads it.
 */
const MAY_TOUCH_THE_CACHE: Readonly<Record<string, { hits: number; why: string }>> = {
  "src/session/seat-brick.ts": {
    hits: 2,
    why: "the decider's fallback leg, and withBrickCache (the ONE spelling of the cache pair)",
  },
  "src/session/persistence/seat-fields.ts": {
    hits: 1,
    why: "the index projection of the cache (a pure record->entry function)",
  },
  "src/session/seat-backfill.ts": {
    hits: 1,
    why: "derives a seat's brick_id FROM its holder, once, at backfill (3dff714d (d))",
  },
  "src/cli/session/session-management.ts": {
    hits: 2,
    why: "mint/join: the new seat's brick_id from the value the cache is about to carry",
  },
  "src/cli/session/runtime.ts": {
    hits: 1,
    why: "subagent seat mint from the child's own (empty) cache",
  },
  "src/cli/session/inherited-metadata.ts": {
    hits: 3,
    why: "pure merge over the CHILD's to-be-written metadata, before any record exists",
  },
  "src/session/archive/record-view.ts": {
    hits: 1,
    why: "archive manifest projection of the cache: a read-only copy (census F)",
  },
  "src/session/persistence/seat-store.ts": {
    hits: 1,
    why: "operator-facing MESSAGE text only (L4's surface); no read",
  },
  "src/brick-outbox.ts": {
    hits: 8,
    why:
      "7 WRITERS that project a brick CLI result onto the cache, and ONE read of the ON-DISK " +
      "cache as 'what was last published' (the tombstone target). The projection target is " +
      "decided through decidedBrick() -> the decider, not read here (fb1a7a9c F4).",
  },
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

test("no src file outside the allowlist reads the record's metadata.brick cache, and no allowlisted file reads more than it says", async () => {
  const root = process.cwd();
  const files = await sourceFiles(path.join(root, "src"));
  assert.ok(files.length > 100, `scanned only ${files.length} files — the walk is broken`);
  const offenders: string[] = [];
  const counts = new Map<string, number>();
  for (const file of files) {
    const rel = path.relative(root, file);
    const hits = rawCacheReadLines(await fs.readFile(file, "utf8"));
    if (hits.length > 0) {
      counts.set(rel, hits.length);
    }
    if (!(rel in MAY_TOUCH_THE_CACHE) && hits.length > 0) {
      offenders.push(`${rel}:${hits.join(",")}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these sites read metadata.brick directly — decide the brick through decideSessionBrick / " +
      "resolveSessionBrickContext (src/session/seat-brick.ts) instead",
  );
  for (const [rel, { hits }] of Object.entries(MAY_TOUCH_THE_CACHE)) {
    assert.equal(
      counts.get(rel) ?? 0,
      hits,
      `${rel}: the allowlist says ${hits} cache-naming line(s); read the new site(s) and decide`,
    );
  }
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
