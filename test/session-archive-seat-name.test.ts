import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadWakeupLiveness } from "../src/session/archive/liveness.js";
import { foldArchiveManifest } from "../src/session/archive/manifest.js";
import {
  applyArchiveRun,
  createContext,
  listArchived,
  planArchiveRun,
  reindexArchive,
} from "../src/session/archive/operations.js";
import { resolveBoundaries } from "../src/session/archive/retention.js";
import { withSeatStoreWrite } from "../src/session/persistence/seat-store.js";
import { withTempDir } from "./runtime-test-helpers.js";

/**
 * D3 (brick b0c59024, D-NAME-HARD-MIGRATION): the record carries no `name` — the SEAT does. The
 * archive tier copies the record, so a session archived after the strip lost its name and showed a
 * title. The archive now captures the SEAT's display name at archive time into the manifest
 * (`name` column) and the shard entry (`name`), and never reads a record `name`.
 */

const SEAT_ID = "dddddddd-2222-4222-8222-222222222222";
const SEAT_NAMELESS_ID = "dddddddd-3333-4333-8333-333333333333";
const OLD_MS = 30 * 24 * 60 * 60 * 1000;

async function plantSeats(hotDir: string): Promise<void> {
  await withSeatStoreWrite(hotDir, (store) => {
    const seats = new Map(store.seats);
    for (const [seatId, name] of [
      [SEAT_ID, "  Release captain  "],
      [SEAT_NAMELESS_ID, undefined],
    ] as const) {
      seats.set(seatId, {
        seatId,
        createdAt: "2026-01-01T00:00:00.000Z",
        activeHolderId: null,
        nextOrdinal: 2,
        closedAt: null,
        name,
        brickId: undefined,
        favorite: undefined,
      });
    }
    return { mutation: { kind: "write", seats } as const, result: undefined };
  });
}

async function writeClosedRecord(
  hotDir: string,
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const file = path.join(hotDir, `${id}.json`);
  const closedAt = new Date(Date.now() - OLD_MS).toISOString();
  await fs.writeFile(
    file,
    JSON.stringify({
      acpx_record_id: id,
      closed: true,
      closed_at: closedAt,
      last_used_at: closedAt,
      cwd: "/tmp",
      ...fields,
    }),
    "utf8",
  );
  const old = new Date(Date.now() - OLD_MS);
  await fs.utimes(file, old, old);
}

async function archiveAll(hotDir: string) {
  const context = createContext(hotDir, "d3");
  const boundaries = resolveBoundaries(context.nowMs);
  const plan = await planArchiveRun(context, boundaries, {
    includeOrphans: false,
    liveness: { primary: undefined, wakeups: await loadWakeupLiveness(hotDir) },
  });
  const result = await applyArchiveRun({
    context,
    boundaries,
    plan,
    dryRun: false,
    allowFirstRun: true,
  });
  return { context, result };
}

test("D3: an archived session keeps its SEAT's name — shard entry and manifest; no seat ⇒ no name; a legacy record `name` is never read", async () => {
  await withTempDir("acpx-archive-seat-name-", async (hotDir) => {
    await plantSeats(hotDir);
    await writeClosedRecord(hotDir, "named-seat-session", {
      seat_id: SEAT_ID,
      title: "a title that must not show as the name",
    });
    await writeClosedRecord(hotDir, "nameless-seat-session", { seat_id: SEAT_NAMELESS_ID });
    await writeClosedRecord(hotDir, "seatless-session", {
      title: "a title",
      // a surviving pre-strip on-disk field: the archive must NOT read it (N1 guard)
      name: "legacy record name",
    });

    const { context, result } = await archiveAll(hotDir);
    assert.deepEqual(result.failures, []);
    assert.equal(result.moved.length, 3);

    const listed = await listArchived(context, {});
    const nameById = new Map(listed.entries.map((entry) => [entry.id, entry.name]));
    assert.equal(nameById.get("named-seat-session"), "Release captain");
    assert.equal(nameById.get("nameless-seat-session"), undefined);
    assert.equal(nameById.get("seatless-session"), undefined);

    const manifest = await fs.readFile(path.join(context.archiveDir, "MANIFEST.tsv"), "utf8");
    const nameColumn = new Map(
      manifest
        .split("\n")
        .map((line) => line.split("\t"))
        .filter((columns) => columns[2] === "archive" && columns[11]?.endsWith(".json"))
        .map((columns) => [columns[3], columns[9]]),
    );
    assert.equal(nameColumn.get("named-seat-session"), "Release captain");
    assert.equal(nameColumn.get("seatless-session"), "");
    assert.equal((await foldArchiveManifest(context.archiveDir)).skippedRows, 0);

    // A reindex rebuilds the shard from the archived record + manifest — the name must survive it
    // (the seat may have been renamed or deleted since; the archive row is the archive-time capture).
    await reindexArchive(context);
    const rebuilt = await listArchived(context, {});
    const rebuiltById = new Map(rebuilt.entries.map((entry) => [entry.id, entry.name]));
    assert.equal(rebuiltById.get("named-seat-session"), "Release captain");
    assert.equal(rebuiltById.get("seatless-session"), undefined);
  });
});
