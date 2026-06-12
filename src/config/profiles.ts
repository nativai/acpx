import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSubscriptionRegistry,
  subscriptionsDir,
  type SubscriptionLookupOptions,
} from "./subscriptions.js";

export type Harness = "claude" | "codex";
export type AuthMode = "subscription" | "openrouter" | "chatgpt" | "claude-home";
export type ReasoningEffort = "low" | "medium" | "high";

/** Effort levels valid for OpenRouter profiles with reasoningSupported=true. */
export const OPENROUTER_REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type OpenRouterReasoningEffort = (typeof OPENROUTER_REASONING_EFFORTS)[number];

export interface ProfileEntry {
  id: string;
  label: string;
  harness: Harness;
  authMode: AuthMode;
  /** CLAUDE_CONFIG_DIR for subscription profiles; null for openrouter/chatgpt. */
  credentialSource: string | null;
  /** Required when authMode="openrouter": full OpenRouter model id. */
  model?: string;
  /**
   * Stored in registry (0600 file). Required when authMode="openrouter".
   * MUST NEVER be logged or written to stderr.
   */
  openRouterApiKey?: string;
  /**
   * Static reasoning depth for OpenRouter profiles. When set, the shim injects
   * `reasoning: { effort }` into every /v1/messages request. Ignored for non-openrouter profiles.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Manual flag (no auto-retrieval) indicating the OR model supports reasoning.
   * When true, the valid effort levels are minimal/low/medium/high and the CLI
   * `--reasoning-effort` flag accepts those values. Ignored for non-openrouter.
   */
  reasoningSupported?: boolean;
  /**
   * Required when authMode="claude-home": absolute HOME directory holding an
   * interactive full-scope Claude login (NOT a CLAUDE_CONFIG_DIR — interactive
   * Claude splits its login across <home>/.claude/ and <home>/.claude.json).
   * Deliberately a dedicated field, not an overload of credentialSource.
   * The path itself is not a secret, but it must never be logged together
   * with credential contents.
   */
  homePath?: string;
  /**
   * Optional account identity (e.g. login email) carried alongside `label` so
   * profiles sharing one billing subscription can be grouped later (UIC-4 D5).
   * Display/grouping only — plays no role in auth resolution.
   */
  accountEmail?: string;
}

export interface ProfileRegistry {
  /** Default profile id. Governs spawns with no explicit selection. */
  default?: string;
  profiles: ProfileEntry[];
}

const EMPTY_PROFILE_REGISTRY: ProfileRegistry = { profiles: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isValidHarness(value: unknown): value is Harness {
  return value === "claude" || value === "codex";
}

function isValidAuthMode(value: unknown): value is AuthMode {
  return (
    value === "subscription" ||
    value === "openrouter" ||
    value === "chatgpt" ||
    value === "claude-home"
  );
}

function isValidReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high";
}

function resolveCredentialSource(
  authMode: AuthMode,
  id: string,
  raw: Record<string, unknown>,
  homeDir: string,
): string | null {
  if (authMode !== "subscription") {
    return null;
  }
  return nonEmptyString(raw.credentialSource) ?? path.join(subscriptionsDir(homeDir), id);
}

function applyOptionalProfileFields(entry: ProfileEntry, raw: Record<string, unknown>): void {
  const model = nonEmptyString(raw.model);
  if (model !== undefined) {
    entry.model = model;
  }
  const apiKey = nonEmptyString(raw.openRouterApiKey);
  if (apiKey !== undefined) {
    entry.openRouterApiKey = apiKey;
  }
  if (isValidReasoningEffort(raw.reasoningEffort)) {
    entry.reasoningEffort = raw.reasoningEffort;
  }
  if (raw.reasoningSupported === true) {
    entry.reasoningSupported = true;
  }
  const accountEmail = nonEmptyString(raw.accountEmail);
  if (accountEmail !== undefined) {
    entry.accountEmail = accountEmail;
  }
}

/**
 * Return the valid effort levels for a profile, or null when reasoning is not
 * applicable (used by CLI validation and the `profiles` discovery command).
 * - subscription → Claude set: low/medium/high/xhigh/max
 * - openrouter + reasoningSupported → OR set: minimal/low/medium/high
 * - openrouter without reasoningSupported → null
 */
export function getValidEffortsForProfile(profile: ProfileEntry): readonly string[] | null {
  // claude-home runs the same interactive Claude effort ladder as subscription
  // (the bridge maps `set effort` onto interactive Claude's --effort).
  if (profile.authMode === "subscription" || profile.authMode === "claude-home") {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  if (profile.authMode === "openrouter" && profile.reasoningSupported) {
    return OPENROUTER_REASONING_EFFORTS;
  }
  return null;
}

// A DECLARED but unrecognized authMode stays inert (null = skip the entry): a
// registry written by a newer binary must not be misread as a subscription
// profile (which would resolve a bogus CLAUDE_CONFIG_DIR). A missing authMode
// still defaults to "subscription" (v1-shaped entries).
function resolveDeclaredAuthMode(raw: unknown): AuthMode | null {
  if (raw === undefined) {
    return "subscription";
  }
  return isValidAuthMode(raw) ? raw : null;
}

// claude-home requires homePath; an entry without one is unusable — false =
// skip the entry rather than guess. No-op for other authModes.
function applyClaudeHomeFields(entry: ProfileEntry, raw: Record<string, unknown>): boolean {
  if (entry.authMode !== "claude-home") {
    return true;
  }
  const homePath = nonEmptyString(raw.homePath);
  if (!homePath) {
    return false;
  }
  entry.homePath = homePath;
  return true;
}

function normalizeProfileEntry(value: unknown, homeDir: string): ProfileEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = nonEmptyString(value.id);
  if (!id) {
    return undefined;
  }
  const authMode = resolveDeclaredAuthMode(value.authMode);
  if (!authMode) {
    return undefined;
  }
  const label = nonEmptyString(value.label) ?? id;
  const harness: Harness = isValidHarness(value.harness) ? value.harness : "claude";
  const credentialSource = resolveCredentialSource(authMode, id, value, homeDir);
  const entry: ProfileEntry = { id, label, harness, authMode, credentialSource };
  if (!applyClaudeHomeFields(entry, value)) {
    return undefined;
  }
  applyOptionalProfileFields(entry, value);
  return entry;
}

function normalizeV2Registry(value: Record<string, unknown>, homeDir: string): ProfileRegistry {
  const profiles: ProfileEntry[] = [];
  const seen = new Set<string>();
  const rawProfiles = value.profiles;
  if (Array.isArray(rawProfiles)) {
    for (const item of rawProfiles) {
      const entry = normalizeProfileEntry(item, homeDir);
      if (entry && !seen.has(entry.id)) {
        seen.add(entry.id);
        profiles.push(entry);
      }
    }
  }
  const registry: ProfileRegistry = { profiles };
  const defaultId = nonEmptyString(value.default);
  if (defaultId !== undefined) {
    registry.default = defaultId;
  }
  return registry;
}

/** Synthesise a ProfileRegistry from a v1 subscriptions registry (in-memory; no file write). */
function synthesiseFromV1(options: SubscriptionLookupOptions | undefined): ProfileRegistry {
  const subRegistry = loadSubscriptionRegistry(options);
  const profiles: ProfileEntry[] = subRegistry.subscriptions.map((sub) => ({
    id: sub.id,
    label: sub.label,
    harness: "claude" as Harness,
    authMode: "subscription" as AuthMode,
    credentialSource: sub.configDir,
  }));
  const registry: ProfileRegistry = { profiles };
  if (subRegistry.default !== undefined) {
    registry.default = subRegistry.default;
  }
  return registry;
}

/** Read and JSON-parse the registry file, returning null on any error. */
function readRegistryJson(registryPath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(registryPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Load the profile registry. Supports two formats:
 *  v2: { "profiles": [...] }   — parsed directly as ProfileRegistry
 *  v1: { "subscriptions": [...] } — synthesised in-memory from SubscriptionEntry
 * Never throws; returns an empty registry on any error.
 */
export function loadProfileRegistry(options?: SubscriptionLookupOptions): ProfileRegistry {
  const homeDir = options?.homeDir ?? os.homedir();
  const registryPath =
    options?.registryPath ?? path.join(homeDir, ".acpx", "subscriptions", "registry.json");
  const parsed = readRegistryJson(registryPath);
  if (!parsed) {
    return EMPTY_PROFILE_REGISTRY;
  }

  // v2 format: has a "profiles" key
  if (Array.isArray(parsed.profiles)) {
    return normalizeV2Registry(parsed, homeDir);
  }

  // v1 format: has a "subscriptions" key — synthesise ProfileEntry objects
  if (Array.isArray(parsed.subscriptions)) {
    return synthesiseFromV1(options);
  }

  return EMPTY_PROFILE_REGISTRY;
}

export function findProfile(id: string, registry: ProfileRegistry): ProfileEntry | undefined {
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  return registry.profiles.find((entry) => entry.id === trimmed);
}

/**
 * id → homePath map over ALL claude-home profiles in the registry — the value
 * of the bridge's INDEPENDENT_CLAUDE_HOME_MAP allow-list env. Always the full
 * map (not a single entry) so the bridge's unknown-selector diagnostics stay
 * meaningful.
 */
export function buildClaudeHomeMap(registry: ProfileRegistry): Record<string, string> {
  const map: Record<string, string> = {};
  for (const profile of registry.profiles) {
    if (profile.authMode === "claude-home" && profile.homePath) {
      map[profile.id] = profile.homePath;
    }
  }
  return map;
}

/**
 * True when `profileId` names a claude-home profile in the registry. Used to
 * exclude claude-home sessions from subscription failover (their credential is
 * an interactive HOME, not a configDir — rewriting session_options.subscription
 * cannot move them anywhere) and to gate the bridge `_meta` selector.
 */
export function isClaudeHomeProfileId(
  profileId: string | null | undefined,
  options?: SubscriptionLookupOptions,
): boolean {
  const trimmed = profileId?.trim();
  if (!trimmed) {
    return false;
  }
  return findProfile(trimmed, loadProfileRegistry(options))?.authMode === "claude-home";
}

/** Ensure the temp config dir for an openrouter session exists and return its path. */
export function ensureOpenRouterConfigDir(sessionId: string): string {
  const dir = path.join(os.tmpdir(), `or-${sessionId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
