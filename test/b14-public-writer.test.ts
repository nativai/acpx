import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { after } from "node:test";

let actors = 0;
after(() => {
  if (actors === 0) {
    process.stderr.write("EXAMINED NOTHING\n");
    process.exit(2);
  }
});

for (const mode of ["bound", "unbound", "alias", "repository", "state-home", "opaque"]) {
  test(`canonical writer exclusion: ${mode}`, () => {
    const root = "/workspace/bricksdb-b14-selftest";
    fs.mkdirSync(root, { recursive: true });
    const home = fs.mkdtempSync(path.join(root, `writer-${mode}-`));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "test/fixtures/b14-public-writer-proof.ts", mode],
      {
        env: { PATH: process.env.PATH, HOME: home },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    if (!result.stdout.includes('"actors":1')) {
      process.stderr.write(`EXAMINED NOTHING\n${result.stderr}`);
      process.exit(2);
    }
    actors++;
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
