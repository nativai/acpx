import type {
  AutomationCapacityReservedDetail,
  CodexSubscriptionCapDetail,
  OutputErrorAcpPayload,
  OutputErrorCode,
  OutputErrorOrigin,
} from "../types.js";
import type { EffectiveAccountMetadata } from "./auth-env.js";

export const OUTPUT_ERROR_JSONRPC_CODES: Record<OutputErrorCode, number> = {
  NO_SESSION: -32002,
  TIMEOUT: -32070,
  PERMISSION_DENIED: -32071,
  PERMISSION_PROMPT_UNAVAILABLE: -32072,
  RUNTIME: -32603,
  USAGE: -32602,
};

type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: unknown;
};

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function assignEffectiveAccountData(
  target: Record<string, unknown>,
  metadata: EffectiveAccountMetadata | undefined,
): void {
  assignDefined(target, "effectiveAccount", metadata?.effectiveAccount);
  assignDefined(target, "effectiveProfile", metadata?.effectiveProfile);
  assignDefined(target, "effectiveAdapter", metadata?.effectiveAdapter);
  assignDefined(target, "effectiveAuthMode", metadata?.effectiveAuthMode);
  assignDefined(target, "effectiveAnchor", metadata?.effectiveAnchor);
  assignDefined(target, "effectiveResolutionMethod", metadata?.effectiveResolutionMethod);
}

export type BuildJsonRpcErrorParams = {
  id?: string | number | null;
  outputCode: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  message: string;
  retryable?: boolean;
  timestamp?: string;
  sessionId?: string;
  acp?: OutputErrorAcpPayload;
  effectiveAccount?: EffectiveAccountMetadata;
  automationCapacityReserved?: AutomationCapacityReservedDetail;
  codexSubscriptionCap?: CodexSubscriptionCapDetail;
  /**
   * WHICH POLICY refused, as a stable token identical across the tiers that enforce
   * one policy (`AcpxErrorOptions.policyReason`).
   *
   * 🛑 **THIS FIELD WAS MISSING AND THAT MADE THE WHOLE TOKEN INERT.** `policyReason`
   * was correct on the thrown error and **absent from every byte of output**, so the
   * only discriminator a real consumer had — an agent reading `--format json`,
   * acpx-ui, any tool — was `detailCode`, which DIFFERS BY TIER for one policy. That
   * is precisely what the token was introduced to fix. **A discriminator that does
   * not cross this boundary does not exist**, so the committed case asserts it on the
   * SERIALIZED output; asserting it on the in-process error is what missed it.
   */
  policyReason?: string;
};

function hasValidAcpError(
  acp: OutputErrorAcpPayload | undefined,
): acp is { code: number; message: string; data?: unknown } {
  return Boolean(
    acp &&
    Number.isFinite(acp.code) &&
    typeof acp.message === "string" &&
    acp.message.trim().length > 0,
  );
}

function buildFallbackData(params: BuildJsonRpcErrorParams): Record<string, unknown> {
  const data: Record<string, unknown> = {
    acpxCode: params.outputCode,
    detailCode: params.detailCode,
    // ⚠️ `policyReason` sits beside `detailCode` deliberately: the pair is the whole
    // point. `detailCode` says WHICH GATE fired, `policyReason` says WHICH POLICY —
    // and only the second is stable across the tiers that enforce one policy.
    policyReason: params.policyReason,
    origin: params.origin,
    retryable: params.retryable,
    timestamp: params.timestamp,
    sessionId: params.sessionId,
  };
  assignEffectiveAccountData(data, params.effectiveAccount);
  if (params.automationCapacityReserved !== undefined) {
    Object.assign(data, params.automationCapacityReserved);
  }
  if (params.codexSubscriptionCap !== undefined) {
    Object.assign(data, params.codexSubscriptionCap);
  }

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      delete data[key];
    }
  }

  return data;
}

function mergeAcpErrorData(acpData: unknown, fallbackData: Record<string, unknown>): unknown {
  if (Object.keys(fallbackData).length === 0) {
    return acpData;
  }
  if (acpData === undefined) {
    return fallbackData;
  }
  if (acpData && typeof acpData === "object" && !Array.isArray(acpData)) {
    return {
      ...fallbackData,
      ...acpData,
    };
  }
  return acpData;
}

function buildErrorObject(params: BuildJsonRpcErrorParams): JsonRpcErrorObject {
  const fallbackData = buildFallbackData(params);
  if (hasValidAcpError(params.acp)) {
    const data = mergeAcpErrorData(params.acp.data, fallbackData);
    return {
      code: params.acp.code,
      message: params.acp.message,
      ...(data !== undefined ? { data } : {}),
    };
  }

  const data = fallbackData;
  return {
    code: OUTPUT_ERROR_JSONRPC_CODES[params.outputCode] ?? -32603,
    message: params.message,
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}

export function buildJsonRpcErrorResponse(params: BuildJsonRpcErrorParams): {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcErrorObject;
} {
  return {
    jsonrpc: "2.0",
    id: params.id ?? null,
    error: buildErrorObject(params),
  };
}
