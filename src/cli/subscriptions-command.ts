import { rmSync } from "node:fs";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { findProfile, loadProfileRegistry, type ProfileEntry } from "../config/profiles.js";
import {
  getSubscriptionsUsageWithFable,
  type SubscriptionUsage,
} from "../config/subscription-usage.js";
import {
  clearDefaultSubscriptionAutoWeeklyCeiling,
  clearSubscriptionAutoWeeklyCeiling,
  findSubscription,
  isSubscriptionLocked,
  loadSubscriptionRegistry,
  removeProfileFromRegistry,
  resolveEffectiveWeeklyCeiling,
  resolveSubscriptionSubject,
  setDefaultSubscriptionAutoWeeklyCeiling,
  setSubscriptionAutoWeeklyCeiling,
  setSubscriptionLockState,
  subscriptionsDir,
  type ResolvedSubscriptionSubject,
  type SubscriptionLockMutationResult,
  type SubscriptionCeilingMutationResult,
  type SubscriptionRegistry,
} from "../config/subscriptions.js";
import {
  SubscriptionPurgeOutsideRootError,
  SubscriptionRemoveDefaultError,
  SubscriptionRemoveInUseError,
  SubscriptionRemoveSelfReferenceError,
  SubscriptionUnknownError,
} from "../errors.js";
import {
  persistSessionOptions,
  sessionOptionsFromRecord,
} from "../runtime/engine/session-options.js";
import { listSessions, writeSessionRecord } from "../session/persistence/repository.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";

const NO_REGISTRY_MESSAGE =
  "No subscriptions registered (~/.acpx/subscriptions/registry.json absent or empty).\n";

function renderSubscriptionsListText(registry: SubscriptionRegistry): string {
  if (registry.subscriptions.length === 0) {
    return NO_REGISTRY_MESSAGE;
  }
  let out = `Subscriptions (default: ${registry.default ?? "-"}):\n`;
  for (const entry of registry.subscriptions) {
    const marker = entry.id === registry.default ? "*" : " ";
    const locked = isSubscriptionLocked(entry, registry) ? "\tlocked" : "";
    out += `  ${marker} ${entry.id}\t${entry.label}\t${entry.configDir}${locked}\n`;
  }
  return out;
}

function handleSubscriptionsList(command: Command, config: ResolvedAcpxConfig): void {
  const { format } = resolveGlobalFlags(command, config);
  const registry = loadSubscriptionRegistry();

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        default: registry.default ?? null,
        subscriptions: registry.subscriptions,
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    process.stdout.write(registry.subscriptions.map((entry) => `${entry.id}\n`).join(""));
    return;
  }

  process.stdout.write(renderSubscriptionsListText(registry));
}

function parseExplicitPercent(value: string): number | undefined {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)%$/u.test(value)) {
    return undefined;
  }
  const percent = Number(value.slice(0, -1));
  return Number.isFinite(percent) && percent > 0 && percent <= 100 ? percent / 100 : undefined;
}

function parseExplicitFraction(value: string): number | undefined {
  if (!/^(?:0?\.\d+|1\.0+)$/u.test(value)) {
    return undefined;
  }
  const fraction = Number(value);
  return Number.isFinite(fraction) && fraction > 0 && fraction <= 1 ? fraction : undefined;
}

export function parseAutoWeeklyCeiling(value: string): number {
  const normalized = value.trim();
  const parsed = normalized.endsWith("%")
    ? parseExplicitPercent(normalized)
    : parseExplicitFraction(normalized);
  if (parsed !== undefined) {
    return parsed;
  }
  throw new InvalidArgumentError(
    `Invalid automation weekly ceiling "${value}". Use an explicit percent (for example 90%) ` +
      `or fraction (for example 0.90 or 1.00); expected greater than 0% and at most 100%.`,
  );
}

type SubscriptionCeilingView = {
  account: string;
  subscriptions: string[];
  effectiveWeeklyCeiling: number;
  effectiveWeeklyCeilingPercent: number;
  reservedWeeklyFraction: number;
  reservedWeeklyPercent: number;
  source: ReturnType<typeof resolveEffectiveWeeklyCeiling>["source"];
  hard: boolean;
};

function ceilingViewForAccount(
  account: string,
  registry: SubscriptionRegistry,
): SubscriptionCeilingView {
  const effective = resolveEffectiveWeeklyCeiling(account, registry);
  const reserved = Number((1 - effective.value).toFixed(10));
  return {
    account,
    subscriptions: registry.subscriptions
      .filter((entry) => entry.account === account)
      .map((entry) => entry.id),
    effectiveWeeklyCeiling: effective.value,
    effectiveWeeklyCeilingPercent: Number((effective.value * 100).toFixed(10)),
    reservedWeeklyFraction: reserved,
    reservedWeeklyPercent: Number((reserved * 100).toFixed(10)),
    source: effective.source,
    hard: effective.hard,
  };
}

function renderCeilingValue(value: number): string {
  return `${(value * 100).toFixed(1)}% (fraction ${value.toFixed(4)})`;
}

function renderCeilingView(view: SubscriptionCeilingView): string {
  return (
    `Account: ${view.account}\n` +
    `  subscriptions: ${view.subscriptions.join(", ") || "-"}\n` +
    `  automation weekly ceiling: ${renderCeilingValue(view.effectiveWeeklyCeiling)}\n` +
    `  reserved weekly capacity: ${renderCeilingValue(view.reservedWeeklyFraction)}\n` +
    `  source: ${view.source}\n` +
    `  enforcement: ${view.hard ? "hard automatic turn boundary" : "legacy soft fallback"}\n`
  );
}

function knownCeilingSubjects(registry: SubscriptionRegistry): string[] {
  return [
    ...new Set([
      ...registry.subscriptions.flatMap((entry) => [
        `profile:${entry.id}`,
        `account:${entry.account}`,
      ]),
      ...Object.keys(registry.subscriptionPolicy?.accounts ?? {}).map(
        (account) => `account:${account}`,
      ),
    ]),
  ];
}

function requireCeilingSubject(
  subject: string,
  registry: SubscriptionRegistry,
): ResolvedSubscriptionSubject {
  const resolved = resolveSubscriptionSubject(subject, registry);
  if (resolved.kind === "ambiguous") {
    const accountProfiles =
      resolved.accountEntries.map((entry) => entry.id).join(", ") ||
      "configured policy with no enrolled profile";
    throw new InvalidArgumentError(
      `Ambiguous ceiling subject "${subject.trim()}": profile:${resolved.profile.id} maps to ` +
        `account "${resolved.profile.account}", while account:${subject.trim()} names profile(s) ` +
        `${accountProfiles}. Use the explicit profile: or account: prefix.`,
    );
  }
  if (resolved.kind === "missing") {
    throw new SubscriptionUnknownError(subject.trim(), knownCeilingSubjects(registry));
  }
  return resolved;
}

function printCeilingPayload(
  payload: SubscriptionCeilingView | SubscriptionCeilingMutationResult,
  format: ReturnType<typeof resolveGlobalFlags>["format"],
): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${payload.effectiveWeeklyCeilingPercent}%\n`);
    return;
  }
  if ("subscriptions" in payload) {
    process.stdout.write(renderCeilingView(payload));
    return;
  }
  const target = payload.account ?? "registry default";
  const verb = payload.action.endsWith("cleared") ? "cleared; effective fallback" : "set";
  process.stdout.write(
    `automation weekly ceiling ${verb} for ${target}: ${renderCeilingValue(payload.effectiveWeeklyCeiling)} (${payload.source}; ${payload.hard ? "hard" : "legacy soft"})\n`,
  );
}

function allCeilingViews(registry: SubscriptionRegistry): SubscriptionCeilingView[] {
  const accounts = new Set([
    ...registry.subscriptions.map((entry) => entry.account),
    ...Object.keys(registry.subscriptionPolicy?.accounts ?? {}),
  ]);
  return [...accounts].map((account) => ceilingViewForAccount(account, registry));
}

function printCeilingOverview(
  registry: SubscriptionRegistry,
  format: ReturnType<typeof resolveGlobalFlags>["format"],
): void {
  const accounts = allCeilingViews(registry);
  const fallback = resolveEffectiveWeeklyCeiling("", registry);
  const payload = {
    configuredDefault: registry.subscriptionPolicy?.defaultAutoWeeklyCeiling ?? null,
    fallback: {
      effectiveWeeklyCeiling: fallback.value,
      effectiveWeeklyCeilingPercent: Number((fallback.value * 100).toFixed(10)),
      source: fallback.source,
      hard: fallback.hard,
    },
    accounts,
  };
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  if (format === "quiet") {
    process.stdout.write(
      accounts
        .map((entry) => `${entry.account}\t${entry.effectiveWeeklyCeilingPercent}%\n`)
        .join(""),
    );
    return;
  }
  process.stdout.write(
    `Registry default: ${renderCeilingValue(fallback.value)} (${fallback.source}; ` +
      `${fallback.hard ? "hard" : "legacy soft"})\n`,
  );
  for (const account of accounts) {
    process.stdout.write(renderCeilingView(account));
  }
}

function handleSubscriptionCeilingShow(
  subject: string | undefined,
  command: Command,
  config: ResolvedAcpxConfig,
): void {
  const { format } = resolveGlobalFlags(command, config);
  const registry = loadSubscriptionRegistry();
  if (subject !== undefined) {
    const resolved = requireCeilingSubject(subject, registry);
    printCeilingPayload(ceilingViewForAccount(resolved.account, registry), format);
    return;
  }
  printCeilingOverview(registry, format);
}

function handleSubscriptionCeilingSet(
  subject: string,
  ceiling: number,
  command: Command,
  config: ResolvedAcpxConfig,
): void {
  const { format } = resolveGlobalFlags(command, config);
  const registry = loadSubscriptionRegistry();
  requireCeilingSubject(subject, registry);
  const result = setSubscriptionAutoWeeklyCeiling(subject, ceiling);
  if (!result) {
    throw new SubscriptionUnknownError(subject.trim(), knownCeilingSubjects(registry));
  }
  printCeilingPayload(result, format);
}

function handleSubscriptionCeilingDefaultSet(
  ceiling: number,
  command: Command,
  config: ResolvedAcpxConfig,
): void {
  const { format } = resolveGlobalFlags(command, config);
  const result = setDefaultSubscriptionAutoWeeklyCeiling(ceiling);
  if (!result) {
    throw new Error(
      "Cannot set an automation weekly ceiling: subscription registry is absent or malformed",
    );
  }
  printCeilingPayload(result, format);
}

function handleSubscriptionCeilingClear(
  subject: string,
  command: Command,
  config: ResolvedAcpxConfig,
): void {
  const { format } = resolveGlobalFlags(command, config);
  const registry = loadSubscriptionRegistry();
  requireCeilingSubject(subject, registry);
  const result = clearSubscriptionAutoWeeklyCeiling(subject);
  if (!result) {
    throw new SubscriptionUnknownError(subject.trim(), knownCeilingSubjects(registry));
  }
  printCeilingPayload(result, format);
}

function handleSubscriptionCeilingDefaultClear(command: Command, config: ResolvedAcpxConfig): void {
  const { format } = resolveGlobalFlags(command, config);
  const result = clearDefaultSubscriptionAutoWeeklyCeiling();
  if (!result) {
    throw new Error(
      "Cannot clear the automation weekly ceiling: subscription registry is absent or malformed",
    );
  }
  printCeilingPayload(result, format);
}

export function formatPercent(window: SubscriptionUsage["fiveHour"]): string {
  if (!window) {
    return "-";
  }
  return `${(window.utilization * 100).toFixed(1)}%`;
}

// Render the Fable-share cell (brick://1badc6f1). The probe is now truthful — a
// Claude-Code-shaped request returns the REAL Fable weekly window — so the reading
// is a genuine percentage, not the old advisory "flappy" verdict. `undefined` =
// not probed; `error` = the reading failed (UNKNOWN, not exhausted); `available:
// false` = a 429 that carried rate-limit headers, i.e. real exhaustion — which
// still shows its percentage, the one case where the number matters most.
export function formatFable(entry: SubscriptionUsage): string {
  const f = entry.fable;
  if (!f) {
    return "fable -";
  }
  if (f.error) {
    return `fable ? (${f.error})`;
  }
  const pct = f.utilization != null ? `${(f.utilization * 100).toFixed(1)}%` : null;
  const reset = f.reset ? `, resets ${f.reset}` : "";
  if (!f.available) {
    return pct ? `fable exhausted (${pct}${reset})` : "fable exhausted";
  }
  return pct ? `fable ${pct}${reset}` : "fable available";
}

/** The quiet fable field: `ok` | `exhausted` | `-` (not probed). */
function quietFable(entry: SubscriptionUsage): string {
  if (!entry.fable) {
    return "-";
  }
  return entry.fable.available ? "ok" : "exhausted";
}

function renderUsageEntryText(entry: SubscriptionUsage): string {
  if (entry.error) {
    return `  ${entry.id}\t${entry.label}\tERROR: ${entry.error}\n`;
  }
  const fiveReset = entry.fiveHour?.reset ? ` (resets ${entry.fiveHour.reset})` : "";
  const sevenReset = entry.sevenDay?.reset ? ` (resets ${entry.sevenDay.reset})` : "";
  return (
    `  ${entry.id}\t${entry.label}` +
    `\t5h ${formatPercent(entry.fiveHour)}${fiveReset}` +
    `\t7d ${formatPercent(entry.sevenDay)}${sevenReset}` +
    `\t${formatFable(entry)}\n`
  );
}

export function renderUsageText(usage: SubscriptionUsage[]): string {
  if (usage.length === 0) {
    return NO_REGISTRY_MESSAGE;
  }
  let out = "Subscription usage (5h / 7d / fable):\n";
  out +=
    "  (fable = the REAL Fable-5 weekly share, read from a 1-token claude-fable-5 probe and " +
    "served from a per-account snapshot at most 2h old; --reprobe forces a fresh read)\n";
  for (const entry of usage) {
    out += renderUsageEntryText(entry);
  }
  return out;
}

/** Quiet output for a subscription-usage list: one `id\t5h%\t7d%\tfable:<state>` line each. */
export function renderSubscriptionsUsageQuiet(usage: SubscriptionUsage[]): string {
  return usage
    .map(
      (entry) =>
        `${entry.id}\t${formatPercent(entry.fiveHour)}\t${formatPercent(entry.sevenDay)}\tfable:${quietFable(entry)}\n`,
    )
    .join("");
}

async function handleSubscriptionsUsage(
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  // Fable is served from the persisted per-account snapshot and only re-probed
  // when that snapshot is stale — so repeating this command inside the fresh
  // window issues NO outbound fable probe. `--reprobe` is the explicit override.
  const reprobe = command.opts<{ reprobe?: boolean }>().reprobe === true;
  const usage = await getSubscriptionsUsageWithFable(loadSubscriptionRegistry().subscriptions, {
    fableMode: reprobe ? "force" : "gated",
  });

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(usage)}\n`);
    return;
  }

  if (format === "quiet") {
    process.stdout.write(renderSubscriptionsUsageQuiet(usage));
    return;
  }

  process.stdout.write(renderUsageText(usage));
}

function printSubscriptionLockResult(
  result: SubscriptionLockMutationResult,
  format: ReturnType<typeof resolveGlobalFlags>["format"],
): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${result.subscription}\n`);
    return;
  }
  const state = result.locked ? "locked" : "unlocked";
  const affected = result.affected.length > 1 ? ` (${result.affected.length} linked entries)` : "";
  process.stdout.write(`subscription ${state}: ${result.subscription}${affected}\n`);
}

function handleSubscriptionLockSet(
  subscriptionId: string,
  locked: boolean,
  command: Command,
  config: ResolvedAcpxConfig,
): void {
  const { format } = resolveGlobalFlags(command, config);
  const id = subscriptionId.trim();
  const registry = loadSubscriptionRegistry();
  if (!findSubscription(id, registry)) {
    throw new SubscriptionUnknownError(
      id,
      registry.subscriptions.map((entry) => entry.id),
    );
  }
  const lockedBy = process.env.ACPX_LOCKED_BY?.trim();
  const result = setSubscriptionLockState(id, locked, lockedBy ? { lockedBy } : {});
  if (!result) {
    throw new SubscriptionUnknownError(
      id,
      registry.subscriptions.map((entry) => entry.id),
    );
  }
  printSubscriptionLockResult(result, format);
}

type SubscriptionRemoveFlags = {
  purge?: boolean;
  setDefault?: string;
  clearDefault?: boolean;
  reassign?: string;
  force?: boolean;
  dryRun?: boolean;
};

type PinnedSession = {
  record: Awaited<ReturnType<typeof listSessions>>[number];
  matchesProfile: boolean;
  matchesSubscription: boolean;
};

export type SubscriptionRemovePlan = {
  action: "subscription_remove";
  subscription: string;
  label: string;
  authMode: string;
  account: string;
  wasDefault: boolean;
  newDefault: string | null;
  /** Credential dir owned by this profile (null ⇒ it owns none). */
  configDir: string | null;
  /** Dir actually deleted (or that --purge would delete); null ⇒ nothing purged. */
  purgedDir: string | null;
  pinnedTotal: number;
  pinnedOpen: number;
  reassignedTo: string | null;
  reassignedCount: number;
  remaining: string[];
  dryRun: boolean;
};

/**
 * The directory that physically holds this profile's credentials — the only
 * thing --purge may delete. openrouter keys live inline in the registry and a
 * chatgpt profile's codexHome is normally the SHARED ~/.codex, so neither owns a
 * dir we may remove.
 */
function ownedConfigDir(profile: ProfileEntry): string | null {
  switch (profile.authMode) {
    case "subscription":
      return profile.credentialSource;
    case "claude-home":
      return profile.homePath;
    case "openrouter":
    case "chatgpt":
      return null;
  }
  throw new Error("Unsupported authMode");
}

/**
 * Resolve what --purge may delete. It only ever deletes STRICTLY BENEATH
 * ~/.acpx/subscriptions: a registry entry is just a string on disk, so without
 * this a malformed or hand-edited credentialSource ("/", "$HOME", "/workspace")
 * would turn a routine removal into a recursive delete of something else.
 * Refuses loudly rather than silently declining — the operator asked for a
 * delete, so quietly not doing it would misreport what happened.
 */
export function resolvePurgeDir(
  id: string,
  configDir: string | null,
  wantsPurge: boolean,
): string | null {
  if (!wantsPurge || configDir === null) {
    return null;
  }
  const root = path.resolve(subscriptionsDir());
  const target = path.resolve(configDir);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new SubscriptionPurgeOutsideRootError(id, target, root);
  }
  return target;
}

/** Sessions whose persisted selection still names `id`, in either slot. */
async function findPinnedSessions(id: string): Promise<PinnedSession[]> {
  const records = await listSessions();
  const pinned: PinnedSession[] = [];
  for (const record of records) {
    const options = sessionOptionsFromRecord(record);
    if (!options) {
      continue;
    }
    const matchesProfile = options.profile === id;
    const matchesSubscription = options.subscription === id;
    if (matchesProfile || matchesSubscription) {
      pinned.push({ record, matchesProfile, matchesSubscription });
    }
  }
  return pinned;
}

async function reassignPinnedSessions(pinned: PinnedSession[], toId: string): Promise<number> {
  let count = 0;
  for (const { record, matchesProfile, matchesSubscription } of pinned) {
    const options = sessionOptionsFromRecord(record) ?? {};
    persistSessionOptions(record, {
      ...options,
      ...(matchesProfile ? { profile: toId } : {}),
      ...(matchesSubscription ? { subscription: toId } : {}),
    });
    await writeSessionRecord(record);
    count += 1;
  }
  return count;
}

function removePlanSessionLine(plan: SubscriptionRemovePlan): string {
  if (plan.pinnedTotal === 0) {
    return "";
  }
  const detail =
    plan.reassignedTo !== null
      ? `${plan.reassignedCount} re-pinned to ${plan.reassignedTo}`
      : `${plan.pinnedOpen} open — left dangling (will fail to spawn)`;
  return `  sessions     ${plan.pinnedTotal} pinned; ${detail}\n`;
}

function removePlanCredentialsLine(plan: SubscriptionRemovePlan): string {
  if (plan.purgedDir !== null) {
    return `  credentials  ${plan.dryRun ? "would purge" : "purged"} ${plan.purgedDir}\n`;
  }
  if (plan.configDir !== null) {
    return `  credentials  kept at ${plan.configDir} (pass --purge to delete)\n`;
  }
  return "";
}

export function renderRemovePlanText(plan: SubscriptionRemovePlan): string {
  const verb = plan.dryRun ? "would remove" : "removed";
  const defaultLine = plan.wasDefault
    ? `  default      ${plan.newDefault ?? "<none — unselected spawns fall back to ~/.claude>"}\n`
    : "";
  return (
    `${verb} subscription: ${plan.subscription}\t${plan.label} (${plan.authMode})\n` +
    defaultLine +
    removePlanSessionLine(plan) +
    removePlanCredentialsLine(plan) +
    `  remaining    ${plan.remaining.length > 0 ? plan.remaining.join(", ") : "<none>"}\n`
  );
}

/**
 * Resolve a `--set-default` / `--reassign` target: it must exist and must not be
 * the profile being removed (which would re-point straight back at the entry
 * about to disappear).
 */
function resolveOtherProfileFlag(
  value: string | undefined,
  flag: string,
  removingId: string,
  registry: ReturnType<typeof loadProfileRegistry>,
  otherIds: readonly string[],
): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }
  if (trimmed === removingId) {
    throw new SubscriptionRemoveSelfReferenceError(flag, trimmed, otherIds);
  }
  if (!findProfile(trimmed, registry)) {
    throw new SubscriptionUnknownError(trimmed, otherIds);
  }
  return trimmed;
}

type RemoveDecision = {
  profile: ProfileEntry;
  knownIds: string[];
  otherIds: string[];
  setDefault: string | undefined;
  reassign: string | undefined;
  wasDefault: boolean;
  pinned: PinnedSession[];
  openPinned: number;
  purgeDir: string | null;
  configDir: string | null;
  currentDefault: string | null;
};

/**
 * The default half of the decision: removing the registry default silently
 * drops every unselected spawn to the raw global ~/.claude, so it takes an
 * explicit --set-default or --clear-default.
 */
function resolveDefaultHandling(
  id: string,
  flags: SubscriptionRemoveFlags,
  registry: ReturnType<typeof loadProfileRegistry>,
  otherIds: readonly string[],
): { setDefault: string | undefined; wasDefault: boolean } {
  const setDefault = resolveOtherProfileFlag(
    flags.setDefault,
    "--set-default",
    id,
    registry,
    otherIds,
  );
  const wasDefault = registry.default === id;
  if (wasDefault && setDefault === undefined && flags.clearDefault !== true) {
    throw new SubscriptionRemoveDefaultError(id, otherIds);
  }
  return { setDefault, wasDefault };
}

/**
 * The sessions half of the decision: count what is still pinned and refuse
 * unless the caller said what should happen to it.
 */
async function assessPinnedSessions(
  id: string,
  flags: SubscriptionRemoveFlags,
  reassign: string | undefined,
  otherIds: readonly string[],
): Promise<{ pinned: PinnedSession[]; openPinned: number }> {
  const pinned = await findPinnedSessions(id);
  const openPinned = pinned.filter(({ record }) => record.closed !== true).length;
  if (openPinned > 0 && reassign === undefined && flags.force !== true) {
    throw new SubscriptionRemoveInUseError(id, openPinned, otherIds);
  }
  return { pinned, openPinned };
}

/** Validate flags and gather impact. Throws on every refusal; writes nothing. */
async function decideRemoval(id: string, flags: SubscriptionRemoveFlags): Promise<RemoveDecision> {
  const registry = loadProfileRegistry();
  const knownIds = registry.profiles.map((entry) => entry.id);
  const profile = findProfile(id, registry);
  if (!profile) {
    throw new SubscriptionUnknownError(id, knownIds);
  }
  const otherIds = knownIds.filter((entry) => entry !== id);

  const { setDefault, wasDefault } = resolveDefaultHandling(id, flags, registry, otherIds);
  const reassign = resolveOtherProfileFlag(flags.reassign, "--reassign", id, registry, otherIds);

  const { pinned, openPinned } = await assessPinnedSessions(id, flags, reassign, otherIds);
  const configDir = ownedConfigDir(profile);

  return {
    profile,
    knownIds,
    otherIds,
    setDefault,
    reassign,
    wasDefault,
    pinned,
    openPinned,
    purgeDir: resolvePurgeDir(id, configDir, flags.purge === true),
    configDir,
    currentDefault: registry.default ?? null,
  };
}

function initialRemovePlan(
  id: string,
  decision: RemoveDecision,
  dryRun: boolean,
): SubscriptionRemovePlan {
  return {
    action: "subscription_remove",
    subscription: id,
    label: decision.profile.label,
    authMode: decision.profile.authMode,
    account: decision.profile.account,
    wasDefault: decision.wasDefault,
    newDefault: decision.wasDefault ? (decision.setDefault ?? null) : decision.currentDefault,
    configDir: decision.configDir,
    purgedDir: decision.purgeDir,
    pinnedTotal: decision.pinned.length,
    pinnedOpen: decision.openPinned,
    reassignedTo: decision.reassign ?? null,
    reassignedCount: 0,
    remaining: decision.otherIds,
    dryRun,
  };
}

async function handleSubscriptionsRemove(
  subscriptionId: string,
  flags: SubscriptionRemoveFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  const id = subscriptionId.trim();
  const decision = await decideRemoval(id, flags);
  const plan = initialRemovePlan(id, decision, flags.dryRun === true);

  if (flags.dryRun === true) {
    printRemovePlan(plan, format);
    return;
  }

  // Order is deliberate and each step is a safe stopping point:
  //   1. re-pin sessions WHILE the profile still resolves, so an abort here
  //      never leaves a record naming a profile that is already gone;
  //   2. drop the registry entry — the step that makes it stop being offered;
  //   3. delete credentials LAST, because that is the only irreversible part.
  if (decision.reassign !== undefined) {
    plan.reassignedCount = await reassignPinnedSessions(decision.pinned, decision.reassign);
  }

  const result = removeProfileFromRegistry(id, {
    ...(decision.setDefault !== undefined ? { setDefault: decision.setDefault } : {}),
    ...(flags.clearDefault === true ? { clearDefault: true } : {}),
  });
  if (!result) {
    throw new SubscriptionUnknownError(id, decision.knownIds);
  }
  plan.newDefault = result.newDefault;
  plan.remaining = result.remaining;

  if (decision.purgeDir !== null) {
    rmSync(decision.purgeDir, { recursive: true, force: true });
  }

  printRemovePlan(plan, format);
}

function printRemovePlan(
  plan: SubscriptionRemovePlan,
  format: ReturnType<typeof resolveGlobalFlags>["format"],
): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${plan.subscription}\n`);
    return;
  }
  process.stdout.write(renderRemovePlanText(plan));
}

export function registerSubscriptionsCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const subscriptionsCommand = parent
    .command("subscriptions")
    .description("List Claude subscriptions and per-subscription usage");

  subscriptionsCommand
    .command("list")
    .description("List registered subscriptions (ids, labels, default)")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command) {
      handleSubscriptionsList(this, config);
    });

  subscriptionsCommand
    .command("usage")
    .description(
      "Per-subscription 5h + 7d utilization plus the REAL Fable-5 weekly share. " +
        "The 5h/7d windows are probed on every run; the Fable share is served from a " +
        "per-account snapshot (~/.acpx/usage/fable) and re-probed only when it is stale — " +
        "older than 2h, past its reset, or superseded by local Fable activity, and then at " +
        "most once every 5 minutes per account.",
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .option(
      "--reprobe",
      "Force a fresh Fable probe, bypassing the staleness gate (still collapsed to one " +
        "probe per 30s per account). NOT the default and not a routine habit: use it only " +
        "when you have concrete reason to believe the current reading is outdated (e.g. " +
        "suspected spend from another box, or a reading that contradicts a real turn).",
    )
    .action(async function (this: Command) {
      await handleSubscriptionsUsage(this, config);
    });

  const ceilingCommand = subscriptionsCommand
    .command("ceiling")
    .description("Show or configure account-scoped automatic weekly ceilings");

  ceilingCommand
    .command("show")
    .description("Show effective ceilings (optionally for one subscription/account)")
    .argument("[subscription-or-account]", "profile:<id>, account:<id>, or an unambiguous bare id")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command, subject?: string) {
      handleSubscriptionCeilingShow(subject, this, config);
    });

  ceilingCommand
    .command("set")
    .description("Set a hard automatic weekly ceiling for one functional account")
    .argument("<subscription-or-account>", "profile:<id>, account:<id>, or an unambiguous bare id")
    .argument("<ceiling>", "Explicit percent (90%) or fraction (0.90/1.00)", parseAutoWeeklyCeiling)
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command, subject: string, ceiling: number) {
      handleSubscriptionCeilingSet(subject, ceiling, this, config);
    });

  ceilingCommand
    .command("set-default")
    .description("Set the hard default for accounts without an override")
    .argument("<ceiling>", "Explicit percent (90%) or fraction (0.90/1.00)", parseAutoWeeklyCeiling)
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command, ceiling: number) {
      handleSubscriptionCeilingDefaultSet(ceiling, this, config);
    });

  ceilingCommand
    .command("clear")
    .description("Clear one account override and reveal the default/legacy fallback")
    .argument("<subscription-or-account>", "profile:<id>, account:<id>, or an unambiguous bare id")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command, subject: string) {
      handleSubscriptionCeilingClear(subject, this, config);
    });

  ceilingCommand
    .command("clear-default")
    .description(
      "Clear the configured default and return unoverridden accounts to legacy soft policy",
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command) {
      handleSubscriptionCeilingDefaultClear(this, config);
    });

  subscriptionsCommand
    .command("lock")
    .description("Lock a Claude SDK subscription so new turns cannot use it")
    .argument("<id>", "Subscription id")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command, id: string) {
      handleSubscriptionLockSet(id, true, this, config);
    });

  subscriptionsCommand
    .command("unlock")
    .description("Unlock a Claude SDK subscription")
    .argument("<id>", "Subscription id")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(function (this: Command, id: string) {
      handleSubscriptionLockSet(id, false, this, config);
    });

  subscriptionsCommand
    .command("remove")
    .alias("rm")
    .description("Remove a subscription/profile from the registry (e.g. a cancelled account)")
    .argument("<id>", "Profile id to remove")
    .option("--purge", "Also delete the profile's credential dir from disk")
    .option("--set-default <id>", "Repoint the registry default (required if removing it)")
    .option("--clear-default", "Leave the registry default unset when removing it")
    .option("--reassign <id>", "Re-pin sessions bound to <id> onto this profile")
    .option("--force", "Remove even while open sessions are pinned to it")
    .option("--dry-run", "Report what would change; write nothing")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command, id: string, flags: SubscriptionRemoveFlags) {
      await handleSubscriptionsRemove(id, flags, this, config);
    });

  subscriptionsCommand.action(async function (this: Command) {
    handleSubscriptionsList(this, config);
  });
}
