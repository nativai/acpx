import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hasKnownDeadSubs, isSubscriptionKnownDead } from "../config/known-dead-subscriptions.js";
import {
  buildClaudeHomeMap,
  findProfile,
  getValidEffortsForProfile,
  loadProfileRegistry,
  type ProfileEntry,
  type ProfileRegistry,
} from "../config/profiles.js";
import type { SubscriptionLookupOptions } from "../config/subscriptions.js";
import {
  chooseSubscriptionConfigDir,
  loadSubscriptionRegistry,
  subscriptionConfigDirExists,
} from "../config/subscriptions.js";
import type { ConfigDirChoice, SubscriptionRegistry } from "../config/subscriptions.js";
import type { AcpClientOptions } from "../types.js";
import { isClaudePtyAgentCommand } from "./agent-command.js";
import type { ShimHandle } from "./openrouter-shim.js";
import { spawnOpenRouterShim } from "./openrouter-shim.js";

const AUTH_ENV_PREFIX = "ACPX_AUTH_";

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
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  promotePrefixedAuthEnvironment(env);
  const baseUrl = resolveAcpxUiBaseUrl(env);
  // FW-07: never inherit a stale ACPX_SESSION_URL/_PARENT from {...process.env} (e.g. a
  // long-lived queue-owner that served a different session). Clear both, then set only from
  // THIS spawn ids below so a bridge session can never carry another session identity.
  delete env.ACPX_SESSION_URL;
  delete env.ACPX_PARENT_SESSION_URL;
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

type ResolvedSubscription = {
  registry: SubscriptionRegistry;
  choice: ConfigDirChoice;
  defaultId: string | undefined;
};

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
    emitExplicitRejection(resolved.choice.explicitRejection);
  }
  return resolved.choice.configDir === undefined ? undefined : resolved;
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
  const { registry, choice, defaultId } = resolved;

  // The id this choice resolved to (explicit selection or registry default).
  const baseResolvedId = choice.source === "explicit" ? explicitId?.trim() : defaultId;
  const { resolvedId, configDir, substituted } = applyPreSpawnAvoidance(
    registry,
    baseResolvedId,
    choice.configDir as string,
  );

  env.CLAUDE_CONFIG_DIR = configDir;
  // Export the RESOLVED subscription id so the agent (and its children) can read
  // its own sub and inherit it (ACPX_SUBSCRIPTION, beside ACPX_TASK_FOLDER).
  if (resolvedId) {
    env.ACPX_SUBSCRIPTION = resolvedId;
  }
  // Only emit the "default applied" note when we used the default verbatim (no
  // failover substitution kicked in), to keep the existing message accurate.
  if (choice.source === "default" && defaultId && !substituted) {
    emitDefaultApplied(
      defaultId,
      choice.configDir as string,
      choice.explicitRejection !== undefined,
    );
  }
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
): { resolvedId: string | undefined; configDir: string; substituted: boolean } {
  if (!resolvedId || !hasKnownDeadSubs() || !isSubscriptionKnownDead(resolvedId)) {
    return { resolvedId, configDir, substituted: false };
  }
  const healthy = firstHealthySubscription(registry, resolvedId);
  if (!healthy) {
    return { resolvedId, configDir, substituted: false };
  }
  process.stderr.write(
    `[acpx] subscription "${resolvedId}" recently failed over; using "${healthy.id}" for this spawn (CLAUDE_CONFIG_DIR=${healthy.configDir})\n`,
  );
  return { resolvedId: healthy.id, configDir: healthy.configDir, substituted: true };
}

// First registered subscription whose dir exists and is not known-dead, skipping
// `avoidId`. Pure registry walk (no probe) for pre-spawn avoidance (§4.1.4).
function firstHealthySubscription(
  registry: SubscriptionRegistry,
  avoidId: string,
): { id: string; configDir: string } | undefined {
  for (const entry of registry.subscriptions) {
    if (entry.id === avoidId || isSubscriptionKnownDead(entry.id)) {
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

// EXACT legacy lines — preserved byte-for-byte so a no-usable-default box behaves
// identically to the pre-default build.
function emitExplicitRejection(rejection: NonNullable<ConfigDirChoice["explicitRejection"]>): void {
  if (rejection.kind === "unknown") {
    process.stderr.write(
      `[acpx] subscription "${rejection.id}" not found in registry; using default Claude config (no CLAUDE_CONFIG_DIR override)\n`,
    );
    return;
  }
  process.stderr.write(
    `[acpx] subscription "${rejection.id}" configDir not found at ${rejection.configDir}; using default Claude config (no CLAUDE_CONFIG_DIR override)\n`,
  );
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

// Seed a freshly-created OpenRouter config dir with the universal SessionStart
// primer hook. OpenRouter sessions run with CLAUDE_CONFIG_DIR pointed at an
// isolated temp dir (so no Anthropic OAuth can leak in); that isolation also
// means Claude Code no longer reads the host's global ~/.claude/settings.json,
// so the primer hook configured there would never fire. We fix that by copying
// ONLY the `hooks` block from the host's global settings into the temp dir —
// never the `.credentials.json`, so the shim's ANTHROPIC_BASE_URL/AUTH_TOKEN
// remain the sole auth path and "local OAuth" can't win.
//
// Best-effort: if the source settings or its hooks are missing/unparseable we
// leave the dir without a settings.json (the primer simply won't fire — same as
// before this fix). Never throws — the primer is a nicety, not worth failing a
// spawn over. The openRouterApiKey is not involved here, so nothing sensitive
// is written.
function seedOpenRouterPrimerHooks(configDir: string): void {
  try {
    const source = join(homedir(), ".claude", "settings.json");
    if (!existsSync(source)) {
      return;
    }
    const parsed = JSON.parse(readFileSync(source, "utf8")) as { hooks?: unknown };
    if (!parsed || typeof parsed !== "object" || parsed.hooks == null) {
      return;
    }
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({ hooks: parsed.hooks }, null, 2),
      {
        mode: 0o644,
      },
    );
  } catch {
    /* best-effort: the primer is a nicety; never block the spawn over it */
  }
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
  const claudePty = isClaudePtyAgentCommand(agentCommand);
  if (profile.authMode === "claude-home" && !claudePty) {
    throw new Error(
      `[acpx] profile "${profileId}" (authMode "claude-home") requires the claude-pty bridge agent; ` +
        `this session's agent command is "${agentCommand}". ` +
        `Create the session with the claude-pty agent to use this profile.`,
    );
  }
  if (profile.authMode !== "claude-home" && claudePty) {
    throw new Error(
      `[acpx] profile "${profileId}" (authMode "${profile.authMode}") cannot be used with the ` +
        `claude-pty bridge agent: its credentials are not an interactive Claude login ` +
        `(interactive Claude would wedge at the login picker). Use a claude-home profile.`,
    );
  }
}

// claude-home branch of applyProfileAuth: the bridge owns auth via its HOME
// selector. Inject the full allow-list map (ALL claude-home profiles in the
// registry) so the bridge's unknown-selector diagnostics stay meaningful; the
// per-session selection travels as session/new _meta (buildClaudeHomeSelectorMeta),
// never as env. No CLAUDE_CONFIG_DIR / ACPX_SUBSCRIPTION: subscription
// resolution does not apply to interactive-home credentials (the bridge strips
// leaked SDK env defensively, but acpx must not emit it — drop anything
// inherited from the owner's own process env). The map holds paths only,
// never credential contents.
function applyClaudeHomeProfileAuth(env: NodeJS.ProcessEnv, registry: ProfileRegistry): void {
  env[INDEPENDENT_CLAUDE_HOME_MAP_ENV] = JSON.stringify(buildClaudeHomeMap(registry));
  delete env.CLAUDE_CONFIG_DIR;
  delete env.ACPX_SUBSCRIPTION;
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
async function applyOpenRouterProfileAuth(
  env: NodeJS.ProcessEnv,
  profileId: string,
  sessionId: string,
  profile: NonNullable<ReturnType<typeof findProfile>>,
  reasoningEffortOverride: string | null | undefined,
): Promise<ShimHandle | null> {
  const apiKey = profile.openRouterApiKey;
  const model = profile.model;
  if (!apiKey || !model) {
    process.stderr.write(
      `[acpx] profile "${profileId}" is missing openRouterApiKey or model; using default Claude config\n`,
    );
    return null;
  }

  // Validate then resolve effort: per-session override > profile default.
  const trimmedEffort = reasoningEffortOverride?.trim() || undefined;
  validateOpenRouterEffort(profileId, profile, trimmedEffort);
  const resolvedEffort = trimmedEffort ?? profile.reasoningEffort;

  // Isolate Claude config in a per-session temp dir (no OAuth inheritance).
  const configDir = join(tmpdir(), `or-${sessionId}`);
  mkdirSync(configDir, { recursive: true });
  // Seed the dir with the universal SessionStart primer hook so OpenRouter
  // sessions get the same primer that subscription sessions get from their
  // own config dir. Copies ONLY the hooks block — never .credentials.json —
  // so the shim's ANTHROPIC_BASE_URL/AUTH_TOKEN stay the sole auth path.
  seedOpenRouterPrimerHooks(configDir);
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
): Promise<ShimHandle | null> {
  const trimmedId = profileId.trim();
  if (!trimmedId) {
    return null;
  }
  const registry = loadProfileRegistry(lookupOptions);
  const profile = findProfile(trimmedId, registry);
  if (!profile) {
    // For the bridge agent a soft fallback would be a SILENT wrong-home run:
    // with no profile there is no map env and no _meta selector, and the
    // bridge then falls back to the box-default HOME (wrong credentials)
    // without erroring. Fail the spawn instead.
    if (agentCommand !== undefined && isClaudePtyAgentCommand(agentCommand)) {
      throw new Error(
        `[acpx] profile "${trimmedId}" not found in registry; the claude-pty bridge agent ` +
          `requires a claude-home profile — refusing to spawn under the box-default HOME. ` +
          `Restore the profile in ~/.acpx/subscriptions/registry.json or recreate the session.`,
      );
    }
    process.stderr.write(
      `[acpx] profile "${trimmedId}" not found in registry; using default Claude config\n`,
    );
    return null;
  }

  validateProfileAgentCompatibility(trimmedId, profile, agentCommand);

  if (profile.authMode === "claude-home") {
    applyClaudeHomeProfileAuth(env, registry);
    return null;
  }

  if (profile.authMode === "subscription") {
    // Behave exactly like applySubscriptionConfigDir for subscription profiles.
    applySubscriptionConfigDir(env, trimmedId, lookupOptions);
    return null;
  }

  if (profile.authMode === "openrouter") {
    return applyOpenRouterProfileAuth(env, trimmedId, sessionId, profile, reasoningEffortOverride);
  }

  // authMode=chatgpt or unknown: no extra env manipulation from the profile side.
  return null;
}

export function buildAgentSpawnOptions(
  cwd: string,
  authCredentials: Record<string, string> | undefined,
  sessionContext?: AgentSessionContext,
  lookupOptions?: SubscriptionLookupOptions,
  agentCommand?: string,
): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
} {
  return {
    cwd,
    env: buildAgentEnvironment(authCredentials, sessionContext, lookupOptions, agentCommand),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}
