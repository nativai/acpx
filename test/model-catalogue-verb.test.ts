import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// brick 574b137e — `acpx <agent> model-catalogue` replaced acpx-ui creating,
// statusing, closing and pruning a throwaway Codex session on every catalogue
// read. The property that bought: a catalogue read is NOT a session-store write.
// Asserted on the sessions dir's BYTES in an isolated HOME — and the `sessions
// new` control proves this instrument sees a write when one happens.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MODEL_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)} --advertise-models`;

type CliResult = { code: number | null; stdout: string; stderr: string };

async function runCli(args: string[], homeDir: string, cwd: string): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
  for (const key of Object.keys(env)) {
    if (/^ACPX_(SESSION|PARENT_SESSION|BRICK|TASK_FOLDER|OWNER_LOG|SUBSCRIPTION)/.test(key)) {
      delete env[key];
    }
  }
  return await new Promise<CliResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Every path under `dir` with the sha256 of its bytes — the byte-identity fingerprint. */
async function fingerprint(dir: string): Promise<string[]> {
  const rows: string[] = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, full);
    rows.push(
      entry.isFile()
        ? `${rel} ${createHash("sha256")
            .update(await fs.readFile(full))
            .digest("hex")}`
        : `${rel}/`,
    );
  }
  return rows.toSorted();
}

async function withIsolatedHome(
  run: (homeDir: string, cwd: string, sessionsDir: string) => Promise<void>,
): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-model-catalogue-home-"));
  try {
    const cwd = path.join(homeDir, "work");
    const sessionsDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(cwd, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    // A pre-existing file, so "unchanged" covers rewrites as well as additions.
    await fs.writeFile(path.join(sessionsDir, "sentinel.json"), '{"keep":true}\n');
    await run(homeDir, cwd, sessionsDir);
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

test("model-catalogue prints the adapter-advertised catalogue as JSON and writes nothing under the sessions dir", async () => {
  await withIsolatedHome(async (homeDir, cwd, sessionsDir) => {
    const before = await fingerprint(sessionsDir);
    const result = await runCli(
      ["--agent", MODEL_AGENT_COMMAND, "--cwd", cwd, "--format", "json", "model-catalogue"],
      homeDir,
      cwd,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await fingerprint(sessionsDir), before);

    const record = result.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row.action === "model_catalogue");
    assert.ok(record, result.stdout);
    assert.equal(record.currentModelId, "default-model");
    const catalogue = record.advertisedModelCatalogue as {
      source: string;
      availability: string;
      accountAllowed: null;
      models: { family: string; efforts: string[]; modelIds: string[] }[];
    };
    assert.equal(catalogue.source, "acp");
    assert.equal(catalogue.availability, "adapter-advertised");
    assert.equal(catalogue.accountAllowed, null);
    assert.deepEqual(
      catalogue.models.find((row) => row.family === "gpt-5.5"),
      { family: "gpt-5.5", efforts: ["xhigh"], modelIds: ["gpt-5.5[xhigh]"] },
    );
    // Bare ids carry no effort ladder and are not catalogue families.
    assert.equal(
      catalogue.models.some((row) => row.family === "default-model"),
      false,
    );
  });
});

test("control: `sessions new` DOES change the sessions dir — the fingerprint sees a write", async () => {
  await withIsolatedHome(async (homeDir, cwd, sessionsDir) => {
    const before = await fingerprint(sessionsDir);
    const result = await runCli(
      ["--agent", MODEL_AGENT_COMMAND, "--approve-all", "--cwd", cwd, "sessions", "new"],
      homeDir,
      cwd,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.notDeepEqual(await fingerprint(sessionsDir), before);
  });
});
