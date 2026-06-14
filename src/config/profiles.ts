import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  subscriptionRegistryPath,
  subscriptionsDir,
  type SubscriptionLookupOptions,
} from "./subscriptions.js";

export type AdapterId = "claude" | "claude-pty" | "codex";
export type AuthMode = "subscription" | "openrouter" | "chatgpt" | "claude-home";
export type ProfileId = string;
export type AccountId = string;

/** Effort levels valid for OpenRouter profiles with reasoningSupported=true. */
export const OPENROUTER_REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type OpenRouterReasoningEffort = (typeof OPENROUTER_REASONING_EFFORTS)[number];
export type ReasoningEffort = OpenRouterReasoningEffort;

export type ProvisioningOverride = Record<string, unknown>;

type CommonProfileFields = {
  id: string;
  label: string;
  authMode: AuthMode;
  adapter: AdapterId;
  /** Functional account seam id. Equal ids mean shared billing/usage/account. */
  account: string;
  /** Display/grouping metadata only. */
  accountEmail?: string;
  /** Q5: a profile may pin a model. */
  model?: string;
  /** ANNEX W2 schema slot; behavior lands in W2. */
  provisioning?: ProvisioningOverride;
};

export type SubscriptionProfileEntry = CommonProfileFields & {
  authMode: "subscription";
  adapter: "claude";
  credentialSource: string;
};

export type OpenRouterProfileEntry = CommonProfileFields & {
  authMode: "openrouter";
  adapter: "claude";
  model: string;
  credentialSource: null;
  openRouterApiKeyEnv?: string;
  openRouterApiKey?: string;
  reasoningEffort?: OpenRouterReasoningEffort;
  reasoningSupported?: boolean;
};

export type ClaudeHomeProfileEntry = CommonProfileFields & {
  authMode: "claude-home";
  adapter: "claude-pty";
  credentialSource: null;
  homePath: string;
};

export type ChatGptProfileEntry = CommonProfileFields & {
  authMode: "chatgpt";
  adapter: "codex";
  credentialSource: null;
  /** CODEX_HOME for this Codex/ChatGPT auth profile. Defaults to ~/.codex. */
  codexHome: string;
};

export type ProfileEntry =
  | SubscriptionProfileEntry
  | OpenRouterProfileEntry
  | ClaudeHomeProfileEntry
  | ChatGptProfileEntry;
export type ResolvedProfile = ProfileEntry;

export type EffectiveResolution = {
  selectedProfileId: ProfileId | null;
  selectedAccountId: AccountId | null;
  physicalDir: string;
  effectiveAccount: AccountId | null;
  method: "path" | "selection";
  verified: boolean;
};

export type EffectiveResolutionRecord = {
  acpx?: {
    session_options?: {
      profile?: string | null;
      subscription?: string | null;
    };
  };
};

export type QuarantinedProfileEntry = {
  reason: string;
  entry: unknown;
};

export interface ProfileRegistry {
  version: 3;
  /** Default profile id. Governs spawns with no explicit selection. */
  default?: string;
  profiles: ProfileEntry[];
  quarantined?: QuarantinedProfileEntry[];
  /** ANNEX W2 schema slot. No behavior in W5. */
  provisioning?: ProvisioningOverride;
}

function emptyProfileRegistry(): ProfileRegistry {
  return { version: 3, profiles: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isValidAuthMode(value: unknown): value is AuthMode {
  return (
    value === "subscription" ||
    value === "openrouter" ||
    value === "chatgpt" ||
    value === "claude-home"
  );
}

function isValidOpenRouterReasoningEffort(value: unknown): value is OpenRouterReasoningEffort {
  return (OPENROUTER_REASONING_EFFORTS as readonly unknown[]).includes(value);
}

export function adapterForAuthMode(authMode: AuthMode): AdapterId {
  switch (authMode) {
    case "subscription":
    case "openrouter":
      return "claude";
    case "claude-home":
      return "claude-pty";
    case "chatgpt":
      return "codex";
  }
  throw new Error("Unsupported authMode");
}

function isLegacyHarnessCompatible(authMode: AuthMode, value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (authMode === "chatgpt") {
    return value === "codex";
  }
  return value === "claude";
}

function declaredAdapterMatches(authMode: AuthMode, value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  return value === adapterForAuthMode(authMode);
}

function commonProfileFields(
  raw: Record<string, unknown>,
  authMode: AuthMode,
  id: string,
  label: string,
): CommonProfileFields {
  const model = nonEmptyString(raw.model);
  const accountEmail = nonEmptyString(raw.accountEmail);
  const provisioning = isRecord(raw.provisioning) ? raw.provisioning : undefined;
  return {
    id,
    label,
    authMode,
    adapter: adapterForAuthMode(authMode),
    account: nonEmptyString(raw.account) ?? id,
    ...(accountEmail !== undefined ? { accountEmail } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(provisioning !== undefined ? { provisioning } : {}),
  };
}

type NormalizeProfileResult =
  | { profile: ProfileEntry }
  | { quarantine: QuarantinedProfileEntry; id?: string };
type NormalizeProfileQuarantine = Extract<NormalizeProfileResult, { quarantine: unknown }>;
type ProfileEnvelope = { raw: Record<string, unknown>; id: string; authMode: AuthMode };

function quarantine(entry: unknown, reason: string, id?: string): NormalizeProfileQuarantine {
  return { quarantine: { reason, entry }, ...(id !== undefined ? { id } : {}) };
}

function resolveDeclaredAuthMode(raw: Record<string, unknown>): AuthMode | undefined {
  if (raw.authMode === undefined) {
    return "subscription";
  }
  return isValidAuthMode(raw.authMode) ? raw.authMode : undefined;
}

function validateProfileEnvelope(value: unknown): ProfileEnvelope | NormalizeProfileQuarantine {
  if (!isRecord(value)) {
    return quarantine(value, "profile entry is not an object");
  }
  const id = nonEmptyString(value.id);
  if (!id) {
    return quarantine(value, "profile entry is missing id");
  }
  const authMode = resolveDeclaredAuthMode(value);
  if (!authMode) {
    return quarantine(value, `profile "${id}" declares unknown authMode`, id);
  }
  if (!isLegacyHarnessCompatible(authMode, value.harness)) {
    return quarantine(
      value,
      `profile "${id}" legacy harness conflicts with authMode "${authMode}"`,
      id,
    );
  }
  if (!declaredAdapterMatches(authMode, value.adapter)) {
    return quarantine(
      value,
      `profile "${id}" adapter must be "${adapterForAuthMode(authMode)}" for authMode "${authMode}"`,
      id,
    );
  }
  return { raw: value, id, authMode };
}

function normalizeSubscriptionProfile(
  raw: Record<string, unknown>,
  homeDir: string,
  common: CommonProfileFields,
): NormalizeProfileResult {
  return {
    profile: {
      ...common,
      authMode: "subscription",
      adapter: "claude",
      credentialSource:
        nonEmptyString(raw.credentialSource) ?? path.join(subscriptionsDir(homeDir), common.id),
    },
  };
}

function normalizeOpenRouterProfile(
  raw: Record<string, unknown>,
  common: CommonProfileFields,
): NormalizeProfileResult {
  const model = nonEmptyString(raw.model);
  if (!model) {
    return quarantine(raw, `profile "${common.id}" openrouter auth requires model`, common.id);
  }
  const credentials = openRouterCredentialFields(raw, common.id);
  if ("quarantine" in credentials) {
    return credentials;
  }
  const reasoning = openRouterReasoningFields(raw, common.id);
  if ("quarantine" in reasoning) {
    return reasoning;
  }
  return {
    profile: {
      ...common,
      authMode: "openrouter",
      adapter: "claude",
      credentialSource: null,
      model,
      ...credentials,
      ...reasoning,
    },
  };
}

function openRouterCredentialFields(
  raw: Record<string, unknown>,
  id: string,
):
  | Pick<OpenRouterProfileEntry, "openRouterApiKey" | "openRouterApiKeyEnv">
  | NormalizeProfileQuarantine {
  const openRouterApiKey = nonEmptyString(raw.openRouterApiKey);
  const openRouterApiKeyEnv = nonEmptyString(raw.openRouterApiKeyEnv);
  if (!openRouterApiKey && !openRouterApiKeyEnv) {
    return quarantine(
      raw,
      `profile "${id}" openrouter auth requires openRouterApiKey or openRouterApiKeyEnv`,
      id,
    );
  }
  return {
    ...(openRouterApiKey !== undefined ? { openRouterApiKey } : {}),
    ...(openRouterApiKeyEnv !== undefined ? { openRouterApiKeyEnv } : {}),
  };
}

function openRouterReasoningFields(
  raw: Record<string, unknown>,
  id: string,
):
  | Pick<OpenRouterProfileEntry, "reasoningEffort" | "reasoningSupported">
  | NormalizeProfileQuarantine {
  if (raw.reasoningEffort !== undefined && !isValidOpenRouterReasoningEffort(raw.reasoningEffort)) {
    return quarantine(raw, `profile "${id}" has invalid OpenRouter reasoningEffort`, id);
  }
  return {
    ...(raw.reasoningEffort !== undefined ? { reasoningEffort: raw.reasoningEffort } : {}),
    ...(raw.reasoningSupported === true ? { reasoningSupported: true } : {}),
  };
}

function normalizeClaudeHomeProfile(
  raw: Record<string, unknown>,
  common: CommonProfileFields,
): NormalizeProfileResult {
  const homePath = nonEmptyString(raw.homePath);
  if (!homePath) {
    return quarantine(raw, `profile "${common.id}" claude-home auth requires homePath`, common.id);
  }
  return {
    profile: {
      ...common,
      authMode: "claude-home",
      adapter: "claude-pty",
      credentialSource: null,
      homePath,
    },
  };
}

function normalizeChatGptProfile(
  raw: Record<string, unknown>,
  homeDir: string,
  common: CommonProfileFields,
): NormalizeProfileResult {
  return {
    profile: {
      ...common,
      authMode: "chatgpt",
      adapter: "codex",
      credentialSource: null,
      codexHome: nonEmptyString(raw.codexHome) ?? path.join(homeDir, ".codex"),
    },
  };
}

function normalizeProfileEntry(value: unknown, homeDir: string): NormalizeProfileResult {
  const envelope = validateProfileEnvelope(value);
  if ("quarantine" in envelope) {
    return envelope;
  }
  const label = nonEmptyString(envelope.raw.label) ?? envelope.id;
  const common = commonProfileFields(envelope.raw, envelope.authMode, envelope.id, label);

  switch (envelope.authMode) {
    case "subscription":
      return normalizeSubscriptionProfile(envelope.raw, homeDir, common);
    case "openrouter":
      return normalizeOpenRouterProfile(envelope.raw, common);
    case "claude-home":
      return normalizeClaudeHomeProfile(envelope.raw, common);
    case "chatgpt":
      return normalizeChatGptProfile(envelope.raw, homeDir, common);
  }
  throw new Error("Unsupported authMode");
}

function profileFromV1Subscription(value: unknown, homeDir: string): ProfileEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = nonEmptyString(value.id);
  if (!id) {
    return undefined;
  }
  const label = nonEmptyString(value.label) ?? id;
  const accountEmail = nonEmptyString(value.accountEmail);
  return {
    id,
    label,
    authMode: "subscription",
    adapter: "claude",
    account: nonEmptyString(value.account) ?? id,
    ...(accountEmail !== undefined ? { accountEmail } : {}),
    credentialSource:
      nonEmptyString(value.configDir) ??
      nonEmptyString(value.credentialSource) ??
      path.join(subscriptionsDir(homeDir), id),
  };
}

function getValidProfileId(profile: ProfileEntry): string {
  return profile.id;
}

function serializeProfileForRegistry(profile: ProfileEntry): Record<string, unknown> {
  const common = {
    id: profile.id,
    label: profile.label,
    authMode: profile.authMode,
    adapter: profile.adapter,
    account: profile.account,
    accountEmail: profile.accountEmail,
    model: profile.model,
    provisioning: profile.provisioning,
  };
  if (profile.authMode === "subscription") {
    return { ...common, credentialSource: profile.credentialSource };
  }
  if (profile.authMode === "openrouter") {
    return {
      ...common,
      model: profile.model,
      openRouterApiKeyEnv: profile.openRouterApiKeyEnv,
      openRouterApiKey: profile.openRouterApiKey,
      reasoningSupported: profile.reasoningSupported,
      reasoningEffort: profile.reasoningEffort,
    };
  }
  if (profile.authMode === "claude-home") {
    return { ...common, homePath: profile.homePath };
  }
  return { ...common, codexHome: profile.codexHome };
}

function normalizeExistingQuarantine(value: unknown): QuarantinedProfileEntry | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const reason = nonEmptyString(value.reason);
  if (!reason || !("entry" in value)) {
    return undefined;
  }
  return { reason, entry: value.entry };
}

function addProfileOrQuarantine(
  result: NormalizeProfileResult,
  profiles: ProfileEntry[],
  seen: Set<string>,
  quarantined: QuarantinedProfileEntry[],
): void {
  if ("quarantine" in result) {
    quarantined.push(result.quarantine);
    return;
  }
  const id = getValidProfileId(result.profile);
  if (seen.has(id)) {
    quarantined.push({
      reason: `duplicate profile id "${id}"`,
      entry: serializeProfileForRegistry(result.profile),
    });
    return;
  }
  seen.add(id);
  profiles.push(result.profile);
}

type NormalizedRegistryDocument = {
  registry: ProfileRegistry;
  migratedJson?: Record<string, unknown>;
  migrationMessages: string[];
};

function storedProfileRequiresMigration(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return true;
  }
  const authMode = resolveDeclaredAuthMode(entry);
  if (authMode === undefined) {
    return true;
  }
  return (
    entry.harness !== undefined ||
    entry.account === undefined ||
    entry.adapter === undefined ||
    entry.adapter !== adapterForAuthMode(authMode)
  );
}

function registryNeedsMigration(
  raw: Record<string, unknown>,
  newQuarantined: readonly QuarantinedProfileEntry[],
): boolean {
  if (raw.version !== 3 || Array.isArray(raw.subscriptions) || newQuarantined.length > 0) {
    return true;
  }
  if (!Array.isArray(raw.profiles)) {
    return false;
  }
  return raw.profiles.some((entry) => storedProfileRequiresMigration(entry));
}

function addProfileArray(
  items: unknown,
  homeDir: string,
  profiles: ProfileEntry[],
  seen: Set<string>,
  quarantined: QuarantinedProfileEntry[],
): void {
  if (!Array.isArray(items)) {
    return;
  }
  for (const item of items) {
    addProfileOrQuarantine(normalizeProfileEntry(item, homeDir), profiles, seen, quarantined);
  }
}

function addV1SubscriptionArray(
  items: unknown,
  homeDir: string,
  profiles: ProfileEntry[],
  seen: Set<string>,
): void {
  if (!Array.isArray(items)) {
    return;
  }
  for (const item of items) {
    const profile = profileFromV1Subscription(item, homeDir);
    if (profile && !seen.has(profile.id)) {
      seen.add(profile.id);
      profiles.push(profile);
    }
  }
}

function normalizeQuarantineArray(items: unknown): QuarantinedProfileEntry[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((entry) => normalizeExistingQuarantine(entry))
    .filter((entry): entry is QuarantinedProfileEntry => entry !== undefined);
}

function buildRegistry(
  value: Record<string, unknown>,
  profiles: ProfileEntry[],
  quarantined: QuarantinedProfileEntry[],
): ProfileRegistry {
  const defaultId = nonEmptyString(value.default);
  const provisioning = isRecord(value.provisioning) ? value.provisioning : undefined;
  return {
    version: 3,
    ...(defaultId !== undefined ? { default: defaultId } : {}),
    profiles,
    ...(quarantined.length > 0 ? { quarantined } : {}),
    ...(provisioning !== undefined ? { provisioning } : {}),
  };
}

function migratedRegistryJson(registry: ProfileRegistry): Record<string, unknown> {
  return {
    version: 3,
    ...(registry.default !== undefined ? { default: registry.default } : {}),
    ...(registry.provisioning !== undefined ? { provisioning: registry.provisioning } : {}),
    profiles: registry.profiles.map(serializeProfileForRegistry),
    ...(registry.quarantined !== undefined ? { quarantined: registry.quarantined } : {}),
  };
}

function normalizeRegistryDocument(
  value: Record<string, unknown>,
  homeDir: string,
): NormalizedRegistryDocument {
  const profiles: ProfileEntry[] = [];
  const seen = new Set<string>();
  const newQuarantined: QuarantinedProfileEntry[] = [];

  addProfileArray(value.profiles, homeDir, profiles, seen, newQuarantined);
  addV1SubscriptionArray(value.subscriptions, homeDir, profiles, seen);

  const existingQuarantined = normalizeQuarantineArray(value.quarantined);
  const quarantined = [...existingQuarantined, ...newQuarantined];
  const registry = buildRegistry(value, profiles, quarantined);

  const migrationMessages = newQuarantined.map((entry) => entry.reason);
  if (!registryNeedsMigration(value, newQuarantined)) {
    return { registry, migrationMessages };
  }

  return { registry, migratedJson: migratedRegistryJson(registry), migrationMessages };
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

function writeV3Migration(
  registryPath: string,
  migratedJson: Record<string, unknown>,
  migrationMessages: readonly string[],
): void {
  try {
    const backupPath = `${registryPath}.pre-v3.bak`;
    if (!existsSync(backupPath)) {
      copyFileSync(registryPath, backupPath);
      chmodSync(backupPath, 0o600);
    }
    writeFileSync(registryPath, `${JSON.stringify(migratedJson, null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(registryPath, 0o600);
    for (const message of migrationMessages) {
      process.stderr.write(`[acpx] registry v3 migration quarantined entry: ${message}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[acpx] registry v3 migration write failed: ${message}\n`);
  }
}

/**
 * Load the profile registry. Supports:
 *  v3: { "version": 3, "profiles": [...] }
 *  v2/hybrid: { "profiles": [...], "subscriptions": [...] } — migrated on read
 *  v1: { "subscriptions": [...] } — synthesized, written through as v3
 * Never throws; returns an empty registry on any read/parse error.
 */
export function loadProfileRegistry(options?: SubscriptionLookupOptions): ProfileRegistry {
  const homeDir = options?.homeDir ?? (process.env.ACPX_STATE_HOME || os.homedir());
  const registryPath = options?.registryPath ?? subscriptionRegistryPath(homeDir);
  const parsed = readRegistryJson(registryPath);
  if (!parsed) {
    return emptyProfileRegistry();
  }

  const result = normalizeRegistryDocument(parsed, homeDir);
  if (result.migratedJson !== undefined) {
    writeV3Migration(registryPath, result.migratedJson, result.migrationMessages);
  }
  return result.registry;
}

export function findProfile(id: string, registry: ProfileRegistry): ProfileEntry | undefined {
  const trimmed = id.trim();
  if (!trimmed) {
    return undefined;
  }
  return registry.profiles.find((entry) => entry.id === trimmed);
}

/**
 * Return the valid effort levels for a profile, or null when reasoning is not
 * applicable (used by CLI validation and the `profiles` discovery command).
 * - subscription / claude-home -> Claude set: low/medium/high/xhigh/max
 * - openrouter + reasoningSupported -> OR set: minimal/low/medium/high
 * - openrouter without reasoningSupported -> null
 */
export function getValidEffortsForProfile(profile: ProfileEntry): readonly string[] | null {
  if (profile.authMode === "subscription" || profile.authMode === "claude-home") {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  if (profile.authMode === "openrouter" && profile.reasoningSupported) {
    return OPENROUTER_REASONING_EFFORTS;
  }
  return null;
}

/**
 * id -> homePath map over ALL claude-home profiles in the registry — the value
 * of the bridge's INDEPENDENT_CLAUDE_HOME_MAP allow-list env. Always the full
 * map (not a single entry) so the bridge's unknown-selector diagnostics stay
 * meaningful.
 */
export function buildClaudeHomeMap(registry: ProfileRegistry): Record<string, string> {
  const map: Record<string, string> = {};
  for (const profile of registry.profiles) {
    if (profile.authMode === "claude-home") {
      map[profile.id] = profile.homePath;
    }
  }
  return map;
}

/**
 * True when `profileId` names a claude-home profile in the registry. Used to
 * keep the current W4-out-of-scope failover exclusion and to gate the bridge
 * `_meta` selector.
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

export async function loadResolvedProfiles(
  options?: SubscriptionLookupOptions,
): Promise<ResolvedProfile[]> {
  return loadProfileRegistry(options).profiles;
}

export async function getResolvedProfile(
  id: ProfileId,
  options?: SubscriptionLookupOptions,
): Promise<ResolvedProfile | undefined> {
  return findProfile(id, loadProfileRegistry(options));
}

export async function siblingProfiles(
  of: ProfileId,
  options?: SubscriptionLookupOptions,
): Promise<ResolvedProfile[]> {
  const registry = loadProfileRegistry(options);
  const profile = findProfile(of, registry);
  if (!profile) {
    throw new Error(`[acpx] profile "${of}" not found; cannot resolve account siblings`);
  }
  return registry.profiles.filter(
    (entry) => entry.authMode === profile.authMode && entry.account !== profile.account,
  );
}

export function transcriptAnchorDir(profile: ResolvedProfile): string | null {
  switch (profile.authMode) {
    case "subscription":
      return profile.credentialSource;
    case "claude-home":
      return path.join(profile.homePath, ".claude");
    case "openrouter":
    case "chatgpt":
      return null;
  }
  throw new Error("Unsupported authMode");
}

function normalizeAnchorPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return stripTrailingPathSeparator(realpathSync.native(resolved));
  } catch {
    return stripTrailingPathSeparator(resolved);
  }
}

function stripTrailingPathSeparator(value: string): string {
  const root = path.parse(value).root;
  let current = value;
  while (current.length > root.length && /[/\\]$/.test(current)) {
    current = current.slice(0, -1);
  }
  return current;
}

function profileMatchesPhysicalDir(profile: ResolvedProfile, normalizedDir: string): boolean {
  const anchor = transcriptAnchorDir(profile);
  return anchor !== null && normalizeAnchorPath(anchor) === normalizedDir;
}

function profileMatchesCodexHome(profile: ResolvedProfile, normalizedDir: string): boolean {
  return profile.authMode === "chatgpt" && normalizeAnchorPath(profile.codexHome) === normalizedDir;
}

function resolvePhysicalAccountFromRegistry(
  dir: string,
  registry: ProfileRegistry,
): AccountId | null {
  const normalizedDir = normalizeAnchorPath(dir);
  const match = registry.profiles.find((profile) =>
    profileMatchesPhysicalDir(profile, normalizedDir),
  );
  return match?.account ?? null;
}

function resolveChatGptPhysicalAccountFromRegistry(
  dir: string,
  registry: ProfileRegistry,
): AccountId | null {
  const normalizedDir = normalizeAnchorPath(dir);
  const match = registry.profiles.find((profile) =>
    profileMatchesCodexHome(profile, normalizedDir),
  );
  return match?.account ?? null;
}

export async function resolvePhysicalAccount(
  dir: string,
  options?: SubscriptionLookupOptions,
): Promise<AccountId | null> {
  return resolvePhysicalAccountFromRegistry(dir, loadProfileRegistry(options));
}

function selectedProfileIdFromRecord(record: EffectiveResolutionRecord): ProfileId | null {
  return (
    record.acpx?.session_options?.profile ?? record.acpx?.session_options?.subscription ?? null
  );
}

function physicalDirFromEnv(env: NodeJS.ProcessEnv): string {
  return (
    env.CLAUDE_CONFIG_DIR ??
    env.CODEX_HOME ??
    env.ACPX_EFFECTIVE_ANCHOR ??
    path.join(os.homedir(), ".claude")
  );
}

function effectiveResolutionForProfile(
  selectedProfile: ResolvedProfile | undefined,
  physicalDir: string,
  registry: ProfileRegistry,
): Pick<EffectiveResolution, "effectiveAccount" | "method"> {
  if (selectedProfile?.authMode === "openrouter") {
    return { effectiveAccount: selectedProfile.account, method: "selection" };
  }
  if (selectedProfile?.authMode === "chatgpt") {
    return {
      effectiveAccount: resolveChatGptPhysicalAccountFromRegistry(physicalDir, registry),
      method: "path",
    };
  }
  return {
    effectiveAccount: resolvePhysicalAccountFromRegistry(physicalDir, registry),
    method: "path",
  };
}

export async function verifyEffectiveResolution(
  record: EffectiveResolutionRecord,
  env: NodeJS.ProcessEnv,
  options?: SubscriptionLookupOptions,
): Promise<EffectiveResolution> {
  const registry = loadProfileRegistry(options);
  const selectedProfileId = selectedProfileIdFromRecord(record);
  const selectedProfile = selectedProfileId ? findProfile(selectedProfileId, registry) : undefined;
  const physicalDir = physicalDirFromEnv(env);
  const { effectiveAccount, method } = effectiveResolutionForProfile(
    selectedProfile,
    physicalDir,
    registry,
  );
  const selectedAccountId = selectedProfile?.account ?? null;
  return {
    selectedProfileId,
    selectedAccountId,
    physicalDir,
    effectiveAccount,
    method,
    verified: selectedAccountId === null || selectedAccountId === effectiveAccount,
  };
}
