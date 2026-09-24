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
 * brick ddd76838 / 7ada04b9 — additive, human-visible terminal annotations on
 * `acpx/delivery` events. Both are READS OF DATA ALREADY ON THE WIRE — no
 * protocol change:
 *
 *  - `warning` — set on a `done` terminal that is NOT a genuine completion of
 *    its own turn: either (a) `steered: true` (an absorbed steer — pi's ack
 *    reuses the genuine `"end_turn"` stop reason for this, so the flag is the
 *    only trustworthy signal — text `STEERED_INTO_ACTIVE_TURN_WARNING`), or
 *    (b) a real completion whose delivery window observed ZERO `session/update`
 *    frames (the original 5.5 h wedge signature — text `ZERO_AGENT_OUTPUT_WARNING`).
 *    The two are mutually exclusive and share one wire field — `steered` is
 *    checked first (`deliveryTerminalWarning`'s precedence) because a steered
 *    delivery is never a genuine completion regardless of how many cosmetic
 *    frames its steer-ack banner produced. Text is stable copy the UI renders
 *    verbatim.
 *  - `steered` — the adapter's own steer-ack `_meta.piAcp.steered`, forwarded so
 *    the delivery record says "this end_turn was an absorbed steer", not a
 *    completed turn of its own. `stopReason` STAYS `"end_turn"` — the union (and
 *    the dedup logic keyed on it, `hasCompletedDeliveryFor` below) is unchanged:
 *    a steered message still reached and was acted on by the agent, so it must
 *    still dedup like any other delivered prompt — only its COMPLETION status is
 *    what changes here.
 */
export const ZERO_AGENT_OUTPUT_WARNING = "completed with no agent output";
export const STEERED_INTO_ACTIVE_TURN_WARNING = "steered into active turn";

/**
 * Stop reasons that prove a delivery genuinely COMPLETED A TURN OF ITS OWN
 * (not dedup echoes, not an absorbed steer). `steered` must be read explicitly:
 * codex's absorbed-steer terminal gets this for free via `stopReason: null`,
 * but pi's steer-ack reuses the genuine `"end_turn"` value, so without this
 * check pi's terminals wrongly pass a test codex's structurally cannot
 * (brick 7ada04b9 — the load-bearing defect behind the 2026-09-24 recurrence).
 */
export function isGenuineCompletionStopReason(
  stopReason: DeliveryStopReason | undefined | null,
  steered?: boolean,
): stopReason is "end_turn" | "max_tokens" | "max_turns" {
  if (steered) {
    return false;
  }
  return stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "max_turns";
}

/**
 * The zero-output warning for a delivery terminal, or `undefined` — one half of
 * the SINGLE decision every terminal path shares (`deliveryTerminalWarning`
 * below). Deliberately narrow, so it cannot cry wolf:
 *
 *  - `done` terminals only — a cancelled/failed terminal with no frames is
 *    unremarkable;
 *  - genuine stop reasons only — `deduplicated` deliveries have no turn at all,
 *    the codex absorbed-steer terminal carries `stopReason: null` BY DESIGN
 *    (the steer acts inside the containing turn; it produces no frames of its own),
 *    and a `steered: true` terminal is never genuine either (see
 *    `isGenuineCompletionStopReason`) — that case gets `steeredDeliveryWarning`
 *    instead, unconditionally, regardless of frame count;
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
  /** brick 7ada04b9 — an absorbed steer is never a genuine completion window. */
  steered?: boolean;
  /** Global session/update frame count snapshotted at the delivery's `accepted`. */
  framesAtStart: number | undefined;
  /** Global session/update frame count read at terminal time. */
  framesAtTerminal: number;
}): string | undefined {
  if (!params.terminal || params.phase !== "done") {
    return undefined;
  }
  if (!isGenuineCompletionStopReason(params.stopReason, params.steered)) {
    return undefined;
  }
  if (params.framesAtStart === undefined) {
    return undefined;
  }
  return params.framesAtTerminal === params.framesAtStart ? ZERO_AGENT_OUTPUT_WARNING : undefined;
}

/**
 * The "steered into active turn" annotation for a delivery terminal, or
 * `undefined` — brick 7ada04b9, the other half of `deliveryTerminalWarning`.
 * Fires on ANY `done` terminal carrying `steered: true`, independently of frame
 * count: pi-acp's steer-ack (ec12cdb, deployed) now emits two cosmetic
 * `session/update` frames on every absorbed steer (a banner chunk + a
 * session_info_update), so a frame-count check alone can never again
 * distinguish "steered, cosmetic frames only" from "genuinely produced
 * output" — the `steered` flag itself is the only signal that still works.
 * This is what makes the zero-output warning survive that cosmetic frame: the
 * steered case is routed here instead of through the frame-counting check
 * entirely, rather than trying to out-count the banner.
 */
export function steeredDeliveryWarning(params: {
  terminal: boolean;
  phase: DeliveryPhase;
  steered?: boolean;
}): string | undefined {
  if (!params.terminal || params.phase !== "done" || !params.steered) {
    return undefined;
  }
  return STEERED_INTO_ACTIVE_TURN_WARNING;
}

/**
 * The delivery-terminal warning — the SINGLE decision every terminal path
 * shares (brick ddd76838 / 7ada04b9). `steeredDeliveryWarning` is tried first:
 * a steered terminal always reports "steered into active turn", never the
 * zero-output warning, however many cosmetic frames its ack produced.
 *
 * ⚠️ The `??` here is DEFENSE IN DEPTH, not the load-bearing guarantee — read
 * this before "simplifying" it away or citing a test against it as proof of
 * ordering. Both branches read the SAME `params.steered`, and
 * `zeroAgentOutputWarning`'s own precondition (`isGenuineCompletionStopReason`'s
 * explicit `steered` check) already returns `undefined` for every steered
 * input before this `??` has anything to choose between — so today the two
 * functions' non-undefined results can never collide, and no standing test can
 * prove this ordering matters without mutating `isGenuineCompletionStopReason`
 * itself (mutation testing is forbidden in this repo). The real, provable
 * guarantee lives in `isGenuineCompletionStopReason`'s own unit coverage. This
 * `??` exists so that IF that guard ever regresses on its own — someone drops
 * the `steered` parameter, say — a steered terminal still gets the correct
 * annotation instead of silently reverting to the pre-7ada04b9 defect.
 */
export function deliveryTerminalWarning(params: {
  terminal: boolean;
  phase: DeliveryPhase;
  stopReason?: DeliveryStopReason;
  steered?: boolean;
  framesAtStart: number | undefined;
  framesAtTerminal: number;
}): string | undefined {
  return steeredDeliveryWarning(params) ?? zeroAgentOutputWarning(params);
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
 *
 * ⚠️ DELIBERATELY does NOT read `steered` (brick 7ada04b9) — this answers "was this
 * messageId ever delivered to and acted on by the agent", not "did it complete a turn
 * of its own". A steered message's content DID reach the agent (that is what
 * absorption means), so it must still dedup like any other delivered prompt or a
 * retry would re-send content the agent already saw. Only the delivery's COMPLETION
 * annotation (`deliveryTerminalWarning`, above) changes for a steered terminal —
 * this function's `done`-for-`messageId` contract is untouched.
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
  /** brick ddd76838 / 7ada04b9 — see `deliveryTerminalWarning`'s doc comment. */
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
