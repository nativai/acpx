import { isClaudeAcpCommand, isClaudePtyAgentCommand } from "../../acp/agent-command.js";
import { splitCommandLine } from "../../acp/client-process.js";
import { isCodexAcpCommand } from "../../acp/codex-compat.js";
import {
  findProfile,
  isSubscriptionProfileLocked,
  loadProfileRegistry,
  type AdapterId,
  type ProfileEntry,
  type ProfileRegistry,
} from "../../config/profiles.js";
import {
  chooseSubscriptionConfigDir,
  findSubscription,
  loadSubscriptionRegistry,
  isSubscriptionLocked,
  type SubscriptionLookupOptions,
} from "../../config/subscriptions.js";
import { AllSubscriptionsLockedError } from "../../errors.js";
import type { SessionRecord } from "../../types.js";
import { isAutoSubscriptionSentinel, resolveAutoSubscription } from "./auto-subscription.js";
import {
  persistSessionOptions,
  sessionOptionsFromRecord,
  type SessionAgentOptions,
} from "./session-options.js";

type AccountBinding = Pick<SessionAgentOptions, "profile" | "subscription">;

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// A concrete account is a profile or subscription id that is NOT the `auto`
// sentinel. `auto` is deliberately non-concrete: it must be resolved to a real
// id (or stripped) before it reaches env building, never treated as a literal
// selection (which would fail the registry lookup and block the spawn). The CLI
// folds `--subscription` into the unified `profile` slot, so `auto` normally
// arrives there; the `subscription` slot is checked too for robustness.
function hasConcreteAccount(options: SessionAgentOptions | undefined): boolean {
  const profile = nonEmpty(options?.profile);
  if (profile !== undefined && !isAutoSubscriptionSentinel(profile)) {
    return true;
  }
  const subscription = nonEmpty(options?.subscription);
  return subscription !== undefined && !isAutoSubscriptionSentinel(subscription);
}

// Drop a literal `auto` sentinel from either selection slot so it can never be
// persisted, resumed, or passed downstream as a concrete id. Returns the input
// unchanged (same reference) when there is nothing to strip.
function withoutAutoSelection(
  options: SessionAgentOptions | undefined,
): SessionAgentOptions | undefined {
  if (options === undefined) {
    return options;
  }
  const profileAuto = isAutoSubscriptionSentinel(options.profile);
  const subscriptionAuto = isAutoSubscriptionSentinel(options.subscription);
  if (!profileAuto && !subscriptionAuto) {
    return options;
  }
  const next = { ...options };
  if (profileAuto) {
    delete next.profile;
  }
  if (subscriptionAuto) {
    delete next.subscription;
  }
  return next;
}

// True when either selection slot carries the `auto` sentinel.
function wantsAutoSelection(options: SessionAgentOptions | undefined): boolean {
  return (
    isAutoSubscriptionSentinel(options?.profile) ||
    isAutoSubscriptionSentinel(options?.subscription)
  );
}

function adapterForAgentCommand(agentCommand: string): AdapterId | undefined {
  if (isClaudePtyAgentCommand(agentCommand)) {
    return "claude-pty";
  }
  const split = splitCommandLine(agentCommand);
  if (isCodexAcpCommand(split.command, split.args)) {
    return "codex";
  }
  if (isClaudeAcpCommand(split.command, split.args)) {
    return "claude";
  }
  return undefined;
}

function profileCompatibleWithAgent(profile: ProfileEntry, agentCommand: string): boolean {
  return profile.adapter === adapterForAgentCommand(agentCommand);
}

function profileUsableForBinding(
  profile: ProfileEntry,
  profileRegistry?: ProfileRegistry,
  lookupOptions?: SubscriptionLookupOptions,
): boolean {
  if (profile.authMode !== "subscription") {
    return true;
  }
  if (profileRegistry && isSubscriptionProfileLocked(profile, profileRegistry)) {
    return false;
  }
  const registry = loadSubscriptionRegistry(lookupOptions);
  const choice = chooseSubscriptionConfigDir(profile.id, registry);
  return choice.source === "explicit" && choice.configDir !== undefined;
}

function firstCompatibleUnlockedSubscriptionProfile(
  registry: ProfileRegistry,
  agentCommand: string,
  lookupOptions?: SubscriptionLookupOptions,
): ProfileEntry | undefined {
  return registry.profiles.find(
    (profile) =>
      profile.authMode === "subscription" &&
      profileCompatibleWithAgent(profile, agentCommand) &&
      profileUsableForBinding(profile, registry, lookupOptions),
  );
}

function defaultProfileBindingForAgent(
  agentCommand: string,
  lookupOptions?: SubscriptionLookupOptions,
): AccountBinding | undefined {
  const registry = loadProfileRegistry(lookupOptions);
  const defaultProfileId = nonEmpty(registry.default);
  if (!defaultProfileId) {
    return undefined;
  }
  const profile = findProfile(defaultProfileId, registry);
  if (!profile || !profileCompatibleWithAgent(profile, agentCommand)) {
    return undefined;
  }
  if (!profileUsableForBinding(profile, registry, lookupOptions)) {
    if (profile.authMode === "subscription" && isSubscriptionProfileLocked(profile, registry)) {
      const fallback = firstCompatibleUnlockedSubscriptionProfile(
        registry,
        agentCommand,
        lookupOptions,
      );
      if (fallback) {
        return { profile: fallback.id };
      }
      throw new AllSubscriptionsLockedError(
        `default subscription profile "${profile.id}" is locked; no unlocked compatible subscription is available`,
      );
    }
    return undefined;
  }
  return { profile: profile.id };
}

function throwIfLockedLegacyDefaultHasNoFallback(
  defaultSubscriptionId: string,
  registry: ReturnType<typeof loadSubscriptionRegistry>,
): void {
  const defaultSubscription = findSubscription(defaultSubscriptionId, registry);
  if (!defaultSubscription || !isSubscriptionLocked(defaultSubscription, registry)) {
    return;
  }
  throw new AllSubscriptionsLockedError(
    `default subscription "${defaultSubscriptionId}" is locked; no unlocked compatible subscription is available`,
  );
}

function legacySubscriptionDefaultBindingForAgent(
  agentCommand: string,
  lookupOptions?: SubscriptionLookupOptions,
): AccountBinding | undefined {
  if (adapterForAgentCommand(agentCommand) !== "claude") {
    return undefined;
  }
  const registry = loadSubscriptionRegistry(lookupOptions);
  const defaultSubscriptionId = nonEmpty(registry.default);
  if (!defaultSubscriptionId) {
    return undefined;
  }
  const choice = chooseSubscriptionConfigDir(undefined, registry);
  if (!choice.configDir) {
    if (choice.defaultUnusable?.kind === "locked") {
      throwIfLockedLegacyDefaultHasNoFallback(defaultSubscriptionId, registry);
    }
    return undefined;
  }
  return { subscription: choice.resolvedId ?? defaultSubscriptionId };
}

export function defaultAccountBindingForAgent(
  agentCommand: string,
  lookupOptions?: SubscriptionLookupOptions,
): AccountBinding | undefined {
  return (
    defaultProfileBindingForAgent(agentCommand, lookupOptions) ??
    legacySubscriptionDefaultBindingForAgent(agentCommand, lookupOptions)
  );
}

export function bindDefaultAccountToSessionOptions(
  options: SessionAgentOptions | undefined,
  agentCommand: string,
  lookupOptions?: SubscriptionLookupOptions,
): SessionAgentOptions | undefined {
  const base = withoutAutoSelection(options);
  if (hasConcreteAccount(base)) {
    return base;
  }
  const binding = defaultAccountBindingForAgent(agentCommand, lookupOptions);
  if (!binding) {
    return base;
  }
  return { ...base, ...binding };
}

/**
 * Async binding for the creation seam: resolves `--subscription auto` to a
 * concrete id (snapshot-once), then delegates to the synchronous default
 * binding. Every other input keeps the exact synchronous behavior.
 *
 * The resolved id is written to the unified `profile` slot — byte-identical to a
 * manual `--subscription <id>`, which the CLI also folds into that slot (a
 * subscription id is always a profile in the normalized registry). A concrete
 * `--profile` always wins (the CLI drops `auto` during unification), so `auto`
 * only reaches here when no concrete selection was given.
 */
export async function bindDefaultAccountToSessionOptionsAsync(
  options: SessionAgentOptions | undefined,
  agentCommand: string,
  lookupOptions?: SubscriptionLookupOptions,
): Promise<SessionAgentOptions | undefined> {
  if (!wantsAutoSelection(options)) {
    return bindDefaultAccountToSessionOptions(options, agentCommand, lookupOptions);
  }
  const stripped = withoutAutoSelection(options);
  const pickedId = await resolveAutoSubscription(agentCommand, lookupOptions, {
    model: stripped?.model,
  });
  if (pickedId) {
    return { ...stripped, profile: pickedId };
  }
  return bindDefaultAccountToSessionOptions(stripped, agentCommand, lookupOptions);
}

export function bindRecordToDefaultAccount(
  record: SessionRecord,
  lookupOptions?: SubscriptionLookupOptions,
): boolean {
  const original = sessionOptionsFromRecord(record);
  // Defense in depth: a record must never carry a literal `auto` (creation
  // resolves it before persist). If one somehow does, strip it and bind the
  // default here — never re-pick auto (resume must not re-select a subscription).
  const hadAuto = wantsAutoSelection(original);
  const current = withoutAutoSelection(original);
  if (hasConcreteAccount(current)) {
    if (hadAuto) {
      persistSessionOptions(record, current);
      return true;
    }
    return false;
  }
  const binding = defaultAccountBindingForAgent(record.agentCommand, lookupOptions);
  if (binding) {
    persistSessionOptions(record, { ...current, ...binding });
    return true;
  }
  if (hadAuto) {
    persistSessionOptions(record, current);
    return true;
  }
  return false;
}
