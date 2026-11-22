import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { agentPodEnv, agentPodHome, runCli, tmpDir } from "./pod-a3-helpers.js";

// A7 follow-ups F2 and F3 through the real CLI: pod mode on the control pod (a home with no place file
// and the switch on) and an agent pod (the place file).

const NOTE = "favorites are kept on the control pod";

function controlPodHome(): string {
  const home = tmpDir("acpx-a7fu-");
  fs.mkdirSync(path.join(home, ".acpx", "sessions"), { recursive: true });
  return home;
}

test("F2: with no wakeups.db in pod mode the degraded line carries the reader's real detail, in text and in json", async () => {
  const home = controlPodHome();
  const env = agentPodEnv(home, "http://127.0.0.1:1");
  const text = await runCli(["sessions", "archive", "--dry-run"], env);
  assert.equal(text.status, 0, text.stderr);
  const line = text.stdout.split("\n").find((l) => l.includes("liveness DEGRADED")) ?? "";
  assert.match(line, /wakeups\.db not found at .*\.acpx\/wakeups\.db/u);
  assert.doesNotMatch(line, /exists but could not be read/u, "the old wrong sentence is gone");
  const json = await runCli(["sessions", "archive", "--dry-run", "--json"], env);
  assert.equal(json.status, 0, json.stderr);
  const doc = JSON.parse(json.stdout) as Record<string, unknown>;
  assert.equal(doc.livenessDegraded, true);
  assert.match(String(doc.livenessDetail), /^wakeups\.db not found at /u);
});

test("F2 NEGATIVE: with the switch OFF a missing wakeups.db is not degraded and says nothing", async () => {
  const home = controlPodHome();
  const env = agentPodEnv(home, "http://127.0.0.1:1", { ACPX_OWNER_PLACEMENT: undefined });
  const json = await runCli(["sessions", "archive", "--dry-run", "--json"], env);
  assert.equal(json.status, 0, json.stderr);
  const doc = JSON.parse(json.stdout) as Record<string, unknown>;
  assert.equal(doc.livenessDegraded, false);
  assert.equal("livenessDetail" in doc, false);
});

test("F3: --json-strict keeps the pod's favourites note OFF stderr; without it the note is there (control)", async () => {
  const { home } = agentPodHome();
  const env = agentPodEnv(home, "http://127.0.0.1:1");
  const strict = await runCli(
    ["--format", "json", "--json-strict", "models", "list", "--json"],
    env,
  );
  assert.equal(strict.status, 0, strict.stderr);
  assert.equal(strict.stderr, "", "json-strict's contract: empty stderr");
  assert.doesNotThrow(() => JSON.parse(strict.stdout));
  const plain = await runCli(["--format", "json", "models", "list", "--json"], env);
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(plain.stderr.includes(NOTE), "without json-strict the note is still said once");
});
