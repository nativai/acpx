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
  // Per-session hard model-floor policy (brick://07dd62c9). undefined/false =
  // the default detect+surface+accept mode; true refuses/quarantines below-floor
  // work. Durable like autoFailover — carried forward across owner respawns by
  // carryForwardPinnedFloor.
  floorHard?: boolean;
  // Per-session autonomous subscription-selection policy (brick://4d517be2).
  // undefined = enabled (default-ON); explicit false opts out. Durable like
  // autoFailover — carried forward across owner respawns.
  autoSubscription?: boolean;
  // Per-session opt-in allowing a Fable session to degrade to Opus when no
  // subscription has Fable available (brick://4d517be2). undefined/false = NOT
  // allowed; explicit true opts in. Durable like floorHard.
  fableDegradeOk?: boolean;
  // Provenance of `model` (brick://5bac5564 Layer C) — one of the ModelSource
  // flat-string values. Persisted as `session_options.model_source`; carried
  // forward paired with `model` so the explicit-vs-implicit distinction survives
  // owner respawns (load-bearing for the reuse-branch clobber-guard).
  modelSource?: string;
  // CREATE-TIME TRANSIENT (never persisted, never carried): the implicit Fable
  // value the resolution-tier guard blocked. Set only when modelSource is
  // "guard-forced"; read once at record creation to stamp the model_guard
  // breadcrumb + mirror the warning. Not a PERSISTED key and absent from every
  // transform leg on purpose.
  modelGuardBlocked?: string;
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
    assignDefinedOption(merged, "floorHard", preferred.floorHard);
    assignDefinedOption(merged, "autoSubscription", preferred.autoSubscription);
    assignDefinedOption(merged, "fableDegradeOk", preferred.fableDegradeOk);
    assignDefinedOption(merged, "modelSource", preferred.modelSource);
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
  modelGuard: PersistedSessionOptions["model_guard"];
  fableDegrade: PersistedSessionOptions["fable_degrade"];
  autoFailover: PersistedSessionOptions["auto_failover"];
  floorHard: PersistedSessionOptions["floor_hard"];
  autoSubscription: PersistedSessionOptions["auto_subscription"];
  fableDegradeOk: PersistedSessionOptions["fable_degrade_ok"];
  model: PersistedSessionOptions["model"];
  modelSource: PersistedSessionOptions["model_source"];
  effort: PersistedSessionOptions["effort"];
};

function sessionOptionBreadcrumbs(record: SessionRecord): SessionOptionBreadcrumbs {
  const stored = record.acpx?.session_options ?? {};
  return {
    subscriptionSwitch: stored.subscription_switch,
    accountSwitch: stored.account_switch,
    provisioningWarning: stored.provisioning_warning,
    modelGuard: stored.model_guard,
    fableDegrade: stored.fable_degrade,
    autoFailover: stored.auto_failover,
    floorHard: stored.floor_hard,
    autoSubscription: stored.auto_subscription,
    fableDegradeOk: stored.fable_degrade_ok,
    model: stored.model,
    modelSource: stored.model_source,
    effort: stored.effort,
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
  // model_guard is a pure record-only breadcrumb (like subscription_switch) — carry
  // it forward so the "implicit Fable blocked" signal stays visible across respawns.
  if (breadcrumbs.modelGuard !== undefined) {
    target.model_guard = breadcrumbs.modelGuard;
  }
  // fable_degrade is a pure record-only breadcrumb (like model_guard) — carry it
  // forward so the "degraded from Fable to Opus" signal stays visible across
  // respawns and preserves the original Fable id for a future auto-restore.
  if (breadcrumbs.fableDegrade !== undefined) {
    target.fable_degrade = breadcrumbs.fableDegrade;
  }
  carryDurableIfUnset(target, breadcrumbs);
}

// Carry the durable POLICY/PIN fields (auto_failover, floor_hard, model, effort)
// from the prior record ONLY when the rebuilt options did not already set them —
// an explicit spawn flag (already written into `target` by persistedSessionOptions)
// is a deliberate change and must win. auto_failover: brick://71af1351; floor_hard:
// brick://07dd62c9; model/effort record-loss gap: brick://dda08023 fold-in.
// carryForwardPinnedFloor seeds these onto the record only when it carries no pin
// of its own, so this never overwrites a live-applied pin.
function carryDurableIfUnset(
  target: PersistedSessionOptions,
  breadcrumbs: SessionOptionBreadcrumbs,
): void {
  carryIfUnset(target, "auto_failover", breadcrumbs.autoFailover);
  carryIfUnset(target, "floor_hard", breadcrumbs.floorHard);
  carryIfUnset(target, "auto_subscription", breadcrumbs.autoSubscription);
  carryIfUnset(target, "fable_degrade_ok", breadcrumbs.fableDegradeOk);
  carryIfUnset(target, "model", breadcrumbs.model);
  // model_source rides forward paired with `model` (brick://5bac5564 Layer C): a
  // respawn that carries the stored pin must carry its provenance too, or the
  // reuse-branch clobber-guard/apply-guard lose the explicit-vs-implicit signal.
  carryIfUnset(target, "model_source", breadcrumbs.modelSource);
  carryIfUnset(target, "effort", breadcrumbs.effort);
}

// Assign `value` to `target[key]` ONLY when the breadcrumb HAS a value AND the
// target has not already set it. The `value !== undefined` guard matters: without
// it, an assignment of `undefined` creates an OWN-KEY (`auto_failover: undefined`)
// that is a no-op on disk (JSON drops it) but NOT for in-memory object identity —
// deepStrictEqual / Object.keys see the extra key (TE Finding #2). Mirrors the old
// assignDefinedOption / assignBreadcrumbs `!== undefined` semantics.
function carryIfUnset<K extends keyof PersistedSessionOptions>(
  target: PersistedSessionOptions,
  key: K,
  value: PersistedSessionOptions[K] | undefined,
): void {
  if (value !== undefined && target[key] === undefined) {
    target[key] = value;
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
  assignStoredOption(sessionOptions, "floorHard", storedBoolean(stored.floor_hard));
  assignStoredOption(sessionOptions, "autoSubscription", storedBoolean(stored.auto_subscription));
  assignStoredOption(sessionOptions, "fableDegradeOk", storedBoolean(stored.fable_degrade_ok));
  assignStoredOption(sessionOptions, "modelSource", nonEmptyString(stored.model_source));

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
  if (typeof options.floorHard === "boolean") {
    next.floor_hard = options.floorHard;
  }
  if (typeof options.autoSubscription === "boolean") {
    next.auto_subscription = options.autoSubscription;
  }
  if (typeof options.fableDegradeOk === "boolean") {
    next.fable_degrade_ok = options.fableDegradeOk;
  }
  // model_source is subordinate to `model` (always co-persisted with it, never
  // alone) — so it is NOT a PERSISTED_CONTENT_KEY: it must not keep an otherwise
  // empty session_options block alive on its own.
  const modelSource = nonEmptyString(options.modelSource);
  if (modelSource !== undefined) {
    next.model_source = modelSource;
  }
  return hasPersistedSessionOptions(next) ? next : undefined;
}

const PERSISTED_CONTENT_KEYS = [
  "model",
  "allowed_tools",
  "max_turns",
  "system_prompt",
  "subscription",
  "profile",
  "effort",
  "auto_failover",
  "floor_hard",
  "auto_subscription",
  "fable_degrade_ok",
] as const satisfies ReadonlyArray<keyof PersistedSessionOptions>;

function hasPersistedSessionOptions(options: PersistedSessionOptions): boolean {
  return PERSISTED_CONTENT_KEYS.some((key) => options[key] !== undefined);
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
