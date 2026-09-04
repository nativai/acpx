/**
 * The OpenRouter model list: fetch, cache, stale-on-error.
 *
 * `https://openrouter.ai/api/v1/models` is PUBLIC and needs no key (C4 §7.1) —
 * no credential goes anywhere near this module, deliberately: a box's OpenRouter
 * key is B1's concern and the catalogue must keep working on a box that has none.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** C4 §7.1 option 2: "TTL 1 h … never on dropdown open". */
export const CATALOGUE_TTL_MS = 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15_000;

export type OpenRouterRawModel = {
  id: string;
  canonical_slug?: string;
  name?: string;
  created?: number;
  description?: string;
  context_length?: number;
  alias_target?: string;
  pricing?: Record<string, string>;
  supported_parameters?: string[];
  reasoning?: {
    mandatory?: boolean;
    default_effort?: string;
    supported_efforts?: string[];
    default_enabled?: boolean;
    supports_max_tokens?: boolean;
  };
};

export type OpenRouterSnapshot = {
  /** ISO-8601 of the fetch these rows came from. */
  fetchedAt: string;
  models: OpenRouterRawModel[];
};

export type OpenRouterLoadResult = {
  snapshot: OpenRouterSnapshot | null;
  /** True when the rows are older than the TTL, or were served after a failed refresh. */
  stale: boolean;
  /** Human-readable when the upstream fetch failed. */
  error: string | null;
};

/**
 * `ACPX_MODELS_CACHE` overrides the file outright (tests, and an operator who
 * wants a pinned roster); `ACPX_STATE_HOME` moves the whole `.acpx` tree, which
 * is the override every other acpx path resolver already honours
 * (`src/cli/config.ts:81`, `src/session/event-log.ts:9`).
 */
export function defaultCatalogueCachePath(): string {
  const explicit = process.env.ACPX_MODELS_CACHE?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(process.env.ACPX_STATE_HOME || os.homedir(), ".acpx", "models-cache.json");
}

function readCache(cachePath: string): OpenRouterSnapshot | null {
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("models" in parsed) ||
      !Array.isArray((parsed as OpenRouterSnapshot).models)
    ) {
      return null;
    }
    const snapshot = parsed as OpenRouterSnapshot;
    const models = snapshot.models.filter(
      (model): model is OpenRouterRawModel =>
        typeof model === "object" && model !== null && typeof model.id === "string",
    );
    return { fetchedAt: snapshot.fetchedAt ?? new Date(0).toISOString(), models };
  } catch {
    // A truncated or hand-mangled cache is a cold cache, never a crash: a
    // session create must not fail because this file is unreadable.
    return null;
  }
}

/** Atomic tmp + rename — a reader never sees a half-written catalogue. */
function writeCache(cachePath: string, snapshot: OpenRouterSnapshot): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(snapshot)}\n`, "utf8");
  fs.renameSync(tmpPath, cachePath);
}

function isFresh(snapshot: OpenRouterSnapshot, ttlMs: number, now: number): boolean {
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt < ttlMs;
}

export async function fetchOpenRouterModels(
  url = OPENROUTER_MODELS_URL,
): Promise<OpenRouterSnapshot> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status} ${response.statusText}`);
  }
  const body: unknown = await response.json();
  const data =
    typeof body === "object" && body !== null && "data" in body
      ? (body as { data: unknown }).data
      : undefined;
  if (!Array.isArray(data)) {
    throw new Error(`${url} returned no "data" array`);
  }
  const models = data.filter(
    (model): model is OpenRouterRawModel =>
      typeof model === "object" &&
      model !== null &&
      typeof (model as { id: unknown }).id === "string",
  );
  return { fetchedAt: new Date().toISOString(), models };
}

export type LoadOptions = {
  cachePath?: string;
  ttlMs?: number;
  /** Force a fetch even when the cache is fresh (`--refresh`). */
  refresh?: boolean;
  /** Never touch the network — the session-create path (C4 §7.1 option 3). */
  offline?: boolean;
  now?: number;
  fetchModels?: () => Promise<OpenRouterSnapshot>;
};

/**
 * Cache-first, stale-on-error. Four outcomes, all of them a usable answer:
 *   fresh cache            → serve it, no network
 *   stale cache, fetch ok  → serve the fetch, rewrite the cache
 *   stale cache, fetch bad → serve the CACHE with `stale: true` + the error
 *   no cache,   fetch bad  → `snapshot: null` + the error (the caller still gets
 *                            the harness-native models; C5 §4.9)
 */
function resolveLoadOptions(options: LoadOptions) {
  return {
    cachePath: options.cachePath ?? defaultCatalogueCachePath(),
    ttlMs: options.ttlMs ?? CATALOGUE_TTL_MS,
    now: options.now ?? Date.now(),
    fetchModels: options.fetchModels ?? fetchOpenRouterModels,
  };
}

export async function loadOpenRouterCatalogue(
  options: LoadOptions = {},
): Promise<OpenRouterLoadResult> {
  const { cachePath, ttlMs, now, fetchModels } = resolveLoadOptions(options);
  const cached = readCache(cachePath);
  const fresh = cached !== null && isFresh(cached, ttlMs, now);

  if (options.offline === true) {
    // The session-create path: read what is on disk, never the network.
    return { snapshot: cached, stale: cached !== null && !fresh, error: null };
  }

  if (fresh && options.refresh !== true) {
    return { snapshot: cached, stale: false, error: null };
  }

  try {
    const fetched = await fetchModels();
    cacheOrWarn(cachePath, fetched);
    return { snapshot: fetched, stale: false, error: null };
  } catch (error) {
    // Stale-on-error: a failed refresh serves the cache rather than emptiness.
    return { snapshot: cached, stale: cached !== null, error: errorMessage(error) };
  }
}

function cacheOrWarn(cachePath: string, snapshot: OpenRouterSnapshot): void {
  try {
    writeCache(cachePath, snapshot);
  } catch (error) {
    // An unwritable cache degrades to "fetch every time", not to a failure.
    process.stderr.write(
      `[acpx] warning: could not write the model cache at ${cachePath}: ${errorMessage(error)}\n`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
