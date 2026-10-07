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
const CLAUDE_COMMAND = `${MOCK_AGENT_COMMAND} --claude-agent-acp --advertise-models --advertise-config-options --advertise-output-style`;
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

async function writeConfig(homeDir: string, operationLog?: string): Promise<void> {
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
    `${JSON.stringify({
      agents: {
        claude: {
          command: operationLog
            ? `${CLAUDE_COMMAND} --operation-log ${JSON.stringify(operationLog)}`
            : CLAUDE_COMMAND,
        },
      },
    })}\n`,
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
    // Same agent ⇒ nothing was skipped, so nothing is announced.
    assert.doesNotMatch(result.stderr, /skipped/);
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

// Brick 28964dd8 — a successor (`--from` INTO the predecessor's own seat) runs on the
// predecessor's EXACT model, Fable included, recorded `model_source: succession`. A child or a
// fork of a Fable session still has an implicit Fable guard-forced off it (brick 5bac5564).

const SUCCESSION_TURN = "succession-first-turn";

async function workspace(homeDir: string): Promise<string> {
  const cwd = path.join(homeDir, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  return cwd;
}

async function createSeatedHolder(
  homeDir: string,
  cwd: string,
  flags: string[],
  env: NodeJS.ProcessEnv = {},
  verbFlags: string[] = [],
): Promise<string> {
  return createdId(
    await runCli(
      [
        "--cwd",
        cwd,
        ...COMMON,
        ...flags,
        "claude",
        "sessions",
        "new",
        "-s",
        "holder",
        ...verbFlags,
      ],
      homeDir,
      env,
    ),
  );
}

async function servedModelOf(operationLog: string, text: string): Promise<unknown> {
  const prompts = (await fs.readFile(operationLog, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: string; text?: string; modelId?: unknown })
    .filter((op) => op.method === "session/prompt" && op.text === text);
  assert.equal(prompts.length, 1, "exactly one served turn");
  return prompts[0]?.modelId;
}

function sessionUrl(id: string): string {
  return `https://atrium.example.test/?session=${id}`;
}

test("S1 (brick 28964dd8): a successor of an explicit-Fable holder carries fable as `succession`, and its first turn is served by fable", async () => {
  await withTempHome("acpx-succession-fable-", async (homeDir) => {
    const operationLog = path.join(homeDir, "agent-ops.jsonl");
    await writeConfig(homeDir, operationLog);
    const cwd = await workspace(homeDir);
    const holderId = await createSeatedHolder(homeDir, cwd, ["--model", "fable"]);
    const holder = await readStored(homeDir, holderId);
    assert.equal(holder.acpx?.session_options?.model_source, "explicit");

    // The handover's create step exactly as a holder runs it: its OWN url, nothing else.
    const successorId = createdId(
      await runCli([...COMMON, "claude", "sessions", "new", "--from", holderId], homeDir, {
        ACPX_SESSION_URL: sessionUrl(holderId),
      }),
    );
    const successor = await readStored(homeDir, successorId);
    const options = successor.acpx?.session_options ?? {};
    assert.equal(successor.seat_id, holder.seat_id);
    assert.equal(options.model, "fable");
    assert.equal(options.model_source, "succession");
    assert.equal(options.model_guard, undefined, "the guard must not fire on a succession");

    const turn = await runCli(
      ["--cwd", cwd, ...COMMON, "claude", "prompt", "--session-id", successorId, SUCCESSION_TURN],
      homeDir,
    );
    assert.equal(turn.code, 0, turn.stderr);
    assert.equal(await servedModelOf(operationLog, SUCCESSION_TURN), "fable");
    const afterTurn = (await readStored(homeDir, successorId)).acpx?.session_options ?? {};
    assert.equal(afterTurn.model, "fable");
    assert.equal(afterTurn.model_source, "succession");
    assert.equal(afterTurn.model_guard, undefined, "the serve-time belt must not fire either");
  });
});

test("S2 (brick 28964dd8): an explicit --model on the --from line overrides the predecessor's model, recorded explicit", async () => {
  await withTempHome("acpx-succession-override-", async (homeDir) => {
    await writeConfig(homeDir);
    const cwd = await workspace(homeDir);
    const holderId = await createSeatedHolder(homeDir, cwd, ["--model", "fable"]);

    const successorId = createdId(
      await runCli(
        [...COMMON, "--model", "opus", "claude", "sessions", "new", "--from", holderId],
        homeDir,
        { ACPX_SESSION_URL: sessionUrl(holderId) },
      ),
    );
    const options = (await readStored(homeDir, successorId)).acpx?.session_options ?? {};
    assert.equal(options.model, "opus");
    assert.equal(options.model_source, "explicit");
  });
});

test("S3 (brick 28964dd8): a CHILD of a Fable holder — spawned without --model — is still guard-forced to opus", async () => {
  await withTempHome("acpx-succession-child-", async (homeDir) => {
    await writeConfig(homeDir);
    const cwd = await workspace(homeDir);
    const holderId = await createSeatedHolder(homeDir, cwd, ["--model", "fable"]);

    // A spawn from inside the holder: parent by ACPX_SESSION_URL, a NEW seat.
    const childId = createdId(
      await runCli(["--cwd", cwd, ...COMMON, "claude", "sessions", "new"], homeDir, {
        ACPX_SESSION_URL: sessionUrl(holderId),
      }),
    );
    const child = await readStored(homeDir, childId);
    assert.equal(child.parent_session_id, holderId);
    assert.notEqual(child.seat_id, (await readStored(homeDir, holderId)).seat_id);
    assert.equal(child.acpx?.session_options?.model, "opus");
    assert.equal(child.acpx?.session_options?.model_source, "guard-forced");
  });
});

test("S3 (brick 28964dd8): --from into a DIFFERENT seat is not a succession — an implicit Fable is still guard-forced", async () => {
  await withTempHome("acpx-succession-other-seat-", async (homeDir) => {
    await writeConfig(homeDir);
    const cwd = await workspace(homeDir);
    const holderId = await createSeatedHolder(homeDir, cwd, ["--model", "fable"]);
    const otherSeat = (
      await readStored(
        homeDir,
        createdId(
          await runCli(
            ["--cwd", cwd, ...COMMON, "--model", "opus", "claude", "sessions", "new", "-s", "b"],
            homeDir,
          ),
        ),
      )
    ).seat_id;

    const successorId = createdId(
      await runCli(
        [...COMMON, "claude", "sessions", "new", "--from", holderId, "--seat", String(otherSeat)],
        homeDir,
      ),
    );
    const options = (await readStored(homeDir, successorId)).acpx?.session_options ?? {};
    assert.equal(options.model, "opus");
    assert.equal(options.model_source, "guard-forced");
  });
});

test("S4 (brick 28964dd8): a TOP-LEVEL holder's successor has no parent even with ACPX_SESSION_URL set — it is never its predecessor's child", async () => {
  await withTempHome("acpx-succession-top-level-", async (homeDir) => {
    await writeConfig(homeDir);
    const cwd = await workspace(homeDir);
    const holderId = await createSeatedHolder(homeDir, cwd, ["--model", "opus"]);
    const holder = await readStored(homeDir, holderId);
    assert.equal(holder.parent_session_id, undefined);

    const successorId = createdId(
      await runCli([...COMMON, "claude", "sessions", "new", "--from", holderId], homeDir, {
        ACPX_SESSION_URL: sessionUrl(holderId),
      }),
    );
    const successor = (await readStored(homeDir, successorId)) as StoredRecord & {
      parent_seat_id?: string;
      parent_session_url?: string;
    };
    assert.equal(successor.seat_id, holder.seat_id);
    assert.equal(successor.holder_active, false);
    assert.equal(successor.parent_session_id, undefined);
    assert.equal(successor.parent_session_url, undefined);
    assert.equal(successor.parent_seat_id, undefined);
  });
});

test("S4 (brick 28964dd8): a CHILD holder's successor takes the holder's own parent, not the ACPX_SESSION_URL caller", async () => {
  await withTempHome("acpx-succession-child-holder-", async (homeDir) => {
    await writeConfig(homeDir);
    const cwd = await workspace(homeDir);
    await writeParent(homeDir, cwd, "the-parent");
    const holderId = await createSeatedHolder(homeDir, cwd, ["--model", "opus"], {}, [
      "--parent-id",
      "the-parent",
    ]);
    assert.equal((await readStored(homeDir, holderId)).parent_session_id, "the-parent");

    const successorId = createdId(
      await runCli([...COMMON, "claude", "sessions", "new", "--from", holderId], homeDir, {
        ACPX_SESSION_URL: sessionUrl(holderId),
      }),
    );
    assert.equal((await readStored(homeDir, successorId)).parent_session_id, "the-parent");
  });
});

test("S5 (brick 28964dd8): a succession still carries effort, harness, profile, auto-failover, cwd and brick exactly", async () => {
  await withTempHome("acpx-succession-regression-", async (homeDir) => {
    await writeConfig(homeDir);
    const cwd = await workspace(homeDir);
    const holderId = await createSeatedHolder(
      homeDir,
      cwd,
      ["--model", "fable", "--brick", BRICK_A],
      brickShimEnv(BRICK_A),
    );
    // Plant the remaining options on the holder's record, as a live holder carries them.
    const holderFile = sessionFilePath(homeDir, holderId);
    const raw = JSON.parse(await fs.readFile(holderFile, "utf8")) as {
      acpx: {
        session_options: Record<string, unknown>;
        desired_config_options?: Record<string, unknown>;
      };
    };
    raw.acpx.session_options.profile = "sub2";
    raw.acpx.session_options.auto_failover = false;
    raw.acpx.desired_config_options = { ...raw.acpx.desired_config_options, effort: "high" };
    await fs.writeFile(holderFile, `${JSON.stringify(raw)}\n`, "utf8");
    const holder = await readStored(homeDir, holderId);

    const successorId = createdId(
      await runCli([...COMMON, "claude", "sessions", "new", "--from", holderId], homeDir, {
        ...brickShimEnv(BRICK_A),
        ACPX_SESSION_URL: sessionUrl(holderId),
      }),
    );
    const successor = await readStored(homeDir, successorId);
    const options = successor.acpx?.session_options ?? {};
    assert.equal(options.model, "fable");
    assert.equal(options.model_source, "succession");
    assert.equal(successor.acpx?.desired_config_options?.effort, "high");
    assert.equal(options.profile, "sub2");
    assert.equal(options.auto_failover, false);
    assert.equal(successor.agent_command, holder.agent_command);
    assert.equal(successor.cwd, cwd);
    assert.equal(successor.metadata?.brick, BRICK_A);
  });
});
