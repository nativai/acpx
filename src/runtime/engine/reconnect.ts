import type { AcpClient } from "../../acp/client.js";
import {
  extractAcpError,
  formatAcpErrorMessage,
  formatErrorMessage,
  isAcpQueryClosedBeforeResponseError,
  isAcpResourceNotFoundError,
} from "../../acp/error-normalization.js";
import {
  assertRequestedModelSupported,
  RequestedModelUnsupportedError,
} from "../../acp/model-support.js";
import { InterruptedError, TimeoutError, withTimeout } from "../../async-control.js";
import { findProfile, loadProfileRegistry, transcriptAnchorDir } from "../../config/profiles.js";
import {
  ensureTranscriptAtConfigDir,
  ensureTranscriptAtActiveConfigDir,
  type TranscriptRecoveryResult,
} from "../../config/subscription-transcript.js";
import {
  ModelFloorUnmetError,
  SessionConfigOptionReplayError,
  SessionModeReplayError,
  SessionModelReplayError,
  SessionResumeRequiredError,
} from "../../errors.js";
import { incrementPerfCounter } from "../../perf-metrics.js";
import { normalizeEffortLevelForModel } from "../../session/config-option-application.js";
import { applyConfigOptionsToRecord } from "../../session/config-options.js";
import { resolveContextWindowHint } from "../../session/conversation-model.js";
import {
  getDesiredConfigOptions,
  getDesiredModeId,
  getDesiredModelId,
  setDesiredConfigOption,
  setCurrentModelId,
  setDesiredModelSource,
  syncAdvertisedModelState,
} from "../../session/mode-preference.js";
import { guardServedModel, stampModelGuardBreadcrumb } from "../../session/model-guard.js";
import { stampAppliedOutputStyle } from "../../session/output-style.js";
import type { SessionRecord, SessionResumePolicy } from "../../types.js";
import {
  applyLifecycleSnapshotToRecord,
  reconcileAgentSessionId,
  sessionHasRealAgentTurn,
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
  /**
   * brick://874fee67 — the output style the client was CONSTRUCTED with, so this
   * function can stamp `acpx.applied_output_style` with the same value the
   * session/new + resume `_meta` were composed from.
   *
   * Passed in rather than read back off the client on purpose: the caller holds
   * the one `sessionOptions` object it hands to both, so the two cannot diverge,
   * and `AcpClient` keeps the surface its many test doubles already implement.
   */
  outputStyle?: string;
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
    return !sessionHasRealAgentTurn(record);
  }

  return !sessionHasRealAgentTurn(record) && isFallbackSafeEmptySessionError(error, acp);
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
        `[acpx] replayed desired mode ${params.desiredModeId} on reconnected ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`,
      );
    }
  } catch (error) {
    throw new SessionModeReplayError(
      `Failed to replay saved session mode ${params.desiredModeId} on reconnected ACP session ${params.sessionId}: ${formatErrorMessage(error)}`,
      {
        cause: error instanceof Error ? error : undefined,
        retryable: true,
      },
    );
  }
}

// brick://5bac5564 Layer B belt (grandfather legacy): a replay of an IMPLICIT Fable
// desired pin is force-redirected to the non-Fable default (+ provenance/breadcrumb);
// absent provenance (legacy) is left alone. Post the resolution-tier guard this is a
// near-noop safety net for a Fable pin that slipped through non-explicit.
function guardReplayDesiredModel(record: SessionRecord, desiredModelId: string): string {
  const guarded = guardServedModel({
    requestedModel: desiredModelId,
    modelSource: record.acpx?.session_options?.model_source,
    availableModels: record.acpx?.available_models,
  });
  if (guarded.forced && guarded.blocked) {
    setDesiredModelSource(record, "guard-forced");
    stampModelGuardBreadcrumb(record, {
      blocked: guarded.blocked,
      forcedTo: guarded.model ?? desiredModelId,
      source: "reconnect-belt",
    });
  }
  return guarded.model ?? desiredModelId;
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
}): Promise<boolean> {
  if (!params.desiredModelId) {
    return false;
  }

  const desiredModelId = guardReplayDesiredModel(params.record, params.desiredModelId);

  try {
    assertRequestedModelSupported({
      requestedModel: desiredModelId,
      models: params.models,
      agentCommand: params.record.agentCommand,
      context: "replay",
    });
    if (!params.models || params.models.currentModelId === desiredModelId) {
      return !!params.models;
    }
    await withTimeout(
      params.client.setSessionModel(params.sessionId, desiredModelId),
      params.timeoutMs,
    );
    if (params.verbose) {
      process.stderr.write(
        `[acpx] replayed desired model ${desiredModelId} on reconnected ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`,
      );
    }
    return true;
  } catch (error) {
    throw toModelReplayError(error, {
      desiredModelId: params.desiredModelId,
      sessionId: params.sessionId,
      servedModelId: params.models?.currentModelId,
      // Only the "advertises a model SET that LACKS the pin" case is a floor
      // violation (below). A target advertising NO model metadata at all is a
      // capability mismatch, not a serving downgrade — keep the generic error.
      hasAdvertisedModels: params.models !== undefined,
    });
  }
}

// Map a failed desired-model replay to the right terminal. Harden the "target
// can't serve the pinned model" case (brick://07dd62c9 §5A): when the reconnected
// / failed-over session advertises a model set that does NOT include the pinned
// model, the desired model IS a pinned floor the target cannot meet — surface it
// as a LOUD ModelFloorUnmetError (detailCode 'model-floor-unmet' → acpx-ui banner
// + parent-visible terminal mirror, observed served model = what the target IS
// serving) instead of a generic SESSION_MODEL_REPLAY_FAILED that reads as an
// internal replay hiccup. Retryable is preserved; the failover loop is already
// bounded (terminates on all-siblings-exhausted), so this never deadlocks. A
// target advertising NO model metadata (no generic model support) and other replay
// failures (network/timeout) keep the generic retryable SessionModelReplayError.
function toModelReplayError(
  error: unknown,
  params: {
    desiredModelId: string;
    sessionId: string;
    servedModelId: string | undefined;
    hasAdvertisedModels: boolean;
  },
): Error {
  if (error instanceof RequestedModelUnsupportedError && params.hasAdvertisedModels) {
    return new ModelFloorUnmetError({
      pinnedModel: params.desiredModelId,
      servedModel: params.servedModelId,
      phase: "post-serve",
      detail: "reconnected/failover target advertises a model set that lacks the pinned model",
    });
  }
  return new SessionModelReplayError(
    `Failed to replay saved session model ${params.desiredModelId} on reconnected ACP session ${params.sessionId}: ${formatErrorMessage(error)}`,
    {
      cause: error instanceof Error ? error : undefined,
      retryable: true,
    },
  );
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
          `[acpx] replayed desired config option ${configId} on reconnected ACP session ${params.sessionId} (previous ${params.previousSessionId})\n`,
        );
      }
    } catch (error) {
      // A returning call means the agent DECLINED the option — degrade with a
      // visible warning and proceed with the turn. Only a transport failure
      // rethrows. See handleConfigOptionReplayError.
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

// Decide how a config-option replay failure is handled.
//
// ⚠️ THE RULE IS ABOUT THE KIND OF FAILURE, NOT THE NAME OF THE OPTION
// (brick://874fee67 F1). It used to be scoped to `effort` alone, and that scoping
// KILLED SESSIONS: a per-subscription custom output style is not resolvable after
// an auto-failover moves the session to another `CLAUDE_CONFIG_DIR`, the adapter
// honestly declines to advertise it, acpx replayed it anyway, and the rethrow
// took the whole turn down — the user got NO REPLY AT ALL. Auto-failover is ON by
// default and re-picks the subscription every turn, so that was the ordinary path
// for any session carrying a custom style, not an edge case.
//
// WHY TOLERATING ANY OPTION IS SAFE, structurally rather than by hope: everything
// in `desired_config_options` is a PREFERENCE, because the two things that are
// correctness PINS cannot be in there. `setDesiredConfigOption`
// (`session/mode-preference.ts`) early-returns for `mode` and `model`, so the
// record slot this loop iterates can never hold them; they have their own replay
// paths with their own error handling (`replayDesiredModel` /
// `SessionModelReplayError`, and the model-floor check above). A preference that
// the reconnected backend will not accept should degrade with a warning; it must
// never cost the user their turn.
//
// The pin is KEPT in the record either way, so if a later turn lands back on a
// subscription where the option resolves, the replay simply succeeds again.
//
// WHAT STILL RETHROWS: a transport failure — timeout or interrupt, i.e. no ACP
// payload at all. That is not the agent declining; it is us not knowing what
// happened, and proceeding would build a turn on an unverified assumption.
// `extractAcpError` is the discriminator, and it is the one that matters here.
function handleConfigOptionReplayError(params: {
  configId: string;
  error: unknown;
  sessionId: string;
  verbose?: boolean;
}): void {
  if (extractAcpError(params.error)) {
    warnConfigOptionReplayDegraded(params);
    return;
  }
  throw new SessionConfigOptionReplayError(
    // formatAcpErrorMessage, not formatErrorMessage: a JSON-RPC fault's `message`
    // is the generic "Internal error" while the actual diagnosis sits in
    // `data.details`. Surfacing only the former is what made this failure
    // undiagnosable in the field (F2).
    `Failed to replay saved session config option ${params.configId} on reconnected ACP session ${params.sessionId}: ${formatAcpErrorMessage(params.error)}`,
    {
      cause: params.error instanceof Error ? params.error : undefined,
      retryable: true,
    },
  );
}

// The degradation must be VISIBLE. A preference that silently stops applying is
// the "control that lies" failure this feature is built to forbid — the user
// would get a reply in the wrong style with nothing anywhere saying so.
//
// `effort` is the ONE carve-out, and only on VERBOSITY, never on tolerance: some
// models (e.g. haiku) advertise an `effort` option at session/new yet have the
// adapter reject mutating it, so this fires routinely for a case the creation
// path already absorbs deliberately (`setConfigOptionWithEffortFallback` —
// "layer on top, never break"). Warning unconditionally there would print noise
// on every reconnect of every such session. Any other option reaching this branch
// is a real, unexplained loss of a setting the user asked for.
function warnConfigOptionReplayDegraded(params: {
  configId: string;
  error: unknown;
  sessionId: string;
  verbose?: boolean;
}): void {
  if (params.configId === "effort" && !params.verbose) {
    return;
  }
  process.stderr.write(
    `[acpx] config option "${params.configId}" was rejected by the agent on session ${params.sessionId} and is NOT in effect for this turn: ${formatAcpErrorMessage(params.error)}\n`,
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
  pendingAgentSessionId = loadState.pendingAgentSessionId;
  sessionModels = loadState.sessionModels;

  // brick://874fee67 turn-boundary spec §3 — the primary stamp site. The query
  // backing this session has just been (re)built, and `client.getSessionOutputStyle()`
  // is the very value its `_meta` was composed from, so `applied` cannot drift
  // from what was actually sent. Stamped AFTER success and UNCONDITIONALLY,
  // including for the default.
  //
  // This is also what makes a recycle terminal rather than repeating: the fresh
  // owner resumes with `desired`, stamps it here as `applied`, and
  // `outputStyleChangePending` goes false — so the next turn boundary does not
  // recycle again.
  stampAppliedOutputStyle(record, options.outputStyle);

  const replayResult = await replayReconnectedSessionPreferences({
    client,
    record,
    shouldReplayPreferences: loadState.shouldReplayPreferences,
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

  applyReconnectedModelState(
    record,
    sessionModels,
    replayResult.desiredModelRestored,
    desiredModelId,
  );

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
  desiredModelRestored: boolean,
  desiredModelId: string | undefined,
): void {
  syncAdvertisedModelState(record, sessionModels);
  if (desiredModelRestored && desiredModelId && sessionModels) {
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

type PreferenceReplayResult = {
  desiredModelRestored: boolean;
};

async function replayReconnectedSessionPreferences(params: {
  client: AcpClient;
  record: SessionRecord;
  shouldReplayPreferences: boolean;
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
}): Promise<PreferenceReplayResult> {
  if (!params.shouldReplayPreferences) {
    return { desiredModelRestored: false };
  }

  let desiredModelRestored = false;
  try {
    await replayDesiredMode({
      client: params.client,
      sessionId: params.sessionId,
      desiredModeId: params.desiredModeId,
      previousSessionId: params.originalSessionId,
      timeoutMs: params.timeoutMs,
      verbose: params.verbose,
    });
    desiredModelRestored = await replayDesiredModel({
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
  return { desiredModelRestored };
}

type RuntimeSessionLoadState = {
  sessionId: string;
  pendingAgentSessionId: string | undefined;
  sessionModels: import("../../acp/client.js").SessionLoadResult["models"];
  resumed: boolean;
  shouldReplayPreferences: boolean;
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
      shouldReplayPreferences: false,
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

/** Fix A (brick 92a994a0): the resume `_meta` hint to restore the authoritative
 *  context window learned by a prior run — the remembered size plus the model
 *  it belongs to (so the adapter re-applies it when the resume replays that
 *  model instead of clobbering it with the plain-alias heuristic). Empty when
 *  there is nothing trustworthy to restore. */
function contextWindowHintOptions(record: SessionRecord): {
  contextWindowSizeHint?: number;
  contextWindowSizeHintModel?: string;
} {
  const contextWindowSizeHint = resolveContextWindowHint(record.acpx);
  if (contextWindowSizeHint === undefined) {
    return {};
  }
  return {
    contextWindowSizeHint,
    contextWindowSizeHintModel: record.acpx?.context_window_model_id,
  };
}

async function runResumeRuntimeSession(params: {
  client: AcpClient;
  record: SessionRecord;
  timeoutMs?: number;
}): Promise<RuntimeSessionLoadState> {
  const resumeResult = await withTimeout(
    params.client.resumeSession(
      params.record.acpSessionId,
      params.record.cwd,
      contextWindowHintOptions(params.record),
    ),
    params.timeoutMs,
  );
  reconcileAgentSessionId(params.record, resumeResult.agentSessionId);
  applyConfigOptionsToRecord(params.record, resumeResult);
  return {
    sessionId: params.record.acpSessionId,
    pendingAgentSessionId: params.record.agentSessionId,
    sessionModels: resumeResult.models,
    resumed: true,
    shouldReplayPreferences: true,
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
      ...contextWindowHintOptions(params.record),
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
    shouldReplayPreferences: true,
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

  if (sessionHasRealAgentTurn(params.record)) {
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
  // Real turns only (brick://509b4ee1): a breadcrumb-only session has no
  // transcript to ensure — proceed straight to connect, where the fixed
  // fallback gate creates the session fresh on the new anchor.
  if (!record.acpSessionId.trim() || !sessionHasRealAgentTurn(record)) {
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
    if (sessionHasRealAgentTurn(params.record)) {
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
    shouldReplayPreferences: true,
  };
}
