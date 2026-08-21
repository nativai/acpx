import fs from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { acpAdapterKind } from "../acp/agent-command.js";
import { isLegacyZedCodexAcpInvocation } from "../acp/codex-compat.js";
import {
  listBuiltInAgents,
  resolveAgentCommand,
  resolveAgentNameFromCommand,
} from "../agent-registry.js";
import {
  findProfile,
  isSubscriptionProfileLocked,
  loadProfileRegistry,
  type ProfileEntry,
  type ProfileRegistry,
} from "../config/profiles.js";
import {
  findSubscription,
  isSubscriptionLocked,
  loadSubscriptionRegistry,
} from "../config/subscriptions.js";
import {
  AgentSpawnError,
  ProfileClassMismatchError,
  ProfileUnknownError,
  SessionNotFoundError,
  SubscriptionChangeRequiresSwitchError,
  SubscriptionLockedError,
  SubscriptionUnknownError,
} from "../errors.js";
import { loadPermissionPolicySpec } from "../permission-policy.js";
import {
  mergePromptSourceWithText,
  parsePromptSource,
  promptToDisplayText,
  PromptInputValidationError,
  textPrompt,
} from "../prompt-content.js";
import { getResolvedProfile } from "../runtime/engine/account-seam.js";
import { isAutoSubscriptionSentinel } from "../runtime/engine/auto-subscription.js";
import { sessionOptionsFromRecord } from "../runtime/engine/session-options.js";
import { exportSession } from "../session/export.js";
import { importSession } from "../session/import.js";
import { getDesiredConfigOptions } from "../session/mode-preference.js";
import { guardImplicitFable, resolveSpawnModelSource } from "../session/model-guard.js";
import {
  findGitRepositoryRoot,
  findSession,
  findSessionByDirectoryWalk,
  isoNow,
  isTemplateRecord,
  listSessions,
  migrateTemplateSlugs,
  normalizeName,
  persistTemplateMark,
  resolveGlobalSessionByName,
  resolveSessionByExactName,
  matchesPruneSessionId,
  resolveSessionRecord,
  resolveTemplateSelector,
  rollbackTemplateSlug,
  DeletionManifestWriteError,
  describeManifestFailure,
  writeSessionRecord,
  writeSessionRecordWithLifecycle,
} from "../session/persistence.js";
import type { MigrateSlugsResult, TemplateRollbackResult } from "../session/persistence.js";
import { EXIT_CODES } from "../types.js";
import type {
  OutputFormat,
  OutputPolicy,
  SessionAgentContent,
  SessionRecord,
  SessionUserContent,
  PermissionPolicy,
} from "../types.js";
import type { ResolvedAcpxConfig } from "./config.js";
import {
  hasExplicitPermissionModeFlag,
  parseHistoryLimit,
  resolveAgentInvocation,
  resolveGlobalFlags,
  resolveOutputPolicy,
  resolvePermissionMode,
  type ExecFlags,
  type GlobalFlags,
  type SessionsCopyFlags,
  type SessionsExportFlags,
  type PromptFlags,
  type SessionsImportFlags,
  type SessionsHistoryFlags,
  type SessionsListFlags,
  type SessionsNewFlags,
  type SessionsOwnerStatusFlags,
  type SessionsPruneFlags,
  type SessionsTemplateFlags,
  type SessionsCloseFlags,
  type StatusFlags,
} from "./flags.js";
import { emitJsonResult } from "./output/json-output.js";
// Type-only, so the render module stays lazily imported at runtime.
import type { PruneRefusal, PruneScope } from "./output/render.js";
import {
  explicitSessionIdFromSelector,
  parseSessionIdFromUrl,
  resolveExplicitSessionRecord,
  resolveSessionTargetSelector,
  type SessionTargetSelector,
} from "./session-selector.js";
import {
  maybeStampBrickLink,
  resolveBrickFlagRef,
  warnIfBrickDoesNotResolve,
} from "./session/brick-link.js";
import type { SessionListResult } from "./session/contracts.js";
import { composeForkDivergenceNotice } from "./session/fork-handoff.js";
import {
  applyBrickFlag,
  withInheritedBrick,
  withInheritedAgentCommand,
  withInheritedModel,
  withInheritedProfile,
  withInheritedReasoningEffort,
  withInheritedTaskFolder,
} from "./session/inherited-metadata.js";
import { mergeSessionMetadata, validateSessionMetadataValue } from "./session/session-metadata.js";

class NoSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoSessionError";
  }
}

type SessionModule = typeof import("../session/session.js");
type OutputModule = typeof import("./output/output.js");
type OutputRenderModule = typeof import("./output/render.js");

let sessionModulePromise: Promise<SessionModule> | undefined;
let outputModulePromise: Promise<OutputModule> | undefined;
let outputRenderModulePromise: Promise<OutputRenderModule> | undefined;

function loadSessionModule(): Promise<SessionModule> {
  sessionModulePromise ??= import("../session/session.js");
  return sessionModulePromise;
}

function loadOutputModule(): Promise<OutputModule> {
  outputModulePromise ??= import("./output/output.js");
  return outputModulePromise;
}

function loadOutputRenderModule(): Promise<OutputRenderModule> {
  outputRenderModulePromise ??= import("./output/render.js");
  return outputRenderModulePromise;
}

async function readPromptInputFromStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
  }
  return data;
}

async function readPrompt(
  promptParts: string[],
  filePath: string | undefined,
  cwd: string,
): Promise<import("../types.js").PromptInput> {
  try {
    if (filePath) {
      return await readPromptFromFile(filePath, cwd, promptParts);
    }

    const joined = promptParts.join(" ").trim();
    if (joined.length > 0) {
      return textPrompt(joined);
    }

    if (process.stdin.isTTY) {
      throw new InvalidArgumentError(
        "Prompt is required (pass as argument, --file, or pipe via stdin)",
      );
    }

    const prompt = parsePromptSource(await readPromptInputFromStdin());
    if (prompt.length === 0) {
      throw new InvalidArgumentError("Prompt from stdin is empty");
    }

    return prompt;
  } catch (error) {
    if (error instanceof PromptInputValidationError) {
      throw new InvalidArgumentError(error.message);
    }
    throw error;
  }
}

async function readPromptFromFile(
  filePath: string,
  cwd: string,
  promptParts: string[],
): Promise<import("../types.js").PromptInput> {
  const source =
    filePath === "-"
      ? await readPromptInputFromStdin()
      : await fs.readFile(path.resolve(cwd, filePath), "utf8");
  const prompt = mergePromptSourceWithText(source, promptParts.join(" "));
  if (prompt.length === 0) {
    throw new InvalidArgumentError("Prompt from --file is empty");
  }
  return prompt;
}

function applyPermissionExitCode(result: {
  permissionStats: {
    requested: number;
    approved: number;
    denied: number;
    cancelled: number;
  };
}): void {
  const stats = result.permissionStats;
  const deniedOrCancelled = stats.denied + stats.cancelled;

  if (stats.requested > 0 && stats.approved === 0 && deniedOrCancelled > 0) {
    process.exitCode = EXIT_CODES.PERMISSION_DENIED;
  }
}

function maybeEmitQuietPermissionUnavailable(params: {
  result: Parameters<typeof applyPermissionExitCode>[0];
  outputPolicy: OutputPolicy;
  nonInteractivePermissions?: string;
}): void {
  const stats = params.result.permissionStats;
  if (
    params.outputPolicy.format === "quiet" &&
    params.nonInteractivePermissions === "fail" &&
    stats.requested > 0 &&
    stats.approved === 0 &&
    stats.denied + stats.cancelled > 0
  ) {
    process.stderr.write("Permission prompt unavailable in non-interactive mode\n");
  }
}

function resolveCompatibleConfigId(agent: { agentCommand: string }, configId: string): string {
  if (isLegacyZedCodexAcpInvocation(agent.agentCommand) && configId === "thought_level") {
    return "reasoning_effort";
  }
  return configId;
}

// Thinking-depth config options. These are the ones that suffer the warm-owner
// revert (the owner binds reasoningEffort at spawn and re-asserts it every turn),
// so the CLI `set` verb recycles the owner for them to make the change bind on
// the next turn (W13-24). Other config options keep the live/direct-apply path.
function isDepthConfigOption(configId: string): boolean {
  return configId === "effort" || configId === "reasoning_effort";
}

function resolveRequestedOutputPolicy(globalFlags: {
  format: OutputFormat;
  jsonStrict?: boolean;
  suppressReads?: boolean;
}): OutputPolicy {
  return {
    ...resolveOutputPolicy(globalFlags.format, globalFlags.jsonStrict === true),
    suppressReads: globalFlags.suppressReads === true,
  };
}

type ResolvedAgentInvocation = ReturnType<typeof resolveAgentInvocation>;

function sessionOptionsFromGlobalFlags(
  globalFlags: GlobalFlags,
): NonNullable<Parameters<SessionModule["createSession"]>[0]["sessionOptions"]> {
  const unifiedSelection = globalFlags.profile ?? globalFlags.subscription;
  return {
    model: globalFlags.model,
    allowedTools: globalFlags.allowedTools,
    maxTurns: globalFlags.maxTurns,
    systemPrompt: globalFlags.systemPrompt,
    profile: unifiedSelection,
    reasoningEffort: globalFlags.reasoningEffort,
    floorHard: globalFlags.floorHard,
  };
}

function validateExplicitSubscriptionFlag(globalFlags: GlobalFlags): void {
  const subscriptionId = globalFlags.subscription?.trim();
  if (!subscriptionId || isAutoSubscriptionSentinel(subscriptionId)) {
    // `auto` is the automatic-selection sentinel, not a registry id — it is
    // resolved to a concrete id at the creation seam, so it must not be
    // rejected here as unknown.
    return;
  }

  const registry = loadSubscriptionRegistry();
  const subscription = findSubscription(subscriptionId, registry);
  if (subscription) {
    if (isSubscriptionLocked(subscription, registry)) {
      throw new SubscriptionLockedError(subscriptionId);
    }
    return;
  }

  throw new SubscriptionUnknownError(
    subscriptionId,
    registry.subscriptions.map((entry) => entry.id),
  );
}

function validateExplicitProfileFlag(globalFlags: GlobalFlags): void {
  const profileId = globalFlags.profile?.trim();
  if (!profileId) {
    return;
  }
  const registry = loadProfileRegistry();
  const profile = findProfile(profileId, registry);
  if (profile && isSubscriptionProfileLocked(profile, registry)) {
    throw new SubscriptionLockedError(profileId);
  }
}

function validateExplicitCredentialFlags(globalFlags: GlobalFlags): void {
  validateExplicitSubscriptionFlag(globalFlags);
  validateExplicitProfileFlag(globalFlags);
}

function selectionIsLocked(selection: string | undefined): boolean {
  const id = selection?.trim();
  if (!id) {
    return false;
  }
  const profileRegistry = loadProfileRegistry();
  const profile = findProfile(id, profileRegistry);
  if (profile && isSubscriptionProfileLocked(profile, profileRegistry)) {
    return true;
  }
  const subscriptionRegistry = loadSubscriptionRegistry();
  const subscription = findSubscription(id, subscriptionRegistry);
  return subscription !== undefined && isSubscriptionLocked(subscription, subscriptionRegistry);
}

function assertProfileUnlocked(profile: ProfileEntry, registry: ProfileRegistry): void {
  if (isSubscriptionProfileLocked(profile, registry)) {
    throw new SubscriptionLockedError(profile.id);
  }
}

function existingSessionSubscriptionLabel(record: SessionRecord): string {
  return record.name ? `"${record.name}" (${record.acpxRecordId})` : record.acpxRecordId;
}

function switchSubscriptionCommand(
  record: SessionRecord,
  agentName: string,
  requested: string,
): string {
  const sessionFlag = record.name ? ` --session ${record.name}` : "";
  return `acpx ${agentName} set${sessionFlag} subscription ${requested}`;
}

type EffectiveSubscriptionSelection = {
  id?: string;
  account?: string;
};

async function resolveEffectiveSubscriptionSelection(
  id: string | undefined,
): Promise<EffectiveSubscriptionSelection> {
  const trimmed = id?.trim();
  if (!trimmed) {
    return {};
  }
  const profile = await getResolvedProfile(trimmed);
  return {
    id: trimmed,
    account: profile?.account,
  };
}

async function effectiveRecordedSubscriptionSelection(
  record: SessionRecord,
): Promise<EffectiveSubscriptionSelection> {
  const sessionOptions = record.acpx?.session_options;
  const profile = sessionOptions?.profile?.trim();
  if (profile) {
    return await resolveEffectiveSubscriptionSelection(profile);
  }
  return await resolveEffectiveSubscriptionSelection(sessionOptions?.subscription);
}

function subscriptionSelectionsMatch(
  current: EffectiveSubscriptionSelection,
  requested: EffectiveSubscriptionSelection,
): boolean {
  if (!current.id || !requested.id) {
    return false;
  }
  if (current.id === requested.id) {
    return true;
  }
  return current.account !== undefined && current.account === requested.account;
}

async function assertExplicitSubscriptionMatchesExistingSession(params: {
  globalFlags: GlobalFlags;
  record: SessionRecord;
  agentName: string;
}): Promise<void> {
  const requested = params.globalFlags.subscription?.trim();
  if (!requested) {
    return;
  }

  const [current, requestedSelection] = await Promise.all([
    effectiveRecordedSubscriptionSelection(params.record),
    resolveEffectiveSubscriptionSelection(requested),
  ]);
  if (subscriptionSelectionsMatch(current, requestedSelection)) {
    return;
  }

  throw new SubscriptionChangeRequiresSwitchError({
    sessionLabel: existingSessionSubscriptionLabel(params.record),
    currentSubscription: current.id,
    requestedSubscription: requested,
    switchCommand: switchSubscriptionCommand(params.record, params.agentName, requested),
  });
}

// `--reasoning-effort` applies to the effort-capable Claude agents: `claude`
// and `claude-pty` (the claude-pty bridge advertises an `effort` config option
// and acpx applies the requested level to it). When it's passed but the
// effective agent is not effort-capable (explicit codex, or a bare spawn that
// inherited a non-claude parent), it never writes effort — say so once on
// stderr (never an error).
function warnReasoningEffortIgnoredForNonClaude(
  globalFlags: GlobalFlags,
  effectiveAgentName: string,
): void {
  if (
    !globalFlags.reasoningEffort ||
    effectiveAgentName === "claude" ||
    effectiveAgentName === "claude-pty" ||
    globalFlags.jsonStrict
  ) {
    return;
  }
  process.stderr.write(
    `[acpx] --reasoning-effort applies to claude; ignoring for agent "${effectiveAgentName}" ` +
      `(codex depth is set via --model '<model>[depth]')\n`,
  );
}

async function resolvePermissionPolicyFromFlags(
  globalFlags: GlobalFlags,
): Promise<PermissionPolicy | undefined> {
  try {
    return await loadPermissionPolicySpec(globalFlags.permissionPolicy, globalFlags.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidArgumentError(`Invalid permission policy: ${message}`);
  }
}

// The parent identity resolved from flags/env: its bare id (for parent_session_id
// linkage + local record lookup) and, when known, its FULL url (host+id). The url
// is preserved verbatim so a cross-box parent keeps its real host (FW-19); a bare
// --parent-id has no url (same-box, derived from the local base url downstream).
type ParentSessionRef = { id: string; url?: string; fromUrlFlag: boolean };

// The minimal flag shape the parent resolver reads. Both `SessionsNewFlags` and
// `SessionsCopyFlags` carry `--parent-session-url`/`--parent-id`, so the shared
// resolver accepts either (used by plain `new` and by the copy/template path).
type ParentFlagSource = { parentSessionUrl?: string; parentId?: string };

function resolveParentSessionRefFromFlagOrEnv(
  flags: ParentFlagSource,
): ParentSessionRef | undefined {
  // --parent-session-url <url> wins over --parent-id <uuid>; both override env.
  const flagUrl = flags.parentSessionUrl?.trim();
  if (flagUrl) {
    const id = parseSessionIdFromUrl(flagUrl);
    if (id) {
      return { id, url: flagUrl, fromUrlFlag: true };
    }
  }
  const flagValue = flags.parentId?.trim();
  if (flagValue) {
    return { id: flagValue, fromUrlFlag: false };
  }
  // Env fallback: ACPX_SESSION_URL is the spawning agent's OWN url (its real host).
  // Preserve the full url so an agent on box A spawning a child on box B records A's
  // host as the parent identity, not B's local base url.
  const envUrl = process.env.ACPX_SESSION_URL?.trim();
  const envFromUrl = parseSessionIdFromUrl(envUrl);
  if (envFromUrl) {
    return { id: envFromUrl, url: envUrl, fromUrlFlag: false };
  }
  return undefined;
}

type ResolvedParentSession = {
  acpxRecordId: string;
  /** Full parent url (host+id) for cross-machine lineage, when known. (FW-19) */
  sessionUrl?: string;
  taskFolder?: string;
  brick?: string;
  subscription?: string;
  profile?: string;
  agentCommand?: string;
  model?: string;
  effort?: string;
};

// Snapshot the parent record's inheritable fields. Agent-type + model + effort
// inheritance is gated on sameAgentAsParent in buildSessionStartOptions; effort
// is the persisted desired intent (the single source of truth — the live
// config_options snapshot can be stale).
// eslint-disable-next-line complexity -- explicit optional-field projection keeps inheritance reviewable
function parentInheritableFields(parent: SessionRecord): ResolvedParentSession {
  const sessionOptions = parent.acpx?.session_options;
  return {
    acpxRecordId: parent.acpxRecordId,
    taskFolder: parent.metadata?.task_folder,
    brick: parent.metadata?.brick,
    subscription: sessionOptions?.subscription,
    profile: sessionOptions?.profile,
    agentCommand: parent.agentCommand,
    model: sessionOptions?.model,
    effort: parent.acpx?.desired_config_options?.effort,
  };
}

async function resolveAndValidateParentSessionId(
  flags: ParentFlagSource,
): Promise<ResolvedParentSession | undefined> {
  const ref = resolveParentSessionRefFromFlagOrEnv(flags);
  if (!ref) {
    return undefined;
  }
  try {
    // Local parent: snapshot its inheritable fields, and carry the explicit url
    // when one was supplied (else downstream derives it from the id same-box).
    return { ...parentInheritableFields(await resolveSessionRecord(ref.id)), sessionUrl: ref.url };
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      // FW-19: a parent identified by URL may live on ANOTHER box — its id won't
      // resolve locally. The url carries the host, so accept it as the parent
      // identity (linkage only; no local field inheritance). A bare --parent-id /
      // env id with no url cannot identify a cross-box session → still an error.
      if (ref.url) {
        return { acpxRecordId: ref.id, sessionUrl: ref.url };
      }
      const label = flags.parentSessionUrl ? "--parent-session-url" : "--parent-id";
      throw new InvalidArgumentError(`${label} refers to unknown session: ${ref.id}`);
    }
    throw error;
  }
}

type EffectiveSpawnAgent = {
  agentName: string;
  agentCommand: string;
  cwd: string;
  sameAgentAsParent: boolean;
};

// Resolve the agent a spawn (`sessions new` / `ensure`) actually uses, applying
// parent agent-type inheritance: a bare/defaulted spawn inside an acpx session
// adopts the parent's agent command (an explicit positional agent / --agent
// always wins), while a top-level shell with no resolvable parent keeps today's
// default. `sameAgentAsParent` then gates model/effort inheritance so an
// agent-namespaced value never crosses agent boundaries.
function resolveEffectiveSpawnAgent(
  agent: ResolvedAgentInvocation,
  explicitAgentName: string | undefined,
  globalFlags: GlobalFlags,
  parent: ResolvedParentSession | undefined,
  config: ResolvedAcpxConfig,
): EffectiveSpawnAgent {
  const agentWasExplicit = explicitAgentName !== undefined || !!globalFlags.agent?.trim();
  const agentCommand = withInheritedAgentCommand(
    agent.agentCommand,
    agentWasExplicit,
    parent?.agentCommand,
  );
  const inherited = agentCommand !== agent.agentCommand;
  // Keep the banner's display name consistent with the inherited command.
  const agentName = inherited
    ? (resolveAgentNameFromCommand(agentCommand, config.agents) ?? agent.agentName)
    : agent.agentName;
  const sameAgentAsParent = !!parent?.agentCommand && agentCommand === parent.agentCommand;
  return { agentName, agentCommand, cwd: agent.cwd, sameAgentAsParent };
}

function inheritedProfileSelection(
  globalFlags: GlobalFlags,
  sameAgentAsParent: boolean,
  parent: ResolvedParentSession | undefined,
): string | undefined {
  const explicitSelection = globalFlags.profile ?? globalFlags.subscription;
  const inheritedSelection = sameAgentAsParent
    ? (parent?.profile ?? parent?.subscription)
    : undefined;
  const selection = withInheritedProfile(explicitSelection, inheritedSelection);
  if (explicitSelection !== undefined) {
    return selection;
  }
  if (selectionIsLocked(selection)) {
    return undefined;
  }
  return selection;
}

// Assemble the child's sessionOptions, layering parent inheritance over the
// global flags. Credential, model, and effort inheritance all require the child
// to resolve to the SAME agent as its parent; explicit child values win
// throughout. effort for a non-claude child is harmless here — the creation sites
// only write/apply it when the session advertises `effort`.
function inheritedSpawnSessionOptions(
  globalFlags: GlobalFlags,
  sameAgentAsParent: boolean,
  parent: ResolvedParentSession | undefined,
): NonNullable<Parameters<SessionModule["createSession"]>[0]["sessionOptions"]> {
  // brick://5bac5564 R1: the PRIMARY Fable-leak site. A bare child of a Fable
  // parent inherits `fable` here. Resolve, tag provenance, then run the invariant
  // guard so an IMPLICIT Fable is rewritten to the non-Fable default while an
  // explicit `--model fable` is preserved. modelSource is also load-bearing for
  // the reuse-branch clobber-guard (RE-ENSURE-CLOBBER addendum).
  const explicitModel = globalFlags.model;
  const inheritedModel = sameAgentAsParent ? parent?.model : undefined;
  const resolvedModel = withInheritedModel(explicitModel, inheritedModel);
  const guarded = guardImplicitFable({
    resolvedModel,
    explicitModel,
    source: resolveSpawnModelSource(explicitModel, inheritedModel),
  });
  return {
    ...sessionOptionsFromGlobalFlags(globalFlags),
    model: guarded.model,
    modelSource: guarded.source,
    ...(guarded.forced ? { modelGuardBlocked: guarded.blocked } : {}),
    reasoningEffort: withInheritedReasoningEffort(
      globalFlags.reasoningEffort,
      sameAgentAsParent ? parent?.effort : undefined,
    ),
    profile: inheritedProfileSelection(globalFlags, sameAgentAsParent, parent),
  };
}

function buildSessionStartOptions(params: {
  agent: EffectiveSpawnAgent;
  flags: SessionsNewFlags;
  globalFlags: GlobalFlags;
  config: ResolvedAcpxConfig;
  permissionMode: ReturnType<typeof resolvePermissionMode>;
  permissionPolicy?: PermissionPolicy;
  parent?: ResolvedParentSession;
  resolvedBrick?: string | false;
}): Parameters<SessionModule["createSession"]>[0] {
  return {
    agentCommand: params.agent.agentCommand,
    agentName: params.agent.agentName,
    cwd: params.agent.cwd,
    name: params.flags.name,
    resumeSessionId: params.flags.resumeSession,
    parentSessionId: params.parent?.acpxRecordId,
    parentSessionUrl: params.parent?.sessionUrl,
    metadata: withInheritedBrick(
      applyBrickFlag(
        withInheritedTaskFolder(params.flags.metadata, params.parent?.taskFolder),
        params.resolvedBrick,
      ),
      params.parent?.brick,
      params.resolvedBrick === false,
    ),
    mcpServers: params.config.mcpServers,
    permissionMode: params.permissionMode,
    nonInteractivePermissions: params.globalFlags.nonInteractivePermissions,
    permissionPolicy: params.permissionPolicy,
    authCredentials: params.config.auth,
    authPolicy: params.globalFlags.authPolicy,
    terminal: params.globalFlags.terminal,
    timeoutMs: params.globalFlags.timeout,
    verbose: params.globalFlags.verbose,
    sessionOptions: inheritedSpawnSessionOptions(
      params.globalFlags,
      params.agent.sameAgentAsParent,
      params.parent,
    ),
  };
}

async function resolveBrickFlagValue(
  brick: string | false | undefined,
): Promise<string | false | undefined> {
  if (brick === false) {
    return false;
  }
  if (typeof brick === "string") {
    return await resolveBrickFlagRef(brick);
  }
  return undefined;
}

function optionValueSourceWithGlobals(command: Command, optionName: string): string | undefined {
  let current: Command | null = command;
  while (current) {
    const source = current.getOptionValueSource(optionName);
    if (source !== undefined) {
      return source;
    }
    current = current.parent;
  }
  return undefined;
}

function resolveCopyDestinationCwd(
  command: Command,
  globalFlags: GlobalFlags,
  source: SessionRecord,
): string {
  const cwdSource = optionValueSourceWithGlobals(command, "cwd");
  return cwdSource && cwdSource !== "default" ? path.resolve(globalFlags.cwd) : source.cwd;
}

function sourceDefaultForkName(source: SessionRecord): string {
  const sourceName = source.name ?? source.title ?? "session";
  return `${sourceName} (fork)`;
}

function agentTypeLabel(agentCommand: string, config: ResolvedAcpxConfig): string {
  return resolveAgentNameFromCommand(agentCommand, config.agents) ?? agentCommand;
}

function copyMetadata(
  flags: SessionsCopyFlags,
  source: SessionRecord,
  forkAtMessageIndex: number,
): Record<string, string> | undefined {
  const metadata: Record<string, string> = { ...flags.metadata };
  if (flags.ephemeral === true) {
    metadata.byway = "1";
    metadata.byway_parent = source.acpxRecordId;
    metadata.byway_at = String(forkAtMessageIndex);
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function sourceSessionOptions(source: SessionRecord) {
  const sessionOptions = { ...sessionOptionsFromRecord(source) };
  const reasoningEffort = getDesiredConfigOptions(source.acpx).effort;
  if (reasoningEffort !== undefined) {
    sessionOptions.reasoningEffort = reasoningEffort;
  }
  return Object.keys(sessionOptions).length > 0 ? sessionOptions : undefined;
}

function sourceDesiredConfigOptions(source: SessionRecord): Record<string, string> | undefined {
  const desired = getDesiredConfigOptions(source.acpx);
  return Object.keys(desired).length > 0 ? desired : undefined;
}

function applyCopyCredentialOverride(
  merged: NonNullable<ReturnType<typeof sourceSessionOptions>>,
  globalFlags: GlobalFlags,
  inheritedCredential: string | undefined,
): void {
  const explicitCredential = globalFlags.profile ?? globalFlags.subscription;
  if (explicitCredential !== undefined) {
    merged.profile = explicitCredential;
    delete merged.subscription;
    return;
  }
  if (selectionIsLocked(inheritedCredential)) {
    throw new SubscriptionLockedError(inheritedCredential as string);
  }
}

function applyCopyModelOverrides(
  merged: NonNullable<ReturnType<typeof sourceSessionOptions>>,
  model: string | undefined,
  reasoningEffort: string | undefined,
): void {
  if (model !== undefined) {
    merged.model = model;
  }
  if (reasoningEffort !== undefined) {
    merged.reasoningEffort = reasoningEffort;
  }
}

// #3 — template params as defaults, explicit flag overrides. Precedence:
// explicit `--model`/`--reasoning-effort` > template/source value > box default.
// Layers the explicit global flag over the source's baked-in value via the same
// pure helpers plain-`new` uses for parent inheritance ("child" = explicit copy
// flag, "inherit" = template value). Same-agent is guaranteed on the copy path
// (assertCopyAgentLock), so no cross-agent gating is needed. When neither the
// flag nor the source sets a field it is omitted → falls to the box default, and
// with no explicit flag the result is byte-identical to `sourceSessionOptions`.
// brick://5bac5564 R2: a copy/fork inherits the SOURCE record's model. Guard it the
// same way as a spawn — an implicit Fable copied from a Fable source is forced to the
// non-Fable default; an explicit `--model fable` is preserved. Then stamp provenance.
function applyGuardedCopyModel(
  merged: NonNullable<ReturnType<typeof sourceSessionOptions>>,
  globalFlags: GlobalFlags,
  baseModel: string | undefined,
): void {
  const explicitModel = globalFlags.model;
  const guarded = guardImplicitFable({
    resolvedModel: withInheritedModel(explicitModel, baseModel),
    explicitModel,
    source: resolveSpawnModelSource(explicitModel, baseModel),
  });
  applyCopyModelOverrides(
    merged,
    guarded.model,
    withInheritedReasoningEffort(globalFlags.reasoningEffort, merged.reasoningEffort),
  );
  if (guarded.model !== undefined) {
    merged.modelSource = guarded.source;
    if (guarded.forced) {
      merged.modelGuardBlocked = guarded.blocked;
    }
  }
}

function copySessionOptionsWithOverride(
  source: SessionRecord,
  globalFlags: GlobalFlags,
): ReturnType<typeof sourceSessionOptions> {
  const base = sourceSessionOptions(source);
  const merged = { ...base };
  applyCopyCredentialOverride(merged, globalFlags, base?.profile ?? base?.subscription);
  applyGuardedCopyModel(merged, globalFlags, base?.model);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// Mirror of the above for `desiredConfigOptions` — the persisted desired effort
// that the downstream apply path reads. Explicit `--reasoning-effort` wins over
// the template's baked-in effort; byte-identical to `sourceDesiredConfigOptions`
// when no flag is passed.
function copyDesiredConfigOptionsWithOverride(
  source: SessionRecord,
  globalFlags: GlobalFlags,
): Record<string, string> | undefined {
  const base = sourceDesiredConfigOptions(source);
  const effort = withInheritedReasoningEffort(globalFlags.reasoningEffort, base?.effort);
  const merged = { ...base };
  if (effort !== undefined) {
    merged.effort = effort;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function assertCopyableSource(source: SessionRecord): void {
  if (source.kind === "subagent") {
    throw new Error("Cannot copy a subagent session");
  }
}

function resolveForkAtMessageIndex(source: SessionRecord, atIndex: number | undefined): number {
  const messageCount = source.messages.length;
  const forkAtMessageIndex = atIndex ?? messageCount;
  if (forkAtMessageIndex < 0 || forkAtMessageIndex > messageCount) {
    throw new InvalidArgumentError(`--at-index out of range (0-${messageCount})`);
  }
  return forkAtMessageIndex;
}

function assertCopyAgentLock(params: {
  explicitAgentName?: string;
  globalFlags: GlobalFlags;
  pathAgent: ResolvedAgentInvocation;
  source: SessionRecord;
  config: ResolvedAcpxConfig;
}): void {
  const agentWasExplicit =
    params.explicitAgentName !== undefined || !!params.globalFlags.agent?.trim();
  if (!agentWasExplicit || params.pathAgent.agentCommand === params.source.agentCommand) {
    return;
  }
  // Same ADAPTER TYPE under a different command spelling is NOT a cross-agent
  // copy — the copy uses `source.agentCommand` verbatim regardless of the path
  // agent, so the only thing to guard is a genuine agent-TYPE change. The
  // exact-string check above is too strict: the claude-pty bridge's registry
  // default (`.../dist/index.js`) and its `.../acp-server-transcript.mjs` root
  // shim are the same program, and `ACPX_CLAUDE_PTY_ACP_COMMAND` / a config
  // `agents` override can spell it a third way — so a session created under one
  // spelling could not be forked/copied/byway-ed once the resolver yielded
  // another (acpx-ui surfaced this as a 502 on byway-create over a claude-pty
  // parent; brick://4dd3ee2c). Allow when both commands classify to the same
  // adapter kind; fall through to the strict reject only for a raw/unknown
  // command on either side (escape-hatch `--agent`).
  const sourceKind = acpAdapterKind(params.source.agentCommand);
  const pathKind = acpAdapterKind(params.pathAgent.agentCommand);
  if (sourceKind !== undefined && sourceKind === pathKind) {
    return;
  }
  const sourceType = agentTypeLabel(params.source.agentCommand, params.config);
  throw new Error(
    `sessions copy preserves the source agent type (${sourceType}); cannot copy as ${params.pathAgent.agentName}`,
  );
}

function resolveSessionListFilterCwd(
  flags: Pick<SessionsListFlags, "filterCwd">,
  agentCwd: string,
): string | undefined {
  return flags.filterCwd ? path.resolve(agentCwd, flags.filterCwd) : undefined;
}

async function printLocalSessionsList(
  agentCommand: string,
  agentName: string,
  filterCwd: string | undefined,
  format: OutputFormat,
): Promise<void> {
  const [{ listSessionsForAgent }, { printSessionsByFormat }] = await Promise.all([
    loadSessionModule(),
    loadOutputRenderModule(),
  ]);
  const sessions = await listSessionsForAgent(agentCommand, agentName);
  const filtered = filterCwd ? sessions.filter((session) => session.cwd === filterCwd) : sessions;
  printSessionsByFormat(filtered, format);
}

function missingScopedSessionMessage(
  agent: ResolvedAgentInvocation,
  sessionName: string | undefined,
): string {
  return sessionName
    ? `No named session "${sessionName}" for cwd ${agent.cwd} and agent ${agent.agentName}`
    : `No cwd session for ${agent.cwd} and agent ${agent.agentName}`;
}

async function findScopedSessionOrThrow(
  agent: ResolvedAgentInvocation,
  sessionName: string | undefined,
): Promise<SessionRecord> {
  const record = await findSession({
    agentCommand: agent.agentCommand,
    agentName: agent.agentName,
    cwd: agent.cwd,
    name: sessionName,
    includeClosed: true,
  });

  if (!record) {
    throw new Error(missingScopedSessionMessage(agent, sessionName));
  }

  return record;
}

function agentNamesForCommand(agentCommand: string, config: ResolvedAcpxConfig): string[] {
  return listBuiltInAgents(config.agents).filter(
    (name) => resolveAgentCommand(name, config.agents) === agentCommand,
  );
}

function explicitSessionCommand(
  agentCommand: string,
  sessionName: string | undefined,
  subcommand: string,
  config: ResolvedAcpxConfig,
): string {
  const names = agentNamesForCommand(agentCommand, config);
  const prefix = names[0] ? `acpx ${names[0]}` : `acpx --agent ${JSON.stringify(agentCommand)}`;
  return sessionName
    ? `${prefix} sessions ${subcommand} ${sessionName}`
    : `${prefix} sessions ${subcommand}`;
}

async function findGenericReadableSessionOrThrow(
  agent: ResolvedAgentInvocation,
  sessionName: string | undefined,
  subcommand: string,
  config: ResolvedAcpxConfig,
): Promise<SessionRecord> {
  const defaultScopedRecord = await findSession({
    agentCommand: agent.agentCommand,
    agentName: agent.agentName,
    cwd: agent.cwd,
    name: sessionName,
    includeClosed: true,
  });

  if (defaultScopedRecord) {
    return defaultScopedRecord;
  }

  const normalizedName = normalizeName(sessionName);
  if (normalizedName !== undefined) {
    return await findExplicitGenericReadableSessionOrThrow(
      agent,
      normalizedName,
      subcommand,
      config,
    );
  }

  const candidates = (await listSessions()).filter(
    (record) =>
      record.kind !== "subagent" &&
      record.cwd === agent.cwd &&
      (normalizedName == null ? record.name == null : record.name === normalizedName),
  );
  if (candidates.length === 1) {
    return candidates[0];
  }

  const baseMessage = missingScopedSessionMessage(agent, sessionName);
  const defaultHint = `Searched default agent ${agent.agentName}.`;

  if (candidates.length === 0) {
    throw new Error(
      `${baseMessage}\n${defaultHint} To inspect another agent, use \`acpx <agent> sessions ${subcommand}${
        sessionName ? ` ${sessionName}` : ""
      }\`.`,
    );
  }

  const suggestions = candidates
    .map(
      (candidate) =>
        `  - ${explicitSessionCommand(candidate.agentCommand, sessionName, subcommand, config)}`,
    )
    .join("\n");
  throw new Error(
    `${baseMessage}\n${defaultHint} Multiple matching sessions exist across agents; use an explicit agent command:\n${suggestions}`,
  );
}

async function findExplicitGenericReadableSessionOrThrow(
  agent: ResolvedAgentInvocation,
  sessionName: string,
  subcommand: string,
  config: ResolvedAcpxConfig,
): Promise<SessionRecord> {
  const localResolution = await resolveSessionByExactName({
    name: sessionName,
    cwd: agent.cwd,
    includeClosed: true,
    excludeSubagents: true,
  });
  if (localResolution.kind === "found") {
    return localResolution.record;
  }
  if (localResolution.kind === "ambiguous") {
    const suggestions = localResolution.candidates
      .map(
        (candidate) =>
          `  - ${explicitSessionCommand(candidate.agentCommand, sessionName, subcommand, config)}`,
      )
      .join("\n");
    throw new Error(
      `${missingScopedSessionMessage(agent, sessionName)}\n` +
        `Searched default agent ${agent.agentName}. Multiple matching sessions exist across agents; use an explicit agent command:\n` +
        suggestions,
    );
  }

  const globalRecord = await resolveGlobalSessionByName({
    agentCommand: agent.agentCommand,
    agentName: agent.agentName,
    name: sessionName,
    includeClosed: true,
  });
  if (globalRecord) {
    return globalRecord;
  }

  throw new Error(
    `${missingScopedSessionMessage(agent, sessionName)}\n` +
      `Searched default agent ${agent.agentName}. To inspect another agent, use \`acpx <agent> sessions ${subcommand} ${sessionName}\`.`,
  );
}

async function findExplicitAgentReadableSessionOrThrow(
  agent: ResolvedAgentInvocation,
  sessionName: string | undefined,
): Promise<SessionRecord> {
  const localRecord = await findSession({
    agentCommand: agent.agentCommand,
    agentName: agent.agentName,
    cwd: agent.cwd,
    name: sessionName,
    includeClosed: true,
  });
  if (localRecord) {
    return localRecord;
  }

  if (sessionName !== undefined) {
    const globalRecord = await resolveGlobalSessionByName({
      agentCommand: agent.agentCommand,
      agentName: agent.agentName,
      name: sessionName,
      includeClosed: true,
    });
    if (globalRecord) {
      return globalRecord;
    }
  }

  return await findScopedSessionOrThrow(agent, sessionName);
}

async function findReadableSessionOrThrow(params: {
  explicitAgentName: string | undefined;
  agent: ResolvedAgentInvocation;
  selector: SessionTargetSelector;
  subcommand: string;
  config: ResolvedAcpxConfig;
}): Promise<SessionRecord> {
  const explicitRecord = await resolveExplicitSessionRecord(params.selector);
  if (explicitRecord) {
    return explicitRecord;
  }

  if (params.selector.name !== undefined) {
    try {
      return await resolveSessionRecord(params.selector.name);
    } catch (error) {
      if (!(error instanceof SessionNotFoundError)) {
        throw error;
      }
    }
  }

  if (params.explicitAgentName == null) {
    return await findGenericReadableSessionOrThrow(
      params.agent,
      params.selector.name,
      params.subcommand,
      params.config,
    );
  }

  return await findExplicitAgentReadableSessionOrThrow(params.agent, params.selector.name);
}

async function findRoutedSessionOrThrow(
  agentCommand: string,
  agentName: string,
  cwd: string,
  sessionName: string | undefined,
): Promise<SessionRecord> {
  const gitRoot = findGitRepositoryRoot(cwd);
  const walkBoundary = gitRoot ?? cwd;

  const record = await findSessionByDirectoryWalk({
    agentCommand,
    agentName,
    cwd,
    name: sessionName,
    boundary: walkBoundary,
  });

  if (record) {
    return record;
  }

  if (sessionName !== undefined) {
    const globalRecord = await resolveGlobalSessionByName({
      agentCommand,
      agentName,
      name: sessionName,
    });
    if (globalRecord) {
      return globalRecord;
    }
  }

  const createCmd = sessionName
    ? `acpx ${agentName} sessions new --name ${sessionName}`
    : `acpx ${agentName} sessions new`;
  throw new NoSessionError(
    `⚠ No acpx session found (searched up to ${walkBoundary}).\nCreate one: ${createCmd}`,
  );
}

async function findRoutedTargetSessionOrThrow(
  agent: ResolvedAgentInvocation,
  selector: SessionTargetSelector,
): Promise<SessionRecord> {
  const explicitRecord = await resolveExplicitSessionRecord(selector);
  if (explicitRecord) {
    return explicitRecord;
  }

  return await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    selector.name,
  );
}

async function findOptionalRoutedTargetSession(
  agent: ResolvedAgentInvocation,
  selector: SessionTargetSelector,
): Promise<SessionRecord | undefined> {
  const explicitRecord = await resolveExplicitSessionRecord(selector);
  if (explicitRecord) {
    return explicitRecord;
  }

  const gitRoot = findGitRepositoryRoot(agent.cwd);
  const localRecord = await findSessionByDirectoryWalk({
    agentCommand: agent.agentCommand,
    agentName: agent.agentName,
    cwd: agent.cwd,
    name: selector.name,
    boundary: gitRoot ?? agent.cwd,
  });
  if (localRecord || selector.name === undefined) {
    return localRecord;
  }

  return await resolveGlobalSessionByName({
    agentCommand: agent.agentCommand,
    agentName: agent.agentName,
    name: selector.name,
  });
}

// Shared prompt-delivery core: build the output formatter and enqueue/run the
// prompt against an existing session. Used by `handlePrompt` and by the
// `sessions new --from-template` auto-fire (which calls it with
// waitForCompletion:false so the spawn returns promptly while the warm child
// works the prompt asynchronously).
async function deliverPrompt(params: {
  sessionId: string;
  prompt: import("../types.js").PromptInput;
  waitForCompletion: boolean;
  globalFlags: GlobalFlags;
  permissionMode: ReturnType<typeof resolvePermissionMode>;
  permissionPolicy?: PermissionPolicy;
  outputPolicy: ReturnType<typeof resolveRequestedOutputPolicy>;
  config: ResolvedAcpxConfig;
  messageId?: string;
}) {
  const { createOutputFormatter } = await loadOutputModule();
  const { sendSession } = await loadSessionModule();
  const outputFormatter = createOutputFormatter(params.outputPolicy.format, {
    jsonContext: {
      sessionId: params.sessionId,
    },
    suppressReads: params.outputPolicy.suppressReads,
  });
  return sendSession({
    sessionId: params.sessionId,
    prompt: params.prompt,
    mcpServers: params.config.mcpServers,
    permissionMode: params.permissionMode,
    permissionModeExplicit: hasExplicitPermissionModeFlag(params.globalFlags),
    nonInteractivePermissions: params.globalFlags.nonInteractivePermissions,
    permissionPolicy: params.permissionPolicy,
    authCredentials: params.config.auth,
    authPolicy: params.globalFlags.authPolicy,
    terminal: params.globalFlags.terminal,
    outputFormatter,
    errorEmissionPolicy: {
      queueErrorAlreadyEmitted: params.outputPolicy.queueErrorAlreadyEmitted,
    },
    suppressSdkConsoleErrors: params.outputPolicy.suppressSdkConsoleErrors,
    timeoutMs: params.globalFlags.timeout,
    ttlMs: params.globalFlags.ttl,
    maxQueueDepth: params.config.queueMaxDepth,
    promptRetries: params.globalFlags.promptRetries,
    verbose: params.globalFlags.verbose,
    waitForCompletion: params.waitForCompletion,
    messageId: params.messageId,
    sessionOptions: sessionOptionsFromGlobalFlags(params.globalFlags),
  });
}

export async function handlePrompt(
  explicitAgentName: string | undefined,
  promptParts: string[],
  flags: PromptFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  validateExplicitCredentialFlags(globalFlags);
  const outputPolicy = resolveRequestedOutputPolicy(globalFlags);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  warnReasoningEffortIgnoredForNonClaude(globalFlags, agent.agentName);
  const { printPromptSessionBanner, printQueuedPromptByFormat } = await loadOutputRenderModule();
  const selector = resolveSessionTargetSelector({ flags, command });
  const record = await findRoutedTargetSessionOrThrow(agent, selector);
  await assertExplicitSubscriptionMatchesExistingSession({
    globalFlags,
    record,
    agentName: agent.agentName,
  });
  const prompt = await readPrompt(promptParts, flags.file, globalFlags.cwd);

  await printPromptSessionBanner(record, agent.cwd, outputPolicy.format, outputPolicy.jsonStrict);
  const result = await deliverPrompt({
    sessionId: record.acpxRecordId,
    prompt,
    waitForCompletion: flags.wait !== false,
    globalFlags,
    permissionMode,
    permissionPolicy,
    outputPolicy,
    config,
    messageId: flags.messageId,
  });

  if ("queued" in result) {
    printQueuedPromptByFormat(result, outputPolicy.format);
    return;
  }

  maybeEmitQuietPermissionUnavailable({
    result,
    outputPolicy,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
  });
  applyPermissionExitCode(result);

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(
      `[acpx] session reconnect failed, started fresh session: ${result.loadError}\n`,
    );
  }
}

export async function handleExec(
  explicitAgentName: string | undefined,
  promptParts: string[],
  flags: ExecFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  validateExplicitCredentialFlags(globalFlags);

  if (config.disableExec) {
    const outputPolicy = resolveRequestedOutputPolicy(globalFlags);
    if (outputPolicy.format === "json") {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "exec subcommand is disabled by configuration (disableExec: true)",
            data: { acpxCode: "EXEC_DISABLED" },
          },
        })}\n`,
      );
    } else {
      process.stderr.write(
        "Error: exec subcommand is disabled by configuration (disableExec: true)\n",
      );
    }
    process.exitCode = 1;
    return;
  }

  const outputPolicy = resolveRequestedOutputPolicy(globalFlags);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);
  const prompt = await readPrompt(promptParts, flags.file, globalFlags.cwd);
  const [{ createOutputFormatter }, { runOnce }] = await Promise.all([
    loadOutputModule(),
    loadSessionModule(),
  ]);
  const outputFormatter = createOutputFormatter(outputPolicy.format, {
    suppressReads: outputPolicy.suppressReads,
  });
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  warnReasoningEffortIgnoredForNonClaude(globalFlags, agent.agentName);

  const result = await runOnce({
    agentCommand: agent.agentCommand,
    agentName: agent.agentName,
    cwd: agent.cwd,
    prompt,
    mcpServers: config.mcpServers,
    permissionMode,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    permissionPolicy,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    terminal: globalFlags.terminal,
    outputFormatter,
    suppressSdkConsoleErrors: outputPolicy.suppressSdkConsoleErrors,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
    promptRetries: globalFlags.promptRetries,
    sessionOptions: sessionOptionsFromGlobalFlags(globalFlags),
  });

  applyPermissionExitCode(result);
}

function printCancelResultByFormat(
  result: { sessionId: string; cancelled: boolean },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "cancel_result",
      acpxRecordId: result.sessionId || "unknown",
      cancelled: result.cancelled,
    })
  ) {
    return;
  }

  process.stdout.write(result.cancelled ? "cancel requested\n" : "nothing to cancel\n");
}

function printSetModeResultByFormat(
  modeId: string,
  result: { record: SessionRecord; resumed: boolean; loadError?: string },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "mode_set",
      modeId,
      resumed: result.resumed,
      acpxRecordId: result.record.acpxRecordId,
      acpxSessionId: result.record.acpSessionId,
      agentSessionId: result.record.agentSessionId,
    })
  ) {
    return;
  }
  process.stdout.write(format === "quiet" ? `${modeId}\n` : `mode set: ${modeId}\n`);
}

function printSetModelResultByFormat(
  modelId: string,
  result: { record: SessionRecord; resumed: boolean; ownerRestarted?: boolean },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "model_set",
      modelId,
      resumed: result.resumed,
      ownerRestarted: result.ownerRestarted ?? false,
      acpxRecordId: result.record.acpxRecordId,
      acpxSessionId: result.record.acpSessionId,
      agentSessionId: result.record.agentSessionId,
    })
  ) {
    return;
  }
  process.stdout.write(format === "quiet" ? `${modelId}\n` : `model set: ${modelId}\n`);
}

function printSetConfigOptionResultByFormat(
  configId: string,
  value: string,
  result: {
    record: SessionRecord;
    resumed: boolean;
    response: { configOptions: unknown[] };
    ownerRestarted?: boolean;
  },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "config_set",
      configId,
      value,
      resumed: result.resumed,
      ownerRestarted: result.ownerRestarted ?? false,
      configOptions: result.response.configOptions,
      acpxRecordId: result.record.acpxRecordId,
      acpxSessionId: result.record.acpSessionId,
      agentSessionId: result.record.agentSessionId,
    })
  ) {
    return;
  }
  process.stdout.write(
    format === "quiet"
      ? `${value}\n`
      : `config set: ${configId}=${value} (${result.response.configOptions.length} options)\n`,
  );
}

export async function handleCancel(
  explicitAgentName: string | undefined,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const { cancelSessionPrompt } = await loadSessionModule();
  const selector = resolveSessionTargetSelector({ flags, command });
  const record = await findOptionalRoutedTargetSession(agent, selector);

  if (!record) {
    printCancelResultByFormat({ sessionId: "", cancelled: false }, globalFlags.format);
    return;
  }

  const result = await cancelSessionPrompt({
    sessionId: record.acpxRecordId,
    verbose: globalFlags.verbose,
  });
  printCancelResultByFormat(result, globalFlags.format);
}

export async function handleSetMode(
  explicitAgentName: string | undefined,
  modeId: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const { setSessionMode } = await loadSessionModule();
  const selector = resolveSessionTargetSelector({ flags, command });
  const record = await findRoutedTargetSessionOrThrow(agent, selector);
  const result = await setSessionMode({
    sessionId: record.acpxRecordId,
    modeId,
    mcpServers: config.mcpServers,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    terminal: globalFlags.terminal,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
  });

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(
      `[acpx] session reconnect failed, started fresh session: ${result.loadError}\n`,
    );
  }

  printSetModeResultByFormat(modeId, result, globalFlags.format);
}

export async function handleSetModel(
  explicitAgentName: string | undefined,
  modelId: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const { setSessionModel } = await loadSessionModule();
  const selector = resolveSessionTargetSelector({ flags, command });
  const record = await findRoutedTargetSessionOrThrow(agent, selector);
  const result = await setSessionModel({
    sessionId: record.acpxRecordId,
    modelId,
    mcpServers: config.mcpServers,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    terminal: globalFlags.terminal,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
    // CLI verb: recycle a live idle owner so the change binds on the next turn
    // (refuses with turn-in-flight if a turn is active). acpx-ui shells this.
    recycleOwner: true,
    sessionName: selector.name ?? record.name,
  });

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(
      `[acpx] session reconnect failed, started fresh session: ${result.loadError}\n`,
    );
  }

  printSetModelResultByFormat(modelId, result, globalFlags.format);
}

// Dispatch table for config keys that are handled outside the generic ACP config-option
// path. Returns true if the key was handled. Extracted to keep handleSetConfigOption
// under the lint complexity budget.
async function tryHandleSpecialConfigKey(
  configId: string,
  explicitAgentName: string | undefined,
  value: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<boolean> {
  if (configId === "model") {
    await handleSetModel(explicitAgentName, value, flags, command, config);
    return true;
  }
  // `set subscription <id>` is a record edit (CLAUDE_CONFIG_DIR), not an ACP
  // config option — route it like `model` above. acpx-ui shells exactly this.
  if (configId === "subscription") {
    await handleSetSubscription(explicitAgentName, value, flags, command, config);
    return true;
  }
  // `set profile <id>` is the unified credential-move verb (SDK sub1↔sub2 AND
  // claude-pty bridge1↔bridge2) — a record edit + transcript port, not an ACP
  // config option. acpx-ui shells exactly this for the bridge case.
  if (configId === "profile") {
    await handleSetProfile(explicitAgentName, value, flags, command, config);
    return true;
  }
  if (isAutoFailoverConfigKey(configId)) {
    await handleSetAutoFailover(explicitAgentName, value, flags, command, config);
    return true;
  }
  if (isAutoSubscriptionConfigKey(configId)) {
    await handleSetAutoSubscription(explicitAgentName, value, flags, command, config);
    return true;
  }
  if (isFableDegradeConfigKey(configId)) {
    await handleSetFableDegrade(explicitAgentName, value, flags, command, config);
    return true;
  }
  return false;
}

export async function handleSetConfigOption(
  explicitAgentName: string | undefined,
  configId: string,
  value: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  if (await tryHandleSpecialConfigKey(configId, explicitAgentName, value, flags, command, config)) {
    return;
  }
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const resolvedConfigId = resolveCompatibleConfigId(agent, configId);
  const { setSessionConfigOption } = await loadSessionModule();
  const selector = resolveSessionTargetSelector({ flags, command });
  const record = await findRoutedTargetSessionOrThrow(agent, selector);
  const result = await setSessionConfigOption({
    sessionId: record.acpxRecordId,
    configId: resolvedConfigId,
    value,
    mcpServers: config.mcpServers,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    terminal: globalFlags.terminal,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
    // CLI verb: recycle a live idle owner so a thinking-depth change binds on the
    // next turn (the owner re-asserts its spawn-time effort every turn otherwise,
    // reverting a live set). Scoped to depth options — other config options keep
    // the existing live/direct apply. Refuses with turn-in-flight if active.
    recycleOwner: isDepthConfigOption(resolvedConfigId),
    sessionName: selector.name ?? record.name,
  });

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(
      `[acpx] session reconnect failed, started fresh session: ${result.loadError}\n`,
    );
  }

  printSetConfigOptionResultByFormat(configId, value, result, globalFlags.format);
}

function isAutoFailoverConfigKey(configId: string): boolean {
  const normalized = configId.trim();
  return (
    normalized === "auto-failover" ||
    normalized === "auto_failover" ||
    normalized === "autoFailover"
  );
}

function parseAutoFailoverValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["on", "true", "1", "enabled"].includes(normalized)) {
    return true;
  }
  if (["off", "false", "0", "disabled"].includes(normalized)) {
    return false;
  }
  throw new InvalidArgumentError(
    "auto-failover value must be one of: on, off, true, false, 1, 0, enabled, disabled",
  );
}

export async function handleSetAutoFailover(
  explicitAgentName: string | undefined,
  value: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const autoFailover = parseAutoFailoverValue(value);
  const selector = resolveSessionTargetSelector({ flags, command });
  const record = await findRoutedTargetSessionOrThrow(agent, selector);
  const { setSessionAutoFailover } = await loadSessionModule();
  const result = await setSessionAutoFailover({
    sessionId: record.acpxRecordId,
    autoFailover,
    sessionName: selector.name ?? record.name,
  });
  printSetAutoFailoverResultByFormat(result, globalFlags.format);
}

function printSetAutoFailoverResultByFormat(
  result: { record: SessionRecord; autoFailover: boolean },
  format: OutputFormat,
): void {
  const label = result.autoFailover ? "on" : "off";
  if (
    emitJsonResult(format, {
      action: "auto_failover_set",
      autoFailover: result.autoFailover,
      acpxRecordId: result.record.acpxRecordId,
      acpxSessionId: result.record.acpSessionId,
      agentSessionId: result.record.agentSessionId,
    })
  ) {
    return;
  }
  process.stdout.write(format === "quiet" ? `${label}\n` : `auto-failover set: ${label}\n`);
}

// brick://4d517be2 — `set auto-subscription on|off` (mirror auto-failover).
function isAutoSubscriptionConfigKey(configId: string): boolean {
  const normalized = configId.trim();
  return (
    normalized === "auto-subscription" ||
    normalized === "auto_subscription" ||
    normalized === "autoSubscription"
  );
}

function parseOnOffValue(value: string, optionLabel: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["on", "true", "1", "enabled"].includes(normalized)) {
    return true;
  }
  if (["off", "false", "0", "disabled"].includes(normalized)) {
    return false;
  }
  throw new InvalidArgumentError(
    `${optionLabel} value must be one of: on, off, true, false, 1, 0, enabled, disabled`,
  );
}

export async function handleSetAutoSubscription(
  explicitAgentName: string | undefined,
  value: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const autoSubscription = parseOnOffValue(value, "auto-subscription");
  const selector = resolveSessionTargetSelector({ flags, command });
  const record = await findRoutedTargetSessionOrThrow(agent, selector);
  const { setSessionAutoSubscription } = await loadSessionModule();
  const result = await setSessionAutoSubscription({
    sessionId: record.acpxRecordId,
    autoSubscription,
    sessionName: selector.name ?? record.name,
  });
  printOnOffResultByFormat(
    {
      action: "auto_subscription_set",
      key: "autoSubscription",
      value: result.autoSubscription,
      record: result.record,
    },
    "auto-subscription",
    globalFlags.format,
  );
}

// brick://4d517be2 — `set fable-degrade on|off` (mirror auto-failover).
function isFableDegradeConfigKey(configId: string): boolean {
  const normalized = configId.trim();
  return (
    normalized === "fable-degrade" ||
    normalized === "fable_degrade" ||
    normalized === "fableDegrade" ||
    normalized === "fable-degrade-ok" ||
    normalized === "fable_degrade_ok" ||
    normalized === "fableDegradeOk"
  );
}

export async function handleSetFableDegrade(
  explicitAgentName: string | undefined,
  value: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const fableDegradeOk = parseOnOffValue(value, "fable-degrade");
  const selector = resolveSessionTargetSelector({ flags, command });
  const record = await findRoutedTargetSessionOrThrow(agent, selector);
  const { setSessionFableDegrade } = await loadSessionModule();
  const result = await setSessionFableDegrade({
    sessionId: record.acpxRecordId,
    fableDegradeOk,
    sessionName: selector.name ?? record.name,
  });
  printOnOffResultByFormat(
    {
      action: "fable_degrade_set",
      key: "fableDegradeOk",
      value: result.fableDegradeOk,
      record: result.record,
    },
    "fable-degrade",
    globalFlags.format,
  );
}

function printOnOffResultByFormat(
  payload: { action: string; key: string; value: boolean; record: SessionRecord },
  label: string,
  format: OutputFormat,
): void {
  const state = payload.value ? "on" : "off";
  if (
    emitJsonResult(format, {
      action: payload.action,
      [payload.key]: payload.value,
      acpxRecordId: payload.record.acpxRecordId,
      acpxSessionId: payload.record.acpSessionId,
      agentSessionId: payload.record.agentSessionId,
    })
  ) {
    return;
  }
  process.stdout.write(format === "quiet" ? `${state}\n` : `${label} set: ${state}\n`);
}

// `acpx <agent> set subscription <id>` — change the session's Claude
// subscription in place (record edit + transcript port; respawn binds it). Cold
// vs live handling lives in setSessionSubscription. Refuses with turn-in-flight
// if a turn is active on the live owner (surfaced to acpx-ui as 409).
export async function handleSetSubscription(
  explicitAgentName: string | undefined,
  subscriptionId: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const trimmedId = subscriptionId.trim();
  const registry = loadSubscriptionRegistry();
  const subscription = findSubscription(trimmedId, registry);
  if (!subscription) {
    throw new SubscriptionUnknownError(
      trimmedId,
      registry.subscriptions.map((entry) => entry.id),
    );
  }
  if (isSubscriptionLocked(subscription, registry)) {
    throw new SubscriptionLockedError(trimmedId);
  }
  const selector = resolveSessionTargetSelector({ flags, command });
  const record = await findRoutedTargetSessionOrThrow(agent, selector);
  const { setSessionSubscription } = await loadSessionModule();
  const result = await setSessionSubscription({
    sessionId: record.acpxRecordId,
    subscriptionId: trimmedId,
    sessionName: selector.name ?? record.name,
    verbose: globalFlags.verbose,
  });
  printSetSubscriptionResultByFormat(result, globalFlags.format);
}

function printSetSubscriptionResultByFormat(
  result: {
    record: SessionRecord;
    from?: string;
    to: string;
    transcriptCopied: boolean;
    ownerRestarted: boolean;
  },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "subscription_set",
      subscription: result.to,
      from: result.from,
      transcriptCopied: result.transcriptCopied,
      ownerRestarted: result.ownerRestarted,
      acpxRecordId: result.record.acpxRecordId,
      acpxSessionId: result.record.acpSessionId,
    })
  ) {
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${result.to}\n`);
    return;
  }
  const fromLabel = result.from ? `${result.from} → ` : "";
  process.stdout.write(`subscription set: ${fromLabel}${result.to}\n`);
}

// Credential-CLASS guard for a manual profile move. The move must stay within
// the session's adapter/authMode class; its current credential is the same value
// switchSessionAccount resolves as its `from` (pinned profile/subscription, else
// the registry default). If that resolves and crosses adapter/authMode, refuse —
// switchSessionAccount does not assert this for manual moves and a cross-class
// move would wedge auth at the next turn.
// The session's current credential id — the same value switchSessionAccount
// resolves as its `from`: the pinned profile/subscription, else the registry
// default.
function currentCredentialId(record: SessionRecord, registry: ProfileRegistry): string | undefined {
  const options = record.acpx?.session_options;
  const pinned = (options?.profile ?? options?.subscription)?.trim();
  return pinned ? pinned : registry.default;
}

function assertSameCredentialClass(
  record: SessionRecord,
  target: ProfileEntry,
  registry: ProfileRegistry,
): void {
  const currentId = currentCredentialId(record, registry);
  const current = currentId ? findProfile(currentId, registry) : undefined;
  if (!current) {
    return;
  }
  if (current.adapter === target.adapter && current.authMode === target.authMode) {
    return;
  }
  throw new ProfileClassMismatchError({
    targetId: target.id,
    targetAuthMode: target.authMode,
    currentId: current.id,
    currentAuthMode: current.authMode,
  });
}

// `acpx <agent> set profile <id>` — move the session to a different credential
// PROFILE in place (the unified SDK-subscription + claude-pty-bridge move). Like
// `set subscription`, the move is a record edit + transcript port; a respawn
// binds it. Refuses with turn-in-flight if a turn is active on the live owner
// (surfaced to acpx-ui as 409). The credential-CLASS guard below rejects a move
// that would cross adapter/authMode classes (which would otherwise wedge auth at
// the next turn — switchSessionAccount does not assert this for manual moves).
export async function handleSetProfile(
  explicitAgentName: string | undefined,
  profileId: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const trimmedId = profileId.trim();
  const registry = loadProfileRegistry();
  const target = findProfile(trimmedId, registry);
  if (!target) {
    throw new ProfileUnknownError(
      trimmedId,
      registry.profiles.map((entry) => entry.id),
    );
  }
  assertProfileUnlocked(target, registry);
  const selector = resolveSessionTargetSelector({ flags, command });
  const record = await findRoutedTargetSessionOrThrow(agent, selector);
  assertSameCredentialClass(record, target, registry);

  const { setSessionProfile } = await loadSessionModule();
  const result = await setSessionProfile({
    sessionId: record.acpxRecordId,
    profileId: trimmedId,
    sessionName: selector.name ?? record.name,
    verbose: globalFlags.verbose,
  });
  printSetProfileResultByFormat(result, globalFlags.format);
}

function printSetProfileResultByFormat(
  result: {
    record: SessionRecord;
    from?: string;
    to: string;
    transcriptCopied: boolean;
    ownerRestarted: boolean;
  },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "profile_set",
      profile: result.to,
      from: result.from,
      transcriptCopied: result.transcriptCopied,
      ownerRestarted: result.ownerRestarted,
      acpxRecordId: result.record.acpxRecordId,
      acpxSessionId: result.record.acpSessionId,
    })
  ) {
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${result.to}\n`);
    return;
  }
  const fromLabel = result.from ? `${result.from} → ` : "";
  process.stdout.write(`profile set: ${fromLabel}${result.to}\n`);
}

function printSetMetadataResultByFormat(
  key: string,
  value: string,
  record: SessionRecord,
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "metadata_set",
      key,
      value,
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
    })
  ) {
    return;
  }
  process.stdout.write(format === "quiet" ? `${value}\n` : `metadata set: ${key}=${value}\n`);
}

async function warnIfTaskFolderMissing(folder: string): Promise<void> {
  try {
    await fs.access(folder);
  } catch {
    process.stderr.write(`[acpx] warning: task_folder does not exist yet: ${folder}\n`);
  }
}

// Self-apply: let a running session set/update its OWN session-record metadata
// (e.g. task_folder) without an ACP round-trip. Pure record edit: resolve the
// locally-routed session (or one exact global name after a local miss), merge
// the key into a freshly-read record, and persist it.
// acpx-ui reflects the link on its next read; $ACPX_TASK_FOLDER reaches the agent
// on its NEXT prompt/exec turn (a live process's env cannot be mutated in place).
export async function handleSessionsSetMetadata(
  explicitAgentName: string | undefined,
  key: string,
  value: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const trimmedValue = validateSessionMetadataValue(key, value);
  const selector = resolveSessionTargetSelector({ flags, command });
  const record = await findRoutedTargetSessionOrThrow(agent, selector);
  if (key === "task_folder") {
    await warnIfTaskFolderMissing(trimmedValue);
  }
  if (key === "brick") {
    await warnIfBrickDoesNotResolve(trimmedValue);
  }
  await writeSessionRecord(mergeSessionMetadata(record, key, trimmedValue));
  printSetMetadataResultByFormat(key, trimmedValue, record, globalFlags.format);
}

async function tryListAgentSessions(
  agent: ResolvedAgentInvocation,
  flags: SessionsListFlags,
  globalFlags: ReturnType<typeof resolveGlobalFlags>,
  config: ResolvedAcpxConfig,
): Promise<SessionListResult | "spawn-failed"> {
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);
  const { listAgentSessions } = await loadSessionModule();
  try {
    return await listAgentSessions({
      agentCommand: agent.agentCommand,
      agentName: agent.agentName,
      cwd: agent.cwd,
      cursor: flags.cursor,
      filterCwd: resolveSessionListFilterCwd(flags, agent.cwd),
      mcpServers: config.mcpServers,
      permissionMode,
      nonInteractivePermissions: globalFlags.nonInteractivePermissions,
      permissionPolicy,
      authCredentials: config.auth,
      authPolicy: globalFlags.authPolicy,
      terminal: globalFlags.terminal,
      timeoutMs: globalFlags.timeout,
      verbose: globalFlags.verbose,
    });
  } catch (error) {
    if (error instanceof AgentSpawnError) {
      return "spawn-failed";
    }
    throw error;
  }
}

export async function handleSessionsList(
  explicitAgentName: string | undefined,
  flags: SessionsListFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const filterCwd = resolveSessionListFilterCwd(flags, agent.cwd);

  if (flags.local) {
    if (flags.cursor) {
      throw new InvalidArgumentError("--cursor cannot be combined with --local");
    }
    await printLocalSessionsList(
      agent.agentCommand,
      agent.agentName,
      filterCwd,
      globalFlags.format,
    );
    return;
  }

  const [result, { printAgentSessionsByFormat }] = await Promise.all([
    tryListAgentSessions(agent, flags, globalFlags, config),
    loadOutputRenderModule(),
  ]);

  if (!result || result === "spawn-failed") {
    if (result !== "spawn-failed" && (flags.cursor || flags.filterCwd)) {
      throw new Error(
        `Agent command "${agent.agentCommand}" does not advertise sessionCapabilities.list; cannot use agent-side session/list filters`,
      );
    }
    await printLocalSessionsList(
      agent.agentCommand,
      agent.agentName,
      undefined,
      globalFlags.format,
    );
    return;
  }

  printAgentSessionsByFormat(result, globalFlags.format);
}

// D1 / KD-5 (brick://53437107) — the opt-in strict exit for `--fail-on-undelivered`.
//
// The DEFAULT stays 0 on a successful close even when custody was lost, and that
// is an orchestrator decision rather than a preference: many fleet call-sites run
// `sessions close` under `set -e` as their final act, so a non-zero default would
// abort wrap-ups fleet-wide. A safety fix must not become an availability
// regression — the thing that was missing here was SIGNAL, not exit status.
const UNDELIVERED_CUSTODY_EXIT_CODE = 3;

export async function handleSessionsClose(
  explicitAgentName: string | undefined,
  sessionName: string | undefined,
  flags: SessionsCloseFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [{ closeSession }, { printClosedSessionByFormat, warnUndeliveredCustody }] =
    await Promise.all([loadSessionModule(), loadOutputRenderModule()]);

  const selector = resolveSessionTargetSelector({ flags, command, positionalName: sessionName });
  const explicitRecord = await resolveExplicitSessionRecord(selector);
  const localRecord =
    explicitRecord ??
    (await findSession({
      agentCommand: agent.agentCommand,
      agentName: agent.agentName,
      cwd: agent.cwd,
      name: selector.name,
    }));
  const record =
    localRecord ??
    (selector.name === undefined
      ? undefined
      : await resolveGlobalSessionByName({
          agentCommand: agent.agentCommand,
          agentName: agent.agentName,
          name: selector.name,
        }));

  if (!record) {
    throw new Error(missingScopedSessionMessage(agent, sessionName));
  }

  // Commander maps `--no-drain` onto `flags.drain === false`; absent means the
  // barrier runs.
  const closed = await closeSession(record.acpxRecordId, {
    drain: flags.drain !== false,
    drainTimeoutMs: flags.drainTimeout,
    verbose: globalFlags.verbose,
  });
  printClosedSessionByFormat(closed.record, closed.drain, globalFlags.format);

  if (closed.drain.undelivered.length > 0) {
    warnUndeliveredCustody(record.name ?? record.acpxRecordId, closed.drain);
    if (flags.failOnUndelivered) {
      process.exitCode = UNDELIVERED_CUSTODY_EXIT_CODE;
    }
  }
}

// Resolve the prompt to auto-fire on a `--from-template` spawn. Commander couples
// --prompt <text> / --no-prompt onto flags.prompt:
//   false → --no-prompt (suppress); string → explicit override;
//   true/undefined → fall through to the template's stored auto_prompt.
// Precedence: --prompt <text>  ▷  template.auto_prompt  ▷  nothing. A blank result
// (absent/empty/whitespace) means no fire.
function resolveTemplateAutoPrompt(
  flags: SessionsNewFlags,
  source: SessionRecord,
): string | undefined {
  if (flags.prompt === false) {
    return undefined;
  }
  const resolved = typeof flags.prompt === "string" ? flags.prompt : source.template?.auto_prompt;
  return resolved?.trim() ? resolved : undefined;
}

// `sessions new --from-template <id>` instantiates a working session from a saved
// template (a copy whose source must be a template), then auto-fires the template's
// stored prompt into the child so it starts work immediately (the warm-worker
// northstar). The auto-fire lives HERE (the --from-template wrapper), NOT in shared
// runSessionCopy — acpx-ui's UI path shells out to the low-level `sessions copy`
// (which routes through runSessionCopy) and fires its own dialog prompt via the
// server's `if (prompt)`, so an auto-fire inside runSessionCopy would double-fire on
// the UI path (K4).
async function handleSessionsNewFromTemplate(
  explicitAgentName: string | undefined,
  flags: SessionsNewFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  // Caller guards on flags.fromTemplate !== undefined before dispatching here.
  const fromTemplate = flags.fromTemplate as string;
  const globalFlags = resolveGlobalFlags(command, config);
  // Resolve the selector here (id-first → slug) so we can stamp the RESOLVED
  // immutable record id as template_source (provenance must point at the concrete
  // version actually spawned from, not the raw slug/arg) and print the selector
  // kind. runSessionCopy re-resolves the concrete id (exact-id match → the same
  // record) and still gates it through assertTemplateSource.
  const { record: resolvedSource, selectorKind } = await resolveTemplateSelector(fromTemplate);
  if (globalFlags.verbose) {
    const via =
      selectorKind === "slug" ? `slug (version ${resolvedSource.template?.version ?? "?"})` : "id";
    process.stderr.write(
      `[acpx] --from-template '${fromTemplate}' → ${resolvedSource.acpxRecordId} via ${via}\n`,
    );
  }
  const { created, source } = await runSessionCopy(
    explicitAgentName,
    {
      from: resolvedSource.acpxRecordId,
      name: flags.name,
      // Mark this child as a template-spawn (vs a plain fork): a normal
      // `sessions copy`/`fork` writes the same parent_session_id +
      // forked_from_session_id, so the board needs an explicit discriminator
      // to place it under its creator with a "from template" provenance badge.
      // Only the --from-template path sets it; plain copy/fork never does.
      // template_source = the RESOLVED immutable id (not the raw arg) so a child
      // spawned by slug records the concrete version it actually came from.
      metadata: { ...flags.metadata, template_source: resolvedSource.acpxRecordId },
      brick: flags.brick,
      parentId: flags.parentId,
      parentSessionUrl: flags.parentSessionUrl,
    },
    command,
    config,
    true,
  );
  const autoPromptText = resolveTemplateAutoPrompt(flags, source);
  if (!autoPromptText) {
    return;
  }
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);
  await deliverPrompt({
    sessionId: created.acpxRecordId,
    prompt: textPrompt(autoPromptText),
    // Enqueue-and-return: the spawn command surfaces the child's URL promptly while
    // the agent works the prompt asynchronously (mirrors the UI's `prompt --no-wait`).
    waitForCompletion: false,
    globalFlags,
    permissionMode,
    permissionPolicy,
    outputPolicy: resolveRequestedOutputPolicy(globalFlags),
    config,
  });
}

export async function handleSessionsNew(
  explicitAgentName: string | undefined,
  flags: SessionsNewFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  // `sessions new --from-template <id>` instantiates a working session from a
  // saved template. It is a copy whose source must be a template; the copy
  // inherits the template's agent type + context and is itself a normal open
  // session (createSession never carries the template marker forward). Routes
  // through the shared copy core so it reuses native deep-copy, the agent-type
  // lock, and cwd/lineage handling rather than the fresh-session path.
  if (flags.fromTemplate !== undefined) {
    await handleSessionsNewFromTemplate(explicitAgentName, flags, command, config);
    return;
  }

  const globalFlags = resolveGlobalFlags(command, config);
  validateExplicitCredentialFlags(globalFlags);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);
  const parent = await resolveAndValidateParentSessionId(flags);
  const resolvedBrick = await resolveBrickFlagValue(flags.brick);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const effectiveAgent = resolveEffectiveSpawnAgent(
    agent,
    explicitAgentName,
    globalFlags,
    parent,
    config,
  );
  warnReasoningEffortIgnoredForNonClaude(globalFlags, effectiveAgent.agentName);
  const [{ createSession, closeSession }, { printCreatedSessionBanner, printNewSessionByFormat }] =
    await Promise.all([loadSessionModule(), loadOutputRenderModule()]);

  const replaced = await findSession({
    agentCommand: effectiveAgent.agentCommand,
    agentName: effectiveAgent.agentName,
    cwd: effectiveAgent.cwd,
    name: flags.name,
  });

  if (replaced) {
    // Deliberately takes the DEFAULT drain: every close entry point goes through
    // the barrier, so it cannot be bypassed by an alternate route (DESIGN §6,
    // and the precondition a future auto-close policy inherits).
    await closeSession(replaced.acpxRecordId);
    if (globalFlags.verbose) {
      process.stderr.write(`[acpx] soft-closed prior session: ${replaced.acpxRecordId}\n`);
    }
  }

  const created = await createSession(
    buildSessionStartOptions({
      agent: effectiveAgent,
      flags,
      globalFlags,
      config,
      permissionMode,
      permissionPolicy,
      parent,
      resolvedBrick,
    }),
  );
  await maybeStampBrickLink(created);

  printCreatedSessionBanner(
    created,
    effectiveAgent.agentName,
    globalFlags.format,
    globalFlags.jsonStrict,
  );

  if (globalFlags.verbose) {
    const scope = flags.name ? `named session "${flags.name}"` : "cwd session";
    process.stderr.write(`[acpx] created ${scope}: ${created.acpxRecordId}\n`);
  }

  printNewSessionByFormat(created, replaced, globalFlags.format);
}

export async function handleSessionsCopy(
  explicitAgentName: string | undefined,
  flags: SessionsCopyFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const handoffPrompt = await resolveCopyHandoffPrompt(flags, command, config);
  const { created, source } = await runSessionCopy(
    explicitAgentName,
    flags,
    command,
    config,
    false,
  );

  // #3 Fork notice: inject a divergence-handoff as turn 1 for every non-ephemeral
  // (plain) fork so the forked agent self-identifies and does not act as the source.
  // Byway (ephemeral) keeps its existing frontend handoff untouched.
  const forkNotice = !flags.ephemeral
    ? composeForkDivergenceNotice(created, source.acpxRecordId)
    : undefined;

  if (!forkNotice && !handoffPrompt) {
    return;
  }

  if (!forkNotice) {
    // Byway / ephemeral path: no notice, deliver handoffPrompt as-is (may include images).
    await deliverCopyHandoffPrompt(created.acpxRecordId, handoffPrompt!, command, config);
    return;
  }

  // Plain fork path: combine notice + any CLI --prompt into a single text block
  // so the transcript stores one content string the frontend can peel by
  // FORK_NOTICE_MARKER. promptToDisplayText joins text blocks; image blocks are
  // ignored (fork handoffs via --prompt don't carry images).
  const handoffText = handoffPrompt ? promptToDisplayText(handoffPrompt) : "";
  const deliverText = forkNotice + (handoffText ? handoffText : "");
  await deliverCopyHandoffPrompt(created.acpxRecordId, textPrompt(deliverText), command, config);
}

async function resolveCopyHandoffPrompt(
  flags: SessionsCopyFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<import("../types.js").PromptInput | undefined> {
  const hasPrompt = typeof flags.prompt === "string";
  const hasPromptFile = typeof flags.promptFile === "string";
  if (!hasPrompt && !hasPromptFile) {
    return undefined;
  }
  if (hasPrompt && hasPromptFile) {
    throw new InvalidArgumentError("Use only one of --prompt or --prompt-file");
  }

  const globalFlags = resolveGlobalFlags(command, config);
  return await readPrompt(
    hasPrompt ? [flags.prompt as string] : [],
    flags.promptFile,
    globalFlags.cwd,
  );
}

async function deliverCopyHandoffPrompt(
  sessionId: string,
  prompt: import("../types.js").PromptInput,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  validateExplicitCredentialFlags(globalFlags);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);
  await deliverPrompt({
    sessionId,
    prompt,
    // Copy/fork handoff is a spawn-style fire-and-return operation: the parent
    // gets the child's id/URL immediately while the copied session works async.
    waitForCompletion: false,
    globalFlags,
    permissionMode,
    permissionPolicy,
    outputPolicy: resolveRequestedOutputPolicy(globalFlags),
    config,
  });
}

// Shared core for `sessions copy`/`fork` and `sessions new --from-template`.
// `requireTemplate` gates the source to acpx-ui-marked templates; everything else
// (native deep-copy, agent-type lock, cwd/lineage handling, output) is identical.
async function runSessionCopy(
  explicitAgentName: string | undefined,
  flags: SessionsCopyFlags,
  command: Command,
  config: ResolvedAcpxConfig,
  requireTemplate: boolean,
): Promise<{
  created: Awaited<ReturnType<SessionModule["createSession"]>>;
  source: SessionRecord;
}> {
  const globalFlags = resolveGlobalFlags(command, config);
  validateExplicitCredentialFlags(globalFlags);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);
  const pathAgent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const source = await resolveSessionRecord(flags.from);
  assertCopyableSource(source);
  if (requireTemplate) {
    assertTemplateSource(source);
  }
  const forkAtMessageIndex = resolveForkAtMessageIndex(source, flags.atIndex);
  assertCopyAgentLock({ explicitAgentName, globalFlags, pathAgent, source, config });

  // GAP 1 — resolve the spawn parent the same way plain-`new` does (flag →
  // flag → ACPX_SESSION_URL env fallback). The copy/template/fork child then
  // carries BOTH its spawn-parent edge (parentSessionId/Url) AND its template
  // /fork origin (forkFromSessionId) — the "both edges" write. With no parent
  // context the `?.` guards omit both fields → byte-identical to today.
  const parent = await resolveAndValidateParentSessionId(flags);
  const resolvedBrick = await resolveBrickFlagValue(flags.brick);

  const [{ createSession }, { printCopiedSessionByFormat, printCreatedSessionBanner }] =
    await Promise.all([loadSessionModule(), loadOutputRenderModule()]);
  const created = await createSession({
    agentCommand: source.agentCommand,
    agentName: source.agentName ?? resolveAgentNameFromCommand(source.agentCommand, config.agents),
    cwd: resolveCopyDestinationCwd(command, globalFlags, source),
    name: flags.name ?? sourceDefaultForkName(source),
    // metadata.brick carry: precedence = --brick flag > spawn-parent brick (--parent-id / byway)
    // > none. A plain fork/copy carries NO brick by default (the 07-15 source.metadata.brick
    // fallback was reversed, brick://1113da9d) so it does not impersonate the source's brick;
    // task_folder mirrors the same two-tier precedence.
    metadata: withInheritedBrick(
      applyBrickFlag(
        withInheritedTaskFolder(
          copyMetadata(flags, source, forkAtMessageIndex),
          parent?.taskFolder, // spawn-parent task_folder (byway via --parent-id) — KEEP
        ),
        resolvedBrick,
      ),
      parent?.brick, // spawn-parent brick (byway via --parent-id) — KEEP
      resolvedBrick === false,
    ),
    parentSessionId: parent?.acpxRecordId,
    parentSessionUrl: parent?.sessionUrl,
    forkFromSessionId: source.acpxRecordId,
    forkAtMessageIndex: flags.atIndex,
    mcpServers: config.mcpServers,
    permissionMode,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    permissionPolicy,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    terminal: globalFlags.terminal,
    timeoutMs: globalFlags.timeout,
    verbose: globalFlags.verbose,
    sessionOptions: copySessionOptionsWithOverride(source, globalFlags),
    desiredConfigOptions: copyDesiredConfigOptionsWithOverride(source, globalFlags),
  });
  await maybeStampBrickLink(created);
  const sourceType = agentTypeLabel(source.agentCommand, config);
  printCreatedSessionBanner(created, sourceType, globalFlags.format, globalFlags.jsonStrict);
  printCopiedSessionByFormat(created, source, globalFlags.format);
  return { created, source };
}

function assertTemplateSource(source: SessionRecord): void {
  if (!isTemplateRecord(source)) {
    throw new Error(
      `Session ${source.acpxRecordId} is not a template; mark it as a template first ` +
        `(acpx-ui: "Save as template", or PATCH /api/sessions/:id/template) before instantiating`,
    );
  }
}

// `acpx <agent> sessions templates` — list the agent's saved templates. Templates
// are local, acpx-ui-owned records (closed sessions flagged template.enabled), so
// this reads the local store and filters; the agent adapter is never consulted.
export async function handleSessionsTemplates(
  explicitAgentName: string | undefined,
  _flags: SessionsListFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [{ listSessionsForAgent }, { printSessionsByFormat }] = await Promise.all([
    loadSessionModule(),
    loadOutputRenderModule(),
  ]);
  const sessions = await listSessionsForAgent(agent.agentCommand, agent.agentName);
  printSessionsByFormat(sessions.filter(isTemplateRecord), globalFlags.format);
}

// Mark a session as a template: terminate any live owner first so the template is a
// clean, closed record (no agent left attached to a "closed template"). closeSession
// kills the queue owner/process group and persists closed:true via the privileged
// path; it is idempotent (no owner = success). Re-resolve afterwards to pick up the
// persisted close, then stamp the marker. Idempotent re-enable preserves the original
// creation stamp / source id.
// Resolve the template's auto_prompt on a mark (--enable). Set when --auto-prompt is
// present (incl. "" → clear); preserve the existing value when the flag is absent,
// mirroring the created_at ?? idempotent-preserve idiom so a plain re-enable keeps
// the stored prompt.
function resolveMarkAutoPrompt(
  flags: SessionsTemplateFlags,
  record: SessionRecord,
): string | undefined {
  if (flags.autoPrompt !== undefined) {
    return flags.autoPrompt || undefined;
  }
  return record.template?.auto_prompt;
}

async function markSessionAsTemplate(
  sessionId: string,
  flags: SessionsTemplateFlags,
): Promise<SessionRecord> {
  const initial = await resolveSessionRecord(sessionId);
  const { closeSession } = await loadSessionModule();
  // Default drain here too — see the note at the soft-close site above.
  await closeSession(initial.acpxRecordId);
  const record = await resolveSessionRecord(sessionId);
  record.template = {
    enabled: true,
    created_at: record.template?.created_at ?? isoNow(),
    source_session_id: record.template?.source_session_id ?? record.acpSessionId,
    auto_prompt: resolveMarkAutoPrompt(flags, record),
    // Carry existing slug/version forward (like created_at/source above) so an
    // idempotent re-enable is detected by persistTemplateMark and does NOT bump
    // the version. persistTemplateMark fills/overrides these next.
    slug: record.template?.slug,
    version: record.template?.version,
  };
  record.closed = true;
  record.closedAt = record.closedAt ?? isoNow();
  return record;
}

// Clear the template marker. Disable un-templates only — leave closed/closedAt as-is
// (disabling does not reopen a session). Idempotent on a non-template record.
async function unmarkSessionTemplate(sessionId: string): Promise<SessionRecord> {
  const record = await resolveSessionRecord(sessionId);
  record.template = undefined;
  return record;
}

// `acpx <agent> sessions template <id> --enable|--disable` — mark/unmark a session
// as a reusable template. A template is a local record carrying `template.enabled`
// plus `closed` (acpx-ui parity). The verb writes the local store directly via the
// PRIVILEGED lifecycle writer (`writeSessionRecordWithLifecycle`): a plain
// `writeSessionRecord` read-preserves `template`/`closed` (FW-16) and would silently
// revert the change. This verb thus joins `closeSession` as a second authorized
// writer of those lifecycle fields. Addressed by id (like `recover`/`owner-status`),
// not cwd+name.
export async function handleSessionsTemplate(
  _explicitAgentName: string | undefined,
  sessionId: string,
  flags: SessionsTemplateFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  if (flags.enable === true && flags.disable === true) {
    throw new InvalidArgumentError("--enable and --disable are mutually exclusive");
  }
  // Default action when neither flag is passed = enable (the verb's job is to make
  // a template).
  const enable = flags.disable !== true;

  const record = enable
    ? await markSessionAsTemplate(sessionId, flags)
    : await unmarkSessionTemplate(sessionId);

  if (enable) {
    // Assigns slug (default slugify(name), overridable via --slug) + version =
    // max+1 for the slug group, under the index lock (E6), then PRIVILEGED-writes.
    await persistTemplateMark(record, { slug: flags.slug });
  } else {
    // PRIVILEGED write — see the function doc-comment. Never use plain
    // writeSessionRecord here; it would read-preserve the on-disk template/closed
    // and drop the clear.
    await writeSessionRecordWithLifecycle(record);
  }

  printTemplateResult(record, enable, globalFlags.format);
}

function templateResultHumanLine(record: SessionRecord, enable: boolean): string {
  if (!enable) {
    return "disabled";
  }
  const autoPromptNote = record.template?.auto_prompt ? " (auto-prompt set)" : "";
  const slug = record.template?.slug;
  const slugNote = slug !== undefined ? ` [${slug} v${record.template?.version ?? "?"}]` : "";
  return `enabled (closed)${slugNote}${autoPromptNote}`;
}

function printTemplateResult(record: SessionRecord, enable: boolean, format: OutputFormat): void {
  const result = {
    action: enable ? ("template_enabled" as const) : ("template_disabled" as const),
    acpxRecordId: record.acpxRecordId,
    template: enable,
    closed: record.closed === true,
    created_at: record.template?.created_at,
    source_session_id: record.template?.source_session_id,
    auto_prompt: record.template?.auto_prompt,
    slug: record.template?.slug,
    version: record.template?.version,
  };
  if (!emitJsonResult(format, result)) {
    process.stdout.write(
      `template ${record.acpxRecordId}: ${templateResultHumanLine(record, enable)}\n`,
    );
  }
}

export async function handleSessionsEnsure(
  explicitAgentName: string | undefined,
  flags: SessionsNewFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  validateExplicitCredentialFlags(globalFlags);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);
  const parent = await resolveAndValidateParentSessionId(flags);
  const resolvedBrick = await resolveBrickFlagValue(flags.brick);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const effectiveAgent = resolveEffectiveSpawnAgent(
    agent,
    explicitAgentName,
    globalFlags,
    parent,
    config,
  );
  warnReasoningEffortIgnoredForNonClaude(globalFlags, effectiveAgent.agentName);
  const existing = await findSessionByDirectoryWalk({
    agentCommand: effectiveAgent.agentCommand,
    cwd: effectiveAgent.cwd,
    name: flags.name,
    boundary: findGitRepositoryRoot(effectiveAgent.cwd) ?? effectiveAgent.cwd,
  });
  if (existing) {
    await assertExplicitSubscriptionMatchesExistingSession({
      globalFlags,
      record: existing,
      agentName: effectiveAgent.agentName,
    });
  }
  const [{ ensureSession }, { printCreatedSessionBanner, printEnsuredSessionByFormat }] =
    await Promise.all([loadSessionModule(), loadOutputRenderModule()]);
  const result = await ensureSession(
    buildSessionStartOptions({
      agent: effectiveAgent,
      flags,
      globalFlags,
      config,
      permissionMode,
      permissionPolicy,
      parent,
      resolvedBrick,
    }),
  );
  await maybeStampBrickLink(result.record);

  if (result.created) {
    printCreatedSessionBanner(
      result.record,
      effectiveAgent.agentName,
      globalFlags.format,
      globalFlags.jsonStrict,
    );
  }

  printEnsuredSessionByFormat(result.record, result.created, globalFlags.format);
}

function userContentToText(content: SessionUserContent): string {
  if ("Text" in content) {
    return content.Text;
  }
  if ("Mention" in content) {
    return content.Mention.content;
  }
  if ("Image" in content) {
    return content.Image.source || "[image]";
  }
  if ("Audio" in content) {
    return `[audio] ${content.Audio.mime_type || "audio"}`;
  }
  return "";
}

function agentContentToText(content: SessionAgentContent): string {
  if ("Text" in content) {
    return content.Text;
  }
  if ("Thinking" in content) {
    return content.Thinking.text;
  }
  if ("RedactedThinking" in content) {
    return "[redacted_thinking]";
  }
  if ("ToolUse" in content) {
    return `[tool:${content.ToolUse.name}]`;
  }
  return "";
}

function conversationHistoryEntries(record: SessionRecord): Array<{
  role: "user" | "assistant";
  timestamp: string;
  textPreview: string;
}> {
  const entries: Array<{ role: "user" | "assistant"; timestamp: string; textPreview: string }> = [];

  for (const message of record.messages) {
    if (message === "Resume") {
      continue;
    }

    if ("User" in message) {
      const text = message.User.content
        .map((entry) => userContentToText(entry))
        .join(" ")
        .trim();
      if (!text) {
        continue;
      }
      entries.push({ role: "user", timestamp: record.updated_at, textPreview: text });
      continue;
    }

    if ("Agent" in message) {
      const text = message.Agent.content
        .map((entry) => agentContentToText(entry))
        .join(" ")
        .trim();
      if (!text) {
        continue;
      }
      entries.push({ role: "assistant", timestamp: record.updated_at, textPreview: text });
    }
  }

  return entries;
}

function printSessionDetailsByFormat(record: SessionRecord, format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${record.acpxRecordId}\n`);
    return;
  }
  for (const line of sessionDetailsLines(record)) {
    process.stdout.write(`${line}\n`);
  }
}

function sessionDetailsLines(record: SessionRecord): string[] {
  return [
    `id: ${record.acpxRecordId}`,
    `sessionId: ${record.acpSessionId}`,
    `agentSessionId: ${displayValue(record.agentSessionId)}`,
    `agent: ${record.agentCommand}`,
    `cwd: ${record.cwd}`,
    `name: ${displayValue(record.name)}`,
    `created: ${record.createdAt}`,
    `lastActivity: ${record.lastUsedAt}`,
    `lastPrompt: ${displayValue(record.lastPromptAt)}`,
    `closed: ${record.closed ? "yes" : "no"}`,
    `closedAt: ${displayValue(record.closedAt)}`,
    `pid: ${displayValue(record.pid)}`,
    `agentStartedAt: ${displayValue(record.agentStartedAt)}`,
    `lastExitCode: ${displayValue(record.lastAgentExitCode)}`,
    `lastExitSignal: ${displayValue(record.lastAgentExitSignal)}`,
    `lastExitAt: ${displayValue(record.lastAgentExitAt)}`,
    `disconnectReason: ${displayValue(record.lastAgentDisconnectReason)}`,
    `historyEntries: ${conversationHistoryEntries(record).length}`,
  ];
}

function displayValue(value: string | number | boolean | null | undefined): string {
  return value == null ? "-" : String(value);
}

function printSessionHistoryByFormat(
  record: SessionRecord,
  limit: number,
  format: OutputFormat,
): void {
  const history = conversationHistoryEntries(record);
  const visible = limit === 0 ? history : history.slice(Math.max(0, history.length - limit));

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify({
        id: record.acpxRecordId,
        sessionId: record.acpSessionId,
        limit,
        count: visible.length,
        entries: visible,
      })}\n`,
    );
    return;
  }

  if (format === "quiet") {
    for (const entry of visible) {
      process.stdout.write(`${entry.textPreview}\n`);
    }
    return;
  }

  process.stdout.write(
    `session: ${record.acpxRecordId} (${visible.length}/${history.length} shown)\n`,
  );
  if (visible.length === 0) {
    process.stdout.write("No history\n");
    return;
  }

  for (const entry of visible) {
    process.stdout.write(`${entry.timestamp}\t${entry.role}\t${entry.textPreview}\n`);
  }
}

export async function handleSessionsShow(
  explicitAgentName: string | undefined,
  sessionName: string | undefined,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const selector = resolveSessionTargetSelector({ flags, command, positionalName: sessionName });
  const record = await findReadableSessionOrThrow({
    explicitAgentName,
    agent,
    selector,
    subcommand: "show",
    config,
  });

  printSessionDetailsByFormat(record, globalFlags.format);
}

export async function handleSessionsHistory(
  explicitAgentName: string | undefined,
  sessionName: string | undefined,
  flags: SessionsHistoryFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const subcommand = command.name() === "read" ? "read" : "history";
  const selector = resolveSessionTargetSelector({ flags, command, positionalName: sessionName });
  const record = await findReadableSessionOrThrow({
    explicitAgentName,
    agent,
    selector,
    subcommand,
    config,
  });

  printSessionHistoryByFormat(record, flags.limit, globalFlags.format);
}

export async function handleSessionsExport(
  explicitAgentName: string | undefined,
  sessionName: string | undefined,
  flags: SessionsExportFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const cwd = flags.sourceCwd ? path.resolve(agent.cwd, flags.sourceCwd) : agent.cwd;
  const selector = resolveSessionTargetSelector({ flags, command, positionalName: sessionName });
  const explicitSessionId = explicitSessionIdFromSelector(selector);

  await exportSession(
    explicitSessionId
      ? { sessionId: explicitSessionId }
      : {
          agentName: globalFlags.agent ? undefined : agent.agentName,
          agentCommand: agent.agentCommand,
          cwd,
          name: selector.name,
        },
    flags.output,
  );

  if (
    emitJsonResult(globalFlags.format, {
      action: "session_exported",
      output: flags.output,
    })
  ) {
    return;
  }

  if (globalFlags.format === "quiet") {
    process.stdout.write(`${flags.output}\n`);
    return;
  }

  process.stdout.write(`exported session to ${flags.output}\n`);
}

export async function handleSessionsImport(
  explicitAgentName: string | undefined,
  archivePath: string,
  flags: SessionsImportFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const result = await importSession(archivePath, {
    name: flags.name,
    newCwd: flags.destinationCwd ? path.resolve(globalFlags.cwd, flags.destinationCwd) : undefined,
    expectedAgentName: globalFlags.agent ? undefined : agent.agentName,
    expectedAgentCommand: agent.agentCommand,
  });

  if (
    emitJsonResult(globalFlags.format, {
      action: "session_imported",
      record_id: result.record_id,
      cwd: result.cwd,
    })
  ) {
    return;
  }

  if (globalFlags.format === "quiet") {
    process.stdout.write(`${result.record_id}\n`);
    return;
  }

  process.stdout.write(`imported session ${result.record_id} at ${result.cwd}\n`);
}

// `acpx <agent> sessions templates rollback <slug> [--delete]` — retract the
// current latest version of a slug. Default soft-retract (reversible); --delete
// hard-removes. The slug is resolved GLOBALLY (D2), so the agent prefix is just
// the CLI convention — the op spans the whole store.
export async function handleSessionsTemplatesRollback(
  slug: string,
  flags: { delete?: boolean },
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  let result: TemplateRollbackResult;
  try {
    result = await rollbackTemplateSlug(slug, { delete: flags.delete });
  } catch (error) {
    // ⚠️ THIS TYPE ONLY — see the same catch in handleSessionsPrune. Before this
    // there was no try/catch here at all, so a manifest-write failure reached
    // the operator as a raw stack trace.
    if (error instanceof DeletionManifestWriteError) {
      printTemplateRollbackAuditFailure(slug, error, globalFlags.format);
      process.exitCode = EXIT_CODES.ERROR;
      return;
    }
    throw error;
  }
  printTemplateRollbackResult(result, globalFlags.format);
}

/**
 * ⚠️ THE TOKEN RULE DOES NOT REACH THIS VERB. That rule is `prune`'s
 * (brick://dd4cb0e8 §3.3), and manufacturing one here would put the word "prune"
 * in front of an operator who is not running prune. What DOES carry over is the
 * reason those strings are pinned at all: an operator pastes and retries
 * whatever an error suggests, so this text is a control surface. It is asserted
 * line-anchored by T-S4.
 *
 * ⚠️ DO NOT ADD "or re-run without --delete" AS THE DISK-FULL REMEDY. It is the
 * natural-looking suggestion and it is WRONG: the soft-retract path calls
 * `writeSessionRecordWithLifecycle`, which is itself a write and fails on the
 * same full disk. Naming it would be a refusal teaching a remedy that does not
 * work — the exact defect the `session_open` advice two functions away exists to
 * fix. T-S4 asserts the substring `without --delete` is ABSENT; M-S3 adds it.
 *
 * Line 1 states the state of the world TWICE, and they are genuinely different
 * facts: `rollbackTemplateSlug` runs find → retract → find-new-latest under ONE
 * lock hold, so an operator seeing a mid-verb failure must learn both that no
 * files were deleted AND that the slug registration did not move either.
 */
function printTemplateRollbackAuditFailure(
  slug: string,
  error: DeletionManifestWriteError,
  format: OutputFormat,
): void {
  const cause = describeManifestFailure(error.cause);
  if (
    emitJsonResult(format, {
      action: "template_rollback_failed",
      reason: "audit_write_failed",
      slug,
      manifestPath: error.manifestPath,
      cause,
    })
  ) {
    return;
  }
  process.stderr.write(
    `acpx sessions templates rollback: could not record this deletion — nothing was deleted, and template '${slug}' is unchanged.\n` +
      `rollback --delete writes one line to ${error.manifestPath} before it removes\n` +
      `anything, so a deletion that cannot be recorded does not happen.\n` +
      `  cause: ${cause}\n` +
      `Free space on that filesystem, then re-run — the slug is untouched, so nothing needs undoing first.\n`,
  );
}

function formatRollbackTarget(target: {
  acpxRecordId: string;
  version: number | undefined;
}): string {
  return `${target.acpxRecordId} (version ${target.version ?? "?"})`;
}

function printTemplateRollbackResult(result: TemplateRollbackResult, format: OutputFormat): void {
  if (emitJsonResult(format, { action: "template_rollback", ...result })) {
    return;
  }
  if (result.outcome === "noop" || !result.retracted) {
    process.stdout.write(`template ${result.slug}: no enabled version to roll back\n`);
    return;
  }
  const verb = result.outcome === "delete" ? "deleted" : "retracted";
  const tail = result.newLatest
    ? `; new latest ${formatRollbackTarget(result.newLatest)}`
    : "; slug now empty";
  process.stdout.write(
    `template ${result.slug}: ${verb} ${formatRollbackTarget(result.retracted)}${tail}\n`,
  );
}

// `acpx <agent> sessions templates migrate-slugs [--dry-run]` — idempotent
// backfill of slug+version on existing templates (global, D2).
export async function handleSessionsTemplatesMigrateSlugs(
  flags: { dryRun?: boolean },
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const result = await migrateTemplateSlugs({ dryRun: flags.dryRun });
  printMigrateSlugsResult(result, globalFlags.format);
}

function printMigrateSlugsResult(result: MigrateSlugsResult, format: OutputFormat): void {
  if (emitJsonResult(format, { action: "template_slugs_migrated", ...result })) {
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${result.assigned}\n`);
    return;
  }
  const prefix = result.dryRun ? "would assign" : "assigned";
  process.stdout.write(
    `${prefix} ${result.assigned} template slugs (scanned ${result.scanned}, skipped ${result.skipped}, slug-less ${result.degenerate}, failed ${result.failed})\n`,
  );
  for (const assignment of result.assignments) {
    process.stdout.write(
      `  ${assignment.acpxRecordId} → ${assignment.slug} v${assignment.version}\n`,
    );
  }
}

/** Thrown from `onBeforeDelete` to abort a prune between record loading and the
 *  first unlink. It carries the refusal so the handler can render it — the throw
 *  is what makes the all-or-nothing id contract (§3.4) enforceable at all: by the
 *  time `pruneSessions` returns, the deletion has already happened. */
class PruneAborted extends Error {
  constructor(readonly refusal: PruneRefusal) {
    super("prune aborted before deleting anything");
    this.name = "PruneAborted";
  }
}

/**
 * `sessions prune` is the CLI's only destructive BULK verb, and until this guard
 * it was the only destructive verb that did not make you name its target: bare
 * `prune` selected every closed session on the box for the agent. On 2026-07-24 a
 * lane meaning to delete the 4 sessions it had just created destroyed 7 and never
 * learned which 3 others died (brick://dd4cb0e8, RCA brick://29eaff14).
 *
 * The scope REQUIREMENT lives here, at the CLI, while the scope FILTERS live in
 * the core. That split is deliberate and load-bearing: "you must state what you
 * mean" is an affordance about how intent is expressed, whereas a programmatic
 * caller writing `pruneSessions({agentCommand})` has already stated box-wide
 * scope unambiguously in code. Keeping it here is also why every existing core
 * prune test stays green unmodified.
 */
export async function handleSessionsPrune(
  explicitAgentName: string | undefined,
  ids: string[],
  flags: SessionsPruneFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [session, render] = await Promise.all([loadSessionModule(), loadOutputRenderModule()]);
  const identity = { agentCommand: agent.agentCommand, agentName: agent.agentName };

  const refusal = await resolvePruneRefusal(session, ids, flags, agent);
  if (refusal) {
    render.printPruneRefusalByFormat(refusal.refusal, globalFlags.format);
    process.exitCode = refusal.code;
    return;
  }

  const scope = buildPruneScope(ids, flags, agent.cwd);

  let result: Awaited<ReturnType<typeof session.pruneSessions>>;
  try {
    result = await session.pruneSessions({
      ...identity,
      before: flags.before,
      olderThanMs: flags.olderThan != null ? flags.olderThan * 24 * 60 * 60 * 1000 : undefined,
      // ⚠️ `!== false`, NEVER `=== true`. An ABSENT flag must mean "delete the
      // history", not "strand it". The default flipped here at the CLI rather
      // than in the core deliberately: `PruneOptions.includeHistory` keeps its
      // exact meaning, so every existing core test stays green unmodified and a
      // programmatic caller is unaffected — and "what should the verb's user get
      // by default" is a policy question, which is the CLI's to answer.
      //
      // The flag that LOOKS conservative is the one that strands: without it a
      // prune deleted ~17% of a session's bytes and permanently orphaned the
      // other 82%, because prune selects off the record index and the record is
      // gone. Measured on devbox: 1,355 record-less ids own 2,157 stream files,
      // 3.65 GB, that nothing can ever reclaim.
      includeHistory: flags.includeHistory !== false,
      auditScope: scope,
      includeTemplates: flags.includeTemplates,
      dryRun: flags.dryRun,
      sessionIds: scope.sessionIds,
      cwd: scope.cwd,
      onBeforeDelete: (plan) => {
        // The contract check runs here, not after pruneSessions returns, because
        // by then the files are gone. It also catches what the index-based
        // pre-resolution above cannot see: an id whose record file is missing,
        // whose record is a protected blueprint, or which the age filter
        // excluded — each of those leaves the id absent from plan.records.
        const unmatched = ids.find(
          (id) => !plan.records.some((record) => matchesPruneSessionId(record, id)),
        );
        if (unmatched != null) {
          throw new PruneAborted({
            reason: "session_not_found",
            agentName: agent.agentName,
            sessionId: unmatched,
          });
        }
        // Suppressed on a dry run — `[DRY RUN] Would prune N sessions` already
        // leads there. The CONTRACT check above is not suppressed: a preview that
        // does not fail where the real run fails is worse than no preview.
        if (!plan.dryRun) {
          render.printPrunePlan(
            {
              count: plan.records.length,
              agentName: agent.agentName,
              scope,
              strandedStreamFiles: plan.strandedStreamFiles,
              strandedStreamBytes: plan.strandedStreamBytes,
              includeHistory: flags.includeHistory !== false,
            },
            globalFlags.format,
          );
        }
      },
    });
  } catch (error) {
    if (error instanceof PruneAborted) {
      render.printPruneRefusalByFormat(error.refusal, globalFlags.format);
      process.exitCode = EXIT_CODES.ERROR;
      return;
    }
    // ⚠️ THIS TYPE ONLY, and everything else is re-thrown. A bare `catch` here
    // would swallow an unrelated failure on a destructive path and tell the
    // operator to free disk space when the real fault was something else —
    // reporting a failure as something it is not. Same discipline as
    // PruneAborted above. M-S5 injects a different error at the same seam and
    // asserts it is re-thrown.
    if (error instanceof DeletionManifestWriteError) {
      render.printPruneRefusalByFormat(
        {
          reason: "audit_write_failed",
          agentName: agent.agentName,
          manifestPath: error.manifestPath,
          cause: describeManifestFailure(error.cause),
        },
        globalFlags.format,
      );
      // ERROR (1), not USAGE (2): a runtime failure, not a malformed command —
      // the same family as session_not_found.
      process.exitCode = EXIT_CODES.ERROR;
      return;
    }
    throw error;
  }

  render.printPruneResultByFormat(result, globalFlags.format, scope);
}

/**
 * `--older-than` / `--before` COUNT AS A SCOPE. They are an affirmative
 * statement of what to delete and they are the only documented usage of this
 * verb, so refusing them would break the one legitimate documented workflow for
 * zero safety gain — the incident involved no age filter. They are a weak scope
 * (on a real box `--older-than 30` still selects thousands), which is what the
 * pre-flight line exists to surface.
 */
function isPruneScopeStated(ids: string[], flags: SessionsPruneFlags): boolean {
  return (
    ids.length > 0 ||
    flags.cwd === true ||
    flags.wholeBox === true ||
    flags.olderThan != null ||
    flags.before != null
  );
}

function buildPruneScope(
  ids: string[],
  flags: SessionsPruneFlags,
  invocationCwd: string,
): PruneScope {
  return {
    ...(flags.wholeBox === true ? { wholeBox: true } : {}),
    ...(ids.length > 0 ? { sessionIds: ids } : {}),
    ...(flags.cwd === true ? { cwd: invocationCwd } : {}),
    ...(flags.olderThan != null ? { olderThanDays: flags.olderThan } : {}),
    ...(flags.before ? { before: flags.before.toISOString() } : {}),
  };
}

/** Every refusal that can be decided BEFORE `pruneSessions` is reached, i.e.
 *  before a single record is loaded or a single file unlinked. Returns undefined
 *  to let the prune proceed. */
async function resolvePruneRefusal(
  session: SessionModule,
  ids: string[],
  flags: SessionsPruneFlags,
  agent: { agentCommand: string; agentName: string; cwd: string },
): Promise<{ refusal: PruneRefusal; code: number } | undefined> {
  const identity = { agentCommand: agent.agentCommand, agentName: agent.agentName };

  if (flags.wholeBox === true && (ids.length > 0 || flags.cwd === true)) {
    return {
      refusal: { reason: "scope_conflict", agentName: agent.agentName },
      code: EXIT_CODES.USAGE,
    };
  }

  // --dry-run is deliberately exempt from the scope requirement: it deletes
  // nothing, so gating it buys no safety, it IS the discovery affordance
  // ("what is out there?"), and exempting it means every documented
  // "--dry-run first" workflow keeps working verbatim.
  if (!isPruneScopeStated(ids, flags) && flags.dryRun !== true) {
    const counts = await session.countPruneCandidates({ ...identity, cwd: agent.cwd });
    return {
      refusal: {
        reason: "scope_required",
        agentName: agent.agentName,
        cwd: agent.cwd,
        closedCandidates: counts.total,
        closedCandidatesInCwd: counts.inCwd,
      },
      code: EXIT_CODES.USAGE,
    };
  }

  const unresolvable = await findUnresolvableId(session, ids, identity, agent.agentName);
  return unresolvable ? { refusal: unresolvable, code: EXIT_CODES.ERROR } : undefined;
}

/** Index-based pre-resolution. Its whole reason for existing is the distinction
 *  the prunable-record set cannot draw: "no such session" vs "it is still open,
 *  close it first". Runs before pruneSessions, so nothing is loaded or deleted. */
async function findUnresolvableId(
  session: SessionModule,
  ids: string[],
  identity: { agentCommand: string; agentName: string },
  agentName: string,
): Promise<PruneRefusal | undefined> {
  if (ids.length === 0) {
    return undefined;
  }
  const resolutions = await session.resolvePruneSessionIds(ids, identity);
  for (const resolution of resolutions) {
    if (resolution.closedMatches.length > 1) {
      return {
        reason: "session_ambiguous",
        agentName,
        sessionId: resolution.id,
        matches: resolution.closedMatches,
      };
    }
    if (resolution.closedMatches.length === 0) {
      return resolution.openMatches > 0
        ? { reason: "session_open", agentName, sessionId: resolution.id }
        : { reason: "session_not_found", agentName, sessionId: resolution.id };
    }
  }
  return undefined;
}

// Force-restart (un-wedge) a session's queue owner. Takes a session id (the same
// id `prompt -s` accepts: acpx record id, ACP session id, or unique suffix). The
// agent prefix is incidental — recovery is purely id-scoped. Exit 0 once the owner
// pid is confirmed gone (including the idempotent "already gone" case); a non-zero
// exit only when a live owner genuinely survived the kill.
export async function handleSessionsRecover(
  _explicitAgentName: string | undefined,
  sessionId: string,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const { recoverSession } = await loadSessionModule();

  const result = await recoverSession(sessionId);

  if (!emitJsonResult(globalFlags.format, result)) {
    const target = result.pid != null ? `owner pid ${result.pid}` : "owner";
    const summary = !result.ownerFound
      ? "no queue owner found (already gone)"
      : result.killed
        ? `killed ${target} and its process group`
        : result.alive
          ? `FAILED to kill ${target} (still alive)`
          : `${target} already gone; cleared stale lease`;
    process.stdout.write(`recover ${result.sessionId}: ${summary}\n`);
  }

  if (result.alive) {
    throw new Error(
      `Failed to recover session ${result.sessionId}: queue owner pid ${result.pid} is still alive after kill`,
    );
  }
}

// Read-only owner-state probe so acpx-ui/heartbeat callers can consume the CLI
// source of truth without duplicating lease-key hashing or PID semantics.
export async function handleSessionsOwnerStatus(
  sessionId: string | undefined,
  flags: SessionsOwnerStatusFlags,
): Promise<void> {
  const {
    readAllSessionOwnerStatuses,
    readDescendantSessionOwnerStatuses,
    readSessionOwnerStatus,
  } = await loadSessionModule();
  const hasDescendantScope = flags.descendantsOf !== undefined;
  if (flags.all === true) {
    if (sessionId || hasDescendantScope) {
      throw new InvalidArgumentError(
        "owner-status accepts exactly one of <id>, --all, or --descendants-of",
      );
    }
    const batch = await readAllSessionOwnerStatuses();
    process.stdout.write(`${JSON.stringify(batch)}\n`);
    return;
  }

  if (hasDescendantScope) {
    if (sessionId) {
      throw new InvalidArgumentError(
        "owner-status accepts exactly one of <id>, --all, or --descendants-of",
      );
    }
    const batch = await readDescendantSessionOwnerStatuses(flags.descendantsOf as string);
    process.stdout.write(`${JSON.stringify(batch)}\n`);
    return;
  }

  if (!sessionId) {
    throw new InvalidArgumentError("owner-status requires <id>, --all, or --descendants-of <id>");
  }

  const status = await readSessionOwnerStatus(sessionId);
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

export { parseHistoryLimit, NoSessionError, loadSessionModule };
