import { appendDeliveryStreamEvent } from "../queue/ipc-server.js";

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
};

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
 * INJECTED_RESPONSE_TIMEOUT semantics. Returns the number of terminals written.
 */
export function terminalizeAbsorbedDeliveriesOnOwnerExit(sessionId: string): number {
  const deliveries = liveAbsorbedDeliveriesBySession.get(sessionId);
  if (!deliveries) {
    return 0;
  }
  liveAbsorbedDeliveriesBySession.delete(sessionId);
  let written = 0;
  for (const delivery of deliveries) {
    if (delivery.terminalWritten) {
      continue;
    }
    // Synchronous flag flip first: the settle paths racing this sweep (e.g. the
    // shared client's close rejecting the wedged prompt) check the same flag.
    delivery.terminalWritten = true;
    appendDeliveryStreamEvent(sessionId, delivery.context, "failed", {
      code: 0,
      message: "delivery outcome unknown — the message may have been processed",
      detailCode: "ABSORBED_TURN_NEVER_ENDED",
    });
    written += 1;
  }
  return written;
}
