import { readFile } from "node:fs/promises";
import path from "node:path";
import { readSessionIndex, type SessionIndexEntry } from "../session/persistence/index.js";
import { sessionBaseDir } from "../session/persistence/repository.js";
import type { AutomationEligibilitySource } from "../types.js";
import { patchFableSnapshot, readFableSnapshot, type FableSnapshot } from "./fable-snapshot.js";
import { findProfile, loadProfileRegistry, type ProfileRegistry } from "./profiles.js";
import {
  resolveEffectiveWeeklyCeiling,
  type SubscriptionEntry,
  type SubscriptionLookupOptions,
  type WeeklyCeilingSource,
} from "./subscriptions.js";

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
//
// Deliberately still generation 5.0 even though the `fable` alias now serves
// claude-fable-5-1 (SDK ≥0.3.251). MEASURED 2026-09-03 on devbox, production
// /v1/messages, 3 accounts (sub5/sub9/sub10), both probe orders: a 1-token
// claude-fable-5 probe and a 1-token claude-fable-5-1 probe return BYTE-IDENTICAL
// rate-limit header sets — same …-7d_oi-utilization, -reset and -status, and no
// extra allocation key on 5.1. A haiku probe carries NO 7d_oi at all, so that
// header is emitted because the REQUEST draws on the Fable share, not as a
// standing account readout ⇒ both generations meter against ONE weekly window and
// this probe predicts 5.1 availability. Do NOT "fix" this to 5.1 or probe both:
// the alias `fable` is not resolvable server-side (404), and probing both would
// double Fable spend for two identical answers. Scope: how Anthropic meters TODAY
// — a future split of the allocations would not be visible here.
// Evidence: brick https://acpx.devbox.nativai.de/?brick=982cf4f0
//   → verification/FINDINGS.md (+ evidence/probe.sh, which regenerates it).
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

// Per-account Fable state (brick://1badc6f1). The SOLE source is the 1-token
// claude-fable-5 probe: its 200 carries the REAL Fable weekly window in the
// `anthropic-ratelimit-unified-7d_oi-*` headers (the claude CLI's own label map
// names `seven_day_overage_included` "Fable 5 limit"). `available` is the
// load-bearing field; `utilization`/`reset` are the real numbers behind it.
export type SubscriptionFableState = {
  /** true ⇐ a 200 (Anthropic just SERVED fable — the strongest availability
   *  evidence); false ⇐ a 429 that carried unified rate-limit headers (real
   *  exhaustion) or a failed reading (then `error` is set — UNKNOWN, not
   *  exhausted). */
  available: boolean;
  /** REAL Fable weekly utilization [0,1] from …-7d_oi-utilization; null when the
   *  header was absent. */
  utilization: number | null;
  /** REAL Fable weekly reset (ISO-8601) from …-7d_oi-reset; null when absent. */
  reset: string | null;
  /** ISO time the served reading was taken. Present whenever the value came from
   *  (or was written to) the persisted snapshot; acpx-ui maps it to `probedAt` so
   *  the UI never has to guess a reading's age. */
  fetchedAt?: string;
  /** Present only when the reading itself failed (network/auth/timeout, or a BARE
   *  429 carrying no rate-limit headers — the request-shape gate) — DISTINCT from
   *  a clean exhaustion. When set, `available` is false and callers must treat
   *  availability as UNKNOWN, not exhausted (do not raise the terminal off it). */
  error?: string;
};

export type SubscriptionUsage = {
  id: string;
  label: string;
  /** Functional quota identity. Equal accounts share policy and provider usage. */
  account?: string;
  /** Shared display label fallback for the functional account. */
  accountLabel?: string;
  locked?: true;
  lockedAt?: string;
  lockedBy?: string;
  fiveHour: SubscriptionUsageWindow | null;
  sevenDay: SubscriptionUsageWindow | null;
  /** Present only when this subscription's probe failed; windows are null then. */
  error?: string;
  /** Resolved from the registry account policy (or legacy compatibility fallback). */
  effectiveWeeklyCeiling?: number;
  weeklyCeilingSource?: WeeklyCeilingSource;
  weeklyCeilingHard?: boolean;
  /** When the unified-window probe that produced this reading completed. */
  fetchedAt?: string;
  /** Whether this call obtained telemetry from the five-minute cache. */
  cacheStatus?: "fresh" | "cached";
  /** Shared engine/UI policy verdict at the normal 0.98 five-hour target bar. */
  eligibility?: SubscriptionEligibilityVerdict;
  /** Fallback (Fable) allocation from the successful probe. Null on error/absent
   *  headers. Populated automatically by usageFromResponse — always cheap. */
  fallback?: SubscriptionFallbackAllocation | null;
  /** Dedicated fable-probe result. Present ONLY when a fable probe ran for this
   *  entry (undefined = not probed — the default for non-Fable paths). */
  fable?: SubscriptionFableState;
};

export type SubscriptionEligibilityReason =
  | "locked"
  | "usage-error"
  | "five-hour-full"
  | "weekly-ceiling"
  | "provider-exhausted";

export type SubscriptionEligibilityVerdict = {
  accountId: string;
  accountLabel: string;
  vendorAvailable: boolean;
  automationEligible: boolean;
  effectiveWeeklyCeiling: number;
  reservedPercent: number;
  weeklyCeilingSource: WeeklyCeilingSource;
  hardCeiling: boolean;
  weeklyUsageKnown: boolean;
  usageFetchedAt: string | null;
  usageCacheStatus: "fresh" | "cached" | "unknown";
  reason: SubscriptionEligibilityReason | null;
  constrainingWindow?: "five-hour" | "seven-day";
  nextAutomationEligibleAt?: string;
  nextEligibilityAccountId?: string;
  nextEligibilityAccountLabel?: string;
  nextEligibilitySource?: AutomationEligibilitySource;
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

// The REAL Fable weekly window, read from a claude-fable-5 response's
// `anthropic-ratelimit-unified-7d_oi-*` headers. `7d_oi` is
// `seven_day_overage_included`, which the claude CLI's own label map names
// "Fable 5 limit" — and it rides ONLY on fable-5 responses (a haiku 200 carries
// 5h/7d but never 7d_oi). `-reset` equals the account's weekly 7d reset; the
// UTILIZATION is the new information.
function parseFableWindow(headers: Headers): {
  utilization: number | null;
  reset: string | null;
  status: string | null;
} {
  const utilRaw = headers.get("anthropic-ratelimit-unified-7d_oi-utilization");
  const util = utilRaw == null ? Number.NaN : Number(utilRaw);
  const resetEpochSec = Number(headers.get("anthropic-ratelimit-unified-7d_oi-reset"));
  return {
    utilization: Number.isFinite(util) ? clamp01(util) : null,
    reset: Number.isFinite(resetEpochSec) ? new Date(resetEpochSec * 1000).toISOString() : null,
    status: headers.get("anthropic-ratelimit-unified-7d_oi-status"),
  };
}

// Did this response carry ANY unified rate-limit header? It is the discriminator
// between the two 429 classes: a 429 WITH unified headers is real exhaustion
// (cacheable), a BARE 429 is the request-shape gate — UNKNOWN, never exhaustion.
function hasUnifiedRateLimitHeaders(headers: Headers): boolean {
  for (const [name] of headers) {
    if (name.toLowerCase().startsWith("anthropic-ratelimit-unified-")) {
      return true;
    }
  }
  return false;
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

// Each subscription is its own Anthropic account; fall back to id for legacy
// registries where account defaults to id anyway. This is the snapshot key.
function fableAccountKey(entry: SubscriptionEntry): string {
  return entry.account || entry.id;
}

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]?.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Hard freshness cap: a snapshot older than this is stale regardless of local
 *  activity. It is the ONLY cover for cross-box spend on a shared account, so a
 *  served reading is "real, and at most this old" — never "live". */
function fableMaxAgeMs(): number {
  return envMs("ACPX_FABLE_MAX_AGE_MS", 2 * 60 * 60_000);
}

/** Min interval between GATED probes for one account. Bounds steady-state probing
 *  to ≤12/hr/account while fable runs continuously — without it the per-turn floor
 *  check alone could drive ~120/hr. */
function fableActivityMinIntervalMs(): number {
  return envMs("ACPX_FABLE_ACTIVITY_MIN_INTERVAL_MS", 5 * 60_000);
}

/** Min interval between FORCED probes (`--reprobe`, the acpx-ui `?force=1` path).
 *  Pure burst collapse: N simultaneous askers ⇒ one probe. */
function fableForceMinIntervalMs(): number {
  return envMs("ACPX_FABLE_FORCE_MIN_INTERVAL_MS", 30_000);
}

/** How long a REAL-TURN Fable exhaustion stays authoritative. Short by design: a
 *  parked session stops producing fable activity, so nothing else would ever
 *  invalidate the stamp and one boundary flap would park the whole box. */
function fableExhaustedStampTtlMs(): number {
  return envMs("ACPX_FABLE_EXHAUSTED_STAMP_TTL_MS", 10 * 60_000);
}

/** The local activity gate is on unless explicitly disabled (`0`/`false`/`off`). */
function fableActivityGateEnabled(): boolean {
  const raw = process.env.ACPX_FABLE_ACTIVITY_GATE?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

// The Claude-Code system prefix. WITHOUT it Anthropic rejects every fable-5
// request from a subscription OAuth token with a bare 429 carrying NO rate-limit
// headers — a REQUEST-SHAPE gate, not quota. The prefix alone flips 429 → 200
// (isolated live on sub7 2026-08-01 and sub4 2026-08-02); haiku probes are
// unaffected. Every "fable throttled" the fleet showed before this line was a
// false negative.
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

type FableProbeResult = {
  state: SubscriptionFableState;
  /** Raw …-7d_oi-status, persisted as data; never read back into a decision. */
  status: string | null;
};

function probeFailure(error: string): FableProbeResult {
  return { state: { available: false, utilization: null, reset: null, error }, status: null };
}

/**
 * Turn a fable-probe response into state. Deliberately asymmetric-safe:
 *   - 200 ⇒ `available: true` from `res.ok` ALONE. Anthropic just served fable,
 *     which is the strongest availability evidence there is; `7d_oi-status` and
 *     utilization ride along as DATA and never flip `available` (a future
 *     `allowed_warning`-style string must not park a working sub).
 *   - 429 WITH unified rate-limit headers ⇒ real exhaustion (clean, no `error`).
 *   - BARE 429 (no unified headers) ⇒ the request-shape gate, or anything else we
 *     cannot read: `error` set ⇒ UNKNOWN, never a clean exhaustion.
 */
function classifyFableProbe(res: Response): FableProbeResult {
  if (res.status === 401 || res.status === 403) {
    return probeFailure("authentication failed — re-run `claude` for this subscription");
  }
  const clean = res.ok || (res.status === 429 && hasUnifiedRateLimitHeaders(res.headers));
  if (!clean) {
    return probeFailure(
      res.status === 429
        ? "fable probe rejected with no rate-limit headers (request-shape gate) — unknown"
        : `HTTP ${res.status}`,
    );
  }
  const window = parseFableWindow(res.headers);
  return {
    state: { available: res.ok, utilization: window.utilization, reset: window.reset },
    status: window.status,
  };
}

/**
 * A dedicated 1-token claude-fable-5 probe — the ONLY tap on the real Fable
 * weekly window (no passive source exists: a real turn's headers die inside the
 * claude CLI process, and the transcript records only 429 error events). Cost:
 * 31 input + 1 output tokens, quota-denominated. Never rejects.
 */
async function probeFableAvailability(token: string): Promise<FableProbeResult> {
  try {
    const res = await fetch(messagesEndpoint(), {
      method: "POST",
      headers: probeRequestHeaders(token, "acpx/subscription-fable"),
      body: JSON.stringify({
        model: FABLE_PROBE_MODEL,
        max_tokens: 1,
        system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_PREFIX }],
        messages: [{ role: "user", content: "." }],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return classifyFableProbe(res);
  } catch (err) {
    return probeFailure((err as Error).message || "network error");
  }
}

/** How a caller wants the snapshot served. `gated` (the default everywhere,
 *  including failover and auto-selection) probes only when the snapshot is stale;
 *  `force` treats it as always stale, honoring only the 30s burst guard. Force is
 *  reserved for the two explicit entry points: `--reprobe` and acpx-ui's
 *  `?force=1`. */
export type FableReadMode = "gated" | "force";

/** Latest local fable ACTIVITY per account, in epoch ms — index-only, no
 *  per-record read. An index entry counts when its model matches isFableModel
 *  (the stored value is the alias "fable", which the substring match covers).
 *
 *  Account resolution reads `.profile` through the registry's `profiles[].account`
 *  (exactly as failover's accountForEntry does), falling back to `.subscription`:
 *  measured on the live index, 45/45 fable entries carry `.profile` and 0 carry
 *  `.subscription`, so a `.subscription`-only gate is a total no-op. */
/** The ACCOUNT a session-index entry runs on: `.profile` resolved through the
 *  registry's `profiles[].account`, falling back to `.subscription`. */
function accountForIndexEntry(
  entry: SessionIndexEntry,
  profiles: ProfileRegistry,
): string | undefined {
  const fromProfile = entry.profile ? findProfile(entry.profile, profiles)?.account : undefined;
  return fromProfile ?? entry.subscription;
}

function fableActivityForEntry(
  entry: SessionIndexEntry,
  profiles: ProfileRegistry,
): { account: string; at: number } | undefined {
  if (!isFableModel(entry.sessionModel) && !isFableModel(entry.currentModelId)) {
    return undefined;
  }
  const account = accountForIndexEntry(entry, profiles);
  // lastWriteAt is the record-write time; lastUsedAt covers older index entries
  // written before that projection existed.
  const at = Date.parse(entry.lastWriteAt ?? entry.lastUsedAt);
  return account === undefined || Number.isNaN(at) ? undefined : { account, at };
}

async function fableActivityByAccount(
  loadOpts?: SubscriptionLookupOptions,
): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  const index = await readSessionIndex(sessionBaseDir()).catch(() => undefined);
  if (!index) {
    return latest;
  }
  const profiles = loadProfileRegistry(loadOpts);
  for (const entry of index.entries) {
    const activity = fableActivityForEntry(entry, profiles);
    if (activity) {
      latest.set(activity.account, Math.max(latest.get(activity.account) ?? 0, activity.at));
    }
  }
  return latest;
}

function snapshotState(snapshot: FableSnapshot): SubscriptionFableState | undefined {
  if (snapshot.fetchedAt === undefined || snapshot.available === undefined) {
    return undefined;
  }
  return {
    available: snapshot.available,
    utilization: snapshot.utilization ?? null,
    reset: snapshot.resetsAt ?? null,
    fetchedAt: snapshot.fetchedAt,
  };
}

/** Is the snapshot's reading still servable without a probe? Stale ⇔ no reading ·
 *  older than the hard cap · its reset has passed · local fable activity on this
 *  account since it was taken. */
function snapshotIsFresh(snapshot: FableSnapshot, now: number, activityAt: number): boolean {
  const fetchedAt = Date.parse(snapshot.fetchedAt ?? "");
  if (Number.isNaN(fetchedAt) || now - fetchedAt > fableMaxAgeMs()) {
    return false;
  }
  const resetsAt = Date.parse(snapshot.resetsAt ?? "");
  if (!Number.isNaN(resetsAt) && now >= resetsAt) {
    return false;
  }
  return !(fableActivityGateEnabled() && activityAt > fetchedAt);
}

/** A real-turn exhaustion still inside its TTL. Reported as unavailable WITHOUT
 *  utilization, because the stamp deliberately never advanced `fetchedAt`. */
function activeExhaustedStamp(
  snapshot: FableSnapshot,
  now: number,
): SubscriptionFableState | undefined {
  const stampedAt = Date.parse(snapshot.exhaustedStampAt ?? "");
  if (Number.isNaN(stampedAt) || now - stampedAt > fableExhaustedStampTtlMs()) {
    return undefined;
  }
  return {
    available: false,
    utilization: snapshot.utilization ?? null,
    reset: snapshot.resetsAt ?? null,
    fetchedAt: snapshot.exhaustedStampAt,
  };
}

function probeBlockedByMinInterval(
  snapshot: FableSnapshot,
  now: number,
  mode: FableReadMode,
): boolean {
  const attemptedAt = Date.parse(snapshot.lastProbeAttemptAt ?? "");
  const minInterval = mode === "force" ? fableForceMinIntervalMs() : fableActivityMinIntervalMs();
  return !Number.isNaN(attemptedAt) && now - attemptedAt < minInterval;
}

/**
 * Fable state for one entry, served from the persisted snapshot and probing only
 * when it is stale. Order: a live real-turn exhaustion stamp wins → a fresh
 * snapshot is served with NO outbound probe → otherwise probe, unless the
 * applicable min-interval guard collapses this ask onto an in-flight/recent one
 * (the guard only rate-limits probing; it never causes a refresh). There is no
 * background poller anywhere.
 */
async function fableForEntry(
  entry: SubscriptionEntry,
  mode: FableReadMode,
  activityAt: number,
): Promise<SubscriptionFableState> {
  const key = fableAccountKey(entry);
  const snapshot = (await readFableSnapshot(key)) ?? {};
  const now = Date.now();

  const stamped = activeExhaustedStamp(snapshot, now);
  if (stamped) {
    return stamped;
  }
  const served = snapshotState(snapshot);
  if (mode === "gated" && served && snapshotIsFresh(snapshot, now, activityAt)) {
    return served;
  }
  if (probeBlockedByMinInterval(snapshot, now, mode)) {
    return served ?? unknownFableState("fable probe rate-limited; no reading yet");
  }

  return await probeAndPersist(entry, key, now);
}

/** Claim the attempt, probe, and persist a clean reading. */
async function probeAndPersist(
  entry: SubscriptionEntry,
  key: string,
  now: number,
): Promise<SubscriptionFableState> {
  const token = await readSubscriptionToken(entry.configDir);
  if (!token) {
    return unknownFableState(`no credentials at ${entry.configDir}/.credentials.json`);
  }
  // Claim FIRST — stamping the attempt before the request is what makes the guard
  // collapse N simultaneous askers; stamping it with the RESULT would leave the
  // whole 10s request window open for everyone to fire into.
  await patchFableSnapshot(key, { lastProbeAttemptAt: new Date(now).toISOString() });

  const { state, status } = await probeFableAvailability(token);
  if (state.error !== undefined) {
    return state; // UNKNOWN — never persisted, so the next ask re-probes
  }
  const fetchedAt = new Date().toISOString();
  await patchFableSnapshot(key, {
    fetchedAt,
    available: state.available,
    utilization: state.utilization,
    resetsAt: state.reset,
    status,
    // A fresh reading supersedes any real-turn stamp (JSON.stringify drops it).
    exhaustedStampAt: undefined,
  });
  return { ...state, fetchedAt };
}

function unknownFableState(error: string): SubscriptionFableState {
  return { available: false, utilization: null, reset: null, error };
}

/**
 * Record a REAL-TURN Fable-share exhaustion for these accounts — the
 * authoritative signal (FableShareExhaustedError), distinct from any probe.
 * Deliberately does NOT advance `fetchedAt` or touch `utilization`, so it expires
 * on its own short TTL instead of masquerading as a fresh reading for hours.
 */
export async function stampFableRealTurnExhausted(entries: SubscriptionEntry[]): Promise<void> {
  const at = new Date().toISOString();
  await Promise.all(
    entries.map((entry) => patchFableSnapshot(fableAccountKey(entry), { exhaustedStampAt: at })),
  );
}

/**
 * Fable state per entry, resolved in parallel from the persisted per-account
 * snapshot. Never rejects. `mode` defaults to `gated` — including on the failover
 * and auto-selection paths, whose own session activity already trips the gate;
 * `force` belongs only to `--reprobe` and acpx-ui's explicit `?force=1`.
 */
export async function getSubscriptionsFableState(
  entries: SubscriptionEntry[],
  mode: FableReadMode = "gated",
  loadOpts?: SubscriptionLookupOptions,
): Promise<Map<string, SubscriptionFableState>> {
  // One index read for the whole sweep, never one per entry.
  const activity =
    mode === "gated" && fableActivityGateEnabled()
      ? await fableActivityByAccount(loadOpts)
      : new Map<string, number>();
  const results = await Promise.all(
    entries.map(
      async (entry) =>
        [
          entry.id,
          await fableForEntry(entry, mode, activity.get(fableAccountKey(entry)) ?? 0),
        ] as const,
    ),
  );
  return new Map(results);
}

/**
 * Probe usage AND fable, stitching each fable state onto its SubscriptionUsage.
 * Used by the CLI and by fable-aware selection so callers get one enriched list.
 * The two halves are independent: `forceUsageRefresh` bypasses the 5-min haiku
 * cache (failover's fresh-read requirement), while the fable half follows its own
 * snapshot rules under `fableMode`.
 */
export async function getSubscriptionsUsageWithFable(
  entries: SubscriptionEntry[],
  options: {
    forceUsageRefresh?: boolean;
    fableMode?: FableReadMode;
    loadOpts?: SubscriptionLookupOptions;
  } = {},
): Promise<SubscriptionUsage[]> {
  const [usages, fable] = await Promise.all([
    getSubscriptionsUsage(entries, options.forceUsageRefresh ?? false),
    getSubscriptionsFableState(entries, options.fableMode ?? "gated", options.loadOpts),
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

function decorateUsageForEntry(
  usage: SubscriptionUsage,
  entry: SubscriptionEntry,
  cacheStatus: "fresh" | "cached",
): SubscriptionUsage {
  const fallback = resolveEffectiveWeeklyCeiling(entry.account);
  const value: SubscriptionUsage = {
    ...usage,
    id: entry.id,
    label: entry.label,
    account: entry.account,
    accountLabel: entry.label,
    effectiveWeeklyCeiling: entry.effectiveWeeklyCeiling ?? fallback.value,
    weeklyCeilingSource: entry.weeklyCeilingSource ?? fallback.source,
    weeklyCeilingHard: entry.weeklyCeilingHard ?? fallback.hard,
    cacheStatus,
  };
  delete value.locked;
  delete value.lockedAt;
  delete value.lockedBy;
  if (entry.locked === true) {
    value.locked = true;
  }
  if (entry.lockedAt !== undefined) {
    value.lockedAt = entry.lockedAt;
  }
  if (entry.lockedBy !== undefined) {
    value.lockedBy = entry.lockedBy;
  }
  value.eligibility = subscriptionEligibilityVerdict(value, maxedThreshold());
  return value;
}

async function usageForEntry(
  entry: SubscriptionEntry,
  forceRefresh = false,
): Promise<SubscriptionUsage> {
  if (!forceRefresh) {
    const cached = cachedUsage(entry.id);
    if (cached) {
      return decorateUsageForEntry(cached, entry, "cached");
    }
  }
  const probed = await probeSubscriptionUsage(entry);
  probed.fetchedAt = new Date().toISOString();
  const value = decorateUsageForEntry(probed, entry, "fresh");
  // Only cache successful probes so transient failures retry on the next call.
  if (value.error === undefined) {
    cache.set(entry.id, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return value;
}

type UsageWindowKey = "fiveHour" | "sevenDay";

function resetSortValue(reset: string | null): number {
  const parsed = Date.parse(reset ?? "");
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function compareConservativeWindows(
  left: SubscriptionUsageWindow,
  right: SubscriptionUsageWindow,
): number {
  if (left.utilization !== right.utilization) {
    return right.utilization - left.utilization;
  }
  const leftReset = resetSortValue(left.reset);
  const rightReset = resetSortValue(right.reset);
  if (leftReset === rightReset || (!Number.isFinite(leftReset) && !Number.isFinite(rightReset))) {
    return 0;
  }
  return rightReset - leftReset;
}

function aggregateAccountWindow(
  usages: readonly SubscriptionUsage[],
  key: UsageWindowKey,
): SubscriptionUsageWindow | null {
  const windows = usages
    .filter((usage) => usage.error === undefined)
    .map((usage) => usage[key])
    .filter((window): window is SubscriptionUsageWindow => window !== null);
  const selected = windows.toSorted(compareConservativeWindows)[0];
  return selected ? { ...selected } : null;
}

function oldestUsageFetchedAt(usages: readonly SubscriptionUsage[]): string | undefined {
  const candidates = usages
    .map((usage) => usage.fetchedAt)
    .filter((value): value is string => value !== undefined)
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((candidate) => !Number.isNaN(candidate.time))
    .toSorted((left, right) => left.time - right.time);
  return candidates[0]?.value;
}

function accountCacheStatus(
  usages: readonly SubscriptionUsage[],
): SubscriptionUsage["cacheStatus"] {
  if (usages.some((usage) => usage.cacheStatus === "cached")) {
    return "cached";
  }
  return usages.some((usage) => usage.cacheStatus === "fresh") ? "fresh" : undefined;
}

type AccountUsageProjection = {
  accountLabel: string;
  fiveHour: SubscriptionUsageWindow | null;
  sevenDay: SubscriptionUsageWindow | null;
  fetchedAt?: string;
  cacheStatus?: "fresh" | "cached";
  locked: boolean;
  lockedAt?: string;
  lockedBy?: string;
};

function accountUsageLabel(usages: readonly SubscriptionUsage[]): string {
  const first = usages[0];
  if (!first) {
    return "unknown";
  }
  const account = first.account ?? first.id;
  return usages.find((usage) => usage.id === account)?.label ?? first.label;
}

function assignProjectionFreshness(
  projection: AccountUsageProjection,
  usages: readonly SubscriptionUsage[],
): void {
  const fetchedAt = oldestUsageFetchedAt(usages);
  const cacheStatus = accountCacheStatus(usages);
  if (fetchedAt !== undefined) {
    projection.fetchedAt = fetchedAt;
  }
  if (cacheStatus !== undefined) {
    projection.cacheStatus = cacheStatus;
  }
}

function assignProjectionLock(
  projection: AccountUsageProjection,
  lockedUsage: SubscriptionUsage | undefined,
): void {
  if (!lockedUsage) {
    return;
  }
  projection.locked = true;
  if (lockedUsage.lockedAt !== undefined) {
    projection.lockedAt = lockedUsage.lockedAt;
  }
  if (lockedUsage.lockedBy !== undefined) {
    projection.lockedBy = lockedUsage.lockedBy;
  }
}

function accountUsageProjection(usages: readonly SubscriptionUsage[]): AccountUsageProjection {
  const lockedUsage = usages.find((usage) => usage.locked === true);
  const projection: AccountUsageProjection = {
    accountLabel: accountUsageLabel(usages),
    fiveHour: aggregateAccountWindow(usages, "fiveHour"),
    sevenDay: aggregateAccountWindow(usages, "sevenDay"),
    locked: false,
  };
  assignProjectionFreshness(projection, usages);
  assignProjectionLock(projection, lockedUsage);
  return projection;
}

function applyAccountUsageProjection(
  usage: SubscriptionUsage,
  projection: AccountUsageProjection,
): SubscriptionUsage {
  const projected: SubscriptionUsage = {
    ...usage,
    accountLabel: projection.accountLabel,
    fiveHour: projection.fiveHour,
    sevenDay: projection.sevenDay,
    ...(projection.fetchedAt !== undefined ? { fetchedAt: projection.fetchedAt } : {}),
    ...(projection.cacheStatus !== undefined ? { cacheStatus: projection.cacheStatus } : {}),
  };
  delete projected.locked;
  delete projected.lockedAt;
  delete projected.lockedBy;
  if (projection.locked) {
    projected.locked = true;
  }
  if (projection.lockedAt !== undefined) {
    projected.lockedAt = projection.lockedAt;
  }
  if (projection.lockedBy !== undefined) {
    projected.lockedBy = projection.lockedBy;
  }
  projected.eligibility = subscriptionEligibilityVerdict(projected, maxedThreshold());
  return projected;
}

/**
 * Produce one conservative quota reading per functional account and project it
 * onto every alias. Successful aliases contribute the maximum utilization for
 * each window; an alias-local probe error remains attached so that credential
 * is not selected when the shared account itself is otherwise eligible.
 */
export function projectAccountSubscriptionUsage(usages: SubscriptionUsage[]): SubscriptionUsage[] {
  const groups = new Map<string, SubscriptionUsage[]>();
  for (const usage of usages) {
    const account = usage.account ?? usage.id;
    const group = groups.get(account) ?? [];
    group.push(usage);
    groups.set(account, group);
  }
  const projections = new Map(
    [...groups].map(([account, group]) => [account, accountUsageProjection(group)]),
  );
  return usages.map((usage) =>
    applyAccountUsageProjection(
      usage,
      projections.get(usage.account ?? usage.id) ?? accountUsageProjection([usage]),
    ),
  );
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
  const usages = await Promise.all(entries.map((entry) => usageForEntry(entry, forceRefresh)));
  return projectAccountSubscriptionUsage(usages);
}

export const CONFIGURED_WEEKLY_CEILING_REFRESH_MARGIN = 0.05;
export const CONFIGURED_WEEKLY_CEILING_MAX_CACHE_AGE_MS = 30_000;

function reserveReadingIsStale(usage: SubscriptionUsage): boolean {
  if (usage.cacheStatus !== "cached" || usage.fetchedAt === undefined) {
    return usage.cacheStatus === "cached";
  }
  const fetchedAt = Date.parse(usage.fetchedAt);
  return (
    Number.isNaN(fetchedAt) || Date.now() - fetchedAt >= CONFIGURED_WEEKLY_CEILING_MAX_CACHE_AGE_MS
  );
}

function shouldRefreshNearConfiguredCeiling(
  entry: SubscriptionEntry,
  usage: SubscriptionUsage | undefined,
): boolean {
  if (!usage || !reserveReadingIsStale(usage) || usage.sevenDay === null) {
    return false;
  }
  const ceiling =
    entry.effectiveWeeklyCeiling !== undefined && entry.weeklyCeilingHard !== undefined
      ? { value: entry.effectiveWeeklyCeiling, hard: entry.weeklyCeilingHard }
      : resolveEffectiveWeeklyCeiling(entry.account);
  return (
    ceiling.hard &&
    ceiling.value < 1 &&
    usage.sevenDay.utilization >=
      Math.max(0, ceiling.value - CONFIGURED_WEEKLY_CEILING_REFRESH_MARGIN)
  );
}

/**
 * Replace near-reserve cached readings with bounded fresh probes before making
 * an automatic routing/admission decision. Fresh and non-reserve readings pass
 * through unchanged, so the normal five-minute cache still bounds probe load.
 */
export async function refreshNearConfiguredWeeklyCeilings(
  entries: SubscriptionEntry[],
  usages: SubscriptionUsage[],
): Promise<SubscriptionUsage[]> {
  const projectedUsages = projectAccountSubscriptionUsage(usages);
  const usageById = new Map(projectedUsages.map((usage) => [usage.id, usage]));
  const refreshEntries = entries.filter((entry) =>
    shouldRefreshNearConfiguredCeiling(entry, usageById.get(entry.id)),
  );
  if (refreshEntries.length === 0) {
    return projectedUsages;
  }
  const refreshedById = new Map(
    (await getSubscriptionsUsage(refreshEntries, true)).map((usage) => [usage.id, usage]),
  );
  return projectAccountSubscriptionUsage(
    projectedUsages.map((usage) => refreshedById.get(usage.id) ?? usage),
  );
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
 * Legacy compatibility accessor. Account-aware production paths receive their
 * resolved value on SubscriptionUsage; direct callers without registry context
 * retain the environment/built-in 0.90 behavior.
 */
export function weeklyHeadroomThreshold(): number {
  return resolveEffectiveWeeklyCeiling("").value;
}

/** Empty exclude set for eligibility checks that don't exclude any sub. */
const EMPTY_EXCLUDE: ReadonlySet<string> = new Set<string>();

type IndexedUsage = { usage: SubscriptionUsage; index: number };

/**
 * Is `usage` an eligible subscription target? brick://67d2fd2f req1 exports this
 * so the forced-switch trigger (`shouldSwitchToSelectionTarget`) reuses the SAME
 * predicate as target selection — the two can never diverge on the weekly guard
 * again (that divergence was REPRO-REQ1 Mech1).
 */
export function isSubscriptionEligible(
  usage: SubscriptionUsage,
  exclude: ReadonlySet<string>,
  threshold: number,
): boolean {
  return isEligibleForFailover(usage, exclude, threshold);
}

export { EMPTY_EXCLUDE };

function ceilingFromUsage(usage: SubscriptionUsage): EffectiveUsageCeiling {
  if (
    usage.effectiveWeeklyCeiling !== undefined &&
    usage.weeklyCeilingSource !== undefined &&
    usage.weeklyCeilingHard !== undefined
  ) {
    return {
      value: usage.effectiveWeeklyCeiling,
      source: usage.weeklyCeilingSource,
      hard: usage.weeklyCeilingHard,
    };
  }
  return resolveEffectiveWeeklyCeiling(usage.account ?? usage.id);
}

type EffectiveUsageCeiling = ReturnType<typeof resolveEffectiveWeeklyCeiling>;

function providerExhausted(usage: SubscriptionUsage): boolean {
  return (usage.fiveHour?.utilization ?? 0) >= 1 || (usage.sevenDay?.utilization ?? 0) >= 1;
}

function telemetryUsable(usage: SubscriptionUsage): boolean {
  return usage.error === undefined && usage.fiveHour !== null;
}

function weeklyCeilingReached(usage: SubscriptionUsage, ceiling: number): boolean {
  return usage.sevenDay !== null && usage.sevenDay.utilization >= ceiling;
}

function fiveHourThresholdReached(usage: SubscriptionUsage, threshold: number): boolean {
  return usage.fiveHour !== null && usage.fiveHour.utilization >= threshold;
}

function eligibilityReason(
  usage: SubscriptionUsage,
  ceiling: number,
  fiveHourThreshold: number,
): SubscriptionEligibilityReason | undefined {
  if (usage.locked === true) {
    return "locked";
  }
  if (providerExhausted(usage)) {
    return "provider-exhausted";
  }
  if (weeklyCeilingReached(usage, ceiling)) {
    return "weekly-ceiling";
  }
  if (!telemetryUsable(usage)) {
    return "usage-error";
  }
  if (fiveHourThresholdReached(usage, fiveHourThreshold)) {
    return "five-hour-full";
  }
  return undefined;
}

function constrainingWindow(
  usage: SubscriptionUsage,
  reason: SubscriptionEligibilityReason | undefined,
): "five-hour" | "seven-day" | undefined {
  if (reason === "five-hour-full") {
    return "five-hour";
  }
  if (reason === "weekly-ceiling") {
    return "seven-day";
  }
  if (reason !== "provider-exhausted") {
    return undefined;
  }
  return providerBindingWindow(fullProviderWindows(usage))?.window;
}

function resetEligibilityProjection(
  usage: SubscriptionUsage,
  window: "five-hour" | "seven-day",
  reset: string | null | undefined,
): Pick<
  SubscriptionEligibilityVerdict,
  | "nextAutomationEligibleAt"
  | "nextEligibilityAccountId"
  | "nextEligibilityAccountLabel"
  | "nextEligibilitySource"
> {
  if (!reset || Number.isNaN(Date.parse(reset))) {
    return {};
  }
  return {
    nextAutomationEligibleAt: reset,
    nextEligibilityAccountId: usage.account ?? usage.id,
    nextEligibilityAccountLabel: usage.accountLabel ?? usage.label,
    nextEligibilitySource: window === "five-hour" ? "five-hour-reset" : "weekly-reset",
  };
}

type FullProviderWindow = {
  window: "five-hour" | "seven-day";
  reset: string | null;
};

function fullProviderWindow(
  window: SubscriptionUsageWindow | null,
  name: "five-hour" | "seven-day",
): FullProviderWindow | undefined {
  if (!window || window.utilization < 1) {
    return undefined;
  }
  return { window: name, reset: window.reset };
}

function fullProviderWindows(usage: SubscriptionUsage): FullProviderWindow[] {
  return [
    fullProviderWindow(usage.fiveHour, "five-hour"),
    fullProviderWindow(usage.sevenDay, "seven-day"),
  ].filter((window): window is FullProviderWindow => window !== undefined);
}

function providerResetUnknown(entry: FullProviderWindow): boolean {
  return !entry.reset || Number.isNaN(Date.parse(entry.reset));
}

function providerBindingWindow(
  full: readonly FullProviderWindow[],
): FullProviderWindow | undefined {
  if (full.length < 2) {
    return full[0];
  }
  if (full.some(providerResetUnknown)) {
    // Both windows are physically full, but at least one reset is unknown. Use
    // seven-day as the deterministic broader-window label; the executable
    // providerEligibilityProjection guard omits the time tuple in this case.
    return full.find((entry) => entry.window === "seven-day") ?? full[0];
  }
  return full.toSorted(
    (left, right) => Date.parse(right.reset ?? "") - Date.parse(left.reset ?? ""),
  )[0];
}

function providerEligibilityProjection(
  usage: SubscriptionUsage,
): ReturnType<typeof resetEligibilityProjection> {
  const full = fullProviderWindows(usage);
  if (full.length === 0 || full.some(providerResetUnknown)) {
    return {};
  }
  const binding = providerBindingWindow(full);
  return binding ? resetEligibilityProjection(usage, binding.window, binding.reset) : {};
}

function nextEligibilityProjection(
  usage: SubscriptionUsage,
  reason: SubscriptionEligibilityReason | undefined,
): ReturnType<typeof resetEligibilityProjection> {
  if (reason === "five-hour-full") {
    return resetEligibilityProjection(usage, "five-hour", usage.fiveHour?.reset);
  }
  if (reason === "weekly-ceiling") {
    return resetEligibilityProjection(usage, "seven-day", usage.sevenDay?.reset);
  }
  return reason === "provider-exhausted" ? providerEligibilityProjection(usage) : {};
}

function accountIdForUsage(usage: SubscriptionUsage): string {
  return usage.account ?? usage.id;
}

function accountLabelForUsage(usage: SubscriptionUsage): string {
  return usage.accountLabel ?? usage.label;
}

function usageFetchedAtOrNull(usage: SubscriptionUsage): string | null {
  return usage.fetchedAt ?? null;
}

function usageCacheStatusOrUnknown(
  usage: SubscriptionUsage,
): SubscriptionEligibilityVerdict["usageCacheStatus"] {
  return usage.cacheStatus ?? "unknown";
}

function nullableEligibilityReason(
  reason: SubscriptionEligibilityReason | undefined,
): SubscriptionEligibilityReason | null {
  return reason ?? null;
}

function vendorAvailableForUsage(usage: SubscriptionUsage): boolean {
  return telemetryUsable(usage) && !providerExhausted(usage);
}

export function subscriptionEligibilityVerdict(
  usage: SubscriptionUsage,
  fiveHourThreshold: number = maxedThreshold(),
): SubscriptionEligibilityVerdict {
  const ceiling = ceilingFromUsage(usage);
  const weeklyUsageKnown = usage.sevenDay !== null;
  const reason = eligibilityReason(usage, ceiling.value, fiveHourThreshold);
  const window = constrainingWindow(usage, reason);

  const verdict: SubscriptionEligibilityVerdict = {
    accountId: accountIdForUsage(usage),
    accountLabel: accountLabelForUsage(usage),
    vendorAvailable: vendorAvailableForUsage(usage),
    automationEligible: reason === undefined,
    effectiveWeeklyCeiling: ceiling.value,
    reservedPercent: Number(((1 - ceiling.value) * 100).toFixed(10)),
    weeklyCeilingSource: ceiling.source,
    hardCeiling: ceiling.hard,
    weeklyUsageKnown,
    usageFetchedAt: usageFetchedAtOrNull(usage),
    usageCacheStatus: usageCacheStatusOrUnknown(usage),
    reason: nullableEligibilityReason(reason),
    ...nextEligibilityProjection(usage, reason),
  };
  if (window !== undefined) {
    verdict.constrainingWindow = window;
  }
  return verdict;
}

export type NextKnownAutomationEligibility = {
  at: string;
  accountId: string;
  accountLabel: string;
  source: AutomationEligibilitySource;
};

function accountUsageRepresentatives(usages: readonly SubscriptionUsage[]): SubscriptionUsage[] {
  const representatives = new Map<string, SubscriptionUsage>();
  for (const usage of usages) {
    const account = usage.account ?? usage.id;
    const current = representatives.get(account);
    if (!current || (current.error !== undefined && usage.error === undefined)) {
      representatives.set(account, usage);
    }
  }
  return [...representatives.values()];
}

function nextKnownForUsage(usage: SubscriptionUsage): NextKnownAutomationEligibility | undefined {
  const verdict = subscriptionEligibilityVerdict(usage, maxedThreshold());
  const at = verdict.nextAutomationEligibleAt;
  const source = verdict.nextEligibilitySource;
  if (!at || !source || Number.isNaN(Date.parse(at))) {
    return undefined;
  }
  return {
    at,
    accountId: verdict.nextEligibilityAccountId ?? verdict.accountId,
    accountLabel: verdict.nextEligibilityAccountLabel ?? verdict.accountLabel,
    source,
  };
}

/** Earliest known policy-eligible time across distinct functional accounts. */
export function earliestKnownAutomationEligibility(
  usages: readonly SubscriptionUsage[],
): NextKnownAutomationEligibility | undefined {
  const candidates = accountUsageRepresentatives(usages)
    .map((usage) => nextKnownForUsage(usage))
    .filter((candidate): candidate is NextKnownAutomationEligibility => candidate !== undefined)
    .toSorted((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return candidates[0];
}

function isEligibleForFailover(
  usage: SubscriptionUsage,
  exclude: ReadonlySet<string>,
  threshold: number,
): boolean {
  if (exclude.has(usage.id)) {
    return false;
  }
  return subscriptionEligibilityVerdict(usage, threshold).automationEligible;
}

function sevenDayResetKey(usage: SubscriptionUsage): number {
  const raw = Date.parse(usage.sevenDay?.reset ?? "");
  return Number.isNaN(raw) ? Number.POSITIVE_INFINITY : raw;
}

export function compareFailoverCandidates(a: IndexedUsage, b: IndexedUsage): number {
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
 * brick://4d517be2 — is `candidate` strictly better than `current` under the same
 * (soonest 7d reset → lower 7d util → registry index) ordering `pickFailoverTarget`
 * uses? Drives the proactive-selection OPTIMIZATION trigger (only rebalance toward a
 * strictly-better sub). Reuses `compareFailoverCandidates` so ranking is identical.
 */
export function subscriptionRanksStrictlyBetter(
  candidate: SubscriptionUsage,
  current: SubscriptionUsage,
  candidateIndex: number,
  currentIndex: number,
): boolean {
  return (
    compareFailoverCandidates(
      { usage: candidate, index: candidateIndex },
      { usage: current, index: currentIndex },
    ) < 0
  );
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
  const accounts = new Set<string>();
  for (const usage of usages) {
    if (isEligibleForFailover(usage, options.exclude, threshold)) {
      accounts.add(usage.account ?? usage.id);
    }
  }
  return accounts.size;
}
