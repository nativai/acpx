import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withTempHome as withTempHomeFixture } from "./runtime-test-helpers.js";

/**
 * Brick a6884bb9 — `seats show` / `seats list` RENDER `favorite`, which `seats favorite
 * --on|--off` already sets.
 *
 * ## DECISIONS (L4, D-AUTONOMY — each stated once, here)
 * - PLACEMENT: a field on `show`, a column on `list`. `list` already widened once (five to
 *   six columns for `brickId`, with the programme owner's ratification); this is the
 *   seventh, taken on the same ground — an operator scanning for starred seats should not
 *   open each one.
 * - JSON: a boolean key `favorite`, ALWAYS present on both verbs, no prose. A row with no
 *   `favorite` key on disk (it predates the field) renders `false`, the same reading the
 *   `favorite` verb itself uses (FV6: "absence must read as false").
 * - TEXT: `show` prints `favorite:      yes|no`; `list` appends `favorite=yes|no` after
 *   `holders=`. Neither prints blank-or-absent for an unstarred seat.
 * - KEYED FROM THE SEAT ROW, never from the holder (B2d's ruling): the fixtures point
 *   `active_holder_id` at a holder that does not exist, which is exactly the stale-pointer
 *   state a holder-derived read gets wrong.
 *
 * Every row spawns the compiled CLI; the verbs' text goes to stdout and `--format json`
 * (global flag) puts the envelope on stdout; rows assert stdout+stderr combined, with the
 * exit code.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

const SEAT_A = "11111111-1111-4111-8111-111111111111";
const SEAT_B = "22222222-2222-4222-8222-222222222222";
const SEAT_C = "33333333-3333-4333-8333-333333333333";

type CliResult = { code: number | null; stdout: string; stderr: string; output: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir };
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
      delete env[key];
    }
    // cwd is the rig: an unregistered token probed from a session-bearing cwd is a real
    // prompt delivery, so nothing here may run from the repo.
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

function withRig(run: (homeDir: string) => Promise<void>): Promise<void> {
  return withTempHomeFixture("acpx-seat-favorite-render-", async (homeDir) => {
    await fs.mkdir(path.join(homeDir, ".acpx", "sessions"), { recursive: true });
    await run(homeDir);
  });
}

function storePath(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions", "seats.json");
}

function seatRow(seatId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seat_id: seatId,
    created_at: "2026-09-29T00:00:00.000Z",
    // A pointer at a holder that exists nowhere: the stale-pointer state.
    active_holder_id: `aaaaaaaa-0000-4000-8000-${seatId.slice(-12)}`,
    next_ordinal: 2,
    closed_at: null,
    favorite: false,
    ...overrides,
  };
}

async function writeStore(homeDir: string, payload: Record<string, unknown>): Promise<void> {
  await fs.writeFile(storePath(homeDir), `${JSON.stringify(payload)}\n`, "utf8");
}

async function favoritesFixture(homeDir: string): Promise<void> {
  await writeStore(homeDir, {
    [SEAT_A]: seatRow(SEAT_A, { favorite: true }),
    [SEAT_B]: seatRow(SEAT_B, { favorite: false }),
    // Predates the field: no `favorite` key on disk.
    [SEAT_C]: seatRow(SEAT_C, { favorite: undefined }),
  });
}

test("FR1 · show --format json: a starred seat is favorite:true, an unstarred one false, a pre-field one false — a boolean key ALWAYS present (JSON mode)", async () => {
  await withRig(async (homeDir) => {
    await favoritesFixture(homeDir);
    for (const [seat, expected] of [
      [SEAT_A, true],
      [SEAT_B, false],
      [SEAT_C, false],
    ] as const) {
      const result = await runCli(["--format", "json", "seats", "show", seat], homeDir);
      assert.equal(result.code, 0, result.output);
      const payload = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
      assert.ok(
        Object.hasOwn(payload, "favorite"),
        `show ${seat}: no favorite key: ${result.stdout}`,
      );
      assert.equal(payload.favorite, expected, `show ${seat}`);
    }
  });
});

test("FR2 · show (TEXT): the favorite line is present for BOTH states — an unstarred seat reads `no`, never blank or absent", async () => {
  await withRig(async (homeDir) => {
    await favoritesFixture(homeDir);
    const starred = await runCli(["seats", "show", SEAT_A], homeDir);
    assert.equal(starred.code, 0, starred.output);
    assert.match(starred.output, /^ {2}favorite: {6}yes$/m);
    const unstarred = await runCli(["seats", "show", SEAT_B], homeDir);
    assert.equal(unstarred.code, 0, unstarred.output);
    assert.match(unstarred.output, /^ {2}favorite: {6}no$/m);
  });
});

test("FR3 · list --format json: every seat carries a boolean favorite, read from its own row (JSON mode)", async () => {
  await withRig(async (homeDir) => {
    await favoritesFixture(homeDir);
    const result = await runCli(["--format", "json", "seats", "list"], homeDir);
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      seats: { seatId: string; favorite?: unknown }[];
    };
    assert.equal(payload.seats.length, 3);
    const bySeat = new Map(payload.seats.map((seat) => [seat.seatId, seat.favorite]));
    assert.equal(bySeat.get(SEAT_A), true);
    assert.equal(bySeat.get(SEAT_B), false);
    assert.equal(bySeat.get(SEAT_C), false);
  });
});

test("FR4 · list (TEXT): each line ends the favorite state as `favorite=yes|no`, and the existing columns are unmoved", async () => {
  await withRig(async (homeDir) => {
    await favoritesFixture(homeDir);
    const result = await runCli(["seats", "list"], homeDir);
    assert.equal(result.code, 0, result.output);
    const lineFor = (seat: string) =>
      result.stdout.split("\n").find((line) => line.startsWith(seat)) ?? "";
    assert.match(lineFor(SEAT_A), /\bholders=\d+ {2}favorite=yes\b/);
    assert.match(lineFor(SEAT_B), /\bholders=\d+ {2}favorite=no\b/);
    assert.match(lineFor(SEAT_C), /\bholders=\d+ {2}favorite=no\b/);
    // Control: the column that was already there is still there, in the same place.
    assert.match(lineFor(SEAT_A), /brick=- {2}active=/);
  });
});

test("FR5 · the verb's own write is what the read surface shows: --on then show, --off then show (round trip, JSON mode)", async () => {
  await withRig(async (homeDir) => {
    await favoritesFixture(homeDir);
    const read = async () => {
      const shown = await runCli(["--format", "json", "seats", "show", SEAT_B], homeDir);
      assert.equal(shown.code, 0, shown.output);
      return (JSON.parse(shown.stdout.trim()) as { favorite?: unknown }).favorite;
    };
    assert.equal(await read(), false);
    const on = await runCli(["--format", "json", "seats", "favorite", SEAT_B, "--on"], homeDir);
    assert.equal(on.code, 0, on.output);
    assert.equal(await read(), true, "did that take? show must answer");
    const off = await runCli(["--format", "json", "seats", "favorite", SEAT_B, "--off"], homeDir);
    assert.equal(off.code, 0, off.output);
    assert.equal(await read(), false);
  });
});
