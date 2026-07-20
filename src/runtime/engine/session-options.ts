import type { SessionRecord } from "../../types.js";

export type SystemPromptOption = string | { append: string };

export type SessionAgentOptions = {
  model?: string;
  allowedTools?: string[];
  maxTurns?: number;
  systemPrompt?: SystemPromptOption;
  subscription?: string;
  /**
   * Profile id set via `--profile <id>`. Stored as `session_options.profile` on
   * disk. When set, takes priority over `subscription` for auth resolution.
   */
  profile?: string;
  // Claude thinking depth (the `effort` config option). Persisted to disk as
  // `session_options.effort` (the durable end-to-end contract field the claude-pty
  // bridge reads on cold-resume) AND, at the creation sites, as
  // `acpx.desired_config_options.effort` (live config + reconnect reapply).
  // Carried forward across turns by mergeSessionOptions so a per-spawn depth
  // survives a same-session re-create. Opaque string (an advertised effort
  // level), validated at the flag boundary and again against the advertised set.
  reasoningEffort?: string;
  // Per-session automatic same-family credential failover policy. undefined =
  // enabled; explicit false is the only behavior-changing state.
  autoFailover?: boolean;
};

export function mergeSessionOptions(
  preferred: SessionAgentOptions | undefined,
  fallback: SessionAgentOptions | undefined,
): SessionAgentOptions | undefined {
  const merged: SessionAgentOptions = { ...fallback };
  if (preferred) {
    assignDefinedOption(merged, "model", preferred.model);
    assignDefinedOption(merged, "allowedTools", preferred.allowedTools);
    assignDefinedOption(merged, "maxTurns", preferred.maxTurns);
    assignDefinedOption(merged, "systemPrompt", preferred.systemPrompt);
    assignDefinedOption(merged, "subscription", preferred.subscription);
    assignDefinedOption(merged, "profile", preferred.profile);
    assignDefinedOption(merged, "reasoningEffort", preferred.reasoningEffort);
    assignDefinedOption(merged, "autoFailover", preferred.autoFailover);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function assignDefinedOption<Key extends keyof SessionAgentOptions>(
  target: SessionAgentOptions,
  key: Key,
  value: SessionAgentOptions[Key] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

export function persistSessionOptions(
  record: SessionRecord,
  options: SessionAgentOptions | undefined,
): void {
  // The subscription_switch breadcrumb is a record-only field (not a user
  // flag, so it is absent from SessionAgentOptions). Carry it forward across a
  // re-persist (e.g. a model change next turn) so a manual/failover switch
  // stays visible; a subsequent switch overwrites it via switchSessionSubscription.
  //
  // auto_failover rides the same carry-forward. Unlike the pure breadcrumbs it
  // IS an explicit user policy (`set auto-failover off`), but it is NOT threaded
  // through the spawn-flag options (model/profile/effort) that owner respawns
  // rebuild session_options from. Without the carry-forward, every respawn would
  // rebuild session_options without auto_failover and silently revert an explicit
  // `off` back to default-on (brick://71af1351). Carrying the persisted value
  // when options omit it — while letting an explicit options.autoFailover win —
  // makes the policy durable across respawns.
  const breadcrumbs = sessionOptionBreadcrumbs(record);
  const next = persistedSessionOptionsWithBreadcrumbs(options, breadcrumbs);
  if (next !== undefined) {
    record.acpx = {
      ...record.acpx,
      session_options: next,
    };
    return;
  }

  clearPersistedSessionOptions(record);
}

type SessionOptionBreadcrumbs = {
  subscriptionSwitch: PersistedSessionOptions["subscription_switch"];
  accountSwitch: PersistedSessionOptions["account_switch"];
  provisioningWarning: PersistedSessionOptions["provisioning_warning"];
  autoFailover: PersistedSessionOptions["auto_failover"];
};

function sessionOptionBreadcrumbs(record: SessionRecord): SessionOptionBreadcrumbs {
  const stored = record.acpx?.session_options;
  return {
    subscriptionSwitch: stored?.subscription_switch,
    accountSwitch: stored?.account_switch,
    provisioningWarning: stored?.provisioning_warning,
    autoFailover: stored?.auto_failover,
  };
}

function persistedSessionOptionsWithBreadcrumbs(
  options: SessionAgentOptions | undefined,
  breadcrumbs: SessionOptionBreadcrumbs,
): PersistedSessionOptions | undefined {
  const next = options === undefined ? undefined : persistedSessionOptions(options);
  if (next !== undefined) {
    assignBreadcrumbs(next, breadcrumbs);
    return next;
  }
  return breadcrumbSessionOptions(breadcrumbs);
}

function clearPersistedSessionOptions(record: SessionRecord): void {
  if (record.acpx) {
    delete record.acpx.session_options;
  }
}

function assignBreadcrumbs(
  target: PersistedSessionOptions,
  breadcrumbs: SessionOptionBreadcrumbs,
): void {
  if (breadcrumbs.subscriptionSwitch !== undefined) {
    target.subscription_switch = breadcrumbs.subscriptionSwitch;
  }
  if (breadcrumbs.accountSwitch !== undefined) {
    target.account_switch = breadcrumbs.accountSwitch;
  }
  if (breadcrumbs.provisioningWarning !== undefined) {
    target.provisioning_warning = breadcrumbs.provisioningWarning;
  }
  // Only carry the persisted auto_failover when the rebuilt options did not
  // already set it — an explicit options.autoFailover (persistedSessionOptions
  // wrote it) is a deliberate policy change and must win over the prior value.
  if (breadcrumbs.autoFailover !== undefined && target.auto_failover === undefined) {
    target.auto_failover = breadcrumbs.autoFailover;
  }
}

function breadcrumbSessionOptions(
  breadcrumbs: SessionOptionBreadcrumbs,
): PersistedSessionOptions | undefined {
  const next: PersistedSessionOptions = {};
  assignBreadcrumbs(next, breadcrumbs);
  return Object.keys(next).length > 0 ? next : undefined;
}

export function sessionOptionsFromRecord(record: SessionRecord): SessionAgentOptions | undefined {
  const stored = record.acpx?.session_options;
  if (!stored) {
    return undefined;
  }

  const sessionOptions: SessionAgentOptions = {};
  assignStoredOption(sessionOptions, "model", nonEmptyString(stored.model));
  assignStoredOption(sessionOptions, "allowedTools", storedAllowedTools(stored.allowed_tools));
  assignStoredOption(sessionOptions, "maxTurns", storedMaxTurns(stored.max_turns));
  assignStoredOption(
    sessionOptions,
    "systemPrompt",
    storedSystemPromptOption(stored.system_prompt),
  );
  assignStoredOption(sessionOptions, "subscription", nonEmptyString(stored.subscription));
  assignStoredOption(sessionOptions, "profile", nonEmptyString(stored.profile));
  assignStoredOption(sessionOptions, "reasoningEffort", nonEmptyString(stored.effort));
  assignStoredOption(sessionOptions, "autoFailover", storedBoolean(stored.auto_failover));

  return Object.keys(sessionOptions).length > 0 ? sessionOptions : undefined;
}

type PersistedSessionOptions = NonNullable<NonNullable<SessionRecord["acpx"]>["session_options"]>;

function persistedSessionOptions(
  options: SessionAgentOptions,
): PersistedSessionOptions | undefined {
  const next: PersistedSessionOptions = {
    model: nonEmptyString(options.model),
    allowed_tools: Array.isArray(options.allowedTools) ? [...options.allowedTools] : undefined,
    max_turns: typeof options.maxTurns === "number" ? options.maxTurns : undefined,
    system_prompt: normalizeSystemPromptOption(options.systemPrompt),
    subscription: nonEmptyString(options.subscription),
    profile: nonEmptyString(options.profile),
    effort: nonEmptyString(options.reasoningEffort),
  };
  if (typeof options.autoFailover === "boolean") {
    next.auto_failover = options.autoFailover;
  }
  return hasPersistedSessionOptions(next) ? next : undefined;
}

function hasPersistedSessionOptions(options: PersistedSessionOptions): boolean {
  return (
    options.model !== undefined ||
    options.allowed_tools !== undefined ||
    options.max_turns !== undefined ||
    options.system_prompt !== undefined ||
    options.subscription !== undefined ||
    options.profile !== undefined ||
    options.effort !== undefined ||
    options.auto_failover !== undefined
  );
}

function normalizeSystemPromptOption(value: unknown): SystemPromptOption | undefined {
  const prompt = nonEmptyString(value);
  if (prompt !== undefined) {
    return prompt;
  }
  const append = appendedSystemPrompt(value);
  return append === undefined ? undefined : { append };
}

function appendedSystemPrompt(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return nonEmptyString((value as { append?: unknown }).append);
}

function assignStoredOption<Key extends keyof SessionAgentOptions>(
  target: SessionAgentOptions,
  key: Key,
  value: SessionAgentOptions[Key] | undefined,
): void {
  assignDefinedOption(target, key, value);
}

function storedAllowedTools(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

function storedMaxTurns(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function storedSystemPromptOption(value: unknown): SystemPromptOption | undefined {
  return normalizeSystemPromptOption(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function storedBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
