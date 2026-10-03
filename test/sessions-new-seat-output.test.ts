import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sessionFilePath, withTempHome } from "./runtime-test-helpers.js";

// Brick 9956d212 item (3) — `sessions new` prints the seat id the operator must activate into,
// and says plainly when the placement is PREPARED (not active). Every row drives the real
// compiled CLI against the mock agent and reads the seat id back from the record on DISK, so an
// output that names the wrong seat fails here. AC6: "one command and no follow-up" — before this
// the id was reachable only through `sessions show`.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
const UI_BASE = "https://ui.example.test";

type CliResult = { code: number | null; stdout: string; stderr: string; output: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_UI_BASE_URL: UI_BASE };
    delete env.ACPX_STATE_HOME;
    for (const key of [
      "ACPX_SESSION_URL",
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
    child.on("close", (code) => resolve({ code, stdout, stderr, output: stdout + stderr }));
  });
}

async function seatOnDisk(homeDir: string, id: string): Promise<string> {
  const stored = JSON.parse(await fs.readFile(sessionFilePath(homeDir, id), "utf8")) as {
    seat_id?: string;
  };
  assert.equal(typeof stored.seat_id, "string");
  return stored.seat_id as string;
}

type NewJson = {
  acpxRecordId: string;
  seatId?: string;
  seatUrl?: string;
  holderActive?: boolean;
};

async function withRig(
  run: (ctx: { homeDir: string; base: string[] }) => Promise<void>,
): Promise<void> {
  await withTempHome("acpx-new-seat-output-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await run({ homeDir, base: ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all"] });
  });
}

async function createJson(base: string[], homeDir: string, extra: string[] = []): Promise<NewJson> {
  const result = await runCli([...base, "--format", "json", "sessions", "new", ...extra], homeDir);
  assert.equal(result.code, 0, result.output);
  return JSON.parse(result.stdout.trim()) as NewJson;
}

test("SN1 · a fresh `sessions new` (TEXT) prints the seat id and its url, and no prepared line — the record id is still the first stdout line", async () => {
  await withRig(async ({ homeDir, base }) => {
    const result = await runCli([...base, "sessions", "new"], homeDir);
    assert.equal(result.code, 0, result.output);
    const id = result.stdout.split("\n")[0];
    const seatId = await seatOnDisk(homeDir, id);
    assert.ok(result.output.includes(`seat: ${seatId}\n`), result.output);
    assert.ok(result.output.includes(`seat url: ${UI_BASE}/?seat=${seatId}\n`), result.output);
    assert.doesNotMatch(result.output, /prepared into seat/);
  });
});

test("SN2 · a fresh `sessions new` (JSON) carries seatId, seatUrl and holderActive:true", async () => {
  await withRig(async ({ homeDir, base }) => {
    const created = await createJson(base, homeDir);
    const seatId = await seatOnDisk(homeDir, created.acpxRecordId);
    assert.equal(created.seatId, seatId);
    assert.equal(created.seatUrl, `${UI_BASE}/?seat=${seatId}`);
    assert.equal(created.holderActive, true);
  });
});

test("SN3 · `sessions new --seat` (TEXT) says the placement is PREPARED, NOT active, and prints the exact activation command", async () => {
  await withRig(async ({ homeDir, base }) => {
    const first = await createJson(base, homeDir);
    const seatId = await seatOnDisk(homeDir, first.acpxRecordId);
    const result = await runCli([...base, "sessions", "new", "--seat", seatId], homeDir);
    assert.equal(result.code, 0, result.output);
    const id = result.stdout.split("\n")[0];
    assert.ok(result.output.includes(`seat: ${seatId}\n`), result.output);
    assert.ok(
      result.output.includes(
        `prepared into seat ${seatId} — NOT active; activate with: ` +
          `acpx sessions activate ${seatId} ${id}\n`,
      ),
      result.output,
    );
  });
});

test("SN4 · `sessions new --seat` (JSON) carries the joined seat and holderActive:false", async () => {
  await withRig(async ({ homeDir, base }) => {
    const first = await createJson(base, homeDir);
    const seatId = await seatOnDisk(homeDir, first.acpxRecordId);
    const prepared = await createJson(base, homeDir, ["--seat", seatId]);
    assert.equal(prepared.seatId, seatId);
    assert.equal(prepared.seatUrl, `${UI_BASE}/?seat=${seatId}`);
    assert.equal(prepared.holderActive, false);
  });
});

test("SN5 · `sessions new --from <old>` joins the old seat as PREPARED and says so in both modes", async () => {
  await withRig(async ({ homeDir, base }) => {
    const old = await createJson(base, homeDir);
    const seatId = await seatOnDisk(homeDir, old.acpxRecordId);
    const json = await createJson(base, homeDir, ["--from", old.acpxRecordId]);
    assert.equal(json.seatId, seatId);
    assert.equal(json.holderActive, false);
    const text = await runCli([...base, "sessions", "new", "--from", old.acpxRecordId], homeDir);
    assert.equal(text.code, 0, text.output);
    const id = text.stdout.split("\n")[0];
    assert.ok(
      text.output.includes(
        `prepared into seat ${seatId} — NOT active; activate with: ` +
          `acpx sessions activate ${seatId} ${id}\n`,
      ),
      text.output,
    );
  });
});

test("SN6 · JSON mode stays ONE JSON document on stdout — no seat prose leaks into it, text or prepared", async () => {
  await withRig(async ({ homeDir, base }) => {
    const first = await createJson(base, homeDir);
    const seatId = await seatOnDisk(homeDir, first.acpxRecordId);
    const result = await runCli(
      [...base, "--format", "json", "sessions", "new", "--seat", seatId],
      homeDir,
    );
    assert.equal(result.code, 0, result.output);
    assert.doesNotThrow(() => JSON.parse(result.stdout.trim()));
    assert.doesNotMatch(result.stdout, /prepared into seat|seat url:/);
  });
});
