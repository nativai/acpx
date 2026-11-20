import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sessionFilePath, withTempHome } from "./runtime-test-helpers.js";

// brick 15252af6 (Daniel, 2026-11-20) — a fork / copy / by-the-way of a Fable session KEEPS Fable:
// forcing it off Fable loses Anthropic's prompt cache and costs more. The implicit-Fable guard
// (brick 5bac5564) still binds fresh spawns, children and TEMPLATE copies. Every row drives the
// real compiled CLI against the mock Claude adapter, reads the copy's record from disk, and — for
// the rows where the serve-time belt (`guardServedModel`) could still flip the model — serves one
// turn and reads the model that turn was actually served by.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const CLAUDE_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)} --claude-agent-acp --supports-fork-session --advertise-models`;
const COMMON = ["--approve-all", "--format", "json"];

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
    delete env.ACPX_STATE_HOME;
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_NAME",
      "ACPX_SESSION_RECORD_ID",
      "ACPX_PARENT_SESSION_URL",
      "ACPX_SEAT_URL",
      "ACPX_PARENT_SEAT_URL",
      "ACPX_TASK_FOLDER",
      "ACPX_BRICK",
      "ACPX_BRICK_PATH",
      "ACPX_OWNER_LOG",
    ]) {
      delete env[key];
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

type SessionOptions = {
  model?: unknown;
  model_source?: unknown;
  model_guard?: { blocked?: unknown };
};
type Stored = { acpx?: { session_options?: SessionOptions } };

async function readStored(homeDir: string, id: string): Promise<Stored> {
  return JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as Stored;
}

function createdId(result: CliResult): string {
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const line = result.stdout.trim().split("\n").at(-1) ?? "{}";
  const id = (JSON.parse(line) as { acpxRecordId?: unknown }).acpxRecordId;
  assert.equal(typeof id, "string", result.stdout);
  return id as string;
}

type Rig = { homeDir: string; cwd: string; operationLog: string };

async function rig(homeDir: string): Promise<Rig> {
  const cwd = path.join(homeDir, "workspace");
  const operationLog = path.join(homeDir, "agent-ops.jsonl");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
  await fs.writeFile(
    path.join(homeDir, ".acpx", "config.json"),
    `${JSON.stringify({
      agents: {
        claude: { command: `${CLAUDE_COMMAND} --operation-log ${JSON.stringify(operationLog)}` },
      },
    })}\n`,
    "utf8",
  );
  return { homeDir, cwd, operationLog };
}

/** An ordinary Fable session that has run one turn — what a byway is opened on. */
async function fableSource(r: Rig): Promise<string> {
  const id = createdId(
    await runCli(
      ["--cwd", r.cwd, ...COMMON, "--model", "fable", "claude", "sessions", "new"],
      r.homeDir,
    ),
  );
  const warm = await runCli(
    ["--cwd", r.cwd, ...COMMON, "claude", "prompt", "--session-id", id, "warm-up"],
    r.homeDir,
  );
  assert.equal(warm.code, 0, warm.stderr);
  const options = (await readStored(r.homeDir, id)).acpx?.session_options;
  assert.equal(options?.model, "fable", "control: the source is on fable");
  assert.equal(options?.model_source, "explicit", "control: the source pinned it explicitly");
  return id;
}

async function copyOf(r: Rig, sourceId: string, extra: string[] = []): Promise<string> {
  return createdId(
    await runCli(
      [
        "--cwd",
        r.cwd,
        ...COMMON,
        ...extra,
        "claude",
        "sessions",
        "copy",
        "--from",
        sourceId,
        "--ephemeral",
        "--parent-id",
        sourceId,
      ],
      r.homeDir,
    ),
  );
}

/** The model the ONE `session/prompt` carrying `text` was served by. */
async function servedModel(r: Rig, sessionId: string, text: string): Promise<unknown> {
  const turn = await runCli(
    ["--cwd", r.cwd, ...COMMON, "claude", "prompt", "--session-id", sessionId, text],
    r.homeDir,
  );
  assert.equal(turn.code, 0, turn.stderr);
  const prompts = (await fs.readFile(r.operationLog, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: string; text?: string; modelId?: unknown })
    .filter((op) => op.method === "session/prompt" && op.text === text);
  assert.equal(prompts.length, 1, "exactly one served turn");
  return prompts[0]?.modelId;
}

async function closeSession(r: Rig, id: string): Promise<void> {
  await runCli(["--cwd", r.cwd, ...COMMON, "claude", "sessions", "close", id], r.homeDir);
}

test("15252af6: a by-the-way copy of an ordinary Fable session stays on fable, explicit, unguarded — and its first turn is served by fable", async () => {
  await withTempHome("acpx-copy-fable-", async (homeDir) => {
    const r = await rig(homeDir);
    const source = await fableSource(r);
    const copyId = await copyOf(r, source);
    try {
      const options = (await readStored(homeDir, copyId)).acpx?.session_options ?? {};
      assert.equal(options.model, "fable");
      assert.equal(options.model_source, "explicit", "the source's provenance, carried verbatim");
      assert.equal(options.model_guard, undefined, "the guard must not fire on a fork");
      // The serve-time belt forces any non-explicit Fable; it must not force this one.
      assert.equal(await servedModel(r, copyId, "byway-first-turn"), "fable");
      assert.equal(
        (await readStored(homeDir, copyId)).acpx?.session_options?.model_source,
        "explicit",
        "the provenance survives a real turn",
      );
    } finally {
      await closeSession(r, copyId);
      await closeSession(r, source);
    }
  });
});

test("15252af6: a copy of a legacy Fable source with NO model_source keeps fable and stays unstamped", async () => {
  await withTempHome("acpx-copy-fable-legacy-", async (homeDir) => {
    const r = await rig(homeDir);
    const source = await fableSource(r);
    const file = sessionFilePath(homeDir, source);
    const record = JSON.parse(await fs.readFile(file, "utf8")) as Stored;
    delete record.acpx?.session_options?.model_source;
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const copyId = await copyOf(r, source);
    try {
      const options = (await readStored(homeDir, copyId)).acpx?.session_options ?? {};
      assert.equal(options.model, "fable");
      // Absent stays absent: the belt grandfathers it, and an invented "inherited" would be forced.
      assert.equal(options.model_source, undefined);
      assert.equal(options.model_guard, undefined);
      assert.equal(await servedModel(r, copyId, "legacy-first-turn"), "fable");
    } finally {
      await closeSession(r, copyId);
      await closeSession(r, source);
    }
  });
});

test("15252af6: an explicit --model on the copy still wins over the source's fable", async () => {
  await withTempHome("acpx-copy-fable-explicit-", async (homeDir) => {
    const r = await rig(homeDir);
    const source = await fableSource(r);
    const copyId = await copyOf(r, source, ["--model", "opus"]);
    try {
      const options = (await readStored(homeDir, copyId)).acpx?.session_options ?? {};
      assert.equal(options.model, "opus");
      assert.equal(options.model_source, "explicit");
      assert.equal(options.model_guard, undefined);
    } finally {
      await closeSession(r, copyId);
      await closeSession(r, source);
    }
  });
});

test("15252af6: a copy of a Fable TEMPLATE is still guard-forced off fable (brick 5bac5564)", async () => {
  await withTempHome("acpx-copy-fable-template-", async (homeDir) => {
    const r = await rig(homeDir);
    const source = await fableSource(r);
    const marked = await runCli(
      ["--cwd", r.cwd, "claude", "sessions", "template", source, "--enable", "--slug", "tpl-fable"],
      homeDir,
    );
    assert.equal(marked.code, 0, marked.stdout + marked.stderr);
    const copyId = await copyOf(r, source);
    try {
      const options = (await readStored(homeDir, copyId)).acpx?.session_options ?? {};
      assert.equal(options.model, "opus");
      assert.equal(options.model_source, "guard-forced");
      assert.equal(options.model_guard?.blocked, "fable");
    } finally {
      await closeSession(r, copyId);
      await closeSession(r, source);
    }
  });
});

test("15252af6: a CHILD of a Fable session is still guard-forced off fable (brick 5bac5564)", async () => {
  await withTempHome("acpx-copy-fable-child-", async (homeDir) => {
    const r = await rig(homeDir);
    const source = await fableSource(r);
    const childId = createdId(
      await runCli(
        ["--cwd", r.cwd, ...COMMON, "claude", "sessions", "new", "--parent-id", source],
        homeDir,
      ),
    );
    try {
      const options = (await readStored(homeDir, childId)).acpx?.session_options ?? {};
      assert.equal(options.model, "opus");
      assert.equal(options.model_source, "guard-forced");
    } finally {
      await closeSession(r, childId);
      await closeSession(r, source);
    }
  });
});
