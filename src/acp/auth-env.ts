import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
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
  isSubscriptionProfileLocked,
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
  isSubscriptionLocked,
  loadSubscriptionRegistry,
  subscriptionConfigDirExists,
} from "../config/subscriptions.js";
import type {
  ConfigDirChoice,
  SubscriptionEntry,
  SubscriptionRegistry,
} from "../config/subscriptions.js";
import { SubscriptionLockedError } from "../errors.js";
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

/**
 * The claude-pty bridge's session/new `_meta` key carrying the parent session's
 * acpx-ui URL (lineage). The bridge reads this (parentSessionUrlFromMeta) and
 * forwards it to the claude child as ACPX_PARENT_SESSION_URL so the child can
 * message its parent back. Unlike the SDK claude adapter (which inherits the
 * parent from the spawn PROCESS env), one bridge PROCESS serves many ACP
 * sessions, so the parent must be delivered PER session — via this `_meta` —
 * not via the process env. This exact string is the bridge interface. (FW-18)
 */
export const INDEPENDENT_CLAUDE_PARENT_SESSION_URL_META_KEY =
  "independent-claude-acp/parent-session-url";

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

/**
 * FW-20: derive the box's acpx-ui base URL from its K8s namespace. Each box runs
 * in namespace `dev-<box>` whose pods get a resolv.conf search domain
 * `dev-<box>.svc.cluster.local`; the box name maps to `https://acpx.<box>.nativai.de`.
 * Pure (content in, url out) so it is testable without touching the filesystem.
 * Returns undefined for non-cluster / unrecognized search domains.
 */
export function parseBoxBaseUrlFromResolvConf(resolvConf: string): string | undefined {
  const match = resolvConf.match(/^search\s+(\S+)/m);
  if (!match) {
    return undefined;
  }
  const nsMatch = match[1].match(/^dev-([a-z0-9-]+)\.svc\.cluster\.local$/i);
  const box = nsMatch?.[1];
  if (!box) {
    return undefined;
  }
  return `https://acpx.${box}.nativai.de`;
}

// Cache the namespace-derived base URL: /etc/resolv.conf does not change within a
// process. `null` = computed-and-absent (not-in-cluster); undefined = not computed.
let cachedBoxBaseUrl: string | null | undefined;

function deriveBoxBaseUrl(): string | undefined {
  if (cachedBoxBaseUrl !== undefined) {
    return cachedBoxBaseUrl ?? undefined;
  }
  let value: string | undefined;
  try {
    value = parseBoxBaseUrlFromResolvConf(readFileSync("/etc/resolv.conf", "utf8"));
  } catch {
    value = undefined;
  }
  cachedBoxBaseUrl = value ?? null;
  return value;
}

/**
 * The acpx-ui base URL for THIS box. Precedence (FW-20):
 *   1. explicit ACPX_UI_BASE_URL env (operator override / test seam)
 *   2. namespace-derived host (robust to restarts wiping per-box env — the bug:
 *      a missing ACPX_UI_BASE_URL on tubeyakker fell back to the devbox default,
 *      giving every agent the WRONG own/parent URL host)
 *   3. the hardcoded devbox default (non-cluster / unknown namespace)
 */
export function resolveAcpxUiBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.ACPX_UI_BASE_URL?.trim();
  const base = raw && raw.length > 0 ? raw : (deriveBoxBaseUrl() ?? DEFAULT_ACPX_UI_BASE_URL);
  return base.replace(/\/+$/, "");
}

/**
 * Absolute path to the acpx-shipped git hooks directory (repo-root `git-hooks/`),
 * resolved relative to the bundled dist entry (dist/cli.js → ../git-hooks). The
 * deployed acpx is a full git checkout, so the committed hook is present on disk.
 * Returns undefined if resolution somehow yields a non-absolute path (guarded so
 * we never activate core.hooksPath with a half-formed value).
 */
export function resolveAcpxHooksDir(): string | undefined {
  try {
    const dir = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "git-hooks");
    return isAbsolute(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Append one git config override via the additive GIT_CONFIG_COUNT/KEY_n/VALUE_n
 * env protocol (git ≥ 2.31), never clobbering a pre-existing count. This is the
 * `-c key=value`-style path — unlike GIT_CONFIG_GLOBAL it preserves the user's
 * global config (e.g. the `url.insteadOf` GitHub-token rewrite).
 */
function appendGitConfigEnv(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const parsed = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  const count = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  env[`GIT_CONFIG_KEY_${count}`] = key;
  env[`GIT_CONFIG_VALUE_${count}`] = value;
  env.GIT_CONFIG_COUNT = String(count + 1);
}

/**
 * Automatic commit attribution (brick fc36b374): make every git commit an
 * acpx-spawned agent authors carry the agent identity as the git author/committer,
 * and activate the shipped prepare-commit-msg hook (which appends `Session:` /
 * `Message:` trailers) via env-scoped core.hooksPath. Gated on a resolvable acpx
 * record id; no-op-safe — if any input is missing we skip that piece rather than
 * emit a half-formed value. Scope is exactly "processes acpx spawned": humans and
 * non-agent git are untouched (no global config, no repo .git/hooks change).
 */
function applyGitCommitAttribution(
  env: NodeJS.ProcessEnv,
  sessionContext: AgentSessionContext,
  baseUrl: string,
): void {
  const recordId = sessionContext.acpxRecordId?.trim();
  if (!recordId) {
    return;
  }
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return;
  }
  if (!host) {
    return;
  }
  const email = `${recordId}@${host}`;
  const name =
    nonEmptyEnvString(sessionContext.sessionName ?? undefined) ?? `acpx:${recordId.slice(0, 8)}`;
  env.GIT_AUTHOR_NAME = name;
  env.GIT_AUTHOR_EMAIL = email;
  env.GIT_COMMITTER_NAME = name;
  env.GIT_COMMITTER_EMAIL = email;
  const hooksDir = resolveAcpxHooksDir();
  if (hooksDir) {
    appendGitConfigEnv(env, "core.hooksPath", hooksDir);
  }
}

export type AgentSessionContext = {
  acpxRecordId: string;
  sessionName?: string | null;
  parentSessionId?: string | null;
  /**
   * The parent session's FULL acpx-ui URL (host + id), used for cross-machine
   * lineage. When the parent lives on another box, its bare id cannot identify
   * it locally — only the URL carries the host. Set from `--parent-session-url`
   * or the spawning agent's ACPX_SESSION_URL at creation. When absent, the
   * parent URL is derived from parentSessionId against the LOCAL base URL
   * (correct same-box). Carried into the bridge's session/new `_meta`. (FW-19)
   */
  parentSessionUrl?: string | null;
  taskFolder?: string | null;
  brick?: string | null;
  brickPath?: string | null;
  agentFolder?: string | null;
  /**
   * Selected Claude subscription id (from ~/.acpx/subscriptions/registry.json).
   * When set and resolvable, buildAgentEnvironment points the adapter at that
   * subscription's CLAUDE_CONFIG_DIR. Unset means raw global ~/.claude; registry
   * defaults are resolved earlier by the session binding layer, not here.
   * Mirrors how per-session `model` flows from the session record.
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
  // FW-07: never inherit stale acpx process context from {...process.env}
  // (e.g. a long-lived queue-owner that served a different session). Clear these,
  // then set only from THIS spawn context below so a bridge session can never
  // carry another session identity.
  delete env.ACPX_SESSION_URL;
  delete env.ACPX_PARENT_SESSION_URL;
  delete env.ACPX_SESSION_NAME;
  delete env.ACPX_TASK_FOLDER;
  delete env.ACPX_BRICK;
  delete env.ACPX_BRICK_PATH;
  delete env.ACPX_OWNER_LOG;
  const baseUrl = resolveAcpxUiBaseUrl(env);
  if (sessionContext && typeof sessionContext.acpxRecordId === "string") {
    const trimmed = sessionContext.acpxRecordId.trim();
    if (trimmed.length > 0) {
      env.ACPX_SESSION_URL = `${baseUrl}/?session=${trimmed}`;
    }
  }
  if (sessionContext && typeof sessionContext.sessionName === "string") {
    const trimmedName = sessionContext.sessionName.trim();
    if (trimmedName.length > 0) {
      env.ACPX_SESSION_NAME = trimmedName;
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
  if (sessionContext && typeof sessionContext.brick === "string") {
    const trimmedBrick = sessionContext.brick.trim();
    if (trimmedBrick.length > 0) {
      env.ACPX_BRICK = trimmedBrick;
      if (typeof sessionContext.brickPath === "string") {
        const trimmedBrickPath = sessionContext.brickPath.trim();
        if (trimmedBrickPath.length > 0) {
          env.ACPX_BRICK_PATH = trimmedBrickPath;
        }
      }
    }
  }
  if (sessionContext && typeof sessionContext.agentFolder === "string") {
    const trimmedAgentFolder = sessionContext.agentFolder.trim();
    if (trimmedAgentFolder.length > 0) {
      env.ACPX_AGENT_FOLDER = trimmedAgentFolder;
    }
  }
  if (sessionContext) {
    applyGitCommitAttribution(env, sessionContext, baseUrl);
  }
  // When a profileId is set the async applyProfileAuth path (called from
  // client.ts after this synchronous env build) handles all auth env setup.
  // Skip subscription resolution here to avoid clobbering what applyProfileAuth
  // will write. Subscription-only sessions (no profileId) continue to use this
  // synchronous path, but ONLY when the record carries a concrete subscription.
  // An unbound record deliberately stays raw here: registry defaults are
  // snapshotted onto sessions by default-account-binding before spawn, not
  // late-resolved inside the env builder.
  // For the claude-pty bridge agent, subscription configDir resolution does not
  // apply at all: an explicit --subscription is rejected (setup-tokens would
  // wedge interactive Claude at the login picker) and the unselected default
  // is skipped silently (no CLAUDE_CONFIG_DIR, no "no subscription selected"
  // banner — the bridge owns auth via its HOME selector).
  if (!sessionContext?.profileId?.trim()) {
    const subscriptionId = sessionContext?.subscriptionId?.trim();
    if (agentCommand !== undefined && isClaudePtyAgentCommand(agentCommand)) {
      rejectExplicitSubscriptionForClaudePty(subscriptionId);
    } else if (subscriptionId) {
      applySubscriptionConfigDir(env, subscriptionId, lookupOptions);
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
    if (resolved.choice.explicitRejection.kind === "locked") {
      throw new SubscriptionLockedError(resolved.choice.explicitRejection.id);
    }
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
    resolved.choice.resolvedId ??
    (resolved.choice.source === "explicit" ? explicitId?.trim() : resolved.defaultId);
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
  if (resolved.choice.resolvedId && resolved.choice.resolvedId !== resolved.defaultId) {
    process.stderr.write(
      `[acpx] registry default "${resolved.defaultId}" is locked; using unlocked subscription "${resolved.choice.resolvedId}" instead (CLAUDE_CONFIG_DIR=${resolved.choice.configDir})\n`,
    );
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

// Resolve which CLAUDE_CONFIG_DIR a concrete subscription selection should use
// and set it on the env. Normal spawn paths call this only with a stored
// subscription id; unbound sessions are bound earlier by
// default-account-binding. Also sets ACPX_SUBSCRIPTION to the resolved id (E.2)
// and applies process-local known-dead avoidance (§4.1.4) before committing the
// dir.
//
// BACKWARD SAFETY: the legacy rejection lines for an explicit id are emitted
// verbatim. The default-applied note remains only for legacy direct callers that
// still pass a null selection; buildAgentEnvironment no longer does that for an
// unbound session.
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
      isSubscriptionLocked(entry, registry) ||
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
  if (rejection.kind === "locked") {
    return `[acpx] subscription "${rejection.id}" is locked; refusing to spawn on a locked account`;
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
// Validate that an explicit effort override is in the selected profile's valid
// set; throws with a clear, user-facing error listing the valid levels.
function normalizedReasoningEffortOverride(
  effortOverride: string | null | undefined,
): string | undefined {
  const trimmedEffort = effortOverride?.trim();
  // Persisted/UI state may use the literal "default" to mean "no override".
  // Profile auth validation must not treat that sentinel as an effort level.
  return trimmedEffort && trimmedEffort !== "default" ? trimmedEffort : undefined;
}

function validateProfileReasoningEffort(
  profileId: string,
  profile: ProfileEntry,
  effortOverride: string | null | undefined,
): void {
  const trimmedEffort = normalizedReasoningEffortOverride(effortOverride);
  if (!trimmedEffort) {
    return;
  }
  const validEfforts = getValidEffortsForProfile(profile);
  if (!validEfforts) {
    throw new Error(
      `[acpx] profile "${profileId}" does not support --reasoning-effort. ` +
        `Remove --reasoning-effort to use this profile without a reasoning override.`,
    );
  }
  if (!validEfforts.includes(trimmedEffort)) {
    throw new Error(
      `[acpx] --reasoning-effort "${trimmedEffort}" is not valid for profile "${profileId}" ` +
        `(${profile.authMode}). Valid levels: ${validEfforts.join(", ")}`,
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

/**
 * FW-18/FW-19: the claude-pty bridge's session/new `_meta` fragment carrying the
 * parent session URL. ONLY for the bridge agent — the SDK claude adapter inherits
 * its parent from the spawn PROCESS env (ACPX_PARENT_SESSION_URL via
 * buildAgentEnvironment), but the bridge serves many ACP sessions per process and
 * must learn each session's parent per-`session/new`. Prefers the full
 * parentSessionUrl (carries the real host for a cross-box parent); otherwise
 * derives `${baseUrl}/?session=${parentSessionId}` against the LOCAL base URL
 * (correct for a same-box parent) — byte-identical to buildAgentEnvironment's
 * ACPX_PARENT_SESSION_URL. Returns undefined when there is no parent or the agent
 * is not the bridge (the namespaced key is harmless to other adapters, but gating
 * keeps the contract explicit).
 */
function resolveParentMetaUrl(sessionContext: AgentSessionContext | undefined): string | undefined {
  const explicitUrl = sessionContext?.parentSessionUrl?.trim();
  if (explicitUrl) {
    return explicitUrl;
  }
  const parentId = sessionContext?.parentSessionId?.trim();
  if (!parentId) {
    return undefined;
  }
  return `${resolveAcpxUiBaseUrl(process.env)}/?session=${parentId}`;
}

export function buildClaudeParentSessionMeta(
  sessionContext: AgentSessionContext | undefined,
  agentCommand: string | undefined,
): Record<string, unknown> | undefined {
  if (agentCommand === undefined || !isClaudePtyAgentCommand(agentCommand)) {
    return undefined;
  }
  const url = resolveParentMetaUrl(sessionContext);
  return url ? { [INDEPENDENT_CLAUDE_PARENT_SESSION_URL_META_KEY]: url } : undefined;
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
  const trimmedEffort = normalizedReasoningEffortOverride(reasoningEffortOverride);
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
  validateProfileReasoningEffort(trimmedId, profile, reasoningEffortOverride);
  if (isSubscriptionProfileLocked(profile, registry)) {
    throw new SubscriptionLockedError(trimmedId);
  }

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
