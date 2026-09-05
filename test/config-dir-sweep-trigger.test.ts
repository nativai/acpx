import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_SWEEP_INTERVAL_MS,
  maybeSweepHarnessConfigDirs,
  resetConfigDirSweepSchedule,
  sweepHarnessConfigDirsNow,
} from "../src/acp/config-dir-sweep-trigger.js";
import { type KnownSessionRecord } from "../src/acp/harness-config-dir.js";
import type { LiveProcessScan } from "../src/process-population.js";

/**
 * brick 0bac6a00 — WHEN THE SWEEP RUNS (ruled A + C(first-prompt), form 2).
 *
 * ⚠️ THE INSTRUMENT CONTROL COMES FIRST HERE TOO. `measuredScan()` is what makes a
 * removal possible at all; the refusal case is pinned in
 * `config-dir-sweep-report.test.ts`. Without it, "the trigger swept" and "the
 * trigger ran and refused" are the same observation.
 */

const HOUR = 60 * 60 * 1000;

function measuredScan(overrides: Partial<LiveProcessScan> = {}): LiveProcessScan {
  return {
    scanned: 42,
    environRead: 12,
    pids: new Set([1, 2, 3]),
    referencedDirs: new Set<string>(),
    referencedSessionIds: new Set<string>(),
    ...overrides,
  };
}

function fixture(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-trigger-"));
  for (const name of names) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const past = (Date.now() - 48 * HOUR) / 1000;
    utimesSync(dir, past, past);
  }
  return root;
}

function options(root: string, extra: Record<string, unknown> = {}) {
  const written: string[] = [];
  const records = new Map<string, KnownSessionRecord>([["closed", { closed: true }]]);
  let loads = 0;
  return {
    written,
    loads: () => loads,
    opts: {
      loadRecords: async () => {
        loads += 1;
        return records;
      },
      rootDir: root,
      scan: () => measuredScan(),
      write: (line: string) => written.push(line),
      ...extra,
    },
  };
}

test("0bac6a00: the FIRST trigger sweeps, and prints its census", async () => {
  resetConfigDirSweepSchedule();
  const root = fixture(["acpx-opencode-closed"]);
  const { written, opts } = options(root);
  try {
    const result = await maybeSweepHarnessConfigDirs(opts);
    assert.ok(result !== undefined, "the first trigger did not sweep");
    assert.deepEqual(result.removed, [join(root, "acpx-opencode-closed")]);
    assert.equal(existsSync(join(root, "acpx-opencode-closed")), false);
    assert.match(written.join(""), /harness config dirs: root=/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigDirSweepSchedule();
  }
});

test("0bac6a00: FORM 2 — a gated-out trigger touches NO directory and reads NO store", async () => {
  // ⚠️ THIS IS THE WHOLE REASON FOR FORM 2 OVER FORM 1. Form 1 decides from the
  // candidate COUNT, which costs a `readdir` — 81% of the census's own cost, and it
  // scales with total /tmp size (~390x across two boxes on one build). So the
  // assertion that matters is not "it returned undefined" but that it did no WORK:
  // the store was never read, and the directory that a sweep would have removed is
  // still there.
  resetConfigDirSweepSchedule();
  const root = fixture(["acpx-opencode-closed"]);
  const first = options(root, { now: 1_000_000 });
  try {
    await maybeSweepHarnessConfigDirs(first.opts);
    assert.equal(first.loads(), 1, "the first trigger did not read the store");

    const root2 = fixture(["acpx-opencode-closed"]);
    try {
      const second = options(root2, { now: 1_000_000 + DEFAULT_SWEEP_INTERVAL_MS - 1 });
      const result = await maybeSweepHarnessConfigDirs(second.opts);
      assert.equal(result, undefined, "a within-interval trigger swept anyway");
      assert.equal(second.loads(), 0, "a gated-out trigger still read the store");
      assert.deepEqual(second.written, [], "a gated-out trigger still printed a census");
      assert.equal(
        existsSync(join(root2, "acpx-opencode-closed")),
        true,
        "a gated-out trigger still removed a directory",
      );
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigDirSweepSchedule();
  }
});

test("0bac6a00: once the interval has ELAPSED the trigger sweeps again", async () => {
  // The negative that makes the gate test evidence: a gate that never re-opens
  // would satisfy the test above and leave the box unswept forever.
  resetConfigDirSweepSchedule();
  const root = fixture(["acpx-opencode-closed"]);
  try {
    await maybeSweepHarnessConfigDirs(options(root, { now: 1_000_000 }).opts);
    const root2 = fixture(["acpx-opencode-closed"]);
    try {
      const later = options(root2, { now: 1_000_000 + DEFAULT_SWEEP_INTERVAL_MS });
      const result = await maybeSweepHarnessConfigDirs(later.opts);
      assert.ok(result !== undefined, "the trigger stayed shut after the interval elapsed");
      assert.equal(existsSync(join(root2, "acpx-opencode-closed")), false);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigDirSweepSchedule();
  }
});

test("0bac6a00: trigger A is UNGATED, and it stamps the clock so a following prompt does not re-sweep", async () => {
  resetConfigDirSweepSchedule();
  const root = fixture(["acpx-opencode-closed"]);
  try {
    // A runs whatever the clock says — the process start IS its "once".
    const atStart = options(root, { now: 5_000_000 });
    assert.ok(await sweepHarnessConfigDirsNow(atStart.opts));

    const root2 = fixture(["acpx-opencode-closed"]);
    try {
      const firstPrompt = options(root2, { now: 5_000_100 });
      assert.equal(
        await maybeSweepHarnessConfigDirs(firstPrompt.opts),
        undefined,
        "a prompt right after server start swept a second time",
      );
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigDirSweepSchedule();
  }
});

test("0bac6a00: the trigger NEVER THROWS — a broken store degrades to a printed line", async () => {
  // ⚠️ IT IS CALLED FROM THE PROMPT PATH. A tidy-up that can fail a user's turn is
  // a worse defect than the leak it cleans up.
  resetConfigDirSweepSchedule();
  const written: string[] = [];
  const result = await sweepHarnessConfigDirsNow({
    loadRecords: async () => {
      throw new Error("store unavailable");
    },
    rootDir: "/nonexistent-root-for-0bac6a00",
    scan: () => measuredScan(),
    write: (line) => written.push(line),
  });
  assert.equal(result, undefined);
  assert.match(written.join(""), /sweep skipped: store unavailable/);
  resetConfigDirSweepSchedule();
});

test("0bac6a00: a dry-run trigger prints the per-candidate plan and removes nothing", async () => {
  resetConfigDirSweepSchedule();
  const root = fixture(["acpx-opencode-closed"]);
  try {
    const { written, opts } = options(root, { dryRun: true });
    const result = await sweepHarnessConfigDirsNow(opts);
    assert.equal(result?.dryRun, true);
    assert.deepEqual(result?.removed, []);
    assert.equal(existsSync(join(root, "acpx-opencode-closed")), true);
    assert.match(written.join(""), /DRY RUN — nothing was removed/);
    assert.match(written.join(""), /REMOVE .*acpx-opencode-closed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetConfigDirSweepSchedule();
  }
});
