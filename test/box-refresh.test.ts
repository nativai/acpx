import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { TOP_LEVEL_VERBS } from "../src/cli-core.js";
import { boxRefreshSettings, startBoxRefresh } from "../src/cli/box-command.js";
import { COMMAND_TABLE } from "../src/pod/command-classes.js";
import { agentPodEnv, agentPodHome, CLI, runCli, tmpDir } from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";

// brick f2fde405 (A-17): `acpx box refresh`, the control-store verb that releases a box from an agent
// pod. The script is a stand-in (the product's test seam, honoured only under NODE_TEST_CONTEXT): a
// test must never start the real /opt/bootstrap/refresh.sh.

function script(body: string): string {
  const file = path.join(tmpDir("acpx-box-script-"), "refresh.sh");
  fs.writeFileSync(file, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  return file;
}

const SEAM = (file: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_TEST_CONTEXT: "child",
  ACPX_BOX_REFRESH_SCRIPT: file,
  ACPX_BOX_REFRESH_STATUS_FILE: "/tmp/runtime-status.test",
  ACPX_BOX_REFRESH_GRACE_MS: "600",
  ACPX_SESSION_URL: "https://atrium.example/?session=s-1",
  ACPX_SEAT_URL: "https://atrium.example/?seat=t-1",
  ...extra,
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a running release: returns at once with the log and record paths under the state home, detached, caller recorded", async () => {
  const stateRoot = tmpDir("acpx-box-state-");
  const marker = path.join(stateRoot, "done");
  const result = await startBoxRefresh({
    env: SEAM(script(`echo "[refresh] running"; sleep 3; touch ${marker}`)),
    stateRoot,
  });
  assert.equal(result.started, true);
  if (!result.started) {
    return;
  }
  assert.ok(
    result.log.startsWith(path.join(stateRoot, "box-refresh")),
    "log is under the state home",
  );
  assert.ok(result.record.startsWith(path.join(stateRoot, "box-refresh")));
  assert.equal(result.runtimeStatus, "/tmp/runtime-status.test");
  assert.ok(alive(result.pid), "the script is still running after the verb returned (detached)");
  const record = JSON.parse(fs.readFileSync(result.record, "utf8")) as {
    caller: Record<string, string>;
  };
  assert.deepEqual(record.caller, {
    session_url: "https://atrium.example/?session=s-1",
    seat_url: "https://atrium.example/?seat=t-1",
  });
  assert.match(
    fs.readFileSync(result.log, "utf8").split("\n")[0] ?? "",
    /caller session=https:\/\/atrium.example\/\?session=s-1 seat=https:\/\/atrium.example\/\?seat=t-1/u,
  );
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(fs.existsSync(marker), "the detached script ran to its end");
});

test("the script's own refusal (single flight, exit 75) is passed through: exit code and first lines, nothing started", async () => {
  const stateRoot = tmpDir("acpx-box-state-");
  const result = await startBoxRefresh({
    env: SEAM(script(`echo "[refresh] denied: a refresh is running (pid 42)" >&2; exit 75`)),
    stateRoot,
  });
  assert.equal(result.started, false);
  assert.equal(!result.started && result.exitCode, 75);
  assert.deepEqual(!result.started && result.firstLines, [
    "[refresh] denied: a refresh is running (pid 42)",
  ]);
});

test("the script, status file and grace are fixed unless NODE_TEST_CONTEXT is non-empty (negative: unset, empty)", () => {
  const knobs = { ACPX_BOX_REFRESH_SCRIPT: "/tmp/evil.sh", ACPX_BOX_REFRESH_GRACE_MS: "5" };
  assert.equal(boxRefreshSettings({ ...knobs, NODE_TEST_CONTEXT: "x" }).script, "/tmp/evil.sh");
  for (const context of [undefined, ""]) {
    const s = boxRefreshSettings({ ...knobs, NODE_TEST_CONTEXT: context });
    assert.equal(s.script, "/opt/bootstrap/refresh.sh");
    assert.equal(s.graceMs, 2_000);
    assert.equal(s.runtimeStatus, "/data/runtime/runtime-status.v1");
  }
});

test("both registrations exist: `box` is a top-level verb, `box refresh` has a class, and a bogus subcommand is an error, not a prompt", () => {
  assert.ok(TOP_LEVEL_VERBS.has("box"));
  assert.equal(COMMAND_TABLE["box refresh"]?.class, "control-store");
  const home = tmpDir();
  const r = spawnSync(process.execPath, [CLI, "box", "bogus"], {
    env: { ...process.env, HOME: home, ACPX_STATE_HOME: home },
    encoding: "utf8",
    cwd: home,
    timeout: 30_000,
  });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /too many arguments for 'box'|unknown command/u);
  assert.doesNotMatch(r.stderr, /No acpx session found/u);
});

test("the CLI on the control pod: starts the stand-in, prints log + runtime-status paths, exit 0", async () => {
  const home = tmpDir();
  const r = await runCli(["box", "refresh"], {
    ...process.env,
    HOME: home,
    ACPX_STATE_HOME: home,
    ...SEAM(script("sleep 2")),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /box refresh started/u);
  assert.match(r.stdout, new RegExp(`log: ${home}/\\.acpx/box-refresh/refresh-`, "u"));
  assert.match(r.stdout, /runtime-status: \/tmp\/runtime-status\.test/u);
});

test("from an AGENT POD it passes through (class control-store): the call reaches atrium, no script runs in the pod", async () => {
  const { home } = agentPodHome();
  const atrium = await startRecordedAtrium({
    calls: [{ answer: { exit: 0, stdout: "started\n" } }],
  });
  try {
    const marker = path.join(home, "ran");
    const r = await runCli(
      ["box", "refresh"],
      agentPodEnv(home, atrium.url, SEAM(script(`touch ${marker}`))),
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "started\n");
    const calls = atrium.requests.filter((q) => q.route === "call");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.body?.argv, ["box", "refresh"]);
    assert.equal(fs.existsSync(marker), false, "the pod did not run the release script");
    assert.equal(
      fs.existsSync(path.join(home, ".acpx", "box-refresh")),
      false,
      "and wrote no release record",
    );
  } finally {
    await atrium.close();
  }
});
