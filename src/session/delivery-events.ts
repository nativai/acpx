import type { AcpJsonRpcMessage } from "../types.js";

export const DELIVERY_EVENT_METHOD = "acpx/delivery";

export type DeliveryPhase = "accepted" | "done" | "failed" | "cancelled";

export type DeliveryStopReason = "end_turn" | "max_tokens" | "max_turns" | "cancelled" | null;

export type DeliveryEventError = {
  code: number;
  message: string;
  detailCode: string;
  effectiveAccount?: string;
};

export const EMPTY_DELIVERY_ERROR: DeliveryEventError = {
  code: 0,
  message: "",
  detailCode: "",
};

export function buildDeliveryEvent(params: {
  messageId: string;
  requestId: string;
  phase: DeliveryPhase;
  stopReason?: DeliveryStopReason;
  error?: DeliveryEventError;
  at?: string;
}): AcpJsonRpcMessage {
  return {
    jsonrpc: "2.0",
    method: DELIVERY_EVENT_METHOD,
    params: {
      messageId: params.messageId,
      requestId: params.requestId,
      phase: params.phase,
      stopReason: params.stopReason ?? null,
      error: params.error ?? EMPTY_DELIVERY_ERROR,
      at: params.at ?? new Date().toISOString(),
    },
  } as AcpJsonRpcMessage;
}
