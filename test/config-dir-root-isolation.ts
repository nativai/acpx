import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HARNESS_CONFIG_DIR_ROOT_ENV } from "../src/acp/harness-config-dir-root.js";

/**
 * KEEPING THE SUITE'S OWN CONFIG-DIR SWEEPS OFF THE BOX'S REAL `/tmp` (brick 0bac6a00).
 *
 * ## ⚠️ THE EXPOSURE THIS CLOSES, MEASURED RATHER THAN ASSERTED
 *
 * Every `acpx sessions prune` that is not `--dry-run` or `--help` ends by sweeping
 * per-session harness config dirs. Measured on this tree with a balanced-paren
 * scan of `test/` (positive-controlled against a planted fixture): **87 `runCli`
 * invocations carry `"prune"`, 10 are `--dry-run` and 2 are `--help`, so 75 reach
 * the sweep, 17 of them at `--whole-box`** — the broadest scope the verb has.
 * Until this module existed, all 75 resolved the root to the REAL SHARED `/tmp` of
 * whatever box the gate ran on: the sweep's `rootDir` was a function parameter the
 * CLI had no way to supply. **An isolated `HOME` does not scope it** — the root
 * comes from `tmpdir()`, not from the store.
 *
 * ## Why an ENV VAR and not a flag on each call site
 *
 * A per-invocation flag would need all 75 call sites edited and every future one
 * remembered — **a hand-maintained list, which systematically survives its own
 * violation**: the 76th prune added next month is scoped by nobody. Every `runCli`
 * helper in this suite spawns the CLI with `{ ...process.env, HOME: … }`, so ONE
 * assignment inside the temp-home fixture scopes every child it spawns, including
 * ones written later, by construction rather than by list.
 *
 * ## The two halves, and why both
 *
 *   - {@link beginIsolatedHarnessConfigDirRoot} — the SCOPING. Called by both
 *     temp-home fixtures, so anything spawned inside a temp home inherits it.
 *   - {@link assertHarnessConfigDirRootIsolated} — the GUARD. Called by the CLI-spawn
 *     helper of every file that invokes `prune`, so a prune added OUTSIDE a temp
 *     home fails loudly instead of quietly sweeping the box.
 *
 * The scoping alone would be silent when it stopped applying, which is the failure
 * mode this whole brick is about.
 */
const ISOLATED_ROOT_DIRNAME = "harness-config-dir-root";

/**
 * Point the harness config-dir root at a fresh directory inside `tempHome` and
 * return the restore. The directory is created eagerly: the sweep reports
 * `notMeasured` for a root it cannot `readdir`, and a fixture that produced a
 * permanent non-measurement would make every sweep assertion vacuous.
 */
export function beginIsolatedHarnessConfigDirRoot(tempHome: string): () => void {
  const previous = process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
  const root = path.join(tempHome, ISOLATED_ROOT_DIRNAME);
  mkdirSync(root, { recursive: true });
  process.env[HARNESS_CONFIG_DIR_ROOT_ENV] = root;
  return () => {
    if (previous === undefined) {
      delete process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
    } else {
      process.env[HARNESS_CONFIG_DIR_ROOT_ENV] = previous;
    }
  };
}

/** The isolated root currently in force, for a test that wants to inspect or seed it. */
export function isolatedHarnessConfigDirRoot(): string {
  const root = process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
  if (root === undefined || root.trim().length === 0) {
    throw new Error(
      `${HARNESS_CONFIG_DIR_ROOT_ENV} is not set — call this inside a withTempHome block`,
    );
  }
  return root;
}

/**
 * Refuse to spawn a `prune` that would sweep an unscoped root.
 *
 * ⚠️ THIS IS A BEHAVIOURAL GUARD, NOT A CONVENTION CHECK. It runs on the argv
 * about to be handed to `spawn`, so it cannot be satisfied by a comment, a naming
 * scheme or a file being present in someone's list. `--help` is exempt because it
 * never reaches the sweep; `--dry-run` is NOT exempt, because a dry run still
 * READS the root (and, after brick 0bac6a00's §5, classifies everything in it).
 */
export function assertHarnessConfigDirRootIsolated(args: readonly string[]): void {
  if (!args.includes("prune") || args.includes("--help")) {
    return;
  }
  // An explicit --config-dir-root on the invocation is the scoping, and it beats
  // the environment in the resolver — so honour the same precedence here rather
  // than demanding both.
  const explicitAt = args.indexOf("--config-dir-root");
  const explicit = explicitAt === -1 ? undefined : args[explicitAt + 1];
  const root = explicit ?? process.env[HARNESS_CONFIG_DIR_ROOT_ENV];
  if (root === undefined || root.trim().length === 0) {
    throw new Error(
      `test invoked 'sessions prune' with no scoped config-dir root: the sweep would run against ` +
        `the box's real ${os.tmpdir()}. Run it inside withTempHome (which sets ` +
        `${HARNESS_CONFIG_DIR_ROOT_ENV}) or pass --config-dir-root.`,
    );
  }
  const resolved = path.resolve(root);
  const realTmp = path.resolve(os.tmpdir());
  if (resolved === realTmp || !resolved.startsWith(`${realTmp}${path.sep}`)) {
    throw new Error(
      `test invoked 'sessions prune' with a config-dir root that is not an isolated temp path: ` +
        `${resolved}. It must live UNDER ${realTmp}, never be ${realTmp} itself.`,
    );
  }
}
