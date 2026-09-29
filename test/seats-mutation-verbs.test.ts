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
import { buildSeatDeletion } from "../src/cli/seats-command.js";
import { readSeatStore, withSeatStoreWrite } from "../src/session/persistence.js";
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

/** A well-formed persisted seat row. `closed_at` is present and `null` — never absent. */
function seatRow(seatId: string, overrides: PersistedRow = {}): PersistedRow {
  return {
    seat_id: seatId,
    created_at: "2026-09-29T00:00:00.000Z",
    active_holder_id: `aaaaaaaa-0000-4000-8000-${seatId.slice(-12)}`,
    next_ordinal: 2,
    closed_at: null,
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
    assert.deepEqual(
      { ...after[SEAT_A], brick_id: undefined },
      { ...before[SEAT_A], brick_id: undefined },
      "every field other than brick_id must be untouched",
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

test("SB3 · a well-formed seat id with NO ROW is refused with the backfill remedy (AP17)", async () => {
  await withRig(async (homeDir) => {
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A) });

    const result = await runCli(
      ["--format", "json", "seats", "set-brick", SEAT_ABSENT, BRICK_ID],
      homeDir,
    );
    assert.equal(result.code, 1);
    const refusal = refusalOf(result);
    assert.equal(refusal.code, "SEAT_ROW_MISSING");
    // The remedy wording is what SB2's mechanism CANNOT produce — that asymmetry is
    // what makes the two refusals distinguishable rather than merely differently worded.
    assert.match(refusal.error, /RUN THE SEAT BACKFILL/);
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
      /RUN THE SEAT BACKFILL/,
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

test("RN3′ · the record-unchanged assertion CAN fail — the committed negative case", () => {
  // In place of "make the implementation also write the holder's record and show
  // RN2′ red" (forbidden: that is gutting/mutating the source). This feeds the same
  // comparison the violation it exists to catch — a record whose `name` moved — and
  // requires it to be caught. Without it, RN2′ would pass identically if the two
  // reads were of the same stale buffer or the comparison were `assert.ok(true)`.
  const recordBefore = JSON.stringify({ acpx_record_id: "r1", name: "alpha", seat_id: SEAT_A });
  const recordAfterProjectionWrite = JSON.stringify({
    acpx_record_id: "r1",
    name: "renamed",
    seat_id: SEAT_A,
  });
  assert.notEqual(
    recordAfterProjectionWrite,
    recordBefore,
    "if this comparison cannot see a changed record name, RN2′ proves nothing",
  );
});

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
  // NOT prove any READER prefers the seat — no reader reads the seat until B7b, and
  // that is the accepted cost recorded on this block, not a gap in this row.
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
    assert.doesNotMatch(badRefusal.error, /RUN THE SEAT BACKFILL/);

    const noRow = await runCli(["--format", "json", "seats", "rename", SEAT_ABSENT, "x"], homeDir);
    assert.equal(noRow.code, 1);
    const noRowRefusal = refusalOf(noRow);
    assert.equal(noRowRefusal.code, "SEAT_ROW_MISSING");
    assert.match(noRowRefusal.error, /RUN THE SEAT BACKFILL/);
    assert.doesNotMatch(noRowRefusal.error, /must be a seat id in lowercase UUID form/);

    assert.equal(await readStoreBytes(homeDir), bytes);
  });
});

test("RN8 · a VACANT seat (active_holder_id null) is renamed anyway — there is no holder to project onto", async () => {
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

test("D7 · a MALFORMED ROW survives the delete VERBATIM — with the control that proves the check bites", async () => {
  await withRig(async (homeDir) => {
    // `next_ordinal: 0` is unreadable by the parse leg (the counter starts at 1), so
    // this row lands in `unparsedRows` — carried, never repaired.
    const malformed = { seat_id: SEAT_B, created_at: "x", next_ordinal: 0 };
    await writeStore(homeDir, { [SEAT_A]: seatRow(SEAT_A), [SEAT_B]: malformed });

    const result = await runCli(["seats", "delete", SEAT_A], homeDir);
    assert.equal(result.code, 0, result.output);

    const after = await readStoreJson(homeDir);
    assert.equal(after[SEAT_A], undefined, "the target is deleted");
    assert.deepEqual(
      after[SEAT_B],
      malformed,
      "the malformed row must be re-emitted VERBATIM — a mutator naturally builds its next " +
        "state from `seats`, which by definition excludes it (seat-store.ts:210-218)",
    );

    // THE COMMITTED NEGATIVE CASE for "[RED-WHEN-REMOVED]: build the next state from
    // store.seats alone". Rather than gutting the writer, this reproduces what such a
    // writer would PRODUCE and requires the same comparison to flag it.
    const naiveWriterOutput: Record<string, PersistedRow> = { ...after };
    delete naiveWriterOutput[SEAT_B];
    assert.equal(
      naiveWriterOutput[SEAT_B],
      undefined,
      "if the malformed row's absence is not detectable, D7's assertion proves nothing",
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

test("D9r · deleting a seat whose OWN row is malformed is REFUSED, not silently dropped", async () => {
  // ⚠️ NOT IN THE PLAN'S ROW LIST — raised by the implementation and reported
  // upward. The store's discipline is "carried and visible, NEVER repaired", and
  // `withSeatStoreWrite` re-emits unparsed rows unconditionally as a data-loss
  // defence, so a delete of an unreadable row cannot remove it without reaching
  // around the one writer. It refuses instead, with its own code, and the refusal
  // says the row is present rather than absent (D8's whole point).
  await withRig(async (homeDir) => {
    const malformed = { seat_id: SEAT_A, created_at: "x", next_ordinal: 0 };
    await writeStore(homeDir, { [SEAT_A]: malformed, [SEAT_B]: seatRow(SEAT_B) });
    const bytes = await readStoreBytes(homeDir);

    const result = await runCli(["--format", "json", "seats", "delete", SEAT_A], homeDir);
    assert.equal(result.code, 1);
    const refusal = refusalOf(result);
    assert.equal(refusal.code, "SEAT_ROW_MALFORMED");
    assert.match(refusal.error, /is PRESENT in the seat store but its row is malformed/);
    assert.notEqual(refusal.code, "SEAT_ROW_MISSING");
    assert.equal(await readStoreBytes(homeDir), bytes, "nothing is written by the refusal");
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
