import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { seatStorePath } from "../src/session/persistence.js";
import {
  listSessionRecordFiles,
  toSessionIndexEntry,
  writeSessionIndex,
} from "../src/session/persistence/index.js";
import { parseSessionRecord } from "../src/session/persistence/parse.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

/**
 * Brick `9984c510` — the seat's canonical `brick_id` must CARRY ITS VALIDATION
 * STATE, so UNVALIDATED is distinguishable from both ABSENT (F1) and VALIDATED.
 *
 * 🛑 **DELIBERATELY STANDALONE AND TYPE-FREE ON THE SEAT SURFACE.** Every row
 * here drives the REAL compiled CLI (`runCli`) and reads/writes `seats.json` as
 * RAW, UNTYPED JSON (never through `SeatRecord`/`SeatBrickLink`) — so this file
 * compiles and runs UNCHANGED against the pre-fix tree (`origin/seat/program`
 * @ `00f59e55`), which is what makes the RED in this brick's own report real
 * rather than contrived. `pnpm run test` is `build && build:test && … &&`
 * chained, so a test file that references the NEW TypeScript type cannot
 * produce a TAP row on base at all — it is a non-result, not a red. Reading the
 * JSON key directly sidesteps that: on base the key is simply ABSENT, so the
 * assertion fails for exactly the right reason.
 *
 * Each test names, in its own comment, whether it is RED-ON-BASE (the
 * behaviour this brick changes — absent on base, present on fix) or
 * GREEN-ON-BASE (characterisation/attribution — passes on both, because its
 * job is to make the RED-ON-BASE rows attributable, not to BE one itself).
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;
// Same fixture used by `seat-creation-paths.test.ts` — resolves `--brick`
// without the real 3s-timeout `brick show` round trip.
const BRICK_SHIM_DIR = path.join(process.cwd(), "test", "fixtures", "brick-shim");

// A fixed, found-nowhere uuid — deliberately DIFFERENT from any brick id any
// other row in this suite resolves, so the REFERENCE ARM's result can never be
// confused with "the shim happened to know this one". Matches the sentinel
// already used in this brick's own measurement log (CONTENT.md).
const BRICK_WRONG = "deadbeef-dead-4bee-8aaa-0123456789ab";
const BRICK_A = "1a5845c3-a832-4370-b564-8ec5286bff79";

type CliResult = { code: number | null; stdout: string; stderr: string };

const CHILD_ENV_SCRUB = [
  "ACPX_SESSION_URL",
  "ACPX_SESSION_NAME",
  "ACPX_PARENT_SESSION_URL",
  "ACPX_SEAT_URL",
  "ACPX_PARENT_SEAT_URL",
  "ACPX_TASK_FOLDER",
  "ACPX_BRICK",
  "ACPX_BRICK_PATH",
  "ACPX_OWNER_LOG",
] as const;

function runCli(
  args: string[],
  homeDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      ACPX_STATE_HOME: homeDir,
      ...extraEnv,
    };
    for (const key of CHILD_ENV_SCRUB) {
      if (!(key in extraEnv)) {
        delete env[key];
      }
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

function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  return withTempHomeFixture("acpx-seat-brick-validation-", run);
}

function sessionsDir(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

/** Raw, untyped read of `seats.json` — deliberately NOT `readSeatStore` /
 * `seatFromStore`, whose return TYPE differs between base and fix. JSON has no
 * compile-time type, so this reads identically on both trees. */
async function readRawSeatStore(homeDir: string): Promise<Record<string, Record<string, unknown>>> {
  const raw = await fs.readFile(seatStorePath(sessionsDir(homeDir)), "utf8");
  return JSON.parse(raw) as Record<string, Record<string, unknown>>;
}

/** Raw, untyped WRITE of `seats.json` — plants a row with an exact on-disk
 * shape without going through `withSeatStoreWrite`/`SeatRecord`, so the
 * fixture itself needs no typed import either. */
async function writeRawSeatStore(
  homeDir: string,
  seats: Record<string, Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(sessionsDir(homeDir), { recursive: true });
  await fs.writeFile(seatStorePath(sessionsDir(homeDir)), `${JSON.stringify(seats)}\n`, "utf8");
}

function rawSeatRow(
  seatId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    seat_id: seatId,
    created_at: "2026-01-01T00:00:00.000Z",
    active_holder_id: null,
    next_ordinal: 1,
    closed_at: null,
    // `false`, matching what `favoriteFromHolders` computes for every holder
    // fixture in this file (none sets `favorite: true`) — WITHOUT this, an
    // absent `favorite` key disagrees with the backfill's own computed value
    // and spuriously trips `favoriteNeedsMigration`, which rewrites the WHOLE
    // row through `migrateSeatFavorite`'s spread. That incidental rewrite is
    // harmless on fix (its reader/writer round-trips `brickId` faithfully)
    // but SILENTLY DROPS a hand-planted `brick_id_validated` on base (base's
    // narrower writer never emits it) — confounding an "untouched by THIS
    // brick's backfill leg" row with "untouched by an unrelated migration
    // leg that happens to also preserve/not-preserve the new field". Setting
    // this explicitly means NO leg has a reason to rewrite an otherwise-
    // consistent row, so "untouched" means byte-for-byte untouched, on both
    // trees, for the right reason.
    favorite: false,
    ...overrides,
  };
}

function sessionRecordPath(homeDir: string, acpxRecordId: string): string {
  return path.join(sessionsDir(homeDir), `${encodeURIComponent(acpxRecordId)}.json`);
}

async function readRawSessionRecord(
  homeDir: string,
  acpxRecordId: string,
): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(sessionRecordPath(homeDir, acpxRecordId), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

let recordSeq = 0;

function makeRecord(overrides: Partial<SessionRecord> & { acpxRecordId: string }): SessionRecord {
  recordSeq += 1;
  return makeSessionRecordFixture({
    acpSessionId: `acp-${overrides.acpxRecordId}`,
    agentCommand: "node agent.js",
    cwd: "/tmp/rig",
    lastUsedAt: `2026-01-01T00:00:${String(recordSeq % 60).padStart(2, "0")}.000Z`,
    ...overrides,
  });
}

async function seed(homeDir: string, records: readonly SessionRecord[]): Promise<void> {
  for (const record of records) {
    await writeSessionRecordFile(homeDir, record);
  }
  const dir = sessionsDir(homeDir);
  const files = await listSessionRecordFiles(dir);
  const entries = [];
  for (const file of files) {
    const parsed = parseSessionRecord(JSON.parse(await fs.readFile(path.join(dir, file), "utf8")));
    assert.ok(parsed, `rig record ${file} did not parse — the fixture is wrong, not the subject`);
    entries.push(toSessionIndexEntry(parsed, file));
  }
  await writeSessionIndex(dir, { files, entries });
}

async function sessionRecordFiles(sessionDir: string): Promise<string[]> {
  return fs
    .readdir(sessionDir)
    .then((names) =>
      names.filter(
        (name) => name.endsWith(".json") && name !== "index.json" && name !== "seats.json",
      ),
    )
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    });
}

// ─── healthy leg × degraded leg — `brick_id_validated` on disk ─────────────

test("RED-ON-BASE · healthy leg (`brick show` resolves) · the seat's brick_id_validated is TRUE on disk", async () => {
  await withTempHome(async (homeDir) => {
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
        "healthy-leg",
        "--brick",
        BRICK_A,
      ],
      homeDir,
      {
        PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
        BRICK_SHIM_MODE: "ok",
        BRICK_SHIM_ID: BRICK_A,
      },
    );
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRawSessionRecord(homeDir, id);
    const seatId = String(onDisk.seat_id);

    const store = await readRawSeatStore(homeDir);
    assert.equal(
      store[seatId]?.brick_id,
      BRICK_A,
      "the healthy leg must still write the seat's brick_id",
    );
    // THE RED: absent on base (no such key is ever written there), `true` on fix.
    assert.equal(
      store[seatId]?.brick_id_validated,
      true,
      "RED-ON-BASE: the healthy leg must mark the seat's brick link VALIDATED",
    );
  });
});

test("O3 · a container brick whose full card is over 1 MiB still gets its seat link VALIDATED", async () => {
  await withTempHome(async (homeDir) => {
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
        "big-card-leg",
        "--brick",
        BRICK_A,
      ],
      homeDir,
      {
        PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
        BRICK_SHIM_MODE: "ok",
        BRICK_SHIM_ID: BRICK_A,
        // `brick show` of a container brick is a 4-12 MB card; execFile's 1 MiB default
        // maxBuffer killed it, which read as "CLI unavailable" and stored the link UNVALIDATED.
        BRICK_SHIM_CARD_BYTES: String(2 * 1024 * 1024),
      },
    );
    assert.equal(created.code, 0, created.stderr);
    assert.doesNotMatch(created.stderr, /brick CLI unavailable/);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRawSessionRecord(homeDir, id);
    const seatId = String(onDisk.seat_id);

    const store = await readRawSeatStore(homeDir);
    assert.equal(store[seatId]?.brick_id, BRICK_A);
    assert.equal(
      store[seatId]?.brick_id_validated,
      true,
      "O3: a resolving --brick create must leave the seat link VALIDATED, however large the brick's card is",
    );
  });
});

test("RED-ON-BASE · ROW B extended, degraded leg (`brick show` times out) · the seat's brick_id_validated is FALSE on disk", async () => {
  await withTempHome(async (homeDir) => {
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
        "degraded-leg",
        "--brick",
        BRICK_A,
      ],
      homeDir,
      {
        PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
        BRICK_SHIM_MODE: "hang",
      },
    );
    assert.equal(created.code, 0, created.stderr);
    // THE LEG-WAS-ACTUALLY-TAKEN GUARD — without it this row silently
    // degenerates into the healthy-leg row above and proves nothing.
    assert.match(created.stderr, /brick CLI unavailable/, "this row did not take the degraded leg");
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRawSessionRecord(homeDir, id);
    assert.equal(
      (onDisk.metadata as Record<string, unknown> | undefined)?.brick,
      BRICK_A,
      "on the degraded leg the holder's own metadata.brick must still carry --brick",
    );
    const seatId = String(onDisk.seat_id);

    const store = await readRawSeatStore(homeDir);
    assert.equal(
      store[seatId]?.brick_id,
      BRICK_A,
      "F1 (pre-existing, not this brick): the degraded leg must still write the seat's brick_id",
    );
    // THE RED: absent on base (every accepted ref read as indistinguishable
    // from validated there), `false` on fix.
    assert.equal(
      store[seatId]?.brick_id_validated,
      false,
      "RED-ON-BASE: the degraded leg must mark the seat's brick link UNVALIDATED",
    );

    // The CLI-observable surface an operator actually reads — `seats show`.
    const shown = await runCli(
      ["--cwd", cwd, "--format", "json", "seats", "show", seatId],
      homeDir,
    );
    assert.equal(shown.code, 0, shown.stderr);
    const shownJson = JSON.parse(shown.stdout.trim()) as Record<string, unknown>;
    assert.equal(shownJson.brickId, BRICK_A);
    assert.equal(
      shownJson.brickIdValidated,
      false,
      "RED-ON-BASE: `acpx seats show` must report the degraded leg's link as unvalidated",
    );
  });
});

// ─── REFERENCE ARM — the attribution pair, brief §5 ─────────────────────────

test("GREEN-ON-BASE · REFERENCE ARM · a WRONG brick ref is REFUSED when `brick show` resolves cleanly to not-found", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const sessionDir = sessionsDir(homeDir);

    const refused = await runCli(
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
        "reference-arm-not-found",
        "--brick",
        BRICK_WRONG,
      ],
      homeDir,
      { PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`, BRICK_SHIM_MODE: "not-found" },
    );
    // GREEN-ON-BASE: this is TODAY'S accept/refuse behaviour, UNCHANGED by
    // this brick (ROW B is pinned; brick-link.ts's accept/refuse logic is
    // explicitly out of scope). It passes on base and on fix identically —
    // its job is to make the paired row below ATTRIBUTABLE, not to redefine
    // this one.
    assert.notEqual(
      refused.code,
      0,
      "a wrong brick ref was ACCEPTED on the healthy validation leg",
    );
    const said = `${refused.stdout}${refused.stderr}`;
    assert.match(said, /unknown brick/i, "the refusal must say the brick is UNKNOWN");
    const files = await sessionRecordFiles(sessionDir);
    assert.deepEqual(files, [], "a session record was written despite the refusal");
  });
});

test("RED-ON-BASE (validated flag) / GREEN-ON-BASE (acceptance) · REFERENCE ARM · the SAME wrong ref is ACCEPTED UNVALIDATED when `brick show` times out", async () => {
  await withTempHome(async (homeDir) => {
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
        "reference-arm-hang",
        "--brick",
        BRICK_WRONG,
      ],
      homeDir,
      {
        PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
        BRICK_SHIM_MODE: "hang",
      },
    );
    // GREEN-ON-BASE half: the ACCEPTANCE itself is pre-existing behaviour
    // (`acceptUuidWhenBrickCliUnavailable` returns the uuid it was given,
    // untouched by this brick) — this assertion passes on base too. What
    // makes the PAIR meaningful is that the row directly above refuses this
    // exact ref under `not-found` — same ref, opposite leg, opposite result,
    // so the acceptance here is attributably a loss of validation.
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stderr, /brick CLI unavailable/, "this row did not take the degraded leg");
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRawSessionRecord(homeDir, id);
    const seatId = String(onDisk.seat_id);
    const store = await readRawSeatStore(homeDir);
    assert.equal(
      store[seatId]?.brick_id,
      BRICK_WRONG,
      "GREEN-ON-BASE: the degraded leg must still link the ref",
    );
    // RED-ON-BASE half: the validation STATE is the new fact — absent on
    // base, `false` on fix.
    assert.equal(
      store[seatId]?.brick_id_validated,
      false,
      "RED-ON-BASE: the accepted-unvalidated ref must be MARKED unvalidated, not indistinguishable from validated",
    );
  });
});

// ─── inheritance — brief §4(C), invariant (i) ───────────────────────────────

test("RED-ON-BASE · a holder JOINING a seat whose link is UNVALIDATED does not receive it as validated", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const seatId = "c0ffee00-1111-4111-8111-111111111111";
    await writeRawSeatStore(homeDir, {
      [seatId]: rawSeatRow(seatId, { brick_id: BRICK_A, brick_id_validated: false }),
    });

    const joined = await runCli(
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
    assert.equal(joined.code, 0, joined.stderr);
    const id = String(
      (JSON.parse(joined.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRawSessionRecord(homeDir, id);
    const metadata = onDisk.metadata as Record<string, unknown> | undefined;
    assert.equal(metadata?.brick, BRICK_A, "the holder must still receive the seat's ref");
    // THE RED: on base this key never exists at all (`undefined`), so a
    // holder joining an unvalidated seat is INDISTINGUISHABLE from one
    // joining a validated seat — exactly invariant (i)'s violation. On fix
    // it must read the WORD "unvalidated" — a boolean-string would be
    // truthy and tell a careless reader nothing.
    assert.equal(
      metadata?.brick_validation,
      "unvalidated",
      "RED-ON-BASE: a holder joining an UNVALIDATED seat link must carry that state, not launder it",
    );
  });
});

test("RED-ON-BASE · a holder joining a seat whose link IS validated carries the explicit word, not an absence that would be ambiguous with 'unknown'", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const seatId = "c0ffee00-2222-4222-8222-222222222222";
    await writeRawSeatStore(homeDir, {
      [seatId]: rawSeatRow(seatId, { brick_id: BRICK_A, brick_id_validated: true }),
    });

    const joined = await runCli(
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
    assert.equal(joined.code, 0, joined.stderr);
    const id = String(
      (JSON.parse(joined.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRawSessionRecord(homeDir, id);
    const metadata = onDisk.metadata as Record<string, unknown> | undefined;
    assert.equal(metadata?.brick, BRICK_A);
    // THE RED: on base there is no such key at all; a design that OMITTED
    // the word for "validated" (rejected — see session-management.ts's own
    // comment) would make this row pass on base too, for the wrong reason
    // (no key either way) — writing the word UNCONDITIONALLY is what keeps
    // this a real red and what makes "absence means unknown" hold on BOTH
    // sides of the system, not just the seat's.
    assert.equal(
      metadata?.brick_validation,
      "validated",
      "RED-ON-BASE: a holder joining a VALIDATED seat link must carry the explicit word",
    );
  });
});

// ─── legacy row — invariant (ii) ────────────────────────────────────────────

test("RED-ON-BASE · a legacy seat row (brick_id present, brick_id_validated absent) reads as UNVALIDATED, never validated-by-assumption", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const seatId = "1ec0bca7-3333-4333-8333-333333333333";
    // NO `brick_id_validated` key at all — the shape every seat on the
    // fleet has today, predating this brick.
    await writeRawSeatStore(homeDir, {
      [seatId]: rawSeatRow(seatId, { brick_id: BRICK_A }),
    });

    // READ THE FIXTURE'S OWN BYTES BACK BEFORE TRUSTING THE INTERPRETATION
    // BELOW — absence is a CONSTRUCTED input here, and the only way to know
    // the construction actually produced it (rather than the helper having
    // silently written a key its caller never asked for) is to check the
    // bytes, not the builder's intent.
    const plantedRaw = await readRawSeatStore(homeDir);
    assert.equal(
      Object.hasOwn(plantedRaw[seatId] ?? {}, "brick_id_validated"),
      false,
      "fixture precondition: the planted row must NOT carry brick_id_validated — otherwise " +
        "this row tests the present-value path while claiming to test absence",
    );

    const shown = await runCli(
      ["--cwd", cwd, "--format", "json", "seats", "show", seatId],
      homeDir,
    );
    assert.equal(shown.code, 0, shown.stderr);
    const shownJson = JSON.parse(shown.stdout.trim()) as Record<string, unknown>;
    assert.equal(shownJson.brickId, BRICK_A);
    // THE RED: absent (`undefined`) on base — the key does not exist in the
    // response at all — `false` on fix.
    assert.equal(
      shownJson.brickIdValidated,
      false,
      "RED-ON-BASE: a legacy row with no brick_id_validated sibling must read as UNVALIDATED",
    );
  });
});

// ─── (d′) — fill ABSENT links on EXISTING seats, brief §4(E)/§6 ────────────

test("RED-ON-BASE · seats backfill (d′) fills an ABSENT seat brick_id from the active holder's link, marked UNVALIDATED; a PRESENT link beside it is untouched; a second run changes nothing", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const absentSeatId = "f111f111-4444-4444-8444-444444444444";
    const presentSeatId = "f222f222-5555-4555-8555-555555555555";

    await seed(homeDir, [
      makeRecord({
        acpxRecordId: "fill-h1",
        seatId: absentSeatId,
        holderOrdinal: 1,
        holderActive: true,
        metadata: { brick: BRICK_A },
      }),
      makeRecord({
        acpxRecordId: "fill-h2",
        seatId: presentSeatId,
        holderOrdinal: 1,
        holderActive: true,
        metadata: { brick: BRICK_A },
      }),
    ]);
    // The mandatory control (brief's 17:43Z discriminator note): a
    // CONSISTENT row beside the inconsistent one, so a run that (incorrectly)
    // changes 0 rows cannot pass as "idempotent" — it must change exactly 1.
    await writeRawSeatStore(homeDir, {
      [absentSeatId]: rawSeatRow(absentSeatId, { active_holder_id: "fill-h1" }), // brick_id ABSENT
      [presentSeatId]: rawSeatRow(presentSeatId, {
        active_holder_id: "fill-h2",
        brick_id: "99999999-9999-4999-8999-999999999999",
        brick_id_validated: true,
      }),
    });

    const first = await runCli(
      ["--cwd", cwd, "--format", "json", "seats", "backfill", "--apply"],
      homeDir,
    );
    assert.equal(first.code, 0, first.stderr);
    const firstReport = JSON.parse(first.stdout.trim()) as Record<string, unknown>;
    // THE RED: `brickLinksFilled` does not exist in base's report at all
    // (`undefined`), so this is never `1` there; on fix exactly one seat
    // (the absent one) is filled.
    assert.equal(
      firstReport.brickLinksFilled,
      1,
      "RED-ON-BASE: exactly one row (the absent one) must be filled — a 0 here is a FAILURE of (d′), not an idempotent pass",
    );

    const store = await readRawSeatStore(homeDir);
    assert.equal(
      store[absentSeatId]?.brick_id,
      BRICK_A,
      "RED-ON-BASE: the absent link must be filled from the active holder",
    );
    assert.equal(
      store[absentSeatId]?.brick_id_validated,
      false,
      "RED-ON-BASE: a filled link is always UNVALIDATED (R28 (5)) — the backfill validates nothing",
    );
    // BRK2, pre-existing and GREEN-ON-BASE: the present link is untouched.
    assert.equal(store[presentSeatId]?.brick_id, "99999999-9999-4999-8999-999999999999");
    assert.equal(store[presentSeatId]?.brick_id_validated, true);

    // The idempotent re-run — AC4's own property, one field over.
    const second = await runCli(
      ["--cwd", cwd, "--format", "json", "seats", "backfill", "--apply"],
      homeDir,
    );
    assert.equal(second.code, 0, second.stderr);
    const secondReport = JSON.parse(second.stdout.trim()) as Record<string, unknown>;
    assert.equal(
      secondReport.brickLinksFilled,
      0,
      "a re-run over an already-filled store must change zero rows",
    );
  });
});

// ─── seats set-brick — caller-asserted validation, brief (B2′) ─────────────

test("RED-ON-BASE · a BARE `seats set-brick` (no --validated) writes brick_id_validated=false", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const seatId = "5e7b1101-6666-4666-8666-666666666666";
    await writeRawSeatStore(homeDir, { [seatId]: rawSeatRow(seatId) });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "seats", "set-brick", seatId, BRICK_A],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(json.brickId, BRICK_A);
    // THE RED: absent on base, `false` on fix — this verb never resolves
    // the ref itself (shape only), so a bare set must default to UNVALIDATED.
    assert.equal(
      json.brickIdValidated,
      false,
      "RED-ON-BASE: a bare `seats set-brick` must write brick_id_validated=false by default",
    );

    const store = await readRawSeatStore(homeDir);
    assert.equal(store[seatId]?.brick_id_validated, false);
  });
});

test("RED-ON-BASE (flag does not exist pre-fix) · `seats set-brick --validated` asserts the caller already confirmed the ref — writes brick_id_validated=true", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const seatId = "5e7b1101-7777-4777-8777-777777777777";
    await writeRawSeatStore(homeDir, { [seatId]: rawSeatRow(seatId) });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "seats", "set-brick", seatId, BRICK_A, "--validated"],
      homeDir,
    );
    // RED-ON-BASE: `--validated` is an UNREGISTERED option pre-fix, so
    // commander refuses the whole invocation (non-zero exit) there; on fix
    // it succeeds and writes the asserted state.
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(
      json.brickIdValidated,
      true,
      "RED-ON-BASE: --validated must write brick_id_validated=true",
    );
  });
});

test("RED-ON-BASE · `seats set-brick --unset` clears BOTH brick_id and brick_id_validated", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const seatId = "5e7b1101-8888-4888-8888-888888888888";
    // A VALIDATED, present link to start from — if a cleared ref left a
    // stale state flag behind, it would read "validated" about nothing.
    await writeRawSeatStore(homeDir, {
      [seatId]: rawSeatRow(seatId, { brick_id: BRICK_A, brick_id_validated: true }),
    });

    const result = await runCli(
      ["--cwd", cwd, "--format", "json", "seats", "set-brick", seatId, "--unset"],
      homeDir,
    );
    assert.equal(result.code, 0, result.stderr);
    const json = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    assert.equal(json.brickId, null, "--unset must report brickId: null");
    // THE RED: on base there is no `brickIdValidated` key in the JSON
    // response at all (`undefined`); on fix it must be `null` too — not a
    // stale `true` surviving the clear.
    assert.equal(
      json.brickIdValidated,
      null,
      "RED-ON-BASE: --unset must report brickIdValidated: null, not a stale leftover",
    );

    // Absence is the OUTPUT asserted here, not a constructed input — legitimate
    // per its own design (`seatToPersisted` OMITS both keys when absent, never
    // nulls them, so there is no alternative specific-value to assert), and
    // distinguishable from a silently-skipped write: the PRE-state was PRESENT
    // (`brick_id_validated: true`, confirmed planted above), so a write that
    // never ran would still show it present — only a real write produces this
    // absence.
    const store = await readRawSeatStore(homeDir);
    assert.equal(
      Object.hasOwn(store[seatId] ?? {}, "brick_id"),
      false,
      "brick_id must be gone from disk",
    );
    assert.equal(
      Object.hasOwn(store[seatId] ?? {}, "brick_id_validated"),
      false,
      "RED-ON-BASE: brick_id_validated must be gone from disk too — not left behind as a stale true",
    );
  });
});

test("GREEN-ON-BASE (BRK2 stands) · a seat whose link is ALREADY PRESENT — validated or not — is untouched by a backfill run", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const seatId = "f333f333-6666-4666-8666-666666666666";

    await seed(homeDir, [
      makeRecord({
        acpxRecordId: "present-h1",
        seatId,
        holderOrdinal: 1,
        holderActive: true,
        // Disagrees with the stored link, same discipline as the
        // pre-existing BRK2 unit test — proves the row is untouched even
        // when a holder would derive something different.
        metadata: { brick: BRICK_WRONG },
      }),
    ]);
    await writeRawSeatStore(homeDir, {
      [seatId]: rawSeatRow(seatId, {
        active_holder_id: "present-h1",
        brick_id: BRICK_A,
        brick_id_validated: true,
      }),
    });

    const report = await runCli(
      ["--cwd", cwd, "--format", "json", "seats", "backfill", "--apply"],
      homeDir,
    );
    assert.equal(report.code, 0, report.stderr);
    const json = JSON.parse(report.stdout.trim()) as Record<string, unknown>;
    // GREEN-ON-BASE: BRK2 (pre-existing, brick 3dff714d) already refuses to
    // touch a present link — this passes on both trees. Its job here is to
    // be the CONTROL beside the RED-ON-BASE fill row above: "filled
    // nothing" (this row) must stay distinguishable from "nothing needed
    // filling" (that row's second-run assertion).
    assert.equal(json.brickLinksFilled ?? 0, 0, "a present link must never be counted as filled");

    const store = await readRawSeatStore(homeDir);
    assert.equal(store[seatId]?.brick_id, BRICK_A, "BRK2: the present ref must be untouched");
    assert.equal(
      store[seatId]?.brick_id_validated,
      true,
      "BRK2: the present validation state must be untouched",
    );
  });
});

// ─── TE Finding 2 + Gap B — the MINT path's own strip/write, brief follow-up ──

test("mint path strips a FORGED inbound brick_validation (degraded leg) — the holder's own record must not launder it", async () => {
  await withTempHome(async (homeDir) => {
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
        "mint-forged-degraded",
        "--brick",
        BRICK_A,
        // THE ATTACK: an operator-supplied --metadata claiming "validated"
        // on a leg that is actually degraded. If this survives unstripped,
        // the holder's own record would present an unvalidated ref as
        // validated — the exact laundering invariant (i) exists to stop.
        "--metadata",
        "brick_validation=validated",
      ],
      homeDir,
      {
        PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
        BRICK_SHIM_MODE: "hang",
      },
    );
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stderr, /brick CLI unavailable/, "this row did not take the degraded leg");
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRawSessionRecord(homeDir, id);
    const metadata = onDisk.metadata as Record<string, unknown> | undefined;
    assert.equal(metadata?.brick, BRICK_A);
    assert.equal(
      metadata?.brick_validation,
      "unvalidated",
      "the forged 'validated' must be stripped and replaced with the TRUE state, not pass through",
    );

    // Same fact, from the other write path — the seat itself must also be
    // unvalidated, so the holder and the seat agree.
    const seatId = String(onDisk.seat_id);
    const store = await readRawSeatStore(homeDir);
    assert.equal(store[seatId]?.brick_id_validated, false);
  });
});

test("mint path WRITES brick_validation on the FOUNDING holder when the state is known (healthy leg) — not just on a joining holder", async () => {
  await withTempHome(async (homeDir) => {
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
        "mint-writes-word",
        "--brick",
        BRICK_A,
      ],
      homeDir,
      {
        PATH: `${BRICK_SHIM_DIR}:${process.env.PATH ?? ""}`,
        BRICK_SHIM_MODE: "ok",
        BRICK_SHIM_ID: BRICK_A,
      },
    );
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRawSessionRecord(homeDir, id);
    const metadata = onDisk.metadata as Record<string, unknown> | undefined;
    // Before this repair, a FOUNDING holder's own metadata never carried
    // brick_validation at all (only a JOINING holder did) — absence there
    // was ambiguous with "predates this brick" rather than "known
    // validated". Gap B closes that: the founding holder gets the word too.
    assert.equal(
      metadata?.brick_validation,
      "validated",
      "the founding holder must carry the word on the healthy leg, exactly as a joining holder does",
    );
  });
});

test("mint path strips a forged brick_validation even when there is NO brick at all for this spawn", async () => {
  await withTempHome(async (homeDir) => {
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
        "mint-no-brick-forged",
        "--metadata",
        "brick_validation=validated",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRawSessionRecord(homeDir, id);
    const metadata = onDisk.metadata as Record<string, unknown> | undefined;
    assert.equal(metadata?.brick, undefined, "fixture sanity: no brick was ever given");
    assert.equal(
      Object.hasOwn(metadata ?? {}, "brick_validation"),
      false,
      "a forged brick_validation with NO ref at all must be stripped, not left standing about nothing",
    );
  });
});

// ─── TE Gap C — an empty-string brick_id must not become a truthy link ─────

test("Gap C · a hand-written seat row with brick_id:'' reads as NO LINK, never a truthy-but-empty one", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const seatId = "9a900000-9999-4999-8999-999999999999";
    await writeRawSeatStore(homeDir, {
      [seatId]: rawSeatRow(seatId, { brick_id: "", brick_id_validated: true }),
    });

    const shown = await runCli(
      ["--cwd", cwd, "--format", "json", "seats", "show", seatId],
      homeDir,
    );
    assert.equal(shown.code, 0, shown.stderr);
    const shownJson = JSON.parse(shown.stdout.trim()) as Record<string, unknown>;
    assert.equal(
      shownJson.brickId,
      null,
      "an empty-string ref must read as NO link, not a truthy one",
    );
    assert.equal(
      shownJson.brickIdValidated,
      null,
      "with no link at all, the validation state must read null too — nothing to describe",
    );
  });
});

test("Gap C · (d′) can fill a seat row whose brick_id was the empty string — it must be treated as ABSENT", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const seatId = "9a900000-8888-4888-8888-888888888888";

    await seed(homeDir, [
      makeRecord({
        acpxRecordId: "gapc-h1",
        seatId,
        holderOrdinal: 1,
        holderActive: true,
        metadata: { brick: BRICK_A },
      }),
    ]);
    await writeRawSeatStore(homeDir, {
      [seatId]: rawSeatRow(seatId, { active_holder_id: "gapc-h1", brick_id: "" }),
    });

    const report = await runCli(
      ["--cwd", cwd, "--format", "json", "seats", "backfill", "--apply"],
      homeDir,
    );
    assert.equal(report.code, 0, report.stderr);
    const json = JSON.parse(report.stdout.trim()) as Record<string, unknown>;
    assert.equal(
      json.brickLinksFilled,
      1,
      "an empty-string brick_id must be treated as ABSENT and therefore fillable — before this fix it " +
        "was permanently blind to this row because '' !== undefined",
    );

    const store = await readRawSeatStore(homeDir);
    assert.equal(store[seatId]?.brick_id, BRICK_A);
    assert.equal(store[seatId]?.brick_id_validated, false);
  });
});

test("Gap C · a WHITESPACE-ONLY brick_id ('   ') reads as NO LINK too, and does not break seats list's column alignment", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const seatId = "9a900000-7777-4777-8777-777777777777";
    await writeRawSeatStore(homeDir, {
      [seatId]: rawSeatRow(seatId, { brick_id: "   ", brick_id_validated: true }),
    });

    const shown = await runCli(
      ["--cwd", cwd, "--format", "json", "seats", "show", seatId],
      homeDir,
    );
    assert.equal(shown.code, 0, shown.stderr);
    const shownJson = JSON.parse(shown.stdout.trim()) as Record<string, unknown>;
    assert.equal(
      shownJson.brickId,
      null,
      "whitespace-only must read as NO link, same as empty string",
    );
    assert.equal(shownJson.brickIdValidated, null);

    const listed = await runCli(["--cwd", cwd, "--format", "json", "seats", "list"], homeDir);
    assert.equal(listed.code, 0, listed.stderr);
    const seats = (
      JSON.parse(listed.stdout.trim()) as { seats: { seatId: string; brickId: unknown }[] }
    ).seats;
    const row = seats.find((entry) => entry.seatId === seatId);
    assert.equal(
      row?.brickId,
      null,
      "seats list must agree with seats show, not render stray whitespace",
    );
  });
});

test("explicit --no-brick on a fresh mint writes no brick_validation at all — absence is the correct state when there is no link", async () => {
  await withTempHome(async (homeDir) => {
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
        "mint-no-brick-flag",
        "--no-brick",
        "--metadata",
        "brick_validation=validated",
      ],
      homeDir,
    );
    assert.equal(created.code, 0, created.stderr);
    const id = String(
      (JSON.parse(created.stdout.trim()) as { acpxRecordId?: unknown }).acpxRecordId,
    );
    const onDisk = await readRawSessionRecord(homeDir, id);
    const metadata = onDisk.metadata as Record<string, unknown> | undefined;
    assert.equal(metadata?.brick, undefined, "fixture sanity: --no-brick must leave no ref at all");
    // THE ASYMMETRY, DELIBERATE: this is the one case where absence IS the
    // correct, specific state — there is genuinely nothing to say about a
    // link that does not exist, so there is no alternative specific value
    // to assert instead of absence.
    assert.equal(
      Object.hasOwn(metadata ?? {}, "brick_validation"),
      false,
      "--no-brick must never manufacture a validation claim about a link that does not exist",
    );
  });
});
