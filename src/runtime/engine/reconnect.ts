import type { AcpClient } from "../../acp/client.js";
import {
  extractAcpError,
  formatErrorMessage,
  isAcpQueryClosedBeforeResponseError,
  isAcpResourceNotFoundError,
} from "../../acp/error-normalization.js";
import { assertRequestedModelSupported } from "../../acp/model-support.js";
import { InterruptedError, TimeoutError, withTimeout } from "../../async-control.js";
import { findProfile, loadProfileRegistry, transcriptAnchorDir } from "../../config/profiles.js";
import {
  ensureTranscriptAtConfigDir,
  ensureTranscriptAtActiveConfigDir,
  type TranscriptRecoveryResult,
} from "../../config/subscription-transcript.js";
import {
  SessionConfigOptionReplayError,
  SessionModeReplayError,
  SessionModelReplayError,
  SessionResumeRequiredError,
} from "../../errors.js";
import { incrementPerfCounter } from "../../perf-metrics.js";
import { normalizeEffortLevelForModel } from "../../session/config-option-application.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import {
  getDesiredConfigOptions,
  getDesiredModeId,
  getDesiredModelId,
  setDesiredConfigOption,
  setCurrentModelId,
  syncAdvertisedModelState,
} from "../../session/mode-preference.js";
import type { SessionRecord, SessionResumePolicy } from "../../types.js";
import {
  applyLifecycleSnapshotToRecord,
  reconcileAgentSessionId,
  sessionHasAgentMessages,
} from "./lifecycle.js";

export type ConnectedSessionController = {
  hasActivePrompt: () => boolean;
  requestCancelActivePrompt: () => Promise<boolean>;
  setSessionMode: (modeId: string) => Promise<void>;
  setSessionModel: (modelId: string) => Promise<void>;
  setSessionConfigOption: (
    configId: string,
    value: string,
  ) => ReturnType<AcpClient["setSessionConfigOption"]>;
};

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ConnectAndLoadSessionOptions = {
  client: AcpClient;
  record: SessionRecord;
  resumePolicy?: SessionResumePolicy;
  timeoutMs?: number;
  verbose?: boolean;
  activeController: ConnectedSessionController;
  onClientAvailable?: (controller: ConnectedSessionController) => void;
  onConnectedRecord?: (record: SessionRecord) => void;
  onSessionIdResolved?: (sessionId: string) => void;
};

export type ConnectAndLoadSessionResult = {
  sessionId: string;
  agentSessionId?: string;
  resumed: boolean;
  loadError?: string;
};

const SESSION_LOAD_UNSUPPORTED_CODES = new Set([-32601, -32602]);

// Structured session/load rejection schema published by the independent-claude-acp
// bridge on the error's data payload (e.g. code -32000, reason "transcript-gone"
// for a session that never ran a turn). Recognized as fallback-safe ONLY for
// records with zero agent messages (see shouldFallbackToNewSession): a
// never-prompted session has nothing to lose, so recovering through a fresh
// session/new matches what create would have done — without this, a freshly
// created session whose owner idle-released before its first prompt is
// permanently unpromptable (UIC-4 verification F1). A rejection AFTER real
// turns keeps surfacing loudly — silent continuity loss is forbidden.
const SESSION_LOAD_REJECTION_SCHEMA = "independent-claude-acp/load-session/v1";

function shouldFallbackToNewSession(error: unknown, record: SessionRecord): boolean {
  if (isHardReconnectFailure(error)) {
    return false;
  }
  const acp = extractAcpError(error);
  if (isAcpResourceNotFoundError(error) || isUnsupportedSessionLoadAcpError(acp)) {
    return !sessionHasAgentMessages(record);
  }

  return !sessionHasAgentMessages(record) && isFallbackSafeEmptySessionError(error, acp);
}

function isHardReconnectFailure(error: unknown): boolean {
  return error instanceof TimeoutError || error instanceof InterruptedError;
}

function isUnsupportedSessionLoadAcpError(acp: ReturnType<typeof extractAcpError>): boolean {
  return !!acp && SESSION_LOAD_UNSUPPORTED_CODES.has(acp.code);
}

function isStructuredSessionLoadRejection(acp: ReturnType<typeof extractAcpError>): boolean {
  const data = acp?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  return (data as Record<string, unknown>).schema === SESSION_LOAD_REJECTION_SCHEMA;
}

function isFallbackSafeEmptySessionError(
  error: unknown,
  acp: ReturnType<typeof extractAcpError>,
): boolean {
  return (
    isAcpQueryClosedBeforeResponseError(error) ||
    acp?.code === -32603 ||
    isStructuredSessionLoadRejection(acp)
  );
}

function requiresSameSession(resumePolicy: SessionResumePolicy | undefined): boolean {
  return resumePolicy === "same-session-only";
}

function makeSessionResumeRequiredError(params: {
  record: SessionRecord;
  reason: string;
  cause?: unknown;
}): SessionResumeRequiredError {
  return new SessionResumeRequiredError(
    `Persistent ACP session ${params.record.acpSessionId} could not be resumed: ${params.reason}`,
    {
      cause: params.cause instanceof Error ? params.cause : undefined,
    },
  );
}

async function replayDesiredMode(params: {
  client: AcpClient;
  sessionId: string;
  desiredModeId: string | undefined;
  previousSessionId: string;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  if (!params.desiredModeId) {
    return;
  }

  try {
    await withTimeout(
      params.client.setSessionMode(params.sessionId, params.desiredModeId),
      params.timeoutMs,
    );
    if (params.verbose) {
      process.stderr.write(
        `[acpx] replayed desired mode ${params.desiredModeId} on fresh ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`,
      );
    }
  } catch (error) {
    throw new SessionModeReplayError(
      `Failed to replay saved session mode ${params.desiredModeId} on fresh ACP session ${params.sessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error instanceof Error ? error : undefined,
        retryable: true,
      },
    );
  }
}

async function replayDesiredModel(params: {
  client: AcpClient;
  sessionId: string;
  desiredModelId: string | undefined;
  previousSessionId: string;
  record: SessionRecord;
  models: import("../../acp/client.js").SessionLoadResult["models"] | undefined;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  if (!params.desiredModelId) {
    return;
  }

  try {
    assertRequestedModelSupported({
      requestedModel: params.desiredModelId,
      models: params.models,
      agentCommand: params.record.agentCommand,
      context: "replay",
    });
    if (!params.models || params.models.currentModelId === params.desiredModelId) {
      return;
    }
    await withTimeout(
      params.client.setSessionModel(params.sessionId, params.desiredModelId),
      params.timeoutMs,
    );
    if (params.verbose) {
      process.stderr.write(
        `[acpx] replayed desired model ${params.desiredModelId} on fresh ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`,
      );
    }
  } catch (error) {
    throw new SessionModelReplayError(
      `Failed to replay saved session model ${params.desiredModelId} on fresh ACP session ${params.sessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error instanceof Error ? error : undefined,
        retryable: true,
      },
    );
  }
}

async function replayDesiredConfigOptions(params: {
  client: AcpClient;
  sessionId: string;
  desiredConfigOptions: Record<string, string>;
  desiredModelId?: string;
  previousSessionId: string;
  record: SessionRecord;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  const normalizedDesiredConfigOptions: Array<[configId: string, value: string]> = [];
  for (const [configId, value] of Object.entries(params.desiredConfigOptions)) {
    const replayValue = replayConfigOptionValue(configId, value, params.desiredModelId);
    try {
      await withTimeout(
        params.client.setSessionConfigOption(params.sessionId, configId, replayValue),
        params.timeoutMs,
      );
      if (replayValue !== value) {
        normalizedDesiredConfigOptions.push([configId, replayValue]);
      }
      if (params.verbose) {
        process.stderr.write(
          `[acpx] replayed desired config option ${configId} on fresh ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`,
        );
      }
    } catch (error) {
      // A returning call means a non-fatal effort rejection — proceed with the
      // turn; any other failure rethrows. See handleConfigOptionReplayError.
      handleConfigOptionReplayError({
        configId,
        error,
        sessionId: params.sessionId,
        verbose: params.verbose,
      });
    }
  }
  for (const [configId, value] of normalizedDesiredConfigOptions) {
    setDesiredConfigOption(params.record, configId, value);
  }
}

// Decide how a config-option replay failure is handled. Effort is a best-effort
// preference, never a turn-blocker: some models (e.g. haiku) advertise an
// `effort` option at session/new yet have the adapter REJECT mutating it
// (`Unknown config option: effort`), so a persisted/inherited effort cannot be
// replayed onto the fresh ACP session. The creation path already absorbs this via
// setConfigOptionWithEffortFallback ("layer on top, never break"); mirror it here
// so replay can't lose the turn. Returns (caller proceeds with the turn) only for
// `effort` AND only when the agent actually returned a rejection (an ACP error
// payload). Transport failures (timeout/interrupt — no ACP payload) and every
// other config option rethrow fatally/retryably exactly as before.
function handleConfigOptionReplayError(params: {
  configId: string;
  error: unknown;
  sessionId: string;
  verbose?: boolean;
}): void {
  if (params.configId === "effort" && extractAcpError(params.error)) {
    if (params.verbose) {
      process.stderr.write(
        `[acpx] effort replay rejected by the agent on fresh ACP session ${params.sessionId} (${formatErrorMessage(params.error)}); continuing without it\n`,
      );
    }
    return;
  }
  throw new SessionConfigOptionReplayError(
    `Failed to replay saved session config option ${params.configId} on fresh ACP session ${params.sessionId}: ${formatErrorMessage(params.error)}`,
    {
      cause: params.error instanceof Error ? params.error : undefined,
      retryable: true,
    },
  );
}

function replayConfigOptionValue(
  configId: string,
  value: string,
  modelId: string | undefined,
): string {
  if (configId !== "effort") {
    return value;
  }
  return normalizeEffortLevelForModel(value, modelId) ?? value;
}

function restoreOriginalSessionState(params: {
  record: SessionRecord;
  sessionId: string;
  agentSessionId: string | undefined;
}): void {
  params.record.acpSessionId = params.sessionId;
  params.record.agentSessionId = params.agentSessionId;
}

export async function connectAndLoadSession(
  options: ConnectAndLoadSessionOptions,
): Promise<ConnectAndLoadSessionResult> {
  const record = options.record;
  const client = options.client;
  const sameSessionOnly = requiresSameSession(options.resumePolicy) || Boolean(record.importedFrom);
  const originalSessionId = record.acpSessionId;
  const originalAgentSessionId = record.agentSessionId;
  const desiredModeId = getDesiredModeId(record.acpx);
  const desiredModelId = getDesiredModelId(record.acpx);
  const desiredConfigOptions = getDesiredConfigOptions(record.acpx);
  const storedProcessAlive = isProcessAlive(record.pid);
  const shouldReconnect = Boolean(record.pid) && !storedProcessAlive;

  logReconnectAttempt(record, storedProcessAlive, shouldReconnect, options.verbose);

  const reusingLoadedSession = client.hasReusableSession(record.acpSessionId);
  if (reusingLoadedSession) {
    incrementPerfCounter("runtime.connect_and_load.reused_session");
  } else {
    await withTimeout(client.start(), options.timeoutMs);
  }
  options.onClientAvailable?.(options.activeController);
  applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
  record.closed = false;
  record.closedAt = undefined;
  options.onConnectedRecord?.(record);
  await ensurePendingSwitchTranscript(record, options.verbose);

  let resumed = false;
  let loadError: string | undefined;
  let sessionId = record.acpSessionId;
  let createdFreshSession = false;
  let pendingAgentSessionId = record.agentSessionId;
  let sessionModels: import("../../acp/client.js").SessionLoadResult["models"];

  const loadState = await loadOrCreateRuntimeSession({
    client,
    record,
    reusingLoadedSession,
    sameSessionOnly,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });
  resumed = loadState.resumed;
  loadError = loadState.loadError;
  sessionId = loadState.sessionId;
  createdFreshSession = loadState.createdFreshSession;
  pendingAgentSessionId = loadState.pendingAgentSessionId;
  sessionModels = loadState.sessionModels;

  await replayFreshSessionPreferences({
    client,
    record,
    createdFreshSession,
    sessionId,
    pendingAgentSessionId,
    originalSessionId,
    originalAgentSessionId,
    desiredModeId,
    desiredModelId,
    desiredConfigOptions,
    sessionModels,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });

  applyReconnectedModelState(record, sessionModels, createdFreshSession, desiredModelId);

  options.onSessionIdResolved?.(sessionId);

  return {
    sessionId,
    agentSessionId: record.agentSessionId,
    resumed,
    loadError,
  };
}

function applyReconnectedModelState(
  record: SessionRecord,
  sessionModels: import("../../acp/client.js").SessionLoadResult["models"],
  createdFreshSession: boolean,
  desiredModelId: string | undefined,
): void {
  syncAdvertisedModelState(record, sessionModels);
  if (createdFreshSession && desiredModelId && sessionModels) {
    setCurrentModelId(record, desiredModelId);
  }
}

function logReconnectAttempt(
  record: SessionRecord,
  storedProcessAlive: boolean,
  shouldReconnect: boolean,
  verbose: boolean | undefined,
): void {
  if (!verbose) {
    return;
  }
  if (storedProcessAlive) {
    process.stderr.write(
      `[acpx] saved session pid ${record.pid} is running; reconnecting to saved ACP session\n`,
    );
    return;
  }
  if (shouldReconnect) {
    process.stderr.write(
      `[acpx] saved session pid ${record.pid} is dead; respawning agent and attempting session reconnect\n`,
    );
  }
}

async function replayFreshSessionPreferences(params: {
  client: AcpClient;
  record: SessionRecord;
  createdFreshSession: boolean;
  sessionId: string;
  pendingAgentSessionId: string | undefined;
  originalSessionId: string;
  originalAgentSessionId: string | undefined;
  desiredModeId: string | undefined;
  desiredModelId: string | undefined;
  desiredConfigOptions: Record<string, string>;
  sessionModels: import("../../acp/client.js").SessionLoadResult["models"];
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<void> {
  if (!params.createdFreshSession) {
    return;
  }

  try {
    await replayDesiredMode({
      client: params.client,
      sessionId: params.sessionId,
      desiredModeId: params.desiredModeId,
      previousSessionId: params.originalSessionId,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
    await replayDesiredModel({
      client: params.client,
      sessionId: params.sessionId,
      desiredModelId: params.desiredModelId,
      previousSessionId: params.originalSessionId,
      record: params.record,
      models: params.sessionModels,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
    await replayDesiredConfigOptions({
      client: params.client,
      sessionId: params.sessionId,
      desiredConfigOptions: params.desiredConfigOptions,
      desiredModelId: params.desiredModelId,
      previousSessionId: params.originalSessionId,
      record: params.record,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
  } catch (error) {
    restoreOriginalSessionState({
      record: params.record,
      sessionId: params.originalSessionId,
      agentSessionId: params.originalAgentSessionId,
    });
    if (params.verbose) {
      process.stderr.write(`[acpx] ${formatErrorMessage(error)}\n`);
    }
    throw error;
  }

  params.record.acpSessionId = params.sessionId;
  reconcileAgentSessionId(params.record, params.pendingAgentSessionId);
}

type RuntimeSessionLoadState = {
  sessionId: string;
  pendingAgentSessionId: string | undefined;
  sessionModels: import("../../acp/client.js").SessionLoadResult["models"];
  resumed: boolean;
  createdFreshSession: boolean;
  loadError?: string;
};

async function loadOrCreateRuntimeSession(params: {
  client: AcpClient;
  record: SessionRecord;
  reusingLoadedSession: boolean;
  sameSessionOnly: boolean;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<RuntimeSessionLoadState> {
  if (params.reusingLoadedSession) {
    return {
      sessionId: params.record.acpSessionId,
      pendingAgentSessionId: params.record.agentSessionId,
      sessionModels: undefined,
      resumed: true,
      createdFreshSession: false,
    };
  }

  if (params.client.supportsResumeSession()) {
    return await resumeRuntimeSession(params);
  }

  if (params.client.supportsLoadSession()) {
    return await loadRuntimeSession(params);
  }

  if (params.sameSessionOnly) {
    throw makeSessionResumeRequiredError({
      record: params.record,
      reason: "agent does not support session/resume or session/load",
    });
  }

  return await createFreshRuntimeSession(params.client, params.record, params.timeoutMs);
}

async function resumeRuntimeSession(params: {
  client: AcpClient;
  record: SessionRecord;
  sameSessionOnly: boolean;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<RuntimeSessionLoadState> {
  try {
    return await runResumeRuntimeSession(params);
  } catch (error) {
    const recovered = await recoverMissingTranscriptAndRetry(
      params,
      error,
      runResumeRuntimeSession,
    );
    if (recovered) {
      return recovered;
    }
    return await recoverRuntimeSessionLoadFailure(params, error);
  }
}

async function loadRuntimeSession(params: {
  client: AcpClient;
  record: SessionRecord;
  sameSessionOnly: boolean;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<RuntimeSessionLoadState> {
  try {
    return await runLoadRuntimeSession(params);
  } catch (error) {
    const recovered = await recoverMissingTranscriptAndRetry(params, error, runLoadRuntimeSession);
    if (recovered) {
      return recovered;
    }
    return await recoverRuntimeSessionLoadFailure(params, error);
  }
}

async function runResumeRuntimeSession(params: {
  client: AcpClient;
  record: SessionRecord;
  timeoutMs?: number;
}): Promise<RuntimeSessionLoadState> {
  const resumeResult = await withTimeout(
    params.client.resumeSession(params.record.acpSessionId, params.record.cwd),
    params.timeoutMs,
  );
  reconcileAgentSessionId(params.record, resumeResult.agentSessionId);
  applyConfigOptionsToRecord(params.record, resumeResult);
  return {
    sessionId: params.record.acpSessionId,
    pendingAgentSessionId: params.record.agentSessionId,
    sessionModels: resumeResult.models,
    resumed: true,
    createdFreshSession: false,
  };
}

async function runLoadRuntimeSession(params: {
  client: AcpClient;
  record: SessionRecord;
  timeoutMs?: number;
}): Promise<RuntimeSessionLoadState> {
  const loadResult = await withTimeout(
    params.client.loadSessionWithOptions(params.record.acpSessionId, params.record.cwd, {
      suppressReplayUpdates: true,
    }),
    params.timeoutMs,
  );
  reconcileAgentSessionId(params.record, loadResult.agentSessionId);
  applyConfigOptionsToRecord(params.record, loadResult);
  return {
    sessionId: params.record.acpSessionId,
    pendingAgentSessionId: params.record.agentSessionId,
    sessionModels: loadResult.models,
    resumed: true,
    createdFreshSession: false,
  };
}

async function recoverMissingTranscriptAndRetry(
  params: {
    client: AcpClient;
    record: SessionRecord;
    sameSessionOnly: boolean;
    timeoutMs?: number;
    verbose?: boolean;
  },
  error: unknown,
  retry: (params: {
    client: AcpClient;
    record: SessionRecord;
    timeoutMs?: number;
  }) => Promise<RuntimeSessionLoadState>,
): Promise<RuntimeSessionLoadState | undefined> {
  if (!isAcpResourceNotFoundError(error)) {
    return undefined;
  }

  const recovery = await ensureTranscriptAtActiveConfigDir(params.record);
  if (recovery.status === "ported") {
    logTranscriptRecovery(params.record, recovery, params.verbose);
    try {
      return await retry(params);
    } catch (retryError) {
      return await recoverRuntimeSessionLoadFailure(params, retryError);
    }
  }

  if (sessionHasAgentMessages(params.record)) {
    throw makeSessionResumeRequiredError({
      record: params.record,
      reason: missingTranscriptReason(recovery),
      cause: error,
    });
  }

  return undefined;
}

async function ensurePendingSwitchTranscript(
  record: SessionRecord,
  verbose?: boolean,
): Promise<void> {
  if (!record.acpSessionId.trim() || !sessionHasAgentMessages(record)) {
    return;
  }
  if (record.acpx?.session_options?.account_switch) {
    await ensurePendingAccountSwitchTranscript(
      record,
      record.acpx.session_options.account_switch,
      verbose,
    );
    return;
  }
  await ensurePendingSubscriptionSwitchTranscript(record, verbose);
}

async function ensurePendingSubscriptionSwitchTranscript(
  record: SessionRecord,
  verbose?: boolean,
): Promise<void> {
  const pendingSwitch = record.acpx?.session_options?.subscription_switch;
  if (!pendingSwitch) {
    return;
  }

  const recovery = await ensureTranscriptAtActiveConfigDir(record);
  if (recovery.status === "missing") {
    throw makeSessionResumeRequiredError({
      record,
      reason: `pending subscription switch ${formatSubscriptionSwitch(pendingSwitch)} cannot resume: ${missingTranscriptReason(recovery)}`,
    });
  }
  if (recovery.status === "ported") {
    logTranscriptRecovery(record, recovery, verbose);
  }
}

async function ensurePendingAccountSwitchTranscript(
  record: SessionRecord,
  pendingSwitch: NonNullable<
    NonNullable<NonNullable<SessionRecord["acpx"]>["session_options"]>["account_switch"]
  >,
  verbose?: boolean,
): Promise<void> {
  const registry = loadProfileRegistry();
  const toProfile = findProfile(pendingSwitch.toProfile, registry);
  const dstAnchor = toProfile ? transcriptAnchorDir(toProfile) : null;
  if (dstAnchor === null) {
    throw makeSessionResumeRequiredError({
      record,
      reason: `pending account switch ${formatAccountSwitch(pendingSwitch)} cannot resume: target profile "${pendingSwitch.toProfile}" has no transcript anchor`,
    });
  }

  const fromProfile = pendingSwitch.fromProfile
    ? findProfile(pendingSwitch.fromProfile, registry)
    : undefined;
  const srcAnchor = fromProfile ? transcriptAnchorDir(fromProfile) : null;
  const recovery = await ensureTranscriptAtConfigDir(record, dstAnchor, {
    sourceConfigDirs: srcAnchor === null ? [] : [srcAnchor],
  });
  if (recovery.status === "missing") {
    throw makeSessionResumeRequiredError({
      record,
      reason: `pending account switch ${formatAccountSwitch(pendingSwitch)} cannot resume: ${missingTranscriptReason(recovery)}`,
    });
  }
  if (recovery.status === "ported") {
    logTranscriptRecovery(record, recovery, verbose);
  }
}

function missingTranscriptReason(recovery: TranscriptRecoveryResult): string {
  const searched =
    recovery.searchedPaths.length > 0 ? `; searched: ${recovery.searchedPaths.join(", ")}` : "";
  return `missing transcript at ${recovery.activePath}${searched}`;
}

function formatSubscriptionSwitch(
  pendingSwitch: NonNullable<
    NonNullable<NonNullable<SessionRecord["acpx"]>["session_options"]>["subscription_switch"]
  >,
): string {
  return `${pendingSwitch.from ?? "<default>"} -> ${pendingSwitch.to}`;
}

function formatAccountSwitch(
  pendingSwitch: NonNullable<
    NonNullable<NonNullable<SessionRecord["acpx"]>["session_options"]>["account_switch"]
  >,
): string {
  return `${pendingSwitch.fromProfile ?? "<unknown>"} -> ${pendingSwitch.toProfile}`;
}

function logTranscriptRecovery(
  record: SessionRecord,
  recovery: TranscriptRecoveryResult,
  verbose?: boolean,
): void {
  if (!verbose || recovery.status !== "ported") {
    return;
  }
  process.stderr.write(
    `[acpx] ported transcript for session ${record.acpSessionId} from ${recovery.sourcePath} to ${recovery.activePath}\n`,
  );
}

async function recoverRuntimeSessionLoadFailure(
  params: {
    client: AcpClient;
    record: SessionRecord;
    sameSessionOnly: boolean;
    timeoutMs?: number;
    verbose?: boolean;
  },
  error: unknown,
): Promise<RuntimeSessionLoadState> {
  const loadError = formatErrorMessage(error);
  if (params.sameSessionOnly) {
    throw makeSessionResumeRequiredError({
      record: params.record,
      reason: loadError,
      cause: error,
    });
  }
  if (!shouldFallbackToNewSession(error, params.record)) {
    if (sessionHasAgentMessages(params.record)) {
      throw makeSessionResumeRequiredError({
        record: params.record,
        reason: loadError,
        cause: error,
      });
    }
    throw error;
  }
  return {
    ...(await createFreshRuntimeSession(params.client, params.record, params.timeoutMs)),
    loadError,
  };
}

async function createFreshRuntimeSession(
  client: AcpClient,
  record: SessionRecord,
  timeoutMs: number | undefined,
): Promise<RuntimeSessionLoadState> {
  const createdSession = await withTimeout(client.createSession(record.cwd), timeoutMs);
  applyConfigOptionsToRecord(record, createdSession);
  return {
    sessionId: createdSession.sessionId,
    pendingAgentSessionId: createdSession.agentSessionId,
    sessionModels: createdSession.models,
    resumed: false,
    createdFreshSession: true,
  };
}
