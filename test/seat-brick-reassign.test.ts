import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withTempHome } from "./runtime-test-helpers.js";

/**
 * brick 641ea2f3 / a91f8d23 — "a session is assigned to a brick and then stays there": re-pointing a
 * seat that is ALREADY on a DIFFERENT brick is refused unless `--reassign`. Contract:
 * /wisdom/Bricks/641ea2f3-849f-4289-828a-9c03b7737805/conception/CONTRACT.md (decision table).
 *
 * Every row drives the compiled CLI against an isolated HOME and reads the result back off DISK.
 * Seats are linked through the product's own `seats set-brick` (the verb under test), never by
 * writing `brick_id` into the store by hand. A refusal row asserts the seat store BYTE-UNCHANGED.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SEAT = "11111111-1111-4111-8111-111111111111";
const BRICK_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const BRICK_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

type CliResult = { code: number | null; stdout: string; stderr: string };

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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withRig(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHome("acpx-seat-reassign-", async (homeDir) => {
    await fs.mkdir(path.join(homeDir, ".acpx", "sessions"), { recursive: true });
    await run(homeDir);
  });
}

function storePath(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions", "seats.json");
}

async function plantSeat(homeDir: string): Promise<void> {
  const row = {
    seat_id: SEAT,
    created_at: "2026-10-23T00:00:00.000Z",
    active_holder_id: null,
    next_ordinal: 2,
    closed_at: null,
    favorite: false,
  };
  await fs.writeFile(storePath(homeDir), `${JSON.stringify({ [SEAT]: row })}\n`, "utf8");
}

function setBrick(homeDir: string, args: string[], format = "json"): Promise<CliResult> {
  return runCli(["--format", format, "seats", "set-brick", SEAT, ...args], homeDir);
}

async function linkedSeat(homeDir: string, brick = BRICK_A): Promise<void> {
  await plantSeat(homeDir);
  const linked = await setBrick(homeDir, [brick, "--validated"]);
  assert.equal(linked.code, 0, `precondition: the seat links to ${brick}: ${linked.stderr}`);
}

async function seatRow(homeDir: string): Promise<Record<string, unknown>> {
  const store = JSON.parse(await fs.readFile(storePath(homeDir), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
  const row = store[SEAT];
  assert.ok(row, "the seat row exists");
  return row;
}

function json(result: CliResult): Record<string, unknown> {
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

test("RA1 · a RE-POINT without --reassign is refused with the contract's code + fields, and the store is BYTE-UNCHANGED", async () => {
  await withRig(async (homeDir) => {
    await linkedSeat(homeDir, BRICK_A);
    const before = await fs.readFile(storePath(homeDir), "utf8");

    const refused = await setBrick(homeDir, [BRICK_B, "--validated"]);
    assert.equal(refused.code, 1, "a refusal exits non-zero");
    const body = json(refused);
    assert.equal(body.ok, false);
    assert.equal(body.code, "SEAT_BRICK_REASSIGN_REQUIRED");
    assert.equal(body.detailCode, "SEAT_BRICK_REASSIGN_REQUIRED");
    assert.equal(body.seatId, SEAT);
    assert.equal(body.currentBrickId, BRICK_A);
    assert.equal(body.requestedBrickId, BRICK_B);
    assert.equal(
      await fs.readFile(storePath(homeDir), "utf8"),
      before,
      "nothing was written: the seat store is byte-identical",
    );
    assert.equal((await seatRow(homeDir)).brick_id, BRICK_A, "the seat is still on A");
  });
});

test("RA1b · the refusal TEXT carries the four contract facts, and never suggests detach + attach", async () => {
  await withRig(async (homeDir) => {
    await linkedSeat(homeDir, BRICK_A);
    const refused = await setBrick(homeDir, [BRICK_B], "text");
    assert.equal(refused.code, 1);
    const said = refused.stderr;
    assert.match(said, /SEAT_BRICK_REASSIGN_REQUIRED/);
    assert.match(
      said,
      new RegExp(`seat ${SEAT.slice(0, 8)} is already on brick ${BRICK_A.slice(0, 8)}`),
    );
    assert.match(said, new RegExp(`re-point it to ${BRICK_B.slice(0, 8)}`), "the requested brick");
    assert.match(said, /--part-of/, "what to do with new work instead");
    assert.match(said, /--brick <uuid>/, "…or a new session linked at spawn");
    assert.match(said, /Re-run with --reassign/, "the explicit form");
    assert.doesNotMatch(said, /detach/i, "detach + attach is NOT a route");
  });
});

test("RA2 · --reassign on a real re-point WRITES it and says `reassigned` (text + JSON reassigned:true beside previousBrickId)", async () => {
  await withRig(async (homeDir) => {
    await linkedSeat(homeDir, BRICK_A);
    const moved = await setBrick(homeDir, [BRICK_B, "--validated", "--reassign"]);
    assert.equal(moved.code, 0, moved.stderr);
    const body = json(moved);
    assert.equal(body.ok, true);
    assert.equal(body.reassigned, true);
    assert.equal(body.brickId, BRICK_B);
    assert.equal(body.previousBrickId, BRICK_A);
    assert.equal((await seatRow(homeDir)).brick_id, BRICK_B);

    const back = await setBrick(homeDir, [BRICK_A, "--reassign"], "text");
    assert.equal(back.code, 0, back.stderr);
    assert.match(back.stdout, /reassigned brick_id = /);
    assert.match(back.stdout, new RegExp(`\\(was ${BRICK_B}\\)`));
  });
});

test("RA3 · re-setting the SAME brick is a success no-op with and without --reassign (reassigned:false)", async () => {
  await withRig(async (homeDir) => {
    await linkedSeat(homeDir, BRICK_A);
    for (const extra of [[], ["--reassign"]]) {
      const same = await setBrick(homeDir, [BRICK_A, "--validated", ...extra]);
      assert.equal(same.code, 0, same.stderr);
      const body = json(same);
      assert.equal(body.reassigned, false);
      assert.equal(body.previousBrickId, BRICK_A);
      assert.equal((await seatRow(homeDir)).brick_id, BRICK_A);
    }
  });
});

test("RA4 · an UNLINKED seat is linked with and without --reassign (reassigned:false: a first link is not a re-point)", async () => {
  for (const extra of [[], ["--reassign"]]) {
    await withRig(async (homeDir) => {
      await plantSeat(homeDir);
      const linked = await setBrick(homeDir, [BRICK_A, ...extra]);
      assert.equal(linked.code, 0, linked.stderr);
      const body = json(linked);
      assert.equal(body.reassigned, false);
      assert.equal(body.previousBrickId, null);
      assert.equal((await seatRow(homeDir)).brick_id, BRICK_A);
    });
  }
});

test("RA5 · --unset is unchanged: it detaches a linked seat with no --reassign", async () => {
  await withRig(async (homeDir) => {
    await linkedSeat(homeDir, BRICK_A);
    const unset = await setBrick(homeDir, ["--unset"]);
    assert.equal(unset.code, 0, unset.stderr);
    const body = json(unset);
    assert.equal(body.action, "seat_brick_unset");
    assert.equal(body.reassigned, false);
    assert.equal(body.previousBrickId, BRICK_A);
    assert.equal((await seatRow(homeDir)).brick_id, undefined);
  });
});

test("RA6 · --reassign together with --unset is refused as args-invalid, and nothing is written", async () => {
  await withRig(async (homeDir) => {
    await linkedSeat(homeDir, BRICK_A);
    const before = await fs.readFile(storePath(homeDir), "utf8");
    const refused = await setBrick(homeDir, ["--unset", "--reassign"]);
    assert.equal(refused.code, 1);
    assert.equal(json(refused).code, "SEAT_BRICK_ARGS_INVALID");
    assert.equal(await fs.readFile(storePath(homeDir), "utf8"), before);
  });
});

test("RA7 · the compare-and-set is INSIDE the seat-store hold: two racing links of an unlinked seat — exactly one wins, the loser is refused", async () => {
  await withRig(async (homeDir) => {
    await plantSeat(homeDir);
    const [x, y] = await Promise.all([setBrick(homeDir, [BRICK_A]), setBrick(homeDir, [BRICK_B])]);
    const outcomes = [x, y].map((r) => r.code).toSorted((a, b) => Number(a) - Number(b));
    assert.deepEqual(
      outcomes,
      [0, 1],
      "one link wins, the other is refused (not silently written)",
    );
    const loser = [x, y].find((r) => r.code === 1);
    assert.ok(loser);
    assert.equal(json(loser).code, "SEAT_BRICK_REASSIGN_REQUIRED");
    const winner = json([x, y].find((r) => r.code === 0) as CliResult).brickId;
    assert.equal((await seatRow(homeDir)).brick_id, winner, "the row holds the winner's brick");
  });
});

test("RA8 · `seats set-brick --help` states the rule and --reassign", async () => {
  await withRig(async (homeDir) => {
    const help = await runCli(["seats", "set-brick", "--help"], homeDir);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /--reassign/);
    assert.match(help.stdout, /SESSION STAYS ON THE BRICK IT WAS ASSIGNED TO/);
    assert.match(help.stdout, /SEAT_BRICK_REASSIGN_REQUIRED/);
    const all = await runCli(["seats", "--help"], homeDir);
    assert.match(all.stdout, /unless --reassign/, "the one-line description names the rule");
  });
});

// ─── Every writer of a seat row's brick link takes the guard — a DISCOVERING check ───────────────
//
// The seat row's link is written by spreading the fetched row: `{ ...row, brickId: … }`. Any such
// write in `src/` must be either `writeBrickLink` (which compares inside the hold) or an
// absent-only FILL (`row.brickId !== undefined` returns first). The scan finds its subjects by
// reading every src file; the negative case plants a fresh unlisted writer and expects it flagged.

const SEAT_LINK_SPREAD = /\.\.\.\w+,\s*brickId\b/;
const SANCTIONED_WRITERS: Readonly<Record<string, string>> = {
  "src/session/seat-brick-write.ts": "the one writer: refuses a re-point without reassign",
  "src/session/persistence/seat-store.ts": "fillSeatBrickLink: writes only when brickId is absent",
};

async function srcFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await srcFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function unsanctionedSeatLinkWriters(files: Readonly<Record<string, string>>): string[] {
  return Object.entries(files)
    .filter(([file, text]) => SEAT_LINK_SPREAD.test(text) && !(file in SANCTIONED_WRITERS))
    .map(([file]) => file);
}

test("RA9 · no src file writes a seat row's brickId outside the sanctioned writers (discovering scan + planted negative)", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files: Record<string, string> = {};
  for (const file of await srcFiles(path.join(root, "src"))) {
    files[path.relative(root, file)] = await fs.readFile(file, "utf8");
  }
  assert.ok(Object.keys(files).length > 100, "positive control: the scan actually read src/");
  for (const sanctioned of Object.keys(SANCTIONED_WRITERS)) {
    assert.match(files[sanctioned] ?? "", SEAT_LINK_SPREAD, `${sanctioned} still has its write`);
  }
  assert.deepEqual(unsanctionedSeatLinkWriters(files), [], "an unguarded seat-link writer exists");

  // NEGATIVE CASE: a fresh writer nobody registered must be flagged.
  const planted = {
    ...files,
    "src/cli/new-rogue-writer.ts": "seats.set(id, { ...row, brickId: link });",
  };
  assert.deepEqual(unsanctionedSeatLinkWriters(planted), ["src/cli/new-rogue-writer.ts"]);
});
