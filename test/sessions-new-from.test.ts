import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// Brick 06b01b6b — `sessions new --from <old-session-id|url>` (Daniel 2026-09-28: "passing in an
// old session and … relevant options are being automatically transferred"). Every row drives the
// real compiled CLI and reads the NEW record back from DISK, snake_case (`.acpx.session_options.*`),
// because the failure this feature is exposed to is an option dropped on the way into the record.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const CLAUDE_COMMAND = `${MOCK_AGENT_COMMAND} --claude-agent-acp --advertise-models --advertise-config-options`;
const OTHER_AGENT_COMMAND = `node ${JSON.stringify(path.join(path.dirname(MOCK_AGENT_PATH), "other-agent.js"))}`;
const BRICK_SHIM_DIR = path.join(process.cwd(), "test", "fixtures", "brick-shim");
const BRICK_A = "1a5845c3-a832-4370-b564-8ec5286bff79";
const BRICK_B = "1d459def-bbfd-44b6-8e14-9ad998f292d6";

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(
  args: string[],
  homeDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ...extraEnv };
    delete env.ACPX_STATE_HOME;
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_SEAT_URL",
      "ACPX_PARENT_SEAT_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
    ]) {
      if (!Object.prototype.hasOwnProperty.call(extraEnv, key)) {
        delete env[key];
      }
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function brickShimEnv(brickId: string): NodeJS.ProcessEnv {
  return {
    PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
    BRICK_SHIM_MODE: "ok",
    BRICK_SHIM_ID: brickId,
  };
}

type StoredRecord = {
  cwd?: string;
  name?: string;
  favorite?: boolean;
  closed?: boolean;
  agent_command?: string;
  parent_session_id?: string;
  seat_id?: string;
  holder_ordinal?: number;
  holder_active?: boolean;
  messages?: unknown[];
  metadata?: Record<string, string>;
  acpx?: {
    session_options?: Record<string, unknown>;
    desired_config_options?: { effort?: unknown };
  };
};

async function readStored(homeDir: string, id: string): Promise<StoredRecord> {
  return JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as StoredRecord;
}

function createdId(result: CliResult): string {
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim()) as { acpxRecordId?: unknown };
  assert.equal(typeof payload.acpxRecordId, "string");
  return payload.acpxRecordId as string;
}

async function writeConfig(homeDir: string): Promise<void> {
  const subscriptionsRoot = path.join(homeDir, ".acpx", "subscriptions");
  for (const id of ["sub1", "sub2"]) {
    await fs.mkdir(path.join(subscriptionsRoot, id), { recursive: true });
  }
  await fs.writeFile(
    path.join(subscriptionsRoot, "registry.json"),
    `${JSON.stringify({
      version: 3,
      default: "sub1",
      profiles: ["sub1", "sub2"].map((id) => ({
        id,
        label: id,
        authMode: "subscription",
        adapter: "claude",
        account: `acct-${id}`,
        credentialSource: path.join(subscriptionsRoot, id),
      })),
    })}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify({ agents: { claude: { command: CLAUDE_COMMAND } } })}\n`,
    "utf8",
  );
}

// An "old" session carrying EVERY transferable option plus the things that must NOT transfer
// (name, favorite, history).
async function writeOldSession(
  homeDir: string,
  params: { cwd: string; parentId: string; agentCommand?: string; id?: string },
): Promise<string> {
  const id = params.id ?? "old-session";
  await writeSessionRecordFile(
    homeDir,
    makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: id,
      agentCommand: params.agentCommand ?? CLAUDE_COMMAND,
      cwd: params.cwd,
      name: "predecessor",
      favorite: true,
      parentSessionId: params.parentId,
      metadata: { brick: BRICK_A },
      acpx: {
        session_options: {
          model: "opus[1m]",
          profile: "sub2",
          allowed_tools: ["Read", "Grep"],
          system_prompt: "be terse",
          output_style: "Explanatory",
          auto_failover: false,
        },
        desired_config_options: { effort: "high" },
      },
    }),
  );
  return id;
}

async function writeParent(homeDir: string, cwd: string, id: string): Promise<void> {
  await writeSessionRecordFile(
    homeDir,
    makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: id,
      agentCommand: CLAUDE_COMMAND,
      cwd,
    }),
  );
}

const COMMON = ["--format", "json", "--approve-all"];

test("--from copies model, effort, profile, auto-failover, allowed tools, system prompt, output style, cwd, parent and brick", async () => {
  await withTempHome("acpx-from-all-", async (homeDir) => {
    await writeConfig(homeDir);
    const oldCwd = path.join(homeDir, "old-workspace");
    await fs.mkdir(oldCwd, { recursive: true });
    await writeParent(homeDir, oldCwd, "the-parent");
    const oldId = await writeOldSession(homeDir, { cwd: oldCwd, parentId: "the-parent" });

    const result = await runCli(
      [...COMMON, "claude", "sessions", "new", "--from", oldId],
      homeDir,
      brickShimEnv(BRICK_A),
    );
    const stored = await readStored(homeDir, createdId(result));

    const options = stored.acpx?.session_options ?? {};
    assert.equal(options.model, "opus[1m]");
    assert.equal(options.profile, "sub2");
    assert.deepEqual(options.allowed_tools, ["Read", "Grep"]);
    assert.equal(options.system_prompt, "be terse");
    assert.equal(options.output_style, "Explanatory");
    assert.equal(options.auto_failover, false);
    assert.equal(stored.acpx?.desired_config_options?.effort, "high");
    assert.equal(stored.cwd, oldCwd);
    assert.equal(stored.parent_session_id, "the-parent");
    assert.equal(stored.metadata?.brick, BRICK_A);
  });
});

test("--from transfers NOTHING else: not the name, favorite, closed state or history", async () => {
  await withTempHome("acpx-from-nothing-else-", async (homeDir) => {
    await writeConfig(homeDir);
    const oldCwd = path.join(homeDir, "old-workspace");
    await fs.mkdir(oldCwd, { recursive: true });
    await writeParent(homeDir, oldCwd, "the-parent");
    const oldId = await writeOldSession(homeDir, { cwd: oldCwd, parentId: "the-parent" });

    const result = await runCli(
      [...COMMON, "claude", "sessions", "new", "--from", oldId],
      homeDir,
      brickShimEnv(BRICK_A),
    );
    const stored = await readStored(homeDir, createdId(result));

    assert.notEqual(stored.name, "predecessor");
    assert.notEqual(stored.favorite, true);
    assert.notEqual(stored.closed, true);
    assert.deepEqual(stored.messages ?? [], []);
  });
});

test("--from resolves a session URL as well as a bare id", async () => {
  await withTempHome("acpx-from-url-", async (homeDir) => {
    await writeConfig(homeDir);
    const oldCwd = path.join(homeDir, "old-workspace");
    await fs.mkdir(oldCwd, { recursive: true });
    await writeParent(homeDir, oldCwd, "the-parent");
    const oldId = await writeOldSession(homeDir, { cwd: oldCwd, parentId: "the-parent" });

    const result = await runCli(
      [
        ...COMMON,
        "claude",
        "sessions",
        "new",
        "--from",
        `https://atrium.example.test/?session=${oldId}`,
      ],
      homeDir,
      brickShimEnv(BRICK_A),
    );
    const stored = await readStored(homeDir, createdId(result));
    assert.equal(stored.acpx?.session_options?.model, "opus[1m]");
    assert.equal(stored.cwd, oldCwd);
  });
});

test("an explicit flag overrides what --from would have copied", async () => {
  await withTempHome("acpx-from-override-", async (homeDir) => {
    await writeConfig(homeDir);
    const oldCwd = path.join(homeDir, "old-workspace");
    const newCwd = path.join(homeDir, "new-workspace");
    await fs.mkdir(oldCwd, { recursive: true });
    await fs.mkdir(newCwd, { recursive: true });
    await writeParent(homeDir, oldCwd, "the-parent");
    await writeParent(homeDir, oldCwd, "other-parent");
    const oldId = await writeOldSession(homeDir, { cwd: oldCwd, parentId: "the-parent" });

    const result = await runCli(
      [
        "--cwd",
        newCwd,
        ...COMMON,
        "--model",
        "sonnet",
        "--reasoning-effort",
        "low",
        "--profile",
        "sub1",
        "--allowed-tools",
        "Bash",
        "claude",
        "sessions",
        "new",
        "--from",
        oldId,
        "--parent-id",
        "other-parent",
        "--brick",
        BRICK_B,
      ],
      homeDir,
      brickShimEnv(BRICK_B),
    );
    const stored = await readStored(homeDir, createdId(result));

    const options = stored.acpx?.session_options ?? {};
    assert.equal(options.model, "sonnet");
    assert.equal(options.profile, "sub1");
    assert.deepEqual(options.allowed_tools, ["Bash"]);
    assert.equal(stored.acpx?.desired_config_options?.effort, "low");
    assert.equal(stored.cwd, newCwd);
    assert.equal(stored.parent_session_id, "other-parent");
    assert.equal(stored.metadata?.brick, BRICK_B);
    // What no flag touched still comes from the old session.
    assert.equal(options.system_prompt, "be terse");
    assert.equal(options.output_style, "Explanatory");
    assert.equal(options.auto_failover, false);
  });
});

test("--no-brick beats the brick link --from would have copied", async () => {
  await withTempHome("acpx-from-no-brick-", async (homeDir) => {
    await writeConfig(homeDir);
    const oldCwd = path.join(homeDir, "old-workspace");
    await fs.mkdir(oldCwd, { recursive: true });
    await writeParent(homeDir, oldCwd, "the-parent");
    const oldId = await writeOldSession(homeDir, { cwd: oldCwd, parentId: "the-parent" });

    const result = await runCli(
      [...COMMON, "claude", "sessions", "new", "--from", oldId, "--no-brick"],
      homeDir,
      brickShimEnv(BRICK_A),
    );
    const stored = await readStored(homeDir, createdId(result));
    assert.equal(stored.metadata?.brick, undefined);
  });
});

test("--from a seated session creates the new session INTO that seat, prepared (not active)", async () => {
  await withTempHome("acpx-from-seat-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, ...COMMON];

    const oldId = createdId(await runCli([...base, "sessions", "new", "-s", "holder"], homeDir));
    const old = await readStored(homeDir, oldId);
    assert.equal(typeof old.seat_id, "string");

    const successorId = createdId(
      await runCli([...base, "sessions", "new", "--from", oldId], homeDir),
    );
    const successor = await readStored(homeDir, successorId);
    assert.equal(successor.seat_id, old.seat_id);
    assert.equal(successor.holder_active, false);
    assert.equal(successor.holder_ordinal, undefined);
    // The predecessor keeps the seat until `sessions activate` hands it over.
    assert.equal((await readStored(homeDir, oldId)).holder_active, true);
  });
});

test("an explicit --seat beats the seat --from would have joined", async () => {
  await withTempHome("acpx-from-seat-override-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, ...COMMON];

    const oldId = createdId(await runCli([...base, "sessions", "new", "-s", "a"], homeDir));
    const otherId = createdId(await runCli([...base, "sessions", "new", "-s", "b"], homeDir));
    const otherSeat = (await readStored(homeDir, otherId)).seat_id;
    assert.notEqual(otherSeat, (await readStored(homeDir, oldId)).seat_id);

    const successorId = createdId(
      await runCli(
        [...base, "sessions", "new", "--from", oldId, "--seat", String(otherSeat)],
        homeDir,
      ),
    );
    assert.equal((await readStored(homeDir, successorId)).seat_id, otherSeat);
  });
});

test("--from a session with no seat mints a fresh seat for the new session", async () => {
  await withTempHome("acpx-from-no-seat-", async (homeDir) => {
    await writeConfig(homeDir);
    const oldCwd = path.join(homeDir, "old-workspace");
    await fs.mkdir(oldCwd, { recursive: true });
    await writeParent(homeDir, oldCwd, "the-parent");
    const oldId = await writeOldSession(homeDir, { cwd: oldCwd, parentId: "the-parent" });

    const result = await runCli(
      [...COMMON, "claude", "sessions", "new", "--from", oldId],
      homeDir,
      brickShimEnv(BRICK_A),
    );
    const stored = await readStored(homeDir, createdId(result));
    assert.equal(typeof stored.seat_id, "string");
    assert.equal(stored.holder_active, true);
    assert.equal(stored.holder_ordinal, 1);
  });
});

test("an agent-specific option is SKIPPED, with a stderr note, when the new session's agent differs", async () => {
  await withTempHome("acpx-from-other-agent-", async (homeDir) => {
    await writeConfig(homeDir);
    const oldCwd = path.join(homeDir, "old-workspace");
    await fs.mkdir(oldCwd, { recursive: true });
    await writeParent(homeDir, oldCwd, "the-parent");
    const oldId = await writeOldSession(homeDir, {
      cwd: oldCwd,
      parentId: "the-parent",
      agentCommand: OTHER_AGENT_COMMAND,
    });

    const result = await runCli(
      ["--agent", MOCK_AGENT_COMMAND, ...COMMON, "sessions", "new", "--from", oldId],
      homeDir,
      brickShimEnv(BRICK_A),
    );
    const stored = await readStored(homeDir, createdId(result));

    const options = stored.acpx?.session_options ?? {};
    for (const key of [
      "model",
      "profile",
      "allowed_tools",
      "system_prompt",
      "output_style",
      "auto_failover",
    ]) {
      assert.equal(options[key], undefined, `${key} crossed an agent boundary`);
    }
    assert.equal(stored.acpx?.desired_config_options?.effort, undefined);
    assert.match(result.stderr, /--from .*skipped .*model/);
    // Agent-independent defaults still transfer.
    assert.equal(stored.cwd, oldCwd);
    assert.equal(stored.parent_session_id, "the-parent");
    assert.equal(stored.metadata?.brick, BRICK_A);
  });
});

test("an unknown --from id refuses with a clear message and creates nothing", async () => {
  await withTempHome("acpx-from-unknown-", async (homeDir) => {
    await writeConfig(homeDir);
    const sessionDir = path.join(homeDir, ".acpx", "sessions");

    const result = await runCli(
      [...COMMON, "claude", "sessions", "new", "--from", "no-such-session"],
      homeDir,
    );

    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr + result.stdout,
      /--from refers to unknown session: no-such-session/,
    );
    const entries = await fs.readdir(sessionDir).catch(() => [] as string[]);
    assert.deepEqual(
      entries.filter((entry) => entry.endsWith(".json") && entry !== "index.json"),
      [],
    );
  });
});

test("--from cannot be combined with --from-template", async () => {
  await withTempHome("acpx-from-vs-template-", async (homeDir) => {
    await writeConfig(homeDir);
    const oldCwd = path.join(homeDir, "old-workspace");
    await fs.mkdir(oldCwd, { recursive: true });
    await writeParent(homeDir, oldCwd, "the-parent");
    const oldId = await writeOldSession(homeDir, { cwd: oldCwd, parentId: "the-parent" });

    const result = await runCli(
      [...COMMON, "claude", "sessions", "new", "--from", oldId, "--from-template", oldId],
      homeDir,
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr + result.stdout, /--from cannot be combined with --from-template/);
  });
});
