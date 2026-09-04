/**
 * The matcher and the banding — C5 `UI-DESIGN.md` D4 and D5.
 *
 * They live HERE, in acpx, and not in a caller: "the UI never offers a model the
 * CLI cannot name, and the CLI never names one the UI will not show" (C5 §6) is
 * only testable if there is exactly one implementation of both.
 */

import { nativeAgentTypesForSource } from "./harness-models.js";
import type { CatalogueModel, ModelSource } from "./types.js";

/** Ranking tiers, best first (C5 D4). */
export const RANK_EXACT_ID = 0;
export const RANK_ID_PREFIX = 1;
export const RANK_NAME_PREFIX = 2;
export const RANK_WORD_BOUNDARY = 3;
export const RANK_SUBSTRING = 4;

export type MatchedModel = {
  model: CatalogueModel;
  rank: number;
};

type SearchIndexEntry = {
  id: string;
  name: string;
  vendor: string;
  haystack: string;
};

/** Precomputed once per catalogue; the filter is then string work on short strings. */
function indexOf(model: CatalogueModel): SearchIndexEntry {
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  const vendor = model.vendor.toLowerCase();
  return { id, name, vendor, haystack: `${name} ${id} ${vendor}` };
}

export function tokenize(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function hasWordBoundaryHit(haystack: string, token: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(token, from);
    if (at === -1) {
      return false;
    }
    if (at === 0 || !/[a-z0-9]/.test(haystack[at - 1] ?? "")) {
      return true;
    }
    from = at + 1;
  }
}

function rankFor(entry: SearchIndexEntry, query: string, tokens: string[]): number {
  if (entry.id === query) {
    return RANK_EXACT_ID;
  }
  if (entry.id.startsWith(query)) {
    return RANK_ID_PREFIX;
  }
  if (entry.name.startsWith(query)) {
    return RANK_NAME_PREFIX;
  }
  if (tokens.some((token) => hasWordBoundaryHit(entry.haystack, token))) {
    return RANK_WORD_BOUNDARY;
  }
  return RANK_SUBSTRING;
}

/**
 * Token-AND over `name + id + vendor`, case-insensitive: every whitespace-
 * separated token must appear somewhere (C5 D4 option c). Fuzzy subsequence
 * matching was rejected on purpose — at 425 slugs it returns plausible garbage,
 * which is the wrong trade when the user is choosing what to spend money on.
 *
 * Unavailable rows are ranked LAST but never dropped: silently hiding a model
 * someone typed the exact name of teaches them the picker is broken.
 */
export function searchModels(
  models: readonly CatalogueModel[],
  query: string,
  favorites: ReadonlySet<string> = new Set(),
): MatchedModel[] {
  const tokens = tokenize(query);
  const normalized = query.trim().toLowerCase();
  const matched: MatchedModel[] = [];

  for (const model of models) {
    const entry = indexOf(model);
    if (tokens.length > 0 && !tokens.every((token) => entry.haystack.includes(token))) {
      continue;
    }
    matched.push({
      model,
      rank: tokens.length === 0 ? RANK_SUBSTRING : rankFor(entry, normalized, tokens),
    });
  }

  matched.sort((a, b) => compareMatches(a, b, favorites));
  return matched;
}

function compareMatches(a: MatchedModel, b: MatchedModel, favorites: ReadonlySet<string>): number {
  // Favorites are boosted above everything else — "favorites always on top" is a
  // property of the control, not only of its opening frame (C5 D4).
  const favoriteDelta = Number(favorites.has(b.model.key)) - Number(favorites.has(a.model.key));
  if (favoriteDelta !== 0) {
    return favoriteDelta;
  }

  const selectableDelta = Number(b.model.selectable) - Number(a.model.selectable);
  if (selectableDelta !== 0) {
    return selectableDelta;
  }

  if (a.rank !== b.rank) {
    return a.rank - b.rank;
  }

  const createdDelta = (b.model.createdAt ?? 0) - (a.model.createdAt ?? 0);
  if (createdDelta !== 0) {
    return createdDelta;
  }

  return a.model.key.localeCompare(b.model.key);
}

// ── Banding (C5 D5 / §4.2) ───────────────────────────────────────────────────

export type Band = {
  /** Stable machine id — `favorites`, `source:<source>`, `vendor:<vendor>`, `unavailable`. */
  id: string;
  label: string;
  models: CatalogueModel[];
};

const NATIVE_SOURCE_ORDER: ModelSource[] = [
  "claude-subscription",
  "claude-home",
  "claude-pty",
  "chatgpt",
];

const SOURCE_LABELS: Record<ModelSource, string> = {
  "claude-subscription": "Claude — on your subscription",
  "claude-home": "Claude — independent home",
  "claude-pty": "Claude PTY bridge",
  chatgpt: "Codex — on your ChatGPT plan",
  openrouter: "OpenRouter",
};

export type BandOptions = {
  /** Favorite keys, most-recently-starred FIRST (the store computes that order). */
  favoriteKeys?: readonly string[];
  /** When set, a model unavailable for this agent type bands as Unavailable. */
  agentType?: string;
  /** Include the Unavailable band (the CLI's `--all`; the UI always shows it). */
  includeUnavailable?: boolean;
};

export function isAvailableForAgent(model: CatalogueModel, agentType: string | undefined): boolean {
  if (!model.selectable) {
    return false;
  }
  if (agentType === undefined) {
    return true;
  }
  // A harness-native row belongs to exactly the agent types that can spawn it —
  // acpx's own knowledge, so this holds even with no capability table.
  const nativeAgents = nativeAgentTypesForSource(model.source);
  if (nativeAgents !== null) {
    return nativeAgents.includes(agentType);
  }
  const availability = model.availability[agentType];
  // An EMPTY availability map means acpx has no capability table yet — that is
  // not evidence of unavailability, so the model stays available.
  return availability === undefined ? true : availability.ok;
}

/**
 * `★ Favorites` → the agent's own models → `OpenRouter` by vendor A→Z, newest
 * first within a vendor → `Unavailable` (C5 D5 option c).
 */
export function bandModels(models: readonly CatalogueModel[], options: BandOptions = {}): Band[] {
  const favoriteKeys = options.favoriteKeys ?? [];
  const partition = partitionModels(models, favoriteKeys, options.agentType);
  const bands: Band[] = [];

  if (partition.favorites.length > 0) {
    bands.push({ id: "favorites", label: "★ Favorites", models: partition.favorites });
  }
  bands.push(...nativeBands(partition), ...vendorBands(partition));
  if (options.includeUnavailable !== false && partition.unavailable.length > 0) {
    bands.push({
      id: "unavailable",
      label: "Unavailable on this box",
      models: partition.unavailable.toSorted(byRecencyThenName),
    });
  }

  return bands;
}

function nativeBands(partition: Partition): Band[] {
  const bands: Band[] = [];
  for (const source of NATIVE_SOURCE_ORDER) {
    const bucket = partition.natives.get(source);
    if (bucket !== undefined && bucket.length > 0) {
      bands.push({ id: `source:${source}`, label: SOURCE_LABELS[source], models: bucket });
    }
  }
  return bands;
}

/** Vendor A→Z, newest first within a vendor. */
function vendorBands(partition: Partition): Band[] {
  return [...partition.vendors.keys()]
    .toSorted((a, b) => a.localeCompare(b))
    .map((vendor) => ({
      id: `vendor:${vendor}`,
      label: `OpenRouter · ${vendor}`,
      models: (partition.vendors.get(vendor) ?? []).toSorted(byRecencyThenName),
    }));
}

type Partition = {
  favorites: CatalogueModel[];
  natives: Map<ModelSource, CatalogueModel[]>;
  vendors: Map<string, CatalogueModel[]>;
  unavailable: CatalogueModel[];
};

function pushInto<K>(buckets: Map<K, CatalogueModel[]>, key: K, model: CatalogueModel): void {
  const bucket = buckets.get(key) ?? [];
  bucket.push(model);
  buckets.set(key, bucket);
}

function partitionModels(
  models: readonly CatalogueModel[],
  favoriteKeys: readonly string[],
  agentType: string | undefined,
): Partition {
  const byKey = new Map(models.map((model) => [model.key, model]));
  const favoriteSet = new Set(favoriteKeys);
  const partition: Partition = {
    // Favorites keep the store's order: most-recently-starred first.
    favorites: favoriteKeys
      .map((key) => byKey.get(key))
      .filter((model): model is CatalogueModel => model !== undefined),
    natives: new Map(),
    vendors: new Map(),
    unavailable: [],
  };

  for (const model of models) {
    if (favoriteSet.has(model.key)) {
      continue;
    }
    if (!isAvailableForAgent(model, agentType)) {
      partition.unavailable.push(model);
    } else if (model.source === "openrouter") {
      pushInto(partition.vendors, model.vendor, model);
    } else {
      pushInto(partition.natives, model.source, model);
    }
  }

  return partition;
}

function byRecencyThenName(a: CatalogueModel, b: CatalogueModel): number {
  const delta = (b.createdAt ?? 0) - (a.createdAt ?? 0);
  return delta !== 0 ? delta : a.name.localeCompare(b.name);
}
