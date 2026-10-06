import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import type { ProfileEntry, ProfileRegistry } from "./profiles.js";
import { subscriptionRegistryPath, type SubscriptionLookupOptions } from "./subscriptions.js";

export type ProvisioningWarningBreadcrumb = {
  at: string;
  profile_id?: string;
  auth_mode?: string;
  adapter?: string;
  anchor?: string;
  message: string;
};

export type ProvisioningWarningHandler = (warning: ProvisioningWarningBreadcrumb) => void;

type OsHarnessHookConfig = {
  event: string;
  marker: string;
};

type OsHarnessConfig = {
  enabled: true;
  sourceDir: string;
  entries: string[];
  hook: OsHarnessHookConfig;
};

type ProvisioningContext = {
  registry: ProfileRegistry;
  profile: ProfileEntry;
  env: NodeJS.ProcessEnv;
  onWarning?: ProvisioningWarningHandler;
};

type MaterializerContext = {
  profile: ProfileEntry;
  anchor: string;
  config: OsHarnessConfig;
  onWarning?: ProvisioningWarningHandler;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function uniqueStrings(value: unknown): string[] | undefined {
  if (!isUnknownArray(value)) {
    return undefined;
  }
  const entries = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length !== value.length || entries.length === 0) {
    return undefined;
  }
  return [...new Set(entries)];
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function deepMergeRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = deepMergeRecords(current, value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function registryProvisioningBlock(registry: ProfileRegistry): Record<string, unknown> | undefined {
  return isRecord(registry.provisioning) ? registry.provisioning : undefined;
}

function profileProvisioningBlock(profile: ProfileEntry): Record<string, unknown> | undefined {
  return isRecord(profile.provisioning) ? profile.provisioning : undefined;
}

function resolveMergedOsHarnessBlock(
  registry: ProfileRegistry,
  profile: ProfileEntry,
): Record<string, unknown> | undefined {
  const registryProvisioning = registryProvisioningBlock(registry);
  if (!registryProvisioning) {
    return undefined;
  }
  const rootHarness = isRecord(registryProvisioning.osHarness)
    ? registryProvisioning.osHarness
    : {};
  const profileProvisioning = profileProvisioningBlock(profile);
  const profileHarness = isRecord(profileProvisioning?.osHarness)
    ? profileProvisioning.osHarness
    : {};
  if (Object.keys(rootHarness).length === 0 && Object.keys(profileHarness).length === 0) {
    return undefined;
  }
  return deepMergeRecords(rootHarness, profileHarness);
}

type ParsedOsHarnessFields = {
  sourceDir?: string;
  entries?: string[];
  event?: string;
  marker?: string;
};

type CompleteOsHarnessFields = {
  sourceDir: string;
  entries: string[];
  event: string;
  marker: string;
};

function parseOsHarnessFields(merged: Record<string, unknown>): ParsedOsHarnessFields {
  const sourceDir = nonEmptyString(merged.sourceDir);
  const entries = uniqueStrings(merged.entries);
  const hook = isRecord(merged.hook) ? merged.hook : undefined;
  const event = nonEmptyString(hook?.event);
  const marker = nonEmptyString(hook?.marker);
  return {
    ...(sourceDir !== undefined ? { sourceDir } : {}),
    ...(entries !== undefined ? { entries } : {}),
    ...(event !== undefined ? { event } : {}),
    ...(marker !== undefined ? { marker } : {}),
  };
}

function hasCompleteOsHarnessFields(
  fields: ParsedOsHarnessFields,
): fields is CompleteOsHarnessFields {
  return (
    fields.sourceDir !== undefined &&
    fields.entries !== undefined &&
    fields.event !== undefined &&
    fields.marker !== undefined
  );
}

function warnInvalidOsHarnessConfig(
  profile: ProfileEntry,
  onWarning?: ProvisioningWarningHandler,
): void {
  emitProvisioningWarning(
    {
      profile_id: profile.id,
      auth_mode: profile.authMode,
      adapter: profile.adapter,
      message:
        `profile "${profile.id}" has invalid osHarness provisioning config; ` +
        `expected enabled, sourceDir, entries, hook.event, and hook.marker`,
    },
    onWarning,
  );
}

function parseOsHarnessConfig(
  registry: ProfileRegistry,
  profile: ProfileEntry,
  onWarning?: ProvisioningWarningHandler,
): OsHarnessConfig | undefined {
  const merged = resolveMergedOsHarnessBlock(registry, profile);
  if (!merged || merged.enabled !== true) {
    return undefined;
  }

  const fields = parseOsHarnessFields(merged);
  if (!hasCompleteOsHarnessFields(fields)) {
    warnInvalidOsHarnessConfig(profile, onWarning);
    return undefined;
  }

  return {
    enabled: true,
    sourceDir: path.resolve(fields.sourceDir),
    entries: fields.entries,
    hook: { event: fields.event, marker: fields.marker },
  };
}

function emitProvisioningWarning(
  warning: Omit<ProvisioningWarningBreadcrumb, "at">,
  onWarning?: ProvisioningWarningHandler,
): void {
  const breadcrumb = { at: new Date().toISOString(), ...warning };
  process.stderr.write(`[acpx] provisioning warning: ${breadcrumb.message}\n`);
  onWarning?.(breadcrumb);
}

function warnForError(
  params: {
    profile: ProfileEntry;
    anchor?: string;
    message: string;
    error: unknown;
  },
  onWarning?: ProvisioningWarningHandler,
): void {
  const detail = params.error instanceof Error ? params.error.message : String(params.error);
  emitProvisioningWarning(
    {
      profile_id: params.profile.id,
      auth_mode: params.profile.authMode,
      adapter: params.profile.adapter,
      ...(params.anchor !== undefined ? { anchor: params.anchor } : {}),
      message: `${params.message}: ${detail}`,
    },
    onWarning,
  );
}

function pathExistsAsDirOrFile(entryPath: string): boolean {
  try {
    lstatSync(entryPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeLinkTarget(linkPath: string, rawTarget: string): string {
  return path.resolve(path.dirname(linkPath), rawTarget);
}

function isExpectedSymlink(linkPath: string, expectedTarget: string): boolean {
  try {
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      return false;
    }
    return normalizeLinkTarget(linkPath, readlinkSync(linkPath)) === path.resolve(expectedTarget);
  } catch {
    return false;
  }
}

function symlinkEntry(params: {
  anchor: string;
  sourceDir: string;
  entry: string;
  replaceExistingSymlink: boolean;
  profile: ProfileEntry;
  onWarning?: ProvisioningWarningHandler;
}): void {
  const source = path.join(params.sourceDir, params.entry);
  const target = path.join(params.anchor, params.entry);
  if (!existsSync(source)) {
    emitProvisioningWarning(
      {
        profile_id: params.profile.id,
        auth_mode: params.profile.authMode,
        adapter: params.profile.adapter,
        anchor: params.anchor,
        message: `osHarness source entry missing: ${source}`,
      },
      params.onWarning,
    );
    return;
  }

  if (isExpectedSymlink(target, source)) {
    return;
  }

  if (pathExistsAsDirOrFile(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() && params.replaceExistingSymlink) {
      unlinkSync(target);
    } else {
      emitProvisioningWarning(
        {
          profile_id: params.profile.id,
          auth_mode: params.profile.authMode,
          adapter: params.profile.adapter,
          anchor: params.anchor,
          message: `osHarness entry ${target} already exists and is not the acpx-owned symlink; leaving it unchanged`,
        },
        params.onWarning,
      );
      return;
    }
  }

  symlinkSync(source, target);
}

function materializeAcpxOwnedAnchor(ctx: MaterializerContext): void {
  mkdirSync(ctx.anchor, { recursive: true });
  for (const entry of ctx.config.entries) {
    symlinkEntry({
      anchor: ctx.anchor,
      sourceDir: ctx.config.sourceDir,
      entry,
      replaceExistingSymlink: true,
      profile: ctx.profile,
      onWarning: ctx.onWarning,
    });
  }
}

function profileAnchor(profile: ProfileEntry, env: NodeJS.ProcessEnv): string | undefined {
  switch (profile.authMode) {
    case "subscription":
      return env.CLAUDE_CONFIG_DIR ?? profile.credentialSource;
    case "chatgpt":
      return undefined;
  }
  return undefined;
}

function materializeProfileOsHarness(
  profile: ProfileEntry,
  env: NodeJS.ProcessEnv,
  config: OsHarnessConfig,
  onWarning?: ProvisioningWarningHandler,
): void {
  if (profile.adapter === "codex") {
    emitProvisioningWarning(
      {
        profile_id: profile.id,
        auth_mode: profile.authMode,
        adapter: profile.adapter,
        message: "no harness materializer for adapter family codex",
      },
      onWarning,
    );
    return;
  }

  const anchor = profileAnchor(profile, env);
  if (!anchor) {
    emitProvisioningWarning(
      {
        profile_id: profile.id,
        auth_mode: profile.authMode,
        adapter: profile.adapter,
        message: `profile "${profile.id}" has no osHarness materialization anchor`,
      },
      onWarning,
    );
    return;
  }

  const ctx = {
    profile,
    anchor,
    config,
    onWarning,
  };
  materializeAcpxOwnedAnchor(ctx);
}

export function ensureProfileOsHarnessProvisioning({
  registry,
  profile,
  env,
  onWarning,
}: ProvisioningContext): void {
  const config = parseOsHarnessConfig(registry, profile, onWarning);
  if (!config) {
    return;
  }
  try {
    materializeProfileOsHarness(profile, env, config, onWarning);
  } catch (error) {
    warnForError(
      {
        profile,
        anchor: profileAnchor(profile, env),
        message: `osHarness provisioning failed for profile "${profile.id}"`,
        error,
      },
      onWarning,
    );
  }
}

export function registryMayConfigureProvisioning(options?: SubscriptionLookupOptions): boolean {
  const homeDir = options?.homeDir;
  const registryPath = options?.registryPath ?? subscriptionRegistryPath(homeDir);
  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as unknown;
    return isRecord(parsed) && isRecord(parsed.provisioning);
  } catch {
    return false;
  }
}
