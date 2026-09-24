import assert from "node:assert/strict";
import test from "node:test";
import {
  assertForkAtIndexHonoured,
  ForkAtIndexUnsupportedError,
  HARNESS_FACTS,
  HARNESS_IDS,
  resolveEffectiveForkIndex,
  resolveForkLandingIndex,
  type HarnessId,
} from "../src/acp/harness-capabilities.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";

// B0.2 deliverable 3 — the fork path made honest (brick
// https://acpx.devbox.nativai.de/?brick=276594c2, and its three correcting notes).
//
// ⚠️ THE SHAPE THIS FILE PINS, because the brick's own title says otherwise and a
// reader who trusts it would build the wrong thing: the loud refusal is for
// `fork.atIndex` 'ignored' and 'unsupported' ONLY. Codex is 'turn-granular' and
// must PROCEED, reporting the index it actually landed on. Building a refusal for
// codex would ship a NEW defect under a bug-fix label.

const COMMANDS: Record<HarnessId, string> = {
  claude: AGENT_REGISTRY.claude,
  codex: AGENT_REGISTRY.codex,
  pi: AGENT_REGISTRY.pi,
};

test("EVERY declared harness is covered by exactly one of {refuse, proceed} — no harness falls through", () => {
  // The population, not a hand-picked sample: if a sixth harness is declared, it
  // appears here and this test says which branch it took, rather than the new
  // harness silently inheriting whichever behaviour the code happens to give it.
  const verdicts = HARNESS_IDS.map((id) => {
    let refused = false;
    try {
      assertForkAtIndexHonoured(COMMANDS[id], 3);
    } catch (error) {
      assert.ok(error instanceof ForkAtIndexUnsupportedError, `${id} threw the wrong error type`);
      refused = true;
    }
    return [id, refused, HARNESS_FACTS[id].fork.atIndex] as const;
  });

  assert.deepEqual(verdicts, [
    ["claude", false, "exact"],
    // ⚠️ FALSE, and deliberately so. See the file header.
    ["codex", false, "turn-granular"],
    // ⚠️ PI MOVED FROM {refuse, "unsupported"} TO {proceed, "exact"} WHEN THE
    // nativai pi-acp FORK LANDED (brick ef5999ca). Upstream pi-acp implements no
    // fork handler at all, so acpx refused; the fork implements session/fork on
    // pi's JSONL tree and truncates at a real index. THIS ROW IS THE POPULATION
    // ROW, so the flip had to be made here rather than anywhere else.
    ["pi", false, "exact"],
  ]);

  // 🛑 NO HARNESS EXERCISES THE REFUSAL BRANCH TODAY — every row above is
  // `false`, so this test currently proves only that nothing falls through, NOT
  // that the refusal still works. `assertForkAtIndexHonoured` refuses on
  // `fork.atIndex` of `"ignored"` or `"unsupported"`, and neither is declared by
  // any harness (see `ForkAtIndexSupport`, where both are documented as having
  // no harness today). **A harness that declares either MUST arrive with a row
  // here asserting `true`, and with the refusal-message row this file used to
  // carry** — otherwise the guard ships untested. Asserted rather than left to a
  // comment, so the day it stops being true is a red:
  assert.deepEqual(
    verdicts.filter(([, refused]) => refused).map(([id]) => id),
    [],
    "a harness now declares ignored/unsupported — restore the refusal coverage described above",
  );
});

test("NO --at-index is never refused, for any harness — a full copy is honest everywhere", () => {
  // The positive control on the refusal: it must not have broken fork itself.
  // A harness that cannot honour --at-index still has a working plain fork where
  // `fork.supported` is true.
  for (const id of HARNESS_IDS) {
    assert.doesNotThrow(() => assertForkAtIndexHonoured(COMMANDS[id], undefined), id);
  }
});

test("an agent command the descriptor does not know is NOT refused", () => {
  // acpx has no claim to make about an unclassified adapter, and inventing one
  // would be the same silent-wrong-answer defect in the other direction.
  assert.doesNotThrow(() => assertForkAtIndexHonoured("some-unknown-adapter --acp", 3));
  assert.doesNotThrow(() => assertForkAtIndexHonoured(undefined, 3));
});

test("the effective index is the LANDED one — odd requests round down on codex, exact everywhere else", () => {
  // ⚠️ The expected values come from `resolveForkLandingIndex` called with the
  // descriptor, NOT from a hand-computed floor(index/2)*2. A test that
  // re-derives the arithmetic is itself a consumer that has drifted from the
  // table — which is the drift the descriptor exists to end (row `G1-FRK-02`).
  for (const requested of [0, 1, 2, 3, 6, 7]) {
    for (const id of ["claude", "codex"] as const) {
      assert.equal(
        resolveEffectiveForkIndex(COMMANDS[id], requested),
        resolveForkLandingIndex(HARNESS_FACTS[id].fork, requested) ?? requested,
        `${id} @ ${requested}`,
      );
    }
  }

  // The concrete case the whole field exists for: codex at an ODD index.
  assert.equal(resolveEffectiveForkIndex(COMMANDS.codex, 7), 6);
  assert.equal(resolveEffectiveForkIndex(COMMANDS.codex, 3), 2);
  // THE POSITIVE CONTROL — an EVEN index must be unchanged. Without it,
  // "the effective index is reported" passes trivially by always reporting
  // something different, which is a different bug in this one's costume.
  assert.equal(resolveEffectiveForkIndex(COMMANDS.codex, 6), 6);
  assert.equal(resolveEffectiveForkIndex(COMMANDS.codex, 2), 2);
  // Claude is exact at every index, odd included.
  assert.equal(resolveEffectiveForkIndex(COMMANDS.claude, 7), 7);
});

test("an unknown agent command falls back to the request — the best claim acpx can honestly make", () => {
  assert.equal(resolveEffectiveForkIndex("some-unknown-adapter --acp", 7), 7);
  assert.equal(resolveEffectiveForkIndex(undefined, 7), 7);
});

test("the rounding rule lives ONLY in the descriptor — mutating the data moves the answer", () => {
  // The property that makes `resolveForkLandingIndex` a derivation rather than a
  // hardcoded floor(index/2): hand it a different granularity and the answer must
  // follow the DATA. If someone re-hardcodes the arithmetic inside the function,
  // this goes red.
  assert.equal(
    resolveForkLandingIndex(
      {
        supported: true,
        atIndex: "turn-granular",
        atIndexGranularityMessages: 4,
        atIndexRounding: "down",
      },
      7,
    ),
    4,
  );
  assert.equal(
    resolveForkLandingIndex(
      {
        supported: true,
        atIndex: "turn-granular",
        atIndexGranularityMessages: 4,
        atIndexRounding: "up",
      },
      7,
    ),
    8,
  );
  // A turn-granular row missing its granularity has no answer — better than a
  // guessed one.
  assert.equal(
    resolveForkLandingIndex({ supported: true, atIndex: "turn-granular" }, 7),
    undefined,
  );
});
