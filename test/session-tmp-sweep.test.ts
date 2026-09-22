import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SESSION_TMP_GRACE_MS,
  DEFAULT_SESSION_TMP_HARD_CEILING_MS,
  type KnownSessionTmpRecord,
  sweepSessionTmpDirs,
} from "../src/acp/session-tmp-sweep.js";

/**
 * brick ceca191f (SPEC.md "Reaper", acceptance criterion 7) — the pure sweep
 * function, tested directly against a scoped throwaway root so nothing here
 * ever touches the box's real `/workspace/.tmp`.
 *
 * These are UNIT tests of the classification rule. `session-tmp-cli.test.ts`
 * covers the CLI wiring (the verb that actually invokes this against the real
 * session store and a real `/proc` scan) end to end.
 */

const CLOSED_SESSION = "11111111-1111-1111-1111-111111111111";
const OPEN_SESSION = "22222222-2222-2222-2222-222222222222";
const UNRECOGNISED_SESSION = "33333333-3333-3333-3333-333333333333";

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "acpx-session-tmp-sweep-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeDir(root: string, sessionId: string): string {
  const dir = join(root, sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A measured, empty-population `/proc` scan — nothing live references anything. */
function emptyLiveScan(scanned = 5): {
  scanned: number;
  environRead: number;
  pids: ReadonlySet<number>;
  referencedDirs: ReadonlySet<string>;
  referencedSessionIds: ReadonlySet<string>;
} {
  return {
    scanned,
    environRead: 0,
    pids: new Set([1, 2, 3].slice(0, Math.min(3, scanned))),
    referencedDirs: new Set(),
    referencedSessionIds: new Set(),
  };
}

test("sweepSessionTmpDirs removes a CLOSED session's directory past the grace period", () => {
  withRoot((root) => {
    const dir = makeDir(root, CLOSED_SESSION);
    const records = new Map<string, KnownSessionTmpRecord>([
      [CLOSED_SESSION, { closed: true, idleMs: DEFAULT_SESSION_TMP_GRACE_MS + 1000 }],
    ]);
    const result = sweepSessionTmpDirs({ records, liveScan: emptyLiveScan(), rootDir: root });
    assert.deepEqual(result.removed, [dir]);
    assert.equal(existsSync(dir), false);
    assert.equal(result.retainedBy.tooYoung, 0);
    assert.equal(result.scanned, 1);
  });
});

test("sweepSessionTmpDirs retains a CLOSED session's directory BEFORE the grace period (tooYoung)", () => {
  withRoot((root) => {
    const dir = makeDir(root, CLOSED_SESSION);
    const records = new Map<string, KnownSessionTmpRecord>([
      [CLOSED_SESSION, { closed: true, idleMs: DEFAULT_SESSION_TMP_GRACE_MS - 1000 }],
    ]);
    const result = sweepSessionTmpDirs({ records, liveScan: emptyLiveScan(), rootDir: root });
    assert.deepEqual(result.removed, []);
    assert.equal(existsSync(dir), true);
    assert.equal(result.retainedBy.tooYoung, 1);
  });
});

test("sweepSessionTmpDirs retains an OPEN session's directory regardless of idle time", () => {
  withRoot((root) => {
    const dir = makeDir(root, OPEN_SESSION);
    const records = new Map<string, KnownSessionTmpRecord>([
      [OPEN_SESSION, { closed: false, idleMs: DEFAULT_SESSION_TMP_HARD_CEILING_MS + 1000 }],
    ]);
    // Even past the record-idle grace period, an OPEN record is retained — age
    // alone never justifies removal. The far-past-the-hard-ceiling variant
    // (with a synthetic `now`, so it cannot pass merely by the directory being
    // young) lives in its own dedicated row below.
    const result = sweepSessionTmpDirs({ records, liveScan: emptyLiveScan(), rootDir: root });
    assert.deepEqual(result.removed, []);
    assert.equal(existsSync(dir), true);
    assert.equal(result.retainedBy.openRecord, 1);
  });
});

test("sweepSessionTmpDirs NEVER removes a directory a live process still references, even closed and past grace", () => {
  withRoot((root) => {
    const dir = makeDir(root, CLOSED_SESSION);
    const records = new Map<string, KnownSessionTmpRecord>([
      [CLOSED_SESSION, { closed: true, idleMs: DEFAULT_SESSION_TMP_HARD_CEILING_MS * 2 }],
    ]);
    const liveScan = {
      ...emptyLiveScan(),
      referencedSessionIds: new Set([CLOSED_SESSION.toLowerCase()]),
    };
    const result = sweepSessionTmpDirs({
      records,
      liveScan,
      rootDir: root,
      // A synthetic `now` far in the future so the directory-age hard ceiling
      // would ALSO fire on its own — proving the live-process clause is what
      // actually wins, not merely that no other clause happened to trigger.
      now: Date.now() + DEFAULT_SESSION_TMP_HARD_CEILING_MS * 3,
    });
    assert.deepEqual(result.removed, []);
    assert.equal(existsSync(dir), true);
    assert.equal(result.retainedBy.liveProcess, 1);
  });
});

test("sweepSessionTmpDirs retains an unrecognised (no-record) directory below the hard ceiling", () => {
  withRoot((root) => {
    const dir = makeDir(root, UNRECOGNISED_SESSION);
    const result = sweepSessionTmpDirs({
      records: new Map(),
      liveScan: emptyLiveScan(),
      rootDir: root,
    });
    assert.deepEqual(result.removed, []);
    assert.equal(existsSync(dir), true);
    assert.equal(result.retainedBy.unrecognised, 1);
  });
});

// brick ceca191f — TE finding: the FIRST shipped version of this rule put the
// hard ceiling BEFORE the record check, so this exact scenario — an OPEN,
// still-in-use session whose directory happened to be old — was removed
// unconditionally. This row is the regression guard for that fix: the hard
// ceiling must NEVER override a record the sweep actually has.
test("sweepSessionTmpDirs NEVER removes an OPEN record's directory, even far past the hard ceiling", () => {
  withRoot((root) => {
    const dir = makeDir(root, OPEN_SESSION);
    const records = new Map<string, KnownSessionTmpRecord>([[OPEN_SESSION, { closed: false }]]);
    const result = sweepSessionTmpDirs({
      records,
      liveScan: emptyLiveScan(),
      rootDir: root,
      now: Date.now() + DEFAULT_SESSION_TMP_HARD_CEILING_MS * 3,
    });
    assert.deepEqual(result.removed, []);
    assert.equal(existsSync(dir), true, "an OPEN record must never be reaped by age alone");
    assert.equal(result.retainedBy.openRecord, 1);
  });
});

test("sweepSessionTmpDirs removes a genuinely UNCLAIMED (no-record) directory once past the hard ceiling", () => {
  withRoot((root) => {
    const dir = makeDir(root, UNRECOGNISED_SESSION);
    const result = sweepSessionTmpDirs({
      records: new Map(),
      liveScan: emptyLiveScan(),
      rootDir: root,
      now: Date.now() + DEFAULT_SESSION_TMP_HARD_CEILING_MS + 1000,
    });
    assert.deepEqual(result.removed, [dir]);
    assert.equal(existsSync(dir), false);
  });
});

// brick ceca191f — the other half of the same fix: a record lookup that
// FAILED (as opposed to confirmed nothing) must never be silently treated as
// "no record" and fed to the hard ceiling — that is exactly how a transient
// I/O error during the caller's targeted lookup could look identical to a
// genuinely unclaimed directory and get reaped.
test("sweepSessionTmpDirs NEVER removes a directory whose record lookup FAILED, even far past the hard ceiling", () => {
  withRoot((root) => {
    const dir = makeDir(root, UNRECOGNISED_SESSION);
    const result = sweepSessionTmpDirs({
      records: new Map(),
      unresolvedIds: new Set([UNRECOGNISED_SESSION]),
      liveScan: emptyLiveScan(),
      rootDir: root,
      now: Date.now() + DEFAULT_SESSION_TMP_HARD_CEILING_MS * 3,
    });
    assert.deepEqual(result.removed, []);
    assert.equal(existsSync(dir), true);
    assert.equal(result.retainedBy.unresolved, 1);
    assert.equal(result.retainedBy.unrecognised, 0, "must not double-count as unrecognised too");
  });
});

test("sweepSessionTmpDirs: an UNMEASURABLE /proc scan removes NOTHING and says so", () => {
  withRoot((root) => {
    const dir = makeDir(root, CLOSED_SESSION);
    const records = new Map<string, KnownSessionTmpRecord>([
      [CLOSED_SESSION, { closed: true, idleMs: DEFAULT_SESSION_TMP_GRACE_MS + 1000 }],
    ]);
    const result = sweepSessionTmpDirs({
      records,
      liveScan: emptyLiveScan(0),
      rootDir: root,
    });
    assert.equal(result.notMeasured, true);
    assert.deepEqual(result.removed, []);
    assert.equal(existsSync(dir), true);
    assert.equal(result.retainedBy.unmeasured, 1);
    // ⚠️ scanned is still the CANDIDATE count, not 0 — a refusal that also
    // printed scanned=0 would be indistinguishable from an empty root.
    assert.equal(result.scanned, 1);
  });
});

test("sweepSessionTmpDirs: a DRY RUN classifies and removes nothing", () => {
  withRoot((root) => {
    const dir = makeDir(root, CLOSED_SESSION);
    const records = new Map<string, KnownSessionTmpRecord>([
      [CLOSED_SESSION, { closed: true, idleMs: DEFAULT_SESSION_TMP_GRACE_MS + 1000 }],
    ]);
    const result = sweepSessionTmpDirs({
      records,
      liveScan: emptyLiveScan(),
      rootDir: root,
      dryRun: true,
    });
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.wouldRemove, [dir]);
    assert.equal(existsSync(dir), true, "a dry run must not actually delete anything");
  });
});

test("sweepSessionTmpDirs only treats UUID-shaped basenames as candidates", () => {
  withRoot((root) => {
    // A stray non-uuid entry (e.g. this sweep's own interval stamp, if one is
    // ever added under this root) must never be swept as a session.
    mkdirSync(join(root, "not-a-uuid"), { recursive: true });
    const result = sweepSessionTmpDirs({
      records: new Map(),
      liveScan: emptyLiveScan(),
      rootDir: root,
    });
    assert.equal(result.scanned, 0);
    assert.equal(existsSync(join(root, "not-a-uuid")), true);
  });
});

test("sweepSessionTmpDirs: an unreadable root is a NON-MEASUREMENT, not a clean sweep", () => {
  const result = sweepSessionTmpDirs({
    records: new Map(),
    liveScan: emptyLiveScan(),
    rootDir: join(tmpdir(), "acpx-session-tmp-sweep-does-not-exist-at-all"),
  });
  assert.equal(result.notMeasured, true);
  assert.equal(result.scanned, 0);
});
