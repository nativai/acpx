import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrickOutbox } from "../../src/brick-outbox.js";
assert.ok(os.homedir().startsWith("/workspace/bricksdb-b14-selftest/"));
const outbox = new BrickOutbox();
const marker = path.join(os.homedir(), "holder-acted");
const holder = fork("test/fixtures/b14-lock-holder.mjs", [outbox.dbPath, marker], {
  execArgv: [],
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
const exit = new Promise((resolve) => holder.once("exit", resolve));
let acted = 0;
try {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(marker) && Date.now() < deadline && holder.exitCode === null)
    {await new Promise((resolve) => setTimeout(resolve, 10));}
  if (!fs.existsSync(marker)) {
    console.error("EXAMINED NOTHING");
    process.exitCode = 2;
  } else {
    acted++;
    assert.throws(() => outbox.setDrain("contender"), /outbox-busy/);
    acted++;
    await new Promise((resolve) => setTimeout(resolve, 5200));
    assert.equal(holder.exitCode, null);
    assert.throws(() => outbox.setDrain("late-contender"), /outbox-busy/);
    acted++;
    holder.kill("SIGKILL");
    await exit;
    outbox.setDrain("owner-death-control");
    acted++;
    assert.equal(outbox.inventory().drain?.cutover_id, "owner-death-control");
  }
} finally {
  if (holder.exitCode === null && holder.signalCode === null) {
    holder.kill("SIGKILL");
    await exit;
  }
  outbox.close();
}
if (!acted) {
  console.error("EXAMINED NOTHING");
  process.exitCode = 2;
}
console.log(`ACTED=${acted}`);
