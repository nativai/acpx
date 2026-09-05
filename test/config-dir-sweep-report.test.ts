import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  describeHarnessConfigDirSweep,
  describeHarnessConfigDirSweepPlan,
  isExcludedFromConfigDirSweep,
  type KnownSessionRecord,
  pruneOrphanHarnessConfigDirs,
} from "../src/acp/harness-config-dir.js";
import type { LiveProcessScan } from "../src/process-population.js";

/**
 * brick 0bac6a00 §§5-7 and §10.1 — THE SWEEP REPORTS HONESTLY.
 *
 * These drive `pruneOrphanHarnessConfigDirs` directly with an explicit `rootDir`,
 * which is the only sanctioned way to exercise the sweep: no subprocess swarm, no
 * shared state, and the root is a fixture that is removed in `finally`.
 *
 * ## The instrument control, and why it is the FIRST thing here
 *
 * An unmeasured `/proc` census must remove NOTHING. Without that control, every
 * "it removed the right thing" below could equally be a sweep that removes
 * indiscriminately. It is pinned in `prune-positive-ownership.test.ts`; the §6 test
 * here strengthens it, because that test asserted the refusal HAPPENED and never
 * what the refusal CLAIMED — which is exactly how the defect §6 fixes shipped.
 */

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

function records(entries: [string, boolean][]): Map<string, KnownSessionRecord> {
  return new Map(entries.map(([id, closed]) => [id, { closed }]));
}

function fixture(entries: { name: string; ageMs?: number }[]): string {
  const root = mkdtempSync(join(tmpdir(), "acpx-0bac6a00-report-"));
  for (const entry of entries) {
    const dir = join(root, entry.name);
    mkdirSync(dir, { recursive: true });
    if (entry.ageMs !== undefined) {
      const past = (Date.now() - entry.ageMs) / 1000;
      utimesSync(dir, past, past);
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// §6 — `unmeasured` is its own value
// ---------------------------------------------------------------------------

test("0bac6a00 §6: a REFUSAL attributes to `unmeasured`, never to `liveProcess`", () => {
  // ⚠️ THE DEFECT THIS PINS: the refusal path returned
  // `{ ...retainedBy, liveProcess: candidates.length }`, so a run that observed NO
  // processes at all reported them as held by live ones. `notMeasured` beside it
  // carried the truth and the attribution contradicted it — and the attribution is
  // what a dashboard renders. A refusal that reports itself as N live holds is
  // worse than one that reports nothing, because it is confident.
  const root = fixture([
    { name: "acpx-opencode-a", ageMs: 48 * HOUR },
    { name: "acpx-pi-b", ageMs: 48 * HOUR },
  ]);
  try {
    const result = pruneOrphanHarnessConfigDirs({
      records: records([]),
      liveScan: measuredScan({ environRead: 0 }), // pids visible, environments unreadable
      rootDir: root,
    });
    assert.equal(result.notMeasured, true);
    assert.equal(result.retainedBy.unmeasured, 2, "the refusal did not attribute to `unmeasured`");
    assert.equal(
      result.retainedBy.liveProcess,
      0,
      "the refusal still claims live holders it never observed",
    );
    assert.deepEqual(result.removed, []);
    // And it says so in the line a human reads, not only in the object.
    const line = describeHarnessConfigDirSweep(result);
    assert.match(line, /unmeasured=2/);
    assert.match(line, /liveProcess=0/);
    assert.match(line, /REFUSED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00 §6: a MEASURED live hold still attributes to `liveProcess`", () => {
  // The negative case that makes the test above evidence: if everything attributed
  // to `unmeasured`, the first test would pass and the field would be meaningless.
  const root = fixture([{ name: "acpx-opencode-held", ageMs: 48 * HOUR }]);
  try {
    const result = pruneOrphanHarnessConfigDirs({
      records: records([["held", true]]),
      liveScan: measuredScan({ referencedDirs: new Set([join(root, "acpx-opencode-held")]) }),
      rootDir: root,
    });
    assert.equal(result.notMeasured, false);
    assert.equal(result.retainedBy.liveProcess, 1);
    assert.equal(result.retainedBy.unmeasured, 0);
    assert.equal(existsSync(join(root, "acpx-opencode-held")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §5 — a real dry-run
// ---------------------------------------------------------------------------

test("0bac6a00 §5: a dry run CLASSIFIES and removes nothing, and `removed` stays truthful", () => {
  const root = fixture([
    { name: "acpx-opencode-closed", ageMs: 48 * HOUR },
    { name: "acpx-pi-open", ageMs: 48 * HOUR },
    { name: "acpx-opencode-young", ageMs: 1 * HOUR },
  ]);
  try {
    const result = pruneOrphanHarnessConfigDirs({
      records: records([
        ["closed", true],
        ["open", false],
      ]),
      liveScan: measuredScan(),
      rootDir: root,
      dryRun: true,
    });

    assert.equal(result.dryRun, true);
    // `removed` means DELETED, on every run, or historical readings are ambiguous.
    assert.deepEqual(result.removed, [], "a dry run reported something as removed");
    assert.deepEqual(result.wouldRemove, [join(root, "acpx-opencode-closed")]);
    // Nothing on disk moved.
    for (const name of ["acpx-opencode-closed", "acpx-pi-open", "acpx-opencode-young"]) {
      assert.equal(existsSync(join(root, name)), true, `${name} was removed by a DRY RUN`);
    }
    // And it is a PREVIEW, not a count: every candidate, its verdict, its reason.
    const plan = describeHarnessConfigDirSweepPlan(result);
    assert.match(plan, /REMOVE .*acpx-opencode-closed \(openRecord/);
    assert.match(plan, /KEEP {2}.*acpx-pi-open \(openRecord/);
    assert.match(plan, /KEEP {2}.*acpx-opencode-young \(tooYoung/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00 §5: the dry run PREDICTS the real run — same verdicts, same set", () => {
  // ⚠️ THE PROPERTY THAT MAKES A PREVIEW WORTH ANYTHING. A preview that classifies
  // by a different path than the run is a preview of nothing; the old `--dry-run`
  // returned before the sweep, so it previewed nothing at all while reading as a
  // clean result. Same fixture, both modes, compared.
  const entries = [
    { name: "acpx-opencode-closed", ageMs: 48 * HOUR },
    { name: "acpx-pi-orphan", ageMs: 48 * HOUR },
    { name: "acpx-pi-open", ageMs: 48 * HOUR },
    { name: "acpx-opencode-young", ageMs: 1 * HOUR },
  ];
  const known: [string, boolean][] = [
    ["closed", true],
    ["open", false],
  ];
  const dryRoot = fixture(entries);
  const realRoot = fixture(entries);
  try {
    const preview = pruneOrphanHarnessConfigDirs({
      records: records(known),
      liveScan: measuredScan(),
      rootDir: dryRoot,
      dryRun: true,
    });
    const real = pruneOrphanHarnessConfigDirs({
      records: records(known),
      liveScan: measuredScan(),
      rootDir: realRoot,
    });

    const rel = (root: string) => (dir: string) => dir.slice(root.length);
    const byText = (a: string, z: string) => (a < z ? -1 : a > z ? 1 : 0);
    // Compared as text so the assertion message names the offending entry rather
    // than printing two object graphs.
    const verdicts = (result: typeof preview, root: string) =>
      result.candidates
        .map((c) => `${rel(root)(c.dir)} retain=${c.retain} reason=${c.reason}`)
        .toSorted(byText);
    assert.deepEqual(
      preview.wouldRemove.map(rel(dryRoot)).toSorted(byText),
      real.removed.map(rel(realRoot)).toSorted(byText),
      "the preview and the real run disagree about what gets removed",
    );
    assert.deepEqual(
      verdicts(preview, dryRoot),
      verdicts(real, realRoot),
      "the preview and the real run disagree about a verdict",
    );
    // Sanity: the comparison is not vacuous — something really was removed.
    assert.ok(real.removed.length > 0, "the real run removed nothing, so this proved nothing");
  } finally {
    rmSync(dryRoot, { recursive: true, force: true });
    rmSync(realRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §7 / the walk cost — the census names what it read
// ---------------------------------------------------------------------------

test("0bac6a00 §7: the census reports `entriesRead` (the WALK) beside `scanned` (the CANDIDATES)", () => {
  // On devbox those two are 25,553 and 7. A census printing only the second
  // describes a walk four orders of magnitude larger than the number beside it.
  const root = fixture([
    { name: "acpx-opencode-a", ageMs: 48 * HOUR },
    { name: "acpx-cli-test-home-XXXX" },
    { name: "acpx-flow-store-YYYY" },
    { name: "unrelated-dir" },
  ]);
  try {
    const result = pruneOrphanHarnessConfigDirs({
      records: records([]),
      liveScan: measuredScan(),
      rootDir: root,
    });
    assert.equal(result.entriesRead, 4, "entriesRead must be the whole listing");
    assert.equal(result.scanned, 1, "only the real config dir is a candidate");
    const line = describeHarnessConfigDirSweep(result);
    assert.match(line, /entriesRead=4/);
    assert.match(line, /scanned=1/);
    assert.match(line, new RegExp(`root=${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §10.1 and the candidate filter — decided EXPLICITLY, never by shape
// ---------------------------------------------------------------------------

/**
 * The real second-segment population of `/tmp/acpx-<segment>-<id>` on devbox,
 * measured 2026-09-05: 12,199 directories carrying the exact SHAPE of a config dir,
 * across these fixture names. **Not one is a harness id.**
 */
const MEASURED_FIXTURE_SEGMENTS = [
  "cli-test-home",
  "flow-store",
  "models-cli",
  "ui-messages-log",
  "models",
  "hook",
  "uiprefs",
  "hostmap-test",
  "ui-b10-flow",
  "ui-close-owner",
  "ui-brick-attach",
];

test("0bac6a00: 12,199 SHAPE-matching fixture dirs are not candidates — and a real one still is", () => {
  // ⚠️ A DISCOVERING CHECK, NOT A NAME LIST. Nothing excludes these by name: they
  // are excluded because membership is a POSITIVE match against HARNESS_IDS. If
  // anyone widens that to an `acpx-*-*` glob or a shape regex, this reds — which is
  // the whole point, because those directories are LIVE (the newest was created
  // seconds before the measurement, by a suite that was running).
  const root = fixture([
    ...MEASURED_FIXTURE_SEGMENTS.map((segment) => ({
      name: `acpx-${segment}-AbCdEf`,
      ageMs: 48 * HOUR,
    })),
    { name: "acpx-opencode-real-one", ageMs: 48 * HOUR },
  ]);
  try {
    const result = pruneOrphanHarnessConfigDirs({
      records: records([]),
      liveScan: measuredScan(),
      rootDir: root,
      dryRun: true,
    });
    assert.equal(
      result.scanned,
      1,
      `a fixture-shaped directory became a candidate: ${result.candidates.map((c) => c.dir).join(", ")}`,
    );
    assert.match(result.candidates[0]?.dir ?? "", /acpx-opencode-real-one$/);
    // Every fixture directory is still on disk.
    for (const segment of MEASURED_FIXTURE_SEGMENTS) {
      assert.equal(existsSync(join(root, `acpx-${segment}-AbCdEf`)), true, segment);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("0bac6a00 §10.1: the plugin cache is excluded EXPLICITLY — with or without its leading dot", () => {
  // ⚠️ THE DOT IS THE ACCIDENT THIS REPLACES. `.acpx-opencode-plugin-cache-<v>`
  // misses `acpx-<harness>-` only because of the dot; drop the dot in a rename and
  // the cache becomes "a session whose id is plugin-cache-1.18.28", unrecognised by
  // any record, removed once it ages past the orphan threshold — silently restoring
  // the 63 MB per session it exists to prevent.
  assert.equal(isOpenCodePluginCacheEntryUnderTest(".acpx-opencode-plugin-cache-1.18.28"), true);
  assert.equal(
    isOpenCodePluginCacheEntryUnderTest("acpx-opencode-plugin-cache-1.18.28"),
    true,
    "a cache renamed WITHOUT the dot is no longer protected",
  );
  assert.equal(isOpenCodePluginCacheEntryUnderTest("acpx-opencode-a-real-session"), false);
  assert.equal(isOpenCodePluginCacheEntryUnderTest("acpx-pi-a-real-session"), false);
});

test("0bac6a00 §10.1: a DOTLESS plugin cache survives a real sweep that would otherwise eat it", () => {
  // The behavioural half. Named without the dot AND aged past the threshold AND
  // claimed by no record — every condition for removal except the exclusion.
  const root = fixture([
    { name: "acpx-opencode-plugin-cache-1.18.28", ageMs: 48 * HOUR },
    { name: "acpx-opencode-victim", ageMs: 48 * HOUR },
  ]);
  try {
    const result = pruneOrphanHarnessConfigDirs({
      records: records([]),
      liveScan: measuredScan(),
      rootDir: root,
    });
    assert.equal(
      existsSync(join(root, "acpx-opencode-plugin-cache-1.18.28")),
      true,
      "the sweep ate the shared plugin cache",
    );
    // Control: the sweep WAS willing to remove in this run, so the survival above
    // is the exclusion working and not the sweep declining to act.
    assert.deepEqual(result.removed, [join(root, "acpx-opencode-victim")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Re-exported through the sweep module's own predicate, so the test binds to the
 *  thing the sweep actually consults rather than to a copy of its rule. */
function isOpenCodePluginCacheEntryUnderTest(entry: string): boolean {
  return isExcludedFromConfigDirSweep(entry);
}
