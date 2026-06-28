import { isClaudeAcpCommand, isClaudePtyAgentCommand } from "../../acp/agent-command.js";
import { splitCommandLine } from "../../acp/client-process.js";
import { isCodexAcpCommand } from "../../acp/codex-compat.js";
import {
  findProfile,
  loadProfileRegistry,
  type AdapterId,
  type ProfileEntry,
} from "../../config/profiles.js";
import {
  chooseSubscriptionConfigDir,
  loadSubscriptionRegistry,
  type SubscriptionLookupOptions,
} from "../../config/subscriptions.js";
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
  lookupOptions?: SubscriptionLookupOptions,
): boolean {
  if (profile.authMode !== "subscription") {
    return true;
  }
  const registry = loadSubscriptionRegistry(lookupOptions);
  const choice = chooseSubscriptionConfigDir(profile.id, registry);
  return choice.source === "explicit" && choice.configDir !== undefined;
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
  if (
    !profile ||
    !profileCompatibleWithAgent(profile, agentCommand) ||
    !profileUsableForBinding(profile, lookupOptions)
  ) {
    return undefined;
  }
  return { profile: profile.id };
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
    return undefined;
  }
  return { subscription: defaultSubscriptionId };
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
