import assert from "node:assert/strict";
import test from "node:test";
import { isHomeOnlyHarness, readBoxFacts } from "../src/pod/home-only.js";
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
