import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type KnownSessionRecord,
  pruneOrphanHarnessConfigDirs,
} from "../src/acp/harness-config-dir.js";
import { CONFIG_DIR_ENV_NAMES, type LiveProcessScan } from "../src/process-population.js";

// cc9a5f25 — the config-dir sweep removes only on POSITIVE OWNERSHIP.
//
// ⚠️ THE DEFECT WAS A COMMENT THAT DESCRIBED A SAFETY PROPERTY THE CODE LACKED.
// It claimed removal required the id to appear in "neither `liveSessionIds` NOR
// AS A LIVE SPAWN", and that "an id it does not recognise is RETAINED". There was
// no live-spawn check at all, and the single branch removed anything not in the
// set — so an unrecognised id was REMOVED. The comment was right about the
// design; the code never implemented it.
//
// ⚠️ SO THERE IS A MUTANT FOR EACH OF THE TWO PROTECTIONS THE COMMENT CLAIMED —
// unrecognised-id retention and the live-process leg. The comment claimed two and
// the code had neither; two probes are what stops that recurring.

const HOUR = 60 * 60 * 1000;

/** A scan that IS measured — both populations non-zero. */
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

function fixture(entries: { name: string; ageMs?: number }[]): string {
  const root = mkdtempSync(join(tmpdir(), "cc9a5f25-"));
  for (const entry of entries) {
    const dir = join(root, entry.name);
    mkdirSync(dir, { recursive: true });
    if (entry.ageMs !== undefined) {
      const when = (Date.now() - entry.ageMs) / 1000;
      utimesSync(dir, when, when);
    }
  }
  return root;
}

function records(pairs: [string, boolean][]): ReadonlyMap<string, KnownSessionRecord> {
  return new Map(pairs.map(([id, closed]) => [id, { closed }]));
}

test("cc9a5f25 PROTECTION 1: an UNRECOGNISED id is RETAINED, not removed", async () => {
  // The `randomUUID()` fallback dir lands here: it is in no session list, ever.
  // Under the old code this was the REMOVE branch.
  const root = fixture([{ name: "acpx-opencode-unknown-id-zzz9", ageMs: 60_000 }]);
  try {
    const result = pruneOrphanHarnessConfigDirs({
      records: records([]),
      liveScan: measuredScan(),
      rootDir: root,
    });
    assert.equal(result.scanned, 1, "population: the candidate was not even examined");
    assert.deepEqual(result.removed, [], "an unrecognised id was REMOVED");
    assert.equal(result.retainedBy.tooYoung, 1);
    assert.equal(existsSync(join(root, "acpx-opencode-unknown-id-zzz9")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cc9a5f25 PROTECTION 2: a dir a LIVE PROCESS references is RETAINED", async () => {
  // Even with a closed record — the strongest form, because every other clause
  // says "remove" and only the live-process leg says no.
  const root = fixture([{ name: "acpx-opencode-live-1", ageMs: 48 * HOUR }]);
  const dir = join(root, "acpx-opencode-live-1");
  try {
    const result = pruneOrphanHarnessConfigDirs({
      records: records([["live-1", true]]),
      liveScan: measuredScan({ referencedDirs: new Set([dir]) }),
      rootDir: root,
    });
    assert.equal(result.scanned, 1);
    assert.deepEqual(result.removed, [], "a dir a live process is using was removed");
    assert.equal(result.retainedBy.liveProcess, 1);
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cc9a5f25: an UNMEASURABLE /proc scan removes NOTHING and says so", async () => {
  // A refusal and a clean sweep both remove nothing. `notMeasured` is what tells
  // them apart, and without it "removed 0" reads like success.
  const root = fixture([{ name: "acpx-opencode-closed-1", ageMs: 48 * HOUR }]);
  try {
    for (const scan of [
      undefined,
      measuredScan({ scanned: 0, pids: new Set() }),
      measuredScan({ environRead: 0 }), // pids visible, environments unreadable
    ]) {
      const result = pruneOrphanHarnessConfigDirs({
        records: records([["closed-1", true]]),
        liveScan: scan,
        rootDir: root,
      });
      assert.equal(result.notMeasured, true, "an unmeasurable scan was treated as measured");
      assert.deepEqual(result.removed, [], "removed on an unmeasurable scan");
      assert.equal(result.scanned, 1, "the candidate population must still be reported");
    }
    assert.equal(existsSync(join(root, "acpx-opencode-closed-1")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cc9a5f25: an OPEN record retains its dir; a CLOSED one releases it", async () => {
  // The two-sided control. A sweep that retained everything would pass every row
  // above and free nothing — this is the row that fails if it does.
  const root = fixture([
    { name: "acpx-opencode-open-1", ageMs: 48 * HOUR },
    { name: "acpx-opencode-closed-1", ageMs: 48 * HOUR },
  ]);
  try {
    const result = pruneOrphanHarnessConfigDirs({
      records: records([
        ["open-1", false],
        ["closed-1", true],
      ]),
      liveScan: measuredScan(),
      rootDir: root,
    });
    assert.equal(result.scanned, 2, "population");
    assert.deepEqual(
      result.removed.map((d) => d.split("/").pop()),
      ["acpx-opencode-closed-1"],
      "exactly the closed record's dir must be removed",
    );
    assert.equal(result.retainedBy.openRecord, 1);
    assert.equal(existsSync(join(root, "acpx-opencode-open-1")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cc9a5f25: an unclaimed dir is removed only once it is OLDER than the stated age", async () => {
  const root = fixture([
    { name: "acpx-opencode-orphan-young", ageMs: 1 * HOUR },
    { name: "acpx-opencode-orphan-old", ageMs: 48 * HOUR },
  ]);
  try {
    const result = pruneOrphanHarnessConfigDirs({
      records: records([]),
      liveScan: measuredScan(),
      rootDir: root,
      orphanMinAgeMs: 6 * HOUR,
    });
    assert.deepEqual(
      result.removed.map((d) => d.split("/").pop()),
      ["acpx-opencode-orphan-old"],
    );
    assert.equal(result.retainedBy.tooYoung, 1);
    // The age is PRINTED, so a stuck orphan is visible instead of accumulating.
    assert.ok(
      (result.oldestUnclaimedAgeMs ?? 0) >= 47 * HOUR,
      `oldest unclaimed age not reported: ${String(result.oldestUnclaimedAgeMs)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cc9a5f25: a directory that is not ours is never even a candidate", async () => {
  // `cli/queue/paths.ts` creates `/tmp/acpx-<hash>` for queue sockets. Found by
  // ENUMERATING the consumers of this name, not by recalling them.
  const root = fixture([{ name: "acpx-0a1b2c3d4e", ageMs: 48 * HOUR }]);
  try {
    const result = pruneOrphanHarnessConfigDirs({
      records: records([]),
      liveScan: measuredScan(),
      rootDir: root,
      orphanMinAgeMs: 0,
    });
    assert.equal(result.scanned, 0, "a queue socket dir was treated as a candidate");
    assert.equal(existsSync(join(root, "acpx-0a1b2c3d4e")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cc9a5f25: the scanned env names match what the writer actually SETS", async () => {
  // The live-process leg is only as good as the list of variables it looks for.
  // If `harness-config-dir.ts` gains a third variable and this list does not, the
  // leg silently stops seeing that harness's dirs — and looks exactly as healthy.
  const { applyHarnessConfigDir } = await import("../src/acp/harness-config-dir.js");
  const { AGENT_REGISTRY } = await import("../src/agent-registry.js");
  const root = mkdtempSync(join(tmpdir(), "cc9a5f25-names-"));
  try {
    const observed = new Set<string>();
    for (const id of ["opencode", "pi"] as const) {
      const env: NodeJS.ProcessEnv = {};
      applyHarnessConfigDir({
        env,
        agentCommand: AGENT_REGISTRY[id],
        sessionId: `names-${id}`,
        primer: "P",
        rootDir: root,
      });
      for (const name of Object.keys(env)) {
        observed.add(name);
      }
    }
    assert.ok(observed.size > 0, "population: no env names were captured at all");
    for (const name of observed) {
      assert.ok(
        (CONFIG_DIR_ENV_NAMES as readonly string[]).includes(name),
        `the writer sets ${name}, which the /proc scan does not look for`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
