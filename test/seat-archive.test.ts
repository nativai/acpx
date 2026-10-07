import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveSeatActiveHolder } from "../src/cli/session-selector.js";
import { loadWakeupLiveness } from "../src/session/archive/liveness.js";
import {
  applyArchiveRun,
  createContext,
  planArchiveRun,
  runRestore,
} from "../src/session/archive/operations.js";
import { resolveBoundaries } from "../src/session/archive/retention.js";
import { withSeatStoreWrite } from "../src/session/persistence/seat-store.js";
import { runSeatBackfill } from "../src/session/seat-backfill.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

/**
 * Brick 87497c17 (Daniel's Option A, 2026-10-07): A SEAT IS ARCHIVED WITH ITS ACTIVE HOLDER.
 *
 * The retention wave moved 123 seat holders into the archive tier on devbox and left their
 * rows in `seats.json` pointing at records that are no longer hot (DANGLING). The rows now
 * travel to a ledger, `~/.acpx/sessions/seat-archive/<seat>.json`, and back on restore.
 *
 * Every row drives a pre-existing entry point — the wave (`applyArchiveRun`), the restore
 * (`runRestore`), the backfill, the seat resolver, the compiled CLI — and reads the ledger as a
 * PATH on disk, so each one compiles against a tree without the feature and fails there as an
 * assertion, not as a missing import.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const OLD = "2026-01-01T00:00:00.000Z";
const SEAT_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SEAT_B = "bbbbbbbb-2222-4222-8222-222222222222";
const SEAT_HOT = "cccccccc-3333-4333-8333-333333333333";
const SEAT_STAR = "dddddddd-4444-4444-8444-444444444444";
const SEAT_GONE = "eeeeeeee-5555-4555-8555-555555555555";
const BRICK = "03bc080b-eccc-4529-82cf-8e05c4e8a054";

type Rig = { home: string; hot: string; archive: string };

function rigOf(home: string): Rig {
  const hot = path.join(home, ".acpx", "sessions");
  return { home, hot, archive: `${hot}-archive` };
}

async function writeHolder(
  rig: Rig,
  id: string,
  seatId: string,
  holder: { ordinal?: number; active?: boolean; closed?: boolean } = {},
): Promise<void> {
  const record: SessionRecord = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: id,
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: rig.home,
    closed: holder.closed ?? true,
    closedAt: OLD,
    lastUsedAt: OLD,
    seatId,
    holderOrdinal: holder.ordinal ?? 1,
    holderActive: holder.active ?? true,
  });
  await writeSessionRecordFile(rig.home, record);
  const old = new Date(OLD);
  await fs.utimes(sessionFilePath(rig.home, id), old, old);
}

type RowSpec = {
  seatId: string;
  holder: string | null;
  name?: string;
  favorite?: boolean;
  brick?: string;
  nextOrdinal?: number;
};

async function plantRows(rig: Rig, rows: readonly RowSpec[]): Promise<void> {
  await withSeatStoreWrite(rig.hot, (store) => {
    const seats = new Map(store.seats);
    for (const row of rows) {
      seats.set(row.seatId, {
        seatId: row.seatId,
        createdAt: OLD,
        activeHolderId: row.holder,
        nextOrdinal: row.nextOrdinal ?? 2,
        closedAt: null,
        name: row.name,
        brickId: row.brick ? { ref: row.brick, validated: true } : undefined,
        favorite: row.favorite ?? false,
      });
    }
    return { mutation: { kind: "write", seats } as const, result: undefined };
  });
}

async function seatsJson(rig: Rig): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await fs.readFile(path.join(rig.hot, "seats.json"), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
}

function ledgerPath(rig: Rig, seatId: string): string {
  return path.join(rig.hot, "seat-archive", `${seatId}.json`);
}

async function readLedger(rig: Rig, seatId: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(ledgerPath(rig, seatId), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

/** A previous wave's move, without any seat handling: the record goes to the archive dir. */
async function moveToArchiveByHand(rig: Rig, id: string): Promise<void> {
  await fs.mkdir(rig.archive, { recursive: true });
  await fs.rename(sessionFilePath(rig.home, id), path.join(rig.archive, `${id}.json`));
}

async function wave(rig: Rig, ids: readonly string[], dryRun = false) {
  const context = createContext(rig.hot, "test");
  const boundaries = resolveBoundaries(context.nowMs);
  const plan = await planArchiveRun(context, boundaries, {
    includeOrphans: false,
    explicitIds: ids,
    liveness: { primary: undefined, wakeups: await loadWakeupLiveness(rig.hot) },
  });
  return await applyArchiveRun({ context, boundaries, plan, dryRun, allowFirstRun: true });
}

/** The toolkit classifier's DANGLING count: rows whose active holder is not a hot record. */
async function dangling(rig: Rig): Promise<string[]> {
  const rows = await seatsJson(rig);
  const out: string[] = [];
  for (const [seatId, row] of Object.entries(rows)) {
    const holder = row.active_holder_id;
    if (typeof holder !== "string") {
      continue;
    }
    try {
      await fs.access(path.join(rig.hot, `${encodeURIComponent(holder)}.json`));
    } catch {
      out.push(seatId);
    }
  }
  return out;
}

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], home: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ACPX_STATE_HOME: home };
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
      "ACPX_SESSIONS_ARCHIVE_DIR",
    ]) {
      delete env[key];
    }
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      cwd: home,
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

async function withRig(run: (rig: Rig) => Promise<void>): Promise<void> {
  await withTempHome("acpx-seat-archive-", async (home) => {
    await fs.mkdir(path.join(home, ".acpx", "sessions"), { recursive: true });
    await run(rigOf(home));
  });
}

test("A1: a real wave archives seats' active holders ⇒ the rows are in the ledger, not seats.json, in ONE store write; DANGLING 0", async () => {
  await withRig(async (rig) => {
    await writeHolder(rig, "holder-a", SEAT_A);
    await writeHolder(rig, "holder-b", SEAT_B);
    await writeHolder(rig, "holder-hot", SEAT_HOT);
    await plantRows(rig, [
      { seatId: SEAT_A, holder: "holder-a", name: "  Release captain  ", brick: BRICK },
      { seatId: SEAT_B, holder: "holder-b" },
      { seatId: SEAT_HOT, holder: "holder-hot", name: "stays" },
    ]);
    const before = await seatsJson(rig);

    const result = await wave(rig, ["holder-a", "holder-b"]);
    assert.deepEqual(
      result.moved.map((entry) => entry.id).toSorted(),
      ["holder-a", "holder-b"],
      "the wave itself moved both holders",
    );

    const after = await seatsJson(rig);
    assert.equal(after[SEAT_A], undefined, "SEAT_A left seats.json");
    assert.equal(after[SEAT_B], undefined, "SEAT_B left seats.json");
    assert.deepEqual(
      after[SEAT_HOT],
      before[SEAT_HOT],
      "a seat whose holder stays hot is untouched",
    );

    const ledgerA = await readLedger(rig, SEAT_A);
    assert.ok(ledgerA, "SEAT_A is in the ledger subdirectory");
    const { holder_id, archived_at, wave: waveToken, ...rowA } = ledgerA;
    assert.deepEqual(rowA, before[SEAT_A], "the ledger holds the row exactly as seats.json had it");
    assert.equal(holder_id, "holder-a");
    assert.equal(typeof archived_at, "string");
    assert.equal(typeof waveToken, "string");
    assert.ok(await readLedger(rig, SEAT_B), "SEAT_B is in the ledger subdirectory");

    // Design point 2: all removals of one run in ONE seats.json write.
    assert.equal(result.seatArchive?.seatStoreWrites, 1);
    assert.equal(result.seatArchive?.folded.length, 2);
    assert.deepEqual(await dangling(rig), [], "DANGLING 0");

    // The ledger is never a FILE beside the records, never inside the archive dir.
    const hotFiles = await fs.readdir(rig.hot, { withFileTypes: true });
    assert.equal(
      hotFiles.some((entry) => entry.isFile() && entry.name.includes(SEAT_A)),
      false,
    );
    const archiveFiles = await fs.readdir(rig.archive);
    assert.equal(
      archiveFiles.some((name) => name.includes(SEAT_A) || name === "seat-archive"),
      false,
    );
  });
});

test("A2: a wave folds the BACKLOG of an earlier wave; a seat whose holder is missing but NOT archived is left alone", async () => {
  await withRig(async (rig) => {
    await writeHolder(rig, "holder-a", SEAT_A);
    await writeHolder(rig, "holder-hot", SEAT_HOT);
    await plantRows(rig, [
      { seatId: SEAT_A, holder: "holder-a" },
      { seatId: SEAT_HOT, holder: "holder-hot" },
      // Negative control: no record anywhere — not this module's population.
      { seatId: SEAT_GONE, holder: "holder-pruned" },
    ]);
    await moveToArchiveByHand(rig, "holder-a");
    const before = await seatsJson(rig);

    // A wave that selects nothing of its own still folds the backlog.
    const result = await wave(rig, ["no-such-id"]);
    assert.equal(result.moved.length, 0);

    const after = await seatsJson(rig);
    assert.equal(after[SEAT_A], undefined, "the backlog seat was folded");
    assert.ok(await readLedger(rig, SEAT_A));
    assert.deepEqual(after[SEAT_GONE], before[SEAT_GONE], "negative control untouched");
    assert.equal(await readLedger(rig, SEAT_GONE), undefined, "negative control not in the ledger");
    assert.deepEqual(await dangling(rig), [SEAT_GONE], "only the negative control still dangles");
  });
});

test("A3: `sessions restore <holder>` puts the row back FIELD FOR FIELD; `--seat` resolves again; while archived the refusal names the restore", async () => {
  await withRig(async (rig) => {
    await writeHolder(rig, "holder-a", SEAT_A, { ordinal: 3 });
    await plantRows(rig, [
      {
        seatId: SEAT_A,
        holder: "holder-a",
        name: "  Release captain  ",
        brick: BRICK,
        nextOrdinal: 4,
      },
    ]);
    const before = (await seatsJson(rig))[SEAT_A];
    await wave(rig, ["holder-a"]);
    assert.equal((await seatsJson(rig))[SEAT_A], undefined);

    await assert.rejects(
      resolveSeatActiveHolder("--seat", SEAT_A),
      (error: Error) =>
        error.message.includes("acpx sessions restore holder-a") &&
        error.message.includes("ARCHIVED"),
      "an archived seat's refusal names its holder and the restore command",
    );

    const restored = await runRestore(createContext(rig.hot, "restore"), ["holder-a"]);
    assert.deepEqual(
      restored.restored.map((entry) => entry.id),
      ["holder-a"],
    );
    assert.deepEqual((await seatsJson(rig))[SEAT_A], before, "the row is back, field for field");
    assert.equal(await readLedger(rig, SEAT_A), undefined, "the ledger file is gone");
    assert.deepEqual(await resolveSeatActiveHolder("--seat", SEAT_A), {
      seatId: SEAT_A,
      holderId: "holder-a",
    });
  });
});

test("A5: an archived active holder of a STARRED seat is not folded — the seat is reported by name", async () => {
  await withRig(async (rig) => {
    await writeHolder(rig, "holder-star", SEAT_STAR);
    await plantRows(rig, [
      { seatId: SEAT_STAR, holder: "holder-star", name: "Pinned", favorite: true },
    ]);
    const before = await seatsJson(rig);
    // The star guard keeps such a holder hot; this is the state when it did not (42ee6cb4).
    await moveToArchiveByHand(rig, "holder-star");

    const result = await wave(rig, ["no-such-id"]);
    assert.deepEqual(await seatsJson(rig), before, "the starred row stays in seats.json");
    assert.equal(await readLedger(rig, SEAT_STAR), undefined);
    assert.deepEqual(
      result.seatArchive?.starred.map((seat) => [seat.seatId, seat.name]),
      [[SEAT_STAR, "Pinned"]],
    );
  });
});

test("A6: an archived seat whose RETIRED holder is still hot ⇒ `seats backfill --apply` mints nothing and reports it archived", async () => {
  await withRig(async (rig) => {
    await writeHolder(rig, "holder-retired", SEAT_A, { ordinal: 1, active: false });
    await writeHolder(rig, "holder-active", SEAT_A, { ordinal: 2, active: true });
    await plantRows(rig, [{ seatId: SEAT_A, holder: "holder-active", nextOrdinal: 3 }]);
    await wave(rig, ["holder-active"]);
    assert.equal((await seatsJson(rig))[SEAT_A], undefined);
    const ledgerBefore = await readLedger(rig, SEAT_A);

    const report = await runSeatBackfill({
      sessionDir: rig.hot,
      apply: true,
      liveScan: {
        scanned: 1,
        environRead: 1,
        pids: new Set([1]),
        referencedDirs: new Set<string>(),
        referencedSessionIds: new Set<string>(),
      },
    });
    assert.equal(report.seats, 0, "no row minted");
    assert.equal((await seatsJson(rig))[SEAT_A], undefined, "seats.json still has no row");
    assert.deepEqual(report.archivedSeats, [SEAT_A], "reported as archived");
    assert.deepEqual(await readLedger(rig, SEAT_A), ledgerBefore, "the ledger is untouched");
  });
});

test("A7: killed between the ledger write and the row removal ⇒ the next run converges, the row in exactly one place", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores directory permissions; the torn state cannot be produced this way");
    return;
  }
  await withRig(async (rig) => {
    await writeHolder(rig, "holder-a", SEAT_A);
    await plantRows(rig, [{ seatId: SEAT_A, holder: "holder-a", name: "torn" }]);
    const before = (await seatsJson(rig))[SEAT_A];
    await moveToArchiveByHand(rig, "holder-a");
    await fs.mkdir(path.join(rig.hot, "seat-archive"));

    // The ledger subdirectory stays writable; seats.json's directory does not — the run
    // writes the ledger file and then dies writing the store.
    await fs.chmod(rig.hot, 0o555);
    let torn: CliResult;
    try {
      torn = await runCli(["seats", "reconcile-archive", "holder-a"], rig.home);
    } finally {
      await fs.chmod(rig.hot, 0o755);
    }
    assert.notEqual(torn.code, 0, "the interrupted run failed");
    assert.deepEqual((await seatsJson(rig))[SEAT_A], before, "row still in seats.json");
    assert.ok(await readLedger(rig, SEAT_A), "…and already in the ledger: in BOTH, never neither");

    const next = await runCli(["seats", "reconcile-archive", "holder-a"], rig.home);
    assert.equal(next.code, 0, next.stderr);
    assert.equal((await seatsJson(rig))[SEAT_A], undefined, "converged: out of seats.json");
    assert.ok(await readLedger(rig, SEAT_A), "converged: in the ledger");

    // The other torn direction: both present and the holder is HOT again ⇒ the row stands.
    await fs.rename(path.join(rig.archive, "holder-a.json"), sessionFilePath(rig.home, "holder-a"));
    await plantRows(rig, [{ seatId: SEAT_A, holder: "holder-a", name: "torn" }]);
    const both = await runCli(["seats", "reconcile-archive", "holder-a"], rig.home);
    assert.equal(both.code, 0, both.stderr);
    assert.deepEqual((await seatsJson(rig))[SEAT_A], before);
    assert.equal(await readLedger(rig, SEAT_A), undefined, "the ledger copy was dropped");
  });
});

test("dry run: a wave's dry run writes nothing and predicts the seats it would fold", async () => {
  await withRig(async (rig) => {
    await writeHolder(rig, "holder-a", SEAT_A);
    await plantRows(rig, [{ seatId: SEAT_A, holder: "holder-a" }]);
    const bytes = await fs.readFile(path.join(rig.hot, "seats.json"), "utf8");

    const result = await wave(rig, ["holder-a"], true);
    assert.equal(result.applied, false);
    assert.equal(await fs.readFile(path.join(rig.hot, "seats.json"), "utf8"), bytes);
    await assert.rejects(fs.access(path.join(rig.hot, "seat-archive")));
    assert.deepEqual(
      result.seatArchive?.folded.map((seat) => seat.seatId),
      [SEAT_A],
    );
    assert.equal(result.seatArchive?.seatStoreWrites, 0);
  });
});

test("idempotent + the one-holder verb: a second wave moves nothing; a holder restored outside acpx gets its seat from `seats reconcile-archive`", async () => {
  await withRig(async (rig) => {
    await writeHolder(rig, "holder-a", SEAT_A);
    await plantRows(rig, [{ seatId: SEAT_A, holder: "holder-a", name: "Back again" }]);
    const before = (await seatsJson(rig))[SEAT_A];
    await wave(rig, ["holder-a"]);

    const second = await wave(rig, ["no-such-id"]);
    assert.equal(second.seatArchive?.folded.length, 0);
    assert.equal(second.seatArchive?.unfolded.length, 0);
    assert.equal(second.seatArchive?.seatStoreWrites, 0);

    // While archived, a seat verb's refusal names the restore — not "typo" or "backfill".
    const show = await runCli(["seats", "show", SEAT_A], rig.home);
    assert.notEqual(show.code, 0);
    assert.match(show.stdout + show.stderr, /acpx sessions restore holder-a/);

    // acpx-ui's Restore moves the files itself, then calls the verb.
    await fs.rename(path.join(rig.archive, "holder-a.json"), sessionFilePath(rig.home, "holder-a"));
    const run = await runCli(
      ["seats", "reconcile-archive", "holder-a", "--format", "json"],
      rig.home,
    );
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual((await seatsJson(rig))[SEAT_A], before);
    assert.equal(await readLedger(rig, SEAT_A), undefined);
    const again = await runCli(
      ["seats", "reconcile-archive", "holder-a", "--format", "json"],
      rig.home,
    );
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /"seatStoreWrites": ?0/);
  });
});
