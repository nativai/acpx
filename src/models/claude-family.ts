/**
 * Claude-family models are NOT available on the OpenRouter route (brick 30eb2003).
 *
 * ## Why this exists
 *
 * We paid OpenRouter's metered price for Claude Sonnet 5 — a model our Claude
 * subscriptions already serve at no marginal cost — because a spawning agent read
 * Daniel's *"use the Claude Sonnet model"* as authorisation for a **route it had
 * itself chosen**. The rule did not fail to fire: the agent quoted the green-list
 * in its own thinking, flagged it, and waived it. So the control had to remove the
 * capability rather than forbid its use, and the refusal had to be addressed to an
 * agent that knows the rule and has just constructed a reason it does not apply.
 *
 * ## The three tiers, and which one is the enforcement
 *
 *   Tier 1  `validateModelSelection`     CLI flag validation, before any spawn.
 *                                        Its unique job is pre-empting
 *                                        `unknownSlugError`'s search hint.
 *                                        BYPASSED by inheritance / fork / template.
 *   P0      `assertModelPolicy`          The spawn path (`resolveAgentLaunchPlan`).
 *                                        ★ THE ENFORCEMENT. Harness-agnostic, every
 *                                        spawn incl. inherited / fork / template /
 *                                        resume, and independent of the catalogue.
 *   Tier 3  `availabilityFor`            The menu says why. For the CLAUDE-FAMILY
 *                                        branch, declaration only. ⚠️ For the
 *                                        ENTITLEMENT branch it is NOT: `availability`
 *                                        is read by `assertModelAvailable`, so Tier 1
 *                                        refuses on it — see `catalogue.ts`.
 *
 * ## Why this module sits LOW in the import graph
 *
 * Three call sites need the same predicate and the same wording, and they already
 * import each other: `openrouter-routing.ts` imports `parseModelRef` from
 * `model-slug-validation.ts`, and both import `catalogue.ts`. Anything shared must
 * therefore sit below all three. ⚠️ The imports below are safe because none of
 * `errors.ts` (type-only imports), `harness-capabilities.ts` (imports only
 * `agent-command.js`) or `openrouter-entitlement.ts` reaches back into `models/`.
 * DO NOT add an import from `models/` here — that is what would close the cycle.
 *
 * ⚠️ **`openrouter-entitlement.ts` IS THE ONE `models/` IMPORT, AND IT IS SAFE FOR
 * A CHECKABLE REASON RATHER THAN A HOPEFUL ONE:** it imports `node:crypto` and
 * `config/providers.js`, and `config/providers.ts` imports only node builtins. So
 * the chain terminates and cannot reach back here. **Verify that before adding
 * anything to that module's imports** — a `models/` import over there closes the
 * cycle from a file whose name does not suggest it.
 *
 * ## Brick daed4261 — this tier is now an ALLOWLIST, not only a Claude denylist
 *
 * `assertModelPolicy` refuses any non-entitled id on the OpenRouter route, against the
 * entitlement module (`openrouter-entitlement.ts`). The Claude-family refusal below is
 * kept **verbatim and list-independent** as its specialised case — see `assertModelPolicy`'s own
 * ordering note for why that is stronger than folding Claude into the list.
 */

import { harnessIdForAgentCommand } from "../acp/harness-capabilities.js";
import { AcpxOperationalError } from "../errors.js";
import {
  isEntitledOpenRouterModelId,
  isFloatingAliasModelId,
  isOpenRouterRouteShapedModelId,
  resolveOpenRouterEntitlement,
  type OpenRouterEntitlementResolution,
  type OpenRouterEntitlementSkew,
} from "./openrouter-entitlement.js";

/**
 * The slash spelling's prefix. It is **not** a source prefix on the claude path:
 * `parseModelRef` splits on a COLON against `KNOWN_SOURCE_PREFIXES`, so
 * `openrouter/anthropic/claude-sonnet-5` has no colon at all and the prefix stays
 * *inside* the id. Only pi's `stripProviderPrefix` removes it, and all three of
 * its callers are gated on `provisionsModelCatalogue`. Nothing strips it for
 * claude — which is why this module strips it itself.
 */
const OPENROUTER_ID_PREFIXES = ["openrouter/", "openrouter:"] as const;

/** A leading `openrouter/` or `openrouter:` removed — the route prefix, either spelling. */
function withoutRoutePrefix(slug: string): string {
  const prefix = OPENROUTER_ID_PREFIXES.find((candidate) => slug.startsWith(candidate));
  return prefix === undefined ? slug : slug.slice(prefix.length);
}

/** The claude-native aliases, in the order a Claude-family slug is matched against them. */
const CLAUDE_FAMILY_ALIASES = ["opus", "sonnet", "haiku", "fable"] as const;

/**
 * True when this model id names a Claude-family model **as an OpenRouter-style
 * namespaced slug**.
 *
 * ⚠️ **THE `/` IS LOAD-BEARING, NOT A TIDINESS CHECK. Without it this predicate
 * refuses every ordinary claude session.** A claude-native model is always a bare
 * alias — `default`, `opus`, `sonnet`, `haiku`, `fable` (`CLAUDE_ALIASES`,
 * `harness-models.ts`) — and never carries a namespace, while every Claude-family
 * row on OpenRouter does (`anthropic/claude-sonnet-5`, `~anthropic/claude-opus-latest`).
 * Requiring a namespace is therefore what separates *"route this to OpenRouter"*
 * from *"run Sonnet on the subscription"*, and the test file carries `sonnet` /
 * `opus` / `default` as committed negative cases for exactly this reason.
 *
 * ⚠️ **IT IS NAME-SHAPED ON PURPOSE AND MUST NOT CONSULT THE CATALOGUE.** The
 * bare-slug leg of the route reads the model cache, and a **cold** cache makes it
 * stand aside — so a catalogue-derived "is this Claude-family" test would be
 * silently absent exactly when the cache is cold. `isFableModel`
 * (`config/subscription-usage.ts`) is the existing precedent for the same reason.
 *
 * Accepts all three spellings, because the id reaches here having had at most a
 * COLON source prefix removed by `parseModelRef`:
 *
 *   openrouter:anthropic/claude-sonnet-5  → id `anthropic/claude-sonnet-5`
 *   anthropic/claude-sonnet-5             → id `anthropic/claude-sonnet-5`
 *   openrouter/anthropic/claude-sonnet-5  → id `openrouter/anthropic/claude-sonnet-5`
 *
 * The second arm — namespace `anthropic` — costs one `||` and covers a
 * Claude-family model whose slug does not spell "claude". Measured 2026-09-28 on
 * this box's `models-cache.json`: all 27 `anthropic/*` rows contain "claude" and no
 * "claude" row exists outside `anthropic/`, so the arm is redundant **today** and is
 * kept as the cheaper half of a refusal that must not quietly stop covering a
 * family when a slug is renamed.
 *
 * ⚠️ **THE FIRST ARM IS A SUBSTRING TEST, SO IT OVER-REACHES BY DESIGN** — any
 * namespaced slug whose model part contains "claude" is refused, a hypothetical
 * `somevendor/claude-killer-3` included. Measured 2026-09-28: **zero of 458 live
 * catalogue rows carry "claude" outside `anthropic/`**, so nothing is affected
 * today, and it is the same trade `isFableModel` already makes. It is the right
 * way round to be wrong: **if it ever bites, it presents as that model being
 * REFUSED — loud, and in the safe direction — never as a Claude model silently
 * getting through.** Narrow it only against a real row, never pre-emptively.
 */
export function isClaudeFamilyModelId(id: string | null | undefined): boolean {
  if (typeof id !== "string") {
    return false;
  }
  const slug = withoutRoutePrefix(id.trim().toLowerCase());
  const slash = slug.lastIndexOf("/");
  if (slash < 0) {
    return false;
  }
  // A leading `~` marks OpenRouter's floating-alias rows (`~anthropic/claude-opus-latest`).
  const namespace = slug.slice(0, slash).replace(/^~/, "");
  const name = slug.slice(slash + 1);
  return name.includes("claude") || namespace === "anthropic";
}

/**
 * The harnesses this policy binds. Both reach OpenRouter, by different mechanisms:
 * claude routes a picked slug through the shim (`via-shim`), pi has the slug
 * written into its own config (`provisioned`). The incident exercised BOTH, 38
 * seconds apart and inside one programme — a pi spawn on
 * `openrouter/anthropic/claude-sonnet-5` at 19:41:37Z, then a claude re-spawn on
 * `anthropic/claude-sonnet-5` at 19:42:15Z. A claude-only control would have
 * refused the second and left the first running.
 */
const REFUSING_HARNESSES = new Set(["claude", "pi"]);

/**
 * Whether this policy refuses this selection (brick 30eb2003).
 *
 * 🛑 **THE HARNESS TERM IS THE DESCRIPTOR (`harnessIdForAgentCommand`), NEVER THE
 * CLI AGENT NAME — AND THE DIFFERENCE IS A SILENT FAIL-OPEN.** The two coincide for
 * a stock `claude` / `pi` agent and DIVERGE for a custom-named agent alias pointing
 * at the same command. `assertModelAvailable` already carries that hole: it looks
 * `availability` up by agent NAME while `computeAvailability` keys it by HARNESS
 * id, so on divergence the lookup misses, the `availability === undefined` arm
 * returns early, and the check SILENTLY PASSES. A predicate gated on the name
 * inherits it exactly: someone registers an alias, and this control quietly stops
 * applying with nothing failing anywhere. The descriptor cannot diverge — it is
 * derived from the agent command itself.
 *
 * ⚠️ **THIS PREDICATE IS NAME-SHAPED AND MUST STAY THAT WAY — A CATALOGUE-DERIVED
 * ONE IS ABSENT EXACTLY WHEN IT MATTERS.** See {@link isClaudeFamilyModelId}: the
 * cold-cache case is the whole reason the spawn-path tiers exist.
 *
 * ⚠️ **KNOWN GAP — "both harnesses" MEANS "both CLASSIFIABLE harnesses".** An agent
 * command the descriptor cannot classify answers `undefined`, and this returns
 * false for it, so the Tier 1 gate STANDS ASIDE. That is not hypothetical: a live
 * record on devbox carries `agent_command: "my-real-bespoke-agent"`, which resolves
 * to `undefined` today. It is safe only because {@link assertModelPolicy} — the
 * enforcement — keys on the MODEL ID ALONE and therefore refuses it anyway. **This
 * is the concrete reason P0 must not be descriptor-gated too**; make them
 * symmetrical and this gap becomes a hole in the control rather than in a
 * diagnostic. A committed test covers both halves.
 */
export function refusesClaudeFamilyOnOpenRouter(params: {
  /** `harnessIdForAgentCommand(agentCommand)` — the DESCRIPTOR, not the agent name. */
  harness: string | undefined;
  modelId: string;
}): boolean {
  return (
    params.harness !== undefined &&
    REFUSING_HARNESSES.has(params.harness) &&
    isClaudeFamilyModelId(params.modelId)
  );
}

/**
 * Tier 3 — the one-line DECLARATION annotation, rendered inline on a catalogue row
 * in the acpx-ui picker and in `acpx models --agent <id>`. Availability ANNOTATES
 * rather than filters ("the list never shrinks", `catalogue.ts`), so the row stays
 * listed with this reason attached and the policy is readable **before** an agent
 * acts — the half a refusal at spawn time can never provide.
 *
 * 🛑 **THIS IS NOT ENFORCEMENT AND MUST NEVER BE DESCRIBED AS SUCH.** It changes no
 * spawn's outcome; it only explains one. `assertModelPolicy` is what refuses.
 */
export const CLAUDE_FAMILY_OPENROUTER_ANNOTATION =
  "Claude-family models are not available on the OpenRouter route — our subscriptions serve " +
  "them at no marginal cost. Use the claude alias instead (sonnet, opus).";

/** The `availability.<agent>.reason` slug for {@link CLAUDE_FAMILY_OPENROUTER_ANNOTATION}. */
export const CLAUDE_FAMILY_OPENROUTER_REASON = "claude-family-on-openrouter";

/**
 * The claude alias that fulfils this request on the subscription. Derived from the
 * slug so the refusal never tells an agent that asked for Opus to pass
 * `--model sonnet`; falls back to `opus` (the box's non-Fable default) for a
 * Claude-family slug that names no family we ship an alias for.
 */
function claudeAliasFor(id: string): string {
  const slug = id.toLowerCase();
  return CLAUDE_FAMILY_ALIASES.find((alias) => slug.includes(alias)) ?? "opus";
}

/**
 * The ENFORCEMENT-tier refusal, verbatim per brick 30eb2003 `RECOMMENDATION.md`
 * and lane C `FINDINGS.md` §3.
 *
 * **Every paragraph closes a route-around that was actually observed, so do not
 * trim it.** It is addressed to an agent that already knows the rule:
 *
 *  1. names what was refused, in the agent's own spelling;
 *  2. names the cheap correct alternative as a **flag it can copy**;
 *  3. closes the reasoning gap that was actually used — being asked for a MODEL is
 *     not authorisation for a ROUTE — and offers the substitute as the *same*
 *     request fulfilled, so complying is not experienced as disobeying the human;
 *  4. says who can authorise an exception, and that re-spelling will not help.
 *
 * 🛑 **DO NOT ADD A CLAIM THAT THE BOX KEY ITSELF DENIES CLAUDE-FAMILY SLUGS.** An
 * earlier draft ended *"the box's OpenRouter key itself denies Claude-family slugs
 * — a direct call would fail too."* It was **cut because it is false**: we
 * investigated a key-level guardrail and did not adopt one (`ignored_models` is in
 * OpenRouter's schema but is not established as an enforced entitlement, and key
 * entitlement only works on bounded-purpose keys — the box key must stay general).
 * An agent could disprove that sentence with one `curl`, and a message it can
 * falsify in one command is worth less than no message at all. The honest
 * deterrent — *not supported, and reportable* — is what the last paragraph says
 * instead, and it stays true.
 */
export function claudeFamilyOnOpenRouterMessage(params: {
  /** What the caller actually typed, echoed back in their own spelling. */
  requested: string;
  /** The attached profile, when this spawn has one. Fills the second paragraph. */
  profileId?: string | undefined;
  /**
   * The DESCRIPTOR of the harness being refused. Only `pi` changes the wording, and
   * it has to: pi cannot reach the claude aliases at all, so telling a pi spawn to
   * pass `--model sonnet` would be a wrong instruction — and a refusal that
   * misdirects is one its audience is entitled to ignore.
   */
  harness?: string | undefined;
}): string {
  const alias = claudeAliasFor(params.requested);
  const aliasTitle = alias.charAt(0).toUpperCase() + alias.slice(1);
  const bare = bareSlug(params.requested);
  const profileId = params.profileId?.trim();
  const isPi = params.harness === "pi";

  // The profile paragraph is fillable from state acpx already holds — a Claude
  // subscription was attached and silently bypassed in the incident itself
  // (`profileBypass`, reason `not-an-openrouter-account`). We held the free
  // credential and paid metered anyway, so saying so is the sharpest sentence here.
  const attached =
    profileId && !isPi
      ? `\n  This session already has the Claude subscription profile "${profileId}" attached — the free\n` +
        `  path to this exact model was one flag away.\n`
      : "";
  // ⚠️ "the subscription's Sonnet", NOT "the same model". The alias is derived from
  // the FAMILY, so `anthropic/claude-sonnet-4.5` maps to `sonnet`, which is Sonnet 5
  // — same family, newer version. The message's job is to make the free path
  // obviously available, not to assert version identity, and a refusal that
  // overstates by one word invites exactly the waiver-reasoning it exists to defeat:
  // the incident agent talked itself past a rule it had correctly recalled, and a
  // message it can catch in an inaccuracy is one it will feel licensed to argue with.
  const useInstead = isPi
    ? `  use instead:  acpx claude sessions new --model ${alias}     (the subscription's ${aliasTitle}, no marginal cost)`
    : profileId
      ? `  use instead:  --model ${alias}     (the subscription's ${aliasTitle}, on ${profileId}, no marginal cost)`
      : `  use instead:  --model ${alias}     (on the box's default Claude subscription)`;
  const fulfils = isPi
    ? `\n  If you were asked for "Claude ${aliasTitle}", a claude agent fulfils that request on the\n` +
      `  subscription — the model was never pi-specific.\n`
    : `\n  If you were asked for "Claude ${aliasTitle}", \`--model ${alias}\` fulfils that request on\n` +
      `  the subscription.\n`;
  const greenList = isPi
    ? `\n  pi keeps every other OpenRouter model. If you need OpenRouter here, the green-listed\n` +
      `  models are z-ai/glm-5.3-flash and deepseek/deepseek-v4.1-flash.`
    : `\n  If you need OpenRouter for something else, the green-listed models are\n` +
      `  z-ai/glm-5.3-flash and deepseek/deepseek-v4.1-flash.`;

  return (
    `[acpx] refusing --model "${params.requested}": Claude-family models are not available\n` +
    `  on the OpenRouter route. OpenRouter bills this model at metered API pricing out of the\n` +
    `  box key; our Claude subscriptions serve the same model at no marginal cost.\n` +
    attached +
    `\n${useInstead}\n` +
    fulfils +
    `  Being asked for a MODEL is not authorisation for a ROUTE: the route is acpx's to choose\n` +
    `  and this one is not available for Claude-family models. There is no per-task exception to\n` +
    `  waive here — only Daniel can authorise a Claude-family model on OpenRouter, per spawn.\n` +
    `\n  Re-spelling will not help: "openrouter:${bare}",\n` +
    `  "openrouter/${bare}" and "${bare}" are all refused\n` +
    `  identically. Calling OpenRouter directly with the box key is not a supported workaround\n` +
    `  and is a reportable action, not a loophole.\n` +
    greenList
  );
}

/**
 * The requested id reduced to its bare namespaced form, so the "re-spelling will
 * not help" list enumerates the caller's OWN slug in all three spellings rather
 * than a hardcoded example. Strips a colon source prefix and the slash prefix.
 */
function bareSlug(requested: string): string {
  const trimmed = requested.trim();
  const colon = trimmed.indexOf(":");
  const afterSource =
    colon > 0 && trimmed.slice(0, colon).toLowerCase() === "openrouter"
      ? trimmed.slice(colon + 1)
      : trimmed;
  return withoutRoutePrefix(afterSource);
}

/**
 * ★ THE ENFORCEMENT (P0). Refuse any model on the OpenRouter route that is not in
 * this box's entitlement set, for ANY harness, aborting the spawn.
 *
 * ## It is an ALLOWLIST as of brick daed4261, and that closed a real gap
 *
 * It used to refuse the **Claude family only**, which made the code tier NARROWER
 * than the policy it existed to give feedback on: `openrouter/openai/gpt-5-pro`,
 * `openrouter/google/gemini-3-ultra` and every other frontier non-Claude row were
 * off the green list and unrefused. Now the permitted set is
 * {@link OPENROUTER_ENTITLEMENT} — the same module the key's `allowed_models`
 * guardrail is generated from — so `S ⊆ K` holds and no model choice can produce
 * the uninterpretable provider 403 described in that module's header.
 *
 * ## The order of the four checks IS the design — read `assertModelPolicy`'s body
 *
 *   1. not route-shaped     → return. The `/` boundary; keeps this off claude/codex.
 *   2. Claude-family        → throw, with the SHIPPED message, list-independent.
 *   3. floating `~…-latest` → throw, on shape, list-independent.
 *   4. not in `S`           → throw, naming the set.
 *
 * Called from `AcpClient.resolveAgentLaunchPlan` ABOVE both `applyBoxProviderEnv`
 * and `applyProfileEnv`, which is what makes it the single place that covers every
 * spawn there is — create, acpx-ui create, an inherited child with no `--model`,
 * `sessions copy`/fork, `--from-template`, and RESUME — because every one of them
 * reaches the adapter through that one method (one caller, one call site).
 *
 * 🛑 **IT THROWS. DO NOT REPLACE IT WITH AN OMISSION — THE OMISSION FORM IS A
 * NO-OP, AND IT IS THIS BRICK'S OWN FAILURE SHAPE REPRODUCED INSIDE ITS OWN FIX.**
 * The obvious-looking pi guard is *"just don't pass `provisionModelId` for a
 * Claude-family slug"*. That changes nothing: `provisionModelId` is only what acpx
 * WRITES into pi's models-store, and **pi's own bundled catalogue already carries
 * the Claude family**, so withholding it does not stop pi running the model.
 * Measured with a control — a pi session on `openrouter/z-ai/glm-5.3-flash`
 * (provisioned a glm id, i.e. NOT a Claude model) still advertised **409 models
 * including 33 Claude-family rows**; acpx writes exactly ONE id per spawn, so the
 * other 32 are pi's. pi knows these models with or without us. Only aborting the
 * spawn refuses them.
 *
 * ⚠️ **HARNESS-AGNOSTIC ON PURPOSE, AND IT COSTS NOTHING.** It keys on the MODEL
 * ID alone, so a harness added later is covered without anyone remembering to add
 * it. The harness is still read — but only to WORD the refusal, never to decide it.
 *
 * 🛑 **WHAT PAYS FOR THAT, NOW THAT IT IS AN ALLOWLIST: THE `/` BOUNDARY, AND IT IS
 * MEASURED RATHER THAN ASSUMED.** A denylist that over-reaches refuses one extra
 * model; an ALLOWLIST that over-reaches refuses *everything it does not know*, so
 * the route gate is the only thing standing between this function and every claude
 * and codex session on the box. Two independent lines of evidence, both 2026-09-29:
 *
 *   CENSUS  devbox's whole session store — ZERO non-OpenRouter model ids carry a
 *           `/`. claude / claude-pty run bare aliases (`opus` ×790, `sonnet` ×291,
 *           `default` ×78, `fable` ×43, `haiku` ×6); codex runs bare ids with a
 *           bracket (`gpt-6-astra[high]` ×32, 18 distinct forms); every namespaced
 *           id present is an OpenRouter id.
 *   TYPE    `ModelSource` has exactly five values (`types.ts:12`) and the four
 *           non-OpenRouter ones — `claude-subscription`, `claude-home`,
 *           `claude-pty`, `chatgpt` — carry only bare ids: claude's are compiled
 *           into `harness-models.ts`, codex's are advertised bare over ACP.
 *
 * `test/openrouter-entitlement.test.ts` pins the boundary with those exact live ids
 * as committed positive controls. **If a harness ever ships a namespaced native id,
 * that test is what goes red** — before the allowlist starts refusing its sessions.
 */
export function assertModelPolicy(
  agentCommand: string | undefined,
  model: string | undefined,
  options?: ModelPolicyOptions,
): void {
  const requested = model?.trim();
  // 🛑 THE ROUTE GATE IS FIRST AND IT IS WHAT KEEPS THE ALLOWLIST OFF EVERY OTHER
  // HARNESS. A bare alias (`opus`, `sonnet`, `default`, `fable`) and a codex
  // composed id (`gpt-6-astra[high]`) leave here untouched — measured: zero
  // non-OpenRouter model ids carry a `/`. See `isOpenRouterRouteShapedModelId`.
  if (!requested || !isOpenRouterRouteShapedModelId(requested)) {
    return;
  }

  // 🛑 CLAUDE-FAMILY IS CHECKED BEFORE THE LIST AND INDEPENDENTLY OF IT — NOT
  // FOLDED INTO IT. Two reasons, and the second is why this ordering is not
  // cosmetic:
  //   1. the shipped refusal keeps its own legible message, verbatim (30eb2003);
  //   2. a Claude row accidentally added to the entitlement module would then
  //      PERMIT Claude on the metered route. Checked first, it cannot: the
  //      refusal does not consult the list at all. The module's own invariant
  //      test asserts no Claude row exists, so the two can never contradict —
  //      this ordering is what makes the contradiction harmless if it ever does.
  if (isClaudeFamilyModelId(requested)) {
    throw claudeFamilyRefusal(requested, agentCommand, options?.profileId);
  }

  const resolution = effectiveEntitlement(options);
  // A floating alias is refused on SHAPE, independently of the list — it is the
  // one id form that can start resolving to a pricier build with no edit by
  // anyone. See `isFloatingAliasModelId`.
  const floatingAlias = isFloatingAliasModelId(requested);
  if (!floatingAlias && isEntitledOpenRouterModelId(requested, resolution.entries)) {
    return;
  }
  throw notEntitled(requested, resolution, floatingAlias);
}

export type ModelPolicyOptions = {
  profileId?: string | undefined;
  /** Inject `S` instead of reading `providers.json` — tests, and only tests. */
  entitlement?: OpenRouterEntitlementResolution;
  /**
   * Called when the two layers are not provably in step, BEFORE the allow/refuse
   * decision and regardless of its outcome. Reporting is the caller's job (the spawn
   * path writes one line); the detection lives in `resolveOpenRouterEntitlement` so
   * a caller that forgets this callback cannot skip it — the same split
   * `applyBoxProviderEnv`'s `onConflict` uses.
   */
  onEntitlementSkew?: (skew: OpenRouterEntitlementSkew) => void;
};

/**
 * The shipped Claude-family refusal, unchanged. ⚠️ The harness term is the
 * DESCRIPTOR and is read only to WORD the message — never to decide it; see
 * {@link refusesClaudeFamilyOnOpenRouter} for why a name-gated version fails open.
 */
function claudeFamilyRefusal(
  requested: string,
  agentCommand: string | undefined,
  profileId: string | undefined,
): ClaudeFamilyOnOpenRouterError {
  const harness = harnessIdForAgentCommand(agentCommand);
  return new ClaudeFamilyOnOpenRouterError(
    claudeFamilyOnOpenRouterMessage({
      requested,
      ...(harness !== undefined ? { harness } : {}),
      ...(profileId ? { profileId } : {}),
    }),
  );
}

/** `S`, plus the skew report fired as a side effect. Split out for the complexity budget. */
function effectiveEntitlement(
  options: ModelPolicyOptions | undefined,
): OpenRouterEntitlementResolution {
  const resolution = options?.entitlement ?? resolveOpenRouterEntitlement();
  if (resolution.skew !== undefined && options?.onEntitlementSkew) {
    options.onEntitlementSkew(resolution.skew);
  }
  return resolution;
}

/** The refusal, built from `S` and the reason it is `S`. Split out for the complexity budget. */
function notEntitled(
  requested: string,
  resolution: OpenRouterEntitlementResolution,
  floatingAlias: boolean,
): OpenRouterModelNotEntitledError {
  return new OpenRouterModelNotEntitledError(
    openRouterNotEntitledMessage({
      requested,
      entries: resolution.entries,
      narrowed: resolution.narrowed,
      // ⚠️ ONLY a settled state (`skew === undefined`) proves the key came from THIS
      // list. Pre-cutover and under skew acpx does not know, and must not say.
      providerEnforced: resolution.skew === undefined,
      floatingAlias,
    }),
  );
}

/**
 * The refusal for an OpenRouter id that is not Claude-family and not entitled
 * (brick daed4261 §9).
 *
 * 🛑 **IT NEVER CLAIMS THE KEY REFUSES THIS MODEL UNLESS ACPX CAN PROVE IT.** The
 * Claude-family message carries the same rule and the reason is recorded there: an
 * earlier draft of *that* message asserted the box key denied Claude-family slugs,
 * and it was **cut because it was false** — an agent could disprove it with one
 * `curl`, and a message it can falsify in one command is worth less than no message
 * at all.
 *
 * Here the claim is **derived from state rather than assumed**: `providerEnforced`
 * is true only when the box's `providers.json` entry records an `entitlementSha`
 * EQUAL to this build's, which is the one condition under which the key provably
 * came from this very list. Pre-cutover (no sha) and under skew (a different sha)
 * the sentence is omitted, because in both cases acpx genuinely does not know.
 */
function openRouterNotEntitledMessage(params: {
  requested: string;
  entries: readonly { slug: string }[];
  narrowed: boolean;
  providerEnforced: boolean;
  floatingAlias: boolean;
}): string {
  const allowed = params.entries.map((entry) => `    --model openrouter/${entry.slug}`).join("\n");
  const why = params.floatingAlias
    ? `"${params.requested}" is a FLOATING alias: OpenRouter re-points \`~…\` / \`…-latest\` ids at\n` +
      `  whatever build is current, so what it costs can change with no edit by anyone. Pin the\n` +
      `  dated build instead — an ordinary slug's id never floats.\n`
    : `"${params.requested}" is not in this box's OpenRouter entitlement set.\n`;
  const narrowed = params.narrowed
    ? `\n  ⚠️ acpx has NARROWED the set to the green list because this build's entitlement list does\n` +
      `  not match the one this box's key was minted from — see the warning above. The full set may\n` +
      `  be wider than what is listed here.\n`
    : "";
  const provider = params.providerEnforced
    ? `  This is not only an acpx rule: the box's OpenRouter key is bounded to this same list at the\n` +
      `  provider, so calling OpenRouter directly with it would be refused too.\n`
    : `  The box key is not yet bounded to this list at the provider, so this refusal is acpx's\n` +
      `  alone. It is still the rule; calling OpenRouter directly to get around it is a reportable\n` +
      `  action, not a loophole.\n`;
  return (
    `[acpx] refusing --model "${params.requested}": ${why}` +
    `  OpenRouter bills metered API pricing out of the box key, so the models an agent may choose\n` +
    `  are an enumerated set.\n` +
    narrowed +
    `\n  entitled models on this box:\n${allowed}\n` +
    `\n${provider}` +
    `\n  Claude-family models are a separate matter: they are served by our subscriptions at no\n` +
    `  marginal cost — use \`--model sonnet\` / \`--model opus\` on a claude agent.\n` +
    `  Anything outside the set above needs Daniel's explicit say-so for that spawn, and adding a\n` +
    `  model to it requires re-minting the key — there is no per-task exception to waive here.`
  );
}

/**
 * Thrown when a non-Claude OpenRouter model outside the entitlement set is selected
 * (brick daed4261).
 *
 * Its own class rather than a reuse of {@link ClaudeFamilyOnOpenRouterError}: the
 * two refusals have different remedies — one points at a free subscription route,
 * the other at an enumerated set and Daniel — and a caller, human or agent, must be
 * able to tell them apart by `detailCode` rather than by parsing prose. Same
 * `outputCode: "USAGE"` so both surface as legible CLI errors rather than adapter
 * crashes.
 */
export class OpenRouterModelNotEntitledError extends AcpxOperationalError {
  constructor(message: string) {
    super(message, {
      outputCode: "USAGE",
      detailCode: "OPENROUTER_MODEL_NOT_ENTITLED",
      origin: "cli",
      // ⚠️ THE SAME TOKEN THE READ PATH PUTS ON `availability.<agent>.reason`, and the
      // same one Tier 1's refusal carries. `detailCode` differs by tier and cannot be
      // made to agree — it names WHICH GATE fired — so this is the field a caller uses
      // to ask "was this refused for entitlement?" without matching prose that is
      // tuned for an agent to read and expected to change.
      policyReason: OPENROUTER_NOT_ENTITLED_REASON,
    });
    this.name = "OpenRouterModelNotEntitledError";
  }
}

/**
 * Tier 3's annotation for a non-entitled OpenRouter row, and the `availability`
 * reason slug that carries it (brick daed4261 §1.4 — the READ path).
 *
 * ⚠️ **THE READ PATH MATTERS BECAUSE THE PROVIDER'S DOES NOT NARROW.** Measured
 * 2026-09-29: `GET /api/v1/models` on a guardrail-restricted key returns the FULL
 * catalogue (464 rows), un-narrowed. So without this annotation acpx keeps
 * advertising models the key will refuse, an agent picks one, and the failure
 * arrives as a provider 403 that nothing interprets. Narrowing here is the same
 * invariant as the spawn-time refusal, one consumer further out — and it is driven
 * by the same module, with no network and no credential.
 */
export const OPENROUTER_NOT_ENTITLED_REASON = "openrouter-not-entitled";

/**
 * The annotation for a non-entitled row — **a function of the CURRENT state, never a
 * constant.**
 *
 * 🛑 **IT WAS A CONSTANT, AND THAT MADE TIER 1 NAME THE REFUSED MODEL IN ITS OWN
 * REMEDY LIST.** The constant enumerated the full {@link OPENROUTER_ENTITLEMENT}, so
 * under sha skew — where acpx has narrowed `S` to the green list — asking for
 * `qwen/qwen3.8-flash` was refused by a message that listed `qwen/qwen3.8-flash`
 * among the choosable models. **The agent had no available action**, and the obvious
 * next move is to retry the thing that just failed. Measured by the test engineer:
 * the Tier 1 message was BYTE-IDENTICAL across all three sha states (one md5 for
 * match, mismatch and absent alike) and always printed all five.
 *
 * ⚠️ **AND IT IS TIER 1, THE STATE-BLIND TIER, THAT PRODUCTION ACTUALLY REACHES** —
 * `assertModelAvailable` fires on the `--model` flag before the spawn guard ever
 * runs. P0's message was state-aware all along, which is exactly why a unit test
 * would miss this: P0 is the tier a test naturally drives and the rarely-reached one
 * in practice. **A refusal whose remedy names the refused model is worse than a bare
 * refusal.** The committed case asserts the message DIFFERS by sha state and that the
 * narrowed one contains no non-green slug.
 */
export function openRouterNotEntitledAnnotation(
  resolution: Pick<OpenRouterEntitlementResolution, "entries" | "narrowed">,
): string {
  const choosable = resolution.entries.map((entry) => entry.slug).join(", ");
  if (!resolution.narrowed) {
    return (
      "Not in this box's OpenRouter entitlement set — the box key is billed at metered API " +
      `pricing, so the choosable set is enumerated (${choosable}). Anything else needs Daniel's ` +
      "say-so for that spawn."
    );
  }
  // The skew explanation rides on the REFUSAL, not only on the success-path warning:
  // an agent refused while narrowed cannot otherwise tell a policy decision from a
  // deployment state, and the remedy is different for each.
  return (
    "Not choosable on this box right now. acpx has NARROWED the choosable set to the green list " +
    `(${choosable}) because this build's entitlement list does not match the one this box's ` +
    "OpenRouter key was minted from — the two enforcement layers are not in step, so acpx cannot " +
    "prove the key would serve anything wider. The full entitlement set is larger than the list " +
    "above; it is not offered while the skew stands. Remedy (operator): deploy the build whose " +
    "list the key was minted from, or re-mint the key from this build's list — " +
    "`pnpm run openrouter:entitlement` prints it."
  );
}

/**
 * Thrown when a Claude-family model is selected on the OpenRouter route (brick
 * 30eb2003).
 *
 * Deliberately its own class rather than a reused `ModelSlugError`: the route's
 * other spawn-time refusal is about a MISSING CREDENTIAL, and a caller — human or
 * agent — must be able to tell *"this box cannot"* from *"this box will not"*.
 * `outputCode: "USAGE"` puts it on the same exit path as the other model-selection
 * refusals, so it surfaces as a legible CLI error and not as an adapter crash.
 */
export class ClaudeFamilyOnOpenRouterError extends AcpxOperationalError {
  constructor(message: string) {
    super(message, {
      outputCode: "USAGE",
      detailCode: "CLAUDE_FAMILY_ON_OPENROUTER",
      origin: "cli",
      // Same mechanism as the entitlement refusal: the token the read path already
      // uses for this policy, so both tiers agree on WHICH policy refused even where
      // their detail codes cannot (brick daed4261).
      policyReason: CLAUDE_FAMILY_OPENROUTER_REASON,
    });
    this.name = "ClaudeFamilyOnOpenRouterError";
  }
}
