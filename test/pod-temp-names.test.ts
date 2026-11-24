import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { uniqueTempPath, writeFileReplacingSync } from "../src/temp-name.js";

// Block A11 / A-67 row 67.4: every temp name carries a random part, never ends in `.json`, and stays in
// its target's directory. Two writers with the same pid (stubbed) get different names.

function scratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `a11-${label}-`));
}

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
