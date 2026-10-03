import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { backfillSeatRow, readSeatStore } from "../src/session/persistence/seat-store.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

/**
 * brick `6cb4f4dc` — A SEAT EXISTS ONLY FOR A SESSION THAT HAS A RECORD.
 *
 * The measured leak: acpx-ui's codex-model-catalogue probe does `sessions new` →
 * `sessions close` → `sessions prune`, and the prune deleted the record and left the
 * seat row (28–29 such rows on devbox-staging). Two halves are pinned here, both
 * through the REAL compiled CLI against an isolated rig:
 *
 *   (b) `acpx seats backfill` COUNTS and LISTS holder-less seats on a dry run and
 *       `--apply` removes them — with a narrow class: a holder is a record FILE (hot
 *       or archive), parseable or not.
 *   (a) `sessions prune` reaps the seat of a record it deletes, unless that seat still
 *       has another holder.
 *
 * Every red row asserts a VALUE (a text line, a row's presence on disk) rather than a
 * new type, so each row COMPILES against a tree that lacks the feature and fails as an
 * assertion there.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const AGENT_COMMAND = "node /opt/claude-agent-acp/dist/index.js";

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
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
  return withTempHomeFixture("acpx-seat-holderless-", run);
}

function sessionsDir(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions");
}

function archiveDir(homeDir: string): string {
  return path.join(homeDir, ".acpx", "sessions-archive");
}

function makeRecord(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return makeSessionRecord(
    {
      acpxRecordId: id,
      acpSessionId: `acp-${id}`,
      agentCommand: AGENT_COMMAND,
      agentName: "claude",
      cwd: "/tmp/rig",
      closed: true,
      closedAt: "2026-07-24T04:39:56.000Z",
      ...overrides,
    },
    { defaultName: false, defaultAcpx: false },
  );
}

async function plantRow(homeDir: string, seatId: string, activeHolderId: string): Promise<void> {
  await backfillSeatRow(sessionsDir(homeDir), {
    seatId,
    createdAt: "2026-01-01T00:00:00.000Z",
    activeHolderId,
    nextOrdinal: 2,
    closedAt: null,
    name: undefined,
    brickId: undefined,
    favorite: false,
  });
}

async function rowIds(homeDir: string): Promise<string[]> {
  return [...(await readSeatStore(sessionsDir(homeDir))).seats.keys()].toSorted();
}

const GONE = "aaaaaaaa-0000-4000-8000-00000000000a";
const LIVE = "bbbbbbbb-0000-4000-8000-00000000000b";
const ARCHIVED = "cccccccc-0000-4000-8000-00000000000c";
const GARBLED = "dddddddd-0000-4000-8000-00000000000d";

/** Rows: GONE (holder has no record anywhere), LIVE (holder in the hot tier — the
 * control), ARCHIVED (holder only in the archive), GARBLED (holder's record exists
 * but is not JSON). The records for the last three are written; GONE's never is. */
async function seedPopulation(homeDir: string): Promise<void> {
  await writeSessionRecordFile(homeDir, makeRecord("live-holder", { seatId: LIVE }));
  await plantRow(homeDir, GONE, "gone-holder");
  await plantRow(homeDir, LIVE, "live-holder");

  await writeSessionRecordFile(homeDir, makeRecord("archived-holder", { seatId: ARCHIVED }));
  await fs.mkdir(archiveDir(homeDir), { recursive: true });
  await fs.rename(
    sessionFilePath(homeDir, "archived-holder"),
    path.join(archiveDir(homeDir), `${encodeURIComponent("archived-holder")}.json`),
  );
  await plantRow(homeDir, ARCHIVED, "archived-holder");

  await fs.writeFile(
    path.join(sessionsDir(homeDir), `${encodeURIComponent("garbled-holder")}.json`),
    '{"acpx_record_id": "garbled-holder", "seat_id": ',
    "utf8",
  );
  await plantRow(homeDir, GARBLED, "garbled-holder");
}

// ─── (b) the backfill ────────────────────────────────────────────────────────

test("HL1: a DRY RUN counts and LISTS the holder-less seat, and writes nothing", async () => {
  await withTempHome(async (homeDir) => {
    await seedPopulation(homeDir);
    const before = await fs.readFile(path.join(sessionsDir(homeDir), "seats.json"), "utf8");

    const result = await runCli(["seats", "backfill"], homeDir);
    assert.equal(result.code, 0, result.stderr);

    assert.match(
      result.stdout,
      /holder-less seats to reap:\s+1\b/,
      "the dry run must carry the stable counter line, counting exactly the one holder-less seat",
    );
    assert.ok(result.stdout.includes(GONE), "the dry run must LIST the seat id it would reap");
    for (const kept of [LIVE, ARCHIVED, GARBLED]) {
      assert.ok(
        !result.stdout.includes(kept),
        `a seat that has a holder must not be listed: ${kept}`,
      );
    }
    assert.equal(
      await fs.readFile(path.join(sessionsDir(homeDir), "seats.json"), "utf8"),
      before,
      "a dry run writes nothing",
    );
  });
});

test("HL2: --apply REMOVES the holder-less seat and exactly that one", async () => {
  await withTempHome(async (homeDir) => {
    await seedPopulation(homeDir);

    const result = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim()) as { holderlessSeats?: string[] };
    assert.deepEqual(report.holderlessSeats, [GONE], "the report lists what it reaped");

    assert.deepEqual(
      await rowIds(homeDir),
      [ARCHIVED, GARBLED, LIVE].toSorted(),
      "only the holder-less row is gone; the control, the archived-holder and the garbled-holder rows stay",
    );

    const second = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.deepEqual(
      (JSON.parse(second.stdout.trim()) as { holderlessSeats?: string[] }).holderlessSeats,
      [],
      "a second run reaps nothing — idempotent",
    );
  });
});

test("HL3: a seat whose holder is only in the ARCHIVE is kept (apply)", async () => {
  await withTempHome(async (homeDir) => {
    await seedPopulation(homeDir);
    await runCli(["seats", "backfill", "--apply"], homeDir);
    assert.ok(
      (await rowIds(homeDir)).includes(ARCHIVED),
      "an archived session is a session with a record — its seat must survive the reap",
    );
  });
});

test("HL4: a seat whose holder record exists but does NOT PARSE is kept (apply)", async () => {
  await withTempHome(async (homeDir) => {
    await seedPopulation(homeDir);
    await runCli(["seats", "backfill", "--apply"], homeDir);
    assert.ok(
      (await rowIds(homeDir)).includes(GARBLED),
      "an unparseable record is still a record — never absent, never reaped",
    );
  });
});

test("HL5: a NON-active holder found only by its record's seat_id keeps the seat — hot unparseable and archived", async () => {
  await withTempHome(async (homeDir) => {
    // Both seats' ACTIVE holder has no file. Their other holder does: one in the
    // archive (parseable), one in the hot tier as invalid JSON whose text still names
    // the seat. A `parent_seat_id` naming a seat is NOT a holder and must not keep one.
    const HOT_GARBLED_SEAT = "11111111-0000-4000-8000-000000000001";
    const ARCHIVE_SEAT = "22222222-0000-4000-8000-000000000002";
    const PARENT_ONLY_SEAT = "33333333-0000-4000-8000-000000000003";
    await plantRow(homeDir, HOT_GARBLED_SEAT, "gone-1");
    await plantRow(homeDir, ARCHIVE_SEAT, "gone-2");
    await plantRow(homeDir, PARENT_ONLY_SEAT, "gone-3");
    await fs.writeFile(
      path.join(sessionsDir(homeDir), `${encodeURIComponent("older-holder")}.json`),
      `{"acpx_record_id": "older-holder", "seat_id": "${HOT_GARBLED_SEAT}", "holder_ordinal": 1,`,
      "utf8",
    );
    await writeSessionRecordFile(
      homeDir,
      makeRecord("older-archived", { seatId: ARCHIVE_SEAT, holderOrdinal: 1 }),
    );
    await fs.mkdir(archiveDir(homeDir), { recursive: true });
    await fs.rename(
      sessionFilePath(homeDir, "older-archived"),
      path.join(archiveDir(homeDir), `${encodeURIComponent("older-archived")}.json`),
    );
    await writeSessionRecordFile(
      homeDir,
      makeRecord("child", { parentSeatId: PARENT_ONLY_SEAT, parentSessionId: "gone-3" }),
    );

    const result = await runCli(["seats", "backfill", "--apply", "--format", "json"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      (JSON.parse(result.stdout.trim()) as { holderlessSeats?: string[] }).holderlessSeats,
      [PARENT_ONLY_SEAT],
      "only the seat that is merely a PARENT is holder-less",
    );
    assert.deepEqual(await rowIds(homeDir), [ARCHIVE_SEAT, HOT_GARBLED_SEAT].toSorted());
  });
});

test("HL6: control — a store of normal seats reports zero and reaps nothing", async () => {
  await withTempHome(async (homeDir) => {
    await writeSessionRecordFile(homeDir, makeRecord("normal", { seatId: LIVE }));
    await plantRow(homeDir, LIVE, "normal");
    const before = await fs.readFile(path.join(sessionsDir(homeDir), "seats.json"), "utf8");

    const result = await runCli(["seats", "backfill", "--apply"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      await fs.readFile(path.join(sessionsDir(homeDir), "seats.json"), "utf8"),
      before,
      "nothing to reap ⇒ the store is byte-identical",
    );
  });
});

// ─── (a) prune ───────────────────────────────────────────────────────────────

test("HL7: pruning the SOLE holder's record reaps its seat row (the catalogue-probe shape)", async () => {
  await withTempHome(async (homeDir) => {
    await writeSessionRecordFile(homeDir, makeRecord("probe", { seatId: GONE }));
    await writeSessionRecordFile(homeDir, makeRecord("bystander", { seatId: LIVE }));
    await plantRow(homeDir, GONE, "probe");
    await plantRow(homeDir, LIVE, "bystander");

    const result = await runCli(["claude", "sessions", "prune", "probe"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(fs.access(sessionFilePath(homeDir, "probe")), "precondition: it pruned");

    assert.deepEqual(
      await rowIds(homeDir),
      [LIVE],
      "the pruned session's seat must go with its last holder; the bystander's seat stays",
    );
  });
});

test("HL8: pruning ONE of two holders keeps the seat", async () => {
  await withTempHome(async (homeDir) => {
    await writeSessionRecordFile(
      homeDir,
      makeRecord("old-holder", { seatId: GONE, holderOrdinal: 1, holderActive: false }),
    );
    await writeSessionRecordFile(
      homeDir,
      makeRecord("new-holder", { seatId: GONE, holderOrdinal: 2, holderActive: true }),
    );
    await plantRow(homeDir, GONE, "new-holder");

    const result = await runCli(["claude", "sessions", "prune", "old-holder"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(fs.access(sessionFilePath(homeDir, "old-holder")), "it pruned");
    assert.deepEqual(await rowIds(homeDir), [GONE], "the seat still has a holder");
  });
});

test("HL9: pruning a holder whose SEAT has an archived second holder keeps the seat", async () => {
  await withTempHome(async (homeDir) => {
    await writeSessionRecordFile(homeDir, makeRecord("pruned", { seatId: GONE, holderOrdinal: 2 }));
    await writeSessionRecordFile(homeDir, makeRecord("cold", { seatId: GONE, holderOrdinal: 1 }));
    await fs.mkdir(archiveDir(homeDir), { recursive: true });
    await fs.rename(
      sessionFilePath(homeDir, "cold"),
      path.join(archiveDir(homeDir), `${encodeURIComponent("cold")}.json`),
    );
    await plantRow(homeDir, GONE, "pruned");

    const result = await runCli(["claude", "sessions", "prune", "pruned"], homeDir);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(fs.access(sessionFilePath(homeDir, "pruned")), "it pruned");
    assert.deepEqual(await rowIds(homeDir), [GONE], "an archived holder still holds the seat");
  });
});
