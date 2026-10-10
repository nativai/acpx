import { CONSUMED_BEFORE_CUT } from "../../session/delivery-consumption.js";
import {
  ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE,
  ABSORBED_TURN_NEVER_ENDED_MESSAGE,
  CONSUMED_CUT_BY_OWNER_EXIT,
  consumedBeforeCutNote,
} from "../queue/delivery-terminals.js";
import { appendDeliveryStreamEventSync } from "../queue/ipc-server.js";

// F3 (493729fc): absorbed injected deliveries (codex steers folded into the
// active turn) are tracked in-memory inside runSessionPrompt and terminalized
// when the containing turn settles. If the queue owner exits while that turn
// never settles (a wedged codex main, a hard teardown racing the settle paths),
// nothing writes their terminals and they sit accepted-forever. This registry
// exposes the still-open list per session so the owner-exit path can write
// terminal states for them — the exact analogue of C4's owner-exit terminals
// for the pending queue.
export type RegisteredAbsorbedDelivery = {
  context: { messageId: string; requestId: string };
  terminalWritten: boolean;
  /** brick e09628a1 — set by the runtime when the model consumed the steer (R-CONSUMED). */
  consumed?: boolean;
};

/** What one owner-exit sweep wrote: `failed` outcome-unknown terminals, and `done` ones for consumed steers. */
export type AbsorbedExitSweep = { failed: number; consumed: number };

const liveAbsorbedDeliveriesBySession = new Map<string, RegisteredAbsorbedDelivery[]>();

// Registers the LIVE array (not a copy): runSessionPrompt keeps splicing it as
// deliveries settle, so at owner exit only genuinely-unsettled entries remain.
export function registerAbsorbedDeliveries(
  sessionId: string,
  deliveries: RegisteredAbsorbedDelivery[],
): void {
  liveAbsorbedDeliveriesBySession.set(sessionId, deliveries);
}

export function unregisterAbsorbedDeliveries(
  sessionId: string,
  deliveries: RegisteredAbsorbedDelivery[],
): void {
  if (liveAbsorbedDeliveriesBySession.get(sessionId) === deliveries) {
    liveAbsorbedDeliveriesBySession.delete(sessionId);
  }
}

/**
 * Writes a terminal for every absorbed delivery still open for `sessionId`.
 * The terminal is `failed` with detailCode ABSORBED_TURN_NEVER_ENDED and
 * outcome-unknown copy: the steer content DID reach the model even though its
 * turn never closed (RCA 493729fc §3.3), so consumers must surface a manual
 * resend decision — never auto-resend (double-execution risk), mirroring
 * INJECTED_RESPONSE_TIMEOUT semantics.
 *
 * brick e09628a1 (R-CONSUMED) — a steer the model had already CONSUMED gets `done / consumed_before_cut`
 * instead, with ABSORBED_TURN_NEVER_ENDED kept as the note's detailCode: the turn that carried it has ended
 * (the owner is exiting), and the model read and acted on it, so it is delivered.
 */
export function terminalizeAbsorbedDeliveriesOnOwnerExit(sessionId: string): AbsorbedExitSweep {
  const sweep: AbsorbedExitSweep = { failed: 0, consumed: 0 };
  const deliveries = liveAbsorbedDeliveriesBySession.get(sessionId);
  if (!deliveries) {
    return sweep;
  }
  liveAbsorbedDeliveriesBySession.delete(sessionId);
  for (const delivery of deliveries) {
    if (delivery.terminalWritten) {
      continue;
    }
    // Synchronous flag flip first: the settle paths racing this sweep (e.g. the
    // shared client's close rejecting the wedged prompt) check the same flag.
    delivery.terminalWritten = true;
    // D1 (brick://53437107): this is an owner-EXIT path, and it is now also
    // reached from the SIGTERM handler — so the write must be synchronous or it
    // does not survive the process (the same async-appendFile trap that lost
    // every externally-killed owner's custody).
    if (delivery.consumed) {
      appendDeliveryStreamEventSync(
        sessionId,
        delivery.context,
        "done",
        consumedBeforeCutNote(CONSUMED_CUT_BY_OWNER_EXIT, ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE),
        { stopReason: CONSUMED_BEFORE_CUT },
      );
      sweep.consumed += 1;
      continue;
    }
    appendDeliveryStreamEventSync(sessionId, delivery.context, "failed", {
      code: 0,
      message: ABSORBED_TURN_NEVER_ENDED_MESSAGE,
      detailCode: ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE,
    });
    sweep.failed += 1;
  }
  return sweep;
}
