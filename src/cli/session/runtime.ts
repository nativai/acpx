import os from "node:os";
import path from "node:path";
import { AcpClient } from "../../acp/client.js";
import {
  formatErrorMessage,
  isRetryablePromptError,
  normalizeOutputError,
} from "../../acp/error-normalization.js";
import { assertRequestedModelSupported } from "../../acp/model-support.js";
import { InterruptedError, withInterrupt, withTimeout } from "../../async-control.js";
import { tailClaudeSubagentJsonl } from "../../claude-jsonl.js";
import { transcriptCwdHash } from "../../config/subscription-transcript.js";
import { AllSubscriptionsExhaustedError, SessionClosedError } from "../../errors.js";
import {
  attemptFailoverAndRetry,
  classifyFailover,
  failoverEnabled,
} from "../../runtime/engine/failover.js";
export { InterruptedError, TimeoutError } from "../../async-control.js";
import { formatPerfMetric, measurePerf, startPerfTimer } from "../../perf-metrics.js";
import { textPrompt } from "../../prompt-content.js";
import {
  applyConversation,
  applyLifecycleSnapshotToRecord,
} from "../../runtime/engine/lifecycle.js";
import { runPromptTurn } from "../../runtime/engine/prompt-turn.js";
import { connectAndLoadSession } from "../../runtime/engine/reconnect.js";
import {
  mergeSessionOptions,
  sessionOptionsFromRecord,
  type SessionAgentOptions,
} from "../../runtime/engine/session-options.js";
import { applyExecReasoningEffort } from "../../session/config-option-application.js";
import {
  cloneSessionAcpxState,
  cloneSessionConversation,
  recordClientOperation as recordConversationClientOperation,
  recordPromptSubmission,
  recordSessionUpdate as recordConversationSessionUpdate,
  trimConversationForRuntime,
} from "../../session/conversation-model.js";
import {
  buildDeliveryEvent,
  type DeliveryEventError,
  type DeliveryPhase,
  type DeliveryStopReason,
} from "../../session/delivery-events.js";
import { defaultSessionEventLog } from "../../session/event-log.js";
import { SessionEventWriter } from "../../session/events.js";
import { LiveSessionCheckpoint } from "../../session/live-checkpoint.js";
import { setCurrentModelId, setDesiredModelId } from "../../session/mode-preference.js";
import { applyRequestedModelIfAdvertised } from "../../session/model-application.js";
import { persistTerminalTurnError } from "../../session/persist-terminal-error.js";
import {
  absolutePath,
  isoNow,
  resolveSessionRecord,
  writeSessionRecord,
} from "../../session/persistence.js";
import {
  SESSION_RECORD_SCHEMA,
  type AcpJsonRpcMessage,
  type AcpMessageDirection,
  type AuthPolicy,
  type McpServer,
  type NonInteractivePermissionPolicy,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
  type OutputFormatter,
  type PermissionEscalationEvent,
  type PermissionPolicy,
  type PromptInput,
  type RunPromptResult,
  SessionRecord,
  SessionSendResult,
  SubagentRef,
} from "../../types.js";
import { type QueueOwnerMessage, type QueueTask, waitMs } from "../queue/ipc.js";
import { type QueueOwnerActiveSessionController } from "../queue/owner-turn-controller.js";
import { resolveAndEnsureAgentFolder } from "./agent-folder.js";
import type { RunOnceOptions, SessionSendOptions } from "./contracts.js";

function claudeSubagentDir(cwd: string, acpSessionId: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  // transcriptCwdHash is the single source of truth for the projects/<cwdHash>
  // layout (shared with subscription-transcript.ts's JSONL portability).
  return path.join(configDir, "projects", transcriptCwdHash(cwd), acpSessionId, "subagents");
}

const INTERRUPT_CANCEL_WAIT_MS = 2_500;

type RunSessionPromptOptions = Omit<
  SessionSendOptions,
  "errorEmissionPolicy" | "maxQueueDepth" | "sessionId" | "ttlMs" | "waitForCompletion"
> & {
  sessionRecordId: string;
  requestId?: string;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
  onPromptActive?: () => Promise<void> | void;
  // Called with a handler once the ACP prompt is in-flight; the handler
  // accepts a QueueTask and concurrently calls client.prompt() for it so the
  // agent sees the new message mid-turn via the Pushable input. Pass undefined
  // to clear the handler after the turn ends.
  setMidTurnHandler?: (handler: ((task: QueueTask) => void) | undefined) => void;
};

type ActiveSessionController = QueueOwnerActiveSessionController;

class QueueTaskOutputFormatter implements OutputFormatter {
  private readonly requestId: string;
  private readonly send: (message: QueueOwnerMessage) => void;

  constructor(task: QueueTask) {
    this.requestId = task.requestId;
    this.send = task.send;
  }

  setContext(_context: { sessionId: string }): void {}

  onAcpMessage(message: AcpJsonRpcMessage): void {
    this.send({
      type: "event",
      requestId: this.requestId,
      message,
    });
  }

  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    timestamp?: string;
  }): void {
    this.send({
      type: "error",
      requestId: this.requestId,
      code: params.code,
      detailCode: params.detailCode,
      origin: params.origin,
      message: params.message,
      retryable: params.retryable,
      acp: params.acp,
    });
  }

  onPermissionEscalation(event: PermissionEscalationEvent): void {
    this.send({
      type: "permission_escalation",
      requestId: this.requestId,
      event,
    });
  }

  flush(): void {}
}

const DISCARD_OUTPUT_FORMATTER: OutputFormatter = {
  setContext() {},
  onAcpMessage() {},
  onError() {},
  onPermissionEscalation() {},
  flush() {},
};

function toPromptResult(
  stopReason: RunPromptResult["stopReason"],
  sessionId: string,
  client: AcpClient,
): RunPromptResult {
  return {
    stopReason,
    sessionId,
    permissionStats: client.getPermissionStats(),
  };
}

type DeliveryContext = {
  messageId: string;
  requestId: string;
};

function deliveryContextFor(params: {
  messageId?: string;
  requestId?: string;
}): DeliveryContext | undefined {
  if (!params.messageId || !params.requestId) {
    return undefined;
  }
  return {
    messageId: params.messageId,
    requestId: params.requestId,
  };
}

function deliveryKey(context: DeliveryContext): string {
  return `${context.messageId}\0${context.requestId}`;
}

function shouldSkipDeliveryEvent(params: {
  phase: DeliveryPhase;
  terminal: boolean;
  key: string;
  acceptedDeliveryKeys: Set<string>;
  terminalDeliveryKeys: Set<string>;
}): boolean {
  if (params.phase === "accepted" && params.acceptedDeliveryKeys.has(params.key)) {
    return true;
  }
  return params.terminal && params.terminalDeliveryKeys.has(params.key);
}

function markDeliveryEvent(params: {
  phase: DeliveryPhase;
  terminal: boolean;
  key: string;
  acceptedDeliveryKeys: Set<string>;
  terminalDeliveryKeys: Set<string>;
}): void {
  if (params.phase === "accepted") {
    params.acceptedDeliveryKeys.add(params.key);
  }
  if (params.terminal) {
    params.terminalDeliveryKeys.add(params.key);
  }
}

const DELIVERY_STOP_REASONS = new Set(["end_turn", "max_tokens", "max_turns", "cancelled"]);

function toDeliveryStopReason(stopReason: RunPromptResult["stopReason"]): DeliveryStopReason {
  return DELIVERY_STOP_REASONS.has(stopReason) ? (stopReason as DeliveryStopReason) : null;
}

function deliveryPhaseForStopReason(
  stopReason: RunPromptResult["stopReason"],
): Exclude<DeliveryPhase, "accepted"> {
  return stopReason === "cancelled" ? "cancelled" : "done";
}

function deliveryErrorFrom(error: unknown): DeliveryEventError {
  const normalized = normalizeOutputError(error, { origin: "runtime" });
  return {
    code: normalized.acp?.code ?? 0,
    message: normalized.message,
    detailCode: normalized.detailCode ?? "",
  };
}

function requestedModelId(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function advertisedModelsForRecord(record: SessionRecord):
  | {
      currentModelId: string;
      availableModels: Array<{ modelId: string; name: string }>;
    }
  | undefined {
  const availableModels = record.acpx?.available_models;
  if (!Array.isArray(availableModels)) {
    return undefined;
  }
  return {
    currentModelId: record.acpx?.current_model_id ?? "",
    availableModels: availableModels.map((modelId) => ({ modelId, name: modelId })),
  };
}

async function applyPromptModelIfAdvertised(params: {
  client: AcpClient;
  sessionId: string;
  requestedModel: string | undefined;
  record: SessionRecord;
  timeoutMs?: number;
}): Promise<void> {
  const requestedModel = requestedModelId(params.requestedModel);
  if (!requestedModel) {
    return;
  }

  const models = advertisedModelsForRecord(params.record);
  assertRequestedModelSupported({
    requestedModel,
    models,
    agentCommand: params.record.agentCommand,
    context: "apply",
  });
  if (!models) {
    return;
  }
  if (params.record.acpx?.current_model_id === requestedModel) {
    setDesiredModelId(params.record, requestedModel);
    return;
  }

  await withTimeout(
    params.client.setSessionModel(params.sessionId, requestedModel),
    params.timeoutMs,
  );
  setDesiredModelId(params.record, requestedModel);
  setCurrentModelId(params.record, requestedModel);
}

function jsonRpcIdKey(value: unknown): string | undefined {
  if (typeof value === "string") {
    return `s:${value}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `n:${value}`;
  }
  return undefined;
}

function extractJsonRpcRequestInfo(
  message: AcpJsonRpcMessage,
): { idKey: string; method: string } | undefined {
  const candidate = message as { method?: unknown; id?: unknown };
  if (typeof candidate.method !== "string") {
    return undefined;
  }
  const idKey = jsonRpcIdKey(candidate.id);
  if (!idKey) {
    return undefined;
  }
  return {
    idKey,
    method: candidate.method,
  };
}

function extractJsonRpcResponseInfo(
  message: AcpJsonRpcMessage,
): { idKey: string; hasError: boolean } | undefined {
  const candidate = message as { id?: unknown; error?: unknown; result?: unknown };
  const idKey = jsonRpcIdKey(candidate.id);
  if (!idKey) {
    return undefined;
  }
  const hasError = Object.hasOwn(candidate, "error");
  const hasResult = Object.hasOwn(candidate, "result");
  if (!hasError && !hasResult) {
    return undefined;
  }
  return {
    idKey,
    hasError,
  };
}

const SESSION_RECONNECT_METHODS = new Set(["session/load", "session/resume"]);

function filterRecoverableLoadFallbackOutput(messages: AcpJsonRpcMessage[]): AcpJsonRpcMessage[] {
  const requestMethodById = new Map<string, string>();
  const failedLoadRequestIds = new Set<string>();

  for (const message of messages) {
    const request = extractJsonRpcRequestInfo(message);
    if (request) {
      requestMethodById.set(request.idKey, request.method);
      continue;
    }

    const response = extractJsonRpcResponseInfo(message);
    if (!response || !response.hasError) {
      continue;
    }

    const requestMethod = requestMethodById.get(response.idKey);
    if (requestMethod && SESSION_RECONNECT_METHODS.has(requestMethod)) {
      failedLoadRequestIds.add(response.idKey);
    }
  }

  if (failedLoadRequestIds.size === 0) {
    return messages;
  }

  return messages.filter((message) => {
    const request = extractJsonRpcRequestInfo(message);
    if (
      request &&
      SESSION_RECONNECT_METHODS.has(request.method) &&
      failedLoadRequestIds.has(request.idKey)
    ) {
      return false;
    }

    const response = extractJsonRpcResponseInfo(message);
    if (response && failedLoadRequestIds.has(response.idKey)) {
      return false;
    }

    return true;
  });
}

function emitPromptRetryNotice(params: {
  error: unknown;
  delayMs: number;
  attempt: number;
  maxRetries: number;
  suppressSdkConsoleErrors?: boolean;
}): void {
  if (params.suppressSdkConsoleErrors) {
    return;
  }

  process.stderr.write(
    `[acpx] prompt failed (${formatErrorMessage(params.error)}), retrying in ${params.delayMs}ms ` +
      `(attempt ${params.attempt}/${params.maxRetries})\n`,
  );
}

function emitConnectPerfMetric(startedAt: number, verbose?: boolean): void {
  if (!verbose) {
    return;
  }
  process.stderr.write(
    `[acpx] ${formatPerfMetric("prompt.connect_and_load", Date.now() - startedAt)}\n`,
  );
}

function emitPromptPerfMetric(startedAt: number, verbose?: boolean): void {
  if (!verbose) {
    return;
  }
  process.stderr.write(`[acpx] ${formatPerfMetric("prompt.agent_turn", Date.now() - startedAt)}\n`);
}

function emitPromptHookError(error: unknown, verbose?: boolean): void {
  if (!verbose) {
    return;
  }
  process.stderr.write("[acpx] onPromptActive hook failed: " + formatErrorMessage(error) + "\n");
}

function emitPromptDisconnectNotice(
  snapshot: ReturnType<AcpClient["getAgentLifecycleSnapshot"]>,
  verbose?: boolean,
): void {
  const lastExit = snapshot.lastExit;
  if (!lastExit?.unexpectedDuringPrompt || !verbose) {
    return;
  }
  process.stderr.write(
    "[acpx] agent disconnected during prompt (" +
      lastExit.reason +
      ", exit=" +
      lastExit.exitCode +
      ", signal=" +
      (lastExit.signal ?? "none") +
      ")\n",
  );
}

function shouldRetryRuntimePrompt(
  error: unknown,
  attempt: number,
  maxRetries: number,
  snapshot: ReturnType<AcpClient["getAgentLifecycleSnapshot"]>,
  hasSideEffects: () => boolean,
): boolean {
  if (!shouldRetryPromptAttempt(error, attempt, maxRetries, hasSideEffects)) {
    return false;
  }
  return snapshot.lastExit?.unexpectedDuringPrompt !== true;
}

function shouldRetryPromptAttempt(
  error: unknown,
  attempt: number,
  maxRetries: number,
  hasSideEffects: () => boolean,
): boolean {
  return attempt < maxRetries && !hasSideEffects() && isRetryablePromptError(error);
}

async function waitBeforePromptRetry(
  error: unknown,
  attempt: number,
  maxRetries: number,
  suppressSdkConsoleErrors?: boolean,
): Promise<void> {
  const delayMs = Math.min(1_000 * 2 ** attempt, 10_000);
  emitPromptRetryNotice({
    error,
    delayMs,
    attempt: attempt + 1,
    maxRetries,
    suppressSdkConsoleErrors,
  });
  await waitMs(delayMs);
}

type QueuedTaskRuntimeOptions = Parameters<typeof runQueuedTask>[2];

function buildQueuedTaskRunOptions(
  sessionRecordId: string,
  task: QueueTask,
  options: QueuedTaskRuntimeOptions,
  outputFormatter: OutputFormatter,
): RunSessionPromptOptions {
  return {
    sessionRecordId,
    mcpServers: options.mcpServers,
    requestId: task.requestId,
    messageId: task.messageId,
    prompt: task.prompt ?? textPrompt(task.message),
    permissionMode: task.permissionMode,
    resumePolicy: task.resumePolicy,
    nonInteractivePermissions: task.nonInteractivePermissions ?? options.nonInteractivePermissions,
    permissionPolicy: task.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    outputFormatter,
    timeoutMs: task.timeoutMs,
    suppressSdkConsoleErrors: task.suppressSdkConsoleErrors ?? options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    promptRetries: task.promptRetries ?? options.promptRetries ?? 0,
    sessionOptions: mergeSessionOptions(task.sessionOptions, options.sessionOptions),
    onClientAvailable: options.onClientAvailable,
    onClientClosed: options.onClientClosed,
    onPromptActive: options.onPromptActive,
    // Fork: thread the queue-owner mid-turn-injection hooks through the
    // extracted helper so concurrent in-turn prompts still reach runSessionPrompt.
    onAcpMessage: options.onAcpMessage,
    setMidTurnHandler: options.setMidTurnHandler,
    client: options.sharedClient,
  };
}

function sendQueuedTaskResult(task: QueueTask, result: SessionSendResult): void {
  if (!task.waitForCompletion) {
    return;
  }
  task.send({
    type: "result",
    requestId: task.requestId,
    result,
  });
}

function sendQueuedTaskError(task: QueueTask, error: unknown): void {
  if (!task.waitForCompletion) {
    return;
  }
  const normalizedError = normalizeOutputError(error, {
    origin: "runtime",
    detailCode: "QUEUE_RUNTIME_PROMPT_FAILED",
  });
  const alreadyEmitted =
    (error as { outputAlreadyEmitted?: unknown }).outputAlreadyEmitted === true;
  task.send({
    type: "error",
    requestId: task.requestId,
    code: normalizedError.code,
    detailCode: normalizedError.detailCode,
    origin: normalizedError.origin,
    message: normalizedError.message,
    retryable: normalizedError.retryable,
    acp: normalizedError.acp,
    outputAlreadyEmitted: alreadyEmitted,
  });
}

export async function runQueuedTask(
  sessionRecordId: string,
  task: QueueTask,
  options: {
    sharedClient?: AcpClient;
    verbose?: boolean;
    mcpServers?: McpServer[];
    nonInteractivePermissions?: NonInteractivePermissionPolicy;
    permissionPolicy?: PermissionPolicy;
    authCredentials?: Record<string, string>;
    authPolicy?: AuthPolicy;
    suppressSdkConsoleErrors?: boolean;
    promptRetries?: number;
    sessionOptions?: SessionAgentOptions;
    onClientAvailable?: (controller: ActiveSessionController) => void;
    onClientClosed?: () => void;
    onPromptActive?: () => Promise<void> | void;
    onAcpMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
    setMidTurnHandler?: (handler: ((task: QueueTask) => void) | undefined) => void;
    // Failover: signaled after a turn auto-switched the session to a new
    // subscription. The owner uses it to recycle its (now stale-dir) shared
    // client so subsequent turns cold-spawn on the new CLAUDE_CONFIG_DIR.
    onFailoverSwitched?: (newSubId: string) => void;
  },
): Promise<void> {
  const outputFormatter = task.waitForCompletion
    ? new QueueTaskOutputFormatter(task)
    : DISCARD_OUTPUT_FORMATTER;

  try {
    let result: SessionSendResult;
    try {
      result = await runSessionPrompt(
        buildQueuedTaskRunOptions(sessionRecordId, task, options, outputFormatter),
      );
    } catch (error) {
      result = await runQueuedTaskFailover(sessionRecordId, task, options, outputFormatter, error);
    }
    sendQueuedTaskResult(task, result);
  } catch (error) {
    sendQueuedTaskError(task, error);
    if (error instanceof InterruptedError) {
      throw error;
    }
  } finally {
    task.close();
  }
}

// On a failover-classified turn error (401/429/billing), switch the session to a
// usable subscription and re-run the turn on a FRESH client (built from the
// updated record → new CLAUDE_CONFIG_DIR, resuming the ported transcript). Not a
// failover trigger, no registry, or exhausted → rethrow (the original error, or
// AllSubscriptionsExhaustedError) for the normal failure path.
async function runQueuedTaskFailover(
  sessionRecordId: string,
  task: QueueTask,
  options: QueuedTaskRuntimeOptions,
  outputFormatter: OutputFormatter,
  error: unknown,
): Promise<SessionSendResult> {
  if (!classifyFailover(error) || !failoverEnabled()) {
    throw error;
  }
  const record = await resolveSessionRecord(sessionRecordId);
  let outcome: { result: SessionSendResult; switchedTo: string };
  try {
    outcome = await attemptFailoverAndRetry<SessionSendResult>({
      record,
      verbose: options.verbose,
      runTurn: async () =>
        // Fresh client (omit sharedClient) so the retry resolves the new dir.
        await runSessionPrompt({
          ...buildQueuedTaskRunOptions(sessionRecordId, task, options, outputFormatter),
          client: undefined,
        }),
    });
  } catch (failoverError) {
    // Exhausting all subscriptions throws AllSubscriptionsExhaustedError — an
    // acpx-synthesized terminal error that is never an ACP message, so the
    // onAcpMessage tap never persists it to the session `.stream.ndjson`. Write
    // it there explicitly so acpx-ui's stream-tail derivation surfaces its
    // `detailCode: "all-subscriptions-exhausted"` and renders the exhausted
    // banner. Best-effort — persistence failure must not swallow the turn error,
    // which still reaches the CLI output layer via sendQueuedTaskError below.
    if (failoverError instanceof AllSubscriptionsExhaustedError) {
      await persistTerminalTurnError(record, failoverError).catch(() => {});
    }
    throw failoverError;
  }
  options.onFailoverSwitched?.(outcome.switchedTo);
  return outcome.result;
}

// eslint-disable-next-line complexity -- fork integration function; intentionally over budget, refactor would risk verified merge semantics
async function runSessionPrompt(options: RunSessionPromptOptions): Promise<SessionSendResult> {
  const stopTotalTimer = startPerfTimer("runtime.prompt.total");
  const output = options.outputFormatter;
  const record = await measurePerf("session.resolve_prompt_record", async () => {
    return await resolveSessionRecord(options.sessionRecordId);
  });

  // Fail-loud on send-to-closed. `closed` is user intent (UI-authored); once
  // set, prompts are rejected until the user explicitly reopens the session
  // (via `PATCH /api/sessions/:id/closed {closed:false}` in the UI, or the
  // corresponding CLI surface). See DESIGN.md §4 "reopen question" for why
  // we don't auto-reopen on a successful turn.
  if (record.closed) {
    throw new SessionClosedError(record.acpxRecordId, record.name ?? undefined);
  }

  const conversation = cloneSessionConversation(record);
  let acpxState = cloneSessionAcpxState(record.acpx);

  const recordPromptStart = async (
    prompt: PromptInput | string,
    messageId?: string,
  ): Promise<string | undefined> => {
    const promptStartedAt = isoNow();
    const promptMessageId = recordPromptSubmission(
      conversation,
      prompt,
      promptStartedAt,
      messageId,
    );
    record.lastPromptAt = promptStartedAt;
    record.lastUsedAt = promptStartedAt;
    applyConversation(record, conversation);
    record.acpx = acpxState;
    await writeSessionRecord(record);
    return promptMessageId;
  };

  const promptMessageId = await recordPromptStart(options.prompt, options.messageId);

  output.setContext({
    sessionId: record.acpxRecordId,
  });

  const eventWriter = await measurePerf("session.events.open", async () => {
    return await SessionEventWriter.open(record);
  });
  await eventWriter.appendMessage(
    {
      jsonrpc: "2.0",
      method: "acpx/turn",
      params: {
        phase: "active",
        sessionId: record.acpxRecordId,
        at: new Date().toISOString(),
      },
    },
    { checkpoint: false },
  );
  const pendingMessages: AcpJsonRpcMessage[] = [];
  const pendingConnectOutputMessages: AcpJsonRpcMessage[] = [];
  const sessionOptions = mergeSessionOptions(
    options.sessionOptions,
    sessionOptionsFromRecord(record),
  );
  let bufferingConnectOutput = true;
  let promptTurnActive = false;
  let promptTurnHadSideEffects = false;
  // Fork: in-flight mid-turn-injected prompts. Tracked so a turn awaits all
  // of them before the queue-owner loop starts the next sequential task —
  // otherwise a second concurrent client.prompt() would cut an injected turn short.
  const injectedPromises: Promise<void>[] = [];
  let sawAcpMessage = false;
  let eventWriterClosed = false;
  const acceptedDeliveryKeys = new Set<string>();
  const terminalDeliveryKeys = new Set<string>();
  const mainDeliveryContext = deliveryContextFor(options);

  const appendDeliveryEvent = async (
    context: DeliveryContext | undefined,
    phase: DeliveryPhase,
    params: {
      stopReason?: DeliveryStopReason;
      error?: DeliveryEventError;
      terminal?: boolean;
    } = {},
  ): Promise<void> => {
    if (!context) {
      return;
    }
    const key = deliveryKey(context);
    const terminal = params.terminal === true;
    if (
      shouldSkipDeliveryEvent({
        phase,
        terminal,
        key,
        acceptedDeliveryKeys,
        terminalDeliveryKeys,
      })
    ) {
      return;
    }
    await eventWriter.appendMessage(
      buildDeliveryEvent({
        messageId: context.messageId,
        requestId: context.requestId,
        phase,
        stopReason: params.stopReason,
        error: params.error,
      }),
    );
    markDeliveryEvent({
      phase,
      terminal,
      key,
      acceptedDeliveryKeys,
      terminalDeliveryKeys,
    });
  };

  const appendDeliveryTerminal = async (
    context: DeliveryContext | undefined,
    phase: Exclude<DeliveryPhase, "accepted">,
    params: {
      stopReason?: DeliveryStopReason;
      error?: DeliveryEventError;
    } = {},
  ): Promise<void> => {
    await appendDeliveryEvent(context, phase, {
      ...params,
      terminal: true,
    });
  };

  // Subagent tracking: map from agent_id (e.g. "poet-a@haiku-demo") to ACPX record id
  const subagentIdToAcpxRecordId = new Map<string, string>();
  // Subagent in-memory records: populated immediately on teammate_spawned, before disk write completes
  const subagentRecordsById = new Map<string, SessionRecord>();
  // Subagent event writers: map from ACPX record id to event writer
  const subagentEventWriters = new Map<string, SessionEventWriter>();
  // Subagent JSONL tailers: map from ACPX record id to stop function
  const subagentTailers = new Map<string, { stop: () => Promise<void> }>();

  const getOrOpenSubagentEventWriter = async (
    childAcpxRecordId: string,
  ): Promise<SessionEventWriter | undefined> => {
    const existing = subagentEventWriters.get(childAcpxRecordId);
    if (existing) {
      return existing;
    }
    try {
      // Prefer in-memory record to avoid race condition where disk write has not completed yet
      const childRecord =
        subagentRecordsById.get(childAcpxRecordId) ??
        (await resolveSessionRecord(childAcpxRecordId));
      const writer = await SessionEventWriter.open(childRecord);
      subagentEventWriters.set(childAcpxRecordId, writer);
      return writer;
    } catch {
      return undefined;
    }
  };

  const stopAllSubagentTailers = async (): Promise<void> => {
    const stops = [...subagentTailers.values()].map((t) => t.stop().catch(() => {}));
    await Promise.all(stops);
    subagentTailers.clear();
  };

  const closeAllSubagentEventWriters = async (): Promise<void> => {
    for (const [id, writer] of subagentEventWriters) {
      try {
        await writer.close({ checkpoint: true });
      } catch {
        // best effort
      }
      subagentEventWriters.delete(id);
    }
  };

  // Extract claudeCode metadata from a raw ACP message (session/update notification)
  const extractClaudeCodeMeta = (
    message: AcpJsonRpcMessage,
  ): Record<string, unknown> | undefined => {
    const msg = message as Record<string, unknown>;
    if (msg.method !== "session/update") {
      return undefined;
    }
    const params = msg.params as Record<string, unknown> | undefined;
    if (!params) {
      return undefined;
    }
    // Check notification-level _meta first (for subagentId routing)
    const notifMeta = params._meta as Record<string, unknown> | undefined;
    if (notifMeta?.claudeCode) {
      return notifMeta.claudeCode as Record<string, unknown>;
    }
    // Check update-level _meta (for teammate_spawned status)
    const update = params.update as Record<string, unknown> | undefined;
    if (!update) {
      return undefined;
    }
    const updateMeta = update._meta as Record<string, unknown> | undefined;
    return updateMeta?.claudeCode as Record<string, unknown> | undefined;
  };

  const closeEventWriter = async (checkpoint: boolean): Promise<void> => {
    if (eventWriterClosed) {
      return;
    }
    eventWriterClosed = true;
    await stopAllSubagentTailers();
    await closeAllSubagentEventWriters();
    await eventWriter.close({ checkpoint });
  };

  const flushPendingMessages = async (checkpoint = false): Promise<void> => {
    if (pendingMessages.length === 0) {
      return;
    }

    const batch = pendingMessages.splice(0);
    await measurePerf("session.events.flush_pending", async () => {
      await eventWriter.appendMessages(batch, { checkpoint });
    });
  };
  const preserveClosedState = async (): Promise<void> => {
    const latest = await resolveSessionRecord(record.acpxRecordId).catch(() => undefined);
    if (!latest?.closed) {
      return;
    }

    record.closed = true;
    record.closedAt = latest.closedAt ?? record.closedAt ?? isoNow();
    record.pid = latest.pid;
    if (latest.acpx) {
      record.acpx = {
        ...record.acpx,
        ...latest.acpx,
      };
    }
  };
  const liveCheckpoint = new LiveSessionCheckpoint({
    save: async () => {
      await flushPendingMessages(false);
      record.lastUsedAt = isoNow();
      applyConversation(record, conversation);
      record.acpx = acpxState;
      await preserveClosedState();
      await eventWriter.checkpoint();
    },
    onError: (error) => {
      if (options.verbose) {
        process.stderr.write(
          "[acpx] live session checkpoint failed: " + formatErrorMessage(error) + "\n",
        );
      }
    },
  });

  const ownClient = options.client == null;
  const client =
    options.client ??
    new AcpClient({
      agentCommand: record.agentCommand,
      cwd: absolutePath(record.cwd),
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode,
      nonInteractivePermissions: options.nonInteractivePermissions,
      permissionPolicy: options.permissionPolicy,
      authCredentials: options.authCredentials,
      authPolicy: options.authPolicy,
      terminal: options.terminal,
      suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
      verbose: options.verbose,
      sessionContext: {
        acpxRecordId: record.acpxRecordId,
        parentSessionId: record.parentSessionId ?? null,
        taskFolder: record.metadata?.task_folder ?? null,
        agentFolder: resolveAndEnsureAgentFolder(record),
        subscriptionId: record.acpx?.session_options?.subscription ?? null,
        profileId: record.acpx?.session_options?.profile ?? null,
      },
      sessionOptions,
    });
  client.updateRuntimeOptions({
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    terminal: options.terminal,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
  });
  client.setEventHandlers({
    // eslint-disable-next-line complexity -- fork integration handler; intentionally over budget, refactor would risk verified merge semantics
    onAcpMessage: (direction, message) => {
      sawAcpMessage = true;
      pendingMessages.push(message);
      // Route messages with subagentId to the child stream as well
      const claudeCodeMeta = extractClaudeCodeMeta(message);
      if (claudeCodeMeta) {
        const subagentId = claudeCodeMeta.subagentId;
        if (typeof subagentId === "string") {
          const childAcpxRecordId = subagentIdToAcpxRecordId.get(subagentId);
          if (childAcpxRecordId) {
            void getOrOpenSubagentEventWriter(childAcpxRecordId).then((writer) => {
              if (writer) {
                void writer.appendMessage(message).catch(() => {});
              }
            });
            // On task completion/failure/stop: drain the tailer and persist final messages
            const status = claudeCodeMeta.status;
            if (
              status === "task_completed" ||
              status === "task_failed" ||
              status === "task_stopped"
            ) {
              const tailer = subagentTailers.get(childAcpxRecordId);
              if (tailer) {
                subagentTailers.delete(childAcpxRecordId);
                void tailer.stop().then(() => {
                  const childRecord = subagentRecordsById.get(childAcpxRecordId);
                  if (childRecord) {
                    childRecord.lastUsedAt = isoNow();
                    void writeSessionRecord(childRecord).catch(() => {});
                  }
                });
              }
            }
          }
        }
      }
      options.onAcpMessage?.(direction, message);
    },
    onAcpOutputMessage: (_direction, message) => {
      if (bufferingConnectOutput) {
        pendingConnectOutputMessages.push(message);
        return;
      }
      output.onAcpMessage(message);
    },
    // eslint-disable-next-line complexity -- fork integration handler; intentionally over budget, refactor would risk verified merge semantics
    onSessionUpdate: (notification) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      acpxState = recordConversationSessionUpdate(conversation, acpxState, notification);
      trimConversationForRuntime(conversation);

      // Detect teammate_spawned events to create subagent session records
      const update = notification.update as Record<string, unknown>;
      if (update.sessionUpdate === "tool_call_update" || update.sessionUpdate === "tool_call") {
        const updateMeta = update._meta as Record<string, unknown> | null | undefined;
        const claudeCodeMeta = updateMeta?.claudeCode as Record<string, unknown> | undefined;
        if (claudeCodeMeta?.status === "teammate_spawned") {
          const agentId = claudeCodeMeta.subagentId;
          const subagentName = claudeCodeMeta.subagentName ?? claudeCodeMeta.subagentId;
          const color = claudeCodeMeta.subagentColor;
          if (typeof agentId === "string") {
            const spawnedAt = isoNow();
            const childAcpxRecordId = crypto.randomUUID();
            const childAcpSessionId = `subagent-${childAcpxRecordId}`;
            const childName =
              typeof subagentName === "string" ? subagentName.split("@")[0] : undefined;
            const childRecord: SessionRecord = {
              schema: SESSION_RECORD_SCHEMA,
              acpxRecordId: childAcpxRecordId,
              acpSessionId: childAcpSessionId,
              agentCommand: "",
              cwd: record.cwd,
              name: childName,
              createdAt: spawnedAt,
              lastUsedAt: spawnedAt,
              lastSeq: 0,
              eventLog: defaultSessionEventLog(childAcpxRecordId),
              closed: false,
              messages: [],
              updated_at: spawnedAt,
              cumulative_token_usage: {},
              request_token_usage: {},
              kind: "subagent",
              parentSessionId: record.acpxRecordId,
            };
            subagentIdToAcpxRecordId.set(agentId, childAcpxRecordId);
            subagentRecordsById.set(childAcpxRecordId, childRecord);

            const subagentRef: SubagentRef = {
              acpxRecordId: childAcpxRecordId,
              name: childName ?? agentId,
              color: typeof color === "string" ? color : undefined,
              spawnedAt,
              claudeJsonlPath: claudeSubagentDir(record.cwd, record.acpSessionId),
            };

            void (async () => {
              try {
                await writeSessionRecord(childRecord);
                const parentRecord = eventWriter.getRecord();
                parentRecord.subagents = [...(parentRecord.subagents ?? []), subagentRef];
                // Sync the in-memory conversation onto the parent record before
                // persisting. Without this the subagent-spawn checkpoint writes
                // the record with stale/empty `messages`, which — if the daemon
                // later dies before the end-of-turn flush — leaves the session
                // JSON with subagent refs, last_seq set, but messages=[].
                applyConversation(parentRecord, conversation);
                parentRecord.acpx = acpxState;
                await writeSessionRecord(parentRecord);
              } catch {
                // best effort
              }
            })();

            // Start tailing the subagent JSONL file in real-time
            const rawAgentId = agentId.split("@")[0];
            const jsonlDir = claudeSubagentDir(record.cwd, record.acpSessionId);
            const tailer = tailClaudeSubagentJsonl(jsonlDir, rawAgentId, (newMessages) => {
              childRecord.messages.push(...newMessages);
              childRecord.lastUsedAt = isoNow();
              void getOrOpenSubagentEventWriter(childAcpxRecordId).then((writer) => {
                if (!writer) {
                  return;
                }
                for (const msg of newMessages) {
                  void writer
                    .appendMessage({
                      jsonrpc: "2.0",
                      method: "session/update",
                      params: {
                        sessionId: record.acpSessionId,
                        update: {
                          _meta: {
                            claudeCode: {
                              toolName: "Agent",
                              status: "subagent_message",
                              subagentId: agentId,
                              subagentName: childName ?? agentId,
                            },
                          },
                          sessionUpdate: "tool_call_update",
                          toolCallId: childAcpxRecordId,
                          message: msg,
                        },
                      },
                    })
                    .catch(() => {});
                }
              });
              void writeSessionRecord(childRecord).catch(() => {});
            });
            subagentTailers.set(childAcpxRecordId, tailer);
          }
        }
      }

      liveCheckpoint.request();
      options.onSessionUpdate?.(notification);
    },
    onClientOperation: (operation) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      acpxState = recordConversationClientOperation(conversation, acpxState, operation);
      trimConversationForRuntime(conversation);
      liveCheckpoint.request();
      options.onClientOperation?.(operation);
    },
    onPermissionEscalation: (event) => {
      output.onPermissionEscalation(event);
      options.onPermissionEscalation?.(event);
    },
  });
  let activeSessionIdForControl = record.acpSessionId;
  let notifiedClientAvailable = false;
  const activeController: ActiveSessionController = {
    hasActivePrompt: () => client.hasActivePrompt(),
    requestCancelActivePrompt: async () => await client.requestCancelActivePrompt(),
    setSessionMode: async (modeId: string) => {
      await client.setSessionMode(activeSessionIdForControl, modeId);
    },
    setSessionModel: async (modelId: string) => {
      await client.setSessionModel(activeSessionIdForControl, modelId);
    },
    setSessionConfigOption: async (configId: string, value: string) => {
      return await client.setSessionConfigOption(activeSessionIdForControl, configId, value);
    },
  };

  const flushConnectOutput = (loadError?: string): void => {
    bufferingConnectOutput = false;
    const messages =
      loadError == null
        ? pendingConnectOutputMessages
        : filterRecoverableLoadFallbackOutput(pendingConnectOutputMessages);
    for (const message of messages) {
      output.onAcpMessage(message);
    }
    pendingConnectOutputMessages.length = 0;
  };

  const connectForPrompt = async () => {
    const connectStartedAt = Date.now();
    try {
      const connected = await measurePerf("runtime.connect_and_load", async () => {
        return await connectAndLoadSession({
          client,
          record,
          resumePolicy: options.resumePolicy,
          timeoutMs: options.timeoutMs,
          verbose: options.verbose,
          activeController,
          onClientAvailable: (controller) => {
            options.onClientAvailable?.(controller);
            notifiedClientAvailable = true;
          },
          onConnectedRecord: (connectedRecord) => {
            connectedRecord.lastPromptAt = isoNow();
          },
          onSessionIdResolved: (sessionId) => {
            activeSessionIdForControl = sessionId;
          },
        });
      });
      flushConnectOutput(connected.loadError);
      emitConnectPerfMetric(connectStartedAt, options.verbose);
      return connected;
    } catch (error) {
      flushConnectOutput();
      throw error;
    }
  };

  const buildPromptStartedHook = (sessionId: string, attempt: number) => {
    // The mid-turn injection handler must be (re)registered on EVERY attempt
    // (including retries) so concurrently-arriving tasks reach the in-flight
    // turn. onPromptActive, by contrast, fires only on the first attempt.
    const needsInjectionHandler = options.setMidTurnHandler !== undefined;
    if (!needsInjectionHandler && (attempt !== 0 || !options.onPromptActive)) {
      return undefined;
    }
    return async () => {
      // Register the mid-turn injection handler now that the ACP prompt is
      // in-flight. Any task injected here calls client.prompt() concurrently
      // so the agent sees the new message via its Pushable input mid-turn
      // rather than waiting for the current turn to end. Each injected promise
      // is tracked so the turn can await all of them once it finishes.
      options.setMidTurnHandler?.((injectedTask: QueueTask) => {
        const injectedPromise = (async () => {
          const injectedPrompt = injectedTask.prompt ?? textPrompt(injectedTask.message);
          const injectedDeliveryContext = deliveryContextFor(injectedTask);
          try {
            await recordPromptStart(injectedPrompt, injectedTask.messageId);
            await appendDeliveryEvent(injectedDeliveryContext, "accepted");
            const injectedResponse = await client.prompt(
              sessionId,
              injectedPrompt,
              injectedTask.messageId !== undefined
                ? { messageId: injectedTask.messageId }
                : undefined,
            );
            await appendDeliveryTerminal(
              injectedDeliveryContext,
              deliveryPhaseForStopReason(injectedResponse.stopReason),
              { stopReason: toDeliveryStopReason(injectedResponse.stopReason) },
            );
            if (injectedTask.waitForCompletion) {
              injectedTask.send({
                type: "result",
                requestId: injectedTask.requestId,
                result: {
                  ...toPromptResult(injectedResponse.stopReason, record.acpxRecordId, client),
                  record,
                  resumed: true,
                },
              });
            }
          } catch (injectedError) {
            await appendDeliveryTerminal(injectedDeliveryContext, "failed", {
              error: deliveryErrorFrom(injectedError),
            }).catch(() => {});
            if (injectedTask.waitForCompletion) {
              const normalized = normalizeOutputError(injectedError, {
                origin: "runtime",
                detailCode: "MID_TURN_PROMPT_FAILED",
              });
              injectedTask.send({
                type: "error",
                requestId: injectedTask.requestId,
                code: normalized.code,
                detailCode: normalized.detailCode,
                origin: normalized.origin,
                message: normalized.message,
                retryable: normalized.retryable,
              });
            }
          } finally {
            injectedTask.close();
          }
        })();
        if (injectedTask.waitForCompletion) {
          injectedPromises.push(injectedPromise);
        }
      });
      if (attempt === 0 && options.onPromptActive) {
        try {
          await options.onPromptActive();
        } catch (error) {
          emitPromptHookError(error, options.verbose);
        }
      }
    };
  };

  const drainInjectedPrompts = async () => {
    // Clear the handler so no new concurrent calls are made, then await all
    // in-flight injected prompts. Without this the queue-owner loop could
    // start the next sequential task while an injected client.prompt() is
    // still running, pushing that next message into the injected turn's
    // context and cutting it short.
    options.setMidTurnHandler?.(undefined);
    if (injectedPromises.length > 0) {
      await Promise.allSettled(injectedPromises);
      injectedPromises.length = 0;
    }
  };

  const runPromptAttempt = async (sessionId: string, attempt: number) => {
    const promptStartedAt = Date.now();
    await appendDeliveryEvent(mainDeliveryContext, "accepted");
    const response = await measurePerf("runtime.prompt.agent_turn", async () => {
      return await runPromptTurn({
        client,
        sessionId,
        prompt: options.prompt,
        timeoutMs: options.timeoutMs,
        conversation,
        promptMessageId,
        messageId: options.messageId,
        onPromptStarted: buildPromptStartedHook(sessionId, attempt),
      });
    });
    // First turn done — stop injecting and await any in-flight injected prompts.
    await drainInjectedPrompts();
    emitPromptPerfMetric(promptStartedAt, options.verbose);
    return response;
  };

  const handlePromptFailure = async (error: unknown, attempt: number): Promise<"retry"> => {
    // Stop injecting and await in-flight injected prompts before deciding
    // whether to retry or fail (mirrors the success path).
    await drainInjectedPrompts();
    const snapshot = client.getAgentLifecycleSnapshot();
    if (
      shouldRetryRuntimePrompt(
        error,
        attempt,
        options.promptRetries ?? 0,
        snapshot,
        () => promptTurnHadSideEffects,
      )
    ) {
      await waitBeforePromptRetry(
        error,
        attempt,
        options.promptRetries ?? 0,
        options.suppressSdkConsoleErrors,
      );
      return promptTurnHadSideEffects ? await failRuntimePrompt(error, snapshot) : "retry";
    }
    return await failRuntimePrompt(error, snapshot);
  };

  const failRuntimePrompt = async (
    error: unknown,
    snapshot: ReturnType<AcpClient["getAgentLifecycleSnapshot"]>,
  ): Promise<never> => {
    promptTurnActive = false;
    applyLifecycleSnapshotToRecord(record, snapshot);
    emitPromptDisconnectNotice(snapshot, options.verbose);
    const normalizedError = normalizeOutputError(error, { origin: "runtime" });
    await flushPendingMessages(false).catch(() => {
      // best effort while bubbling prompt failure
    });
    await appendDeliveryTerminal(mainDeliveryContext, "failed", {
      error: {
        code: normalizedError.acp?.code ?? 0,
        message: normalizedError.message,
        detailCode: normalizedError.detailCode ?? "",
      },
    }).catch(() => {});
    output.flush();
    record.lastUsedAt = isoNow();
    applyConversation(record, conversation);
    record.acpx = acpxState;
    const propagated = error instanceof Error ? error : new Error(formatErrorMessage(error));
    (propagated as { outputAlreadyEmitted?: boolean }).outputAlreadyEmitted = sawAcpMessage;
    (propagated as { normalizedOutputError?: unknown }).normalizedOutputError = normalizedError;
    throw propagated;
  };

  const runPromptWithRetries = async (sessionId: string) => {
    promptTurnActive = true;
    for (let attempt = 0; ; attempt++) {
      try {
        return await runPromptAttempt(sessionId, attempt);
      } catch (error) {
        if ((await handlePromptFailure(error, attempt)) === "retry") {
          continue;
        }
      }
    }
  };

  const savePromptSuccess = async (response: Awaited<ReturnType<typeof runPromptTurn>>) => {
    await flushPendingMessages(false);
    output.flush();
    const now = isoNow();
    record.lastUsedAt = now;
    // NOTE: We intentionally do NOT touch `record.closed` / `record.closedAt` here.
    // Under the session-lifecycle-state ownership model (see
    // src/session/persistence/repository.ts docs + DESIGN.md), `closed` is
    // UI-authored user intent. Silently re-opening a closed session on any
    // successful turn violates that intent. `runSessionPrompt` already refuses to
    // run against a closed record (throws SessionClosedError), so reaching this
    // point means the session was open when the turn started and should remain
    // open — the default already on disk. Route any future lifecycle write here
    // through writeSessionRecordWithLifecycle.
    record.protocolVersion = client.initializeResult?.protocolVersion;
    record.agentCapabilities = client.initializeResult?.agentCapabilities;
    applyConversation(record, conversation);
    record.acpx = acpxState;
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    stopTotalTimer();
    return response;
  };

  try {
    return await withInterrupt(
      async () => {
        const { sessionId: activeSessionId, resumed, loadError } = await connectForPrompt();

        await applyPromptModelIfAdvertised({
          client,
          sessionId: activeSessionId,
          requestedModel: sessionOptions?.model,
          record,
          timeoutMs: options.timeoutMs,
        });

        output.setContext({
          sessionId: record.acpxRecordId,
        });
        await liveCheckpoint.checkpoint();

        const response = await savePromptSuccess(await runPromptWithRetries(activeSessionId));
        await appendDeliveryTerminal(
          mainDeliveryContext,
          deliveryPhaseForStopReason(response.stopReason),
          { stopReason: toDeliveryStopReason(response.stopReason) },
        );
        promptTurnActive = false;

        return {
          ...toPromptResult(response.stopReason, record.acpxRecordId, client),
          record,
          resumed,
          loadError,
        };
      },
      async () => {
        const response = await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
        if (response?.stopReason === "cancelled") {
          await appendDeliveryTerminal(mainDeliveryContext, "cancelled", {
            stopReason: "cancelled",
          }).catch(() => {});
        }
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.lastUsedAt = isoNow();
        applyConversation(record, conversation);
        record.acpx = acpxState;
        await flushPendingMessages(false).catch(() => {
          // best effort while process is being interrupted
        });
        if (ownClient) {
          await client.close();
        }
      },
    );
  } catch (error) {
    if (error instanceof InterruptedError) {
      await appendDeliveryTerminal(mainDeliveryContext, "cancelled", {
        stopReason: "cancelled",
      }).catch(() => {});
    } else {
      await appendDeliveryTerminal(mainDeliveryContext, "failed", {
        error: deliveryErrorFrom(error),
      }).catch(() => {});
    }
    throw error;
  } finally {
    if (options.verbose) {
      process.stderr.write(`[acpx] ${formatPerfMetric("prompt.total", stopTotalTimer())}\n`);
    } else {
      stopTotalTimer();
    }
    if (notifiedClientAvailable) {
      options.onClientClosed?.();
    }
    client.clearEventHandlers();
    if (ownClient) {
      await client.close();
    }
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    applyConversation(record, conversation);
    record.acpx = acpxState;
    await liveCheckpoint.flush().catch(() => {
      // best effort on close
    });
    await flushPendingMessages(false).catch(() => {
      // best effort on close
    });
    await preserveClosedState().catch(() => {
      // best effort on close
    });
    await eventWriter
      .appendMessage(
        {
          jsonrpc: "2.0",
          method: "acpx/turn",
          params: {
            phase: "idle",
            sessionId: record.acpxRecordId,
            at: new Date().toISOString(),
          },
        },
        { checkpoint: false },
      )
      .catch(() => {
        // best effort on close
      });
    await closeEventWriter(true).catch(() => {
      // best effort on close
    });
  }
}

export async function runOnce(options: RunOnceOptions): Promise<RunPromptResult> {
  const output = options.outputFormatter;
  let promptTurnActive = false;
  let promptTurnHadSideEffects = false;
  const client = new AcpClient({
    agentCommand: options.agentCommand,
    cwd: absolutePath(options.cwd),
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    onAcpMessage: options.onAcpMessage,
    onAcpOutputMessage: (_direction, message) => output.onAcpMessage(message),
    onSessionUpdate: (notification) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      options.onSessionUpdate?.(notification);
    },
    onClientOperation: (operation) => {
      if (promptTurnActive) {
        promptTurnHadSideEffects = true;
      }
      options.onClientOperation?.(operation);
    },
    onPermissionEscalation: (event) => {
      output.onPermissionEscalation(event);
      options.onPermissionEscalation?.(event);
    },
    sessionContext: {
      acpxRecordId: "",
      subscriptionId: options.sessionOptions?.subscription ?? null,
      profileId: options.sessionOptions?.profile ?? null,
    },
    sessionOptions: options.sessionOptions,
  });

  const runExecPromptAttempt = async (sessionId: string) => {
    return await measurePerf("runtime.exec.prompt", async () => {
      return await withTimeout(client.prompt(sessionId, options.prompt), options.timeoutMs);
    });
  };

  const runExecPromptWithRetries = async (sessionId: string) => {
    const maxRetries = options.promptRetries ?? 0;
    promptTurnActive = true;
    for (let attempt = 0; ; attempt++) {
      try {
        return await runExecPromptAttempt(sessionId);
      } catch (error) {
        if (shouldRetryPromptAttempt(error, attempt, maxRetries, () => promptTurnHadSideEffects)) {
          await waitBeforePromptRetry(error, attempt, maxRetries, options.suppressSdkConsoleErrors);
          if (!promptTurnHadSideEffects) {
            continue;
          }
        }
        promptTurnActive = false;
        throw error;
      }
    }
  };

  try {
    return await withInterrupt(
      async () => {
        await measurePerf("runtime.exec.start", async () => {
          await withTimeout(client.start(), options.timeoutMs);
        });
        const createdSession = await measurePerf("runtime.exec.create_session", async () => {
          return await withTimeout(
            client.createSession(absolutePath(options.cwd)),
            options.timeoutMs,
          );
        });
        const sessionId = createdSession.sessionId;
        await applyRequestedModelIfAdvertised({
          client,
          sessionId,
          requestedModel: options.sessionOptions?.model,
          models: createdSession.models,
          agentCommand: options.agentCommand,
          timeoutMs: options.timeoutMs,
        });
        // One-shot: no persisted record, so apply effort live for this turn only.
        await applyExecReasoningEffort({
          client,
          sessionId,
          reasoningEffort: options.sessionOptions?.reasoningEffort,
          advertised: createdSession.configOptions,
          modelId: options.sessionOptions?.model,
          timeoutMs: options.timeoutMs,
          verbose: options.verbose,
        });

        output.setContext({
          sessionId,
        });

        const response = await runExecPromptWithRetries(sessionId);
        promptTurnActive = false;
        output.flush();
        return toPromptResult(response.stopReason, sessionId, client);
      },
      async () => {
        await client.cancelActivePrompt(INTERRUPT_CANCEL_WAIT_MS);
        await client.close();
      },
    );
  } finally {
    await client.close();
  }
}

export async function sendSessionDirect(options: SessionSendOptions): Promise<SessionSendResult> {
  return await runSessionPrompt({
    sessionRecordId: options.sessionId,
    prompt: options.prompt,
    messageId: options.messageId,
    mcpServers: options.mcpServers,
    permissionMode: options.permissionMode,
    resumePolicy: options.resumePolicy,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    outputFormatter: options.outputFormatter,
    onAcpMessage: options.onAcpMessage,
    onSessionUpdate: options.onSessionUpdate,
    onClientOperation: options.onClientOperation,
    onPermissionEscalation: options.onPermissionEscalation,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    client: options.client,
  });
}
