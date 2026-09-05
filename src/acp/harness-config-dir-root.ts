import { tmpdir } from "node:os";

/**
 * WHERE per-session harness config dirs live — resolved in ONE place, by the
 * writer ({@link import("./harness-config-dir.js").applyHarnessConfigDir}), by the
 * shared OpenCode plugin cache, and by the orphan sweep
 * ({@link import("./harness-config-dir.js").pruneOrphanHarnessConfigDirs}).
 *
 * ## ⚠️ WHY THIS IS ITS OWN MODULE
 *
 * The three consumers must agree about the root or the sweep looks somewhere the
 * writer never wrote — a sweep reporting a truthful, cheap, entirely clean census
 * over an empty directory while the real population sits elsewhere. `harness-config-dir.ts`
 * imports `opencode-plugin-cache.ts`, so the resolver cannot live in either without
 * a cycle. One module, imported by both, is what makes "they cannot disagree" a
 * property rather than a habit.
 *
 * ## ⚠️ THE DEFAULT STAYS THE REAL ROOT, DELIBERATELY (CONCEPTION §4)
 *
 * An explicit root is for callers who need SCOPING — the test suite, a rig, an
 * operator on a shared box. It is **not** a way to make the default harmless: if
 * the default moved, the safe invocation would become the one nobody uses, and the
 * directories that actually leak today (`/tmp/acpx-<harness>-<id>`) would be
 * orphaned from their own reaper.
 *
 * ## Precedence, stated rather than inferred
 *
 *   1. an **explicit argument** — `--config-dir-root <path>` on `sessions prune`,
 *      or `rootDir` on a direct call. Wins over everything, so a test that pins a
 *      fixture root is never overridden by an ambient variable.
 *   2. **`ACPX_HARNESS_CONFIG_DIR_ROOT`** in the environment. This is the only form
 *      that can scope a CHILD process nobody edited — which is what the test suite
 *      needs: every `runCli` helper spreads `process.env` into the spawned CLI, so
 *      one assignment in the temp-home fixture scopes every prune invocation the
 *      suite makes, including ones added later. A per-invocation flag cannot do
 *      that without a hand-maintained list of call sites, and a hand-maintained
 *      list survives its own violation.
 *   3. **`tmpdir()`** — the real root, honouring `TMPDIR` exactly as before.
 *
 * A blank or whitespace-only value is treated as ABSENT rather than as the empty
 * string: `ACPX_HARNESS_CONFIG_DIR_ROOT=` in an env file would otherwise resolve the
 * root to `""`, which `join()` turns into a RELATIVE path under the process cwd —
 * a sweep rooted wherever the CLI happened to be invoked from.
 */
export const HARNESS_CONFIG_DIR_ROOT_ENV = "ACPX_HARNESS_CONFIG_DIR_ROOT";

export function resolveHarnessConfigDirRoot(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromArgument = explicit?.trim();
  if (fromArgument !== undefined && fromArgument.length > 0) {
    return fromArgument;
  }
  const fromEnv = env[HARNESS_CONFIG_DIR_ROOT_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return tmpdir();
}
