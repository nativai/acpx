import type {
  DeliveryEventError,
  DeliveryRecoveredBy,
  DeliveryStopReason,
} from "../../session/delivery-events.js";

// brick 570d2570 — the running MAIN turn's delivery, as seen from the owner's exit paths.
//
// WHY. `sessions close` drains the owner, asks the adapter to close the ACP session (which cancels the turn in
// flight) and then SIGTERMs the owner. The runtime writes the main turn's terminal only at the end of its async
// success/failure path, several awaits after the prompt resolves — so the SIGTERM wins, and the owner's signal
// sweep (`terminalizeCustodyOnSignal`) covered queued custody and absorbed steers but never the main turn, which
// lived only as a closure variable inside `runSessionPrompt`. The delivery then stayed `accepted` forever and
// acpx-ui read it `done / delivered` although the close cut it mid-tool.
//
// runtime.ts and the IPC server live in the owner process but share no object, so the open delivery goes through
// a module-level map — the same shape as `session-close-intent.ts` and `absorbed-delivery-registry.ts`. State only,
// no I/O: the writer is the owner's exit path (`ipc-server.ts`), which already owns the synchronous append.
//
// ONE TERMINAL PER DELIVERY. Both writers — the runtime's choke point `appendDeliveryTerminal` and the owner's exit
// sweep — call `claimMainTurnDeliveryTerminal` SYNCHRONOUSLY, before any await, and only the caller that flips the
// flag writes. Whichever comes first wins; the other writes nothing.
//
// A TURN THAT ENDED ON ITS OWN GETS ITS OWN TERMINAL, NEVER THE CLOSE'S CODE. The runtime records `ownEnd` the
// moment the `session/prompt` RESPONSE arrives (runtime.ts `recordMainTurnOwnEnd`, called from `runPromptTurn`'s
// `onPromptResponse` — BEFORE its >=1 s late-update drain and every other await that precedes the terminal), but
// only for a stop the close did not cause (`mainTurnEndedOnItsOwn`). If the close's SIGTERM lands in that gap, the
// sweep writes THAT turn's `done` with its recorded stopReason, through the same claim. Only a turn that had not
// answered, or answered cancelled / cut, gets the close's code.
//   (570d2570 C3, test-engineer 2026-10-09: the first form recorded this only when `runPromptTurn` RETURNED, i.e.
//   after the late-update drain, and a turn ending in the drain's last second got the close's code — d4889ceb
//   L60 `end_turn`, then L61 `failed / SESSION_CLOSED_TURN_CANCELLED`.)
export type MainTurnOwnEnd = {
  stopReason: DeliveryStopReason;
  steered?: boolean;
  recoveredBy?: DeliveryRecoveredBy;
  /** The adapter's out-of-band turn-failure note, carried on a `done` the way the runtime's own terminal does. */
  error?: DeliveryEventError;
};

export type OpenMainTurnDelivery = {
  context: { messageId: string; requestId: string };
  terminalClaimed: boolean;
  ownEnd?: MainTurnOwnEnd;
};

const openMainTurnDeliveries = new Map<string, OpenMainTurnDelivery>();

export function registerOpenMainTurnDelivery(
  sessionId: string,
  delivery: OpenMainTurnDelivery,
): void {
  openMainTurnDeliveries.set(sessionId, delivery);
}

export function unregisterOpenMainTurnDelivery(
  sessionId: string,
  delivery: OpenMainTurnDelivery,
): void {
  if (openMainTurnDeliveries.get(sessionId) === delivery) {
    openMainTurnDeliveries.delete(sessionId);
  }
}

/** True for the ONE caller that may write this delivery's terminal; false for every later caller. */
export function claimMainTurnDeliveryTerminal(delivery: OpenMainTurnDelivery): boolean {
  if (delivery.terminalClaimed) {
    return false;
  }
  delivery.terminalClaimed = true;
  return true;
}

/**
 * The owner-exit half for a session close: removes the session's open main delivery and, when THIS call won the
 * claim, returns what to write — its context, plus `ownEnd` when the turn had already ended on its own (write that
 * turn's `done`), or no `ownEnd` (the close cut it: write the close's code). `undefined` when no main turn is open
 * (an idle close) or the runtime already claimed it (its terminal is written or being written).
 */
export function claimMainTurnOnSessionClose(
  sessionId: string,
): { context: OpenMainTurnDelivery["context"]; ownEnd?: MainTurnOwnEnd } | undefined {
  const delivery = openMainTurnDeliveries.get(sessionId);
  if (!delivery) {
    return undefined;
  }
  openMainTurnDeliveries.delete(sessionId);
  if (!claimMainTurnDeliveryTerminal(delivery)) {
    return undefined;
  }
  return delivery.ownEnd
    ? { context: delivery.context, ownEnd: delivery.ownEnd }
    : { context: delivery.context };
}
