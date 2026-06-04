import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Per-subscription Claude credential registry. Each subscription is a
// CLAUDE_CONFIG_DIR holding its own .credentials.json (and per-dir runtime
// state); shared behavior (settings.json, skills/, commands/, plugins/) is
// symlinked from ~/.claude into each dir. The registry maps a stable `id` to
// its configDir + a human label, and records the default id. Read at adapter
// spawn (auth-env.ts) to resolve a selected subscription to CLAUDE_CONFIG_DIR,
// and by the `subscriptions list|usage` CLI. The on-disk shape is a FIXED
// cross-repo contract (acpx-ui reads the same registry.json).

export type SubscriptionEntry = {
  id: string;
  label: string;
  /** Absolute CLAUDE_CONFIG_DIR for this subscription. */
  configDir: string;
};

export type SubscriptionRegistry = {
  /** Default subscription id. Governs spawns with no explicit selection. */
  default?: string;
  subscriptions: SubscriptionEntry[];
};

/**
 * Outcome of resolving which CLAUDE_CONFIG_DIR a spawn should use. Pure data —
 * the caller (auth-env.ts) turns it into env mutation + stderr. `configDir`
 * undefined means "leave CLAUDE_CONFIG_DIR unset" (raw ~/.claude). The optional
 * rejection/unusable fields carry the *reason* a selection could not be honored
 * so the caller can log without re-deriving it.
 */
export type ConfigDirChoice = {
  /** Final dir to set; undefined ⇒ leave CLAUDE_CONFIG_DIR unset. */
  configDir?: string;
  /** Which input produced `configDir` (only present when `configDir` is). */
  source?: "explicit" | "default";
  /** A provided explicit id we could NOT honor (still emitted for logging). */
  explicitRejection?:
    | { kind: "unknown"; id: string }
    | { kind: "missing-dir"; id: string; configDir: string };
  /** A configured `default` that was itself unusable (set+unknown / set+dir-missing). */
  defaultUnusable?:
    | { kind: "unknown"; id: string }
    | { kind: "missing-dir"; id: string; configDir: string };
};

const SUBSCRIPTIONS_DIRNAME = "subscriptions";
const REGISTRY_FILENAME = "registry.json";

const EMPTY_REGISTRY: SubscriptionRegistry = { subscriptions: [] };

export type SubscriptionLookupOptions = {
  /** Override the home dir used to derive default paths (tests). */
  homeDir?: string;
  /** Override the registry.json path directly (tests). */
  registryPath?: string;
};

export function subscriptionsDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".acpx", SUBSCRIPTIONS_DIRNAME);
}

export function subscriptionRegistryPath(homeDir: string = os.homedir()): string {
  return path.join(subscriptionsDir(homeDir), REGISTRY_FILENAME);
}

/**
 * Load the subscription registry. Returns an empty registry (no subscriptions)
 * when the file is absent or malformed — the feature is opt-in and must never
 * throw on a box without a registry. configDir defaults to
 * ~/.acpx/subscriptions/<id> when omitted.
 */
export function loadSubscriptionRegistry(
  options?: SubscriptionLookupOptions,
): SubscriptionRegistry {
  const homeDir = options?.homeDir ?? os.homedir();
  const registryPath = options?.registryPath ?? subscriptionRegistryPath(homeDir);

  let raw: string;
  try {
    raw = readFileSync(registryPath, "utf8");
  } catch {
    return EMPTY_REGISTRY;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_REGISTRY;
  }

  return normalizeRegistry(parsed, homeDir);
}

export function findSubscription(
  id: string,
  registry: SubscriptionRegistry,
): SubscriptionEntry | undefined {
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  return registry.subscriptions.find((entry) => entry.id === trimmed);
}

/**
 * Resolve a subscription id to its CLAUDE_CONFIG_DIR, or undefined if the id is
 * not registered. Loads the registry unless one is supplied.
 */
export function resolveSubscriptionConfigDir(
  id: string,
  options?: SubscriptionLookupOptions & { registry?: SubscriptionRegistry },
): string | undefined {
  const registry = options?.registry ?? loadSubscriptionRegistry(options);
  return findSubscription(id, registry)?.configDir;
}

export function subscriptionConfigDirExists(configDir: string): boolean {
  return existsSync(configDir);
}

type IdResolution =
  | { kind: "ok"; configDir: string }
  | { kind: "unknown"; id: string }
  | { kind: "missing-dir"; id: string; configDir: string };

function resolveRegisteredDir(
  id: string,
  registry: SubscriptionRegistry,
  dirExists: (dir: string) => boolean,
): IdResolution {
  const entry = findSubscription(id, registry);
  if (!entry) {
    return { kind: "unknown", id };
  }
  if (!dirExists(entry.configDir)) {
    return { kind: "missing-dir", id, configDir: entry.configDir };
  }
  return { kind: "ok", configDir: entry.configDir };
}

/**
 * PURE resolution of CLAUDE_CONFIG_DIR for one adapter spawn. No env, no logging,
 * no fs beyond the injected `dirExists`. Resolution order:
 *   1. explicit valid id (registered AND configDir exists)        → source "explicit"
 *   2. else registry.default valid (registered AND configDir exists) → source "default"
 *   3. else                                                        → no configDir (raw)
 * An explicit id that is unknown or whose dir is missing falls through the SAME
 * default→raw chain (its reason is carried in `explicitRejection` for logging).
 * A configured-but-unusable default is reported in `defaultUnusable`. Both reason
 * fields are populated only on a box that actually configured those values, which
 * is what keeps no-registry / no-default boxes byte-identical to pre-default
 * behavior (empty registry ⇒ no explicit match, no default ⇒ plain `{}`).
 */
export function chooseSubscriptionConfigDir(
  explicitId: string | null | undefined,
  registry: SubscriptionRegistry,
  dirExists: (dir: string) => boolean = subscriptionConfigDirExists,
): ConfigDirChoice {
  const result: ConfigDirChoice = {};

  const trimmedExplicit = explicitId?.trim();
  if (trimmedExplicit) {
    const resolved = resolveRegisteredDir(trimmedExplicit, registry, dirExists);
    if (resolved.kind === "ok") {
      return { configDir: resolved.configDir, source: "explicit" };
    }
    result.explicitRejection = resolved;
  }

  const defaultId = registry.default?.trim();
  if (defaultId) {
    const resolved = resolveRegisteredDir(defaultId, registry, dirExists);
    if (resolved.kind === "ok") {
      result.configDir = resolved.configDir;
      result.source = "default";
      return result;
    }
    result.defaultUnusable = resolved;
  }

  return result;
}

function normalizeRegistry(value: unknown, homeDir: string): SubscriptionRegistry {
  if (!isRecord(value) || !Array.isArray(value.subscriptions)) {
    return EMPTY_REGISTRY;
  }

  const subscriptions: SubscriptionEntry[] = [];
  const seen = new Set<string>();
  for (const entry of value.subscriptions) {
    const normalized = normalizeEntry(entry, homeDir);
    if (normalized && !seen.has(normalized.id)) {
      seen.add(normalized.id);
      subscriptions.push(normalized);
    }
  }

  const registry: SubscriptionRegistry = { subscriptions };
  const defaultId = nonEmptyString(value.default);
  if (defaultId !== undefined) {
    registry.default = defaultId;
  }
  return registry;
}

function normalizeEntry(value: unknown, homeDir: string): SubscriptionEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = nonEmptyString(value.id);
  if (id === undefined) {
    return undefined;
  }
  const label = nonEmptyString(value.label) ?? id;
  const configDir = nonEmptyString(value.configDir) ?? path.join(subscriptionsDir(homeDir), id);
  return { id, label, configDir };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
