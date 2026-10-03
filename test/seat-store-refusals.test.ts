import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withTempHome as withTempHomeFixture } from "./runtime-test-helpers.js";

/**
 * L4 — seat-store refusals (container 4b12e368; bricks bf454a2c, 6391b51b, 92c4f30a,
 * a18c822f). R21 is the rule: a refusal names the PROPERTY that makes a case safe, never
 * an enumeration of origins its author thought of.
 *
 * ## HOW EVERY ROW ASSERTS A REFUSAL (container rule — channel and mode are named per row)
 *
 * Every row spawns the compiled CLI and asserts on `stdout + stderr` COMBINED, together
 * with the exit code, never the code alone. The refusal envelope is on stderr in TEXT
 * mode and on stdout under `--format json` (global flag, before the subcommand); the
 * combined stream is the only form invariant to both. Each row says which mode it runs.
 *
 * ## THE PRINCIPLE EVERY ADVICE ROW EXISTS FOR (L1's test-engineer, brick 3dff714d)
 *
 * "A guard is not verified until its own recovery advice has been run FROM THE REFUSED
 * STATE." So the rows that matter here do not stop at "the string was printed": they
 * reach the refused state, RUN what the refusal told the operator to run, and assert
 * the state it was supposed to produce. A string-match cannot tell a correct instruction
 * from a confident wrong one, which is F4's whole defect.
 *
 * ## THE PAIR (bf454a2c)
 *
 * A MISTYPED seat id must NOT be sent to the backfill; a genuinely backfillable seat
 * MUST be, and that advice is EXECUTED. Neither arm alone catches over-deletion or a
 * wrong remedy.
 *
 * Fixtures: a corrupt store file / row is FIXTURE-ENTERED (nothing in the product writes
 * one — corruption is an external event). A backfillable seat is entered by the product
 * (`sessions new`) and then has ONLY its row removed, which is the state a seat that
 * predates the store, or whose row write failed, is in: a record carrying `seat_id`
 * and no row.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

/** Well-formed, never minted into any rig, referenced by no record. */
const SEAT_TYPO = "99999999-9999-4999-8999-999999999999";
const SEAT_OTHER = "11111111-1111-4111-8111-111111111111";

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
  return withTempHomeFixture("acpx-seat-refusals-", async (homeDir) => {
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
    active_holder_id: null,
    next_ordinal: 2,
    closed_at: null,
    favorite: false,
    ...overrides,
  };
}

async function writeStore(homeDir: string, payload: Record<string, unknown>): Promise<void> {
  await fs.writeFile(storePath(homeDir), `${JSON.stringify(payload)}\n`, "utf8");
}

async function readStoreJson(homeDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(storePath(homeDir), "utf8")) as Record<string, unknown>;
}

/** A real founding session (product-entered), returning its seat id. */
async function mintFounder(homeDir: string, name: string): Promise<string> {
  const cwd = path.join(homeDir, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const founding = await runCli(
    [
      "--cwd",
      cwd,
      "--agent",
      MOCK_AGENT_COMMAND,
      "--approve-all",
      "--format",
      "json",
      "sessions",
      "new",
      "-s",
      name,
    ],
    homeDir,
  );
  assert.equal(founding.code, 0, founding.output);
  const holderId = String(
    (JSON.parse(founding.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
  );
  const record = JSON.parse(
    await fs.readFile(path.join(homeDir, ".acpx", "sessions", `${holderId}.json`), "utf8"),
  ) as { seat_id?: string };
  assert.ok(record.seat_id, "fixture precondition: the founding holder carries a seat id");
  return record.seat_id;
}

/** The backfillable state: a record carrying `seat_id`, and no row for it. */
async function mintBackfillableSeat(homeDir: string, name: string): Promise<string> {
  const seatId = await mintFounder(homeDir, name);
  const store = await readStoreJson(homeDir);
  assert.ok(store[seatId], "fixture precondition: the product minted a row to remove");
  delete store[seatId];
  await writeStore(homeDir, store);
  return seatId;
}

// ═══ bf454a2c — SEAT_ROW_MISSING follows the ORIGIN (the pair) ════════════════

test("F4-typo · show on a seat id NO RECORD references: the refusal says check the id and does NOT send the operator to the backfill — TEXT mode, combined stream", async () => {
  await withRig(async (homeDir) => {
    // A healthy store holding a DIFFERENT seat, so this is "absent row in a real store".
    await writeStore(homeDir, { [SEAT_OTHER]: seatRow(SEAT_OTHER) });
    const result = await runCli(["seats", "show", SEAT_TYPO], homeDir);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /SEAT_ROW_MISSING/);
    assert.match(
      result.output,
      /no readable session record in \S+ carries that seat id/i,
      "does not name the real origin",
    );
    assert.match(
      result.output,
      /typo|check the (seat )?id/i,
      "does not tell the operator to check the id",
    );
    assert.doesNotMatch(
      result.output,
      /backfill/i,
      "F4: the backfill cannot mint a seat nobody created — advising it is a confident wrong remedy",
    );
  });
});

test("F4-unparseable · a seat whose ONLY referencing record does not PARSE: the refusal states what was measured and never claims the seat was never minted — TEXT mode, combined stream", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_OTHER]: seatRow(SEAT_OTHER) });
    // The one record that names this seat is invalid JSON (its text still carries the id).
    // The seat WAS minted; the scan cannot read the record that proves it.
    await fs.writeFile(
      path.join(homeDir, ".acpx", "sessions", "broken-holder.json"),
      `{"acpx_record_id": "broken-holder", "seat_id": "${SEAT_TYPO}", "holder_ordinal": 1,`,
      "utf8",
    );
    const result = await runCli(["seats", "show", SEAT_TYPO], homeDir);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /SEAT_ROW_MISSING/);
    assert.match(
      result.output,
      /no readable session record in \S*sessions carries that seat id/i,
      "the sentence must state the property that was measured",
    );
    assert.doesNotMatch(
      result.output,
      /never minted|ever minted|nothing to repair/i,
      "an unparseable record is evidence the seat WAS minted — the refusal must not deny it",
    );
  });
});

test("F4-typo · rename (a MUTATION verb, row looked up inside the hold) refuses the same way — JSON mode, combined stream", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_OTHER]: seatRow(SEAT_OTHER) });
    const result = await runCli(
      ["--format", "json", "seats", "rename", SEAT_TYPO, "whatever"],
      homeDir,
    );
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /SEAT_ROW_MISSING/);
    assert.match(result.output, /no readable session record in \S+ carries that seat id/i);
    assert.doesNotMatch(result.output, /backfill/i);
  });
});

test("F4-typo · the advice, RUN from the refused state: `seats list` shows the real seats and not the typo; and the backfill really would not have helped", async () => {
  await withRig(async (homeDir) => {
    const realSeat = await mintFounder(homeDir, "typo-advice");
    const refused = await runCli(["seats", "show", SEAT_TYPO], homeDir);
    assert.equal(refused.code, 1, refused.output);
    // The printed advice names `acpx seats list`; run it.
    assert.match(
      refused.output,
      /acpx seats list/,
      "the check-the-id advice must name its command",
    );
    const listed = await runCli(["seats", "list"], homeDir);
    assert.equal(listed.code, 0, listed.output);
    assert.ok(listed.output.includes(realSeat), "the advice command must show the real seat");
    assert.ok(!listed.output.includes(SEAT_TYPO), "the typo'd id is in no listing");
    // Why the backfill is NOT advised: run it anyway and the typo'd seat is still missing.
    const backfilled = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.equal(backfilled.code, 0, backfilled.output);
    const stillMissing = await runCli(["seats", "show", SEAT_TYPO], homeDir);
    assert.equal(stillMissing.code, 1, "the backfill cannot mint a seat nobody created");
  });
});

test("F4-backfillable · a seat whose record exists and whose ROW is missing IS sent to the backfill — and running that advice heals it (show, TEXT)", async () => {
  await withRig(async (homeDir) => {
    const seatId = await mintBackfillableSeat(homeDir, "backfillable-show");
    const refused = await runCli(["seats", "show", seatId], homeDir);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /SEAT_ROW_MISSING/);
    assert.match(refused.output, /predates the seat store/i, "the correct origin advice was lost");
    assert.match(
      refused.output,
      /acpx seats backfill --apply/,
      "the advice must be runnable as printed",
    );
    assert.doesNotMatch(refused.output, /no readable session record in \S+ carries that seat id/i);

    // RUN THE ADVICE, as printed (a bare `seats backfill` is a DRY RUN that writes nothing).
    const healed = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.equal(healed.code, 0, healed.output);
    assert.ok((await readStoreJson(homeDir))[seatId], "the backfill did not mint the row");
    const shown = await runCli(["seats", "show", seatId], homeDir);
    assert.equal(
      shown.code,
      0,
      `the refused verb still refuses after the advice ran: ${shown.output}`,
    );
  });
});

test("F4-backfillable · rename (inside the hold, JSON) gives the same backfill advice, and works after it is run", async () => {
  await withRig(async (homeDir) => {
    const seatId = await mintBackfillableSeat(homeDir, "backfillable-rename");
    const refused = await runCli(
      ["--format", "json", "seats", "rename", seatId, "renamed"],
      homeDir,
    );
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /SEAT_ROW_MISSING/);
    assert.match(refused.output, /acpx seats backfill --apply/);
    assert.doesNotMatch(refused.output, /no readable session record in \S+ carries that seat id/i);
    const healed = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.equal(healed.code, 0, healed.output);
    const renamed = await runCli(
      ["--format", "json", "seats", "rename", seatId, "renamed"],
      homeDir,
    );
    assert.equal(renamed.code, 0, renamed.output);
  });
});

test("F4 · activate (phase 0.1) follows the origin too: typo ⇒ no backfill; backfillable ⇒ backfill — TEXT mode, combined stream", async () => {
  await withRig(async (homeDir) => {
    const backfillable = await mintBackfillableSeat(homeDir, "activate-pair");
    const typo = await runCli(
      ["--agent", MOCK_AGENT_COMMAND, "sessions", "activate", SEAT_TYPO, "nobody"],
      homeDir,
    );
    assert.notEqual(typo.code, 0, typo.output);
    assert.match(typo.output, /SEAT_ROW_MISSING/);
    assert.match(typo.output, /no readable session record in \S+ carries that seat id/i);
    assert.doesNotMatch(typo.output, /backfill/i);

    const real = await runCli(
      ["--agent", MOCK_AGENT_COMMAND, "sessions", "activate", backfillable, "nobody"],
      homeDir,
    );
    assert.notEqual(real.code, 0, real.output);
    assert.match(real.output, /SEAT_ROW_MISSING/);
    assert.match(real.output, /acpx seats backfill --apply/);
  });
});

test("F4 · create-into-seat (`sessions new --seat`) follows the origin too — TEXT mode, combined stream", async () => {
  await withRig(async (homeDir) => {
    const backfillable = await mintBackfillableSeat(homeDir, "join-pair");
    const cwd = path.join(homeDir, "workspace");
    const join = (seat: string) =>
      runCli(
        [
          "--cwd",
          cwd,
          "--agent",
          MOCK_AGENT_COMMAND,
          "--approve-all",
          "sessions",
          "new",
          "--seat",
          seat,
        ],
        homeDir,
      );
    const typo = await join(SEAT_TYPO);
    assert.notEqual(typo.code, 0, typo.output);
    assert.match(typo.output, /no readable session record in \S+ carries that seat id/i);
    assert.doesNotMatch(typo.output, /backfill/i);
    const real = await join(backfillable);
    assert.notEqual(real.code, 0, real.output);
    assert.match(real.output, /acpx seats backfill --apply/);
    // The join-specific rider survives the rewrite.
    assert.match(typo.output, /Joining NEVER creates a seat/);
    assert.match(real.output, /Joining NEVER creates a seat/);
  });
});

// ═══ 6391b51b — every seat-store refusal names the store's ABSOLUTE path ═══════

test("PATH · SEAT_ROW_MISSING names the absolute store path (both origins)", async () => {
  await withRig(async (homeDir) => {
    const backfillable = await mintBackfillableSeat(homeDir, "path-missing");
    const abs = storePath(homeDir);
    const real = await runCli(["seats", "show", backfillable], homeDir);
    const typo = await runCli(["seats", "show", SEAT_TYPO], homeDir);
    for (const result of [real, typo]) {
      assert.equal(result.code, 1, result.output);
      assert.ok(result.output.includes(abs), `no absolute path ${abs} in: ${result.output}`);
    }
  });
});

test("PATH · SEAT_STORE_UNHEALTHY (show against a corrupt STORE, TEXT) names the absolute path, and its quarantine step is a path the operator can paste", async () => {
  await withRig(async (homeDir) => {
    await fs.writeFile(storePath(homeDir), "{ not json at all", "utf8");
    const result = await runCli(["seats", "show", SEAT_OTHER], homeDir);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /SEAT_STORE_UNHEALTHY/);
    assert.ok(result.output.includes(storePath(homeDir)), result.output);
    assert.ok(
      result.output.includes(`${storePath(homeDir)}.corrupt-<timestamp>`),
      "the quarantine target must be an absolute path, not a bare filename",
    );
  });
});

test("PATH · SEAT_STORE_UNWRITABLE (rename against a corrupt STORE, JSON) names the absolute path in its REMEDY too, not only its preamble", async () => {
  await withRig(async (homeDir) => {
    await fs.writeFile(storePath(homeDir), "{ not json at all", "utf8");
    const result = await runCli(["--format", "json", "seats", "rename", SEAT_OTHER, "x"], homeDir);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /SEAT_STORE_UNWRITABLE/);
    assert.ok(
      result.output.includes(`${storePath(homeDir)}.corrupt-<timestamp>`),
      "the unwritable refusal's remedy still uses the bare filename",
    );
  });
});

test("PATH · MalformedSeatRowError names seats.json AND the absolute path — show (TEXT) and the raw propagation through `sessions new --seat`", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, {
      [SEAT_OTHER]: { seat_id: SEAT_OTHER, created_at: "x", next_ordinal: 0 },
    });
    const shown = await runCli(["seats", "show", SEAT_OTHER], homeDir);
    assert.equal(shown.code, 1, shown.output);
    assert.match(shown.output, /SEAT_ROW_MALFORMED/);
    assert.ok(shown.output.includes(storePath(homeDir)), shown.output);

    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const joined = await runCli(
      [
        "--cwd",
        cwd,
        "--agent",
        MOCK_AGENT_COMMAND,
        "--approve-all",
        "sessions",
        "new",
        "--seat",
        SEAT_OTHER,
      ],
      homeDir,
    );
    assert.notEqual(joined.code, 0, joined.output);
    assert.match(joined.output, /MALFORMED/i);
    assert.match(
      joined.output,
      /seats\.json/,
      "the raw MalformedSeatRowError never names the file",
    );
    assert.ok(joined.output.includes(storePath(homeDir)), joined.output);
  });
});

test("PATH · the quarantine advice, RUN from the refused state (corrupt store): quarantine the named path, run the backfill, and the seat is readable again", async () => {
  await withRig(async (homeDir) => {
    const seatId = await mintFounder(homeDir, "quarantine-advice");
    await fs.writeFile(storePath(homeDir), "{ not json at all", "utf8");
    const refused = await runCli(["seats", "show", seatId], homeDir);
    assert.equal(refused.code, 1, refused.output);
    const named = /(\/\S+seats\.json)\.corrupt-<timestamp>/.exec(refused.output);
    assert.ok(named, `no absolute quarantine target in: ${refused.output}`);
    // Run it as printed: rename the NAMED path, keeping the file, then backfill.
    const target = named[1];
    assert.equal(target, storePath(homeDir));
    await fs.rename(target, `${target}.corrupt-20260101T000000Z`);
    const backfilled = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.equal(backfilled.code, 0, backfilled.output);
    const shown = await runCli(["seats", "show", seatId], homeDir);
    assert.equal(shown.code, 0, `the advice ran and the seat is still unreadable: ${shown.output}`);
    await fs.stat(`${target}.corrupt-20260101T000000Z`); // KEPT, as the advice says
  });
});

// ═══ 92c4f30a — a malformed-row refusal states the invariant, not a verb ═══════

test("92c4f30a · `show` on a malformed row is not told about a DELETE it did not run; `delete` still refuses and keeps the data-loss rationale — TEXT mode, combined stream", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, {
      [SEAT_OTHER]: { seat_id: SEAT_OTHER, created_at: "x", next_ordinal: 0 },
    });
    const shown = await runCli(["seats", "show", SEAT_OTHER], homeDir);
    assert.equal(shown.code, 1, shown.output);
    assert.match(shown.output, /SEAT_ROW_MALFORMED/);
    assert.doesNotMatch(
      shown.output,
      /this delete REFUSES|instead of removing it/i,
      "show is being told about a verb it did not run",
    );
    // The paired arm: the refusal must not be rewritten into silence (over-deletion).
    const deleted = await runCli(["seats", "delete", SEAT_OTHER], homeDir);
    assert.equal(deleted.code, 1, deleted.output);
    assert.match(deleted.output, /SEAT_ROW_MALFORMED/);
    assert.match(deleted.output, /hand-recoverable/, "the data-loss rationale was lost");
    assert.match(deleted.output, /QUARANTINE/, "the remedy was lost");
    assert.doesNotMatch(deleted.output, /this delete REFUSES|instead of removing it/i);
    assert.deepEqual(
      Object.keys(await readStoreJson(homeDir)),
      [SEAT_OTHER],
      "the refused delete must leave the malformed row in place",
    );
  });
});

// ═══ a18c822f — the "D9 phase (i)" citation names a decision that does not exist ═

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Whole-token occurrences of `D9 phase` — NOT bare `D9`, which also lives inside longer tokens
 * and in `models-command.ts`'s unrelated `§D9` (C5). Read as bytes (`latin1`) because one source
 * file carries a NUL and a text-mode reader would hide its hits. */
function d9PhaseHits(text: string): number {
  return text.match(/\bD9 phase\b/g)?.length ?? 0;
}

test("a18c822f · no source comment cites 'D9 phase' — a decision that is in no conception document (real referent: CONCEPTION §4 contract C2)", async () => {
  const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
  const files = await sourceFiles(srcRoot);
  assert.ok(
    files.length > 100,
    `the sweep scanned ${files.length} files — an empty read is a failed measurement`,
  );
  // POSITIVE CONTROL OF THE SAME KIND AS THE THING SOUGHT: the sweep function over a string
  // known to carry the token (and a near-miss it must not count).
  assert.equal(
    d9PhaseHits("// D9 phase (i): the name is written"),
    1,
    "the sweep cannot see its own token",
  );
  assert.equal(
    d9PhaseHits("C5 §8.3 / §D9, and D95 phase"),
    0,
    "the sweep over-matches a longer token",
  );
  const hits: string[] = [];
  for (const file of files) {
    if (d9PhaseHits(await fs.readFile(file, "latin1")) > 0) {
      hits.push(path.relative(srcRoot, file));
    }
  }
  assert.deepEqual(
    hits,
    [],
    "a pointer to a decision that does not exist is how a reader concludes the rule is imaginary",
  );
});
