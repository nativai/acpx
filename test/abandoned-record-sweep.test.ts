import assert from "node:assert/strict";
import test from "node:test";
import type { LiveProcessScan } from "../src/process-population.js";
import { sweepAbandonedSessionRecords } from "../src/session/abandoned-record-sweep.js";
import type { SessionRecord } from "../src/types.js";

// 7adac97e — close records with no live owner, so the config-dir sweep's
// "record is CLOSED" clause has a truthful population to work against.
//
// ⚠️ THIS EXISTS BECAUSE OF A MEASUREMENT, NOT A THEORY: 206 records in the rig
// store, 118 closed, 88 still OPEN, from lanes that had long since finished —
// each one pinning a config dir the (correct) directory sweep must therefore
// retain forever. The population is not a reason to relax the deletion rule; it
// is a reason to fix the population, one layer up.

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-04T18:00:00.000Z");

function measuredScan(overrides: Partial<LiveProcessScan> = {}): LiveProcessScan {
  return {
    scanned: 40,
    environRead: 9,
    pids: new Set([100, 200]),
    referencedDirs: new Set<string>(),
    referencedSessionIds: new Set<string>(),
    ...overrides,
  };
}

function record(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    acpxRecordId: "rec-1",
    closed: false,
    lastUsedAt: new Date(NOW - 48 * HOUR).toISOString(),
    ...overrides,
  } as unknown as SessionRecord;
}

async function sweep(
  records: SessionRecord[],
  overrides: { liveScan?: LiveProcessScan; minIdleMs?: number } = {},
) {
  const closedIds: string[] = [];
  const result = await sweepAbandonedSessionRecords({
    records,
    liveScan: "liveScan" in overrides ? overrides.liveScan : measuredScan(),
    minIdleMs: overrides.minIdleMs ?? 24 * HOUR,
    now: NOW,
    closeSession: (id) => {
      closedIds.push(id);
      return Promise.resolve();
    },
  });
  return { result, closedIds };
}

test("7adac97e: an ownerless, long-idle OPEN record is closed", async () => {
  const { result, closedIds } = await sweep([record({ acpxRecordId: "abandoned-1" })]);
  assert.equal(result.scanned, 1, "population: no open record was examined");
  assert.deepEqual(closedIds, ["abandoned-1"]);
  assert.deepEqual(result.closed, ["abandoned-1"]);
});

test("7adac97e: a record whose AGENT PID is live is retained", async () => {
  const { result, closedIds } = await sweep([record({ acpxRecordId: "owned-1", pid: 100 })]);
  assert.deepEqual(closedIds, [], "closed a session whose agent is still running");
  assert.equal(result.retainedBy.liveOwner, 1);
});

test("7adac97e: a record whose QUEUE OWNER is live is retained even with a dead pid", async () => {
  // ⚠️ THE ROW THAT MAKES THE PID-ONLY CHECK INSUFFICIENT. A record's `pid` is
  // its AGENT; acpx also runs a per-session queue owner. An agent that exited
  // leaves a dead pid beside a live owner still holding custody, and a pid-only
  // sweep would terminate a session that is very much in use.
  const id = "01a06d8d-8994-7725-9d35-7e9522059e13";
  const { result, closedIds } = await sweep([record({ acpxRecordId: id, pid: 999_999 })], {
    liveScan: measuredScan({ referencedSessionIds: new Set([id]) }),
  });
  assert.deepEqual(closedIds, [], "closed a session whose queue owner is alive");
  assert.equal(result.retainedBy.liveOwner, 1);
});

test("7adac97e: a recently-used record is retained", async () => {
  const { result, closedIds } = await sweep([
    record({ acpxRecordId: "fresh-1", lastUsedAt: new Date(NOW - 1 * HOUR).toISOString() }),
  ]);
  assert.deepEqual(closedIds, []);
  assert.equal(result.retainedBy.tooYoung, 1);
  assert.equal(result.oldestRetainedIdleMs, 1 * HOUR);
});

test("7adac97e: a record with NO usable timestamp is retained, never assumed stale", async () => {
  // "Unknown" must not read as "old". This is the record we know least about.
  const { result, closedIds } = await sweep([
    record({ acpxRecordId: "no-stamp", lastUsedAt: undefined, createdAt: undefined }),
  ]);
  assert.deepEqual(closedIds, [], "closed a record whose age could not be established");
  assert.equal(result.retainedBy.ageUnknown, 1);
});

test("7adac97e: an UNMEASURABLE /proc scan closes NOTHING and says so", async () => {
  for (const scan of [undefined, measuredScan({ scanned: 0 }), measuredScan({ environRead: 0 })]) {
    const { result, closedIds } = await sweep([record({ acpxRecordId: "abandoned-1" })], {
      liveScan: scan,
    });
    assert.equal(result.notMeasured, true, "an unmeasurable scan was treated as measured");
    assert.deepEqual(closedIds, [], "closed a session without a measured process census");
    assert.equal(result.scanned, 1, "the candidate population must still be reported");
  }
});

test("7adac97e: already-closed records are not candidates and are not re-closed", async () => {
  const { result, closedIds } = await sweep([
    record({ acpxRecordId: "already", closed: true }),
    record({ acpxRecordId: "abandoned-1" }),
  ]);
  assert.equal(result.scanned, 1, "a closed record was counted as an open candidate");
  assert.deepEqual(closedIds, ["abandoned-1"]);
});

test("7adac97e: a close that FAILS is retained and counted, never reported as closed", async () => {
  const result = await sweepAbandonedSessionRecords({
    records: [record({ acpxRecordId: "boom" })],
    liveScan: measuredScan(),
    minIdleMs: 24 * HOUR,
    now: NOW,
    closeSession: () => Promise.reject(new Error("owner refused")),
  });
  assert.deepEqual(result.closed, [], "a failed close was reported as a close");
  assert.equal(result.retainedBy.closeFailed, 1);
});

test("7adac97e: the sweep discriminates — it does not answer the same way for everything", async () => {
  // Population + degeneracy in one row: a sweep that closed everything, or
  // nothing, would satisfy several rows above in isolation.
  const id = "01a06caf-6c65-71e1-86cd-9ef0fff0dd97";
  const { result, closedIds } = await sweep(
    [
      record({ acpxRecordId: "abandoned-1" }),
      record({ acpxRecordId: "abandoned-2" }),
      record({ acpxRecordId: "owned-pid", pid: 200 }),
      record({ acpxRecordId: id, pid: 999_999 }),
      record({ acpxRecordId: "fresh", lastUsedAt: new Date(NOW - HOUR).toISOString() }),
      record({ acpxRecordId: "closed-already", closed: true }),
    ],
    { liveScan: measuredScan({ referencedSessionIds: new Set([id]) }) },
  );
  assert.equal(result.scanned, 5, "population: the open candidates were miscounted");
  assert.deepEqual(closedIds.toSorted(), ["abandoned-1", "abandoned-2"]);
  assert.equal(result.retained, 3);
  assert.equal(result.retainedBy.liveOwner, 2);
  assert.equal(result.retainedBy.tooYoung, 1);
});
