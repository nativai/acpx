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
  // Claude thinking depth (the `effort` config option). In-memory only: it is
  // NOT written to `session_options` on disk — the creation sites persist it as
  // `acpx.desired_config_options.effort` and apply it live via the config-option
  // path. Carried forward across turns by mergeSessionOptions so a per-spawn
  // depth survives a same-session re-create. Opaque string (an advertised effort
  // level), validated at the flag boundary and again against the advertised set.
  reasoningEffort?: string;
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
  const priorSwitch = record.acpx?.session_options?.subscription_switch;
  const next = options === undefined ? undefined : persistedSessionOptions(options);
  if (next !== undefined) {
    if (priorSwitch !== undefined) {
      next.subscription_switch = priorSwitch;
    }
    record.acpx = {
      ...record.acpx,
      session_options: next,
    };
    return;
  }

  if (priorSwitch !== undefined) {
    record.acpx = {
      ...record.acpx,
      session_options: { subscription_switch: priorSwitch },
    };
    return;
  }

  if (!record.acpx) {
    return;
  }

  delete record.acpx.session_options;
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

  return Object.keys(sessionOptions).length > 0 ? sessionOptions : undefined;
}

type PersistedSessionOptions = NonNullable<NonNullable<SessionRecord["acpx"]>["session_options"]>;

function persistedSessionOptions(
  options: SessionAgentOptions,
): PersistedSessionOptions | undefined {
  const next = {
    model: nonEmptyString(options.model),
    allowed_tools: Array.isArray(options.allowedTools) ? [...options.allowedTools] : undefined,
    max_turns: typeof options.maxTurns === "number" ? options.maxTurns : undefined,
    system_prompt: normalizeSystemPromptOption(options.systemPrompt),
    subscription: nonEmptyString(options.subscription),
    profile: nonEmptyString(options.profile),
  } satisfies PersistedSessionOptions;
  return hasPersistedSessionOptions(next) ? next : undefined;
}

function hasPersistedSessionOptions(options: PersistedSessionOptions): boolean {
  return (
    options.model !== undefined ||
    options.allowed_tools !== undefined ||
    options.max_turns !== undefined ||
    options.system_prompt !== undefined ||
    options.subscription !== undefined ||
    options.profile !== undefined
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
