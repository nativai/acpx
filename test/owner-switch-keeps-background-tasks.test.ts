// brick://3356183e — a subscription switch must not kill the session's background work.
//
// The defect (OWNER-EXIT.md): an unpinned session is bound to the registry default;
// the pre-turn proactive selection moves it to the best-headroom subscription; that
// turn then ran on a throwaway client which runSessionPrompt closes at turn end —
// killing the adapter and every `run_in_background` Bash / Monitor it held — and the
// owner then exited silently (`onFailoverSwitched` → recycle). Every atrium-created
// session whose default was not the selection target lost its first-turn task.
//
// ⚠️ WHY REAL PROCESSES. The loss is an adapter PROCESS dying at turn end, and the
// observable is a completion that never arrives. So every row runs the real CLI, a
// real queue owner and a real adapter process (the mock, launched from a
// `claude-agent-acp/` path so the Claude-family seam engages exactly as in
// production), and reads the session's own stream file for the completion. A
// stubbed client cannot die, so it could not fail here.
//
// The probe server answers the subscription usage probe: `dflt` (the registry
// default) is at 95 % of its 5h window, `target` at 10 %, so selection moves a
// session off `dflt` by its FORCED rule — no cooldown, no ranking subtlety. A warm
// owner is made by running turn 1 with the probes DOWN: a failed probe is never
// cached and leaves selection no target, so the owner stays on `dflt`; turn 2 then
// probes afresh and selection wants `target` — what a usage change does mid-life.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transcriptJsonlPath } from "../src/config/subscription-transcript.js";
import { scopeHarnessConfigDirRootForCli } from "./config-dir-root-isolation.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const COMPLETION_WAIT_MS = 15_000;

type CliRunResult = { code: number | null; stdout: string; stderr: string };

type Rig = {
  homeDir: string;
  cwd: string;
  subsDir: string;
  probeUrl: string;
  cli: (args: string[]) => Promise<CliRunResult>;
  setProbesUp: (up: boolean) => void;
};

function startProbeServer(): Promise<{
  server: Server;
  url: string;
  setUp: (up: boolean) => void;
}> {
  const fiveHour: Record<string, string> = { "token-dflt": "0.95", "token-target": "0.1" };
  let up = true;
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
      const utilization = fiveHour[token];
      if (!up || utilization === undefined) {
        response.writeHead(500).end("{}");
        return;
      }
      response
        .writeHead(200, {
          "anthropic-ratelimit-unified-5h-utilization": utilization,
          "anthropic-ratelimit-unified-7d-utilization": "0.1",
          "anthropic-ratelimit-unified-7d-reset": "1893456000",
        })
        .end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object");
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/v1/messages`,
        setUp: (next) => {
          up = next;
        },
      });
    });
  });
}

async function runCli(
  rig: Omit<Rig, "cli" | "setProbesUp">,
  args: string[],
): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: rig.homeDir,
      ACPX_STATE_HOME: rig.homeDir,
      ACPX_NO_CATALOGUE_WARM: "1",
      CLAUDE_MESSAGES_ENDPOINT: rig.probeUrl,
    };
    for (const key of Object.keys(env)) {
      // The launching agent's own session/subscription identity must not reach the
      // rig: an inherited parent subscription would pin the child and hide the switch.
      if (
        key.startsWith("ACPX_SESSION_") ||
        key.startsWith("ACPX_PARENT_") ||
        key.startsWith("ACPX_EFFECTIVE_") ||
        key.startsWith("ACPX_SEAT") ||
        key.startsWith("ACPX_BRICK") ||
        key === "ACPX_SUBSCRIPTION" ||
        key === "ACPX_SUBSCRIPTION_AUTO_SELECT" ||
        key === "ACPX_OWNER_LOG" ||
        key === "ACPX_TASK_FOLDER" ||
        key === "CLAUDE_CONFIG_DIR"
      ) {
        delete env[key];
      }
    }
    scopeHarnessConfigDirRootForCli(args, env, rig.homeDir);
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: rig.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-switch-bg-"));
  const { server, url, setUp } = await startProbeServer();
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const adapterDir = path.join(homeDir, "claude-agent-acp", "dist");
    await fs.mkdir(adapterDir, { recursive: true });
    const adapterPath = path.join(adapterDir, "index.js");
    await fs.symlink(MOCK_AGENT_PATH, adapterPath);
    const command = `node ${adapterPath} --claude-agent-acp --supports-load-session`;
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { claude: { command } } }, null, 2)}\n`,
    );
    const subsDir = path.join(homeDir, ".acpx", "subscriptions");
    for (const id of ["dflt", "target"]) {
      await fs.mkdir(path.join(subsDir, id), { recursive: true });
      await fs.writeFile(
        path.join(subsDir, id, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: `token-${id}` } }),
      );
    }
    await fs.writeFile(
      path.join(subsDir, "registry.json"),
      JSON.stringify({
        version: 3,
        default: "dflt",
        profiles: ["dflt", "target"].map((id) => ({
          id,
          label: id,
          authMode: "subscription",
          adapter: "claude",
          account: `${id}-account`,
          credentialSource: path.join(subsDir, id),
        })),
      }),
      { mode: 0o600 },
    );
    const base = { homeDir, cwd, subsDir, probeUrl: url };
    await run({ ...base, cli: async (args) => await runCli(base, args), setProbesUp: setUp });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function sessionFile(rig: Rig, id: string, suffix: string): string {
  return path.join(rig.homeDir, ".acpx", "sessions", `${encodeURIComponent(id)}${suffix}`);
}

async function readText(file: string): Promise<string> {
  return await fs.readFile(file, "utf8").catch(() => "");
}

// On-disk shape: snake_case (`acp_session_id`), options under `.acpx` (acpx PROJECT.md).
type RecordView = {
  acp_session_id: string;
  acpx?: {
    session_options?: {
      profile?: string;
      auto_subscription?: boolean;
      account_switch?: { reason?: string; toProfile?: string };
    };
  };
};

async function readRecord(rig: Rig, id: string): Promise<RecordView> {
  return JSON.parse(await fs.readFile(sessionFile(rig, id, ".json"), "utf8")) as RecordView;
}

// A switch between two subscriptions of a session with real turns must find the
// Claude transcript to port. The mock writes none, so the row writes it, as the
// real adapter would have.
async function writeTranscript(rig: Rig, id: string, subscription: string): Promise<void> {
  const record = await readRecord(rig, id);
  assert.ok(record.acp_session_id, "the record names its ACP session");
  const file = transcriptJsonlPath(
    path.join(rig.subsDir, subscription),
    rig.cwd,
    record.acp_session_id,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"type":"assistant","text":"context"}\n');
}

async function ownerPid(rig: Rig, id: string): Promise<number | null> {
  const status = await rig.cli(["--format", "json", "claude", "status", "--session-id", id]);
  const parsed = JSON.parse(status.stdout.trim() || "{}") as { pid?: number | null };
  return typeof parsed.pid === "number" ? parsed.pid : null;
}

function completed(stream: string, taskId: string): boolean {
  return stream
    .split("\n")
    .some((line) => line.includes('"task_completed"') && line.includes(`"subagentId":"${taskId}"`));
}

async function waitForCompletion(rig: Rig, id: string, taskId: string): Promise<boolean> {
  const deadline = Date.now() + COMPLETION_WAIT_MS;
  while (Date.now() < deadline) {
    if (completed(await readText(sessionFile(rig, id, ".stream.ndjson")), taskId)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function diagnose(rig: Rig, id: string): Promise<string> {
  const record = await readRecord(rig, id);
  return `acp_session_id=${record.acp_session_id} session_options=${JSON.stringify(record.acpx?.session_options)}\nowner.log:\n${await readText(sessionFile(rig, id, ".owner.log"))}`;
}

async function newSession(rig: Rig, options: { autoSubscription: boolean }): Promise<string> {
  const created = await rig.cli(["--format", "json", "claude", "sessions", "new"]);
  assert.equal(created.code, 0, created.stderr);
  const id = String((JSON.parse(created.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId);
  if (!options.autoSubscription) {
    const off = await rig.cli(["claude", "set", "auto-subscription", "off", "--session-id", id]);
    assert.equal(off.code, 0, off.stderr);
  }
  return id;
}

async function prompt(rig: Rig, id: string, text: string): Promise<CliRunResult> {
  const result = await rig.cli(["--approve-all", "claude", "prompt", "--session-id", id, text]);
  assert.equal(result.code, 0, `prompt "${text}" failed: ${result.stderr}`);
  return result;
}

async function closeSession(rig: Rig, id: string): Promise<void> {
  await rig.cli(["claude", "sessions", "close", id]);
}

test("cold owner: a first turn that selection moves off the default keeps its background task", async () => {
  await withRig(async (rig) => {
    const id = await newSession(rig, { autoSubscription: true });
    try {
      await prompt(rig, id, "bg-task 2000 cold1");
      const owner = await ownerPid(rig, id);

      const record = await readRecord(rig, id);
      assert.equal(record.acpx?.session_options?.account_switch?.reason, "selection");
      assert.equal(record.acpx?.session_options?.profile, "target", "selection moved the session");
      assert.equal(
        await waitForCompletion(rig, id, "cold1"),
        true,
        "the background task's completion must arrive after the turn — its adapter survived",
      );
      assert.notEqual(owner, null, "the owner is still serving after the turn");
      assert.equal(await ownerPid(rig, id), owner, "the same owner, not a respawn");
      const log = await readText(sessionFile(rig, id, ".owner.log"));
      assert.match(log, /switched session \S+ to target before the turn \(by selection\)/u);
      assert.doesNotMatch(log, /queue owner recycling session/u, "no turn-boundary recycle");
    } finally {
      await closeSession(rig, id);
    }
  });
});

test("warm owner, no live task: the switching turn's own background task survives", async () => {
  await withRig(async (rig) => {
    const id = await newSession(rig, { autoSubscription: true });
    try {
      rig.setProbesUp(false);
      await prompt(rig, id, "echo warm");
      const warmOwner = await ownerPid(rig, id);
      assert.notEqual(warmOwner, null, "turn 1 left a warm owner on dflt");
      assert.equal((await readRecord(rig, id)).acpx?.session_options?.profile, "dflt");
      await writeTranscript(rig, id, "dflt");
      rig.setProbesUp(true);

      await prompt(rig, id, "bg-task 2000 warm2");

      const record = await readRecord(rig, id);
      assert.equal(
        record.acpx?.session_options?.account_switch?.reason,
        "selection",
        await diagnose(rig, id),
      );
      assert.equal(record.acpx?.session_options?.profile, "target");
      assert.equal(
        await waitForCompletion(rig, id, "warm2"),
        true,
        "a task started IN the switching turn lives on the replacement client, so it completes",
      );
      assert.equal(await ownerPid(rig, id), warmOwner, "the warm owner was kept, not recycled");
      const log = await readText(sessionFile(rig, id, ".owner.log"));
      assert.match(
        log,
        /to target before the turn \(by selection\); replaced its adapter client in \d+ ms, killing 0 live background/u,
      );
      assert.doesNotMatch(log, /queue owner recycling session/u);
    } finally {
      await closeSession(rig, id);
    }
  });
});

test("warm owner WITH a live task: selection defers, no switch, and the task completes", async () => {
  await withRig(async (rig) => {
    const id = await newSession(rig, { autoSubscription: true });
    try {
      rig.setProbesUp(false);
      // Long enough to complete AFTER turn 2, while the owner's idle drain writes the
      // stream: frames between a turn and the idle drain reach no stream writer.
      await prompt(rig, id, "bg-task 9000 live3");
      const warmOwner = await ownerPid(rig, id);
      assert.notEqual(warmOwner, null);
      assert.equal((await readRecord(rig, id)).acpx?.session_options?.profile, "dflt");
      await writeTranscript(rig, id, "dflt");
      rig.setProbesUp(true);

      await prompt(rig, id, "echo second turn");

      const record = await readRecord(rig, id);
      assert.equal(
        record.acpx?.session_options?.profile,
        "dflt",
        `selection did NOT switch\n${await diagnose(rig, id)}`,
      );
      assert.equal(record.acpx?.session_options?.account_switch, undefined);
      assert.equal(
        await waitForCompletion(rig, id, "live3"),
        true,
        "the turn-1 task survives turn 2",
      );
      assert.equal(await ownerPid(rig, id), warmOwner);
      const log = await readText(sessionFile(rig, id, ".owner.log"));
      assert.match(
        log,
        /proactive subscription switch dflt → target deferred for session \S+: 1 live background task/u,
      );
      assert.doesNotMatch(log, /queue owner recycling session/u);
    } finally {
      await closeSession(rig, id);
    }
  });
});

test("reactive failover still switches, and its recycle line counts the task it kills", async () => {
  await withRig(async (rig) => {
    const id = await newSession(rig, { autoSubscription: false });
    try {
      await prompt(rig, id, "bg-task 60000 lost4");
      await writeTranscript(rig, id, "dflt");

      const served = await rig.cli([
        "--approve-all",
        "claude",
        "prompt",
        "--session-id",
        id,
        "rate-limited-on /dflt",
      ]);
      assert.equal(
        served.code,
        0,
        `${served.stdout}\n${served.stderr}\n${await diagnose(rig, id)}`,
      );
      assert.match(served.stdout, /served after failover/u, "the retried turn was served");

      const record = await readRecord(rig, id);
      assert.equal(record.acpx?.session_options?.profile, "target", "failover switched");
      const log = await readText(sessionFile(rig, id, ".owner.log"));
      assert.match(
        log,
        /queue owner recycling session \S+ after turn \(reason=account-switch; switched to target by failover\); killing 1 live background task\(s\)/u,
      );
    } finally {
      await closeSession(rig, id);
    }
  });
});
