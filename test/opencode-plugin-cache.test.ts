import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneOrphanHarnessConfigDirs } from "../src/acp/harness-config-dir.js";
import { seedOpenCodePluginInstall } from "../src/acp/opencode-plugin-cache.js";
import type { LiveProcessScan } from "../src/process-population.js";

// 9cd608d9 — ONE shared OpenCode plugin install, hardlinked into every session.
//
// ⚠️ MEASURED AGAINST THE REAL opencode-ai 1.18.28 BINARY, and the measurement
// overturned the brick's own proposed fix. At `session/new` OpenCode writes
// `<configDir>/package.json` declaring `@opencode-ai/plugin@<its version>` and
// installs it: 63 MB per session, 47 MB of it `effect`.
//
//   ✗ `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` does NOT stop it — still 63 MB.
//   ✗ a SYMLINK at `node_modules` into a shared cache is REPLACED by a real
//     directory and the cache stays empty — the dependency was unsatisfied, so
//     the installer correctly did its job.
//   ✓ a COMPLETE install seeded by HARDLINK satisfies it: verified by inode —
//     `effect/package.json` kept the same inode across a full `session/new`, so
//     nothing was reinstalled.
//
// Disk, measured: a cache plus THREE seeded dirs = 66 MB, where four independent
// copies = ~252 MB. The saving is that hardlinks share BLOCKS, which is why the
// implementation walks the tree with `linkSync` instead of using `cpSync`.

const VERSION = "1.18.28";

/** A complete-looking install, cheap enough to build in a test. */
function plantInstall(dir: string, version = VERSION): void {
  const pkg = join(dir, "node_modules", "@opencode-ai", "plugin");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@opencode-ai/plugin", version }),
  );
  mkdirSync(join(dir, "node_modules", "effect"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "effect", "package.json"), '{"name":"effect"}');
  writeFileSync(join(dir, "package.json"), '{"dependencies":{"@opencode-ai/plugin":"1.18.28"}}');
  writeFileSync(join(dir, "package-lock.json"), "{}");
}

function fixture(): { root: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), "hp-9cd608d9-"));
  const configDir = join(root, "acpx-opencode-ses-new", "opencode");
  mkdirSync(configDir, { recursive: true });
  return { root, configDir };
}

test("9cd608d9: a warm cache SEEDS a session, and the files are HARDLINKS", () => {
  const { root, configDir } = fixture();
  try {
    const cache = join(root, `.acpx-opencode-plugin-cache-${VERSION}`);
    mkdirSync(cache, { recursive: true });
    plantInstall(cache);
    const cachedInode = statSync(join(cache, "node_modules", "effect", "package.json")).ino;

    const result = seedOpenCodePluginInstall({ configDir, rootDir: root, version: VERSION });
    assert.equal(result.outcome, "seeded", `expected a seed, got ${result.outcome}`);

    // ⚠️ THE ASSERTION THAT MATTERS. A copy would satisfy "the file exists" and
    // cost the full 63 MB. Identical inodes are what prove blocks are shared.
    const seededInode = statSync(join(configDir, "node_modules", "effect", "package.json")).ino;
    assert.equal(seededInode, cachedInode, "the seeded tree was COPIED, not hardlinked");

    // And the manifest OpenCode checks is present, or it would reinstall anyway.
    assert.equal(existsSync(join(configDir, "package-lock.json")), true);
    assert.equal(
      existsSync(join(configDir, "node_modules", "@opencode-ai", "plugin", "package.json")),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9cd608d9: a cold cache WARMS from an existing session, then seeds", () => {
  const { root, configDir } = fixture();
  try {
    // Another session that already paid the install cost.
    const donor = join(root, "acpx-opencode-ses-old", "opencode");
    mkdirSync(donor, { recursive: true });
    plantInstall(donor);
    const donorInode = statSync(join(donor, "node_modules", "effect", "package.json")).ino;

    const result = seedOpenCodePluginInstall({ configDir, rootDir: root, version: VERSION });
    assert.equal(result.outcome, "warmed", `expected a warm, got ${result.outcome}`);
    assert.ok(result.scanned > 0, "population: no session dirs were examined");

    // The cache exists for the NEXT session, and everything shares blocks.
    assert.equal(
      existsSync(join(result.cacheDir, "node_modules")),
      true,
      "the cache was not filled",
    );
    assert.equal(
      statSync(join(configDir, "node_modules", "effect", "package.json")).ino,
      donorInode,
      "warming or seeding copied instead of linking",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9cd608d9: an INCOMPLETE install is never used as a source", () => {
  // ⚠️ A session may be mid-install RIGHT NOW. Hardlinking a half-written tree
  // into another session hands it a broken one that the installer, seeing a
  // populated directory, may not repair.
  const { root, configDir } = fixture();
  try {
    const donor = join(root, "acpx-opencode-ses-partial", "opencode");
    mkdirSync(join(donor, "node_modules", "effect"), { recursive: true });
    writeFileSync(join(donor, "package-lock.json"), "{}"); // lock present, plugin NOT

    const result = seedOpenCodePluginInstall({ configDir, rootDir: root, version: VERSION });
    assert.equal(result.outcome, "cache-miss", "a partial install was promoted into the cache");
    assert.equal(result.scanned, 1, "population: the partial donor was not examined");
    assert.equal(existsSync(join(configDir, "node_modules")), false, "a partial tree was seeded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9cd608d9: an install of the WRONG version is not used", () => {
  // The dependency is pinned to OpenCode's version, so a cache from another
  // version is not interchangeable — and reusing it would be invisible.
  const { root, configDir } = fixture();
  try {
    const donor = join(root, "acpx-opencode-ses-old", "opencode");
    mkdirSync(donor, { recursive: true });
    plantInstall(donor, "1.17.0");
    const result = seedOpenCodePluginInstall({ configDir, rootDir: root, version: VERSION });
    assert.equal(result.outcome, "cache-miss", "an install from another version was reused");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9cd608d9: an existing node_modules is left ALONE", () => {
  const { root, configDir } = fixture();
  try {
    mkdirSync(join(configDir, "node_modules", "mine"), { recursive: true });
    const result = seedOpenCodePluginInstall({ configDir, rootDir: root, version: VERSION });
    assert.equal(result.outcome, "skipped");
    assert.equal(
      existsSync(join(configDir, "node_modules", "mine")),
      true,
      "an install was clobbered",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9cd608d9: with nothing to seed from, it degrades to today's behaviour", () => {
  const { root, configDir } = fixture();
  try {
    const result = seedOpenCodePluginInstall({ configDir, rootDir: root, version: VERSION });
    assert.equal(result.outcome, "cache-miss");
    assert.equal(existsSync(join(configDir, "node_modules")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9cd608d9 ⚠️ INTERACTION: acpx's own orphan sweep must NOT eat the cache", () => {
  // ⚠️ THE TRAP THIS NAME AVOIDS. `pruneOrphanHarnessConfigDirs` treats anything
  // matching `acpx-<harness>-` as a session config dir. A cache called
  // `acpx-opencode-plugins-1.18.28` would be read as a session whose id is
  // `plugins-1.18.28`, recognised by no record, and deleted once it aged past the
  // orphan threshold — silently reintroducing the 63 MB per session it exists to
  // prevent. The leading dot puts it outside that prefix entirely.
  const root = mkdtempSync(join(tmpdir(), "hp-9cd608d9-prune-"));
  try {
    const cache = join(root, `.acpx-opencode-plugin-cache-${VERSION}`);
    mkdirSync(cache, { recursive: true });
    plantInstall(cache);
    // A real session dir beside it, so the sweep has something to legitimately do.
    mkdirSync(join(root, "acpx-opencode-dead-1"), { recursive: true });

    const scan: LiveProcessScan = {
      scanned: 40,
      environRead: 9,
      pids: new Set([1]),
      referencedDirs: new Set<string>(),
      referencedSessionIds: new Set<string>(),
    };
    const result = pruneOrphanHarnessConfigDirs({
      records: new Map([["dead-1", { closed: true }]]),
      liveScan: scan,
      rootDir: root,
      orphanMinAgeMs: 0,
    });

    assert.equal(result.scanned, 1, "the cache was treated as a session config dir");
    assert.equal(existsSync(cache), true, "acpx's own sweep deleted the shared plugin cache");
    // CONTROL: the sweep really did run and really can delete — otherwise the row
    // above passes on a sweep that does nothing at all.
    assert.equal(
      result.removed.length,
      1,
      "control: the sweep removed nothing, so it proves nothing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9cd608d9: the cache is keyed by VERSION, so two versions coexist", () => {
  const { root, configDir } = fixture();
  try {
    const a = seedOpenCodePluginInstall({ configDir, rootDir: root, version: "1.18.28" });
    const b = seedOpenCodePluginInstall({ configDir, rootDir: root, version: "1.19.0" });
    assert.notEqual(a.cacheDir, b.cacheDir, "two OpenCode versions would share one cache");
    assert.match(a.cacheDir, /1\.18\.28$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("9cd608d9: an unreadable root reports scanned=0 — NOT RUN, not clean", () => {
  const result = seedOpenCodePluginInstall({
    configDir: "/nonexistent-hp-b4-zzz9/opencode",
    rootDir: "/nonexistent-hp-b4-root-zzz9",
    version: VERSION,
  });
  assert.equal(result.scanned, 0);
  assert.equal(result.outcome, "cache-miss");
});

test("9cd608d9: the seeded manifest matches what OpenCode would have written", () => {
  // If the seeded `package.json` did not declare the same dependency, OpenCode
  // would rewrite it and reinstall — the seed would exist and buy nothing.
  const { root, configDir } = fixture();
  try {
    const cache = join(root, `.acpx-opencode-plugin-cache-${VERSION}`);
    mkdirSync(cache, { recursive: true });
    plantInstall(cache);
    seedOpenCodePluginInstall({ configDir, rootDir: root, version: VERSION });
    const manifest = JSON.parse(readFileSync(join(configDir, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.equal(manifest.dependencies["@opencode-ai/plugin"], VERSION);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
