import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSubscriptionRegistry,
  subscriptionsDir,
  type SubscriptionLookupOptions,
} from "./subscriptions.js";

export type Harness = "claude" | "codex";
export type AuthMode = "subscription" | "openrouter" | "chatgpt";

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
  return value === "subscription" || value === "openrouter" || value === "chatgpt";
}

function resolveCredentialSource(
  authMode: AuthMode,
  id: string,
  raw: Record<string, unknown>,
  homeDir: string,
): string | null {
  if (authMode !== "subscription") {return null;}
  return nonEmptyString(raw.credentialSource) ?? path.join(subscriptionsDir(homeDir), id);
}

function normalizeProfileEntry(value: unknown, homeDir: string): ProfileEntry | undefined {
  if (!isRecord(value)) {return undefined;}
  const id = nonEmptyString(value.id);
  if (!id) {return undefined;}
  const label = nonEmptyString(value.label) ?? id;
  const harness: Harness = isValidHarness(value.harness) ? value.harness : "claude";
  const authMode: AuthMode = isValidAuthMode(value.authMode) ? value.authMode : "subscription";
  const credentialSource = resolveCredentialSource(authMode, id, value, homeDir);
  const entry: ProfileEntry = { id, label, harness, authMode, credentialSource };
  const model = nonEmptyString(value.model);
  if (model !== undefined) {entry.model = model;}
  const apiKey = nonEmptyString(value.openRouterApiKey);
  if (apiKey !== undefined) {entry.openRouterApiKey = apiKey;}
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
  if (subRegistry.default !== undefined) {registry.default = subRegistry.default;}
  return registry;
}

/** Read and JSON-parse the registry file, returning null on any error. */
function readRegistryJson(registryPath: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw);
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
  if (!parsed) {return EMPTY_PROFILE_REGISTRY;}

  // v2 format: has a "profiles" key
  if (Array.isArray(parsed.profiles)) {return normalizeV2Registry(parsed, homeDir);}

  // v1 format: has a "subscriptions" key — synthesise ProfileEntry objects
  if (Array.isArray(parsed.subscriptions)) {return synthesiseFromV1(options);}

  return EMPTY_PROFILE_REGISTRY;
}

export function findProfile(id: string, registry: ProfileRegistry): ProfileEntry | undefined {
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  return registry.profiles.find((entry) => entry.id === trimmed);
}

/** Ensure the temp config dir for an openrouter session exists and return its path. */
export function ensureOpenRouterConfigDir(sessionId: string): string {
  const dir = path.join(os.tmpdir(), `or-${sessionId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
