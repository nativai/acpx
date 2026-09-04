import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { resolvePrimerChannel } from "../src/acp/agent-command.js";
import {
  ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX,
  DEPTH_MECHANISMS_ROUTED_BY_ACPX,
  deriveAcceptsArbitraryModelIds,
  deriveCanSetDepthLive,
  deriveCanSetModelLive,
  deriveDefaultModelKey,
  deriveHarnessCapabilities,
  HARNESS_FACTS,
  HARNESS_IDS,
  type HarnessId,
  isHarnessId,
  listHarnessCapabilities,
  MODEL_MECHANISMS_ROUTED_BY_ACPX,
  resolveForkLandingIndex,
  resolveHarnessCapabilities,
} from "../src/acp/harness-capabilities.js";
import { supportsMidTurnPromptInjection } from "../src/acp/mid-turn-injection-support.js";
import {
  assertRequestedModelSupported,
  RequestedModelUnsupportedError,
} from "../src/acp/model-support.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";

// The command strings acpx's registry launches by default, written out here
// rather than read from AGENT_REGISTRY for claude/codex/claude-pty: those three
// entries are env-overridable (ACPX_*_ACP_COMMAND), and a test that read the env
// would measure the box instead of the product.
const DEFAULT_AGENT_COMMANDS: Record<HarnessId, string> = {
  claude: "node /opt/claude-agent-acp/dist/index.js",
  "claude-pty": "node /opt/claude-pty-acp/dist/index.js",
  codex: "node /opt/codex-acp/dist/index.js",
  opencode: AGENT_REGISTRY.opencode,
  pi: AGENT_REGISTRY.pi,
};

function selectOption(id: string): SessionConfigOption {
  return {
    id,
    name: id,
    category: "thought_level",
    type: "select",
    currentValue: "low",
    availableValues: [{ value: "low", name: "low" }],
  } as unknown as SessionConfigOption;
}

test("the table declares exactly the five program harnesses", () => {
  assert.deepEqual([...HARNESS_IDS], ["claude", "claude-pty", "codex", "opencode", "pi"]);
  assert.deepEqual(
    listHarnessCapabilities().map((capability) => capability.id),
    [...HARNESS_IDS],
  );
  assert.equal(isHarnessId("opencode"), true);
  assert.equal(isHarnessId("gemini"), false);
});

// ── G1-CFG-04: canSetModelLive is DERIVED, not hand-written ──────────────────
//
// The type system already makes a literal impossible (HarnessCapabilityFacts
// Omits the derived fields), but a type error is not observable from a test, so
// this drives the derivation itself with synthetic routing lists and requires
// the answer to FLIP. A test that only read the shipped values could not tell a
// derivation from a literal.

test("canSetModelLive flips with the routed-mechanism list, in both directions", () => {
  // opencode's declared mechanism, with acpx NOT routing it -> false (today)
  assert.equal(deriveCanSetModelLive("config-option", ["set-model"]), false);
  // the same mechanism, with acpx routing it -> true (after B3, no table edit)
  assert.equal(deriveCanSetModelLive("config-option", ["set-model", "config-option"]), true);
  // a mechanism that is not a live change at all stays false however it is routed
  assert.equal(deriveCanSetModelLive("none", ["none", "set-model"]), false);
  // and a live mechanism acpx routes is true
  assert.equal(deriveCanSetModelLive("set-model", ["set-model"]), true);
});

test("canSetDepthLive flips with the routed list AND with the session/new advertisement", () => {
  const openCodeShape = HARNESS_FACTS.opencode.depth;
  assert.equal(deriveCanSetDepthLive(openCodeShape, ["config-option"]), false);
  assert.equal(
    deriveCanSetDepthLive({ ...openCodeShape, configOptionAdvertisedAtSessionNew: true }, [
      "config-option",
    ]),
    true,
  );
  // pi rides ACP modes: live only once acpx's depth path grows a `mode` arm.
  assert.equal(deriveCanSetDepthLive(HARNESS_FACTS.pi.depth, ["config-option"]), false);
  assert.equal(deriveCanSetDepthLive(HARNESS_FACTS.pi.depth, ["config-option", "mode"]), true);
  // codex's depth is a property of the model id — never a live depth control.
  assert.equal(
    deriveCanSetDepthLive(HARNESS_FACTS.codex.depth, ["config-option", "mode", "compose-into-id"]),
    false,
  );
});

test("acceptsArbitraryModelIds flips with the routed provisioning list", () => {
  assert.equal(deriveAcceptsArbitraryModelIds("provisioned", []), false);
  assert.equal(deriveAcceptsArbitraryModelIds("provisioned", ["provisioned"]), true);
  assert.equal(deriveAcceptsArbitraryModelIds("via-shim", []), false);
  assert.equal(deriveAcceptsArbitraryModelIds("via-shim", ["via-shim"]), true);
  // `native` needs no acpx work by definition; `none` can never be true.
  assert.equal(deriveAcceptsArbitraryModelIds("native", []), true);
  assert.equal(deriveAcceptsArbitraryModelIds("none", ["none"]), false);
});

test("defaultModelKey is composed from the (source, id) pair, never hand-written", () => {
  assert.equal(
    deriveDefaultModelKey({ source: "openrouter", id: "z-ai/glm-5.3-flash" }),
    "openrouter:z-ai/glm-5.3-flash",
  );
  for (const id of HARNESS_IDS) {
    const facts = HARNESS_FACTS[id];
    assert.equal(
      deriveHarnessCapabilities(facts).defaultModelKey,
      `${facts.defaultModel.source}:${facts.defaultModel.id}`,
    );
  }
});

// ── The two-way pin between the routing list and acpx's REAL apply gate ──────
//
// This is what stops MODEL_MECHANISMS_ROUTED_BY_ACPX becoming a second,
// drifting source of truth. It CALLS the gate (assertRequestedModelSupported,
// the predicate applyRequestedModelIfAdvertised runs unconditionally) with each
// harness's advertised shape and requires the answer to agree with the list.
// Adding "config-option" to the list without landing the apply branch goes red;
// landing the branch without updating the list goes red too.

// Whether the harness's `session/new` carries an ACP `models` array at all —
// the wire fact acpx's gate keys on. `set-model` and `compose-into-id` both do
// (codex advertises `listModels` cross-producted into `model[effort]` ids, MAP
// §3.1); `config-option` does not (I1 R5/R11 — no `models`, no
// `session/set_model`), and neither does `none`.
const ADVERTISES_ACP_MODELS: Record<string, boolean> = {
  "set-model": true,
  "compose-into-id": true,
  "config-option": false,
  none: false,
};

function acpxRoutesAModelFor(id: HarnessId): boolean {
  const advertisesAcpModels = ADVERTISES_ACP_MODELS[HARNESS_FACTS[id].model.mechanism] === true;
  try {
    assertRequestedModelSupported({
      requestedModel: "probe-model",
      models: advertisesAcpModels
        ? ({ availableModels: [{ modelId: "probe-model", name: "probe" }] } as never)
        : undefined,
      agentCommand: DEFAULT_AGENT_COMMANDS[id],
      context: "apply",
    });
    return true;
  } catch (error) {
    assert.ok(
      error instanceof RequestedModelUnsupportedError,
      `unexpected error: ${String(error)}`,
    );
    return false;
  }
}

test("acpx's real model gate agrees with MODEL_MECHANISMS_ROUTED_BY_ACPX for every harness", () => {
  for (const id of HARNESS_IDS) {
    const declaredRouted = MODEL_MECHANISMS_ROUTED_BY_ACPX.includes(
      HARNESS_FACTS[id].model.mechanism,
    );
    assert.equal(
      acpxRoutesAModelFor(id),
      declaredRouted,
      `${id}: the routing list says routed=${declaredRouted} but acpx's model gate disagrees. ` +
        "Either the apply path grew a branch and the list was not updated, or the list gained a " +
        "mechanism with no branch behind it.",
    );
  }
});

test("the mechanism a harness needs and the mechanism acpx routes are separate facts", () => {
  // OpenCode's HARNESS mechanism is config-option (I1 R5) — that is a measured
  // property of OpenCode and must not be edited to make a boolean come out.
  assert.equal(HARNESS_FACTS.opencode.model.mechanism, "config-option");
  // acpx does NOT route it today; that is the reason the capability is false.
  assert.equal(MODEL_MECHANISMS_ROUTED_BY_ACPX.includes("config-option"), false);
  const opencode = deriveHarnessCapabilities(HARNESS_FACTS.opencode);
  assert.equal(opencode.canSetModelLive, false);
  assert.notEqual(opencode.liveModelChangeReason, null);
  // The reason a user reads beside the padlock must name the situation, not be generic.
  assert.match(String(opencode.liveModelChangeReason), /set_config_option/);
  assert.match(String(opencode.liveModelChangeReason), /unrecoverable|D2/);
});

test("a live capability never carries a stale reason string", () => {
  for (const capability of listHarnessCapabilities()) {
    if (capability.canSetModelLive) {
      assert.equal(capability.liveModelChangeReason, null, capability.id);
    } else {
      assert.ok(
        (capability.liveModelChangeReason ?? "").length > 20,
        `${capability.id}: a padlock with an empty or generic reason is worse than no padlock`,
      );
    }
  }
});

// ── Per-harness cells that encode a measured fact ────────────────────────────

test("per-harness mechanism cells match the findings they cite", () => {
  // I1 R5/R11 — no ACP `models` array, no session/set_model; model is a config option
  assert.equal(HARNESS_FACTS.opencode.model.mechanism, "config-option");
  // I1 R8 — effort is a config option, per-model, absent at session/new
  assert.equal(HARNESS_FACTS.opencode.depth.mechanism, "config-option");
  assert.equal(HARNESS_FACTS.opencode.depth.ladder, "per-model");
  assert.equal(HARNESS_FACTS.opencode.depth.configOptionAdvertisedAtSessionNew, false);
  // I2 R5 — live via session/set_model, proven three ways
  assert.equal(HARNESS_FACTS.pi.model.mechanism, "set-model");
  // I2 R8 — configOptions is null; depth rides the ACP mode selector
  assert.equal(HARNESS_FACTS.pi.depth.mechanism, "mode");
  // I1 R4 — the fork silently full-copies while acpx records a truncation
  assert.equal(HARNESS_FACTS.opencode.fork.atIndex, "ignored");
  assert.equal(HARNESS_FACTS.opencode.fork.supported, true);
  // I2 R4 — `fork` occurs zero times in pi-acp 0.0.26 AND 0.0.33
  assert.equal(HARNESS_FACTS.pi.fork.supported, false);
  assert.equal(HARNESS_FACTS.pi.fork.atIndex, "unsupported");
  // I2 R12 — pi-acp carries no usage over ACP
  assert.equal(HARNESS_FACTS.pi.usageReporting, false);
  // MAP §3.1 — codex has zero outputStyle references
  assert.equal(HARNESS_FACTS.codex.supportsOutputStyles, false);
  // MAP §2.2 — no AuthMode maps to a fourth harness
  assert.equal(HARNESS_FACTS.opencode.supportsProfiles, false);
  assert.equal(HARNESS_FACTS.pi.supportsProfiles, false);
  assert.equal(HARNESS_FACTS.opencode.credential.tier, "box-provider");
  assert.deepEqual(HARNESS_FACTS.pi.credential.providers, ["openrouter"]);
});

test("midTurnSteering agrees with acpx's own injection predicate", () => {
  for (const id of HARNESS_IDS) {
    assert.equal(
      HARNESS_FACTS[id].midTurnSteering,
      supportsMidTurnPromptInjection(DEFAULT_AGENT_COMMANDS[id]),
      `${id}: the declared cell and src/acp/mid-turn-injection-support.ts disagree`,
    );
  }
});

test("primerChannel agrees with the channel acpx actually resolves", () => {
  for (const id of HARNESS_IDS) {
    assert.equal(
      HARNESS_FACTS[id].primerChannel,
      resolvePrimerChannel(DEFAULT_AGENT_COMMANDS[id]),
      `${id}: the declared cell and resolvePrimerChannel disagree. A harness whose primer path ` +
        "exists but is not wired declares `none` until acpx writes it.",
    );
  }
});

// ── IR-5: the negative assertion carries its positive control ────────────────

test("no descriptor entry carries a permission field — asserted on a populated table", () => {
  const capabilities = listHarnessCapabilities();
  const serialized = JSON.stringify(capabilities);

  // POSITIVE CONTROL, in the same assertion: the object under test is populated
  // and a field that MUST be present parses out. Without this, an instrument
  // pointed at [] or null would report "no permission field" and pass.
  assert.ok(capabilities.length >= 5);
  for (const capability of capabilities) {
    assert.ok(
      typeof capability.fork.atIndex === "string" && capability.fork.atIndex.length > 0,
      `${capability.id}: fork.atIndex missing — the absence check below would be examining nothing`,
    );
    for (const forbidden of ["permissionModel", "permissions", "permissionPolicy"]) {
      assert.equal(
        Object.hasOwn(capability as unknown as Record<string, unknown>, forbidden),
        false,
        `${capability.id} carries "${forbidden}" — Daniel's 2026-09-03 23:17Z ruling drops it`,
      );
    }
  }
  assert.equal(
    /permission/i.test(serialized),
    false,
    "the serialized descriptor mentions permissions somewhere",
  );
});

// ── Runtime refinement ───────────────────────────────────────────────────────

test("with no session the resolver returns the declared table verbatim", () => {
  for (const id of HARNESS_IDS) {
    assert.deepEqual(resolveHarnessCapabilities(id), deriveHarnessCapabilities(HARNESS_FACTS[id]));
  }
});

test("a runtime advertisement can only NARROW a declared capability, never widen it", () => {
  const advertisements = [
    undefined,
    { configOptions: [] },
    { configOptions: [selectOption("effort")] },
    { configOptions: [selectOption("model")] },
    { configOptions: [selectOption("model"), selectOption("effort"), selectOption("mode")] },
  ];
  for (const id of HARNESS_IDS) {
    const declared = resolveHarnessCapabilities(id);
    for (const advertisement of advertisements) {
      const refined = resolveHarnessCapabilities(id, advertisement);
      if (refined.canSetModelLive) {
        assert.equal(declared.canSetModelLive, true, `${id}: refinement widened canSetModelLive`);
      }
      if (refined.canSetDepthLive) {
        assert.equal(declared.canSetDepthLive, true, `${id}: refinement widened canSetDepthLive`);
      }
    }
  }
});

test("refinement narrows a config-option capability the session did not advertise", () => {
  // Claude's depth IS a config option and IS live in the declared table; a
  // session whose adapter advertised nothing must not be shown a live control.
  assert.equal(resolveHarnessCapabilities("claude").canSetDepthLive, true);
  assert.equal(resolveHarnessCapabilities("claude", { configOptions: [] }).canSetDepthLive, false);
  assert.equal(
    resolveHarnessCapabilities("claude", { configOptions: [selectOption("effort")] })
      .canSetDepthLive,
    true,
  );
  // A `set-model` harness is not touched by the config-option refinement.
  assert.equal(resolveHarnessCapabilities("pi", { configOptions: [] }).canSetModelLive, true);
});

// ── fork.atIndex is actionable data, not prose ───────────────────────────────

test("resolveForkLandingIndex answers where a fork will actually land", () => {
  // codex: turn-granular, 2 messages per turn, rounds down — asking for 7 lands at 6
  const codex = HARNESS_FACTS.codex.fork;
  assert.equal(resolveForkLandingIndex(codex, 7), 6);
  assert.equal(resolveForkLandingIndex(codex, 6), 6);
  assert.equal(resolveForkLandingIndex(codex, 1), 0);
  // claude: exact — the request is the answer
  assert.equal(resolveForkLandingIndex(HARNESS_FACTS.claude.fork, 7), 7);
  // opencode ignores the index and pi has no fork at all: the question has no answer
  assert.equal(resolveForkLandingIndex(HARNESS_FACTS.opencode.fork, 7), undefined);
  assert.equal(resolveForkLandingIndex(HARNESS_FACTS.pi.fork, 7), undefined);
});

test("only a turn-granular harness carries the rounding data, and it carries all of it", () => {
  for (const id of HARNESS_IDS) {
    const fork = HARNESS_FACTS[id].fork;
    if (fork.atIndex === "turn-granular") {
      assert.ok(
        (fork.atIndexGranularityMessages ?? 0) > 0,
        `${id}: turn-granular without a granularity is unactionable prose`,
      );
      assert.ok(fork.atIndexRounding !== undefined, `${id}: turn-granular without a rounding rule`);
    } else {
      assert.equal(fork.atIndexGranularityMessages, undefined, id);
      assert.equal(fork.atIndexRounding, undefined, id);
    }
  }
});

test("the routed lists are the ones the shipped code has branches for", () => {
  // Pinned literally so a widening is a deliberate, visible change reviewed
  // alongside the apply-path branch that justifies it. The behavioural
  // agreement with the real gate is asserted above.
  assert.deepEqual([...MODEL_MECHANISMS_ROUTED_BY_ACPX], ["set-model", "compose-into-id"]);
  assert.deepEqual([...DEPTH_MECHANISMS_ROUTED_BY_ACPX], ["config-option"]);
  assert.deepEqual([...ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX], []);
});
