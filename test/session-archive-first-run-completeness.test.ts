import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadWakeupLiveness } from "../src/session/archive/liveness.js";
import {
  applyArchiveRun,
  createContext,
  planArchiveRun,
} from "../src/session/archive/operations.js";
import { resolveBoundaries } from "../src/session/archive/retention.js";
import { withSeatStoreWrite } from "../src/session/persistence/seat-store.js";
import {
  fileExists,
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// Brick eadfe315 (TE-1e13-1): a held first-run dry run (or apply) used to return before the dry-run predictions, so it left out
// the lone spawn-state removals and the seat folds that the ALLOWED apply makes. A dry run must list everything the apply
// would do — measured here by comparing the held run's prediction with what the allowed apply then actually does.

const HOLDER = "holder-a";
const SEAT = "aaaaaaaa-1111-4111-8111-111111111111";
const LONE = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const OLD = "2026-01-01T00:00:00.000Z";

async function rig(home: string): Promise<{ hot: string; lone: string }> {
  const hot = path.join(home, ".acpx", "sessions");
  await fs.mkdir(hot, { recursive: true });
  await writeSessionRecordFile(
    home,
    makeSessionRecord({
      acpxRecordId: HOLDER,
      acpSessionId: HOLDER,
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: home,
      closed: true,
      closedAt: OLD,
      lastUsedAt: OLD,
      seatId: SEAT,
      holderOrdinal: 1,
      holderActive: true,
    }),
  );
  const old = new Date(OLD);
  await fs.utimes(sessionFilePath(home, HOLDER), old, old);
  await withSeatStoreWrite(hot, (store) => {
    const seats = new Map(store.seats);
    seats.set(SEAT, {
      seatId: SEAT,
      createdAt: OLD,
      activeHolderId: HOLDER,
      nextOrdinal: 2,
      closedAt: null,
      name: undefined,
      brickId: undefined,
      favorite: false,
    });
    return { mutation: { kind: "write", seats } as const, result: undefined };
  });
  const lone = path.join(hot, `${LONE}.spawn-state`);
  await fs.writeFile(lone, JSON.stringify({ v: 1, record_id: LONE }), "utf8");
  await fs.utimes(lone, old, old);
  return { hot, lone };
}

async function wave(hot: string, options: { dryRun: boolean; allowFirstRun: boolean }) {
  const context = createContext(hot, "t");
  const boundaries = resolveBoundaries(context.nowMs);
  const plan = await planArchiveRun(context, boundaries, {
    includeOrphans: false,
    liveness: { primary: undefined, wakeups: await loadWakeupLiveness(hot) },
  });
  return await applyArchiveRun({ context, boundaries, plan, ...options });
}

const loneLines = (warnings: string[]): string[] =>
  warnings.filter((line) => line.includes("spawn-state"));

test("a HELD first-run dry run and a HELD first-run apply both predict the lone spawn-state removal and the seat fold — and the allowed apply then does exactly that", async () => {
  await withTempHome("acpx-archive-first-run-complete-", async (home) => {
    const { hot, lone } = await rig(home);
    const seatsBefore = await fs.readFile(path.join(hot, "seats.json"), "utf8");

    for (const dryRun of [true, false]) {
      const held = await wave(hot, { dryRun, allowFirstRun: false });
      assert.equal(held.firstRunGated, true);
      assert.equal(held.applied, false);
      assert.deepEqual(held.moved, [], `held (dryRun=${dryRun}): nothing moved`);
      assert.equal(loneLines(held.warnings).length, 1, `held (dryRun=${dryRun}): the lone line`);
      assert.match(loneLines(held.warnings)[0] ?? "", new RegExp(`${LONE}\\.spawn-state`, "u"));
      assert.deepEqual(
        held.seatArchive?.folded.map((seat) => seat.seatId),
        [SEAT],
        `held (dryRun=${dryRun}): the seat fold is predicted`,
      );
      assert.equal(held.seatArchive?.seatStoreWrites, 0, "a prediction writes nothing");
      // and it touched nothing
      assert.equal(await fileExists(lone), true);
      assert.equal(await fs.readFile(path.join(hot, "seats.json"), "utf8"), seatsBefore);
      await assert.rejects(fs.stat(path.join(home, ".acpx", "sessions-archive")));
    }

    // the allowed apply does what the held run said
    const predicted = await wave(hot, { dryRun: true, allowFirstRun: false });
    const applied = await wave(hot, { dryRun: false, allowFirstRun: true });
    assert.equal(applied.applied, true);
    assert.equal(
      await fileExists(lone),
      false,
      "the lone spawn-state the held run named is removed",
    );
    assert.deepEqual(
      applied.moved.map((entry) => entry.id),
      [HOLDER],
    );
    assert.deepEqual(
      applied.seatArchive?.folded.map((seat) => seat.seatId),
      predicted.seatArchive?.folded.map((seat) => seat.seatId),
      "the seats folded are the seats predicted",
    );
  });
});

test("NEGATIVE: with nothing for the apply to do beyond the gate, the held run predicts nothing extra (no lone line, no fold)", async () => {
  await withTempHome("acpx-archive-first-run-complete-", async (home) => {
    const hot = path.join(home, ".acpx", "sessions");
    await fs.mkdir(hot, { recursive: true });
    const held = await wave(hot, { dryRun: true, allowFirstRun: false });
    assert.equal(held.firstRunGated, true);
    assert.deepEqual(loneLines(held.warnings), []);
    assert.deepEqual(held.seatArchive?.folded ?? [], []);
  });
});
