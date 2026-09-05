import { statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE INTERVAL GATE THAT MAKES A PER-PROMPT SWEEP AFFORDABLE (CONCEPTION §3,
 * ruled A + C(first-prompt), form 2).
 *
 * ## ⚠️ FORM 2, AND THE DIFFERENCE FROM FORM 1 IS THE WHOLE REASON THIS EXISTS
 *
 * Two ways to keep a triggered sweep cheap were on the table:
 *
 *   **Form 1** — sweep only when the candidate count exceeds a threshold. To learn
 *   the count it must `readdir` the root, which is **81% of the census's own
 *   cost** (116.74 ms listing vs 2.76 ms for the `/proc` scan, measured by
 *   hp-g4-te). A gate that pays the expensive part of the thing it is gating is
 *   not a gate.
 *
 *   **Form 2** — sweep at most once per interval, decided from a TIMESTAMP. No
 *   listing, no `/proc`. That is this.
 *
 * ## ⚠️ WHY THE TIMESTAMP IS ON DISK AND NOT A MODULE VARIABLE
 *
 * The obvious implementation is `let lastSweepAt` in module scope — "at most once
 * per interval per process". **On the trigger that was actually ruled, that gates
 * nothing.** `acpx prompt` is a FRESH CLI PROCESS every time, so a per-process
 * variable starts unset on every single prompt and the full census runs on every
 * single prompt — form 2 collapsing into "no gate at all", silently, while reading
 * in source exactly like a working one. A stamp file survives the process, so the
 * bound is real for short-lived and long-lived callers alike.
 *
 * ## The claim is written BEFORE the sweep runs, deliberately
 *
 * Two prompts landing in the same second would otherwise both see a stale stamp
 * and both sweep. Claiming first means the loser skips. The cost of the race going
 * the other way — a sweep skipped because a concurrent one claimed it — is one
 * interval of staleness, which is what the interval already permits.
 *
 * ⚠️ THE STAMP IS NOT A LOCK, and must not be read as one. It bounds FREQUENCY,
 * not concurrency: two processes can still overlap if they claim either side of
 * the interval boundary. That is safe here because the sweep itself removes only
 * on positive ownership and `rmSync(..., { force: true })` tolerates a directory a
 * concurrent sweep already took.
 */

/**
 * Six hours. Deliberately the same order as `DEFAULT_ORPHAN_MIN_AGE_MS`: a
 * directory cannot become removable faster than it can age past the orphan
 * threshold, so sweeping much more often than that spends the census to discover
 * nothing new. Stated, not tuned.
 */
export const DEFAULT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * ⚠️ A DOT-PREFIXED FILE, AND IT IS A FILE, NOT A DIRECTORY. Two independent
 * reasons the sweep can never treat its own stamp as a candidate — the name misses
 * the `acpx-<harness>-` prefix, and §10.1's lesson says not to rely on a naming
 * accident alone.
 */
const STAMP_NAME = ".acpx-config-dir-sweep-stamp";

/**
 * Claim the right to sweep `root` now, or decline because one ran recently.
 *
 * @returns `true` when the caller should sweep (and the claim has been recorded),
 *          `false` when the interval has not elapsed.
 */
export function claimHarnessConfigDirSweep(params: {
  root: string;
  now?: number;
  intervalMs?: number;
}): boolean {
  const now = params.now ?? Date.now();
  const intervalMs = params.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const stamp = join(params.root, STAMP_NAME);
  const lastRunAt = readStampMs(stamp);
  if (lastRunAt !== undefined && now - lastRunAt < intervalMs) {
    return false;
  }
  return writeStamp(stamp, now);
}

/** The stamp's mtime, or undefined when there is no readable stamp — which means
 *  "never swept here", not "swept at time zero". */
function readStampMs(stamp: string): number | undefined {
  try {
    return statSync(stamp).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Record the claim. **A failure to write means DECLINE, not proceed.** If the
 * stamp cannot be written, nothing bounds the next caller either — so a sweep that
 * went ahead anyway would run on every prompt forever, which is precisely the
 * unbounded cost this gate exists to prevent. Skipping is recoverable; an
 * ungated census on every turn is not.
 */
function writeStamp(stamp: string, now: number): boolean {
  try {
    writeFileSync(stamp, "", { mode: 0o600 });
    // `writeFileSync` sets mtime to the real clock; the injected `now` is what the
    // caller's interval arithmetic uses, so pin the two together or a test with a
    // synthetic clock measures the wall clock instead of its own fixture.
    const seconds = now / 1000;
    utimesSync(stamp, seconds, seconds);
    return true;
  } catch {
    return false;
  }
}
