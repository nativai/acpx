import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { revalidateBeforeApply } from "../src/session/archive/move.js";
import { withTempDir } from "./runtime-test-helpers.js";

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
