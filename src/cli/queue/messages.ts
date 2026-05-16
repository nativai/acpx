import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { toAcpErrorPayload } from "../../acp/error-shapes.js";
import { isAcpJsonRpcMessage } from "../../acp/jsonrpc.js";
import { isPromptInput, textPrompt } from "../../prompt-content.js";
import {
  OUTPUT_ERROR_CODES,
  OUTPUT_ERROR_ORIGINS,
  type AcpClientOptions,
  type OutputErrorAcpPayload,
  type OutputErrorCode,
  type OutputErrorOrigin,
  type PermissionEscalationEvent,
  type PermissionPolicy,
} from "../../types.js";
import type {
  AcpJsonRpcMessage,
  NonInteractivePermissionPolicy,
  PermissionMode,
  PromptInput,
  SessionResumePolicy,
  SessionSendResult,
} from "../../types.js";

type QueueSessionOptions = NonNullable<AcpClientOptions["sessionOptions"]>;

export type QueueSubmitRequest = {
  type: "submit_prompt";
  requestId: string;
  ownerGeneration?: number;
  message: string;
  prompt?: PromptInput;
  permissionMode: PermissionMode;
  resumePolicy?: SessionResumePolicy;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  timeoutMs?: number;
  suppressSdkConsoleErrors?: boolean;
  promptRetries?: number;
  waitForCompletion: boolean;
  sessionOptions?: QueueSessionOptions;
};

export type QueueCancelRequest = {
  type: "cancel_prompt";
  requestId: string;
  ownerGeneration?: number;
};

export type QueueSetModeRequest = {
  type: "set_mode";
  requestId: string;
  ownerGeneration?: number;
  modeId: string;
  timeoutMs?: number;
};

export type QueueSetModelRequest = {
  type: "set_model";
  requestId: string;
  ownerGeneration?: number;
  modelId: string;
  timeoutMs?: number;
};

export type QueueSetConfigOptionRequest = {
  type: "set_config_option";
  requestId: string;
  ownerGeneration?: number;
  configId: string;
  value: string;
  timeoutMs?: number;
};

export type QueueCloseSessionRequest = {
  type: "close_session";
  requestId: string;
  ownerGeneration?: number;
  timeoutMs?: number;
};

export type QueueRequest =
  | QueueSubmitRequest
  | QueueCancelRequest
  | QueueSetModeRequest
  | QueueSetModelRequest
  | QueueSetConfigOptionRequest
  | QueueCloseSessionRequest;

export type QueueOwnerAcceptedMessage = {
  type: "accepted";
  requestId: string;
  ownerGeneration?: number;
};

export type QueueOwnerEventMessage = {
  type: "event";
  requestId: string;
  ownerGeneration?: number;
  message: AcpJsonRpcMessage;
};

export type QueueOwnerPermissionEscalationMessage = {
  type: "permission_escalation";
  requestId: string;
  ownerGeneration?: number;
  event: PermissionEscalationEvent;
};

export type QueueOwnerResultMessage = {
  type: "result";
  requestId: string;
  ownerGeneration?: number;
  result: SessionSendResult;
};

export type QueueOwnerCancelResultMessage = {
  type: "cancel_result";
  requestId: string;
  ownerGeneration?: number;
  cancelled: boolean;
};

export type QueueOwnerSetModeResultMessage = {
  type: "set_mode_result";
  requestId: string;
  ownerGeneration?: number;
  modeId: string;
};

export type QueueOwnerSetModelResultMessage = {
  type: "set_model_result";
  requestId: string;
  ownerGeneration?: number;
  modelId: string;
};

export type QueueOwnerSetConfigOptionResultMessage = {
  type: "set_config_option_result";
  requestId: string;
  ownerGeneration?: number;
  response: SetSessionConfigOptionResponse;
};

export type QueueOwnerCloseSessionResultMessage = {
  type: "close_session_result";
  requestId: string;
  ownerGeneration?: number;
  closed: boolean;
};

export type QueueOwnerErrorMessage = {
  type: "error";
  requestId: string;
  ownerGeneration?: number;
  code?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  message: string;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
  outputAlreadyEmitted?: boolean;
};

export type QueueOwnerMessage =
  | QueueOwnerAcceptedMessage
  | QueueOwnerEventMessage
  | QueueOwnerPermissionEscalationMessage
  | QueueOwnerResultMessage
  | QueueOwnerCancelResultMessage
  | QueueOwnerSetModeResultMessage
  | QueueOwnerSetModelResultMessage
  | QueueOwnerSetConfigOptionResultMessage
  | QueueOwnerCloseSessionResultMessage
  | QueueOwnerErrorMessage;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "approve-all" || value === "approve-reads" || value === "deny-all";
}

function isSessionResumePolicy(value: unknown): value is SessionResumePolicy {
  return value === "allow-new" || value === "same-session-only";
}

function isNonInteractivePermissionPolicy(value: unknown): value is NonInteractivePermissionPolicy {
  return value === "deny" || value === "fail";
}

function isPermissionPolicy(value: unknown): value is PermissionPolicy {
  if (value == null) {
    return false;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const stringListKeys = ["autoApprove", "autoDeny", "escalate"] as const;
  for (const key of stringListKeys) {
    const entry = record[key];
    if (entry == null) {
      continue;
    }
    if (!Array.isArray(entry) || entry.some((item) => typeof item !== "string")) {
      return false;
    }
  }
  return (
    record.defaultAction == null ||
    record.defaultAction === "approve" ||
    record.defaultAction === "deny" ||
    record.defaultAction === "escalate"
  );
}

function isOutputErrorCode(value: unknown): value is OutputErrorCode {
  return typeof value === "string" && OUTPUT_ERROR_CODES.includes(value as OutputErrorCode);
}

function isOutputErrorOrigin(value: unknown): value is OutputErrorOrigin {
  return typeof value === "string" && OUTPUT_ERROR_ORIGINS.includes(value as OutputErrorOrigin);
}

function isPermissionEscalationEvent(value: unknown): value is PermissionEscalationEvent {
  const event = asRecord(value);
  return (
    event?.type === "permission_escalation" &&
    typeof event.sessionId === "string" &&
    typeof event.toolCallId === "string" &&
    typeof event.toolTitle === "string" &&
    event.action === "escalate" &&
    typeof event.message === "string" &&
    typeof event.timestamp === "string" &&
    (event.toolName == null || typeof event.toolName === "string") &&
    (event.toolKind == null || typeof event.toolKind === "string") &&
    (event.matchedRule == null || typeof event.matchedRule === "string")
  );
}

function parseSessionOptions(value: unknown): QueueSessionOptions | null | undefined {
  if (value == null) {
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const sessionOptions: QueueSessionOptions = {};
  if (record.model != null) {
    if (typeof record.model !== "string" || record.model.trim().length === 0) {
      return null;
    }
    sessionOptions.model = record.model;
  }
  if (record.allowedTools != null) {
    if (!Array.isArray(record.allowedTools)) {
      return null;
    }
    const allowedTools = record.allowedTools.filter(
      (tool): tool is string => typeof tool === "string",
    );
    if (allowedTools.length !== record.allowedTools.length) {
      return null;
    }
    sessionOptions.allowedTools = allowedTools;
  }
  if (record.maxTurns != null) {
    if (typeof record.maxTurns !== "number" || !Number.isFinite(record.maxTurns)) {
      return null;
    }
    sessionOptions.maxTurns = Math.max(1, Math.round(record.maxTurns));
  }
  if (record.systemPrompt != null) {
    if (typeof record.systemPrompt === "string") {
      sessionOptions.systemPrompt = record.systemPrompt;
    } else {
      const systemPrompt = asRecord(record.systemPrompt);
      if (!systemPrompt || typeof systemPrompt.append !== "string") {
        return null;
      }
      sessionOptions.systemPrompt = { append: systemPrompt.append };
    }
  }

  return sessionOptions;
}

function parseOwnerGeneration(value: unknown): number | undefined | null {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function parseNonNegativeInteger(value: unknown): number | undefined | null {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.round(value);
}

export function parseQueueRequest(raw: unknown): QueueRequest | null {
  const request = asRecord(raw);
  if (!request) {
    return null;
  }

  if (typeof request.type !== "string" || typeof request.requestId !== "string") {
    return null;
  }
  const ownerGeneration = parseOwnerGeneration(request.ownerGeneration);
  if (ownerGeneration === null) {
    return null;
  }

  const timeoutRaw = request.timeoutMs;
  const timeoutMs =
    typeof timeoutRaw === "number" && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.round(timeoutRaw)
      : undefined;

  if (request.type === "submit_prompt") {
    const resumePolicy =
      request.resumePolicy == null
        ? undefined
        : isSessionResumePolicy(request.resumePolicy)
          ? request.resumePolicy
          : null;
    const nonInteractivePermissions =
      request.nonInteractivePermissions == null
        ? undefined
        : isNonInteractivePermissionPolicy(request.nonInteractivePermissions)
          ? request.nonInteractivePermissions
          : null;
    const permissionPolicy =
      request.permissionPolicy == null
        ? undefined
        : isPermissionPolicy(request.permissionPolicy)
          ? request.permissionPolicy
          : null;
    const suppressSdkConsoleErrors =
      request.suppressSdkConsoleErrors == null
        ? undefined
        : typeof request.suppressSdkConsoleErrors === "boolean"
          ? request.suppressSdkConsoleErrors
          : null;
    const promptRetries = parseNonNegativeInteger(request.promptRetries);
    const sessionOptions = parseSessionOptions(request.sessionOptions);

    const prompt =
      request.prompt == null ? undefined : isPromptInput(request.prompt) ? request.prompt : null;
    if (
      typeof request.message !== "string" ||
      !isPermissionMode(request.permissionMode) ||
      resumePolicy === null ||
      prompt === null ||
      nonInteractivePermissions === null ||
      permissionPolicy === null ||
      suppressSdkConsoleErrors === null ||
      promptRetries === null ||
      sessionOptions === null ||
      typeof request.waitForCompletion !== "boolean"
    ) {
      return null;
    }

    return {
      type: "submit_prompt",
      requestId: request.requestId,
      ownerGeneration,
      message: request.message,
      prompt: prompt ?? textPrompt(request.message),
      permissionMode: request.permissionMode,
      ...(resumePolicy !== undefined ? { resumePolicy } : {}),
      nonInteractivePermissions,
      ...(permissionPolicy !== undefined ? { permissionPolicy } : {}),
      timeoutMs,
      ...(suppressSdkConsoleErrors !== undefined ? { suppressSdkConsoleErrors } : {}),
      ...(promptRetries !== undefined ? { promptRetries } : {}),
      waitForCompletion: request.waitForCompletion,
      ...(sessionOptions !== undefined ? { sessionOptions } : {}),
    };
  }

  if (request.type === "cancel_prompt") {
    return {
      type: "cancel_prompt",
      requestId: request.requestId,
      ownerGeneration,
    };
  }

  if (request.type === "close_session") {
    return {
      type: "close_session",
      requestId: request.requestId,
      ownerGeneration,
      timeoutMs,
    };
  }

  if (request.type === "set_mode") {
    if (typeof request.modeId !== "string" || request.modeId.trim().length === 0) {
      return null;
    }
    return {
      type: "set_mode",
      requestId: request.requestId,
      ownerGeneration,
      modeId: request.modeId,
      timeoutMs,
    };
  }

  if (request.type === "set_model") {
    if (typeof request.modelId !== "string" || request.modelId.trim().length === 0) {
      return null;
    }
    return {
      type: "set_model",
      requestId: request.requestId,
      ownerGeneration,
      modelId: request.modelId,
      timeoutMs,
    };
  }

  if (request.type === "set_config_option") {
    if (
      typeof request.configId !== "string" ||
      request.configId.trim().length === 0 ||
      typeof request.value !== "string" ||
      request.value.trim().length === 0
    ) {
      return null;
    }
    return {
      type: "set_config_option",
      requestId: request.requestId,
      ownerGeneration,
      configId: request.configId,
      value: request.value,
      timeoutMs,
    };
  }

  return null;
}

function parseSessionSendResult(raw: unknown): SessionSendResult | null {
  const result = asRecord(raw);
  if (!result) {
    return null;
  }

  if (
    typeof result.stopReason !== "string" ||
    typeof result.sessionId !== "string" ||
    typeof result.resumed !== "boolean"
  ) {
    return null;
  }

  const permissionStats = asRecord(result.permissionStats);
  const record = asRecord(result.record);
  if (!permissionStats || !record) {
    return null;
  }

  const statsValid =
    typeof permissionStats.requested === "number" &&
    typeof permissionStats.approved === "number" &&
    typeof permissionStats.denied === "number" &&
    typeof permissionStats.cancelled === "number";
  if (!statsValid) {
    return null;
  }

  const recordValid =
    typeof record.acpxRecordId === "string" &&
    typeof record.acpSessionId === "string" &&
    typeof record.agentCommand === "string" &&
    typeof record.cwd === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.lastUsedAt === "string" &&
    Array.isArray(record.messages) &&
    typeof record.updated_at === "string" &&
    typeof record.lastSeq === "number" &&
    Number.isInteger(record.lastSeq) &&
    !!record.eventLog &&
    typeof record.eventLog === "object";
  if (!recordValid) {
    return null;
  }

  return result as SessionSendResult;
}

export function parseQueueOwnerMessage(raw: unknown): QueueOwnerMessage | null {
  const message = asRecord(raw);
  if (!message || typeof message.type !== "string") {
    return null;
  }

  if (typeof message.requestId !== "string") {
    return null;
  }
  const ownerGeneration = parseOwnerGeneration(message.ownerGeneration);
  if (ownerGeneration === null) {
    return null;
  }

  if (message.type === "accepted") {
    return {
      type: "accepted",
      requestId: message.requestId,
      ownerGeneration,
    };
  }

  if (message.type === "event") {
    if (!isAcpJsonRpcMessage(message.message)) {
      return null;
    }

    return {
      type: "event",
      requestId: message.requestId,
      ownerGeneration,
      message: message.message,
    };
  }

  if (message.type === "permission_escalation") {
    if (!isPermissionEscalationEvent(message.event)) {
      return null;
    }

    return {
      type: "permission_escalation",
      requestId: message.requestId,
      ownerGeneration,
      event: message.event,
    };
  }

  if (message.type === "result") {
    const parsedResult = parseSessionSendResult(message.result);
    if (!parsedResult) {
      return null;
    }
    return {
      type: "result",
      requestId: message.requestId,
      ownerGeneration,
      result: parsedResult,
    };
  }

  if (message.type === "cancel_result") {
    if (typeof message.cancelled !== "boolean") {
      return null;
    }
    return {
      type: "cancel_result",
      requestId: message.requestId,
      ownerGeneration,
      cancelled: message.cancelled,
    };
  }

  if (message.type === "set_mode_result") {
    if (typeof message.modeId !== "string") {
      return null;
    }
    return {
      type: "set_mode_result",
      requestId: message.requestId,
      ownerGeneration,
      modeId: message.modeId,
    };
  }

  if (message.type === "set_model_result") {
    if (typeof message.modelId !== "string") {
      return null;
    }
    return {
      type: "set_model_result",
      requestId: message.requestId,
      ownerGeneration,
      modelId: message.modelId,
    };
  }

  if (message.type === "set_config_option_result") {
    const response = asRecord(message.response);
    if (!response || !Array.isArray(response.configOptions)) {
      return null;
    }
    return {
      type: "set_config_option_result",
      requestId: message.requestId,
      ownerGeneration,
      response: response as SetSessionConfigOptionResponse,
    };
  }

  if (message.type === "error") {
    if (
      typeof message.message !== "string" ||
      !isOutputErrorCode(message.code) ||
      !isOutputErrorOrigin(message.origin)
    ) {
      return null;
    }

    const detailCode =
      typeof message.detailCode === "string" && message.detailCode.trim().length > 0
        ? message.detailCode
        : undefined;
    const retryable = typeof message.retryable === "boolean" ? message.retryable : undefined;
    const acp = toAcpErrorPayload(message.acp);
    const outputAlreadyEmitted =
      typeof message.outputAlreadyEmitted === "boolean" ? message.outputAlreadyEmitted : undefined;

    return {
      type: "error",
      requestId: message.requestId,
      ownerGeneration,
      code: message.code,
      detailCode,
      origin: message.origin,
      message: message.message,
      retryable,
      acp,
      ...(outputAlreadyEmitted === undefined ? {} : { outputAlreadyEmitted }),
    };
  }

  return null;
}
