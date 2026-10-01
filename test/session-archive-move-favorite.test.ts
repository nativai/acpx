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

// ── D-STAR TRI-STATE FIX — the two windows a first cut silently unprotected ───
//
// Caught by the L0, 2026-09-30T23:39Z, brick `6adabe72`: reading the seat alone
// and coercing an unmigrated seat's `favorite` to `false` drops protection for
// (A) any seat row that exists but has not been through the migration yet, and
// (B) any record with no seat at all — production's steady state pre-backfill.
// Both rows below are RED against that first cut and GREEN after the fix.

test("revalidateBeforeApply ROW 1: a seat row WITHOUT the favorite field yet — legacy record.favorite:true still blocks the active holder", async () => {
  await withTempDir("acpx-archive-move-fav-", async (hotDir) => {
    const id = "unmigrated-active-holder";
    await writeAgedRecord(hotDir, id, {
      closed: true,
      closed_at: new Date(Date.now() - OLD_MS).toISOString(),
      seat_id: SEAT_STARRED,
      holder_active: true,
      favorite: true, // the legacy per-record star, never migrated onto the seat
    });
    // The seat row EXISTS (real pre-migration shape) but `favorite` was never set.
    await withSeatStoreWrite(hotDir, (store) => {
      const seats = new Map(store.seats);
      seats.set(SEAT_STARRED, {
        seatId: SEAT_STARRED,
        createdAt: "2026-01-01T00:00:00.000Z",
        activeHolderId: id,
        nextOrdinal: 2,
        closedAt: null,
        name: undefined,
        brickId: undefined,
        favorite: undefined,
      });
      return { mutation: { kind: "write", seats } as const, result: undefined };
    });

    const result = await revalidateBeforeApply(
      hotDir,
      id,
      [`${id}.json`],
      true,
      60_000,
      Date.now(),
    );
    assert.equal(result.ok, false, "an unmigrated seat must fall back to the record's own star");
    if (!result.ok) {
      assert.equal(result.reason, "favorite");
    }
  });
});

test("revalidateBeforeApply ROW 2: a SEAT-LESS record with legacy record.favorite:true still blocks — production's steady state pre-backfill", async () => {
  await withTempDir("acpx-archive-move-fav-", async (hotDir) => {
    const id = "no-seat-at-all";
    await writeAgedRecord(hotDir, id, {
      closed: true,
      closed_at: new Date(Date.now() - OLD_MS).toISOString(),
      favorite: true,
      // no seat_id at all.
    });

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

test("revalidateBeforeApply ROW 4: a migrated un-starred seat (favorite:false) archives despite a stale legacy record.favorite:true", async () => {
  await withTempDir("acpx-archive-move-fav-", async (hotDir) => {
    const id = "migrated-unstarred-active-holder";
    await writeAgedRecord(hotDir, id, {
      closed: true,
      closed_at: new Date(Date.now() - OLD_MS).toISOString(),
      seat_id: SEAT_STARRED,
      holder_active: true,
      favorite: true, // stale — pre-migration value, left behind on the record
    });
    await withSeatStoreWrite(hotDir, (store) => {
      const seats = new Map(store.seats);
      seats.set(SEAT_STARRED, {
        seatId: SEAT_STARRED,
        createdAt: "2026-01-01T00:00:00.000Z",
        activeHolderId: id,
        nextOrdinal: 2,
        closedAt: null,
        name: undefined,
        brickId: undefined,
        favorite: false, // MIGRATED, explicitly un-starred
      });
      return { mutation: { kind: "write", seats } as const, result: undefined };
    });

    const result = await revalidateBeforeApply(
      hotDir,
      id,
      [`${id}.json`],
      true,
      60_000,
      Date.now(),
    );
    assert.equal(
      result.ok,
      true,
      "the migrated seat's explicit false must override the record's stale legacy true",
    );
  });
});
