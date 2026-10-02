// brick 3d213c33 — the suite printed `# fail 0` beside 9 `not ok` rows.
//
// THE MECHANISM, confirmed by direct reproduction against the pinned node
// (v22.23.2), not inferred from the TAP spec: when a test's returned/awaited
// promise is still pending once `node --test` decides the run (or the file)
// is done, the runner classifies it `failureType: 'cancelledByParent'`,
// prints a `not ok` row for it (and can cascade the same classification onto
// later sibling tests in the same file), and tallies it under the summary's
// `# cancelled` counter — NOT `# fail`. `# tests` DOES count it. So
// `# fail 0` is not evidence of a clean run on its own; `# cancelled` must be
// read too, and a careless paste of the summary (dropping `# suites` and
// `# cancelled`, as the first report of this very incident did) reproduces
// the exact misreading at the human/agent layer.
//
// This is NOT a cross-file aggregation bug and NOT a subtest-propagation
// bug — `scripts/run-tests.mjs` passes the child's TAP stream straight through
// (`stdio: "inherit"`, untouched by this module) and the arithmetic reconciles
// exactly: pass + fail + cancelled + skipped + todo == tests, every time.
// Nothing is dropped; one real-failure bucket is simply not named "fail".
//
// 🛑 DELIBERATELY NOT WIRED INTO `scripts/run-tests.mjs`. That script is the
// hot path every lane and every gate on this programme runs through; turning
// its `stdio: "inherit"` passthrough into piped-and-re-emitted changes the I/O
// behaviour of a shared path lanes are gated through live, for a check whose
// own value is a backstop (in both known incidents the child's own exit code
// was ALREADY correct — only the printed text misled). Ship this as a
// standalone, after-the-fact checker over a SAVED LOG instead (the CLI entry
// point below) — zero blast radius on the running suite, and usable
// retroactively against any gate log already on disk, including the 850KB
// evidence log that first reported this brick.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const COUNTER_NAMES = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];

/**
 * @typedef {{
 *   tests?: number,
 *   suites?: number,
 *   pass?: number,
 *   fail?: number,
 *   cancelled?: number,
 *   skipped?: number,
 *   todo?: number,
 * }} SuiteCounters
 */

/**
 * Parses the LAST occurrence of each `# <name> <N>` summary line in a block
 * of `node --test` TAP output. A multi-file run prints exactly one grand
 * total block at the very end (verified against the brick's own evidence
 * log); taking the last occurrence is what makes this safe even if that
 * assumption ever changes and an intermediate block appears.
 *
 * Returns an object with only the counters actually found — a counter that
 * never appeared is OMITTED, never defaulted to 0, so a caller can tell
 * "absent from this output" apart from "present and zero".
 *
 * @param {string} tapText
 * @returns {SuiteCounters}
 */
export function parseSuiteSummary(tapText) {
  /** @type {SuiteCounters} */
  const counters = {};
  for (const name of COUNTER_NAMES) {
    const re = new RegExp(`^# ${name} (\\d+)$`, "gm");
    let match;
    let last;
    while ((match = re.exec(tapText)) !== null) {
      last = Number(match[1]);
    }
    if (last !== undefined) {
      counters[name] = last;
    }
  }
  return counters;
}

/**
 * Evaluates whether a `node --test` run was genuinely clean, reading the
 * summary's OWN counters only (never cross-referencing a grepped row count —
 * `# pass` counts nested subtests while top-level `ok` rows are fewer, so
 * that comparison differs normally and is not this defect; brick 3d213c33's
 * own journal warns against it explicitly).
 *
 * Two independent checks, either one sufficient to fail the run:
 *   1. Sum-of-parts: pass + fail + cancelled + skipped + todo must equal
 *      tests. This is the belt-and-braces catch-all for a count genuinely
 *      vanishing (unconfirmed whether that can happen — the brick says so
 *      explicitly — but this check costs nothing and would catch it).
 *   2. fail + cancelled must be 0. This is the check that actually fires on
 *      THIS incident's real data: fail was 0 but cancelled was 9.
 *
 * @param {string} tapText
 * @returns {{ok: true, counters: SuiteCounters} | {ok: false, reason: string, counters: SuiteCounters}}
 */
export function checkSuiteSummaryHealth(tapText) {
  const counters = parseSuiteSummary(tapText);
  if (counters.tests === undefined) {
    return {
      ok: false,
      reason: "no '# tests' summary line found in the output — the run may not have completed",
      counters,
    };
  }

  const pass = counters.pass ?? 0;
  const fail = counters.fail ?? 0;
  const cancelled = counters.cancelled ?? 0;
  const skipped = counters.skipped ?? 0;
  const todo = counters.todo ?? 0;

  const sumOfParts = pass + fail + cancelled + skipped + todo;
  if (sumOfParts !== counters.tests) {
    return {
      ok: false,
      reason:
        `the summary's own parts (pass ${pass} + fail ${fail} + cancelled ${cancelled} + ` +
        `skipped ${skipped} + todo ${todo} = ${sumOfParts}) do not add up to tests ` +
        `(${counters.tests})`,
      counters,
    };
  }

  const realFailures = fail + cancelled;
  if (realFailures > 0) {
    return {
      ok: false,
      reason:
        `${realFailures} test(s) did not pass (fail=${fail}, cancelled=${cancelled}) — ` +
        `'# fail 0' alone is not evidence of a clean run when 'cancelled' is nonzero ` +
        `(brick 3d213c33: a leaked/cancelled test is tallied under 'cancelled', not ` +
        `'fail', while still printing its own 'not ok' row)`,
      counters,
    };
  }

  return { ok: true, counters };
}

// ─── CLI entry — a standalone, after-the-fact check over a SAVED LOG ───────
//
// Usage:
//   node scripts/suite-summary-invariant.mjs <path-to-tap-log>
//   node scripts/suite-summary-invariant.mjs -           (reads stdin)
//   some-gate-command | node scripts/suite-summary-invariant.mjs -
//
// Prints the verdict and exits non-zero on an unhealthy summary. Never
// touches a running suite — point it at a log file after the fact.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2];
  const text =
    target === undefined || target === "-" ? readFileSync(0, "utf8") : readFileSync(target, "utf8");

  const health = checkSuiteSummaryHealth(text);
  if (health.ok) {
    console.log(`HEALTHY — ${JSON.stringify(health.counters)}`);
    process.exit(0);
  } else {
    console.error(`🛑 UNHEALTHY (brick 3d213c33) — ${health.reason}`);
    console.error(`   counters: ${JSON.stringify(health.counters)}`);
    process.exit(1);
  }
}
