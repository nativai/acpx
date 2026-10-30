// brick 9d34a178 — A SELF-CLOSE DEFERS TO THE END OF THE TURN, SO THE FINAL REPLY SURVIVES.
//
// Real processes end to end, in the production shape: the real CLI starts a real queue owner, the
// owner spawns the mock agent as its adapter, and the AGENT ITSELF spawns `acpx sessions close`
// (owner → adapter/agent → command, as Claude Code's Bash tool does — test/mock-agent.ts
// `run-then-say`), then answers with a final reply. Before the fix that close SIGTERMed its own
// owner, the agent died inside its tool call, and the reply was never generated (live: session
// bd264aec, brick f1f7a68d).
//
// Each guarantee has its own row, and each row can fail: the `--now` row is the planted negative of
// the first (same shape, the reply is lost), and the background-task row shows a deferred close
// that is NOT performed.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isProcessAlive } from "../src/cli/queue/lease-store.js";
import { queuePaths, withTempHome } from "./queue-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

type CliResult = { code: number | null; stdout: string; stderr: string };

function cliEnv(homeDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    ACPX_STATE_HOME: homeDir,
    ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
  };
  for (const key of [
    "ACPX_SESSION_URL",
    "ACPX_SEAT_URL",
    "ACPX_SESSION_NAME",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_PARENT_SEAT_URL",
    "ACPX_BRICK",
    "ACPX_OWNER_LOG",
  ]) {
    delete env[key];
  }
  return env;
}

async function runCli(args: string[], homeDir: string, timeoutMs = 60_000): Promise<CliResult> {
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
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

type Rig = { homeDir: string; cwd: string; id: string; sessionsDir: string };

async function withSession(run: (rig: Rig) => Promise<void>): Promise<void> {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { codex: { command: MOCK_AGENT_COMMAND } } })}\n`,
    );
    const created = await runCli(
      ["--cwd", cwd, "--format", "json", "codex", "sessions", "new", "--name", "self-closer"],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId: unknown }).acpxRecordId,
    );
    await run({ homeDir, cwd, id, sessionsDir: path.join(homeDir, ".acpx", "sessions") });
  });
}

/** The prompt that makes the agent run `argv` itself and then answer `say`. */
function runThenSay(spec: {
  argv: string[];
  say: string;
  holdMs?: number;
  bgTask?: [number, string];
}): string {
  return `run-then-say ${Buffer.from(JSON.stringify(spec)).toString("base64url")}`;
}

/** `acpx sessions close` as the agent's own Bash would run it; `touch`es `flag` once it returned. */
function closeFromInside(rig: Rig, extra: string[], flag?: string): string[] {
  const close = [process.execPath, CLI_PATH, "--format", "json", "codex", "sessions", "close"];
  const argv = [...close, "--session-id", rig.id, ...extra];
  if (!flag) {
    return argv;
  }
  const quoted = argv.map((part) => `'${part}'`).join(" ");
  return ["sh", "-c", `${quoted}; touch '${flag}'`];
}

function prompt(rig: Rig, text: string): Promise<CliResult> {
  return runCli(["--cwd", rig.cwd, "codex", "prompt", "--session-id", rig.id, text], rig.homeDir);
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

const recordOf = async (rig: Rig) =>
  JSON.parse(await fs.readFile(path.join(rig.sessionsDir, `${rig.id}.json`), "utf8")) as Record<
    string,
    unknown
  >;
const streamOf = (rig: Rig) => readText(path.join(rig.sessionsDir, `${rig.id}.stream.ndjson`));
const messagesOf = (rig: Rig) => readText(path.join(rig.sessionsDir, `${rig.id}.messages.ndjson`));
const ownerLogOf = (rig: Rig) => readText(path.join(rig.sessionsDir, `${rig.id}.owner.log`));

async function waitFor(what: string, timeoutMs: number, ready: () => Promise<boolean>) {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    assert.ok(Date.now() < deadline, `${what} never happened within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function exists(file: string): Promise<boolean> {
  return await fs.stat(file).then(
    () => true,
    () => false,
  );
}

async function ownerPidOf(rig: Rig): Promise<number> {
  const lease = JSON.parse(await fs.readFile(queuePaths(rig.homeDir, rig.id).lockPath, "utf8")) as {
    pid: number;
  };
  return lease.pid;
}

/** The record is closed, the lease released and the owner process gone. */
async function waitForClosedAndOwnerGone(rig: Rig, ownerPid: number): Promise<void> {
  await waitFor("the deferred close", 30_000, async () => (await recordOf(rig)).closed === true);
  await waitFor("the owner leaving", 30_000, async () => {
    return !isProcessAlive(ownerPid) && !(await exists(queuePaths(rig.homeDir, rig.id).lockPath));
  });
}

function streamLines(stream: string): Array<Record<string, unknown>> {
  return stream
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function lastIdleTurnIndex(lines: Array<Record<string, unknown>>): number {
  return lines.findLastIndex(
    (line) =>
      line.method === "acpx/turn" &&
      (line.params as { phase?: string } | undefined)?.phase === "idle",
  );
}

test("production shape: the agent closes itself, then writes its final reply — the reply is kept and the session closes after the turn", async () => {
  await withSession(async (rig) => {
    const marker = `FINAL-REPLY-${process.pid}-kept`;
    const flag = path.join(rig.homeDir, "closed-returned");
    const running = prompt(
      rig,
      runThenSay({ argv: closeFromInside(rig, [], flag), say: marker, holdMs: 500 }),
    );
    await waitFor("the close command returning inside the turn", 30_000, () => exists(flag));
    const ownerPid = await ownerPidOf(rig);
    // Mid-turn, after the close returned: nothing is closed yet and the owner is alive.
    assert.equal((await recordOf(rig)).closed, false, "a deferred close writes nothing mid-turn");
    assert.equal(isProcessAlive(ownerPid), true, "a deferred close kills nothing mid-turn");

    const result = await running;
    assert.equal(result.code, 0, `the turn ends normally; stderr=${result.stderr}`);
    // The close's own JSON — what the agent saw from its tool call — says it was scheduled.
    const scheduled = JSON.parse(
      result.stdout.split("\n").find((line) => line.includes("session_close_scheduled")) ?? "{}",
    ) as Record<string, unknown>;
    assert.equal(scheduled.deferred, true, result.stdout);
    assert.equal(scheduled.self, true);
    assert.equal(scheduled.activeTurn, true);
    assert.match(result.stdout, new RegExp(marker), "the reply reached the prompting client");

    await waitForClosedAndOwnerGone(rig, ownerPid);
    const record = await recordOf(rig);
    assert.equal(typeof record.closed_at, "string");
    assert.equal(record.pid, undefined, "the closed record names no adapter pid");
    assert.match(
      await messagesOf(rig),
      new RegExp(marker),
      "the final reply is in messages.ndjson",
    );
    const lines = streamLines(await streamOf(rig));
    const markerIndex = lines.findIndex((line) => JSON.stringify(line).includes(marker));
    assert.ok(markerIndex >= 0, "the final reply is in the stream");
    assert.ok(lastIdleTurnIndex(lines) > markerIndex, "the turn's idle event follows the reply");
    assert.match(
      await ownerLogOf(rig),
      new RegExp(`deferred close: session ${rig.id} closed at the end of its turn`),
    );
  });
});

test("NEGATIVE --now: the same shape with --now still ends the turn at once — the reply is never generated", async () => {
  await withSession(async (rig) => {
    const marker = `FINAL-REPLY-${process.pid}-lost`;
    const result = await prompt(
      rig,
      runThenSay({ argv: closeFromInside(rig, ["--now"]), say: marker }),
    );
    await waitFor("the immediate close", 30_000, async () => (await recordOf(rig)).closed === true);
    assert.doesNotMatch(result.stdout, new RegExp(marker));
    assert.doesNotMatch(await messagesOf(rig), new RegExp(marker), "nothing after --now exists");
    const lines = streamLines(await streamOf(rig));
    const activeTurns = lines.filter(
      (line) =>
        line.method === "acpx/turn" &&
        (line.params as { phase?: string } | undefined)?.phase === "active",
    ).length;
    const idleTurns = lines.filter(
      (line) =>
        line.method === "acpx/turn" &&
        (line.params as { phase?: string } | undefined)?.phase === "idle",
    ).length;
    assert.equal(idleTurns, activeTurns - 1, "the cut turn never wrote its idle event");
  });
});

test("NEGATIVE custody: a message queued in the deferred window is never started — it ends SESSION_CLOSED_UNDELIVERED", async () => {
  await withSession(async (rig) => {
    const flag = path.join(rig.homeDir, "closed-returned");
    const marker = `FINAL-REPLY-${process.pid}-custody`;
    const running = prompt(
      rig,
      runThenSay({ argv: closeFromInside(rig, [], flag), say: marker, holdMs: 4_000 }),
    );
    await waitFor("the close command returning inside the turn", 30_000, () => exists(flag));
    const ownerPid = await ownerPidOf(rig);
    const messageId = "44444444-4444-4444-8444-444444444444";
    const late = await runCli(
      [
        "--cwd",
        rig.cwd,
        "--format",
        "json",
        "codex",
        "prompt",
        "--session-id",
        rig.id,
        "--no-wait",
        "--message-id",
        messageId,
        "echo LATE-MESSAGE-STARTED",
      ],
      rig.homeDir,
    );
    assert.equal(late.code, 0, `the late message is accepted into custody; ${late.stderr}`);
    assert.match(late.stdout, /"action":"prompt_queued"/);

    assert.equal((await running).code, 0);
    await waitForClosedAndOwnerGone(rig, ownerPid);
    assert.match(await messagesOf(rig), new RegExp(marker));
    assert.doesNotMatch(await messagesOf(rig), /LATE-MESSAGE-STARTED/, "never started");
    const terminals = streamLines(await streamOf(rig)).filter(
      (line) =>
        line.method === "acpx/delivery" &&
        (line.params as { messageId?: string } | undefined)?.messageId === messageId,
    );
    const last = terminals.at(-1)?.params as
      | { phase?: string; error?: { detailCode?: string } }
      | undefined;
    assert.equal(last?.phase, "failed", JSON.stringify(terminals));
    assert.equal(last?.error?.detailCode, "SESSION_CLOSED_UNDELIVERED");
  });
});

test("NEGATIVE background task: one that went live after an UNFORCED request leaves the session open, and owner.log says so", async () => {
  await withSession(async (rig) => {
    const marker = `FINAL-REPLY-${process.pid}-bg`;
    const result = await prompt(
      rig,
      runThenSay({ argv: closeFromInside(rig, []), say: marker, bgTask: [60_000, "late-bg-1"] }),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /session_close_scheduled/);
    await waitFor("the owner's refusal line", 30_000, async () =>
      (await ownerLogOf(rig)).includes(`deferred close NOT performed for session ${rig.id}`),
    );
    assert.match(await ownerLogOf(rig), /late-bg-1/);
    const ownerPid = await ownerPidOf(rig);
    assert.equal((await recordOf(rig)).closed, false, "fail open: the session stays open");
    assert.equal(isProcessAlive(ownerPid), true, "the owner keeps serving");
    assert.match(await messagesOf(rig), new RegExp(marker));

    // It keeps working: the next turn runs normally.
    const next = await prompt(rig, "echo STILL-SERVING");
    assert.equal(next.code, 0, next.stderr);
    assert.match(next.stdout, /STILL-SERVING/);
  });
});

test("--kill-background-tasks: a forced deferred close closes even with a late background task", async () => {
  await withSession(async (rig) => {
    const flag = path.join(rig.homeDir, "closed-returned");
    const running = prompt(
      rig,
      runThenSay({
        argv: closeFromInside(rig, ["--kill-background-tasks"], flag),
        say: "forced",
        bgTask: [60_000, "late-bg-2"],
        holdMs: 300,
      }),
    );
    await waitFor("the close command returning inside the turn", 30_000, () => exists(flag));
    const ownerPid = await ownerPidOf(rig);
    assert.equal((await running).code, 0);
    await waitForClosedAndOwnerGone(rig, ownerPid);
    assert.doesNotMatch(await ownerLogOf(rig), /deferred close NOT performed/);
  });
});

test("--after-turn from OUTSIDE: scheduled while a turn runs (nothing cut), and an idle session closes at once", async () => {
  await withSession(async (rig) => {
    const flag = path.join(rig.homeDir, "turn-running");
    const marker = `FINAL-REPLY-${process.pid}-after-turn`;
    const running = prompt(rig, runThenSay({ argv: ["touch", flag], say: marker, holdMs: 3_000 }));
    await waitFor("the turn running", 30_000, () => exists(flag));
    const ownerPid = await ownerPidOf(rig);
    const scheduled = await runCli(
      ["--format", "json", "codex", "sessions", "close", "--session-id", rig.id, "--after-turn"],
      rig.homeDir,
    );
    assert.equal(scheduled.code, 0, scheduled.stderr);
    const json = JSON.parse(scheduled.stdout.trim()) as Record<string, unknown>;
    assert.equal(json.action, "session_close_scheduled");
    assert.equal(json.self, false);
    assert.equal(json.activeTurn, true);
    assert.equal((await recordOf(rig)).closed, false);

    assert.equal((await running).code, 0);
    await waitForClosedAndOwnerGone(rig, ownerPid);
    assert.match(await messagesOf(rig), new RegExp(marker), "the in-flight turn was not cut");
  });

  await withSession(async (rig) => {
    const idle = await runCli(
      ["--format", "json", "codex", "sessions", "close", "--session-id", rig.id, "--after-turn"],
      rig.homeDir,
    );
    assert.equal(idle.code, 0, idle.stderr);
    assert.match(idle.stdout, /"action":"session_closed"/, "idle ⇒ an ordinary close, now");
    assert.equal((await recordOf(rig)).closed, true);
  });
});

test("--now and --after-turn together are refused before anything is touched", async () => {
  await withSession(async (rig) => {
    const result = await runCli(
      ["codex", "sessions", "close", "--session-id", rig.id, "--now", "--after-turn"],
      rig.homeDir,
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--now and --after-turn cannot be combined/);
    assert.equal((await recordOf(rig)).closed, false);
  });
});
