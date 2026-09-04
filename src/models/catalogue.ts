/**
 * The model catalogue — ONE list, all sources, every derivation done here.
 *
 * Everything a caller could otherwise re-derive (the depth ladder, the vendor,
 * the billing, the badges, selectability, the per-agent availability, the
 * counts) is computed in this module and shipped ready-made. Daniel, 2026-09-03
 * 22:58:57Z: "ACPX needs to be the basis for all of this."
 */

import { readHarnessCapabilities } from "./capability-source.js";
import type { AvailabilityCapability } from "./capability-source.js";
import { deriveDepthDescriptor } from "./depth.js";
import { harnessNativeModels } from "./harness-models.js";
import type { NativeModel } from "./harness-models.js";
import { loadOpenRouterCatalogue } from "./openrouter-catalogue.js";
import type { LoadOptions, OpenRouterRawModel } from "./openrouter-catalogue.js";
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

export function deriveBilling(model: OpenRouterRawModel): ModelBilling {
  const prompt = model.pricing?.prompt;
  if (prompt === "-1") {
    return { kind: "variable", inPerM: null, outPerM: null, account: OPENROUTER_ACCOUNT };
  }
  const inPerM = perMillion(prompt);
  const outPerM = perMillion(model.pricing?.completion);
  if (inPerM === 0 && (outPerM ?? 0) === 0) {
    return { kind: "free", inPerM: 0, outPerM: 0, account: OPENROUTER_ACCOUNT };
  }
  return { kind: "metered", inPerM, outPerM, account: OPENROUTER_ACCOUNT };
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
): Record<string, AgentAvailability> {
  const availability: Record<string, AgentAvailability> = {};
  for (const capability of capabilities) {
    availability[capability.id] = availabilityFor(model, nativeAgentTypes, capability);
  }
  return availability;
}

function availabilityFor(
  model: CatalogueModel,
  nativeAgentTypes: string[] | undefined,
  capability: AvailabilityCapability,
): AgentAvailability {
  const blocking = model.unavailableReasons[0];
  if (blocking) {
    return { ok: false, reason: blocking.reason, message: blocking.message };
  }

  if (nativeAgentTypes) {
    // A harness-native row belongs to exactly the agent types that can spawn it.
    return nativeAgentTypes.includes(capability.id)
      ? { ok: true }
      : {
          ok: false,
          reason: "other-harness",
          message: `${model.source} models are not reachable from a ${capability.id} session`,
        };
  }

  if (!capability.acceptsArbitraryModelIds) {
    return {
      ok: false,
      reason: "agent-fixed-backend",
      message: `${capability.id} sessions cannot be created with an arbitrary model id`,
    };
  }

  return { ok: true };
}

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

  const models: CatalogueModel[] = [];
  for (const native of natives) {
    const { agentTypes, ...row } = native;
    models.push({ ...row, availability: computeAvailability(row, agentTypes, capabilities) });
  }
  for (const raw of openRouterModels) {
    const model = toCatalogueModel(raw, equivalence, now);
    models.push({ ...model, availability: computeAvailability(model, undefined, capabilities) });
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
