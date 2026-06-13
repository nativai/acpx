import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  hasKnownDeadAccounts,
  hasKnownDeadSubs,
  isAccountKnownDead,
  isSubscriptionKnownDead,
} from "../config/known-dead-subscriptions.js";
import {
  ensureProfileOsHarnessProvisioning,
  registryMayConfigureProvisioning,
  type ProvisioningWarningHandler,
} from "../config/os-harness-provisioning.js";
import {
  buildClaudeHomeMap,
  findProfile,
  getValidEffortsForProfile,
  loadProfileRegistry,
  transcriptAnchorDir,
  type ChatGptProfileEntry,
  type ClaudeHomeProfileEntry,
  type OpenRouterProfileEntry,
  type ProfileEntry,
  type ProfileRegistry,
  type SubscriptionProfileEntry,
} from "../config/profiles.js";
import type { SubscriptionLookupOptions } from "../config/subscriptions.js";
import {
  chooseSubscriptionConfigDir,
  findSubscription,
  loadSubscriptionRegistry,
  subscriptionConfigDirExists,
} from "../config/subscriptions.js";
import type {
  ConfigDirChoice,
  SubscriptionEntry,
  SubscriptionRegistry,
} from "../config/subscriptions.js";
import type { AcpClientOptions } from "../types.js";
import { isClaudePtyAgentCommand } from "./agent-command.js";
import { splitCommandLine } from "./client-process.js";
import { isCodexAcpCommand } from "./codex-compat.js";
import type { ShimHandle } from "./openrouter-shim.js";
import { spawnOpenRouterShim } from "./openrouter-shim.js";

const AUTH_ENV_PREFIX = "ACPX_AUTH_";
export const ACPX_EFFECTIVE_PROFILE_ENV = "ACPX_EFFECTIVE_PROFILE";
export const ACPX_EFFECTIVE_ACCOUNT_ENV = "ACPX_EFFECTIVE_ACCOUNT";
export const ACPX_EFFECTIVE_ADAPTER_ENV = "ACPX_EFFECTIVE_ADAPTER";
export const ACPX_EFFECTIVE_AUTH_MODE_ENV = "ACPX_EFFECTIVE_AUTH_MODE";
export const ACPX_EFFECTIVE_ANCHOR_ENV = "ACPX_EFFECTIVE_ANCHOR";

export type EffectiveAccountMetadata = {
  effectiveAccount: string;
  effectiveProfile?: string;
  effectiveAdapter?: string;
  effectiveAuthMode?: string;
  effectiveAnchor?: string;
  effectiveResolutionMethod?: "path" | "selection";
};

/**
 * The claude-pty bridge's published session/new `_meta` selector key
 * (independent-claude-acp). This exact string is the bridge interface —
 * never introduce a second name.
 */
export const INDEPENDENT_CLAUDE_HOME_META_KEY = "independent-claude-acp/home";

/** The bridge's server-side HOME allow-list env (JSON {id → abs home path}). */
export const INDEPENDENT_CLAUDE_HOME_MAP_ENV = "INDEPENDENT_CLAUDE_HOME_MAP";

function toEnvToken(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function nonEmptyEnvString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function effectiveResolutionMethod(authMode: string | undefined): "path" | "selection" | undefined {
  if (authMode === undefined) {
    return undefined;
  }
  return authMode === "openrouter" ? "selection" : "path";
}

export function effectiveAccountMetadataFromEnv(
  env: NodeJS.ProcessEnv,
): EffectiveAccountMetadata | undefined {
  const effectiveAccount = nonEmptyEnvString(env[ACPX_EFFECTIVE_ACCOUNT_ENV]);
  if (effectiveAccount === undefined) {
    return undefined;
  }
  const effectiveAuthMode = nonEmptyEnvString(env[ACPX_EFFECTIVE_AUTH_MODE_ENV]);
  return {
    effectiveAccount,
    ...(nonEmptyEnvString(env[ACPX_EFFECTIVE_PROFILE_ENV]) !== undefined
      ? { effectiveProfile: nonEmptyEnvString(env[ACPX_EFFECTIVE_PROFILE_ENV]) }
      : {}),
    ...(nonEmptyEnvString(env[ACPX_EFFECTIVE_ADAPTER_ENV]) !== undefined
      ? { effectiveAdapter: nonEmptyEnvString(env[ACPX_EFFECTIVE_ADAPTER_ENV]) }
      : {}),
    ...(effectiveAuthMode !== undefined ? { effectiveAuthMode } : {}),
    ...(nonEmptyEnvString(env[ACPX_EFFECTIVE_ANCHOR_ENV]) !== undefined
      ? { effectiveAnchor: nonEmptyEnvString(env[ACPX_EFFECTIVE_ANCHOR_ENV]) }
      : {}),
    ...(effectiveResolutionMethod(effectiveAuthMode) !== undefined
      ? { effectiveResolutionMethod: effectiveResolutionMethod(effectiveAuthMode) }
      : {}),
  };
}

function buildAuthEnvKey(methodId: string): string | undefined {
  const token = toEnvToken(methodId);
  return token.length > 0 ? `${AUTH_ENV_PREFIX}${token}` : undefined;
}

const authEnvKeyCache = new Map<string, string | undefined>();

function authEnvKey(methodId: string): string | undefined {
  const cached = authEnvKeyCache.get(methodId);
  if (cached !== undefined) {
    return cached;
  }
  const key = buildAuthEnvKey(methodId);
  authEnvKeyCache.set(methodId, key);
  return key;
}

export function readEnvCredential(methodId: string): string | undefined {
  const key = authEnvKey(methodId);
  if (!key) {
    return undefined;
  }
  const value = process.env[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function promotePrefixedAuthEnvironment(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(AUTH_ENV_PREFIX)) {
      continue;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }

    const normalized = key.slice(AUTH_ENV_PREFIX.length);
    if (!normalized || env[normalized] != null) {
      continue;
    }

    env[normalized] = value;
  }
}

const DEFAULT_ACPX_UI_BASE_URL = "https://acpx.devbox.nativai.de";

export function resolveAcpxUiBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.ACPX_UI_BASE_URL?.trim();
  const base = raw && raw.length > 0 ? raw : DEFAULT_ACPX_UI_BASE_URL;
  return base.replace(/\/+$/, "");
}

export type AgentSessionContext = {
  acpxRecordId: string;
  parentSessionId?: string | null;
  taskFolder?: string | null;
  agentFolder?: string | null;
  /**
   * Selected Claude subscription id (from ~/.acpx/subscriptions/registry.json).
   * When set and resolvable, buildAgentEnvironment points the adapter at that
   * subscription's CLAUDE_CONFIG_DIR. Unset/unknown ⇒ today's behavior (global
   * ~/.claude). Mirrors how per-session `model` flows from the session record.
   */
  subscriptionId?: string | null;
  /**
   * Profile id from session_options.profile — takes priority over subscriptionId
   * when set. The profile-based auth is applied asynchronously after the
   * synchronous env build (see applyProfileAuth in client.ts usage).
   */
  profileId?: string | null;
  /**
   * Per-session reasoning effort override. Overrides profile.reasoningEffort when
   * set. For openrouter profiles only — passed to spawnOpenRouterShim via the
   * shim's OR_REASONING_EFFORT env var. Must be in the profile's valid effort set.
   */
  reasoningEffort?: string | null;
};

// eslint-disable-next-line complexity -- fork integration function; intentionally over budget, refactor would risk verified merge semantics
function buildAgentEnvironment(
  authCredentials: Record<string, string> | undefined,
  sessionContext?: AgentSessionContext,
  lookupOptions?: SubscriptionLookupOptions,
  agentCommand?: string,
  onProvisioningWarning?: ProvisioningWarningHandler,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  promotePrefixedAuthEnvironment(env);
  const baseUrl = resolveAcpxUiBaseUrl(env);
  if (sessionContext && typeof sessionContext.acpxRecordId === "string") {
    const trimmed = sessionContext.acpxRecordId.trim();
    if (trimmed.length > 0) {
      env.ACPX_SESSION_URL = `${baseUrl}/?session=${trimmed}`;
    }
  }
  if (sessionContext && typeof sessionContext.parentSessionId === "string") {
    const trimmedParent = sessionContext.parentSessionId.trim();
    if (trimmedParent.length > 0) {
      env.ACPX_PARENT_SESSION_URL = `${baseUrl}/?session=${trimmedParent}`;
    }
  }
  if (sessionContext && typeof sessionContext.taskFolder === "string") {
    const trimmedTaskFolder = sessionContext.taskFolder.trim();
    if (trimmedTaskFolder.length > 0) {
      env.ACPX_TASK_FOLDER = trimmedTaskFolder;
    }
  }
  if (sessionContext && typeof sessionContext.agentFolder === "string") {
    const trimmedAgentFolder = sessionContext.agentFolder.trim();
    if (trimmedAgentFolder.length > 0) {
      env.ACPX_AGENT_FOLDER = trimmedAgentFolder;
    }
  }
  // When a profileId is set the async applyProfileAuth path (called from
  // client.ts after this synchronous env build) handles all auth env setup.
  // Skip subscription resolution here to avoid clobbering what applyProfileAuth
  // will write. Subscription-only sessions (no profileId) continue to use the
  // existing synchronous path below, byte-identical to pre-profile behavior.
  // For the claude-pty bridge agent, subscription configDir resolution does not
  // apply at all: an explicit --subscription is rejected (setup-tokens would
  // wedge interactive Claude at the login picker) and the unselected default
  // is skipped silently (no CLAUDE_CONFIG_DIR, no "no subscription selected"
  // banner — the bridge owns auth via its HOME selector).
  if (!sessionContext?.profileId?.trim()) {
    if (agentCommand !== undefined && isClaudePtyAgentCommand(agentCommand)) {
      rejectExplicitSubscriptionForClaudePty(sessionContext?.subscriptionId);
    } else {
      applySubscriptionConfigDir(env, sessionContext?.subscriptionId ?? null, lookupOptions);
      ensureProvisioningForResolvedSubscription(env, lookupOptions, onProvisioningWarning);
    }
  }
  if (!authCredentials) {
    return env;
  }

  for (const [methodId, credential] of Object.entries(authCredentials)) {
    assignAuthCredentialEnv(env, methodId, credential);
  }

  return env;
}

function ensureProvisioningForResolvedSubscription(
  env: NodeJS.ProcessEnv,
  lookupOptions?: SubscriptionLookupOptions,
  onProvisioningWarning?: ProvisioningWarningHandler,
): void {
  if (!env[ACPX_EFFECTIVE_PROFILE_ENV] || !registryMayConfigureProvisioning(lookupOptions)) {
    return;
  }
  const registry = loadProfileRegistry(lookupOptions);
  const profile = findProfile(env[ACPX_EFFECTIVE_PROFILE_ENV], registry);
  if (!profile) {
    return;
  }
  ensureProfileOsHarnessProvisioning({
    registry,
    profile,
    env,
    onWarning: onProvisioningWarning,
  });
}

type ResolvedSubscription = {
  registry: SubscriptionRegistry;
  choice: ConfigDirChoice;
  defaultId: string | undefined;
};

type EffectiveAccountStamp = {
  profileId: string;
  account: string;
  adapter: string;
  authMode: string;
  anchor: string;
};

function normalizedFsPath(value: string): string {
  return resolvePath(value);
}

function findSubscriptionByConfigDir(
  configDir: string,
  registry: SubscriptionRegistry,
): SubscriptionEntry | undefined {
  const normalized = normalizedFsPath(configDir);
  return registry.subscriptions.find((entry) => normalizedFsPath(entry.configDir) === normalized);
}

function findSubscriptionProfileByConfigDir(
  configDir: string,
  registry: ProfileRegistry,
): ProfileEntry | undefined {
  const normalized = normalizedFsPath(configDir);
  return registry.profiles.find(
    (entry) =>
      entry.authMode === "subscription" && normalizedFsPath(entry.credentialSource) === normalized,
  );
}

function findClaudeHomeProfileByAnchor(
  anchor: string,
  registry: ProfileRegistry,
): ProfileEntry | undefined {
  const normalized = normalizedFsPath(anchor);
  return registry.profiles.find((entry) => {
    if (entry.authMode !== "claude-home") {
      return false;
    }
    const profileAnchor = transcriptAnchorDir(entry);
    return profileAnchor !== null && normalizedFsPath(profileAnchor) === normalized;
  });
}

function findChatGptProfileByCodexHome(
  codexHome: string,
  registry: ProfileRegistry,
): ProfileEntry | undefined {
  const normalized = normalizedFsPath(codexHome);
  return registry.profiles.find(
    (entry) => entry.authMode === "chatgpt" && normalizedFsPath(entry.codexHome) === normalized,
  );
}

function stampEffectiveAccount(env: NodeJS.ProcessEnv, stamp: EffectiveAccountStamp): void {
  env.ACPX_SUBSCRIPTION = stamp.profileId;
  env[ACPX_EFFECTIVE_PROFILE_ENV] = stamp.profileId;
  env[ACPX_EFFECTIVE_ACCOUNT_ENV] = stamp.account;
  env[ACPX_EFFECTIVE_ADAPTER_ENV] = stamp.adapter;
  env[ACPX_EFFECTIVE_AUTH_MODE_ENV] = stamp.authMode;
  env[ACPX_EFFECTIVE_ANCHOR_ENV] = stamp.anchor;
}

function throwAccountMismatch(params: {
  expectedAccount: string;
  selectionKind: "subscription" | "profile";
  selectionId: string;
  physicalAccount: string;
  anchor: string;
}): never {
  throw new Error(
    `[acpx] recorded account "${params.expectedAccount}" for ${params.selectionKind} "${params.selectionId}" ` +
      `does not match the physically resolved account "${params.physicalAccount}" at ${params.anchor}; ` +
      `refusing to spawn on the wrong account`,
  );
}

function assertPhysicalAccount(params: {
  expectedAccount: string;
  selectionKind: "subscription" | "profile";
  selectionId: string;
  physicalAccount: string;
  anchor: string;
}): void {
  if (params.physicalAccount !== params.expectedAccount) {
    throwAccountMismatch(params);
  }
}

function verifySubscriptionEffectiveAccount(
  env: NodeJS.ProcessEnv,
  expectedEntry: SubscriptionEntry,
  registry: SubscriptionRegistry,
  configDir: string,
): void {
  const physicalEntry = findSubscriptionByConfigDir(configDir, registry) ?? expectedEntry;
  assertPhysicalAccount({
    expectedAccount: expectedEntry.account,
    selectionKind: "subscription",
    selectionId: expectedEntry.id,
    physicalAccount: physicalEntry.account,
    anchor: configDir,
  });
  stampEffectiveAccount(env, {
    profileId: expectedEntry.id,
    account: expectedEntry.account,
    adapter: "claude",
    authMode: "subscription",
    anchor: configDir,
  });
}

function stampProfileEffectiveAccount(
  env: NodeJS.ProcessEnv,
  profile: ProfileEntry,
  anchor: string,
): void {
  stampEffectiveAccount(env, {
    profileId: profile.id,
    account: profile.account,
    adapter: profile.adapter,
    authMode: profile.authMode,
    anchor,
  });
}

function verifySubscriptionProfileEffectiveAccount(
  env: NodeJS.ProcessEnv,
  expectedProfile: SubscriptionProfileEntry,
  registry: ProfileRegistry,
): void {
  const configDir = env.CLAUDE_CONFIG_DIR;
  if (!configDir) {
    throw new Error(
      `[acpx] profile "${expectedProfile.id}" resolved as subscription but no CLAUDE_CONFIG_DIR was applied`,
    );
  }
  const physicalProfile =
    findSubscriptionProfileByConfigDir(configDir, registry) ?? expectedProfile;
  assertPhysicalAccount({
    expectedAccount: expectedProfile.account,
    selectionKind: "profile",
    selectionId: expectedProfile.id,
    physicalAccount: physicalProfile.account,
    anchor: configDir,
  });
  stampProfileEffectiveAccount(env, expectedProfile, configDir);
}

function verifyClaudeHomeProfileEffectiveAccount(
  env: NodeJS.ProcessEnv,
  expectedProfile: ClaudeHomeProfileEntry,
  registry: ProfileRegistry,
): void {
  const anchor = transcriptAnchorDir(expectedProfile) ?? expectedProfile.homePath;
  const physicalProfile = findClaudeHomeProfileByAnchor(anchor, registry) ?? expectedProfile;
  assertPhysicalAccount({
    expectedAccount: expectedProfile.account,
    selectionKind: "profile",
    selectionId: expectedProfile.id,
    physicalAccount: physicalProfile.account,
    anchor,
  });
  stampProfileEffectiveAccount(env, expectedProfile, anchor);
}

function verifyChatGptProfileEffectiveAccount(
  env: NodeJS.ProcessEnv,
  expectedProfile: ChatGptProfileEntry,
  registry: ProfileRegistry,
): void {
  const codexHome = env.CODEX_HOME ?? expectedProfile.codexHome;
  const physicalProfile = findChatGptProfileByCodexHome(codexHome, registry) ?? expectedProfile;
  assertPhysicalAccount({
    expectedAccount: expectedProfile.account,
    selectionKind: "profile",
    selectionId: expectedProfile.id,
    physicalAccount: physicalProfile.account,
    anchor: codexHome,
  });
  stampProfileEffectiveAccount(env, expectedProfile, codexHome);
}

function verifyProfileEffectiveAccount(
  env: NodeJS.ProcessEnv,
  expectedProfile: ProfileEntry,
  registry: ProfileRegistry,
): void {
  switch (expectedProfile.authMode) {
    case "subscription":
      return verifySubscriptionProfileEffectiveAccount(env, expectedProfile, registry);
    case "claude-home":
      return verifyClaudeHomeProfileEffectiveAccount(env, expectedProfile, registry);
    case "chatgpt":
      return verifyChatGptProfileEffectiveAccount(env, expectedProfile, registry);
    case "openrouter":
      return stampProfileEffectiveAccount(env, expectedProfile, env.CLAUDE_CONFIG_DIR ?? "");
  }
}

// Load the registry and resolve the choice, emitting the legacy log lines. Returns
// undefined when there is no configDir to apply (no registry / unusable default /
// registry read failure) — i.e. the caller leaves CLAUDE_CONFIG_DIR unset.
function resolveSubscriptionChoice(
  explicitId: string | null | undefined,
  lookupOptions: SubscriptionLookupOptions | undefined,
): ResolvedSubscription | undefined {
  let resolved: ResolvedSubscription;
  try {
    const registry = loadSubscriptionRegistry(lookupOptions);
    resolved = {
      registry,
      defaultId: registry.default,
      choice: chooseSubscriptionConfigDir(explicitId, registry, subscriptionConfigDirExists),
    };
  } catch (error) {
    emitRegistryReadFailure(explicitId, error);
    return undefined;
  }
  if (resolved.choice.explicitRejection) {
    throw new Error(formatExplicitRejection(resolved.choice.explicitRejection));
  }
  return resolved.choice.configDir === undefined ? undefined : resolved;
}

type AppliedSubscriptionChoice = {
  resolvedId: string | undefined;
  configDir: string;
  substituted: boolean;
};

function applySubscriptionChoiceAvoidance(
  explicitId: string | null | undefined,
  resolved: ResolvedSubscription,
): AppliedSubscriptionChoice {
  const baseResolvedId =
    resolved.choice.source === "explicit" ? explicitId?.trim() : resolved.defaultId;
  return applyPreSpawnAvoidance(
    resolved.registry,
    baseResolvedId,
    resolved.choice.configDir as string,
    resolved.choice.source !== "explicit",
  );
}

function maybeEmitDefaultApplied(
  resolved: ResolvedSubscription,
  applied: AppliedSubscriptionChoice,
): void {
  if (resolved.choice.source !== "default" || !resolved.defaultId || applied.substituted) {
    return;
  }
  emitDefaultApplied(
    resolved.defaultId,
    resolved.choice.configDir as string,
    resolved.choice.explicitRejection !== undefined,
  );
}

function verifyAppliedSubscription(
  env: NodeJS.ProcessEnv,
  resolved: ResolvedSubscription,
  applied: AppliedSubscriptionChoice,
): void {
  const expectedEntry = applied.resolvedId
    ? findSubscription(applied.resolvedId, resolved.registry)
    : undefined;
  if (expectedEntry) {
    verifySubscriptionEffectiveAccount(env, expectedEntry, resolved.registry, applied.configDir);
  }
}

// Resolve which CLAUDE_CONFIG_DIR an adapter spawn should use and set it on the
// env. This is the SINGLE resolution point — every spawn path (create / recover /
// keepwarm) routes through buildAgentEnvironment, so they all inherit it. Order
// (see chooseSubscriptionConfigDir): explicit valid id → registry default →
// raw ~/.claude. An explicit id we can't honor logs the legacy line and falls
// through the same default→raw chain instead of crashing the spawn. Also sets
// ACPX_SUBSCRIPTION to the resolved id (E.2) and applies process-local
// known-dead avoidance (§4.1.4) before committing the dir.
//
// BACKWARD SAFETY: on a box with no registry / no usable default, an UNSELECTED
// spawn produces no configDir and ZERO stderr (byte-identical to pre-default
// behavior); the legacy rejection lines for an explicit id are emitted verbatim.
// The new default-applied note only ever fires on a box with a usable default.
function applySubscriptionConfigDir(
  env: NodeJS.ProcessEnv,
  explicitId: string | null | undefined,
  lookupOptions?: SubscriptionLookupOptions,
): void {
  const resolved = resolveSubscriptionChoice(explicitId, lookupOptions);
  if (!resolved) {
    return;
  }
  const applied = applySubscriptionChoiceAvoidance(explicitId, resolved);

  env.CLAUDE_CONFIG_DIR = applied.configDir;
  // Export the RESOLVED subscription id so the agent (and its children) can read
  // its own sub and inherit it (ACPX_SUBSCRIPTION, beside ACPX_TASK_FOLDER).
  if (applied.resolvedId) {
    env.ACPX_SUBSCRIPTION = applied.resolvedId;
  }
  // Only emit the "default applied" note when we used the default verbatim (no
  // failover substitution kicked in), to keep the existing message accurate.
  maybeEmitDefaultApplied(resolved, applied);
  verifyAppliedSubscription(env, resolved, applied);
}

// Pre-spawn avoidance (§4.1.4): if the resolved sub failed over earlier in this
// process, substitute the first registered, dir-present sub that is NOT
// known-dead — a cheap registry walk, no probe. Best-effort; the durable signal
// is the persisted record (which failover already updated). When nothing is
// known-dead this is a no-op that returns the inputs unchanged (backward safety).
function applyPreSpawnAvoidance(
  registry: SubscriptionRegistry,
  resolvedId: string | undefined,
  configDir: string,
  allowSubstitution = true,
): { resolvedId: string | undefined; configDir: string; substituted: boolean } {
  const target = avoidanceTarget(registry, resolvedId, allowSubstitution);
  if (!target) {
    return { resolvedId, configDir, substituted: false };
  }
  const healthy = firstHealthySubscription(registry, target.id, target.account);
  if (!healthy) {
    return { resolvedId, configDir, substituted: false };
  }
  process.stderr.write(
    `[acpx] subscription "${target.id}" recently failed over; using "${healthy.id}" for this spawn (CLAUDE_CONFIG_DIR=${healthy.configDir})\n`,
  );
  return { resolvedId: healthy.id, configDir: healthy.configDir, substituted: true };
}

function avoidanceTarget(
  registry: SubscriptionRegistry,
  resolvedId: string | undefined,
  allowSubstitution: boolean,
): { id: string; account?: string } | undefined {
  if (!allowSubstitution || !resolvedId || !hasKnownDeadCredentialState()) {
    return undefined;
  }
  const failedEntry = findSubscription(resolvedId, registry);
  if (!isResolvedSubscriptionDead(resolvedId, failedEntry)) {
    return undefined;
  }
  return { id: resolvedId, ...(failedEntry !== undefined ? { account: failedEntry.account } : {}) };
}

function hasKnownDeadCredentialState(): boolean {
  return hasKnownDeadSubs() || hasKnownDeadAccounts();
}

function isResolvedSubscriptionDead(
  resolvedId: string,
  entry: SubscriptionEntry | undefined,
): boolean {
  return (
    isSubscriptionKnownDead(resolvedId) ||
    (entry !== undefined && isAccountKnownDead(entry.account))
  );
}

// First registered subscription whose dir exists and is not known-dead, skipping
// `avoidId`. Pure registry walk (no probe) for pre-spawn avoidance (§4.1.4).
function firstHealthySubscription(
  registry: SubscriptionRegistry,
  avoidId: string,
  avoidAccount?: string,
): { id: string; configDir: string } | undefined {
  for (const entry of registry.subscriptions) {
    if (
      entry.id === avoidId ||
      entry.account === avoidAccount ||
      isSubscriptionKnownDead(entry.id) ||
      isAccountKnownDead(entry.account)
    ) {
      continue;
    }
    if (subscriptionConfigDirExists(entry.configDir)) {
      return { id: entry.id, configDir: entry.configDir };
    }
  }
  return undefined;
}

// loadSubscriptionRegistry never throws; this defends the explicit-id path
// against a surprising fs error from the existence check, matching the legacy
// behavior (and staying silent for unselected spawns, which never logged here).
function emitRegistryReadFailure(explicitId: string | null | undefined, error: unknown): void {
  const trimmed = explicitId?.trim();
  if (!trimmed) {
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `[acpx] failed to read subscription registry for "${trimmed}" (${message}); using default Claude config\n`,
  );
}

// Explicit selections are apply-or-loud. Falling through to a default would make
// the session record lie about the account that physically ran the agent.
function formatExplicitRejection(
  rejection: NonNullable<ConfigDirChoice["explicitRejection"]>,
): string {
  if (rejection.kind === "unknown") {
    return `[acpx] subscription "${rejection.id}" not found in registry; refusing to spawn on a different account`;
  }
  return `[acpx] subscription "${rejection.id}" configDir not found at ${rejection.configDir}; refusing to spawn on a different account`;
}

// NEW note — only reachable when a usable default produced the configDir, i.e.
// never on a no-default box.
function emitDefaultApplied(defaultId: string, configDir: string, viaRejection: boolean): void {
  const lead = viaRejection
    ? `using registry default "${defaultId}" instead`
    : `no subscription selected; using registry default "${defaultId}"`;
  process.stderr.write(`[acpx] ${lead} (CLAUDE_CONFIG_DIR=${configDir})\n`);
}

function assignAuthCredentialEnv(
  env: NodeJS.ProcessEnv,
  methodId: string,
  credential: string,
): void {
  if (typeof credential !== "string" || credential.trim().length === 0) {
    return;
  }

  if (!methodId.includes("=") && !methodId.includes("\u0000") && env[methodId] == null) {
    env[methodId] = credential;
  }

  const normalized = toEnvToken(methodId);
  if (normalized) {
    assignIfMissing(env, `${AUTH_ENV_PREFIX}${normalized}`, credential);
    assignIfMissing(env, normalized, credential);
  }
}

function assignIfMissing(env: NodeJS.ProcessEnv, key: string, value: string): void {
  if (env[key] == null) {
    env[key] = value;
  }
}

export function resolveConfiguredAuthCredential(
  methodId: string,
  authCredentials: AcpClientOptions["authCredentials"],
): string | undefined {
  const configCredentials = authCredentials ?? {};
  return configCredentials[methodId] ?? configCredentials[toEnvToken(methodId)];
}

/**
 * Apply profile-based authentication to the env dict and return a ShimHandle
 * for openrouter profiles (caller must stop it when the session closes), or
 * null for subscription profiles. Called asynchronously after the synchronous
 * env build so the shim port is known before the adapter process spawns.
 *
 * reasoningEffortOverride: per-session effort from --reasoning-effort; overrides
 * the profile's default reasoningEffort for openrouter profiles. Validated
 * against the profile's valid effort set — throws on mismatch so the caller
 * gets a clear error rather than a silently wrong effort level.
 *
 * Constraint: openRouterApiKey must never appear in logs or process output.
 */
// Validate that an effort override is in the profile's valid set; throws with a
// clear, user-facing error listing the valid levels on mismatch.
function validateOpenRouterEffort(
  profileId: string,
  profile: ReturnType<typeof findProfile> & object,
  effortOverride: string | undefined,
): void {
  if (!effortOverride) {
    return;
  }
  const validEfforts = getValidEffortsForProfile(profile);
  if (!validEfforts) {
    throw new Error(
      `[acpx] profile "${profileId}" does not support reasoning (reasoningSupported is not set). ` +
        `Remove --reasoning-effort to use this profile without reasoning.`,
    );
  }
  if (!validEfforts.includes(effortOverride)) {
    throw new Error(
      `[acpx] --reasoning-effort "${effortOverride}" is not valid for OpenRouter profile "${profileId}". ` +
        `Valid levels: ${validEfforts.join(", ")}`,
    );
  }
}

// Fail-fast guard for v1 subscription selection on the claude-pty bridge.
// Unselected spawns pass silently (the bridge owns auth via its HOME selector);
// an explicit id is a configuration error worth stopping the spawn over —
// subscription configDirs hold headless setup-tokens, which interactive Claude
// rejects at its login picker (a wedged TUI, not a clean error).
function rejectExplicitSubscriptionForClaudePty(subscriptionId: string | null | undefined): void {
  const trimmed = subscriptionId?.trim();
  if (!trimmed) {
    return;
  }
  throw new Error(
    `[acpx] subscription "${trimmed}" cannot be used with the claude-pty bridge agent: ` +
      `subscription configDirs hold headless setup-tokens, which interactive Claude does not accept. ` +
      `Use a claude-home profile instead (--profile <id>).`,
  );
}

function assertClaudePtyProfileCompatibility(params: {
  profileId: string;
  profile: ProfileEntry;
  agentCommand: string;
  claudePty: boolean;
}): void {
  if (params.profile.authMode === "claude-home" && !params.claudePty) {
    throw new Error(
      `[acpx] profile "${params.profileId}" (authMode "claude-home") requires the claude-pty bridge agent; ` +
        `this session's agent command is "${params.agentCommand}". ` +
        `Create the session with the claude-pty agent to use this profile.`,
    );
  }
  if (params.profile.authMode !== "claude-home" && params.claudePty) {
    throw new Error(
      `[acpx] profile "${params.profileId}" (authMode "${params.profile.authMode}") cannot be used with the ` +
        `claude-pty bridge agent: its credentials are not an interactive Claude login ` +
        `(interactive Claude would wedge at the login picker). Use a claude-home profile.`,
    );
  }
}

function assertCodexProfileCompatibility(params: {
  profileId: string;
  profile: ProfileEntry;
  agentCommand: string;
  codex: boolean;
}): void {
  if (params.profile.authMode === "chatgpt" && !params.codex) {
    throw new Error(
      `[acpx] profile "${params.profileId}" (authMode "chatgpt") requires the codex adapter; ` +
        `this session's agent command is "${params.agentCommand}". Create the session with the codex agent.`,
    );
  }
  if (params.profile.authMode !== "chatgpt" && params.codex) {
    throw new Error(
      `[acpx] profile "${params.profileId}" (authMode "${params.profile.authMode}") cannot be used with the ` +
        `codex adapter. Use a chatgpt profile for codex auth.`,
    );
  }
}

// Both-directions profile↔agent compatibility gate, evaluated on EVERY spawn
// (create / recover / keepwarm — applyProfileAuth is on the single resolution
// path). claude-home profiles only work on the claude-pty bridge (interactive
// HOME logins); every other authMode must stay off the bridge (their
// credentials are not an interactive Claude login). Skipped when the caller
// cannot supply the agent command (no silent false negatives — every
// production spawn path passes it).
function validateProfileAgentCompatibility(
  profileId: string,
  profile: ProfileEntry,
  agentCommand: string | undefined,
): void {
  if (agentCommand === undefined) {
    return;
  }
  const split = splitCommandLine(agentCommand);
  const claudePty = isClaudePtyAgentCommand(agentCommand);
  const codex = isCodexAcpCommand(split.command, split.args);
  assertClaudePtyProfileCompatibility({ profileId, profile, agentCommand, claudePty });
  assertCodexProfileCompatibility({ profileId, profile, agentCommand, codex });
}

// claude-home branch of applyProfileAuth: the bridge owns auth via its HOME
// selector. Inject the full allow-list map (ALL claude-home profiles in the
// registry) so the bridge's unknown-selector diagnostics stay meaningful; the
// per-session selection travels as session/new _meta (buildClaudeHomeSelectorMeta),
// never as env. No CLAUDE_CONFIG_DIR: subscription configDir resolution does
// not apply to interactive-home credentials (the bridge strips leaked SDK env
// defensively, but acpx must not emit it). ACPX_SUBSCRIPTION is re-stamped
// later as the unified selection id for child-spawn compatibility. The map
// holds paths only, never credential contents.
function applyClaudeHomeProfileAuth(env: NodeJS.ProcessEnv, registry: ProfileRegistry): void {
  env[INDEPENDENT_CLAUDE_HOME_MAP_ENV] = JSON.stringify(buildClaudeHomeMap(registry));
  delete env.CLAUDE_CONFIG_DIR;
  delete env.ACPX_SUBSCRIPTION;
}

function applyChatGptProfileAuth(env: NodeJS.ProcessEnv, profile: ProfileEntry): void {
  if (profile.authMode !== "chatgpt") {
    return;
  }
  env.CODEX_HOME = profile.codexHome;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.ACPX_SUBSCRIPTION;
  delete env[INDEPENDENT_CLAUDE_HOME_MAP_ENV];
}

/**
 * The `_meta` fragment selecting the bridge HOME for a claude-home profile
 * session: { "independent-claude-acp/home": <profile id> }. Undefined for
 * non-claude-home (or unknown) profiles. Re-resolved from the registry on
 * every call, so each spawn stays record-driven (restart safety): a missing
 * selector would NOT error bridge-side — it silently falls back to the box
 * default HOME (wrong credentials) — so callers attach this on every
 * session/new (and session/load, for when the bridge advertises loadSession).
 */
export function buildClaudeHomeSelectorMeta(
  profileId: string | null | undefined,
  lookupOptions?: SubscriptionLookupOptions,
): Record<string, unknown> | undefined {
  const trimmed = profileId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const profile = findProfile(trimmed, loadProfileRegistry(lookupOptions));
  if (profile?.authMode !== "claude-home") {
    return undefined;
  }
  return { [INDEPENDENT_CLAUDE_HOME_META_KEY]: trimmed };
}

// Handles the openrouter authMode branch of applyProfileAuth.
function resolveOpenRouterApiKey(profile: OpenRouterProfileEntry): string | undefined {
  if (profile.openRouterApiKeyEnv) {
    const envValue = process.env[profile.openRouterApiKeyEnv];
    if (typeof envValue === "string" && envValue.trim().length > 0) {
      return envValue;
    }
  }
  return profile.openRouterApiKey;
}

async function applyOpenRouterProfileAuth(
  env: NodeJS.ProcessEnv,
  profileId: string,
  sessionId: string,
  profile: OpenRouterProfileEntry,
  reasoningEffortOverride: string | null | undefined,
): Promise<ShimHandle | null> {
  const apiKey = resolveOpenRouterApiKey(profile);
  const model = profile.model;
  if (!apiKey || !model) {
    throw new Error(
      `[acpx] profile "${profileId}" is missing OpenRouter credentials or model; refusing to spawn under a different account`,
    );
  }

  // Validate then resolve effort: per-session override > profile default.
  const trimmedEffort = reasoningEffortOverride?.trim() || undefined;
  validateOpenRouterEffort(profileId, profile, trimmedEffort);
  const resolvedEffort = trimmedEffort ?? profile.reasoningEffort;

  // Isolate Claude config in a per-session temp dir (no OAuth inheritance).
  const configDir = join(tmpdir(), `or-${sessionId}`);
  mkdirSync(configDir, { recursive: true });
  env.CLAUDE_CONFIG_DIR = configDir;

  // Start the model-rewrite shim; apiKey never appears in logs.
  const shim = await spawnOpenRouterShim(apiKey, model, resolvedEffort);

  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${shim.port}`;
  // Bypass the Bun availability / key check in claude-agent-acp.
  env.ANTHROPIC_AUTH_TOKEN = " ";
  // Remove any custom headers set by the subscription path —
  // the shim injects Authorization itself.
  delete env.ANTHROPIC_CUSTOM_HEADERS;

  return shim;
}

export async function applyProfileAuth(
  env: NodeJS.ProcessEnv,
  profileId: string,
  sessionId: string,
  reasoningEffortOverride?: string | null,
  lookupOptions?: SubscriptionLookupOptions,
  agentCommand?: string,
  onProvisioningWarning?: ProvisioningWarningHandler,
): Promise<ShimHandle | null> {
  const trimmedId = profileId.trim();
  if (!trimmedId) {
    return null;
  }
  const registry = loadProfileRegistry(lookupOptions);
  const profile = findProfile(trimmedId, registry);
  if (!profile) {
    throw new Error(
      `[acpx] profile "${trimmedId}" not found in registry; refusing to spawn under a different account. ` +
        `Restore the profile in ~/.acpx/subscriptions/registry.json or recreate the session.`,
    );
  }

  validateProfileAgentCompatibility(trimmedId, profile, agentCommand);

  if (profile.authMode === "claude-home") {
    applyClaudeHomeProfileAuth(env, registry);
    verifyProfileEffectiveAccount(env, profile, registry);
    ensureProfileOsHarnessProvisioning({
      registry,
      profile,
      env,
      onWarning: onProvisioningWarning,
    });
    return null;
  }

  if (profile.authMode === "subscription") {
    // Behave exactly like applySubscriptionConfigDir for subscription profiles.
    applySubscriptionConfigDir(env, trimmedId, lookupOptions);
    verifyProfileEffectiveAccount(env, profile, registry);
    ensureProfileOsHarnessProvisioning({
      registry,
      profile,
      env,
      onWarning: onProvisioningWarning,
    });
    return null;
  }

  if (profile.authMode === "openrouter") {
    const shim = await applyOpenRouterProfileAuth(
      env,
      trimmedId,
      sessionId,
      profile,
      reasoningEffortOverride,
    );
    verifyProfileEffectiveAccount(env, profile, registry);
    ensureProfileOsHarnessProvisioning({
      registry,
      profile,
      env,
      onWarning: onProvisioningWarning,
    });
    return shim;
  }

  if (profile.authMode === "chatgpt") {
    applyChatGptProfileAuth(env, profile);
    verifyProfileEffectiveAccount(env, profile, registry);
    ensureProfileOsHarnessProvisioning({
      registry,
      profile,
      env,
      onWarning: onProvisioningWarning,
    });
    return null;
  }

  return null;
}

export function buildAgentSpawnOptions(
  cwd: string,
  authCredentials: Record<string, string> | undefined,
  sessionContext?: AgentSessionContext,
  lookupOptions?: SubscriptionLookupOptions,
  agentCommand?: string,
  onProvisioningWarning?: ProvisioningWarningHandler,
): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
} {
  return {
    cwd,
    env: buildAgentEnvironment(
      authCredentials,
      sessionContext,
      lookupOptions,
      agentCommand,
      onProvisioningWarning,
    ),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}
