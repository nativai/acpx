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

/**
 * brick ddd76838 — additive, human-visible terminal annotations on `acpx/delivery`
 * events. Both are READS OF DATA ALREADY ON THE WIRE — no protocol change:
 *
 *  - `warning` — set on a `done` terminal whose delivery window observed ZERO
 *    `session/update` frames (the 5.5 h wedge signature: a delivery recorded as a
 *    clean success while nothing reached the session). Text is stable copy the
 *    UI renders verbatim.
 *  - `steered` — the adapter's own steer-ack `_meta.piAcp.steered`, forwarded so
 *    the delivery record says "this end_turn was an absorbed steer", not a
 *    completed turn of its own. `stopReason` STAYS `"end_turn"` — the union (and
 *    the dedup logic keyed on it) is unchanged.
 */
export const ZERO_AGENT_OUTPUT_WARNING = "completed with no agent output";

/** Stop reasons that prove a delivery genuinely COMPLETED a turn (not dedup echoes). */
export function isGenuineCompletionStopReason(
  stopReason: DeliveryStopReason | undefined | null,
): stopReason is "end_turn" | "max_tokens" | "max_turns" {
  return stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "max_turns";
}

/**
 * The zero-output warning for a delivery terminal, or `undefined` — the SINGLE
 * decision every terminal path shares (brick ddd76838). Deliberately narrow, so
 * it cannot cry wolf:
 *
 *  - `done` terminals only — a cancelled/failed terminal with no frames is
 *    unremarkable;
 *  - genuine stop reasons only — `deduplicated` deliveries have no turn at all,
 *    and the codex absorbed-steer terminal carries `stopReason: null` BY DESIGN
 *    (the steer acts inside the containing turn; it produces no frames of its own);
 *  - an unknown window (`framesAtStart === undefined`, no accepted event was seen
 *    for this delivery) stays silent — absence of a measurement is not a zero.
 *
 * Overlapping windows (an injected prompt running inside the main turn's span)
 * can only UNDER-count a zero — the shared frame stream attributes the main
 * turn's frames to the injected window too — so a missed warning is the worst
 * case, never a false one.
 */
export function zeroAgentOutputWarning(params: {
  terminal: boolean;
  phase: DeliveryPhase;
  stopReason?: DeliveryStopReason;
  /** Global session/update frame count snapshotted at the delivery's `accepted`. */
  framesAtStart: number | undefined;
  /** Global session/update frame count read at terminal time. */
  framesAtTerminal: number;
}): string | undefined {
  if (!params.terminal || params.phase !== "done") {
    return undefined;
  }
  if (!isGenuineCompletionStopReason(params.stopReason)) {
    return undefined;
  }
  if (params.framesAtStart === undefined) {
    return undefined;
  }
  return params.framesAtTerminal === params.framesAtStart ? ZERO_AGENT_OUTPUT_WARNING : undefined;
}

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
  /** brick ddd76838 — the adapter's steer-ack flag, forwarded as-is. */
  steered?: boolean;
  /** brick ddd76838 — zero session/update frames observed in the delivery window. */
  warning?: string;
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
      ...(params.steered ? { steered: true } : {}),
      ...(params.warning ? { warning: params.warning } : {}),
      at: params.at ?? new Date().toISOString(),
    },
  } as AcpJsonRpcMessage;
}
