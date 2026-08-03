import { isClaudeAcpCommand, isClaudePtyAgentCommand } from "../../acp/agent-command.js";
import { splitCommandLine } from "../../acp/client-process.js";
import { isCodexAcpCommand } from "../../acp/codex-compat.js";
import {
  countEligibleFailoverTargets,
  getSubscriptionsFableState,
  getSubscriptionsUsage,
  isFableModel,
  maxedThreshold,
  pickFailoverTarget,
  type SubscriptionFableState,
  type SubscriptionUsage,
} from "../../config/subscription-usage.js";
import {
  isSubscriptionLocked,
  loadSubscriptionRegistry,
  type SubscriptionLookupOptions,
  type SubscriptionRegistry,
} from "../../config/subscriptions.js";

// Built-in automatic subscription selection (brick 523b6449). A spawn that opts
// in with `--subscription auto` gets the best-available, unlocked subscription
// picked here — reusing the SAME optimal selector the turn-failover path uses
// (pickFailoverTarget) — resolved ONCE at session creation and snapshotted as a
// concrete id. Every branch degrades to the existing default binding rather than
// blocking a spawn; the whole thing is bounded by a hard timeout.

/** The sentinel `--subscription` value that requests automatic selection. */
export const AUTO_SUBSCRIPTION_SENTINEL = "auto";

/** True when `value` is the `auto` sentinel (trimmed, case-insensitive). */
export function isAutoSubscriptionSentinel(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === AUTO_SUBSCRIPTION_SENTINEL;
}

const DEFAULT_AUTO_TIMEOUT_MS = 2500;
// A Fable spawn inherently adds a second (fable) probe, so give it a modestly
// wider default budget so the completed probe lands inside the window and the
// spawn signal is 'all-fable-exhausted', not a generic 'timeout'. Belt to the
// budget-INDEPENDENT fallback below (a completed fable probe is surfaced even if
// the outer deadline passes).
const DEFAULT_FABLE_AUTO_TIMEOUT_MS = 4000;
// Bounded grace to let an in-flight fable probe LAND after the outer deadline
// fired — a completed fable verdict is authoritative and the pick has already
// fallen back to default (so the spawn is not blocked on a real decision). Only
// ever incurred on a rare cold-probe spike past the budget; caps the extra wait.
const FABLE_PROBE_GRACE_MS = 2500;

/**
 * Hard budget for the whole `auto` resolution (usage probe + cross-HOME check).
 * On expiry the pick is treated as "no result" → default fallback, so `auto`
 * never adds more than this to a spawn. Env-tunable via
 * ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS (positive milliseconds); when unset, a Fable
 * spawn uses the wider fable default.
 */
function autoTimeoutMs(isFable: boolean): number {
  const raw = process.env.ACPX_SUBSCRIPTION_AUTO_TIMEOUT_MS?.trim();
  const fallback = isFable ? DEFAULT_FABLE_AUTO_TIMEOUT_MS : DEFAULT_AUTO_TIMEOUT_MS;
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

// Only the SDK claude adapter has per-subscription CLAUDE_CONFIG_DIRs. Mirror
// default-account-binding's `adapterForAgentCommand(...) === "claude"` guard
// (codex / gemini / claude-pty all fall through as a no-op). Re-derived here
// rather than imported to avoid a cycle with default-account-binding.
function isClaudeAdapterCommand(agentCommand: string): boolean {
  if (isClaudePtyAgentCommand(agentCommand)) {
    return false;
  }
  const split = splitCommandLine(agentCommand);
  if (isCodexAcpCommand(split.command, split.args)) {
    return false;
  }
  return isClaudeAcpCommand(split.command, split.args);
}

/** Machine-readable summary of one `auto` resolution, surfaced under `--format json`. */
export type AutoSubscriptionSelectionSummary = {
  mode: "auto";
  /** The concrete id picked, or null when we fell back to the default. */
  picked: string | null;
  /** Why this outcome: `soonest-7d-reset` on a pick, else the fallback reason. */
  reason: string;
  candidatesConsidered: number;
  eligible: number;
  fellBack: boolean;
  /** Present only when the optional cross-HOME acpx-ui lock view diverged. */
  divergedFromUi?: true;
  /** Present only when this was a Fable spawn (the fable probe ran). */
  fable?: FableTally;
};

/** A small Fable-availability tally, surfaced when a Fable spawn is resolved. */
type FableTally = { available: number; exhausted: number; probed: boolean };

type LocalSelection = {
  /** The picked subscription id, or undefined when we fell back to the default. */
  pickedId?: string;
  picked?: SubscriptionUsage;
  reason: string;
  candidatesConsidered: number;
  eligible: number;
  /** Present only when this was a Fable spawn (the fable probe ran). */
  fable?: FableTally;
};

type Divergence = { origin: string };

// A single most-recent selection summary, written when `auto` resolves and
// read-and-cleared by the JSON session-create printer. A CLI `new`/`copy`
// invocation creates exactly one session then prints, so writer and reader are
// sequential in one process; a long-lived queue-owner has no reader and simply
// overwrites it each spawn (harmless).
let lastSelection: AutoSubscriptionSelectionSummary | undefined;

function captureAutoSelection(summary: AutoSubscriptionSelectionSummary): void {
  lastSelection = summary;
}

/** Read and clear the most recent `auto` selection summary (for `--format json`). */
export function consumeAutoSubscriptionSelection(): AutoSubscriptionSelectionSummary | undefined {
  const value = lastSelection;
  lastSelection = undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function noEligibleReason(
  usages: SubscriptionUsage[],
  exclude: ReadonlySet<string>,
  threshold: number,
): string {
  if (usages.every((usage) => exclude.has(usage.id) || usage.locked === true)) {
    return "all-locked";
  }
  if (usages.every((usage) => usage.error !== undefined)) {
    return "all-probe-error";
  }
  if (usages.some((usage) => usage.fiveHour !== null && usage.fiveHour.utilization >= threshold)) {
    return "all-5h-maxed";
  }
  return "no-eligible-subscription";
}

// Pure-local pick: probe usages, exclude account-locked subs (DIR-2 — honor
// account-propagated locks, not just the direct flag), then reuse the shared
// pickFailoverTarget selector. Returns a binding on success, or the fallback
// reason so the caller can log/degrade. Never throws; getSubscriptionsUsage
// never rejects.
// Pure tally over probed fable states: available (200), exhausted (clean 429). A
// probe ERROR is UNKNOWN — counted as neither.
function computeFableTally(
  entries: SubscriptionRegistry["subscriptions"],
  states: Map<string, SubscriptionFableState>,
): FableTally {
  let available = 0;
  let exhausted = 0;
  for (const entry of entries) {
    const state = states.get(entry.id);
    if (state?.available === true) {
      available += 1;
    } else if (state?.available === false && state.error === undefined) {
      exhausted += 1;
    }
  }
  return { available, exhausted, probed: true };
}

// From already-probed fable states, add cleanly-429 subs to `exclude` (mutated in
// place) and return the tally. Sync so the fable probe can run CONCURRENTLY with
// the usage probe in selectLocal.
function applyFableExclusions(
  entries: SubscriptionRegistry["subscriptions"],
  exclude: Set<string>,
  states: Map<string, SubscriptionFableState>,
): FableTally {
  for (const entry of entries) {
    const state = states.get(entry.id);
    if (state?.available === false && state.error === undefined) {
      exclude.add(entry.id);
    }
  }
  return computeFableTally(entries, states);
}

// Budget-independent fallback: when the outer auto-select deadline fired but the
// fable probe had already COMPLETED and every sub is cleanly exhausted, surface
// 'all-fable-exhausted' + tally rather than discarding it as a generic 'timeout'.
// Returns undefined when the probe didn't finish or some sub is still available
// (then the pick truly could not be resolved → honest 'timeout').
function fableTimeoutFallback(
  registry: SubscriptionRegistry,
  states: Map<string, SubscriptionFableState> | undefined,
): LocalSelection | undefined {
  if (!states) {
    return undefined;
  }
  const fable = computeFableTally(registry.subscriptions, states);
  if (fable.available === 0 && fable.exhausted > 0) {
    return {
      reason: "all-fable-exhausted",
      candidatesConsidered: registry.subscriptions.length,
      eligible: 0,
      fable,
    };
  }
  return undefined;
}

// When nothing survived: a distinct reason if it was fleet-wide Fable exhaustion,
// else the generic no-eligible reason. Checked before the generic (§3a).
function fallbackReason(
  usages: SubscriptionUsage[],
  exclude: ReadonlySet<string>,
  threshold: number,
  fable: FableTally | undefined,
): string {
  if (fable && fable.available === 0 && fable.exhausted > 0) {
    return "all-fable-exhausted";
  }
  return noEligibleReason(usages, exclude, threshold);
}

async function selectLocal(
  registry: SubscriptionRegistry,
  fableProbe: Promise<Map<string, SubscriptionFableState> | undefined>,
): Promise<LocalSelection> {
  const entries = registry.subscriptions;
  if (entries.length === 0) {
    return { reason: "empty-registry", candidatesConsidered: 0, eligible: 0 };
  }
  // Probe usage AND fable CONCURRENTLY so cold latency is max(), not sum() — the
  // sequential form blew the auto-select budget and degraded the signal to a
  // generic 'timeout' instead of the designed 'all-fable-exhausted' + tally. The
  // fable probe is owned by the caller (a shared promise) so a COMPLETED result
  // survives an outer-deadline timeout (budget-independent fallback). A probe ERROR
  // means UNKNOWN — do NOT exclude (§1). Spawn NEVER hard-fails on fable exhaustion;
  // it degrades to the default binding and the turn-level terminal error tells the
  // agent (§4).
  const [usages, fableStates] = await Promise.all([getSubscriptionsUsage(entries), fableProbe]);
  const threshold = maxedThreshold();
  const exclude = new Set(
    entries.filter((entry) => isSubscriptionLocked(entry, registry)).map((entry) => entry.id),
  );
  const fable = fableStates ? applyFableExclusions(entries, exclude, fableStates) : undefined;
  const eligible = countEligibleFailoverTargets(usages, { exclude, threshold });
  const picked = pickFailoverTarget(usages, { exclude, threshold });
  if (!picked) {
    return {
      reason: fallbackReason(usages, exclude, threshold, fable),
      candidatesConsidered: usages.length,
      eligible,
      ...(fable ? { fable } : {}),
    };
  }
  return {
    pickedId: picked.id,
    picked,
    reason: "soonest-7d-reset",
    candidatesConsidered: usages.length,
    eligible,
    ...(fable ? { fable } : {}),
  };
}

// The array of usage entries inside an acpx-ui /api/subscriptions/usage body,
// accepting a bare array or a {subscriptions}/{usage} wrapper. Undefined for
// anything else so the diagnostic is skipped.
function usageListFromBody(body: unknown): unknown[] | undefined {
  if (Array.isArray(body)) {
    return body as unknown[];
  }
  if (!isRecord(body)) {
    return undefined;
  }
  if (Array.isArray(body.subscriptions)) {
    return body.subscriptions as unknown[];
  }
  if (Array.isArray(body.usage)) {
    return body.usage as unknown[];
  }
  return undefined;
}

// Extract the set of subscription ids acpx-ui reports as directly locked.
// Returns undefined on a malformed body so the diagnostic is silently skipped.
function extractRemoteLockedIds(body: unknown): Set<string> | undefined {
  const list = usageListFromBody(body);
  if (!list) {
    return undefined;
  }
  const locked = new Set<string>();
  for (const item of list) {
    if (isRecord(item) && typeof item.id === "string" && item.id.trim() && item.locked === true) {
      locked.add(item.id.trim());
    }
  }
  return locked;
}

function lockedSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false;
    }
  }
  return true;
}

// Optional cross-HOME equivalence check (§5, DIR-3): derive the governing
// acpx-ui origin from ACPX_SESSION_URL and compare its {id → locked} view
// against the local registry's DIRECT lock flags (like-for-like — acpx-ui
// reports the raw flag, not account propagation). Best-effort and a pure
// DIAGNOSTIC: it NEVER affects the pick, never blocks, and is silently skipped
// on any failure (absent env, bad url, timeout, non-200, malformed body).
async function crossHomeDivergence(
  registry: SubscriptionRegistry,
  timeoutMs: number,
): Promise<Divergence | undefined> {
  const sessionUrl = process.env.ACPX_SESSION_URL?.trim();
  if (!sessionUrl) {
    return undefined;
  }
  let origin: string;
  try {
    origin = new URL(sessionUrl).origin;
  } catch {
    return undefined;
  }
  try {
    const res = await fetch(`${origin}/api/subscriptions/usage`, {
      headers: { "User-Agent": "acpx/subscription-auto" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return undefined;
    }
    const remoteLocked = extractRemoteLockedIds(await res.json());
    if (!remoteLocked) {
      return undefined;
    }
    const localLocked = new Set(
      registry.subscriptions.filter((entry) => entry.locked === true).map((entry) => entry.id),
    );
    return lockedSetsEqual(remoteLocked, localLocked) ? undefined : { origin };
  } catch {
    return undefined;
  }
}

const DEADLINE = Symbol("acpx-auto-subscription-deadline");

function deadline(ms: number): {
  signal: Promise<typeof DEADLINE>;
  cancel: () => void;
} {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const signal = new Promise<typeof DEADLINE>((resolve) => {
    handle = setTimeout(() => resolve(DEADLINE), ms);
  });
  return {
    signal,
    cancel: () => {
      if (handle) {
        clearTimeout(handle);
      }
    },
  };
}

// Race `work` against a SHARED deadline so the local pick and the cross-HOME
// check together never exceed the one budget. A lost race yields undefined; the
// abandoned promise still settles on its own (both branches never reject).
async function raceDeadline<T>(
  work: Promise<T>,
  signal: Promise<typeof DEADLINE>,
): Promise<T | undefined> {
  const result = await Promise.race([work, signal]);
  return result === DEADLINE ? undefined : (result as T);
}

function summarize(
  selection: LocalSelection | undefined,
  divergence: Divergence | undefined,
): AutoSubscriptionSelectionSummary {
  const diverged = divergence ? ({ divergedFromUi: true } as const) : {};
  if (!selection) {
    return {
      mode: "auto",
      picked: null,
      reason: "timeout",
      candidatesConsidered: 0,
      eligible: 0,
      fellBack: true,
      ...diverged,
    };
  }
  return {
    mode: "auto",
    picked: selection.pickedId ?? null,
    reason: selection.reason,
    candidatesConsidered: selection.candidatesConsidered,
    eligible: selection.eligible,
    fellBack: selection.pickedId === undefined,
    ...diverged,
    ...(selection.fable ? { fable: selection.fable } : {}),
  };
}

function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined) {
    return "n/a";
  }
  return `${Math.round(fraction * 100)}%`;
}

function fableSuffix(fable: FableTally | undefined): string {
  return fable ? `; fable ${fable.available}/${fable.available + fable.exhausted} available` : "";
}

function autoPickLine(picked: SubscriptionUsage, eligible: number, fable?: FableTally): string {
  return (
    `[acpx] subscription auto → "${picked.label}" (${picked.id}) — ` +
    `7d ${formatPercent(picked.sevenDay?.utilization)}, ` +
    `5h ${formatPercent(picked.fiveHour?.utilization)}; ` +
    `${eligible} eligible [soonest-7d-reset]${fableSuffix(fable)}\n`
  );
}

// The registry-default fallback line: a distinct message when the fallback was
// caused specifically by fleet-wide Fable exhaustion, else the generic reason.
function autoFallbackLine(selection: LocalSelection | undefined): string {
  if (selection?.reason === "all-fable-exhausted") {
    return (
      `[acpx] subscription auto → registry default (all subscriptions Fable-exhausted; ` +
      `the turn will report the Fable-share limit)\n`
    );
  }
  return `[acpx] subscription auto → registry default (no eligible subscription: ${
    selection?.reason ?? "timeout"
  })\n`;
}

// One human line to stderr (same channel as the existing default-applied note),
// plus the cross-HOME divergence warning when present.
function emitAutoSelection(
  selection: LocalSelection | undefined,
  divergence: Divergence | undefined,
): void {
  if (selection?.picked && selection.pickedId) {
    process.stderr.write(autoPickLine(selection.picked, selection.eligible, selection.fable));
  } else {
    process.stderr.write(autoFallbackLine(selection));
  }
  if (divergence) {
    process.stderr.write(
      `[acpx] subscription auto: local registry differs from governing acpx-ui at ` +
        `${divergence.origin} — using local\n`,
    );
  }
}

/**
 * Resolve `--subscription auto` to a concrete subscription id, or undefined to
 * signal "fall back to the existing default binding". Claude-adapter-only.
 * Reuses pickFailoverTarget over a lock-aware exclude set (DIR-2), bounded by a
 * hard timeout. Emits one observability line and captures a JSON summary. Never
 * throws — any failure degrades to undefined (→ default) so a spawn never blocks.
 */
export async function resolveAutoSubscription(
  agentCommand: string,
  lookupOptions?: SubscriptionLookupOptions,
  opts?: { model?: string },
): Promise<string | undefined> {
  if (!isClaudeAdapterCommand(agentCommand)) {
    return undefined;
  }
  const isFable = isFableModel(opts?.model);
  const budgetMs = autoTimeoutMs(isFable);
  const registry = loadSubscriptionRegistry(lookupOptions);
  // The fable probe is owned HERE (not inside selectLocal) so a COMPLETED result
  // survives an outer-deadline timeout: a completed probe is authoritative
  // regardless of the wrapper deadline, so we still surface 'all-fable-exhausted'
  // + tally instead of discarding it as a generic 'timeout'.
  let completedFable: Map<string, SubscriptionFableState> | undefined;
  const fableProbe: Promise<Map<string, SubscriptionFableState> | undefined> = isFable
    ? getSubscriptionsFableState(registry.subscriptions, "gated", lookupOptions).then((states) => {
        completedFable = states;
        return states;
      })
    : Promise.resolve(undefined);
  const { signal, cancel } = deadline(budgetMs);
  try {
    const divergenceWork = crossHomeDivergence(registry, budgetMs);
    const selection = await raceDeadline(selectLocal(registry, fableProbe), signal);
    const divergence = await raceDeadline(divergenceWork, signal);
    const resolved = await resolveWithFableGrace(registry, selection, isFable, fableProbe);
    captureAutoSelection(summarize(resolved, divergence));
    emitAutoSelection(resolved, divergence);
    return resolved?.pickedId;
  } catch {
    // Defensive: never let a surprising error block a spawn. Still prefer a
    // completed fable verdict over a bare timeout.
    const resolved = fableTimeoutFallback(registry, completedFable);
    captureAutoSelection(summarize(resolved, undefined));
    emitAutoSelection(resolved, undefined);
    return resolved?.pickedId;
  } finally {
    cancel();
  }
}

// Resolve the final selection: the raced result if any, else the fable verdict.
// When the fable probe was still in flight at the deadline (a rare cold spike),
// give it a BOUNDED grace to land so we surface 'all-fable-exhausted' rather than
// a generic 'timeout' — a completed fable verdict is authoritative and the pick
// already fell back to default, so the spawn is not blocked on a real decision.
async function resolveWithFableGrace(
  registry: SubscriptionRegistry,
  selection: LocalSelection | undefined,
  isFable: boolean,
  fableProbe: Promise<Map<string, SubscriptionFableState> | undefined>,
): Promise<LocalSelection | undefined> {
  if (selection) {
    return selection;
  }
  if (!isFable) {
    return undefined;
  }
  const grace = deadline(FABLE_PROBE_GRACE_MS);
  try {
    const states = await Promise.race([fableProbe, grace.signal]);
    return states instanceof Map ? fableTimeoutFallback(registry, states) : undefined;
  } finally {
    grace.cancel();
  }
}
