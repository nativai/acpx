import { randomUUID } from "node:crypto";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { QueueConnectionError, QueueProtocolError } from "../../errors.js";
import { incrementPerfCounter } from "../../perf-metrics.js";
import { classifyRecordedIdentity, identityScope } from "../../process-identity.js";
import { isProcessDefinitelyDead } from "../../process-liveness.js";
import type { DepthProjection } from "../../session/depth-projection.js";
import { resolveSessionRecord } from "../../session/persistence.js";
import type {
  AcpClientOptions,
  NonInteractivePermissionPolicy,
  OutputErrorEmissionPolicy,
  OutputFormatter,
  PermissionMode,
  PermissionPolicy,
  PromptInput,
  SessionResumePolicy,
  SessionEnqueueResult,
  SessionSendOutcome,
} from "../../types.js";
import type { BackgroundTaskAnswer } from "../session/background-task-tracker.js";
import { clearBackgroundTaskChipAfterReap } from "../session/owner-task-reap.js";
import { probeQueueOwnerHealth, type QueueOwnerHealth } from "./ipc-health.js";
import type { QueueOwnerDrainReport } from "./ipc-server.js";
import { connectToQueueOwner } from "./ipc-transport.js";
import {
  type CloserTaskContext,
  type QueueOwnerRecord,
  readQueueOwnerRecord,
  readQueueOwnerState,
  recoverQueueOwnerForSession,
  terminateQueueOwnerForSession,
} from "./lease-store.js";
import {
  parseQueueOwnerMessage,
  type QueueCancelRequest,
  type QueueCloseSessionRequest,
  type QueueDrainDeliveriesRequest,
  type QueueDrainReason,
  type QueueOwnerActiveTurnResultMessage,
  type QueueOwnerBackgroundTasksResultMessage,
  type QueueOwnerCancelResultMessage,
  type QueueOwnerCloseSessionResultMessage,
  type QueueOwnerDrainResultMessage,
  type QueueOwnerMessage,
  type QueueOwnerSetConfigOptionResultMessage,
  type QueueOwnerSetDepthResultMessage,
  type QueueOwnerSetModelResultMessage,
  type QueueOwnerSetModeResultMessage,
  type QueueQueryActiveTurnRequest,
  type QueueQueryBackgroundTasksRequest,
  type QueueOwnerScheduleCloseResultMessage,
  type QueueRequest,
  type QueueScheduleCloseRequest,
  type QueueSetConfigOptionRequest,
  type QueueSetDepthRequest,
  type QueueSetModelRequest,
  type QueueSetModeRequest,
  type QueueSubmitRequest,
} from "./messages.js";

export { QUEUE_CONNECT_RETRY_MS } from "./ipc-transport.js";
export const MAX_MESSAGE_BUFFER_SIZE = 10 * 1024 * 1024;
export {
  isProcessAlive,
  hasLiveProcessGroup,
  readQueueOwnerLiveness,
  readQueueOwnerState,
  recoverQueueOwnerForSession,
  releaseQueueOwnerLease,
  signalProcessGroup,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
  waitMs,
} from "./lease-store.js";
export type {
  QueueOwnerLease,
  QueueOwnerLiveness,
  QueueOwnerProcessIdentity,
  QueueOwnerRecoveryResult,
  QueueOwnerStateKind,
  QueueOwnerStopOutcome,
} from "./lease-store.js";

const STALE_OWNER_PROTOCOL_DETAIL_CODES = new Set([
  "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
  "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
]);
// ⚠️ brick ad6ba1c2 v3.1: QUEUE_OWNER_CLOSE_PENDING must NEVER join this set — it would make a sender's
// CLI terminate an owner whose close may yet be refused (`test/close-pending-drain.test.ts` pins it).
const OWNER_SHUTDOWN_DETAIL_CODES = new Set(["QUEUE_OWNER_CLOSED", "QUEUE_OWNER_SHUTTING_DOWN"]);

export function isOwnerShutdownDetailCode(detailCode: string | undefined): boolean {
  return detailCode !== undefined && OWNER_SHUTDOWN_DETAIL_CODES.has(detailCode);
}

function isOwnerShutdownError(error: unknown): error is QueueConnectionError {
  return error instanceof QueueConnectionError && isOwnerShutdownDetailCode(error.detailCode);
}

function isSameQueueOwner(left: QueueOwnerRecord, right: QueueOwnerRecord): boolean {
  return left.pid === right.pid && left.ownerGeneration === right.ownerGeneration;
}

// brick ae547131 §8.4b — retires ONLY the owner generation that answered "shutting down", only
// through the verified signal, and cleans up only through the guarded, generation-checked reap. A
// foreign or replaced lease is left untouched (T36): the old code recovered whatever lease was
// current, including a successor's.
async function recoverOwnerAfterShutdownError(params: {
  sessionId: string;
  owner: QueueOwnerRecord;
  detailCode?: string;
  verbose?: boolean;
}): Promise<boolean> {
  const stopped = await terminateQueueOwnerForSession(
    params.sessionId,
    params.owner,
    await queryCloserTaskContext(params.sessionId),
  ).catch(
    () => undefined, // Preserve the original shutdown error if cleanup fails.
  );
  if (stopped) {
    await clearBackgroundTaskChipAfterReap(params.sessionId, stopped.reap);
  }

  const currentOwner = await readQueueOwnerRecord(params.sessionId);
  if (currentOwner && isSameQueueOwner(currentOwner, params.owner)) {
    return false;
  }

  incrementPerfCounter("queue.owner.shutdown_recovered");
  if (params.verbose) {
    process.stderr.write(
      `[acpx] cleared shutting-down queue owner metadata for session ${params.sessionId} (${params.detailCode ?? "unknown"})\n`,
    );
  }
  return true;
}

async function maybeRecoverSubmitFailure(params: {
  sessionId: string;
  owner: QueueOwnerRecord;
  error: unknown;
  verbose?: boolean;
}): Promise<boolean> {
  if (isOwnerShutdownError(params.error)) {
    return await recoverOwnerAfterShutdownError({
      sessionId: params.sessionId,
      owner: params.owner,
      detailCode: params.error.detailCode,
      verbose: params.verbose,
    });
  }

  return await maybeRecoverStaleOwnerAfterProtocolMismatch(params);
}

// DELIBERATELY RETAINED auto-replace of a live owner (W13-24-10, North Star).
// This is the ONE remaining place the system auto-terminates a process that is
// still alive. It is NOT a quiet/idle/heartbeat heuristic: it fires only when the
// owner is positively RESPONDING but with malformed/unexpected queue protocol —
// i.e. deterministic version-skew unusability after a breaking queue-protocol
// change between deploys. Without it a protocol-incompatible owner permanently
// wedges the session. The strict-North-Star alternative (surface a MANUAL restart
// instead) was weighed and DEFERRED: given the rarity and the deterministic
// (non-heuristic) trigger, preserve-and-document is the lower-risk choice. Revisit
// if a breaking queue-protocol change is ever shipped. A generic submit timeout
// (not shutdown, not protocol) deliberately does NOT reach here → no kill; the
// user must manually recover (North-Star compliant for the wedged-but-alive case).
async function maybeRecoverStaleOwnerAfterProtocolMismatch(params: {
  sessionId: string;
  owner: QueueOwnerRecord;
  error: unknown;
  verbose?: boolean;
}): Promise<boolean> {
  if (!(params.error instanceof QueueProtocolError)) {
    return false;
  }

  const detailCode = params.error.detailCode;
  if (!detailCode || !STALE_OWNER_PROTOCOL_DETAIL_CODES.has(detailCode)) {
    return false;
  }

  // Q9: the protocol-mismatch kill is kept, but it targets ONLY the generation that answered, and
  // signals only through signalVerifiedProcess (a foreign or replaced lease is untouched, T36).
  const outcome = await terminateQueueOwnerForSession(
    params.sessionId,
    params.owner,
    await queryCloserTaskContext(params.sessionId),
  ).catch(() => undefined);
  if (!outcome?.stopped) {
    return false;
  }
  await clearBackgroundTaskChipAfterReap(params.sessionId, outcome.reap);
  incrementPerfCounter("queue.owner.stale_recovered");

  if (params.verbose) {
    process.stderr.write(
      `[acpx] dropped stale queue owner metadata after protocol mismatch for session ${params.sessionId} (${detailCode})\n`,
    );
  }

  return true;
}
/**
 * The owner has a live lease but did not accept the connection. For an owner in ANOTHER pid
 * namespace that is `QUEUE_OWNER_UNREACHABLE` (retryable) — and never a cold spawn: a second owner
 * on one session is the split brain brick ae547131 exists to stop (CONCEPT §5.2 F1–F3, F5).
 */
function notAcceptingRequestsError(health: QueueOwnerHealth, what: string): QueueConnectionError {
  if (health.scope === "foreign") {
    return new QueueConnectionError(
      `Session queue owner runs in another pid namespace (${health.host ?? "unknown host"}) and ` +
        `did not accept ${what} requests from here; retry`,
      { detailCode: "QUEUE_OWNER_UNREACHABLE", origin: "queue", retryable: true },
    );
  }
  return new QueueConnectionError(
    `Session queue owner is running but not accepting ${what} requests`,
    { detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS", origin: "queue", retryable: true },
  );
}

export { probeQueueOwnerHealth };
export type { QueueOwnerHealth };
export type { QueueOwnerMessage, QueueSubmitRequest } from "./messages.js";
export type { QueueOwnerControlHandlers, QueueOwnerDrainReport, QueueTask } from "./ipc-server.js";
export {
  appendDeliveryStreamEvent,
  appendDeliveryStreamEventSync,
  appendRefusedStreamEventSync,
  SessionQueueOwner,
} from "./ipc-server.js";
export type { QueueDrainedDelivery, QueueDrainReason } from "./messages.js";

function assertOwnerGeneration(
  owner: QueueOwnerRecord,
  message: QueueOwnerMessage,
): QueueOwnerMessage {
  if (
    owner.ownerGeneration !== undefined &&
    message.ownerGeneration !== undefined &&
    message.ownerGeneration !== owner.ownerGeneration
  ) {
    throw new QueueProtocolError("Queue owner returned mismatched generation", {
      detailCode: "QUEUE_OWNER_GENERATION_MISMATCH",
      origin: "queue",
      retryable: true,
    });
  }
  return message;
}

type QueueOwnerRequestState = {
  acknowledged: boolean;
};

type QueueOwnerRequestControls<TResult> = {
  state: QueueOwnerRequestState;
  resolve: (result: TResult) => void;
  reject: (error: unknown) => void;
};

function queueConnectionErrorFromOwner(
  message: Extract<QueueOwnerMessage, { type: "error" }>,
  outputAlreadyEmitted: boolean,
): QueueConnectionError {
  return new QueueConnectionError(message.message, {
    outputCode: message.code,
    detailCode: message.detailCode,
    origin: message.origin ?? "queue",
    retryable: message.retryable,
    acp: message.acp,
    ...(outputAlreadyEmitted ? { outputAlreadyEmitted: true } : {}),
  });
}

function makeMalformedQueueMessageError(): QueueProtocolError {
  return new QueueProtocolError("Queue owner sent malformed message", {
    detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
    origin: "queue",
    retryable: true,
  });
}

function emitQueueOwnerError(
  formatter: OutputFormatter,
  policy: OutputErrorEmissionPolicy | undefined,
  sessionId: string,
  message: Extract<QueueOwnerMessage, { type: "error" }>,
): QueueConnectionError {
  formatter.setContext({ sessionId });
  const queueErrorAlreadyEmitted = policy?.queueErrorAlreadyEmitted ?? true;
  const shouldEmitInFormatter = message.outputAlreadyEmitted !== true || !queueErrorAlreadyEmitted;
  if (shouldEmitInFormatter) {
    formatter.onError({
      code: message.code ?? "RUNTIME",
      detailCode: message.detailCode,
      origin: message.origin ?? "queue",
      message: message.message,
      retryable: message.retryable,
      acp: message.acp,
      effectiveAccount: message.effectiveAccount,
      automationCapacityReserved: message.automationCapacityReserved,
      codexSubscriptionCap: message.codexSubscriptionCap,
    });
    formatter.flush();
  }
  return queueConnectionErrorFromOwner(message, queueErrorAlreadyEmitted);
}

function parseQueueOwnerResponseLine(
  owner: QueueOwnerRecord,
  requestId: string,
  line: string,
): QueueOwnerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new QueueProtocolError("Queue owner sent invalid JSON payload", {
      detailCode: "QUEUE_PROTOCOL_INVALID_JSON",
      origin: "queue",
      retryable: true,
    });
  }

  const parsedMessage = parseQueueOwnerMessage(parsed);
  if (!parsedMessage) {
    throw makeMalformedQueueMessageError();
  }

  const message = assertOwnerGeneration(owner, parsedMessage);
  if (message.requestId !== requestId) {
    throw makeMalformedQueueMessageError();
  }

  return message;
}

async function runQueueOwnerRequest<TResult>(options: {
  owner: QueueOwnerRecord;
  request: QueueRequest;
  // Optional client-side deadline. WITHOUT it this request waits forever on an
  // owner that accepts the connection and then says nothing — there is no timer
  // anywhere else in this path. Racing an external `withTimeout` around the
  // returned promise is NOT equivalent: it abandons the socket still open, which
  // leaks the connection and keeps the process alive. The deadline has to live
  // in here, where the teardown is.
  timeoutMs?: number;
  onAccepted?: (controls: QueueOwnerRequestControls<TResult>) => void;
  onMessage: (message: QueueOwnerMessage, controls: QueueOwnerRequestControls<TResult>) => void;
  onClose: (controls: QueueOwnerRequestControls<TResult>) => void;
}): Promise<TResult | undefined> {
  const socket = await connectToQueueOwner(options.owner);
  if (!socket) {
    return undefined;
  }

  socket.setEncoding("utf8");

  return await new Promise<TResult>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    const state: QueueOwnerRequestState = {
      acknowledged: false,
    };
    const deadline =
      options.timeoutMs != null && options.timeoutMs > 0
        ? setTimeout(() => {
            finishReject(
              new QueueConnectionError("Queue owner did not respond before the deadline", {
                detailCode: "QUEUE_REQUEST_TIMED_OUT",
                origin: "queue",
                retryable: true,
              }),
            );
          }, options.timeoutMs)
        : undefined;

    const finishResolve = (result: TResult) => {
      if (settled) {
        return;
      }
      settled = true;
      if (deadline) {
        clearTimeout(deadline);
      }
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.end();
      }
      resolve(result);
    };

    const finishReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      if (deadline) {
        clearTimeout(deadline);
      }
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      reject(error);
    };

    const controls: QueueOwnerRequestControls<TResult> = {
      state,
      resolve: finishResolve,
      reject: finishReject,
    };

    const processLine = (line: string): void => {
      let message: QueueOwnerMessage;
      try {
        message = parseQueueOwnerResponseLine(options.owner, options.request.requestId, line);
      } catch (error) {
        finishReject(error);
        return;
      }

      if (message.type === "accepted") {
        state.acknowledged = true;
        options.onAccepted?.(controls);
        return;
      }

      options.onMessage(message, controls);
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      if (buffer.length > MAX_MESSAGE_BUFFER_SIZE) {
        socket.destroy();
        finishReject(new Error(`Message buffer exceeded ${MAX_MESSAGE_BUFFER_SIZE} bytes`));
        return;
      }

      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);

        if (line.length > 0) {
          processLine(line);
        }

        index = buffer.indexOf("\n");
      }
    });

    socket.once("error", (error: Error) => {
      finishReject(error);
    });

    socket.once("close", () => {
      if (settled) {
        return;
      }
      options.onClose(controls);
    });

    socket.write(`${JSON.stringify(options.request)}\n`);
  });
}

export type SubmitToQueueOwnerOptions = {
  sessionId: string;
  messageId?: string;
  message: string;
  prompt?: PromptInput;
  permissionMode: PermissionMode;
  resumePolicy?: SessionResumePolicy;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  outputFormatter: OutputFormatter;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  promptRetries?: number;
  codexSubscriptionCapWeeklyPercent?: number;
  waitForCompletion: boolean;
  verbose?: boolean;
  sessionOptions?: NonNullable<AcpClientOptions["sessionOptions"]>;
  /** Client-side only (never put on the wire): fired once the owner acks the submit. */
  onSubmitAccepted?: () => void;
  // Keep-warm idle-TTL override (ms; 0 = forever) for the running owner. Absent
  // => do not change the owner's TTL.
  ttlMs?: number;
};

function missingQueueAckError(): QueueConnectionError {
  return new QueueConnectionError("Queue owner did not acknowledge request", {
    detailCode: "QUEUE_ACK_MISSING",
    origin: "queue",
    retryable: true,
  });
}

function unexpectedQueueResponseError(): QueueProtocolError {
  return new QueueProtocolError("Queue owner returned unexpected response", {
    detailCode: "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
    origin: "queue",
    retryable: true,
  });
}

function handleAcknowledgedSubmitMessage(
  message: QueueOwnerMessage,
  controls: QueueOwnerRequestControls<SessionSendOutcome>,
  formatter: OutputFormatter,
): void {
  if (message.type === "event") {
    formatter.onAcpMessage(message.message);
    return;
  }
  if (message.type === "permission_escalation") {
    formatter.onPermissionEscalation(message.event);
    return;
  }
  if (message.type === "result") {
    formatter.flush();
    controls.resolve(message.result);
    return;
  }
  controls.reject(unexpectedQueueResponseError());
}

function handleSubmitQueueOwnerMessage(
  message: QueueOwnerMessage,
  controls: QueueOwnerRequestControls<SessionSendOutcome>,
  options: SubmitToQueueOwnerOptions,
): void {
  if (message.type === "error") {
    if (isOwnerShutdownDetailCode(message.detailCode)) {
      controls.reject(queueConnectionErrorFromOwner(message, false));
      return;
    }
    controls.reject(
      emitQueueOwnerError(
        options.outputFormatter,
        options.errorEmissionPolicy,
        options.sessionId,
        message,
      ),
    );
    return;
  }
  if (!controls.state.acknowledged) {
    controls.reject(missingQueueAckError());
    return;
  }
  handleAcknowledgedSubmitMessage(message, controls, options.outputFormatter);
}

async function submitToQueueOwner(
  owner: QueueOwnerRecord,
  options: SubmitToQueueOwnerOptions,
): Promise<SessionSendOutcome | undefined> {
  const requestId = randomUUID();
  const request: QueueSubmitRequest = {
    type: "submit_prompt",
    requestId,
    ownerGeneration: owner.ownerGeneration,
    ...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
    message: options.message,
    prompt: options.prompt,
    permissionMode: options.permissionMode,
    resumePolicy: options.resumePolicy,
    nonInteractivePermissions: options.nonInteractivePermissions,
    permissionPolicy: options.permissionPolicy,
    timeoutMs: options.timeoutMs,
    suppressSdkConsoleErrors: options.suppressSdkConsoleErrors,
    promptRetries: options.promptRetries ?? 0,
    ...(options.codexSubscriptionCapWeeklyPercent !== undefined
      ? { codexSubscriptionCapWeeklyPercent: options.codexSubscriptionCapWeeklyPercent }
      : {}),
    waitForCompletion: options.waitForCompletion,
    sessionOptions: options.sessionOptions,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
  };

  options.outputFormatter.setContext({
    sessionId: options.sessionId,
  });

  return await runQueueOwnerRequest<SessionSendOutcome>({
    owner,
    request,
    onAccepted: ({ resolve }) => {
      options.onSubmitAccepted?.();
      options.outputFormatter.setContext({
        sessionId: options.sessionId,
      });
      if (!options.waitForCompletion) {
        const queued: SessionEnqueueResult = {
          queued: true,
          sessionId: options.sessionId,
          requestId,
        };
        resolve(queued);
      }
    },
    onMessage: (message, controls) => {
      handleSubmitQueueOwnerMessage(message, controls, options);
    },
    onClose: ({ state, resolve, reject }) => {
      if (!state.acknowledged) {
        reject(
          new QueueConnectionError("Queue owner disconnected before acknowledging request", {
            detailCode: "QUEUE_DISCONNECTED_BEFORE_ACK",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      if (!options.waitForCompletion) {
        const queued: SessionEnqueueResult = {
          queued: true,
          sessionId: options.sessionId,
          requestId,
        };
        resolve(queued);
        return;
      }

      reject(
        new QueueConnectionError("Queue owner disconnected before prompt completion", {
          detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
          origin: "queue",
          retryable: true,
        }),
      );
    },
  });
}

async function submitControlToQueueOwner<TResponse extends QueueOwnerMessage>(
  owner: QueueOwnerRecord,
  request: QueueRequest,
  isExpectedResponse: (message: QueueOwnerMessage) => message is TResponse,
  timeoutMs?: number,
): Promise<TResponse | undefined> {
  return await runQueueOwnerRequest<TResponse>({
    owner,
    request,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    onMessage: (message, { state, resolve, reject }) => {
      if (message.type === "error") {
        reject(
          new QueueConnectionError(message.message, {
            outputCode: message.code,
            detailCode: message.detailCode,
            origin: message.origin ?? "queue",
            retryable: message.retryable,
            acp: message.acp,
          }),
        );
        return;
      }

      if (!state.acknowledged) {
        reject(
          new QueueConnectionError("Queue owner did not acknowledge request", {
            detailCode: "QUEUE_ACK_MISSING",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      if (!isExpectedResponse(message)) {
        reject(
          new QueueProtocolError("Queue owner returned unexpected response", {
            detailCode: "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      resolve(message);
    },
    onClose: ({ state, reject }) => {
      if (!state.acknowledged) {
        reject(
          new QueueConnectionError("Queue owner disconnected before acknowledging request", {
            detailCode: "QUEUE_DISCONNECTED_BEFORE_ACK",
            origin: "queue",
            retryable: true,
          }),
        );
        return;
      }

      reject(
        new QueueConnectionError("Queue owner disconnected before responding", {
          detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
          origin: "queue",
          retryable: true,
        }),
      );
    },
  });
}

async function submitCancelToQueueOwner(owner: QueueOwnerRecord): Promise<boolean | undefined> {
  const request: QueueCancelRequest = {
    type: "cancel_prompt",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerCancelResultMessage => message.type === "cancel_result",
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new QueueProtocolError("Queue owner returned mismatched cancel response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
  }
  return response.cancelled;
}

async function submitQueryActiveTurnToQueueOwner(
  owner: QueueOwnerRecord,
): Promise<boolean | undefined> {
  const request: QueueQueryActiveTurnRequest = {
    type: "query_active_turn",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerActiveTurnResultMessage =>
      message.type === "query_active_turn_result",
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new QueueProtocolError("Queue owner returned mismatched query_active_turn response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
  }
  return response.active;
}

async function submitSetModeToQueueOwner(
  owner: QueueOwnerRecord,
  modeId: string,
  timeoutMs?: number,
): Promise<boolean | undefined> {
  const request: QueueSetModeRequest = {
    type: "set_mode",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    modeId,
    timeoutMs,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerSetModeResultMessage => message.type === "set_mode_result",
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new QueueProtocolError("Queue owner returned mismatched set_mode response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
  }
  return true;
}

async function submitSetModelToQueueOwner(
  owner: QueueOwnerRecord,
  modelId: string,
  timeoutMs?: number,
): Promise<boolean | undefined> {
  const request: QueueSetModelRequest = {
    type: "set_model",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    modelId,
    timeoutMs,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerSetModelResultMessage => message.type === "set_model_result",
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new QueueProtocolError("Queue owner returned mismatched set_model response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
  }
  return true;
}

async function submitSetConfigOptionToQueueOwner(
  owner: QueueOwnerRecord,
  configId: string,
  value: string,
  timeoutMs?: number,
): Promise<SetSessionConfigOptionResponse | undefined> {
  const request: QueueSetConfigOptionRequest = {
    type: "set_config_option",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    configId,
    value,
    timeoutMs,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerSetConfigOptionResultMessage =>
      message.type === "set_config_option_result",
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new QueueProtocolError("Queue owner returned mismatched set_config_option response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
  }
  return response.response;
}

// Headroom on top of whatever budget the caller gave the owner for its ACP
// shutdown. Generous, because a real `session/close` can legitimately take a
// while — the point is that the wait TERMINATES, not that it is short.
const CLOSE_SESSION_CLIENT_TIMEOUT_MS = 10_000;

async function submitCloseSessionToQueueOwner(
  owner: QueueOwnerRecord,
  timeoutMs?: number,
): Promise<boolean | undefined> {
  const request: QueueCloseSessionRequest = {
    type: "close_session",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    timeoutMs,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerCloseSessionResultMessage =>
      message.type === "close_session_result",
    // brick://53437107 — the ONE control verb this brick bounds. Without a
    // deadline, an owner that accepts the connection and then says nothing hangs
    // `sessions close` forever, which does not merely coexist with this brick's
    // purpose, it DEFEATS it: acceptance criterion #1 is that the closing agent
    // is told, in its own shell, at that moment. A close that never returns
    // prints no warning and yields no exit code.
    //
    // Scoped deliberately. The other five control verbs ride the same helper and
    // keep today's unbounded behaviour; bounding them is a behaviour change in
    // lanes this brick does not own, tracked as brick://11b83b47.
    (timeoutMs ?? 0) + CLOSE_SESSION_CLIENT_TIMEOUT_MS,
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new QueueProtocolError("Queue owner returned mismatched close_session response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
  }
  return response.closed;
}

// Headroom on top of the owner's own settle budget, so a wedged owner cannot
// hang a close beyond `--drain-timeout` by more than the socket round trip.
const DRAIN_CLIENT_SLACK_MS = 2_000;

async function submitDrainDeliveriesToQueueOwner(
  owner: QueueOwnerRecord,
  reason: QueueDrainReason,
  timeoutMs: number | undefined,
  checkBackgroundTasks: boolean,
): Promise<QueueOwnerDrainResultMessage | undefined> {
  const request: QueueDrainDeliveriesRequest = {
    type: "drain_deliveries",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    reason,
    timeoutMs,
    ...(checkBackgroundTasks ? { checkBackgroundTasks: true } : {}),
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerDrainResultMessage =>
      message.type === "drain_deliveries_result",
    // The owner's own settle budget plus headroom for the socket round trip. A
    // wedged owner therefore cannot hold a close open past --drain-timeout.
    (timeoutMs ?? 0) + DRAIN_CLIENT_SLACK_MS,
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new QueueProtocolError("Queue owner returned mismatched drain_deliveries response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
  }
  return response;
}

/**
 * D1 / A7 (brick://53437107) — ask a live owner to drain its custody before it is
 * terminated, and report what it lost.
 *
 * BEST-EFFORT BY CONSTRUCTION, exactly like `tryCloseSessionOnRunningOwner`: an
 * owner that is already gone (E2), unreachable, or still running pre-drain code
 * and therefore rejecting the verb as unknown (E3, the mixed fleet) all return
 * `undefined` and the close proceeds. This is why stage 2 is safe to ship against
 * a fleet of long-lived owners that a deploy does not restart — the barrier
 * degrades to today's behaviour rather than blocking a close.
 *
 * `undefined` means "we could not ask"; an empty `undelivered` means "we asked
 * and nothing was in flight". The caller must be able to tell those apart.
 */
export async function drainQueueOwnerForSession(options: {
  sessionId: string;
  reason: QueueDrainReason;
  timeoutMs?: number;
  verbose?: boolean;
  /** brick ad6ba1c2 v3.1 — an UNFORCED close: the owner re-checks for live tasks, abortably (§6.4). */
  checkBackgroundTasks?: boolean;
}): Promise<QueueOwnerDrainReport | undefined> {
  const owner = await readQueueOwnerRecord(options.sessionId);
  if (!owner) {
    return undefined;
  }

  let report: QueueOwnerDrainResultMessage | undefined;
  try {
    report = await submitDrainDeliveriesToQueueOwner(
      owner,
      options.reason,
      options.timeoutMs,
      options.checkBackgroundTasks === true,
    );
  } catch (error) {
    if (options.verbose) {
      process.stderr.write(
        `[acpx] queue owner for session ${options.sessionId} did not drain ` +
          `(${error instanceof Error ? error.message : String(error)}); closing anyway\n`,
      );
    }
    return undefined;
  }
  if (!report) {
    return undefined;
  }

  if (options.verbose) {
    process.stderr.write(
      `[acpx] drained queue owner pid ${owner.pid} for session ${options.sessionId} ` +
        `(${report.drained} undelivered, turnSettled=${report.turnSettled})\n`,
    );
  }
  return drainReportFrom(report);
}

function drainReportFrom(report: QueueOwnerDrainResultMessage): QueueOwnerDrainReport {
  return {
    drained: report.drained,
    undelivered: report.undelivered,
    turnSettled: report.turnSettled,
    activeTurnAtEntry: report.activeTurnAtEntry,
    ...(report.taskCheck ? { taskCheck: report.taskCheck, tasks: report.tasks ?? [] } : {}),
  };
}

async function recoverRecoverableOwnerBeforeSubmit(options: {
  sessionId: string;
  verbose?: boolean;
}): Promise<boolean> {
  const ownerState = await readQueueOwnerState(options.sessionId);
  if (!ownerState.ownerFound || !ownerState.recoverable) {
    return false;
  }

  await recoverQueueOwnerForSession(options.sessionId);
  if (options.verbose) {
    process.stderr.write(
      `[acpx] cleared ${ownerState.state} queue owner metadata for session ${options.sessionId}\n`,
    );
  }
  return true;
}

export async function trySubmitToRunningOwner(
  options: SubmitToQueueOwnerOptions,
): Promise<SessionSendOutcome | undefined> {
  const owner = await readQueueOwnerRecord(options.sessionId);
  if (!owner) {
    return undefined;
  }

  if (await recoverRecoverableOwnerBeforeSubmit(options)) {
    return undefined;
  }

  let submitted: SessionSendOutcome | undefined;
  try {
    submitted = await submitToQueueOwner(owner, options);
  } catch (error) {
    const recovered = await maybeRecoverSubmitFailure({
      sessionId: options.sessionId,
      owner,
      error,
      verbose: options.verbose,
    });
    if (recovered) {
      return undefined;
    }
    throw error;
  }
  if (submitted) {
    if (options.verbose) {
      process.stderr.write(
        `[acpx] queued prompt on active owner pid ${owner.pid} for session ${options.sessionId}\n`,
      );
    }
    return submitted;
  }

  const health = await probeQueueOwnerHealth(options.sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw notAcceptingRequestsError(health, "queue");
}

export async function tryCloseSessionOnRunningOwner(options: {
  sessionId: string;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<boolean | undefined> {
  const owner = await readQueueOwnerRecord(options.sessionId);
  if (!owner) {
    return undefined;
  }

  const closed = await submitCloseSessionToQueueOwner(owner, options.timeoutMs);
  if (closed !== undefined) {
    if (options.verbose) {
      process.stderr.write(
        `[acpx] requested session/close on active owner pid ${owner.pid} for session ${options.sessionId}\n`,
      );
    }
    return closed;
  }

  const health = await probeQueueOwnerHealth(options.sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw notAcceptingRequestsError(health, "close_session");
}

export async function tryCancelOnRunningOwner(options: {
  sessionId: string;
  verbose?: boolean;
}): Promise<boolean | undefined> {
  const owner = await readQueueOwnerRecord(options.sessionId);
  if (!owner) {
    return undefined;
  }

  const cancelled = await submitCancelToQueueOwner(owner);
  if (cancelled !== undefined) {
    if (options.verbose) {
      process.stderr.write(
        `[acpx] requested cancel on active owner pid ${owner.pid} for session ${options.sessionId}\n`,
      );
    }
    return cancelled;
  }

  const health = await probeQueueOwnerHealth(options.sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw notAcceptingRequestsError(health, "cancel");
}

// Query a live owner for whether a turn is in flight. Returns undefined when
// there is no live owner (cold session — caller proceeds), true/false otherwise.
// Used to refuse a mid-turn manual subscription switch (turn-in-flight).
export async function tryQueryActiveTurnOnRunningOwner(
  sessionId: string,
): Promise<boolean | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  const active = await submitQueryActiveTurnToQueueOwner(owner);
  if (active !== undefined) {
    return active;
  }

  const health = await probeQueueOwnerHealth(sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw notAcceptingRequestsError(health, "query_active_turn");
}

/** brick 9d34a178 — what asking the live owner to close at the end of its turn produced. */
export type ScheduleCloseOutcome =
  /** Recorded: the owner closes itself when the turn in flight ends (at once if none ran). */
  | { kind: "scheduled"; activeTurn: boolean; ownerPid: number }
  /** `onlyIfActiveTurn` and no turn in flight: nothing was recorded. */
  | { kind: "idle"; ownerPid: number }
  /** No owner to ask (no lease, or its socket did not answer). */
  | { kind: "no-owner" }
  /** The owner answered but cannot schedule — above all an owner still running an older acpx. */
  | { kind: "unsupported"; detail: string };

const SCHEDULE_CLOSE_DEADLINE_MS = 5_000;

/**
 * brick 9d34a178 — `schedule_close` on the session's live owner. NEVER throws. Control path only,
 * like the background-task query: never routed through `trySubmitToRunningOwner`, whose
 * protocol-mismatch recovery terminates an owner that answers unexpectedly — an OLD owner
 * answering this verb must be reported (`unsupported`), never killed.
 */
export async function tryScheduleCloseOnRunningOwner(
  sessionId: string,
  options: { killBackgroundTasks: boolean; onlyIfActiveTurn: boolean },
): Promise<ScheduleCloseOutcome> {
  const owner = await readQueueOwnerRecord(sessionId).catch(() => undefined);
  if (!owner) {
    return { kind: "no-owner" };
  }
  try {
    return await submitScheduleCloseToQueueOwner(owner, options);
  } catch (error) {
    return { kind: "unsupported", detail: scheduleCloseErrorDetail(error) };
  }
}

async function submitScheduleCloseToQueueOwner(
  owner: QueueOwnerRecord,
  options: { killBackgroundTasks: boolean; onlyIfActiveTurn: boolean },
): Promise<ScheduleCloseOutcome> {
  const request: QueueScheduleCloseRequest = {
    type: "schedule_close",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    ...(options.killBackgroundTasks ? { killBackgroundTasks: true } : {}),
    ...(options.onlyIfActiveTurn ? { onlyIfActiveTurn: true } : {}),
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerScheduleCloseResultMessage =>
      message.type === "schedule_close_result",
    SCHEDULE_CLOSE_DEADLINE_MS,
  );
  if (!response) {
    return { kind: "no-owner" };
  }
  if (response.requestId !== request.requestId) {
    return { kind: "unsupported", detail: "mismatched schedule_close response" };
  }
  return response.scheduled
    ? { kind: "scheduled", activeTurn: response.activeTurn, ownerPid: owner.pid }
    : { kind: "idle", ownerPid: owner.pid };
}

/**
 * The detail the refusal names. An owner from before this verb fails it as `QUEUE_REQUEST_INVALID`
 * under requestId `unknown`, which this client reads as `QUEUE_PROTOCOL_MALFORMED_MESSAGE` (measured
 * live 2026-10-30 against the deployed owner, session 889b9087).
 */
function scheduleCloseErrorDetail(error: unknown): string {
  if (error instanceof QueueConnectionError || error instanceof QueueProtocolError) {
    return error.detailCode ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** brick ad6ba1c2 (Contract C4) — one hard deadline over connect AND answer. */
export const BACKGROUND_TASKS_QUERY_DEADLINE_MS = 2_000;

export type BackgroundTasksQuery =
  | ({ queried: true } & BackgroundTaskAnswer)
  | {
      queried: false;
      /**
       * A live (or foreign) owner held the lease and gave no answer: an older acpx, another pod's
       * owner, or a wedged one. Its tasks could not be checked, so a close WARNS (HoD R2-8).
       * Absent when there was no owner to ask at all.
       */
      ownerUnanswered?: true;
    };

function isForeignOwner(owner: QueueOwnerRecord): boolean {
  const recorded = classifyRecordedIdentity(owner.processIdentity);
  return recorded.kind === "birth" && identityScope(recorded.birth) === "foreign";
}

async function submitQueryBackgroundTasksToQueueOwner(
  owner: QueueOwnerRecord,
  timeoutMs: number,
): Promise<BackgroundTaskAnswer | undefined> {
  const request: QueueQueryBackgroundTasksRequest = {
    type: "query_background_tasks",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerBackgroundTasksResultMessage =>
      message.type === "query_background_tasks_result",
    timeoutMs,
  );
  if (!response || response.requestId !== request.requestId) {
    return undefined;
  }
  return {
    source: response.source,
    tasks: response.tasks,
    monitorCommands: response.monitorCommands,
  };
}

/**
 * Asks the session's live owner for its background tasks. NEVER throws: no lease, a foreign owner,
 * an old owner (`QUEUE_REQUEST_INVALID`), an error or the 2 s deadline all read `queried:false`,
 * and the close gate then fails OPEN (Contract C2/C4).
 *
 * ⚠️ CONTROL PATH ONLY. Never route this through `trySubmitToRunningOwner`: its protocol-mismatch
 * recovery auto-terminates an owner that answers unexpectedly — an OLD owner answering this verb
 * would be killed before the close even started (AC8).
 */
export async function tryQueryBackgroundTasksOnRunningOwner(
  sessionId: string,
  deadlineMs: number = BACKGROUND_TASKS_QUERY_DEADLINE_MS,
): Promise<BackgroundTasksQuery> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  // Pessimistic: until the lease is read and shows no live owner, a missing answer is unanswered.
  let ownerAbsent = false;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), deadlineMs);
    timer.unref();
  });
  const query = (async () => {
    const owner = await readQueueOwnerRecord(sessionId);
    // Only ESRCH proves the owner gone; a foreign pid is another namespace's and is never judged here.
    if (!owner || (!isForeignOwner(owner) && isProcessDefinitelyDead(owner.pid))) {
      ownerAbsent = true;
      return undefined;
    }
    if (isForeignOwner(owner)) {
      return undefined;
    }
    const remaining = Math.max(1, deadlineMs - (Date.now() - startedAt));
    return await submitQueryBackgroundTasksToQueueOwner(owner, remaining);
  })().catch(() => undefined);
  const list = await Promise.race([query, deadline]);
  clearTimeout(timer);
  if (list) {
    return { queried: true, ...list };
  }
  return ownerAbsent ? { queried: false } : { queried: false, ownerUnanswered: true };
}

/**
 * v3 §5.2 — the closer asks the owner for `BG` immediately before it snapshots (recover, setters,
 * the automatic terminations). Never throws; bounded by the query's 2 s deadline.
 */
export async function queryCloserTaskContext(sessionId: string): Promise<CloserTaskContext> {
  const [query, record] = await Promise.all([
    tryQueryBackgroundTasksOnRunningOwner(sessionId),
    resolveSessionRecord(sessionId).catch(() => undefined),
  ]);
  // No answer ⇒ no `bg` ⇒ nothing admitted (`skipped:"no-task-set"`).
  return {
    bg: query.queried ? { tasks: query.tasks, monitorCommands: query.monitorCommands } : undefined,
    acpSessionId: record?.acpSessionId,
  };
}

export async function trySetModeOnRunningOwner(
  sessionId: string,
  modeId: string,
  timeoutMs: number | undefined,
  verbose: boolean | undefined,
): Promise<boolean | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  const submitted = await submitSetModeToQueueOwner(owner, modeId, timeoutMs);
  if (submitted) {
    if (verbose) {
      process.stderr.write(
        `[acpx] requested session/set_mode on owner pid ${owner.pid} for session ${sessionId}\n`,
      );
    }
    return true;
  }

  const health = await probeQueueOwnerHealth(sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw notAcceptingRequestsError(health, "set_mode");
}

export async function trySetModelOnRunningOwner(
  sessionId: string,
  modelId: string,
  timeoutMs: number | undefined,
  verbose: boolean | undefined,
): Promise<boolean | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  const submitted = await submitSetModelToQueueOwner(owner, modelId, timeoutMs);
  if (submitted) {
    if (verbose) {
      process.stderr.write(
        `[acpx] requested session/set_model on owner pid ${owner.pid} for session ${sessionId}\n`,
      );
    }
    return true;
  }

  const health = await probeQueueOwnerHealth(sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw notAcceptingRequestsError(health, "set_model");
}

export async function trySetConfigOptionOnRunningOwner(
  sessionId: string,
  configId: string,
  value: string,
  timeoutMs: number | undefined,
  verbose: boolean | undefined,
): Promise<SetSessionConfigOptionResponse | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  const response = await submitSetConfigOptionToQueueOwner(owner, configId, value, timeoutMs);
  if (response) {
    if (verbose) {
      process.stderr.write(
        `[acpx] requested session/set_config_option on owner pid ${owner.pid} for session ${sessionId}\n`,
      );
    }
    return response;
  }

  const health = await probeQueueOwnerHealth(sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw notAcceptingRequestsError(health, "set_config_option");
}

async function submitSetDepthToQueueOwner(
  owner: QueueOwnerRecord,
  requested: string,
  timeoutMs?: number,
): Promise<DepthProjection | undefined> {
  const request: QueueSetDepthRequest = {
    type: "set_depth",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    requested,
    timeoutMs,
  };
  const response = await submitControlToQueueOwner(
    owner,
    request,
    (message): message is QueueOwnerSetDepthResultMessage => message.type === "set_depth_result",
  );
  if (!response) {
    return undefined;
  }
  if (response.requestId !== request.requestId) {
    throw new QueueProtocolError("Queue owner returned mismatched set_depth response", {
      detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
      origin: "queue",
      retryable: true,
    });
  }
  return response.projection as DepthProjection;
}

/**
 * Live thinking-depth change on a RUNNING owner (brick a3c65f0f).
 *
 * Returns the projection OUTCOME (what the owner applied, and how it differs from
 * the request), or `undefined` when no owner is running — the caller then falls
 * back to the direct connect path. The projection itself runs owner-side: the
 * owner's live client holds the only CURRENT advertisement, and a rung projected
 * against the creation snapshot would target a ladder the session may no longer be
 * on (see {@link submitSetDepthToQueueOwner}).
 */
export async function trySetDepthOnRunningOwner(
  sessionId: string,
  requested: string,
  timeoutMs: number | undefined,
  verbose: boolean | undefined,
): Promise<DepthProjection | undefined> {
  const owner = await readQueueOwnerRecord(sessionId);
  if (!owner) {
    return undefined;
  }

  // brick a3c65f0f (TE red) — a DEAD or STALE owner record must fall through to
  // the direct-connect arm, not surface a connection failure. Same recovery the
  // submit path runs before every attempt: a recoverable record (owner gone,
  // generation stale) is CLEARED here, and returning undefined sends the caller
  // down the fallback that spawns a fresh connection. Without this, the first
  // depth change after an owner crash reported the crash instead of applying.
  if (await recoverRecoverableOwnerBeforeSubmit({ sessionId, verbose })) {
    return undefined;
  }

  const projection = await submitSetDepthToQueueOwner(owner, requested, timeoutMs);
  if (projection) {
    if (verbose) {
      process.stderr.write(
        `[acpx] requested live depth "${requested}" on owner pid ${owner.pid} for session ${sessionId} → ${projection.kind}${projection.value ? ` (${projection.value})` : ""}\n`,
      );
    }
    return projection;
  }

  const health = await probeQueueOwnerHealth(sessionId);
  if (!health.hasLease) {
    return undefined;
  }

  throw notAcceptingRequestsError(health, "set_depth");
}
