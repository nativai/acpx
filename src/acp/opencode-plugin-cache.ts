import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { ACP_ADAPTER_PACKAGE_RANGES } from "../agent-registry.js";
import { resolveHarnessConfigDirRoot } from "./harness-config-dir-root.js";

/**
 * ONE shared OpenCode plugin install, HARDLINKED into every session's config dir
 * (brick 9cd608d9).
 *
 * ## What was measured, and it is not what the brick assumed
 *
 * At `session/new` — not at spawn, and not at `initialize` — OpenCode writes
 * `<configDir>/package.json` declaring `@opencode-ai/plugin@<its own version>`
 * and installs it. **63 MB per session**, 47 MB of which is `effect`. B3 made
 * that per-session by splitting the config dirs.
 *
 * ⚠️ **BOTH APPROACHES THE BRICK PROPOSED WERE MEASURED AND BOTH FAIL** against
 * opencode-ai 1.18.28:
 *
 *   - `OPENCODE_DISABLE_DEFAULT_PLUGINS=1` does **not** stop it — still 63 MB.
 *   - a **symlink** at `<configDir>/node_modules` pointing into a shared cache is
 *     **replaced by a real directory**, and the cache stays empty. Of course it
 *     is: the dependency was unsatisfied, so the installer did its job.
 *
 * ## What DOES work, and why
 *
 * The dependency is **pinned to the OpenCode version**, so one warmed install is
 * valid for every session of that version. Seeding a session's dir with a
 * COMPLETE install by **hardlink** (`cp -al`) satisfies the installer, which then
 * no-ops — verified by inode: `effect/package.json` kept the same inode across a
 * full `session/new`, so nothing was reinstalled.
 *
 * Hardlinks cost inodes, not blocks. Measured: a cache plus THREE seeded session
 * dirs occupy **66 MB total**, where four independent copies would be ~252 MB.
 * Per-session cost falls from 63 MB to directory entries.
 *
 * ⚠️ **THE CACHE DIRECTORY IS NAMED SO acpx's OWN ORPHAN SWEEP IGNORES IT.**
 * `pruneOrphanHarnessConfigDirs` treats anything matching `acpx-<harness>-` as a
 * session config dir, so a cache called `acpx-opencode-plugins-1.18.28` would be
 * read as a session whose id is `plugins-1.18.28` — recognised by no record, and
 * therefore deleted once it aged past the orphan threshold. The leading dot puts
 * it outside that prefix entirely.
 */
const CACHE_PREFIX = ".acpx-opencode-plugin-cache-";

/** The package OpenCode installs into its own config dir. */
const PLUGIN_PACKAGE = "@opencode-ai/plugin";

/** What seeding did, so a caller can log it and 0 never reads as success. */
export interface PluginCacheResult {
  /** `seeded` — the session got a hardlinked install and OpenCode will no-op.
   *  `warmed` — the cache was empty and was filled from an existing install,
   *  then this session was seeded from it.
   *  `cache-miss` — nothing to seed from; this session installs normally and a
   *  later spawn will warm the cache from it.
   *  `skipped` — the config dir already has an install, so there is nothing to do. */
  outcome: "seeded" | "warmed" | "cache-miss" | "skipped";
  /** The cache directory considered, for evidence. */
  cacheDir: string;
  /** Session dirs examined when looking for an install to warm from. **0 means
   *  NOT MEASURED** — the root was unreadable — not "no candidates exist". */
  scanned: number;
}

/**
 * Seed `configDir` with the shared plugin install, warming the cache first if it
 * is empty and some other session already has a complete one.
 *
 * Best-effort throughout: every failure leaves OpenCode to install for itself,
 * which is exactly today's behaviour. Nothing here may break a spawn.
 */
export function seedOpenCodePluginInstall(params: {
  /** `<sessionDir>/opencode` — where OpenCode writes package.json. */
  configDir: string;
  /** Overrides the resolved root (`ACPX_HARNESS_CONFIG_DIR_ROOT`, else `tmpdir()`);
   *  tests keep the cache inside a fixture. */
  rootDir?: string;
  /** Overrides the pinned version, for tests. */
  version?: string;
}): PluginCacheResult {
  const { root, version, cacheDir } = resolveCacheTarget(params);

  if (existsSync(join(params.configDir, "node_modules"))) {
    return { outcome: "skipped", cacheDir, scanned: 0 };
  }

  if (isCompleteInstall(cacheDir, version)) {
    const outcome = hardlinkInstall(cacheDir, params.configDir) ? "seeded" : "cache-miss";
    return { outcome, cacheDir, scanned: 0 };
  }

  const found = findWarmInstall(root, version, params.configDir);
  const warmed = found.dir !== undefined && warmCache(found.dir, cacheDir);
  const outcome = warmed && hardlinkInstall(cacheDir, params.configDir) ? "warmed" : "cache-miss";
  return { outcome, cacheDir, scanned: found.scanned };
}

/** Defaults in one place, so the function above reads as the RULE. */
function resolveCacheTarget(params: { rootDir?: string; version?: string }): {
  root: string;
  version: string;
  cacheDir: string;
} {
  // The SAME resolver the config-dir writer and the orphan sweep use
  // (`harness-config-dir-root.ts`), so the cache always lands in the root the
  // sweep walks — never beside it in a directory nothing reaps.
  const root = resolveHarnessConfigDirRoot(params.rootDir);
  const version = params.version ?? ACP_ADAPTER_PACKAGE_RANGES.opencode;
  return { root, version, cacheDir: join(root, `${CACHE_PREFIX}${version}`) };
}

/**
 * Is `entry` (a bare directory name, as `readdirSync` yields it) the shared
 * plugin cache?
 *
 * ## ⚠️ WHY THE SWEEP ASKS THIS EXPLICITLY INSTEAD OF RELYING ON THE PREFIX
 *
 * `.acpx-opencode-plugin-cache-<version>` misses the sweep's `acpx-<harness>-`
 * candidate filter **only because of its leading dot**. That is a naming
 * convention, and a naming convention is exactly the kind of guard the next
 * tidy-up removes — renaming the cache, broadening the candidate glob, or moving
 * the config dirs under a dedicated root (CONCEPTION §8.1) each restore the 63
 * MB-per-session cost this cache exists to prevent, silently and with nothing
 * failing to announce it.
 *
 * ⚠️ **DO NOT DELETE THIS AND LEAN ON THE DOT.** The dot is a second, independent
 * reason the cache is safe today; this predicate is the one that survives a
 * rename or a root move. The two are redundant on purpose — see the sweep's
 * candidate filter, and `test/opencode-plugin-cache.test.ts`, which fire-tests
 * this predicate against a cache name that has NO leading dot.
 */
export function isOpenCodePluginCacheEntry(entry: string): boolean {
  return entry.startsWith(CACHE_PREFIX) || entry.startsWith(CACHE_PREFIX.slice(1));
}

/**
 * ⚠️ COMPLETENESS IS CHECKED, NOT ASSUMED. A directory can hold a half-written
 * `node_modules` from a session that is mid-install right now, and hardlinking
 * that into another session would hand it a broken tree that the installer,
 * seeing a populated directory, may not repair. The lock file plus the plugin's
 * own manifest at the EXPECTED VERSION is the criterion.
 */
function isCompleteInstall(dir: string, version: string): boolean {
  const manifest = join(dir, "node_modules", PLUGIN_PACKAGE, "package.json");
  if (!existsSync(join(dir, "package-lock.json")) || !existsSync(manifest)) {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return parsed.version === version;
  } catch {
    return false;
  }
}

/**
 * Any OTHER session config dir that already holds a complete install.
 *
 * ⚠️ THE SESSION BEING SEEDED IS EXCLUDED. Warming the cache from the very
 * directory about to be seeded is circular, and on the path where it matters —
 * a session whose own install is half-written — it would promote exactly the
 * partial tree `isCompleteInstall` exists to reject.
 */
function findWarmInstall(
  root: string,
  version: string,
  excludeConfigDir: string,
): { dir?: string; scanned: number } {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return { scanned: 0 }; // NOT MEASURED — not "nothing there"
  }
  let scanned = 0;
  for (const entry of entries) {
    if (!entry.startsWith("acpx-opencode-")) {
      continue;
    }
    const candidate = join(root, entry, "opencode");
    if (candidate === excludeConfigDir) {
      continue;
    }
    scanned += 1;
    if (isCompleteInstall(candidate, version)) {
      return { dir: candidate, scanned };
    }
  }
  return { scanned };
}

/**
 * Fill the cache from a session's install. Built in a TEMP directory and renamed
 * into place, so a concurrent spawn can never observe a half-written cache — the
 * same partial-tree hazard `isCompleteInstall` guards against, one level up.
 */
function warmCache(from: string, cacheDir: string): boolean {
  const staging = `${cacheDir}.${process.pid}.partial`;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    // ⚠️ HARDLINK, NOT COPY. Warming the cache from an existing install must
    // cost inodes rather than another 63 MB — a cache built by copying would
    // double the very problem it exists to solve.
    linkTree(join(from, "node_modules"), join(staging, "node_modules"));
    for (const file of ["package.json", "package-lock.json"]) {
      if (existsSync(join(from, file))) {
        cpSync(join(from, file), join(staging, file), { force: true });
      }
    }
    renameSync(staging, cacheDir);
    return true;
  } catch {
    rmSync(staging, { recursive: true, force: true });
    return false;
  }
}

/** Hardlink the cached install into one session's config dir. */
function hardlinkInstall(cacheDir: string, configDir: string): boolean {
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    linkTree(join(cacheDir, "node_modules"), join(configDir, "node_modules"));
    for (const file of ["package.json", "package-lock.json"]) {
      const source = join(cacheDir, file);
      if (existsSync(source)) {
        cpSync(source, join(configDir, file), { force: true });
      }
    }
    return true;
  } catch {
    // Leave the directory as OpenCode expects to find it: no half-seeded tree,
    // because a populated-but-incomplete node_modules is worse than an absent one.
    rmSync(join(configDir, "node_modules"), { recursive: true, force: true });
    return false;
  }
}

/**
 * Recursively HARDLINK a tree — the `cp -al` equivalent.
 *
 * ⚠️ WRITTEN OUT RATHER THAN DELEGATED TO `cpSync`, WHICH HAS NO HARDLINK MODE.
 * `cpSync` would copy, silently, and copying is precisely the 63 MB this exists
 * to avoid: the saving is not "fewer files", it is that hardlinks share BLOCKS.
 * Measured: a cache plus three linked session dirs occupy 66 MB where four
 * independent copies occupy ~252 MB.
 *
 * Falls back to a real copy per file on `EXDEV` — a hardlink cannot cross a
 * filesystem boundary, and a correct-but-larger tree beats a failed spawn.
 */
function linkTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory()) {
      linkTree(source, destination);
      continue;
    }
    if (entry.isSymbolicLink()) {
      // Preserved as a symlink; following it could pull a tree in twice.
      cpSync(source, destination, { verbatimSymlinks: true, force: true });
      continue;
    }
    try {
      linkSync(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
        throw error;
      }
      cpSync(source, destination, { force: true });
    }
  }
}
