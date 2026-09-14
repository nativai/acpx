import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

for (const scenario of [
  "drain-exit",
  "frontier",
  "lookup-error",
  "gate",
  "projection",
  "drain",
  "rename-cut",
  "superseded",
  "spawn",
  "receipt-conflict",
  "initial-prompt",
  "ownership",
]) {
  test(`B14 ${scenario}`, () => {
    const root = "/workspace/bricksdb-b14-selftest";
    fs.mkdirSync(root, { recursive: true });
    const home = fs.mkdtempSync(path.join(root, `${scenario}-`));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "test/fixtures/brick-outbox-worker.ts", scenario],
      {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ACTED=[1-9]\d*/);
  });
}

for (const scenario of ["positive", "revoked"]) {
  test(`B14 real child ${scenario}`, () => {
    const root = "/workspace/bricksdb-b14-selftest";
    fs.mkdirSync(root, { recursive: true });
    const home = fs.mkdtempSync(path.join(root, `real-${scenario}-`));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "test/fixtures/b14-real-child.ts", scenario],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, HOME: home },
        encoding: "utf8",
        timeout: 20000,
      },
    );
    if (!/ACTORS=1/.test(result.stdout)) {
      console.error("EXAMINED NOTHING");
      process.exitCode = 2;
      assert.fail(`real-child proof had no observed actor: ${result.stderr}`);
    }
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PHASES=2/);
  });
}

test("B14 live holder beyond 5 seconds and owner-death recovery", () => {
  const root = "/workspace/bricksdb-b14-selftest";
  fs.mkdirSync(root, { recursive: true });
  const home = fs.mkdtempSync(path.join(root, "lock-"));
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "test/fixtures/b14-lock-proof.ts"],
    {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: home },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /ACTED=4/);
});
