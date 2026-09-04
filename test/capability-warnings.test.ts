import assert from "node:assert/strict";
import test from "node:test";
import {
  depthRequestUnroutableReason,
  DEPTH_MECHANISMS_ROUTED_BY_ACPX,
  HARNESS_FACTS,
  HARNESS_IDS,
  isDepthRequestRoutable,
  resolveHarnessCapabilities,
} from "../src/acp/harness-capabilities.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { assertLiveModelChangeRoutable } from "../src/session/model-application.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// B0.2 deliverables 4 + 5 — the name-hardcoded warnings become capability checks
// (rows `G1-WRN-01`), and `set model` fails loudly instead of bricking the
// session (row `G1-OC-04`).

function recordFor(agentCommand: string, acpx?: SessionRecord["acpx"]): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "rec-cap",
    acpSessionId: "rec-cap-acp",
    agentCommand,
    cwd: "/workspace/projects/temp",
    ...(acpx ? { acpx } : {}),
  });
}

// ── Deliverable 4: the effort warning ────────────────────────────────────────

test("depth routability is answered for EVERY declared harness, and in both directions", () => {
  // The whole population, so a sixth harness cannot join silently. The values are
  // stated as data, not derived here — the point of the row is that the ANSWER
  // moved from a name check to the mechanism table.
  assert.deepEqual(
    HARNESS_IDS.map((id) => [id, HARNESS_FACTS[id].depth.mechanism, isDepthRequestRoutable(id)]),
    [
      ["claude", "config-option", true],
      ["claude-pty", "config-option", true],
      // ⚠️ codex: depth rides INSIDE the model id, so the depth control cannot
      // move it. It must KEEP warning — this is `G1-WRN-01`'s positive control,
      // the thing that separates "made it a capability check" from "deleted the
      // check".
      ["codex", "compose-into-id", false],
      // ⚠️ opencode: the mechanism IS routed, so the warning must NOT fire. This
      // is the direction the old name gate got wrong — it warned while the apply
      // path applied the value.
      ["opencode", "config-option", true],
      // ⚠️ pi: depth is an ACP MODE, and B3 gave acpx's depth path a mode arm
      // (`applyDepthAsMode` -> `session/set_mode`), so the request now REACHES
      // it and the warning must NOT fire. Flipped from false in the same commit
      // as the arm — codex above stays false, which is what keeps this row a
      // discriminating check rather than a blanket "everything is routable now".
      ["pi", "mode", true],
    ],
  );
});

test("the warning gates on the MECHANISM, not on canSetDepthLive", () => {
  // ⚠️ These two answers DIVERGE for opencode, and taking the wrong one is the
  // subtle version of the same defect. `canSetDepthLive` is false there only
  // because the DEFAULT (non-reasoning) model does not advertise `effort` at
  // session/new — so warning on that basis would be wrong the moment a reasoning
  // model is pinned, and the message would contradict the behaviour again.
  assert.equal(isDepthRequestRoutable("opencode"), true);
  assert.equal(resolveHarnessCapabilities("opencode").canSetDepthLive, false);
});

test("the unroutable reason names the mechanism and the verb that DOES work", () => {
  assert.equal(depthRequestUnroutableReason("claude"), null);
  assert.equal(depthRequestUnroutableReason("opencode"), null);
  assert.match(String(depthRequestUnroutableReason("codex")), /--model '<model>\[depth\]'/);
  // ⚠️ pi is now ROUTABLE (B3's mode arm), so it must report NO reason. A stale
  // "use acpx pi set-mode" hint here would tell the user to reach for a
  // workaround for something --reasoning-effort now does.
  assert.equal(depthRequestUnroutableReason("pi"), null);
  // codex remains the positive control: exactly one harness still unroutable.
  assert.equal(
    HARNESS_IDS.filter((id) => !isDepthRequestRoutable(id)).length,
    1,
    "codex must be the ONLY unroutable depth harness — if this hits 0 the check was deleted, not fixed",
  );
});

test("routability follows the ROUTED-MECHANISM list — it is a derivation, not a literal", () => {
  // The mutation probe for this derivation: `config-option` is the only depth
  // mechanism acpx routes today, and that is exactly why claude and opencode
  // answer true. If the list is what decides, removing it from the list must flip
  // them — which is asserted by construction below rather than by re-reading the
  // same table the function reads.
  assert.deepEqual([...DEPTH_MECHANISMS_ROUTED_BY_ACPX], ["config-option", "mode"]);
  for (const id of HARNESS_IDS) {
    assert.equal(
      isDepthRequestRoutable(id),
      DEPTH_MECHANISMS_ROUTED_BY_ACPX.includes(HARNESS_FACTS[id].depth.mechanism),
      id,
    );
  }
});

// ── Deliverable 4b: the output-style warning ─────────────────────────────────

test("output-style support is a descriptor read, and only the Claude family has it", () => {
  assert.deepEqual(
    HARNESS_IDS.map((id) => [id, resolveHarnessCapabilities(id).supportsOutputStyles]),
    [
      ["claude", true],
      ["claude-pty", true],
      ["codex", false],
      ["opencode", false],
      ["pi", false],
    ],
  );
});

// ── Deliverable 5: `set model` fails loudly and recoverably ──────────────────

function captureThrow(run: () => void): Error {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new assert.AssertionError({ message: "expected a throw" });
}

test("D2's protection MOVED from the gate to the apply arm — opencode is now routable", () => {
  // ⚠️ READ THIS BEFORE "RESTORING" THE OLD REFUSAL. Before B3 this row asserted
  // that `assertLiveModelChangeRoutable` THREW for opencode, because acpx had no
  // way to apply a config-option model and persisting one bricked the session
  // (FINDINGS-opencode D2). B3 gave it that way, so the gate now correctly
  // passes — `canSetModelLive` derives true from the routed mechanism.
  //
  // The D2 protection is NOT gone; it moved to where it can be precise. The gate
  // could only answer "this harness, ever"; the apply arm answers "this model,
  // on this session, against what it actually advertises" — see
  // `test/model-application.test.ts`. Asserting a throw here again would mean
  // re-breaking live model selection for OpenCode.
  assert.doesNotThrow(() => assertLiveModelChangeRoutable(recordFor(AGENT_REGISTRY.opencode)));
  assert.equal(resolveHarnessCapabilities("opencode").canSetModelLive, true);
});

test("the gate still REFUSES a session whose adapter advertises no model option", () => {
  // The surviving refusal, and the reason the gate was not simply deleted: an
  // OpenCode session that advertises config options WITHOUT a selectable `model`
  // cannot have one applied, and must fail before anything is persisted.
  const noModelOption = recordFor(AGENT_REGISTRY.opencode, {
    config_options: [
      { id: "effort", name: "Effort", type: "select", currentValue: "low", options: [] },
    ],
  } as unknown as SessionRecord["acpx"]);
  const error = captureThrow(() => assertLiveModelChangeRoutable(noModelOption));
  assert.match(error.message, /Cannot set the model on this opencode session/);
  assert.match(error.message, /session\/set_config_option/);
  // The user must be told the session is FINE — a loud failure that leaves them
  // believing the session is bricked is only half the fix (row `G1-OC-04`).
  assert.match(error.message, /Nothing was written/);
});

test("a live model change is ALLOWED on every harness acpx can actually route", () => {
  // The positive control: the refusal must not have broken `set model` itself.
  // claude / claude-pty / pi are `set-model`; codex is `compose-into-id`. Both
  // mechanisms are in MODEL_MECHANISMS_ROUTED_BY_ACPX.
  for (const id of ["claude", "claude-pty", "codex", "pi"] as const) {
    assert.doesNotThrow(() => assertLiveModelChangeRoutable(recordFor(AGENT_REGISTRY[id])), id);
  }
});

test("an agent command the descriptor does not know is NOT refused", () => {
  // The gate must not start refusing model changes on adapters it has never
  // classified; those fall through to the pre-existing advertised-models check.
  assert.doesNotThrow(() => assertLiveModelChangeRoutable(recordFor("some-unknown-adapter --acp")));
});

test("the refusal NARROWS with the session's own advertisement, and never widens", () => {
  // Both directions on the SAME harness, which is what makes this a narrowing
  // check rather than two unrelated assertions:
  //  - advertises a selectable `model`  -> allowed (the declared capability holds)
  //  - advertises options but no `model` -> refused (narrowed by the session)
  // The advertisement can make the answer more restrictive, never less.
  const withModel = recordFor(AGENT_REGISTRY.opencode, {
    config_options: [
      { id: "model", name: "Model", type: "select", currentValue: "a", options: [] },
    ],
  } as unknown as SessionRecord["acpx"]);
  assert.doesNotThrow(() => assertLiveModelChangeRoutable(withModel));

  const withoutModel = recordFor(AGENT_REGISTRY.opencode, {
    config_options: [
      { id: "mode", name: "Mode", type: "select", currentValue: "build", options: [] },
    ],
  } as unknown as SessionRecord["acpx"]);
  assert.throws(() => assertLiveModelChangeRoutable(withoutModel));
});
