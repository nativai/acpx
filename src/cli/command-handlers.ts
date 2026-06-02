import fs from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { isLegacyZedCodexAcpInvocation } from "../acp/codex-compat.js";
import { listBuiltInAgents, resolveAgentCommand } from "../agent-registry.js";
import { AgentSpawnError, SessionNotFoundError } from "../errors.js";
import { loadPermissionPolicySpec } from "../permission-policy.js";
import {
  mergePromptSourceWithText,
  parsePromptSource,
  PromptInputValidationError,
  textPrompt,
} from "../prompt-content.js";
import { exportSession } from "../session/export.js";
import { importSession } from "../session/import.js";
import {
  findGitRepositoryRoot,
  findSession,
  findSessionByDirectoryWalk,
  listSessions,
  normalizeName,
  resolveSessionRecord,
  writeSessionRecord,
} from "../session/persistence.js";
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
  parseHistoryLimit,
  resolveAgentInvocation,
  resolveGlobalFlags,
  resolveOutputPolicy,
  resolvePermissionMode,
  resolveSessionNameFromFlags,
  type ExecFlags,
  type GlobalFlags,
  type SessionsExportFlags,
  type PromptFlags,
  type SessionsImportFlags,
  type SessionsHistoryFlags,
  type SessionsListFlags,
  type SessionsNewFlags,
  type SessionsPruneFlags,
  type StatusFlags,
} from "./flags.js";
import { emitJsonResult } from "./output/json-output.js";
import type { SessionListResult } from "./session/contracts.js";
import { withInheritedTaskFolder } from "./session/inherited-metadata.js";
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

function resolveCompatibleConfigId(agent: { agentCommand: string }, configId: string): string {
  if (isLegacyZedCodexAcpInvocation(agent.agentCommand) && configId === "thought_level") {
    return "reasoning_effort";
  }
  return configId;
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
  return {
    model: globalFlags.model,
    allowedTools: globalFlags.allowedTools,
    maxTurns: globalFlags.maxTurns,
    systemPrompt: globalFlags.systemPrompt,
  };
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

// Parse the UUID from an acpx-ui session URL (...?session=<uuid>).
// Returns undefined for missing / malformed input or empty session value.
function parseSessionIdFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    const sessionId = parsed.searchParams.get("session")?.trim();
    return sessionId && sessionId.length > 0 ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

function resolveParentSessionIdFromFlagOrEnv(flags: SessionsNewFlags): string | undefined {
  // --parent-session-url <url> wins over --parent-id <uuid>; both override env.
  const flagUrlValue = parseSessionIdFromUrl(flags.parentSessionUrl);
  if (flagUrlValue) {
    return flagUrlValue;
  }
  const flagValue = flags.parentId?.trim();
  if (flagValue && flagValue.length > 0) {
    return flagValue;
  }
  // Env fallback: the URL is the agent's identity, parse the UUID out.
  const envFromUrl = parseSessionIdFromUrl(process.env.ACPX_SESSION_URL);
  if (envFromUrl) {
    return envFromUrl;
  }
  return undefined;
}

type ResolvedParentSession = { acpxRecordId: string; taskFolder?: string };

async function resolveAndValidateParentSessionId(
  flags: SessionsNewFlags,
): Promise<ResolvedParentSession | undefined> {
  const candidate = resolveParentSessionIdFromFlagOrEnv(flags);
  if (!candidate) {
    return undefined;
  }
  try {
    const parent = await resolveSessionRecord(candidate);
    return { acpxRecordId: parent.acpxRecordId, taskFolder: parent.metadata?.task_folder };
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      const label = flags.parentSessionUrl ? "--parent-session-url" : "--parent-id";
      throw new InvalidArgumentError(`${label} refers to unknown session: ${candidate}`);
    }
    throw error;
  }
}

function buildSessionStartOptions(params: {
  agent: ResolvedAgentInvocation;
  flags: SessionsNewFlags;
  globalFlags: GlobalFlags;
  config: ResolvedAcpxConfig;
  permissionMode: ReturnType<typeof resolvePermissionMode>;
  permissionPolicy?: PermissionPolicy;
  parentSessionId?: string;
  parentTaskFolder?: string;
}): Parameters<SessionModule["createSession"]>[0] {
  return {
    agentCommand: params.agent.agentCommand,
    cwd: params.agent.cwd,
    name: params.flags.name,
    resumeSessionId: params.flags.resumeSession,
    parentSessionId: params.parentSessionId,
    metadata: withInheritedTaskFolder(params.flags.metadata, params.parentTaskFolder),
    mcpServers: params.config.mcpServers,
    permissionMode: params.permissionMode,
    nonInteractivePermissions: params.globalFlags.nonInteractivePermissions,
    permissionPolicy: params.permissionPolicy,
    authCredentials: params.config.auth,
    authPolicy: params.globalFlags.authPolicy,
    terminal: params.globalFlags.terminal,
    timeoutMs: params.globalFlags.timeout,
    verbose: params.globalFlags.verbose,
    sessionOptions: sessionOptionsFromGlobalFlags(params.globalFlags),
  };
}

function resolveSessionListFilterCwd(
  flags: Pick<SessionsListFlags, "filterCwd">,
  agentCwd: string,
): string | undefined {
  return flags.filterCwd ? path.resolve(agentCwd, flags.filterCwd) : undefined;
}

async function printLocalSessionsList(
  agentCommand: string,
  filterCwd: string | undefined,
  format: OutputFormat,
): Promise<void> {
  const [{ listSessionsForAgent }, { printSessionsByFormat }] = await Promise.all([
    loadSessionModule(),
    loadOutputRenderModule(),
  ]);
  const sessions = await listSessionsForAgent(agentCommand);
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
    cwd: agent.cwd,
    name: sessionName,
    includeClosed: true,
  });

  if (defaultScopedRecord) {
    return defaultScopedRecord;
  }

  const normalizedName = normalizeName(sessionName);
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
    cwd,
    name: sessionName,
    boundary: walkBoundary,
  });

  if (record) {
    return record;
  }

  const createCmd = sessionName
    ? `acpx ${agentName} sessions new --name ${sessionName}`
    : `acpx ${agentName} sessions new`;
  throw new NoSessionError(
    `⚠ No acpx session found (searched up to ${walkBoundary}).\nCreate one: ${createCmd}`,
  );
}

export async function handlePrompt(
  explicitAgentName: string | undefined,
  promptParts: string[],
  flags: PromptFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const outputPolicy = resolveRequestedOutputPolicy(globalFlags);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);
  const prompt = await readPrompt(promptParts, flags.file, globalFlags.cwd);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [
    { createOutputFormatter },
    { printPromptSessionBanner, printQueuedPromptByFormat },
    { sendSession },
  ] = await Promise.all([loadOutputModule(), loadOutputRenderModule(), loadSessionModule()]);
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    flags.session,
  );
  const outputFormatter = createOutputFormatter(outputPolicy.format, {
    jsonContext: {
      sessionId: record.acpxRecordId,
    },
    suppressReads: outputPolicy.suppressReads,
  });

  await printPromptSessionBanner(record, agent.cwd, outputPolicy.format, outputPolicy.jsonStrict);
  const result = await sendSession({
    sessionId: record.acpxRecordId,
    prompt,
    mcpServers: config.mcpServers,
    permissionMode,
    nonInteractivePermissions: globalFlags.nonInteractivePermissions,
    permissionPolicy,
    authCredentials: config.auth,
    authPolicy: globalFlags.authPolicy,
    terminal: globalFlags.terminal,
    outputFormatter,
    errorEmissionPolicy: {
      queueErrorAlreadyEmitted: outputPolicy.queueErrorAlreadyEmitted,
    },
    suppressSdkConsoleErrors: outputPolicy.suppressSdkConsoleErrors,
    timeoutMs: globalFlags.timeout,
    ttlMs: globalFlags.ttl,
    keepWarmTtlMs: globalFlags.ttlExplicitMs,
    maxQueueDepth: config.queueMaxDepth,
    promptRetries: globalFlags.promptRetries,
    verbose: globalFlags.verbose,
    waitForCompletion: flags.wait !== false,
    sessionOptions: {
      model: globalFlags.model,
      allowedTools: globalFlags.allowedTools,
      maxTurns: globalFlags.maxTurns,
      systemPrompt: globalFlags.systemPrompt,
    },
  });

  if ("queued" in result) {
    printQueuedPromptByFormat(result, outputPolicy.format);
    return;
  }

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
  if (config.disableExec) {
    const globalFlags = resolveGlobalFlags(command, config);
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

  const globalFlags = resolveGlobalFlags(command, config);
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

  const result = await runOnce({
    agentCommand: agent.agentCommand,
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
    sessionOptions: {
      model: globalFlags.model,
      allowedTools: globalFlags.allowedTools,
      maxTurns: globalFlags.maxTurns,
      systemPrompt: globalFlags.systemPrompt,
    },
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
  result: { record: SessionRecord; resumed: boolean },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "model_set",
      modelId,
      resumed: result.resumed,
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
  },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "config_set",
      configId,
      value,
      resumed: result.resumed,
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
  const gitRoot = findGitRepositoryRoot(agent.cwd);
  const walkBoundary = gitRoot ?? agent.cwd;
  const record = await findSessionByDirectoryWalk({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: resolveSessionNameFromFlags(flags, command),
    boundary: walkBoundary,
  });

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
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    resolveSessionNameFromFlags(flags, command),
  );
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
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    resolveSessionNameFromFlags(flags, command),
  );
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
  });

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(
      `[acpx] session reconnect failed, started fresh session: ${result.loadError}\n`,
    );
  }

  printSetModelResultByFormat(modelId, result, globalFlags.format);
}

export async function handleSetConfigOption(
  explicitAgentName: string | undefined,
  configId: string,
  value: string,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  if (configId === "model") {
    await handleSetModel(explicitAgentName, value, flags, command, config);
    return;
  }
  const resolvedConfigId = resolveCompatibleConfigId(agent, configId);
  const { setSessionConfigOption } = await loadSessionModule();
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    resolveSessionNameFromFlags(flags, command),
  );
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
  });

  if (globalFlags.verbose && result.loadError) {
    process.stderr.write(
      `[acpx] session reconnect failed, started fresh session: ${result.loadError}\n`,
    );
  }

  printSetConfigOptionResultByFormat(configId, value, result, globalFlags.format);
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
// cwd-scoped session, merge the key into a freshly-read record, and persist it.
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
  const record = await findRoutedSessionOrThrow(
    agent.agentCommand,
    agent.agentName,
    agent.cwd,
    resolveSessionNameFromFlags(flags, command),
  );
  if (key === "task_folder") {
    await warnIfTaskFolderMissing(trimmedValue);
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
    await printLocalSessionsList(agent.agentCommand, filterCwd, globalFlags.format);
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
    await printLocalSessionsList(agent.agentCommand, undefined, globalFlags.format);
    return;
  }

  printAgentSessionsByFormat(result, globalFlags.format);
}

export async function handleSessionsClose(
  explicitAgentName: string | undefined,
  sessionName: string | undefined,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [{ closeSession }, { printClosedSessionByFormat }] = await Promise.all([
    loadSessionModule(),
    loadOutputRenderModule(),
  ]);

  const record = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: sessionName,
  });

  if (!record) {
    throw new Error(missingScopedSessionMessage(agent, sessionName));
  }

  const closed = await closeSession(record.acpxRecordId);
  printClosedSessionByFormat(closed, globalFlags.format);
}

export async function handleSessionsNew(
  explicitAgentName: string | undefined,
  flags: SessionsNewFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);
  const parent = await resolveAndValidateParentSessionId(flags);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [{ createSession, closeSession }, { printCreatedSessionBanner, printNewSessionByFormat }] =
    await Promise.all([loadSessionModule(), loadOutputRenderModule()]);

  const replaced = await findSession({
    agentCommand: agent.agentCommand,
    cwd: agent.cwd,
    name: flags.name,
  });

  if (replaced) {
    await closeSession(replaced.acpxRecordId);
    if (globalFlags.verbose) {
      process.stderr.write(`[acpx] soft-closed prior session: ${replaced.acpxRecordId}\n`);
    }
  }

  const created = await createSession(
    buildSessionStartOptions({
      agent,
      flags,
      globalFlags,
      config,
      permissionMode,
      permissionPolicy,
      parentSessionId: parent?.acpxRecordId,
      parentTaskFolder: parent?.taskFolder,
    }),
  );

  printCreatedSessionBanner(created, agent.agentName, globalFlags.format, globalFlags.jsonStrict);

  if (globalFlags.verbose) {
    const scope = flags.name ? `named session "${flags.name}"` : "cwd session";
    process.stderr.write(`[acpx] created ${scope}: ${created.acpxRecordId}\n`);
  }

  printNewSessionByFormat(created, replaced, globalFlags.format);
}

export async function handleSessionsEnsure(
  explicitAgentName: string | undefined,
  flags: SessionsNewFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const permissionMode = resolvePermissionMode(globalFlags, config.defaultPermissions);
  const permissionPolicy = await resolvePermissionPolicyFromFlags(globalFlags);
  const parent = await resolveAndValidateParentSessionId(flags);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [{ ensureSession }, { printCreatedSessionBanner, printEnsuredSessionByFormat }] =
    await Promise.all([loadSessionModule(), loadOutputRenderModule()]);
  const result = await ensureSession(
    buildSessionStartOptions({
      agent,
      flags,
      globalFlags,
      config,
      permissionMode,
      permissionPolicy,
      parentSessionId: parent?.acpxRecordId,
      parentTaskFolder: parent?.taskFolder,
    }),
  );

  if (result.created) {
    printCreatedSessionBanner(
      result.record,
      agent.agentName,
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
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const record =
    explicitAgentName == null
      ? await findGenericReadableSessionOrThrow(agent, sessionName, "show", config)
      : await findScopedSessionOrThrow(agent, sessionName);

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
  const record =
    explicitAgentName == null
      ? await findGenericReadableSessionOrThrow(agent, sessionName, subcommand, config)
      : await findScopedSessionOrThrow(agent, sessionName);

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

  await exportSession(
    {
      agentName: globalFlags.agent ? undefined : agent.agentName,
      agentCommand: agent.agentCommand,
      cwd,
      name: sessionName,
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

export async function handleSessionsPrune(
  explicitAgentName: string | undefined,
  flags: SessionsPruneFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const [{ pruneSessions }, { printPruneResultByFormat }] = await Promise.all([
    loadSessionModule(),
    loadOutputRenderModule(),
  ]);

  const olderThanMs = flags.olderThan != null ? flags.olderThan * 24 * 60 * 60 * 1000 : undefined;

  const result = await pruneSessions({
    agentCommand: agent.agentCommand,
    before: flags.before,
    olderThanMs,
    includeHistory: flags.includeHistory,
    dryRun: flags.dryRun,
  });

  printPruneResultByFormat(result, globalFlags.format);
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

// Read-only owner-liveness probe — emits {sessionId,ownerFound,pid,alive,stale,
// heartbeatAt} as JSON so the acpx-ui server can read owner liveness without
// replicating the lease-key hashing. Never mutates the lease.
export async function handleSessionsOwnerStatus(sessionId: string): Promise<void> {
  const { readSessionOwnerStatus } = await loadSessionModule();
  const status = await readSessionOwnerStatus(sessionId);
  process.stdout.write(`${JSON.stringify(status)}\n`);
}

export { parseHistoryLimit, NoSessionError, loadSessionModule };
