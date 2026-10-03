import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { revalidateBeforeApply } from "../src/session/archive/move.js";
import {
  listSessionRecordFiles,
  toSessionIndexEntry,
  writeSessionIndex,
} from "../src/session/persistence/index.js";
import { parseSessionRecord } from "../src/session/persistence/parse.js";
import {
  backfillSeatRow,
  parseSeatFromPersisted,
  readSeatStore,
  SEAT_STORE_FILE,
  SeatStoreUnwritableError,
} from "../src/session/persistence/seat-store.js";
import { countStaleSeatIndexEntries, SEAT_BACKFILL_NOTES } from "../src/session/seat-backfill.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

/**
 * B10 — `acpx seats backfill`. Brick `f65262c1`, the conception ruling of
 * 2026-09-29, and the acceptance rows of that brick's `plan/PLAN.md` §6.
 *
 * ## 🛑 AC16 GOVERNS: EVERY ROW DRIVES THE REAL CLI AGAINST AN ISOLATED RIG
 *
 * A unit test proves REGISTRATION, not that the shipped binary answers `acpx seats
 * backfill` — and the latter is the subject. Every legitimate and every refusal row
 * below spawns the compiled CLI with its own `HOME` and `ACPX_STATE_HOME`, exactly
 * as `seat-creation-paths.test.ts` does. The few in-process rows are supplementary
 * and say so.
 *
 * **`--apply` is NEVER run against a real box store.** Every rig is a temp home; the
 * shared `assertTempHomePath` guard in `runtime-test-helpers.ts` makes that
 * structural rather than remembered.
 *
 * ## The red arm — expectation inversion, never a broken guard
 *
 * Mutation testing is forbidden fleet-wide (Daniel, 2026-09-22), so no row here was
 * proven by gutting a guard in `src/`. Where a property could be expressed as a
 * COMMITTED negative case it is one — permanently red if the policy is removed,
 * which is strictly stronger than a one-time demonstration and what most of the rows
 * below rely on.
 *
 * Four rows whose subject is an EQUALITY were additionally falsified by flipping the
 * expected value in THIS FILE, running this file alone, confirming the row FAILED,
 * and reverting. Measured 2026-09-29, all four inverted in one run: **26 tests, 22
 * pass, 4 fail — exactly the four inverted rows and no others.** The observation is
 * repeated at each row, because a demonstrated mechanism does not transfer its
 * validity to the next row that invokes it.
 *
 *   L1  `diffNames(before, after)` `[]` → `["INVERTED"]`  → failed
 *   L3  `second.seats` `0` → `1`                          → failed
 *   L5  `row.nextOrdinal` `4` → `2`                       → failed
 *   L13 `report.indexEntries` `1` → `0`                   → failed
 *
 * 🔑 L5's inversion is the one worth reading twice: `2` is not an arbitrary wrong
 * answer, it is the value a hard-coded `next_ordinal` would produce, and it passes
 * against every seat on every live box. The row fails on it, so the row discriminates
 * the defect it exists for rather than merely being non-vacuous.
 *
 * **L19 was falsified differently and more strongly — by a (b′) TRANSPLANTED-TEST ARM
 * against the real committed pre-fix tree `c7ee352`, with the test file copied in
 * because the row postdates that tree. Its own comment carries the claim, the
 * disclosure that earns it, and the measurement.**
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

type CliResult = { code: number | null; stdout: string; stderr: string };

/**
 * Spawn the CLI and hand back the child, for a row that must interrupt it.
 *
 * ⚠️ NO EXPLICIT RETURN TYPE, DELIBERATELY. Annotating this `ReturnType<typeof spawn>`
 * widens it to `ChildProcess`, whose `stdout`/`stderr` are `Readable | null` — and
 * `pnpm run typecheck` DOES NOT CATCH THAT, because it is a different tsconfig from
 * `build:test`. Measured: typecheck green, `build:test` red with TS18047, and
 * `node --test` then ran happily against the emitted-anyway JS. The inferred
 * `ChildProcessByStdio` from the literal `stdio` tuple is what makes the streams
 * non-null at every call site.
 */
function spawnCli(args: string[], homeDir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
  for (const key of CHILD_ENV_SCRUB) {
    delete env[key];
  }
  return spawn(process.execPath, [CLI_PATH, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
}

/**
 * Ambient session context a child must not inherit — the same scrub list
 * `seat-creation-paths.test.ts` and `session-reparent.test.ts` use. Without it a
 * child can silently acquire the TEST RUNNER's own session as ambient context.
 */
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

/**
 * Drive the REAL compiled CLI against a rig home.
 *
 * Same scrub list as `seat-creation-paths.test.ts` / `session-reparent.test.ts`: a
 * child built without it can silently acquire the TEST RUNNER's own session as
 * ambient context. `HOME` and `ACPX_STATE_HOME` are both pinned because
 * `sessionBaseDir()` reads `ACPX_STATE_HOME || os.homedir()` and the first WINS —
 * pinning one leaves the store resolution to the other.
 */
function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawnCli(args, homeDir);
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

type BackfillJson = {
  apply: boolean;
  recordsScanned: number;
  recordsSeated: number;
  seats: number;
  indexEntries: number;
  recordsWithoutIndexEntry: number;
  rowsRepaired: number;
  favoritesMigrated: number;
  brickLinksFilled: number;
  activeHoldersFilled: number;
  holderMirrorsSet: number;
  errors: { file: string; stage: string; code?: string; message: string }[];
  backupSuffix?: string;
  backups: string[];
  staleIndexEntries: number;
  notes: string[];
  sweep: { scanned: number; closed: string[]; notMeasured: boolean };
};

async function backfill(homeDir: string, extra: string[] = []): Promise<BackfillJson> {
  const result = await runCli(["seats", "backfill", "--format", "json", ...extra], homeDir);
  assert.equal(result.code, 0, `seats backfill exited ${result.code}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim()) as BackfillJson;
}

function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  return withTempHomeFixture("acpx-seat-backfill-", run);
}

function sessionsDir(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

let recordSeq = 0;

function makeRecord(overrides: Partial<SessionRecord> & { acpxRecordId: string }): SessionRecord {
  recordSeq += 1;
  return makeSessionRecordFixture({
    acpSessionId: `acp-${overrides.acpxRecordId}`,
    agentCommand: "node agent.js",
    cwd: "/tmp/rig",
    // Distinct, so `writeSessionIndex`'s lastUsedAt sort is deterministic.
    lastUsedAt: `2026-01-01T00:00:${String(recordSeq % 60).padStart(2, "0")}.000Z`,
    ...overrides,
  });
}

async function seed(homeDir: string, records: readonly SessionRecord[]): Promise<void> {
  for (const record of records) {
    await writeSessionRecordFile(homeDir, record);
  }
  await rebuildRigIndex(homeDir);
}

/** The rig's `index.json`, projected the way acpx projects it. Deliberately built
 * from the records ON DISK rather than from the in-memory fixtures: the index this
 * verb enriches is the one a real box has, entries and all. */
async function rebuildRigIndex(homeDir: string): Promise<void> {
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

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

/** Every file in the store, by content hash. The instrument for every
 * byte-identical row. */
async function snapshot(homeDir: string): Promise<Map<string, string>> {
  const dir = sessionsDir(homeDir);
  const out = new Map<string, string>();
  for (const name of (await fs.readdir(dir)).toSorted()) {
    out.set(name, await sha256(path.join(dir, name)));
  }
  return out;
}

function diffNames(before: Map<string, string>, after: Map<string, string>): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).toSorted();
}

async function readIndexEntries(homeDir: string): Promise<Map<string, Record<string, unknown>>> {
  const payload = JSON.parse(
    await fs.readFile(path.join(sessionsDir(homeDir), "index.json"), "utf8"),
  ) as { entries: Record<string, unknown>[] };
  return new Map(payload.entries.map((entry) => [String(entry.file), entry]));
}

async function readRecordJson(homeDir: string, id: string): Promise<Record<string, unknown>> {
  const file = path.join(sessionsDir(homeDir), `${encodeURIComponent(id)}.json`);
  return JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
}

async function readRawStore(homeDir: string): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(
    await fs.readFile(path.join(sessionsDir(homeDir), SEAT_STORE_FILE), "utf8"),
  ) as Record<string, Record<string, unknown>>;
}

// ─── IR — the verb is answered by the SHIPPED binary ─────────────────────────

test("IR: `acpx seats backfill` is a registered verb, not an agent-name fall-through", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "ir-1" })]);
    const result = await runCli(["seats", "backfill", "--format", "json"], homeDir);
    // ⚠️ THE CONTROL STRING, NOT THE EXIT CODE. An unregistered token is absorbed by
    // the agent catch-all, whose rc is cwd-dependent and therefore sound in neither
    // direction (`cli-core.ts`'s own warning on TOP_LEVEL_VERBS). `No acpx session
    // found` is what that fall-through prints, and it must be ABSENT.
    assert.equal(
      `${result.stdout}${result.stderr}`.includes("No acpx session found"),
      false,
      "`seats` fell through to the agent registry — TOP_LEVEL_VERBS is missing the entry",
    );
    assert.equal(result.code, 0, result.stderr);
  });
});

test("IR: a bogus subverb ERRORS — it does not become a prompt", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "ir-2" })]);
    const result = await runCli(["seats", "zzznotaverb"], homeDir);
    assert.notEqual(result.code, 0, "a bogus subverb must not succeed");
    assert.equal(
      `${result.stdout}${result.stderr}`.includes("No acpx session found"),
      false,
      "the bogus subverb reached the agent catch-all",
    );
  });
});

// ─── L1 — dry run is the default and it touches NOTHING ──────────────────────

test("L1: the DEFAULT is a dry run — counts reported, store byte-identical", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [
      makeRecord({ acpxRecordId: "l1-a" }),
      makeRecord({ acpxRecordId: "l1-b" }),
    ]);
    const before = await snapshot(homeDir);

    const report = await backfill(homeDir);

    assert.equal(report.apply, false, "the default must be a dry run");
    assert.equal(report.recordsScanned, 2);
    assert.equal(report.seats, 2, "one seat per seat-less record");
    assert.equal(report.indexEntries, 2);
    assert.equal(report.errors.length, 0);

    // 🔑 THE ROW'S SUBJECT. Inverted 2026-09-29 (flipped to `deepEqual(diff, ["x"])`)
    // and this file alone re-run: the row FAILED as required, then reverted.
    const after = await snapshot(homeDir);
    assert.deepEqual(diffNames(before, after), [], "a dry run wrote to the store");
    assert.equal(
      after.has(SEAT_STORE_FILE),
      false,
      "a dry run CREATED seats.json — the absent store must stay absent",
    );
  });
});

// ─── L2 — apply, from an ABSENT store ────────────────────────────────────────

test("L2: --apply mints the seats, enriches the entries and CREATES an absent store", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [
      makeRecord({ acpxRecordId: "l2-a", legacyName: "alpha" }),
      makeRecord({ acpxRecordId: "l2-b", legacyName: "beta", closed: true }),
    ]);
    // The control for the "creates an ABSENT store" claim: it really is absent first.
    assert.equal((await readSeatStore(sessionsDir(homeDir))).fileState, "absent");

    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.apply, true);
    assert.equal(report.seats, 2);
    assert.equal(report.recordsSeated, 2);
    assert.equal(report.indexEntries, 2);
    assert.equal(report.errors.length, 0);

    const store = await readSeatStore(sessionsDir(homeDir));
    assert.equal(store.fileState, "ok");
    assert.equal(store.seats.size, 2);

    const open = await readRecordJson(homeDir, "l2-a");
    const closed = await readRecordJson(homeDir, "l2-b");
    assert.equal(typeof open.seat_id, "string");
    assert.equal(open.holder_ordinal, 1);
    assert.equal(open.holder_active, true);
    // A CLOSED session keeps holding its seat (D-SEAT-HOLD, brick `eca085bb`): the
    // holder mirror is true and the row's active holder names it, while `closed_at`
    // stays null — a close ends nothing on the seat.
    assert.equal(closed.holder_active, true);
    const closedRow = store.seats.get(String(closed.seat_id));
    assert.equal(closedRow?.activeHolderId, "l2-b");
    assert.equal(closedRow?.closedAt, null);
    assert.equal(store.seats.get(String(open.seat_id))?.activeHolderId, "l2-a");

    // The entries carry the same group the records do — the leg-2 subject.
    const entries = await readIndexEntries(homeDir);
    assert.equal(entries.get("l2-a.json")?.seatId, open.seat_id);
    assert.equal(entries.get("l2-b.json")?.seatId, closed.seat_id);
    assert.equal(entries.get("l2-b.json")?.holderActive, true);
  });
});

test("L2b: the record leg changes the SEAT GROUP and nothing else", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "l2b", legacyName: "kept", favorite: true })]);
    const before = await readRecordJson(homeDir, "l2b");

    await backfill(homeDir, ["--apply"]);

    const after = await readRecordJson(homeDir, "l2b");
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .toSorted();
    // A completeness claim by CONSTRUCTION rather than by spot-check: every key of
    // both objects is compared, so a field this write silently drops shows up here.
    assert.deepEqual(changed, ["holder_active", "holder_ordinal", "seat_id"]);
  });
});

// ─── L3 — idempotent: apply, then apply ──────────────────────────────────────

test("L3: a second --apply reports 0 and leaves the store byte-identical", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [
      makeRecord({ acpxRecordId: "l3-a" }),
      makeRecord({ acpxRecordId: "l3-b" }),
    ]);
    const first = await backfill(homeDir, ["--apply"]);
    assert.equal(first.seats, 2, "control: the FIRST apply must actually mint something");

    const afterFirst = await snapshot(homeDir);
    const second = await backfill(homeDir, ["--apply"]);

    assert.equal(second.seats, 0, "the second apply minted a seat");
    assert.equal(second.recordsSeated, 0);
    assert.equal(second.indexEntries, 0);
    assert.equal(second.errors.length, 0);

    // 🔑 THE ROW'S SUBJECT. Inverted 2026-09-29 (`second.seats` expected 1) and this
    // file alone re-run: the row FAILED as required, then reverted.
    const afterSecond = await snapshot(homeDir);
    const changed = diffNames(afterFirst, afterSecond).filter(
      // The second run takes its own rollback copies; those are NEW files, not
      // changes to the store, and excluding them is what the row is about.
      (name) => !name.includes(".bak-mig-"),
    );
    assert.deepEqual(changed, [], "the second apply rewrote part of the store");
  });
});

// ─── L4 — the MIXED population, which is the live shape ──────────────────────

test("L4: already-seated records and their entries are left BYTE-IDENTICAL", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [
      makeRecord({
        acpxRecordId: "l4-seated",
        seatId: "11111111-2222-3333-4444-555555555555",
        holderOrdinal: 1,
        holderActive: true,
      }),
      makeRecord({ acpxRecordId: "l4-bare" }),
    ]);
    // Its row already exists, so nothing about this seat needs repairing either.
    await backfillSeatRow(sessionsDir(homeDir), {
      seatId: "11111111-2222-3333-4444-555555555555",
      createdAt: "2026-01-01T00:00:00.000Z",
      activeHolderId: "l4-seated",
      nextOrdinal: 2,
      closedAt: null,
      name: undefined,
      brickId: undefined,
      favorite: false,
    });
    const seatedBefore = await sha256(path.join(sessionsDir(homeDir), "l4-seated.json"));

    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.seats, 1, "only the unseated record's seat is minted");
    assert.equal(report.recordsSeated, 1);
    assert.equal(report.indexEntries, 1, "the already-correct entry must not be rewritten");

    assert.equal(
      await sha256(path.join(sessionsDir(homeDir), "l4-seated.json")),
      seatedBefore,
      "an already-seated record was rewritten",
    );
    const store = await readSeatStore(sessionsDir(homeDir));
    assert.equal(store.seats.size, 2);
    assert.equal(store.seats.get("11111111-2222-3333-4444-555555555555")?.nextOrdinal, 2);
  });
});

// ─── L5 — next_ordinal is DERIVED, never a constant ──────────────────────────

test("L5: next_ordinal = max(holder_ordinal)+1 over the seat's records, not 2", async () => {
  await withTempHome(async (homeDir) => {
    const seatId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    // No live specimen of a multi-holder seat exists on any box today — every
    // existing seat has exactly one holder, so a hard-coded `2` passes against LIVE
    // DATA. This synthetic rig is the only thing that can falsify the rule, which is
    // precisely why the rule is tested here and not on a census.
    await seed(homeDir, [
      makeRecord({
        acpxRecordId: "l5-h1",
        seatId,
        holderOrdinal: 1,
        holderActive: false,
        closed: true,
      }),
      makeRecord({
        acpxRecordId: "l5-h2",
        seatId,
        holderOrdinal: 2,
        holderActive: false,
        closed: true,
      }),
      makeRecord({ acpxRecordId: "l5-h3", seatId, holderOrdinal: 3, holderActive: true }),
    ]);

    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.seats, 1, "three holders, ONE row");
    assert.equal(report.rowsRepaired, 1, "the seat already existed on the records — a repair");

    const row = (await readSeatStore(sessionsDir(homeDir))).seats.get(seatId);
    // 🔑 THE ROW'S SUBJECT. Inverted 2026-09-29 to the exact value a hard-coded
    // `next_ordinal` would produce (`2`) and this file alone re-run: the row FAILED
    // as required, then reverted. So it discriminates the defect, not just any value.
    assert.equal(row?.nextOrdinal, 4, "next_ordinal was not derived from the holders");
    assert.notEqual(row?.nextOrdinal, 2, "a constant 2 would pass on every live seat");
    assert.equal(row?.activeHolderId, "l5-h3", "the OPEN, active holder must be the pointer");
  });
});

// ─── L6 / R2 — closed_at is PRESENT and null ─────────────────────────────────

test("L6: a seat whose holders are all closed keeps the closed holder, `null` closed_at — PRESENT", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "l6", closed: true })]);
    await backfill(homeDir, ["--apply"]);

    const raw = await readRawStore(homeDir);
    const [row] = Object.values(raw);
    assert.equal(row.active_holder_id, "l6", "a closed holder keeps holding its seat");
    assert.equal("closed_at" in row, true, "closed_at was OMITTED — the store rejects such a row");
    assert.equal(row.closed_at, null, "a backfilled seat reads NOT CLOSED");
    // `name`/`brick_id` are the only omit-when-unset fields; `brick attach` is not
    // this pass, so `brick_id` must be absent rather than null.
    assert.equal("brick_id" in row, false);
  });
});

test("R2: a row with closed_at ABSENT is malformed — the committed negative case", () => {
  const withKey = {
    seat_id: "s",
    created_at: "t",
    active_holder_id: null,
    next_ordinal: 2,
    closed_at: null,
  };
  // C1 — the control produces a NON-zero result first: the identical row WITH the
  // key parses. Without it the rejection below would prove nothing.
  assert.notEqual(parseSeatFromPersisted(withKey), undefined);
  const { closed_at: _omitted, ...withoutKey } = withKey;
  assert.equal(
    parseSeatFromPersisted(withoutKey),
    undefined,
    "hasValidRequiredSeatFields accepted a row with closed_at absent",
  );
});

test("R2b: the backfill REFUSES to overwrite a malformed ROW and carries it verbatim", async () => {
  await withTempHome(async (homeDir) => {
    const seatId = "dddddddd-eeee-ffff-0000-111111111111";
    await seed(homeDir, [
      makeRecord({ acpxRecordId: "r2b", seatId, holderOrdinal: 1, holderActive: true }),
    ]);
    // A row present and unreadable: `closed_at` absent. The FILE is fine, so this is
    // not the R1/R4 refusal — it is the row-scoped one, and the two must not collapse.
    const storePath = path.join(sessionsDir(homeDir), SEAT_STORE_FILE);
    const corruptRow = { seat_id: seatId, created_at: "2026-01-01T00:00:00.000Z", next_ordinal: 2 };
    await fs.writeFile(storePath, `${JSON.stringify({ [seatId]: corruptRow })}\n`, "utf8");

    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.seats, 0, "a malformed row must not be minted over");
    assert.equal(report.errors.length, 1);
    assert.equal(
      report.errors[0]?.stage,
      "store",
      "the failing LEG must be named, not just 'it failed'",
    );
    assert.match(
      report.errors[0]?.message ?? "",
      /PRESENT in the seat store \/\S+seats\.json but its row is malformed/,
      "the refusal must be MalformedSeatRowError, not a generic throw",
    );
    // The `--format json` payload (this row drives the real CLI via `backfill()`,
    // which always passes `--format json`) must carry a STABLE, machine-readable
    // code — not leave a caller to string-match the prose above. `SEAT_ROW_MALFORMED`
    // is the code B2b already emits for this same condition; reused, not re-coined.
    assert.equal(
      report.errors[0]?.code,
      "SEAT_ROW_MALFORMED",
      "the malformed-row error must carry a stable machine-readable code",
    );
    assert.deepEqual(
      await readRawStore(homeDir),
      { [seatId]: corruptRow },
      "the malformed row must be carried EXACTLY as read",
    );
  });
});

// ─── D-STAR item 3 — the one-time `favorite` migration (brick 6adabe72) ──────

test("FAV1: a FRESHLY-MINTED seat's favorite = any holder's favorite — the disagreeing fixture", async () => {
  // 🛑 THE DISAGREEMENT IS THE POINT (AC2). A fixture where every holder agreed
  // would pass on ANY implementation, including one that reads only the first
  // holder — so this fixture deliberately carries one `true`, one explicit
  // `false`, and one holder with no `favorite` at all.
  await withTempHome(async (homeDir) => {
    const seatId = "fafafafa-1111-4111-8111-111111111111";
    // No existing row: this exercises `planSeatRow`'s mint-time computation.
    await seed(homeDir, [
      makeRecord({ acpxRecordId: "fav1-h1", seatId, holderOrdinal: 1, favorite: true }),
      makeRecord({ acpxRecordId: "fav1-h2", seatId, holderOrdinal: 2, favorite: false }),
      makeRecord({ acpxRecordId: "fav1-h3", seatId, holderOrdinal: 3, favorite: undefined }),
    ]);

    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.seats, 1);

    const row = (await readSeatStore(sessionsDir(homeDir))).seats.get(seatId);
    assert.equal(row?.favorite, true, "any holder's favorite must win");
  });
});

test("FAV2: an EXISTING seat row is MIGRATED — favorite disagreed with the holders and is corrected", async () => {
  await withTempHome(async (homeDir) => {
    const seatId = "fafafafa-2222-4222-8222-222222222222";
    await seed(homeDir, [
      makeRecord({ acpxRecordId: "fav2-h1", seatId, holderOrdinal: 1, favorite: false }),
      makeRecord({ acpxRecordId: "fav2-h2", seatId, holderOrdinal: 2, favorite: true }),
    ]);
    // Plant the row EXACTLY as it exists pre-migration: `favorite: false`, the
    // default for every seat this store has never migrated.
    await backfillSeatRow(sessionsDir(homeDir), {
      seatId,
      createdAt: "2026-01-01T00:00:00.000Z",
      activeHolderId: "fav2-h2",
      nextOrdinal: 3,
      closedAt: null,
      name: undefined,
      brickId: undefined,
      favorite: false,
    });

    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.seats, 0, "the row already existed — this run mints nothing");
    assert.equal(report.favoritesMigrated, 1, "the disagreement must be counted and corrected");

    const row = (await readSeatStore(sessionsDir(homeDir))).seats.get(seatId);
    assert.equal(row?.favorite, true);
    assert.equal(row?.activeHolderId, "fav2-h2", "the migration touches favorite and nothing else");
  });
});

test("FAV3: AC4 — a second --apply touches ZERO rows, with a positive control that the counter can see a change", async () => {
  await withTempHome(async (homeDir) => {
    const seatId = "fafafafa-3333-4333-8333-333333333333";
    await seed(homeDir, [
      makeRecord({ acpxRecordId: "fav3-h1", seatId, holderOrdinal: 1, favorite: true }),
    ]);
    await backfillSeatRow(sessionsDir(homeDir), {
      seatId,
      createdAt: "2026-01-01T00:00:00.000Z",
      activeHolderId: "fav3-h1",
      nextOrdinal: 2,
      closedAt: null,
      name: undefined,
      brickId: undefined,
      favorite: false,
    });

    // POSITIVE CONTROL: the first run proves the counter is capable of seeing a
    // change at all — a counter that always reads 0 would pass the re-run
    // assertion below for the wrong reason.
    const first = await backfill(homeDir, ["--apply"]);
    assert.equal(first.favoritesMigrated, 1, "control: the counter must see this real change");

    const bytes = await fs.readFile(path.join(sessionsDir(homeDir), SEAT_STORE_FILE), "utf8");
    const second = await backfill(homeDir, ["--apply"]);
    assert.equal(second.favoritesMigrated, 0, "AC4: re-run touches zero rows");
    assert.equal(
      await fs.readFile(path.join(sessionsDir(homeDir), SEAT_STORE_FILE), "utf8"),
      bytes,
      "a re-run with nothing to migrate must not rewrite the store",
    );
  });
});

test("FAV4: a DRY RUN reports favoritesMigrated without writing anything", async () => {
  await withTempHome(async (homeDir) => {
    const seatId = "fafafafa-4444-4444-8444-444444444444";
    await seed(homeDir, [
      makeRecord({ acpxRecordId: "fav4-h1", seatId, holderOrdinal: 1, favorite: true }),
    ]);
    await backfillSeatRow(sessionsDir(homeDir), {
      seatId,
      createdAt: "2026-01-01T00:00:00.000Z",
      activeHolderId: "fav4-h1",
      nextOrdinal: 2,
      closedAt: null,
      name: undefined,
      brickId: undefined,
      favorite: false,
    });
    const before = await readRawStore(homeDir);

    const report = await backfill(homeDir);
    assert.equal(report.apply, false);
    assert.equal(report.favoritesMigrated, 1, "the dry run must still COUNT the pending migration");
    assert.deepEqual(await readRawStore(homeDir), before, "a dry run must touch nothing");
  });
});

test("FAV5: a row with NO favorite key at all (real pre-migration shape) is migrated even when every holder computes to false", async () => {
  // 🛑 THE TRI-STATE REGRESSION THIS ROW GUARDS. Under the coercion-to-false bug
  // (caught by the L0 2026-09-30T23:39Z, brick `6adabe72`), a not-yet-migrated
  // row's `favorite` read as `false` — identical to the value every holder here
  // computes — so `favoriteNeedsMigration` compared `false !== false` and NEVER
  // flagged the seat. The row stayed ambiguous ("not yet migrated" vs
  // "explicitly un-starred") forever, because its computed answer happened to
  // agree with the coerced one. With the tri-state fix, an absent key reads as
  // `undefined`, `undefined !== false` is true, and the migration fires —
  // converting the ambiguous state into an explicit, on-disk `false`.
  await withTempHome(async (homeDir) => {
    const seatId = "fafafafa-5555-4555-8555-555555555555";
    await seed(homeDir, [
      // No holder here has `favorite: true` — the computed answer is `false`.
      makeRecord({ acpxRecordId: "fav5-h1", seatId, holderOrdinal: 1 }),
    ]);
    // Plant the row with the REAL pre-migration shape: every other field present,
    // no `favorite` key whatsoever — not even an explicit `false`.
    const dir = sessionsDir(homeDir);
    const preMigrationRow = {
      seat_id: seatId,
      created_at: "2026-01-01T00:00:00.000Z",
      active_holder_id: "fav5-h1",
      next_ordinal: 2,
      closed_at: null,
    };
    await fs.writeFile(
      path.join(dir, SEAT_STORE_FILE),
      `${JSON.stringify({ [seatId]: preMigrationRow })}\n`,
      "utf8",
    );
    assert.ok(
      !("favorite" in (await readRawStore(homeDir))[seatId]),
      "fixture precondition: the planted row must carry no favorite key at all",
    );

    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.seats, 0, "the row already existed — nothing is minted");
    assert.equal(
      report.favoritesMigrated,
      1,
      "an absent key must be migrated to an explicit value, not silently matched",
    );

    const raw = await readRawStore(homeDir);
    assert.ok(Object.hasOwn(raw[seatId], "favorite"), "the migration must leave an explicit key");
    assert.equal(raw[seatId].favorite, false);
  });
});

// ─── L7 — every minted row round-trips the store's own parse leg ─────────────

test("L7: every backfilled row round-trips parseSeatFromPersisted", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [
      makeRecord({ acpxRecordId: "l7-a", legacyName: "named" }),
      makeRecord({ acpxRecordId: "l7-b", legacyName: undefined }),
      makeRecord({ acpxRecordId: "l7-c", closed: true }),
    ]);
    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.seats, 3, "control: rows must actually have been written");

    const raw = await readRawStore(homeDir);
    assert.equal(Object.keys(raw).length, 3);
    for (const [seatId, row] of Object.entries(raw)) {
      const parsed = parseSeatFromPersisted(row);
      assert.notEqual(parsed, undefined, `row ${seatId} is one the store's own parse leg rejects`);
      assert.equal(parsed?.seatId, seatId, "the key IS the identity — a disagreement is malformed");
    }
    // And the store reads back with no malformed ids at all — the file-scope control.
    const store = await readSeatStore(sessionsDir(homeDir));
    assert.deepEqual(store.malformedSeatIds, []);
  });
});

// ─── L8 — non-UUID `ses_` record ids are REAL ────────────────────────────────

test("L8: a non-UUID `ses_` record id is seated, not skipped", async () => {
  await withTempHome(async (homeDir) => {
    // Four of these exist on the live devbox store. A backfill that quietly skipped
    // them would leave real sessions permanently unjoinable.
    await seed(homeDir, [makeRecord({ acpxRecordId: "ses_01JABCDEF0123456789" })]);
    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.seats, 1);
    assert.equal(report.errors.length, 0);
    const record = await readRecordJson(homeDir, "ses_01JABCDEF0123456789");
    assert.equal(typeof record.seat_id, "string");
  });
});

// ─── L9 — NO EXCLUSIONS: templates and subagents get seats too ───────────────

test("L9: template and subagent records are counted and seated (Topic 1, no exclusions)", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [
      makeRecord({ acpxRecordId: "l9-plain" }),
      makeRecord({
        acpxRecordId: "l9-template",
        template: { enabled: true, created_at: "2026-01-01T00:00:00.000Z" },
      }),
      makeRecord({ acpxRecordId: "l9-subagent", kind: "subagent" }),
    ]);
    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.recordsScanned, 3);
    assert.equal(report.seats, 3, "a record was EXCLUDED — AC11 counts all records");
    for (const id of ["l9-plain", "l9-template", "l9-subagent"]) {
      assert.equal(typeof (await readRecordJson(homeDir, id)).seat_id, "string", `${id} unseated`);
    }
  });
});

// ─── L10 — the sweep runs FIRST, and is REPORT-ONLY ──────────────────────────

test("L10: the abandoned-record sweep precedes every mint in the run log", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "l10" })]);
    const result = await runCli(["seats", "backfill", "--apply"], homeDir);
    assert.equal(result.code, 0, result.stderr);

    const sweepAt = result.stdout.indexOf("abandoned session records:");
    const mintAt = result.stdout.indexOf("seat backfill (");
    assert.notEqual(sweepAt, -1, "the sweep did not report at all");
    assert.notEqual(mintAt, -1);
    assert.ok(sweepAt < mintAt, "the sweep must be reported BEFORE the mint counts");
  });
});

test("L10b: the sweep is REPORT-ONLY — an abandoned record stays OPEN", async () => {
  await withTempHome(async (homeDir) => {
    // Long-idle (the fixture stamps 2026-01), no pid, so the sweep classifies it as
    // abandoned. Closing a record is `sessions close`'s authority; nothing in the
    // ruling gives it to this verb, so the record must come through untouched.
    await seed(homeDir, [makeRecord({ acpxRecordId: "l10b" })]);
    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.sweep.notMeasured, false, "control: /proc must be measurable here");
    assert.deepEqual(
      report.sweep.closed,
      ["l10b"],
      "control: this record IS an abandonment candidate",
    );
    assert.equal(
      (await readRecordJson(homeDir, "l10b")).closed,
      false,
      "the backfill CLOSED a session — the sweep must be report-only",
    );
  });
});

// ─── L11 / L13 — the index leg, and the reconcile trap ───────────────────────

test("L11: --verify counts exactly the stale entries, and 0 once enriched", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [
      makeRecord({ acpxRecordId: "l11-a" }),
      makeRecord({ acpxRecordId: "l11-b" }),
    ]);
    // A RECORD-ONLY backfill, reproduced exactly: the records gain `seat_id`, the
    // index keeps its old (createdAt-bearing, seatId-less) entries. That is the state
    // the whole index of every box would be in after a record-only run, and the state
    // B3's resolveSeat TRUSTS and therefore never repairs.
    const dir = sessionsDir(homeDir);
    for (const id of ["l11-a", "l11-b"]) {
      const file = path.join(dir, `${id}.json`);
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      raw.seat_id = `00000000-0000-4000-8000-00000000000${id.endsWith("a") ? "1" : "2"}`;
      raw.holder_ordinal = 1;
      raw.holder_active = true;
      await fs.writeFile(file, `${JSON.stringify(raw)}\n`, "utf8");
    }

    const verify = await runCli(["seats", "backfill", "--verify", "--format", "quiet"], homeDir);
    assert.equal(verify.code, 0, verify.stderr);
    assert.equal(verify.stdout.trim(), "2", "--verify did not count the stale entries");

    const applied = await backfill(homeDir, ["--apply", "--verify"]);
    assert.equal(applied.indexEntries, 2, "control: the entries must actually have been enriched");
    assert.equal(applied.staleIndexEntries, 0, "stale entries remain after --apply");
  });
});

test("L13: the entry IS enriched when only record CONTENTS changed — the anti-reconcile row", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "l13" })]);
    const dir = sessionsDir(homeDir);
    const seatId = "99999999-8888-7777-6666-555555555555";
    const file = path.join(dir, "l13.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    raw.seat_id = seatId;
    raw.holder_ordinal = 1;
    raw.holder_active = true;
    await fs.writeFile(file, `${JSON.stringify(raw)}\n`, "utf8");

    // 🛑 THE FILE LIST IS UNCHANGED, which is the whole trap: `reconcileSessionIndex`
    // compares only `index.files` against disk, matches, and returns the index
    // UNCHANGED (`drift: false`). An index leg built on it gets a clean run and zero
    // entries enriched — this row is RED against that implementation and green only
    // against a targeted per-entry rewrite.
    const filesBefore = (await readIndexEntries(homeDir)).size;

    const report = await backfill(homeDir, ["--apply"]);
    // 🔑 THE ROW'S SUBJECT, and `0` is precisely what a `reconcileSessionIndex`-based
    // leg produces. Inverted to `0` on 2026-09-29 and this file alone re-run: the row
    // FAILED as required, then reverted.
    assert.equal(report.indexEntries, 1, "the stale entry was not re-projected");

    const entries = await readIndexEntries(homeDir);
    assert.equal(
      entries.size,
      filesBefore,
      "membership changed — this leg must not add or drop rows",
    );
    assert.equal(entries.get("l13.json")?.seatId, seatId);
    assert.equal(entries.get("l13.json")?.holderActive, true);
  });
});

// ─── L12 — the ORDERING, observed as an END STATE under an asymmetric fault ──

/**
 * 🛑 NOT A CALL-ORDER ASSERTION. B2's original AP16 asserted an mtime proxy and KEPT
 * PASSING after the ordering was reversed — it never discriminated the two orderings
 * at all, and that was measured rather than argued. So this row injects a fault
 * BETWEEN the legs and reads the wreckage.
 *
 * **The fault is ASYMMETRIC, which is the hard part.** A whole-directory fault kills
 * both legs and proves nothing. This one kills leg 1 ONLY, deterministically, with no
 * `src/` edit and no test hook: `persistRecordFile` writes
 * `<file>.<pid>.<ms>.<uuid>.tmp`, so a record whose own filename is 245 bytes has a
 * temp path over 300 — **ENAMETOOLONG on the record write while every index write
 * (temp path derived from the short `index.json`) succeeds untouched.**
 *
 * Under the ruled order the faulted record ends with NO `seat_id` and an entry that
 * claims NO seat. Under the wrong order its entry would claim a seat the record never
 * got — the exact state AC11 exists to prevent, and one that is permanently invisible
 * to B3's `resolveSeat`.
 */
test("L12: an abort between the legs leaves NO index entry claiming a seat its record lacks", async () => {
  await withTempHome(async (homeDir) => {
    // 🔑 215 IS CALIBRATED, AND THE ARITHMETIC IS WRITTEN DOWN BECAUSE THE FIRST
    // VALUE I PICKED WAS WRONG AND THE ROW PASSED VACUOUSLY.
    //
    // Under a temp HOME the rig dir IS the canonical `~/.acpx/sessions`, so
    // `persistRecordFile` takes the OUTBOX branch and the temp name is
    // `writeRecordAtomic`'s `<file>.<pid>.<uuid>.tmp` (+47 bytes) — NOT
    // `persistRecordFile`'s own `<file>.<pid>.<ms>.<uuid>.tmp` (+61). At 200 that is
    // 254 bytes: one under NAME_MAX, so the write SUCCEEDED and the whole row proved
    // nothing. Against NAME_MAX = 255, with pid width between 1 and 7 digits:
    //   record file  215 + 5              = 220  ✓ readable and writable
    //   rollback copy 220 + 30 (suffix)   = 250  ✓ so the BACKUP leg succeeds …
    //   outbox temp   220 + 42 + pidWidth ≥ 263  ✗ … and the RECORD write cannot
    // Both margins hold for every pid width, so the fault is deterministic rather
    // than pid-dependent. If either arithmetic ever stops holding the row goes RED —
    // on the control (nothing failed) or on the code assertion — never silently green.
    const longId = "l".repeat(215);
    await seed(homeDir, [
      makeRecord({ acpxRecordId: longId }),
      // C1 — the control arm. An ordinary record in the SAME run must succeed, or a
      // zero from the faulted arm says nothing: it would be indistinguishable from a
      // run that did nothing at all.
      makeRecord({ acpxRecordId: "l12-control" }),
    ]);

    const report = await backfill(homeDir, ["--apply"]);

    // The control produced a non-zero result…
    assert.equal(report.seats, 1, "the control record was not seated — the run did nothing");
    assert.equal(typeof (await readRecordJson(homeDir, "l12-control")).seat_id, "string");

    // …and the fault BIT, at the leg it was calibrated for (C2: which mechanism
    // refused, by its own signature — not merely "the run failed").
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.stage, "record", "the fault did not land on the RECORD leg");
    assert.equal(report.errors[0]?.code, "ENAMETOOLONG");

    // THE END STATE — the subject of the row.
    const faulted = await readRecordJson(homeDir, longId);
    assert.equal(faulted.seat_id, undefined, "the faulted record must be unseated");
    const entry = (await readIndexEntries(homeDir)).get(`${longId}.json`);
    assert.notEqual(entry, undefined, "control: the faulted record still has an index entry");
    assert.equal(
      entry?.seatId,
      undefined,
      "an index entry CLAIMS A SEAT ITS RECORD LACKS — the legs ran in the wrong order",
    );
    // And no row was minted for a seat nobody holds.
    assert.equal((await readSeatStore(sessionsDir(homeDir))).seats.size, 1);
  });
});

/**
 * 🔑 A REGRESSION GUARD FOR A DEFECT L12 ACTUALLY FOUND, not a hypothetical.
 *
 * The first version of the apply path took EVERY rollback copy up front, so the one
 * record whose `<file><suffix>` exceeds `NAME_MAX` threw from outside the per-record
 * isolation: the whole run aborted with exit 1 having written nothing, and with no
 * per-record diagnosis of which record was the problem. Per-record isolation means
 * *"one record's failure never aborts the run"*, and a rollback copy is part of that
 * record's work — so it belongs inside its `try`, which is where it now is.
 */
test("L12b: a record whose ROLLBACK COPY cannot be taken is skipped, not written, and does not abort the run", async () => {
  await withTempHome(async (homeDir) => {
    // 240 + `.json` + the 30-byte suffix is 275 — over NAME_MAX for every pid width,
    // so the COPY itself fails. (215, in L12, is the other side of that boundary:
    // there the copy fits and the record write is what cannot.)
    const unbackupable = "u".repeat(240);
    await seed(homeDir, [
      makeRecord({ acpxRecordId: unbackupable }),
      makeRecord({ acpxRecordId: "l12b-control" }),
    ]);

    const report = await backfill(homeDir, ["--apply"]);

    assert.equal(report.seats, 1, "the run aborted — the other records were not processed");
    assert.equal(typeof (await readRecordJson(homeDir, "l12b-control")).seat_id, "string");
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.stage, "backup", "the failing leg must be named as the BACKUP");
    assert.equal(report.errors[0]?.code, "ENAMETOOLONG");
    assert.equal(
      (await readRecordJson(homeDir, unbackupable)).seat_id,
      undefined,
      "a record with no rollback copy must not be written",
    );
  });
});

// ─── L14 / L15 — rollback: the copies, and RESTORING them ────────────────────

test("L14: --apply leaves a .bak-mig-<TS> copy of the record, the index AND seats.json", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "l14" })]);
    // seats.json must EXIST pre-apply for its copy to be assertable; an absent store
    // has nothing to copy, which is a different (and correct) case.
    await backfillSeatRow(sessionsDir(homeDir), {
      seatId: "12121212-3434-5656-7878-909090909090",
      createdAt: "2026-01-01T00:00:00.000Z",
      activeHolderId: null,
      nextOrdinal: 2,
      closedAt: null,
      name: undefined,
      brickId: undefined,
      favorite: false,
    });

    const report = await backfill(homeDir, ["--apply"]);
    const suffix = report.backupSuffix ?? "";
    assert.match(suffix, /^\.bak-mig-/, "no rollback suffix was recorded");

    const names = (await fs.readdir(sessionsDir(homeDir))).filter((n) => n.includes(suffix));
    assert.deepEqual(
      names.toSorted(),
      [`index.json${suffix}`, `l14.json${suffix}`, `${SEAT_STORE_FILE}${suffix}`].toSorted(),
      "all three pre-apply copies must exist — record, index AND seats.json",
    );
  });
});

test("L15: RESTORING the copies returns records, index and store to byte-identical", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [
      makeRecord({ acpxRecordId: "l15-a" }),
      makeRecord({ acpxRecordId: "l15-b" }),
    ]);
    await backfillSeatRow(sessionsDir(homeDir), {
      seatId: "31313131-4141-5151-6161-717171717171",
      createdAt: "2026-01-01T00:00:00.000Z",
      activeHolderId: null,
      nextOrdinal: 2,
      closedAt: null,
      name: undefined,
      brickId: undefined,
      favorite: false,
    });
    const before = await snapshot(homeDir);

    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.seats, 2, "control: the run must actually have changed something");
    assert.notDeepEqual(
      diffNames(before, await snapshot(homeDir)).filter((n) => !n.includes(".bak-mig-")),
      [],
      "control: nothing changed, so a successful restore would prove nothing",
    );

    // 🔑 ROLLBACK ASSERTED AS A RESTORE, NOT AS "WE TOOK A COPY". The copy is a claim
    // about intent; the restore is the claim an operator needs at the worst moment.
    const suffix = report.backupSuffix ?? "";
    const dir = sessionsDir(homeDir);
    for (const name of await fs.readdir(dir)) {
      if (name.endsWith(suffix)) {
        await fs.rename(path.join(dir, name), path.join(dir, name.slice(0, -suffix.length)));
      }
    }

    assert.deepEqual(
      diffNames(before, await snapshot(homeDir)),
      [],
      "restoring the pre-apply copies did not return the store to its exact prior state",
    );
  });
});

// ─── R1 / R3 / R4 — refusals, each paired with L2 and each shown reachable ───

test("R1: a MALFORMED seats.json is refused — and nothing is written", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "r1" })]);
    await fs.writeFile(path.join(sessionsDir(homeDir), SEAT_STORE_FILE), "{ not json", "utf8");
    const before = await snapshot(homeDir);

    const result = await runCli(["seats", "backfill", "--apply"], homeDir);
    assert.notEqual(result.code, 0, "a malformed store must not exit 0");
    const output = `${result.stdout}${result.stderr}`;
    // C2 — WHICH mechanism refused, by its own signature. "It failed" is not a control.
    assert.match(output, /refusing to write the seat store/, "not the single writer's refusal");
    assert.match(output, /QUARANTINE the file/, "the refusal must print the real remedy");
    assert.equal(
      output.includes("acpx seats backfill --apply"),
      true,
      "the message must still name the backfill as the step AFTER quarantine",
    );

    assert.deepEqual(
      diffNames(before, await snapshot(homeDir)),
      [],
      "the refusal wrote to the store",
    );
  });
});

test("R1b: the SINGLE WRITER is what fails closed — backfillSeatRow refuses too", async () => {
  await withTempHome(async (homeDir) => {
    const dir = sessionsDir(homeDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, SEAT_STORE_FILE), "[]", "utf8");
    // Behavioural, not textual: only a write going through `withSeatStoreWrite`
    // inherits the fail-closed guard. A second writer would happily overwrite.
    await assert.rejects(
      backfillSeatRow(dir, {
        seatId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        createdAt: "2026-01-01T00:00:00.000Z",
        activeHolderId: null,
        nextOrdinal: 2,
        closedAt: null,
        name: undefined,
        brickId: undefined,
        favorite: false,
      }),
      (error: unknown) =>
        error instanceof SeatStoreUnwritableError && error.fileState === "malformed",
    );
    assert.equal(await fs.readFile(path.join(dir, SEAT_STORE_FILE), "utf8"), "[]");
  });
});

test("R3: an index that fails the all-or-nothing contract is refused, not rebuilt", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "r3" })]);
    const indexPath = path.join(sessionsDir(homeDir), "index.json");
    const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
      entries: Record<string, unknown>[];
    };
    // ONE unparseable entry. `readSessionIndex` rejects the WHOLE file for it
    // (index.ts:645-647) — so anything downstream would be built on a full rebuild.
    index.entries.push({ file: "ghost.json", acpxRecordId: 7 });
    await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");
    const before = await snapshot(homeDir);

    const result = await runCli(["seats", "backfill", "--apply"], homeDir);
    assert.notEqual(result.code, 0);
    assert.match(
      `${result.stdout}${result.stderr}`,
      /ALL-OR-NOTHING/,
      "the refusal must name the contract it refused on",
    );
    assert.deepEqual(
      diffNames(before, await snapshot(homeDir)),
      [],
      "the refusal wrote to the store",
    );
  });
});

test("R4: an UNREADABLE store is refused, and it is a DIFFERENT answer from absent", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "r4" })]);
    const storePath = path.join(sessionsDir(homeDir), SEAT_STORE_FILE);
    await fs.writeFile(storePath, "{}", "utf8");
    await fs.chmod(storePath, 0o000);
    try {
      // The three-way distinction, asserted as three values rather than a boolean:
      // `absent` is not an error (L2 creates the file), while `unreadable` refuses
      // with a filesystem remedy and `malformed` refuses with a quarantine one.
      assert.equal((await readSeatStore(sessionsDir(homeDir))).fileState, "unreadable");

      const result = await runCli(["seats", "backfill", "--apply"], homeDir);
      assert.notEqual(result.code, 0);
      const output = `${result.stdout}${result.stderr}`;
      assert.match(output, /could not be read \(a permission or I\/O failure/);
      assert.equal(
        output.includes("QUARANTINE the file"),
        false,
        "unreadable must not print the MALFORMED remedy — the two remedies differ",
      );
      assert.equal(typeof (await readRecordJson(homeDir, "r4")).seat_id, "undefined");
    } finally {
      await fs.chmod(storePath, 0o644);
    }
  });
});

test("R5: an ABSENT sessions directory is a NAMED refusal with a code, not a raw ENOENT", async () => {
  await withTempHome(async (homeDir) => {
    // Deliberately NO `seed()` — `withTempHome` only `mkdtemp`s an empty HOME, so
    // `.acpx/sessions` genuinely does not exist here. Without this control the row
    // could pass against a rig that happens to have the directory anyway.
    const dir = sessionsDir(homeDir);
    assert.equal(
      await fs
        .access(dir)
        .then(() => true)
        .catch(() => false),
      false,
      "rig is wrong: the sessions directory exists",
    );

    const result = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.notEqual(result.code, 0, "an absent sessions directory must not exit 0");

    // Parse the ENVELOPE, not the rc and not a substring of stdout — a raw ENOENT
    // trace would ALSO exit non-zero, so the code is the only thing that tells the
    // two apart.
    const envelope = JSON.parse(result.stdout.trim()) as {
      error: { message: string; data?: { detailCode?: string } };
    };
    assert.equal(
      envelope.error.data?.detailCode,
      "SEAT_BACKFILL_SESSION_DIR_MISSING",
      "the refusal must carry a stable machine-readable code, not a raw filesystem error",
    );
    assert.doesNotMatch(
      envelope.error.message,
      /ENOENT|scandir/,
      "a NAMED refusal must replace the raw scandir trace, not sit beside it",
    );
    assert.match(
      envelope.error.message,
      /does not exist/,
      "the message must say what is actually wrong",
    );

    // NOTHING WRITTEN: the directory this verb was pointed at must not spring into
    // existence as a side effect of refusing to run against it.
    assert.equal(
      await fs
        .access(dir)
        .then(() => true)
        .catch(() => false),
      false,
      "the refusal created the sessions directory",
    );
  });
});

/**
 * R6 (brick `1dd9ae9a`) — CONTENT.md's acceptance: "all three total refusals carry
 * `data.detailCode`, asserted with ONE test that enumerates the population — so the
 * next class added without a code reds by name." The population, as of this brick,
 * is exactly the three preflight refusals `preflight()` in `seat-backfill.ts` can
 * throw: `SEAT_BACKFILL_SESSION_DIR_MISSING` (R5's subject, already coded — its
 * presence here is the control member, proving the enumeration itself is not
 * vacuous), `SEAT_STORE_UNWRITABLE` (R1/R4's subject, REUSED from the established
 * `seats-command.ts` convention rather than a new spelling — the code names the
 * SEAM, not the caller), and `SEAT_BACKFILL_INDEX_UNREADABLE` (R3's subject, new —
 * no established code exists for this seam elsewhere). A row that checked only the
 * two newly-coded members would recreate the exact inconsistency this brick exists
 * to close the moment a fourth refusal is added without a code.
 */
test("R6 · ALL THREE preflight refusals carry a stable data.detailCode — the population, not just the newest", async () => {
  function detailCodeOf(stdout: string): string | undefined {
    const envelope = JSON.parse(stdout.trim()) as { error: { data?: { detailCode?: string } } };
    return envelope.error.data?.detailCode;
  }

  // (a) an absent sessions directory — mirrors R5.
  await withTempHome(async (homeDir) => {
    const result = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.notEqual(result.code, 0, "an absent sessions directory must not exit 0");
    assert.equal(detailCodeOf(result.stdout), "SEAT_BACKFILL_SESSION_DIR_MISSING");
  });

  // (b) a malformed seats.json — mirrors R1.
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "r6b" })]);
    await fs.writeFile(path.join(sessionsDir(homeDir), SEAT_STORE_FILE), "{ not json", "utf8");
    const result = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.notEqual(result.code, 0, "a malformed store must not exit 0");
    assert.equal(detailCodeOf(result.stdout), "SEAT_STORE_UNWRITABLE");
  });

  // (c) an index that fails the all-or-nothing contract — mirrors R3.
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "r6c" })]);
    const indexPath = path.join(sessionsDir(homeDir), "index.json");
    const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as {
      entries: Record<string, unknown>[];
    };
    index.entries.push({ file: "ghost.json", acpxRecordId: 7 });
    await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");
    const result = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.notEqual(result.code, 0);
    assert.equal(detailCodeOf(result.stdout), "SEAT_BACKFILL_INDEX_UNREADABLE");
  });
});

// ─── L17 — RESUMABILITY: the row the operator actually needs ─────────────────

/**
 * 🔑 THE REALISTIC FAILURE IS NOT A CRASH, IT IS AN IMPATIENT HUMAN.
 *
 * The apply takes MINUTES at box scale (measured: 144 s for 1,900 records, and a real
 * box's index is ~3x this rig's), so "operator hits Ctrl-C at 90 s because it looks
 * hung" is the likeliest thing that will ever happen to this verb — and until this
 * row, NOTHING asserted that it is harmless.
 *
 * **The interruption is SIGKILL, not SIGINT, deliberately**: SIGKILL cannot be caught,
 * so no cleanup handler of ours can make the result look better than it is. Whatever
 * survives is what the filesystem was left holding.
 *
 * ⚠️ THE KILL IS TRIGGERED BY A CONDITION, NOT BY A TIMER. A sleep-then-kill on this
 * box is a coin flip — load swings 2-4x within minutes, so a delay tuned once lands
 * before the run starts or after it finishes, and an interruption that missed the run
 * entirely passes this row while proving nothing. The poll below waits for the store
 * to show STRICT partial progress and only then kills, and the row asserts that it
 * really did catch the run mid-flight.
 */
async function seatRowCount(homeDir: string): Promise<number> {
  try {
    return Object.keys(await readRawStore(homeDir)).length;
  } catch {
    // Absent, or caught mid-rename. Not an error: the poll simply has not seen
    // progress yet, and the atomic rename means this can never read a torn file.
    return 0;
  }
}

/** Every index entry that claims a seat its record does not carry. THE invariant an
 * interruption must never break, at any point in the run. */
async function entriesClaimingUnseatedRecords(homeDir: string): Promise<string[]> {
  const entries = await readIndexEntries(homeDir);
  const offenders: string[] = [];
  for (const [file, entry] of entries) {
    if (typeof entry.seatId !== "string") {
      continue;
    }
    const raw = JSON.parse(
      await fs.readFile(path.join(sessionsDir(homeDir), file), "utf8"),
    ) as Record<string, unknown>;
    if (typeof raw.seat_id !== "string") {
      offenders.push(file);
    }
  }
  return offenders;
}

test("L17: a KILLED --apply leaves a consistent store, and re-running completes the remainder", async () => {
  await withTempHome(async (homeDir) => {
    // Large enough that the run is many seconds wide, so the poll cannot miss the
    // window; small enough to stay a test. The row asserts the catch rather than
    // assuming it.
    const total = 120;
    const records = [];
    for (let i = 0; i < total; i++) {
      records.push(makeRecord({ acpxRecordId: `l17-${String(i).padStart(3, "0")}` }));
    }
    await seed(homeDir, records);

    const child = spawnCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    child.stdin.end();
    child.stdout.resume();
    child.stderr.resume();

    let caughtAt = 0;
    const exited = new Promise<void>((resolve) => child.on("close", () => resolve()));
    // The liveness test is the child's OWN state, not a flag a listener sets: the
    // linter cannot see a closure write, and more to the point a flag can lag the
    // process it describes. `exitCode`/`signalCode` are both null only while running.
    for (let attempt = 0; attempt < 3000; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        break;
      }
      const seen = await seatRowCount(homeDir);
      if (seen > 0 && seen < total) {
        caughtAt = seen;
        child.kill("SIGKILL");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await exited;

    // 🛑 THE CONTROL, AND IT IS THE WHOLE ROW. Without it, a run that finished before
    // the first poll would sail through every assertion below — the store would be
    // complete, the re-run would report 0, and the row would be green having never
    // interrupted anything.
    assert.ok(
      caughtAt > 0 && caughtAt < total,
      `the run was never caught mid-flight (caught at ${caughtAt} of ${total}) — this row proved nothing`,
    );

    // ⚠️ THE ARITHMETIC USES THE POST-EXIT COUNT, NOT `caughtAt`, AND THAT IS A REAL
    // FLAKE THIS ROW WOULD OTHERWISE CARRY. `kill()` only DELIVERS the signal; the
    // child keeps running until the kernel stops it, so more rows can land between
    // the poll that read `caughtAt` and the process actually dying. `caughtAt` is
    // therefore sound ONLY as the mid-flight control above — an undercount cannot
    // make `0 < caughtAt < total` wrongly true — and the count below is what the
    // re-run's remainder has to be measured against.
    const landedBeforeKill = await seatRowCount(homeDir);
    assert.ok(
      landedBeforeKill >= caughtAt && landedBeforeKill < total,
      `expected a partial store after the kill, found ${landedBeforeKill} of ${total}`,
    );

    // (a) No file is half-written. Every artefact is temp-file + rename, so an
    // interruption tears BETWEEN artefacts and never inside one.
    const interrupted = await readSeatStore(sessionsDir(homeDir));
    assert.equal(interrupted.fileState, "ok", "SIGKILL left a torn seats.json");
    assert.deepEqual(interrupted.malformedSeatIds, []);
    assert.notEqual(
      (await readIndexEntries(homeDir)).size,
      0,
      "SIGKILL left an index that does not parse",
    );

    // (b) THE ORDERING INVARIANT HOLDS AT THE INTERRUPTION POINT — the same property
    // L12 asserts under a fault, here under a real kill at an arbitrary instant.
    assert.deepEqual(
      await entriesClaimingUnseatedRecords(homeDir),
      [],
      "an interrupted run left an index entry claiming a seat its record lacks",
    );

    // (c) RE-RUNNING COMPLETES THE REMAINDER, and reports 0 for what was already done.
    const resumed = await backfill(homeDir, ["--apply"]);
    assert.equal(resumed.errors.length, 0, JSON.stringify(resumed.errors));
    assert.equal(
      resumed.seats,
      total - landedBeforeKill,
      "the re-run did not mint exactly the seats the killed run had not reached",
    );

    // (d) …and the store is COMPLETE and idempotent afterwards.
    assert.equal((await readSeatStore(sessionsDir(homeDir))).seats.size, total);
    const third = await backfill(homeDir, ["--apply", "--verify"]);
    assert.equal(third.seats, 0);
    assert.equal(third.indexEntries, 0);
    assert.equal(third.staleIndexEntries, 0, "stale entries survived the resumed run");
  });
});

// ─── L18 — the decisions the COUNTS cannot say, in the verb's own output ─────

/**
 * 🛑 AN ABSENCE CANNOT BE DISTINGUISHED FROM AN OVERSIGHT, which is why this row
 * exists at all. `parent_seat_id` being unset is a RULED outcome, and it shows up in
 * the store as *nothing happening* — indistinguishable, to an operator, from a bug.
 * Same for "safe to re-run": an operator who is not told will hand-repair a store
 * that only needed the command run again.
 *
 * The row asserts against `SEAT_BACKFILL_NOTES` itself rather than re-spelling the
 * sentences: delete a line from the renderer and this goes RED; delete the constant
 * and it stops compiling. A row carrying its own copy of the wording would pass while
 * the operator saw nothing.
 */
test("L18: every run states the decisions the counts cannot — in text AND in json", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "l18" })]);

    // A DRY RUN too, not only an apply: the operator's first command is the dry run,
    // and that is where the decision most needs to be met.
    const dryText = await runCli(["seats", "backfill"], homeDir);
    assert.equal(dryText.code, 0, dryText.stderr);
    for (const note of SEAT_BACKFILL_NOTES) {
      assert.equal(dryText.stdout.includes(note), true, `dry-run text is missing: ${note}`);
    }

    const applied = await backfill(homeDir, ["--apply"]);
    assert.deepEqual(
      applied.notes,
      [...SEAT_BACKFILL_NOTES],
      "--format json dropped the notes — a json operator meets the gap instead of the decision",
    );

    // The two decisions, named, so a future reader of this row knows WHICH facts are
    // load-bearing rather than only that "some notes" are printed.
    const joined = SEAT_BACKFILL_NOTES.join(" ");
    assert.match(joined, /parent_seat_id is deliberately NOT set/);
    assert.match(joined, /safe to re-run if interrupted/);
  });
});

test("L18b: `--help` carries both decisions too — the operator reading before running", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "l18b" })]);
    const help = await runCli(["seats", "backfill", "--help"], homeDir);
    const output = `${help.stdout}${help.stderr}`;
    assert.match(output, /parent_seat_id IS DELIBERATELY NOT SET/);
    assert.match(output, /SAFE TO RE-RUN IF YOU INTERRUPT IT/);
    // 🛑 THE PRECONDITION, NOT ADVICE. Concurrent-backfill-while-live is FORBIDDEN by
    // B12a, and an operator must meet that before running, not discover it after.
    assert.match(output, /RUN THIS ON A QUIET BOX/);
    // The control: `--help` really did render, so the matches above are not passing
    // against some other output that happens to contain the words.
    assert.match(output, /--apply/);
  });
});

// ─── L16b — the `seats` noun is registered EXACTLY ONCE ─────────────────────

/**
 * 🛑 THE RISK RANKING HERE WAS MEASURED, NOT ASSUMED, AND IT INVERTED.
 *
 * B10 and B2b both create `src/cli/seats-command.ts` and both export the same symbol
 * `registerSeatsCommand`, each registering a different subset of the `seats` verbs.
 * Probed against this worktree's own commander (14.0.3) with the exact union shape —
 * one registrar called twice on one program:
 *
 *   Error: cannot add command 'seats' as already have command 'seats'   → THREW
 *
 * So a duplicated call is **LOUD**: it breaks CLI setup on *every* `acpx` invocation
 * and cannot survive one run, let alone reach a commit. The silent defect is the
 * other one — resolving the add/add by KEEPING ONE SIDE, which yields a valid binary
 * that starts, answers, and is missing verbs. That is what L16a (added with the
 * merge) exists for.
 *
 * This row is belt-and-braces and is committed anyway: it costs nothing, and if a
 * future commander relaxes the duplicate check it becomes load-bearing — better that
 * it already exists than that someone has to notice.
 */
test("L16b: `seats` is registered exactly once, and every subcommand it lists ANSWERS", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "l16b" })]);

    // 🔑 ASSERT ON OUTPUT, NEVER ON AN rc. `cli-core.ts` says it outright: the rc
    // names WHICH FALL-THROUGH FIRED, not whether the command exists, and it is
    // cwd-dependent — unsound in both directions. `No acpx session found` is what the
    // agent-name fall-through prints, and it must be ABSENT for a registered verb.
    const help = await runCli(["seats", "--help"], homeDir);
    const output = `${help.stdout}${help.stderr}`;
    assert.equal(
      output.includes("No acpx session found"),
      false,
      "`seats` fell through to the agent registry",
    );

    // Exactly one `seats` in the top-level list — the duplicate-registration guard.
    const topLevel = await runCli(["--help"], homeDir);
    const topLevelText = `${topLevel.stdout}${topLevel.stderr}`;
    const seatsMentions = topLevelText
      .split("\n")
      .filter((line) => /^\s{2,}seats\b/.test(line)).length;
    assert.equal(seatsMentions, 1, `top-level help lists \`seats\` ${seatsMentions} times, want 1`);

    // DISCOVERING, not a second hand-written list: every subcommand the binary
    // actually advertises must answer. A hand list would be exactly as incomplete as
    // the registration it checks.
    //
    // ⚠️ THIS ALONE CANNOT CATCH "three of four registered" — it discovers whatever
    // is there and is happy. The literal four-name assertion is L16a, and it lands
    // with the B2b union; do not read this row as covering that.
    // ⚠️ THE NAME IS THE FIRST TOKEN ON A TWO-SPACE-INDENTED LINE, AND NOTHING MAY BE
    // ASSUMED TO FOLLOW IT. An earlier version required two more spaces and a
    // non-space after the name — which is the layout for a bare verb and NOT the
    // layout commander uses once a subcommand takes options or arguments
    // (`  set-brick [options] <seat> <brick>  Point a seat…`). It matched zero
    // commands and the row failed on its own control, which is the right direction
    // for a discovering check to fail in: it could not silently discover nothing.
    // `-h, --help` cannot match because the alternation is anchored on `[a-z]`; the
    // continuation lines are indented far deeper than two.
    const listed = [...output.matchAll(/^ {2}([a-z][a-z0-9-]*)\b/gm)]
      .map((match) => match[1])
      .filter((name) => name !== "help");
    assert.ok(listed.includes("backfill"), `\`backfill\` is not listed: ${listed.join(",")}`);
    assert.ok(
      listed.length >= 4,
      `expected the whole union to be listed, found: ${listed.join(",")}`,
    );
    for (const name of listed) {
      const sub = await runCli(["seats", name, "--help"], homeDir);
      assert.equal(
        `${sub.stdout}${sub.stderr}`.includes("No acpx session found"),
        false,
        `\`seats ${name}\` is advertised but does not answer`,
      );
    }
  });
});

// ─── L16a — ALL FOUR subcommands answer on the shipped binary ────────────────

/**
 * 🛑 THE ROW THAT CATCHES THE UNION'S ONLY SILENT DEFECT.
 *
 * B2b (`set-brick`, `rename`, `delete`) and B10 (`backfill`) were cut from the same
 * commit and each created `src/cli/seats-command.ts` exporting the SAME symbol
 * `registerSeatsCommand`. Resolving that add/add by KEEPING ONE SIDE yields a binary
 * that compiles, starts and answers — **with three of the four verbs missing**, and
 * no type error anywhere. Neither lane's own rows can catch that, because each lane
 * only ever asserted its own verbs.
 *
 * The other two collision points are loud and were MEASURED rather than assumed:
 * a duplicated registrar call makes commander 14 throw at CLI setup, and a duplicated
 * `TOP_LEVEL_VERBS` entry is inert because it is a `Set`. So this list is where the
 * care belongs.
 *
 * ⚠️ IT ASSERTS THAT `delete` **ANSWERS**, AND DELIBERATELY EXERCISES NOTHING ELSE.
 * B2b's semantics are TE-passed and are not this row's to re-litigate — variadic
 * `delete` is a data-safety decision on a measured loss cliff, and it carries two
 * OPPOSITE failure contracts (`SEAT_REF_INVALID` is total, nothing deleted;
 * `SEAT_ROW_MALFORMED` is partial, committing the rest). A row here that poked at
 * either would couple this block to contracts it does not own.
 */
const SEATS_SUBCOMMANDS = ["set-brick", "rename", "delete", "backfill"] as const;

test("L16a: `acpx seats` registers ALL FOUR subcommands, and each ANSWERS", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "l16a" })]);

    const help = await runCli(["seats", "--help"], homeDir);
    const output = `${help.stdout}${help.stderr}`;
    // 🔑 OUTPUT, NEVER AN rc. `cli-core.ts:41-52`: the rc names which fall-through
    // fired rather than whether the command exists, and it is cwd-dependent — so it
    // is unsound in both directions. `No acpx session found` is the control string.
    assert.equal(
      output.includes("No acpx session found"),
      false,
      "`seats` fell through to the agent registry",
    );

    for (const name of SEATS_SUBCOMMANDS) {
      assert.match(
        output,
        new RegExp(`^\\s{2}${name}\\b`, "m"),
        `\`seats --help\` does not list \`${name}\` — the union dropped a lane's verbs`,
      );
      // 🛑 PRESENCE, NOT JUST ABSENCE. `output.includes("No acpx session found") ===
      // false` was near-vacuous: commander answers an UNREGISTERED subcommand name
      // with `--help` by printing the PARENT's (`seats`'s) own usage line, which
      // also never contains that fallback marker — so the old check passed
      // identically for a real verb and for garbage (measured directly against
      // `seats l6c-item2-unregistered-subcommand --help`). The actual
      // discriminator is each subcommand's OWN usage line (`Usage: acpx seats
      // <name> …`), which only appears when commander actually resolved and
      // dispatched to it — see the negative case below for the same probe
      // applied to a name that was never registered.
      const sub = await runCli(["seats", name, "--help"], homeDir);
      assert.match(
        sub.stdout,
        new RegExp(`^Usage: acpx seats ${name}\\b`, "m"),
        `\`seats ${name}\` is listed but its own usage line never appeared — ` +
          `it is advertised without actually being reachable`,
      );
    }

    // PRESENCE/ABSENCE PAIR (required by the brief for an absence-shaped guard):
    // a name that was NEVER registered must NOT get a per-subcommand usage line.
    // Without this, emptying SEATS_SUBCOMMANDS to `[]` would leave the loop above
    // vacuously green — the for-loop simply runs zero times — so this committed
    // negative case is the one assertion in this test that fires regardless of
    // what the array contains.
    const unregisteredName = "l6c-item2-unregistered-subcommand";
    const bogus = await runCli(["seats", unregisteredName, "--help"], homeDir);
    assert.doesNotMatch(
      bogus.stdout,
      new RegExp(`^Usage: acpx seats ${unregisteredName}\\b`, "m"),
      `an unregistered name must not get its own per-subcommand usage line — ` +
        `if it does, the positive check above is vacuous again`,
    );
  });
});

// ─── L19 — the record the index has NO ENTRY for (a live population) ─────────

/**
 * 🛑 A REAL DEFECT, FOUND BY THE INDEPENDENT TEST-ENGINEER, ON A POPULATION THAT
 * EXISTS ON THE LIVE FLEET — PLAN §4's census measured exactly ONE such record on
 * devbox. Nothing covered it until this row.
 *
 * ## The mechanism, because it is not the one a reader expects
 *
 * A record with no index entry was EXCLUDED from the index leg by construction:
 * the flag read `entry !== undefined && !indexEntryAgrees(...)`, so an orphan scored
 * `false` and was never enriched — and was not counted either.
 *
 * But the entry gets created anyway, **by another record's index write**:
 * `overlaySessionIndexEntries` → `reconcileSessionIndex` reconciles MEMBERSHIP and
 * adds an entry for every record file the index lacks, projected from that record as
 * it stands at that moment. So the first enriching record minted the orphan's entry
 * from its UNSEATED record, and nothing revisited it.
 *
 * End state after ONE `--apply`: record seated · row present · **entry with
 * `createdAt` and no `seatId`** — the exact cutover-blocking state this block exists
 * to delete, and the one `resolveSeat` TRUSTS and therefore never repairs.
 *
 * ## Why the rig's NAMES are load-bearing
 *
 * Records are processed in sorted file order, so the defect only fires when an
 * enriching record sorts BEFORE the orphan — it is the earlier record's index write
 * that mints the stale entry. `a-normal` / `z-orphan` guarantees that order. Named
 * the other way round this row would pass against the broken code.
 *
 * ## It breaks two RULED properties, and the row asserts both
 *
 * - the brick's own measured acceptance — *"after --apply, ZERO index entries whose
 *   record carries seat_id but whose entry lacks it"* — `--verify` returned 1;
 * - the ruled IDEMPOTENCY — *"a second --apply reports 0 and changes nothing"* — the
 *   second run reported `0 1 0` and WROTE the index. It self-healed, which is why
 *   this is not data loss; but B12a's operator runs the command ONCE, and the
 *   remedy must never be "run it twice".
 *
 * ## How this row was falsified
 *
 * **Red arm — (b′) transplanted-test arm: L19 was run against the real committed
 * pre-fix tree `c7ee352` with the test file copied in, since the row postdates that
 * tree; nothing inverted, no `src/` guard touched.**
 *
 * *Measured:* detached worktree at `c7ee352`, `build:test` rc 0, and **L19 fails
 * there on exactly the assertion that names the defect** — *"the orphan's index entry
 * lacks its seatId"*.
 *
 * 🛑 **THAT DISCLOSURE IS THE CONDITION THAT EARNS THE FORM, NOT A FOOTNOTE.** (b′)
 * must name the transplant AND the pre-fix SHA **in the same sentence that claims
 * it**; an arm that cannot be stated that plainly falls back to (c). So do not
 * shorten the sentence above to "red-armed (b′)" and explain it further down.
 *
 * 🛑 **AND THE LABEL LIVES HERE, IN THE CODE, BECAUSE A RE-DERIVER READS THE CODE** —
 * the same reason the name-ordering warning above is here rather than in a document
 * beside it. A fragile fact belongs attached to the thing that can go wrong.
 *
 * ⚠️ I first called this "technique (b)" and that was wrong: (b) means THE TEST
 * EXISTED ON THAT TREE, and this row postdates `c7ee352`, so old product plus new
 * test is a MIXED TREE. A sibling lane met the identical shape and took the less
 * flattering call — "(b) unavailable" — and **(b′) exists so that honest call no
 * longer reads as weaker.** Recorded rather than quietly relabelled, because if two
 * lanes name one method two ways the block whose evidence merely LOOKS weaker is the
 * honest one.
 */
test("L19: a record with NO index entry gets a CORRECT entry in one --apply, and the second run is a no-op", async () => {
  await withTempHome(async (homeDir) => {
    // Seed + index the ordinary record FIRST, so the orphan is genuinely absent from
    // the index rather than merely last in it.
    await seed(homeDir, [makeRecord({ acpxRecordId: "a-normal" })]);
    await writeSessionRecordFile(homeDir, makeRecord({ acpxRecordId: "z-orphan" }));

    // THE CONTROL: the orphan really has no entry, and the ordinary record does.
    // Without this the row could pass against a rig that never had the population.
    const before = await readIndexEntries(homeDir);
    assert.equal(before.has("a-normal.json"), true, "rig is wrong: the normal record is unindexed");
    assert.equal(before.has("z-orphan.json"), false, "rig is wrong: the orphan IS indexed");

    const first = await backfill(homeDir, ["--apply", "--verify"]);
    assert.equal(first.errors.length, 0, JSON.stringify(first.errors));
    assert.equal(first.recordsWithoutIndexEntry, 1, "the orphan population was not seen at all");
    assert.equal(first.seats, 2, "control: both records must be seated in this run");

    // (a) The record and its row — the two legs that were already correct.
    const orphanRecord = await readRecordJson(homeDir, "z-orphan");
    const orphanSeatId = String(orphanRecord.seat_id);
    assert.match(orphanSeatId, /^[0-9a-f-]{36}$/);
    assert.equal(
      (await readSeatStore(sessionsDir(homeDir))).seats.has(orphanSeatId),
      true,
      "no seat row for the orphan",
    );

    // (b) 🔑 THE SUBJECT: its index entry must carry ITS OWN seat id, not a stale
    // projection taken before the record was seated.
    const entry = (await readIndexEntries(homeDir)).get("z-orphan.json");
    assert.notEqual(entry, undefined, "the orphan ended the run with no index entry at all");
    assert.equal(
      entry?.seatId,
      orphanSeatId,
      "the orphan's index entry lacks its seatId — resolveSeat TRUSTS this entry and never repairs it",
    );

    // (c) The brick's own measured acceptance, from the verb's own instrument.
    //
    // 🛑 MUST BE MEASURED AFTER THE APPLY, NOT READ FROM `first.staleIndexEntries`.
    // `scanRecords` computes that field BEFORE any write, so on this rig it reads `0`
    // whether or not the defect is present — the orphan's `seat.seatsRecord` is still
    // `true` at scan time, which structurally excludes it from the pre-write count
    // regardless of what its index entry ends up holding. Call the same instrument
    // the CLI's own `--verify` uses, against the live post-apply store, so the
    // assertion measures what its message claims.
    assert.equal(
      await countStaleSeatIndexEntries(sessionsDir(homeDir)),
      0,
      "--verify still counts a stale entry after one --apply",
    );

    // (d) THE RULED IDEMPOTENCY, which the defect also broke: the second run must
    // report 0 AND write nothing. Before the fix this reported `0 1 0` and rewrote
    // the index — self-healing, but the ruled property was false as shipped.
    const afterFirst = await snapshot(homeDir);
    const second = await backfill(homeDir, ["--apply"]);
    assert.equal(second.seats, 0);
    assert.equal(second.indexEntries, 0, "the second --apply rewrote an index entry");
    assert.equal(second.errors.length, 0);
    assert.deepEqual(
      diffNames(afterFirst, await snapshot(homeDir)).filter((n) => !n.includes(".bak-mig-")),
      [],
      "the second --apply changed the store",
    );
  });
});

// ─── item (d), brick 3dff714d — ADDITIVE ONLY: these two rows are the ONLY
// change this brick makes to this file. `seats backfill` is a THIRD site of
// F1's pattern (`planSeatRow` wrote `brickId: undefined` unconditionally,
// same comment `mintSeatRow` carried before its own fix, and pre-existing —
// not introduced by this brick's edits). Left unfixed, (a) only starts seats
// from now on and C4 stays false for every pre-existing seat, the DOMINANT
// population per F1. No existing row above is touched. ───────────────────

const BRICK_A = "1a5845c3-a832-4370-b564-8ec5286bff79";
const BRICK_B = "1d459def-bbfd-44b6-8e14-9ad998f292d6";

test("BRK1: a FRESHLY-MINTED seat's brick_id comes from the ACTIVE holder — the disagreeing fixture", async () => {
  // 🛑 THE DISAGREEMENT IS THE POINT, same discipline as FAV1 — AND THE TWO
  // DISAGREEING AXES (active-vs-retired, ordinal) MUST POINT OPPOSITE WAYS, or
  // the row cannot tell "the active holder wins" from "the highest ordinal
  // wins" apart (TE finding, brick 3dff714d): an earlier version of this
  // fixture put the active holder at the HIGHER ordinal too, so both
  // hypotheses predicted the same answer and the row split only "any
  // holder's brick wins" (the favorite-style rule), never the one it is
  // named for. Here the ACTIVE holder is the LOWER ordinal (1) and carries
  // B; the RETIRED holder is the HIGHER ordinal (2) and carries the stale A.
  // `activeHolderFor` prefers the `holder_active`-flagged member (h1) over the
  // higher ordinal, so a "highest ordinal overall" rule would instead resurrect
  // h2's stale A. (Brick `eca085bb`: the choice is among ALL members, open or
  // closed — the flag decides here, not open-ness.)
  await withTempHome(async (homeDir) => {
    const seatId = "b4b4b4b4-1111-4111-8111-111111111111";
    await seed(homeDir, [
      makeRecord({
        acpxRecordId: "brk1-h1",
        seatId,
        holderOrdinal: 1,
        holderActive: true,
        metadata: { brick: BRICK_B },
      }),
      makeRecord({
        acpxRecordId: "brk1-h2",
        seatId,
        holderOrdinal: 2,
        holderActive: false,
        closed: true,
        metadata: { brick: BRICK_A },
      }),
    ]);

    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.seats, 1);

    const row = (await readSeatStore(sessionsDir(homeDir))).seats.get(seatId);
    assert.equal(
      row?.brickId?.ref,
      BRICK_B,
      "the ACTIVE holder's brick must win, not the RETIRED holder's HIGHER ordinal — brick_id " +
        "derives like name (the active-holder representative), never like favorite's some(), " +
        "and never by raw ordinal over all members",
    );
    // Brick `9984c510`, R28 (5): a FRESH mint via the backfill always writes
    // UNVALIDATED — it promotes the holder's own derived copy verbatim.
    assert.equal(row?.brickId?.validated, false);
    assert.equal(row?.activeHolderId, "brk1-h1", "fixture sanity: h1 is the active holder");
  });
});

test("BRK2: an EXISTING seat row that already carries a brick_id is LEFT UNCHANGED by a backfill run", async () => {
  // Preserves the measured invariant at the base: `backfillSeatRow` never
  // recomputes an existing row — it mints an ABSENT one and leaves a PRESENT
  // one alone (`SEAT_STORE_NO_CHANGE`). A seat whose row already has a brick
  // must not be disturbed even when its holder disagrees with it.
  await withTempHome(async (homeDir) => {
    const seatId = "b4b4b4b4-2222-4222-8222-222222222222";
    await seed(homeDir, [
      makeRecord({
        acpxRecordId: "brk2-h1",
        seatId,
        holderOrdinal: 1,
        metadata: { brick: BRICK_B },
      }),
    ]);
    await backfillSeatRow(sessionsDir(homeDir), {
      seatId,
      createdAt: "2026-01-01T00:00:00.000Z",
      activeHolderId: "brk2-h1",
      nextOrdinal: 2,
      closedAt: null,
      name: undefined,
      // Brick `9984c510`: `validated: true` here (not `false`, like every
      // OTHER fixture in this file) is deliberate — BRK2 must prove the
      // WHOLE link object is left alone, including its validation state,
      // not merely its ref. If the (d′) fill leg this brick adds ever
      // started reconciling a PRESENT link's state, this is the row that
      // would catch it.
      brickId: { ref: BRICK_A, validated: true },
      favorite: false,
    });

    const report = await backfill(homeDir, ["--apply"]);
    assert.equal(report.seats, 0, "the row already existed — this run mints nothing");

    const row = (await readSeatStore(sessionsDir(homeDir))).seats.get(seatId);
    assert.equal(
      row?.brickId?.ref,
      BRICK_A,
      "an existing row's brick_id must not be overwritten by a holder that disagrees with it",
    );
    assert.equal(
      row?.brickId?.validated,
      true,
      "BRK2 must preserve the link's validation state too",
    );
  });
});

// ─── brick `5c4b8c4a` narrowed the (d′) fill leg to the ACTIVE holder; brick
// `eca085bb` (D-SEAT-HOLD, D-BRICK-ON-SEAT) REVERSED it. A closed session keeps
// holding its seat, so the seat's brick link is taken from its holder OPEN OR
// CLOSED. BRK3 and BRK5 below were `5c4b8c4a`'s "a closed holder sources NO
// link" assertions; they are INVERTED here, not deleted, so the harmful case
// keeps a row. The fill leg still never overwrites a present link (BRK2). ─────

test(
  "BRK3/BRK4/COUNT/untouched: a seat whose only holder is CLOSED IS filled " +
    "from that holder, an OPEN holder's link is filled in the same run, an " +
    "existing link is left alone, and the run fills exactly two",
  async () => {
    await withTempHome(async (homeDir) => {
      const seatBrk3 = "b4b4b4b4-3333-4333-8333-333333333333";
      const seatBrk4 = "b4b4b4b4-4444-4444-8444-444444444444";
      const seatUntouched = "b4b4b4b4-6666-4666-8666-666666666666";

      await seed(homeDir, [
        // BRK3 — the seat's ONLY holder is CLOSED and carries a brick ref.
        // It is still the seat's holder (D-SEAT-HOLD), so BRICK_A is promoted —
        // the 35 links `5c4b8c4a` reverted on staging.
        makeRecord({
          acpxRecordId: "brk3-h1",
          seatId: seatBrk3,
          holderOrdinal: 1,
          holderActive: false,
          closed: true,
          metadata: { brick: BRICK_A },
        }),
        // BRK4 — the paired positive control, SAME temp HOME, SAME --apply:
        // an OPEN active holder carrying a link. Without this row, BRK3's
        // "not filled" is satisfied just as well by the fill leg being
        // disabled outright, or by a fixture that never produced a fillable
        // seat at all.
        makeRecord({
          acpxRecordId: "brk4-h1",
          seatId: seatBrk4,
          holderOrdinal: 1,
          holderActive: true,
          metadata: { brick: BRICK_B },
        }),
        // untouched control — the holder's brick DISAGREES with the
        // already-present link (same discipline as BRK2 above), so a leg
        // that started reconciling a PRESENT link against its holder would
        // be caught here too.
        makeRecord({
          acpxRecordId: "brk-untouched-h1",
          seatId: seatUntouched,
          holderOrdinal: 1,
          holderActive: true,
          metadata: { brick: BRICK_B },
        }),
      ]);

      // Pre-seed all three EXISTING rows — same mechanism as BRK2 above:
      // `backfillSeatRow` mints a row only when none exists, so this is how
      // an "the row already existed" seat is constructed for this leg.
      await backfillSeatRow(sessionsDir(homeDir), {
        seatId: seatBrk3,
        createdAt: "2026-01-01T00:00:00.000Z",
        activeHolderId: null,
        nextOrdinal: 2,
        closedAt: null,
        name: undefined,
        brickId: undefined,
        favorite: false,
      });
      await backfillSeatRow(sessionsDir(homeDir), {
        seatId: seatBrk4,
        createdAt: "2026-01-01T00:00:00.000Z",
        activeHolderId: null,
        nextOrdinal: 2,
        closedAt: null,
        name: undefined,
        brickId: undefined,
        favorite: false,
      });
      await backfillSeatRow(sessionsDir(homeDir), {
        seatId: seatUntouched,
        createdAt: "2026-01-01T00:00:00.000Z",
        activeHolderId: "brk-untouched-h1",
        nextOrdinal: 2,
        closedAt: null,
        name: undefined,
        brickId: { ref: BRICK_A, validated: true },
        favorite: false,
      });

      // THE ABSENCE DISCIPLINE: read the constructed fixture back from disk
      // BEFORE --apply — never trust the builder's intent for a
      // deliberately-absent value.
      const beforeStore = await readSeatStore(sessionsDir(homeDir));
      assert.equal(
        beforeStore.seats.get(seatBrk3)?.brickId,
        undefined,
        "fixture sanity: BRK3's row must start with brick_id ABSENT, read from disk",
      );
      assert.equal(
        beforeStore.seats.get(seatBrk4)?.brickId,
        undefined,
        "fixture sanity: BRK4's row must start with brick_id ABSENT, read from disk",
      );
      assert.deepEqual(
        beforeStore.seats.get(seatUntouched)?.brickId,
        { ref: BRICK_A, validated: true },
        "fixture sanity: the untouched seat must start WITH a link, read from disk",
      );

      const report = await backfill(homeDir, ["--apply"]);

      const afterStore = await readSeatStore(sessionsDir(homeDir));

      // BRK3 — a closed holder's link IS the seat's link.
      assert.deepEqual(
        afterStore.seats.get(seatBrk3)?.brickId,
        { ref: BRICK_A, validated: false },
        "a seat whose only holder is CLOSED must be filled from that holder's brick",
      );

      // BRK4 — the paired positive control, same run, always UNVALIDATED
      // (R28 (5)).
      assert.deepEqual(
        afterStore.seats.get(seatBrk4)?.brickId,
        { ref: BRICK_B, validated: false },
        "a seat with an OPEN active holder carrying a link must still be filled",
      );

      // untouched control — BRK2's invariant holds in this arm too, even
      // though the holder disagrees with the stored ref.
      assert.deepEqual(
        afterStore.seats.get(seatUntouched)?.brickId,
        { ref: BRICK_A, validated: true },
        "a seat whose row already carries a link must be left byte-identical",
      );

      // THE COUNT — BRK3 and BRK4 were filled this run; the untouched seat was not.
      assert.equal(
        report.brickLinksFilled,
        2,
        "exactly two seats (BRK3, BRK4) should have been filled this run",
      );
    });
  },
);

test(
  "BRK5: a FRESH seat whose only holder is CLOSED is minted WITH that holder's " +
    "brick link — the mint-path twin of BRK3, with a sibling mint in the same " +
    "arm proving the mint leg still fills from an OPEN holder",
  async () => {
    await withTempHome(async (homeDir) => {
      const seatClosedOnly = "b4b4b4b4-7777-4777-8777-777777777777";
      const seatWithOpenHolder = "b4b4b4b4-8888-4888-8888-888888888888";

      await seed(homeDir, [
        // The FRESH-MINT twin of BRK3: NO existing row (this is leg 3's
        // mint path — `planSeatRow`/`brickLinkFromHolders` — never leg 3¾'s
        // fill path), and the seat's only holder is CLOSED.
        makeRecord({
          acpxRecordId: "brk5-closed-h1",
          seatId: seatClosedOnly,
          holderOrdinal: 1,
          holderActive: false,
          closed: true,
          metadata: { brick: BRICK_A },
        }),
        // The sibling, SAME arm: an OPEN holder — the positive control proving
        // the mint leg is not disabled outright.
        makeRecord({
          acpxRecordId: "brk5-open-h1",
          seatId: seatWithOpenHolder,
          holderOrdinal: 1,
          holderActive: true,
          metadata: { brick: BRICK_B },
        }),
      ]);

      const report = await backfill(homeDir, ["--apply"]);
      assert.equal(report.seats, 2, "both seats are FRESH mints, never existing rows");

      const store = await readSeatStore(sessionsDir(homeDir));

      assert.deepEqual(
        store.seats.get(seatClosedOnly)?.brickId,
        { ref: BRICK_A, validated: false },
        "a freshly-minted seat whose only holder is CLOSED must carry that holder's brick link",
      );
      assert.deepEqual(
        store.seats.get(seatWithOpenHolder)?.brickId,
        { ref: BRICK_B, validated: false },
        "the sibling fresh mint with an OPEN holder must still mint the link",
      );
    });
  },
);

// ─── brick `eca085bb` — D-BRICK-ON-SEAT / D-SEAT-HOLD, AC-LINK1 and AC-LINK2.
// Reverses `5c4b8c4a`'s active-only narrowing: the seat's holder is its holder
// OPEN OR CLOSED, the brick link is taken from it, and a closed holder is never
// "vacant". AC-LINK1/AC-LINK2 are cited from `0d2b83f0`'s CONCEPTION.md
// (D-BRICK-ON-SEAT, §3), not restated. The close-path half of AC-LINK2 is in
// `seat-activate.test.ts`. ─────────────────────────────────────────────────

const BRICK_C = "7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

test(
  "AC-LINK1 (fresh mint): a seat whose ONLY holder is CLOSED is held by it and carries its brick, " +
    "the positive control (an OPEN holder) minted in the same run",
  async () => {
    await withTempHome(async (homeDir) => {
      const seatClosedOnly = "e1e1e1e1-0001-4001-8001-000000000001";
      const seatOpen = "e1e1e1e1-0002-4002-8002-000000000002";
      await seed(homeDir, [
        makeRecord({
          acpxRecordId: "lk1-closed",
          seatId: seatClosedOnly,
          holderOrdinal: 1,
          holderActive: false,
          closed: true,
          metadata: { brick: BRICK_A },
        }),
        makeRecord({
          acpxRecordId: "lk1-open",
          seatId: seatOpen,
          holderOrdinal: 1,
          holderActive: true,
          metadata: { brick: BRICK_B },
        }),
      ]);

      const report = await backfill(homeDir, ["--apply"]);
      assert.equal(report.seats, 2, "both seats are FRESH mints");
      const store = await readSeatStore(sessionsDir(homeDir));

      const closedRow = store.seats.get(seatClosedOnly);
      assert.equal(
        closedRow?.activeHolderId,
        "lk1-closed",
        "a closed holder keeps holding its seat — the pointer must name it, never null",
      );
      assert.deepEqual(
        closedRow?.brickId,
        { ref: BRICK_A, validated: false },
        "AC-LINK1 FAILED: the link is absent because the holder is closed",
      );
      assert.equal(closedRow?.closedAt, null, "the SEAT is not closed — only its holder is");
      assert.equal(store.seats.get(seatOpen)?.activeHolderId, "lk1-open", "control: the open seat");
      assert.deepEqual(store.seats.get(seatOpen)?.brickId, { ref: BRICK_B, validated: false });
    });
  },
);

test("AC-LINK1 (mirror): a fresh-minted CLOSED holder's `holder_active` mirror agrees with the seat's pointer", async () => {
  await withTempHome(async (homeDir) => {
    await seed(homeDir, [makeRecord({ acpxRecordId: "lk1-mirror", closed: true })]);
    await backfill(homeDir, ["--apply"]);

    const record = await readRecordJson(homeDir, "lk1-mirror");
    assert.equal(
      record.holder_active,
      true,
      "the record says nobody holds a seat whose pointer names it",
    );
    const row = (await readSeatStore(sessionsDir(homeDir))).seats.get(String(record.seat_id));
    assert.equal(row?.activeHolderId, "lk1-mirror");
    assert.equal((await readIndexEntries(homeDir)).get("lk1-mirror.json")?.holderActive, true);
  });
});

test("AC-LINK1 (which closed member): the flagged holder wins over a higher ordinal; no flag ⇒ highest ordinal", async () => {
  await withTempHome(async (homeDir) => {
    const seatFlagged = "e1e1e1e1-0003-4003-8003-000000000003";
    const seatUnflagged = "e1e1e1e1-0004-4004-8004-000000000004";
    await seed(homeDir, [
      // The flagged member is the LOWER ordinal, so "flag wins" and "highest
      // ordinal wins" predict different holders (same discipline as BRK1).
      makeRecord({
        acpxRecordId: "lk1-f1",
        seatId: seatFlagged,
        holderOrdinal: 1,
        holderActive: true,
        closed: true,
        metadata: { brick: BRICK_A },
      }),
      makeRecord({
        acpxRecordId: "lk1-f2",
        seatId: seatFlagged,
        holderOrdinal: 2,
        holderActive: false,
        closed: true,
        metadata: { brick: BRICK_B },
      }),
      makeRecord({
        acpxRecordId: "lk1-u1",
        seatId: seatUnflagged,
        holderOrdinal: 1,
        holderActive: false,
        closed: true,
        metadata: { brick: BRICK_A },
      }),
      makeRecord({
        acpxRecordId: "lk1-u2",
        seatId: seatUnflagged,
        holderOrdinal: 2,
        holderActive: false,
        closed: true,
        metadata: { brick: BRICK_C },
      }),
    ]);

    await backfill(homeDir, ["--apply"]);
    const store = await readSeatStore(sessionsDir(homeDir));
    assert.equal(store.seats.get(seatFlagged)?.activeHolderId, "lk1-f1");
    assert.equal(store.seats.get(seatFlagged)?.brickId?.ref, BRICK_A);
    assert.equal(store.seats.get(seatUnflagged)?.activeHolderId, "lk1-u2");
    assert.equal(store.seats.get(seatUnflagged)?.brickId?.ref, BRICK_C);
  });
});

const EXISTING_ROW_BASE = {
  createdAt: "2026-01-01T00:00:00.000Z",
  nextOrdinal: 2,
  name: undefined,
  brickId: undefined,
  favorite: false,
} as const;

test(
  "AC-LINK1 (existing rows — the 35 retired-holder seats on staging): the (d′) fill restores the link " +
    "AND the pointer; a present pointer, a present link and a CLOSED seat are left alone",
  async () => {
    await withTempHome(async (homeDir) => {
      const ids = {
        a: "e1e1e1e1-0010-4010-8010-000000000010",
        b: "e1e1e1e1-0011-4011-8011-000000000011",
        c: "e1e1e1e1-0012-4012-8012-000000000012",
        pointed: "e1e1e1e1-0013-4013-8013-000000000013",
        abolished: "e1e1e1e1-0014-4014-8014-000000000014",
      };
      await seed(homeDir, [
        // Three ALL-CLOSED seats on existing rows with a null pointer and no link:
        // two carry a brick, one does not.
        makeRecord({
          acpxRecordId: "lk1x-a",
          seatId: ids.a,
          holderOrdinal: 1,
          closed: true,
          metadata: { brick: BRICK_A },
        }),
        makeRecord({
          acpxRecordId: "lk1x-b",
          seatId: ids.b,
          holderOrdinal: 1,
          closed: true,
          metadata: { brick: BRICK_B },
        }),
        makeRecord({ acpxRecordId: "lk1x-c", seatId: ids.c, holderOrdinal: 1, closed: true }),
        // Never overwritten: the row already names a holder.
        makeRecord({
          acpxRecordId: "lk1x-p-old",
          seatId: ids.pointed,
          holderOrdinal: 1,
          closed: true,
          metadata: { brick: BRICK_A },
        }),
        makeRecord({
          acpxRecordId: "lk1x-p-new",
          seatId: ids.pointed,
          holderOrdinal: 2,
          holderActive: true,
          metadata: { brick: BRICK_B },
        }),
        // A seat the operator abolished (`closed_at` set) with a null pointer: the
        // pointer stays null — vacancy of an abolished seat is not ours to repair.
        makeRecord({
          acpxRecordId: "lk1x-abolished",
          seatId: ids.abolished,
          holderOrdinal: 1,
          closed: true,
          metadata: { brick: BRICK_A },
        }),
      ]);
      const dir = sessionsDir(homeDir);
      for (const seatId of [ids.a, ids.b, ids.c]) {
        await backfillSeatRow(dir, {
          seatId,
          activeHolderId: null,
          closedAt: null,
          ...EXISTING_ROW_BASE,
        });
      }
      await backfillSeatRow(dir, {
        seatId: ids.pointed,
        activeHolderId: "lk1x-p-new",
        closedAt: null,
        ...EXISTING_ROW_BASE,
        brickId: { ref: BRICK_C, validated: true },
      });
      await backfillSeatRow(dir, {
        seatId: ids.abolished,
        activeHolderId: null,
        closedAt: "2026-02-02T00:00:00.000Z",
        ...EXISTING_ROW_BASE,
      });

      // Fixture sanity, read back from disk: every row starts with a null pointer
      // (except `pointed`) and no link — the state the narrowing left behind.
      const before = await readSeatStore(dir);
      assert.equal(before.seats.get(ids.a)?.activeHolderId, null, "fixture: pointer starts null");
      assert.equal(before.seats.get(ids.a)?.brickId, undefined, "fixture: link starts absent");

      const dry = await backfill(homeDir, []);
      assert.equal(dry.activeHoldersFilled, 3, "the dry run must predict the pointer fills");
      assert.equal(dry.brickLinksFilled, 3, "the dry run must predict the link fills");

      const report = await backfill(homeDir, ["--apply"]);
      assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
      // THE PREDICTABLE NUMBERS: 3 all-closed seats ⇒ 3 pointers; the links are the 2
      // that carry a brick plus the abolished seat's (the link fill never looked at
      // `closed_at`; only the pointer fill does).
      assert.equal(report.activeHoldersFilled, 3);
      assert.equal(report.brickLinksFilled, 3);

      const after = await readSeatStore(dir);
      assert.equal(after.seats.get(ids.a)?.activeHolderId, "lk1x-a");
      assert.deepEqual(after.seats.get(ids.a)?.brickId, { ref: BRICK_A, validated: false });
      assert.equal(after.seats.get(ids.b)?.activeHolderId, "lk1x-b");
      assert.deepEqual(after.seats.get(ids.b)?.brickId, { ref: BRICK_B, validated: false });
      assert.equal(after.seats.get(ids.c)?.activeHolderId, "lk1x-c");
      assert.equal(
        after.seats.get(ids.c)?.brickId,
        undefined,
        "no brick on the holder, none made up",
      );
      assert.equal(
        after.seats.get(ids.pointed)?.activeHolderId,
        "lk1x-p-new",
        "a non-null pointer is never overwritten",
      );
      assert.deepEqual(after.seats.get(ids.pointed)?.brickId, { ref: BRICK_C, validated: true });
      assert.equal(after.seats.get(ids.abolished)?.activeHolderId, null);
      assert.deepEqual(after.seats.get(ids.abolished)?.brickId, { ref: BRICK_A, validated: false });
      assert.equal(after.seats.get(ids.abolished)?.closedAt, "2026-02-02T00:00:00.000Z");

      // A second run reports 0 and writes nothing.
      const afterFirst = await snapshot(homeDir);
      const second = await backfill(homeDir, ["--apply"]);
      assert.equal(second.activeHoldersFilled, 0);
      assert.equal(second.brickLinksFilled, 0);
      assert.deepEqual(
        diffNames(afterFirst, await snapshot(homeDir)).filter((n) => !n.includes(".bak-mig-")),
        [],
        "the second --apply changed the store",
      );
    });
  },
);

// ─── brick `eca085bb` fix round (TE c1c2c2b7) — the existing-row FILL sets the
// holder's `holder_active` mirror, record AND index entry, as a fresh mint does. ──

test(
  "MIRROR: the existing-row pointer fill sets the holder's mirror on record AND index entry; " +
    "the dry run counts the writes; a starred seat's filled holder is archive-protected",
  async () => {
    await withTempHome(async (homeDir) => {
      const seatId = "e1e1e1e1-0020-4020-8020-000000000020";
      const OLD = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await seed(homeDir, [
        makeRecord({
          acpxRecordId: "mir-h1",
          seatId,
          holderOrdinal: 1,
          holderActive: false,
          closed: true,
          closedAt: OLD.toISOString(),
          favorite: true,
        }),
      ]);
      const dir = sessionsDir(homeDir);
      await backfillSeatRow(dir, {
        seatId,
        activeHolderId: null,
        closedAt: null,
        ...EXISTING_ROW_BASE,
        favorite: true,
      });
      const recordFile = path.join(dir, "mir-h1.json");
      await fs.utimes(recordFile, OLD, OLD);
      assert.equal(
        (await readRecordJson(homeDir, "mir-h1")).holder_active,
        false,
        "fixture: mirror false",
      );

      const dry = await backfill(homeDir, []);
      assert.equal(dry.activeHoldersFilled, 1, "control: the pointer fill is predicted");
      assert.equal(dry.holderMirrorsSet, 1, "the dry run must count the mirror write");
      assert.equal(
        (await readRecordJson(homeDir, "mir-h1")).holder_active,
        false,
        "the dry run wrote the record",
      );

      const report = await backfill(homeDir, ["--apply"]);
      assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
      assert.equal(report.activeHoldersFilled, 1);
      assert.equal(report.holderMirrorsSet, 1);

      const row = (await readSeatStore(dir)).seats.get(seatId);
      assert.equal(row?.activeHolderId, "mir-h1");
      assert.equal(
        (await readRecordJson(homeDir, "mir-h1")).holder_active,
        true,
        "the record's mirror disagrees with the pointer",
      );
      assert.equal(
        (await readIndexEntries(homeDir)).get("mir-h1.json")?.holderActive,
        true,
        "the index entry's mirror disagrees with the pointer",
      );

      // The star guard reads the MIRROR: a starred seat's filled holder is protected.
      await fs.utimes(recordFile, OLD, OLD);
      const verdict = await revalidateBeforeApply(
        dir,
        "mir-h1",
        ["mir-h1.json"],
        true,
        60_000,
        Date.now(),
      );
      assert.equal(verdict.ok, false, "a starred seat's filled holder is archivable");
      if (!verdict.ok) {
        assert.equal(verdict.reason, "favorite");
      }

      const second = await backfill(homeDir, ["--apply"]);
      assert.equal(second.holderMirrorsSet, 0, "a second run must set no mirror");
    });
  },
);
