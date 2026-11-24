/**
 * Per-provider ENDPOINT metrics for one OpenRouter model: fetch, cache,
 * stale-on-error (brick 4c272cab §7.1).
 *
 * `GET /api/v1/models/<slug>/endpoints` is what makes provider choice a decision
 * on data rather than a guess. For `z-ai/glm-5.3-flash` it returns 26 rows —
 * measured 2026-09-10 — each carrying `provider_name`, `tag`, `quantization`,
 * `pricing`, `status`, `uptime_last_*` and `throughput_last_30m{p50..p99}`; the
 * spread between the top and bottom row was **157 vs 12 tok/s at the same list
 * price**, which is the entire reason this brick exists.
 *
 * ## Three differences from `openrouter-catalogue.ts`, each measured
 *
 * 1. **The key is OPTIONAL — sent when the box has one, never required.**
 *
 *    🛑 **THE BRIEF SAID THE OPPOSITE AND THE BRIEF WAS WRONG.** CONCEPTION §7.1
 *    states this endpoint *"needs the box key (unlike `/api/v1/models`, which is
 *    public)"*, and acceptance A4 listed "returns rows on a box with no key" as a
 *    FAIL. The test engineer measured it directly (2026-09-10 10:12Z): **no
 *    `Authorization` header at all → `200`, 24 559 bytes, 26 rows**; a
 *    deliberately invalid key → `200` as well. The endpoint is public. Refusing
 *    to show freely-reachable data because this box happens to hold no credential
 *    is a self-inflicted degradation, so the credential is now an enrichment and
 *    its absence is a NOTE, not an error (HoD ruling O-1, which revises A4).
 *
 *    ⚠️ **BUT THE THROUGHPUT NUMBERS ARE KEY-GATED, AND THEY ARE THE POINT.**
 *    Measured 2026-09-10, same slug, one variable: **unauthenticated → 26 rows,
 *    uptime on all 26, `throughput_last_30m.p50` null on ALL 26; authenticated →
 *    26 rows, p50 on all 26.** So "public" is true about the ROWS and false about
 *    the metric this whole brick exists to act on. A box with no credential can
 *    still see who serves a model, its quantization, its price and its uptime —
 *    which is why refusing the call was wrong — but it cannot rank by speed. The
 *    CLI says so in its `note` rather than letting every `p50` render as `—` with
 *    no explanation.
 *
 *    ⚠️ **AND IT KILLED A FAULT INJECTION** — worth knowing before you reach for
 *    one: the TE's first stale-on-error probe set a bogus key expecting the fetch
 *    to fail, and got 26 live rows with `error:null`. A bad key does not fail this
 *    request. Use a slug that genuinely 404s.
 * 2. **TTL is 5 minutes, not the catalogue's hour.** These are LIVE HEALTH
 *    figures. An hour-old uptime number is worse than none, because it reads as
 *    current — and it is read at exactly the moment someone is deciding whether a
 *    provider is safe to prefer.
 * 3. **One derived field, `providerSlug` = `tag.split("/")[0]`.** The wire
 *    carries `tag` (`baseten/fp8`) and a display `provider_name` (`BaseTen`);
 *    the routing contract stores the bare SLUG (`baseten`), confirmed against
 *    `GET /api/v1/providers`' 105 rows. Deriving it once here is what stops every
 *    consumer deriving it slightly differently — and a wrong provider name is
 *    silently ignored by OpenRouter (probe C), so there is no error to notice.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileReplacingSync } from "../temp-name.js";

export const OPENROUTER_ENDPOINTS_TTL_MS = 5 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15_000;

/** One serving endpoint, passed through verbatim plus `providerSlug`. */
export type OpenRouterEndpoint = {
  /** Bare provider slug — the identifier the routing policy stores (K1). */
  providerSlug: string;
  provider_name?: string;
  tag?: string;
  quantization?: string;
  context_length?: number;
  max_completion_tokens?: number;
  pricing?: Record<string, string>;
  status?: number;
  uptime_last_5m?: number | null;
  uptime_last_30m?: number | null;
  uptime_last_1d?: number | null;
  latency_last_30m?: Record<string, number | null> | null;
  throughput_last_30m?: Record<string, number | null> | null;
  supported_parameters?: string[];
  supports_tool_choice?: boolean;
};

export type OpenRouterEndpointsSnapshot = {
  slug: string;
  /** ISO-8601 of the fetch these rows came from. */
  fetchedAt: string;
  endpoints: OpenRouterEndpoint[];
};

export type OpenRouterEndpointsResult = {
  /**
   * ⚠️ `null` ON EVERY FAILURE, NEVER `[]`. A consumer renders "no metrics" and
   * "this model has no endpoints" differently, and here the distinction is
   * sharper than usual: `[]` is a REAL answer a box-wide precision floor can
   * produce, and conflating it with a failed fetch is how a floor that emptied
   * the set looks like a network blip.
   */
  snapshot: OpenRouterEndpointsSnapshot | null;
  /** Older than the TTL, or served after a failed refresh. */
  stale: boolean;
  error: string | null;
};

export function endpointsUrl(slug: string): string {
  // ⚠️ NOT encodeURIComponent: the slug's `/` is a PATH SEPARATOR in this API
  // (`…/models/z-ai/glm-5.3-flash/endpoints`), and percent-encoding it 404s.
  return `https://openrouter.ai/api/v1/models/${slug}/endpoints`;
}

/**
 * The cache file for one slug.
 *
 * ⚠️ TAKES THE `env` IT IS ASKED ABOUT (brick ff298f02), same order as
 * `defaultCatalogueCachePath`. The slug's `/` is replaced so one model cannot
 * create directories named after another's vendor.
 */
export function endpointsCachePath(slug: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ACPX_ENDPOINTS_CACHE_DIR?.trim();
  const root =
    explicit ||
    path.join(
      env.ACPX_STATE_HOME?.trim() || env.HOME?.trim() || os.homedir(),
      ".acpx",
      "endpoints",
    );
  return path.join(root, `${slug.replaceAll("/", "__")}.json`);
}

export type EndpointsLoadOptions = {
  env?: NodeJS.ProcessEnv;
  cachePath?: string;
  ttlMs?: number;
  /** Force a fetch even when the cache is fresh (`--refresh`). */
  refresh?: boolean;
  now?: number;
  /** Injected in tests; the real one needs the box key. */
  fetchEndpoints?: (slug: string) => Promise<OpenRouterEndpointsSnapshot>;
};

/**
 * Cache-first, stale-on-error — the same four outcomes the catalogue reader
 * documents, so the two describe staleness identically:
 *   fresh cache           → serve it, no network
 *   stale cache, fetch ok → serve the fetch, rewrite the cache
 *   stale cache, fetch bad→ serve the CACHE with `stale: true` + the error
 *   no cache,   fetch bad → `snapshot: null` + the error
 */
export async function loadOpenRouterEndpoints(
  slug: string,
  /** The box key when it has one. **Optional** — this endpoint is public (§1). */
  apiKey: string | undefined,
  options: EndpointsLoadOptions = {},
): Promise<OpenRouterEndpointsResult> {
  const { cachePath, ttlMs, now, fetchEndpoints } = resolveLoadOptions(slug, apiKey, options);
  const cached = readCache(cachePath, slug);
  const fresh = cached !== null && isFresh(cached, ttlMs, now);
  if (fresh && options.refresh !== true) {
    return { snapshot: cached, stale: false, error: null };
  }
  try {
    const fetched = await fetchEndpoints(slug);
    cacheOrWarn(cachePath, fetched);
    return { snapshot: fetched, stale: false, error: null };
  } catch (error) {
    return { snapshot: cached, stale: cached !== null, error: errorMessage(error) };
  }
}

/** Defaults in one place, mirroring the catalogue reader's own splitting. */
function resolveLoadOptions(
  slug: string,
  apiKey: string | undefined,
  options: EndpointsLoadOptions,
) {
  const env = options.env ?? process.env;
  return {
    cachePath: options.cachePath ?? endpointsCachePath(slug, env),
    ttlMs: options.ttlMs ?? OPENROUTER_ENDPOINTS_TTL_MS,
    now: options.now ?? Date.now(),
    fetchEndpoints: options.fetchEndpoints ?? ((id: string) => fetchEndpointsLive(id, apiKey)),
  };
}

export async function fetchEndpointsLive(
  slug: string,
  apiKey?: string,
): Promise<OpenRouterEndpointsSnapshot> {
  const url = endpointsUrl(slug);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    // The key is sent when present — attribution and any account-level view ride
    // on it — and simply omitted when not. Measured: both forms answer 200.
    headers: {
      accept: "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
  });
  if (!response.ok) {
    // ⚠️ The URL, never the key. The Authorization header is the one thing in
    // this function that may not reach a log line or an error message.
    throw new Error(`${url} responded ${response.status} ${response.statusText}`);
  }
  const body: unknown = await response.json();
  return { slug, fetchedAt: new Date().toISOString(), endpoints: parseEndpointsBody(body) };
}

/**
 * `{data:{endpoints:[…]}}` → rows, each with the derived `providerSlug`.
 *
 * Exported so the derivation can be measured against a REAL response body
 * rather than against a re-implementation of it in a test — the shape is
 * OpenRouter's, and a test that built its own rows would pass on a parser that
 * no longer matches the wire.
 */
export function parseEndpointsBody(body: unknown): OpenRouterEndpoint[] {
  const data = asRecord(asRecord(body)?.data)?.endpoints;
  if (!Array.isArray(data)) {
    return [];
  }
  return data.flatMap((entry) => {
    const record = asRecord(entry);
    return record
      ? [{ ...record, providerSlug: providerSlugOf(record) } as OpenRouterEndpoint]
      : [];
  });
}

/**
 * `tag.split("/")[0]`, with `provider_name` lower-cased as the fallback.
 *
 * The fallback is deliberately WEAK and only for a row with no tag: OpenRouter's
 * own `/api/v1/providers` shows the display name is not mechanically the slug
 * (`Z.AI` → `z-ai`, `Io Net` → `io-net`), so a name-derived slug is a guess. The
 * tag is the authority.
 */
function providerSlugOf(entry: Record<string, unknown>): string {
  const tag = typeof entry.tag === "string" ? entry.tag : "";
  if (tag) {
    return tag.split("/")[0];
  }
  const name = typeof entry.provider_name === "string" ? entry.provider_name : "";
  return name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
}

function readCache(cachePath: string, slug: string): OpenRouterEndpointsSnapshot | null {
  try {
    const parsed = asRecord(JSON.parse(fs.readFileSync(cachePath, "utf8")));
    if (!parsed || !Array.isArray(parsed.endpoints)) {
      return null;
    }
    return {
      slug: typeof parsed.slug === "string" ? parsed.slug : slug,
      fetchedAt:
        typeof parsed.fetchedAt === "string" ? parsed.fetchedAt : new Date(0).toISOString(),
      endpoints: parsed.endpoints as OpenRouterEndpoint[],
    };
  } catch {
    // A truncated or hand-mangled cache is a cold cache, never a crash.
    return null;
  }
}

function isFresh(snapshot: OpenRouterEndpointsSnapshot, ttlMs: number, now: number): boolean {
  const fetchedAt = Date.parse(snapshot.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt < ttlMs;
}

/** Atomic tmp + rename — a reader never sees a half-written file. */
function cacheOrWarn(cachePath: string, snapshot: OpenRouterEndpointsSnapshot): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    writeFileReplacingSync(cachePath, `${JSON.stringify(snapshot)}\n`);
  } catch (error) {
    // An unwritable cache degrades to "fetch every time", not to a failure.
    process.stderr.write(
      `[acpx] warning: could not write the endpoints cache at ${cachePath}: ${errorMessage(error)}\n`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
