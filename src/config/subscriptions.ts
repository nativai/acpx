import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path, { dirname } from "node:path";

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
  /** Functional account seam id; defaults to id for legacy registries. */
  account: string;
  /** Display/grouping metadata only. */
  accountEmail?: string;
  /** User/operator lock: this Claude SDK subscription must not be selected or used. */
  locked?: true;
  lockedAt?: string;
  lockedBy?: string;
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
  /** Final subscription id that produced `configDir` when it is known. */
  resolvedId?: string;
  /** A provided explicit id we could NOT honor (still emitted for logging). */
  explicitRejection?:
    | { kind: "unknown"; id: string }
    | { kind: "missing-dir"; id: string; configDir: string }
    | { kind: "locked"; id: string };
  /** A configured `default` that was itself unusable (set+unknown / set+dir-missing). */
  defaultUnusable?:
    | { kind: "unknown"; id: string }
    | { kind: "missing-dir"; id: string; configDir: string }
    | { kind: "locked"; id: string };
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

export function subscriptionsDir(
  homeDir: string = process.env.ACPX_STATE_HOME || os.homedir(),
): string {
  return path.join(homeDir, ".acpx", SUBSCRIPTIONS_DIRNAME);
}

export function subscriptionRegistryPath(
  homeDir: string = process.env.ACPX_STATE_HOME || os.homedir(),
): string {
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
  const homeDir = options?.homeDir ?? (process.env.ACPX_STATE_HOME || os.homedir());
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
  | { kind: "ok"; id: string; configDir: string }
  | { kind: "unknown"; id: string }
  | { kind: "missing-dir"; id: string; configDir: string }
  | { kind: "locked"; id: string };

function resolveRegisteredDir(
  id: string,
  registry: SubscriptionRegistry,
  dirExists: (dir: string) => boolean,
): IdResolution {
  const entry = findSubscription(id, registry);
  if (!entry) {
    return { kind: "unknown", id };
  }
  if (isSubscriptionLocked(entry, registry)) {
    return { kind: "locked", id };
  }
  if (!dirExists(entry.configDir)) {
    return { kind: "missing-dir", id, configDir: entry.configDir };
  }
  return { kind: "ok", id: entry.id, configDir: entry.configDir };
}

function applyDefaultResolution(result: ConfigDirChoice, resolved: IdResolution): boolean {
  if (resolved.kind !== "ok") {
    result.defaultUnusable = resolved;
    return false;
  }
  result.configDir = resolved.configDir;
  result.source = "default";
  return true;
}

function firstUnlockedSubscription(
  registry: SubscriptionRegistry,
  dirExists: (dir: string) => boolean,
): SubscriptionEntry | undefined {
  return registry.subscriptions.find(
    (entry) => !isSubscriptionLocked(entry, registry) && dirExists(entry.configDir),
  );
}

function applyLockedDefaultFallback(
  result: ConfigDirChoice,
  registry: SubscriptionRegistry,
  dirExists: (dir: string) => boolean,
): boolean {
  if (result.defaultUnusable?.kind !== "locked") {
    return false;
  }
  const fallback = firstUnlockedSubscription(registry, dirExists);
  if (!fallback) {
    return false;
  }
  result.configDir = fallback.configDir;
  result.source = "default";
  result.resolvedId = fallback.id;
  return true;
}

function resolveExplicitChoice(
  result: ConfigDirChoice,
  explicitId: string | null | undefined,
  registry: SubscriptionRegistry,
  dirExists: (dir: string) => boolean,
): ConfigDirChoice | undefined {
  const trimmedExplicit = explicitId?.trim();
  if (!trimmedExplicit) {
    return undefined;
  }
  const resolved = resolveRegisteredDir(trimmedExplicit, registry, dirExists);
  if (resolved.kind === "ok") {
    return { configDir: resolved.configDir, source: "explicit" };
  }
  result.explicitRejection = resolved;
  return undefined;
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

  const explicitChoice = resolveExplicitChoice(result, explicitId, registry, dirExists);
  if (explicitChoice) {
    return explicitChoice;
  }

  const defaultId = registry.default?.trim();
  if (defaultId) {
    const resolved = resolveRegisteredDir(defaultId, registry, dirExists);
    if (applyDefaultResolution(result, resolved)) {
      return result;
    }
  }

  if (applyLockedDefaultFallback(result, registry, dirExists)) {
    return result;
  }

  return result;
}

export function isSubscriptionLocked(
  entry: SubscriptionEntry,
  registry: SubscriptionRegistry,
): boolean {
  if (entry.locked === true) {
    return true;
  }
  const account = entry.account || entry.id;
  return registry.subscriptions.some(
    (candidate) =>
      candidate.id !== entry.id &&
      candidate.locked === true &&
      (candidate.account || candidate.id) === account,
  );
}

type SubscriptionNormalizer = (entry: unknown, homeDir: string) => SubscriptionEntry | undefined;

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
  const account = nonEmptyString(value.account) ?? id;
  const accountEmail = nonEmptyString(value.accountEmail);
  const locked = lockFields(value);
  return {
    id,
    label,
    configDir,
    account,
    ...(accountEmail !== undefined ? { accountEmail } : {}),
    ...locked,
  };
}

function addUniqueSubscription(
  normalized: SubscriptionEntry | undefined,
  subscriptions: SubscriptionEntry[],
  seen: Set<string>,
): void {
  if (!normalized || seen.has(normalized.id)) {
    return;
  }
  seen.add(normalized.id);
  subscriptions.push(normalized);
}

function collectSubscriptions(
  items: unknown,
  homeDir: string,
  normalizer: SubscriptionNormalizer,
  subscriptions: SubscriptionEntry[],
  seen: Set<string>,
): void {
  if (!Array.isArray(items)) {
    return;
  }
  for (const entry of items) {
    addUniqueSubscription(normalizer(entry, homeDir), subscriptions, seen);
  }
}

type LockMetadata = { account: string; lockedAt?: string; lockedBy?: string };
type LockAuditMetadata = Omit<LockMetadata, "account">;

function legacySubscriptionLockFields(value: unknown): LockMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = nonEmptyString(value.id);
  if (id === undefined || value.locked !== true) {
    return undefined;
  }
  const fields = lockFields(value);
  return {
    account: nonEmptyString(value.account) ?? id,
    ...(fields.lockedAt !== undefined ? { lockedAt: fields.lockedAt } : {}),
    ...(fields.lockedBy !== undefined ? { lockedBy: fields.lockedBy } : {}),
  };
}

function collectLegacySubscriptionLocks(items: unknown): Map<string, LockAuditMetadata> {
  const lockedByAccount = new Map<string, LockAuditMetadata>();
  if (!Array.isArray(items)) {
    return lockedByAccount;
  }
  for (const item of items) {
    const lock = legacySubscriptionLockFields(item);
    if (lock && !lockedByAccount.has(lock.account)) {
      lockedByAccount.set(lock.account, {
        ...(lock.lockedAt !== undefined ? { lockedAt: lock.lockedAt } : {}),
        ...(lock.lockedBy !== undefined ? { lockedBy: lock.lockedBy } : {}),
      });
    }
  }
  return lockedByAccount;
}

function applyLockMetadataToSubscription(
  subscription: SubscriptionEntry,
  lock: LockAuditMetadata | undefined,
): void {
  if (!lock) {
    return;
  }
  subscription.locked = true;
  if (subscription.lockedAt === undefined && lock.lockedAt !== undefined) {
    subscription.lockedAt = lock.lockedAt;
  }
  if (subscription.lockedBy === undefined && lock.lockedBy !== undefined) {
    subscription.lockedBy = lock.lockedBy;
  }
}

function applyLegacySubscriptionLocks(items: unknown, subscriptions: SubscriptionEntry[]): void {
  const lockedByAccount = collectLegacySubscriptionLocks(items);
  if (lockedByAccount.size === 0) {
    return;
  }
  for (const subscription of subscriptions) {
    applyLockMetadataToSubscription(
      subscription,
      lockedByAccount.get(subscription.account || subscription.id),
    );
  }
}

function isSubscriptionProfileRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  return value.authMode === undefined || value.authMode === "subscription";
}

function normalizeSubscriptionProfileEntry(
  value: unknown,
  homeDir: string,
): SubscriptionEntry | undefined {
  if (!isSubscriptionProfileRecord(value)) {
    return undefined;
  }
  const id = nonEmptyString(value.id);
  if (id === undefined) {
    return undefined;
  }
  const label = nonEmptyString(value.label) ?? id;
  const configDir =
    nonEmptyString(value.credentialSource) ??
    nonEmptyString(value.configDir) ??
    path.join(subscriptionsDir(homeDir), id);
  const account = nonEmptyString(value.account) ?? id;
  const accountEmail = nonEmptyString(value.accountEmail);
  const locked = lockFields(value);
  return {
    id,
    label,
    configDir,
    account,
    ...(accountEmail !== undefined ? { accountEmail } : {}),
    ...locked,
  };
}

function normalizeRegistry(value: unknown, homeDir: string): SubscriptionRegistry {
  if (!isRecord(value)) {
    return EMPTY_REGISTRY;
  }
  if (!Array.isArray(value.profiles) && !Array.isArray(value.subscriptions)) {
    return EMPTY_REGISTRY;
  }

  const subscriptions: SubscriptionEntry[] = [];
  const seen = new Set<string>();

  // v3 drops subscriptions[]; subscription auth lives as tagged profiles. Read
  // these first so --subscription remains valid after migration.
  collectSubscriptions(
    value.profiles,
    homeDir,
    normalizeSubscriptionProfileEntry,
    subscriptions,
    seen,
  );
  collectSubscriptions(value.subscriptions, homeDir, normalizeEntry, subscriptions, seen);
  applyLegacySubscriptionLocks(value.subscriptions, subscriptions);

  const defaultId = nonEmptyString(value.default);
  return {
    subscriptions,
    ...(defaultId !== undefined ? { default: defaultId } : {}),
  };
}

export type SubscriptionLockMutationResult = {
  action: "subscription_lock_set";
  subscription: string;
  locked: boolean;
  affected: string[];
  lockedAt?: string;
};

function registryPathForOptions(options?: SubscriptionLookupOptions): string {
  const homeDir = options?.homeDir ?? (process.env.ACPX_STATE_HOME || os.homedir());
  return options?.registryPath ?? subscriptionRegistryPath(homeDir);
}

function readRegistryDocument(registryPath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function lockFields(
  value: Record<string, unknown>,
): Pick<SubscriptionEntry, "locked" | "lockedAt" | "lockedBy"> {
  if (value.locked !== true) {
    return {};
  }
  const lockedAt = nonEmptyString(value.lockedAt);
  const lockedBy = nonEmptyString(value.lockedBy);
  return {
    locked: true,
    ...(lockedAt !== undefined ? { lockedAt } : {}),
    ...(lockedBy !== undefined ? { lockedBy } : {}),
  };
}

function updateLockFields(
  entry: Record<string, unknown>,
  locked: boolean,
  lockedAt: string | undefined,
  lockedBy: string | undefined,
): void {
  if (locked) {
    entry.locked = true;
    entry.lockedAt = lockedAt;
    if (lockedBy !== undefined) {
      entry.lockedBy = lockedBy;
    } else {
      delete entry.lockedBy;
    }
    return;
  }
  delete entry.locked;
  delete entry.lockedAt;
  delete entry.lockedBy;
}

function mutateLockFieldsInArray(
  items: unknown,
  affectedIds: ReadonlySet<string>,
  locked: boolean,
  lockedAt: string | undefined,
  lockedBy: string | undefined,
): void {
  if (!Array.isArray(items)) {
    return;
  }
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const id = nonEmptyString(item.id);
    if (id === undefined || !affectedIds.has(id)) {
      continue;
    }
    if (item.authMode !== undefined && item.authMode !== "subscription") {
      continue;
    }
    updateLockFields(item, locked, lockedAt, lockedBy);
  }
}

function writeRegistryDocument(registryPath: string, document: Record<string, unknown>): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  // DELIBERATELY no randomUUID here, unlike the async write-tmp+rename sites
  // (persistence/repository.ts, persistence/index.ts, runtime/public/file-session-store.ts,
  // session/messages-log.ts, flows/store.ts). This function is fully SYNCHRONOUS:
  // there is no await point between writeFileSync and renameSync, so two calls in
  // this process cannot interleave — the first has already renamed the temp away
  // before the second starts. Across processes the `${pid}` segment differs. So the
  // same-millisecond collision that ENOENTs the async sites is unreachable here.
  // If this is ever made async, it MUST gain the randomUUID segment.
  const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, registryPath);
  chmodSync(registryPath, 0o600);
}

type LockMutationContext = {
  registryPath: string;
  document: Record<string, unknown>;
  registry: SubscriptionRegistry;
  target: SubscriptionEntry;
};

function loadLockMutationContext(
  id: string,
  options?: SubscriptionLookupOptions,
): LockMutationContext | undefined {
  const registryPath = registryPathForOptions(options);
  const document = readRegistryDocument(registryPath);
  if (!document) {
    return undefined;
  }
  const homeDir = options?.homeDir ?? (process.env.ACPX_STATE_HOME || os.homedir());
  const registry = normalizeRegistry(document, homeDir);
  const target = findSubscription(id, registry);
  if (!target) {
    return undefined;
  }
  return { registryPath, document, registry, target };
}

function affectedSubscriptionIds(
  target: SubscriptionEntry,
  registry: SubscriptionRegistry,
): string[] {
  const targetAccount = target.account || target.id;
  return registry.subscriptions
    .filter((entry) => (entry.account || entry.id) === targetAccount)
    .map((entry) => entry.id);
}

export function setSubscriptionLockState(
  id: string,
  locked: boolean,
  options?: SubscriptionLookupOptions & { lockedBy?: string },
): SubscriptionLockMutationResult | undefined {
  const context = loadLockMutationContext(id, options);
  if (!context) {
    return undefined;
  }

  const affected = affectedSubscriptionIds(context.target, context.registry);
  const affectedIds = new Set(affected);
  const lockedAt = locked ? new Date().toISOString() : undefined;
  const lockedBy = locked ? (options?.lockedBy ?? process.env.ACPX_LOCKED_BY ?? "acpx") : undefined;

  mutateLockFieldsInArray(context.document.profiles, affectedIds, locked, lockedAt, lockedBy);
  mutateLockFieldsInArray(context.document.subscriptions, affectedIds, locked, lockedAt, lockedBy);
  writeRegistryDocument(context.registryPath, context.document);

  return {
    action: "subscription_lock_set",
    subscription: context.target.id,
    locked,
    affected,
    ...(lockedAt !== undefined ? { lockedAt } : {}),
  };
}

export type ProfileRemovalOptions = SubscriptionLookupOptions & {
  /** Repoint the registry default here when the removed profile WAS the default. */
  setDefault?: string;
  /** Accept an unset default when the removed profile WAS the default. */
  clearDefault?: boolean;
};

export type ProfileRemovalResult = {
  action: "subscription_remove";
  subscription: string;
  wasDefault: boolean;
  /** Registry default AFTER the removal; null ⇒ none set (raw ~/.claude fallthrough). */
  newDefault: string | null;
  /** Profile ids still registered after the removal. */
  remaining: string[];
};

/** Drop every entry with `id` from a registry array. Returns true if any went. */
function removeEntriesById(items: unknown, id: string): boolean {
  if (!Array.isArray(items)) {
    return false;
  }
  let removed = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item: unknown = items[index];
    if (isRecord(item) && nonEmptyString(item.id) === id) {
      items.splice(index, 1);
      removed = true;
    }
  }
  return removed;
}

/** Point `default` at `replacement`, or drop the key when there is none. */
function repointRegistryDefault(
  document: Record<string, unknown>,
  replacement: string | undefined,
): void {
  if (replacement !== undefined) {
    document.default = replacement;
    return;
  }
  delete document.default;
}

function profileIdsIn(items: unknown): string[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.flatMap((item: unknown) => {
    const id = isRecord(item) ? nonEmptyString(item.id) : undefined;
    return id === undefined ? [] : [id];
  });
}

/**
 * Delete a profile from the on-disk registry, whole-file read-modify-write so
 * every sibling entry (and its lock metadata, and `quarantined`) survives
 * byte-for-byte. Works on the raw document rather than the normalized
 * `subscriptions` view, because that view is subscription-authMode-only — a
 * claude-home bridge or an openrouter profile is invisible there but is still a
 * removable registry entry.
 *
 * Optimistic concurrency, not a lock: acpx's registry writes are lockless
 * temp+rename, so we snapshot the file before the read and re-check it just
 * before the rename, ABORTING rather than clobbering a concurrent
 * lock/unlock/add that landed in between. Returns undefined when there is no
 * registry or no such id — the caller turns that into SubscriptionUnknownError.
 */
export function removeProfileFromRegistry(
  id: string,
  options?: ProfileRemovalOptions,
): ProfileRemovalResult | undefined {
  const registryPath = registryPathForOptions(options);
  const before = readRegistrySnapshot(registryPath);
  const document = readRegistryDocument(registryPath);
  if (!document) {
    return undefined;
  }

  const trimmed = id.trim();
  const removedFromProfiles = removeEntriesById(document.profiles, trimmed);
  const removedFromLegacy = removeEntriesById(document.subscriptions, trimmed);
  if (!removedFromProfiles && !removedFromLegacy) {
    return undefined;
  }

  const wasDefault = nonEmptyString(document.default) === trimmed;
  if (wasDefault) {
    repointRegistryDefault(document, nonEmptyString(options?.setDefault));
  }

  if (readRegistrySnapshot(registryPath) !== before) {
    throw new Error(
      `registry.json changed while removing "${trimmed}"; aborted rather than overwrite a ` +
        `concurrent change. Re-run the command.`,
    );
  }
  writeRegistryDocument(registryPath, document);

  return {
    action: "subscription_remove",
    subscription: trimmed,
    wasDefault,
    newDefault: nonEmptyString(document.default) ?? null,
    remaining: profileIdsIn(document.profiles),
  };
}

/** Raw file text used as the compare-and-swap token; undefined when absent. */
function readRegistrySnapshot(registryPath: string): string | undefined {
  try {
    return readFileSync(registryPath, "utf8");
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
