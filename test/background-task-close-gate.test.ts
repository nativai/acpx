import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  backgroundTaskRetryCommand,
  backgroundTasksJson,
  evaluateBackgroundTaskGate,
  closeRetryArgs,
  liveBackgroundTasksErrorMessage,
  liveBackgroundTasksRefusalText,
  taskOutcome,
  templateRetryArgs,
} from "../src/cli/background-task-gate.js";
import { tryQueryBackgroundTasksOnRunningOwner } from "../src/cli/queue/ipc.js";
import { isProcessAlive, readQueueOwnerProcessIdentity } from "../src/cli/queue/lease-store.js";
import { parseQueueOwnerMessage, parseQueueRequest } from "../src/cli/queue/messages.js";
import { queueLockFilePath, queueSharedSocketDir } from "../src/cli/queue/paths.js";
import { clearBackgroundTaskChip } from "../src/cli/session/owner-task-reap.js";
import { parseProcStat, unmeasuredReap, type ReapReport } from "../src/process-tree-reap.js";
import { FIXTURE_MONITOR_COMMAND, FIXTURE_TASKS } from "./bg-task-fixtures.js";
import { listenServer, writeQueueOwnerLock } from "./queue-test-helpers.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";
import { removeTempHome } from "./temp-home.js";

// brick ad6ba1c2 — the `sessions close` / `sessions template` gate (Contract C2–C4), through the REAL
// CLI against a stand-in owner process (`bg-task-owner-child.ts`) whose task shell is a setsid'd
// session exactly like Claude Code's, so the reap rows count real processes by pid.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const CHILD_PATH = fileURLToPath(new URL("./bg-task-owner-child.js", import.meta.url));
const PRODUCTION_AGENT_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const linux = process.platform === "linux";

type CliResult = { code: number | null; stdout: string; stderr: string };

function cliEnv(homeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
  for (const name of [
    "ACPX_SESSION_URL",
    "ACPX_SESSION_NAME",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_STATE_HOME",
    "ACPX_BRICK",
    "ACPX_SUBSCRIPTION",
  ]) {
    delete env[name];
  }
  return env;
}

async function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: cliEnv(homeDir),
      cwd: homeDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`acpx ${args.join(" ")} timed out`));
    }, 60_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Runs a printed command LITERALLY through `sh -c`, with an `acpx` on PATH that is this build —
 * what an agent does when it pastes the retry line into its Bash tool.
 */
async function runShellLiterally(command: string, homeDir: string): Promise<CliResult> {
  const binDir = path.join(homeDir, "shim-bin");
  await fsp.mkdir(binDir, { recursive: true });
  const shim = path.join(binDir, "acpx");
  await fsp.writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" "${CLI_PATH}" "$@"\n`);
  await fsp.chmod(shim, 0o755);
  const env = { ...cliEnv(homeDir), PATH: `${binDir}:${process.env.PATH ?? ""}` };
  return await new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      env,
      cwd: homeDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`sh -c ${command} timed out`));
    }, 60_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function jsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Alive = /proc says the pid exists with the same start ticks and is not a zombie. */
function aliveAs(pid: number, startTicks: string): boolean {
  try {
    const entry = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    return entry?.startTicks === startTicks && entry.state !== "Z" && entry.state !== "X";
  } catch {
    return false;
  }
}

function startTicksOf(pid: number): string {
  const entry = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  assert.ok(entry, `no /proc entry for ${pid}`);
  return entry.startTicks;
}

// v3 rig (bg-task-owner-child.ts): a proven Bash task (shell + sleep) and a proven Monitor (shell + sleep).
const RIG_KEYS = [
  "ownerPid",
  "claudePid",
  "shellPid",
  "sleepPid",
  "monShellPid",
  "monSleepPid",
] as const;
const TASK_KEYS = ["shellPid", "sleepPid", "monShellPid", "monSleepPid"] as const;
type RigPids = Record<(typeof RIG_KEYS)[number], number>;
type Rig = {
  pids: RigPids;
  ticks: Record<keyof RigPids, string>;
  outFile: string;
  stderrFile: string;
  lines: () => Array<Record<string, unknown>>;
  kill: () => void;
};

async function startOwnerRig(homeDir: string, mode: string, sessionId: string): Promise<Rig> {
  const outFile = path.join(homeDir, `${mode}-${sessionId}.out`);
  const stderrFile = path.join(homeDir, `${mode}-${sessionId}.err`);
  const errFd = fs.openSync(stderrFile, "a");
  const taskRoot = path.join(homeDir, `claude-${os.userInfo().uid}`, "proj");
  const child = spawn(process.execPath, [CHILD_PATH, mode, outFile, sessionId, taskRoot], {
    env: cliEnv(homeDir),
    cwd: homeDir,
    detached: true,
    stdio: ["ignore", "ignore", errFd],
  });
  fs.closeSync(errFd);
  child.unref();
  const lines = () =>
    fs.existsSync(outFile)
      ? fs
          .readFileSync(outFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  const deadline = Date.now() + 20_000;
  let ready: Record<string, unknown> | undefined;
  while (!ready && Date.now() < deadline) {
    ready = lines().find((line) => line.ready === true);
    if (!ready) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.ok(ready, `rig ${mode} never became ready: ${fs.readFileSync(stderrFile, "utf8")}`);
  const pids = ready as unknown as RigPids;
  const ticks = Object.fromEntries(RIG_KEYS.map((key) => [key, startTicksOf(pids[key])])) as Record<
    (typeof RIG_KEYS)[number],
    string
  >;
  const kill = () => {
    // Rig teardown BY VERIFIED PID only (start ticks re-checked), never by pattern.
    for (const key of [...RIG_KEYS].toReversed()) {
      if (aliveAs(pids[key], ticks[key])) {
        try {
          process.kill(pids[key], "SIGKILL");
        } catch {
          // gone meanwhile
        }
      }
    }
    // SIGKILL is asynchronous: wait (bounded) until the deaths are visible before the temp-home
    // teardown checks for processes still holding it.
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && RIG_KEYS.some((key) => aliveAs(pids[key], ticks[key]))) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  };
  return { pids, ticks, outFile, stderrFile, lines, kill };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

async function withHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fsp.mkdtemp(path.join(os.tmpdir(), "acpx-bg-gate-"));
  try {
    await run(homeDir);
  } finally {
    await removeTempHome(homeDir);
  }
}

async function writeRecord(homeDir: string, sessionId: string): Promise<void> {
  await writeSessionRecordFile(
    homeDir,
    makeSessionRecord({
      acpxRecordId: sessionId,
      acpSessionId: sessionId,
      agentCommand: PRODUCTION_AGENT_COMMAND,
      cwd: homeDir,
    }),
  );
}

async function recordClosed(homeDir: string, sessionId: string): Promise<unknown> {
  const file = path.join(homeDir, ".acpx", "sessions", `${sessionId}.json`);
  return (JSON.parse(await fsp.readFile(file, "utf8")) as { closed?: unknown }).closed;
}

type LiveBackgroundTaskShape = { taskId: string };

const NOW = Date.parse("2026-10-29T13:26:12.417Z");

// ---------------------------------------------------------------------------
// Exact shapes (Contract C2) — pure, no processes.
// ---------------------------------------------------------------------------

test("C2 text block: exact refusal text, singular/plural heading, age, empty description", () => {
  const sessionId = "0b994d77-ace8-4110-b5f6-92a91ac1d10b";
  const refusal = {
    verb: "close" as const,
    sessionId,
    tasks: FIXTURE_TASKS,
    retryCommand: backgroundTaskRetryCommand("close", sessionId, "claude"),
  };
  assert.equal(
    liveBackgroundTasksRefusalText(refusal, NOW),
    `sessions close: LIVE_BACKGROUND_TASKS: refused: session ${sessionId} has 2 live background tasks that closing it would kill:\n` +
      `  - Bash "rig-s1 bash bg" (task b343f35rh, running 7m24s)\n` +
      `  - Monitor "rig-s1 monitor" (task b2g1k6brj, running 7m22s)\n` +
      `Nothing was closed or stopped. To close it anyway and kill these tasks, run:\n` +
      `  acpx claude sessions close --session-id ${sessionId} --kill-background-tasks\n`,
  );
  const bare = { taskId: "t1", taskType: "local_agent", description: "" };
  const one = liveBackgroundTasksRefusalText({ ...refusal, tasks: [bare] }, NOW);
  assert.match(
    one,
    /has 1 live background task that closing it would kill:\n {2}- local_agent \(task t1\)\n/,
  );
});

test("C2 JSON error text and C3 template wording", () => {
  const close = {
    verb: "close" as const,
    sessionId: "s1",
    tasks: FIXTURE_TASKS,
    retryCommand: "x",
  };
  assert.equal(
    liveBackgroundTasksErrorMessage(close),
    'refused: session s1 has 2 live background tasks that closing it would kill: Bash "rig-s1 bash bg" (task b343f35rh), Monitor "rig-s1 monitor" (task b2g1k6brj). Re-run with --kill-background-tasks to close it anyway and kill them.',
  );
  const template = liveBackgroundTasksErrorMessage({ ...close, verb: "template" });
  assert.match(template, /marking it as a template closes it/);
  assert.equal(
    backgroundTaskRetryCommand("template", "s1", undefined),
    "acpx sessions template s1 --kill-background-tasks",
  );
});

test("HoD ruling: the retry command carries EVERY user-supplied verb option, shell-quoted", () => {
  assert.deepEqual(closeRetryArgs({}), []);
  assert.equal(
    backgroundTaskRetryCommand(
      "close",
      "s1",
      "claude",
      closeRetryArgs({ drain: false, drainTimeout: 1234, failOnUndelivered: true }),
    ),
    "acpx claude sessions close --session-id s1 --no-drain --drain-timeout 1234 --fail-on-undelivered --kill-background-tasks",
  );
  assert.equal(
    backgroundTaskRetryCommand(
      "template",
      "s1",
      undefined,
      templateRetryArgs({ enable: true, slug: "my-slug", autoPrompt: "Don't stop: run $HOME `x`" }),
    ),
    "acpx sessions template s1 --enable --slug my-slug --auto-prompt 'Don'\\''t stop: run $HOME `x`' --kill-background-tasks",
  );
  assert.equal(
    backgroundTaskRetryCommand("template", "s1", undefined, templateRetryArgs({ autoPrompt: "" })),
    "acpx sessions template s1 --auto-prompt '' --kill-background-tasks",
  );
});

test("C2 outcome rule (v3, per task): ended needs a measured reap, no survivor, and a PROOF for that task; measured:false is never a census", () => {
  const gate = { queried: true, killed: true, tasks: FIXTURE_TASKS };
  const ended: ReapReport = {
    measured: true,
    taskProcesses: 4,
    survivors: 0,
    survivorPids: [],
    survivorDetails: [],
    processTaskIds: ["b343f35rh", "b2g1k6brj"],
    provenTaskIds: ["b343f35rh", "b2g1k6brj"],
    survivingTaskIds: [],
  };
  assert.deepEqual(
    backgroundTasksJson(gate, ended, true).tasks.map((task) => task.outcome),
    ["ended", "ended"],
  );
  // An unproven live task never reads "ended", even with survivors:0 (RV-3).
  const oneUnproven = { ...ended, provenTaskIds: ["b343f35rh"] };
  assert.deepEqual(
    backgroundTasksJson(gate, oneUnproven, true).tasks.map((task) => task.outcome),
    ["ended", "unverified"],
  );
  const survived = {
    ...ended,
    survivors: 1,
    survivorPids: [42],
    survivorDetails: [{ pid: 42, comm: "sleep", startTicks: "7" }],
    survivingTaskIds: ["b343f35rh"],
  };
  const withSurvivor = backgroundTasksJson(gate, survived, true);
  assert.deepEqual(
    withSurvivor.tasks.map((task) => task.outcome),
    ["unverified", "unverified"],
  );
  assert.deepEqual(withSurvivor.reap, {
    measured: true,
    taskProcesses: 4,
    survivors: 1,
    survivorPids: [42],
  });
  // In-process task types end with claude; remote/unknown never read "ended".
  const agent = { taskId: "a1", taskType: "local_agent", description: "" };
  const remote = { taskId: "r1", taskType: "remote_agent", description: "" };
  assert.equal(taskOutcome(agent, ended, true), "ended");
  assert.equal(taskOutcome(agent, ended, false), "unverified");
  assert.equal(taskOutcome(remote, ended, true), "unverified");
  // R4 at the wire: an unmeasured reap is never "0 survivors" with measured:true.
  const unmeasured = backgroundTasksJson(gate, unmeasuredReap("no-task-set"), true);
  assert.deepEqual(unmeasured.reap, {
    measured: false,
    taskProcesses: 0,
    survivors: 0,
    survivorPids: [],
    skipped: "no-task-set",
  });
  assert.deepEqual(
    unmeasured.tasks.map((task) => task.outcome),
    ["unverified", "unverified"],
  );
});

test("gate decision: fails open on queried:false; refuses live tasks without the flag; killed only when forced", async () => {
  const record = makeSessionRecord({
    acpxRecordId: "g",
    acpSessionId: "g",
    agentCommand: PRODUCTION_AGENT_COMMAND,
    cwd: "/tmp",
  });
  const live = async () => ({
    queried: true as const,
    source: "adapter" as const,
    tasks: FIXTURE_TASKS,
    monitorCommands: [],
  });
  const none = async () => ({
    queried: true as const,
    source: "adapter" as const,
    tasks: [],
    monitorCommands: [],
  });
  const unknown = async () => ({ queried: false as const });
  const base = { record, explicitAgentName: undefined, verb: "close" as const };
  const refused = await evaluateBackgroundTaskGate({
    ...base,
    killBackgroundTasks: undefined,
    query: live,
  });
  assert.ok(refused.refusal);
  assert.equal(refused.gate.killed, false);
  const forced = await evaluateBackgroundTaskGate({
    ...base,
    killBackgroundTasks: true,
    query: live,
  });
  assert.equal(forced.refusal, undefined);
  assert.equal(forced.gate.killed, true);
  const open = await evaluateBackgroundTaskGate({
    ...base,
    killBackgroundTasks: undefined,
    query: unknown,
  });
  assert.equal(open.refusal, undefined);
  assert.deepEqual(open.gate, { queried: false, tasks: [], killed: false });
  const empty = await evaluateBackgroundTaskGate({
    ...base,
    killBackgroundTasks: true,
    query: none,
  });
  assert.equal(empty.gate.killed, false, "killed means tasks WERE live and the flag was given");
});

test("C4 wire: query_background_tasks parses; a result with a malformed task is rejected", () => {
  assert.deepEqual(parseQueueRequest({ type: "query_background_tasks", requestId: "r1" }), {
    type: "query_background_tasks",
    requestId: "r1",
    ownerGeneration: undefined,
  });
  const ok = parseQueueOwnerMessage({
    type: "query_background_tasks_result",
    requestId: "r1",
    source: "adapter",
    tasks: FIXTURE_TASKS,
  });
  assert.ok(ok && ok.type === "query_background_tasks_result");
  assert.deepEqual(ok.tasks, FIXTURE_TASKS);
  assert.equal(
    parseQueueOwnerMessage({
      type: "query_background_tasks_result",
      requestId: "r1",
      source: "adapter",
      tasks: [{ taskId: "x" }],
    }),
    null,
  );
  assert.equal(
    parseQueueOwnerMessage({
      type: "query_background_tasks_result",
      requestId: "r1",
      source: "bogus",
      tasks: [],
    }),
    null,
  );
});

// ---------------------------------------------------------------------------
// Through the real CLI and a real owner process.
// ---------------------------------------------------------------------------

test("G1 refusal: exit 7, exact JSON envelope, nothing touched — owner, adapter and both task pids alive, record open, no drain/close_session", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withHome(async (homeDir) => {
    const sessionId = "g1-gate";
    await writeRecord(homeDir, sessionId);
    const rig = await startOwnerRig(homeDir, "owner", sessionId);
    try {
      const json = await runCli(
        ["--format", "json", "claude", "sessions", "close", "--session-id", sessionId],
        homeDir,
      );
      assert.equal(json.code, 7, json.stderr);
      const lines = jsonLines(json.stdout);
      assert.equal(lines.length, 1, json.stdout);
      assert.deepEqual(lines[0], {
        ok: false,
        code: "LIVE_BACKGROUND_TASKS",
        error:
          `refused: session ${sessionId} has 2 live background tasks that closing it would kill: ` +
          'Bash "rig-s1 bash bg" (task b343f35rh), Monitor "rig-s1 monitor" (task b2g1k6brj). ' +
          "Re-run with --kill-background-tasks to close it anyway and kill them.",
        sessionId,
        liveBackgroundTasks: FIXTURE_TASKS,
        forceFlag: "--kill-background-tasks",
        retryCommand: `acpx claude sessions close --session-id ${sessionId} --kill-background-tasks`,
      });

      const text = await runCli(["sessions", "close", "--session-id", sessionId], homeDir);
      assert.equal(text.code, 7);
      assert.equal(text.stdout, "", "a text refusal prints nothing on stdout");
      assert.match(
        text.stderr,
        /^sessions close: LIVE_BACKGROUND_TASKS: refused: session g1-gate has 2 live background tasks that closing it would kill:\n {2}- Bash "rig-s1 bash bg" \(task b343f35rh, running \d+m\d\ds\)\n {2}- Monitor "rig-s1 monitor" \(task b2g1k6brj, running \d+m\d\ds\)\nNothing was closed or stopped\. To close it anyway and kill these tasks, run:\n {2}acpx sessions close --session-id g1-gate --kill-background-tasks\n$/,
      );

      const quiet = await runCli(
        ["--format", "quiet", "sessions", "close", "--session-id", sessionId],
        homeDir,
      );
      assert.equal(quiet.code, 7);
      assert.equal(quiet.stdout + quiet.stderr, "");

      assert.equal(await recordClosed(homeDir, sessionId), false);
      for (const key of RIG_KEYS) {
        assert.ok(aliveAs(rig.pids[key], rig.ticks[key]), `${key} was signalled by a refusal`);
      }
      const requests = rig.lines().filter((line) => "request" in line);
      assert.deepEqual(requests, [], "a refusal must send no drain and no close_session");
    } finally {
      rig.kill();
    }
  });
});

test("G2 + G4: the retryCommand, executed LITERALLY, closes and kills — every pid of the tree gone, outcomes ended", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withHome(async (homeDir) => {
    const sessionId = "g2-force";
    await writeRecord(homeDir, sessionId);
    const rig = await startOwnerRig(homeDir, "owner", sessionId);
    try {
      const refused = await runCli(
        ["--format", "json", "sessions", "close", "--session-id", sessionId],
        homeDir,
      );
      assert.equal(refused.code, 7);
      const retry = String(jsonLines(refused.stdout)[0]?.retryCommand);
      assert.match(retry, /^acpx /);
      // JSON for the assertions: `--format` is a GLOBAL option, so it goes right after `acpx`; the
      // rest of the printed command is pasted unchanged.
      const forced = await runShellLiterally(
        retry.replace(/^acpx /, "acpx --format json "),
        homeDir,
      );
      assert.equal(forced.code, 0, forced.stderr);
      const closed = jsonLines(forced.stdout).find((line) => line.action === "session_closed");
      assert.ok(closed, forced.stdout);
      assert.equal(closed.recordClosed, true);
      const bg = closed.backgroundTasks as Record<string, unknown>;
      assert.equal(bg.queried, true);
      assert.equal(bg.killed, true);
      assert.deepEqual(
        (bg.tasks as Array<Record<string, unknown>>).map((task) => [task.taskId, task.outcome]),
        [
          ["b343f35rh", "ended"],
          ["b2g1k6brj", "ended"],
        ],
      );
      assert.deepEqual(bg.reap, {
        measured: true,
        taskProcesses: 4,
        survivors: 0,
        survivorPids: [],
      });
      for (const key of RIG_KEYS) {
        assert.ok(
          await waitUntil(() => !aliveAs(rig.pids[key], rig.ticks[key]), 3_000),
          `${key} survived the forced close`,
        );
      }
      // The owner's own handler (path G) logged its reap to owner.log (its stderr here).
      assert.match(
        fs.readFileSync(rig.stderrFile, "utf8"),
        /queue owner reaped 4 background task process\(es\) of session g2-force after SIGTERM/,
      );
    } finally {
      rig.kill();
    }
  });
});

test("G2 text: a forced close prints the kill summary on stderr", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withHome(async (homeDir) => {
    const sessionId = "g2-text";
    await writeRecord(homeDir, sessionId);
    const rig = await startOwnerRig(homeDir, "owner", sessionId);
    try {
      const forced = await runCli(
        ["sessions", "close", "--session-id", sessionId, "--kill-background-tasks"],
        homeDir,
      );
      assert.equal(forced.code, 0, forced.stderr);
      assert.match(
        forced.stderr,
        /\[acpx\] killed 2 live background tasks of g2-text: Bash "rig-s1 bash bg" \(b343f35rh\), Monitor "rig-s1 monitor" \(b2g1k6brj\); 4 task processes ended, 0 survived\n/,
      );
    } finally {
      rig.kill();
    }
  });
});

test("G3 / AC8 (v3): an OLD owner (QUEUE_REQUEST_INVALID) fails open — not auto-terminated by the query, the close is not refused, and with NO task set the closer signals nothing and says so (RV-5)", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withHome(async (homeDir) => {
    const sessionId = "g3-old";
    await writeRecord(homeDir, sessionId);
    const rig = await startOwnerRig(homeDir, "old-owner", sessionId);
    try {
      const prev = process.env.HOME;
      process.env.HOME = homeDir;
      try {
        assert.deepEqual(await tryQueryBackgroundTasksOnRunningOwner(sessionId), {
          queried: false,
          ownerUnanswered: true,
        });
      } finally {
        process.env.HOME = prev;
      }
      assert.ok(
        aliveAs(rig.pids.ownerPid, rig.ticks.ownerPid),
        "the query must never auto-terminate an old owner (protocol-mismatch recovery)",
      );

      const closed = await runCli(
        ["--format", "json", "sessions", "close", "--session-id", sessionId],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
      const line = jsonLines(closed.stdout).find((entry) => entry.action === "session_closed");
      assert.ok(line);
      const bg = line.backgroundTasks as Record<string, unknown>;
      assert.equal(bg.queried, false);
      assert.equal(bg.killed, false);
      assert.deepEqual(bg.tasks, []);
      // Never a false all-clear: no census without a task set.
      assert.deepEqual(bg.reap, {
        measured: false,
        taskProcesses: 0,
        survivors: 0,
        survivorPids: [],
        skipped: "no-task-set",
      });
      assert.ok(!aliveAs(rig.pids.ownerPid, rig.ticks.ownerPid), "the old owner was stopped");
      // RV-5, by design: an old owner's tasks orphan exactly as today (the rig kills them below).
      assert.ok(TASK_KEYS.every((key) => aliveAs(rig.pids[key], rig.ticks[key])));
      // HoD R2-8: ...but never silently. The JSON carries no `warnings` field; stderr does, in json too.
      assert.match(
        closed.stderr,
        /\[acpx\] WARNING: could not check g3-old's background tasks \(its owner runs an older acpx or did not answer\); any it had may still be running \(brick ad6ba1c2\)\n/,
      );
    } finally {
      rig.kill();
    }
  });
});

test("HoD (v3): a live task no proof matches is LOUD — stderr names K of N, and that task reads unverified while the proven ones end", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withHome(async (homeDir) => {
    const sessionId = "ghost-warn";
    await writeRecord(homeDir, sessionId);
    const rig = await startOwnerRig(homeDir, "owner-ghost", sessionId);
    try {
      const forced = await runCli(
        [
          "--format",
          "json",
          "sessions",
          "close",
          "--session-id",
          sessionId,
          "--kill-background-tasks",
        ],
        homeDir,
      );
      assert.equal(forced.code, 0, forced.stderr);
      assert.match(
        forced.stderr,
        /\[acpx\] WARNING: session ghost-warn: proof matched 2 of 3 live background tasks — the unmatched ones may survive; Claude Code's task layout may have changed \(brick ad6ba1c2\)/,
      );
      const line = jsonLines(forced.stdout).find((entry) => entry.action === "session_closed");
      assert.ok(line, forced.stdout);
      const tasks = (line.backgroundTasks as { tasks: Array<{ taskId: string; outcome: string }> })
        .tasks;
      assert.deepEqual(
        tasks.map((task) => [task.taskId, task.outcome]),
        [
          ["b343f35rh", "ended"],
          ["b2g1k6brj", "ended"],
          ["bghost0001", "unverified"],
        ],
      );
      // The owner's own handler wrote it to owner.log too.
      assert.match(
        fs.readFileSync(rig.stderrFile, "utf8"),
        /proof matched 2 of 3 live background tasks/,
      );
      assert.ok(TASK_KEYS.every((key) => !aliveAs(rig.pids[key], rig.ticks[key])));
    } finally {
      rig.kill();
    }
  });
});

test("C4 v3: a Monitor's command (match-only) never appears in any CLI output — refusal or success, any format", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withHome(async (homeDir) => {
    const sessionId = "no-command-leak";
    await writeRecord(homeDir, sessionId);
    const rig = await startOwnerRig(homeDir, "owner", sessionId);
    try {
      const outputs: string[] = [];
      for (const format of ["json", "text"]) {
        const refused = await runCli(
          ["--format", format, "sessions", "close", "--session-id", sessionId],
          homeDir,
        );
        assert.equal(refused.code, 7);
        outputs.push(refused.stdout, refused.stderr);
      }
      const forced = await runCli(
        [
          "--format",
          "json",
          "sessions",
          "close",
          "--session-id",
          sessionId,
          "--kill-background-tasks",
        ],
        homeDir,
      );
      assert.equal(forced.code, 0, forced.stderr);
      outputs.push(forced.stdout, forced.stderr);
      for (const output of outputs) {
        assert.ok(
          !output.includes(FIXTURE_MONITOR_COMMAND),
          "the Monitor command leaked into CLI output",
        );
        assert.ok(!output.includes("monitorCommands"), "monitorCommands leaked into CLI output");
      }
    } finally {
      rig.kill();
    }
  });
});

test("G1 negative: an owner with NO live tasks is not refused (plain close works)", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withHome(async (homeDir) => {
    const sessionId = "g1-none";
    await writeRecord(homeDir, sessionId);
    const rig = await startOwnerRig(homeDir, "owner-none", sessionId);
    try {
      const closed = await runCli(
        ["--format", "json", "sessions", "close", "--session-id", sessionId],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
      const line = jsonLines(closed.stdout).find((entry) => entry.action === "session_closed");
      const bg = line?.backgroundTasks as Record<string, unknown>;
      assert.deepEqual([bg.queried, bg.killed, bg.tasks], [true, false, []]);
      assert.doesNotMatch(
        closed.stderr,
        /could not check/,
        "an answering owner is checked: no R2-8 warning",
      );
    } finally {
      rig.kill();
    }
  });
});

// HoD Q4 path C: recover leaves the session OPEN, so after it reaped tasks the stream's last
// `_claude/backgroundTasks` line must be the empty set (the "⧖ running" chip clears). The negative: a
// recover that reaped nothing (no owner) writes no line.
test("Q4 path C: a recover that reaped tasks clears the chip; one that reaped nothing writes no line", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withHome(async (homeDir) => {
    const stream = (id: string) => path.join(homeDir, ".acpx", "sessions", `${id}.stream.ndjson`);
    await writeRecord(homeDir, "q4c-idle");
    const idle = await runCli(["--format", "json", "sessions", "recover", "q4c-idle"], homeDir);
    assert.equal(idle.code, 0, idle.stderr);
    assert.equal(fs.existsSync(stream("q4c-idle")), false, "nothing reaped ⇒ no chip line");

    const sessionId = "q4c-live";
    await writeRecord(homeDir, sessionId);
    const rig = await startOwnerRig(homeDir, "owner", sessionId);
    try {
      const recovered = await runCli(
        ["--format", "json", "sessions", "recover", sessionId],
        homeDir,
      );
      assert.equal(recovered.code, 0, recovered.stderr);
      const result = jsonLines(recovered.stdout).find((line) => "reap" in line);
      assert.ok(result, recovered.stdout);
      assert.equal((result.reap as { taskProcesses: number }).taskProcesses, 4);
      const lines = (await fsp.readFile(stream(sessionId), "utf8")).trim().split("\n");
      const last = JSON.parse(lines.at(-1) ?? "") as {
        method: string;
        params: { sessionId: string; tasks: unknown[] };
      };
      assert.equal(last.method, "_claude/backgroundTasks");
      assert.deepEqual([last.params.sessionId, last.params.tasks], [sessionId, []]);
    } finally {
      rig.kill();
    }
  });
});

test("G5 template: refused (exit 7, nothing marked), then --kill-background-tasks marks it and ends the tasks", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withHome(async (homeDir) => {
    const sessionId = "g5-template";
    await writeRecord(homeDir, sessionId);
    const rig = await startOwnerRig(homeDir, "owner", sessionId);
    try {
      const refused = await runCli(
        ["--format", "json", "sessions", "template", sessionId, "--slug", "g5"],
        homeDir,
      );
      assert.equal(refused.code, 7, refused.stderr);
      const refusal = jsonLines(refused.stdout)[0];
      assert.equal(refusal?.code, "LIVE_BACKGROUND_TASKS");
      assert.match(String(refusal?.error), /marking it as a template closes it/);
      assert.equal(
        refusal?.retryCommand,
        // HoD ruling: the caller's own options are carried into the retry.
        `acpx sessions template ${sessionId} --slug g5 --kill-background-tasks`,
      );
      assert.equal(await recordClosed(homeDir, sessionId), false);
      assert.ok(aliveAs(rig.pids.sleepPid, rig.ticks.sleepPid));

      const forced = await runCli(
        [
          "--format",
          "json",
          "sessions",
          "template",
          sessionId,
          "--slug",
          "g5",
          "--kill-background-tasks",
        ],
        homeDir,
      );
      assert.equal(forced.code, 0, forced.stderr);
      const line = jsonLines(forced.stdout).find((entry) => entry.action === "template_enabled");
      assert.ok(line, forced.stdout);
      const bg = line.backgroundTasks as Record<string, unknown>;
      assert.equal(bg.killed, true);
      assert.deepEqual(bg.reap, {
        measured: true,
        taskProcesses: 4,
        survivors: 0,
        survivorPids: [],
      });
      assert.ok(!aliveAs(rig.pids.sleepPid, rig.ticks.sleepPid));
      assert.ok(!aliveAs(rig.pids.shellPid, rig.ticks.shellPid));
    } finally {
      rig.kill();
    }
  });
});

test("C4 fail-open: no lease, and an owner that accepts but never answers, both read queried:false within the deadline", async (t) => {
  if (!linux) {
    t.skip("unix sockets");
    return;
  }
  await withHome(async (homeDir) => {
    const prev = process.env.HOME;
    process.env.HOME = homeDir;
    const server = net.createServer(() => {
      // accept, read nothing, answer nothing — a wedged owner
    });
    try {
      // No owner to ask is not "unanswered" (R2-8): neither no lease nor a stale lease of a dead pid.
      assert.deepEqual(await tryQueryBackgroundTasksOnRunningOwner("c4-none"), { queried: false });
      const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
      assert.ok(deadPid && !isProcessAlive(deadPid));
      await writeQueueOwnerLock({
        lockPath: queueLockFilePath("c4-stale", homeDir),
        pid: deadPid,
        sessionId: "c4-stale",
        socketPath: path.join(queueSharedSocketDir(homeDir), "c4-stale.sock"),
      });
      assert.deepEqual(await tryQueryBackgroundTasksOnRunningOwner("c4-stale"), { queried: false });
      const sessionId = "c4-silent";
      const socketPath = path.join(queueSharedSocketDir(homeDir), `${sessionId}.sock`);
      await listenServer(server, socketPath);
      const identity = await readQueueOwnerProcessIdentity(process.pid);
      assert.ok(identity);
      await writeQueueOwnerLock({
        lockPath: queueLockFilePath(sessionId, homeDir),
        pid: process.pid,
        sessionId,
        socketPath,
        processIdentity: identity,
      });
      const startedAt = Date.now();
      assert.deepEqual(await tryQueryBackgroundTasksOnRunningOwner(sessionId, 400), {
        queried: false,
        ownerUnanswered: true,
      });
      assert.ok(Date.now() - startedAt < 1_500, "the deadline bounds connect AND answer");
    } finally {
      server.close();
      process.env.HOME = prev;
    }
  });
});

test("HoD Q4: the chip-clear line is the adapter's own shape with tasks:[], and is not written for a closed record", async () => {
  await withHome(async (homeDir) => {
    const prev = process.env.HOME;
    process.env.HOME = homeDir;
    try {
      await writeRecord(homeDir, "q4-open");
      const stream = path.join(homeDir, ".acpx", "sessions", "q4-open.stream.ndjson");
      await clearBackgroundTaskChip("q4-open");
      const line = JSON.parse((await fsp.readFile(stream, "utf8")).trim()) as Record<
        string,
        unknown
      >;
      assert.equal(line.jsonrpc, "2.0");
      assert.equal(line.method, "_claude/backgroundTasks");
      const params = line.params as Record<string, unknown>;
      assert.equal(params.sessionId, "q4-open");
      assert.deepEqual(params.tasks, []);
      assert.ok(!Number.isNaN(Date.parse(String(params.at))));

      await writeSessionRecordFile(
        homeDir,
        makeSessionRecord({
          acpxRecordId: "q4-closed",
          acpSessionId: "q4-closed",
          agentCommand: PRODUCTION_AGENT_COMMAND,
          cwd: homeDir,
          closed: true,
        }),
      );
      await clearBackgroundTaskChip("q4-closed");
      assert.equal(
        fs.existsSync(path.join(homeDir, ".acpx", "sessions", "q4-closed.stream.ndjson")),
        false,
      );
    } finally {
      process.env.HOME = prev;
    }
  });
});

test("HoD ruling: a template refusal with --slug and --auto-prompt prints a retryCommand that, run LITERALLY through a shell, yields the SAME template", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withHome(async (homeDir) => {
    const sessionId = "g5-intent";
    const autoPrompt = "Don't stop: run the suite in $PWD, then `report`";
    await writeRecord(homeDir, sessionId);
    const rig = await startOwnerRig(homeDir, "owner", sessionId);
    try {
      const refused = await runCli(
        ["sessions", "template", sessionId, "--slug", "intent-slug", "--auto-prompt", autoPrompt],
        homeDir,
      );
      assert.equal(refused.code, 7, refused.stderr);
      const printed = refused.stderr.trimEnd().split("\n").at(-1)?.trim() ?? "";
      assert.match(printed, /--slug intent-slug --auto-prompt '.*' --kill-background-tasks$/);
      assert.equal(await recordClosed(homeDir, sessionId), false, "a refusal marks nothing");

      const forced = await runShellLiterally(printed, homeDir);
      assert.equal(forced.code, 0, forced.stderr);
      const record = JSON.parse(
        await fsp.readFile(path.join(homeDir, ".acpx", "sessions", `${sessionId}.json`), "utf8"),
      ) as {
        closed?: boolean;
        template?: { enabled?: boolean; slug?: string; auto_prompt?: string };
      };
      assert.equal(record.closed, true);
      assert.equal(record.template?.enabled, true);
      assert.equal(record.template?.slug, "intent-slug");
      assert.equal(
        record.template?.auto_prompt,
        autoPrompt,
        "the auto-prompt survived the shell byte for byte",
      );
      assert.ok(!aliveAs(rig.pids.sleepPid, rig.ticks.sleepPid));
    } finally {
      rig.kill();
    }
  });
});

test("T-RACE-2 (v3.1): no task at the gate, one INSIDE the drain — exit 7 naming it, record open, NO close_session, owner alive", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withHome(async (homeDir) => {
    const sessionId = "race-cli";
    await writeRecord(homeDir, sessionId);
    const rig = await startOwnerRig(homeDir, "race", sessionId);
    try {
      const refused = await runCli(
        [
          "--format",
          "json",
          "sessions",
          "close",
          "--session-id",
          sessionId,
          "--drain-timeout",
          "30000",
        ],
        homeDir,
      );
      assert.equal(refused.code, 7, refused.stderr);
      const line = jsonLines(refused.stdout)[0];
      assert.ok(line, refused.stdout);
      assert.equal(line.code, "LIVE_BACKGROUND_TASKS");
      assert.deepEqual(
        (line.liveBackgroundTasks as LiveBackgroundTaskShape[]).map((task) => task.taskId),
        ["b2g1k6brj"],
      );
      assert.equal(
        line.retryCommand,
        `acpx sessions close --session-id ${sessionId} --drain-timeout 30000 --kill-background-tasks`,
      );
      assert.equal(await recordClosed(homeDir, sessionId), false);
      const requests = rig
        .lines()
        .filter((entry) => "request" in entry)
        .map((entry) => entry.request);
      assert.deepEqual(
        requests,
        ["drain_deliveries"],
        "no close_session after an in-drain refusal",
      );
      for (const key of RIG_KEYS) {
        assert.ok(aliveAs(rig.pids[key], rig.ticks[key]), `${key} was signalled`);
      }
    } finally {
      rig.kill();
    }
  });
});

test("T-RACE-4 (v3.1): a task appearing AFTER the commit is reaped AND named startedDuringClose, with a stderr WARNING", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withHome(async (homeDir) => {
    const sessionId = "race-late";
    await writeRecord(homeDir, sessionId);
    const rig = await startOwnerRig(homeDir, "late", sessionId);
    try {
      const closed = await runCli(
        ["--format", "json", "sessions", "close", "--session-id", sessionId],
        homeDir,
      );
      assert.equal(closed.code, 0, closed.stderr);
      const line = jsonLines(closed.stdout).find((entry) => entry.action === "session_closed");
      assert.ok(line, closed.stdout);
      const bg = line.backgroundTasks as {
        killed: boolean;
        tasks: Array<{ taskId: string; outcome: string; startedDuringClose?: boolean }>;
      };
      assert.equal(bg.killed, false, "nothing was consented");
      assert.deepEqual(
        bg.tasks.map((task) => [task.taskId, task.startedDuringClose, task.outcome]),
        [
          ["b343f35rh", true, "ended"],
          ["b2g1k6brj", true, "ended"],
        ],
      );
      assert.match(
        closed.stderr,
        /WARNING: 2 background tasks of race-late started during the close and were ended without consent: Bash "rig-s1 bash bg" \(b343f35rh\), Monitor "rig-s1 monitor" \(b2g1k6brj\)/,
      );
      assert.ok(TASK_KEYS.every((key) => !aliveAs(rig.pids[key], rig.ticks[key])));
    } finally {
      rig.kill();
    }
  });
});
