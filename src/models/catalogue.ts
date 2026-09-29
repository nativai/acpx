/**
 * The model catalogue — ONE list, all sources, every derivation done here.
 *
 * Everything a caller could otherwise re-derive (the depth ladder, the vendor,
 * the billing, the badges, selectability, the per-agent availability, the
 * counts) is computed in this module and shipped ready-made. Daniel, 2026-09-03
 * 22:58:57Z: "ACPX needs to be the basis for all of this."
 */

import type { ArbitraryModelSupport } from "../acp/harness-capabilities.js";
import { readHarnessCapabilities } from "./capability-source.js";
import type { AvailabilityCapability } from "./capability-source.js";
import {
  CLAUDE_FAMILY_OPENROUTER_ANNOTATION,
  CLAUDE_FAMILY_OPENROUTER_REASON,
  openRouterNotEntitledAnnotation,
  OPENROUTER_NOT_ENTITLED_REASON,
  refusesClaudeFamilyOnOpenRouter,
} from "./claude-family.js";
import { deriveDepthDescriptor } from "./depth.js";
import { harnessNativeModels } from "./harness-models.js";
import type { NativeModel } from "./harness-models.js";
import { loadOpenRouterCatalogue } from "./openrouter-catalogue.js";
import type { LoadOptions, OpenRouterRawModel } from "./openrouter-catalogue.js";
import {
  isEntitledOpenRouterModelId,
  resolveOpenRouterEntitlement,
  type OpenRouterEntitlementResolution,
} from "./openrouter-entitlement.js";
import type {
  AgentAvailability,
  CatalogueCounts,
  SelectabilityCounts,
  CatalogueModel,
  ModelBilling,
  ModelBadge,
  ModelCatalogue,
  UnavailableReason,
} from "./types.js";
import { deriveWireModelId } from "./wire-model-id.js";

/** Rows newer than this many days carry the `newest` badge. */
const NEWEST_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const OPENROUTER_ACCOUNT = "openrouter";

// ── Selectability ────────────────────────────────────────────────────────────
// Derived PURELY from catalogue facts, so the arithmetic is reproducible from
// the raw roster alone (C4 §7.3). The counts are computed, never hardcoded: the
// roster drifts (425 at 2026-09-03T21:36Z, 426 at 23:54Z) and the RULES are the
// oracle, not the numbers.

export function unavailableReasonsFor(model: OpenRouterRawModel): UnavailableReason[] {
  const reasons: UnavailableReason[] = [];
  if (model.id.endsWith(":batch")) {
    reasons.push({
      reason: "batch-endpoint",
      message: "batch endpoint — a session cannot stream from it",
    });
  }
  if (!(model.supported_parameters ?? []).includes("tools")) {
    reasons.push({
      reason: "no-tool-calling",
      message: "does not support tool calling — a coding agent cannot run on it",
    });
  }
  if (model.pricing?.prompt === "-1") {
    reasons.push({
      reason: "variable-price",
      message: "routes to an unpredictable model — cost and depth cannot be stated up front",
    });
  }
  return reasons;
}

function perMillion(price: string | undefined): number | null {
  if (price === undefined) {
    return null;
  }
  const value = Number(price);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return value * 1_000_000;
}

/**
 * The cache rates, read from the SAME upstream row as the prompt/completion rates
 * so they can never disagree with them about which model they describe
 * (brick 6253611b). They ride along on every branch of {@link deriveBilling}.
 */
function deriveCacheRates(model: OpenRouterRawModel): {
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
} {
  return {
    cacheReadPerM: perMillion(model.pricing?.input_cache_read),
    cacheWritePerM: perMillion(model.pricing?.input_cache_write),
  };
}

/**
 * A MEASURED zero — the upstream row quotes zero for both directions.
 *
 * ⚠️ Distinct from "no price is known", which is `variable`/absent (see
 * `ModelBilling`). An absent completion rate beside a zero prompt rate still counts
 * as measured-zero, which is what the `?? 0` states.
 */
function isMeasuredZeroPrice(inPerM: number | null, outPerM: number | null): boolean {
  return inPerM === 0 && (outPerM ?? 0) === 0;
}

export function deriveBilling(model: OpenRouterRawModel): ModelBilling {
  const prompt = model.pricing?.prompt;
  const { cacheReadPerM, cacheWritePerM } = deriveCacheRates(model);
  if (prompt === "-1") {
    return {
      kind: "variable",
      inPerM: null,
      outPerM: null,
      cacheReadPerM: null,
      cacheWritePerM: null,
      account: OPENROUTER_ACCOUNT,
    };
  }
  const inPerM = perMillion(prompt);
  const outPerM = perMillion(model.pricing?.completion);
  if (isMeasuredZeroPrice(inPerM, outPerM)) {
    return {
      kind: "free",
      inPerM: 0,
      outPerM: 0,
      cacheReadPerM: cacheReadPerM ?? 0,
      cacheWritePerM: cacheWritePerM ?? 0,
      account: OPENROUTER_ACCOUNT,
    };
  }
  return {
    kind: "metered",
    inPerM,
    outPerM,
    cacheReadPerM,
    cacheWritePerM,
    account: OPENROUTER_ACCOUNT,
  };
}

/** The band grouping. Derived server-side so the UI and the CLI band identically (C5 §8.1). */
export function deriveVendor(id: string): string {
  const slash = id.indexOf("/");
  const prefix = slash === -1 ? id : id.slice(0, slash);
  // The 13 `~vendor/…-latest` alias rows carry a leading tilde on the prefix.
  return prefix.startsWith("~") ? prefix.slice(1) : prefix;
}

function deriveBadges(model: OpenRouterRawModel, now: number): ModelBadge[] {
  const badges: ModelBadge[] = [];
  if (model.id.endsWith(":free")) {
    badges.push("free");
  }
  if (model.alias_target) {
    badges.push("alias");
  }
  if (model.id.endsWith(":batch")) {
    badges.push("batch");
  }
  if (model.created !== undefined && now - model.created * 1000 <= NEWEST_WINDOW_MS) {
    badges.push("newest");
  }
  return badges;
}

/**
 * Intra-OpenRouter equivalence only: two rows sharing a `canonical_slug` are the
 * same weights. The cross-source alias map is deliberately deferred (C4 §11a
 * answer 5) — the field degrades to no badge, and the price + source cell still
 * carries the whole distinction.
 */
function buildEquivalenceIndex(models: OpenRouterRawModel[]): Map<string, string[]> {
  const bySlug = new Map<string, string[]>();
  for (const model of models) {
    const slug = model.canonical_slug;
    if (!slug) {
      continue;
    }
    const keys = bySlug.get(slug) ?? [];
    keys.push(`openrouter:${model.id}`);
    bySlug.set(slug, keys);
  }
  return bySlug;
}

/** The plain fields, defaulted — kept apart so the row builder stays readable. */
function plainFields(raw: OpenRouterRawModel) {
  return {
    name: raw.name ?? raw.id,
    description: raw.description ?? null,
    contextLength: raw.context_length ?? null,
    tools: (raw.supported_parameters ?? []).includes("tools"),
    createdAt: raw.created ?? null,
    aliasTarget: raw.alias_target ? { id: raw.alias_target, name: null } : null,
  };
}

function toCatalogueModel(
  raw: OpenRouterRawModel,
  equivalence: Map<string, string[]>,
  now: number,
): CatalogueModel {
  const key = `openrouter:${raw.id}`;
  const reasons = unavailableReasonsFor(raw);
  const sameWeights = raw.canonical_slug ? (equivalence.get(raw.canonical_slug) ?? []) : [];

  return {
    key,
    source: "openrouter",
    id: raw.id,
    vendor: deriveVendor(raw.id),
    billing: deriveBilling(raw),
    depth: deriveDepthDescriptor(raw.reasoning),
    badges: deriveBadges(raw, now),
    equivalentTo: sameWeights.filter((other) => other !== key),
    selectable: reasons.length === 0,
    unavailableReasons: reasons,
    availability: {},
    favorite: false,
    favoritedAt: null,
    ...plainFields(raw),
  };
}

// ── The availability join ────────────────────────────────────────────────────

/**
 * `availability` is a JOIN — catalogue selectability × acpx's harness-capability
 * table (C4 §7.2 rule 3) — and NOT a filter: the list never shrinks, it
 * annotates (C5 D6).
 *
 * With an empty capability table (today) every model gets `{}`: an empty map
 * says "acpx cannot yet answer this per agent type", which is honest. A guessed
 * `{claude: {ok: true}}` would be a lie the picker renders as fact.
 */
function computeAvailability(
  model: CatalogueModel,
  nativeAgentTypes: string[] | undefined,
  capabilities: AvailabilityCapability[],
  entitlement: OpenRouterEntitlementResolution,
): Record<string, AgentAvailability> {
  const availability: Record<string, AgentAvailability> = {};
  for (const capability of capabilities) {
    availability[capability.id] = availabilityFor(model, nativeAgentTypes, capability, entitlement);
  }
  return availability;
}

/**
 * ⚠️ `entitlement` IS PASSED IN, NOT RESOLVED HERE. `resolveOpenRouterEntitlement`
 * reads `providers.json`, and this function runs once per (row × capability) — ~458
 * rows × 3 capabilities on a live catalogue, so resolving inside would be ~1,400
 * file reads per `acpx models` call. `buildCatalogue` resolves it once.
 */
function availabilityFor(
  model: CatalogueModel,
  nativeAgentTypes: string[] | undefined,
  capability: AvailabilityCapability,
  entitlement: OpenRouterEntitlementResolution,
): AgentAvailability {
  const blocking = model.unavailableReasons[0];
  if (blocking) {
    return { ok: false, reason: blocking.reason, message: blocking.message };
  }

  if (nativeAgentTypes) {
    // A harness-native row belongs to exactly the agent types that can spawn it.
    return nativeAgentTypes.includes(capability.id)
      ? available(model, capability)
      : {
          ok: false,
          reason: "other-harness",
          message: `${model.source} models are not reachable from a ${capability.id} session`,
        };
  }

  // ── Tier 3: the Claude-family DECLARATION (brick 30eb2003) ─────────────────
  //
  // Sited after the harness-native arm, so it can only ever see an OpenRouter row —
  // a claude-native `sonnet` row is answered above and never reaches here.
  //
  // ⚠️ `capability.id` IS the harness id (this map is built from
  // `readHarnessCapabilities`, which projects `HARNESS_FACTS`), which is why the
  // SAME predicate the spawn-path gate uses is asked here. Two lists would drift;
  // one predicate cannot.
  //
  // 🛑 DECLARATION ONLY. Availability annotates and never filters — the row stays
  // in the list, greyed, with this reason — so this changes no spawn's outcome. It
  // is what makes the policy readable BEFORE an agent acts; `assertModelPolicy` is
  // what refuses. Never cite this as coverage.
  if (refusesClaudeFamilyOnOpenRouter({ harness: capability.id, modelId: model.id })) {
    return {
      ok: false,
      reason: CLAUDE_FAMILY_OPENROUTER_REASON,
      message: CLAUDE_FAMILY_OPENROUTER_ANNOTATION,
    };
  }

  if (!capability.acceptsArbitraryModelIds) {
    return arbitraryModelDenial(capability);
  }

  // ── The ENTITLEMENT declaration (brick daed4261 §9, the READ path) ──────────
  //
  // ⚠️ IT SITS AFTER THE `acceptsArbitraryModelIds` ARM ON PURPOSE. For codex —
  // which cannot reach OpenRouter at all — "this harness does not take arbitrary
  // model ids" is the more informative answer, and the committed assertion that
  // codex's reason is NOT a policy reason stays green. Reaching here means the
  // harness genuinely could run this row and only the entitlement set stops it.
  //
  // ⚠️ WHY THE READ PATH NEEDS THIS AT ALL: a guardrail-restricted key's
  // `GET /api/v1/models` returns the FULL catalogue, un-narrowed (measured
  // 2026-09-29, 464 rows). So the provider will not narrow the advertisement for
  // us — acpx would keep offering models the key refuses, an agent would pick one,
  // and the failure would arrive as a provider 403 that `probeOpenRouterRefusal`
  // interprets NOWHERE. Same module, same invariant, one consumer further out. No
  // network, no credential: the module is compiled in.
  //
  // 🛑 **NOT DECLARATION-ONLY — AND UNLIKE THE CLAUDE BRANCH ABOVE, THIS ONE DOES
  // CHANGE OUTCOMES.** Saying otherwise would be the "comment a future reader trusts
  // INSTEAD of reading the code" failure, so: `availability` is also consumed by
  // `assertModelAvailable` (`model-slug-validation.ts`), which THROWS
  // `ModelSlugError` / `MODEL_NOT_AVAILABLE_FOR_AGENT`. So a row marked unavailable
  // here is REFUSED by the Tier 1 `--model` gate, which runs BEFORE
  // `assertModelPolicy`. Two consequences worth knowing:
  //
  //   · for a catalogued id passed as `--model`, the message an agent sees is
  //     {@link openRouterNotEntitledAnnotation} — which names the entitled set and
  //     the escape hatch — not `assertModelPolicy`'s longer one. That one still fires
  //     on the legs Tier 1 cannot reach (inherited / fork / template / resume) and
  //     whenever the catalogue is cold;
  //   · the two tiers therefore use DIFFERENT detailCodes for one policy. A caller
  //     discriminating on `detailCode` must expect either.
  //
  // This is the intended direction — the tiers agreeing is the whole point — but it
  // is a wider change than "annotation", which is why it is written down here.
  //
  // What it also changes is the default LISTING: a not-available row is bucketed
  // `unavailable` by `partitionModels` and `acpx models list` drops that band unless
  // `--all`, so the row is ABSENT by default and LISTED WITH THIS REASON under
  // `--all` and on `acpx models show`. That split is deliberate — availability
  // annotates and never filters — so an agent asking "why can I not use this?" always
  // gets an answer, which is the exact opposite of the uninterpretable 403 above.
  if (!isEntitledOpenRouterModelId(model.id, entitlement.entries)) {
    return {
      ok: false,
      reason: OPENROUTER_NOT_ENTITLED_REASON,
      message: openRouterNotEntitledAnnotation(entitlement),
    };
  }

  return available(model, capability);
}

/**
 * An `ok` answer, carrying the wire id the caller must send.
 *
 * ⚠️ **A ROW WITH NO STATABLE WIRE ID IS NOT AVAILABLE.** `deriveWireModelId`
 * returns `null` only where acpx cannot name an id that is valid on its own — a
 * depth-fused harness on a row whose ladder has no default rung — and for such a
 * harness a bare id is REFUSED at the adapter. Returning `ok: true` with no
 * `modelId` would hand the picker a row it can only offer by guessing, which is
 * the failure this whole field exists to end. So the absence is reported as an
 * unavailability with its own reason rather than as a silently incomplete `ok`.
 */
function available(model: CatalogueModel, capability: AvailabilityCapability): AgentAvailability {
  const modelId = deriveWireModelId({
    row: model,
    idForm: capability.idForm,
    depthFusedIntoId: capability.depthFusedIntoId,
  });
  if (modelId === null) {
    return {
      ok: false,
      reason: "no-wire-id",
      message:
        `${capability.id} fuses the thinking depth into the model id, and ${model.key} ` +
        `advertises no default depth — acpx cannot state an id to send`,
    };
  }
  return { ok: true, modelId };
}

/**
 * WHY an arbitrary model id is refused — **keyed on the SUPPORT KIND, never on
 * the harness NAME**, so a harness that changes kind cannot silently keep a
 * reason that has stopped being true.
 *
 * ## This split is a CORRECTNESS fix, not a UX one (brick c4da2ff2)
 *
 * Every locked harness used to collapse to `agent-fixed-backend`, and **for
 * claude that was FALSE**: its `arbitraryModelSupport` is `via-shim`, the shim
 * exists, and the `openrouter-deepseek [claude/openrouter]` profile exists — what
 * is missing is **acpx's own picker→shim wiring**. We were reporting our
 * unfinished plumbing as a fact about claude's backend, to every consumer of the
 * payload and not merely to the picker. A wrong reason outlives the UI that
 * works around it.
 *
 * The same was true of pi for as long as `provisioned` was declared and
 * the spawn was not yet routed — which is precisely why this is keyed on the
 * kind: that harness's answer corrected itself when the routing landed, with no
 * edit here.
 *
 *   `none`        → `agent-fixed-backend` — the backend genuinely is fixed.
 *                   PERMANENT; nothing acpx builds will change it.
 *   anything else → `acpx-not-wired`      — the harness CAN reach arbitrary
 *                   models; acpx is what is missing. A shipping target, not a
 *                   property of the harness.
 *
 * ## ⚠️ `acpx-not-wired` IS EXPECTED TO BECOME UNREACHABLE FOR CLAUDE
 *
 * When **007eaac8** wires the picker→shim path, claude's OpenRouter rows go
 * `ok: true` and this branch stops firing for it. **That is the intended end
 * state, and it is why the reason must never be described to anyone as a lasting
 * property of claude** — it describes the pre-routing state, and it stays
 * correct for any future `via-shim` harness that arrives unrouted. Keyed on the
 * kind, that transition needs no edit here: it is the same self-correction
 * pi's answer already made when its routing landed.
 */
function arbitraryModelDenial(capability: AvailabilityCapability): AgentAvailability {
  if (capability.arbitraryModelSupport === "none") {
    return {
      ok: false,
      reason: "agent-fixed-backend",
      message: `${capability.id} runs on a fixed backend and cannot be created with an arbitrary model id`,
    };
  }
  return {
    ok: false,
    reason: "acpx-not-wired",
    message: `${capability.id} ${ARBITRARY_MODEL_GAP[capability.arbitraryModelSupport]}`,
  };
}

/**
 * The gap, per kind — a TOTAL map, not a switch with a fallback.
 *
 * A new {@link ArbitraryModelSupport} member fails to compile here rather than
 * silently inheriting whichever sentence a `default:` arm happened to hold. That
 * is the same property `HarnessCapabilityFacts` buys by omitting the derived
 * fields: make the wrong thing a type error, not something a reviewer catches.
 */
const ARBITRARY_MODEL_GAP = {
  "via-shim":
    "can reach arbitrary models through a credential-profile shim, but acpx does not yet wire a model selection into it",
  provisioned:
    "can reach arbitrary models once acpx provisions them into its own config, and acpx does not provision for it yet",
  native: "accepts arbitrary model ids natively, but acpx does not route that support yet",
} satisfies Record<Exclude<ArbitraryModelSupport, "none">, string>;

// ── Assembly ─────────────────────────────────────────────────────────────────

function countSelectability(models: CatalogueModel[]): SelectabilityCounts {
  const selectable = models.filter((model) => model.selectable).length;
  return { total: models.length, selectable, unavailable: models.length - selectable };
}

/**
 * COMPUTED, never hardcoded. The roster drifts — 425 models at 2026-09-03T21:36Z,
 * 426 at 23:54Z, and the selectable count landed on 292 both times — so the
 * RULES are the oracle and the numbers are an observation with a timestamp.
 */
export function countModels(models: CatalogueModel[]): CatalogueCounts {
  return {
    ...countSelectability(models),
    openRouter: countSelectability(models.filter((model) => model.source === "openrouter")),
  };
}

export type BuildCatalogueOptions = {
  now?: number;
  capabilities?: AvailabilityCapability[];
  nativeModels?: NativeModel[];
  /**
   * Inject the entitlement set (brick daed4261 §9) instead of resolving it from
   * this box's `providers.json`. Tests use it so the annotation does not depend on
   * whether this box's key records an `entitlementSha` — a box-dependent test here
   * would read as a catalogue bug.
   */
  entitlement?: OpenRouterEntitlementResolution;
};

/** Merge the raw OpenRouter rows with the harness-native rows into ONE ordered list. */
export function buildCatalogue(
  openRouterModels: OpenRouterRawModel[],
  meta: { fetchedAt: string | null; stale: boolean; error: string | null },
  options: BuildCatalogueOptions = {},
): ModelCatalogue {
  const now = options.now ?? Date.now();
  const capabilities = options.capabilities ?? readHarnessCapabilities();
  const natives = options.nativeModels ?? harnessNativeModels();
  const equivalence = buildEquivalenceIndex(openRouterModels);
  // Resolved ONCE — see `availabilityFor`'s note on why this is not per row.
  const entitlement = options.entitlement ?? resolveOpenRouterEntitlement();

  const models: CatalogueModel[] = [];
  for (const native of natives) {
    const { agentTypes, ...row } = native;
    models.push({
      ...row,
      availability: computeAvailability(row, agentTypes, capabilities, entitlement),
    });
  }
  for (const raw of openRouterModels) {
    const model = toCatalogueModel(raw, equivalence, now);
    models.push({
      ...model,
      availability: computeAvailability(model, undefined, capabilities, entitlement),
    });
  }

  return {
    fetchedAt: meta.fetchedAt,
    stale: meta.stale,
    error: meta.error,
    counts: countModels(models),
    models,
  };
}

/** Load (cache-first) and assemble. The one entry point every caller uses. */
export async function loadCatalogue(
  options: LoadOptions & BuildCatalogueOptions = {},
): Promise<ModelCatalogue> {
  const { now, capabilities, nativeModels, ...loadOptions } = options;
  const result = await loadOpenRouterCatalogue(loadOptions);
  return buildCatalogue(
    result.snapshot?.models ?? [],
    {
      // No snapshot ⇒ no successful fetch has ever produced these rows, so there
      // is no fetch time to report. `null`, never "now": see the note on
      // ModelCatalogue.fetchedAt.
      fetchedAt: result.snapshot?.fetchedAt ?? null,
      stale: result.stale,
      error: result.error,
    },
    { now, capabilities, nativeModels },
  );
}

/**
 * Stamp the per-box favorites onto the payload, so a caller never has to join
 * two lists to draw one row (the picker, the CLI and an agent reading `--json`
 * all need `favorite` on the model itself — C5's `mock-cli.html` `--json` frame).
 */
export function decorateFavorites(
  catalogue: ModelCatalogue,
  favorites: readonly { key: string; favoritedAt: string }[],
): ModelCatalogue {
  const byKey = new Map(favorites.map((favorite) => [favorite.key, favorite.favoritedAt]));
  if (byKey.size === 0) {
    return catalogue;
  }
  return {
    ...catalogue,
    models: catalogue.models.map((model) => {
      const favoritedAt = byKey.get(model.key);
      return favoritedAt === undefined ? model : { ...model, favorite: true, favoritedAt };
    }),
  };
}

export function findModelsById(catalogue: ModelCatalogue, id: string): CatalogueModel[] {
  const needle = id.trim().toLowerCase();
  return catalogue.models.filter((model) => model.id.toLowerCase() === needle);
}

export function findModelByKey(catalogue: ModelCatalogue, key: string): CatalogueModel | undefined {
  const needle = key.trim().toLowerCase();
  return catalogue.models.find((model) => model.key.toLowerCase() === needle);
}
