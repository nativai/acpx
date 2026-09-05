import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { releaseHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import type { LivePidScan } from "../src/process-population.js";

// c9b2520f — a holder whose owning process is gone must not pin the directory.
//
// ⚠️ THE SPECIMEN. A clean drained close left holder `346359-953c2e22` behind
// with `/proc/346359` gone. `releaseHarnessConfigDir` removed only the CALLER's
// own marker and then counted, so the set could never empty and the close path
// could never remove that dir.
//
// ⚠️ AND NOTHING ELSE COLLECTS IT. RS-15 established that the orphan sweep is
// HOLDER-BLIND by design — `HOLDERS_DIR` appears four times in the module and
// none of them is in the sweep — and that nothing on staging invokes the sweep
// at all. So the leak is monotonic in sessions, which is why this is HIGH rather
// than untidy.
//
// ⚠️ THE THIRD ROW IS THE POINT. "Drop holders whose pid no longer exists",
// implemented literally, DELETES EVERY HOLDER on a box where `/proc` is
// unreadable — because "this pid does not exist" and "I cannot tell" are the same
// observation. A dead-pid row and a live-holder row BOTH PASS on that build. Only
// the unmeasurable row tells the correct fix from the dangerous one.

/** A pid census that IS measured, and does not contain `absentPid`. */
function measuredPids(live: number[]): LivePidScan {
  return { scanned: Math.max(live.length, 1) + 40, pids: new Set(live) };
}

/** ⚠️ 0 enumerated — NOT MEASURED, not "nothing is running". */
const UNMEASURABLE: LivePidScan = { scanned: 0, pids: new Set() };

function dirWithHolders(...holderIds: string[]): { root: string; dir: string; holders: string } {
  const root = mkdtempSync(join(tmpdir(), "hp-c9b2520f-"));
  const dir = join(root, "acpx-opencode-ses-1");
  const holders = join(dir, ".acpx-holders");
  mkdirSync(holders, { recursive: true });
  for (const id of holderIds) {
    writeFileSync(join(holders, id), `${new Date().toISOString()}\n`);
  }
  return { root, dir, holders };
}

test("c9b2520f: a holder whose PID IS GONE is dropped, and the dir is removed", () => {
  // The specimen, reproduced: one stale holder left by a client that is no longer
  // running, and the closing client's own marker.
  const { root, dir } = dirWithHolders("346359-953c2e22", "999001-aaaaaaaa");
  try {
    const result = releaseHarnessConfigDir(dir, "999001-aaaaaaaa", measuredPids([12345]));
    assert.equal(result.droppedStaleHolders, 1, "the stale holder was not dropped");
    assert.equal(result.remainingHolders, 0);
    assert.equal(result.removed, true, "the dir survived its terminal close — the leak persists");
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("c9b2520f: a holder whose PID IS LIVE is RETAINED, and so is the dir", () => {
  // The two-sided control, and it is the property `4a6fdda0` bought: a transient
  // client closing must not delete the directory another client is still using.
  const { root, dir } = dirWithHolders("777001-bbbbbbbb", "999001-aaaaaaaa");
  try {
    const result = releaseHarnessConfigDir(dir, "999001-aaaaaaaa", measuredPids([777001]));
    assert.equal(result.droppedStaleHolders, 0, "a LIVE holder was dropped");
    assert.equal(result.remainingHolders, 1);
    assert.equal(result.removed, false, "a dir with a live holder was removed");
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("c9b2520f: an UNMEASURABLE /proc drops NOTHING, retains, and REPORTS it", () => {
  // ⚠️ THE ROW THAT DISTINGUISHES THE CORRECT FIX FROM THE DANGEROUS ONE. Both
  // rows above pass on a build that treats "I cannot enumerate /proc" as "no pid
  // exists" — and that build deletes the config dir of every LIVE session on any
  // box where /proc is restricted. Turning a leak into data loss under an
  // unmeasured condition is strictly worse than the leak.
  const { root, dir } = dirWithHolders("346359-953c2e22", "999001-aaaaaaaa");
  try {
    const result = releaseHarnessConfigDir(dir, "999001-aaaaaaaa", UNMEASURABLE);
    assert.equal(result.droppedStaleHolders, 0, "holders were dropped on an unmeasurable scan");
    assert.equal(result.removed, false, "the dir was removed on an unmeasurable scan");
    assert.equal(existsSync(dir), true);

    // ⚠️ AND IT MUST BE DISTINGUISHABLE FROM "every holder was live", which
    // produces the same `droppedStaleHolders: 0`. Without this the refusal is
    // silent, which is the failure family this whole module is built against.
    assert.equal(result.staleCheckMeasured, false, "the refusal is not reported");
    assert.equal(result.remainingHolders, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("c9b2520f: a holder id whose pid cannot be parsed is RETAINED, never guessed", () => {
  // Same discipline as the sweep retaining an id it does not recognise: an id
  // this code cannot judge is not an id it may delete.
  const { root, dir } = dirWithHolders("not-a-pid-holder", "999001-aaaaaaaa");
  try {
    const result = releaseHarnessConfigDir(dir, "999001-aaaaaaaa", measuredPids([12345]));
    assert.equal(result.droppedStaleHolders, 0, "an unparseable holder id was dropped");
    assert.equal(result.removed, false);
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("c9b2520f: the sole holder closing normally still removes the dir", () => {
  // The fast path `4a6fdda0` shipped must be unchanged by any of this.
  const { root, dir } = dirWithHolders("999001-aaaaaaaa");
  try {
    const result = releaseHarnessConfigDir(dir, "999001-aaaaaaaa", measuredPids([999001]));
    assert.equal(result.removed, true, "a sole holder's close no longer removes the dir");
    assert.equal(result.droppedStaleHolders, 0, "nothing should have been judged stale");
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("c9b2520f: several stale holders are all dropped, and the count is reported", () => {
  // Population, and it discriminates: a build that dropped only the first would
  // satisfy row 1 and still leak on the real specimen shape.
  const { root, dir, holders } = dirWithHolders(
    "346359-953c2e22",
    "346360-11111111",
    "346361-22222222",
    "999001-aaaaaaaa",
  );
  try {
    assert.equal(readdirSync(holders).length, 4, "control: the fixture did not plant four holders");
    const result = releaseHarnessConfigDir(dir, "999001-aaaaaaaa", measuredPids([12345]));
    assert.equal(result.droppedStaleHolders, 3);
    assert.equal(result.removed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("c9b2520f: an UNREADABLE holder set is still a NON-MEASUREMENT, unchanged", () => {
  // The pre-existing refusal must survive the new one beside it. Two different
  // non-measurements — the holder set, and /proc — and neither may remove.
  const root = mkdtempSync(join(tmpdir(), "hp-c9b2520f-nohold-"));
  try {
    const dir = join(root, "acpx-opencode-ses-2");
    mkdirSync(dir, { recursive: true });
    const result = releaseHarnessConfigDir(dir, "999001-aaaaaaaa", measuredPids([12345]));
    assert.equal(result.notMeasured, true, "an unreadable holder set was treated as measured");
    assert.equal(result.removed, false);
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
