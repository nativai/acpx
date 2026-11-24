import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "../src/capacity/governor/classify.js";
import { loadOpenRouterCatalogue } from "../src/models/openrouter-catalogue.js";
import { writeRoutedPayload } from "../src/pod/routed-call.js";
import { rewriteArchiveReadme } from "../src/session/archive/compress-sweep.js";
import { uniqueTempPath, writeFileReplacingSync } from "../src/temp-name.js";
import { findPidOnlyTempNames } from "./pod-source-scan.js";

// Block A11 / A-67 row 67.4: every temp name carries a random part, never ends in `.json`, and stays in
// its target's directory. Two writers with the same pid (stubbed) get different names.

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

function scratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `a11-${label}-`));
}

test("the discovering check: acpx's source has no pid-only temp name", () => {
  assert.deepEqual(findPidOnlyTempNames(SRC_ROOT), []);
});

test("the discovering check is RED on a planted pid-only temp name, clean on one with a random part", () => {
  const root = scratch("scan");
  fs.writeFileSync(
    path.join(root, "bad.ts"),
    "const tmpPath = `${cachePath}.${process.pid}.tmp`;\nconst other = `${f}.${process.pid}.${Date.now()}.tmp`;\n",
  );
  fs.writeFileSync(
    path.join(root, "good.ts"),
    "const tmp = `${f}.${process.pid}.${randomUUID()}.tmp`;\n// const old = `${f}.${process.pid}.tmp`;\nconst log = `pid ${process.pid}`;\n",
  );
  assert.deepEqual(findPidOnlyTempNames(root), ["bad.ts:1", "bad.ts:2"]);
});

test("uniqueTempPath: same pid, same target → different names; same directory; never .json", () => {
  const target = "/some/dir/cache.json";
  const a = uniqueTempPath(target);
  const b = uniqueTempPath(target);
  assert.notEqual(a, b);
  for (const name of [a, b]) {
    assert.equal(path.dirname(name), path.dirname(target));
    assert.equal(name.endsWith(".json"), false);
    assert.equal(name.endsWith(".tmp"), true);
  }
});

test("writeFileReplacingSync publishes the file, leaves no temp, and cleans up on a failed write", () => {
  const dir = scratch("write");
  const target = path.join(dir, "cache.json");
  writeFileReplacingSync(target, "one\n");
  writeFileReplacingSync(target, "two\n", { mode: 0o600 });
  assert.equal(fs.readFileSync(target, "utf8"), "two\n");
  assert.deepEqual(fs.readdirSync(dir), ["cache.json"]);
  // A failing rename: the target is a non-empty directory.
  const blocked = path.join(dir, "blocked");
  fs.mkdirSync(path.join(blocked, "inside"), { recursive: true });
  assert.throws(() => writeFileReplacingSync(blocked, "x\n"));
  assert.deepEqual(
    fs.readdirSync(dir).toSorted(),
    ["blocked", "cache.json"],
    "no *.tmp left behind",
  );
});

test("the routed payload (C2): published under its final name, mode 0600, no temp left, also on a failed rename", () => {
  const dir = scratch("payload");
  const final = writeRoutedPayload(dir, "call-1", "hello");
  assert.equal(path.basename(final), "call-1.payload");
  assert.equal(fs.statSync(final).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["call-1.payload"]);
  fs.mkdirSync(path.join(dir, "call-2.payload", "inside"), { recursive: true });
  assert.throws(() => writeRoutedPayload(dir, "call-2", "hello"));
  assert.deepEqual(fs.readdirSync(dir).toSorted(), ["call-1.payload", "call-2.payload"]);
});

// ---- the writers that built a temp name from the pid alone (row 67.4) ----

test("the cache and governor writers still publish their file, leave no temp, and a stale temp of another pod's writer is not touched", async () => {
  const dir = scratch("sites");
  // catalogue cache, through the public loader with an injected fetch
  const cachePath = path.join(dir, "openrouter-models.json");
  const loaded = await loadOpenRouterCatalogue({
    cachePath,
    fetchModels: async () => ({ fetchedAt: new Date().toISOString(), models: [] }),
  });
  assert.equal(loaded.error, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")).models, []);
  // governor state file
  const gov = path.join(dir, "groups.json");
  writeFileAtomic(gov, "[]\n");
  assert.equal(fs.readFileSync(gov, "utf8"), "[]\n");
  // archive README, with a same-pid, same-target temp already on disk: the new writer uses another name
  const archive = path.join(dir, "archive");
  fs.mkdirSync(archive);
  const squatter = `${path.join(archive, "README.md")}.${process.pid}.tmp`;
  fs.writeFileSync(squatter, "another pod's half-written temp");
  const warnings: string[] = [];
  await rewriteArchiveReadme(archive, warnings);
  assert.deepEqual(warnings, []);
  assert.match(fs.readFileSync(path.join(archive, "README.md"), "utf8"), /\S/);
  assert.equal(fs.readFileSync(squatter, "utf8"), "another pod's half-written temp");
  assert.deepEqual(fs.readdirSync(dir).toSorted(), [
    "archive",
    "groups.json",
    "openrouter-models.json",
  ]);
  assert.deepEqual(
    fs.readdirSync(archive).toSorted(),
    [path.basename(squatter), "README.md"].toSorted(),
  );
});
