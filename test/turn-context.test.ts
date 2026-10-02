/**
 * Per-turn context injection — unit rows of the brick-4539b033 test matrix.
 *
 * Row ids in test names map to `conception/TEST-MATRIX.md`. **Every row making a presence or
 * absence claim carries its named control in the same test or an adjacent one** — a row
 * without its control is an uncontrolled green, because stripped of the control it passes on
 * a build where the feature does nothing at all.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildPromptRequest } from "../src/acp/client.js";
import {
  KNOWN_ENVELOPE_IDS,
  PER_PROVIDER_CAP,
  TOTAL_CAP,
  TURN_CONTEXT_BUDGET_MS,
  TURN_CONTEXT_CLOSE_TAG,
  TURN_CONTEXT_ENVELOPE_ID,
  TURN_CONTEXT_OPEN_TAG,
  TURN_CONTEXT_PROVENANCE_LINE,
  TURN_CONTEXT_TEST_PAYLOAD_ENV,
  buildTurnContextRequest,
  composeTurnContext,
  effectiveTurnContextProviders,
  hasTurnContextProviders,
  resetTurnContextWarningsForTests,
  resolveTurnContext,
  setTurnContextProvidersForTesting,
  turnContextProviders,
  type TurnContextProvider,
  type TurnContextRequest,
} from "../src/acp/turn-context.js";

const REQUEST: TurnContextRequest = {
  sessionId: "session-1",
  harness: "claude",
  agentCommand: "node /opt/claude-agent-acp/dist/index.js",
  sessionEnv: {},
};

function provider(
  id: string,
  resolve: TurnContextProvider["resolve"],
  attribution: TurnContextProvider["attribution"] = { kind: "neutral" },
): TurnContextProvider {
  return { id, attribution, resolve };
}

/** Capture stderr for the duration of `run`, so warning COUNTS can be asserted. */
async function captureStderr(run: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    await run();
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  return written;
}

function turnContextWarnings(lines: string[]): string[] {
  return lines.filter((line) => line.includes("turn context unavailable"));
}

test.beforeEach(() => {
  resetTurnContextWarningsForTests();
});

// ---------------------------------------------------------------------------
// A — Inertness. THE primary regression; protects every live agent on five boxes.
// ---------------------------------------------------------------------------

test("A5 buildPromptRequest with no turn context is byte-identical and key-order-identical", () => {
  const prompt = [{ type: "text" as const, text: "the user's words" }];

  const withoutMessageId = buildPromptRequest("s1", prompt, undefined);
  assert.deepEqual(Object.keys(withoutMessageId), ["sessionId", "prompt"]);
  assert.equal(
    JSON.stringify(withoutMessageId),
    '{"sessionId":"s1","prompt":[{"type":"text","text":"the user\'s words"}]}',
  );

  const withMessageId = buildPromptRequest("s1", prompt, { messageId: "m1" });
  // Key ORDER is asserted via Object.keys because deepEqual ignores order, and inertness is
  // a byte-identity claim: a re-ordered key is a real failure.
  assert.deepEqual(Object.keys(withMessageId), ["sessionId", "prompt", "messageId"]);

  // The prompt array is passed through by REFERENCE, not copied — the inert path is the same
  // code path, not an equivalent one.
  assert.equal(withoutMessageId.prompt, prompt);

  // CONTROL: with turn context the frame MUST differ, otherwise this row would pass on a
  // build where turn context is never placed at all.
  const decorated = buildPromptRequest("s1", prompt, undefined, "BLOCK");
  assert.notEqual(JSON.stringify(decorated), JSON.stringify(withoutMessageId));
  assert.equal(decorated.prompt.length, 2);
});

test("A5 inert frame matches the captured literal wire baselines' shape on all three adapters", () => {
  // The baselines are the LITERAL JSON-RPC frames captured at b16b75c before this change.
  const baselineDir = "/wisdom/Bricks/4539b033-e3f1-4749-8a3e-8835f780b373/verification/baseline";
  for (const adapter of ["claude-agent-acp", "codex-acp", "pi-acp"]) {
    const frame = JSON.parse(
      readFileSync(`${baselineDir}/${adapter}.session-prompt.literal-frame.json`, "utf8"),
    ) as { params: { sessionId: string; prompt: Array<{ type: "text"; text: string }> } };

    // The per-turn slot is genuinely empty today — that is what makes byte-identity a clean
    // claim rather than a diff against existing clutter.
    assert.equal(
      Object.hasOwn(frame.params, "_meta"),
      false,
      `${adapter}: baseline session/prompt must carry no _meta`,
    );
    assert.deepEqual(
      Object.keys(frame.params),
      ["sessionId", "prompt"],
      `${adapter}: params key order`,
    );
    assert.deepEqual(
      Object.keys(frame.params.prompt[0]),
      ["type", "text"],
      `${adapter}: block key order`,
    );
    assert.equal(
      frame.params.prompt.length,
      1,
      `${adapter}: undecorated turn is a 1-element array`,
    );

    // Our inert builder reproduces that exact params shape, key order included.
    const built = buildPromptRequest(frame.params.sessionId, frame.params.prompt, undefined);
    assert.equal(
      JSON.stringify(built),
      JSON.stringify(frame.params),
      `${adapter}: inert params byte-identical`,
    );
  }
});

test("A4 a REGISTERED provider returning undefined leaves the request byte-identical", async () => {
  const prompt = [{ type: "text" as const, text: "hello" }];
  const inert = JSON.stringify(buildPromptRequest("s1", prompt, undefined));

  const restore = setTurnContextProvidersForTesting([provider("silent", () => undefined)]);
  try {
    const composed = await resolveTurnContext(REQUEST);
    assert.equal(composed, undefined);
    assert.equal(JSON.stringify(buildPromptRequest("s1", prompt, undefined, composed)), inert);
  } finally {
    restore();
  }

  // CONTROL: the same registry shape with a provider that DOES contribute must differ.
  // Without this, A4 passes on a build where the registry is never consulted at all.
  const restoreNonce = setTurnContextProvidersForTesting([
    provider("nonce", () => "deadbeefdeadbeef"),
  ]);
  try {
    const composed = await resolveTurnContext(REQUEST);
    assert.ok(composed?.includes("deadbeefdeadbeef"));
    assert.notEqual(JSON.stringify(buildPromptRequest("s1", prompt, undefined, composed)), inert);
  } finally {
    restoreNonce();
  }
});

test("D3 a provider returning whitespace only contributes nothing, not an empty envelope", async () => {
  const restore = setTurnContextProvidersForTesting([provider("blank", () => "   \n\t  ")]);
  try {
    assert.equal(await resolveTurnContext(REQUEST), undefined);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// The registry ships EMPTY, and the synchronous guard.
// ---------------------------------------------------------------------------

test("the shipped registry is EMPTY — this is the shipped state of the feature", () => {
  assert.deepEqual(turnContextProviders(), []);
});

test("D10 the synchronous guard predicate is false with an empty registry and no payload", () => {
  // If this predicate is false, the `&&` at the call site cannot reach resolveTurnContext,
  // so no promise is allocated and no microtask is queued on the inert path.
  assert.equal(hasTurnContextProviders({}), false);

  // CONTROL (registry): a registered provider flips it true — otherwise this row would pass
  // on a build where the predicate is hardwired to false.
  const restore = setTurnContextProvidersForTesting([provider("p", () => "x")]);
  try {
    assert.equal(hasTurnContextProviders({}), true);
  } finally {
    restore();
  }

  // CONTROL (test seam): the payload env alone also flips it true.
  assert.equal(hasTurnContextProviders({ [TURN_CONTEXT_TEST_PAYLOAD_ENV]: "nonce" }), true);
  // ...and an empty/whitespace payload does NOT, so the seam cannot accidentally arm itself.
  assert.equal(hasTurnContextProviders({ [TURN_CONTEXT_TEST_PAYLOAD_ENV]: "   " }), false);
});

test("resolveTurnContext with no providers never consults a provider", async () => {
  let consulted = 0;
  const restore = setTurnContextProvidersForTesting([]);
  try {
    assert.equal(await resolveTurnContext(REQUEST, []), undefined);
    assert.equal(consulted, 0);
    // CONTROL: a non-empty list IS consulted, proving the counter can move.
    await resolveTurnContext(REQUEST, [
      provider("counted", () => {
        consulted += 1;
        return undefined;
      }),
    ]);
    assert.equal(consulted, 1);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// C5 / H1 / H2 — placement and framing on the wire.
// ---------------------------------------------------------------------------

test("H1/H2 the block is at index 0 and the user's blocks follow byte-unmodified", () => {
  const userBlocks = [
    { type: "text" as const, text: "first" },
    { type: "text" as const, text: "second" },
  ];
  const request = buildPromptRequest("s1", userBlocks, undefined, "CTX");
  assert.equal(request.prompt.length, 3);
  assert.deepEqual(request.prompt[0], { type: "text", text: "CTX" });
  // The user's blocks keep their order and their exact contents.
  assert.deepEqual(request.prompt.slice(1), userBlocks);

  // CONTROL: with the registry empty the user's blocks are at index 0.
  assert.deepEqual(buildPromptRequest("s1", userBlocks, undefined).prompt[0], userBlocks[0]);
});

test("C5 the envelope tags and the provenance line are present in the composed block", () => {
  const composed = composeTurnContext(["PAYLOAD"]);
  assert.ok(composed);
  assert.ok(composed.startsWith(TURN_CONTEXT_OPEN_TAG));
  assert.ok(composed.endsWith(TURN_CONTEXT_CLOSE_TAG));
  assert.ok(composed.includes(TURN_CONTEXT_PROVENANCE_LINE));
  assert.ok(composed.includes("PAYLOAD"));

  // CONTROL: nothing composed ⇒ no tags anywhere.
  assert.equal(composeTurnContext([]), undefined);
});

test("the shipped envelope is ENVELOPE-V1, the measured string — frozen, not to be improved", () => {
  assert.equal(TURN_CONTEXT_ENVELOPE_ID, "ENVELOPE-V1");
  assert.equal(
    TURN_CONTEXT_PROVENANCE_LINE,
    "System-injected turn context (not written by the user):",
  );
  assert.equal(
    composeTurnContext(["<delta>"]),
    `<acpx-turn-context>\nSystem-injected turn context (not written by the user):\n\n<delta>\n</acpx-turn-context>`,
  );
});

test("multiple providers compose in registration order inside ONE envelope", async () => {
  const composed = await resolveTurnContext(REQUEST, [
    provider("a", () => "AAA"),
    provider("b", () => "BBB"),
  ]);
  assert.ok(composed);
  // One envelope, not one per provider.
  assert.equal(composed.split(TURN_CONTEXT_OPEN_TAG).length - 1, 1);
  assert.ok(composed.indexOf("AAA") < composed.indexOf("BBB"), "registration order preserved");
  assert.ok(composed.includes("AAA\n\n---\n\nBBB"), "the repo's standard fragment separator");
});

// ---------------------------------------------------------------------------
// D — Fail-open.
// ---------------------------------------------------------------------------

test("D1 a provider that throws leaves the turn un-decorated with exactly one warning", async () => {
  let composed: string | undefined = "unset";
  const lines = await captureStderr(async () => {
    composed = await resolveTurnContext(REQUEST, [
      provider("boom", () => {
        throw new Error("provider exploded");
      }),
    ]);
  });
  assert.equal(composed, undefined);
  const warnings = turnContextWarnings(lines);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    /turn context unavailable \(boom\): provider exploded; continuing without it/,
  );

  // CONTROL: a working provider decorates and warns ZERO times.
  resetTurnContextWarningsForTests();
  const okLines = await captureStderr(async () => {
    assert.ok(await resolveTurnContext(REQUEST, [provider("fine", () => "ok")]));
  });
  assert.equal(turnContextWarnings(okLines).length, 0);
});

test("D1 a rejecting provider does not stop the others from contributing", async () => {
  await captureStderr(async () => {
    const composed = await resolveTurnContext(REQUEST, [
      provider("bad", () => Promise.reject(new Error("nope"))),
      provider("good", () => "SURVIVED"),
    ]);
    assert.ok(composed?.includes("SURVIVED"));
  });
});

test("D2/D8a a provider that never SETTLES is bounded at the budget, un-decorated, one warning", async () => {
  let composed: string | undefined = "unset";
  const started = performance.now();
  const lines = await captureStderr(async () => {
    composed = await resolveTurnContext(REQUEST, [
      provider("stuck", () => new Promise<string>(() => {})),
    ]);
  });
  const elapsedMs = performance.now() - started;

  assert.equal(composed, undefined);
  const warnings = turnContextWarnings(lines);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\(stuck\).*did not settle within the 100ms turn-context budget/);
  // Bounded at budget + tolerance. The generous upper bound is deliberate: this box is shared
  // and its load swings, so a tight bound would be a flaky row — and a flaky row in a
  // mandatory gate is noise, not coverage.
  assert.ok(
    elapsedMs < TURN_CONTEXT_BUDGET_MS * 8,
    `expected bounded by the budget, took ${elapsedMs.toFixed(1)}ms`,
  );

  // CONTROL: a provider settling well inside the budget DECORATES and does not warn. This is
  // what proves the race resolves on provider success and not always on the timer.
  resetTurnContextWarningsForTests();
  const okLines = await captureStderr(async () => {
    const quick = await resolveTurnContext(REQUEST, [
      provider(
        "prompt-ish",
        () => new Promise<string>((resolve) => setTimeout(() => resolve("QUICK"), 5)),
      ),
    ]);
    assert.ok(quick?.includes("QUICK"));
  });
  assert.equal(turnContextWarnings(okLines).length, 0);
});

test("D8b a provider that BLOCKS the event loop is NOT bounded — the documented limit, measured", async () => {
  // ⚠️ THIS ROW PASSES BY DEMONSTRATING A FAILURE TO BOUND. Do not "fix" it to expect ~100ms.
  // `Promise.race` bounds a provider that never SETTLES; it cannot bound one that never
  // YIELDS, because the timer enforcing the budget is itself starved by the block. `async` is
  // not a thread. The mitigation is the provider contract plus code review, enforceable
  // because there is no runtime ingress — NOT the budget.
  const blockMs = 400;
  const started = performance.now();
  await captureStderr(async () => {
    await resolveTurnContext(REQUEST, [
      provider("blocker", () => {
        const until = Date.now() + blockMs;
        while (Date.now() < until) {
          // deliberate synchronous spin — the never-yields shape
        }
        return "BLOCKED-BUT-RETURNED";
      }),
    ]);
  });
  const elapsedMs = performance.now() - started;
  assert.ok(
    elapsedMs >= blockMs * 0.8,
    `the block must NOT be bounded by the ${TURN_CONTEXT_BUDGET_MS}ms budget; measured ${elapsedMs.toFixed(1)}ms`,
  );
  // D8a is this row's control: there, the budget DOES bound a never-settles provider. The pair
  // is what turns a prose caveat into a measured fact.
});

test("D5 one throwing provider warns ONCE across many turns, not once per turn", async () => {
  const thrower = provider("repeat-offender", () => {
    throw new Error("still broken");
  });
  const lines = await captureStderr(async () => {
    for (let turn = 0; turn < 50; turn++) {
      await resolveTurnContext(REQUEST, [thrower]);
    }
  });
  assert.equal(turnContextWarnings(lines).length, 1);

  // CONTROL: TWO throwing providers ⇒ exactly TWO lines. Proves the dedupe key is
  // per-provider and not a global mute.
  resetTurnContextWarningsForTests();
  const twoLines = await captureStderr(async () => {
    for (let turn = 0; turn < 10; turn++) {
      await resolveTurnContext(REQUEST, [
        provider("first", () => {
          throw new Error("a");
        }),
        provider("second", () => {
          throw new Error("b");
        }),
      ]);
    }
  });
  assert.equal(turnContextWarnings(twoLines).length, 2);
});

test("D6 one provider failing in two distinct classes warns twice", async () => {
  let turn = 0;
  const flaky = provider("two-faced", () => {
    turn += 1;
    if (turn === 1) {
      throw new Error("threw first");
    }
    return new Promise<string>(() => {}); // then never settles
  });
  const lines = await captureStderr(async () => {
    await resolveTurnContext(REQUEST, [flaky]);
    await resolveTurnContext(REQUEST, [flaky]);
  });
  const warnings = turnContextWarnings(lines);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((line) => line.includes("threw first")));
  assert.ok(warnings.some((line) => line.includes("did not settle")));
});

test("D7 a provider returning a non-string is treated as no contribution, one invalid warning", async () => {
  let composed: string | undefined = "unset";
  const lines = await captureStderr(async () => {
    composed = await resolveTurnContext(REQUEST, [
      // A runtime type violation is reachable from untyped JS, so it is handled rather than trusted.
      provider("wrong-type", () => 42 as unknown as string),
    ]);
  });
  assert.equal(composed, undefined);
  const warnings = turnContextWarnings(lines);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\(wrong-type\).*expected a string, received number/);

  // CONTROL: a valid string contributes.
  resetTurnContextWarningsForTests();
  assert.ok(await resolveTurnContext(REQUEST, [provider("right-type", () => "fine")]));
});

// ---------------------------------------------------------------------------
// E — The bulk bound.
// ---------------------------------------------------------------------------

test("E5 the cap constants, and TOTAL_CAP excludes a primer-sized payload BY CONSTRUCTION", () => {
  assert.equal(PER_PROVIDER_CAP, 2048);
  assert.equal(TOTAL_CAP, 4096);
  assert.ok(
    TOTAL_CAP < 36_100,
    "TOTAL_CAP must stay below 36,100 — the exact size of the whole-primer re-send a previous " +
      "phase deleted. Raising the cap to fit a primer-sized payload is the specific regression " +
      "this assertion exists to block: the per-turn slot cannot be cached, so bulk content " +
      "there is paid on every turn of every session. If you are here to raise the cap, that is " +
      "a design decision needing its own cost argument, not a test to update.",
  );
});

test("E1 a 36,100-char payload contributes nothing, warns over-cap, and the turn survives", async () => {
  let composed: string | undefined = "unset";
  const lines = await captureStderr(async () => {
    composed = await resolveTurnContext(REQUEST, [provider("bulky", () => "x".repeat(36_100))]);
  });
  assert.equal(composed, undefined);
  const warnings = turnContextWarnings(lines);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\(bulky\): 36100 chars exceeds the 2048-char per-provider cap/);

  // CONTROL (E2): an under-cap payload contributes — proving the cap is not rejecting
  // everything, which is what a one-sided cap test cannot distinguish.
  resetTurnContextWarningsForTests();
  assert.ok(await resolveTurnContext(REQUEST, [provider("small", () => "y".repeat(100))]));
});

test("E2/E3 the per-provider cap boundary is inclusive, and one char over is dropped", async () => {
  // E2 — exactly at the cap contributes.
  const atCap = await resolveTurnContext(REQUEST, [
    provider("at-cap", () => "a".repeat(PER_PROVIDER_CAP)),
  ]);
  assert.ok(atCap?.includes("a".repeat(PER_PROVIDER_CAP)));

  // E3 — one char over is dropped. E2 and E3 are each other's control: a one-sided cap test
  // cannot tell "the cap works" from "everything is dropped".
  resetTurnContextWarningsForTests();
  let over: string | undefined = "unset";
  const lines = await captureStderr(async () => {
    over = await resolveTurnContext(REQUEST, [
      provider("over-cap", () => "a".repeat(PER_PROVIDER_CAP + 1)),
    ]);
  });
  assert.equal(over, undefined);
  assert.match(turnContextWarnings(lines)[0], /2049 chars exceeds the 2048-char per-provider cap/);
});

test("E4 providers each under cap but over the TOTAL cap drop the WHOLE block, not a subset", async () => {
  const three = (size: number) => [
    provider("p1", () => "1".repeat(size)),
    provider("p2", () => "2".repeat(size)),
    provider("p3", () => "3".repeat(size)),
  ];

  let composed: string | undefined = "unset";
  const lines = await captureStderr(async () => {
    composed = await resolveTurnContext(REQUEST, three(1_500));
  });
  assert.equal(composed, undefined, "4,500 chars of payload exceeds the 4,096 total cap");
  assert.equal(turnContextWarnings(lines).length, 1, "one warning, not one per provider");
  assert.match(turnContextWarnings(lines)[0], /over the 4096-char total cap/);

  // CONTROL: the same three providers under the total cap ⇒ ALL THREE contribute. Without
  // this, E4 passes on a build that drops everything.
  resetTurnContextWarningsForTests();
  const under = await resolveTurnContext(REQUEST, three(1_300));
  assert.ok(under, "3,900 chars of payload fits under the 4,096 total cap");
  assert.ok(under.includes("1".repeat(1_300)));
  assert.ok(under.includes("2".repeat(1_300)));
  assert.ok(under.includes("3".repeat(1_300)));
});

/**
 * The suite executes from `dist-test/test/`, so a fixed relative hop to `../src` lands in
 * `dist-test/src` — compiled `.js`, zero `.ts` files — and a source sweep then silently
 * examines NOTHING while reporting clean. This repo already carries that scar in
 * `test/output-style-no-live-apply.test.ts`, and this file reproduced it on its first run.
 * Walk to the real repo root, and assert the subject is non-empty before trusting a clean
 * result: a sweep with no subjects and a sweep with no offenders are the same green.
 */
function repoRoot(): string {
  let dir = import.meta.dirname;
  for (let hop = 0; hop < 8; hop += 1) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error(`could not locate the repo root from ${import.meta.dirname}`);
}

test("E6/D9 turn-context.ts has no executable surface and no blocking fs call", () => {
  const sourcePath = join(repoRoot(), "src/acp/turn-context.ts");
  const source = readFileSync(sourcePath, "utf8");
  // THE SUBJECT CHECK. Without it this row passes on an empty or wrong file.
  assert.ok(
    source.length > 2_000 && source.includes("export async function resolveTurnContext"),
    `${sourcePath} does not look like the turn-context module — the sweep had no subject`,
  );
  // Strip the module doc comment: it NAMES these shapes in the provider contract precisely to
  // forbid them, and a textual scan would otherwise flag its own prohibition.
  const code = source.slice(source.indexOf("\nimport "));
  // SECOND subject check: the doc-comment strip above could in principle consume the whole
  // file, and a sweep over an empty string is green for the wrong reason.
  assert.ok(code.length > 1_000, "stripping the module doc comment left no code to sweep");
  const forbiddenShapes = new Set([
    "child_process",
    "spawn(",
    "execSync",
    "execFile",
    "readFileSync",
    "writeFileSync",
  ]);
  for (const forbidden of forbiddenShapes) {
    assert.equal(
      code.includes(forbidden),
      false,
      `turn-context.ts must not contain ${forbidden} — no runtime ingress (that is what makes ` +
        "the provider contract enforceable at review) and no event-loop blocking",
    );
  }
});

test("E7 every registry entry declares attribution — binds on the first provider added", () => {
  for (const entry of turnContextProviders()) {
    assert.ok(entry.attribution, `provider ${entry.id} must declare attribution`);
    assertAttributionWellFormed(entry);
  }
  // CONTROL (E9's malformed arm) — proving the assertion can fail at all. Without it, E7 is
  // green merely because the shipped set is empty.
  assert.throws(() =>
    assertAttributionWellFormed(
      provider("sneaky", () => "x", { kind: "requires-mitigation", evidence: "" }),
    ),
  );
});

test("E9 a requires-mitigation entry needs evidence naming a KNOWN envelope identifier", () => {
  // Accepted: well-formed `<measurement>/<ENVELOPE-ID>`.
  assertAttributionWellFormed(
    provider("ok", () => "x", { kind: "requires-mitigation", evidence: "M1e/ENVELOPE-V1" }),
  );

  // Rejected: missing, empty, shapeless, or naming an envelope nobody measured. The accepted
  // and rejected arms are each other's control — a one-sided check cannot distinguish "the
  // guard works" from "everything is rejected".
  for (const evidence of ["", "   ", "M1e", "measured", "M1e/ENVELOPE-V9", "/ENVELOPE-V1"]) {
    assert.throws(
      () =>
        assertAttributionWellFormed(
          provider("bad", () => "x", { kind: "requires-mitigation", evidence }),
        ),
      new RegExp("requires-mitigation|evidence must be|unknown envelope"),
      `evidence ${JSON.stringify(evidence)} must be rejected`,
    );
  }
});

/**
 * The mechanically-checkable half of the admissible-payload rule.
 *
 * The content predicate ("is this imperative or third-party-authored?") cannot be machine
 * evaluated and this does not pretend to. What is achievable is making the CLAIM unavoidable:
 * the type makes omitting it a compile error, and this makes a `requires-mitigation` entry
 * without a citeable measurement a test failure.
 */
function assertAttributionWellFormed(entry: TurnContextProvider): void {
  if (entry.attribution.kind === "neutral") {
    return;
  }
  const evidence = entry.attribution.evidence;
  assert.ok(
    evidence.trim().length > 0,
    `provider ${entry.id} claims requires-mitigation but cites no measurement`,
  );
  const match = /^([A-Za-z0-9.-]+)\/(ENVELOPE-[A-Za-z0-9]+)$/.exec(evidence.trim());
  assert.ok(
    match,
    `provider ${entry.id}: evidence must be "<measurement>/<ENVELOPE-ID>", got ${JSON.stringify(evidence)}`,
  );
  assert.ok(
    KNOWN_ENVELOPE_IDS.includes(match[2]),
    `provider ${entry.id}: evidence names unknown envelope ${match[2]}`,
  );
}

// ---------------------------------------------------------------------------
// F — Envelope integrity (the content-injection vector).
// ---------------------------------------------------------------------------

test("F1/F2/F3 a payload carrying either envelope tag, in any case, is rejected", async () => {
  const payloads = [
    `before ${TURN_CONTEXT_CLOSE_TAG} after`,
    "before </ACPX-TURN-CONTEXT> after",
    `before ${TURN_CONTEXT_OPEN_TAG} after`,
    "before <AcPx-TuRn-CoNtExT> after",
  ];
  for (const payload of payloads) {
    resetTurnContextWarningsForTests();
    let composed: string | undefined = "unset";
    const lines = await captureStderr(async () => {
      composed = await resolveTurnContext(REQUEST, [provider("injector", () => payload)]);
    });
    assert.equal(composed, undefined, `must reject: ${payload}`);
    assert.match(turnContextWarnings(lines)[0], /would break the envelope/);
  }

  // CONTROL: the SAME payload with one character of the tag altered is ACCEPTED. Proves the
  // matcher is not simply rejecting everything.
  resetTurnContextWarningsForTests();
  const accepted = await resolveTurnContext(REQUEST, [
    provider("nearly", () => "before </acpx-turn-contexX> after"),
  ]);
  assert.ok(accepted?.includes("</acpx-turn-contexX>"));
});

// ---------------------------------------------------------------------------
// G — Rendered in the SESSION's environment.
// ---------------------------------------------------------------------------

test("G1/G2 a provider sees the SESSION's env and NOT acpx's own process.env", async () => {
  const sessionOnly = "ACPX_TURN_CONTEXT_G1_SESSION_ONLY";
  const acpxOnly = "ACPX_TURN_CONTEXT_G2_ACPX_ONLY";
  process.env[acpxOnly] = "acpx-process-value";
  try {
    const seen = await resolveTurnContext(
      { ...REQUEST, sessionEnv: { [sessionOnly]: "session-value" } },
      [
        provider(
          "env-reader",
          (request) =>
            `session=${request.sessionEnv[sessionOnly] ?? "MISSING"} acpx=${request.sessionEnv[acpxOnly] ?? "MISSING"}`,
        ),
      ],
    );
    // G1 — the session's own var is visible.
    assert.ok(seen, "the env-reading provider must contribute");
    assert.ok(seen.includes("session=session-value"));
    // G2 — THE LOAD-BEARING HALF. A var present only in acpx's process.env must NOT be
    // visible. G1 alone passes on a broken build that reads process.env, because a var
    // present in both envs would be found either way.
    assert.ok(seen.includes("acpx=MISSING"));
  } finally {
    delete process.env[acpxOnly];
  }
});

test("G3 buildTurnContextRequest carries sessionEnv through and derives the harness", () => {
  const sessionEnv = { SOME_VAR: "v" };
  const built = buildTurnContextRequest({
    sessionId: "s9",
    agentCommand: "node /opt/pi-acp/dist/index.js",
    sessionEnv,
  });
  assert.equal(built.sessionEnv, sessionEnv, "the session env is passed by reference, not copied");
  assert.equal(built.harness, "pi");
  assert.equal(built.sessionId, "s9");

  // CONTROL: an unknown adapter yields an undefined harness rather than a wrong one.
  assert.equal(
    buildTurnContextRequest({ sessionId: "s", agentCommand: "node /tmp/whatever.js", sessionEnv })
      .harness,
    undefined,
  );
});

// ---------------------------------------------------------------------------
// The test seam is a registered provider, so it exercises the production path.
// ---------------------------------------------------------------------------

test("the test-payload seam is a real registry provider reading the SESSION's env", async () => {
  const sessionEnv = { [TURN_CONTEXT_TEST_PAYLOAD_ENV]: "a1b2c3d4e5f60718" };
  const providers = effectiveTurnContextProviders(sessionEnv);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, "test-payload");
  assert.deepEqual(providers[0].attribution, { kind: "neutral" });

  const composed = await resolveTurnContext({ ...REQUEST, sessionEnv });
  assert.ok(composed, "the seam must contribute when the session env carries a payload");
  assert.ok(composed.includes("a1b2c3d4e5f60718"));
  assert.ok(composed.startsWith(TURN_CONTEXT_OPEN_TAG));

  // CONTROL: unset ⇒ no providers, nothing composed. Same instrument, opposite verdict.
  assert.deepEqual(effectiveTurnContextProviders({}), []);
  assert.equal(await resolveTurnContext({ ...REQUEST, sessionEnv: {} }), undefined);
});

test("the seam does NOT read acpx's own process.env", async () => {
  process.env[TURN_CONTEXT_TEST_PAYLOAD_ENV] = "leaked-from-acpx-env";
  try {
    assert.deepEqual(effectiveTurnContextProviders({}), []);
    assert.equal(await resolveTurnContext({ ...REQUEST, sessionEnv: {} }), undefined);
  } finally {
    delete process.env[TURN_CONTEXT_TEST_PAYLOAD_ENV];
  }
});
