import type { AcpJsonRpcMessage } from "../types.js";

export const DELIVERY_EVENT_METHOD = "acpx/delivery";

// `queued` (C4) is a non-terminal visibility phase: a mid-turn task buffered
// during the capture window / re-queued after a turn, not yet accepted. Additive
// — acpx-ui's parseDeliveryEvent whitelists phases and ignores unknown ones.
export type DeliveryPhase = "accepted" | "queued" | "done" | "failed" | "cancelled";

export type DeliveryStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turns"
  | "cancelled"
  | "deduplicated"
  | null;

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

/**
 * True iff `events` contains a delivery terminal proving the prompt actually COMPLETED a
 * turn: an `acpx/delivery` `phase:"done"` for `messageId` whose `stopReason` is a genuine
 * completion (`end_turn`/`max_tokens`/`max_turns`) rather than a prior dedup echo
 * (`stopReason:"deduplicated"`). A `failed`/`cancelled` terminal, or a persisted-but-never-run
 * prompt, has no such `done` — so this returns false and dedup must not fire (Defect B).
 */
export function hasCompletedDeliveryFor(events: AcpJsonRpcMessage[], messageId: string): boolean {
  for (const event of events) {
    if ((event as { method?: unknown }).method !== DELIVERY_EVENT_METHOD) {
      continue;
    }
    const params = (event as { params?: unknown }).params;
    if (!params || typeof params !== "object") {
      continue;
    }
    const {
      messageId: eventMessageId,
      phase,
      stopReason,
    } = params as {
      messageId?: unknown;
      phase?: unknown;
      stopReason?: unknown;
    };
    if (eventMessageId === messageId && phase === "done" && stopReason !== "deduplicated") {
      return true;
    }
  }
  return false;
}

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
