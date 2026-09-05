import { type LiveProcessScan, scanLiveProcesses } from "../process-population.js";
import {
  describeHarnessConfigDirSweep,
  describeHarnessConfigDirSweepPlan,
  type HarnessConfigDirPruneResult,
  type KnownSessionRecord,
  pruneOrphanHarnessConfigDirs,
} from "./harness-config-dir.js";

/**
 * WHEN THE ORPHAN CONFIG-DIR SWEEP RUNS (CONCEPTION §3; ruled A + C(first-prompt),
 * form 2).
 *
 * ## Why a trigger module exists at all
 *
 * `AcpClient.close()` releases the directory it wrote, and it is **measured absent
 * on three paths** — create+close, turn+close, and resume+turn+close (the last with
 * `reachedOwner: true` and `turnSettled: true`). An owner death, a pod eviction or a
 * `kill -9` skips it by construction: there is no process left to run it. So
 * remove-on-close is the fast path and the sweep is the guarantee — and a guarantee
 * that only runs when someone types `sessions prune` is not one.
 *
 * Worse, until this brick the ONLY thing that invoked the sweep was `sessions prune`,
 * which destroys each session's record **and its messages sidecar**. Reclaiming a
 * leaked directory was therefore coupled to transcript destruction, which is why no
 * agent was permitted to run it. A trigger has to be able to sweep WITHOUT that.
 *
 * ## ⚠️ THE TRIGGER IS NOT `close`, AND THE CORRECTION TO `create` IS MEASURED
 *
 * `create` was the intuitive trigger and it is the wrong one: **a create-only
 * session materialises no config dir** — 3 create+close pairs added 0 candidates,
 * 0 sightings against 110 measured both ways. The directory appears during a
 * **PROMPT**. A create-triggered sweep therefore fires before the thing it sweeps
 * exists, and on a create-then-idle box it finds nothing, forever, while reporting a
 * clean census.
 *
 * ## ⚠️ FORM 2, NOT FORM 1 — AND THE DIFFERENCE IS THE WHOLE COST
 *
 * Two ways to gate "at most occasionally":
 *
 *   - **form 1** — decide from the CANDIDATE COUNT ("sweep when there are more than
 *     N"). To know the count it must `readdir` the root, **which is 81% of the
 *     census's own cost** (116.74 ms listing against 2.76 ms for the `/proc` leg,
 *     and the listing scales with total `/tmp` size — ~390× across two boxes on one
 *     build). A gate that pays the expensive part in order to decide whether to pay
 *     the expensive part is not a gate.
 *   - **form 2** — decide from a TIMESTAMP. One `Date.now()` and one comparison:
 *     ~0.0004 ms, no syscall, no directory read.
 *
 * ⇒ Every prompt pays form 2's compare. The full census runs **at most once per
 * interval per process**. That is what makes "gated" mean anything here.
 */

/**
 * How long a process waits before it will sweep again.
 *
 * ⚠️ STATED, NOT INFERRED, and deliberately well under the six-hour orphan
 * threshold: a directory only becomes removable once it is older than that, so an
 * interval shorter than it means no orphan waits materially longer than the age gate
 * already makes it wait. Longer than an hour and a long-running owner could sit on a
 * grown backlog for most of a working day; shorter and the census cost recurs for no
 * new candidates.
 */
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * ⚠️ PER PROCESS, DELIBERATELY, AND THE CONSEQUENCE IS STATED RATHER THAN HIDDEN.
 * Module state is not shared between the CLI invocations and queue owners on a box,
 * so N processes may each sweep once per interval. That is accepted: the sweep is
 * idempotent, retains anything it cannot positively attribute, and a shared
 * cross-process timestamp would be a lock file — another piece of state to keep
 * honest, for a saving of a few directory listings. The census names its root and
 * its `entriesRead`, so a reader can see how often it actually ran.
 */
let lastSweepAt: number | undefined;

/** Test seam: module state must not leak between tests. */
export function resetConfigDirSweepSchedule(): void {
  lastSweepAt = undefined;
}

export interface ConfigDirSweepTriggerOptions {
  /** The invoking HOME's records, id → state. Read lazily: a gated-out trigger
   *  must not pay for a store read either. */
  loadRecords: () => Promise<ReadonlyMap<string, KnownSessionRecord>>;
  /** Overrides the resolved root. Undefined keeps the real one. */
  rootDir?: string;
  /** Classify and print, remove nothing. */
  dryRun?: boolean;
  /** Injectable clock, so the interval is testable without waiting an hour. */
  now?: number;
  intervalMs?: number;
  /** Injectable so a test need not depend on the box's real `/proc`. */
  scan?: () => LiveProcessScan;
  /** Where the census goes. Defaults to stderr, like the prune path's. */
  write?: (line: string) => void;
}

/**
 * Trigger C, and the interval gate for trigger A.
 *
 * Returns the sweep result when it ran, `undefined` when the interval gated it out —
 * so a caller can tell "swept and found nothing" from "did not sweep", which is the
 * same distinction `scanned=0 means NOT RUN` exists to preserve one level down.
 *
 * ⚠️ NEVER THROWS. It is called from the prompt path, and a tidy-up that can fail a
 * user's turn is a worse defect than the leak it cleans up.
 */
export async function maybeSweepHarnessConfigDirs(
  options: ConfigDirSweepTriggerOptions,
): Promise<HarnessConfigDirPruneResult | undefined> {
  const now = options.now ?? Date.now();
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  // ⚠️ THE ENTIRE GATE, AND IT TOUCHES NO DIRECTORY. Everything below this line is
  // the expensive part; everything above it is one comparison.
  if (lastSweepAt !== undefined && now - lastSweepAt < intervalMs) {
    return undefined;
  }
  // Stamp BEFORE the work, not after: two prompts arriving while a sweep is in
  // flight would otherwise both pass the gate and both walk the root.
  lastSweepAt = now;
  return await sweepHarnessConfigDirsNow(options);
}

/**
 * Trigger A — the ungated sweep, for a caller that has its own "once" (a process
 * start). It still stamps the interval clock, so a start followed immediately by a
 * first prompt does not sweep twice.
 *
 * ⚠️ NEVER THROWS, for the same reason as above: at server start, a tidy-up that
 * can abort the boot is not a tidy-up.
 */
export async function sweepHarnessConfigDirsNow(
  options: ConfigDirSweepTriggerOptions,
): Promise<HarnessConfigDirPruneResult | undefined> {
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  try {
    lastSweepAt = options.now ?? Date.now();
    const result = pruneOrphanHarnessConfigDirs({
      records: await options.loadRecords(),
      liveScan: (options.scan ?? scanLiveProcesses)(),
      rootDir: options.rootDir,
      dryRun: options.dryRun,
      now: options.now,
    });
    // §7 — printed, always. A sweep that removes things silently is the shape of
    // every incident in this thread.
    write(describeHarnessConfigDirSweep(result));
    if (options.dryRun === true) {
      write(describeHarnessConfigDirSweepPlan(result));
    }
    return result;
  } catch (error) {
    write(
      `[acpx] harness config dir sweep skipped: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return undefined;
  }
}
