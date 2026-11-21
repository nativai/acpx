import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// brick 8d85cb47 — the lock module the atrium server loads IN-PROCESS (EXPORT-lock-module.md v1,
// agreed 2026-11-21). Two binding requirements from the atrium stream: (1) no SQLite anywhere in the
// BUILT entry's import graph — atrium loads it on any path; (2) the agreed surface, stable. Walks the
// graph as SHIPPED (`pnpm test` builds dist/ first), like test/governor-import-graph.test.ts.
//
// ⚠️ THE STRING SCAN IS DELIBERATE: acpx loads SQLite through `createRequire(...)("node:sqlite")`
// (src/spawn-ledger.ts), which no import-specifier pattern sees. Any file of the graph that so much
// as names a SQLite module fails this test — the conservative direction. The positive control runs
// the same walk from dist/spawn-ledger.js, which must be caught.

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const ENTRY = path.join(DIST, "pod-lock.js");
const SPECIFIER =
  /(?:^|[\s;}])(?:import|export)\s*(?:[\w*{}\s,$]*?\bfrom\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu;
const SQLITE = /["'](?:node:sqlite|sqlite3?|better-sqlite3)["']/u;

function walk(entry: string): { files: string[]; sqlite: string[] } {
  const seen = new Set<string>();
  const sqlite: string[] = [];
  const stack = [entry];
  for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    if (SQLITE.test(source)) {
      sqlite.push(path.relative(DIST, file));
    }
    for (const match of source.matchAll(SPECIFIER)) {
      const spec = match[1] ?? match[2];
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(file), spec);
        if (fs.existsSync(target)) {
          stack.push(target);
        }
      }
    }
  }
  return { files: [...seen], sqlite };
}

test("the BUILT pod-lock entry's import graph names no SQLite module", () => {
  assert.ok(fs.existsSync(ENTRY), `${ENTRY} missing — run \`pnpm run build\` (pnpm test does)`);
  const graph = walk(ENTRY);
  assert.ok(graph.files.length >= 2, "positive control: the entry imports at least one chunk");
  assert.deepEqual(
    graph.sqlite,
    [],
    `SQLite reached from dist/pod-lock.js via ${graph.sqlite.join(", ")}`,
  );
});

test("positive control: the same walk from dist/spawn-ledger.js DOES find node:sqlite", () => {
  assert.notDeepEqual(walk(path.join(DIST, "spawn-ledger.js")).sqlite, []);
});

const PROBE = `
const before = process.moduleLoadList.filter((m) => /sqlite/i.test(m));
const mod = await import(process.argv[1]);
const after = process.moduleLoadList.filter((m) => /sqlite/i.test(m));
if (process.argv[2] === "control") { await import("node:sqlite"); }
const control = process.moduleLoadList.filter((m) => /sqlite/i.test(m));
console.log(JSON.stringify({ before, after, control, keys: Object.keys(mod).sort(), version: mod.POD_LOCK_API_VERSION }));
`;

function probe(mode = ""): {
  before: string[];
  after: string[];
  control: string[];
  keys: string[];
  version: unknown;
} {
  const out = execFileSync(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", PROBE, pathToFileURL(ENTRY).href, mode],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as ReturnType<typeof probe>;
}

test("loaded in a FRESH process, dist/pod-lock.js pulls no SQLite module into the process", () => {
  const result = probe();
  assert.deepEqual(result.before, []);
  assert.deepEqual(result.after, [], "no sqlite module after the import");
});

test("positive control: the fresh-process probe does see node:sqlite when something loads it", () => {
  assert.notDeepEqual(probe("control").control, []);
});

test("the agreed surface, exactly (EXPORT-lock-module.md v1) — change it only with both stream sub-HoDs", () => {
  const result = probe();
  assert.equal(result.version, 1);
  assert.deepEqual(result.keys, [
    "DEATH_PROOF_TIMEOUT_MS",
    "POD_LOCK_API_VERSION",
    "RECORD_LOCK_BUDGET_MS",
    "isRecordLockTimeout",
    "ownPodIdentity",
    "proveDeath",
    "sweepOwnPodLocks",
    "withRecordFileLock",
  ]);
});

test("`acpx __pod-lock-module` prints the file: URL of that same entry", () => {
  const url = execFileSync(process.execPath, [path.join(DIST, "cli.js"), "__pod-lock-module"], {
    encoding: "utf8",
  }).trim();
  assert.equal(url, pathToFileURL(ENTRY).href);
});
