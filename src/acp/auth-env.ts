import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hasKnownDeadSubs, isSubscriptionKnownDead } from "../config/known-dead-subscriptions.js";
import { findProfile, loadProfileRegistry } from "../config/profiles.js";
import type { SubscriptionLookupOptions } from "../config/subscriptions.js";
import {
  chooseSubscriptionConfigDir,
  loadSubscriptionRegistry,
  subscriptionConfigDirExists,
} from "../config/subscriptions.js";
import type { ConfigDirChoice, SubscriptionRegistry } from "../config/subscriptions.js";
import type { AcpClientOptions } from "../types.js";
import type { ShimHandle } from "./openrouter-shim.js";
import { spawnOpenRouterShim } from "./openrouter-shim.js";

const AUTH_ENV_PREFIX = "ACPX_AUTH_";

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
};

// eslint-disable-next-line complexity -- fork integration function; intentionally over budget, refactor would risk verified merge semantics
function buildAgentEnvironment(
  authCredentials: Record<string, string> | undefined,
  sessionContext?: AgentSessionContext,
  lookupOptions?: SubscriptionLookupOptions,
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
  if (!sessionContext?.profileId?.trim()) {
    applySubscriptionConfigDir(env, sessionContext?.subscriptionId ?? null, lookupOptions);
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
 * Constraint: openRouterApiKey must never appear in logs or process output.
 */
export async function applyProfileAuth(
  env: NodeJS.ProcessEnv,
  profileId: string,
  sessionId: string,
  lookupOptions?: SubscriptionLookupOptions,
): Promise<ShimHandle | null> {
  const trimmedId = profileId.trim();
  if (!trimmedId) {
    return null;
  }
  const registry = loadProfileRegistry(lookupOptions);
  const profile = findProfile(trimmedId, registry);
  if (!profile) {
    process.stderr.write(
      `[acpx] profile "${trimmedId}" not found in registry; using default Claude config\n`,
    );
    return null;
  }

  if (profile.authMode === "subscription") {
    // Behave exactly like applySubscriptionConfigDir for subscription profiles.
    applySubscriptionConfigDir(env, trimmedId, lookupOptions);
    return null;
  }

  if (profile.authMode === "openrouter") {
    const apiKey = profile.openRouterApiKey;
    const model = profile.model;
    if (!apiKey || !model) {
      process.stderr.write(
        `[acpx] profile "${trimmedId}" is missing openRouterApiKey or model; using default Claude config\n`,
      );
      return null;
    }

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
    const shim = await spawnOpenRouterShim(apiKey, model, profile.reasoningEffort);

    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${shim.port}`;
    // Bypass the Bun availability / key check in claude-agent-acp.
    env.ANTHROPIC_AUTH_TOKEN = " ";
    // Remove any custom headers set by the subscription path —
    // the shim injects Authorization itself.
    delete env.ANTHROPIC_CUSTOM_HEADERS;

    return shim;
  }

  // authMode=chatgpt or unknown: no extra env manipulation from the profile side.
  return null;
}

export function buildAgentSpawnOptions(
  cwd: string,
  authCredentials: Record<string, string> | undefined,
  sessionContext?: AgentSessionContext,
  lookupOptions?: SubscriptionLookupOptions,
): {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ["pipe", "pipe", "pipe"];
  windowsHide: true;
} {
  return {
    cwd,
    env: buildAgentEnvironment(authCredentials, sessionContext, lookupOptions),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}
