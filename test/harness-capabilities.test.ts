import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { resolvePrimerChannel } from "../src/acp/agent-command.js";
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
  //   - `ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR = ["pi"]` (:360) is a SECOND,
  //     per-harness constant added beside it, and is what actually says acpx
  //     provisions for pi.
  //   - the derivation at :421-423 consults that second list, so the question is
  //     answered per harness rather than per kind.
  //
  // ⚠️ WHY THE SPLIT EXISTS AT ALL, since it is what a future reader would
  // "simplify": each harness has its own config format and its own merge
  // semantics. pi's `models-store.json` is MEASURED to merge by id; whether
  // opencode deep-merges or REPLACES an existing
  // `provider.openrouter.models.<slug>` entry is NOT measured. Listing the KIND
  // would switch BOTH on from one harness's measurement, and opencode's picker
  // would then offer a band acpx does not provision for. That is the bug the
  // split corrected.
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
  assert.equal(deriveAcceptsArbitraryModelIds("provisioned", "opencode"), false);
  assert.equal(
    deriveAcceptsArbitraryModelIds("provisioned", undefined),
    false,
    "the kind alone is never enough — that is the whole point of the split",
  );
  assert.deepEqual([...ARBITRARY_MODEL_PROVISIONING_ROUTED_FOR], ["pi"]);

  // ⚠️⚠️ THIS GUARD NAMES ITS OWN EXIT CONDITION, ON PURPOSE, so it reads as a
  // CONTRACT rather than an obstacle — and so it cannot go stale the way the
  // rationale two rows above did.
  //
  // pi is listed because its `models-store.json` is MEASURED to merge BY ID
  // (brick ef5999ca): same id replaces, new id appends, and `writePiModelsStore`
  // copies the box's catalogue forward before upserting.
  //
  // **THE ONE MEASUREMENT THAT LICENSES ADDING `"opencode"` IS J2's
  // MERGE-VS-REPLACE ANSWER:** does an empty
  // `provider.openrouter.models.<slug>: {}` DEEP-MERGE with OpenCode's bundled
  // entry, or REPLACE it? If it replaces, the model loses the `reasoning` support
  // its `effort` option is advertised from, and depth silently stops working for
  // every pinned model.
  //
  // ⇒ **When J2 answers MERGE, change this row and cite that measurement.** Do
  // not delete it because it is in the way; the list is deliberately narrow, and
  // an entry added without its measurement re-creates the bug B5 fixed.
});
