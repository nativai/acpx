import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { revalidateBeforeApply } from "../src/session/archive/move.js";
import { withSeatStoreWrite } from "../src/session/persistence/seat-store.js";
import { withTempDir } from "./runtime-test-helpers.js";

/**
 * `revalidateBeforeApply` / `revalidateRecord` — the APPLY-TIME twin of
 * `retention.ts`'s seat-aware `favorite` blocker (D-STAR, brick `6adabe72`).
 *
 * `session-archive-retention.test.ts` covers the PLAN-time predicate
 * (`staticBlockerFor`) directly. Nothing in this repo previously drove
 * `revalidateBeforeApply` against a real filesystem, so this file builds the
 * smallest real rig it needs: one record file, one `seats.json`, no CLI.
 */

const SEAT_STARRED = "dddddddd-1111-4111-8111-111111111111";
const OLD_MS = 10 * 24 * 60 * 60 * 1000; // 10 days — well outside any quiet window

async function writeAgedRecord(
  hotDir: string,
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const file = path.join(hotDir, `${id}.json`);
  await fs.writeFile(file, JSON.stringify({ acpx_record_id: id, ...fields }), "utf8");
  const old = new Date(Date.now() - OLD_MS);
  await fs.utimes(file, old, old);
}

async function plantStarredSeat(hotDir: string, activeHolderId: string): Promise<void> {
  await withSeatStoreWrite(hotDir, (store) => {
    const seats = new Map(store.seats);
    seats.set(SEAT_STARRED, {
      seatId: SEAT_STARRED,
      createdAt: "2026-01-01T00:00:00.000Z",
      activeHolderId,
      nextOrdinal: 2,
      closedAt: null,
      name: undefined,
      brickId: undefined,
      favorite: true,
    });
    return { mutation: { kind: "write", seats } as const, result: undefined };
  });
}

test("revalidateBeforeApply: a starred seat's ACTIVE holder is refused — reason 'favorite'", async () => {
  await withTempDir("acpx-archive-move-fav-", async (hotDir) => {
    const id = "active-holder-id";
    await writeAgedRecord(hotDir, id, {
      closed: true,
      closed_at: new Date(Date.now() - OLD_MS).toISOString(),
      seat_id: SEAT_STARRED,
      holder_active: true,
    });
    await plantStarredSeat(hotDir, id);

    const result = await revalidateBeforeApply(
      hotDir,
      id,
      [`${id}.json`],
      true,
      60_000,
      Date.now(),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "favorite");
    }
  });
});

test("revalidateBeforeApply: a RETIRED holder of the same starred seat IS archivable", async () => {
  await withTempDir("acpx-archive-move-fav-", async (hotDir) => {
    const activeId = "active-holder-id";
    const retiredId = "retired-holder-id";
    await writeAgedRecord(hotDir, retiredId, {
      closed: true,
      closed_at: new Date(Date.now() - OLD_MS).toISOString(),
      seat_id: SEAT_STARRED,
      holder_active: false,
    });
    // The seat's active holder is a DIFFERENT record — the retired one is not it.
    await plantStarredSeat(hotDir, activeId);

    const result = await revalidateBeforeApply(
      hotDir,
      retiredId,
      [`${retiredId}.json`],
      true,
      60_000,
      Date.now(),
    );
    assert.equal(result.ok, true, "a retired holder of a starred seat must not be blocked");
  });
});

test("revalidateBeforeApply: an UN-starred seat's active holder is not blocked (control)", async () => {
  await withTempDir("acpx-archive-move-fav-", async (hotDir) => {
    const id = "active-holder-unstarred";
    await writeAgedRecord(hotDir, id, {
      closed: true,
      closed_at: new Date(Date.now() - OLD_MS).toISOString(),
      seat_id: "eeeeeeee-2222-4222-8222-222222222222",
      holder_active: true,
    });
    // No seat planted at all — the seat store has no row for this id's seat.

    const result = await revalidateBeforeApply(
      hotDir,
      id,
      [`${id}.json`],
      true,
      60_000,
      Date.now(),
    );
    assert.equal(result.ok, true);
  });
});
