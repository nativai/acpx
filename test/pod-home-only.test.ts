import assert from "node:assert/strict";
import test from "node:test";
import {
  isHomeOnlyHarness,
  PI_PLACEMENT_ENV,
  readBoxFacts,
  resetPiPlacementWarningForTests,
} from "../src/pod/home-only.js";
import { utilityKeyFor } from "../src/pod/utility-branch.js";

// A-44 / A-45: the ONE function that says which harnesses are home-only on this box — read by the utility
// pod's key and by a session's placement. The condition is a PER-BOX fact (P1 on the box), never an acpx release.

const NO_P1 = { p1OnBox: false };
const P1 = { p1OnBox: true };

test("home-only: codex always; pi until P1 is on the box; claude, the terminal harness, utility and unknown never", () => {
  assert.equal(isHomeOnlyHarness("codex", NO_P1), true);
  assert.equal(isHomeOnlyHarness("codex", P1), true, "codex stays home with P1");
  assert.equal(isHomeOnlyHarness("pi", NO_P1), true);
  assert.equal(isHomeOnlyHarness("pi", P1), false, "with P1's fact, Pi leaves the home set");
  for (const harness of ["claude", "claude-pty", "utility", "gemini", undefined]) {
    assert.equal(isHomeOnlyHarness(harness, NO_P1), false, String(harness));
    assert.equal(isHomeOnlyHarness(harness, P1), false, String(harness));
  }
});

test("the per-box fact: no signal means NOT on the box; the test seam is ignored outside node --test and unless exactly `1`", () => {
  assert.deepEqual(readBoxFacts({}), NO_P1, "nothing set: pre-P1 — Pi stays home");
  assert.deepEqual(readBoxFacts({ NODE_TEST_CONTEXT: "child" }), NO_P1);
  assert.deepEqual(
    readBoxFacts({ ACPX_TEST_P1_ON_BOX: "1" }),
    NO_P1,
    "the seam alone, outside a test, is ignored",
  );
  assert.deepEqual(
    readBoxFacts({ NODE_TEST_CONTEXT: "child", ACPX_TEST_P1_ON_BOX: "true" }),
    NO_P1,
  );
  assert.deepEqual(readBoxFacts({ NODE_TEST_CONTEXT: "child", ACPX_TEST_P1_ON_BOX: "1" }), P1);
  // An EMPTY NODE_TEST_CONTEXT honours no seam (the rule of every other seam here).
  assert.deepEqual(readBoxFacts({ NODE_TEST_CONTEXT: "", ACPX_TEST_P1_ON_BOX: "1" }), NO_P1);
});

test("the utility key follows the same function: Pi and codex home, claude pool — and Pi pool only with the fact", () => {
  assert.equal(utilityKeyFor("pi", NO_P1), "util-home");
  assert.equal(utilityKeyFor("pi", P1), "util-pool");
  assert.equal(utilityKeyFor("codex", NO_P1), "util-home");
  assert.equal(utilityKeyFor("codex", P1), "util-home");
  assert.equal(utilityKeyFor("claude", NO_P1), "util-pool");
  assert.equal(utilityKeyFor(undefined, NO_P1), "util-pool");
});

// P1 (brick e9f71106, contract §2): the REAL per-box signal. These rows go red if the reader honours anything
// but the exact `pool`, if it ever answers `pool` without the variable (the release alone moving Pi), or if an
// unknown value stops warning by name.
test("P1 signal: ACPX_PI_PLACEMENT=pool puts P1 on the box; absent, empty and home do not, silently", () => {
  assert.equal(PI_PLACEMENT_ENV, "ACPX_PI_PLACEMENT");
  const lines: string[] = [];
  const warn = (line: string) => lines.push(line);
  resetPiPlacementWarningForTests();
  assert.deepEqual(readBoxFacts({ ACPX_PI_PLACEMENT: "pool" }, warn), P1);
  // No test seam needed and none consulted: the production signal works outside node --test too.
  assert.deepEqual(readBoxFacts({ NODE_TEST_CONTEXT: "", ACPX_PI_PLACEMENT: "pool" }, warn), P1);
  assert.deepEqual(readBoxFacts({}, warn), NO_P1, "absent: the release alone never moves Pi");
  assert.deepEqual(readBoxFacts({ ACPX_PI_PLACEMENT: "" }, warn), NO_P1, "empty");
  assert.deepEqual(readBoxFacts({ ACPX_PI_PLACEMENT: "home" }, warn), NO_P1, "home (the undo)");
  assert.deepEqual(lines, [], "absent, empty, home and pool warn about nothing");
});

test("P1 signal: any other value is NOT pool and warns once per process, naming the variable and the value", () => {
  const lines: string[] = [];
  const warn = (line: string) => lines.push(line);
  resetPiPlacementWarningForTests();
  for (const garbage of ["Pool", "pool ", "POOL", "on", "true", "1", "auto", "pod"]) {
    assert.deepEqual(readBoxFacts({ ACPX_PI_PLACEMENT: garbage }, warn), NO_P1, garbage);
  }
  assert.equal(lines.length, 1, "one warning per process, not one per call");
  assert.match(
    lines[0] ?? "",
    /ACPX_PI_PLACEMENT="Pool" is not "pool" or "home"; treating it as "home"/,
  );
  // The garbage value with the test seam on still takes the seam's answer, not pool.
  assert.deepEqual(
    readBoxFacts({ ACPX_PI_PLACEMENT: "yes", NODE_TEST_CONTEXT: "child" }, warn),
    NO_P1,
  );
});

test("P1 signal: sessions and one-shots get the same answer from the same env — codex never moves", () => {
  for (const [value, piKey, piHome] of [
    [undefined, "util-home", true],
    ["", "util-home", true],
    ["home", "util-home", true],
    ["pool", "util-pool", false],
    ["garbage", "util-home", true],
  ] as const) {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { ACPX_PI_PLACEMENT: value };
    const box = readBoxFacts(env, () => {});
    assert.equal(utilityKeyFor("pi", box), piKey, `one-shot, ${String(value)}`);
    assert.equal(isHomeOnlyHarness("pi", box), piHome, `session, ${String(value)}`);
    assert.equal(utilityKeyFor("codex", box), "util-home", `codex one-shot, ${String(value)}`);
    assert.equal(isHomeOnlyHarness("codex", box), true, `codex session, ${String(value)}`);
  }
});
