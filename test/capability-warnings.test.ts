import assert from "node:assert/strict";
import test from "node:test";
import {
  depthRequestUnroutableReason,
  DEPTH_MECHANISMS_ROUTED_BY_ACPX,
  deriveCanSetDepthLive,
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
      // ⚠️ codex: depth rides INSIDE the model id, so the depth control cannot
      // move it. It must KEEP warning — this is `G1-WRN-01`'s positive control,
      // the thing that separates "made it a capability check" from "deleted the
      // check".
      ["codex", "compose-into-id", false],
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
  // ⚠️ THE TWO ANSWERS ARE DIFFERENT QUESTIONS, and taking the wrong one is the
  // subtle version of the same defect. `isDepthRequestRoutable` asks about the
  // MECHANISM; `canSetDepthLive` additionally asks whether THIS session
  // advertised the option. They diverge for any harness with a per-model ladder,
  // whose default (non-reasoning) model does not advertise `effort` at
  // session/new — so warning on that basis would be wrong the moment a reasoning
  // model is pinned, and the message would contradict the behaviour again.
  //
  // Driven through the derivation rather than a table row, because the two
  // answers coincide for every harness shipped today.
  const perModel = {
    ...HARNESS_FACTS.claude.depth,
    mechanism: "config-option",
    ladder: "per-model",
    configOptionAdvertisedAtSessionNew: false,
  } as const;
  assert.equal(DEPTH_MECHANISMS_ROUTED_BY_ACPX.includes(perModel.mechanism), true);
  assert.equal(deriveCanSetDepthLive(perModel, [...DEPTH_MECHANISMS_ROUTED_BY_ACPX]), false);
});

test("the unroutable reason names the mechanism and the verb that DOES work", () => {
  assert.equal(depthRequestUnroutableReason("claude"), null);
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
  // The mutation probe for this derivation: `config-option` and `mode` are the
  // depth mechanisms acpx routes, and that is exactly why claude and pi answer
  // true. If the list is what decides, removing an entry must flip them — which
  // is asserted by construction below rather than by re-reading the same table
  // the function reads.
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
      ["codex", false],
      ["pi", false],
    ],
  );
});

// ── Deliverable 5: `set model` fails loudly and recoverably ──────────────────

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
