import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import {
  DELIVERY_SIDECAR_SUFFIXES,
  isSessionRecordFileName,
} from "../src/session/persistence/session-dir-files.js";
import {
  collectConstants,
  jsonSuffixSites,
  listingSites,
  parseTree,
  referencesOf,
  type Site,
} from "./sessions-dir-scan.js";

// brick 99bf1c0d — the ONE predicate for "is this name a session record file?", and the conformance rows
// that keep every enumeration of the sessions directory behind it (see test/delivery-json-sidecar.test.ts for
// the behavioural negatives per enumeration).

test("the predicate: `<id>.json` with a dot-free id — uuid, uuidv7, `ses_…` and slug ids alike", () => {
  for (const name of [
    "11111111-aaaa-4aaa-8aaa-111111111111.json",
    "019edbeb-53e3-7a83-a3d0-ab305b914d2a.json", // uuidv7
    "ses_f84bb7041ffeOayX6OGKPn4Elu.json", // real opaque ids on devbox: a uuid test would drop these
    "mid-turn-injection.json", // the archive's slug-id record
    "an-id.with.stream.in-it.json", // ids may contain dots (the prune rows use one): not a sidecar
  ]) {
    assert.equal(isSessionRecordFileName(name), true, name);
  }
});

test("the predicate NEGATIVES: every sidecar and store that ends in `.json`, and the shapes around them", () => {
  for (const name of [
    "11111111-aaaa-4aaa-8aaa-111111111111.delivery.json", // acpx-ui's delivery store
    "11111111-aaaa-4aaa-8aaa-111111111111.queue.json", // its legacy siblings
    "11111111-aaaa-4aaa-8aaa-111111111111.inflight.json",
    "index.json", // acpx's own stores
    "seats.json",
    ".json", // no id part
    "x.json.tmp",
    "x.json.bak-mig-2026-10-06T191739004Z",
    "x.json.123.456.tmp",
    "dir/x.json", // a path, not a bare name
    "..\\x.json",
    "x.JSON.tmp",
    "",
  ]) {
    assert.equal(isSessionRecordFileName(name), false, JSON.stringify(name));
  }
});

test("KNOWN LIMIT, stated as a row: a sidecar family nobody has listed is counted again until its suffix joins DELIVERY_SIDECAR_SUFFIXES", () => {
  assert.equal(
    isSessionRecordFileName("11111111-aaaa-4aaa-8aaa-111111111111.some-future-sidecar.json"),
    true,
  );
  assert.deepEqual(
    [...DELIVERY_SIDECAR_SUFFIXES],
    [".delivery.json", ".queue.json", ".inflight.json"],
  );
});

// ---- CONFORMANCE: discovered by a REAL PARSE of src/ (brick f933f372 — the first version was line-based) ----
//
// Two discoveries, both over the TypeScript AST, so comments and prose never count as code and a suffix test is
// recognised in every spelling the parse can see: `endsWith` with a literal, a constant (any file) or a
// concatenation, a call split across lines, `extname`/`slice`/`substring`/`split().pop()` compared with
// `.json`/`json`, `[".json"].includes(extname(x))`, a regex literal or `new RegExp(…)` ending in `\.json$`;
// and every call that LISTS a directory, under `readdir`/`opendir`, an import alias, or a bound/destructured copy.

const SRC = path.resolve("src");
/** An exemption is one OCCURRENCE: file, enclosing FUNCTION, and the occurrence's own text. */
const key = (site: Site): string => `${site.file}::${site.fn}::${site.text}`;

/** `count`: how many occurrences with this exact key are expected (default 1) — EXACT, not "at least". */
type Exemption = { why: string; count?: number };

/**
 * Suffix tests that are NOT about the sessions directory. Keyed `file::function::text`: a new filter in the
 * same file but another function — or a second identical one in the same function — is a different
 * occurrence (it fails the exact count) and is flagged. `seat-archive.ts` is the case that made this
 * per-occurrence: it lists the seat-archive dir AND the sessions dir, and the TE showed that a text-only key let
 * a new `name.endsWith(".json")` in `unfoldRacedHolders` ride on the exemption of `readSeatArchiveLedger`.
 */
const JSON_SUFFIX_EXEMPT: Readonly<Record<string, Exemption>> = {
  'session/persistence/session-dir-files.ts::isSessionRecordFileName::filename.endsWith(".json")': {
    why: "defines the predicate",
  },
  "session/archive/archive-index.ts::<module>::/^(\\d{4})-(\\d{2})\\.json$/": {
    why: "ARCHIVE-INDEX shard names `YYYY-MM.json`",
  },
  'session/persistence/seat-archive.ts::readSeatArchiveLedger::name.endsWith(".json")': {
    why: "the seat-archive directory (`<seatId>.json`), not the sessions dir",
  },
  'acp/pi-model-knowledge.ts::piKeptOverlayPath::cachePath.endsWith(".json")': {
    why: "derives a sibling path of a cache file; lists nothing",
  },
  'capacity/waiting.ts::readWaiting::name.endsWith(".json")': {
    why: "the capacity waiting-queue directory",
  },
  'capacity/governor/notify.ts::readOutbox::name.endsWith(".json")': {
    why: "the governor's notification outbox",
  },
  "capacity/governor/record.ts::pendingPeaksDays::/^\\d{4}-\\d{2}-\\d{2}\\.json$/u": {
    why: "the governor's dated peak files",
  },
  "session/persistence/session-dir-files.ts::isSessionRecordFileName::filename.endsWith(suffix)": {
    why: "the predicate iterates its OWN list, DELIVERY_SIDECAR_SUFFIXES — the one list a name may be tested against",
  },
  'flows/json.ts::extractFencedJsonText::text.slice(contentStart, contentStart + 4).toLowerCase() === "json"':
    { why: "a Markdown code-fence language tag, not a file name (an accepted over-fire)" },
};

/** Occurrences of a suffix test that no exemption covers — by key AND by exact count per key. */
export function unexemptedSuffixTests(
  sites: readonly Site[],
  exempt: Readonly<Record<string, Exemption>>,
): string[] {
  const seen = new Map<string, Site[]>();
  for (const site of sites) {
    seen.set(key(site), [...(seen.get(key(site)) ?? []), site]);
  }
  const flagged: string[] = [];
  for (const [siteKey, group] of seen) {
    const allowed = exempt[siteKey]?.count ?? (exempt[siteKey] ? 1 : 0);
    if (group.length > allowed) {
      flagged.push(`${siteKey} (${group.length} occurrence(s), ${allowed} exempted)`);
    }
  }
  return flagged.toSorted();
}

/** Exemptions whose live count is not EXACTLY what they say (stale or too wide). */
export function wrongExemptionCounts(
  sites: readonly Site[],
  exempt: Readonly<Record<string, Exemption>>,
): string[] {
  const counts = new Map<string, number>();
  for (const site of sites) {
    counts.set(key(site), (counts.get(key(site)) ?? 0) + 1);
  }
  return Object.entries(exempt)
    .filter(([siteKey, entry]) => (counts.get(siteKey) ?? 0) !== (entry.count ?? 1))
    .map(([siteKey]) => siteKey)
    .toSorted();
}

const parsed = parseTree(SRC);
const constants = collectConstants(parsed);

test("CONFORMANCE: every `.json` suffix test in src/ is behind the predicate or a per-OCCURRENCE exemption (file::function::text, exact count) — found by parse", () => {
  const sites = jsonSuffixSites(parsed, constants);
  assert.deepEqual(unexemptedSuffixTests(sites, JSON_SUFFIX_EXEMPT), []);
  // each exemption names EXACTLY its live count: a stale one (0) and a too-wide one (more occurrences) both fail
  assert.deepEqual(wrongExemptionCounts(sites, JSON_SUFFIX_EXEMPT), []);
});

test("CONFORMANCE: the exemption counters themselves can fail — a stale exemption and a doubled occurrence are both reported", () => {
  const site: Site = { file: "a.ts", fn: "f", text: 'n.endsWith(".json")' };
  const exempt = { [key(site)]: { why: "x" } };
  assert.deepEqual(wrongExemptionCounts([site], exempt), []);
  assert.deepEqual(wrongExemptionCounts([], exempt), [key(site)], "stale: nothing live matches");
  assert.deepEqual(
    wrongExemptionCounts([site, site], exempt),
    [key(site)],
    "too wide: two live, one exempted",
  );
  assert.deepEqual(
    unexemptedSuffixTests([site, site], exempt).length,
    1,
    "and the second occurrence is flagged",
  );
  assert.deepEqual(wrongExemptionCounts([site, site], { [key(site)]: { why: "x", count: 2 } }), []);
});

/** Each way a suffix test can be spelled — every one must be SEEN by the parse. */
const SPELLINGS: Readonly<Record<string, string>> = {
  "endsWith, double quotes": 'export const f = (n: string) => n.endsWith(".json");',
  "endsWith, single quotes": "export const f = (n: string) => n.endsWith('.json');",
  "endsWith, template literal": "export const f = (n: string) => n.endsWith(`.json`);",
  "endsWith, a constant":
    'const SUFFIX = ".json";\nexport const f = (n: string) => n.endsWith(SUFFIX);',
  "endsWith, a constant built by concatenation":
    'const EXT = "." + "json";\nexport const f = (n: string) => n.endsWith(EXT);',
  "endsWith, a call split across lines":
    'export const f = (n: string) =>\n  n.endsWith(\n    ".json",\n  );',
  extname:
    'import path from "node:path";\nexport const f = (n: string) => path.extname(n) === ".json";',
  "extname, lower-cased, reversed operands":
    'import { extname } from "node:path";\nexport const f = (n: string) => ".json" === extname(n).toLowerCase();',
  "extname in a list":
    'import { extname } from "node:path";\nexport const f = (n: string) => [".json", ".yaml"].includes(extname(n));',
  "slice(-5)": 'export const f = (n: string) => n.slice(-5) === ".json";',
  "slice with a computed length":
    'export const f = (n: string) => n.slice(n.length - 5) !== ".json";',
  substring: 'export const f = (n: string) => n.substring(n.length - 5) == ".json";',
  "split().pop()": 'export const f = (n: string) => n.split(".").pop() === "json";',
  "regex literal": "export const f = (n: string) => /\\.json$/u.test(n);",
  "regex literal, a capture group": "export const f = (n: string) => /^([^.]+)\\.json$/u.exec(n);",
  "new RegExp": 'export const f = (n: string) => new RegExp("\\\\.json$").test(n);',
  "extname into a local (F-2, R3)":
    'import path from "node:path";\nexport const f = (n: string) => {\n  const ext = path.extname(n);\n  return ext === ".json";\n};',
  "extname into a local, then a list":
    'import { extname } from "node:path";\nexport const f = (n: string) => {\n  const ext = extname(n).toLowerCase();\n  return [".json"].includes(ext);\n};',
  "fs.globSync with a json pattern (F-2, R4)":
    'import fs from "node:fs";\nexport const f = (dir: string) => fs.globSync("*.json", { cwd: dir });',
  "fs.promises.glob with a json pattern":
    'import fs from "node:fs";\nexport const f = (dir: string) => fs.promises.glob("**/*.json", { cwd: dir });',
  "path.matchesGlob":
    'import path from "node:path";\nexport const f = (n: string) => path.matchesGlob(n, "*.json");',
  "RegExp from a constant":
    'const PATTERN = "\\\\.json$";\nexport const f = (n: string) => RegExp(PATTERN).test(n);',
};

/** Spellings that are NOT a `.json` suffix test — the scan must stay quiet (a guard that flags everything proves nothing). */
const CONTROLS: Readonly<Record<string, string>> = {
  ndjson: 'export const f = (n: string) => n.endsWith(".ndjson");',
  "ndjson regex": "export const f = (n: string) => /^(\\d{4})\\.ndjson$/u.test(n);",
  "zst via a constant": 'const ZST = ".zst";\nexport const f = (n: string) => n.endsWith(ZST);',
  "extname of something else":
    'import path from "node:path";\nexport const f = (n: string) => path.extname(n) === ".md";',
  "slice of something else": 'export const f = (n: string) => n.slice(-4) === ".zst";',
  "a comment that says it":
    '// n.endsWith(".json") and path.extname(n) === ".json"\nexport const f = 1;',
  "prose in a string": 'export const f = "use endsWith(\\".json\\") never";',
  "extname into a local compared with something else":
    'import path from "node:path";\nexport const f = (n: string) => {\n  const ext = path.extname(n);\n  return ext === ".md";\n};',
  "a glob that is not json":
    'import fs from "node:fs";\nexport const f = (d: string) => fs.globSync("*.md", { cwd: d });',
  "building a record path": "export const f = (id: string) => `${id}.json`;",
};

function scanFresh(files: Readonly<Record<string, string>>): Site[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-dj-fresh-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  const tree = parseTree(root);
  return jsonSuffixSites(tree, collectConstants(tree));
}

for (const [name, text] of Object.entries(SPELLINGS)) {
  test(`CONFORMANCE NEGATIVE (spelling): a fresh file with ${name} is flagged without being registered anywhere`, () => {
    const sites = scanFresh({ "fresh.ts": text });
    assert.equal(sites.length >= 1, true, `not seen: ${text}`);
    assert.deepEqual(unexemptedSuffixTests(sites, {}).length >= 1, true);
  });
}

/**
 * The line-based detector the first version shipped (99bf1c0d), kept as DATA: this row documents that each
 * spelling below really escaped it (the TE's F-C5a) and is seen now — "red on today's scan", permanently.
 */
const LEGACY_LINE_FILTER = /endsWith\(\s*["'`]\.json["'`]\s*\)|\\\.json\$\/|\.json\$\//u;
const legacyCatches = (text: string): boolean =>
  text
    .split("\n")
    .some((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line) && LEGACY_LINE_FILTER.test(line));

test("the old line-based scan MISSED these spellings (F-C5a) — and the parse sees every one", () => {
  const escaped = Object.entries(SPELLINGS)
    .filter(([, text]) => !legacyCatches(text))
    .map(([name]) => name);
  assert.deepEqual(
    escaped.toSorted(),
    [
      "RegExp from a constant",
      "endsWith, a call split across lines",
      "endsWith, a constant",
      "endsWith, a constant built by concatenation",
      "extname",
      "extname into a local (F-2, R3)",
      "extname into a local, then a list",
      "fs.globSync with a json pattern (F-2, R4)",
      "fs.promises.glob with a json pattern",
      "path.matchesGlob",
      "extname in a list",
      "extname, lower-cased, reversed operands",
      "new RegExp",
      "slice with a computed length",
      "slice(-5)",
      "split().pop()",
      "substring",
    ].toSorted(),
  );
  // positive control: the old scan did catch these, so the filter itself is not broken
  for (const name of [
    "endsWith, double quotes",
    "endsWith, single quotes",
    "endsWith, template literal",
    "regex literal",
  ]) {
    assert.equal(legacyCatches(SPELLINGS[name] ?? ""), true, name);
  }
  for (const name of escaped) {
    assert.equal(
      scanFresh({ "fresh.ts": SPELLINGS[name] ?? "" }).length >= 1,
      true,
      `the parse missed: ${name}`,
    );
  }
});

/**
 * Round 3 (F-14, F-15): a suffix test through a CONSTANT LIST — the idiom the predicate itself uses
 * (`DELIVERY_SIDECAR_SUFFIXES.some((suffix) => filename.endsWith(suffix))`). A developer writing the next
 * sessions-dir filter "like the predicate" must not get a green scan.
 */
const LIST_SPELLINGS: Readonly<Record<string, string>> = {
  "F-14 some over a const list":
    'const EXTS = [".json", ".yaml"];\nexport const f = (n: string) => EXTS.some((e) => n.endsWith(e));',
  "F-14 find over a const list":
    'const EXTS = [".json"];\nexport const f = (n: string) => EXTS.find((e) => n.endsWith(e));',
  "F-14 every / filter over a const list":
    'const EXTS = [".json"] as const;\nexport const f = (n: string) => EXTS.every((e) => n.endsWith(e)) || EXTS.filter((e) => n.endsWith(e));',
  "F-14 some over an inline list":
    'export const f = (n: string) => [".json", ".yaml"].some((e) => n.endsWith(e));',
  "F-14 some over a Set built from a list":
    'const EXTS = new Set([".json"]);\nexport const f = (n: string) => [...EXTS].some((e) => n.endsWith(e));',
  "F-14 for…of over a const list":
    'const EXTS = [".json"];\nexport const f = (n: string) => {\n  for (const e of EXTS) {\n    if (n.endsWith(e)) {\n      return true;\n    }\n  }\n  return false;\n};',
  "F-14 an alias of the list":
    'const A = [".json"];\nconst B = A;\nexport const f = (n: string) => B.some((e) => n.endsWith(e));',
  "F-14 a list imported from ANOTHER file":
    'import { EXTS } from "./exts.js";\nexport const f = (n: string) => EXTS.some((e) => n.endsWith(e));',
  "F-14 a function expression callback":
    'const EXTS = [".json"];\nexport const f = (n: string) => EXTS.some(function (e) {\n  return n.endsWith(e);\n});',
  "F-18 a suffix local read in a nested closure of its declaring function":
    'import path from "node:path";\nexport const f = (n: string) => {\n  const ext = path.extname(n);\n  const isRecord = () => ext === ".json";\n  return isRecord();\n};',
  "F-18 a suffix local read in a closure, against a constant list":
    'import path from "node:path";\nconst EXTS = [".json"];\nexport function f(n: string) {\n  const ext = path.extname(n);\n  return () => EXTS.includes(ext);\n}',
  "F-17 the iterated element compared (===) with a suffix local":
    'import path from "node:path";\nconst EXTS = [".json"];\nexport const f = (n: string) => {\n  const ext = path.extname(n);\n  return EXTS.some((e) => ext === e);\n};',
  "F-17 for…of with the element compared against an extname call":
    'import path from "node:path";\nconst EXTS = [".json"];\nexport const f = (n: string) => {\n  for (const e of EXTS) {\n    if (path.extname(n) === e) {\n      return true;\n    }\n  }\n  return false;\n};',
  "F-17 Array.from(LIST).some":
    'const EXTS = [".json"];\nexport const f = (n: string) => Array.from(EXTS).some((e) => n.endsWith(e));',
  "F-17 a copy of the list (slice / toSorted)":
    'const EXTS = [".json"];\nexport const f = (n: string) => EXTS.slice().some((e) => n.endsWith(e)) || EXTS.toSorted().some((e) => n.endsWith(e));',
  "F-25 a `let` WITH an initialiser binds a suffix local too":
    'import path from "node:path";\nexport const f = (n: string) => {\n  let ext = path.extname(n);\n  return ext === ".json";\n};',
  "F-15 includes on a const list":
    'import path from "node:path";\nconst EXTS = [".json", ".yaml"];\nexport const f = (n: string) => EXTS.includes(path.extname(n));',
  "F-15 has on a const Set":
    'import path from "node:path";\nconst SET = new Set([".json"]);\nexport const f = (n: string) => SET.has(path.extname(n));',
  "F-15 has on a const Set, through a local (the flows/cli.ts shape)":
    'import path from "node:path";\nconst SET = new Set([".json"]);\nexport const f = (n: string) => {\n  const ext = path.extname(n).toLowerCase();\n  return SET.has(ext);\n};',
  "F-15 has on a Set literal receiver":
    'import path from "node:path";\nexport const f = (n: string) => new Set([".json"]).has(path.extname(n));',
};

const LIST_FILES: Readonly<Record<string, string>> = {
  "exts.ts": 'export const EXTS = [".json"];',
};

/** Look-alikes that must stay quiet — including the `OUTPUT_FORMATS.includes(value)` shape that over-fired while locals were file-wide. */
const LIST_CONTROLS: Readonly<Record<string, string>> = {
  "iterating a non-json suffix list":
    'const EXTS = [".zst", ".ndjson"];\nexport const f = (n: string) => EXTS.some((e) => n.endsWith(e));',
  "includes on a non-json list with an extname":
    'import path from "node:path";\nconst EXTS = [".md", ".txt"];\nexport const f = (n: string) => EXTS.includes(path.extname(n));',
  'a list holding "json" tested with a value from ANOTHER function (locals are scoped)':
    'const FORMATS = ["text", "json"];\nexport const a = (v: string) => FORMATS.includes(v);\nexport const b = (raw: string) => {\n  const v = raw.slice(0, 4);\n  return v;\n};',
  "a closure reading a local that is NOT suffix-derived":
    "export const f = (n: string) => {\n  const ext = n.length;\n  return () => ext === 5;\n};",
  "a closure reading a suffix local, compared with something else":
    'import path from "node:path";\nexport const f = (n: string) => {\n  const ext = path.extname(n);\n  return () => ext === ".md";\n};',
  "a sibling function reading a same-named local it did not derive":
    'import path from "node:path";\nexport const a = (n: string) => {\n  const ext = path.extname(n);\n  return ext;\n};\nexport const b = (ext: string) => ext === ".json";',
  "a json list whose element is never used as a suffix":
    'const EXTS = [".json"];\nexport const f = (n: string) => EXTS.some((e) => n === e);',
};

test("CONFORMANCE NEGATIVE (F-14/F-15): a suffix test through a constant list is flagged, in every form, without being registered", () => {
  for (const [name, text] of Object.entries(LIST_SPELLINGS)) {
    const sites = scanFresh({ "fresh.ts": text, ...LIST_FILES });
    assert.equal(sites.length >= 1, true, `not seen: ${name}`);
    assert.equal(unexemptedSuffixTests(sites, {}).length >= 1, true, name);
  }
});

test("CONFORMANCE (F-14/F-15): the old line-based scan saw NONE of the constant-list forms — red on yesterday's scan", () => {
  for (const [name, text] of Object.entries(LIST_SPELLINGS)) {
    assert.equal(legacyCatches(text), false, `the old scan already caught: ${name}`);
  }
});

/**
 * NAMED ESCAPES — real suffix tests the scan does NOT see, listed in the header of `sessions-dir-scan.ts`. They are
 * NOT look-alikes (so not in LIST_CONTROLS, where "stays quiet" would read as "is correct"): this row pins that
 * each one still escapes, so closing one turns it red and moves it to SPELLINGS (brick bfbb74e3, F20-a).
 */
const NAMED_ESCAPES: Readonly<Record<string, string>> = {
  "a `let` assigned AFTER its declaration":
    'import path from "node:path";\nexport const f = (n: string) => {\n  let ext: string;\n  ext = path.extname(n);\n  return ext === ".json";\n};',
};

test("NAMED ESCAPES (F20-a): each documented escape is a real `.json` suffix test the scan does not see — closing one must move it to SPELLINGS", () => {
  for (const [name, text] of Object.entries(NAMED_ESCAPES)) {
    assert.deepEqual(
      scanFresh({ "fresh.ts": text }),
      [],
      `now seen — move it to SPELLINGS: ${name}`,
    );
    // it IS a suffix test: the same shape with the initialiser on the declaration is seen
    assert.equal(
      scanFresh({ "fresh.ts": text.replace("let ext: string;\n  ext = ", "const ext = ") })
        .length >= 1,
      true,
      `the control shape is not a suffix test: ${name}`,
    );
  }
});

test("CONFORMANCE CONTROLS (F-14/F-15): look-alikes over constant lists stay quiet", () => {
  for (const [name, text] of Object.entries(LIST_CONTROLS)) {
    assert.deepEqual(scanFresh({ "fresh.ts": text }), [], name);
  }
});

test("CONFORMANCE (F-14): the predicate's own list iteration is found on the REAL tree and exempted, with its reason — and no other site changed", () => {
  const sites = jsonSuffixSites(parsed, constants);
  const own = sites.filter((site) => site.text === "filename.endsWith(suffix)");
  assert.deepEqual(own.map(key), [
    "session/persistence/session-dir-files.ts::isSessionRecordFileName::filename.endsWith(suffix)",
  ]);
  assert.equal(
    sites.length,
    Object.values(JSON_SUFFIX_EXEMPT).reduce((sum, entry) => sum + (entry.count ?? 1), 0),
  );
});

test("CONFORMANCE CONTROLS: the same scan stays quiet on every non-`.json` look-alike, comments and prose included", () => {
  for (const [name, text] of Object.entries(CONTROLS)) {
    assert.deepEqual(scanFresh({ "fresh.ts": text }), [], name);
  }
});

test("CONFORMANCE NEGATIVE: a constant suffix defined in ANOTHER file is followed", () => {
  const sites = scanFresh({
    "suffixes.ts": 'export const RECORD_SUFFIX = ".json";',
    "use.ts":
      'import { RECORD_SUFFIX } from "./suffixes.js";\nexport const f = (n: string) => n.endsWith(RECORD_SUFFIX);',
  });
  assert.deepEqual(
    sites.map((site) => site.file),
    ["use.ts"],
  );
});

test('CONFORMANCE NEGATIVE (per occurrence, the TE\'s R2): a NEW `name.endsWith(".json")` in another function of an exempted file is flagged — same variable name, same text', () => {
  const exempted = `export function readSeatArchiveLedger(names: string[]) {
  return names.filter((name) => name.endsWith(".json"));
}`;
  const another = `export function unfoldRacedHolders(names: string[]) {
  return names.filter((name) => name.endsWith(".json"));
}`;
  const exempt = {
    'seat-archive.ts::readSeatArchiveLedger::name.endsWith(".json")': {
      why: "the seat-archive dir",
    },
  };
  // twin: only the exempted occurrence — clean, and its count is exactly right
  const alone = scanFresh({ "seat-archive.ts": exempted });
  assert.deepEqual(unexemptedSuffixTests(alone, exempt), []);
  assert.deepEqual(wrongExemptionCounts(alone, exempt), []);
  // the TE's case: the same text, another function
  const both = scanFresh({ "seat-archive.ts": `${exempted}\n${another}` });
  assert.deepEqual(unexemptedSuffixTests(both, exempt), [
    'seat-archive.ts::unfoldRacedHolders::name.endsWith(".json") (1 occurrence(s), 0 exempted)',
  ]);
  // …and a SECOND identical occurrence inside the exempted function itself
  const doubled = scanFresh({
    "seat-archive.ts": `export function readSeatArchiveLedger(a: string[], b: string[]) {
  return [a.filter((name) => name.endsWith(".json")), b.filter((name) => name.endsWith(".json"))];
}`,
  });
  assert.deepEqual(unexemptedSuffixTests(doubled, exempt), [
    'seat-archive.ts::readSeatArchiveLedger::name.endsWith(".json") (2 occurrence(s), 1 exempted)',
  ]);
});

test("CONFORMANCE: the same row against the REAL tree — a new `.json` filter in unfoldRacedHolders would be flagged (the exemption is keyed to readSeatArchiveLedger)", () => {
  const injected: Site = {
    file: "session/persistence/seat-archive.ts",
    fn: "unfoldRacedHolders",
    text: 'name.endsWith(".json")',
  };
  const sites = [...jsonSuffixSites(parsed, constants), injected];
  assert.deepEqual(unexemptedSuffixTests(sites, JSON_SUFFIX_EXEMPT), [
    'session/persistence/seat-archive.ts::unfoldRacedHolders::name.endsWith(".json") (1 occurrence(s), 0 exempted)',
  ]);
});

// ---- the inventory of directory listings: per CALL SITE (file::function), each says what it lists ----

/** Lists the sessions directory and treats the names as session records: must use the predicate. */
type Listing = { records: true } | { records: false; lists: string };
const NOT = (lists: string): Listing => ({ records: false, lists });
const PROC = NOT("/proc");

const LISTING_INVENTORY: Readonly<Record<string, Listing>> = {
  "session/persistence/index.ts::listSessionRecordFiles": { records: true },
  "session/archive/retention.ts::scanSessionDir": { records: true }, // every name, to CLAIM them to ids; the record read is behind the predicate (readRecordCandidates)
  "cli/queue/lease-removal.ts::listQueues": NOT("the queues directory (<key>.lock lease files)"),
  "cli/queue/lease-removal.ts::sessionLookup": NOT(
    "every name in the hot and archive directories, to map a queue key to a session (residue-only sessions included); it reads no record and its `<id>.json` check only ranks hits",
  ),
  "cli/transcripts-dedup.ts::readDirents": { records: true }, // indexRecordFiles filters its entries through the predicate
  "session/persistence/repository.ts::unlinkHardDeletedFiles": NOT(
    "per-id stream-file lookup by id prefix",
  ),
  "session/persistence/repository.ts::pruneSessions": NOT("per-id stream-file lookup by id prefix"),
  "session/persistence/seat-archive.ts::readSeatArchiveLedger": NOT("the seat-archive dir"),
  "session/persistence/seat-archive.ts::unfoldRacedHolders": NOT(
    "a Set of hot names for `<id>.json` existence checks (Set.has)",
  ),
  "session/persistence/seat-archive.ts::reconcileSeatArchive": NOT(
    "a Set of hot names for `<id>.json` existence checks (Set.has)",
  ),
  "session/persistence/identity-file-lock.ts::sweepOwnPodLocks": NOT("lock directories"),
  "session/archive/archive-index.ts::listArchiveIndexShardKeys": NOT("ARCHIVE-INDEX shards"),
  "session/archive/compression-reconcile.ts::planReconcile": NOT(
    "archive dir, claimed to ids by longest prefix",
  ),
  "session/archive/compress-sweep.ts::idsPresentInHot": NOT(
    "hot dir claimed to ids by longest prefix",
  ),
  "session/archive/compress-sweep.ts::scanArchive": NOT(
    "archive dir, claimed to ids by longest prefix",
  ),
  "session/archive/compress-sweep.ts::removeStaleStaging": NOT("the COMPRESSION staging dir"),
  "session/archive/compress-sweep.ts::rewriteShardBytes": NOT("ARCHIVE-INDEX shards"),
  "session/archive/compress-sweep.ts::listZstTargets": NOT("`.zst` names in the archive"),
  "session/archive/operations.ts::runRestore": NOT("archive dir, claimed to ids by longest prefix"),
  "session/archive/operations.ts::archiveStatus": NOT(
    "archive dir, claimed to ids by longest prefix",
  ),
  "session/archive/operations.ts::listArchivedOrphans": NOT(
    "archive dir, claimed to ids by longest prefix",
  ),
  "session/archive/operations.ts::measureDir": NOT("sizes of a directory's files"),
  "session/archive/operations.ts::verifyEveryZst": NOT("`.zst` names in the archive"),
  "session/archive/operations.ts::reindexArchive": NOT(
    "archive dir, claimed to ids by longest prefix",
  ),
  "session/archive/thaw.ts::assertThawTarget": NOT("the thaw target dir is empty"),
  "session/archive/thaw.ts::planThaw": NOT("archive dir, claimed to ids by longest prefix"),
  "cli/session/agent-folders-migrate.ts::readDirOrThrow": NOT("the agent-folders tree"),
  "cli/session/agent-folders-migrate.ts::mergeDirectory": NOT("the agent-folders tree"),
  "cli/session/agent-folders-migrate.ts::classifyDirectory": NOT("the agent-folders tree"),
  "cli/session/owner-exit-transcript-reap.ts::listLiveGroupMembers": PROC,
  "config/transcript-dedup.ts::writerHoldsOpen": PROC,
  "config/transcript-dedup.ts::processHoldsWriter": PROC,
  "config/transcript-dedup.ts::findMatchingExitTailFile": NOT("a transcript directory"),
  "acp/claude-fork-index.ts::readSubagentUuids": NOT("the claude subagents directory"),
  "acp/harness-config-dir.ts::releaseHarnessConfigDir": NOT("harness holder directories"),
  "acp/harness-config-dir.ts::piConfigDirsUnder": NOT("harness config directories"),
  "acp/harness-config-dir.ts::findFileWithSuffix": NOT("a harness config directory"),
  "acp/harness-config-dir.ts::findStrandedPiTranscripts": NOT("pi transcript directories"),
  "acp/harness-config-dir.ts::seedPiExtensions": NOT("a harness extensions directory"),
  "capacity/governor/notify.ts::readOutbox": NOT("the governor outbox"),
  "capacity/governor/record.ts::pendingPeaksDays": NOT("the governor peaks dir"),
  "capacity/governor/run.ts::refreshCensus": NOT("the governor queue dir"),
  "capacity/governor/scan.ts::streamingScanner": PROC,
  "capacity/leases.ts::readProcessTable": PROC,
  "capacity/leases.ts::listLeaseFiles": NOT("capacity lease files"),
  "capacity/ledger.ts::pruneOldLogs": NOT("the capacity log dir"),
  "capacity/waiting.ts::readWaiting": NOT("the capacity waiting dir"),
  "pod/routed-call.ts::sweepRoutedPayloads": NOT("the routed-call payload dir"),
  "process-population.ts::scanLiveProcesses": PROC,
  "process-population.ts::scanLivePids": PROC,
  "process-tree-reap.ts::listDir": PROC,
  "session/scratch-reaper.ts::newestMtimeMs": NOT("session scratch directories"),
  "session/scratch-reaper.ts::listEntries": NOT("session scratch directories"),
};

const siteKey = (site: Site): string => `${site.file}::${site.fn}`;
const uniqueKeys = (sites: readonly Site[]): string[] =>
  [...new Set(sites.map(siteKey))].toSorted();

/** `file::function` → how many listing calls it holds (so a SECOND call in a classified function is a new site too). */
const callCounts = (sites: readonly Site[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const site of sites) {
    counts[siteKey(site)] = (counts[siteKey(site)] ?? 0) + 1;
  }
  return counts;
};
/** The classified functions that hold more than one listing call (every other holds exactly one). */
const CALLS_PER_FUNCTION: Readonly<Record<string, number>> = {
  "acp/harness-config-dir.ts::findStrandedPiTranscripts": 2,
};

test("CONFORMANCE: every call under src/ that lists a directory is classified PER CALL SITE (file::function) — a new one must say what it lists", () => {
  assert.deepEqual(uniqueKeys(listingSites(parsed)), Object.keys(LISTING_INVENTORY).toSorted());
  const expected = Object.fromEntries(
    Object.keys(LISTING_INVENTORY).map((name) => [name, CALLS_PER_FUNCTION[name] ?? 1]),
  );
  assert.deepEqual(callCounts(listingSites(parsed)), expected);
});

test("CONFORMANCE NEGATIVE: a SECOND listing call inside an already-classified function is flagged (the seat-archive case)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-dj-second-"));
  fs.writeFileSync(
    path.join(root, "seat-archive.ts"),
    'import fs from "node:fs/promises";\nexport async function unfoldRacedHolders(a: string, b: string) {\n  return [await fs.readdir(a), await fs.readdir(b)];\n}\n',
  );
  const counts = callCounts(listingSites(parseTree(root)));
  assert.deepEqual(counts, { "seat-archive.ts::unfoldRacedHolders": 2 });
  assert.notDeepEqual(
    counts,
    { "seat-archive.ts::unfoldRacedHolders": 1 },
    "the classified function holds ONE call",
  );
});

test("CONFORMANCE: a classified record enumerator really USES the predicate — a reference in code, a mention in a comment does not count", () => {
  for (const [siteName, entry] of Object.entries(LISTING_INVENTORY)) {
    if (entry.records) {
      const file = siteName.split("::")[0] ?? "";
      const tree = parsed.find((candidate) => candidate.relative === file);
      assert.ok(tree, file);
      assert.equal(
        referencesOf(tree.sf, "isSessionRecordFileName") > 0,
        true,
        `${file} enumerates session records without isSessionRecordFileName`,
      );
    }
  }
});

const LISTING_SPELLINGS: Readonly<Record<string, string>> = {
  readdir: 'import fs from "node:fs/promises";\nexport const f = (d: string) => fs.readdir(d);',
  readdirSync: 'import fs from "node:fs";\nexport const f = (d: string) => fs.readdirSync(d);',
  opendir: 'import fs from "node:fs";\nexport const f = (d: string) => fs.opendirSync(d);',
  "an import alias":
    'import { readdir as ls } from "node:fs/promises";\nexport const f = (d: string) => ls(d);',
  "a bound copy":
    'import fs from "node:fs";\nconst list = fs.readdirSync;\nexport const f = (d: string) => list(d);',
  "a destructured copy":
    'import fs from "node:fs";\nconst { readdirSync: scan } = fs;\nexport const f = (d: string) => scan(d);',
  "fs.globSync":
    'import fs from "node:fs";\nexport const f = (d: string) => fs.globSync("*.md", { cwd: d });',
  "fs.promises.glob":
    'import fs from "node:fs";\nexport const f = (d: string) => fs.promises.glob("*.md", { cwd: d });',
  "a promisified copy":
    'import fs from "node:fs";\nimport { promisify } from "node:util";\nconst ls = promisify(fs.readdir);\nexport const f = (d: string) => ls(d);',
};

for (const [name, text] of Object.entries(LISTING_SPELLINGS)) {
  test(`CONFORMANCE NEGATIVE (listing): a fresh file listing a directory through ${name} is flagged without being registered`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-dj-listing-"));
    fs.writeFileSync(path.join(root, "fresh.ts"), text);
    assert.deepEqual(uniqueKeys(listingSites(parseTree(root))), ["fresh.ts::f"]);
  });
}

test("CONFORMANCE: a comment mentioning the predicate is not a use of it (the row above is blind to prose); a real reference is", () => {
  const sf = (text: string) => ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true);
  assert.equal(
    referencesOf(
      sf("// uses isSessionRecordFileName\nexport const f = 1;"),
      "isSessionRecordFileName",
    ),
    0,
  );
  assert.equal(
    referencesOf(sf('const s = "isSessionRecordFileName";'), "isSessionRecordFileName"),
    0,
  );
  assert.equal(
    referencesOf(
      sf(
        'import { isSessionRecordFileName } from "./x.js";\nexport const f = (n: string) => isSessionRecordFileName(n);',
      ),
      "isSessionRecordFileName",
    ),
    1,
    "the import does not count, the call does",
  );
  assert.equal(
    referencesOf(
      sf("export const g = names.filter(isSessionRecordFileName);"),
      "isSessionRecordFileName",
    ),
    1,
  );
});
