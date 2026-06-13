import {
  findSubscription,
  loadSubscriptionRegistry,
  type SubscriptionLookupOptions,
} from "./subscriptions.js";

export interface AccountHealth {
  deadUntil?: string;
  utilization?: number;
  resetsAt?: string;
}

// Process-local, in-memory set of subscriptions/accounts that failed over
// (401/maxed) in THIS process. Best-effort PRE-SPAWN avoidance: a spawn whose
// resolved account is in this set can substitute a healthy one to avoid
// re-failing the first turn. It is intentionally:
//   - NOT durable — a restart re-probes fresh (the durable signal is the
//     persisted session_options.subscription, which failover updates);
//   - NOT a probe-on-every-spawn — a plain Set lookup, no network/IO cost;
//   - opt-in — only populated by an actual failover, so a no-registry box never
//     touches it and resolution stays byte-identical (backward safety A5).
// Standalone (no other acpx deps) so the low-level auth-env resolution point and
// the failover engine can both use it without a layering cycle.

const knownDeadSubs = new Set<string>();
const accountHealth = new Map<string, AccountHealth>();

function farFutureIso(): string {
  return "9999-12-31T23:59:59.999Z";
}

function trimId(value: string): string {
  return value.trim();
}

function markAccountDeadSync(account: string, until?: string): void {
  const trimmed = trimId(account);
  if (!trimmed) {
    return;
  }
  const resetAt = until?.trim();
  accountHealth.set(trimmed, {
    ...accountHealth.get(trimmed),
    deadUntil: resetAt || farFutureIso(),
    ...(resetAt ? { resetsAt: resetAt } : {}),
  });
}

/** Mark an account dead/maxed for the rest of this process's lifetime or until `until`. */
export async function markAccountDead(
  account: string,
  _reason: string,
  until?: string,
): Promise<void> {
  markAccountDeadSync(account, until);
}

/** Return the process-local health snapshot for an account. */
export async function getAccountHealth(account: string): Promise<AccountHealth> {
  const health = accountHealth.get(trimId(account));
  return health ? { ...health } : {};
}

/** True if `account` was marked dead by a failover earlier in this process. */
export function isAccountKnownDead(account: string): boolean {
  return accountHealth.has(trimId(account));
}

/** True if any account is known dead (cheap guard before a registry walk). */
export function hasKnownDeadAccounts(): boolean {
  return accountHealth.size > 0;
}

function accountForSubscription(id: string, options?: SubscriptionLookupOptions): string {
  return findSubscription(id, loadSubscriptionRegistry(options))?.account ?? id;
}

/**
 * Deprecated compatibility alias. Marks the legacy subscription id and forwards
 * to account health using the registry's account seam when it can be resolved.
 */
export function markSubscriptionDead(
  id: string,
  _reason = "subscription failure",
  until?: string,
  options?: SubscriptionLookupOptions,
): void {
  const trimmed = trimId(id);
  if (trimmed) {
    knownDeadSubs.add(trimmed);
    markAccountDeadSync(accountForSubscription(trimmed, options), until);
  }
}

/** True if `id` was marked dead by a failover earlier in this process. */
export function isSubscriptionKnownDead(id: string): boolean {
  return knownDeadSubs.has(trimId(id));
}

/** True if any subscription is known dead (cheap guard before a registry walk). */
export function hasKnownDeadSubs(): boolean {
  return knownDeadSubs.size > 0;
}

/** Test-only: clear the in-mem known-dead set between cases. */
export function resetKnownDeadSubs(): void {
  knownDeadSubs.clear();
  accountHealth.clear();
}
