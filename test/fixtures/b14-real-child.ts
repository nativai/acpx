import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrickOutbox } from "../../src/brick-outbox.js";
import { parseSessionRecord } from "../../src/session/persistence/parse.js";

assert.ok(os.homedir().startsWith("/workspace/bricksdb-b14-selftest/"));
const outbox = new BrickOutbox();
const revoked = process.argv[2] === "revoked";
const target = "33333333-3333-4333-8333-333333333333";
const marker = path.join(os.homedir(), "adapter-reached");
const release = path.join(os.homedir(), "adapter-release");
const attempt = outbox.reserveSpawn({
  run_id: "real-run",
  fence: 1,
  trigger_id: "fixture",
  parent_brick_id: "fixture",
  child_brick_id: "fixture",
  target_record_id: target,
});
const command = `node ${path.resolve("test/fixtures/b14-acp-barrier.mjs")} ${marker} ${release}`;
const child = spawn(
  process.execPath,
  [
    "dist/cli.js",
    "--agent",
    command,
    "--approve-all",
    "--format",
    "json",
    "--cwd",
    os.homedir(),
    "sessions",
    "new",
    "--name",
    "b14-child",
    "--record-id",
    target,
    "--no-brick",
    "--metadata",
    `spawn_key=${attempt.idempotency_key}`,
  ],
  {
    env: { PATH: process.env.PATH, HOME: os.homedir() },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stdout = "";
let stderr = "";
child.stdout.on("data", (data: Buffer) => {
  stdout += data.toString();
});
child.stderr.on("data", (data: Buffer) => {
  stderr += data.toString();
});
const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
await new Promise<void>((resolve, reject) => {
  child.once("spawn", () => {
    try {
      outbox.recordSpawnChild("real-run", 1, child.pid!);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
  child.once("error", reject);
});
let acted = 0;
try {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null)
    {await new Promise((resolve) => setTimeout(resolve, 20));}
  if (!fs.existsSync(marker)) {
    console.error(`EXAMINED NOTHING: adapter did not reach barrier\n${stdout}\n${stderr}`);
    process.exitCode = 2;
  } else {
    acted++;
    console.log("ACTORS=1");
    assert.equal(outbox.readRecord(target), undefined);
    assert.equal(outbox.spawnChildLiveness("real-run", 1), "alive");
    if (revoked) {outbox.transitionSpawn("real-run", 1, "revoked");}
    fs.writeFileSync(release, "release");
    const code = await exited;
    if (revoked) {
      assert.notEqual(code, 0, stdout + stderr);
      assert.equal(outbox.readRecord(target), undefined);
    } else {
      assert.equal(code, 0, stdout + stderr);
      const raw = outbox.readRecord(target);
      assert.ok(parseSessionRecord(raw));
      assert.equal(raw?.acpx_record_id, target);
      assert.notEqual(raw?.acp_session_id, target);
      assert.equal(raw?.metadata?.spawn_state, "pending");
      outbox.transitionSpawn("real-run", 1, "published");
      outbox.transitionSpawn("real-run", 1, "adopted");
    }
    acted++;
  }
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
  outbox.close();
}
if (acted === 0) {
  console.error("EXAMINED NOTHING");
  process.exitCode = 2;
}
console.log(`PHASES=${acted} real-child=${revoked ? "revoked" : "positive"}`);
