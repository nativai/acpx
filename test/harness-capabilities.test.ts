import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { isClaudeFamilyAgent, resolvePrimerChannel } from "../src/acp/agent-command.js";
import {
  ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR,
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
  depthRequestUnroutableReason,
  isDepthRequestRoutable,
  isHarnessId,
  listHarnessCapabilities,
  MODEL_MECHANISMS_ROUTED_BY_ACPX,
  resolveForkLandingIndex,
  resolveHarnessCapabilities,
} from "../src/acp/harness-capabilities.js";
import { supportsMidTurnPromptInjection } from "../src/acp/mid-turn-injection-support.js";
import { RequestedModelUnsupportedError } from "../src/acp/model-support.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { applyRequestedModelIfAdvertised } from "../src/session/model-application.js";

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

test("acceptsArbitraryModelIds: `provisioned` is answered PER HARNESS, every other kind by kind", () => {
  // ⚠️ THE SIGNATURE CHANGED AND SO DID THE MEANING. `provisioned` used to be
  // routed as a KIND, which switched it on for every harness declaring it from a
  // single harness's measurement. Each harness has its own config format and its
  // own merge semantics, so it is one measurement per harness.
  assert.equal(deriveAcceptsArbitraryModelIds("provisioned", "pi", [], ["pi"]), true);
  assert.equal(deriveAcceptsArbitraryModelIds("provisioned", "opencode", [], ["pi"]), false);
  assert.equal(
    deriveAcceptsArbitraryModelIds("provisioned", undefined, [], ["pi"]),
    false,
    "an unnamed harness cannot inherit another's provisioning",
  );
  assert.equal(
    deriveAcceptsArbitraryModelIds("provisioned", "pi", ["provisioned"], []),
    false,
    "the KIND list must not be able to switch provisioning on behind the per-harness list",
  );

  // Every other kind is still answered by kind.
  assert.equal(deriveAcceptsArbitraryModelIds("via-shim", "pi", [], ["pi"]), false);
  assert.equal(deriveAcceptsArbitraryModelIds("via-shim", "pi", ["via-shim"], []), true);
  // `native` needs no acpx work by definition; `none` can never be true.
  assert.equal(deriveAcceptsArbitraryModelIds("native", undefined, [], []), true);
  assert.equal(deriveAcceptsArbitraryModelIds("none", "pi", ["none"], ["pi"]), false);
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

// ⚠️ THIS PROBES THE DISPATCHER, NOT ONE ARM — and that is the whole point.
//
// Before B3 it called `assertRequestedModelSupported` directly, which was then
// the only gate. B3 gave `applyRequestedModelIfAdvertised` a `config-option` arm
// that legitimately BYPASSES that assertion (OpenCode advertises no ACP `models`
// array at all), so a probe aimed at the assertion would now report "not routed"
// for a harness acpx routes perfectly well — a false RED produced by measuring a
// neighbouring question. Call the entry point the product calls.
async function acpxRoutesAModelFor(id: HarnessId): Promise<boolean> {
  const mechanism = HARNESS_FACTS[id].model.mechanism;
  const advertisesAcpModels = ADVERTISES_ACP_MODELS[mechanism];
  const sent: string[] = [];
  const client = {
    setSessionModel: async (_sessionId: string, modelId: string) => {
      sent.push(`set_model:${modelId}`);
    },
    setSessionConfigOption: async (_sessionId: string, configId: string, value: string) => {
      sent.push(`set_config_option:${configId}=${value}`);
      return {};
    },
  };
  try {
    const outcome = await applyRequestedModelIfAdvertised({
      client,
      sessionId: "probe-session",
      requestedModel: "probe-model",
      models: advertisesAcpModels
        ? ({
            currentModelId: "something-else",
            availableModels: [{ modelId: "probe-model", name: "probe" }],
          } as never)
        : undefined,
      // The config-option arm validates against the advertised `model` option,
      // so the probe must advertise one or it measures the validation, not the
      // routing.
      advertisedConfigOptions: [
        {
          id: "model",
          name: "model",
          type: "select",
          currentValue: "something-else",
          options: [{ value: "probe-model", name: "probe" }],
        },
      ] as never,
      agentCommand: DEFAULT_AGENT_COMMANDS[id],
    });
    // ⚠️ Assert the probe REACHED ITS SUBJECT. An outcome of `applied:false` with
    // nothing sent looks identical to a routed apply if only the absence of a
    // throw is checked — the "a control that stops short looks exactly like one
    // that passed" trap. Routed means a wire call actually happened.
    assert.ok(
      outcome.applied && sent.length === 1,
      `${id}: expected exactly one wire call, got ${JSON.stringify(sent)} (applied=${outcome.applied})`,
    );
    return true;
  } catch (error) {
    assert.ok(
      error instanceof RequestedModelUnsupportedError,
      `unexpected error: ${String(error)}`,
    );
    assert.equal(sent.length, 0, `${id}: refused, but a wire call was still made`);
    return false;
  }
}

test("acpx's real model gate agrees with MODEL_MECHANISMS_ROUTED_BY_ACPX for every harness", async () => {
  for (const id of HARNESS_IDS) {
    const declaredRouted = MODEL_MECHANISMS_ROUTED_BY_ACPX.includes(
      HARNESS_FACTS[id].model.mechanism,
    );
    assert.equal(
      await acpxRoutesAModelFor(id),
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
  // B3 landed the apply branch, so acpx DOES route it now — and the capability
  // followed on its own. Neither `HARNESS_FACTS` nor `deriveCanSetModelLive` was
  // edited to achieve that; only the routing list gained an entry, in the same
  // commit as the branch. That is the derivation doing its job.
  assert.equal(MODEL_MECHANISMS_ROUTED_BY_ACPX.includes("config-option"), true);
  const opencode = deriveHarnessCapabilities(HARNESS_FACTS.opencode);
  assert.equal(opencode.canSetModelLive, true);
  // A live capability must not carry a stale padlock reason.
  assert.equal(opencode.liveModelChangeReason, null);
  // The reason is still THERE as a fact, ready if the routing is ever withdrawn —
  // it is suppressed by the derivation, not deleted from the table.
  assert.match(HARNESS_FACTS.opencode.liveModelChangeBlockedReason, /set_config_option/);
  assert.match(HARNESS_FACTS.opencode.liveModelChangeBlockedReason, /unrecoverable|D2/);
  // And the derivation genuinely depends on the list: hand it a list without
  // `config-option` and the answer flips back. This is what proves the boolean
  // is DERIVED and not a literal that happens to read true today.
  assert.equal(deriveCanSetModelLive("config-option", ["set-model"]), false);
  assert.equal(deriveCanSetModelLive("config-option", ["config-option"]), true);
});

test("the depth routing list and acpx's depth dispatcher agree for every harness", () => {
  // Pi's depth mechanism is the ACP mode selector (I2 R8) — measured, not chosen.
  assert.equal(HARNESS_FACTS.pi.depth.mechanism, "mode");
  // B3 landed the mode arm and the list entry together.
  assert.equal(DEPTH_MECHANISMS_ROUTED_BY_ACPX.includes("mode"), true);
  // `isDepthRequestRoutable` is what the CLI's "ignored for agent X" warning
  // dispatches on, so it must now say pi IS reachable — otherwise acpx applies
  // the depth and tells the user on stderr that it did not.
  assert.equal(isDepthRequestRoutable("pi"), true);
  assert.equal(depthRequestUnroutableReason("pi"), null);
  // codex is still unroutable, and for a reason that names the mechanism.
  assert.equal(isDepthRequestRoutable("codex"), false);
  assert.match(String(depthRequestUnroutableReason("codex")), /model id/);
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
  // ⚠️ THREE PI CELLS FLIPPED WITH THE ADAPTER, AND THE CITATION IS WHAT MAKES
  // THAT LEGIBLE. I2 R4 measured `fork` occurring ZERO times in pi-acp 0.0.26 and
  // 0.0.33, and I2 R12 measured no usage over ACP — both true of UPSTREAM and
  // both false of the nativai fork acpx now launches (brick ef5999ca), which
  // implements session/fork on pi's JSONL tree and carries pi's per-message
  // accounting. A cell whose value depends on which adapter is installed must
  // name the adapter, which is why these lines cite the fork rather than a finding
  // number alone.
  assert.equal(HARNESS_FACTS.pi.fork.supported, true);
  // `exact`, because the fork counts the index in CLIENT messages — one
  // tool-using turn writes three pi JSONL records where a client counts one.
  assert.equal(HARNESS_FACTS.pi.fork.atIndex, "exact");
  assert.equal(HARNESS_FACTS.pi.usageReporting, true);
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
  // ⚠️ THESE TWO ANSWER DIFFERENT QUESTIONS, and B3 is where they stop coinciding.
  //
  //  - `resolvePrimerChannel` answers "which ACP `_meta` channel carries the
  //    primer?" — `none` for opencode and pi is CORRECT and permanent: neither
  //    adapter has a `_meta` primer channel to bind to (I1 R9 measured
  //    `_meta.systemPrompt.append` accepted and SILENTLY IGNORED; pi-acp handles
  //    `_meta` only for `terminal-auth` and `piAcp.queueDepth`).
  //  - the descriptor cell answers "how does acpx DELIVER the primer?" — which
  //    for those two is now `config-file`, because B3 writes it there.
  //
  // Asserting equality across all five would force one of the two to lie. The
  // relationship that must hold is: a harness with a `_meta` channel declares
  // exactly that channel; a harness without one declares `config-file` if acpx
  // writes a config dir for it, and `none` only if acpx delivers no primer at all.
  for (const id of HARNESS_IDS) {
    const declared = HARNESS_FACTS[id].primerChannel;
    const metaChannel = resolvePrimerChannel(DEFAULT_AGENT_COMMANDS[id]);
    if (metaChannel !== "none") {
      assert.equal(
        declared,
        metaChannel,
        `${id}: it HAS a _meta primer channel, so the descriptor must name that one`,
      );
      continue;
    }
    assert.equal(
      declared,
      "config-file",
      `${id}: no _meta channel, so the primer must come from the config dir — ` +
        "declaring `none` here means acpx silently delivers no primer at all",
    );
  }
});

test("the config-file cell is the GATE on adapter env, so its population is pinned", () => {
  // This cell decides which harnesses' adapters gain environment variables
  // (src/acp/harness-config-dir.ts). Pinned as a population so widening it is a
  // deliberate, reviewed act rather than a side effect of editing one row —
  // adding a harness here hands its adapter new env entries.
  assert.deepEqual(
    HARNESS_IDS.filter((id) => HARNESS_FACTS[id].primerChannel === "config-file"),
    ["opencode", "pi"],
  );
  // And the three the program requires untouched are NOT in it.
  for (const id of ["claude", "claude-pty", "codex"] as const) {
    assert.notEqual(HARNESS_FACTS[id].primerChannel, "config-file", id);
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
  // claude: exact — the request is the answer
  assert.equal(resolveForkLandingIndex(HARNESS_FACTS.claude.fork, 7), 7);
  // pi: `exact` too, since the fork implements a real index truncation.
  assert.equal(resolveForkLandingIndex(HARNESS_FACTS.pi.fork, 7), 7);
  // opencode ignores the index: the question has no answer there.
  assert.equal(resolveForkLandingIndex(HARNESS_FACTS.opencode.fork, 7), undefined);
});

test("resolveForkLandingIndex boundaries: 0 is a landing index, not an absent answer", () => {
  const codex = HARNESS_FACTS.codex.fork;
  // `0` and `undefined` mean opposite things and a caller acts on both: 0 is
  // "the fork lands at the very start", undefined is "this harness cannot
  // answer". Conflating them is the failure this asserts against.
  assert.equal(resolveForkLandingIndex(codex, 0), 0);
  assert.equal(resolveForkLandingIndex(codex, 1), 0);
  assert.notEqual(resolveForkLandingIndex(codex, 1), undefined);
  assert.equal(resolveForkLandingIndex(HARNESS_FACTS.claude.fork, 0), 0);
  // An index past the end is still answered — clamping to the real message
  // count is the caller's job (acpx already range-checks --at-index at
  // src/cli/session/session-management.ts:409); this function only reports
  // where the HARNESS would round it to.
  assert.equal(resolveForkLandingIndex(codex, 999), 998);
  assert.equal(resolveForkLandingIndex(HARNESS_FACTS.claude.fork, 999), 999);
  assert.equal(resolveForkLandingIndex(HARNESS_FACTS.pi.fork, 0), 0);
  // The no-answer harness stays undefined at every boundary, never 0. ⚠️ pi used
  // to provide a second one and no longer does — one `ignored` harness is the
  // whole population for this arm now, so losing opencode's row would leave it
  // asserting nothing.
  for (const requested of [0, 1, 999]) {
    assert.equal(resolveForkLandingIndex(HARNESS_FACTS.opencode.fork, requested), undefined);
  }
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
  // B3 widened both, each in the same commit as the apply-path branch behind it:
  // `config-option` for the model (applyModelAsConfigOption -> session/set_config_option)
  // and `mode` for depth (applyDepthAsMode -> session/set_mode).
  assert.deepEqual(
    [...MODEL_MECHANISMS_ROUTED_BY_ACPX],
    ["set-model", "compose-into-id", "config-option"],
  );
  assert.deepEqual([...DEPTH_MECHANISMS_ROUTED_BY_ACPX], ["config-option", "mode"]);
  // ⚠️ EMPTY IS THE MECHANISM HERE, NOT A LEFTOVER — and nothing superseded this
  // list. It must STAY empty, which is why the assertion below is a guard rather
  // than a snapshot.
  //
  // The reason it once gave for `provisioned` is now FALSE: it said the
  // per-session config dir had to GENERATE a catalogue fragment first, and B5
  // shipped exactly that — acpx DOES provision for pi today. What did not change
  // is that `provisioned` must not be listed HERE, because this is a list of
  // KINDS and provisioning is answered PER HARNESS:
  //
  //   - `ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX` (harness-capabilities.ts:337)
  //     stays empty by design; its own comment at :338-350 carries the argument.
  //   - `ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR = ["pi", "opencode"]` is a
  //     SECOND, per-harness constant added beside it, and is what actually says
  //     which harnesses acpx provisions for.
  //   - the derivation at :421-423 consults that second list, so the question is
  //     answered per harness rather than per kind.
  //
  // ⚠️ WHY THE SPLIT EXISTS AT ALL, since it is what a future reader would
  // "simplify": each harness has its own config format and its own merge
  // semantics. pi's `models-store.json` is MEASURED to merge by id (brick
  // ef5999ca); OpenCode's `provider.openrouter.models.<slug>` is SEPARATELY
  // measured to deep-merge (brick 4c7a38b2). Listing the KIND would have
  // switched BOTH on from whichever measurement landed first, and one harness's
  // picker would then have offered a band acpx does not provision for. That is
  // the bug the split corrected.
  //
  // ⚠️ BOTH ANSWERS NOW BEING `merge` IS EXACTLY WHEN THIS GUARD LOOKS
  // REDUNDANT, AND IT IS NOT. The next harness to declare `provisioned` would be
  // switched on by a measurement taken against a config format it does not share.
  // Two agreeing data points do not retire the seam.
  //
  // `via-shim` is still genuinely unshipped — the OpenRouter shim would have to
  // take a model from the picker rather than from the profile (CONCEPTION §7.4,
  // §11 Q1) — so that half of the old rationale still holds.
  assert.deepEqual([...ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX], []);
});

test("the SHIPPED per-harness provisioning list is what the derivation defaults to", () => {
  // ⚠️ WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT DUPLICATE. The row above
  // (`acceptsArbitraryModelIds: …`) already exercises the per-harness derivation
  // thoroughly, in both directions — but it INJECTS its lists on every call. So
  // nothing exercised the SHIPPED defaults: a change to
  // `ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR` itself moved no assertion, because
  // every existing row supplies its own list. Adding `"opencode"` to the real
  // constant left the suite green.
  //
  // That matters because the constant is the one the product actually runs on:
  // `deriveHarnessCapabilities` calls the two-argument form, so the shipped list
  // is what reaches the picker. This row calls that same two-argument form.
  //
  // ⚠️ THE BUG IT GUARDS HAS ALREADY BEEN MADE ONCE HERE: a KIND-keyed list
  // switching opencode on from a PI measurement. B5 corrected it by splitting the
  // answer per harness; leaving the replacement list unpinned made the corrected
  // bug re-enterable by hand.
  assert.equal(deriveAcceptsArbitraryModelIds("provisioned", "pi"), true);
  assert.equal(deriveAcceptsArbitraryModelIds("provisioned", "opencode"), true);
  // ⚠️ THE NEGATIVE DIRECTION MOVED, IT WAS NOT DROPPED. `opencode` used to be
  // this row's `false`; now that it is provisioned, a harness that is genuinely
  // NOT on the list has to carry that half, or the row becomes one-sided and
  // "everything is true" would pass it. `codex` is on no provisioning list and
  // is not going to be — its ids are `family[effort]` against a fixed backend.
  assert.equal(
    deriveAcceptsArbitraryModelIds("provisioned", "codex"),
    false,
    "a harness absent from the shipped list must derive false — otherwise this row only ever says yes",
  );
  assert.equal(
    deriveAcceptsArbitraryModelIds("provisioned", undefined),
    false,
    "the kind alone is never enough — that is the whole point of the split",
  );
  assert.deepEqual([...ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR], ["pi", "opencode"]);

  // ⚠️⚠️ THIS GUARD NAMES ITS OWN EXIT CONDITION, ON PURPOSE, so it reads as a
  // CONTRACT rather than an obstacle — and so it cannot go stale the way the
  // rationale two rows above did.
  //
  // pi is listed because its `models-store.json` is MEASURED to merge BY ID
  // (brick ef5999ca): same id replaces, new id appends, and `writePiModelsStore`
  // copies the box's catalogue forward before upserting.
  //
  // opencode is listed because J2's MERGE-VS-REPLACE QUESTION IS ANSWERED, and
  // the answer is MERGE — brick 4c7a38b2, measured 2026-09-06 against OpenCode
  // 1.18.28 on a scratch rig, both layers with their own controls:
  //
  //   - over OpenCode's own catalogue entry, an empty
  //     `provider.openrouter.models.<slug>: {}` preserved
  //     `capabilities.reasoning: true` — the support the `effort` option is
  //     advertised from, and the loss this row used to guard against — plus name,
  //     family, cost and limit; removing the config again restored the baseline;
  //   - over a pre-existing PROJECT-level entry, a user-set `name` SURVIVED the
  //     same declaration, so a spawn does not clobber a user's provider config;
  //   - and the REPLACE outcome was rendered, not merely asserted to be
  //     reachable: the same empty `{}` on a slug OpenCode does not know produces
  //     a visible stub (`reasoning: false`, cost 0, `limit.context` 0).
  //
  // ⇒ **THE EXIT CONDITION STILL STANDS FOR THE NEXT HARNESS.** This list is
  // narrow on purpose; an entry added without its own measurement re-creates the
  // bug B5 fixed, and the fact that two harnesses in a row answered `merge` is
  // not evidence about a third.
});

// ── brick 82a2aafd (discharges 29b8ce8a): the three fields acpx-ui decided by NAME ─
//
// Context for whoever reads a red here: before this block, acpx-ui answered
// `supportsSessionClear` / `canSetCredentialLive` / `supportsModelDegrade` with
// `agentType === "claude"`-shaped checks while taking the descriptor and ignoring
// it — so pi's and opencode's values were measured against NO adapter and no
// adapter swap could ever change them. ZERO test files asserted these three;
// `canSetModelLive` was asserted in two, as the control. These tests are what
// makes the six keys a contract rather than a claim.

const CLEAR_REASON_KEY = "sessionClearReason" as const;
const CREDENTIAL_REASON_KEY = "credentialLiveReason" as const;
const DEGRADE_REASON_KEY = "modelDegradeReason" as const;

const CAPABILITY_REASON_PAIRS = [
  ["supportsSessionClear", CLEAR_REASON_KEY],
  ["canSetCredentialLive", CREDENTIAL_REASON_KEY],
  ["supportsModelDegrade", DEGRADE_REASON_KEY],
] as const;

const NOT_MEASURED = "not measured:";

test("all six keys are PRESENT on all five blocks, and every boolean is a real boolean", () => {
  const capabilities = listHarnessCapabilities();

  // POSITIVE CONTROL, in the same assertion and in the same shape as the
  // permission-field test above: an instrument pointed at [] or at rows missing
  // their populated cells would report "all present" while examining nothing.
  assert.equal(capabilities.length, 5);
  for (const capability of capabilities) {
    assert.ok(
      typeof capability.label === "string" && capability.label.length > 0,
      `${capability.id}: the row itself is not populated — the presence checks below examine nothing`,
    );

    const row = capability as unknown as Record<string, unknown>;
    for (const [booleanKey, reasonKey] of CAPABILITY_REASON_PAIRS) {
      // ABSENCE SEMANTICS ARE FROZEN: the consumer distinguishes "acpx measured a
      // denial" from "this acpx is too old to answer" by whether the KEY EXISTS.
      // A missing key, a null boolean or a placeholder moves its token behaviour
      // from correct to wrong SILENTLY — the only way this contract fails quietly.
      assert.ok(Object.hasOwn(row, booleanKey), `${capability.id}: ${booleanKey} key is absent`);
      assert.ok(Object.hasOwn(row, reasonKey), `${capability.id}: ${reasonKey} key is absent`);
      assert.equal(
        typeof row[booleanKey],
        "boolean",
        `${capability.id}: ${booleanKey} is ${String(row[booleanKey])}, not a boolean`,
      );
      const reason = row[reasonKey];
      assert.ok(
        reason === null || (typeof reason === "string" && reason.trim().length > 0),
        `${capability.id}: ${reasonKey} must be null or a non-empty string, got ${JSON.stringify(reason)}`,
      );
    }
  }

  // And they SERIALIZE — the wire is JSON, and a key that survives an in-memory
  // read but not `JSON.stringify` reaches the consumer as "descriptor absent".
  const wire = JSON.parse(JSON.stringify(capabilities)) as Record<string, unknown>[];
  for (const row of wire) {
    for (const [booleanKey, reasonKey] of CAPABILITY_REASON_PAIRS) {
      assert.ok(
        Object.hasOwn(row, booleanKey),
        `${String(row.id)}: ${booleanKey} lost on the wire`,
      );
      assert.ok(Object.hasOwn(row, reasonKey), `${String(row.id)}: ${reasonKey} lost on the wire`);
    }
  }
});

test("each reason is null IFF its boolean is true — the derivation, in both directions", () => {
  for (const capability of listHarnessCapabilities()) {
    const row = capability as unknown as Record<string, unknown>;
    for (const [booleanKey, reasonKey] of CAPABILITY_REASON_PAIRS) {
      if (row[booleanKey] === true) {
        assert.equal(
          row[reasonKey],
          null,
          `${capability.id}: ${reasonKey} is set while ${booleanKey} is true — a control that works must carry no denial`,
        );
      } else {
        assert.ok(
          typeof row[reasonKey] === "string" && row[reasonKey].length > 20,
          `${capability.id}: ${booleanKey} is false with an empty or generic ${reasonKey} — a padlock with no reason is the silent dead control this table exists to replace`,
        );
      }
    }
  }
});

test("the null-IFF-true rule is the DERIVATION's, not the table's — flipping a fact flips the reason", () => {
  // The regression pin for the structural invariant: `deriveHarnessCapabilities`
  // is the only producer, so this must hold for a synthetic row too — otherwise
  // a future edit could satisfy the table-wide test above by hand-writing nulls.
  const facts = HARNESS_FACTS.pi;

  const denied = deriveHarnessCapabilities({ ...facts, supportsSessionClear: false });
  assert.equal(denied.supportsSessionClear, false);
  assert.equal(denied.sessionClearReason, facts.sessionClearBlockedReason);

  const allowed = deriveHarnessCapabilities({ ...facts, supportsSessionClear: true });
  assert.equal(allowed.supportsSessionClear, true);
  assert.equal(allowed.sessionClearReason, null);

  const credentialAllowed = deriveHarnessCapabilities({ ...facts, canSetCredentialLive: true });
  assert.equal(credentialAllowed.credentialLiveReason, null);
  const degradeAllowed = deriveHarnessCapabilities({ ...facts, supportsModelDegrade: true });
  assert.equal(degradeAllowed.modelDegradeReason, null);

  // The BLOCKED reasons are internal: they must never reach the wire under their
  // own names, or a consumer would read a denial that is not in force.
  const wire = deriveHarnessCapabilities(facts) as unknown as Record<string, unknown>;
  for (const internal of [
    "sessionClearBlockedReason",
    "credentialLiveBlockedReason",
    "modelDegradeBlockedReason",
  ]) {
    assert.equal(Object.hasOwn(wire, internal), false, `${internal} leaked onto the wire`);
  }
});

test("the `not measured:` token accompanies false, never true — and its cell is still a present, real boolean", () => {
  let tokenCells = 0;
  for (const capability of listHarnessCapabilities()) {
    const row = capability as unknown as Record<string, unknown>;
    for (const [booleanKey, reasonKey] of CAPABILITY_REASON_PAIRS) {
      const reason = row[reasonKey];
      if (typeof reason !== "string" || !reason.startsWith(NOT_MEASURED)) {
        continue;
      }
      tokenCells += 1;
      // An honest-unmeasured cell decaying into a confident denial — or worse,
      // into an unmeasured `true` — is the failure mode this pins.
      assert.equal(
        row[booleanKey],
        false,
        `${capability.id}: ${booleanKey} is true while ${reasonKey} says "${NOT_MEASURED}"`,
      );
      assert.ok(
        reason.length > NOT_MEASURED.length + 20,
        `${capability.id}: "${NOT_MEASURED}" must be followed by WHAT is missing, not stand alone`,
      );
      // The token is a PREFIX, never a phrase buried mid-sentence: the consumer
      // separates the three states with `startsWith`.
      assert.equal(
        reason.indexOf(NOT_MEASURED),
        0,
        `${capability.id}: the token must lead the reason`,
      );
    }
  }
  // Control: if nobody is using the token, the assertions above ran on nothing —
  // and an all-measured table is a claim this brick deliberately did not make.
  assert.ok(
    tokenCells > 0,
    "no cell carries the `not measured:` token — the loop asserted nothing",
  );

  // ⚠️ THE LOOP ABOVE CANNOT CATCH THE CASE THIS TEST IS NAMED FOR, AND THAT IS
  // WHY THIS SECOND LOOP EXISTS. Measured, not reasoned: a mutation flipping
  // `pi.supportsSessionClear` false→true left this test GREEN, because the
  // derivation NULLS the reason when the boolean is true — so the `not measured:`
  // string it inspects is exactly the thing that disappears. An honest-unmeasured
  // cell decaying into a confident `true` is invisible on the wire and must be
  // asserted on the FACTS, where the blocked reason is always present.
  let factTokenCells = 0;
  for (const id of HARNESS_IDS) {
    const facts = HARNESS_FACTS[id] as unknown as Record<string, unknown>;
    for (const [booleanKey, reasonKey] of CAPABILITY_REASON_PAIRS) {
      const blockedKey = `${reasonKey.replace(/Reason$/, "")}BlockedReason`;
      const blocked = facts[blockedKey];
      assert.equal(typeof blocked, "string", `${id}: ${blockedKey} must be a plain string`);
      if (!(blocked as string).startsWith(NOT_MEASURED)) {
        continue;
      }
      factTokenCells += 1;
      assert.equal(
        facts[booleanKey],
        false,
        `${id}: ${booleanKey} is true while ${blockedKey} still says "${NOT_MEASURED}" — either measure it and rewrite the reason, or leave it false`,
      );
    }
  }
  assert.ok(
    factTokenCells > 0,
    "no FACTS cell carries the token — the second loop asserted nothing",
  );

  // `descriptor absent:` is the CONSUMER's token for an acpx too old to answer.
  // acpx must never emit it: doing so would make a served descriptor
  // indistinguishable from no descriptor at all.
  assert.equal(
    JSON.stringify(listHarnessCapabilities()).includes("descriptor absent:"),
    false,
    "acpx emitted the consumer's `descriptor absent:` token",
  );
});

test("canSetCredentialLive agrees with the seam acpx actually enforces, per ADAPTER", () => {
  // The behavioural pin, in the same shape as the model-gate test above: the cell
  // is checked against the shipped predicate that would refuse the move, not
  // against a remembered list. `switchSessionAccount` admits a record only through
  // `assertClaudeFamilySeam` → `isClaudeFamilyAgent(record.agentCommand)`
  // (src/runtime/engine/account-seam.ts:187, src/acp/agent-command.ts:226), so a
  // harness declaring `true` that the seam refuses would ship a control that
  // throws, and a harness declaring `false` that the seam admits would hide one
  // that works.
  for (const id of HARNESS_IDS) {
    assert.equal(
      HARNESS_FACTS[id].canSetCredentialLive,
      isClaudeFamilyAgent(DEFAULT_AGENT_COMMANDS[id]),
      `${id}: the declared credential-move capability disagrees with acpx's own seam predicate`,
    );
  }
  // Control on the predicate itself, so a stubbed-out `isClaudeFamilyAgent`
  // returning a constant cannot make the loop pass.
  assert.equal(isClaudeFamilyAgent(DEFAULT_AGENT_COMMANDS.claude), true);
  assert.equal(isClaudeFamilyAgent(DEFAULT_AGENT_COMMANDS.opencode), false);
});

test("canSetCredentialLive is NOT supportsProfiles — codex is the discriminator", () => {
  // The single most likely wrong "simplification" of this field, and the reason
  // the consumer's own note calls it out: `supportsProfiles` asks whether a
  // profile can be bound AT CREATION. codex answers yes to that and no to this,
  // because `transcriptAnchorDir` is null for `chatgpt` (src/config/profiles.ts)
  // and `assertClaudeFamilySeam` refuses the adapter outright.
  assert.equal(HARNESS_FACTS.codex.supportsProfiles, true);
  assert.equal(HARNESS_FACTS.codex.canSetCredentialLive, false);
  assert.match(
    String(deriveHarnessCapabilities(HARNESS_FACTS.codex).credentialLiveReason),
    /Claude-family/,
  );
});

test("no non-Claude-family harness may declare supportsModelDegrade", () => {
  // One-way behavioural pin against the shipped gate. The Fable→Opus degrade is
  // reachable only inside the subscription failover engine, and
  // `selectedProfileId` (src/runtime/engine/failover.ts:520-554) returns undefined
  // for a non-Claude adapter BEFORE reading any stored profile — so
  // `failoverEnabledForRecord` is false and the engine never runs. Declaring
  // `true` there would advertise a degrade that cannot fire.
  for (const id of HARNESS_IDS) {
    if (HARNESS_FACTS[id].supportsModelDegrade) {
      assert.equal(
        isClaudeFamilyAgent(DEFAULT_AGENT_COMMANDS[id]),
        true,
        `${id}: declares a model degrade, but its adapter never enters the failover engine that owns it`,
      );
    }
  }
  assert.equal(HARNESS_FACTS.claude.supportsModelDegrade, true); // control: the loop had a subject
});

test("the three cells are per-harness FACTS, not one answer repeated", () => {
  // The defect being fixed was that all three were `agentType === "claude"`. If a
  // future edit collapses them back onto one answer, this goes red: the three
  // fields must not agree across all five harnesses.
  const rows = listHarnessCapabilities();
  const clear = rows.map((row) => row.supportsSessionClear);
  const credential = rows.map((row) => row.canSetCredentialLive);
  const degrade = rows.map((row) => row.supportsModelDegrade);
  assert.notDeepEqual(
    clear,
    credential,
    "supportsSessionClear and canSetCredentialLive answer identically for all five harnesses — that is the collapsed name check returning",
  );
  assert.deepEqual(clear, degrade); // both are claude-only TODAY; see the row pins below

  // And the per-harness pins, so a silent flip of any one cell is a red rather
  // than a diff nobody reads. Each cites where its value comes from.
  assert.deepEqual(
    rows.map((row) => [row.id, row.supportsSessionClear] as const),
    [
      ["claude", true], // Claude Code 2.1.251 defines the `/clear` slash command
      ["claude-pty", false], // not measured: prompt→TUI slash execution unprobed
      ["codex", false], // not measured
      ["opencode", false], // not measured
      ["pi", false], // not measured, and fork-vs-upstream dependent
    ],
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.canSetCredentialLive] as const),
    [
      ["claude", true], // Claude-family seam + subscription anchor
      ["claude-pty", true], // Claude-family seam + claude-home anchor
      ["codex", false], // seam refuses; chatgpt has no transcript anchor
      ["opencode", false], // box-provider credential; no AuthMode maps to it
      ["pi", false], // box-provider credential; no AuthMode maps to it
    ],
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.supportsModelDegrade] as const),
    [
      ["claude", true], // brick://4d517be2, the harness the path was built for
      ["claude-pty", false], // not measured: gate admits it, trigger looks unreachable
      ["codex", false], // chatgpt profile never enters the failover engine
      ["opencode", false], // non-Claude adapter never enters the failover engine
      ["pi", false], // non-Claude adapter never enters the failover engine
    ],
  );
});

test("the reason-key NAMING RULE holds, and its one legacy exception is still the only one", () => {
  // The rule: strip the capability prefix (`supports` / `canSet`), add `Reason`.
  // Written as a test so the NEXT field answers itself instead of being guessed.
  const row = deriveHarnessCapabilities(HARNESS_FACTS.opencode) as unknown as Record<
    string,
    unknown
  >;
  for (const [booleanKey, reasonKey] of CAPABILITY_REASON_PAIRS) {
    const stripped = booleanKey.replace(/^(supports|canSet)/, "");
    const expected = `${stripped.charAt(0).toLowerCase()}${stripped.slice(1)}Reason`;
    assert.equal(reasonKey, expected, `${booleanKey}'s reason key breaks the naming rule`);
    assert.ok(Object.hasOwn(row, expected));
  }
  // THE NAMED EXCEPTION: `canSetModelLive` would give `modelLiveReason` under the
  // rule and is `liveModelChangeReason` instead — a legacy one-off, deliberately
  // NOT renamed because it is on the wire and consumed. Pinned so the exception
  // stays exactly one field wide: if a later edit "fixes" the name for symmetry,
  // this goes red and the consumer is not broken silently.
  assert.ok(Object.hasOwn(row, "liveModelChangeReason"));
  assert.equal(Object.hasOwn(row, "modelLiveReason"), false);
});
