// END-TO-END brick-trigger auto-spawn through the REAL CLI (brick d36c222f): a real
// `acpx sessions new --record-id` child creates the spawn-owned record, the attempt is
// published and adopted, the queued initial prompt is released through a real `acpx prompt`,
// and the owner's cold session/resume MISSES and falls back to session/new — the normal shape.
// The agent must receive the initial prompt exactly once.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpawnLedger } from "../../src/spawn-ledger.js";

assert.ok(os.homedir().startsWith("/workspace/spawn-ledger-selftest/"));
const home = os.homedir();
fs.mkdirSync(path.join(home, ".acpx"), { recursive: true });
fs.writeFileSync(
  path.join(home, ".acpx", "instance.json"),
  JSON.stringify({ instance_id: "i-111111111111", home }),
);
const ledger = new SpawnLedger();
ledger.bindIdentity({ instance_id: "i-111111111111" });
const target = "44444444-4444-4444-8444-444444444444";
const log = path.join(home, "adapter.log");
const agent = `node ${path.resolve("test/fixtures/spawn-ledger-resume-miss-adapter.mjs")} ${log}`;
const cli = path.resolve("dist/cli.js");
const env = { PATH: process.env.PATH, HOME: home };
const base = ["--agent", agent, "--approve-all", "--format", "json", "--cwd", home];
const initial = "INITIAL-PROMPT-d36c222f";
const adapterLog = () =>
  fs.existsSync(log)
    ? fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; sessionId?: string; text?: string })
    : [];

let acted = 0;
try {
  const attempt = ledger.reserveSpawn({
    run_id: "e2e-run",
    fence: 1,
    trigger_id: "fixture",
    parent_brick_id: "55555555-5555-4555-8555-555555555555",
    child_brick_id: "66666666-6666-4666-8666-666666666666",
    target_record_id: target,
  });
  const child = spawn(
    process.execPath,
    [
      cli,
      ...base,
      "--ttl",
      "1",
      "sessions",
      "new",
      "--name",
      "e2e-child",
      "--record-id",
      target,
      "--no-brick",
      "--metadata",
      `spawn_key=${attempt.idempotency_key}`,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let childOut = "";
  child.stdout.on("data", (chunk: Buffer) => (childOut += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (childOut += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => {
      ledger.recordSpawnChild("e2e-run", 1, child.pid!);
      resolve();
    });
    child.once("error", reject);
  });
  assert.equal(await exited, 0, `sessions new failed:\n${childOut}`);
  const created = ledger.readRecord(target);
  assert.ok(created, "sessions new wrote no record");
  const createdAcp = String(created.acp_session_id);
  acted++;
  console.log("ACTORS=1");

  ledger.transitionSpawn("e2e-run", 1, "published", {
    session_url: `https://atrium.example.invalid/?session=${target}`,
  });
  ledger.transitionSpawn("e2e-run", 1, "adopted");
  ledger.queueInitialPrompt("e2e-run", { text: initial });

  let output = "";
  await ledger.releaseInitialPrompt("e2e-run", async (payload) => {
    output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [cli, ...base, "--ttl", "1", "prompt", "--session-id", target, String(payload.text)],
        { env, timeout: 60_000 },
        (error, stdout, stderr) =>
          error
            ? reject(Object.assign(error, { detail: `${stdout}\n${stderr}` }))
            : resolve(`${stdout}\n${stderr}`),
      );
    }).catch((error: Error & { detail?: string }) => {
      throw new Error(`initial prompt submission failed: ${error.message}\n${error.detail ?? ""}`);
    });
  });
  const entries = adapterLog();
  const resumes = entries.filter(
    (entry) => entry.method === "session/load" || entry.method === "session/resume",
  );
  assert.ok(
    resumes.length >= 1,
    `the owner never tried to resume — the fallback shape was not entered:\n${output}`,
  );
  const received = entries.filter(
    (entry) => entry.method === "session/prompt" && entry.text?.includes(initial),
  );
  assert.equal(
    received.length,
    1,
    `agent received the initial prompt ${received.length} times:\n${JSON.stringify(entries)}\n${output}`,
  );
  const final = ledger.readRecord(target);
  assert.notEqual(
    String(final?.acp_session_id),
    createdAcp,
    "the fallback did not rebind acp_session_id",
  );
  assert.equal(String(final?.acp_session_id), received[0]?.sessionId);
  assert.equal(final?.metadata?.spawn_key, attempt.idempotency_key);
  assert.equal(ledger.pendingInitialPrompts().length, 0);
  acted++;
} finally {
  ledger.close();
}
if (acted === 0) {
  console.error("EXAMINED NOTHING");
  process.exitCode = 2;
}
console.log(`PHASES=${acted}`);
