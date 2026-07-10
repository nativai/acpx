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

function hasConcreteAccount(options: SessionAgentOptions | undefined): boolean {
  return nonEmpty(options?.profile) !== undefined || nonEmpty(options?.subscription) !== undefined;
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
  if (hasConcreteAccount(options)) {
    return options;
  }
  const binding = defaultAccountBindingForAgent(agentCommand, lookupOptions);
  if (!binding) {
    return options;
  }
  return { ...options, ...binding };
}

export function bindRecordToDefaultAccount(
  record: SessionRecord,
  lookupOptions?: SubscriptionLookupOptions,
): boolean {
  const current = sessionOptionsFromRecord(record);
  if (hasConcreteAccount(current)) {
    return false;
  }
  const binding = defaultAccountBindingForAgent(record.agentCommand, lookupOptions);
  if (!binding) {
    return false;
  }
  persistSessionOptions(record, { ...current, ...binding });
  return true;
}
