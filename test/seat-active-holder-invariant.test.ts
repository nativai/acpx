import assert from "node:assert/strict";
import test from "node:test";
import { listSessions } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// Brick 5ad22d5d, GATE-B1-FALSIFIABILITY §G12 — "at most one active holder per
// seat" holds trivially in B1 (it mints exactly one holder per seat, always
// active), but the gate's own note is the point: "the test exists so B2
// inherits a guard that already fails correctly." A guard nobody has ever
// seen fail is not proven — this file proves it fails on the shape B2 will
// actually produce (two holders sharing a seat_id), not just passes on the
// shape B1 produces.

/** The invariant itself, stated once so B2 can reuse or extend it rather than
 * re-deriving it: at most one record per seatId may carry holderActive===true. */
function seatsWithMultipleActiveHolders(records: SessionRecord[]): string[] {
  const activeCountBySeat = new Map<string, number>();
  for (const record of records) {
    if (record.seatId && record.holderActive === true) {
      activeCountBySeat.set(record.seatId, (activeCountBySeat.get(record.seatId) ?? 0) + 1);
    }
  }
  return [...activeCountBySeat.entries()]
    .filter(([, count]) => count > 1)
    .map(([seatId]) => seatId);
}

function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  return withTempHomeFixture("acpx-seat-active-holder-invariant-", run);
}

test("G12/positive · B1's own output never violates the invariant (real disk read)", async () => {
  await withTempHome(async (homeDir) => {
    // Three independently-created records, as B1's three paths would produce
    // (each mints its OWN seat) — the shape B1 itself ever writes.
    for (const id of ["seat-a-holder-1", "seat-b-holder-1", "seat-c-holder-1"]) {
      await writeSessionRecordFile(
        homeDir,
        makeSessionRecordFixture({
          acpxRecordId: id,
          acpSessionId: `${id}-acp`,
          agentCommand: "node mock-agent.js",
          cwd: `${homeDir}/workspace`,
          seatId: `seat-of-${id}`,
          holderOrdinal: 1,
          holderActive: true,
        }),
      );
    }
    const records = await listSessions();
    assert.deepEqual(
      seatsWithMultipleActiveHolders(records),
      [],
      "B1's own three-independent-seats output must never trip this guard",
    );
  });
});

test("G12/negative · the guard FAILS CORRECTLY on the shape B2 will produce (two active holders, one seat)", async () => {
  await withTempHome(async (homeDir) => {
    // The shape a BUGGY B2 activation write would produce: two records
    // sharing one seat_id, BOTH carrying holder_active:true — exactly the
    // invariant violation D-B1-2 says B2's activation write must prevent.
    // This is deliberately synthetic (B1 alone cannot produce it) — the
    // point is that the CHECK catches it when handed the shape, so B2
    // inherits a guard proven to fail rather than one that has only ever
    // seen green.
    for (const [id, ordinal] of [
      ["shared-seat-holder-1", 1],
      ["shared-seat-holder-2", 2],
    ] as const) {
      await writeSessionRecordFile(
        homeDir,
        makeSessionRecordFixture({
          acpxRecordId: id,
          acpSessionId: `${id}-acp`,
          agentCommand: "node mock-agent.js",
          cwd: `${homeDir}/workspace`,
          seatId: "shared-seat",
          holderOrdinal: ordinal,
          holderActive: true,
        }),
      );
    }
    const records = await listSessions();
    assert.deepEqual(
      seatsWithMultipleActiveHolders(records),
      ["shared-seat"],
      "the guard must name the violating seat when the invariant is broken — a guard that stays " +
        "green here is not proven, it is untested",
    );
  });
});
