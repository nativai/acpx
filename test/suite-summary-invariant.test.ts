import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkSuiteSummaryHealth, parseSuiteSummary } from "../scripts/suite-summary-invariant.mjs";

/**
 * brick 3d213c33 — "the acpx test suite prints `# fail 0` beside 9 `not ok` rows".
 *
 * 🔑 THE MECHANISM (established by direct reproduction against the pinned node
 * v22.23.2, not inferred from docs): a test whose returned/awaited promise is
 * still pending when `node --test` concludes the run is classified
 * `failureType: 'cancelledByParent'`. It gets its own `not ok` TAP row (and can
 * cascade the same classification onto later siblings in the same file), and
 * is tallied under the summary's `# cancelled` counter — never `# fail`.
 * `# tests` DOES count it. Nothing is lost; one real-failure bucket is simply
 * not named "fail", so a reader who only checks `# fail` sees green.
 *
 * `scripts/suite-summary-invariant.mjs` is a PLAIN .mjs module with its own
 * CLI entry point (`node scripts/suite-summary-invariant.mjs <log-path>`) —
 * a standalone, after-the-fact checker over a SAVED LOG. It is deliberately
 * NOT wired into `scripts/run-tests.mjs`: that script is the hot path every
 * lane and gate on this programme runs through live, and turning its
 * `stdio: "inherit"` passthrough into piped-and-re-emitted would change the
 * I/O behaviour of a shared path for a check whose own value is a backstop
 * (in both known incidents the child's own exit code was already correct —
 * only the printed text misled). This test file exercises the module
 * in-process via a normal relative import, same as any other test helper.
 */

// Resolved into the SOURCE tree, not beside the compiled file: `build:test`
// compiles `.ts` and does NOT copy `.mjs` fixtures into `dist-test/`. From
// `dist-test/test/` two levels up is the repo root (same pattern as
// `outbox-write-ordering.test.ts`'s `HOLDER_PATH`).
const FIXTURE_PATH = fileURLToPath(
  new URL("../../test/fixtures/suite-summary-cancelled-promise.mjs", import.meta.url),
);

type RunResult = { stdout: string; code: number | null };

async function runNodeTest(filePath: string): Promise<RunResult> {
  // 🛑 `NODE_TEST_CONTEXT` is set by the OUTER `node --test` run (this very
  // suite) and inherited by any spawned child by default. A nested
  // `node --test` that sees it already set suppresses its own TAP stdout
  // entirely — `stdout` arrives empty, with no error of any kind, which reads
  // as "the fixture printed nothing" rather than "the child silently switched
  // modes". Measured directly: identical spawn, env with vs without the key
  // stripped, 0 bytes vs 1136 bytes of stdout. Strip it so the nested run
  // reports exactly as it does when run standalone.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", filePath], {
      stdio: ["ignore", "pipe", "ignore"],
      env,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ stdout, code }));
  });
}

test("RED: the fixture reproduces brick 3d213c33 — `# fail 0` beside real `not ok` rows", async () => {
  const { stdout, code } = await runNodeTest(FIXTURE_PATH);

  // The defect itself, demonstrated: real failures (`not ok`), zero in `# fail`.
  assert.match(stdout, /^not ok \d+ - leaks a never-resolving promise$/m);
  assert.match(stdout, /^# fail 0$/m);
  const parsed = parseSuiteSummary(stdout);
  assert.equal(parsed.fail, 0, "the defect must still be live on this node version");
  assert.ok(
    (parsed.cancelled ?? 0) > 0,
    "the leaked promise must land in 'cancelled', not vanish — otherwise this fixture no longer reproduces the mechanism",
  );
  // rc is correct even while the text lies — matches both the real incident and
  // this reproduction; asserted so a future node version silently "fixing" rc
  // alongside the text would be caught here rather than assumed.
  assert.equal(code, 1);
});

test("GREEN: checkSuiteSummaryHealth catches what `# fail 0` alone hides", async () => {
  const { stdout } = await runNodeTest(FIXTURE_PATH);
  const health = checkSuiteSummaryHealth(stdout);
  assert.equal(health.ok, false, "a cancelled test must be reported unhealthy");
  assert.match(health.reason, /cancelled/);
});

test("positive control: a genuinely clean summary is NOT flagged (no false positive)", () => {
  const cleanSummary = [
    "TAP version 13",
    "# Subtest: ok one",
    "ok 1 - ok one",
    "1..1",
    "# tests 1",
    "# suites 0",
    "# pass 1",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
  ].join("\n");
  const health = checkSuiteSummaryHealth(cleanSummary);
  assert.equal(health.ok, true, health.ok ? "" : health.reason);
});

test("sum-of-parts invariant catches a genuinely vanished count, independent of `cancelled`", () => {
  // Hypothetical: no 'cancelled' line at all, and pass+fail+skipped+todo undercounts
  // tests. The brick explicitly says this direction is "not established either way" —
  // this check is the belt-and-braces backstop for it, proven here on a fixture that
  // cannot occur from the real mechanism above.
  const brokenSummary = ["# tests 10", "# pass 8", "# fail 0", "# skipped 0", "# todo 0"].join(
    "\n",
  );
  const health = checkSuiteSummaryHealth(brokenSummary);
  assert.equal(health.ok, false);
  assert.match(health.reason, /do not add up/);
});

test("parseSuiteSummary takes the LAST occurrence of each counter (the grand-total block)", () => {
  // A run that (hypothetically) printed an intermediate block before the final one must
  // not be read from the wrong block.
  const twoBlocks = [
    "# tests 1",
    "# pass 1",
    "# fail 0",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
    "# tests 50",
    "# pass 41",
    "# fail 0",
    "# cancelled 9",
    "# skipped 0",
    "# todo 0",
  ].join("\n");
  const parsed = parseSuiteSummary(twoBlocks);
  assert.equal(parsed.tests, 50);
  assert.equal(parsed.cancelled, 9);
});
