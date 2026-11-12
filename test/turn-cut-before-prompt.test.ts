// brick 6f461fe4 — a turn cut before its prompt reached the adapter must not be logged as submitted.
//
// The field case (consol-stack 7781a8ca, creation prompt 60bb9c91): the queue owner switched the
// session sub5 → sub7 at turn start and replaced its adapter client; the replacement connects cold
// (initialize, then session/resume — slow on an account that never held the conversation). A close
// landed in that connect. The model never got the prompt (no `session/prompt` frame, no reply), yet
// `messages.ndjson` held a User row for it and the stream an `acpx/turn active`: the transcript
// claimed a submission that never happened, and the connect's own frames never reached the stream.
//
// ⚠️ WHY REAL PROCESSES. The loss is an owner and its adapter dying inside the connect, so every
// row runs the real CLI, a real queue owner and a real adapter process (the mock, launched from a
// `claude-agent-acp/` path so the Claude-family seam engages as in production). The adapter's
// `initialize` is slowed so the connect is a window a close can land in, as the slow cold resume
// was in the field.
//
// The probe server answers the subscription usage probe: `dflt` (the registry default) is at 95 %
// of its 5h window, `target` at 10 %, so selection moves an auto-subscription session off `dflt`
// before its first turn (the swap); with auto-subscription off there is no swap (the control).
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scopeHarnessConfigDirRootForCli } from "./config-dir-root-isolation.js";
import { removeTempHome } from "./temp-home.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
// Long enough that the close's drain barrier (below) times out while the turn is still
// connecting; short enough to keep the rows quick.
const INITIALIZE_DELAY_MS = 4_000;
const CLOSE_DRAIN_TIMEOUT_MS = "500";
const WAIT_MS = 20_000;

type CliRunResult = { code: number | null; stdout: string; stderr: string };

type Rig = {
  homeDir: string;
  cwd: string;
  cli: (args: string[]) => Promise<CliRunResult>;
};

function startProbeServer(): Promise<{ server: Server; url: string }> {
  const fiveHour: Record<string, string> = { "token-dflt": "0.95", "token-target": "0.1" };
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const token = (request.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
      const utilization = fiveHour[token];
      if (utilization === undefined) {
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
      resolve({ server, url: `http://127.0.0.1:${address.port}/v1/messages` });
    });
  });
}

async function runCli(
  rig: { homeDir: string; cwd: string; probeUrl: string },
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
      // The launching agent's own session/subscription identity must not reach the rig.
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

async function withRig(adapterArgs: string[], run: (rig: Rig) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-turn-cut-"));
  const { server, url } = await startProbeServer();
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const adapterDir = path.join(homeDir, "claude-agent-acp", "dist");
    await fs.mkdir(adapterDir, { recursive: true });
    const adapterPath = path.join(adapterDir, "index.js");
    await fs.symlink(MOCK_AGENT_PATH, adapterPath);
    const command = [
      "node",
      adapterPath,
      "--claude-agent-acp",
      "--supports-load-session",
      ...adapterArgs,
    ].join(" ");
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
    const base = { homeDir, cwd, probeUrl: url };
    await run({ homeDir, cwd, cli: async (args) => await runCli(base, args) });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeTempHome(homeDir);
  }
}

function sessionFile(rig: Rig, id: string, suffix: string): string {
  return path.join(rig.homeDir, ".acpx", "sessions", `${encodeURIComponent(id)}${suffix}`);
}

async function readText(file: string): Promise<string> {
  return await fs.readFile(file, "utf8").catch(() => "");
}

function frames(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function promptFrameFor(stream: string, messageId: string): boolean {
  return frames(stream).some(
    (frame) =>
      frame.method === "session/prompt" &&
      (frame.params as { messageId?: unknown } | undefined)?.messageId === messageId,
  );
}

function userRowFor(messagesLog: string, messageId: string): boolean {
  return frames(messagesLog).some(
    (row) => (row.User as { id?: unknown } | undefined)?.id === messageId,
  );
}

function deliveryPhases(stream: string, messageId: string): string[] {
  return frames(stream).flatMap((frame) => {
    const params = frame.params as { messageId?: unknown; phase?: unknown } | undefined;
    return frame.method === "acpx/delivery" && params?.messageId === messageId
      ? [String(params.phase)]
      : [];
  });
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
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

function sendPrompt(rig: Rig, id: string, messageId: string, text: string) {
  return rig.cli([
    "--approve-all",
    "claude",
    "prompt",
    "--session-id",
    id,
    "--message-id",
    messageId,
    text,
  ]);
}

async function diagnose(rig: Rig, id: string): Promise<string> {
  return (
    `owner.log:\n${await readText(sessionFile(rig, id, ".owner.log"))}\n` +
    `stream:\n${await readText(sessionFile(rig, id, ".stream.ndjson"))}\n` +
    `messages:\n${await readText(sessionFile(rig, id, ".messages.ndjson"))}`
  );
}

// Cut the turn while its client is still connecting: the turn is active (its `acpx/turn` frame is
// written) and, for the swap rows, the owner has replaced its client; the adapter is still inside
// its slowed `initialize`, so no `session/prompt` can have gone out.
async function closeMidConnect(rig: Rig, id: string, opts: { swap: boolean }): Promise<void> {
  await waitFor(async () => {
    const stream = await readText(sessionFile(rig, id, ".stream.ndjson"));
    const log = await readText(sessionFile(rig, id, ".owner.log"));
    return (
      stream.includes('"phase":"active"') &&
      (!opts.swap || /replaced its adapter client/u.test(log))
    );
  }, "the turn to start connecting");
  const closed = await rig.cli([
    "claude",
    "sessions",
    "close",
    "--session-id",
    id,
    "--drain-timeout",
    CLOSE_DRAIN_TIMEOUT_MS,
  ]);
  assert.equal(closed.code, 0, `${closed.stdout}\n${closed.stderr}`);
}

async function assertNotLoggedAsSubmitted(rig: Rig, id: string, messageId: string): Promise<void> {
  const stream = await readText(sessionFile(rig, id, ".stream.ndjson"));
  const messagesLog = await readText(sessionFile(rig, id, ".messages.ndjson"));
  assert.equal(
    promptFrameFor(stream, messageId),
    false,
    `precondition: the prompt never reached the adapter\n${await diagnose(rig, id)}`,
  );
  assert.equal(
    userRowFor(messagesLog, messageId),
    false,
    `a prompt the adapter never received must not be logged as submitted (User row in messages.ndjson)\n${await diagnose(rig, id)}`,
  );
  assert.deepEqual(
    deliveryPhases(stream, messageId).filter((phase) => phase === "accepted" || phase === "done"),
    [],
    `no acceptance for a prompt that never reached the adapter\n${await diagnose(rig, id)}`,
  );
}

test("swap at turn start, close inside the replacement client's connect: the prompt is not logged as submitted", async () => {
  await withRig(["--initialize-delay-ms", String(INITIALIZE_DELAY_MS)], async (rig) => {
    const id = await newSession(rig, { autoSubscription: true });
    const messageId = randomUUID();
    const sent = sendPrompt(rig, id, messageId, "echo creation prompt");
    await closeMidConnect(rig, id, { swap: true });
    await sent;
    const log = await readText(sessionFile(rig, id, ".owner.log"));
    assert.match(log, /switched session \S+ to target before the turn \(by selection\)/u);
    await assertNotLoggedAsSubmitted(rig, id, messageId);
  });
});

test("no swap (auto-subscription off), close inside the cold connect: the prompt is not logged as submitted", async () => {
  await withRig(["--initialize-delay-ms", String(INITIALIZE_DELAY_MS)], async (rig) => {
    const id = await newSession(rig, { autoSubscription: false });
    const messageId = randomUUID();
    const sent = sendPrompt(rig, id, messageId, "echo creation prompt");
    await closeMidConnect(rig, id, { swap: false });
    await sent;
    const log = await readText(sessionFile(rig, id, ".owner.log"));
    assert.doesNotMatch(log, /replaced its adapter client/u, "the control row has no swap");
    await assertNotLoggedAsSubmitted(rig, id, messageId);
  });
});

test("swap at turn start, no close: the prompt is delivered on the replacement client and logged once", async () => {
  await withRig([], async (rig) => {
    const id = await newSession(rig, { autoSubscription: true });
    try {
      const messageId = randomUUID();
      const sent = await sendPrompt(rig, id, messageId, "echo swapped turn");
      assert.equal(sent.code, 0, `${sent.stdout}\n${sent.stderr}\n${await diagnose(rig, id)}`);
      assert.match(sent.stdout, /swapped turn/u, "the agent answered");
      const log = await readText(sessionFile(rig, id, ".owner.log"));
      assert.match(log, /switched session \S+ to target before the turn \(by selection\)/u);
      const stream = await readText(sessionFile(rig, id, ".stream.ndjson"));
      assert.equal(promptFrameFor(stream, messageId), true, await diagnose(rig, id));
      const rows = frames(await readText(sessionFile(rig, id, ".messages.ndjson"))).filter(
        (row) => (row.User as { id?: unknown } | undefined)?.id === messageId,
      );
      assert.equal(rows.length, 1, "exactly one User row for the delivered prompt");
    } finally {
      await rig.cli(["claude", "sessions", "close", "--session-id", id]);
    }
  });
});

test("no swap, no close: a normal turn is delivered and logged once (unchanged)", async () => {
  await withRig([], async (rig) => {
    const id = await newSession(rig, { autoSubscription: false });
    try {
      const messageId = randomUUID();
      const sent = await sendPrompt(rig, id, messageId, "echo plain turn");
      assert.equal(sent.code, 0, `${sent.stdout}\n${sent.stderr}\n${await diagnose(rig, id)}`);
      assert.match(sent.stdout, /plain turn/u);
      const log = await readText(sessionFile(rig, id, ".owner.log"));
      assert.doesNotMatch(log, /replaced its adapter client/u);
      const stream = await readText(sessionFile(rig, id, ".stream.ndjson"));
      assert.equal(promptFrameFor(stream, messageId), true, await diagnose(rig, id));
      const rows = frames(await readText(sessionFile(rig, id, ".messages.ndjson"))).filter(
        (row) => (row.User as { id?: unknown } | undefined)?.id === messageId,
      );
      assert.equal(rows.length, 1);
    } finally {
      await rig.cli(["claude", "sessions", "close", "--session-id", id]);
    }
  });
});
