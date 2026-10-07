// Brick 085c8dd6 — `sessions owner-status --descendants-of` scans the FAMILY, and the family edge is the
// parent SEAT: after a handover the successor's scan reaches the children its predecessor spawned, with
// no `set-parent`; the retired holder's scan reaches none. A seat-less parent keeps today's behaviour.
import assert from "node:assert/strict";
import test from "node:test";
import { familyDescendantRecords } from "../src/cli/session/session-control.js";

type Node = {
  acpxRecordId: string;
  lastUsedAt: string;
  parentSessionId?: string;
  parentSeatId?: string;
  seatId?: string;
  holderActive?: boolean;
  holderOrdinal?: number;
  closed?: boolean;
};
const node = (id: string, over: Partial<Node> = {}): Node => ({ acpxRecordId: id, lastUsedAt: "2026-10-07T00:00:00.000Z", ...over });
const ids = (records: Node[]) => records.map((r) => r.acpxRecordId).toSorted();

function succession(): Node[] {
  return [
    node("x", { seatId: "seat-x", holderActive: true, holderOrdinal: 1 }),
    node("a", { seatId: "S", holderActive: false, holderOrdinal: 1, parentSessionId: "x", parentSeatId: "seat-x" }),
    node("b", { seatId: "S", holderActive: true, holderOrdinal: 2, parentSessionId: "a", parentSeatId: "S" }),
    node("c", { seatId: "seat-c", holderActive: true, holderOrdinal: 1, parentSessionId: "a", parentSeatId: "S" }),
    node("g", { seatId: "seat-g", holderActive: true, holderOrdinal: 1, parentSessionId: "c", parentSeatId: "seat-c" }),
  ];
}

test("085c8dd6: the successor's family scan reaches what its predecessor spawned; the retired holder's reaches nothing", () => {
  assert.deepEqual(ids(familyDescendantRecords("b", succession())), ["c", "g"]);
  assert.deepEqual(ids(familyDescendantRecords("a", succession())), []);
  assert.deepEqual(ids(familyDescendantRecords("x", succession())), ["b", "c", "g"], "the seat (its current holder) keeps its place under x; the retired a is its history");
});

test("085c8dd6: the predecessor ARCHIVED (absent) — the stored seat edge still carries the child", () => {
  const records = succession().filter((r) => r.acpxRecordId !== "a");
  assert.deepEqual(ids(familyDescendantRecords("b", records)), ["c", "g"]);
});

test("085c8dd6: no stored parentSeatId — the seat of the parent record decides", () => {
  const records = succession().map((r) => (r.acpxRecordId === "c" ? { ...r, parentSeatId: undefined } : r));
  assert.deepEqual(ids(familyDescendantRecords("b", records)), ["c", "g"]);
});

test("085c8dd6: a seat-less parent, and a vacant seat, keep the session edge", () => {
  const plain = [node("p"), node("k", { parentSessionId: "p" })];
  assert.deepEqual(ids(familyDescendantRecords("p", plain)), ["k"]);
  const vacant = succession().map((r) => (r.acpxRecordId === "b" ? { ...r, holderActive: false } : r));
  assert.deepEqual(ids(familyDescendantRecords("a", vacant)), ["b", "c", "g"]);
});

test("085c8dd6: a cycle in the records terminates", () => {
  const records = [node("p", { parentSessionId: "q" }), node("q", { parentSessionId: "p" })];
  assert.deepEqual(ids(familyDescendantRecords("p", records)), ["q"]);
});
