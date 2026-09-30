/**
 * WHAT THIS BOX'S OpenRouter KEY MAY BE BILLED FOR — read from the key itself
 * (brick ecfb0461).
 *
 * ## One authority, and that is the whole design
 *
 * Daniel, 2026-09-29: *"agents can freely pick all models which the key allows to
 * be selected. So this shouldn't be like dual hard coded in the key and somewhere
 * else. the source of truth is what models does the key provide."*
 *
 * So there is **no list in this file**. `GET /api/v1/models/user` answers, for a
 * given key, exactly which models that key may use — and it answers to an
 * **ordinary key with no management credential**. Measured 2026-09-29 on devbox:
 *
 * ```
 * GET /api/v1/models/user  ->  200  { data: [ … ], links: { next: null }, total_count: 2 }
 *      ids:       deepseek/deepseek-v4.1-flash  |  z-ai/glm-5.3-flash
 *      canonical: deepseek/deepseek-v4.1-flash-20260910  |  z-ai/glm-5.3-flash-20260826
 * GET /api/v1/models       ->  200  464 rows   (the public catalogue, un-narrowed)
 * ```
 *
 * 🛑 **DO NOT EXPECT THE `allowed_models` SHAPE BACK.** A 4-string allowlist comes
 * back as **2 rows**, because each row is a full catalogue object for a model the
 * key may use and the two id *forms* of one model collapse into one row. A consumer
 * that compares a 4-element allowlist against this endpoint reads 2 and wrongly
 * concludes divergence. Measured five times across five boxes; it is stable. **Read
 * `.data[].id`.**
 *
 * ## What this replaced, and why the deletion is the feature
 *
 * The previous design kept **two** lists — a hardcoded entitlement module here and
 * the key's `allowed_models` at OpenRouter — and then worked hard to keep them
 * honest: an `entitlementSha` in `providers.json`, a sha comparison at spawn, three
 * resolution branches, a narrowing rule, a skew warning, and a two-place edit on
 * every change. **All of that existed only to detect divergence between two
 * authorities. With one authority there is nothing to diverge**, so it is gone —
 * and changing the allowed set is now a re-mint with no code change to keep in step.
 *
 * ## The dividend: this layer can fail OPEN, safely
 *
 * Under two lists the code had to be kept in lockstep or an agent met an
 * uninterpretable provider 403 (`probeOpenRouterRefusal` returns `undefined` for any
 * status that is not 429, and only runs when the turn error says `timeout`). Under
 * one authority **the key refuses regardless**, so this layer is purely feedback.
 * An unknown set — cold cache, failed fetch, no key — therefore permits everything
 * and says so: the cost is legibility (an agent meets the provider's refusal instead
 * of a clean one), never enforcement. Failing closed would trade that small cost for
 * breaking every spawn on the box whenever OpenRouter is slow.
 *
 * 🛑 **`allowed: null` (UNKNOWN) AND `allowed: new Set()` (THE KEY ALLOWS NOTHING)
 * ARE DIFFERENT FACTS AND MUST NEVER COLLAPSE.** Collapsing them is how a cold cache
 * becomes a box on which no model can be selected — a total outage produced by a
 * missing file. Every read path below returns `null` for "I do not know".
 *
 * ## Where the network hop lives — read path yes, spawn path never
 *
 * An earlier ruling (brick daed4261) forbade a **spawn-path** network probe. That
 * ruling is not overturned here and its reason has not changed: `C4 §7.1` — no
 * session create may block on a third-party fetch. What *is* revisited is whether
 * the query may be the mechanism at all, and it may: the query rides
 * {@link loadOpenRouterEntitlement} on the path that is **already async and already
 * fetching from OpenRouter** (`loadCatalogue`), while the spawn path reads
 * {@link readOpenRouterEntitlementSync} — a plain `readFileSync`, no network, no
 * promise, no credential resolution beyond the fingerprint check.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fingerprintCredential,
  loadBoxProviders,
  resolveBoxProviderKey,
  type BoxProviderEntry,
  type BoxProviderLookupOptions,
} from "../config/providers.js";
import type { CatalogueEntitlement } from "./types.js";

/** The per-key endpoint. Answers to an ordinary key; no management credential. */
export const OPENROUTER_MODELS_USER_URL = "https://openrouter.ai/api/v1/models/user";

/** Same window the public catalogue uses — the allowed set changes only on a re-mint. */
export const ENTITLEMENT_TTL_MS = 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15_000;

/** The `providers.json` entry that pays for the OpenRouter route. */
const OPENROUTER_PROVIDER_ENTRY = "openrouter";

/**
 * Set to any non-empty value to forbid the authenticated `models/user` call. A warm
 * cache is still served; only the refresh is suppressed. The test suite sets it from
 * its bootstrap so no gate run can put this box's key on the wire — see
 * `test/box-env-scrub.ts`, which owns the reasoning.
 */
export const NO_ENTITLEMENT_FETCH_ENV = "ACPX_NO_OPENROUTER_ENTITLEMENT_FETCH";

/**
 * What the key allows, plus how well we know it.
 *
 * 🛑 `allowed === null` is **UNKNOWN**, never "nothing". See the header.
 */
export type OpenRouterEntitlement = {
  /** Every id form the key named — `null` when acpx could not find out. */
  allowed: ReadonlySet<string> | null;
  /** ISO-8601 of the read these ids came from, when there was one. */
  fetchedAt: string | null;
  /** The ids are older than the TTL, or were served after a failed refresh. */
  stale: boolean;
  /** Human-readable when the read failed. Present with a `null` set, and on stale. */
  error: string | null;
};

/** The fail-open value. Returned wherever acpx cannot establish the set. */
export const ENTITLEMENT_UNKNOWN: OpenRouterEntitlement = {
  allowed: null,
  fetchedAt: null,
  stale: false,
  error: null,
};

function unknown(error: string | null): OpenRouterEntitlement {
  return { allowed: null, fetchedAt: null, stale: false, error };
}

/** What lands on disk. `keyFingerprint` is a digest — never the key. */
type EntitlementCacheFile = {
  fetchedAt: string;
  keyFingerprint: string;
  modelIds: string[];
};

/**
 * ⚠️ TAKES THE `env` IT IS ASKED ABOUT, NOT THE PROCESS'S — the same resolution
 * ladder, and the same reason, as `defaultCatalogueCachePath` (brick ff298f02): a
 * caller threading a scoped env must not silently read the machine's cache.
 */
export function defaultEntitlementCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ACPX_OPENROUTER_ENTITLEMENT_CACHE?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return path.join(
    env.ACPX_STATE_HOME?.trim() || env.HOME?.trim() || os.homedir(),
    ".acpx",
    "openrouter-entitlement.json",
  );
}

/**
 * The key's fingerprint, or `undefined` when this box has no OpenRouter credential.
 *
 * ⚠️ Never throws into session creation — `loadBoxProviders` degrades on a missing,
 * unreadable or malformed file by its own contract, and the `catch` covers the rest.
 */
export function openRouterKeyFingerprint(
  options?: BoxProviderLookupOptions & { entry?: BoxProviderEntry | undefined },
): string | undefined {
  const key = resolveOpenRouterKey(options);
  return key === undefined ? undefined : fingerprintCredential(key);
}

/**
 * The box's OpenRouter key, or `undefined`. ⚠️ Returns a SECRET — callers may
 * fingerprint it or put it in a request header, and nowhere else.
 */
function resolveOpenRouterKey(
  options?: BoxProviderLookupOptions & { entry?: BoxProviderEntry | undefined },
): string | undefined {
  const entry = options?.entry ?? findOpenRouterEntry(options);
  if (entry === undefined) {
    return undefined;
  }
  const key = resolveBoxProviderKey(entry, options?.env ?? process.env);
  return key === undefined || key.trim() === "" ? undefined : key;
}

/**
 * The cache file, validated — or `null`.
 *
 * 🛑 **A FINGERPRINT MISMATCH IS A COLD CACHE, AND THAT IS THE INVALIDATION THAT
 * ACTUALLY FIRES.** Time alone is the wrong instrument here: the allowed set almost
 * never changes on its own, it changes when the key is **re-minted** — which
 * produces a *new key*, not an older timestamp. Without this check a box would keep
 * serving the previous key's allowed set for up to a full TTL after a re-mint, which
 * is precisely the window in which being wrong is most likely.
 *
 * `expectedFingerprint === undefined` (no credential on this box) matches nothing,
 * so such a box reads as unknown and fails open — correct: with no key there is no
 * authority to consult.
 */
function readCache(
  cachePath: string,
  expectedFingerprint: string | undefined,
): {
  snapshot: EntitlementCacheFile | null;
  reason: string | null;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch {
    return { snapshot: null, reason: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A truncated or hand-mangled cache is a cold cache, never a crash.
    return { snapshot: null, reason: `${cachePath} is not valid JSON` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { snapshot: null, reason: `${cachePath} is not an object` };
  }
  return validateCacheFile(parsed as Partial<EntitlementCacheFile>, cachePath, expectedFingerprint);
}

/** Shape + fingerprint validation. Split out for the complexity budget. */
function validateCacheFile(
  file: Partial<EntitlementCacheFile>,
  cachePath: string,
  expectedFingerprint: string | undefined,
): { snapshot: EntitlementCacheFile | null; reason: string | null } {
  if (!Array.isArray(file.modelIds) || typeof file.keyFingerprint !== "string") {
    return { snapshot: null, reason: `${cachePath} is missing modelIds or keyFingerprint` };
  }
  if (expectedFingerprint === undefined) {
    return { snapshot: null, reason: "this box has no resolvable OpenRouter credential" };
  }
  if (file.keyFingerprint !== expectedFingerprint) {
    return {
      snapshot: null,
      reason: "the cached allowed set belongs to a different OpenRouter key (re-minted?)",
    };
  }
  return {
    snapshot: {
      fetchedAt: typeof file.fetchedAt === "string" ? file.fetchedAt : new Date(0).toISOString(),
      keyFingerprint: file.keyFingerprint,
      modelIds: file.modelIds.filter((id): id is string => typeof id === "string"),
    },
    reason: null,
  };
}

/** Atomic tmp + rename — a reader never sees a half-written set. */
function writeCache(cachePath: string, file: EntitlementCacheFile): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(file)}\n`, "utf8");
  fs.renameSync(tmpPath, cachePath);
}

function isFresh(file: EntitlementCacheFile, ttlMs: number, now: number): boolean {
  const fetchedAt = Date.parse(file.fetchedAt);
  return Number.isFinite(fetchedAt) && now - fetchedAt < ttlMs;
}

function toEntitlement(file: EntitlementCacheFile, stale: boolean, error: string | null) {
  return {
    allowed: new Set(file.modelIds),
    fetchedAt: file.fetchedAt,
    stale,
    error,
  } satisfies OpenRouterEntitlement;
}

export type EntitlementLoadOptions = BoxProviderLookupOptions & {
  /**
   * 🛑 **`entitlementCachePath`, NOT `cachePath`, AND THE NAME IS LOAD-BEARING.**
   * `loadCatalogue` takes `LoadOptions & EntitlementLoadOptions` in one object so
   * `offline` / `refresh` / `ttlMs` / `now` are shared by construction — but
   * `LoadOptions.cachePath` already names the *public catalogue* cache. A field of
   * the same name would intersect to one string and point this loader at
   * `models-cache.json`, which parses as "no modelIds" and reads as a permanently
   * cold entitlement cache: fail-open everywhere, with nothing failing.
   */
  entitlementCachePath?: string;
  ttlMs?: number;
  /** Force a fetch even when the cache is fresh (`--refresh`). */
  refresh?: boolean;
  /** Never touch the network. */
  offline?: boolean;
  now?: number;
  entry?: BoxProviderEntry | undefined;
  /** Injected for tests. Receives the resolved key; returns the ids the key allows. */
  fetchAllowed?: (key: string) => Promise<EntitlementSnapshot>;
};

/**
 * The allowed set from disk, **SYNCHRONOUSLY and with no network access** — the
 * spawn path's reader.
 *
 * ⚠️ A cold, stale-past-TTL, unparseable or foreign-key cache all return
 * `allowed: null`, i.e. fail open with a reason. **Staleness fails open too**: an
 * hour-old set is a set acpx cannot vouch for, and quietly enforcing it would be
 * enforcement without authority — the exact thing this brick deleted.
 */
export function readOpenRouterEntitlementSync(
  options: EntitlementLoadOptions = {},
): OpenRouterEntitlement {
  const cachePath = options.entitlementCachePath ?? defaultEntitlementCachePath(options.env);
  const ttlMs = options.ttlMs ?? ENTITLEMENT_TTL_MS;
  const now = options.now ?? Date.now();
  const fingerprint = openRouterKeyFingerprint(options);
  const { snapshot, reason } = readCache(cachePath, fingerprint);
  if (snapshot === null) {
    return unknown(reason ?? `no cached OpenRouter allowed-model set at ${cachePath}`);
  }
  if (!isFresh(snapshot, ttlMs, now)) {
    return unknown(`the cached OpenRouter allowed-model set at ${cachePath} is older than its TTL`);
  }
  return toEntitlement(snapshot, false, null);
}

export type EntitlementSnapshot = {
  fetchedAt: string;
  modelIds: string[];
};

/**
 * Ask the key what it allows.
 *
 * ⚠️ **BOTH ID FORMS PER ROW.** Each row carries `canonical_slug` as a FIELD
 * (`z-ai/glm-5.3-flash` → `z-ai/glm-5.3-flash-20260826`; it is NOT `slug + date` —
 * three date formats and at least one word reordering are on record, so it is read,
 * never constructed). `.data[].id` is the authoritative read; adding
 * `canonical_slug` cannot widen the set past what the key named — it is a second
 * spelling of the same model — and it means either form an agent types resolves.
 *
 * ⚠️ **THE KEY IS AN ARGUMENT, NOT AN ENVIRONMENT READ OR AN ARGV.** It goes into a
 * header and nowhere else: on these boxes an argv dump is a credential dump.
 */
export async function fetchOpenRouterAllowedModels(
  key: string,
  url = OPENROUTER_MODELS_USER_URL,
): Promise<EntitlementSnapshot> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json", authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`${url} responded ${response.status} ${response.statusText}`);
  }
  const body: unknown = await response.json();
  const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : null;
  if (!Array.isArray(data)) {
    throw new Error(`${url} returned no "data" array`);
  }
  const modelIds = new Set<string>();
  for (const row of data) {
    for (const id of rowModelIds(row)) {
      modelIds.add(id);
    }
  }
  return { fetchedAt: new Date().toISOString(), modelIds: [...modelIds].toSorted() };
}

/** Both id forms off one row, normalised. Split out for the complexity budget. */
function rowModelIds(row: unknown): string[] {
  if (typeof row !== "object" || row === null) {
    return [];
  }
  const { id, canonical_slug: canonical } = row as { id?: unknown; canonical_slug?: unknown };
  return [id, canonical]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim().toLowerCase());
}

/**
 * Cache-first, stale-on-error — the read path's loader, and the only thing that ever
 * puts this module on the network.
 *
 * Outcomes, all of them a usable answer:
 *   fresh cache            → serve it, no network
 *   stale cache, fetch ok  → serve the fetch, rewrite the cache
 *   stale cache, fetch bad → serve the CACHE, `stale: true` + the error
 *   no cache,   fetch bad  → UNKNOWN + the error ⇒ **fail open** (see the header)
 *   no credential          → UNKNOWN, no network attempted
 *
 * ⚠️ A **stale** set is still served here, unlike the sync reader — the read path
 * tried and can say so (`stale`, `error`), so annotating `acpx models` from an
 * hour-old set beats annotating from nothing. The spawn path, which cannot report,
 * fails open instead.
 */
export async function loadOpenRouterEntitlement(
  options: EntitlementLoadOptions = {},
): Promise<OpenRouterEntitlement> {
  const cachePath = options.entitlementCachePath ?? defaultEntitlementCachePath(options.env);
  const key = resolveOpenRouterKey(options);
  if (key === undefined) {
    return unknown("this box has no resolvable OpenRouter credential");
  }
  const fingerprint = fingerprintCredential(key);
  const { snapshot, reason } = readCache(cachePath, fingerprint);
  if (servableWithoutRefresh(snapshot, options)) {
    return toEntitlement(snapshot, false, null);
  }
  const withheld = whyNoFetch(options, options.env ?? process.env);
  if (withheld !== null) {
    return servedWithoutFetch(snapshot, reason, cachePath, withheld);
  }
  return await refreshFromKey({ options, key, fingerprint, cachePath, snapshot });
}

/** A cache good enough to serve as-is. Split out for the complexity budget. */
function servableWithoutRefresh(
  snapshot: EntitlementCacheFile | null,
  options: EntitlementLoadOptions,
): snapshot is EntitlementCacheFile {
  if (snapshot === null || options.refresh === true) {
    return false;
  }
  return isFresh(snapshot, options.ttlMs ?? ENTITLEMENT_TTL_MS, options.now ?? Date.now());
}

/** The fetch-and-cache leg. Split out for the complexity budget. */
async function refreshFromKey(params: {
  options: EntitlementLoadOptions;
  key: string;
  fingerprint: string;
  cachePath: string;
  snapshot: EntitlementCacheFile | null;
}): Promise<OpenRouterEntitlement> {
  const fetchAllowed =
    params.options.fetchAllowed ?? ((k: string) => fetchOpenRouterAllowedModels(k));
  try {
    const fetched = await fetchAllowed(params.key);
    const file: EntitlementCacheFile = { ...fetched, keyFingerprint: params.fingerprint };
    cacheOrWarn(params.cachePath, file);
    return toEntitlement(file, false, null);
  } catch (error) {
    // Stale-on-error: a failed refresh serves the cache rather than emptiness, and
    // labels it. With no cache it is UNKNOWN — never an empty set (see the header).
    const message = error instanceof Error ? error.message : String(error);
    return params.snapshot === null
      ? unknown(message)
      : toEntitlement(params.snapshot, true, message);
  }
}

/**
 * Why this call must not go to the network, or `null` when it may.
 *
 * 🛑 BOTH REASONS ARE CHECKED AFTER THE FRESH-CACHE BRANCH, so a warm cache is
 * served either way — they suppress the FETCH, never the answer. The env guard is
 * about a CREDENTIAL: this is the only authenticated outbound call acpx makes for
 * the model surface, and `test/box-env-scrub.ts` sets it from the suite bootstrap
 * rather than relying on every row to isolate `ACPX_STATE_HOME` (the store guard
 * there is opt-in per test, not global).
 */
function whyNoFetch(options: EntitlementLoadOptions, env: NodeJS.ProcessEnv): string | null {
  if (options.offline === true) {
    return "acpx was asked not to touch the network (offline)";
  }
  return env[NO_ENTITLEMENT_FETCH_ENV]
    ? `${NO_ENTITLEMENT_FETCH_ENV} is set, so acpx did not ask the key what it allows`
    : null;
}

/** The answer when no fetch was made: a labelled stale cache, or UNKNOWN. */
function servedWithoutFetch(
  snapshot: EntitlementCacheFile | null,
  reason: string | null,
  cachePath: string,
  withheld: string,
): OpenRouterEntitlement {
  if (snapshot === null) {
    return unknown(reason ?? `${withheld}; no cached allowed-model set at ${cachePath}`);
  }
  return toEntitlement(snapshot, true, withheld);
}

/** ⚠️ Same never-throw-into-session-creation rule the catalogue read follows. */
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

function cacheOrWarn(cachePath: string, file: EntitlementCacheFile): void {
  try {
    writeCache(cachePath, file);
  } catch (error) {
    // An unwritable cache degrades to "fetch every time", not to a failure.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[acpx] warning: could not write the OpenRouter entitlement cache at ${cachePath}: ${message}\n`,
    );
  }
}

const OPENROUTER_ID_PREFIXES = ["openrouter/", "openrouter:"] as const;

/** A leading `openrouter/` or `openrouter:` removed — the route prefix, either spelling. */
export function withoutOpenRouterRoutePrefix(id: string): string {
  const lower = id.trim().toLowerCase();
  const prefix = OPENROUTER_ID_PREFIXES.find((candidate) => lower.startsWith(candidate));
  return prefix === undefined ? lower : lower.slice(prefix.length);
}

/**
 * Whether this model id names the OpenRouter route at all — the gate that keeps the
 * allowed set off every other harness.
 *
 * 🛑 **THE NAMESPACE TEST IS LOAD-BEARING, NOT A TIDINESS CHECK. Without it this
 * predicate swallows every ordinary claude and codex session.** Measured on devbox's
 * whole session store, 2026-09-29: **zero non-OpenRouter model ids carry a `/`.**
 * claude and claude-pty run bare aliases (`opus` ×790, `sonnet` ×291, `default` ×78,
 * `fable` ×43, `haiku` ×6); codex runs bare ids with a bracket (`gpt-6-astra[high]`
 * ×32, 18 distinct forms); every namespaced id in the store is an OpenRouter id.
 * Structurally corroborated: `ModelSource` has five values (`types.ts:12`) and the
 * four non-OpenRouter ones carry only bare ids — claude's compiled into
 * `harness-models.ts`, codex's advertised bare over ACP.
 *
 * ⚠️ **NAME-SHAPED ON PURPOSE — IT MUST NOT CONSULT THE CATALOGUE.** The bare-slug
 * leg of the route reads the model cache, and a **cold** cache makes it stand aside,
 * so a catalogue-derived test would be silently absent exactly when the cache is
 * cold. `isClaudeFamilyModelId` is the existing precedent, for the same reason.
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
 * A FLOATING alias — OpenRouter's `~…` / `…-latest` rows, refused **independently of
 * what the key allows**.
 *
 * ⚠️ **THE ONE DELIBERATE EXCEPTION TO "THE KEY DECIDES", AND IT IS NARROW.** A
 * plain slug's canonical is PINNED — measured across three natural experiments, an
 * undated slug's canonical is the OLDER date and a newer build ships as a NEW slug —
 * so an ordinary id never goes stale. A floating alias is the opposite: a standing
 * hole that could **begin resolving to a pricier build with no edit by anyone**.
 * Refusing by SHAPE catches an alias spelling nobody anticipated, costs nothing, and
 * — the reason it is worth keeping at all — **it is the one refusal that survives
 * fail-open**, when the key's answer is unavailable and every other check stands
 * aside. In practice it never contradicts the key: `models/user` answers with pinned
 * ids.
 */
export function isFloatingAliasModelId(id: string | null | undefined): boolean {
  if (typeof id !== "string") {
    return false;
  }
  const slug = withoutOpenRouterRoutePrefix(id);
  return slug.startsWith("~") || slug.endsWith("-latest");
}

/**
 * Whether the key allows this id.
 *
 * 🛑 **UNKNOWN PERMITS.** `allowed === null` means acpx could not establish the set,
 * and this returns `true` — the fail-open decision, in one place so no caller can
 * implement it differently. The key still refuses; only the local feedback is lost.
 */
export function isEntitledOpenRouterModelId(
  id: string,
  entitlement: OpenRouterEntitlement,
): boolean {
  if (entitlement.allowed === null) {
    return true;
  }
  return entitlement.allowed.has(withoutOpenRouterRoutePrefix(id));
}

/**
 * The ids the key allows, shortest-form-first and de-duplicated, for a message.
 *
 * `models/user` answers with both a slug and its dated canonical for one model, so a
 * bare enumeration would offer an agent two spellings of two models as four choices.
 * A dated id whose undated prefix is also allowed is dropped — the undated one is
 * what a human writes, and both resolve.
 */
export function entitlementModelSlugs(entitlement: OpenRouterEntitlement): string[] {
  if (entitlement.allowed === null) {
    return [];
  }
  const all = [...entitlement.allowed].toSorted();
  return all.filter((id) => !all.some((other) => other !== id && id.startsWith(`${other}-`)));
}

/**
 * The one wording for "acpx could not establish what the key allows", so the spawn
 * path and the read path cannot drift.
 *
 * ⚠️ It says what acpx knows and what follows from it — never what the provider will
 * do. The key's own refusal is still in force; that is precisely why failing open
 * here is safe, and the note has to make that legible rather than alarming.
 *
 * ⚠️ **SURFACE-NEUTRAL ON PURPOSE.** It is consumed by the spawn guard (one stderr
 * line per spawn) *and* by the catalogue descriptor {@link describeCatalogueEntitlement},
 * which puts it on `acpx models` and `/api/models`. An earlier wording said *"not
 * checking your model choice"* — true at a spawn, wrong on a listing, where the fact
 * is that **nothing has been narrowed**. One string for two surfaces only works if it
 * names the consequence rather than one caller's moment.
 */
export function formatEntitlementUnknown(entitlement: OpenRouterEntitlement): string {
  const because = entitlement.error === null ? "" : ` (${entitlement.error})`;
  return (
    `acpx could not read which models this box's OpenRouter key allows${because}, so nothing here ` +
    `is narrowed to that set. The key itself still enforces it: a model it does not allow will be ` +
    `refused by OpenRouter at call time instead of here. Run \`acpx models --refresh\` to ` +
    `repopulate the set.`
  );
}

/**
 * The catalogue's own statement of how well it knows the key's set — the READ-PATH
 * half of decision 2's *"permits everything **and says so**"*.
 *
 * 🛑 **THE SPAWN PATH SAID SO AND THE READ PATH DID NOT, WHICH MADE THE STATED DESIGN
 * HALF-TRUE IN THE DIRECTION THAT MATTERS.** Under fail-open an unreadable answer
 * leaves every OpenRouter row `ok: true` — a catalogue **byte-indistinguishable** from
 * a box whose key genuinely allows everything. So `acpx models list` answered
 * *"what may I use?"* with ~310 models, unhedged, on a cold / corrupt / 401'd read,
 * and `/api/models` gave the picker no field to qualify it with. Daniel's ask was
 * *"an agent can see and query via CLI what are the available models"*; silently
 * overstating in a failure state is that question answered wrong.
 *
 * ⚠️ **`source` IS THE MACHINE-READABLE PART.** `note` is prose and must never be
 * parsed — see `CatalogueEntitlement`.
 */
export function describeCatalogueEntitlement(
  entitlement: OpenRouterEntitlement,
): CatalogueEntitlement {
  if (entitlement.allowed === null) {
    return { source: "unknown", stale: false, note: formatEntitlementUnknown(entitlement) };
  }
  if (entitlement.stale) {
    const because = entitlement.error === null ? "" : ` (${entitlement.error})`;
    return {
      source: "key",
      stale: true,
      note:
        `the allowed-model set was read from a cache older than its TTL${because}, so it may not ` +
        `match what this box's OpenRouter key allows right now. Run \`acpx models --refresh\`.`,
    };
  }
  return { source: "key", stale: false, note: null };
}
