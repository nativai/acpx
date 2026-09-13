import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("initial prompt routes to the adopted replacement and keeps immutable run content", () => {
  const root = "/workspace/bricksdb-b14-selftest";
  fs.mkdirSync(root, { recursive: true });
  const home = fs.mkdtempSync(path.join(root, "prompt-target-test-"));
  const result = spawnSync(process.execPath, ["--import", "tsx", "probe/b14/prompt-target.ts"], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      B14_OUTBOX_MODULE: path.resolve("src/brick-outbox.ts"),
    },
    encoding: "utf8",
    timeout: 15000,
  });
  const observations = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const observed = observations.find((row) => row.actors === 1);
  if (!observed || observed.subjectCalls !== 1) {
    process.stderr.write(`EXAMINED NOTHING\n${result.stderr}`);
    process.exit(2);
  }
  assert.equal(observed.controlCalls, 1);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(observed.actualTarget, "22222222-2222-4222-8222-222222222222");
});
