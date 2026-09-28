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
 *   Tier 3  `availabilityFor`            The menu says why. DECLARATION ONLY —
 *                                        availability annotates, never filters, so
 *                                        it must never be called enforcement.
 *
 * ## Why this module sits LOW in the import graph
 *
 * Three call sites need the same predicate and the same wording, and they already
 * import each other: `openrouter-routing.ts` imports `parseModelRef` from
 * `model-slug-validation.ts`, and both import `catalogue.ts`. Anything shared must
 * therefore sit below all three. ⚠️ The two imports below are safe because neither
 * `errors.ts` (type-only imports) nor `harness-capabilities.ts` (imports only
 * `agent-command.js`) reaches back into `models/`. DO NOT add an import from
 * `models/` here — that is what would close the cycle.
 */

import { harnessIdForAgentCommand } from "../acp/harness-capabilities.js";
import { AcpxOperationalError } from "../errors.js";

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
 * ★ THE ENFORCEMENT (P0). Refuse a Claude-family model on the OpenRouter route,
 * for ANY harness, aborting the spawn.
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
 * it. There are no false positives to trade against: a Claude-native id is a bare
 * alias (`sonnet`, `opus`, `default`, `fable`) and cannot match, and no other
 * harness's ids are namespaced under `anthropic/`. The harness is still read — but
 * only to WORD the refusal, never to decide it.
 */
export function assertModelPolicy(
  agentCommand: string | undefined,
  model: string | undefined,
  options?: { profileId?: string | undefined },
): void {
  const requested = model?.trim();
  if (!requested || !isClaudeFamilyModelId(requested)) {
    return;
  }
  const harness = harnessIdForAgentCommand(agentCommand);
  throw new ClaudeFamilyOnOpenRouterError(
    claudeFamilyOnOpenRouterMessage({
      requested,
      ...(harness !== undefined ? { harness } : {}),
      ...(options?.profileId ? { profileId: options.profileId } : {}),
    }),
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
    });
    this.name = "ClaudeFamilyOnOpenRouterError";
  }
}
