// Process-local, in-memory set of subscriptions that failed over (401/maxed) in
// THIS process (CONCEPTION §4.1.4). Best-effort PRE-SPAWN avoidance: a spawn
// whose resolved sub is in this set can substitute a healthy one to avoid
// re-failing the first turn. It is intentionally:
//   - NOT durable — a restart re-probes fresh (the durable signal is the
//     persisted session_options.subscription, which failover updates);
//   - NOT a probe-on-every-spawn — a plain Set lookup, no network/IO cost;
//   - opt-in — only populated by an actual failover, so a no-registry box never
//     touches it and resolution stays byte-identical (backward safety A5).
// Standalone (no other acpx deps) so the low-level auth-env resolution point and
// the failover engine can both use it without a layering cycle.

const knownDeadSubs = new Set<string>();

/** Mark a subscription dead/maxed for the rest of this process's lifetime. */
export function markSubscriptionDead(id: string): void {
  const trimmed = id.trim();
  if (trimmed) {
    knownDeadSubs.add(trimmed);
  }
}

/** True if `id` was marked dead by a failover earlier in this process. */
export function isSubscriptionKnownDead(id: string): boolean {
  return knownDeadSubs.has(id.trim());
}

/** True if any subscription is known dead (cheap guard before a registry walk). */
export function hasKnownDeadSubs(): boolean {
  return knownDeadSubs.size > 0;
}

/** Test-only: clear the in-mem known-dead set between cases. */
export function resetKnownDeadSubs(): void {
  knownDeadSubs.clear();
}
