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
    "reconcileSessionIndexFromDisk",
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

function recordText(id: string, extra: { closed?: boolean; lastUsedAt?: string } = {}): string {
  const record = {
    ...makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `acp-${id}`,
      agentCommand: "agent",
      cwd: "/tmp/projection",
      ...(extra.lastUsedAt ? { lastUsedAt: extra.lastUsedAt } : {}),
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

// ---- brick 5e64449b: the batch holds the index lock for time that scales with the BATCH, not the store ----

const STORE_SIZE = 1500;

async function seedLargeStore(dir: string): Promise<string[]> {
  await fsp.mkdir(dir, { recursive: true });
  const names: string[] = [];
  for (let i = 0; i < STORE_SIZE; i += 1) {
    const id = `big-${String(i).padStart(5, "0")}`;
    names.push(`${id}.json`);
    await fsp.writeFile(path.join(dir, `${id}.json`), recordText(id));
  }
  const { reconcileSessionIndexFromDisk } = await import("../src/index-projection.js");
  await reconcileSessionIndexFromDisk(dir);
  return names;
}

type FsSpy = { recordReads: string[]; dirReads: number; stop: () => void };

/** Counts the record files read and the directory listings made through `fs/promises` while it is on. */
function spyFs(dir: string): FsSpy {
  const spy: FsSpy = { recordReads: [], dirReads: 0, stop: () => undefined };
  const realRead = fsp.readFile;
  const realReaddir = fsp.readdir;
  fsp.readFile = (async (...args: Parameters<typeof fsp.readFile>) => {
    const file = typeof args[0] === "string" ? args[0] : "";
    // the seat store is read once by the index writer's name projection — not a record
    if (
      path.dirname(file) === dir &&
      file.endsWith(".json") &&
      !/(?:index|seats)\.json$/u.test(file)
    ) {
      spy.recordReads.push(path.basename(file));
    }
    return await realRead(...args);
  }) as typeof fsp.readFile;
  fsp.readdir = (async (...args: Parameters<typeof fsp.readdir>) => {
    if (args[0] === dir) {
      spy.dirReads += 1;
    }
    return await realReaddir(...args);
  }) as typeof fsp.readdir;
  spy.stop = () => {
    fsp.readFile = realRead;
    fsp.readdir = realReaddir;
  };
  return spy;
}

test("a 3-file batch on a large store reads ONLY the 3 named records and never lists the directory", async () => {
  await withTempHome("acpx-projection-scale-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    const names = await seedLargeStore(dir);
    const batch = [names[10] ?? "", names[700] ?? "", names[1400] ?? ""];
    const { projectRecordFilesIntoIndex } = await import("../src/index-projection.js");
    const spy = spyFs(dir);
    try {
      await projectRecordFilesIntoIndex(dir, batch);
    } finally {
      spy.stop();
    }
    assert.deepEqual(
      spy.recordReads.toSorted((a, b) => a.localeCompare(b)),
      batch,
    );
    assert.equal(spy.dirReads, 0, "no whole-store reconcile inside the batch");
  });
});

test("other sessions' rows are byte-identical after a batch; the named row is re-projected", async () => {
  await withTempHome("acpx-projection-identical-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    const names = await seedLargeStore(dir);
    const { projectRecordFilesIntoIndex, readSessionIndex } =
      await import("../src/index-projection.js");
    const before = await readSessionIndex(dir);
    assert.equal(before?.entries.length, STORE_SIZE);
    await fsp.writeFile(path.join(dir, names[5] ?? ""), recordText("big-00005", { closed: true }));
    await projectRecordFilesIntoIndex(dir, [names[5] ?? ""]);
    const after = await readSessionIndex(dir);
    const rowOf = (index: Awaited<ReturnType<typeof readSessionIndex>>, file: string) =>
      JSON.stringify(index?.entries.find((entry) => entry.file === file));
    for (const file of names) {
      if (file !== names[5]) {
        assert.equal(rowOf(after, file), rowOf(before, file), file);
      }
    }
    assert.notEqual(rowOf(after, names[5] ?? ""), rowOf(before, names[5] ?? ""));
    assert.equal(after?.entries.find((entry) => entry.file === names[5])?.closed, true);
    assert.deepEqual(after?.files, before?.files, "membership unchanged");
  });
});

test("a named record that was DELETED has its row and its files entry removed; the others stay", async () => {
  await withTempHome("acpx-projection-deleted-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    const names = await seedLargeStore(dir);
    const { projectRecordFilesIntoIndex, readSessionIndex } =
      await import("../src/index-projection.js");
    await fsp.rm(path.join(dir, names[20] ?? ""));
    await projectRecordFilesIntoIndex(dir, [names[20] ?? "", names[21] ?? ""]);
    const after = await readSessionIndex(dir);
    assert.equal(
      after?.entries.some((entry) => entry.file === names[20]),
      false,
    );
    assert.equal(after?.files.includes(names[20] ?? ""), false);
    assert.equal(
      after?.entries.some((entry) => entry.file === names[21]),
      true,
    );
    assert.equal(after?.entries.length, STORE_SIZE - 1);
  });
});

test("an UNPARSABLE named record is skipped and its existing row kept (large store)", async () => {
  await withTempHome("acpx-projection-torn-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    const names = await seedLargeStore(dir);
    const { projectRecordFilesIntoIndex, readSessionIndex } =
      await import("../src/index-projection.js");
    const before = await readSessionIndex(dir);
    await fsp.writeFile(path.join(dir, names[30] ?? ""), "{torn");
    await projectRecordFilesIntoIndex(dir, [names[30] ?? ""]);
    const after = await readSessionIndex(dir);
    const row = (index: Awaited<ReturnType<typeof readSessionIndex>>) =>
      JSON.stringify(index?.entries.find((entry) => entry.file === names[30]));
    assert.equal(row(after), row(before));
    assert.equal(after?.files.includes(names[30] ?? ""), true);
  });
});

test("the batch adds a NEW named record, but does not reconcile files it was not asked about — that is the rarer path", async () => {
  await withTempHome("acpx-projection-rare-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    await seedLargeStore(dir);
    const { projectRecordFilesIntoIndex, reconcileSessionIndexFromDisk, readSessionIndex } =
      await import("../src/index-projection.js");
    await fsp.writeFile(path.join(dir, "named-new.json"), recordText("named-new"));
    await fsp.writeFile(path.join(dir, "unnamed-new.json"), recordText("unnamed-new"));
    await projectRecordFilesIntoIndex(dir, ["named-new.json"]);
    let index = await readSessionIndex(dir);
    assert.equal(
      index?.entries.some((entry) => entry.file === "named-new.json"),
      true,
    );
    assert.equal(
      index?.files.includes("unnamed-new.json"),
      false,
      "NEGATIVE: the batch does not scan the directory for strangers",
    );
    assert.deepEqual(await reconcileSessionIndexFromDisk(dir), { drift: true });
    index = await readSessionIndex(dir);
    assert.equal(
      index?.entries.some((entry) => entry.file === "unnamed-new.json"),
      true,
    );
    assert.deepEqual(await reconcileSessionIndexFromDisk(dir), { drift: false });
  });
});

test("names that are not a plain record file are ignored — never read outside the sessions directory", async () => {
  await withTempHome("acpx-projection-names-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(homeDir, "outside.json"), recordText("outside"));
    const { projectRecordFilesIntoIndex, sessionIndexPath } =
      await import("../src/index-projection.js");
    assert.deepEqual(
      await projectRecordFilesIntoIndex(dir, [
        "../outside.json",
        "index.json",
        "seats.json",
        "x/y.json",
        "not-json.txt",
      ]),
      { files: 0 },
    );
    assert.equal(fs.existsSync(sessionIndexPath(dir)), false);
  });
});

test("the index rewrite keeps its order contract: newest-first by lastUsedAt, ties stable, an unordered list sorted, an ordered one untouched", async () => {
  await withTempHome("acpx-projection-order-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    await fsp.mkdir(dir, { recursive: true });
    const stamps: Record<string, string> = {
      "o-a": "2026-01-03T00:00:00.000Z",
      "o-b": "2026-01-01T00:00:00.000Z",
      "o-c": "2026-01-02T00:00:00.000Z",
      "o-d": "2026-01-02T00:00:00.000Z", // ties o-c: file order decides
    };
    for (const [id, lastUsedAt] of Object.entries(stamps)) {
      await fsp.writeFile(path.join(dir, `${id}.json`), recordText(id, { lastUsedAt }));
    }
    const { projectRecordFilesIntoIndex, readSessionIndex } =
      await import("../src/index-projection.js");
    await projectRecordFilesIntoIndex(dir, ["o-b.json", "o-d.json", "o-a.json", "o-c.json"]);
    const order = async () =>
      (await readSessionIndex(dir))?.entries.map((entry) => entry.acpxRecordId);
    assert.deepEqual(await order(), ["o-a", "o-c", "o-d", "o-b"]);
    // a re-projected row that becomes the newest moves to the top; the rest keep their order
    await fsp.writeFile(
      path.join(dir, "o-b.json"),
      recordText("o-b", { lastUsedAt: "2026-02-01T00:00:00.000Z" }),
    );
    await projectRecordFilesIntoIndex(dir, ["o-b.json"]);
    assert.deepEqual(await order(), ["o-b", "o-a", "o-c", "o-d"]);
    // an untouched batch leaves the order exactly as it is
    await projectRecordFilesIntoIndex(dir, ["o-c.json"]);
    assert.deepEqual(await order(), ["o-b", "o-a", "o-c", "o-d"]);
  });
});

test("F1: a named SYMLINK to a record outside the directory is never indexed, and a row it had is removed", async () => {
  await withTempHome("acpx-projection-symlink-", async (homeDir) => {
    const dir = path.join(homeDir, ".acpx", "sessions");
    await fsp.mkdir(dir, { recursive: true });
    const outside = path.join(homeDir, "elsewhere");
    await fsp.mkdir(outside, { recursive: true });
    await fsp.writeFile(path.join(outside, "linked.json"), recordText("linked"));
    await fsp.writeFile(path.join(dir, "real.json"), recordText("real"));
    await fsp.symlink(path.join(outside, "linked.json"), path.join(dir, "linked.json"));
    const { projectRecordFilesIntoIndex, readSessionIndex } =
      await import("../src/index-projection.js");
    await projectRecordFilesIntoIndex(dir, ["real.json"]); // builds the index (no link named yet)
    await projectRecordFilesIntoIndex(dir, ["real.json", "linked.json"]);
    const index = await readSessionIndex(dir);
    assert.equal(
      index?.entries.some((entry) => entry.file === "linked.json"),
      false,
      "no row for the link",
    );
    assert.equal(index?.files.includes("linked.json"), false, "not a member");
    assert.equal(
      index?.entries.some((entry) => entry.file === "real.json"),
      true,
      "NEGATIVE CONTROL: a regular file named in the same batch is indexed",
    );
  });
});
