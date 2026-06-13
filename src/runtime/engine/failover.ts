import type { EffectiveAccountMetadata } from "../../acp/auth-env.js";
import {
  effectiveAccountMetadataFromValue,
  formatErrorMessage,
} from "../../acp/error-normalization.js";
import { extractAcpError } from "../../acp/error-shapes.js";
import { findProfile, loadProfileRegistry } from "../../config/profiles.js";
import {
  getSubscriptionsUsage,
  maxUtilization,
  pickFailoverTarget,
  type SubscriptionUsage,
} from "../../config/subscription-usage.js";
import {
  loadSubscriptionRegistry,
  type SubscriptionEntry,
  type SubscriptionLookupOptions,
} from "../../config/subscriptions.js";
import { AllSubscriptionsExhaustedError } from "../../errors.js";
import { writeSessionRecord } from "../../session/persistence/repository.js";
import type { SessionRecord } from "../../types.js";
import {
  getAccountHealth,
  markAccountDead,
  siblingProfiles,
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

export type FailoverTrigger = "rate_limit" | "auth_failed" | "billing" | null;

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
    ["rate limit", "quota exceeded", "usage limit"].some((text) => lower.includes(text))
  );
}

function errorMessageText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

function classifyFromAcp(acp: ReturnType<typeof extractAcpError>): FailoverTrigger {
  // 1. Machine-readable errorKind (preferred).
  const kind = errorKindFromData(acp?.data);
  const byKind = kind !== undefined ? classifyErrorKind(kind) : null;
  if (byKind) {
    return byKind;
  }
  // 2. Auth-required ACP code (401 / login path) → dead sub.
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
  return resetIsoFromValue(extractAcpError(error)?.data) ?? resetIsoFromValue(error);
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
  const time = Date.parse(trimmed);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
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
  const profile = currentProfile(record, loadOpts);
  return profile !== undefined && transcriptAnchorDir(profile) !== null;
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

async function pickSibling(
  current: ResolvedProfile,
  triedAccounts: ReadonlySet<string>,
  loadOpts?: SubscriptionLookupOptions,
): Promise<{
  target?: ResolvedProfile;
  statuses: string[];
  siblingCount: number;
  portableCount: number;
}> {
  const siblings = await siblingProfiles(current.id, loadOpts);
  const currentAnchor = transcriptAnchorDir(current);
  const portable =
    currentAnchor === null
      ? []
      : siblings.filter((profile) => transcriptAnchorDir(profile) !== null);
  const baseStatuses = await candidateStatuses(portable, triedAccounts);
  const picked =
    current.authMode === "subscription"
      ? await pickSubscriptionSibling(baseStatuses, loadOpts)
      : { target: baseStatuses.find(accountHealthy)?.profile, statuses: baseStatuses };
  return {
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

function exhaustedError(
  statuses: string[],
  context: EffectiveAccountMetadata,
): AllSubscriptionsExhaustedError {
  const error = new AllSubscriptionsExhaustedError(statuses.join("; "));
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
  current: ResolvedProfile,
  context: EffectiveAccountMetadata,
  restoreOriginalSelection: () => Promise<void>,
): Promise<ResolvedProfile> {
  if (picked.siblingCount === 0) {
    await restoreOriginalSelection();
    const health = await getAccountHealth(context.effectiveAccount);
    throw exhaustedError([noSiblingMessage(current, context, health)], context);
  }
  if (picked.portableCount === 0) {
    await restoreOriginalSelection();
    throw exhaustedError([noPortableSiblingMessage(current, context)], context);
  }
  if (!picked.target) {
    await restoreOriginalSelection();
    throw exhaustedError(picked.statuses, context);
  }
  return picked.target;
}

async function switchToFailoverTarget(params: {
  record: SessionRecord;
  target: ResolvedProfile;
  context: EffectiveAccountMetadata;
  loadOpts?: SubscriptionLookupOptions;
}): Promise<void> {
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
  await markAccountDead(
    initialContext.effectiveAccount,
    "failover trigger",
    resetIsoFromError(args.triggerError),
  );

  for (let attempt = 0; ; attempt++) {
    const picked = await pickSibling(current, tried, args.loadOpts);
    const target = await requirePickedTarget(
      picked,
      current,
      lastFailureContext,
      restoreOriginalSelection,
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
        throw attachEffectiveAccount(retryError, failureContext(retryError, target));
      }
      // The retried turn failed too. Charge the physically effective account
      // when the runtime stamped one; fall back to the selected target only for
      // direct unit harnesses that do not spawn an adapter.
      lastFailureContext = failureContext(retryError, target);
      tried.add(lastFailureContext.effectiveAccount);
      await markAccountDead(lastFailureContext.effectiveAccount, `failover retry ${trigger}`);
    }
  }
}
