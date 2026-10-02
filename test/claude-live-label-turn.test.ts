// brick ebfe4c3c — CONTRACT §5.1 row 5: the label's INPUTS survive a REAL TURN.
//
// ⚠️ WHY A REAL TURN AND NOT AN IN-MEMORY ROUND TRIP. The turn path rebuilds
// `record.acpx` from `cloneSessionAcpxState`, a field-by-field allowlist — a field
// missing there is present at `sessions new` and gone after ONE prompt, while every
// in-memory test stays green (acpx PROJECT.md; three fields have been lost this way).
// `resolvedModelLabel` is derived at projection from `current_model_id` +
// `config_options`, so the question this row answers is whether those inputs are
// still on the record — and the label still on the index entry — after a turn.
//
// ⚠️ WHY THE ADAPTER LIVES UNDER A `claude-agent-acp/` PATH. acpx's fixtures use
// synthetic commands no real record carries; the label's claude gate is a SEGMENT
// match on the adapter token, so the mock is launched from
// `<home>/claude-agent-acp/dist/index.js` exactly as the deployed adapter is from
// `/opt/claude-agent-acp/dist/index.js`. Its advertisement says "Opus 9.1" — a
// version no binary has shipped — so a label that appears can only have come from
// the advertisement.
//
// Mutation reasoning (never run with tooling — mutation testing is forbidden):
// deleting `config_options` or `current_model_id` from the clone leaves the label at
// `sessions new` and drops it after the turn (asserted below); deleting the
// projection line drops it at `sessions new`.
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

type CliRunResult = { code: number | null; stdout: string; stderr: string };

async function runCli(args: string[], homeDir: string, cwd: string): Promise<CliRunResult> {
  return await new Promise<CliRunResult>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      ACPX_STATE_HOME: homeDir,
      // A `sessions new` kicks the detached catalogue warm; it must not outlive the row.
      ACPX_NO_CATALOGUE_WARM: "1",
    };
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
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

type IndexEntry = { acpxRecordId: string; resolvedModelLabel?: string; currentModelId?: string };

async function readEntry(homeDir: string, id: string): Promise<IndexEntry | undefined> {
  const index = JSON.parse(
    await fs.readFile(path.join(homeDir, ".acpx", "sessions", "index.json"), "utf8"),
  ) as { entries: IndexEntry[] };
  return index.entries.find((entry) => entry.acpxRecordId === id);
}

async function readRecordAcpx(
  homeDir: string,
  id: string,
): Promise<{ current_model_id?: string; config_options?: { id: string }[] } | undefined> {
  const record = JSON.parse(
    await fs.readFile(
      path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(id)}.json`),
      "utf8",
    ),
  ) as { acpx?: { current_model_id?: string; config_options?: { id: string }[] } };
  return record.acpx;
}

test("REAL TURN: resolvedModelLabel is on the entry at create, SURVIVES a prompt, and follows `set model`", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-label-turn-"));
  try {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const adapterDir = path.join(homeDir, "claude-agent-acp", "dist");
    await fs.mkdir(adapterDir, { recursive: true });
    const adapterPath = path.join(adapterDir, "index.js");
    await fs.symlink(MOCK_AGENT_PATH, adapterPath);
    const advertPath = path.join(homeDir, "model-advertisement.json");
    await fs.writeFile(
      advertPath,
      JSON.stringify([
        { value: "default", name: "Default (recommended)", description: "Opus 9.1 · Test tagline" },
        { value: "opus", name: "Opus", description: "Opus 9.1 · Test tagline" },
        { value: "sonnet", name: "Sonnet", description: "Sonnet 9.1 · Routine" },
      ]),
    );
    const command = `node ${adapterPath} --claude-agent-acp --model-advertisement ${advertPath}`;
    await fs.mkdir(path.join(homeDir, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".acpx", "config.json"),
      `${JSON.stringify({ agents: { claude: { command } } }, null, 2)}\n`,
    );

    const created = await runCli(
      ["--cwd", cwd, "--format", "json", "--model", "opus", "claude", "sessions", "new"],
      homeDir,
      cwd,
    );
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId,
    );
    try {
      assert.equal((await readEntry(homeDir, id))?.resolvedModelLabel, "Opus 9.1", "at create");

      const prompted = await runCli(
        [
          "--cwd",
          cwd,
          "--approve-all",
          "--format",
          "json",
          "claude",
          "prompt",
          "--session-id",
          id,
          "hi",
        ],
        homeDir,
        cwd,
      );
      assert.equal(prompted.code, 0, prompted.stderr);
      const afterTurn = await readRecordAcpx(homeDir, id);
      assert.equal(afterTurn?.current_model_id, "opus", "current_model_id survived the turn");
      assert.ok(
        afterTurn?.config_options?.some((option) => option.id === "model"),
        "config_options survived the turn",
      );
      assert.equal(
        (await readEntry(homeDir, id))?.resolvedModelLabel,
        "Opus 9.1",
        "the label must SURVIVE the turn — the cloneSessionAcpxState class",
      );

      const set = await runCli(
        ["--cwd", cwd, "--format", "json", "claude", "set", "model", "sonnet", "--session-id", id],
        homeDir,
        cwd,
      );
      assert.equal(set.code, 0, set.stderr);
      const afterSet = await readEntry(homeDir, id);
      assert.equal(afterSet?.currentModelId, "sonnet");
      assert.equal(afterSet?.resolvedModelLabel, "Sonnet 9.1", "re-derived on the set write");
    } finally {
      await runCli(["--cwd", cwd, "claude", "sessions", "close", id], homeDir, cwd);
    }
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
