import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  makeSessionRecord,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

/**
 * Brick 9956d212 item (2) — the holders line of `seats show` names a PREPARED holder (a
 * placement with no ordinal yet) `prepared`, never `#?`. A `?` reads as a bug in the
 * product; "prepared" is the designed state (D-SEAT-HOLD). Item (1) of that brick (a closed
 * holder is not "nobody home") already landed in eca085bb and is not re-tested here.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SEAT = "11111111-1111-4111-8111-111111111111";
const ACTIVE = "aaaaaaaa-0000-4000-8000-00000000000a";
const PREPARED = "bbbbbbbb-0000-4000-8000-00000000000b";

type CliResult = { code: number | null; stdout: string; stderr: string; output: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
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
      cwd: homeDir,
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

async function withRig(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-seat-prepared-render-", async (homeDir) => {
    const sessions = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(sessions, { recursive: true });
    await fs.writeFile(
      path.join(sessions, "seats.json"),
      `${JSON.stringify({
        [SEAT]: {
          seat_id: SEAT,
          created_at: "2026-10-03T00:00:00.000Z",
          active_holder_id: ACTIVE,
          next_ordinal: 2,
          closed_at: null,
          favorite: false,
        },
      })}\n`,
      "utf8",
    );
    const base = { agentCommand: "node agent.js", cwd: homeDir, seatId: SEAT };
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        ...base,
        acpxRecordId: ACTIVE,
        acpSessionId: "acp-active",
        holderOrdinal: 1,
        holderActive: true,
      }),
    );
    // Prepared: placed into the seat by `sessions new --seat`, no ordinal until activated.
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({ ...base, acpxRecordId: PREPARED, acpSessionId: "acp-prepared" }),
    );
    await run(homeDir);
  });
}

test("PR1 · seats show (TEXT): a holder with no ordinal reads `prepared`, never `#?`; an ordinal holder still reads `#<n>`", async () => {
  await withRig(async (homeDir) => {
    const result = await runCli(["seats", "show", SEAT], homeDir);
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.stdout, /#\?/);
    assert.match(result.stdout, new RegExp(`^ {4}prepared {2}${PREPARED} {2}open$`, "m"));
    assert.match(result.stdout, new RegExp(`^ {4}#1 {2}${ACTIVE} {2}open$`, "m"));
  });
});

test("PR2 · seats show (JSON): the holder's ordinal stays null — the word `prepared` is prose and never enters the payload", async () => {
  await withRig(async (homeDir) => {
    const result = await runCli(["--format", "json", "seats", "show", SEAT], homeDir);
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      holders: { id: string; ordinal: number | null }[];
    };
    const prepared = payload.holders.find((holder) => holder.id === PREPARED);
    assert.equal(prepared?.ordinal, null);
    assert.doesNotMatch(result.stdout, /prepared/);
  });
});
