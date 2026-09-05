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
  "claude-pty": AGENT_REGISTRY["claude-pty"],
  codex: AGENT_REGISTRY.codex,
  opencode: AGENT_REGISTRY.opencode,
  pi: AGENT_REGISTRY.pi,
};

function captureThrow(run: () => void): ForkAtIndexUnsupportedError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ForkAtIndexUnsupportedError, "wrong error type");
    return error;
  }
  throw new assert.AssertionError({ message: "expected a ForkAtIndexUnsupportedError" });
}

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
    ["claude-pty", false, "exact"],
    // ⚠️ FALSE, and deliberately so. See the file header.
    ["codex", false, "turn-granular"],
    ["opencode", true, "ignored"],
    // ⚠️ PI MOVED FROM {refuse, "unsupported"} TO {proceed, "exact"} WHEN THE
    // nativai pi-acp FORK LANDED (brick ef5999ca). Upstream pi-acp implements no
    // fork handler at all, so acpx refused; the fork implements session/fork on
    // pi's JSONL tree and truncates at a real index. THIS ROW IS THE POPULATION
    // ROW, so the flip had to be made here rather than anywhere else — and the
    // refusal branch keeps a member (opencode), which is what stops this from
    // becoming a test that only exercises "proceed".
    ["pi", false, "exact"],
  ]);
});

test("the refusal names the descriptor value and what it means — a bare 'unsupported' is not actionable", () => {
  // `assert.throws` returns undefined in node:test — capture the error by hand.
  const error = captureThrow(() => assertForkAtIndexHonoured(COMMANDS.opencode, 2));
  assert.equal(error.harness, "opencode");
  assert.equal(error.atIndex, "ignored");
  assert.match(error.message, /fork\.atIndex == "ignored"/);
  // The user must learn WHY, or the refusal reads as a bug in acpx.
  assert.match(error.message, /silently full-copies/);
  // And what they can do instead: opencode's PLAIN fork works (fork.supported).
  assert.match(error.message, /omit --at-index/);

  // ⚠️ pi USED TO PROVIDE THE SECOND REFUSAL CASE HERE and no longer does — the
  // fork honours --at-index. Asserting the POSITIVE in its place keeps the row
  // two-sided: without it, a change that made assertForkAtIndexHonoured refuse
  // everything would still pass on the opencode half alone.
  assert.doesNotThrow(() => assertForkAtIndexHonoured(COMMANDS.pi, 2));
});

test("NO --at-index is never refused, for any harness — a full copy is honest everywhere", () => {
  // The positive control on the refusal: it must not have broken fork itself.
  // opencode's plain fork is `fork.supported: true` and stays available.
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
    for (const id of ["claude", "claude-pty", "codex"] as const) {
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
  assert.equal(resolveEffectiveForkIndex(COMMANDS["claude-pty"], 7), 7);
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
