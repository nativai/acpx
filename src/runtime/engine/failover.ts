import type { EffectiveAccountMetadata } from "../../acp/auth-env.js";
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
  getSubscriptionsFableState,
  getSubscriptionsUsage,
  isFableModel,
  maxUtilization,
  pickFailoverTarget,
  type SubscriptionFableState,
  type SubscriptionUsage,
} from "../../config/subscription-usage.js";
import {
  loadSubscriptionRegistry,
  type SubscriptionEntry,
  type SubscriptionLookupOptions,
} from "../../config/subscriptions.js";
import {
  AllSubscriptionsExhaustedError,
  AllSubscriptionsLockedError,
  BridgeAuthGatedError,
  FableShareExhaustedError,
  SubscriptionLockedError,
} from "../../errors.js";
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

// A human status line per sub for the FableShareExhaustedError message, in the
// describeUsage style.
function fableStatuses(
  entries: SubscriptionEntry[],
  fable: Map<string, SubscriptionFableState>,
): string {
  return entries
    .map((entry) => {
      const state = fable.get(entry.id);
      if (!state) {
        return `${entry.label} (${entry.id}): fable not probed`;
      }
      if (state.error) {
        return `${entry.label} (${entry.id}): fable ? (${state.error})`;
      }
      return `${entry.label} (${entry.id}): fable ${state.available ? "available" : "exhausted"}`;
    })
    .join("; ");
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
async function fableRateLimitShortCircuit(params: {
  tried: Set<string>;
  restoreOriginalSelection: () => Promise<void>;
  loadOpts?: SubscriptionLookupOptions;
}): Promise<string> {
  const entries = loadSubscriptionRegistry(params.loadOpts).subscriptions;
  const fable = await getSubscriptionsFableState(entries, true);
  const statusSnapshot = fableStatuses(entries, fable);
  const anyAvailable = entries.some((entry) => fable.get(entry.id)?.available === true);
  if (!anyAvailable) {
    await params.restoreOriginalSelection();
    throw new FableShareExhaustedError(statusSnapshot);
  }
  for (const entry of entries) {
    const state = fable.get(entry.id);
    if (state?.available === false && state.error === undefined) {
      const account = accountForEntry(entry, params.loadOpts);
      if (account) {
        params.tried.add(account);
      }
    }
  }
  return statusSnapshot;
}

// Boundary conversion (§3b): when the fable-available subset ALSO exhausts
// mid-loop, the loop throws AllSubscriptionsExhaustedError — the WRONG class for a
// Fable session. Re-throw it as FableShareExhaustedError, carrying over the
// effective-account metadata the exhausted error already attached. Every non-Fable
// path and every other error class propagates byte-identically.
function convertFableTerminal(
  loopError: unknown,
  fable: { isFableRateLimit: boolean; statusSnapshot?: string },
): never {
  if (fable.isFableRateLimit && loopError instanceof AllSubscriptionsExhaustedError) {
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
  const statusSnapshot = await fableRateLimitShortCircuit({
    tried: params.tried,
    restoreOriginalSelection: params.restoreOriginalSelection,
    loadOpts: params.loadOpts,
  });
  return { isFableRateLimit: true, statusSnapshot };
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

function selectedProfileId(
  record: SessionRecord,
  loadOpts?: SubscriptionLookupOptions,
): string | undefined {
  return storedSelectionId(record) ?? defaultProfileId(loadOpts);
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
    if (originalOptions === undefined) {
      delete record.acpx.session_options;
    } else {
      record.acpx.session_options = cloneSessionOptions(originalOptions);
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
    return convertFableTerminal(loopError, fable);
  }
}
