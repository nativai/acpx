/**
 * THE SINGLE SOURCE OF TRUTH for what this box's OpenRouter key may be billed for
 * (brick daed4261, CONCEPTION §9).
 *
 * ## Why one module and not two lists
 *
 * Two enforcement layers ship against this set: this code, refusing at spawn; and
 * the provider, refusing a real HTTP call because the key's `allowed_models`
 * guardrail bounds it. **If they can differ, the failure lands in the worst
 * possible place.** A model the code permits and the key refuses comes back as a
 * provider 403 mid-turn — and a 403 is recognised NOWHERE: `probeOpenRouterRefusal`
 * returns `undefined` for any status that is not 429
 * (`openrouter-refusal-reason.ts:249-251`) and only runs at all when the turn error
 * says `timed out`/`timeout` (`:81-84`). So the agent gets an *uninterpretable*
 * turn failure, and an agent meeting an unexplained obstacle reads it as transient
 * infrastructure and retries.
 *
 * ⇒ The key's list is GENERATED from this module (`entitlementModelIds`, printed by
 * `pnpm run openrouter:entitlement`), never typed. Cardea validates
 * `scope.models` not at all — it passes verbatim into `allowed_models` — so a
 * hand-typed list is accepted end-to-end by both Cardea and OpenRouter while
 * enforcing nothing.
 *
 * ## THE INVARIANT — S ⊆ K at every instant
 *
 * `S` = the set this code permits at spawn. `K` = the key's `allowed_models`. The
 * code layer is NEVER wider than the key, so every refusal an agent can provoke by
 * *choosing a model* is the legible spawn-time one, and the provider 403 stays a
 * backstop for the paths code cannot reach (a hand-rolled `curl` with the ambient
 * key, `acpx pi set model` on a live session, an already-running adapter).
 *
 * 🛑 **IT IS A PROPERTY OF THE CODE'S SHAPE, NOT A RULE ANYONE HAS TO REMEMBER.**
 * Only two values of `S` are reachable — {@link OPENROUTER_ENTITLEMENT} and
 * {@link OPENROUTER_GREEN_LIST} — and the second is a `filter` of the first, so no
 * branch can produce an `S` holding an id outside this module. That is what makes
 * {@link resolveOpenRouterEntitlement}'s narrowing safe in BOTH skew directions:
 *
 *   widen  the set → mint first, code second → shas differ → S = G(old) ⊆ K_old ⊆ K_new
 *   narrow the set → code first, mint second → shas differ → S = G(new) ⊆ K_old
 *   settled                                 → shas equal  → S = the list K came from
 *
 * *"The code layer is the narrower one during skew"* therefore FALLS OUT of the
 * mechanism. Do not re-state it as a convention and do not add a branch that
 * widens `S` past this module.
 *
 * ## Why it lives in acpx, in code an agent can edit
 *
 * The spawn path must resolve this with **no network and no credential** — a rule
 * the route already enforces twice (`openrouter-routing.ts:123-128`, `:173-177`: a
 * create must never fail because a catalogue fetch was slow). Being version
 * controlled, diffable and reviewable is the other half; the guardrail is
 * structurally unreadable from any box (401 to the ambient key on
 * `/api/v1/guardrails`, `/guardrails/assignments/keys` and `/api/v1/keys`).
 *
 * **That this file is agent-editable is not a weakness of the design; it is the
 * design.** This layer is avowedly as strong as review — its job is FAST, LEGIBLE
 * FEEDBACK at the moment of the mistake. The unliftable copy is the one frozen into
 * the guardrail at mint time, which no box can read, let alone change.
 */

import { createHash } from "node:crypto";
import {
  loadBoxProviders,
  type BoxProviderEntry,
  type BoxProviderLookupOptions,
} from "../config/providers.js";

/** One entitled model, in BOTH id forms OpenRouter answers to. */
export type OpenRouterEntitlementEntry = {
  /** The plain slug, e.g. `z-ai/glm-5.3-flash`. */
  readonly slug: string;
  /**
   * The dated form, **READ from `/api/v1/models`, NEVER CONSTRUCTED**.
   *
   * 🛑 It is NOT `slug + date`. Three date formats and at least one word
   * reordering are on record: `anthropic/claude-fable-5` →
   * `anthropic/claude-5-fable-20260609` (word order differs),
   * `qwen/qwen3-235b-a22b` → `…-04-28` (dash-date), `z-ai/glm-5.3-flash` →
   * `…-20260826` (compact-date). A CONSTRUCTED canonical slug is accepted by
   * Cardea, by the guardrail write and by OpenRouter — and enforces nothing.
   */
  readonly canonicalSlug: string;
  /**
   * Green-listed = an agent may choose it without Daniel's per-spawn say-so
   * (`Skills/model-selection`). ⚠️ A SUBSET OF THIS LIST, NEVER A SECOND ONE — see
   * {@link OPENROUTER_GREEN_LIST}.
   */
  readonly greenListed?: true;
  /** Why this row is in the set — so a later reader can judge a removal. */
  readonly why: string;
};

/** When the `canonicalSlug` values below were read. */
export const OPENROUTER_ENTITLEMENT_MEASURED_AT = "2026-09-29";

/**
 * Where they were read from. **Public and unauthenticated** — no credential, no
 * cost, independently re-runnable, which is what makes the pre-mint catalogue
 * re-read a standing requirement rather than a favour.
 */
export const OPENROUTER_ENTITLEMENT_SOURCE = "https://openrouter.ai/api/v1/models";

/**
 * THE ENTITLEMENT SET — the models this box's key may be billed for at all.
 *
 * ⚠️ **THE ENTITLEMENT SET AND THE GREEN LIST ARE DIFFERENT SETS, AND COLLAPSING
 * THEM BREAKS WORKING SOFTWARE.** The green list answers *"what may an agent choose
 * without asking?"*; this answers *"what may this box bill at all?"* — and it must
 * be a superset, because measured live traffic legitimately sits outside the green
 * list: three `orseam-*` claude seam fixtures on `qwen/qwen3.8-flash` (preserved
 * deliberately — they are how someone re-tests this seam later) and
 * `tg-pi-personal-assistant-*`, Daniel's Telegram assistant, on
 * `moonshotai/kimi-k2.6`.
 *
 * 🛑 **THIS ARRAY IS THE ONE EDIT POINT.** Changing the set is deleting or adding
 * rows here — the sha regenerates itself, the generator output follows, and nothing
 * else in the codebase moves. It costs a per-box re-mint plus a revocation
 * (Cardea attaches a guardrail at MINT TIME ONLY), which is deliberate: it makes
 * policy and enforcement structurally unable to drift, and drift is exactly the
 * 2026-09-27 failure. **Do not build an in-band bypass to recover the old latency
 * — any lever an agent can pull is the rejected per-session-credential lever
 * wearing a new name.**
 *
 * ⚠️ **NO CLAUDE-FAMILY ROW, AND NO FLOATING `~…-latest` ALIAS, EVER.** Both are
 * refused by {@link assertModelPolicy} independently of this list, so a row added
 * here would not permit them — but it WOULD make the two layers disagree.
 * `test/openrouter-entitlement.test.ts` asserts all three invariants and goes red
 * on a violation.
 */
export const OPENROUTER_ENTITLEMENT: readonly OpenRouterEntitlementEntry[] = [
  {
    slug: "z-ai/glm-5.3-flash",
    canonicalSlug: "z-ai/glm-5.3-flash-20260826",
    greenListed: true,
    why: "green list · 34 open sessions measured 2026-09-29",
  },
  {
    slug: "deepseek/deepseek-v4.1-flash",
    canonicalSlug: "deepseek/deepseek-v4.1-flash-20260910",
    greenListed: true,
    why: "green list",
  },
  {
    slug: "qwen/qwen3.8-flash",
    canonicalSlug: "qwen/qwen3.8-flash-20260826",
    why: "5 live sessions — 3 claude orseam-* seam fixtures + 2 pi",
  },
  {
    slug: "moonshotai/kimi-k2.6",
    canonicalSlug: "moonshotai/kimi-k2.6-20260420",
    why: "live pi, incl. tg-pi-personal-assistant-* (Daniel's Telegram assistant)",
  },
  {
    slug: "moonshotai/kimi-k2-thinking",
    canonicalSlug: "moonshotai/kimi-k2-thinking-20251106",
    why: "1 live pi session",
  },
];

/**
 * `G` — the green list, **DERIVED BY FILTER**.
 *
 * 🛑 **NEVER REPLACE THIS WITH A SECOND LITERAL.** `G ⊆ K` is what licenses
 * narrowing to it as the safe response to sha skew, and as a `filter` that
 * containment is STRUCTURAL rather than asserted: every element is, by reference,
 * a row of {@link OPENROUTER_ENTITLEMENT}. A hand-written twin would be a second
 * list to keep in step — the exact defect this module exists to remove — and
 * `test/openrouter-entitlement.test.ts` checks reference identity, so it goes red
 * the moment one appears.
 */
export const OPENROUTER_GREEN_LIST: readonly OpenRouterEntitlementEntry[] =
  OPENROUTER_ENTITLEMENT.filter((entry) => entry.greenListed === true);

/**
 * Both id forms of every entry, deduped and sorted — the flat list the key's
 * `scope.models` is GENERATED from — print it with `pnpm run openrouter:entitlement`.
 *
 * ⚠️ **BOTH FORMS ON PURPOSE, AND IT IS NOT HEDGING.** Nothing validates which
 * form `allowed_models` enforces on: the field takes "slug or canonical_slug" and
 * a list written in the wrong form is ACCEPTED and enforces NOTHING, silently.
 * Two spellings of one model **cannot widen the scope**, so carrying both is
 * form-agnostic — it closes the trap structurally instead of by guessing.
 */
export function entitlementModelIds(
  entries: readonly OpenRouterEntitlementEntry[] = OPENROUTER_ENTITLEMENT,
): readonly string[] {
  return [...new Set(entries.flatMap((entry) => [entry.slug, entry.canonicalSlug]))].toSorted();
}

/**
 * The fingerprint that ties the two layers together, over exactly the strings the
 * guardrail was generated from.
 *
 * ⚠️ **COMPUTED FROM THE ROWS, NEVER STORED AS A CONSTANT.** A hardcoded sha is a
 * second source of truth that goes stale on the first edit to the list — silently,
 * and in the direction that reports "in step" while the lists differ.
 */
export function entitlementSha(
  entries: readonly OpenRouterEntitlementEntry[] = OPENROUTER_ENTITLEMENT,
): string {
  return createHash("sha256").update(entitlementModelIds(entries).join("\n")).digest("hex");
}

/** This build's entitlement sha — the code half of the tie. */
export const OPENROUTER_ENTITLEMENT_SHA = entitlementSha();

/** The `providers.json` entry that pays for the OpenRouter route. */
const OPENROUTER_PROVIDER_ENTRY = "openrouter";

const OPENROUTER_ID_PREFIXES = ["openrouter/", "openrouter:"] as const;

/** A leading `openrouter/` or `openrouter:` removed — the route prefix, either spelling. */
export function withoutOpenRouterRoutePrefix(id: string): string {
  const lower = id.trim().toLowerCase();
  const prefix = OPENROUTER_ID_PREFIXES.find((candidate) => lower.startsWith(candidate));
  return prefix === undefined ? lower : lower.slice(prefix.length);
}

/**
 * Whether this model id names the OpenRouter route at all — the gate that keeps
 * the allowlist off every other harness.
 *
 * 🛑 **THE NAMESPACE TEST IS LOAD-BEARING, NOT A TIDINESS CHECK. Without it this
 * predicate swallows every ordinary claude and codex session.** Measured on
 * devbox's whole session store, 2026-09-29: **zero non-OpenRouter model ids carry a
 * `/`.** claude and claude-pty run bare aliases (`opus` ×790, `sonnet` ×291,
 * `default` ×78, `fable` ×43, `haiku` ×6); codex runs bare ids with a bracket
 * (`gpt-6-astra[high]` ×32, 18 distinct forms); every namespaced id in the store is
 * an OpenRouter id. Structurally corroborated: `ModelSource` has five values
 * (`types.ts:12`) and the four non-OpenRouter ones carry only bare ids — claude's
 * compiled into `harness-models.ts`, codex's advertised bare over ACP.
 *
 * ⚠️ **NAME-SHAPED ON PURPOSE — IT MUST NOT CONSULT THE CATALOGUE.** The bare-slug
 * leg of the route reads the model cache, and a **cold** cache makes it stand
 * aside, so a catalogue-derived test would be silently absent exactly when the
 * cache is cold. `isClaudeFamilyModelId` is the existing precedent, for the same
 * reason.
 *
 * ⚠️ An EXPLICIT `openrouter:` / `openrouter/` prefix settles it on its own, even
 * with no namespace after it (`openrouter/free`) — the caller named the route.
 */
export function isOpenRouterRouteShapedModelId(id: string | null | undefined): boolean {
  if (typeof id !== "string") {
    return false;
  }
  const lower = id.trim().toLowerCase();
  if (OPENROUTER_ID_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  return withoutOpenRouterRoutePrefix(lower).includes("/");
}

/**
 * A FLOATING alias — OpenRouter's `~…` / `…-latest` rows, refused at this layer
 * **independently of the entitlement list**.
 *
 * ⚠️ **THEY ARE THE ONLY GENUINELY FLOATING IDS, WHICH IS WHY THEY ARE THE ONE
 * SHAPE WORTH A DEDICATED REFUSAL.** A plain slug's canonical is PINNED — measured
 * across three natural experiments, an undated slug's canonical is the OLDER date
 * and a newer build ships as a NEW slug — so an ordinary entry never goes stale.
 * An entry on a floating alias is the opposite: a standing hole that could **begin
 * resolving to a pricier build with no edit by anyone**. Fail-closed refusal is the
 * correct posture, and refusing by SHAPE catches an alias spelling nobody
 * anticipated.
 *
 * ⚠️ The companion check — no entry has `canonicalSlug === slug`, the measured
 * signature of a floating row — belongs to the module's invariants and cannot live
 * here: a *requested* id's canonical form is not knowable without the network.
 */
export function isFloatingAliasModelId(id: string | null | undefined): boolean {
  if (typeof id !== "string") {
    return false;
  }
  const slug = withoutOpenRouterRoutePrefix(id);
  return slug.startsWith("~") || slug.endsWith("-latest");
}

/** Whether `id` is one of `entries`' two id forms. The route prefix is stripped first. */
export function isEntitledOpenRouterModelId(
  id: string,
  entries: readonly OpenRouterEntitlementEntry[],
): boolean {
  const slug = withoutOpenRouterRoutePrefix(id);
  return entries.some((entry) => entry.slug === slug || entry.canonicalSlug === slug);
}

/**
 * WHY the effective set is what it is — reported on the spawn log, never inferred.
 *
 * - `mismatch` — the box's key was minted from a DIFFERENT list than this build
 *   carries. Real skew: narrow, and say so loudly.
 * - `unrecorded` — the entry records no sha (or there is no entry). **No key-side
 *   claim was ever made**, which is the pre-cutover state. Do not narrow; say so.
 */
export type OpenRouterEntitlementSkewKind = "mismatch" | "unrecorded";

export type OpenRouterEntitlementSkew = {
  kind: OpenRouterEntitlementSkewKind;
  /** The `providers.<name>` entry consulted. */
  name: string;
  /** This build's sha — a fingerprint of a public list, not a secret. */
  codeSha: string;
  /** The entry's sha, when it declares one. */
  entrySha?: string;
};

/** The effective allowed set, plus the reason it is that set. */
export type OpenRouterEntitlementResolution = {
  /** `S`. Always {@link OPENROUTER_ENTITLEMENT} or {@link OPENROUTER_GREEN_LIST}. */
  entries: readonly OpenRouterEntitlementEntry[];
  /** `true` when narrowed to the green list — i.e. `kind === "mismatch"`. */
  narrowed: boolean;
  /** Present whenever the two layers are not provably in step. */
  skew?: OpenRouterEntitlementSkew;
};

/**
 * Resolve `S` — **no network, no credential, no management key**, and it never
 * throws into session creation (`loadBoxProviders` degrades on a missing,
 * unreadable or malformed file, by its own contract).
 *
 * 🛑 **AN ABSENT `entitlementSha` DOES NOT NARROW, AND THAT IS A DECISION RATHER
 * THAN AN OMISSION.** The field means *"this key was minted from list X"*. Absent
 * means no key-side claim was ever recorded — the pre-cutover state, where the key
 * is UNRESTRICTED and therefore `S ⊆ K` holds for any `S`. Narrowing on absence
 * would refuse the open `orseam-*` sessions on `qwen/qwen3.8-flash` **before the
 * mint**: breaking traffic that was preserved on purpose, in the one window where
 * this control provides nothing. It is REPORTED rather than silent, because a check
 * that has not started must not look like a check that passed.
 *
 * ⚠️ **WHAT THIS CHECK IS, STATED SO NOBODY OVERCLAIMS IT: a skew detector between
 * two honest authorities, NOT an adversarial control.** An agent that can rewrite
 * `providers.json` can rewrite this module too. The adversarial control is the
 * key's guardrail, which no box can read or lift (401 from the ambient key on every
 * guardrail endpoint) — this half exists so an honest deploy ordering cannot
 * silently produce an uninterpretable provider 403.
 */
export function resolveOpenRouterEntitlement(
  options?: BoxProviderLookupOptions & { entry?: BoxProviderEntry | undefined },
): OpenRouterEntitlementResolution {
  const entry = options?.entry ?? findOpenRouterEntry(options);
  const entrySha = entry?.entitlementSha;
  const name = entry?.name ?? OPENROUTER_PROVIDER_ENTRY;
  if (entrySha === undefined) {
    return {
      entries: OPENROUTER_ENTITLEMENT,
      narrowed: false,
      skew: { kind: "unrecorded", name, codeSha: OPENROUTER_ENTITLEMENT_SHA },
    };
  }
  if (entrySha === OPENROUTER_ENTITLEMENT_SHA) {
    return { entries: OPENROUTER_ENTITLEMENT, narrowed: false };
  }
  return {
    entries: OPENROUTER_GREEN_LIST,
    narrowed: true,
    skew: { kind: "mismatch", name, codeSha: OPENROUTER_ENTITLEMENT_SHA, entrySha },
  };
}

/** ⚠️ Same never-throw-into-session-creation rule the route's catalogue read follows. */
function findOpenRouterEntry(
  options: BoxProviderLookupOptions | undefined,
): BoxProviderEntry | undefined {
  try {
    return loadBoxProviders(options).providers.find(
      (provider) => provider.name === OPENROUTER_PROVIDER_ENTRY,
    );
  } catch {
    return undefined;
  }
}

/**
 * The ONE wording for a skew, so the spawn path and any diagnostic cannot drift —
 * the same rule `formatBoxProviderEnvConflict` follows, and the same shape: say
 * which value is which, what the consequence is, and what to do about it. A
 * warning that names a divergence without naming the remedy just relocates the
 * puzzle.
 *
 * ⚠️ Carries no credential. A sha over a list of public model ids is not a secret,
 * and it is the only thing that makes the two layers comparable from a box at all.
 */
export function formatOpenRouterEntitlementSkew(skew: OpenRouterEntitlementSkew): string {
  const codeShort = skew.codeSha.slice(0, 16);
  if (skew.kind === "unrecorded") {
    return (
      // 🛑 IT SAYS WHAT ACPX KNOWS, NEVER WHAT THE PROVIDER WILL DO. An earlier
      // wording ended "…a non-entitled model is refused here but nothing refuses it
      // at the provider yet" — a claim about the KEY that this module cannot check,
      // and FALSE in the reassuring direction in the one state that matters: a key
      // that IS restricted while no sha was recorded. Then acpx uses the full set,
      // the provider refuses, and the operator has been told the opposite. The
      // doc-comment on `resolveOpenRouterEntitlement` is already careful that this is
      // a skew detector between two honest authorities and not an adversarial
      // control; this sentence had to be equally careful.
      `providers.${skew.name} records no entitlementSha, so acpx cannot prove its allowed set ` +
      `matches the one this box's OpenRouter key was minted from. Using the full entitlement ` +
      `list (sha256:${codeShort}, ${OPENROUTER_ENTITLEMENT.length} models). This is the expected ` +
      `state until the key is re-minted with a scope.models guardrail. ⚠️ acpx cannot tell from ` +
      `here whether this key is already restricted: if it is, a model acpx permits may still be ` +
      `refused at the provider. Record entitlementSha in the same change that restricts the key.`
    );
  }
  return (
    `providers.${skew.name} was minted from entitlement list sha256:` +
    `${skew.entrySha?.slice(0, 16) ?? "unknown"} but this build carries sha256:${codeShort} — the ` +
    `two enforcement layers are NOT in step. Narrowing to the green list ` +
    `(${OPENROUTER_GREEN_LIST.map((entry) => entry.slug).join(", ")}) so acpx can never permit a ` +
    `model the key would refuse with an uninterpretable 403. Remedy: deploy the build whose list ` +
    `the key was minted from, or re-mint the key from this build's list — run ` +
    // ⚠️ THE RUNNABLE FORM, NOT THE FILE NAME. This named
    // `scripts/print-openrouter-entitlement.mjs`, which does not exist (the script is
    // `.ts`); an operator who pasted it got "Cannot find module". It matters out of
    // proportion to its size because this line reaches an operator EXACTLY when the
    // two enforcement layers have diverged — the one moment they need a command that
    // runs rather than a path to debug.
    `\`pnpm run openrouter:entitlement\` to print it.`
  );
}
