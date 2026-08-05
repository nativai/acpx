import { randomUUID } from "node:crypto";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { QueueConnectionError, QueueProtocolError } from "../../errors.js";
import { incrementPerfCounter } from "../../perf-metrics.js";
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
import { probeQueueOwnerHealth, type QueueOwnerHealth } from "./ipc-health.js";
import type { QueueOwnerDrainReport } from "./ipc-server.js";
import { connectToQueueOwner } from "./ipc-transport.js";
import {
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
  type QueueOwnerCancelResultMessage,
  type QueueOwnerCloseSessionResultMessage,
  type QueueOwnerDrainResultMessage,
  type QueueOwnerMessage,
  type QueueOwnerSetConfigOptionResultMessage,
  type QueueOwnerSetModelResultMessage,
  type QueueOwnerSetModeResultMessage,
  type QueueQueryActiveTurnRequest,
  type QueueRequest,
  type QueueSetConfigOptionRequest,
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
  terminateProcess,
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
} from "./lease-store.js";

const STALE_OWNER_PROTOCOL_DETAIL_CODES = new Set([
  "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
  "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
]);
const OWNER_SHUTDOWN_DETAIL_CODES = new Set(["QUEUE_OWNER_CLOSED", "QUEUE_OWNER_SHUTTING_DOWN"]);

function isOwnerShutdownDetailCode(detailCode: string | undefined): boolean {
  return detailCode !== undefined && OWNER_SHUTDOWN_DETAIL_CODES.has(detailCode);
}

function isOwnerShutdownError(error: unknown): error is QueueConnectionError {
  return error instanceof QueueConnectionError && isOwnerShutdownDetailCode(error.detailCode);
}

function isSameQueueOwner(left: QueueOwnerRecord, right: QueueOwnerRecord): boolean {
  return left.pid === right.pid && left.ownerGeneration === right.ownerGeneration;
}

async function recoverOwnerAfterShutdownError(params: {
  sessionId: string;
  owner: QueueOwnerRecord;
  detailCode?: string;
  verbose?: boolean;
}): Promise<boolean> {
  await recoverQueueOwnerForSession(params.sessionId).catch(() => {
    // Preserve the original shutdown error if cleanup fails.
  });

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

  await terminateQueueOwnerForSession(params.sessionId).catch(() => {
    // Preserve existing behavior if cleanup fails.
  });
  incrementPerfCounter("queue.owner.stale_recovered");

  if (params.verbose) {
    process.stderr.write(
      `[acpx] dropped stale queue owner metadata after protocol mismatch for session ${params.sessionId} (${detailCode})\n`,
    );
  }

  return true;
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
  waitForCompletion: boolean;
  verbose?: boolean;
  sessionOptions?: NonNullable<AcpClientOptions["sessionOptions"]>;
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
): Promise<QueueOwnerDrainResultMessage | undefined> {
  const request: QueueDrainDeliveriesRequest = {
    type: "drain_deliveries",
    requestId: randomUUID(),
    ownerGeneration: owner.ownerGeneration,
    reason,
    timeoutMs,
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
}): Promise<QueueOwnerDrainReport | undefined> {
  const owner = await readQueueOwnerRecord(options.sessionId);
  if (!owner) {
    return undefined;
  }

  let report: QueueOwnerDrainResultMessage | undefined;
  try {
    report = await submitDrainDeliveriesToQueueOwner(owner, options.reason, options.timeoutMs);
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
  return {
    drained: report.drained,
    undelivered: report.undelivered,
    turnSettled: report.turnSettled,
    activeTurnAtEntry: report.activeTurnAtEntry,
  };
}

async function recoverRecoverableOwnerBeforeSubmit(
  options: SubmitToQueueOwnerOptions,
): Promise<boolean> {
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

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting queue requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
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

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting close_session requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
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

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting cancel requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
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

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting query_active_turn requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
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

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting set_mode requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
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

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting set_model requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
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

  throw new QueueConnectionError(
    "Session queue owner is running but not accepting set_config_option requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
}
