import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildCatalogue } from "../src/models/catalogue.js";
import {
  assertModelPolicy,
  CLAUDE_FAMILY_OPENROUTER_REASON,
  ClaudeFamilyOnOpenRouterError,
  claudeFamilyOnOpenRouterMessage,
  isClaudeFamilyModelId,
} from "../src/models/claude-family.js";
import { ModelSlugError, validateModelSelection } from "../src/models/model-slug-validation.js";
import type { OpenRouterSnapshot } from "../src/models/openrouter-catalogue.js";
import type { CatalogueModel } from "../src/models/types.js";

/**
 * CONTROL ④ — THE PERMANENT NEGATIVE TEST for brick 30eb2003.
 *
 * An attempt to start a session on a Claude-family model via OpenRouter MUST fail.
 * This file is the assertion of that guarantee and it lives in the suite forever:
 * it carries its own negative inputs, so it costs one run per suite and keeps
 * proving the property long after the commit that introduced it.
 *
 * ## What happened, so nobody deletes this as redundant
 *
 * We paid OpenRouter's metered price (~$12.65) for Claude Sonnet 5, a model our
 * subscriptions already serve at no marginal cost. The spawning agent QUOTED the
 * green-list rule in its own thinking, flagged it, and waived it — it read a
 * request for a MODEL as authorisation for a ROUTE it had itself chosen. Told its
 * first spelling was unknown, it followed acpx's own `try: acpx models --search
 * sonnet` hint, found a spelling that worked, and spent the money.
 *
 * **It happened TWICE, 38 seconds apart, in one programme** — a `pi` spawn on
 * `openrouter/anthropic/claude-sonnet-5` at 19:41:37Z, then a `claude` re-spawn on
 * `anthropic/claude-sonnet-5` at 19:42:15Z. A claude-only control would have
 * refused the second and left the first running. That is why the enforcement is
 * harness-agnostic.
 *
 * ## The three spellings
 *
 *   openrouter:anthropic/claude-sonnet-5   COLON
 *   anthropic/claude-sonnet-5              BARE    ← the claude half of the incident
 *   openrouter/anthropic/claude-sonnet-5   SLASH   ← the pi half; was refused as a TYPO
 *
 * ## ⚠️ WHAT GOES RED IF EACH TIER IS DELETED
 *
 *   delete `assertModelPolicy`'s throw (P0, THE ENFORCEMENT)
 *       → "P0 —" blocks, every one of them
 *   delete the Tier 1 gate in `validateModelSelection`
 *       → "Tier 1 —" blocks; above all "the SLASH form gets OUR refusal"
 *   delete the Tier 3 branch in `availabilityFor`
 *       → "Tier 3 —" blocks
 *   broaden the predicate so it catches native aliases
 *       → every "POSITIVE CONTROL" block
 *   trim the `/` / namespace requirement out of the predicate
 *       → "a bare claude-* alias is NOT refused" — the 2-versus-2 boundary on live
 *         ids, and the one trim that would INVERT this control rather than weaken it
 *   swap the descriptor gate back to the agent NAME
 *       → "a custom agent NAME does not defeat the policy"
 *   restore the false key-level claim to the message
 *       → "the message never claims the KEY denies Claude-family slugs"
 *
 * Every refusal assertion is paired with a POSITIVE CONTROL on the same call shape,
 * so no row can pass merely because its code path was never reached.
 */

// Same fixture + cwd rule as the sibling route tests: the suite runs the COMPILED
// tests out of dist-test/, where the fixture folder does not exist.
const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/openrouter-models-2026-09-04.json");
const META = { fetchedAt: "2026-09-04T00:10:56.992Z", stale: false, error: null };

/**
 * ⚠️ THE REAL PRODUCTION AGENT COMMANDS, NOT SYNTHETIC ONES.
 *
 * acpx's test fixtures conventionally use synthetic commands (`"agent"`,
 * `"claude"`, `"node claude-agent.js"`) that NO real record carries — so an
 * adapter-keyed predicate can pass its whole suite against shapes that never occur
 * in production, and fail in BOTH directions. The Tier 1 gate IS adapter-keyed, so
 * these are sampled from this box's live session store (2026-09-28, 400 records:
 * 169 codex, 137 pi, 43 claude) and each is asserted to resolve to its harness id
 * below, so the sampling cannot silently go stale.
 */
const REAL_CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const REAL_PI_COMMAND = "node /opt/pi-acp/dist/index.js";
const REAL_CODEX_COMMAND = "node /opt/codex-acp/dist/index.js";
/** Also real — one live record carries an agent command the descriptor cannot classify. */
const UNCLASSIFIED_COMMAND = "my-real-bespoke-agent";

/** A WARM cache — the OpenRouter roster is loaded, so the catalogue can answer. */
function warmCatalogue() {
  const snapshot = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as OpenRouterSnapshot;
  return buildCatalogue(snapshot.models, META);
}

/**
 * A COLD cache — harness-native rows only, no OpenRouter rows at all. This is the
 * state in which the catalogue-driven checks stand aside, and therefore the state
 * in which a catalogue-DERIVED family test would be silently absent. The refusal
 * must not depend on it.
 */
function coldCatalogue() {
  return buildCatalogue([], { fetchedAt: null, stale: false, error: null });
}

/** The incident's own model, in all three spellings. */
const THREE_SPELLINGS = [
  "openrouter:anthropic/claude-sonnet-5",
  "anthropic/claude-sonnet-5",
  "openrouter/anthropic/claude-sonnet-5",
] as const;

/** Green-listed, non-Claude, and present in the fixture — the positive control model. */
const GREEN_LISTED = "z-ai/glm-5.3-flash";

function detailCodeOf(error: unknown): string | undefined {
  return (error as { detailCode?: string } | undefined)?.detailCode;
}

function captureThrow(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

// ── The fixtures are the real shapes ─────────────────────────────────────────

test("the sampled agent commands are the REAL ones and resolve to their harness", async () => {
  // Guards the whole adapter-keyed half of this file: if acpx's adapter detection
  // changes, every Tier 1 row below would quietly start exercising `undefined` —
  // which stands aside — and pass while testing nothing.
  const { harnessIdForAgentCommand } = await import("../src/acp/harness-capabilities.js");
  assert.equal(harnessIdForAgentCommand(REAL_CLAUDE_COMMAND), "claude");
  assert.equal(harnessIdForAgentCommand(REAL_PI_COMMAND), "pi");
  assert.equal(harnessIdForAgentCommand(REAL_CODEX_COMMAND), "codex");
  assert.equal(harnessIdForAgentCommand(UNCLASSIFIED_COMMAND), undefined);
});

// ── The predicate ────────────────────────────────────────────────────────────

test("the family predicate fires on all three spellings and across the family", () => {
  for (const spelling of THREE_SPELLINGS) {
    assert.equal(isClaudeFamilyModelId(spelling), true, spelling);
  }
  for (const id of [
    "anthropic/claude-opus-5",
    "anthropic/claude-haiku-4.5",
    "anthropic/claude-fable-5.1",
    "anthropic/claude-sonnet-5:batch", // OpenRouter's own suffix survives parseModelRef
    "~anthropic/claude-opus-latest", // OpenRouter's floating-alias row shape
    "ANTHROPIC/CLAUDE-SONNET-5", // case-insensitive
    "  anthropic/claude-sonnet-5  ", // trimmed
    "anthropic/something-unnamed", // second arm: the namespace alone is enough
  ]) {
    assert.equal(isClaudeFamilyModelId(id), true, id);
  }
});

test("POSITIVE CONTROL: the predicate does NOT fire on a claude-native alias", () => {
  // ⚠️ THE ROW THAT MATTERS MOST. These are what every ordinary claude session runs
  // on. A predicate that merely looked for "claude" — or that dropped the namespace
  // requirement — would refuse every claude spawn on this box, at session creation,
  // where it is maximally disruptive.
  for (const native of ["sonnet", "opus", "haiku", "fable", "default", "opus[1m]", "sonnet[1m]"]) {
    assert.equal(isClaudeFamilyModelId(native), false, native);
  }
  for (const other of [GREEN_LISTED, "deepseek/deepseek-v4.1-flash", "openai/gpt-6", "", "   "]) {
    assert.equal(isClaudeFamilyModelId(other), false, other);
  }
  assert.equal(isClaudeFamilyModelId(undefined), false);
  assert.equal(isClaudeFamilyModelId(null), false);
});

test("POSITIVE CONTROL: a bare claude-* alias is NOT refused — refusing it would INVERT this control", () => {
  // 🛑 DO NOT FOLD THIS BACK INTO THE MIXED LIST ABOVE, AND DO NOT "TIDY" THE `/`
  // REQUIREMENT OUT OF THE PREDICATE. THIS ROW IS THE BOUNDARY.
  //
  // `claude-fable-5` and `claude-fable-5-1` are LIVE model ids on this box and they
  // carry NO namespace. A bare alias is a SUBSCRIPTION model at zero marginal cost
  // — the free path this entire control exists to push work TOWARD.
  //
  // So refusing one would not merely be disruptive. **It would INVERT the control:**
  // it would push work OFF the free subscription and ONTO the metered OpenRouter
  // route this brick exists to prevent — causing precisely the spend it was built
  // to stop.
  //
  // Measured 2026-09-28 across the whole live session store: of the 4 ids
  // containing "claude", exactly 2 carry a namespace and exactly 2 do not —
  //
  //   openrouter/anthropic/claude-sonnet-5   namespaced  → MUST be refused (the incident)
  //   anthropic/claude-sonnet-5              namespaced  → MUST be refused (the incident)
  //   claude-fable-5-1                       bare        → must NOT be refused
  //   claude-fable-5                         bare        → must NOT be refused
  //
  // The `/` requirement IS that 2-versus-2 boundary, on real records rather than
  // fixtures. It is the only thing separating the sessions we must refuse from the
  // sessions we must not touch.
  for (const bareAlias of ["claude-fable-5", "claude-fable-5-1"]) {
    assert.equal(
      isClaudeFamilyModelId(bareAlias),
      false,
      `${bareAlias} is a subscription alias at no marginal cost — refusing it inverts the control`,
    );
    // …and the enforcement itself must let it through, for every harness.
    for (const agentCommand of [REAL_CLAUDE_COMMAND, REAL_PI_COMMAND, undefined]) {
      assert.doesNotThrow(
        () => assertModelPolicy(agentCommand, bareAlias),
        `${String(agentCommand)} / ${bareAlias} must spawn`,
      );
    }
  }
});

// ── P0 — the enforcement, on the spawn path ──────────────────────────────────

test("P0 — every harness is refused, on all three spellings", () => {
  // ★ THE ENFORCEMENT ROW. Harness-agnostic by construction, so a harness added
  // later is covered without anyone remembering to add it — including the
  // `undefined` descriptor, which is a real shape on this box.
  for (const agentCommand of [
    REAL_CLAUDE_COMMAND,
    REAL_PI_COMMAND,
    REAL_CODEX_COMMAND,
    UNCLASSIFIED_COMMAND,
    undefined,
  ]) {
    for (const model of THREE_SPELLINGS) {
      const error = captureThrow(() => assertModelPolicy(agentCommand, model));
      assert.ok(
        error instanceof ClaudeFamilyOnOpenRouterError,
        `${String(agentCommand)} / ${model} must be refused, got ${String(error)}`,
      );
      assert.equal(detailCodeOf(error), "CLAUDE_FAMILY_ON_OPENROUTER");
      // The agent's own spelling is echoed back.
      assert.ok(error.message.includes(`refusing --model "${model}"`), model);
    }
  }
});

test("P0 — it needs NO catalogue, which is the cold-cache hole it exists to close", () => {
  // 🛑 THE CASE TIER 1 STRUCTURALLY CANNOT COVER, and the whole reason P0 is
  // separate from it.
  //
  // Tier 1 runs only on an EXPLICIT `--model` flag. An inherited child, a
  // `sessions copy`/fork, a `--from-template` spawn and a resume all carry the
  // model in `sessionOptions` WITHOUT passing the flag, so they never reach Tier 1
  // at all (brick 61731179). And for pi the fallback is not safe: pi's provisioning
  // never consults acpx's catalogue, so a cold cache would otherwise provision it
  // straight onto the Claude model with no refusal anywhere.
  //
  // `assertModelPolicy` takes no catalogue argument and reads none — asserted here
  // by calling it with nothing loaded at all.
  for (const agentCommand of [REAL_PI_COMMAND, REAL_CLAUDE_COMMAND]) {
    const error = captureThrow(() =>
      assertModelPolicy(agentCommand, "openrouter/anthropic/claude-sonnet-5"),
    );
    assert.ok(error instanceof ClaudeFamilyOnOpenRouterError, agentCommand);
  }
});

test("P0 — it THROWS rather than omitting, because omission is a no-op", () => {
  // 🛑 The tempting pi implementation is "don't pass `provisionModelId` for a
  // Claude-family slug". IT DOES NOTHING: `provisionModelId` is only what acpx
  // WRITES into pi's models-store, and pi's own bundled catalogue already carries
  // the Claude family. Measured with a control — a pi session provisioned a
  // non-Claude glm id still advertised 409 models including 33 Claude-family rows,
  // and acpx writes exactly ONE id per spawn, so the other 32 are pi's own.
  //
  // This row pins the OBSERVABLE consequence: the call raises, so the spawn aborts.
  // A guard that returned a value (or returned quietly) would fail here.
  assert.throws(
    () => assertModelPolicy(REAL_PI_COMMAND, "openrouter/anthropic/claude-sonnet-5"),
    ClaudeFamilyOnOpenRouterError,
  );
});

test("P0 POSITIVE CONTROL: green-listed, native and absent models all pass", () => {
  // Without this the rows above would pass on a guard that refuses everything.
  for (const agentCommand of [REAL_CLAUDE_COMMAND, REAL_PI_COMMAND, REAL_CODEX_COMMAND]) {
    for (const model of [
      GREEN_LISTED,
      `openrouter/${GREEN_LISTED}`,
      `openrouter:${GREEN_LISTED}`,
      "deepseek/deepseek-v4.1-flash",
      "sonnet",
      "opus",
      "default",
      "opus[1m]",
      undefined,
      "",
    ]) {
      assert.doesNotThrow(
        () => assertModelPolicy(agentCommand, model),
        `${agentCommand} / ${String(model)} must be allowed`,
      );
    }
  }
});

test("P0 — the attached profile is named in the refusal", () => {
  // The incident session had `sub10` attached and the route bypassed it as
  // `not-an-openrouter-account`: we held the free credential and paid metered
  // anyway. Threading the profile is what lets the refusal say so.
  const error = captureThrow(() =>
    assertModelPolicy(REAL_CLAUDE_COMMAND, "anthropic/claude-sonnet-5", { profileId: "sub10" }),
  );
  assert.ok(error instanceof ClaudeFamilyOnOpenRouterError);
  assert.match(error.message, /profile "sub10" attached/);
  assert.match(error.message, /--model sonnet {5}\(the subscription's Sonnet, on sub10/);
});

// ── Tier 1 — CLI flag validation ─────────────────────────────────────────────

test("Tier 1 — all three spellings are refused, for claude AND pi, in BOTH cache states", () => {
  for (const [agentCommand, agentName, provisions] of [
    [REAL_CLAUDE_COMMAND, "claude", false],
    [REAL_PI_COMMAND, "pi", true],
  ] as const) {
    for (const catalogue of [warmCatalogue(), coldCatalogue()]) {
      for (const model of THREE_SPELLINGS) {
        const error = captureThrow(() =>
          validateModelSelection(catalogue, {
            model,
            agentName,
            agentCommand,
            ...(provisions ? { provisionsModelCatalogue: true } : {}),
          }),
        );
        assert.ok(error instanceof ModelSlugError, `${agentName} / ${model}: ${String(error)}`);
        assert.equal(
          detailCodeOf(error),
          "MODEL_CLAUDE_FAMILY_ON_OPENROUTER",
          `${agentName} / ${model} must get the POLICY refusal`,
        );
      }
    }
  }
});

test("Tier 1 — the SLASH form gets OUR refusal, NOT the unknown-slug typo hint", () => {
  // 🛑 THE ROW THIS WHOLE CONTROL EXISTS FOR, AND "the slash form fails" DOES NOT
  // SATISFY IT. It ALREADY failed before this change — as a TYPO:
  //
  //   [acpx] --model "openrouter/anthropic/claude-sonnet-5" is not in this box's
  //     model catalogue.
  //     did you mean: ...
  //     try: acpx models --search sonnet
  //
  // In the incident the agent met exactly that, concluded it had a spelling
  // problem, followed the search hint, found a working spelling, and spent the
  // money. **Our own error message walked it to the bypass.** So a test asserting
  // only that the slash form throws would have passed on the UNFIXED code, on the
  // one path that actually cost us. The assertion must be about WHICH refusal
  // fires, and that the search hint is GONE.
  const error = captureThrow(() =>
    validateModelSelection(warmCatalogue(), {
      model: "openrouter/anthropic/claude-sonnet-5",
      agentName: "claude",
      agentCommand: REAL_CLAUDE_COMMAND,
    }),
  );
  assert.ok(error instanceof ModelSlugError);
  assert.equal(detailCodeOf(error), "MODEL_CLAUDE_FAMILY_ON_OPENROUTER");
  assert.doesNotMatch(
    error.message,
    /acpx models --search/,
    "the search hint is what walked the agent to the working spelling — it must not appear",
  );
  assert.doesNotMatch(error.message, /is not in this box's model catalogue/);
  assert.doesNotMatch(error.message, /did you mean/);
});

test("Tier 1 CONTROL: the typo hint still fires for a genuine typo", () => {
  // The paired control for the row above: proves the hint was suppressed for the
  // POLICY case specifically, not disabled across the board. A refusal that
  // silenced every unknown-slug diagnosis would pass the row above and be a
  // regression in its own right.
  const error = captureThrow(() =>
    validateModelSelection(warmCatalogue(), {
      model: "z-ai/glm-5.3-flashh",
      agentName: "claude",
      agentCommand: REAL_CLAUDE_COMMAND,
    }),
  );
  assert.ok(error instanceof ModelSlugError);
  assert.equal(detailCodeOf(error), "MODEL_SLUG_UNKNOWN");
  assert.match(error.message, /acpx models --search/);
});

test("Tier 1 — a custom agent NAME does not defeat the policy", () => {
  // 🛑 THE DESCRIPTOR-VS-NAME FAIL-OPEN. `agentName` is the CLI agent-registry
  // name and can be any alias; the descriptor is derived from the COMMAND and
  // cannot diverge. `assertModelAvailable` already carries this hole — it looks
  // `availability` up by NAME while the map is keyed by HARNESS id, so a
  // divergence misses and returns early on `undefined`, silently passing.
  //
  // Here the name is a bespoke alias while the command is really claude. Gated on
  // the name, this row would sail through; gated on the descriptor it is refused.
  const error = captureThrow(() =>
    validateModelSelection(warmCatalogue(), {
      model: "anthropic/claude-sonnet-5",
      agentName: "my-bespoke-claude",
      agentCommand: REAL_CLAUDE_COMMAND,
    }),
  );
  assert.equal(detailCodeOf(error), "MODEL_CLAUDE_FAMILY_ON_OPENROUTER");
});

test("Tier 1 POSITIVE CONTROL: green-listed and native selections still validate", () => {
  assert.equal(
    validateModelSelection(warmCatalogue(), {
      model: GREEN_LISTED,
      agentName: "claude",
      agentCommand: REAL_CLAUDE_COMMAND,
    })?.id,
    GREEN_LISTED,
  );
  for (const native of ["sonnet", "opus", "haiku"]) {
    assert.doesNotThrow(
      () =>
        validateModelSelection(warmCatalogue(), {
          model: native,
          agentName: "claude",
          agentCommand: REAL_CLAUDE_COMMAND,
        }),
      `${native} must remain selectable on a claude session`,
    );
  }
});

test("Tier 1 POSITIVE CONTROL: pi keeps the non-Claude OpenRouter roster", () => {
  assert.equal(
    validateModelSelection(warmCatalogue(), {
      model: `openrouter/${GREEN_LISTED}`,
      agentName: "pi",
      agentCommand: REAL_PI_COMMAND,
      provisionsModelCatalogue: true,
    })?.id,
    GREEN_LISTED,
  );
});

test("Tier 1 — codex is untouched by the policy gate", () => {
  // codex's own ids are never namespaced under `anthropic/`, so the gate is inert
  // for it. Asserted as "not OUR refusal", never as "does not throw": codex's own
  // validation may legitimately refuse for other reasons, and a blanket
  // doesNotThrow would couple this control to those.
  const error = captureThrow(() =>
    validateModelSelection(warmCatalogue(), {
      model: GREEN_LISTED,
      agentName: "codex",
      agentCommand: REAL_CODEX_COMMAND,
    }),
  );
  assert.notEqual(detailCodeOf(error), "MODEL_CLAUDE_FAMILY_ON_OPENROUTER");
});

// ── Tier 3 — the declaration (menu / `acpx models`) ──────────────────────────

function rowById(id: string): CatalogueModel {
  const row = warmCatalogue().models.find(
    (model) => model.source === "openrouter" && model.id === id,
  );
  assert.ok(row, `the fixture must carry an OpenRouter row for ${id}`);
  return row;
}

test("Tier 3 — a Claude-family row is annotated unavailable for claude AND pi", () => {
  const row = rowById("anthropic/claude-sonnet-5");
  for (const agent of ["claude", "pi"]) {
    const availability = row.availability[agent];
    assert.equal(availability?.ok, false, agent);
    assert.equal(availability?.reason, CLAUDE_FAMILY_OPENROUTER_REASON, agent);
    assert.match(availability?.message ?? "", /not available on the OpenRouter route/);
  }
});

test("Tier 3 — the row is still LISTED, because availability annotates and never filters", () => {
  // ⚠️ This is also the reason Tier 3 must never be cited as enforcement: the row
  // remains selectable-looking to anything that ignores `availability`, so it
  // explains the policy without applying it.
  const catalogue = warmCatalogue();
  assert.ok(
    catalogue.models.some((model) => model.id === "anthropic/claude-sonnet-5"),
    "the Claude-family row must remain in the list",
  );
});

test("Tier 3 POSITIVE CONTROL: a non-Claude row stays available for claude and pi", () => {
  const row = rowById(GREEN_LISTED);
  for (const agent of ["claude", "pi"]) {
    assert.equal(row.availability[agent]?.ok, true, agent);
  }
});

test("Tier 3 — codex keeps its own reason, not ours", () => {
  // Proves the branch is scoped per capability id rather than applied to the row.
  const row = rowById("anthropic/claude-sonnet-5");
  assert.notEqual(row.availability.codex?.reason, CLAUDE_FAMILY_OPENROUTER_REASON);
});

test("Tier 3 — ONLY Claude-family rows are annotated, and every one of them is", () => {
  // A structural sweep rather than a spot check: counts the rows carrying our
  // reason and the rows the predicate says should, and requires them to be the
  // same set. Catches both over-reach (a non-Claude row annotated) and
  // under-reach (a Claude-family row missed) in one assertion, over the whole
  // fixture rather than over the examples someone thought to list.
  const openRouterRows = warmCatalogue().models.filter((model) => model.source === "openrouter");
  // ⚠️ PRECEDENCE, MEASURED RATHER THAN ASSUMED: a row that is already unavailable
  // for a catalogue reason keeps that reason. `availabilityFor` answers the
  // `unavailableReasons[0]` arm first, so every `…:batch` Claude row reports
  // `batch-endpoint` and never reaches our branch. That is correct — a batch
  // endpoint cannot stream a session at all, which is the more fundamental refusal
  // — and it is asserted as its own row below rather than papered over here.
  const expected = openRouterRows.filter(
    (model) => isClaudeFamilyModelId(model.id) && model.unavailableReasons.length === 0,
  );
  const annotated = openRouterRows.filter(
    (model) => model.availability.pi?.reason === CLAUDE_FAMILY_OPENROUTER_REASON,
  );
  assert.ok(expected.length > 0, "the fixture must contain selectable Claude-family rows");
  assert.deepEqual(
    annotated.map((model) => model.id).toSorted(),
    expected.map((model) => model.id).toSorted(),
  );
  // …and pi keeps everything else.
  assert.ok(
    openRouterRows.length - expected.length > 300,
    "pi must keep the rest of the OpenRouter roster",
  );
});

test("Tier 3 — a Claude-family :batch row is still unavailable, by the earlier reason", () => {
  // The other half of the precedence above. Our branch never sees this row, and it
  // must not: it is unavailable for a reason that is true regardless of policy. The
  // row exists so "not annotated by us" can never be mistaken for "available".
  const row = rowById("anthropic/claude-sonnet-5:batch");
  for (const agent of ["claude", "pi"]) {
    assert.equal(row.availability[agent]?.ok, false, agent);
    assert.equal(row.availability[agent]?.reason, "batch-endpoint", agent);
  }
  // And the spawn-path enforcement does NOT defer to that: P0 refuses it on policy.
  assert.throws(
    () => assertModelPolicy(REAL_PI_COMMAND, "anthropic/claude-sonnet-5:batch"),
    ClaudeFamilyOnOpenRouterError,
  );
});

// ── The message ──────────────────────────────────────────────────────────────

test("the message closes the reasoning gap that was actually used", () => {
  const message = claudeFamilyOnOpenRouterMessage({
    requested: "anthropic/claude-sonnet-5",
    profileId: "sub10",
  });
  // Addressed to an agent that KNOWS the rule and has constructed a reason it does
  // not apply. Each of these closes a specific observed route-around.
  assert.match(message, /not authorisation for a ROUTE/); // the waiver that was used
  assert.match(message, /only Daniel can authorise/); // no local exception exists
  assert.match(message, /Re-spelling will not help/); // the four retries
  assert.match(message, /reportable action, not a loophole/); // the direct-curl path
  assert.match(message, /z-ai\/glm-5\.3-flash and deepseek\/deepseek-v4\.1-flash/); // the green list
  // All three spellings of the CALLER'S OWN slug, not a hardcoded example.
  for (const spelling of THREE_SPELLINGS) {
    assert.ok(message.includes(spelling), `the message must enumerate ${spelling}`);
  }
});

test("🛑 the message never claims the KEY denies Claude-family slugs", () => {
  // An earlier draft ended "the box's OpenRouter key itself denies Claude-family
  // slugs — a direct call would fail too." IT IS FALSE: we investigated a
  // key-level guardrail and did NOT adopt one, so there is no key-level Claude
  // ban, and `providers.json` is readable by the same uid every agent runs as. An
  // agent can disprove that sentence with one `curl` — and a deterrent it can
  // falsify in one command discredits every other paragraph. This row is what
  // stops the sentence coming back.
  for (const harness of ["claude", "pi", undefined]) {
    for (const profileId of ["sub10", undefined]) {
      const message = claudeFamilyOnOpenRouterMessage({
        requested: "anthropic/claude-sonnet-5",
        ...(harness ? { harness } : {}),
        ...(profileId ? { profileId } : {}),
      });
      assert.doesNotMatch(message, /key itself denies/i);
      assert.doesNotMatch(message, /would fail too/i);
      assert.doesNotMatch(message, /direct call would fail/i);
    }
  }
});

test("the message names the alias the caller actually asked for", () => {
  // An Opus request told to pass `--model sonnet` is a wrong instruction, and a
  // refusal that misdirects is one an agent is entitled to ignore.
  const opus = claudeFamilyOnOpenRouterMessage({ requested: "anthropic/claude-opus-5" });
  assert.match(opus, /--model opus/);
  assert.doesNotMatch(opus, /--model sonnet/);

  const haiku = claudeFamilyOnOpenRouterMessage({ requested: "anthropic/claude-haiku-4.5" });
  assert.match(haiku, /--model haiku/);
});

test("the message does not assert version identity", () => {
  // `anthropic/claude-sonnet-4.5` maps to alias `sonnet`, which is Sonnet 5 — same
  // FAMILY, newer version. Claiming "the same model" would be an inaccuracy this
  // refusal's audience is specifically primed to argue with.
  const message = claudeFamilyOnOpenRouterMessage({
    requested: "anthropic/claude-sonnet-4.5",
    profileId: "sub10",
  });
  assert.match(message, /the subscription's Sonnet/);
  assert.doesNotMatch(message, /\(the same model/);
});

test("the pi variant does not tell pi to pass a flag pi cannot honour", () => {
  // 🛑 pi cannot reach the claude aliases at all — `--model sonnet` is not a thing
  // a pi session can do. Handing pi that flag would be a wrong instruction, and a
  // refusal that misdirects invites the waiver-reasoning this control exists to
  // defeat. The pi variant points at a claude AGENT instead.
  const message = claudeFamilyOnOpenRouterMessage({
    requested: "openrouter/anthropic/claude-sonnet-5",
    harness: "pi",
  });
  assert.match(message, /acpx claude sessions new --model sonnet/);
  assert.match(message, /a claude agent fulfils that request/);
  assert.match(message, /pi keeps every other OpenRouter model/);
  // And it must not imply pi has a subscription profile of its own.
  assert.doesNotMatch(message, /profile/i);
});

test("the no-profile variant states nothing about a profile, and no cost multiple", () => {
  const message = claudeFamilyOnOpenRouterMessage({ requested: "anthropic/claude-sonnet-5" });
  assert.doesNotMatch(message, /profile/i);
  assert.match(message, /on the box's default Claude subscription/);
  // A drafted "~165x the green-listed rate" was removed from THIS message: measured
  // on this box's catalogue, Sonnet 5 is ~13-20x glm-5.3-flash and ~143x/~25x
  // deepseek-v4.1-flash per token. (The Operating System's ~165x figure describes
  // claude-fable-5.1 and is correct for THAT model — it was simply wrong inside a
  // Sonnet message.) No falsifiable multiple belongs in a deterrent.
  assert.doesNotMatch(message, /\d+x/);
});
