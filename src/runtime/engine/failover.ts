import type { EffectiveAccountMetadata } from "../../acp/auth-env.js";
import { splitCommandLine } from "../../acp/client-process.js";
import { isCodexAcpCommand } from "../../acp/codex-compat.js";
import {
  effectiveAccountMetadataFromValue,
  formatErrorMessage,
} from "../../acp/error-normalization.js";
import { extractAcpError } from "../../acp/error-shapes.js";
import {
  findProfile,
  isSubscriptionProfileLocked,
  loadProfileRegistry,
} from "../../config/profiles.js";
import {
  EMPTY_EXCLUDE,
  getSubscriptionsFableState,
  getSubscriptionsUsage,
  getSubscriptionsUsageWithFable,
  isFableModel,
  isSubscriptionEligible,
  maxedThreshold,
  maxUtilization,
  pickFailoverTarget,
  stampFableRealTurnExhausted,
  subscriptionRanksStrictlyBetter,
  type SubscriptionUsage,
} from "../../config/subscription-usage.js";
import {
  isSubscriptionLocked,
  loadSubscriptionRegistry,
  type SubscriptionEntry,
  type SubscriptionLookupOptions,
} from "../../config/subscriptions.js";
import {
  AllSubscriptionsExhaustedError,
  AllSubscriptionsLockedError,
  BridgeAuthGatedError,
  FableShareExhaustedError,
  ModelFloorUnmetError,
  SubscriptionLockedError,
} from "../../errors.js";
import { applyFableDegrade, fableDegradeOkForRecord } from "../../session/fable-degrade.js";
import { floorHardEnabled, pinnedModelFloor, setFloorParked } from "../../session/model-floor.js";
import { writeSessionRecord } from "../../session/persistence/repository.js";
import type { SessionRecord } from "../../types.js";
import {
  getAccountHealth,
  markAccountDead,
  switchSessionAccount,
  transcriptAnchorDir,
  type AccountHealth,
  type ResolvedProfile,
} from "./account-seam.js";

// Classify a thrown turn error (manager.ts:745) into a subscription-failover
// trigger. The primary signal is machine-readable: the adapter attaches the SDK
// assistant-error discriminant as JSON-RPC `data.errorKind` (preserved by
// error-shapes.ts / error-normalization.ts), and a 401/auth path arrives as the
// auth-required ACP code (-32000). A string match on the message is the
// belt-and-suspenders fallback (mirrors output.ts's isRateLimitError) for paths
// that carry no errorKind.
//
// NOTE on Risk 4 (SDK error-kind drift): the conception called for asserting the
// SDK's `SDKAssistantMessageError` literal union so a rename breaks the build.
// acpx does NOT depend on @anthropic-ai/claude-agent-sdk (only on
// @agentclientprotocol/sdk) — the errorKind reaches acpx only as a JSON-RPC
// string across the adapter boundary, so there is no compile-time SDK type to
// import here. FAILOVER_ERROR_KINDS below is acpx's authoritative copy of that
// contract; the unit test pins it so any change is a deliberate, reviewed edit,
// and the string-match fallback covers a silent upstream rename.

export type FailoverTrigger = "rate_limit" | "auth_failed" | "billing" | "auth_gated" | null;

/** The adapter-supplied `data.errorKind` values that warrant a sub failover. */
export const FAILOVER_ERROR_KINDS = {
  rate_limit: "rate_limit",
  authentication_failed: "authentication_failed",
  billing_error: "billing_error",
} as const;

/** The ACP error code the adapter uses for a 401 / "please run /login" path. */
const AUTH_REQUIRED_ACP_CODE = -32000;

function errorKindFromData(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const kind = (data as { errorKind?: unknown }).errorKind;
  return typeof kind === "string" ? kind : undefined;
}

function classifyErrorKind(kind: string): FailoverTrigger {
  switch (kind) {
    case FAILOVER_ERROR_KINDS.rate_limit:
      return "rate_limit";
    case FAILOVER_ERROR_KINDS.authentication_failed:
      return "auth_failed";
    case FAILOVER_ERROR_KINDS.billing_error:
      return "billing";
    default:
      return null;
  }
}

function matchesRateLimitText(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    /\b429\b/u.test(message) ||
    // Claude subscription-limit family: "You've hit your <session|weekly|monthly|usage> limit",
    // "You've hit your limit", "monthly spend limit".
    /\bhit your\b[\s\S]*\blimit\b/u.test(lower) ||
    [
      "rate limit",
      "quota exceeded",
      "usage limit",
      "session limit",
      "weekly limit",
      "monthly limit",
      "spend limit",
      "out of usage",
      "credit balance",
      "insufficient credit",
      "low balance",
    ].some((text) => lower.includes(text))
  );
}

function errorMessageText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

// A claude-pty bridge whose stored Claude login expired surfaces as a generic
// AdapterHealthError on the adapter's catch-all code (-32000) carrying
// data.reason/state === "auth-gated". Detect that auth-gated state explicitly so
// it does NOT collapse into the broad "-32000 → auth_failed" rule below (which is
// reserved for a real subscription 401). Mirrors acpx-ui's isAuthGatedTailError —
// the single source of truth for this cross-repo contract.
function isAuthGatedAcp(acp: ReturnType<typeof extractAcpError>): boolean {
  const data = asRecord(acp?.data);
  return data?.reason === "auth-gated" || data?.state === "auth-gated";
}

function classifyFromAcp(acp: ReturnType<typeof extractAcpError>): FailoverTrigger {
  // 1. Machine-readable errorKind (preferred).
  const kind = errorKindFromData(acp?.data);
  const byKind = kind !== undefined ? classifyErrorKind(kind) : null;
  if (byKind) {
    return byKind;
  }
  // 2. Auth-gated bridge (expired claude-home login) → distinct trigger, ahead
  //    of the generic -32000 rule. Still non-null so failover engages.
  if (isAuthGatedAcp(acp)) {
    return "auth_gated";
  }
  // 3. Auth-required ACP code (401 / login path) → dead sub.
  return acp?.code === AUTH_REQUIRED_ACP_CODE ? "auth_failed" : null;
}

export function classifyFailover(error: unknown): FailoverTrigger {
  const acp = extractAcpError(error);
  const byAcp = classifyFromAcp(acp);
  if (byAcp) {
    return byAcp;
  }
  // 3. String-match fallback for a 429/usage-limit with no errorKind.
  const message = acp?.message ?? errorMessageText(error);
  return message && matchesRateLimitText(message) ? "rate_limit" : null;
}

// A non-quota failure (auth-gated bridge / subscription 401) carries no reset
// timestamp, so without this it would fall to the process-lifetime sentinel
// (9999-…) in markAccountDeadSync — locking the account out for the rest of the
// process with no auto-recovery even after the login is fixed. Bound it to a
// short TTL instead: activeDeadUntil() treats a past deadUntil as "not dead", so
// the account auto-re-probes in ~1 min. Quota (rate_limit/billing) is unaffected
// — those keep today's reset-or-sentinel behavior.
const NON_QUOTA_DEAD_TTL_MS = 60_000;

function nonQuotaDeadUntil(trigger: FailoverTrigger): string | undefined {
  return trigger === "auth_gated" || trigger === "auth_failed"
    ? new Date(Date.now() + NON_QUOTA_DEAD_TTL_MS).toISOString()
    : undefined;
}

/**
 * Failover only engages on a box with a usable provider registry. On a
 * no-registry box this is false and resolution stays
 * byte-identical to today (backward safety A5).
 */
export function failoverEnabled(loadOpts?: SubscriptionLookupOptions): boolean {
  return loadProfileRegistry(loadOpts).profiles.some(
    (profile) => transcriptAnchorDir(profile) !== null,
  );
}

function describeUsage(usage: SubscriptionUsage, account: string): string {
  if (usage.error) {
    return `${account} (${usage.id}): ${usage.error}`;
  }
  const reset = earliestUsageReset(usage);
  return `${account} (${usage.id}): ${Math.round(maxUtilization(usage) * 100)}% used${
    reset ? `, resets ${formatReset(reset)}` : ""
  }`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// "Unified healthy" = at least one sub can STILL serve non-Fable traffic (5h
// present, no probe error, utilization < the maxed threshold). This is the
// ISOLATING discriminator that a rate_limit is Fable-SPECIFIC (the per-model
// fallback cap) rather than whole-account exhaustion — it is exactly the premise
// FableShareExhaustedError asserts, so we must VERIFY it before raising that error.
function unifiedUsageHealthy(usages: SubscriptionUsage[], threshold: number): boolean {
  return usages.some(
    (usage) =>
      usage.error === undefined &&
      usage.fiveHour !== null &&
      usage.fiveHour.utilization < threshold,
  );
}

// Evidence string for the FableShareExhaustedError message — carries the ACTUAL
// unified figures just read (so "unified windows healthy" is backed by numbers,
// not asserted) plus the fable-429 count.
function fableShareEvidence(usages: SubscriptionUsage[], threshold: number): string {
  const healthy = usages.find(
    (usage) =>
      usage.error === undefined &&
      usage.fiveHour !== null &&
      usage.fiveHour.utilization < threshold,
  );
  const unified = healthy
    ? `unified 5h ${pctText(healthy.fiveHour?.utilization)}/7d ${pctText(healthy.sevenDay?.utilization)} — healthy on ${healthy.id}`
    : "unified maxed everywhere";
  const exhausted = usages.filter(
    (usage) => usage.fable?.available === false && usage.fable.error === undefined,
  ).length;
  return `${unified}; fable 429 on ${exhausted}/${usages.length} subs`;
}

function pctText(fraction: number | null | undefined): string {
  return fraction == null ? "n/a" : `${Math.round(fraction * 100)}%`;
}

// Seed `tried` with the fable-EXHAUSTED accounts (clean 429 only) so the failover
// loop only fails over to fable-available subs — no wasted hops on known-429 subs.
function seedFableExhaustedTried(
  entries: SubscriptionEntry[],
  usageById: Map<string, SubscriptionUsage>,
  tried: Set<string>,
  loadOpts?: SubscriptionLookupOptions,
): void {
  for (const entry of entries) {
    const state = usageById.get(entry.id)?.fable;
    if (state?.available === false && state.error === undefined) {
      const account = accountForEntry(entry, loadOpts);
      if (account) {
        tried.add(account);
      }
    }
  }
}

// The `tried`-set account key for a subscription entry (same profile.account key
// the failover loop keys on), so seeding it with fable-exhausted subs makes the
// loop skip them. Returns undefined when no profile matches (leave it eligible).
function accountForEntry(
  entry: SubscriptionEntry,
  loadOpts?: SubscriptionLookupOptions,
): string | undefined {
  return findProfile(entry.id, loadProfileRegistry(loadOpts))?.account;
}

// Fable rate_limit short-circuit (§3b) — the core value. The Fable-share limit is
// invisible to 5h/7d tracking, so without this a Fable session that hits it hops
// EVERY sub (each 429s on fable) with a full turn before any terminal fires.
// Probe fable FRESH: if every sub is cleanly exhausted, restore selection and
// throw FableShareExhaustedError immediately (skip the thrash loop). Otherwise
// seed `tried` with the fable-EXHAUSTED accounts so the loop only fails over to
// fable-available subs. A probe ERROR is UNKNOWN — never counted available, never
// seeded (degrades to normal failover; we only short-circuit on POSITIVE evidence
// of a clean 429). Returns a status snapshot for the mid-loop boundary conversion.
//
// NOTE the probe is a VOLATILE point-in-time signal (the limit flaps near its
// boundary). This is acceptable here because it runs ONLY after the session's OWN
// real turn already 429'd — the AUTHORITATIVE signal — so the fresh probe is
// corroborating that live failure, not predicting it in the abstract.
//
// CLASSIFICATION GATE: FableShareExhaustedError claims "unified 5h/7d windows are
// healthy". So we VERIFY that before raising it — probe unified AND fable fresh in
// one shot. If NOTHING can serve non-Fable traffic (unified maxed everywhere), the
// 429 is GENERIC exhaustion, not the fable-share cap: return isFableRateLimit=false
// so BOTH the pre-loop throw and the mid-loop conversion are bypassed and the
// normal path raises AllSubscriptionsExhaustedError (correct cause + remedy).
async function fableRateLimitShortCircuit(params: {
  record: SessionRecord;
  sessionModel: string;
  tried: Set<string>;
  restoreOriginalSelection: () => Promise<void>;
  loadOpts?: SubscriptionLookupOptions;
}): Promise<{ isFableRateLimit: boolean; statusSnapshot?: string }> {
  const entries = loadSubscriptionRegistry(params.loadOpts).subscriptions;
  // Unified (haiku) is read FRESH — the classification gate below must not act on
  // a stale "everything's fine". Fable is read GATED: this session's own record
  // was just written, so the activity gate already trips for its account, and the
  // 2h cap is the freshness contract for the rest (brick://1badc6f1).
  const usages = await getSubscriptionsUsageWithFable(entries, {
    forceUsageRefresh: true,
    loadOpts: params.loadOpts,
  });
  const threshold = maxedThreshold();
  if (!unifiedUsageHealthy(usages, threshold)) {
    return { isFableRateLimit: false }; // generic exhaustion, not fable-share
  }
  const statusSnapshot = fableShareEvidence(usages, threshold);
  const anyAvailable = usages.some((usage) => usage.fable?.available === true);
  // A probe ERROR = UNKNOWN. Short-circuit ONLY on POSITIVE evidence — every sub a
  // clean 429 (no available, no unknown). If any probe errored we degrade to the
  // normal loop so a real turn decides that sub (AC8), never a false terminal.
  const anyUnknown = usages.some((usage) => usage.fable?.error !== undefined);
  if (!anyAvailable && !anyUnknown) {
    // brick://4d517be2 — every sub is cleanly fable-exhausted AND unified is
    // healthy. If the session opted into fable→opus degrade, durably rewrite the
    // model to Opus and let the normal failover loop pick a unified-healthy sibling
    // and complete the turn on Opus (return isFableRateLimit:false so the fable
    // seeding is skipped). Otherwise the behavior is byte-identical to before:
    // restore the original selection and raise the loud terminal.
    if (fableDegradeOkForRecord(params.record)) {
      await applyFableDegrade(params.record, { from: params.sessionModel });
      return { isFableRateLimit: false };
    }
    await stampFableRealTurnExhausted(entries);
    await params.restoreOriginalSelection();
    throw new FableShareExhaustedError(statusSnapshot);
  }
  const usageById = new Map(usages.map((usage) => [usage.id, usage]));
  seedFableExhaustedTried(entries, usageById, params.tried, params.loadOpts);
  return { isFableRateLimit: true, statusSnapshot };
}

// Boundary conversion (§3b): when the fable-available subset ALSO exhausts
// mid-loop, the loop throws AllSubscriptionsExhaustedError — the WRONG class for a
// Fable session. Re-throw it as FableShareExhaustedError, carrying over the
// effective-account metadata the exhausted error already attached. Every non-Fable
// path and every other error class propagates byte-identically.
async function convertFableTerminal(
  loopError: unknown,
  fable: { isFableRateLimit: boolean; statusSnapshot?: string },
  loadOpts?: SubscriptionLookupOptions,
): Promise<never> {
  if (fable.isFableRateLimit && loopError instanceof AllSubscriptionsExhaustedError) {
    // REAL-TURN evidence (every fable-available sub 429'd on an actual turn) —
    // stamp it so siblings on this box see the exhaustion without re-probing.
    await stampFableRealTurnExhausted(loadSubscriptionRegistry(loadOpts).subscriptions);
    const converted = new FableShareExhaustedError(fable.statusSnapshot ?? loopError.message);
    attachEffectiveAccount(converted, errorEffectiveAccount(loopError));
    throw converted;
  }
  throw loopError;
}

// Compute whether this failover is a Fable rate_limit case and, if so, run the
// short-circuit (throw-now-if-all-exhausted / seed `tried`). Keeps the model
// lookup + gating out of attemptFailoverAndRetry.
async function prepareFableShortCircuit(params: {
  record: SessionRecord;
  initialTrigger: FailoverTrigger;
  tried: Set<string>;
  restoreOriginalSelection: () => Promise<void>;
  loadOpts?: SubscriptionLookupOptions;
}): Promise<{ isFableRateLimit: boolean; statusSnapshot?: string }> {
  const sessionModel =
    params.record.acpx?.session_options?.model ?? params.record.acpx?.current_model_id;
  if (!isFableModel(sessionModel) || params.initialTrigger !== "rate_limit") {
    return { isFableRateLimit: false };
  }
  return await fableRateLimitShortCircuit({
    record: params.record,
    // Non-empty Fable string here (isFableModel is false for undefined/null); the
    // `?? "fable"` is a defensive TS-narrowing default, never taken in practice.
    sessionModel: sessionModel ?? "fable",
    tried: params.tried,
    restoreOriginalSelection: params.restoreOriginalSelection,
    loadOpts: params.loadOpts,
  });
}

function errorEffectiveAccount(error: unknown): EffectiveAccountMetadata | undefined {
  const record = asRecord(error);
  if (!record) {
    return undefined;
  }
  return effectiveAccountMetadataFromValue(
    record.effectiveAccountMetadata ?? record.effectiveAccount,
  );
}

const RESET_KEYS = new Set([
  "reset",
  "resetAt",
  "resetsAt",
  "reset_at",
  "resets_at",
  "resetTime",
  "reset_time",
]);

function resetIsoFromError(error: unknown): string | undefined {
  const acp = extractAcpError(error);
  return (
    resetIsoFromValue(acp?.data) ??
    parseResetTimestamp(acp?.message) ??
    parseResetTimestamp(errorMessageText(error)) ??
    resetIsoFromValue(error)
  );
}

function resetIsoFromValue(value: unknown, depth = 0): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  const direct = parseResetTimestamp(value);
  if (direct !== undefined) {
    return direct;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of RESET_KEYS) {
    const nested = resetIsoFromValue(record[key], depth + 1);
    if (nested !== undefined) {
      return nested;
    }
  }
  return Object.values(record)
    .map((entry) => resetIsoFromValue(entry, depth + 1))
    .find((entry) => entry !== undefined);
}

function parseResetTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return dateIsoFromEpoch(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/u.test(trimmed)) {
    return dateIsoFromEpoch(Number(trimmed));
  }
  const textReset = parseTextualUtcReset(trimmed);
  if (textReset !== undefined) {
    return textReset;
  }
  const time = Date.parse(trimmed);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

function parseTextualUtcReset(message: string): string | undefined {
  const match = /\bresets?\s+(\d{1,2}):(\d{2})\s*(am|pm)\s*\(UTC\)/iu.exec(message);
  if (!match) {
    return undefined;
  }
  const hour12 = Number(match[1]);
  const minute = Number(match[2]);
  if (hour12 < 1 || hour12 > 12 || minute < 0 || minute > 59) {
    return undefined;
  }
  const hour = (hour12 % 12) + (match[3].toLowerCase() === "pm" ? 12 : 0);
  const now = new Date(Date.now());
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

function dateIsoFromEpoch(value: number): string | undefined {
  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function attachEffectiveAccount(
  error: unknown,
  metadata: EffectiveAccountMetadata | undefined,
): unknown {
  if (metadata === undefined || !error || typeof error !== "object") {
    return error;
  }
  (error as { effectiveAccountMetadata?: EffectiveAccountMetadata }).effectiveAccountMetadata ??=
    metadata;
  return error;
}

function storedSelectionId(record: SessionRecord): string | undefined {
  const options = record.acpx?.session_options;
  return options?.profile?.trim() || options?.subscription?.trim() || undefined;
}

function defaultProfileId(loadOpts?: SubscriptionLookupOptions): string | undefined {
  return loadProfileRegistry(loadOpts).default?.trim() || undefined;
}

// A codex session authenticates from its native ~/.codex (a `chatgpt` profile, or
// no profile at all — native auth). It is the only adapter that legitimately
// carries no stored profile, so it is the only one that reaches the default
// fallback below. The registry `default` is a Claude *subscription* profile; the
// codex adapter rejects any non-chatgpt profile at turn auth. Detect codex records
// so we can withhold that fallback rather than force an incompatible profile onto
// them. (brick://792ad0a4)
function recordUsesCodexAdapter(record: SessionRecord): boolean {
  const agentCommand = record.agentCommand;
  if (!agentCommand) {
    return false;
  }
  const split = splitCommandLine(agentCommand);
  return isCodexAcpCommand(split.command, split.args);
}

function selectedProfileId(
  record: SessionRecord,
  loadOpts?: SubscriptionLookupOptions,
): string | undefined {
  const stored = storedSelectionId(record);
  if (stored !== undefined) {
    return stored;
  }
  // Do NOT fall back to the registry default (a Claude subscription) for a codex
  // session: that made the pre-turn subscription selector treat the session as
  // subscription-backed and persist an incompatible profile, which the codex
  // adapter then rejected at turn auth — killing every codex-session turn in ~13ms
  // (brick://792ad0a4, regressed by the subauto pre-turn selector). Resolving to
  // `undefined` leaves codex on native auth: currentProfile()/failoverEnabledForRecord/
  // selectSubscriptionBeforeTurn all no-op for it, exactly as before subauto.
  if (recordUsesCodexAdapter(record)) {
    return undefined;
  }
  return defaultProfileId(loadOpts);
}

function currentProfile(
  record: SessionRecord,
  loadOpts?: SubscriptionLookupOptions,
): ResolvedProfile | undefined {
  const id = selectedProfileId(record, loadOpts);
  return id ? findProfile(id, loadProfileRegistry(loadOpts)) : undefined;
}

function metadataFromProfile(profile: ResolvedProfile): EffectiveAccountMetadata {
  const anchor = transcriptAnchorDir(profile);
  return {
    effectiveAccount: profile.account,
    effectiveProfile: profile.id,
    effectiveAdapter: profile.adapter,
    effectiveAuthMode: profile.authMode,
    ...(anchor !== null ? { effectiveAnchor: anchor } : {}),
    effectiveResolutionMethod: profile.authMode === "openrouter" ? "selection" : "path",
  };
}

function failureContext(
  error: unknown,
  fallbackProfile: ResolvedProfile,
): EffectiveAccountMetadata {
  return errorEffectiveAccount(error) ?? metadataFromProfile(fallbackProfile);
}

export function failoverEnabledForRecord(
  record: SessionRecord,
  loadOpts?: SubscriptionLookupOptions,
): boolean {
  if (!autoFailoverEnabledForRecord(record)) {
    return false;
  }
  const profile = currentProfile(record, loadOpts);
  return profile !== undefined && transcriptAnchorDir(profile) !== null;
}

export function autoFailoverEnabledForRecord(record: SessionRecord): boolean {
  return record.acpx?.session_options?.auto_failover !== false;
}

// brick://4d517be2 — per-session autonomous-selection policy. Absent means enabled
// (default-ON); only explicit false opts out. Mirrors autoFailoverEnabledForRecord.
export function autoSubscriptionEnabledForRecord(record: SessionRecord): boolean {
  return record.acpx?.session_options?.auto_subscription !== false;
}

// Global fleet-wide kill-switch for autonomous selection (belt-and-suspenders for a
// fast rollback without touching sessions). Default ON; set falsy to disable. Mirrors
// the ACPX_SUBSCRIPTION_MAXED_THRESHOLD env-parse discipline.
function subscriptionAutoSelectEnabledGlobally(): boolean {
  const raw = process.env.ACPX_SUBSCRIPTION_AUTO_SELECT?.trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

// The proactive-selection thrash-guard cooldown (decision #3): the minimum dwell
// before an OPTIMIZATION switch (rebalance toward a sooner-reset sub while the
// current one is still healthy). Defaults to the 5-min probe-cache TTL so we never
// re-optimize more often than the ranking can change. FORCED switches (current sub
// <30% headroom / locked / errored) bypass this.
const DEFAULT_SUBSCRIPTION_SELECT_COOLDOWN_MS = 300_000;

function subscriptionSelectCooldownMs(): number {
  const raw = process.env.ACPX_SUBSCRIPTION_SELECT_COOLDOWN_MS?.trim();
  if (!raw) {
    return DEFAULT_SUBSCRIPTION_SELECT_COOLDOWN_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SUBSCRIPTION_SELECT_COOLDOWN_MS;
  }
  return parsed;
}

export function isSubscriptionLockBlockError(
  error: unknown,
): error is SubscriptionLockedError | AllSubscriptionsLockedError {
  return error instanceof SubscriptionLockedError || error instanceof AllSubscriptionsLockedError;
}

function cloneSessionOptions(
  options: NonNullable<NonNullable<SessionRecord["acpx"]>["session_options"]> | undefined,
): NonNullable<NonNullable<SessionRecord["acpx"]>["session_options"]> | undefined {
  if (options === undefined) {
    return undefined;
  }
  return {
    ...options,
    ...(options.subscription_switch !== undefined
      ? { subscription_switch: { ...options.subscription_switch } }
      : {}),
    ...(options.account_switch !== undefined
      ? { account_switch: { ...options.account_switch } }
      : {}),
  };
}

/**
 * Snapshot the record's current unified selection + breadcrumbs and return a
 * restore-and-persist function. Used so exhaustion leaves the record UNCHANGED
 * (A3 / edge-1): after some failover attempts mutated it, restore the original
 * so a later turn re-probes and auto-recovers.
 */
function snapshotSelectionRestorer(record: SessionRecord): () => Promise<void> {
  const originalOptions = cloneSessionOptions(record.acpx?.session_options);
  return async () => {
    if (!record.acpx) {
      return;
    }
    // brick://4d517be2 — this restore undoes SELECTION (subscription/account) only,
    // never a Fable→Opus degrade applied AFTER the snapshot was taken. The snapshot
    // captured the pre-degrade Fable model; blindly restoring it would silently
    // un-degrade a session that deliberately fell back to Opus (and leave the
    // fable_degrade breadcrumb contradicting the model). Carry the live degrade
    // (model/model_source + breadcrumb) forward. Gated on `explicit-degrade` so this
    // is a strict no-op for every normal failover restore.
    const live = record.acpx.session_options;
    const degradeOverlay =
      live?.model_source === "explicit-degrade"
        ? {
            model: live.model,
            model_source: live.model_source,
            ...(live.fable_degrade !== undefined
              ? { fable_degrade: { ...live.fable_degrade } }
              : {}),
          }
        : undefined;
    if (originalOptions === undefined && degradeOverlay === undefined) {
      delete record.acpx.session_options;
    } else {
      record.acpx.session_options = {
        ...cloneSessionOptions(originalOptions),
        ...degradeOverlay,
      };
    }
    await writeSessionRecord(record);
  };
}

type CandidateStatus = {
  profile: ResolvedProfile;
  health: AccountHealth;
  usage?: SubscriptionUsage;
  missingSubscriptionEntry?: boolean;
  tried: boolean;
};

function activeDeadUntil(health: AccountHealth): string | undefined {
  const raw = health.deadUntil?.trim();
  if (!raw) {
    return undefined;
  }
  const time = Date.parse(raw);
  return Number.isNaN(time) || time > Date.now() ? raw : undefined;
}

function earliestUsageReset(usage: SubscriptionUsage): string | undefined {
  const resets = [usage.fiveHour?.reset, usage.sevenDay?.reset]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .toSorted();
  return resets[0];
}

function formatReset(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return iso;
  }
  return `${new Date(time).toISOString().slice(11, 16)}Z`;
}

function describeStatus(status: CandidateStatus): string {
  const account = status.profile.account;
  if (status.tried) {
    return `${account} (${status.profile.id}): already tried this turn`;
  }
  const deadUntil = activeDeadUntil(status.health);
  if (deadUntil) {
    return `${account} (${status.profile.id}): marked dead until ${formatReset(deadUntil)}`;
  }
  if (status.missingSubscriptionEntry) {
    return `${account} (${status.profile.id}): no subscription probe entry`;
  }
  if (status.usage) {
    return describeUsage(status.usage, account);
  }
  return `${account} (${status.profile.id}): eligible`;
}

function accountHealthy(status: CandidateStatus): boolean {
  return !status.tried && activeDeadUntil(status.health) === undefined;
}

function bySubscriptionId(entries: SubscriptionEntry[]): Map<string, SubscriptionEntry> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

function byUsageId(usages: SubscriptionUsage[]): Map<string, SubscriptionUsage> {
  return new Map(usages.map((usage) => [usage.id, usage]));
}

async function candidateStatuses(
  profiles: ResolvedProfile[],
  triedAccounts: ReadonlySet<string>,
): Promise<CandidateStatus[]> {
  return await Promise.all(
    profiles.map(async (profile) => ({
      profile,
      health: await getAccountHealth(profile.account),
      tried: triedAccounts.has(profile.account),
    })),
  );
}

async function pickSubscriptionSibling(
  statuses: CandidateStatus[],
  loadOpts?: SubscriptionLookupOptions,
): Promise<{ target?: ResolvedProfile; statuses: CandidateStatus[] }> {
  const entryById = bySubscriptionId(loadSubscriptionRegistry(loadOpts).subscriptions);
  const entries = statuses
    .filter(accountHealthy)
    .map((status) => entryById.get(status.profile.id))
    .filter((entry): entry is SubscriptionEntry => entry !== undefined);
  const usages = await getSubscriptionsUsage(entries, true);
  const usageById = byUsageId(usages);
  const enriched = statuses.map((status) => ({
    ...status,
    ...(usageById.get(status.profile.id) !== undefined
      ? { usage: usageById.get(status.profile.id) }
      : {}),
    ...(status.profile.authMode === "subscription" && !entryById.has(status.profile.id)
      ? { missingSubscriptionEntry: true }
      : {}),
  }));
  const picked = pickFailoverTarget(usages, { exclude: new Set() });
  return {
    target: picked
      ? enriched.find((status) => status.profile.id === picked.id)?.profile
      : undefined,
    statuses: enriched,
  };
}

function effectiveSourceProfile(
  registry: ReturnType<typeof loadProfileRegistry>,
  current: ResolvedProfile,
  context: EffectiveAccountMetadata,
): { source: ResolvedProfile; failedAccount: string } {
  const effectiveProfileId = context.effectiveProfile?.trim();
  const byEffectiveProfile = effectiveProfileId
    ? findProfile(effectiveProfileId, registry)
    : undefined;
  if (byEffectiveProfile) {
    return { source: byEffectiveProfile, failedAccount: context.effectiveAccount };
  }
  const byEffectiveAccount = registry.profiles.find(
    (profile) =>
      profile.authMode === current.authMode && profile.account === context.effectiveAccount,
  );
  if (byEffectiveAccount) {
    return { source: byEffectiveAccount, failedAccount: context.effectiveAccount };
  }
  return { source: current, failedAccount: current.account };
}

function failoverCandidates(
  current: ResolvedProfile,
  context: EffectiveAccountMetadata,
  loadOpts?: SubscriptionLookupOptions,
): { source: ResolvedProfile; siblings: ResolvedProfile[] } {
  const registry = loadProfileRegistry(loadOpts);
  const { source, failedAccount } = effectiveSourceProfile(registry, current, context);
  return {
    source,
    // The selected profile can be stale after a failed target startup. Exclude the
    // physically failed account, not the selected account, so that selected target
    // remains eligible for a fresh-client retry.
    siblings: registry.profiles.filter(
      (profile) =>
        profile.authMode === source.authMode &&
        profile.account !== failedAccount &&
        !isSubscriptionProfileLocked(profile, registry),
    ),
  };
}

async function pickSibling(
  current: ResolvedProfile,
  context: EffectiveAccountMetadata,
  triedAccounts: ReadonlySet<string>,
  loadOpts?: SubscriptionLookupOptions,
): Promise<{
  source: ResolvedProfile;
  target?: ResolvedProfile;
  statuses: string[];
  siblingCount: number;
  portableCount: number;
}> {
  const { source, siblings } = failoverCandidates(current, context, loadOpts);
  const currentAnchor = transcriptAnchorDir(source);
  const portable =
    currentAnchor === null
      ? []
      : siblings.filter((profile) => transcriptAnchorDir(profile) !== null);
  const baseStatuses = await candidateStatuses(portable, triedAccounts);
  const picked =
    source.authMode === "subscription"
      ? await pickSubscriptionSibling(baseStatuses, loadOpts)
      : { target: baseStatuses.find(accountHealthy)?.profile, statuses: baseStatuses };
  return {
    source,
    target: picked.target,
    statuses: picked.statuses.map(describeStatus),
    siblingCount: siblings.length,
    portableCount: portable.length,
  };
}

type PickedSibling = Awaited<ReturnType<typeof pickSibling>>;

function noSiblingMessage(
  current: ResolvedProfile,
  context: EffectiveAccountMetadata,
  health: AccountHealth,
): string {
  const reset = health.resetsAt ? formatReset(health.resetsAt) : "unknown";
  return (
    `failover unavailable - profile "${current.id}" (${current.authMode}) has no sibling account; ` +
    `account "${current.account}" resets ${reset}; effectiveAccount "${context.effectiveAccount}"`
  );
}

function noPortableSiblingMessage(
  current: ResolvedProfile,
  context: EffectiveAccountMetadata,
): string {
  return (
    `failover unavailable - profile "${current.id}" (${current.authMode}) has no portable sibling account; ` +
    `account "${current.account}" resets unknown; effectiveAccount "${context.effectiveAccount}"`
  );
}

function lockBlockStatuses(current: ResolvedProfile, statuses: readonly string[]): string {
  const prefix = `selected subscription "${current.id}" is locked`;
  return statuses.length > 0 ? `${prefix}; ${statuses.join("; ")}` : prefix;
}

async function pickUnlockedTargetForLockedProfile(
  current: ResolvedProfile,
  loadOpts?: SubscriptionLookupOptions,
): Promise<PickedSibling> {
  const registry = loadProfileRegistry(loadOpts);
  const siblings = registry.profiles.filter(
    (profile) =>
      profile.authMode === current.authMode &&
      profile.account !== current.account &&
      !isSubscriptionProfileLocked(profile, registry),
  );
  const currentAnchor = transcriptAnchorDir(current);
  const portable =
    currentAnchor === null
      ? []
      : siblings.filter((profile) => transcriptAnchorDir(profile) !== null);
  const baseStatuses = await candidateStatuses(portable, new Set());
  const picked =
    current.authMode === "subscription"
      ? await pickSubscriptionSibling(baseStatuses, loadOpts)
      : { target: baseStatuses.find(accountHealthy)?.profile, statuses: baseStatuses };
  return {
    source: current,
    target: picked.target,
    statuses: picked.statuses.map(describeStatus),
    siblingCount: siblings.length,
    portableCount: portable.length,
  };
}

export type SubscriptionLockEnforcementResult = {
  switchedTo?: string;
};

export async function enforceSubscriptionLockBeforeTurn(
  record: SessionRecord,
  loadOpts?: SubscriptionLookupOptions,
): Promise<SubscriptionLockEnforcementResult> {
  const registry = loadProfileRegistry(loadOpts);
  const current = currentProfile(record, loadOpts);
  if (
    !current ||
    current.authMode !== "subscription" ||
    !isSubscriptionProfileLocked(current, registry)
  ) {
    return {};
  }
  if (!autoFailoverEnabledForRecord(record)) {
    throw new SubscriptionLockedError(current.id, { origin: "runtime", outputCode: "RUNTIME" });
  }

  const picked = await pickUnlockedTargetForLockedProfile(current, loadOpts);
  if (picked.siblingCount === 0 || picked.portableCount === 0) {
    throw new AllSubscriptionsLockedError(lockBlockStatuses(current, picked.statuses));
  }
  if (!picked.target) {
    throw new AllSubscriptionsExhaustedError(lockBlockStatuses(current, picked.statuses));
  }

  await switchSessionAccount(record, picked.target.id, "locked", loadOpts);
  await writeSessionRecord(record);
  return { switchedTo: picked.target.id };
}

export type SubscriptionSelectionResult = {
  switchedTo?: string;
};

// brick://4d517be2 — DEFAULT-ON autonomous subscription selection, a pre-turn
// sibling of enforceSubscriptionLockBeforeTurn. Before every turn (both ingress
// paths funnel here) auto-pick the best-headroom sub: ≥30% 5h headroom
// (threshold 0.70) → soonest weekly reset. A thrash guard bounds turn-to-turn
// switching (decision #3). NEVER-THROW / best-effort: any probe/registry/switch
// failure is swallowed (keep the current sub) — a selection failure must never
// block a turn (unlike the lock hook, which legitimately refuses).
export async function selectSubscriptionBeforeTurn(
  record: SessionRecord,
  loadOpts?: SubscriptionLookupOptions,
): Promise<SubscriptionSelectionResult> {
  try {
    return await selectSubscriptionBeforeTurnUnsafe(record, loadOpts);
  } catch (error) {
    // Best-effort: log and keep the current sub. Model on resolveAutoSubscription's
    // "never throws — any failure degrades to the default" contract.
    process.stderr.write(
      `[acpx] proactive subscription selection skipped (best-effort): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return {};
  }
}

// The no-op gates (decision #4): global kill-switch, per-session auto_subscription
// opt-out, OR auto_failover:false (a session locked to its sub must not be
// proactively moved either — this also makes "locked session" decision #7 fall out).
function proactiveSelectionDisabled(record: SessionRecord): boolean {
  return (
    !subscriptionAutoSelectEnabledGlobally() ||
    !autoSubscriptionEnabledForRecord(record) ||
    !autoFailoverEnabledForRecord(record)
  );
}

async function selectSubscriptionBeforeTurnUnsafe(
  record: SessionRecord,
  loadOpts?: SubscriptionLookupOptions,
): Promise<SubscriptionSelectionResult> {
  if (proactiveSelectionDisabled(record)) {
    return {};
  }
  const current = currentProfile(record, loadOpts);
  // Only subscription-auth sessions participate; non-subscription profiles have no
  // headroom/reset probe to select on.
  if (!current || current.authMode !== "subscription") {
    return {};
  }

  const registry = loadSubscriptionRegistry(loadOpts);
  const entries = registry.subscriptions;
  if (entries.length === 0) {
    return {};
  }
  // Account-propagated lock exclude (decision #7) — the correct primary, NOT the
  // empty-exclude reactive-failover path. A locked sub is never picked as a target.
  const exclude = new Set(
    entries.filter((entry) => isSubscriptionLocked(entry, registry)).map((entry) => entry.id),
  );
  // Cached probe (≤5-min staleness tolerated for a best-effort optimization) →
  // ≤1 probe-set / session / 5 min. Reactive failover uses forceRefresh; we do not.
  const usages = await getSubscriptionsUsage(entries, false);

  const target = pickSelectionTarget(usages, exclude);
  if (!target || target.id === current.id) {
    return {}; // already optimal / nothing eligible
  }

  const currentIndex = usages.findIndex((usage) => usage.id === current.id);
  const currentUsage = usages[currentIndex]; // undefined when currentIndex is -1 (not found)
  const targetIndex = usages.findIndex((usage) => usage.id === target.id);
  if (
    !shouldSwitchToSelectionTarget({
      record,
      target,
      targetIndex,
      currentUsage,
      currentIndex,
    })
  ) {
    return {};
  }

  await switchSessionAccount(record, target.id, "selection", loadOpts);
  await writeSessionRecord(record);
  return { switchedTo: target.id };
}

// The #2 fallback ladder: primary rule (≥30% 5h headroom → soonest reset), then the
// least-maxed guard (0.98) when no sub clears 30%, then hold (undefined).
function pickSelectionTarget(
  usages: SubscriptionUsage[],
  exclude: ReadonlySet<string>,
): SubscriptionUsage | undefined {
  const primary = pickFailoverTarget(usages, { exclude, threshold: 0.7 });
  if (primary) {
    return primary;
  }
  // Secondary: everyone's below 30% headroom — move off a maxed sub onto the
  // least-maxed / soonest-reset one (strictly better than sitting maxed).
  return pickFailoverTarget(usages, { exclude, threshold: maxedThreshold() });
}

// Thrash guard (decision #3): FORCED when the current sub is ineligible (locked /
// errored / <30% headroom) — bypasses the cooldown; OPTIMIZATION when the current
// sub is still healthy but the target ranks strictly better AND no auto-selection
// switch happened within the cooldown.
export function shouldSwitchToSelectionTarget(params: {
  record: SessionRecord;
  target: SubscriptionUsage;
  targetIndex: number;
  currentUsage: SubscriptionUsage | undefined;
  currentIndex: number;
}): boolean {
  const { currentUsage } = params;
  // Current sub ineligible → FORCED switch (correctness floor; also covers a current
  // sub missing from the probe set, i.e. no headroom evidence). brick://67d2fd2f
  // req1 (REPRO-REQ1 Mech1): reuse the SHARED eligibility predicate instead of a
  // hand-rolled 5h-only test, so the forced trigger and target selection can never
  // diverge on the weekly guard again. threshold 0.70 = the primary 5h bar; empty
  // exclude (the current sub's own membership is irrelevant here). Now fires when
  // current lacks 5h OR weekly headroom (or is locked/errored/probe-missing).
  if (!currentUsage || !isSubscriptionEligible(currentUsage, EMPTY_EXCLUDE, 0.7)) {
    return true;
  }
  // Current sub still healthy → OPTIMIZATION, cooldown-gated + strictly-better only.
  if (
    !subscriptionRanksStrictlyBetter(
      params.target,
      currentUsage,
      params.targetIndex,
      params.currentIndex,
    )
  ) {
    return false;
  }
  return !withinSelectionCooldown(params.record);
}

// Read the last auto-selection switch time from the switch breadcrumbs (reason
// "selection") and test it against the cooldown. Absent / unparseable ⇒ not within
// cooldown (allow the switch).
function withinSelectionCooldown(record: SessionRecord): boolean {
  const options = record.acpx?.session_options;
  const candidates = [options?.subscription_switch, options?.account_switch].filter(
    (breadcrumb): breadcrumb is NonNullable<typeof breadcrumb> =>
      breadcrumb !== undefined && breadcrumb.reason === "selection",
  );
  let lastAt = Number.NEGATIVE_INFINITY;
  for (const breadcrumb of candidates) {
    const at = Date.parse(breadcrumb.at);
    if (!Number.isNaN(at) && at > lastAt) {
      lastAt = at;
    }
  }
  if (lastAt === Number.NEGATIVE_INFINITY) {
    return false;
  }
  return Date.now() - lastAt < subscriptionSelectCooldownMs();
}

// Pre-turn probe-gate for `--floor-hard` (brick://07dd62c9 §5b.a) — the
// "never-SUBMIT-when-knowably-down" half. Mirrors enforceSubscriptionLockBeforeTurn:
// runs before the prompt is submitted, and refuses UPFRONT (throwing a retryable
// ModelFloorUnmetError, no prompt sent) when the pinned model is knowably
// unservable. It is ADVISORY by construction (the fable-share probe flaps), so it
// only fires on POSITIVE evidence of clean exhaustion on EVERY subscription — any
// probe reading available OR unknown (a flap / probe error) proceeds and lets the
// post-serve check be the airtight backstop. A no-op outside --floor-hard, for a
// non-fable pin (no probe primitive exists), or with no registry. On a refusal
// the session is PARKED (durable breadcrumb) and auto-recovers on the next
// at-floor serve.
export async function enforceModelFloorBeforeTurn(
  record: SessionRecord,
  loadOpts?: SubscriptionLookupOptions,
): Promise<void> {
  if (!floorHardEnabled(record)) {
    return;
  }
  const pinnedModel = pinnedModelFloor(record);
  if (!pinnedModel || !isFableModel(pinnedModel)) {
    // The 1-token exhaustion probe exists only for the Fable share. A non-Fable
    // pin (opus/sonnet) has no pre-turn signal — the post-serve check catches it.
    return;
  }
  const entries = loadSubscriptionRegistry(loadOpts).subscriptions;
  if (entries.length === 0) {
    return;
  }
  // GATED read (brick://1badc6f1): the persisted snapshot's freshness contract —
  // 2h hard cap, invalidated by this account's own fable activity — is what keeps
  // a floor decision off a stale "available". This runs per TURN, so forcing here
  // would probe every 30s forever for no added truth.
  // getSubscriptionsFableState never rejects; a probe ERROR is UNKNOWN.
  const states = [...(await getSubscriptionsFableState(entries, "gated", loadOpts)).values()];
  const anyAvailable = states.some((state) => state.available);
  const anyUnknown = states.some((state) => state.error !== undefined);
  if (anyAvailable || anyUnknown) {
    return; // servable somewhere, or a flap/probe-miss — proceed; post-serve backstops.
  }
  // Clean 429 on every subscription: the pin is knowably unservable right now.
  setFloorParked(record, pinnedModel);
  await writeSessionRecord(record).catch(() => {});
  throw new ModelFloorUnmetError({
    pinnedModel,
    phase: "pre-turn",
    detail: "fable-share probed cleanly exhausted on all subscriptions",
  });
}

// Choose the terminal error class by the INITIAL trigger (the user's selected
// profile's failure — the actionable cause; sibling reasons are incidental). An
// auth-gated bridge → BridgeAuthGatedError (detailCode 'auth-gated' → acpx-ui's
// AuthGatedBanner, "log in"); everything else (quota/401) →
// AllSubscriptionsExhaustedError (detailCode 'all-subscriptions-exhausted' →
// ExhaustedBanner, "free up quota"). UNCHANGED for every non-auth-gated trigger.
function makeExhaustedError(
  initialTrigger: FailoverTrigger,
  statuses: string[],
  context: EffectiveAccountMetadata,
): AllSubscriptionsExhaustedError | BridgeAuthGatedError {
  const error =
    initialTrigger === "auth_gated"
      ? new BridgeAuthGatedError(statuses.join("; "))
      : new AllSubscriptionsExhaustedError(statuses.join("; "));
  attachEffectiveAccount(error, context);
  return error;
}

function enrichAccountSwitchBreadcrumb(
  record: SessionRecord,
  context: EffectiveAccountMetadata,
): void {
  const accountSwitch = record.acpx?.session_options?.account_switch;
  if (!accountSwitch) {
    return;
  }
  accountSwitch.effectiveAccount = context.effectiveAccount;
  if (context.effectiveProfile !== undefined) {
    accountSwitch.effectiveProfile = context.effectiveProfile;
  }
  if (context.effectiveAuthMode !== undefined) {
    accountSwitch.effectiveAuthMode = context.effectiveAuthMode;
  }
  if (context.effectiveAnchor !== undefined) {
    accountSwitch.effectiveAnchor = context.effectiveAnchor;
  }
  if (context.effectiveResolutionMethod !== undefined) {
    accountSwitch.effectiveResolutionMethod = context.effectiveResolutionMethod;
  }
}

async function requirePickedTarget(
  picked: PickedSibling,
  context: EffectiveAccountMetadata,
  restoreOriginalSelection: () => Promise<void>,
  initialTrigger: FailoverTrigger,
): Promise<ResolvedProfile> {
  if (picked.siblingCount === 0) {
    await restoreOriginalSelection();
    const health = await getAccountHealth(context.effectiveAccount);
    throw makeExhaustedError(
      initialTrigger,
      [noSiblingMessage(picked.source, context, health)],
      context,
    );
  }
  if (picked.portableCount === 0) {
    await restoreOriginalSelection();
    throw makeExhaustedError(
      initialTrigger,
      [noPortableSiblingMessage(picked.source, context)],
      context,
    );
  }
  if (!picked.target) {
    await restoreOriginalSelection();
    throw makeExhaustedError(initialTrigger, picked.statuses, context);
  }
  return picked.target;
}

async function switchToFailoverTarget(params: {
  record: SessionRecord;
  target: ResolvedProfile;
  context: EffectiveAccountMetadata;
  loadOpts?: SubscriptionLookupOptions;
}): Promise<void> {
  if (storedSelectionId(params.record) === params.target.id) {
    // Split-brain recovery: the record already names the target, but the live
    // owner failed on a different effective account. Keep the selected target and
    // let the caller's fresh-client retry bind to it.
    const sessionOptions = params.record.acpx?.session_options;
    if (sessionOptions) {
      sessionOptions.profile = params.target.id;
      delete sessionOptions.subscription;
      delete sessionOptions.subscription_switch;
    }
    enrichAccountSwitchBreadcrumb(params.record, params.context);
    await writeSessionRecord(params.record);
    return;
  }
  try {
    await switchSessionAccount(params.record, params.target.id, "failover", params.loadOpts);
  } catch (error) {
    throw attachEffectiveAccount(
      error instanceof Error ? error : new Error(formatErrorMessage(error)),
      params.context,
    );
  }
  enrichAccountSwitchBreadcrumb(params.record, params.context);
  await writeSessionRecord(params.record);
}

export type FailoverRetryResult<T> = {
  /** Whatever the retried turn returned (on success). */
  result: T;
  /** The profile/account the turn ultimately succeeded on. */
  switchedTo: string;
};

/**
 * On a failover-classified turn error, switch the session to a usable
 * subscription (most headroom) and re-run the turn via `runTurn`, which MUST
 * build a fresh client from the (now-updated) record so it resolves the new
 * CLAUDE_CONFIG_DIR and resumes the ported transcript. Bounded by the number of
 * registered subs (each tried at most once). No usable target →
 * AllSubscriptionsExhaustedError (record left unchanged so a later turn
 * re-probes). A non-failover throw from a retry propagates unchanged.
 */
export async function attemptFailoverAndRetry<T>(args: {
  record: SessionRecord;
  runTurn: () => Promise<T>;
  triggerError?: unknown;
  loadOpts?: SubscriptionLookupOptions;
  verbose?: boolean;
}): Promise<FailoverRetryResult<T>> {
  const current = currentProfile(args.record, args.loadOpts);
  if (!current) {
    throw new AllSubscriptionsExhaustedError("failover unavailable - no selected profile");
  }
  const initialContext = failureContext(args.triggerError, current);
  let lastFailureContext = initialContext;
  const restoreOriginalSelection = snapshotSelectionRestorer(args.record);

  // Seed the tried set with the account that physically failed so we never
  // re-pick it this turn.
  const tried = new Set<string>();
  tried.add(initialContext.effectiveAccount);
  const initialTrigger = classifyFailover(args.triggerError);

  // Fable-share short-circuit: a Fable session hitting rate_limit must never
  // thrash every sub. Probe fable and either throw the distinct terminal now (all
  // exhausted) or seed `tried` so only fable-available subs are tried (§3b).
  const fable = await prepareFableShortCircuit({
    record: args.record,
    initialTrigger,
    tried,
    restoreOriginalSelection,
    loadOpts: args.loadOpts,
  });

  // Non-quota triggers (auth-gated / 401) have no legitimate reset window, so the
  // bounded TTL takes precedence: it both prevents the process-lifetime sentinel
  // AND avoids resetIsoFromError misreading an incidental numeric field (e.g. the
  // adapter's -32000 health code) as a bogus epoch reset. Quota triggers
  // (rate_limit / billing) yield `undefined` here and fall through to the genuine
  // reset timestamp (or today's sentinel when absent) — byte-identical to before.
  await markAccountDead(
    initialContext.effectiveAccount,
    "failover trigger",
    nonQuotaDeadUntil(initialTrigger) ?? resetIsoFromError(args.triggerError),
  );

  try {
    for (let attempt = 0; ; attempt++) {
      const picked = await pickSibling(current, lastFailureContext, tried, args.loadOpts);
      const target = await requirePickedTarget(
        picked,
        lastFailureContext,
        restoreOriginalSelection,
        initialTrigger,
      );
      await switchToFailoverTarget({
        record: args.record,
        target,
        context: lastFailureContext,
        loadOpts: args.loadOpts,
      });
      tried.add(target.account);

      if (args.verbose) {
        process.stderr.write(
          `[acpx] account failover → profile "${target.id}" (failed account: ${lastFailureContext.effectiveAccount}); retrying turn\n`,
        );
      }

      try {
        const result = await args.runTurn();
        return { result, switchedTo: target.id };
      } catch (retryError) {
        const trigger = classifyFailover(retryError);
        if (!trigger) {
          const effectiveRetryError = attachEffectiveAccount(
            retryError,
            failureContext(retryError, target),
          );
          await restoreOriginalSelection();
          throw effectiveRetryError;
        }
        // The retried turn failed too. Charge the physically effective account
        // when the runtime stamped one; fall back to the selected target only for
        // direct unit harnesses that do not spawn an adapter.
        lastFailureContext = failureContext(retryError, target);
        tried.add(lastFailureContext.effectiveAccount);
        await markAccountDead(
          lastFailureContext.effectiveAccount,
          `failover retry ${trigger}`,
          nonQuotaDeadUntil(trigger),
        );
      }
    }
  } catch (loopError) {
    return await convertFableTerminal(loopError, fable, args.loadOpts);
  }
}
