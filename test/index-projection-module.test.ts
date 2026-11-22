import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// block A8 → atrium S5 (brick 88112988): acpx's index projection, loaded IN-PROCESS by the atrium
// server. Same two binding requirements as the lock module: no SQLite in the BUILT graph, and the
// agreed surface, exactly. Walks the graph as SHIPPED (`pnpm test` builds dist/ first).

const DIST = fileURLToPath(new URL("../../dist/", import.meta.url));
const ENTRY = path.join(DIST, "index-projection.js");
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

test("the BUILT index-projection entry's import graph names no SQLite module", () => {
  assert.ok(fs.existsSync(ENTRY), `${ENTRY} missing — run \`pnpm run build\` (pnpm test does)`);
  const graph = walk(ENTRY);
  assert.ok(graph.files.length >= 2, "positive control: the entry imports at least one chunk");
  assert.deepEqual(graph.sqlite, [], `SQLite reached via ${graph.sqlite.join(", ")}`);
});

test("positive control: the same walk from dist/spawn-ledger.js DOES find node:sqlite", () => {
  assert.notDeepEqual(walk(path.join(DIST, "spawn-ledger.js")).sqlite, []);
});

const PROBE = `
const mod = await import(process.argv[1]);
const sqlite = process.moduleLoadList.filter((m) => /sqlite/i.test(m));
console.log(JSON.stringify({ keys: Object.keys(mod).sort(), version: mod.INDEX_PROJECTION_API_VERSION, sqlite }));
`;

function probe(): { keys: string[]; version: unknown; sqlite: string[] } {
  const out = execFileSync(
    process.execPath,
    ["--no-warnings", "--input-type=module", "-e", PROBE, pathToFileURL(ENTRY).href],
    { encoding: "utf8" },
  );
  return JSON.parse(out) as ReturnType<typeof probe>;
}

test("loaded in a FRESH process it pulls no SQLite module, and the surface is exactly the agreed one", () => {
  const result = probe();
  assert.deepEqual(result.sqlite, []);
  assert.equal(result.version, 1);
  assert.deepEqual(result.keys, [
    "INDEX_PROJECTION_API_VERSION",
    "isIndexLockTimeout",
    "projectRecordFilesIntoIndex",
    "projectRecordText",
    "readSessionIndex",
    "sessionIndexPath",
  ]);
});

test("`acpx __index-projection-module` prints the file: URL of that same entry", () => {
  const url = execFileSync(
    process.execPath,
    [path.join(DIST, "cli.js"), "__index-projection-module"],
    {
      encoding: "utf8",
    },
  ).trim();
  assert.equal(url, pathToFileURL(ENTRY).href);
});

function recordText(id: string, extra: { closed?: boolean } = {}): string {
  const record = {
    ...makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `acp-${id}`,
      agentCommand: "agent",
      cwd: "/tmp/projection",
    }),
    ...extra,
  };
  return JSON.stringify(serializeSessionRecordForDisk(record, { messages: "split-tail" }));
}

test("projectRecordText is acpx's own projection: the same entry the owner's write would queue", async () => {
  const { projectRecordText } = await import("../src/index-projection.js");
  const entry = projectRecordText(recordText("p1", { closed: true }), "p1.json");
  assert.equal(entry?.file, "p1.json");
  assert.equal(entry?.acpxRecordId, "p1");
  assert.equal(entry?.closed, true);
});

test("projectRecordText: text that is not a record projects to nothing (negative)", async () => {
  const { projectRecordText } = await import("../src/index-projection.js");
  assert.equal(projectRecordText("{not json", "x.json"), undefined);
  assert.equal(projectRecordText(JSON.stringify({ hello: "world" }), "x.json"), undefined);
});

test("a batch of N record files projects into the index in one call, from the records on disk", async () => {
  await withTempHome("acpx-projection-batch-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    await fsp.mkdir(dir, { recursive: true });
    const ids = ["b1", "b2", "b3", "b4"];
    for (const id of ids) {
      await fsp.writeFile(path.join(dir, `${id}.json`), recordText(id));
    }
    const { projectRecordFilesIntoIndex, readSessionIndex, sessionIndexPath } =
      await import("../src/index-projection.js");
    const result = await projectRecordFilesIntoIndex(
      dir,
      ids.map((id) => `${id}.json`),
    );
    assert.deepEqual(result, { files: 4 });
    const index = await readSessionIndex(dir);
    assert.deepEqual(index?.files, ids.map((id) => `${id}.json`));
    assert.deepEqual(index?.entries.map((entry) => entry.acpxRecordId).toSorted(), ids);
    const first = await fsp.stat(sessionIndexPath(dir));

    // a second batch after one record changed: one more rewrite, the changed row re-projected
    await fsp.writeFile(path.join(dir, "b2.json"), recordText("b2", { closed: true }));
    await projectRecordFilesIntoIndex(dir, ["b2.json"]);
    const again = await readSessionIndex(dir);
    assert.equal(again?.entries.find((entry) => entry.acpxRecordId === "b2")?.closed, true);
    assert.equal(again?.entries.find((entry) => entry.acpxRecordId === "b1")?.closed, false);
    assert.ok((await fsp.stat(sessionIndexPath(dir))).mtimeMs >= first.mtimeMs);
  });
});

test("an unreadable record in the batch keeps the index's existing row — never a snapshot, never a hole (negative)", async () => {
  await withTempHome("acpx-projection-unreadable-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "u1.json"), recordText("u1"));
    const { projectRecordFilesIntoIndex, readSessionIndex } =
      await import("../src/index-projection.js");
    await projectRecordFilesIntoIndex(dir, ["u1.json"]);
    await fsp.writeFile(path.join(dir, "u1.json"), "{torn");
    await projectRecordFilesIntoIndex(dir, ["u1.json"]);
    const index = await readSessionIndex(dir);
    assert.equal(index?.entries.find((entry) => entry.file === "u1.json")?.acpxRecordId, "u1");
  });
});

test("an empty batch writes nothing", async () => {
  await withTempHome("acpx-projection-empty-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    await fsp.mkdir(dir, { recursive: true });
    const { projectRecordFilesIntoIndex, sessionIndexPath } =
      await import("../src/index-projection.js");
    assert.deepEqual(await projectRecordFilesIntoIndex(dir, []), { files: 0 });
    assert.equal(fs.existsSync(sessionIndexPath(dir)), false);
  });
});
