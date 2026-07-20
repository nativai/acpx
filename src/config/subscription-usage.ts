import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SubscriptionEntry } from "./subscriptions.js";

// Native per-subscription usage probe. Mirrors acpx-ui/server/sessionUsage.ts
// (kept independent — acpx must not depend on acpx-ui): for each subscription
// we read its <configDir>/.credentials.json OAuth token and POST a 1-token
// request to Anthropic /v1/messages, then read the unified rate-limit response
// headers. The body is throwaway; only the headers matter. Per-probe cost is
// ≈ $0.00001, so a 5-minute per-subscription cache keeps spend negligible.

function messagesEndpoint(): string {
  return process.env.CLAUDE_MESSAGES_ENDPOINT ?? "https://api.anthropic.com/v1/messages";
}

const PROBE_MODEL = "claude-haiku-4-5-20251001";
// The dedicated Fable-share probe model. A 1-token generation against this model
// is the ONLY reliable per-subscription Fable-share exhaustion signal today
// (200 ⇒ available, 429 ⇒ exhausted) — the 5h/7d unified windows do not track it.
const FABLE_PROBE_MODEL = "claude-fable-5";
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;

export type SubscriptionUsageWindow = {
  /** Raw utilization fraction in [0,1] from anthropic-ratelimit-unified-<k>-utilization. */
  utilization: number;
  /** ISO-8601 reset time, or null when the header is absent/unparseable. */
  reset: string | null;
};

// The Fable/"fallback" ALLOCATION, read passively from a SUCCESSFUL probe-model
// (haiku) response. Cheap — no extra request. Null when the probe errored or the
// headers were absent (older API / non-unified account).
export type SubscriptionFallbackAllocation = {
  /** anthropic-ratelimit-unified-fallback-percentage in [0,1] (0.5 = "half your
   *  usage for Fable"), or null when the header is absent/unparseable. */
  percentage: number | null;
  /** anthropic-ratelimit-unified-fallback raw availability string
   *  ("available" seen on sub1), or null when absent. Advisory only — NOT a
   *  reliable per-sub exhaustion signal (it was absent on most subs). */
  availability: string | null;
};

// Result of a DEDICATED claude-fable-5 probe. `available` is the load-bearing
// field. `utilization`/`reset` are best-effort: a 429 carries NO
// anthropic-ratelimit-* headers, so on exhaustion they are null; on a 200 they
// are populated IF the API exposes a fallback-utilization header (unconfirmed —
// parseFallbackUtilization/parseFallbackReset return null until a 200-Fable
// window is captured empirically).
export type SubscriptionFableState = {
  /** true ⇐ HTTP 200; false ⇐ HTTP 429 rate_limit_error. */
  available: boolean;
  /** Fallback utilization fraction [0,1] if a 200 response exposes it; else null. */
  utilization: number | null;
  /** Reset ISO if a 200 response exposes it; else null (429 carries none). */
  reset: string | null;
  /** Present only when the fable probe itself failed (network/auth/timeout) —
   *  DISTINCT from a clean 429. When set, `available` is false and callers must
   *  treat availability as UNKNOWN, not exhausted (do not raise the terminal
   *  error off a probe error). */
  error?: string;
};

export type SubscriptionUsage = {
  id: string;
  label: string;
  locked?: true;
  lockedAt?: string;
  lockedBy?: string;
  fiveHour: SubscriptionUsageWindow | null;
  sevenDay: SubscriptionUsageWindow | null;
  /** Present only when this subscription's probe failed; windows are null then. */
  error?: string;
  /** Fallback (Fable) allocation from the successful probe. Null on error/absent
   *  headers. Populated automatically by usageFromResponse — always cheap. */
  fallback?: SubscriptionFallbackAllocation | null;
  /** Dedicated fable-probe result. Present ONLY when a fable probe ran for this
   *  entry (undefined = not probed — the default for non-Fable paths). */
  fable?: SubscriptionFableState;
};

type CacheEntry = { value: SubscriptionUsage; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function clamp01(n: number): number {
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  if (n > 1) {
    return 1;
  }
  return n;
}

function parseWindow(headers: Headers, key: "5h" | "7d"): SubscriptionUsageWindow | null {
  const utilRaw = headers.get(`anthropic-ratelimit-unified-${key}-utilization`);
  if (utilRaw == null) {
    return null;
  }
  const util = Number(utilRaw);
  if (!Number.isFinite(util)) {
    return null;
  }
  const resetEpochSec = Number(headers.get(`anthropic-ratelimit-unified-${key}-reset`));
  const reset = Number.isFinite(resetEpochSec)
    ? new Date(resetEpochSec * 1000).toISOString()
    : null;
  return { utilization: clamp01(util), reset };
}

// The Fable-share ALLOCATION headers ride on every SUCCESSFUL haiku probe — read
// them for free. Distinct from the dedicated fable probe: this tells you the
// share SIZE (0.5 = half), NOT whether it is exhausted.
function parseFallback(headers: Headers): SubscriptionFallbackAllocation | null {
  const pctRaw = headers.get("anthropic-ratelimit-unified-fallback-percentage");
  const availability = headers.get("anthropic-ratelimit-unified-fallback"); // e.g. "available"
  if (pctRaw == null && availability == null) {
    return null;
  }
  const pct = pctRaw == null ? null : Number(pctRaw);
  return {
    percentage: pct != null && Number.isFinite(pct) ? clamp01(pct) : null,
    availability: availability ?? null,
  };
}

// Fallback UTILIZATION / RESET on a 200-Fable response. The exact header names
// are unconfirmed (all subs were Fable-exhausted when this was written, so no
// 200-Fable window was capturable). Until a window is captured empirically these
// return null (a safe default: the CLI then shows the boolean available/exhausted
// instead of a percentage). Additive — fill in the header name when confirmed.
function parseFallbackUtilization(_headers: Headers): number | null {
  return null;
}

function parseFallbackReset(_headers: Headers): string | null {
  return null;
}

async function readSubscriptionToken(configDir: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(configDir, ".credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    const token = parsed?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function usageFromResponse(res: Response, base: SubscriptionUsage): SubscriptionUsage {
  if (res.status === 401 || res.status === 403) {
    return { ...base, error: "authentication failed — re-run `claude` for this subscription" };
  }
  const fiveHour = parseWindow(res.headers, "5h");
  const sevenDay = parseWindow(res.headers, "7d");
  if (fiveHour || sevenDay) {
    return { ...base, fiveHour, sevenDay, fallback: parseFallback(res.headers) };
  }
  if (!res.ok) {
    return { ...base, error: `HTTP ${res.status}` };
  }
  return { ...base, error: "upstream response missing rate-limit headers" };
}

async function probeSubscriptionUsage(entry: SubscriptionEntry): Promise<SubscriptionUsage> {
  const base: SubscriptionUsage = {
    id: entry.id,
    label: entry.label,
    ...(entry.locked === true ? { locked: true } : {}),
    ...(entry.lockedAt !== undefined ? { lockedAt: entry.lockedAt } : {}),
    ...(entry.lockedBy !== undefined ? { lockedBy: entry.lockedBy } : {}),
    fiveHour: null,
    sevenDay: null,
  };

  const token = await readSubscriptionToken(entry.configDir);
  if (!token) {
    return { ...base, error: `no credentials at ${entry.configDir}/.credentials.json` };
  }

  try {
    const res = await fetch(messagesEndpoint(), {
      method: "POST",
      headers: probeRequestHeaders(token, "acpx/subscription-usage"),
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return usageFromResponse(res, base);
  } catch (err) {
    return { ...base, error: (err as Error).message || "network error" };
  }
}

// Shared 1-token /v1/messages probe request headers. OAuth bearer tokens (the
// kind Claude Code writes to .credentials.json) require the anthropic-beta header
// — without it the API returns 400.
function probeRequestHeaders(token: string, userAgent: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
    "Content-Type": "application/json",
    "User-Agent": userAgent,
  };
}

/** True when the model id names Fable (alias or full id), case-insensitive. This
 *  is the ONLY gate that keeps non-Fable sessions from paying any fable-probe
 *  cost. Substring match is robust to `fable` vs `claude-fable-5` vs
 *  `claude-fable-5[1m]`; no non-Fable model carries the substring. */
export function isFableModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.toLowerCase().includes("fable");
}

const fableCache = new Map<string, { value: SubscriptionFableState; expiresAt: number }>();

// A dedicated 1-token claude-fable-5 probe. A 429 is a CLEAN exhaustion signal
// (rejected before generation → no Fable quota consumed); a 200 consumes a sliver
// of the scarce Fable allocation. Never rejects: any failure yields `error` set
// and `available: false` (which callers must treat as UNKNOWN, not exhausted).
//
// VOLATILITY: this is a POINT-IN-TIME signal only. The Fable-share limit FLAPS
// near its boundary — a probe-429 does NOT mean a real turn will fail (real fable
// turns have been observed succeeding while this probe returned 429). Treat the
// probe as ADVISORY (visibility/steering); the AUTHORITATIVE exhaustion signal is
// a real-turn 429 → FableShareExhaustedError (failover.ts short-circuit).
async function probeFableAvailability(entry: SubscriptionEntry): Promise<SubscriptionFableState> {
  const token = await readSubscriptionToken(entry.configDir);
  if (!token) {
    return {
      available: false,
      utilization: null,
      reset: null,
      error: `no credentials at ${entry.configDir}/.credentials.json`,
    };
  }
  try {
    const res = await fetch(messagesEndpoint(), {
      method: "POST",
      headers: probeRequestHeaders(token, "acpx/subscription-fable"),
      body: JSON.stringify({
        model: FABLE_PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 429) {
      return { available: false, utilization: null, reset: null }; // CLEAN exhaustion
    }
    if (res.status === 401 || res.status === 403) {
      return {
        available: false,
        utilization: null,
        reset: null,
        error: "authentication failed — re-run `claude` for this subscription",
      };
    }
    if (res.ok) {
      return {
        available: true,
        utilization: parseFallbackUtilization(res.headers),
        reset: parseFallbackReset(res.headers),
      };
    }
    return { available: false, utilization: null, reset: null, error: `HTTP ${res.status}` };
  } catch (err) {
    return {
      available: false,
      utilization: null,
      reset: null,
      error: (err as Error).message || "network error",
    };
  }
}

function cachedFable(id: string): SubscriptionFableState | undefined {
  const hit = fableCache.get(id);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value;
  }
  return undefined;
}

async function fableForEntry(
  entry: SubscriptionEntry,
  forceRefresh: boolean,
): Promise<SubscriptionFableState> {
  if (!forceRefresh) {
    const cached = cachedFable(entry.id);
    if (cached) {
      return cached;
    }
  }
  const value = await probeFableAvailability(entry);
  // Cache BOTH a clean 200 (available) and a clean 429 (exhausted) — both are
  // definitive. Never cache network/auth errors, so a transient failure re-probes.
  if (value.error === undefined) {
    fableCache.set(entry.id, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return value;
}

/**
 * Fable availability per entry, 5-min cached in a SEPARATE map (a fable probe
 * never evicts/serves a haiku entry), probed in parallel. Never rejects.
 * `forceRefresh` bypasses the cache (a fresh read — for pre-spawn / failover
 * decisions so a Fable decision never acts on a stale "available").
 */
export async function getSubscriptionsFableState(
  entries: SubscriptionEntry[],
  forceRefresh = false,
): Promise<Map<string, SubscriptionFableState>> {
  const results = await Promise.all(
    entries.map(async (entry) => [entry.id, await fableForEntry(entry, forceRefresh)] as const),
  );
  return new Map(results);
}

/**
 * Probe usage AND fable, stitching each fable state onto its SubscriptionUsage.
 * Used by the CLI and by fable-aware selection so callers get one enriched list.
 */
export async function getSubscriptionsUsageWithFable(
  entries: SubscriptionEntry[],
  forceRefresh = false,
): Promise<SubscriptionUsage[]> {
  const [usages, fable] = await Promise.all([
    getSubscriptionsUsage(entries, forceRefresh),
    getSubscriptionsFableState(entries, forceRefresh),
  ]);
  for (const usage of usages) {
    const state = fable.get(usage.id);
    if (state !== undefined) {
      usage.fable = state;
    }
  }
  return usages;
}

function cachedUsage(id: string): SubscriptionUsage | undefined {
  const hit = cache.get(id);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value;
  }
  return undefined;
}

async function usageForEntry(
  entry: SubscriptionEntry,
  forceRefresh = false,
): Promise<SubscriptionUsage> {
  if (!forceRefresh) {
    const cached = cachedUsage(entry.id);
    if (cached) {
      return cached;
    }
  }
  const value = await probeSubscriptionUsage(entry);
  // Only cache successful probes so transient failures retry on the next call.
  if (value.error === undefined) {
    cache.set(entry.id, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return value;
}

/**
 * Probe each subscription's current 5h + 7d utilization, in parallel, with a
 * per-subscription 5-minute cache. Never rejects: a failed probe yields an
 * entry with `error` set and null windows. `forceRefresh` bypasses the cache
 * (used on the first failover for a turn so target selection does not act on a
 * stale "everything's fine" reading).
 */
export async function getSubscriptionsUsage(
  entries: SubscriptionEntry[],
  forceRefresh = false,
): Promise<SubscriptionUsage[]> {
  return await Promise.all(entries.map((entry) => usageForEntry(entry, forceRefresh)));
}

/** Highest of the two windows' utilization (the binding constraint), or 0. */
export function maxUtilization(usage: SubscriptionUsage): number {
  return Math.max(usage.fiveHour?.utilization ?? 0, usage.sevenDay?.utilization ?? 0);
}

const DEFAULT_MAXED_THRESHOLD = 0.98;

/**
 * Resolve the "too maxed to target" utilization threshold. Per CONCEPTION §8
 * OQ1 default: only skip a sub for being maxed if it is ≥0.98 (or has a probe
 * error / 401); otherwise utilization is used solely to RANK targets — we never
 * strand a usable sub. Configurable via ACPX_SUBSCRIPTION_MAXED_THRESHOLD.
 */
export function maxedThreshold(): number {
  const raw = process.env.ACPX_SUBSCRIPTION_MAXED_THRESHOLD?.trim();
  if (!raw) {
    return DEFAULT_MAXED_THRESHOLD;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return DEFAULT_MAXED_THRESHOLD;
  }
  return parsed;
}

type IndexedUsage = { usage: SubscriptionUsage; index: number };

function isEligibleForFailover(
  usage: SubscriptionUsage,
  exclude: ReadonlySet<string>,
  threshold: number,
): boolean {
  if (exclude.has(usage.id)) {
    return false;
  }
  if (usage.locked === true) {
    return false;
  }
  if (usage.error !== undefined) {
    return false;
  }
  // fiveHour === null means the 5h header was absent on a non-errored probe;
  // treat as ineligible — we cannot confirm the 5h headroom requirement is met.
  if (usage.fiveHour === null) {
    return false;
  }
  return usage.fiveHour.utilization < threshold;
}

function sevenDayResetKey(usage: SubscriptionUsage): number {
  const raw = Date.parse(usage.sevenDay?.reset ?? "");
  return Number.isNaN(raw) ? Number.POSITIVE_INFINITY : raw;
}

function compareFailoverCandidates(a: IndexedUsage, b: IndexedUsage): number {
  const resetDiff = sevenDayResetKey(a.usage) - sevenDayResetKey(b.usage);
  // Guard NaN: Infinity - Infinity = NaN when ALL eligible subs lack a known 7d
  // reset. NaN !== 0 is true, which would return NaN and skip the secondary
  // tiebreak. Treat NaN as a tie so the lower-util tiebreak still applies.
  if (resetDiff !== 0 && !Number.isNaN(resetDiff)) {
    return resetDiff;
  }
  const utilA = a.usage.sevenDay?.utilization ?? maxUtilization(a.usage);
  const utilB = b.usage.sevenDay?.utilization ?? maxUtilization(b.usage);
  if (utilA !== utilB) {
    return utilA - utilB;
  }
  return a.index - b.index;
}

/**
 * Pick the best failover target from a set of probed usages.
 *
 * Eligibility gate (all must hold):
 *   - not in `options.exclude`, not user-locked, no probe error
 *   - has 5h headroom: fiveHour !== null && fiveHour.utilization < threshold
 *     (fiveHour === null = header absent on non-errored probe → conservatively ineligible)
 *
 * Selection order among eligible (deterministic; picks the first):
 *   1. Soonest sevenDay.reset (null/unparseable → +Infinity, sorted last)
 *   2. Lower sevenDay.utilization (or maxUtilization(u) when sevenDay is null)
 *   3. Input (registry) order — index ascending
 *
 * Returns undefined when nothing qualifies (→ all-subscriptions-exhausted).
 */
export function pickFailoverTarget(
  usages: SubscriptionUsage[],
  options: { exclude: ReadonlySet<string>; threshold?: number },
): SubscriptionUsage | undefined {
  const threshold = options.threshold ?? maxedThreshold();
  const eligible = usages
    .map((usage, index) => ({ usage, index }))
    .filter(({ usage }) => isEligibleForFailover(usage, options.exclude, threshold));
  if (eligible.length === 0) {
    return undefined;
  }
  return eligible.toSorted(compareFailoverCandidates)[0].usage;
}

/**
 * Count how many usages pass the same eligibility gate `pickFailoverTarget`
 * uses. Purely for observability (the `auto` selection reports how many subs
 * were eligible); it applies no ranking and picks nothing.
 */
export function countEligibleFailoverTargets(
  usages: SubscriptionUsage[],
  options: { exclude: ReadonlySet<string>; threshold?: number },
): number {
  const threshold = options.threshold ?? maxedThreshold();
  return usages.reduce(
    (count, usage) =>
      isEligibleForFailover(usage, options.exclude, threshold) ? count + 1 : count,
    0,
  );
}
