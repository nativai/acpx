import { tmpdir } from "node:os";

/**
 * WHERE per-session harness config dirs live — resolved in ONE place, by the
 * WRITER ({@link import("./harness-config-dir.js").applyHarnessConfigDir}).
 *
 * ⚠️ THIS MODULE ALSO USED TO BE SHARED WITH AN ORPHAN-DIRECTORY SWEEP, REMOVED
 * 2026-09-30 (brick d1e12500) — see the anti-rebuild comment on `handlePrompt` in
 * `cli/command-handlers.ts`. It OOM-crashed the CLI in production twice by loading
 * every session's message history to build its candidate set, to reclaim a
 * population (Pi-only, ~36 MB worst case) that self-wipes on every pod restart
 * anyway. This module's job did not change: the writer still needs to know where
 * it is allowed to write, and the test suite still needs to scope that away from
 * the box's real `/tmp` — only the second CONSUMER of the root is gone.
 *
 * ## ⚠️ THE DEFAULT STAYS THE REAL ROOT, DELIBERATELY (CONCEPTION §4)
 *
 * An explicit root is for callers who need SCOPING — the test suite, a rig, an
 * operator on a shared box. It is **not** a way to make the default harmless: the
 * directories the writer actually creates live at `/tmp/acpx-<harness>-<id>`, and a
 * default pointed anywhere else would silently stop the writer from finding its
 * own box-level state (`ACPX_PI_BOX_AGENT_DIR` resolution and the like).
 *
 * ## Precedence, stated rather than inferred
 *
 *   1. an **explicit argument** — `rootDir` on a direct call to the writer. Wins
 *      over everything, so a test that pins a fixture root is never overridden by
 *      an ambient variable.
 *   2. **`ACPX_HARNESS_CONFIG_DIR_ROOT`** in the environment. This is the only form
 *      that can scope a CHILD process nobody edited — which is what the test suite
 *      needs: every `runCli` helper spreads `process.env` into the spawned CLI, so
 *      one assignment in the temp-home fixture scopes every child invocation the
 *      suite makes, including ones added later. A per-invocation flag cannot do
 *      that without a hand-maintained list of call sites, and a hand-maintained
 *      list survives its own violation.
 *   3. **`tmpdir()`** — the real root, honouring `TMPDIR` exactly as before.
 *
 * A blank or whitespace-only value is treated as ABSENT rather than as the empty
 * string: `ACPX_HARNESS_CONFIG_DIR_ROOT=` in an env file would otherwise resolve the
 * root to `""`, which `join()` turns into a RELATIVE path under the process cwd —
 * a config dir written wherever the CLI happened to be invoked from.
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
