import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { TOP_LEVEL_VERBS } from "../src/cli-core.js";
import { registerDefaultCommands } from "../src/cli/command-registration.js";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";
import {
  buildSeatDeletion,
  decideSeatClose,
  decideSeatReopen,
  seatHolderOpenMessage,
} from "../src/cli/seats-command.js";
import { readSeatStore, withSeatStoreWrite, type SeatRecord } from "../src/session/persistence.js";
import { withTempHome as withTempHomeFixture } from "./runtime-test-helpers.js";

/**
 * B2b — `acpx seats set-brick` / `rename` / `delete`. Brick 03bc080b.
 *
 * ## THE EVIDENCE STANDARD, AND WHY EVERY ROW BELOW SPAWNS A PROCESS
 *
 * AC16: *"proven by driving the real CLI against a rig, never a unit-level stub of
 * the store."* So every legitimate row and every refusal row runs the compiled CLI
 * (`dist-test/src/cli.js`) as a child process against an isolated rig with its own
 * `HOME`, and reads the result back off DISK rather than out of the CLI's own echo.
 * The two in-process rows at the bottom are supplementary and say so.
 *
 * This bites hardest on Group R. A unit test over `registerDefaultCommands` proves
 * REGISTRATION; it cannot prove the shipped binary answers `acpx seats …`, which is
 * that group's whole subject — the failure mode being that the token falls through
 * to the AGENT registry, where it is not an error but a prompt delivery.
 *
 * ## 🛑 WHY THERE IS NO "REMOVE THE POLICY AND SHOW RED" ROW ANYWHERE IN THIS FILE
 *
 * The plan marks nine rows `[RED-WHEN-REMOVED]`. Demonstrating those by deleting a
 * guard from `src/` and re-running is **mutation testing, which is forbidden
 * fleet-wide** (Daniel, 2026-09-22) — and the same brief that asks for the
 * demonstration also states the prohibition and its remedy: *"Prove a check can fail
 * with a negative case in the test file, never by gutting a guard."*
 *
 * So each `[RED-WHEN-REMOVED]` row is discharged as a **committed negative case**:
 * the assertion is paired, in this file, with an arm that feeds the checker the
 * violation it claims to detect and requires it to be caught. Those arms run with
 * the suite forever, where a one-off mutation run proves nothing after the commit
 * that recorded it.
 *
 * ⚠️ STATED AT EXACTLY ITS WIDTH, because it is not the same claim: these controls
 * prove the ASSERTIONS ARE NOT VACUOUS — they detect the violation they are written
 * against. They do not prove by execution that deleting one particular line of
 * `src/cli/seats-command.ts` turns a particular row red. Where a row's whole subject
 * is a coupling to a specific guard, the row instead asserts on a substring and a
 * refusal CODE that only that guard produces, which is the same evidence by a
 * different route.
 *
 * ## 🛑 PRECONDITION AUDIT — WHICH STATES THE PRODUCT ENTERS, AND WHICH A FIXTURE DOES
 *
 * Every assertion here names the state it claims to observe, and this is where that
 * state is shown to have been ENTERED. A fixture-entered precondition is honest when
 * the reason is structural and stated; it is a defect when a fixture quietly stands in
 * for a product path that exists. The audit, row by class:
 *
 * - **A well-formed seat row + its holder** — PRODUCT-ENTERED. `RN2′` mints both with
 *   a real `sessions new`, drives `seats rename` against them, and asserts on the
 *   files the product wrote. The other rows use a fixture row of the SAME SHAPE
 *   `mintSeatRow` writes, for control over `name` / `brick_id` / neighbouring rows —
 *   anchored to the real path by RN2′ rather than standing in for it.
 * - **`active_holder_id: null` (a vacant seat)** — FIXTURE-ENTERED, structurally. No
 *   product path at `d50e5bf` clears that field; see `RN8`, which states it in full.
 * - **A malformed ROW, and a malformed STORE FILE** — FIXTURE-ENTERED, structurally.
 *   Nothing in the product writes an unparseable row or an unparseable file:
 *   corruption is an external event (a torn disk, a hand edit), which is precisely why
 *   the store carries `fileState` and `unparsedRows` at all. `SB5`, `RN9`, `D7`,
 *   `D8r`, `D9r`.
 * - **A seat row and a holder record disagreeing about `name`** — PRODUCT-ENTERED, and
 *   by this very block: under ruling A one `seats rename` produces it. `RN5` writes the
 *   disagreement as a fixture only so the verb meets a PRE-EXISTING one rather than the
 *   one it just created — the same reason the activation protocol reads its divergence
 *   before it writes.
 * - **`closed_at` non-null** — **UPDATED FOR B2c: PRODUCT-ENTERED, by this block's own
 *   `acpx seats close` verb.** At B2b nothing in the product could write a closure, so
 *   `D4`'s control arm (below) constructed a stamped row as an in-test VALUE rather
 *   than a store fixture, and that remains true — `D4` is about a checker seeing a
 *   value, not about reaching the closed STATE. The closed-seat rows added by B2c
 *   drive the real `acpx seats close` and read the result off disk — see `CL1` and
 *   `CLB1` (the latter mints a real seat+holder, closes both for real, THEN drives
 *   `set-brick` against the product-closed seat).
 *   ⚠️ **CORRECTED (independent TE finding F3, 2026-09-29)** — ~~"A row still using
 *   `seatRow(..., { closed_at: … })` as a fixture in this file names its OWN
 *   structural reason (holder-changed's interleaving cannot be entered by a
 *   single-process CLI row — see `CL7`'s comment)"~~ was FALSE on two counts: (1)
 *   `CLB2`/`CLB3` fixtured `closed_at` directly with NO stated reason, and there was
 *   none available — the shipped verb CAN produce that state, which is the defect
 *   half of the fixture-disclosure rule, not the structural half; (2) the
 *   cross-reference was wrong twice — holder-changed is `CL5`, not `CL7` (`CL7` is
 *   the store-health row), and `CL5` is not a store fixture at all — it builds an
 *   in-test `SeatRecord` value, calling `decideSeatClose` directly. **What is
 *   actually true, post-fix:** `CLB2`/`CLB3` now state they are ANCHORED to `CLB1`
 *   (cost/control reason, not a structural one — see their own comments), which is
 *   the honest label; nothing in this file fixtures `closed_at` for a structural
 *   reason any more.
 * - **`brick_id` set on a row** — **CORRECTED (independent TE finding, B2d/re-open
 *   verification, 2026-09-30) — RECURRENCE of the SAME CLASS F3 caught above, on a
 *   different field.** `LS5` fixtured `brick_id` directly with no stated reason,
 *   while `seats set-brick` is a shipped path (`SB1` drives it for real, above) —
 *   the exact defect half of the rule, again. Fixed the same way this rule prefers:
 *   `LS5`'s with-brick arm now drives the real `set-brick` verb. Nothing in this
 *   file fixtures `brick_id` for a structural reason.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

const SEAT_A = "11111111-1111-4111-8111-111111111111";
const SEAT_B = "22222222-2222-4222-8222-222222222222";
const SEAT_C = "33333333-3333-4333-8333-333333333333";
/** Well-formed, and deliberately never minted into any rig. */
const SEAT_ABSENT = "99999999-9999-4999-8999-999999999999";
const BRICK_ID = "03bc080b-eccc-4529-82cf-8e05c4e8a054";

type CliResult = { code: number | null; stdout: string; stderr: string; output: string };

/**
 * Drive the compiled CLI against the rig.
 *
 * The env scrub is copied from `seat-creation-paths.test.ts` for the same reason: a
 * child that inherits the TEST RUNNER's own `ACPX_SESSION_*` acquires that session as
 * ambient context, and for Group R specifically an inherited session would change
 * which fallthrough path an unregistered token takes.
 */
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
      // 🛑 THE CWD IS THE RIG, NOT THE REPO. An unregistered token probed from a
      // SESSION-BEARING cwd is a real prompt delivery to whatever agent owns that
      // session — so the one row that deliberately probes an unregistered token
      // (R1's control) must run where no session can possibly be resolved. The rig
      // is a fresh mkdtemp whose HOME holds an empty session store.
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
  return withTempHomeFixture("acpx-seats-verbs-", async (homeDir) => {
    await fs.mkdir(path.join(homeDir, ".acpx", "sessions"), { recursive: true });
    await run(homeDir);
  });
}

function storePath(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions", "seats.json");
}

type PersistedRow = Record<string, unknown>;

/**
 * A well-formed persisted seat row. `closed_at` is present and `null` — never
 * absent; `favorite` likewise, matching what `mintSeatRow` / any real write emits
 * post-D-STAR. `FV6` in the favorite group tests the OTHER shape — a row that
 * predates the field entirely, by omitting it via `overrides`.
 */
function seatRow(seatId: string, overrides: PersistedRow = {}): PersistedRow {
  return {
    seat_id: seatId,
    created_at: "2026-09-29T00:00:00.000Z",
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

async function writeRawStore(homeDir: string, payload: string): Promise<void> {
  await fs.writeFile(storePath(homeDir), payload, "utf8");
}

async function readStoreJson(homeDir: string): Promise<Record<string, PersistedRow>> {
  return JSON.parse(await fs.readFile(storePath(homeDir), "utf8")) as Record<string, PersistedRow>;
}

async function readStoreBytes(homeDir: string): Promise<string> {
  return await fs.readFile(storePath(homeDir), "utf8");
}

async function storeExists(homeDir: string): Promise<boolean> {
  try {
    await fs.stat(storePath(homeDir));
    return true;
  } catch {
    return false;
  }
}

/** The refusal envelope, parsed from `--format json`. */
type Refusal = { ok: boolean; code: string; error: string };

function refusalOf(result: CliResult): Refusal {
  const parsed = JSON.parse(result.stdout.trim()) as Refusal;
  assert.equal(parsed.ok, false, `expected a refusal envelope, got ${result.stdout}`);
  return parsed;
}

// ═══ Group R — the `seats` namespace exists ═══════════════════════════════════

test("R1 · the REAL BINARY answers `acpx seats` — asserted on stdout content, never an rc", async () => {
  await withRig(async (homeDir) => {
    const help = await runCli(["seats", "--help"], homeDir);

    // ⚠️ NO EXIT-CODE ASSERTION HERE, DELIBERATELY. `cli-core.ts:41-52`: the rc
    // "reports WHICH FALLTHROUGH PATH WAS HIT, never whether the command exists, and
    // it is CWD-DEPENDENT", so a guard written against one passes today against a
    // completely unregistered verb.
    assert.match(help.output, /set-brick/);
    assert.match(help.output, /rename/);
    assert.match(help.output, /delete/);
    // B2c — the shipped binary answers `acpx seats close`, not just `registerSeatsCommand`.
    assert.match(help.output, /close/);
    assert.doesNotMatch(
      help.output,
      /No acpx session found/,
      "the agent-catch-all string must be ABSENT — its presence means `seats` fell through to " +
        "the agent registry, where the words after it are a PROMPT rather than a verb",
    );
  });
});

test("R1 control · the absent-string assertion can SEE the string — an unregistered token produces it", async () => {
  // §3a-bis: a zero from the fault arm means nothing until the control arm has
  // produced a non-zero. R1 asserts a string is ABSENT; without this row, R1 would
  // pass identically if `No acpx session found` could never appear at all — from a
  // typo in the pattern, or from the message having been reworded.
  //
  // 🛑 SAFE ONLY BECAUSE THE RIG IS SESSION-FREE. `runCli` runs with cwd = the rig
  // and HOME = the rig, whose session store is empty, so the agent path can resolve
  // nothing. The same probe in a session-bearing cwd is a real prompt delivery.
  await withRig(async (homeDir) => {
    const bogus = await runCli(["zzz-not-a-registered-verb", "list"], homeDir);
    assert.match(
      bogus.output,
      /No acpx session found/,
      "an unregistered token must fall through to the agent path and produce this exact " +
        "string — if it does not, R1's absent-string assertion is vacuous",
    );
  });
});

test("R1b · a bogus `seats` subverb is an ERROR, not an absorbed prompt", async () => {
  await withRig(async (homeDir) => {
    const bogus = await runCli(["seats", "zzz-bogus-subverb"], homeDir);
    assert.match(bogus.output, /unknown command|too many arguments/i);
    assert.doesNotMatch(bogus.output, /No acpx session found/);
  });
});

test("R2 · `seats` is in TOP_LEVEL_VERBS — with the negative case that proves the check bites", () => {
  assert.ok(
    TOP_LEVEL_VERBS.has("seats"),
    "without this entry `acpx seats …` registers as an AGENT NAME (OS brick 2e3f50b5)",
  );
  // THE COMMITTED NEGATIVE CASE, in place of gutting the source: present the
  // registered-vs-listed check the exact violation it exists to catch — `seats`
  // registered and absent from the set — and require it to be flagged.
  const registeredWithoutEntry = ["seats"];
  const setWithoutSeats = new Set([...TOP_LEVEL_VERBS].filter((verb) => verb !== "seats"));
  const missing = registeredWithoutEntry.filter((name) => !setWithoutSeats.has(name));
  assert.deepEqual(
    missing,
    ["seats"],
    "the bidirectional check in top-level-verbs.test.ts must flag a registered-but-unlisted " +
      "`seats`; if this control stops catching it, that check has stopped protecting this verb",
  );
});

test("R3 · `registerDefaultCommands` registers `seats` — with its own negative case", () => {
  const program = new Command();
  registerDefaultCommands(program, fakeConfig());
  const names = new Set(program.commands.map((command) => command.name()));
  assert.ok(
    names.has("seats"),
    "the other half of the two registrations: an entry in TOP_LEVEL_VERBS that no command " +
      "answers is a DEAD TOKEN — it blocks an agent of that name while doing nothing",
  );
  // The committed negative case for the dead-token direction.
  const deadSet = new Set([...TOP_LEVEL_VERBS, "zzz-dead-seats-token"]);
  const dead = [...deadSet].filter((verb) => !names.has(verb) && verb !== "help");
  assert.ok(
    dead.includes("zzz-dead-seats-token"),
    "the dead-token direction must catch a set entry nothing answers",
  );
});

function fakeConfig(): ResolvedAcpxConfig {
  return {
    defaultAgent: "codex",
    defaultPermissions: "approve-all",
    nonInteractivePermissions: "deny",
    authPolicy: "skip",
    ttlMs: 900_000,
    queueMaxDepth: 16,
    format: "text",
    agents: {},
    auth: {},
    disableExec: false,
    mcpServers: [],
    subscriptions: { version: 3, subscriptions: [], profiles: [] },
    globalPath: "/tmp/acpx-test-config.json",
    projectPath: "/tmp/.acpxrc.json",
    hasGlobalConfig: false,
    hasProjectConfig: false,
  } as unknown as ResolvedAcpxConfig;
}

// ═══ Group SB — `seats set-brick` ═════════════════════════════════════════════

test("SB1 · sets brick_id; closed_at survives as an explicit null; every other field byte-identical", async () => {
  await withRig(async (homeDir) => {
    const before = { [SEAT_A]: seatRow(SEAT_A, { name: "alpha" }), [SEAT_B]: seatRow(SEAT_B) };
    await writeStore(homeDir, before);

    const result = await runCli(["seats", "set-brick", SEAT_A, BRICK_ID], homeDir);
    assert.equal(result.code, 0, result.output);

    const after = await readStoreJson(homeDir);
    assert.equal(after[SEAT_A]?.brick_id, BRICK_ID);
    // H4 — the KEY, not merely the value. `closed_at` must be PRESENT on every row a
    // verb writes: the parse leg rejects a row missing it as malformed (D8), so an
    // omission would write rows the store rejects on its next read.
    assert.ok(
      Object.hasOwn(after[SEAT_A] as object, "closed_at"),
      "closed_at must remain a PRESENT key, not be dropped by rebuilding the row",
    );
    assert.equal(after[SEAT_A]?.closed_at, null);
    // Brick `9984c510`: a bare `set-brick` (no `--validated`) now also writes
    // the sibling `brick_id_validated: false` — asserted explicitly here, and
    // excluded from the "everything else untouched" comparison below exactly
    // as `brick_id` itself is, since the two travel together by design.
    assert.equal(after[SEAT_A]?.brick_id_validated, false);
    assert.deepEqual(
      { ...after[SEAT_A], brick_id: undefined, brick_id_validated: undefined },
      { ...before[SEAT_A], brick_id: undefined, brick_id_validated: undefined },
      "every field other than brick_id/brick_id_validated must be untouched",
    );
    assert.deepEqual(after[SEAT_B], before[SEAT_B], "an unrelated row must be byte-identical");
  });
});

test("SB2 · a malformed SEAT ref is refused by the seat-id mechanism, and nothing is written", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });
    const bytes = await readStoreBytes(homeDir);

    const result = await runCli(
      ["--format", "json", "seats", "set-brick", "not-a-uuid", BRICK_ID],
      homeDir,
    );
    assert.equal(result.code, 1);
    const refusal = refusalOf(result);
    assert.equal(refusal.code, "SEAT_REF_INVALID");
    // F4 — the assertion must distinguish WHICH mechanism refused. `set-brick` takes
    // two refs and both can be "a bad ref"; B2's AP13 was green whichever of two
    // mechanisms fired because both messages shared a substring.
    assert.match(refusal.error, /Seat id must be a seat id in lowercase UUID form/);
    assert.match(refusal.error, /"not-a-uuid"/, "the refusal must name the value it rejected");
    assert.doesNotMatch(refusal.error, /FULL brick uuid/);

    assert.equal(await readStoreBytes(homeDir), bytes, "a refusal must write nothing");
  });
});

test("SB3 · a well-formed seat id with NO ROW (and no record) is refused naming that origin, not a backfill it cannot get (AP17 / F4)", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });

    const result = await runCli(
      ["--format", "json", "seats", "set-brick", SEAT_ABSENT, BRICK_ID],
      homeDir,
    );
    assert.equal(result.code, 1);
    const refusal = refusalOf(result);
    assert.equal(refusal.code, "SEAT_ROW_MISSING");
    // The wording is what SB2's mechanism CANNOT produce — that asymmetry is what makes
    // the two refusals distinguishable rather than merely differently worded. SEAT_ABSENT
    // is referenced by no record, so this is the typo origin (brick `bf454a2c`); the
    // backfillable origin's pair lives in `seat-store-refusals.test.ts`.
    assert.match(refusal.error, /has no row in/);
    assert.match(refusal.error, /no readable session record in \S+ carries that seat id/);
    assert.doesNotMatch(refusal.error, /must be a seat id in lowercase UUID form/);
  });
});

test("SB4 · a non-uuid BRICK ref is refused by the brick mechanism, naming that argument", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });
    const bytes = await readStoreBytes(homeDir);

    const result = await runCli(
      ["--format", "json", "seats", "set-brick", SEAT_A, "5b9f2617"],
      homeDir,
    );
    assert.equal(result.code, 1);
    const refusal = refusalOf(result);
    assert.equal(refusal.code, "BRICK_REF_INVALID");
    assert.match(refusal.error, /Brick id must be a FULL brick uuid/);
    assert.match(refusal.error, /"5b9f2617"/);
    assert.doesNotMatch(refusal.error, /Seat id must be/);
    assert.equal(await readStoreBytes(homeDir), bytes);
  });
});

test("SB4b · the three set-brick refusals are PAIRWISE distinguishable — the AP13 control", async () => {
  // 🔑 ASSERTED AS A PROPERTY OF THE SET, not row by row. B2's AP13 passed whichever
  // of two mechanisms fired because the check only ever looked at one message at a
  // time; the defect is only visible when the messages are compared to each other.
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });
    const refusals = await Promise.all([
      runCli(["--format", "json", "seats", "set-brick", "not-a-uuid", BRICK_ID], homeDir),
      runCli(["--format", "json", "seats", "set-brick", SEAT_A, "5b9f2617"], homeDir),
      runCli(["--format", "json", "seats", "set-brick", SEAT_ABSENT, BRICK_ID], homeDir),
    ]);
    const codes = refusals.map((result) => refusalOf(result).code);
    assert.deepEqual(codes, ["SEAT_REF_INVALID", "BRICK_REF_INVALID", "SEAT_ROW_MISSING"]);
    assert.equal(new Set(codes).size, 3, "each mechanism must carry its own code");

    const markers = [
      /Seat id must be a seat id in lowercase UUID form/,
      /Brick id must be a FULL brick uuid/,
      /has no row in/,
    ];
    for (const [index, result] of refusals.entries()) {
      const { error } = refusalOf(result);
      for (const [other, marker] of markers.entries()) {
        assert.equal(
          marker.test(error),
          index === other,
          `refusal ${index} must match ONLY its own marker (${String(marker)})`,
        );
      }
    }
  });
});

test("SB5 · a MALFORMED store refuses AT THE SEAT-STORE WRITE, and the unfaulted arm is the control", async () => {
  await withRig(async (homeDir) => {
    // §3a-bis — THE CONTROL ARM FIRST, in the same test, so the fault arm's zero is
    // interpretable. A zero from a fault arm means nothing until the control arm has
    // produced a non-zero on the same rig.
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });
    const healthy = await runCli(["seats", "set-brick", SEAT_A, BRICK_ID], homeDir);
    assert.equal(healthy.code, 0, healthy.output);
    assert.equal(
      (await readStoreJson(homeDir))[SEAT_A]?.brick_id,
      BRICK_ID,
      "control arm: the UNFAULTED store is written — without this the fault arm proves nothing",
    );

    // THE FAULT.
    await writeRawStore(homeDir, "{ this is not json");
    const bytes = await readStoreBytes(homeDir);
    const faulted = await runCli(
      ["--format", "json", "seats", "set-brick", SEAT_A, BRICK_ID],
      homeDir,
    );
    assert.equal(faulted.code, 1);
    const refusal = refusalOf(faulted);
    // §E309 — NAME THE SEAM. "The run failed" is not a finding; this asserts the
    // failure is the seat-store WRITE refusing, with that error's own signature.
    assert.equal(refusal.code, "SEAT_STORE_UNWRITABLE");
    assert.match(refusal.error, /refusing to write the seat store at/);
    assert.match(refusal.error, /seats\.json/);
    // 🛑 AND IT MUST NOT READ AS "SEAT NOT FOUND" — that is F1's defect, a
    // present-and-corrupt store answering ABSENT and sending an operator to a
    // backfill that refuses to run against a malformed store.
    assert.notEqual(refusal.code, "SEAT_ROW_MISSING");
    assert.equal(await readStoreBytes(homeDir), bytes, "the corrupt file must be left untouched");
  });
});

// ═══ Group RN — `seats rename` ════════════════════════════════════════════════

test("RN1 · writes the seat row's name; closed_at present and null; other fields byte-identical", async () => {
  await withRig(async (homeDir) => {
    const before = { [SEAT_A]: seatRow(SEAT_A, { name: "alpha" }), [SEAT_B]: seatRow(SEAT_B) };
    await writeStore(homeDir, before);

    const result = await runCli(["seats", "rename", SEAT_A, "beta"], homeDir);
    assert.equal(result.code, 0, result.output);

    const after = await readStoreJson(homeDir);
    assert.equal(after[SEAT_A]?.name, "beta");
    assert.ok(Object.hasOwn(after[SEAT_A] as object, "closed_at"));
    assert.equal(after[SEAT_A]?.closed_at, null);
    assert.deepEqual({ ...after[SEAT_A], name: undefined }, { ...before[SEAT_A], name: undefined });
    assert.deepEqual(after[SEAT_B], before[SEAT_B]);
  });
});

test("RN2′ · the seat row carries the new name and the ACTIVE HOLDER'S RECORD IS UNCHANGED", async () => {
  // 🔑 THE CONTEMPLATED STATE, ASSERTED POSITIVELY RATHER THAN TOLERATED (ruling A).
  // Under the ruling `seats rename` writes the SEAT ROW ONLY; the holder's copy of
  // the name is a derived projection that phase (i) explicitly allows to disagree,
  // with the seat winning. This row proves we chose that state deliberately.
  //
  // The rig is built by the PRODUCT — a real `sessions new`, which mints a real seat
  // row and a real holder record — because a hand-authored record would not be
  // evidence about what the real record write does.
  await withRig(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const created = await runCli(
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
        "rn2-holder",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const createdPayload = JSON.parse(created.stdout.trim()) as { acpxRecordId?: string };
    const recordId = createdPayload.acpxRecordId;
    assert.ok(
      recordId,
      `fixture precondition: sessions new returned a record id — ${created.stdout}`,
    );
    const recordFile = path.join(homeDir, ".acpx", "sessions", `${recordId}.json`);
    const recordBefore = await fs.readFile(recordFile, "utf8");
    const seatId = (JSON.parse(recordBefore) as { seat_id?: string }).seat_id;
    assert.ok(seatId, "fixture precondition: the session carries a seat id");
    assert.match(seatId, /^[0-9a-f-]{36}$/);

    const renamed = await runCli(
      ["--format", "json", "seats", "rename", seatId, "renamed"],
      homeDir,
    );
    assert.equal(renamed.code, 0, renamed.output);

    const store = await readSeatStore(path.join(homeDir, ".acpx", "sessions"));
    assert.equal(store.seats.get(seatId)?.name, "renamed", "the SEAT is what the verb writes");

    const recordAfter = await fs.readFile(recordFile, "utf8");
    assert.equal(
      recordAfter,
      recordBefore,
      "the active holder's record must be BYTE-IDENTICAL — a rename that touched it would " +
        "either be a silent no-op (no `name` authority flag exists) or a drift into option B",
    );
  });
});

// ⚠️ **PLAN.md's `RN3′` HAS NO ROW HERE, AND ITS DELETION IS THE POINT.**
//
// A row of that name existed and was a TAUTOLOGY: it built two literal JSON strings
// differing in `name` and asserted they differ. It drove no CLI, touched no rig, read
// no file, and never referenced RN2′'s comparison — it constructed a fresh unrelated
// one. It could not fail for any product reason, and it was the only non-async row in
// this file, which is the mechanical tell.
//
// 🔑 **THE PROTECTION RN3′ CLAIMED TO PROVIDE IS REAL AND LIVES IN `RN2′` ITSELF.**
// RN2′ asserts the holder's record is BYTE-IDENTICAL after a `seats rename` driven
// through the real binary. An implementation that also wrote the holder's record makes
// that assertion fail — so RN2′ is SELF-FALSIFYING, which is what "red when its policy
// is removed" actually means: permanently, rather than once. Appending a second block
// to a self-falsifying assertion adds nothing and, built from literals, can only be a
// tautology.
//
// **The test for whether any "negative case" is real: DOES THE PRODUCT APPEAR IN IT?**
// A row constructible from literals in this file alone proves something about
// JavaScript, not about our code.
// *(Found by the independent test-engineer; the specification that invited it has been
// corrected by the sub-HoD, and PLAN.md's credit for ruling A moves to RN2′.)*

test("RN4 · a name is REJECTED, never repaired — with the legitimate pair that still passes", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { name: "alpha" }) });
    const bytes = await readStoreBytes(homeDir);

    for (const bad of ["  padded  ", "trailing ", " leading", "", "line\nbreak"]) {
      const result = await runCli(["--format", "json", "seats", "rename", SEAT_A, bad], homeDir);
      assert.equal(result.code, 1, `expected ${JSON.stringify(bad)} to be refused`);
      const refusal = refusalOf(result);
      assert.equal(refusal.code, "SEAT_NAME_INVALID");
      assert.match(refusal.error, /Seat name must be non-empty/);
      assert.equal(
        await readStoreBytes(homeDir),
        bytes,
        "a rejected name must not be repaired into a written one",
      );
    }

    // AP15 — the paired legitimate row. Without it, a validator that refused
    // EVERYTHING would pass every assertion above.
    const legit = "Hauptsitz — Büro 2 (west)";
    const ok = await runCli(["seats", "rename", SEAT_A, legit], homeDir);
    assert.equal(ok.code, 0, ok.output);
    assert.equal(
      (await readStoreJson(homeDir))[SEAT_A]?.name,
      legit,
      "an accepted name is stored BYTE-IDENTICAL — not trimmed, not coerced, not normalised",
    );
  });
});

test("RN5 · the SEAT is the subject — a pre-existing disagreement is not consulted or reconciled", async () => {
  // The rig is built already disagreeing: the seat says `alpha`, the holder's record
  // says `beta`. A reconciling implementation would read the record, or write it, or
  // refuse. The correct one takes the seat as its only subject.
  //
  // ⚠️ SCOPE, STATED: this proves the VERB treats the seat as authoritative. It does
  // NOT prove any READER prefers the seat — that is a separate row, not a gap in
  // this one.
  await withRig(async (homeDir) => {
    const holderId = "aaaaaaaa-5555-4555-8555-555555555555";
    await writeStore(homeDir, {
      [SEAT_A]: seatRow(SEAT_A, { name: "alpha", active_holder_id: holderId }),
    });
    const recordFile = path.join(homeDir, ".acpx", "sessions", `${holderId}.json`);
    const record = JSON.stringify({ acpx_record_id: holderId, name: "beta", seat_id: SEAT_A });
    await fs.writeFile(recordFile, record, "utf8");

    const result = await runCli(["seats", "rename", SEAT_A, "gamma"], homeDir);
    assert.equal(result.code, 0, result.output);

    assert.equal((await readStoreJson(homeDir))[SEAT_A]?.name, "gamma");
    assert.equal(
      await fs.readFile(recordFile, "utf8"),
      record,
      "the disagreeing record is neither read into the write nor overwritten by it",
    );
  });
});

test("RN6/RN7′ · rename's two refusals are distinguishable, and neither writes", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });
    const bytes = await readStoreBytes(homeDir);

    const badRef = await runCli(
      ["--format", "json", "seats", "rename", "not-a-uuid", "x"],
      homeDir,
    );
    assert.equal(badRef.code, 1);
    const badRefusal = refusalOf(badRef);
    assert.equal(badRefusal.code, "SEAT_REF_INVALID");
    assert.match(badRefusal.error, /Seat id must be a seat id in lowercase UUID form/);
    assert.doesNotMatch(badRefusal.error, /has no row in/);

    const noRow = await runCli(["--format", "json", "seats", "rename", SEAT_ABSENT, "x"], homeDir);
    assert.equal(noRow.code, 1);
    const noRowRefusal = refusalOf(noRow);
    assert.equal(noRowRefusal.code, "SEAT_ROW_MISSING");
    assert.match(noRowRefusal.error, /has no row in/);
    assert.doesNotMatch(noRowRefusal.error, /must be a seat id in lowercase UUID form/);

    assert.equal(await readStoreBytes(homeDir), bytes);
  });
});

test("RN8 · a VACANT seat (active_holder_id null) is renamed anyway — there is no holder to project onto", async () => {
  // 🛑 PRECONDITION IS **FIXTURE-ENTERED, AND HERE IS WHY** — PLAN.md's RN8 says this
  // state is reachable "by minting a row and retiring its holder", and that is WRONG:
  // corrected by the sub-HoD on the L0's measurement at `d50e5bf`, **NO PRODUCT PATH
  // PRODUCES `active_holder_id === null` at this commit**. There is no standalone
  // retire verb (`seats retire` / `sessions retire` do not exist); `mintSeatRow` sets
  // the founding holder and `activate` sets the successor, so the field is never
  // cleared by anything that ships.
  //
  // The row still earns its place: vacancy is a DOCUMENTED first-class state —
  // `seat-store.ts` calls `null` "vacant" — a non-error state, and `resolvePredecessorOrRefuse` branches on it — so
  // `rename` must handle it. The parse leg accepts an explicit `null` by design, which
  // is what lets the fixture enter the state honestly. The CLI still drives the rename
  // itself, so AC16's standard holds for the ACT; only the PRECONDITION is fixture-written.
  await withRig(async (homeDir) => {
    await writeStore(homeDir, {
      [SEAT_A]: seatRow(SEAT_A, { active_holder_id: null, name: "alpha" }),
    });

    const result = await runCli(
      ["--format", "json", "seats", "rename", SEAT_A, "vacant-renamed"],
      homeDir,
    );
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as { ok: boolean; activeHolderId: unknown };
    assert.equal(payload.ok, true);
    assert.equal(payload.activeHolderId, null, "vacancy is a first-class state, not an error");

    const after = await readStoreJson(homeDir);
    assert.equal(after[SEAT_A]?.name, "vacant-renamed");
    assert.equal(after[SEAT_A]?.active_holder_id, null, "vacancy must survive the rename");
  });
});

test("RN9 · a malformed store refuses at the write seam, with the unfaulted control arm", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });
    const control = await runCli(["seats", "rename", SEAT_A, "control-arm"], homeDir);
    assert.equal(control.code, 0, control.output);
    assert.equal((await readStoreJson(homeDir))[SEAT_A]?.name, "control-arm");

    await writeRawStore(homeDir, "[]");
    const bytes = await readStoreBytes(homeDir);
    const faulted = await runCli(["--format", "json", "seats", "rename", SEAT_A, "x"], homeDir);
    assert.equal(faulted.code, 1);
    const refusal = refusalOf(faulted);
    assert.equal(refusal.code, "SEAT_STORE_UNWRITABLE");
    assert.match(refusal.error, /refusing to write the seat store at/);
    assert.equal(await readStoreBytes(homeDir), bytes);
  });
});

test("RN11 · the B7b notice is GONE — text keeps its success line, json/quiet stay prose-free", async () => {
  // Ruling A's accepted cost used to be surfaced with a prose notice on every
  // text-format rename, because no reader read the seat yet. B7b made the acpx-ui
  // readers (rail, board, chat header, Fleet) read the seat, so the notice became a
  // falsehood and was deleted (brick 693ed2a9). This row now asserts the opposite
  // of what it used to: the notice must NOT reappear. The json half is unchanged —
  // `--format json` must never gain a prose line, whatever else moves.
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });

    const text = await runCli(["seats", "rename", SEAT_A, "noted"], homeDir);
    assert.equal(text.code, 0, text.output);
    assert.doesNotMatch(
      text.stdout,
      /note: the seat is the authority for its name/,
      "the notice was deleted once B7b made the acpx-ui readers read the seat — it must not come back",
    );
    // Presence control, not merely absence: an over-deletion that also stripped the
    // rename's own success line would otherwise pass the row above for the wrong
    // reason. This is what distinguishes "deleted the notice" from "deleted too much".
    assert.ok(
      text.stdout.includes(`seat ${SEAT_A}: name = ${JSON.stringify("noted")}`),
      `expected the rename's own success line in: ${text.stdout}`,
    );

    const json = await runCli(
      ["--format", "json", "seats", "rename", SEAT_A, "quiet-note"],
      homeDir,
    );
    assert.equal(json.code, 0, json.output);
    assert.doesNotMatch(json.stdout, /note: the seat is the authority/);
    // The strong form: the WHOLE of stdout must parse as one object. A prose line
    // anywhere in it — before, after or between — makes this throw. This also
    // doubles as the positive control that the CLI ran and produced real output.
    const parsed = JSON.parse(json.stdout.trim()) as { action: string };
    assert.equal(parsed.action, "seat_renamed");

    const quiet = await runCli(["--format", "quiet", "seats", "rename", SEAT_A, "silent"], homeDir);
    assert.equal(quiet.code, 0, quiet.output);
    assert.equal(quiet.stdout, "", "quiet is quiet");
  });
});

test("RN12 · `seats rename --help` no longer claims invisibility, but still explains the silent-no-op", async () => {
  // The same expiry hit the verb's own --help text (a third site, alongside the
  // text-format notice and the doc comment): it used to say the rename "WILL NOT
  // SEE IT YET" and was "invisible in those four surfaces". That claim is deleted.
  // The silent-no-op reasoning right beside it — writing the holder's record
  // instead would be a no-op — is still true and must survive.
  await withRig(async (homeDir) => {
    const help = await runCli(["seats", "rename", "--help"], homeDir);
    assert.equal(help.code, 0, help.output);
    assert.doesNotMatch(
      help.output,
      /WILL NOT SEE IT YET/,
      "the invisibility claim was deleted once B7b made the acpx-ui readers read the seat",
    );
    assert.doesNotMatch(help.output, /invisible in those four surfaces/);
    // Presence control: the still-true silent-no-op reasoning must remain, so a
    // blunt over-deletion of the whole help block fails this row too.
    assert.match(
      help.output,
      /SILENT NO-OP/,
      `expected the silent-no-op reasoning to survive in: ${help.output}`,
    );
  });
});

// ═══ Group FV — `seats favorite` (B2e, Daniel's D-STAR ruling) ════════════════
//
// The star belongs to the seat, not the session (D-STAR, 2026-09-30). This verb
// writes the SEAT ROW ONLY, under the index lock, through the one writer —
// `rename`'s single-hold shape, since a star has no holder state to vet either.

test("FV1 · --on sets favorite:true; --off clears it; closed_at present and null; other fields byte-identical", async () => {
  await withRig(async (homeDir) => {
    const before = {
      [SEAT_A]: seatRow(SEAT_A, { name: "alpha" }),
      [SEAT_B]: seatRow(SEAT_B),
    };
    await writeStore(homeDir, before);

    const on = await runCli(["seats", "favorite", SEAT_A, "--on"], homeDir);
    assert.equal(on.code, 0, on.output);
    const afterOn = await readStoreJson(homeDir);
    assert.equal(afterOn[SEAT_A]?.favorite, true);
    assert.ok(Object.hasOwn(afterOn[SEAT_A] as object, "closed_at"));
    assert.equal(afterOn[SEAT_A]?.closed_at, null);
    assert.deepEqual(
      { ...afterOn[SEAT_A], favorite: undefined },
      { ...before[SEAT_A], favorite: undefined },
    );
    assert.deepEqual(afterOn[SEAT_B], before[SEAT_B], "an unrelated seat is untouched");

    const off = await runCli(["seats", "favorite", SEAT_A, "--off"], homeDir);
    assert.equal(off.code, 0, off.output);
    const afterOff = await readStoreJson(homeDir);
    assert.equal(afterOff[SEAT_A]?.favorite, false);
  });
});

test("FV2 · IDEMPOTENT — setting the value a seat already holds is a no-op and rewrites NOTHING", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { favorite: false }) });

    const first = await runCli(["--format", "json", "seats", "favorite", SEAT_A, "--off"], homeDir);
    assert.equal(first.code, 0, first.output);
    const payload = JSON.parse(first.stdout.trim()) as { changed: boolean; favorite: boolean };
    assert.equal(payload.changed, false);
    assert.equal(payload.favorite, false);

    const bytes = await readStoreBytes(homeDir);
    const second = await runCli(["seats", "favorite", SEAT_A, "--off"], homeDir);
    assert.equal(second.code, 0, second.output);
    assert.equal(
      await readStoreBytes(homeDir),
      bytes,
      "a no-change mutation must not rewrite the store at all",
    );
  });
});

test("FV3 · exactly one of --on/--off is required — neither or both is refused, and nothing is written", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });
    const bytes = await readStoreBytes(homeDir);

    const neither = await runCli(["--format", "json", "seats", "favorite", SEAT_A], homeDir);
    assert.equal(neither.code, 1);
    assert.equal(refusalOf(neither).code, "SEAT_FAVORITE_FLAG_INVALID");

    const both = await runCli(
      ["--format", "json", "seats", "favorite", SEAT_A, "--on", "--off"],
      homeDir,
    );
    assert.equal(both.code, 1);
    assert.equal(refusalOf(both).code, "SEAT_FAVORITE_FLAG_INVALID");

    assert.equal(await readStoreBytes(homeDir), bytes, "a refused flag combination must not write");
  });
});

test("FV4 · the two refusals are distinguishable, and neither writes — mirrors RN6/RN7′", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });
    const bytes = await readStoreBytes(homeDir);

    const badRef = await runCli(
      ["--format", "json", "seats", "favorite", "not-a-uuid", "--on"],
      homeDir,
    );
    assert.equal(badRef.code, 1);
    assert.equal(refusalOf(badRef).code, "SEAT_REF_INVALID");

    const noRow = await runCli(
      ["--format", "json", "seats", "favorite", SEAT_ABSENT, "--on"],
      homeDir,
    );
    assert.equal(noRow.code, 1);
    assert.equal(refusalOf(noRow).code, "SEAT_ROW_MISSING");

    assert.equal(await readStoreBytes(homeDir), bytes);
  });
});

test("FV5 · a malformed store refuses at the write seam, with the unfaulted control arm", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });
    const control = await runCli(["seats", "favorite", SEAT_A, "--on"], homeDir);
    assert.equal(control.code, 0, control.output);
    assert.equal((await readStoreJson(homeDir))[SEAT_A]?.favorite, true);

    await writeRawStore(homeDir, "[]");
    const bytes = await readStoreBytes(homeDir);
    const faulted = await runCli(
      ["--format", "json", "seats", "favorite", SEAT_A, "--off"],
      homeDir,
    );
    assert.equal(faulted.code, 1);
    assert.equal(refusalOf(faulted).code, "SEAT_STORE_UNWRITABLE");
    assert.equal(await readStoreBytes(homeDir), bytes);
  });
});

test("FV6 · a seat row written before `favorite` existed (no key on disk) starts un-starred, and --on stars it", async () => {
  await withRig(async (homeDir) => {
    // `favorite: undefined` is dropped by JSON.stringify — the shape of every seat
    // on the fleet before this block's migration runs.
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { favorite: undefined }) });
    assert.ok(!Object.hasOwn((await readStoreJson(homeDir))[SEAT_A] as object, "favorite"));

    const result = await runCli(["--format", "json", "seats", "favorite", SEAT_A, "--on"], homeDir);
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as { changed: boolean; favorite: boolean };
    assert.equal(payload.changed, true, "absence must read as false, so --on is a real change");
    assert.equal((await readStoreJson(homeDir))[SEAT_A]?.favorite, true);
  });
});

// ═══ Group D — `seats delete` ═════════════════════════════════════════════════

test("D1 · the row is gone and every other row is byte-identical", async () => {
  await withRig(async (homeDir) => {
    const before = {
      [SEAT_A]: seatRow(SEAT_A),
      [SEAT_B]: seatRow(SEAT_B, { name: "keep-me" }),
      [SEAT_C]: seatRow(SEAT_C),
    };
    await writeStore(homeDir, before);

    const result = await runCli(["seats", "delete", SEAT_A], homeDir);
    assert.equal(result.code, 0, result.output);

    const after = await readStoreJson(homeDir);
    assert.equal(after[SEAT_A], undefined);
    assert.deepEqual(after[SEAT_B], before[SEAT_B]);
    assert.deepEqual(after[SEAT_C], before[SEAT_C]);
  });
});

test("D2 · an absent row is a NO-OP at rc 0 — the store is untouched, and an absent store is NOT created", async () => {
  await withRig(async (homeDir) => {
    // (a) existing store, absent row: byte-identical afterwards.
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });
    const bytes = await readStoreBytes(homeDir);
    const noop = await runCli(["--format", "json", "seats", "delete", SEAT_ABSENT], homeDir);
    assert.equal(noop.code, 0, noop.output);
    const payload = JSON.parse(noop.stdout.trim()) as { absent: string[]; storeWritten: boolean };
    assert.deepEqual(payload.absent, [SEAT_ABSENT]);
    assert.equal(payload.storeWritten, false);
    assert.equal(await readStoreBytes(homeDir), bytes);
  });

  await withRig(async (homeDir) => {
    // (b) 🔑 ABSENT STORE: the file must NOT be created. This is what asserts
    // SEAT_STORE_NO_CHANGE is actually used — writing an unchanged store would
    // create the file and pass a naive "no rows changed" check.
    await fs.rm(storePath(homeDir), { force: true });
    assert.equal(await storeExists(homeDir), false, "fixture precondition: no store");

    const result = await runCli(["seats", "delete", SEAT_ABSENT], homeDir);
    assert.equal(result.code, 0, result.output);
    assert.equal(
      await storeExists(homeDir),
      false,
      "a sweep that finds nothing must not MINT a seat store on a box that has none",
    );
  });
});

test("D3 · a malformed seat ref is a REFUSAL, and it cannot be confused with D2's no-op", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });
    const bytes = await readStoreBytes(homeDir);

    const result = await runCli(["--format", "json", "seats", "delete", "not-a-uuid"], homeDir);
    assert.equal(result.code, 1, "a malformed ref is the caller's mistake, not a steady state");
    const refusal = refusalOf(result);
    assert.equal(refusal.code, "SEAT_REF_INVALID");
    assert.match(refusal.error, /Seat id must be a seat id in lowercase UUID form/);
    assert.equal(await readStoreBytes(homeDir), bytes);

    // F4 — the two outcomes must be distinguishable, not merely differently worded:
    // an absent row exits 0 with `ok: true`, a malformed ref exits 1 with `ok: false`.
    const noop = await runCli(["--format", "json", "seats", "delete", SEAT_ABSENT], homeDir);
    assert.equal(noop.code, 0);
    assert.equal((JSON.parse(noop.stdout.trim()) as { ok: boolean }).ok, true);
  });
});

test("D4 · DELETE DOES NOT CLOSE — no row anywhere gains a closed_at, and the checker proves it can see one", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A), [SEAT_B]: seatRow(SEAT_B) });

    const result = await runCli(["seats", "delete", SEAT_A], homeDir);
    assert.equal(result.code, 0, result.output);

    const after = await readStoreJson(homeDir);
    assert.equal(after[SEAT_A], undefined, "the row is ABSENT — delete removes it");
    const stamped = Object.values(after).filter((row) => row.closed_at !== null);
    assert.deepEqual(
      stamped,
      [],
      "a writer that implemented delete as a `closed_at` stamp destroys the only thing " +
        "closed_at records (ratification item 2)",
    );

    // THE COMMITTED NEGATIVE CASE, in place of implementing delete as a stamp and
    // showing red: present the same filter a stamped row and require it to be seen.
    const withStamp = {
      ...after,
      [SEAT_C]: seatRow(SEAT_C, { closed_at: "2026-09-29T00:00:00Z" }),
    };
    assert.equal(
      Object.values(withStamp).filter((row) => row.closed_at !== null).length,
      1,
      "if this filter cannot see a stamped row, D4's zero means nothing",
    );

    // ⚠️ AND NOTE WHAT THIS ROW DOES NOT CLAIM. It asserts closing does NOT happen.
    // Nothing in B2b claims a seat can be CLOSED — that verb is B2c's, and the
    // standing clause forbidding such a claim is discharged honestly here.
  });
});

test("D5b · a REPEATED id is reported once — the count must match the rows actually removed", async () => {
  // Found by the independent test-engineer against the real binary: `delete <A> <A>`
  // reported `deleted: [A, A]` for ONE row removed. The store was always correct —
  // every lookup runs against the unmutated store read at the top of the hold, so the
  // second occurrence merely re-read as present — but the payload over-reported, and
  // the sweep's wiring may log that number.
  //
  // 🔑 THE ROW ASSERTS THE COUNT, NOT JUST THE END STATE, because the end state was
  // never wrong: a row that only checked the store would have passed throughout the
  // defect. That is the same shape as the suite-tally lesson on this block — assert
  // the count, not only the outcome.
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A), [SEAT_B]: seatRow(SEAT_B) });

    const result = await runCli(
      ["--format", "json", "seats", "delete", SEAT_A, SEAT_A, SEAT_B],
      homeDir,
    );
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      deleted: string[];
      absent: string[];
      malformed: string[];
    };
    assert.deepEqual(payload.deleted, [SEAT_A, SEAT_B], "each id reported ONCE, in caller order");
    assert.deepEqual(payload.absent, [], "a duplicate must not re-read as absent either");
    assert.deepEqual(payload.malformed, []);
    assert.deepEqual(Object.keys(await readStoreJson(homeDir)), [], "the store was always correct");
  });

  // The paired arm for a repeated ABSENT id: de-duplication must not turn a no-op into
  // a deletion, nor report the same missing seat twice.
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });
    const result = await runCli(
      ["--format", "json", "seats", "delete", SEAT_ABSENT, SEAT_ABSENT],
      homeDir,
    );
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      deleted: string[];
      absent: string[];
      storeWritten: boolean;
    };
    assert.deepEqual(payload.absent, [SEAT_ABSENT]);
    assert.deepEqual(payload.deleted, []);
    assert.equal(payload.storeWritten, false);
  });
});

test("D5 · N ids in ONE invocation — every row gone", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, {
      [SEAT_A]: seatRow(SEAT_A),
      [SEAT_B]: seatRow(SEAT_B),
      [SEAT_C]: seatRow(SEAT_C),
    });

    const result = await runCli(["--format", "json", "seats", "delete", SEAT_A, SEAT_B], homeDir);
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as { deleted: string[] };
    assert.deepEqual(payload.deleted, [SEAT_A, SEAT_B]);

    const after = await readStoreJson(homeDir);
    assert.deepEqual(Object.keys(after), [SEAT_C]);
  });
});

test("D6 · a MIXED batch — present ids deleted, absent ids no-op'd, rc 0", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A), [SEAT_B]: seatRow(SEAT_B) });

    const result = await runCli(
      ["--format", "json", "seats", "delete", SEAT_A, SEAT_ABSENT, SEAT_B],
      homeDir,
    );
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      deleted: string[];
      absent: string[];
      storeWritten: boolean;
    };
    assert.deepEqual(payload.deleted, [SEAT_A, SEAT_B]);
    assert.deepEqual(payload.absent, [SEAT_ABSENT]);
    assert.equal(payload.storeWritten, true);
    assert.deepEqual(Object.keys(await readStoreJson(homeDir)), []);
  });
});

test("D7 · a MALFORMED ROW survives the delete VERBATIM", async () => {
  await withRig(async (homeDir) => {
    // `next_ordinal: 0` is unreadable by the parse leg (the counter starts at 1), so
    // this row lands in `unparsedRows` — carried, never repaired.
    const malformed = { seat_id: SEAT_B, created_at: "x", next_ordinal: 0 };
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A), [SEAT_B]: malformed });

    const result = await runCli(["seats", "delete", SEAT_A], homeDir);
    assert.equal(result.code, 0, result.output);

    const after = await readStoreJson(homeDir);
    assert.equal(after[SEAT_A], undefined, "the target is deleted");
    // 🔑 SELF-FALSIFYING, AND THAT IS WHY NOTHING IS APPENDED BELOW IT. A writer that
    // built its next state from `store.seats` alone would drop the malformed row, so
    // `after[SEAT_B]` would be `undefined` and this comparison would fail. The row
    // therefore goes red WHEN THE POLICY IS REMOVED, permanently, by construction.
    //
    // ⚠️ An appended "negative case" USED TO SIT HERE and was DELETED as a tautology:
    // it copied `after`, `delete`d the key, and asserted the key was `undefined` —
    // which is true by the semantics of `delete` and could not fail for any product
    // reason. The replacement proposed for it (`notDeepEqual` against the same copy)
    // is the same tautology one operator over: comparing `undefined` to a literal
    // object is a fact about JavaScript, not about this codebase. The rule that
    // settles it — DOES THE PRODUCT APPEAR IN THE ASSERTION? — says delete, not repair.
    assert.deepEqual(
      after[SEAT_B],
      malformed,
      "the malformed row must be re-emitted VERBATIM — a mutator naturally builds its next " +
        "state from `seats`, which by definition excludes it (seat-store.ts:210-218)",
    );
  });
});

test("D8r · a malformed STORE refuses at the write seam, with the unfaulted control arm", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A), [SEAT_B]: seatRow(SEAT_B) });
    const control = await runCli(["seats", "delete", SEAT_A], homeDir);
    assert.equal(control.code, 0, control.output);
    assert.equal((await readStoreJson(homeDir))[SEAT_A], undefined, "control arm: a real delete");

    await writeRawStore(homeDir, "not json at all");
    const bytes = await readStoreBytes(homeDir);
    const faulted = await runCli(["--format", "json", "seats", "delete", SEAT_B], homeDir);
    assert.equal(faulted.code, 1);
    const refusal = refusalOf(faulted);
    assert.equal(refusal.code, "SEAT_STORE_UNWRITABLE");
    assert.match(refusal.error, /refusing to write the seat store at/);
    assert.notEqual(refusal.code, "SEAT_ROW_MISSING", "F1: corrupt must never read as absent");
    assert.equal(await readStoreBytes(homeDir), bytes);
  });
});

test("D9r · a seat whose OWN row is malformed is REFUSED and NAMED — the plan did not cover this row", async () => {
  // ⚠️ NOT IN PLAN.md's ROW LIST. Raised by the implementation, escalated, and
  // ratified by the sub-HoD on 2026-09-29: the store's discipline is "carried and
  // visible, NEVER repaired", and `withSeatStoreWrite` re-emits unparsed rows
  // unconditionally as a data-loss defence — so an unreadable row cannot be removed
  // without reaching around the one writer, which is forbidden. It refuses instead.
  //
  // F4 — THE REFUSED STATE IS ENTERED by writing a store whose TARGET row does not
  // parse (`next_ordinal: 0`; the counter starts at 1, so the parse leg rejects it).
  await withRig(async (homeDir) => {
    const malformed = { seat_id: SEAT_A, created_at: "x", next_ordinal: 0 };
    await writeStore(homeDir, { [SEAT_A]: malformed, [SEAT_B]: seatRow(SEAT_B) });

    // AP15 — THE PAIRED LEGITIMATE ARM, IN THE SAME STORE AND THE SAME RUN: a corrupt
    // row must not veto unrelated work, so the healthy id is deleted and WRITTEN.
    const result = await runCli(["--format", "json", "seats", "delete", SEAT_A, SEAT_B], homeDir);
    assert.equal(result.code, 1, "a partial run must never read as a clean one");
    const payload = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      code: string;
      error: string;
      deleted: string[];
      absent: string[];
      malformed: string[];
      storeWritten: boolean;
    };
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "SEAT_ROW_MALFORMED");
    assert.deepEqual(payload.deleted, [SEAT_B], "the healthy row IS deleted in the same run");
    assert.deepEqual(payload.malformed, [SEAT_A]);
    assert.deepEqual(payload.absent, []);
    assert.equal(payload.storeWritten, true);

    const after = await readStoreJson(homeDir);
    assert.equal(after[SEAT_B], undefined, "the good deletion reached disk");
    assert.deepEqual(after[SEAT_A], malformed, "the malformed row survives VERBATIM");

    // THE REMEDY, not just the condition — the standard `seatStoreUnhealthyMessage`
    // sets. A refusal that names a condition and stops is one step from a refusal
    // that prescribes the wrong repair (F1).
    assert.match(payload.error, /QUARANTINE a copy/);
    assert.match(payload.error, /corrupt-<timestamp>/);
    assert.match(payload.error, /Only the named row is corrupt/);
    assert.match(payload.error, new RegExp(SEAT_A), "the refusal must name WHICH seat");
  });
});

test("D9r · MALFORMED and MISSING are distinguishable in BOTH directions", async () => {
  // 🔑 THE AP13 CONTROL FOR THIS PAIR. Two refusals that both mean "this row is not
  // usable" are green whichever fired if their messages share a marker. Each is
  // required to carry its own marker AND to lack the other's — checked both ways,
  // because one direction alone cannot see a subsuming message.
  await withRig(async (homeDir) => {
    const malformed = { seat_id: SEAT_A, created_at: "x", next_ordinal: 0 };
    await writeStore(homeDir, { [SEAT_A]: malformed });

    const malformedRun = await runCli(["--format", "json", "seats", "delete", SEAT_A], homeDir);
    const malformedError = (JSON.parse(malformedRun.stdout.trim()) as { error: string }).error;
    // `set-brick` is used for the MISSING arm because `delete` treats an absent row as
    // a no-op by design — the two verbs are where each condition is refusable.
    const missingRun = await runCli(
      ["--format", "json", "seats", "set-brick", SEAT_ABSENT, BRICK_ID],
      homeDir,
    );
    const missingError = refusalOf(missingRun).error;

    assert.match(malformedError, /its row is MALFORMED/);
    assert.doesNotMatch(malformedError, /has no row in/);
    assert.match(missingError, /has no row in/);
    assert.doesNotMatch(missingError, /QUARANTINE/);
    assert.doesNotMatch(
      missingError,
      /its row is MALFORMED/,
      "F1: an absent row must never be described as a corrupt one, or vice versa",
    );
  });
});

test("D9r · the variadic mix — good deleted, absent no-op'd, malformed refused, in ONE invocation", async () => {
  await withRig(async (homeDir) => {
    const malformed = { seat_id: SEAT_C, created_at: "x", next_ordinal: 0 };
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A), [SEAT_C]: malformed });

    const result = await runCli(
      ["--format", "json", "seats", "delete", SEAT_A, SEAT_C, SEAT_ABSENT],
      homeDir,
    );
    assert.equal(result.code, 1);
    const payload = JSON.parse(result.stdout.trim()) as {
      deleted: string[];
      absent: string[];
      malformed: string[];
    };
    assert.deepEqual(payload.deleted, [SEAT_A]);
    assert.deepEqual(payload.malformed, [SEAT_C]);
    assert.deepEqual(payload.absent, [SEAT_ABSENT]);

    // IDEMPOTENT RETRY — the property that makes a non-zero rc safe on a partial run:
    // a caller that ignores the report and re-runs the whole batch is correct.
    const retry = await runCli(
      ["--format", "json", "seats", "delete", SEAT_A, SEAT_C, SEAT_ABSENT],
      homeDir,
    );
    const retried = JSON.parse(retry.stdout.trim()) as {
      deleted: string[];
      absent: string[];
      malformed: string[];
      storeWritten: boolean;
    };
    assert.deepEqual(retried.deleted, [], "the already-deleted id is now simply absent");
    assert.deepEqual(retried.absent, [SEAT_A, SEAT_ABSENT]);
    assert.deepEqual(retried.malformed, [SEAT_C], "the corrupt row still refuses, still named");
    assert.equal(retried.storeWritten, false, "a retry that deletes nothing writes nothing");
  });
});

// ═══ Group CL — `seats close` (B2c, brick 4a17c8b5) ══════════════════════════
//
// AC16 + B2c PLAN.md §2-§3. `close` is the writer of `closed_at` — the one ratified
// seat field B2b shipped with no write path (PLAN.md §0 F-B2c-1).

test("CL1 · a VACANT seat closes; closed_at is a FRESH clock read, postdating a read taken before the call; every field survives", async () => {
  await withRig(async (homeDir) => {
    // FIXTURE-ENTERED, structurally, same reason RN8 states for the identical shape:
    // no product path clears `active_holder_id` back to null, so a vacant seat can
    // only be REACHED in this rig by planting the row directly.
    await writeStore(homeDir, {
      [SEAT_A]: seatRow(SEAT_A, { active_holder_id: null, name: "alpha", brick_id: BRICK_ID }),
    });
    const before = Date.now();

    const result = await runCli(["--format", "json", "seats", "close", SEAT_A], homeDir);
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      action: string;
      closedAt: string;
      changed: boolean;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.action, "seat_closed");
    assert.equal(payload.changed, true);

    const after = await readStoreJson(homeDir);
    const row = after[SEAT_A] as Record<string, unknown>;
    // THE CLOCK IS THE PRODUCT'S — read off DISK, never the CLI's own echo alone —
    // and it postdates a timestamp taken BEFORE the command ran.
    const closedAtMs = Date.parse(row.closed_at as string);
    assert.ok(
      Number.isFinite(closedAtMs),
      `closed_at is not a valid ISO instant: ${String(row.closed_at)}`,
    );
    assert.ok(
      closedAtMs >= before,
      "closed_at does not postdate a clock read taken before the call",
    );
    assert.equal(row.closed_at, payload.closedAt, "the JSON echo must match what landed on disk");

    // EVERY FIELD SURVIVES — `close` touches closed_at and nothing else.
    assert.equal(row.seat_id, SEAT_A);
    assert.equal(row.active_holder_id, null);
    assert.equal(row.name, "alpha");
    assert.equal(row.brick_id, BRICK_ID);
    assert.ok(Object.hasOwn(row, "next_ordinal"));
  });
});

test("CL2 · IDEMPOTENT — a second close is a no-op, rc 0, and the timestamp does NOT move", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { active_holder_id: null }) });

    const first = await runCli(["--format", "json", "seats", "close", SEAT_A], homeDir);
    assert.equal(first.code, 0, first.output);
    const firstClosedAt = (await readStoreJson(homeDir))[SEAT_A]?.closed_at;
    assert.ok(typeof firstClosedAt === "string");

    const second = await runCli(["--format", "json", "seats", "close", SEAT_A], homeDir);
    assert.equal(second.code, 0, "a second close on an already-closed seat must NOT be an error");
    const payload = JSON.parse(second.stdout.trim()) as {
      ok: boolean;
      action: string;
      changed: boolean;
      closedAt: string;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.action, "seat_close_no_change");
    assert.equal(payload.changed, false, "a no-op must say so in its own payload");
    assert.equal(payload.closedAt, firstClosedAt, "the timestamp must NOT move on a second close");
    assert.equal(
      (await readStoreJson(homeDir))[SEAT_A]?.closed_at,
      firstClosedAt,
      "read off DISK: the second close must not have re-stamped the field",
    );
  });
});

test("CL3 · there is NO --at / timestamp argument — a caller-supplied close time is UNREPRESENTABLE", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { active_holder_id: null }) });
    const result = await runCli(
      ["seats", "close", SEAT_A, "--at", "2020-01-01T00:00:00.000Z"],
      homeDir,
    );
    assert.notEqual(
      result.code,
      0,
      "an unrecognised --at flag must be refused, not silently accepted",
    );
    assert.match(result.output, /unknown option/i);
    assert.equal(
      (await readStoreJson(homeDir))[SEAT_A]?.closed_at,
      null,
      "the seat must be untouched — commander's own refusal must fire before any write",
    );
  });
});

test("CL4 · R1 — refuses SEAT_HOLDER_OPEN while the active holder is open, and closes once it is closed (AP15 pair)", async () => {
  await withRig(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];

    const founding = await runCli([...base, "sessions", "new", "-s", "cl4-holder"], homeDir);
    assert.equal(founding.code, 0, founding.stderr);
    const holderId = (JSON.parse(founding.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId;
    assert.ok(holderId, `fixture precondition — ${founding.stdout}`);
    const holderRecord = JSON.parse(
      await fs.readFile(path.join(homeDir, ".acpx", "sessions", `${holderId}.json`), "utf8"),
    ) as { seat_id?: string };
    const seatId = holderRecord.seat_id;
    assert.ok(seatId, "fixture precondition: the founding holder carries a seat id");

    // F4 — THE REFUSED STATE IS ENTERED: a real, open holder is the seat's active
    // holder (that is exactly what `sessions new` without `--seat` leaves behind).
    const refused = await runCli(["--format", "json", "seats", "close", seatId], homeDir);
    assert.equal(refused.code, 1, refused.output);
    const refusal = refusalOf(refused);
    assert.equal(refusal.code, "SEAT_HOLDER_OPEN");
    assert.match(refusal.error, new RegExp(holderId));
    assert.match(refusal.error, /sessions close/);
    assert.equal(
      (await readStoreJson(homeDir))[seatId]?.closed_at,
      null,
      "a refused close must not have written anything",
    );

    // AP15 — THE PAIRED LEGITIMATE CASE, IN THE SAME RUN: close the holder, and the
    // SAME seat now closes.
    // `--session-id`, NOT the positional arg — the positional `[name]` on `sessions
    // close` resolves by SESSION NAME, not by record id (`session-selector.ts`:
    // `resolveSelectorName` feeds it through `normalizeName` as a name; only
    // `--session-id`/`--session-url` reach `resolveExplicitSessionRecord`).
    const closedHolder = await runCli(
      ["--format", "json", "sessions", "close", "--session-id", holderId],
      homeDir,
    );
    assert.equal(closedHolder.code, 0, closedHolder.stderr);
    const allowed = await runCli(["--format", "json", "seats", "close", seatId], homeDir);
    assert.equal(
      allowed.code,
      0,
      `AP15: close was refused even after the holder was closed — ${allowed.output}`,
    );
    assert.equal((await readStoreJson(homeDir))[seatId]?.closed_at !== null, true);
  });
});

test("CL4 message · seatHolderOpenMessage (the PRODUCT's own builder) names the seat, the holder, and the --session-id remedy", () => {
  // 🛑 CORRECTED (independent TE finding F1, 2026-09-29). This block used to be
  // named "CL4 control" and asserted two regexes against a HAND-WRITTEN literal
  // string that imported no product module at all. Proven vacuous by the TE:
  // copied verbatim into a standalone file with no product import, it still
  // passed — it tested the test. Worse than inert: named "control", it read as
  // discharging §3a-bis for CL4 while examining a paraphrase, never the product's
  // own message.
  //
  // §3a-bis's control-ARM requirement never attached to CL4 in the first place —
  // CL4 is PRODUCT-ENTERED (a real open holder, closed for real via the CLI), not
  // fault-injected, so there is no fault arm here that needs an unfaulted
  // counterpart. What replaces it is a real assertion, against the exported
  // `seatHolderOpenMessage` (product code, not a copy), that the message actually
  // carries what an operator needs to act on the refusal.
  const message = seatHolderOpenMessage(
    "11111111-1111-4111-8111-111111111111",
    "aaaaaaaa-0000-4000-8000-000000000000",
  );
  assert.match(message, /11111111-1111-4111-8111-111111111111/, "the message must name the SEAT");
  assert.match(message, /aaaaaaaa-0000-4000-8000-000000000000/, "the message must name the HOLDER");
  assert.match(
    message,
    /--session-id/,
    "the remedy must use --session-id — the positional form resolves by NAME, not record id",
  );
});

test("CL5 · decideSeatClose — the pure CAS decision, all four branches, width stated (R2)", () => {
  // 🔑 EXPORTED FOR ONE REASON (same precedent `buildSeatDeletion` sets):
  // SEAT_HOLDER_CHANGED's refused state needs an interleaving no single-process CLI
  // row can enter deterministically, and a two-process race is a flaky test, not a
  // test. So this row calls the PRODUCT's own decision function directly — the
  // product appears in every branch below, executes, and discriminates on `kind`.
  //
  // WIDTH, STATED HONESTLY: the concurrent interleaving itself is not entered
  // end-to-end here; the function that GOVERNS it is exercised directly. A row that
  // claimed to enter the race itself would be the worse, dishonest artifact.
  const row: SeatRecord = {
    seatId: SEAT_A,
    createdAt: "2026-09-29T00:00:00.000Z",
    activeHolderId: "holder-1",
    nextOrdinal: 2,
    closedAt: null,
    name: undefined,
    brickId: undefined,
    favorite: false,
  };

  // Branch 1 — already closed.
  assert.deepEqual(
    decideSeatClose(
      { ...row, closedAt: "2026-09-28T00:00:00.000Z" },
      { id: "holder-1", open: false },
    ),
    { kind: "already-closed" },
  );

  // Branch 2 — R2: the vetted holder is no longer the current one.
  assert.deepEqual(decideSeatClose(row, { id: "holder-DIFFERENT", open: false }), {
    kind: "holder-changed",
  });
  // AC16 (ii): a null vetted holder against a row that has since gained one is ALSO
  // a holder-changed — the same branch, entered from the vacant side.
  assert.deepEqual(decideSeatClose(row, { id: null, open: false }), { kind: "holder-changed" });

  // Branch 3 — R1: the (still-current) vetted holder was open.
  assert.deepEqual(decideSeatClose(row, { id: "holder-1", open: true }), { kind: "holder-open" });

  // Branch 4 — the unchanged, not-open path closes. AC16 (i)'s second half and (ii)'s
  // first half, both reached here: a real holder that is now closed, and vacancy.
  assert.deepEqual(decideSeatClose(row, { id: "holder-1", open: false }), { kind: "close" });
  assert.deepEqual(decideSeatClose({ ...row, activeHolderId: null }, { id: null, open: false }), {
    kind: "close",
  });
});

test("CL6 · a DANGLING active_holder_id (record unresolvable) still closes — refusing would leave no remedy", async () => {
  // FIXTURE-ENTERED, structurally: `active_holder_id` naming a session record that
  // was never minted or has since been removed is a real-world event (hand
  // intervention, an external purge) that no verb in this product produces — the
  // same class of reason RN8/SB5 state for their own fixtures.
  await withRig(async (homeDir) => {
    const danglingId = "dddddddd-0000-4000-8000-dddddddddddd";
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { active_holder_id: danglingId }) });

    const result = await runCli(["--format", "json", "seats", "close", SEAT_A], homeDir);
    assert.equal(
      result.code,
      0,
      `a dangling holder pointer must still close — refusing leaves no remedy an operator can act on: ${result.output}`,
    );
    const payload = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      holderUnresolvable?: string;
    };
    assert.equal(payload.ok, true);
    assert.equal(
      payload.holderUnresolvable,
      danglingId,
      "the payload must say WHICH holder could not be resolved",
    );
    assert.equal((await readStoreJson(homeDir))[SEAT_A]?.closed_at !== null, true);
  });
});

test("CL7 · store health: MALFORMED/UNREADABLE refuses SEAT_STORE_UNWRITABLE, never SEAT_ROW_MISSING — unfaulted control arm", async () => {
  await withRig(async (homeDir) => {
    // §3a-bis control arm FIRST.
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { active_holder_id: null }) });
    const control = await runCli(["--format", "json", "seats", "close", SEAT_A], homeDir);
    assert.equal(control.code, 0, control.output);

    await writeRawStore(homeDir, "{ not json at all");
    const bytes = await readStoreBytes(homeDir);
    const faulted = await runCli(["--format", "json", "seats", "close", SEAT_B], homeDir);
    assert.equal(faulted.code, 1);
    const refusal = refusalOf(faulted);
    assert.equal(refusal.code, "SEAT_STORE_UNWRITABLE");
    assert.match(refusal.error, /refusing to write the seat store at/);
    assert.notEqual(refusal.code, "SEAT_ROW_MISSING", "F1: corrupt must never read as absent");
    assert.equal(await readStoreBytes(homeDir), bytes, "the corrupt file must be left untouched");
  });
});

test("CL8 · close on an ABSENT row refuses SEAT_ROW_MISSING with AP17's cause and remedy", async () => {
  await withRig(async (homeDir) => {
    // `withRig` only mkdirs the sessions DIRECTORY — no `seats.json` is written
    // here, so this is ALSO close on an absent STORE (F6, independent TE finding,
    // part B: "close on an absent store must not create the file").
    assert.equal(await storeExists(homeDir), false, "fixture precondition: no store file yet");
    const result = await runCli(["--format", "json", "seats", "close", SEAT_ABSENT], homeDir);
    assert.equal(result.code, 1);
    const refusal = refusalOf(result);
    assert.equal(refusal.code, "SEAT_ROW_MISSING");
    // No record carries SEAT_ABSENT, so the cause is a mistyped id and the remedy is to
    // check it — NOT the backfill (brick `bf454a2c`; the backfillable pair is in
    // `seat-store-refusals.test.ts`).
    assert.match(
      refusal.error,
      /no readable session record in \S+ carries that seat id/i,
      "the refusal does not name the cause",
    );
    assert.match(refusal.error, /acpx seats list/, "the refusal does not name the remedy");
    assert.equal(
      await storeExists(homeDir),
      false,
      "a refused close on an absent store must NOT create the file",
    );
  });
});

test("CL9 · close on a MALFORMED row refuses SEAT_ROW_MALFORMED; the row survives VERBATIM (never becomes the write that deletes it)", async () => {
  await withRig(async (homeDir) => {
    const malformed = { seat_id: SEAT_A, created_at: "x", next_ordinal: 0 };
    await writeStore(homeDir, { [SEAT_A]: malformed });

    const result = await runCli(["--format", "json", "seats", "close", SEAT_A], homeDir);
    assert.equal(result.code, 1);
    const refusal = refusalOf(result);
    assert.equal(refusal.code, "SEAT_ROW_MALFORMED");

    const after = await readStoreJson(homeDir);
    assert.deepEqual(
      after[SEAT_A],
      malformed,
      "close must not become the write that silently deletes an unreadable row",
    );
  });
});

// ═══ Group CLB — the three B2b verbs on a CLOSED seat (B2c PLAN.md §1) ════════
//
// All three SUCCEED — sub-HoD ruling, PLAN.md §1: close KEEPS the row precisely so
// it stays correctable/attributable after abolition. Each row also asserts
// closed_at is BYTE-UNCHANGED — the standing guard that the `{...row, field}`
// spread never drops or moves the key, one field over from D8's malformed-row trap.

test("CLB1 · `set-brick` on a CLOSED seat SUCCEEDS; closed_at is byte-unchanged — PRODUCT-ENTERED", async () => {
  // 🛑 PRODUCT-ENTERED (independent TE finding F3, 2026-09-29). This row used to
  // fixture `closed_at` directly with NO stated reason — the defect half of the
  // fixture-disclosure rule PLAN §3.1 demands, since the shipped `acpx seats
  // close` verb can produce this exact state. Reached here through the real
  // verb, same pattern RN2' sets for a real seat+holder. CLB2 and CLB3 are
  // ANCHORED to this row rather than repeating the mint+close sequence — see
  // their own comments for the cost/control reason.
  await withRig(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];

    const founding = await runCli([...base, "sessions", "new", "-s", "clb1-holder"], homeDir);
    assert.equal(founding.code, 0, founding.stderr);
    const holderId = (JSON.parse(founding.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId;
    assert.ok(holderId, `fixture precondition — ${founding.stdout}`);
    const seatId = (
      JSON.parse(
        await fs.readFile(path.join(homeDir, ".acpx", "sessions", `${holderId}.json`), "utf8"),
      ) as { seat_id?: string }
    ).seat_id;
    assert.ok(seatId, "fixture precondition: the founding holder carries a seat id");

    const closedHolder = await runCli(
      [...base, "sessions", "close", "--session-id", holderId],
      homeDir,
    );
    assert.equal(closedHolder.code, 0, closedHolder.stderr);
    const closedSeat = await runCli([...base, "seats", "close", seatId], homeDir);
    assert.equal(
      closedSeat.code,
      0,
      `fixture precondition: the real close must succeed — ${closedSeat.stdout}${closedSeat.stderr}`,
    );
    const closedAt = (JSON.parse(closedSeat.stdout.trim()) as { closedAt?: string }).closedAt;
    assert.ok(closedAt, "fixture precondition: the real close returned a timestamp");

    const result = await runCli(["seats", "set-brick", seatId, BRICK_ID], homeDir);
    assert.equal(result.code, 0, result.output);
    const after = await readStoreJson(homeDir);
    assert.equal(after[seatId]?.brick_id, BRICK_ID);
    assert.equal(
      after[seatId]?.closed_at,
      closedAt,
      "close's timestamp — WRITTEN BY THE REAL VERB — must be byte-unchanged",
    );
  });
});

test("CLB2 · `rename` on a CLOSED seat SUCCEEDS; closed_at is byte-unchanged — anchored to CLB1", async () => {
  // ANCHORED TO CLB1, NOT product-entered separately (F3): CLB1 already proves
  // the real `acpx seats close` produces this state; re-running that mint+close
  // sequence here would cost a second CLI round-trip (sessions new + sessions
  // close + seats close, ~5-8s) to re-verify a mechanism this file already
  // verifies once, for a row whose own variable is `name`, not how closed_at got
  // there. Same reasoning RN2' vs. the other `seatRow(...)`-based rows in this
  // file already states for the well-formed-row class.
  await withRig(async (homeDir) => {
    const closedAt = "2026-09-29T00:00:00.000Z";
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { closed_at: closedAt, name: "old" }) });

    const result = await runCli(["seats", "rename", SEAT_A, "renamed-after-close"], homeDir);
    assert.equal(result.code, 0, result.output);
    const after = await readStoreJson(homeDir);
    assert.equal(after[SEAT_A]?.name, "renamed-after-close");
    assert.equal(after[SEAT_A]?.closed_at, closedAt, "close's timestamp must be byte-unchanged");
  });
});

test("CLB3 · `delete` on a CLOSED seat SUCCEEDS — the row is removed, which is what the byway sweep needs — anchored to CLB1", async () => {
  // ANCHORED TO CLB1, same cost/control reason as CLB2's comment: this row's own
  // variable is row REMOVAL, not the closing mechanism, which CLB1 already
  // reaches through the real verb.
  await withRig(async (homeDir) => {
    const closedAt = "2026-09-29T00:00:00.000Z";
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { closed_at: closedAt }) });

    const result = await runCli(["seats", "delete", SEAT_A], homeDir);
    assert.equal(result.code, 0, result.output);
    assert.equal(
      (await readStoreJson(homeDir))[SEAT_A],
      undefined,
      "a closed seat's row must still delete",
    );
  });
});

// ═══ Group SH/LS/RO — B2d (`list`/`show`) + R7 (`reopen`), brick 88186acd ══════
//
// PRECONDITION AUDIT, extending the class above:
// - A VACANT seat (`active_holder_id: null`) is FIXTURE-ENTERED, structurally, same
//   reason CL1/RN8 state: no product path clears that field, and `mintSeatRow`
//   always seeds a fresh seat with its founding holder.
// - A seat whose `active_holder_id` points at a CLOSED session — SH2's whole
//   subject — is PRODUCT-ENTERED: a real founder, closed for real via `sessions
//   close`. Nothing writes the seat row on a holder's own close (ratification item
//   5), so this state is reached by the ordinary product path, not fixtured.
// - A DANGLING pointer (record resolvable to nothing) is FIXTURE-ENTERED,
//   structurally, same reason CL6 states for `close`.
// - `closed_at` non-null on a `reopen` row is PRODUCT-ENTERED where the row's own
//   test needs the REAL verb's timestamp (RO2); FIXTURE-ENTERED, structurally
//   noted, where the row's variable is something else (RO1, RO4-7).

/**
 * Mint a real founding holder and return its (holder id, seat id) — the shape
 * CL4/CLB1/R4 each inline separately; factored here because Group SH/LS/RO uses it
 * five times and a fixture would not reach the PRODUCT-ENTERED states these rows
 * are about.
 */
async function mintFounderAndSeat(
  homeDir: string,
  name: string,
): Promise<{ holderId: string; seatId: string }> {
  const cwd = path.join(homeDir, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];
  const founding = await runCli([...base, "sessions", "new", "-s", name], homeDir);
  assert.equal(founding.code, 0, founding.stderr);
  const holderId = String(
    (JSON.parse(founding.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
  );
  const holderRecord = JSON.parse(
    await fs.readFile(path.join(homeDir, ".acpx", "sessions", `${holderId}.json`), "utf8"),
  ) as { seat_id?: string };
  const seatId = String(holderRecord.seat_id);
  assert.ok(seatId !== "undefined", "fixture precondition: the founding holder carries a seat id");
  return { holderId, seatId };
}

// ─── show ────────────────────────────────────────────────────────────────────

test("SH1 · a VACANT seat (active_holder_id: null) shows as VACANT", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, {
      [SEAT_A]: seatRow(SEAT_A, { active_holder_id: null, name: "alpha", brick_id: BRICK_ID }),
    });
    const result = await runCli(["--format", "json", "seats", "show", SEAT_A], homeDir);
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      activeHolder: { state: string; id: string | null };
      activeHolderIdRaw: string | null;
      brickId: string | null;
    };
    assert.deepEqual(payload.activeHolder, { state: "vacant", id: null });
    assert.equal(payload.activeHolderIdRaw, null);
    assert.equal(payload.brickId, BRICK_ID, "the seventh field, brick_id, must round-trip");

    const text = await runCli(["seats", "show", SEAT_A], homeDir);
    assert.match(text.stdout, /active holder:\s+vacant/);
  });
});

/**
 * 🔑 THE FALSIFIER — the row that would have gone RED had `show` trusted the seat
 * row's raw `active_holder_id` pointer instead of `vetActiveHolder`'s resolution of
 * the HOLDER'S OWN record. PRODUCT-ENTERED: a real founder, closed for real. The
 * seat itself is NOT closed — this row's whole subject is the holder pointer, not
 * seat closure, and conflating the two would test the wrong mechanism.
 *
 * Measured live on devbox-staging (2026-09-30) that this is not a hypothetical:
 * `active_holder_id` is NEVER cleared by a holder's own close, so every session
 * that closes without a successor leaves its seat's row pointing at a closed id
 * forever — exactly the shape this row reaches through the real CLI.
 */
test("SH2 · a CLOSED holder's pointer shows as HELD BY A CLOSED SESSION, never as vacant and never as active (the falsifier)", async () => {
  await withRig(async (homeDir) => {
    const { holderId, seatId } = await mintFounderAndSeat(homeDir, "sh2-holder");
    const closedHolder = await runCli(
      ["--format", "json", "sessions", "close", "--session-id", holderId],
      homeDir,
    );
    assert.equal(closedHolder.code, 0, closedHolder.stderr);

    // Control: the row's RAW pointer still names the (now closed) holder — nothing
    // clears it on a holder's own close. Without this, the row below could pass
    // vacuously against a store that happened to already read `null`.
    const rawRow = (await readStoreJson(homeDir))[seatId] as Record<string, unknown>;
    assert.equal(
      rawRow.active_holder_id,
      holderId,
      "fixture precondition: the raw pointer still names the closed holder",
    );

    const result = await runCli(["--format", "json", "seats", "show", seatId], homeDir);
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      activeHolder: { state: string; id: string | null };
      activeHolderIdRaw: string | null;
      holders: { id: string; open: boolean | null }[];
    };
    // THE ASSERTION THAT WOULD HAVE FAILED: a `show` reading the raw pointer would
    // report `state: "active", id: holderId` here — a CLOSED session as the active
    // holder.
    // (Brick `eca085bb`, D-SEAT-HOLD: this row used to assert the OPPOSITE — that a
    // closed pointer renders identically to vacancy as "nobody-home". Inverted:
    // a close does not vacate a seat, so the seat is shown as held.)
    assert.deepEqual(
      payload.activeHolder,
      { state: "held-by-closed-session", id: holderId },
      "a closed holder must render as HELD BY a closed session — distinct from vacancy and from active",
    );
    assert.equal(
      payload.activeHolderIdRaw,
      holderId,
      "the RAW field must still show the actual pointer",
    );

    const text = await runCli(["seats", "show", seatId], homeDir);
    const holderLine =
      text.stdout.split("\n").find((line) => line.includes("active holder:")) ?? "";
    assert.match(
      holderLine,
      new RegExp(`${holderId} \\(held by a closed session\\)`),
      "the ACTIVE HOLDER line must name the closed holder AND say it is closed",
    );
    assert.doesNotMatch(holderLine, /nobody home|vacant/);

    // The holders list (a different field) DOES resolve this holder, and correctly
    // as closed — the two-encodings rule is about "who is ACTIVE", not about
    // erasing the holder from history.
    const holderEntry = payload.holders.find((holder) => holder.id === holderId);
    assert.ok(holderEntry, "the closed holder must still appear in the holders list");
    assert.equal(holderEntry?.open, false);
  });
});

test("SH3 · a DANGLING active_holder_id (record unresolvable) shows as HOLDER RECORD MISSING", async () => {
  await withRig(async (homeDir) => {
    const danglingId = "dddddddd-0000-4000-8000-dddddddddddd";
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { active_holder_id: danglingId }) });
    const result = await runCli(["--format", "json", "seats", "show", SEAT_A], homeDir);
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      activeHolder: { state: string; id: string | null };
    };
    assert.deepEqual(payload.activeHolder, { state: "holder-record-missing", id: danglingId });
    const text = await runCli(["seats", "show", SEAT_A], homeDir);
    assert.match(text.stdout, /holder record missing/);
  });
});

test("SH4 · show on an ABSENT row refuses SEAT_ROW_MISSING", async () => {
  await withRig(async (homeDir) => {
    const result = await runCli(["--format", "json", "seats", "show", SEAT_ABSENT], homeDir);
    assert.equal(result.code, 1);
    const refusal = refusalOf(result);
    assert.equal(refusal.code, "SEAT_ROW_MISSING");
  });
});

test("SH5 · show on a MALFORMED row refuses SEAT_ROW_MALFORMED", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: { seat_id: SEAT_A, created_at: "x", next_ordinal: 0 } });
    const result = await runCli(["--format", "json", "seats", "show", SEAT_A], homeDir);
    assert.equal(result.code, 1);
    assert.equal(refusalOf(result).code, "SEAT_ROW_MALFORMED");
  });
});

test("SH6 · show against a MALFORMED STORE refuses SEAT_STORE_UNHEALTHY, never SEAT_ROW_MISSING — unfaulted control arm", async () => {
  await withRig(async (homeDir) => {
    // §3a-bis control arm FIRST — the healthy case must actually succeed.
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { active_holder_id: null }) });
    const control = await runCli(["--format", "json", "seats", "show", SEAT_A], homeDir);
    assert.equal(control.code, 0, control.output);

    await writeRawStore(homeDir, "{ not json at all");
    const faulted = await runCli(["--format", "json", "seats", "show", SEAT_B], homeDir);
    assert.equal(faulted.code, 1);
    const refusal = refusalOf(faulted);
    // 🛑 THE NEW READ-PATH CODE, DELIBERATELY NOT `SEAT_STORE_UNWRITABLE` — that
    // code's message opens "refusing to WRITE the seat store", which is wrong for a
    // read verb. `show`/`list` never call the writer at all.
    assert.equal(refusal.code, "SEAT_STORE_UNHEALTHY");
    assert.doesNotMatch(refusal.error, /refusing to write/i);
    assert.notEqual(refusal.code, "SEAT_ROW_MISSING", "F1: corrupt must never read as absent");
  });
});

test("SH7 · holders are listed from the session index, ordered by ordinal, resolved via their OWN record", async () => {
  await withRig(async (homeDir) => {
    const { holderId, seatId } = await mintFounderAndSeat(homeDir, "sh7-holder");
    const result = await runCli(["--format", "json", "seats", "show", seatId], homeDir);
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      holders: { id: string; ordinal: number | null; open: boolean | null }[];
    };
    assert.deepEqual(payload.holders, [{ id: holderId, ordinal: 1, open: true }]);
  });
});

/**
 * R2 (brick 5d632d35) — `describeHolderOpenState(undefined)` → "record missing" was
 * verified at the ACTIVE-HOLDER seam (`SH3`, on `row.activeHolderId`) but never at
 * this HOLDERS-LIST seam (`listSeatHolders`, one row per session-index entry). The
 * two seams reach the same string through different inputs, and a TE pass found the
 * obvious way to reach it here — deleting the holder's record FILE — does not work:
 * `reconcileSessionIndex`'s fast path compares only the file LIST, so removing a
 * file drops its own index entry before `listSeatHolders` ever iterates it, and the
 * catch branch that renders "record missing" is unreachable that way. Corrupting the
 * file's CONTENT in place — same filename, same file list — leaves the index entry
 * untouched (the fast path never re-parses on an unchanged list) while
 * `resolveSessionRecord` still fails to read it, which is what actually reaches the
 * branch.
 */
test("SH8 · a holder whose RECORD IS UNREADABLE (not merely absent from the index) renders in the holders list as RECORD MISSING", async () => {
  await withRig(async (homeDir) => {
    const { holderId: founderId, seatId } = await mintFounderAndSeat(homeDir, "sh8-founder");
    const cwd = path.join(homeDir, "workspace");
    const successor = await runCli(
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
        "--seat",
        seatId,
      ],
      homeDir,
    );
    assert.equal(successor.code, 0, successor.stderr);
    const successorId = String(
      (JSON.parse(successor.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    // Control FIRST — both holders resolve OPEN before the corruption.
    const control = await runCli(["--format", "json", "seats", "show", seatId], homeDir);
    assert.equal(control.code, 0, control.output);
    const controlHolders = (
      JSON.parse(control.stdout.trim()) as { holders: { id: string; open: boolean | null }[] }
    ).holders;
    assert.ok(
      controlHolders.length === 2 && controlHolders.every((holder) => holder.open === true),
      `fixture precondition: both holders must resolve OPEN before corruption — ${JSON.stringify(controlHolders)}`,
    );

    await fs.writeFile(
      path.join(homeDir, ".acpx", "sessions", `${successorId}.json`),
      "{ not json at all",
      "utf8",
    );

    const result = await runCli(["--format", "json", "seats", "show", seatId], homeDir);
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      holders: { id: string; ordinal: number | null; open: boolean | null }[];
    };
    const founder = payload.holders.find((holder) => holder.id === founderId);
    const corrupted = payload.holders.find((holder) => holder.id === successorId);
    assert.equal(
      founder?.open,
      true,
      "the healthy founder must not be affected by the sibling's corruption",
    );
    assert.equal(
      corrupted?.open,
      null,
      "an unreadable record must report open:null, not vanish from the list",
    );

    const text = await runCli(["seats", "show", seatId], homeDir);
    assert.equal(text.code, 0, text.output);
    assert.match(
      text.stdout,
      /record missing/,
      "the TEXT rendering must print the same string SH3 asserts for the active-holder seam",
    );
  });
});

// ─── list ────────────────────────────────────────────────────────────────────

test("LS1 · lists both seats with no flag; --closed and --open each filter to one; together they filter to NEITHER (both listed)", async () => {
  await withRig(async (homeDir) => {
    const { seatId: openSeatId } = await mintFounderAndSeat(homeDir, "ls1-open");
    // A second, CLOSED seat — vacant, fixtured (same structural reason as SH1).
    const closedAt = "2026-09-29T00:00:00.000Z";
    const current = await readStoreJson(homeDir);
    current[SEAT_B] = seatRow(SEAT_B, { active_holder_id: null, closed_at: closedAt });
    await writeStore(homeDir, current);

    const all = await runCli(["--format", "json", "seats", "list"], homeDir);
    assert.equal(all.code, 0, all.output);
    const allSeatIds = (JSON.parse(all.stdout.trim()) as { seats: { seatId: string }[] }).seats.map(
      (seat) => seat.seatId,
    );
    assert.ok(allSeatIds.includes(openSeatId) && allSeatIds.includes(SEAT_B), allSeatIds.join(","));

    const closedOnly = await runCli(["--format", "json", "seats", "list", "--closed"], homeDir);
    const closedIds = (
      JSON.parse(closedOnly.stdout.trim()) as { seats: { seatId: string }[] }
    ).seats.map((seat) => seat.seatId);
    assert.deepEqual(closedIds, [SEAT_B]);

    const openOnly = await runCli(["--format", "json", "seats", "list", "--open"], homeDir);
    const openIds = (
      JSON.parse(openOnly.stdout.trim()) as { seats: { seatId: string }[] }
    ).seats.map((seat) => seat.seatId);
    assert.deepEqual(openIds, [openSeatId]);

    // BOTH FLAGS TOGETHER — the verb's own help text states this is "no filtering",
    // not a refusal. Assert the documented behaviour rather than leaving it silent.
    const both = await runCli(["--format", "json", "seats", "list", "--closed", "--open"], homeDir);
    const bothIds = (JSON.parse(both.stdout.trim()) as { seats: { seatId: string }[] }).seats.map(
      (seat) => seat.seatId,
    );
    assert.ok(
      bothIds.includes(openSeatId) && bothIds.includes(SEAT_B),
      `--closed --open together must list everything, got: ${bothIds.join(",")}`,
    );
  });
});

test("LS2 · holder count reflects the session index, one pass — not one scan per seat", async () => {
  await withRig(async (homeDir) => {
    const { seatId } = await mintFounderAndSeat(homeDir, "ls2-holder");
    const current = await readStoreJson(homeDir);
    current[SEAT_B] = seatRow(SEAT_B, { active_holder_id: null });
    await writeStore(homeDir, current);

    const result = await runCli(["--format", "json", "seats", "list"], homeDir);
    assert.equal(result.code, 0, result.output);
    const seats = (
      JSON.parse(result.stdout.trim()) as { seats: { seatId: string; holderCount: number }[] }
    ).seats;
    assert.equal(seats.find((seat) => seat.seatId === seatId)?.holderCount, 1);
    assert.equal(
      seats.find((seat) => seat.seatId === SEAT_B)?.holderCount,
      0,
      "a seat with no index entries must report zero holders, not be absent from the report",
    );
  });
});

test("LS3 · list against a MALFORMED STORE refuses SEAT_STORE_UNHEALTHY — unfaulted control arm", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { active_holder_id: null }) });
    const control = await runCli(["--format", "json", "seats", "list"], homeDir);
    assert.equal(control.code, 0, control.output);

    await writeRawStore(homeDir, "{ not json at all");
    const faulted = await runCli(["--format", "json", "seats", "list"], homeDir);
    assert.equal(faulted.code, 1);
    assert.equal(refusalOf(faulted).code, "SEAT_STORE_UNHEALTHY");
  });
});

test("LS4 · a MALFORMED ROW is excluded from the listing and named, never silently dropped", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, {
      [SEAT_A]: seatRow(SEAT_A, { active_holder_id: null }),
      [SEAT_B]: { seat_id: SEAT_B, created_at: "x", next_ordinal: 0 },
    });
    const result = await runCli(["--format", "json", "seats", "list"], homeDir);
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      seats: { seatId: string }[];
      malformed: string[];
    };
    assert.ok(
      payload.seats.every((seat) => seat.seatId !== SEAT_B),
      "the malformed row must not be listed as a seat",
    );
    assert.deepEqual(payload.malformed, [SEAT_B]);
  });
});

/**
 * 🛑 THE CONTRACT WIDENING — owner ruling 2026-09-30T16:17:04Z, on the TE's V3
 * finding: `list` must answer "which seat holds brick X", the one relation this
 * programme moved from the session onto the seat. `brickId` is ALWAYS PRESENT in
 * JSON (`null` when unset — C2's absence-is-a-value rule, same as `name`), and a
 * short `brick` column (uuid8, `-` when unset) in text.
 */
test("LS5 · brick_id — a seat WITH a brick shows it in BOTH formats; a seat WITHOUT shows null/json and -/text", async () => {
  await withRig(async (homeDir) => {
    // R0 (brick 5d632d35) — the WITH-BRICK arm is PRODUCT-ENTERED: `seats set-brick`
    // is a shipped path (`SB1` drives it for real, above, in this same file), so
    // fixturing `brick_id` directly would reintroduce the exact class an independent
    // TE already eliminated once in this file (finding F3, on `closed_at`) — a
    // fixture quietly standing in for a product path that exists (this file's own
    // precondition-audit rule, above). `SEAT_B`'s `active_holder_id: null` stays
    // fixtured — `RN8` documents that one as structurally legitimate.
    await writeStore(homeDir, {
      [SEAT_A]: seatRow(SEAT_A, { active_holder_id: null }),
      [SEAT_B]: seatRow(SEAT_B, { active_holder_id: null }),
    });
    const setBrick = await runCli(["seats", "set-brick", SEAT_A, BRICK_ID], homeDir);
    assert.equal(setBrick.code, 0, setBrick.output);

    const json = await runCli(["--format", "json", "seats", "list"], homeDir);
    assert.equal(json.code, 0, json.output);
    const payload = JSON.parse(json.stdout.trim()) as {
      seats: { seatId: string; brickId: string | null }[];
    };
    assert.equal(
      payload.seats.find((seat) => seat.seatId === SEAT_A)?.brickId,
      BRICK_ID,
      "a seat WITH a brick must show it",
    );
    assert.equal(
      payload.seats.find((seat) => seat.seatId === SEAT_B)?.brickId,
      null,
      "a seat WITHOUT a brick must show null, never be missing the key",
    );
    assert.ok(
      Object.hasOwn(payload.seats.find((seat) => seat.seatId === SEAT_B) ?? {}, "brickId"),
      "brickId must be a PRESENT key with value null, never an absent key",
    );

    const text = await runCli(["seats", "list"], homeDir);
    assert.equal(text.code, 0, text.output);
    const lineFor = (seatId: string) =>
      text.stdout.split("\n").find((line) => line.startsWith(seatId));
    assert.match(lineFor(SEAT_A) ?? "", new RegExp(`brick=${BRICK_ID.slice(0, 8)}\\b`));
    assert.match(lineFor(SEAT_B) ?? "", /brick=-\s/);
  });
});

// ─── reopen ──────────────────────────────────────────────────────────────────

test("RO1 · IDEMPOTENT no-op — reopening a seat that is NOT closed is rc 0 with a notice, and writes nothing", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A, { active_holder_id: null }) });
    const before = await readStoreBytes(homeDir);

    const result = await runCli(["--format", "json", "seats", "reopen", SEAT_A], homeDir);
    assert.equal(result.code, 0, result.output);
    const payload = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      action: string;
      changed: boolean;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.action, "seat_reopen_no_change");
    assert.equal(payload.changed, false);
    assert.equal(
      await readStoreBytes(homeDir),
      before,
      "a no-op reopen must not rewrite the store",
    );
  });
});

/**
 * R7 item 2, verified on the REAL round trip: `active_holder_id` and
 * `next_ordinal` are BYTE-UNCHANGED across close → reopen — reopening is not a
 * succession, and the seat verb never touches a session record.
 */
test("RO2 · a real close -> reopen round trip clears closed_at and leaves active_holder_id / next_ordinal BYTE-UNCHANGED", async () => {
  await withRig(async (homeDir) => {
    const { holderId, seatId } = await mintFounderAndSeat(homeDir, "ro2-holder");
    const closedHolder = await runCli(
      ["--format", "json", "sessions", "close", "--session-id", holderId],
      homeDir,
    );
    assert.equal(closedHolder.code, 0, closedHolder.stderr);
    const closedSeat = await runCli(["--format", "json", "seats", "close", seatId], homeDir);
    assert.equal(closedSeat.code, 0, closedSeat.output);

    const beforeReopen = (await readStoreJson(homeDir))[seatId] as Record<string, unknown>;
    assert.ok(
      typeof beforeReopen.closed_at === "string",
      "fixture precondition: the seat is really closed",
    );

    const reopened = await runCli(["--format", "json", "seats", "reopen", seatId], homeDir);
    assert.equal(reopened.code, 0, reopened.output);
    const payload = JSON.parse(reopened.stdout.trim()) as {
      action: string;
      changed: boolean;
      activeHolderId: string | null;
    };
    assert.equal(payload.action, "seat_reopened");
    assert.equal(payload.changed, true);
    assert.equal(payload.activeHolderId, holderId);

    const after = (await readStoreJson(homeDir))[seatId] as Record<string, unknown>;
    assert.equal(after.closed_at, null, "closed_at must be cleared");
    assert.equal(
      after.active_holder_id,
      beforeReopen.active_holder_id,
      "active_holder_id must be BYTE-UNCHANGED — reopen is not a succession",
    );
    assert.equal(
      after.next_ordinal,
      beforeReopen.next_ordinal,
      "next_ordinal must be BYTE-UNCHANGED — reopen never draws or resets it",
    );
    assert.equal(after.name, beforeReopen.name);
  });
});

/**
 * 🔑 AP15 — THE PAIRED REFUSAL, MIRRORING R4's EXACT SHAPE
 * (`test/seat-creation-paths.test.ts:386`): before reopen, create-into-seat is
 * refused SEAT_CLOSED; after reopen, the identical command is ACCEPTED. A refusal
 * test alone cannot tell "correctly refused" from "broken in both states" — this
 * row proves both halves in the same run, against the same seat.
 */
test("RO3 · AP15 pair — create-into-seat is refused SEAT_CLOSED before reopen, and ACCEPTED after", async () => {
  await withRig(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];
    const { holderId, seatId } = await mintFounderAndSeat(homeDir, "ro3-founder");

    const closedHolder = await runCli(
      [...base, "sessions", "close", "--session-id", holderId],
      homeDir,
    );
    assert.equal(closedHolder.code, 0, closedHolder.stderr);
    const closedSeat = await runCli([...base, "seats", "close", seatId], homeDir);
    assert.equal(closedSeat.code, 0, closedSeat.output);

    // BEFORE reopen — refused.
    const refused = await runCli([...base, "sessions", "new", "--seat", seatId], homeDir);
    assert.notEqual(refused.code, 0, "a closed seat must still refuse a join before reopen");
    assert.match(`${refused.stdout}${refused.stderr}`, /SEAT_CLOSED/);

    // THE VERB UNDER TEST.
    const reopened = await runCli([...base, "seats", "reopen", seatId], homeDir);
    assert.equal(reopened.code, 0, reopened.output);

    // AFTER reopen — the IDENTICAL command now succeeds.
    const accepted = await runCli([...base, "sessions", "new", "--seat", seatId], homeDir);
    assert.equal(
      accepted.code,
      0,
      `AP15: create-into-seat was still refused after reopen — ${accepted.stdout}${accepted.stderr}`,
    );
  });
});

test("RO4 · reopen on an ABSENT row refuses SEAT_ROW_MISSING", async () => {
  await withRig(async (homeDir) => {
    const result = await runCli(["--format", "json", "seats", "reopen", SEAT_ABSENT], homeDir);
    assert.equal(result.code, 1);
    assert.equal(refusalOf(result).code, "SEAT_ROW_MISSING");
    assert.equal(await storeExists(homeDir), false, "a refused reopen must not create the store");
  });
});

test("RO5 · reopen on a MALFORMED row refuses SEAT_ROW_MALFORMED; the row survives VERBATIM", async () => {
  await withRig(async (homeDir) => {
    const malformed = { seat_id: SEAT_A, created_at: "x", next_ordinal: 0 };
    await writeStore(homeDir, { [SEAT_A]: malformed });
    const result = await runCli(["--format", "json", "seats", "reopen", SEAT_A], homeDir);
    assert.equal(result.code, 1);
    assert.equal(refusalOf(result).code, "SEAT_ROW_MALFORMED");
    assert.deepEqual((await readStoreJson(homeDir))[SEAT_A], malformed);
  });
});

test("RO6 · reopen against a MALFORMED STORE refuses SEAT_STORE_UNWRITABLE — the EXISTING write-path code, not the new read one", async () => {
  await withRig(async (homeDir) => {
    // §3a-bis control arm FIRST.
    await writeStore(homeDir, {
      [SEAT_A]: seatRow(SEAT_A, { closed_at: "2026-09-29T00:00:00.000Z" }),
    });
    const control = await runCli(["--format", "json", "seats", "reopen", SEAT_A], homeDir);
    assert.equal(control.code, 0, control.output);

    await writeRawStore(homeDir, "{ not json at all");
    const faulted = await runCli(["--format", "json", "seats", "reopen", SEAT_B], homeDir);
    assert.equal(faulted.code, 1);
    // 🛑 `reopen` IS A MUTATION — it must reuse the SAME `SEAT_STORE_UNWRITABLE`
    // code every other writer uses, never the new `SEAT_STORE_UNHEALTHY` read-path
    // code (SH6/LS3), which would be a second, inconsistent scheme for one fact.
    assert.equal(refusalOf(faulted).code, "SEAT_STORE_UNWRITABLE");
  });
});

test("RO7 · decideSeatReopen — the pure decision, both branches", () => {
  const row: SeatRecord = {
    seatId: SEAT_A,
    createdAt: "2026-09-29T00:00:00.000Z",
    activeHolderId: "holder-1",
    nextOrdinal: 2,
    closedAt: null,
    name: undefined,
    brickId: undefined,
    favorite: false,
  };
  assert.deepEqual(decideSeatReopen(row), { kind: "already-open" });
  assert.deepEqual(decideSeatReopen({ ...row, closedAt: "2026-09-28T00:00:00.000Z" }), {
    kind: "reopen",
  });
});

/**
 * 🔑 R1 (brick 5d632d35) — THE PRIMARY RESIDUAL, reframed by the programme owner as
 * an UNMET ACCEPTANCE CRITERION rather than tidiness: R7 item 4 requires PAIRED rows
 * for both refusals `reopen` lifts (AP15). `RO3` above covers `create-into-seat`
 * only; the `sessions activate` half was verified once, on the product, by an
 * independent TE (B2d/re-open `VERIFICATION.md` V5 — rc 1 `SEAT_CLOSED` before
 * reopen, rc 0 `outcome:"activated"` `holderOrdinal:2` after) and stopped there —
 * nothing in the repo re-checked it, so a future change to `seat-activate.ts` could
 * silently invert the refusal with nothing red to catch it. Mirrors `RO3`'s exact
 * shape: same seat, same run, refused before reopen, accepted after — a refusal row
 * ALONE cannot tell "correctly refused" from "broken in both states".
 */
test("RO8 · AP15 pair — sessions activate is refused SEAT_CLOSED before reopen, and ACCEPTED after", async () => {
  await withRig(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];
    const { holderId: founderId, seatId } = await mintFounderAndSeat(homeDir, "ro8-founder");

    // The successor must be created INTO the seat WHILE IT IS STILL OPEN —
    // create-into-seat itself refuses once the seat is closed (RO3 / seat-activate's
    // own R4).
    const successor = await runCli([...base, "sessions", "new", "--seat", seatId], homeDir);
    assert.equal(successor.code, 0, successor.stderr);
    const successorId = String(
      (JSON.parse(successor.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );

    const closedFounder = await runCli(
      [...base, "sessions", "close", "--session-id", founderId],
      homeDir,
    );
    assert.equal(closedFounder.code, 0, closedFounder.stderr);
    const closedSeat = await runCli([...base, "seats", "close", seatId], homeDir);
    assert.equal(closedSeat.code, 0, closedSeat.output);

    // BEFORE reopen — refused.
    const refused = await runCli([...base, "sessions", "activate", seatId, successorId], homeDir);
    assert.notEqual(refused.code, 0, "a closed seat must still refuse an activation before reopen");
    assert.match(`${refused.stdout}${refused.stderr}`, /SEAT_CLOSED/);

    // THE VERB UNDER TEST.
    const reopened = await runCli([...base, "seats", "reopen", seatId], homeDir);
    assert.equal(reopened.code, 0, reopened.output);

    // AFTER reopen — the IDENTICAL command now succeeds.
    const accepted = await runCli([...base, "sessions", "activate", seatId, successorId], homeDir);
    assert.equal(
      accepted.code,
      0,
      `AP15: sessions activate was still refused after reopen — ${accepted.stdout}${accepted.stderr}`,
    );
    const payload = JSON.parse(accepted.stdout.trim()) as {
      outcome?: string;
      holderOrdinal?: number;
    };
    assert.equal(payload.outcome, "activated");
    assert.equal(payload.holderOrdinal, 2, "the successor must take next_ordinal, not restart it");
  });
});

// ═══ Group H — store discipline, supplementary in-process rows ════════════════
//
// These two are IN-PROCESS and therefore supplementary evidence, not primary
// (AC16). They measure something a child process cannot report on: what happens
// INSIDE the hold.

test("H1 · the delete mutator's hold is ONE seats.json read and ONE write — with a non-vacuity control", async () => {
  await withTempHomeFixture("acpx-seats-hold-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "seats.json"),
      `${JSON.stringify({ [SEAT_A]: seatRow(SEAT_A), [SEAT_B]: seatRow(SEAT_B) })}\n`,
      "utf8",
    );

    const ops: string[] = [];
    const fsp = await import("node:fs/promises");
    for (const api of ["readFile", "writeFile", "rename"] as const) {
      const original = fsp.default[api] as (...args: unknown[]) => unknown;
      mock.method(fsp.default, api, (...args: unknown[]) => {
        const target = typeof args[0] === "string" ? args[0] : "<non-path>";
        if (path.basename(target).startsWith("seats.json")) {
          // `.tmp` siblings of seats.json are the atomic write's own temp file.
          ops.push(`${api}:${path.basename(target).includes(".tmp") ? "temp" : "store"}`);
        }
        return original(...args);
      });
    }

    try {
      await withSeatStoreWrite(sessionDir, (store) => {
        const { seats } = buildSeatDeletion(store, [SEAT_A]);
        return { mutation: { kind: "write", seats } as const, result: undefined };
      });
    } finally {
      mock.restoreAll();
    }

    assert.deepEqual(
      ops,
      ["readFile:store", "writeFile:temp", "rename:temp"],
      "exactly one store read, and one atomic write (temp + rename) — nothing else",
    );
  });
});

test("H1 control · the op counter CATCHES a forbidden extra read — it is not vacuous", async () => {
  await withTempHomeFixture("acpx-seats-hold-control-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "seats.json"),
      `${JSON.stringify({ [SEAT_A]: seatRow(SEAT_A) })}\n`,
      "utf8",
    );

    const ops: string[] = [];
    const fsSync = await import("node:fs");
    const originalReadSync = fsSync.default.readFileSync;
    mock.method(fsSync.default, "readFileSync", (...args: unknown[]) => {
      const target = typeof args[0] === "string" ? args[0] : "<non-path>";
      if (path.basename(target).startsWith("seats.json")) {
        ops.push("readFileSync:store");
      }
      return (originalReadSync as (...a: unknown[]) => unknown)(...args);
    });

    try {
      await withSeatStoreWrite(sessionDir, (store) => {
        // ⚠️ THE FORBIDDEN OPERATION, PERFORMED HERE IN THE TEST — never in `src/`.
        // A synchronous mutator cannot `await`, so sync fs is the only residue it can
        // still reach; this proves the instrument would see it if a future mutator did.
        fsSync.default.readFileSync(path.join(sessionDir, "seats.json"), "utf8");
        return { mutation: { kind: "write", seats: new Map(store.seats) } as const, result: 0 };
      });
    } finally {
      mock.restoreAll();
    }

    assert.deepEqual(ops, ["readFileSync:store"], "an extra read inside the hold must be COUNTED");
  });
});

test("AP11 (close) · the no-change path performs NO WRITE at all — mtime/inode/bytes identical, with a write-visible control", async () => {
  // 🛑 WRITTEN (independent TE finding F6, 2026-09-29). PLAN §3.1 required this
  // bound for `close` — "one seats.json read, at most one write, nothing else
  // inside the hold, measured under an fs spy against the product's own mutator,
  // as B2b's row H1 does" — and no such row existed. `close` is the FIRST verb
  // whose `mutate` BRANCHES (`SEAT_STORE_NO_CHANGE` vs a real write), which is
  // exactly the shape where a stray extra write hides silently.
  //
  // ⚠️ WHY THIS IS BLACK-BOX (file stats), NOT AN fs-SPY LIKE H1: H1 spies on
  // `buildSeatDeletion`, an EXPORTED standalone mutator function called
  // in-process. `close`'s `mutate` callback is inline inside the private
  // `handleSeatsClose` — nothing to import and call directly. Reimplementing its
  // logic here to spy on would be measuring a COPY of the product, the exact trap
  // H1's own comment names ("a test that re-implemented the mutator would be
  // measuring its own copy"). So this row measures the STORE FILE itself: mtime,
  // inode and byte count all identical across a no-change close means no write
  // reached the filesystem, which is what an accidental extra write would change.
  await withRig(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all", "--format", "json"];
    const storeFile = storePath(homeDir);

    const founding = await runCli([...base, "sessions", "new", "-s", "ap11-holder"], homeDir);
    assert.equal(founding.code, 0, founding.stderr);
    const holderId = (JSON.parse(founding.stdout.trim()) as { acpxRecordId?: string }).acpxRecordId;
    assert.ok(holderId, "fixture precondition");
    const seatId = (
      JSON.parse(
        await fs.readFile(path.join(homeDir, ".acpx", "sessions", `${holderId}.json`), "utf8"),
      ) as { seat_id?: string }
    ).seat_id;
    assert.ok(seatId, "fixture precondition: the founding holder carries a seat id");

    const closedHolder = await runCli(
      [...base, "sessions", "close", "--session-id", holderId],
      homeDir,
    );
    assert.equal(closedHolder.code, 0, closedHolder.stderr);
    const firstClose = await runCli([...base, "seats", "close", seatId], homeDir);
    assert.equal(firstClose.code, 0, firstClose.stdout + firstClose.stderr);

    // Wait past filesystem mtime resolution before the measurement window opens —
    // the TE's own script validated 1.1s as sufficient on this box.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const before = await fs.stat(storeFile);

    const secondClose = await runCli([...base, "seats", "close", seatId], homeDir);
    assert.equal(secondClose.code, 0, "the no-change path must still be rc 0");

    const after = await fs.stat(storeFile);
    assert.equal(
      before.mtimeMs,
      after.mtimeMs,
      "AP11: the no-change path WROTE the file (mtime moved)",
    );
    assert.equal(before.ino, after.ino, "AP11: the no-change path WROTE the file (inode moved)");
    assert.equal(before.size, after.size, "AP11: the no-change path WROTE the file (size moved)");

    // §3a-bis — THE CONTROL ARM. A "nothing was written" result is worthless from
    // a blind instrument: prove the SAME measurement sees a write that DID happen.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const rename = await runCli(["seats", "rename", seatId, "ap11-control-rename"], homeDir);
    assert.equal(rename.code, 0, rename.output);
    const controlAfter = await fs.stat(storeFile);
    assert.notEqual(
      before.mtimeMs,
      controlAfter.mtimeMs,
      "CONTROL: a real write must move mtime — if it does not, this instrument is BLIND and the " +
        "no-write result above proves nothing",
    );
  });
});

// H2 — the compiler, not this file, is the enforcement: `withSeatStoreWrite`'s
// mutator returns a VALUE, never a Promise, so no record I/O, index I/O, network
// call or drain is reachable from inside the hold BY TYPE. Making any mutator in
// `seats-command.ts` async fails `pnpm run typecheck`. The type-level assertion
// lives once, in `test/seat-store.test.ts`; restating it here would be a copy.
//
// H3 — no memoisation is introduced: `seats-command.ts` holds no module-level state
// of any kind, and every verb reads the store fresh inside the hold through
// `readSeatStore`, which goes to disk every time by design. The behavioural evidence
// is that each CLI row above starts from a store written by the PREVIOUS row and
// sees it — SB5, RN9 and D8r each re-read a file rewritten between invocations.
