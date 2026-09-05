import assert from "node:assert/strict";
import test from "node:test";
import { parseReasoningEffort } from "../src/cli/flags.js";
import { CANONICAL_DEPTH_VOCABULARY } from "../src/session/depth-projection.js";

// `--reasoning-effort` must not apply a harness's ladder at a harness-agnostic gate.
//
// ⚠️ WHY THIS CHANGED, AND IT IS NOT A WIDENING FOR ITS OWN SAKE. codex widened
// `ReasoningEffort` from a closed union to an OPEN STRING: rungs are
// catalogue-driven per model, and `gpt-6-astra` carries `ultra` — a rung acpx had
// never seen. pi proved the same lesson from the other direction: it advertises
// six rungs and serves three, so even a ladder read FROM the harness can lie.
// Two harnesses, one conclusion — a ladder fixed at this gate is wrong by
// construction, because the gate runs before the agent is known.
//
// ⚠️ MEASURED BEFORE THE FIX: of the NINE canonical values, this parser rejected
// THREE — `ultra`, and B3's two load-bearing sentinels `default` and `off`. So a
// valid rung on a catalogue-driven harness, and a request to disable reasoning,
// both died at acpx's own door before any harness saw them.

test("every CANONICAL depth value survives the CLI gate", () => {
  const rejected: string[] = [];
  for (const value of CANONICAL_DEPTH_VOCABULARY) {
    try {
      parseReasoningEffort(value);
    } catch {
      rejected.push(value);
    }
  }
  // ⚠️ POPULATION FIRST — an empty vocabulary would satisfy this vacuously.
  assert.ok(CANONICAL_DEPTH_VOCABULARY.length >= 9, "the vocabulary shrank; this row is weakened");
  assert.deepEqual(rejected, [], `the CLI rejects valid depth values: ${rejected.join(", ")}`);
});

test("`ultra` specifically is accepted — the rung codex's gpt-6-astra added", () => {
  // Named on its own so a regression reads as what it is rather than as "one of
  // nine". `ultra` is the concrete rung that made the closed union wrong.
  assert.equal(parseReasoningEffort("ultra"), "ultra");
});

test("the sentinels `default` and `off` reach the depth path", () => {
  // They are not rungs and they are not interchangeable: 97 catalogue models are
  // `reasoning.mandatory`, so `off` is unsatisfiable for them while `default`
  // always is. A gate that rejects both makes the distinction unreachable.
  assert.equal(parseReasoningEffort("default"), "default");
  assert.equal(parseReasoningEffort("off"), "off");
});

test("it still REJECTS what is not depth vocabulary at all", () => {
  // The two-sided control. A parser that accepted everything would pass every row
  // above and validate nothing — which is a worse defect than the one fixed here,
  // because the error would surface at the harness instead of at the flag.
  for (const value of ["banana", "", "   ", "highest", "9", "low;rm -rf /"]) {
    assert.throws(
      () => parseReasoningEffort(value),
      /Invalid reasoning effort/,
      `accepted nonsense: ${JSON.stringify(value)}`,
    );
  }
});

test("case and surrounding whitespace are still normalised", () => {
  assert.equal(parseReasoningEffort("  ULTRA "), "ultra");
  assert.equal(parseReasoningEffort("Max"), "max");
});

test("the error names the whole vocabulary, and does not claim a harness's ladder", () => {
  // The old message said "Claude profiles: low, medium, high, xhigh, max" —
  // which, at a gate that runs before the agent is known, told a codex user about
  // Claude's ladder and omitted the rung they had asked for.
  let message = "";
  try {
    parseReasoningEffort("nonsense");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(message, "control: no error was raised, so there is no message to judge");
  for (const value of CANONICAL_DEPTH_VOCABULARY) {
    assert.match(message, new RegExp(`\\b${value}\\b`), `the error omits "${value}"`);
  }
  assert.doesNotMatch(
    message,
    /Claude profiles:/,
    "the error still presents one harness's ladder as the rule",
  );
});
