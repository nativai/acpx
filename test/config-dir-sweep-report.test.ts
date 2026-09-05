import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HARNESS_CONFIG_DIR_ROOT_ENV } from "../src/acp/harness-config-dir-root.js";
import {
  describeHarnessConfigDirSweep,
  describeHarnessConfigDirSweepPlan,
  type KnownSessionRecord,
  pruneOrphanHarnessConfigDirs,
} from "../src/acp/harness-config-dir.js";
import type { LiveProcessScan } from "../src/process-population.js";
import {
  makeSessionRecord,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

/**
 * brick 0bac6a00 §§5–7 and §10.1 — the sweep REPORTS honestly, and the shared
 * plugin cache is out of scope by a predicate rather than by a naming accident.
 *
 * Deliberately separate from `config-dir-sweep-scope.test.ts`, which is about §4
 * (where the sweep looks). This file is about what it says and what it spares.
 */

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const AGENT_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

type CliResult = { code: number | null; stdout: string; stderr: string };

function runCliUnguarded(args: string[], homeDir: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, ACPX_STATE_HOME: homeDir };
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.stdin.end();
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** A scan that IS measured — both populations non-zero, no dirs referenced. */
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

function plantAged(root: string, name: string, ageMs = SEVEN_HOURS_MS): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "marker.txt"), "planted");
  const past = (Date.now() - ageMs) / 1000;
  utimesSync(dir, past, past);
  return dir;
}

function freshRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// §5 — a REAL dry-run
// ---------------------------------------------------------------------------

test("0bac6a00 §5: a dry run CLASSIFIES, reports wouldRemove, and deletes nothing", () => {
  const root = freshRoot("acpx-0bac6a00-dry-");
  try {
    const dir = plantAged(root, "acpx-opencode-orphan-1");
    // ⚠️ A CLOSED RECORD, not an empty store. Since `unrecognised` became
    // retain-and-report, an unclaimed directory is never removable — so a preview
    // fixture with no record would preview nothing and this test would assert the
    // absence of a removal rather than the preview of one.
    const result = pruneOrphanHarnessConfigDirs({
      records: new Map<string, KnownSessionRecord>([["orphan-1", { closed: true }]]),
      liveScan: measuredScan(),
      rootDir: root,
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    assert.equal(result.scanned, 1);
    // ⚠️ BOTH HALVES MATTER. `removed` empty alone would also be true of a sweep
    // that never ran — which is exactly what the OLD --dry-run did.
    assert.deepEqual(result.removed, [], "a dry run must delete nothing");
    assert.deepEqual(result.wouldRemove, [dir], "a dry run must say what it WOULD delete");
    assert.equal(existsSync(dir), true, "the directory was deleted by a preview");
    assert.deepEqual(
      result.candidates.map((c) => ({ dir: c.dir, retain: c.retain, reason: c.reason })),
      [{ dir, retain: false, reason: "closedRecord" }],
      "the preview must carry a per-candidate verdict, not just a count",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00 §5: the SAME fixture without --dry-run really is removed (the preview is not vacuous)", () => {
  // The control for the test above: a dry run that previews a removal nothing
  // would ever have performed is a preview of a fiction.
  const root = freshRoot("acpx-0bac6a00-wet-");
  try {
    const dir = plantAged(root, "acpx-opencode-orphan-1");
    const result = pruneOrphanHarnessConfigDirs({
      records: new Map<string, KnownSessionRecord>([["orphan-1", { closed: true }]]),
      liveScan: measuredScan(),
      rootDir: root,
    });
    assert.equal(result.dryRun, false);
    assert.deepEqual(result.removed, [dir]);
    assert.deepEqual(result.wouldRemove, [], "a real run must not populate wouldRemove");
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00 §5: `sessions prune --dry-run` PREVIEWS a directory an OPEN abandoned record still pins", async () => {
  // ⚠️ THE ORDERING TEST, AND IT IS THE ONE THAT IS EASY TO GET WRONG. A real prune
  // closes ownerless records FIRST, and only then will the directory pass remove
  // their dirs. A dry run closes nothing, so a naive preview re-reads a store where
  // the record is still OPEN and reports RETAIN(openRecord) — omitting exactly the
  // set the record sweep exists to release, in the reassuring direction.
  await withTempHomeFixture("acpx-0bac6a00-order-", async (homeDir) => {
    const root = process.env[HARNESS_CONFIG_DIR_ROOT_ENV] as string;
    const cwd = path.join(homeDir, "work");
    await fs.mkdir(cwd, { recursive: true });
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord(
        {
          acpxRecordId: "dryrun-abandoned",
          acpSessionId: "dryrun-abandoned",
          agentCommand: AGENT_COMMAND,
          agentName: "claude",
          cwd,
          // Long idle and OPEN: the abandoned-record sweep would close it.
          createdAt: "2026-01-01T00:00:00.000Z",
          lastUsedAt: "2026-01-01T00:00:00.000Z",
          closed: false,
        },
        { defaultName: false, defaultAcpx: false },
      ),
    );
    const dir = plantAged(root, "acpx-opencode-dryrun-abandoned");

    const result = await runCliUnguarded(["claude", "sessions", "prune", "--dry-run"], homeDir);

    const out = result.stderr;
    assert.match(out, /harness config dirs: .*DRY RUN \(nothing removed\)/);
    assert.ok(
      out.includes(`WOULD REMOVE ${dir}`),
      `the preview did not model the record sweep's closes:\n${out}`,
    );
    assert.equal(existsSync(dir), true, "a dry run deleted a directory");
  });
});

// ---------------------------------------------------------------------------
// §6 — `unmeasured` as its own value
// ---------------------------------------------------------------------------

test("0bac6a00 §6: a REFUSAL attributes to `unmeasured`, never to `liveProcess`", () => {
  const root = freshRoot("acpx-0bac6a00-refuse-");
  try {
    plantAged(root, "acpx-opencode-a");
    plantAged(root, "acpx-pi-b");
    // An unmeasured census: the shape that made the old code claim every candidate
    // was held by a live process. `liveProcess: 6` was measured with none running.
    const result = pruneOrphanHarnessConfigDirs({
      records: new Map<string, KnownSessionRecord>(),
      liveScan: {
        scanned: 0,
        environRead: 0,
        pids: new Set(),
        referencedDirs: new Set(),
        referencedSessionIds: new Set(),
      },
      rootDir: root,
    });

    assert.equal(result.notMeasured, true);
    assert.equal(result.scanned, 2, "a refusal must still report the candidate population");
    assert.deepEqual(result.removed, []);
    assert.equal(result.retainedBy.unmeasured, 2);
    assert.equal(
      result.retainedBy.liveProcess,
      0,
      "a refusal must not claim live holders it never measured",
    );
    const line = describeHarnessConfigDirSweep(result);
    assert.match(line, /unmeasured=2/);
    assert.match(line, /liveProcess=0/);
    assert.match(line, /REFUSED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00 §6: a REFUSAL's plan says so rather than reading as a clean root", () => {
  const root = freshRoot("acpx-0bac6a00-refuse2-");
  try {
    const result = pruneOrphanHarnessConfigDirs({
      records: new Map<string, KnownSessionRecord>(),
      liveScan: {
        scanned: 0,
        environRead: 0,
        pids: new Set(),
        referencedDirs: new Set(),
        referencedSessionIds: new Set(),
      },
      rootDir: join(root, "does-not-exist"),
    });
    assert.equal(result.notMeasured, true);
    assert.match(describeHarnessConfigDirSweepPlan(result), /NOT a statement that it is clean/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §7 — the census by default
// ---------------------------------------------------------------------------

test("0bac6a00 §7: the census prints WITHOUT --verbose", async () => {
  await withTempHomeFixture("acpx-0bac6a00-census-", async (homeDir) => {
    const root = process.env[HARNESS_CONFIG_DIR_ROOT_ENV] as string;
    // No --verbose anywhere on this command line.
    const result = await runCliUnguarded(["claude", "sessions", "prune", "--whole-box"], homeDir);
    assert.ok(
      result.stderr.includes(`harness config dirs: root=${root}`),
      `a sweep that removes things silently is the shape of every incident in this thread:\n${result.stderr}`,
    );
    assert.ok(
      result.stderr.includes("scanned=0 means NOT RUN, not clean"),
      "the census must keep saying what a zero means",
    );
  });
});

// ---------------------------------------------------------------------------
// §10.1 — the plugin cache excluded by SCOPE, not by its name's leading dot
// ---------------------------------------------------------------------------

test("0bac6a00 §10.1: a plugin cache WITHOUT its leading dot is still excluded", () => {
  // ⚠️ THE FIRE TEST FOR THE POINT OF §10.1. Today the cache is spared because the
  // dot makes `.acpx-opencode-plugin-cache-<v>` miss the `acpx-<harness>-` prefix —
  // a naming convention, and the next tidy-up removes those. Named WITHOUT the dot
  // the old filter would read it as a session whose id is `plugin-cache-1.18.28`,
  // recognise it from no record, and delete it once aged — silently restoring the
  // 63 MB-per-session cost the cache exists to prevent.
  const root = freshRoot("acpx-0bac6a00-cache-");
  try {
    const undotted = plantAged(root, "acpx-opencode-plugin-cache-1.18.28");
    const dotted = plantAged(root, ".acpx-opencode-plugin-cache-1.18.28");
    // The CONTROL: an ordinary orphan in the same root, same age, must still go —
    // otherwise "nothing was deleted" would prove nothing about the exclusion.
    const ordinary = plantAged(root, "acpx-opencode-ordinary-orphan");

    const result = pruneOrphanHarnessConfigDirs({
      records: new Map<string, KnownSessionRecord>([["ordinary-orphan", { closed: true }]]),
      liveScan: measuredScan(),
      rootDir: root,
    });

    assert.deepEqual(result.removed, [ordinary], "the control orphan was not removed");
    assert.equal(existsSync(undotted), true, "the cache was eaten once its dot was gone");
    assert.equal(existsSync(dotted), true);
    assert.equal(result.scanned, 1, "the cache must not even be a CANDIDATE");
    assert.deepEqual(
      result.candidates.map((c) => c.dir),
      [ordinary],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00 §10.1: the exclusion does not swallow a real session dir with a similar name", () => {
  // A guard that is too broad is the other failure: `acpx-opencode-plugin-x` is a
  // session id, not the cache, and must remain reapable.
  const root = freshRoot("acpx-0bac6a00-cache2-");
  try {
    const lookalike = plantAged(root, "acpx-opencode-plugin-x", 8 * HOUR);
    const result = pruneOrphanHarnessConfigDirs({
      records: new Map<string, KnownSessionRecord>([["plugin-x", { closed: true }]]),
      liveScan: measuredScan(),
      rootDir: root,
    });
    assert.deepEqual(result.removed, [lookalike]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00 §6b: a REMOVED dir reports `closedRecord`, never `openRecord`", () => {
  // ⚠️ THE LINE THIS PINS ONCE READ "WOULD REMOVE …(openRecord)" — "I am deleting
  // this, and the reason is that its record is open." Measured on staging against
  // four real leaked directories. Same defect §6 removed from the refusal path,
  // arriving on the removal path.
  //
  // It survived every test because on devbox every candidate was `tooYoung`, so the
  // remove-because-closed branch never executed. Both branches are asserted here.
  const root = freshRoot("acpx-0bac6a00-closedreason-");
  try {
    const closedDir = plantAged(root, "acpx-opencode-closed-one");
    const openDir = plantAged(root, "acpx-opencode-open-one");
    const records = new Map<string, KnownSessionRecord>([
      ["closed-one", { closed: true }],
      ["open-one", { closed: false }],
    ]);

    const result = pruneOrphanHarnessConfigDirs({
      records,
      liveScan: measuredScan(),
      rootDir: root,
      dryRun: true,
    });

    const byDir = new Map(result.candidates.map((c) => [c.dir, c]));
    assert.equal(byDir.get(closedDir)?.retain, false, "a closed record must release its dir");
    assert.equal(
      byDir.get(closedDir)?.reason,
      "closedRecord",
      "a removal must not be attributed to the record being OPEN",
    );
    // The other branch, so "it says closedRecord" is not simply "it says that always".
    assert.equal(byDir.get(openDir)?.retain, true);
    assert.equal(byDir.get(openDir)?.reason, "openRecord");

    // And the rendered preview — the thing a human actually reads.
    const plan = describeHarnessConfigDirSweepPlan(result);
    assert.match(plan, /WOULD REMOVE .*acpx-opencode-closed-one \(closedRecord\)/);
    assert.match(plan, /RETAIN .*acpx-opencode-open-one \(openRecord\)/);
    assert.equal(
      /WOULD REMOVE .*\(openRecord\)/.test(plan),
      false,
      "no removal line may be attributed to openRecord",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00 §6b: `retainedBy` still counts only RETENTIONS, and closedRecord is not one", () => {
  // The two vocabularies are separate types so a removal reason cannot be counted as
  // a retention. This asserts the arithmetic that separation protects.
  const root = freshRoot("acpx-0bac6a00-tally-");
  try {
    plantAged(root, "acpx-opencode-closed-a");
    plantAged(root, "acpx-opencode-open-b");
    const result = pruneOrphanHarnessConfigDirs({
      records: new Map<string, KnownSessionRecord>([
        ["closed-a", { closed: true }],
        ["open-b", { closed: false }],
      ]),
      liveScan: measuredScan(),
      rootDir: root,
      dryRun: true,
    });
    assert.equal(result.scanned, 2);
    assert.equal(result.retained, 1, "only the open-record dir is retained");
    assert.equal(result.retainedBy.openRecord, 1);
    assert.deepEqual(result.wouldRemove.length, 1);
    // Every retention is accounted for by exactly one reason — no double-count, no gap.
    const tally = Object.values(result.retainedBy).reduce((a, b) => a + b, 0);
    assert.equal(tally, result.retained, "retainedBy must sum to retained");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00: `prune` CANNOT reap the dirs of the sessions it just deleted — the verb can", async () => {
  // ⚠️ A REAL CONSEQUENCE OF MAKING `unrecognised` RETAIN-AND-REPORT, pinned so it is a
  // known property rather than a surprise. `sessions prune` DELETES each closed record
  // and only then sweeps, so by the time the directory pass runs, the id that would
  // have identified the dir is GONE — the dir reads `unrecognised` and is now kept.
  //
  // That is the conservative answer and it is arguably correct: prune has destroyed the
  // evidence needed to attribute the directory, so refusing to delete it is the honest
  // outcome. But it means prune's tidy-up is a NO-OP FOR ITS OWN DELETIONS, and the
  // record-preserving verb is the reaper that actually works — precisely BECAUSE it
  // preserves the record it needs to read.
  //
  // Measured 2026-09-05 with the fixture asserted in both arms:
  //   prune --whole-box      -> record after 0, dir RETAINED (unrecognised=1)
  //   sweep-config-dirs      -> record after 1, dir REMOVED  (removed=1)
  const root = freshRoot("acpx-0bac6a00-prunegap-");
  try {
    const dir = plantAged(root, "acpx-opencode-gap-one");

    // Arm 1: the record is GONE, as it is after prune has deleted it.
    const afterPrune = pruneOrphanHarnessConfigDirs({
      records: new Map<string, KnownSessionRecord>(),
      liveScan: measuredScan(),
      rootDir: root,
    });
    assert.deepEqual(afterPrune.removed, [], "a dir with no record must be RETAINED");
    assert.equal(afterPrune.retainedBy.unrecognised, 1);
    assert.equal(existsSync(dir), true);

    // Arm 2: the record SURVIVES, as it does under sweep-config-dirs. Same directory,
    // same age — the only difference is whether the record is still there to read.
    const afterVerb = pruneOrphanHarnessConfigDirs({
      records: new Map<string, KnownSessionRecord>([["gap-one", { closed: true }]]),
      liveScan: measuredScan(),
      rootDir: root,
    });
    assert.deepEqual(afterVerb.removed, [dir], "a CLOSED record must release its dir");
    assert.equal(existsSync(dir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
