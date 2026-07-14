import os from "node:os";
import path from "node:path";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { EffectiveAccountMetadata } from "../../acp/auth-env.js";
import { AcpClient } from "../../acp/client.js";
import {
  formatErrorMessage,
  isRetryablePromptError,
  normalizeOutputError,
} from "../../acp/error-normalization.js";
import {
  injectionAbsorbsIntoActiveTurn,
  injectionReturnsTerminalResponse,
} from "../../acp/mid-turn-injection-support.js";
import { assertRequestedModelSupported } from "../../acp/model-support.js";
import { InterruptedError, withInterrupt, withTimeout } from "../../async-control.js";
import { tailClaudeSubagentJsonl } from "../../claude-jsonl.js";
import { transcriptCwdHash } from "../../config/subscription-transcript.js";
import {
  AllSubscriptionsExhaustedError,
  BridgeAuthGatedError,
  PermissionPromptUnavailableError,
  SessionClosedError,
} from "../../errors.js";
import {
  attemptFailoverAndRetry,
  classifyFailover,
  enforceSubscriptionLockBeforeTurn,
  failoverEnabled,
  failoverEnabledForRecord,
  isSubscriptionLockBlockError,
} from "../../runtime/engine/failover.js";
export { InterruptedError, TimeoutError } from "../../async-control.js";
import { formatPerfMetric, measurePerf, startPerfTimer } from "../../perf-metrics.js";
import { textPrompt } from "../../prompt-content.js";
import { bindRecordToDefaultAccount } from "../../runtime/engine/default-account-binding.js";
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
  hasUserMessageId,
  recordClientOperation as recordConversationClientOperation,
  recordPromptSubmission,
  recordSessionUpdate as recordConversationSessionUpdate,
  stampSteerBoundaryUuid,
  trimConversationForRuntime,
} from "../../session/conversation-model.js";
import { withDefaultModelForNewSession } from "../../session/default-model.js";
import {
  buildDeliveryEvent,
  hasCompletedDeliveryFor,
  type DeliveryEventError,
  type DeliveryPhase,
  type DeliveryStopReason,
} from "../../session/delivery-events.js";
import { defaultSessionEventLog } from "../../session/event-log.js";
import { listSessionEvents, SessionEventWriter } from "../../session/events.js";
import { LiveSessionCheckpoint } from "../../session/live-checkpoint.js";
import { copyLoggedMessageCount } from "../../session/messages-log-bookkeeping.js";
import {
  mergeLatestDurableAcpxPreferences,
  setCurrentModelId,
  setDesiredModelId,
} from "../../session/mode-preference.js";
import { applyRequestedModelIfAdvertised } from "../../session/model-application.js";
import {
  ownerOptionsToInput,
  persistSessionOwnerOptions,
  resolveSessionOwnerOptions,
} from "../../session/owner-options.js";
import { persistTerminalTurnError } from "../../session/persist-terminal-error.js";
import {
  absolutePath,
  isoNow,
  readPersistedLifecycle,
  resolveSessionRecord,
  writeSessionRecord,
  writeSessionRecordAtBoundary,
  type PersistedSessionLifecycle,
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
  type SessionNotification,
  SessionSendResult,
  SubagentRef,
} from "../../types.js";
import { type QueueOwnerMessage, type QueueTask, waitMs } from "../queue/ipc.js";
import { type QueueOwnerActiveSessionController } from "../queue/owner-turn-controller.js";
import { resolveAndEnsureAgentFolder } from "./agent-folder.js";
import { resolveExistingBrickPath } from "./brick-link.js";
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

type AbsorbedInjectedDelivery = {
  context: DeliveryContext;
  task: QueueTask;
  closed: boolean;
  terminalWritten: boolean;
};

// A tracked (awaited) mid-turn-injected prompt: its promise, its delivery
// context, and whether it has settled — so the C3 drain backstop can write a
// terminal for one still pending when the backstop fires.
type TrackedInjectedDelivery = {
  promise: Promise<void>;
  context: DeliveryContext | undefined;
  settled: boolean;
};

type PromptStartResult = {
  messageId: string | undefined;
  deduplicated: boolean;
  record?: SessionRecord;
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

const EMPTY_PERMISSION_STATS: RunPromptResult["permissionStats"] = {
  requested: 0,
  approved: 0,
  denied: 0,
  cancelled: 0,
};

function toDeliveryStopReason(stopReason: RunPromptResult["stopReason"]): DeliveryStopReason {
  return DELIVERY_STOP_REASONS.has(stopReason) ? (stopReason as DeliveryStopReason) : null;
}

function deliveryPhaseForStopReason(
  stopReason: RunPromptResult["stopReason"],
): Exclude<DeliveryPhase, "accepted"> {
  return stopReason === "cancelled" ? "cancelled" : "done";
}

/**
 * Read the pre-steer transcript tail uuid the bridge stamps on a mid-turn steer
 * ack (`_meta.steerBoundaryUuid`). Used to stamp durable byway-fork provenance
 * onto the steer's User entry (A3).
 */
function readSteerBoundaryUuid(
  meta: { [key: string]: unknown } | null | undefined,
): string | undefined {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const value = (meta as Record<string, unknown>).steerBoundaryUuid;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function deliveryErrorFrom(error: unknown): DeliveryEventError {
  const normalized = normalizeOutputError(error, { origin: "runtime" });
  return {
    code: normalized.acp?.code ?? 0,
    message: normalized.message,
    detailCode: normalized.detailCode ?? "",
    ...(normalized.effectiveAccount?.effectiveAccount !== undefined
      ? { effectiveAccount: normalized.effectiveAccount.effectiveAccount }
      : {}),
  };
}

async function resolveRecordIfPromptAlreadyPersisted(
  sessionRecordId: string,
  messageId: string,
): Promise<SessionRecord | undefined> {
  const latestRecord = await resolveSessionRecord(sessionRecordId);
  if (!hasUserMessageId(cloneSessionConversation(latestRecord), messageId)) {
    return undefined;
  }
  // Persistence alone is not proof of delivery: recordPromptStart writes the User message
  // BEFORE the turn runs, so a turn that failed/never-completed leaves an orphaned prompt.
  // Only dedup when a real completion terminal exists for this messageId (Defect B, 182d241f).
  const events = await listSessionEvents(latestRecord.acpxRecordId);
  return hasCompletedDeliveryFor(events, messageId) ? latestRecord : undefined;
}

// The sentinel SessionEventWriter throws once closed (src/session/events.ts).
// C2 keys the standalone-writer fallback on it.
function isClosedEventWriterError(error: unknown): boolean {
  return error instanceof Error && error.message === "SessionEventWriter is closed";
}

async function appendDeduplicatedDeliveryTerminal(
  record: SessionRecord,
  context: DeliveryContext | undefined,
): Promise<void> {
  if (!context) {
    return;
  }
  const eventWriter = await SessionEventWriter.open(record);
  try {
    await eventWriter.appendMessage(
      buildDeliveryEvent({
        messageId: context.messageId,
        requestId: context.requestId,
        phase: "done",
        stopReason: "deduplicated",
      }),
    );
  } finally {
    await eventWriter.close({ checkpoint: true });
  }
}

function deduplicatedSessionSendResult(record: SessionRecord): SessionSendResult {
  return {
    stopReason: "end_turn",
    sessionId: record.acpxRecordId,
    permissionStats: { ...EMPTY_PERMISSION_STATS },
    record,
    resumed: true,
  };
}

// Drain-backstop default: how long the turn waits for injected prompts to
// settle before finalizing anyway. Generous on purpose (30 min) so a normal
// long injected turn (the incident's was a normal ~10 min turn) is NEVER
// truncated — truncating is the very bug this fix removes. Override via
// ACPX_INJECTED_DRAIN_TIMEOUT_MS; explicit `0` ⇒ unbounded (rely on the
// injected IIFE's error-isolation + rejection-on-owner-death alone).
const DEFAULT_INJECTED_DRAIN_TIMEOUT_MS = 1_800_000;

function resolveInjectedDrainTimeoutMs(): number {
  const raw = process.env.ACPX_INJECTED_DRAIN_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") {
    return DEFAULT_INJECTED_DRAIN_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  // Negative / NaN ⇒ fall back to the generous default rather than disabling
  // the backstop by accident; only an explicit `0` means unbounded.
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INJECTED_DRAIN_TIMEOUT_MS;
  }
  return parsed;
}

export type DrainInjectedPromptsResult = {
  timedOut: boolean;
  /** Injected prompts still unsettled when the backstop fired (0 if it didn't). */
  pending: number;
};

/**
 * Await a set of injected-prompt promises, bounded by a single shared backstop
 * deadline. On `timeoutMs <= 0` the wait is unbounded. On expiry it resolves
 * `{ timedOut: true, pending }` and invokes `onTimeout(pending)` once, leaving
 * the still-pending injected prompts running (they remain error-isolated) so
 * the turn can finalize instead of wedging the queue owner forever.
 *
 * The timer is cleared on normal settle (and `unref`'d while pending) so it can
 * never hold the event loop open. The injected promises never reject (the
 * injection IIFE wraps everything in try/catch/finally), but both settle paths
 * are counted defensively.
 */
export async function drainInjectedPromptsWithBackstop(
  injectedPromises: ReadonlyArray<Promise<void>>,
  timeoutMs: number,
  onTimeout: (pending: number) => void,
): Promise<DrainInjectedPromptsResult> {
  if (injectedPromises.length === 0) {
    return { timedOut: false, pending: 0 };
  }
  const total = injectedPromises.length;
  let settledCount = 0;
  const markSettled = () => {
    settledCount += 1;
  };
  const settleAll = Promise.allSettled(
    injectedPromises.map((promise) => promise.then(markSettled, markSettled)),
  );
  if (timeoutMs <= 0) {
    await settleAll;
    return { timedOut: false, pending: 0 };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
    timer.unref?.();
    void settleAll.then(() => resolve(false));
  });
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  const pending = total - settledCount;
  if (timedOut) {
    onTimeout(pending);
  }
  return { timedOut, pending };
}

// --- C1: turn-completion watchdog (G1) -------------------------------------
// The adapter's own end-of-turn marker: the terminal `usage_update` carrying
// `_meta._claude/lastTurnEndReason` (the same signal acpx-ui reads). It rides on
// a REAL message and can appear on either the notification-level or the
// update-level `_meta`. Seeing it proves the SDK turn ended; if the response is
// then still overdue, the response was withheld (the adapter routing hole, RCA
// §1.2) and the watchdog recovers — a turn with NO marker never triggers, so
// genuinely long-running work can never be truncated.
const CLAUDE_TURN_END_MARKER_META_KEY = "_claude/lastTurnEndReason";

function readTurnEndReason(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const value = (meta as Record<string, unknown>)[CLAUDE_TURN_END_MARKER_META_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function turnEndReasonFromNotification(notification: SessionNotification): string | undefined {
  const update = (notification as { update?: unknown }).update as
    | Record<string, unknown>
    | undefined;
  if (!update || update.sessionUpdate !== "usage_update") {
    return undefined;
  }
  return (
    readTurnEndReason((notification as { _meta?: unknown })._meta) ??
    readTurnEndReason(update._meta)
  );
}

// Genuine completions the end-marker can report. Used for the Q2 reconciliation:
// when tier-1's cancel recovers a turn whose marker already reported one of these,
// the delivery terminal reports that semantic truth rather than the `cancelled`
// our own nudge produced.
const COMPLETION_TURN_END_REASONS = new Set(["end_turn", "max_tokens", "max_turns"]);

function reconcileStopReasonWithMarker(
  rawStopReason: RunPromptResult["stopReason"],
  endMarkerReason: string | undefined,
): RunPromptResult["stopReason"] {
  if (
    rawStopReason === "cancelled" &&
    endMarkerReason !== undefined &&
    COMPLETION_TURN_END_REASONS.has(endMarkerReason)
  ) {
    return endMarkerReason as RunPromptResult["stopReason"];
  }
  return rawStopReason;
}

// Tier-2 turn-response timeout: retryable + a stable detailCode the UI (D-lane)
// keys on. `normalizeOutputError` reads `detailCode`/`retryable` straight off the
// error instance.
export class TurnResponseTimeoutError extends Error {
  readonly detailCode = "TURN_RESPONSE_TIMEOUT";
  readonly retryable = true;
  constructor(sessionId: string, totalMs: number) {
    super(
      `Turn response overdue for session ${sessionId}: end-of-turn marker seen but no response after ${totalMs}ms`,
    );
    this.name = "TurnResponseTimeoutError";
  }
}

// Per-tier response-overdue bound (Q1 default 120 s ⇒ ~4 min worst case to a
// tier-2 failure). Override via ACPX_TURN_RESPONSE_TIMEOUT_MS; a non-positive /
// NaN value falls back to the default rather than disabling the watchdog.
const DEFAULT_TURN_RESPONSE_TIMEOUT_MS = 120_000;

function resolveTurnResponseTimeoutMs(): number {
  const raw = process.env.ACPX_TURN_RESPONSE_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") {
    return DEFAULT_TURN_RESPONSE_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TURN_RESPONSE_TIMEOUT_MS;
  }
  return parsed;
}

type TurnWatchdogOptions = {
  timeoutMs: number;
  sessionId: string;
  // Tier 1 (nudge): the SDK turn ended but the response is overdue — cancel the
  // active prompt so the withheld response/cancel result settles through the
  // adapter's existing cancel path. No work is lost (the marker proved the turn
  // already ended).
  onTier1: () => void;
  // Tier 2 (bound): still unsettled a second interval later — abandon the turn.
  // Runs just before the guarded turn promise is rejected so late continuations
  // can be suppressed.
  onTier2Abandon: () => void;
  log: (tier: 1 | 2, elapsedMs: number) => void;
};

/**
 * Bounds a main-turn `client.prompt()` await once the adapter has emitted its
 * end-of-turn marker. Two tiers, each `timeoutMs` apart: tier 1 nudges (cancel),
 * tier 2 rejects the guarded promise with a retryable {@link TurnResponseTimeoutError}.
 * The clock only starts when {@link noteEndMarker} is called from the production
 * session-update tap — no marker, no timers, so live work is never truncated.
 */
class TurnWatchdog {
  private endMarkerSeenAt: number | undefined;
  private tier1Timer: ReturnType<typeof setTimeout> | undefined;
  private tier2Timer: ReturnType<typeof setTimeout> | undefined;
  private rejectTurn: ((error: unknown) => void) | undefined;
  private disposed = false;

  constructor(private readonly options: TurnWatchdogOptions) {}

  noteEndMarker(): void {
    if (this.disposed || this.endMarkerSeenAt !== undefined) {
      return;
    }
    this.endMarkerSeenAt = Date.now();
    const { timeoutMs } = this.options;
    this.tier1Timer = setTimeout(() => {
      this.options.log(1, timeoutMs);
      this.options.onTier1();
    }, timeoutMs);
    this.tier1Timer.unref?.();
    this.tier2Timer = setTimeout(() => {
      this.options.log(2, timeoutMs * 2);
      this.options.onTier2Abandon();
      this.rejectTurn?.(new TurnResponseTimeoutError(this.options.sessionId, timeoutMs * 2));
    }, timeoutMs * 2);
    this.tier2Timer.unref?.();
  }

  async guard<T>(turnPromise: Promise<T>): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      this.rejectTurn = reject;
      turnPromise.then(
        (value) => {
          this.dispose();
          resolve(value);
        },
        (error) => {
          this.dispose();
          reject(error);
        },
      );
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.tier1Timer) {
      clearTimeout(this.tier1Timer);
      this.tier1Timer = undefined;
    }
    if (this.tier2Timer) {
      clearTimeout(this.tier2Timer);
      this.tier2Timer = undefined;
    }
    this.rejectTurn = undefined;
  }
}

function attachEffectiveAccountMetadata(
  error: unknown,
  metadata: EffectiveAccountMetadata | undefined,
): unknown {
  if (metadata === undefined || !error || typeof error !== "object") {
    return error;
  }
  const target = error as { effectiveAccountMetadata?: EffectiveAccountMetadata };
  target.effectiveAccountMetadata ??= metadata;
  return error;
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
    effectiveAccount: normalizedError.effectiveAccount,
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
    // profile/account. The owner uses it to recycle its stale shared client so
    // subsequent turns cold-spawn on the new transcript anchor.
    onFailoverSwitched?: (newProfileId: string) => void;
    onLockBlocked?: () => void;
  },
): Promise<void> {
  const outputFormatter = task.waitForCompletion
    ? new QueueTaskOutputFormatter(task)
    : DISCARD_OUTPUT_FORMATTER;

  try {
    let result: SessionSendResult;
    try {
      const lockPolicy = await applyQueuedTaskSubscriptionLockPolicy(sessionRecordId, options);
      result = await runSessionPrompt({
        ...buildQueuedTaskRunOptions(sessionRecordId, task, options, outputFormatter),
        ...(lockPolicy.useFreshClient ? { client: undefined } : {}),
      });
    } catch (error) {
      result = await runQueuedTaskFailover(sessionRecordId, task, options, outputFormatter, error);
    }
    sendQueuedTaskResult(task, result);
  } catch (error) {
    if (isSubscriptionLockBlockError(error)) {
      options.onLockBlocked?.();
    }
    sendQueuedTaskError(task, error);
    if (error instanceof InterruptedError) {
      throw error;
    }
  } finally {
    task.close();
  }
}

async function applyQueuedTaskSubscriptionLockPolicy(
  sessionRecordId: string,
  options: QueuedTaskRuntimeOptions,
): Promise<{ useFreshClient: boolean }> {
  const record = await resolveSessionRecord(sessionRecordId);
  if (bindRecordToDefaultAccount(record)) {
    await writeSessionRecord(record);
  }
  try {
    const outcome = await enforceSubscriptionLockBeforeTurn(record);
    if (outcome.switchedTo) {
      options.onFailoverSwitched?.(outcome.switchedTo);
      return { useFreshClient: true };
    }
  } catch (error) {
    if (isSubscriptionLockBlockError(error)) {
      await persistTerminalTurnError(record, error).catch(() => {});
    }
    throw error;
  }
  return { useFreshClient: false };
}

// Failover eligibility gate: returns the session record when this turn error
// should attempt account failover, or null to rethrow the original error.
// Null when the error is not failover-classified, the box has no provider
// registry, or the selected/default profile has no portable transcript anchor.
async function resolveFailoverRecord(
  sessionRecordId: string,
  error: unknown,
): Promise<SessionRecord | null> {
  if (!classifyFailover(error) || !failoverEnabled()) {
    return null;
  }
  const record = await resolveSessionRecord(sessionRecordId);
  if (!failoverEnabledForRecord(record)) {
    return null;
  }
  return record;
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
  const record = await resolveFailoverRecord(sessionRecordId, error);
  if (!record) {
    throw error;
  }
  let outcome: { result: SessionSendResult; switchedTo: string };
  try {
    outcome = await attemptFailoverAndRetry<SessionSendResult>({
      record,
      triggerError: error,
      verbose: options.verbose,
      runTurn: async () =>
        // Fresh client (omit sharedClient) so the retry resolves the new dir.
        await runSessionPrompt({
          ...buildQueuedTaskRunOptions(sessionRecordId, task, options, outputFormatter),
          client: undefined,
        }),
    });
  } catch (failoverError) {
    // Exhausting all subscriptions throws AllSubscriptionsExhaustedError, and an
    // auth-gated bridge pool throws BridgeAuthGatedError — both acpx-synthesized
    // terminal errors that are never an ACP message, so the onAcpMessage tap
    // never persists them to the session `.stream.ndjson`. Write them there
    // explicitly so acpx-ui's stream-tail derivation surfaces their detailCode
    // (`all-subscriptions-exhausted` → exhausted banner; `auth-gated` →
    // AuthGatedBanner). Best-effort — persistence failure must not swallow the
    // turn error, which still reaches the CLI output layer via
    // sendQueuedTaskError below.
    if (
      failoverError instanceof AllSubscriptionsExhaustedError ||
      failoverError instanceof BridgeAuthGatedError ||
      isSubscriptionLockBlockError(failoverError)
    ) {
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
  if (bindRecordToDefaultAccount(record)) {
    await writeSessionRecord(record);
  }
  try {
    await enforceSubscriptionLockBeforeTurn(record);
  } catch (error) {
    if (isSubscriptionLockBlockError(error)) {
      await persistTerminalTurnError(record, error).catch(() => {});
    }
    throw error;
  }

  const conversation = cloneSessionConversation(record);
  let acpxState = cloneSessionAcpxState(record.acpx);
  const mainDeliveryContext = deliveryContextFor(options);

  const recordPromptStart = async (
    prompt: PromptInput | string,
    messageId?: string,
  ): Promise<PromptStartResult> => {
    if (messageId !== undefined) {
      const deduplicatedRecord = await resolveRecordIfPromptAlreadyPersisted(
        options.sessionRecordId,
        messageId,
      );
      if (deduplicatedRecord) {
        return { messageId, deduplicated: true, record: deduplicatedRecord };
      }
    }

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
    await writeSessionRecordAtBoundary(record);
    copyLoggedMessageCount(record, conversation);
    return { messageId: promptMessageId, deduplicated: false };
  };

  const promptStart = await recordPromptStart(options.prompt, options.messageId);
  const promptMessageId = promptStart.messageId;

  output.setContext({
    sessionId: record.acpxRecordId,
  });

  if (promptStart.deduplicated) {
    const deduplicatedRecord = promptStart.record ?? record;
    await appendDeduplicatedDeliveryTerminal(deduplicatedRecord, mainDeliveryContext);
    return deduplicatedSessionSendResult(deduplicatedRecord);
  }

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
  // otherwise a second concurrent client.prompt() would cut an injected turn
  // short. Each carries its delivery context + a settled flag so the drain
  // backstop (C3) can write a terminal for one still pending when it fires.
  const injectedDeliveries: TrackedInjectedDelivery[] = [];
  // Backend is constant per session, so resolve once: whether an injected prompt
  // to this backend returns a terminal response and can therefore be safely
  // awaited (drained) even when waitForCompletion is false. True for Claude /
  // claude-pty (both terminate); false for Codex (acts on the steer in-turn,
  // returns no terminal) and unknown backends — they stay fire-and-forget.
  const awaitInjectedPrompt = injectionReturnsTerminalResponse(record.agentCommand);
  // Codex no-wait steers are absorbed into the active turn and never produce a
  // per-injection JSON-RPC terminal. Track their accepted delivery ids so the
  // containing turn can close those exact lifecycles when it ends.
  const completeAbsorbedInjectedNoWait = injectionAbsorbsIntoActiveTurn(record.agentCommand);
  const absorbedInjectedDeliveries: AbsorbedInjectedDelivery[] = [];
  let sawAcpMessage = false;
  let eventWriterClosed = false;
  const acceptedDeliveryKeys = new Set<string>();
  const terminalDeliveryKeys = new Set<string>();
  // C1 turn-completion watchdog. Backend-gated to the same set that returns a
  // terminal per turn (Claude / claude-pty) — the `_claude/*`-namespaced marker
  // only exists there. `activeTurnWatchdog` is the per-attempt instance the
  // production session-update tap feeds; `turnAbandoned` suppresses a tier-2
  // abandoned turn's late continuations; `endMarkerReasonThisTurn` carries the
  // marker's reason for the Q2 stop-reason reconciliation.
  const turnWatchdogEnabled = awaitInjectedPrompt;
  let activeTurnWatchdog: TurnWatchdog | undefined;
  let turnAbandoned = false;
  let endMarkerReasonThisTurn: string | undefined;

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
    // C2 (G2): a late-settling injected IIFE writes its terminal after the turn
    // finalized and closed the per-turn writer. Rather than swallow that write
    // (the accepted-forever bug), fall back to a fresh standalone writer — the
    // exact precedent used by appendDeduplicatedDeliveryTerminal. The dedup
    // bookkeeping below is unchanged, so the one-terminal invariant holds.
    await writeDurableDeliveryEvent(
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

  const writeDurableDeliveryEvent = async (event: AcpJsonRpcMessage): Promise<void> => {
    if (!eventWriterClosed) {
      try {
        await eventWriter.appendMessage(event);
        return;
      } catch (error) {
        if (!isClosedEventWriterError(error)) {
          throw error;
        }
        // Writer was closed under us — fall through to the standalone path.
      }
    }
    const standalone = await SessionEventWriter.open(record);
    try {
      await standalone.appendMessage(event);
    } finally {
      await standalone.close({ checkpoint: true });
    }
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

  const closeAbsorbedInjectedDelivery = (delivery: AbsorbedInjectedDelivery): void => {
    if (delivery.closed) {
      return;
    }
    delivery.closed = true;
    delivery.task.close();
  };

  const completeAbsorbedInjectedDeliveries = async (
    phase: Exclude<DeliveryPhase, "accepted">,
    params: {
      stopReason?: DeliveryStopReason;
      error?: DeliveryEventError;
    } = {},
  ): Promise<void> => {
    if (absorbedInjectedDeliveries.length === 0) {
      return;
    }
    const deliveries = absorbedInjectedDeliveries.splice(0);
    for (const delivery of deliveries) {
      if (!delivery.terminalWritten) {
        await appendDeliveryTerminal(delivery.context, phase, params);
        delivery.terminalWritten = true;
      }
      closeAbsorbedInjectedDelivery(delivery);
    }
  };

  const createAbsorbedInjectedDelivery = (
    task: QueueTask,
    context: DeliveryContext | undefined,
  ): AbsorbedInjectedDelivery | undefined => {
    if (!completeAbsorbedInjectedNoWait || task.waitForCompletion || !context) {
      return undefined;
    }
    const delivery: AbsorbedInjectedDelivery = {
      context,
      task,
      closed: false,
      terminalWritten: false,
    };
    absorbedInjectedDeliveries.push(delivery);
    return delivery;
  };

  const markAbsorbedDeliveryTerminalWritten = (
    delivery: AbsorbedInjectedDelivery | undefined,
  ): void => {
    if (delivery) {
      delivery.terminalWritten = true;
    }
  };

  const maybeStampInjectedSteerBoundary = async (
    injectedMessageId: string | undefined,
    injectedResponse: PromptResponse,
  ): Promise<void> => {
    // Durable byway-fork provenance (A3): a mid-turn steer produces no
    // distinct claude user record, so the bridge hands back the pre-steer
    // transcript tail uuid in the steer ack `_meta.steerBoundaryUuid`.
    // Stamp it onto the steer's User entry as the contract's primary
    // signal. Note: `recordPromptStart` already finalized this entry
    // to the append-only messages_log with its inherit-preceding value
    // (= the preceding Agent's claudeUuid = the same pre-steer tail, equal
    // by construction — see CONTRACT §2), so that inherited value is what
    // the fork resolver durably reads. This stamp keeps the live record in
    // sync with the bridge-authoritative uuid (and is picked up by a later
    // log compaction rewrite); it does not rewrite the committed log line.
    const steerBoundaryUuid = readSteerBoundaryUuid(injectedResponse._meta);
    if (!injectedMessageId || !steerBoundaryUuid) {
      return;
    }
    // C2 record-integrity guard (RCA §2): once the turn has finalized, `record`
    // holds the dead turn's conversation snapshot. Stamping + persisting it here
    // (a late injected settle) would clobber the finalized record with stale
    // state. The stamp is best-effort provenance the log-compaction rewrite also
    // recovers, so skip it rather than persist a stale snapshot.
    if (eventWriterClosed) {
      return;
    }
    stampSteerBoundaryUuid(conversation, injectedMessageId, steerBoundaryUuid);
    applyConversation(record, conversation);
    await writeSessionRecordAtBoundary(record);
  };

  const sendInjectedResultIfWaiting = (
    injectedTask: QueueTask,
    injectedResponse: PromptResponse,
  ): void => {
    if (!injectedTask.waitForCompletion) {
      return;
    }
    injectedTask.send({
      type: "result",
      requestId: injectedTask.requestId,
      result: {
        ...toPromptResult(injectedResponse.stopReason, record.acpxRecordId, client),
        record,
        resumed: true,
      },
    });
  };

  const sendInjectedDeduplicatedResultIfWaiting = (
    injectedTask: QueueTask,
    deduplicatedRecord: SessionRecord,
  ): void => {
    if (!injectedTask.waitForCompletion) {
      return;
    }
    injectedTask.send({
      type: "result",
      requestId: injectedTask.requestId,
      result: {
        ...toPromptResult("end_turn", record.acpxRecordId, client),
        record: deduplicatedRecord,
        resumed: true,
      },
    });
  };

  const sendInjectedErrorIfWaiting = (injectedTask: QueueTask, injectedError: unknown): void => {
    if (!injectedTask.waitForCompletion) {
      return;
    }
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
  };

  const handleInjectedPromptResponse = async (
    injectedTask: QueueTask,
    injectedDeliveryContext: DeliveryContext | undefined,
    injectedMessageId: string | undefined,
    injectedResponse: PromptResponse,
    absorbedDelivery: AbsorbedInjectedDelivery | undefined,
  ): Promise<void> => {
    await maybeStampInjectedSteerBoundary(injectedMessageId, injectedResponse);
    await appendDeliveryTerminal(
      injectedDeliveryContext,
      deliveryPhaseForStopReason(injectedResponse.stopReason),
      { stopReason: toDeliveryStopReason(injectedResponse.stopReason) },
    );
    markAbsorbedDeliveryTerminalWritten(absorbedDelivery);
    sendInjectedResultIfWaiting(injectedTask, injectedResponse);
  };

  const handleInjectedPromptError = async (
    injectedTask: QueueTask,
    injectedDeliveryContext: DeliveryContext | undefined,
    injectedError: unknown,
    absorbedDelivery: AbsorbedInjectedDelivery | undefined,
  ): Promise<void> => {
    await appendDeliveryTerminal(injectedDeliveryContext, "failed", {
      error: deliveryErrorFrom(injectedError),
    }).catch(() => {});
    markAbsorbedDeliveryTerminalWritten(absorbedDelivery);
    sendInjectedErrorIfWaiting(injectedTask, injectedError);
  };

  const closeInjectedTask = (
    injectedTask: QueueTask,
    absorbedDelivery: AbsorbedInjectedDelivery | undefined,
  ): void => {
    if (absorbedDelivery) {
      closeAbsorbedInjectedDelivery(absorbedDelivery);
      return;
    }
    injectedTask.close();
  };

  const runInjectedPromptTask = async (
    sessionId: string,
    injectedTask: QueueTask,
  ): Promise<void> => {
    const injectedPrompt = injectedTask.prompt ?? textPrompt(injectedTask.message);
    const injectedDeliveryContext = deliveryContextFor(injectedTask);
    let absorbedDelivery: AbsorbedInjectedDelivery | undefined;
    try {
      const injectedPromptStart = await recordPromptStart(injectedPrompt, injectedTask.messageId);
      if (injectedPromptStart.deduplicated) {
        await appendDeliveryTerminal(injectedDeliveryContext, "done", {
          stopReason: "deduplicated",
        });
        sendInjectedDeduplicatedResultIfWaiting(injectedTask, injectedPromptStart.record ?? record);
        return;
      }
      const injectedMessageId = injectedPromptStart.messageId;
      await appendDeliveryEvent(injectedDeliveryContext, "accepted");
      const injectedResponsePromise = client.prompt(
        sessionId,
        injectedPrompt,
        injectedTask.messageId !== undefined ? { messageId: injectedTask.messageId } : undefined,
      );
      absorbedDelivery = createAbsorbedInjectedDelivery(injectedTask, injectedDeliveryContext);
      const injectedResponse = await injectedResponsePromise;
      await handleInjectedPromptResponse(
        injectedTask,
        injectedDeliveryContext,
        injectedMessageId,
        injectedResponse,
        absorbedDelivery,
      );
    } catch (injectedError) {
      await handleInjectedPromptError(
        injectedTask,
        injectedDeliveryContext,
        injectedError,
        absorbedDelivery,
      );
    } finally {
      closeInjectedTask(injectedTask, absorbedDelivery);
    }
  };

  // Subagent tracking: map from agent_id (e.g. "poet-a@haiku-demo") to ACPX record id
  const subagentIdToAcpxRecordId = new Map<string, string>();
  // Subagent in-memory records: populated immediately on teammate_spawned, before disk write completes
  const subagentRecordsById = new Map<string, SessionRecord>();
  // Subagent event writers: map from ACPX record id to event writer
  const subagentEventWriters = new Map<string, SessionEventWriter>();
  // Subagent JSONL tailers: map from ACPX record id to stop function
  const subagentTailers = new Map<string, { stop: () => Promise<void> }>();
  const subagentSaveChains = new Map<string, Promise<void>>();

  const enqueueSubagentBoundaryWrite = (
    childAcpxRecordId: string,
    childRecord: SessionRecord,
  ): Promise<void> => {
    const previous = subagentSaveChains.get(childAcpxRecordId) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // Preserve ordering after a best-effort write failure.
      })
      .then(async () => {
        await writeSessionRecordAtBoundary(childRecord);
      });
    subagentSaveChains.set(childAcpxRecordId, next);
    void next.finally(() => {
      if (subagentSaveChains.get(childAcpxRecordId) === next) {
        subagentSaveChains.delete(childAcpxRecordId);
      }
    });
    return next;
  };

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
    await Promise.all([...subagentSaveChains.values()].map((save) => save.catch(() => {})));
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
  const applyPersistedClosedState = (persisted: PersistedSessionLifecycle | undefined): void => {
    if (!persisted?.closed) {
      return;
    }

    record.closed = true;
    record.closedAt = persisted.closedAt ?? record.closedAt ?? isoNow();
    record.pid = persisted.pid;
    if (persisted.acpx) {
      record.acpx = {
        ...record.acpx,
        ...persisted.acpx,
      };
    }
  };
  const preserveClosedState = async (): Promise<void> => {
    applyPersistedClosedState(await readPersistedLifecycle(record.acpxRecordId));
  };
  const mergeLatestDurablePreferences = (
    persisted: PersistedSessionLifecycle | undefined,
  ): void => {
    acpxState = cloneSessionAcpxState(
      mergeLatestDurableAcpxPreferences(acpxState, persisted?.acpx),
    );
    record.acpx = acpxState;
  };
  const mergeLatestDurablePreferencesFromDisk = async (): Promise<void> => {
    mergeLatestDurablePreferences(await readPersistedLifecycle(record.acpxRecordId));
  };
  const liveCheckpoint = new LiveSessionCheckpoint({
    save: async () => {
      await flushPendingMessages(false);
      record.lastUsedAt = isoNow();
      applyConversation(record, conversation);
      // One pre-read feeds the closed-state merge and lifecycle preserve; the
      // write path separately rereads metadata so external metadata patches win
      // over stale owner state (W11).
      const persisted = await readPersistedLifecycle(record.acpxRecordId);
      mergeLatestDurablePreferences(persisted);
      applyPersistedClosedState(persisted);
      await eventWriter.checkpoint({ persistedLifecycle: { value: persisted } });
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
  const brick = record.metadata?.brick?.trim() || null;
  const brickPath = brick ? resolveExistingBrickPath(brick) : null;
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
        sessionName: record.name ?? null,
        parentSessionId: record.parentSessionId ?? null,
        taskFolder: record.metadata?.task_folder ?? null,
        brick,
        brickPath,
        agentFolder: resolveAndEnsureAgentFolder(record, brickPath),
        subscriptionId: record.acpx?.session_options?.subscription ?? null,
        profileId: record.acpx?.session_options?.profile ?? null,
        reasoningEffort: sessionOptions?.reasoningEffort ?? null,
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
                    void enqueueSubagentBoundaryWrite(childAcpxRecordId, childRecord).catch(
                      () => {},
                    );
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
      // C1: the watchdog listens on the live session-update tap. The end-of-turn
      // marker arriving here (during the main prompt's await) arms the response
      // bound; nothing else in this handler changes for the common path.
      if (turnWatchdogEnabled) {
        const endReason = turnEndReasonFromNotification(notification);
        if (endReason !== undefined) {
          endMarkerReasonThisTurn = endReason;
          activeTurnWatchdog?.noteEndMarker();
        }
      }
      // A turn abandoned at tier 2 may still emit late updates when its withheld
      // response finally settles. Drop them: the turn is already being failed, so
      // folding its late output into the record or re-triggering a checkpoint
      // would clobber the finalized state (the tier-2 late-response guard).
      if (turnAbandoned) {
        return;
      }
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
              void enqueueSubagentBoundaryWrite(childAcpxRecordId, childRecord).catch(() => {});
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
        const injectedPromise = runInjectedPromptTask(sessionId, injectedTask);
        // Track (await) this injected promise when EITHER the caller is waiting
        // for completion (unchanged), OR the backend returns a terminal for an
        // injected prompt (Claude / claude-pty). This is the root fix for the
        // "stuck red" bug: a Claude `--no-wait` injection that outlives the
        // primary must be awaited so its output folds into the record and its
        // delivery terminal is written before the turn's `finally` tears down
        // the event writer. A backend without a terminal (Codex / unknown)
        // stays fire-and-forget — never pushed, so it can't hold the turn open.
        // The result/error SEND gates above (the --no-wait contract) are
        // unchanged; only this await-tracking gate widens.
        if (injectedTask.waitForCompletion || awaitInjectedPrompt) {
          const tracked: TrackedInjectedDelivery = {
            promise: injectedPromise,
            context: deliveryContextFor(injectedTask),
            settled: false,
          };
          void injectedPromise.finally(() => {
            tracked.settled = true;
          });
          injectedDeliveries.push(tracked);
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
    if (injectedDeliveries.length === 0) {
      return;
    }
    // Bound the wait with a backstop so a pathological injected prompt that
    // never settles can't wedge the queue owner forever — degrading to the
    // pre-fix behavior for that one stuck prompt only (strictly no worse than
    // the bug, and far rarer). Realistic "never resolves" triggers already
    // resolve safely: rejections are isolated inside the IIFE, and an owner
    // death rejects the pending client.prompt() (AgentDisconnectedError).
    const drainTimeoutMs = resolveInjectedDrainTimeoutMs();
    const drainResult = await drainInjectedPromptsWithBackstop(
      injectedDeliveries.map((delivery) => delivery.promise),
      drainTimeoutMs,
      (pending) => {
        // Diagnosable, NON-verbose-gated → owner.log (mirrors the idle-release
        // line at queue-owner-runtime.ts:784-786). The owner's stderr is its own
        // owner.log fd, never a --json-strict client's JSON-RPC stream.
        process.stderr.write(
          `[acpx] injected-prompt drain backstop fired for session ${record.acpxRecordId} ` +
            `after ${drainTimeoutMs}ms; finalizing with ${pending} injected prompt(s) still pending\n`,
        );
      },
    );
    // C3 (G2 completeness): the backstop fired with injected prompts still
    // pending. Their own late terminal may never come (the response is withheld
    // forever), so write one now — the exactly-one-terminal invariant is held by
    // terminalDeliveryKeys, which suppresses any late IIFE terminal for the same
    // delivery. Not a "completed" terminal by design (Defect-B dedup won't dedup
    // a resend): the message may have run, hence the detailCode + copy (D3, Q3).
    if (drainResult.timedOut) {
      for (const delivery of injectedDeliveries) {
        if (delivery.settled || !delivery.context) {
          continue;
        }
        await appendDeliveryTerminal(delivery.context, "failed", {
          error: {
            code: 0,
            message: "delivery outcome unknown — the message may have been processed",
            detailCode: "INJECTED_RESPONSE_TIMEOUT",
          },
        });
      }
    }
    injectedDeliveries.length = 0;
  };

  const runPromptAttempt = async (sessionId: string, attempt: number) => {
    const promptStartedAt = Date.now();
    // Fresh watchdog state for this attempt (a retry re-arms cleanly).
    turnAbandoned = false;
    endMarkerReasonThisTurn = undefined;
    await appendDeliveryEvent(mainDeliveryContext, "accepted");
    const response = await measurePerf("runtime.prompt.agent_turn", async () => {
      const turnPromise = runPromptTurn({
        client,
        sessionId,
        prompt: options.prompt,
        timeoutMs: options.timeoutMs,
        conversation,
        promptMessageId,
        messageId: options.messageId,
        onPromptStarted: buildPromptStartedHook(sessionId, attempt),
      });
      if (!turnWatchdogEnabled) {
        return await turnPromise;
      }
      // Bound the await against a withheld response. The watchdog only arms once
      // the end-of-turn marker reaches the session-update tap above; until then
      // this is a plain `await turnPromise`.
      const watchdog = new TurnWatchdog({
        timeoutMs: resolveTurnResponseTimeoutMs(),
        sessionId: record.acpxRecordId,
        onTier1: () => {
          void client.requestCancelActivePrompt().catch(() => {
            // Best effort: the nudge either settles the withheld prompt or tier 2
            // bounds it. Never let the cancel's own failure escape the watchdog.
          });
        },
        onTier2Abandon: () => {
          turnAbandoned = true;
        },
        log: (tier, elapsedMs) => {
          // Diagnosable, NON-verbose-gated → owner.log (mirrors the drain-backstop
          // line). The owner's stderr is its own owner.log fd, never a client's
          // JSON-RPC stream.
          process.stderr.write(
            `[acpx] turn-completion watchdog tier ${tier} for session ${record.acpxRecordId}: ` +
              `end-of-turn marker seen, response overdue ${elapsedMs}ms\n`,
          );
        },
      });
      activeTurnWatchdog = watchdog;
      try {
        return await watchdog.guard(turnPromise);
      } finally {
        activeTurnWatchdog = undefined;
        watchdog.dispose();
      }
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
    await completeAbsorbedInjectedDeliveries("failed", {
      error: deliveryErrorFrom(error),
    });
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
    (propagated as { outputAlreadyEmitted?: boolean }).outputAlreadyEmitted =
      sawAcpMessage && !(error instanceof PermissionPromptUnavailableError);
    (propagated as { normalizedOutputError?: unknown }).normalizedOutputError = normalizedError;
    attachEffectiveAccountMetadata(propagated, client.getEffectiveAccountMetadata());
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
    await mergeLatestDurablePreferencesFromDisk();
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
        acpxState = cloneSessionAcpxState(record.acpx);

        output.setContext({
          sessionId: record.acpxRecordId,
        });
        await liveCheckpoint.checkpoint();

        const response = await savePromptSuccess(await runPromptWithRetries(activeSessionId));
        // Q2 (semantic truth): if tier-1's cancel recovered a turn whose marker
        // already reported a genuine completion, the delivery terminal reports
        // that completion — not the `cancelled` our own nudge produced. The raw
        // stopReason still flows to the caller's RunPromptResult below.
        const terminalStopReason = reconcileStopReasonWithMarker(
          response.stopReason,
          endMarkerReasonThisTurn,
        );
        await completeAbsorbedInjectedDeliveries(
          deliveryPhaseForStopReason(terminalStopReason),
          terminalStopReason === "cancelled" ? { stopReason: "cancelled" } : { stopReason: null },
        );
        await appendDeliveryTerminal(
          mainDeliveryContext,
          deliveryPhaseForStopReason(terminalStopReason),
          { stopReason: toDeliveryStopReason(terminalStopReason) },
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
        await completeAbsorbedInjectedDeliveries("cancelled", {
          stopReason: "cancelled",
        }).catch(() => {});
        if (response?.stopReason === "cancelled") {
          await appendDeliveryTerminal(mainDeliveryContext, "cancelled", {
            stopReason: "cancelled",
          }).catch(() => {});
        }
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.lastUsedAt = isoNow();
        applyConversation(record, conversation);
        await mergeLatestDurablePreferencesFromDisk().catch(() => {
          record.acpx = acpxState;
        });
        await flushPendingMessages(false).catch(() => {
          // best effort while process is being interrupted
        });
        if (ownClient) {
          await client.close();
        }
      },
    );
  } catch (error) {
    const annotatedError = attachEffectiveAccountMetadata(
      error,
      client.getEffectiveAccountMetadata(),
    );
    if (error instanceof InterruptedError) {
      await completeAbsorbedInjectedDeliveries("cancelled", {
        stopReason: "cancelled",
      }).catch(() => {});
      await appendDeliveryTerminal(mainDeliveryContext, "cancelled", {
        stopReason: "cancelled",
      }).catch(() => {});
    } else {
      await completeAbsorbedInjectedDeliveries("failed", {
        error: deliveryErrorFrom(annotatedError),
      }).catch(() => {});
      await appendDeliveryTerminal(mainDeliveryContext, "failed", {
        error: deliveryErrorFrom(annotatedError),
      }).catch(() => {});
    }
    throw annotatedError;
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
    await mergeLatestDurablePreferencesFromDisk().catch(() => {
      record.acpx = acpxState;
    });
    await liveCheckpoint.flush().catch(() => {
      // best effort on close
    });
    await mergeLatestDurablePreferencesFromDisk().catch(() => {
      record.acpx = acpxState;
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
      sessionName: null,
      subscriptionId: options.sessionOptions?.subscription ?? null,
      profileId: options.sessionOptions?.profile ?? null,
      reasoningEffort: options.sessionOptions?.reasoningEffort ?? null,
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
        const effectiveSessionOptions = withDefaultModelForNewSession(
          options.agentCommand,
          options.sessionOptions,
        );
        await applyRequestedModelIfAdvertised({
          client,
          sessionId,
          requestedModel: effectiveSessionOptions?.model,
          models: createdSession.models,
          agentCommand: options.agentCommand,
          timeoutMs: options.timeoutMs,
        });
        // One-shot: no persisted record, so apply effort live for this turn only.
        await applyExecReasoningEffort({
          client,
          sessionId,
          reasoningEffort: effectiveSessionOptions?.reasoningEffort,
          advertised: createdSession.configOptions,
          modelId: effectiveSessionOptions?.model,
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
  const record = await resolveSessionRecord(options.sessionId);
  const ownerOptions = resolveSessionOwnerOptions(record, options, {
    permissionModeExplicit: options.permissionModeExplicit,
  });
  persistSessionOwnerOptions(record, ownerOptionsToInput(ownerOptions));
  await writeSessionRecordAtBoundary(record);

  return await runSessionPrompt({
    sessionRecordId: options.sessionId,
    prompt: options.prompt,
    messageId: options.messageId,
    mcpServers: options.mcpServers,
    permissionMode: ownerOptions.permission_mode,
    resumePolicy: options.resumePolicy,
    nonInteractivePermissions: ownerOptions.non_interactive_permissions,
    permissionPolicy: options.permissionPolicy,
    authCredentials: options.authCredentials,
    authPolicy: ownerOptions.auth_policy,
    terminal: ownerOptions.terminal,
    outputFormatter: options.outputFormatter,
    onAcpMessage: options.onAcpMessage,
    onSessionUpdate: options.onSessionUpdate,
    onClientOperation: options.onClientOperation,
    onPermissionEscalation: options.onPermissionEscalation,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    verbose: options.verbose,
    promptRetries: options.promptRetries,
    sessionOptions: options.sessionOptions,
    client: options.client,
  });
}
