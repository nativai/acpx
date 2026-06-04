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
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;

export type SubscriptionUsageWindow = {
  /** Raw utilization fraction in [0,1] from anthropic-ratelimit-unified-<k>-utilization. */
  utilization: number;
  /** ISO-8601 reset time, or null when the header is absent/unparseable. */
  reset: string | null;
};

export type SubscriptionUsage = {
  id: string;
  label: string;
  fiveHour: SubscriptionUsageWindow | null;
  sevenDay: SubscriptionUsageWindow | null;
  /** Present only when this subscription's probe failed; windows are null then. */
  error?: string;
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
    return { ...base, fiveHour, sevenDay };
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
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        // OAuth bearer tokens (the kind Claude Code writes to .credentials.json)
        // require this beta header — without it the API returns 400.
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        "User-Agent": "acpx/subscription-usage",
      },
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

/**
 * Pick the best failover target from a set of probed usages: exclude already-
 * tried subs, any with a probe error (401/probe-fail), and any at/above the
 * maxed threshold; among the rest pick the lowest max-utilization (most
 * headroom). Ties resolve to input order (callers pass registry order).
 * Returns undefined when nothing qualifies (→ all-subscriptions-exhausted).
 */
export function pickFailoverTarget(
  usages: SubscriptionUsage[],
  options: { exclude: ReadonlySet<string>; threshold?: number },
): SubscriptionUsage | undefined {
  const threshold = options.threshold ?? maxedThreshold();
  let best: SubscriptionUsage | undefined;
  let bestUtil = Number.POSITIVE_INFINITY;
  for (const usage of usages) {
    if (options.exclude.has(usage.id)) {
      continue;
    }
    if (usage.error !== undefined) {
      continue;
    }
    const util = maxUtilization(usage);
    if (util >= threshold) {
      continue;
    }
    if (util < bestUtil) {
      best = usage;
      bestUtil = util;
    }
  }
  return best;
}
