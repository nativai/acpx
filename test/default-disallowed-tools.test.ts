// brick ab754b0d — default `disallowedTools` to the six harness-tool block
// (ScheduleWakeup, CronCreate, CronList, CronDelete, RemoteTrigger, Skill) for the
// `claude` agent type ONLY, applied ONLY when --disallowed-tools is never passed
// at all. `--disallowed-tools ""` (parses to []) is the escape hatch and must
// clear the default rather than fall back to it. All underlying enforcement
// (blocking these tools actually removes them from the model's tool listing) was
// independently verified live — see the brick's CONTENT.md and item 1's
// verification at /wisdom/Bricks/7ac24c20-14cc-4fa9-b825-13dcbee3b3c3/. These
// tests lock only the NEW piece: the default-value seam itself, at the
// session-creation record (`sessions new`), driven through the real CLI against a
// mock ACP agent.
import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { scopeHarnessConfigDirRootForCli } from "./config-dir-root-isolation.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
// The `--claude-agent-acp` arg is what makes acpAdapterKind(agentCommand) resolve
// to "claude" (agent-command.ts's isClaudeAcpCommand matches any arg containing
// that substring) — same convention as cli.test.ts's GUARD_CLAUDE_COMMAND. A bare
// mock command with no such marker is deliberately NOT detected as "claude", even
// when registered under the agent NAME "claude" — this is what the negative test
// below relies on to prove the gate is on the resolved adapter kind, not the name.
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const CLAUDE_ADAPTER_COMMAND = `${MOCK_AGENT_COMMAND} --claude-agent-acp`;

const EXPECTED_DEFAULT = [
  "ScheduleWakeup",
  "CronCreate",
  "CronList",
  "CronDelete",
  "RemoteTrigger",
  "Skill",
];

type CliRunResult = { code: number | null; stdout: string; stderr: string };

async function runCli(args: string[], homeDir: string, cwd: string): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
    ]) {
      delete env[key];
    }
    scopeHarnessConfigDirRootForCli(args, env, homeDir);
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.stdin.end();
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withAgentHome(
  agentCommand: string,
  run: (homeDir: string, cwd: string) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-disallowed-default-"));
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { claude: { command: agentCommand } } }, null, 2)}\n`,
      "utf8",
    );
    await run(homeDir, cwd);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

async function newSessionAndReadDisallowedTools(
  homeDir: string,
  cwd: string,
  extraArgs: string[],
  name: string,
): Promise<unknown> {
  const result = await runCli(
    ["--cwd", cwd, "--format", "json", ...extraArgs, "claude", "sessions", "new", "--name", name],
    homeDir,
    cwd,
  );
  assert.equal(result.code, 0, `sessions new failed: ${result.stderr}`);
  const payload = JSON.parse(result.stdout.trim()) as { acpxRecordId?: string };
  const recordId = String(payload.acpxRecordId);
  const stored = JSON.parse(
    await fs.readFile(
      path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(recordId)}.json`),
      "utf8",
    ),
  ) as { acpx?: { session_options?: { disallowed_tools?: unknown } } };
  return stored.acpx?.session_options?.disallowed_tools;
}

test("default-disallowed-tools: claude spawn with NO --disallowed-tools flag defaults to the six-tool block", async () => {
  await withAgentHome(CLAUDE_ADAPTER_COMMAND, async (homeDir, cwd) => {
    const disallowedTools = await newSessionAndReadDisallowedTools(homeDir, cwd, [], "default-on");
    assert.deepEqual(disallowedTools, EXPECTED_DEFAULT);
  });
});

test('default-disallowed-tools: claude spawn with --disallowed-tools "" clears the default (escape hatch)', async () => {
  await withAgentHome(CLAUDE_ADAPTER_COMMAND, async (homeDir, cwd) => {
    const disallowedTools = await newSessionAndReadDisallowedTools(
      homeDir,
      cwd,
      ["--disallowed-tools", ""],
      "default-cleared",
    );
    assert.deepEqual(disallowedTools, []);
  });
});

test("default-disallowed-tools: an explicit non-empty --disallowed-tools list passes through unchanged", async () => {
  await withAgentHome(CLAUDE_ADAPTER_COMMAND, async (homeDir, cwd) => {
    const disallowedTools = await newSessionAndReadDisallowedTools(
      homeDir,
      cwd,
      ["--disallowed-tools", "Bash,WebFetch"],
      "default-overridden",
    );
    assert.deepEqual(disallowedTools, ["Bash", "WebFetch"]);
  });
});

// Registered under the agent NAME "claude" but resolving to a command
// acpAdapterKind does NOT classify as "claude" (no claude-agent-acp marker) — the
// gate must be on the resolved adapter kind, not the CLI's agent-name string, so
// this must NOT receive the default. This is the same discipline CONTENT.md
// requires for excluding claude-pty, exercised from the opposite side.
test("default-disallowed-tools: an agent NAMED claude but not adapter-kind-detected as claude gets no default", async () => {
  await withAgentHome(MOCK_AGENT_COMMAND, async (homeDir, cwd) => {
    const disallowedTools = await newSessionAndReadDisallowedTools(
      homeDir,
      cwd,
      [],
      "non-claude-adapter",
    );
    assert.equal(disallowedTools, undefined);
  });
});

// ---------------------------------------------------------------------------
// `exec` (handleExec/runOnce) builds sessionOptions via the SAME
// sessionOptionsFromGlobalFlags(globalFlags) call as the turn/prompt path, but
// unlike a turn on a durable session it is a fresh one-shot every invocation —
// there is no stored fallback for a later call to clobber, so the reasoning that
// kept the default OUT of the shared per-turn/exec-merge function (protecting the
// "" escape hatch across turns of a DURABLE session) does not exempt exec itself;
// it was a genuine gap, closed at its own call site in handleExec. `exec` persists
// no session record, so — unlike `sessions new` above — this reads the default
// back off the mock agent's operation log (session/new _meta.claudeCode.options),
// via the disallowedToolsFromNewSessionMeta sibling added to mock-agent.ts.
// ---------------------------------------------------------------------------

type MockOperation = { method?: string; disallowedTools?: string[] };

async function readMockOperations(operationLog: string): Promise<MockOperation[]> {
  const raw = await fs.readFile(operationLog, "utf8");
  return raw
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as MockOperation);
}

async function execAndReadDisallowedTools(
  homeDir: string,
  cwd: string,
  extraArgs: string[],
  operationLog: string,
): Promise<unknown> {
  const result = await runCli(
    ["--cwd", cwd, ...extraArgs, "claude", "exec", "hello"],
    homeDir,
    cwd,
  );
  assert.equal(result.code, 0, `exec failed: ${result.stderr}`);
  const sessionNew = (await readMockOperations(operationLog)).find(
    (operation) => operation.method === "session/new",
  );
  assert.ok(sessionNew, "mock agent never recorded a session/new operation");
  return sessionNew.disallowedTools;
}

test("default-disallowed-tools: claude exec with NO --disallowed-tools flag defaults to the six-tool block", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-disallowed-default-exec-"));
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    const operationLog = path.join(homeDir, "exec-ops.jsonl");
    const command = `${CLAUDE_ADAPTER_COMMAND} --operation-log ${JSON.stringify(operationLog)}`;
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { claude: { command } } }, null, 2)}\n`,
      "utf8",
    );
    const disallowedTools = await execAndReadDisallowedTools(homeDir, cwd, [], operationLog);
    assert.deepEqual(disallowedTools, EXPECTED_DEFAULT);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('default-disallowed-tools: claude exec with --disallowed-tools "" clears the default (escape hatch)', async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-disallowed-default-exec-"));
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    const operationLog = path.join(homeDir, "exec-ops.jsonl");
    const command = `${CLAUDE_ADAPTER_COMMAND} --operation-log ${JSON.stringify(operationLog)}`;
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { claude: { command } } }, null, 2)}\n`,
      "utf8",
    );
    const disallowedTools = await execAndReadDisallowedTools(
      homeDir,
      cwd,
      ["--disallowed-tools", ""],
      operationLog,
    );
    assert.deepEqual(disallowedTools, []);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
