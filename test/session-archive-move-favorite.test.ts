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

// ── A1 / A2 — the two APPLY-TIME rows the plan-time file has and this one lacked ──
//
// Brick `cd7eb899`. The archive favorite policy is enforced by TWO separate functions
// (`retention.ts` at plan time, `move.ts` here), and this is the only file that drives
// the second. The plan-time twins are `session-archive-retention.test.ts` "favorite:
// a seat with no row at all (dangling seat_id)…" (A1) and "favorite ROW 5: a MALFORMED
// seat row throws…" (A2). Behaviour was already correct; these rows are what stops the
// apply-time layer regressing with every other test green.
//
// The store is written RAW, in the persisted spelling, so the rows say exactly what is
// on disk and do not depend on `SeatRecord`'s field set.

const SEAT_DANGLING = "ffffffff-3333-4333-8333-333333333333";
const SEAT_OTHER = "99999999-4444-4444-8444-444444444444";

async function writeRawSeatStore(hotDir: string, payload: string): Promise<void> {
  await fs.writeFile(path.join(hotDir, "seats.json"), payload, "utf8");
}

const HEALTHY_STORE_WITHOUT_THE_SEAT = JSON.stringify({
  [SEAT_OTHER]: {
    seat_id: SEAT_OTHER,
    created_at: "2026-01-01T00:00:00.000Z",
    active_holder_id: "someone-else",
    next_ordinal: 2,
    closed_at: null,
    favorite: true,
  },
});

async function applyTimeVerdict(hotDir: string, id: string) {
  return await revalidateBeforeApply(hotDir, id, [`${id}.json`], true, 60_000, Date.now());
}

test("revalidateBeforeApply A1: a DANGLING seat_id (store healthy, no row) falls back to the record's legacy favorite — both directions", async () => {
  await withTempDir("acpx-archive-move-fav-", async (hotDir) => {
    await writeRawSeatStore(hotDir, HEALTHY_STORE_WITHOUT_THE_SEAT);
    const common = {
      closed: true,
      closed_at: new Date(Date.now() - OLD_MS).toISOString(),
      seat_id: SEAT_DANGLING,
      holder_active: true,
    };
    await writeAgedRecord(hotDir, "dangling-starred", { ...common, favorite: true });
    await writeAgedRecord(hotDir, "dangling-unstarred", { ...common, favorite: false });

    const starred = await applyTimeVerdict(hotDir, "dangling-starred");
    assert.equal(starred.ok, false, "no row to answer ⇒ the legacy star must still protect");
    if (!starred.ok) {
      assert.equal(starred.reason, "favorite");
    }
    // The control that makes the row above a discrimination rather than a blanket block.
    assert.equal(
      (await applyTimeVerdict(hotDir, "dangling-unstarred")).ok,
      true,
      "no row and no legacy star ⇒ archivable",
    );
  });
});

test("revalidateBeforeApply A2: a MALFORMED seat row FAILS LOUD at apply time — never read as 'not starred'", async () => {
  await withTempDir("acpx-archive-move-fav-", async (hotDir) => {
    await writeAgedRecord(hotDir, "holder-of-malformed", {
      closed: true,
      closed_at: new Date(Date.now() - OLD_MS).toISOString(),
      seat_id: SEAT_DANGLING,
      holder_active: true,
      favorite: true,
    });
    // PRESENT but unreadable: `closed_at` and the rest of the required fields are absent.
    await writeRawSeatStore(
      hotDir,
      JSON.stringify({ [SEAT_DANGLING]: { seat_id: SEAT_DANGLING } }),
    );

    await assert.rejects(
      applyTimeVerdict(hotDir, "holder-of-malformed"),
      /is PRESENT in the seat store .*seats\.json but its row is malformed/,
      "a destruction guard must fail loud, never treat 'cannot tell' as 'not starred'",
    );
  });
});

test("revalidateBeforeApply A2b: an UNHEALTHY seat store (file does not parse) FAILS LOUD at apply time", async () => {
  await withTempDir("acpx-archive-move-fav-", async (hotDir) => {
    await writeAgedRecord(hotDir, "holder-of-unhealthy", {
      closed: true,
      closed_at: new Date(Date.now() - OLD_MS).toISOString(),
      seat_id: SEAT_DANGLING,
      holder_active: true,
      favorite: true,
    });
    await writeRawSeatStore(hotDir, "{ this is not json");

    await assert.rejects(
      applyTimeVerdict(hotDir, "holder-of-unhealthy"),
      /EXISTS but its top level does not parse/,
      "an unreadable store must never answer 'absent' to a destruction guard",
    );
  });
});
