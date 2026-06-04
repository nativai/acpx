import { extractAcpError } from "../../acp/error-shapes.js";
import { markSubscriptionDead } from "../../config/known-dead-subscriptions.js";
import {
  getSubscriptionsUsage,
  maxUtilization,
  pickFailoverTarget,
  type SubscriptionUsage,
} from "../../config/subscription-usage.js";
import {
  loadSubscriptionRegistry,
  type SubscriptionLookupOptions,
} from "../../config/subscriptions.js";
import { AllSubscriptionsExhaustedError } from "../../errors.js";
import { writeSessionRecord } from "../../session/persistence/repository.js";
import type { SessionRecord } from "../../types.js";
import { switchSessionSubscription } from "./subscription-switch.js";

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
 * Failover only engages on a box with a usable registry — i.e. ≥1 registered
 * subscription. On a no-registry box this is false and resolution stays
 * byte-identical to today (backward safety A5).
 */
export function failoverEnabled(loadOpts?: SubscriptionLookupOptions): boolean {
  return loadSubscriptionRegistry(loadOpts).subscriptions.length > 0;
}

function describeUsage(usage: SubscriptionUsage): string {
  if (usage.error) {
    return `${usage.id}: ${usage.error}`;
  }
  return `${usage.id}: ${Math.round(maxUtilization(usage) * 100)}% used`;
}

/** The current subscription a record resolves to (explicit selection, if any). */
function currentSubId(record: SessionRecord): string | undefined {
  return record.acpx?.session_options?.subscription?.trim() || undefined;
}

/**
 * Snapshot the record's current subscription selection + breadcrumb and return a
 * restore-and-persist function. Used so exhaustion leaves the record UNCHANGED
 * (A3 / edge-1): after some failover attempts mutated it, restore the original
 * so a later turn re-probes and auto-recovers.
 */
function snapshotSelectionRestorer(record: SessionRecord): () => Promise<void> {
  const originalSelection = record.acpx?.session_options?.subscription;
  const originalSwitch = record.acpx?.session_options?.subscription_switch;
  return async () => {
    const sessionOptions = record.acpx?.session_options;
    if (!sessionOptions) {
      return;
    }
    if (originalSelection === undefined) {
      delete sessionOptions.subscription;
    } else {
      sessionOptions.subscription = originalSelection;
    }
    if (originalSwitch === undefined) {
      delete sessionOptions.subscription_switch;
    } else {
      sessionOptions.subscription_switch = originalSwitch;
    }
    await writeSessionRecord(record);
  };
}

export type FailoverRetryResult<T> = {
  /** Whatever the retried turn returned (on success). */
  result: T;
  /** The subscription the turn ultimately succeeded on. */
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
  loadOpts?: SubscriptionLookupOptions;
  verbose?: boolean;
}): Promise<FailoverRetryResult<T>> {
  const registry = loadSubscriptionRegistry(args.loadOpts);
  const entries = registry.subscriptions;
  const restoreOriginalSelection = snapshotSelectionRestorer(args.record);

  // Seed the tried set with the failed sub so we never re-pick it this turn.
  const tried = new Set<string>();
  const failed = currentSubId(args.record);
  if (failed) {
    tried.add(failed);
    markSubscriptionDead(failed); // §4.1.4 pre-spawn avoidance (process-local)
  }

  // Force-refresh on the first failover so target selection does not act on a
  // stale "everything's fine" reading (CONCEPTION §4.1.2).
  let usages = await getSubscriptionsUsage(entries, true);

  for (let attempt = 0; attempt < entries.length; attempt++) {
    const target = pickFailoverTarget(usages, { exclude: tried });
    if (!target) {
      await restoreOriginalSelection();
      throw new AllSubscriptionsExhaustedError(usages.map(describeUsage).join("; "));
    }

    await switchSessionSubscription({
      record: args.record,
      targetSubId: target.id,
      reason: "failover",
      loadOpts: args.loadOpts,
    });
    await writeSessionRecord(args.record);
    tried.add(target.id);

    if (args.verbose) {
      process.stderr.write(
        `[acpx] subscription failover → "${target.id}" (failed: ${failed ?? "default"}); retrying turn\n`,
      );
    }

    try {
      const result = await args.runTurn();
      return { result, switchedTo: target.id };
    } catch (retryError) {
      const trigger = classifyFailover(retryError);
      if (!trigger) {
        throw retryError;
      }
      // The new target also failed over — mark it dead, drop it, refresh, loop.
      markSubscriptionDead(target.id);
      usages = await getSubscriptionsUsage(entries, true);
    }
  }

  await restoreOriginalSelection();
  throw new AllSubscriptionsExhaustedError(usages.map(describeUsage).join("; "));
}
