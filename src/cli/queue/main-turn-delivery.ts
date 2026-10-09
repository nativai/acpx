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
// A TURN THAT ENDED ON ITS OWN NEVER GETS THE CLOSE'S CODE. The runtime sets `turnEndedOnItsOwn` synchronously
// the moment the prompt resolves with a stop the close did not cause (runtime.ts `mainTurnEndedOnItsOwn`), ahead
// of the awaits that precede its terminal. If the SIGTERM lands in that gap the sweep writes nothing: the turn's
// own `done` is lost with the process, and no terminal reads as done/delivered — which, for a finished turn, is
// the truth. Only a turn that had not resolved, or resolved cancelled / cut, is the close's doing.
export type OpenMainTurnDelivery = {
  context: { messageId: string; requestId: string };
  terminalClaimed: boolean;
  turnEndedOnItsOwn: boolean;
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
 * The owner-exit half for a session close: removes the session's open main delivery and returns its context when
 * the close cut that turn and THIS call won the claim — the caller must then write the close's terminal.
 * `undefined` when no main turn is open (an idle close), the turn ended on its own, or the runtime already claimed
 * it (its terminal is written or being written).
 */
export function claimMainTurnCutByClose(
  sessionId: string,
): OpenMainTurnDelivery["context"] | undefined {
  const delivery = openMainTurnDeliveries.get(sessionId);
  if (!delivery) {
    return undefined;
  }
  openMainTurnDeliveries.delete(sessionId);
  if (delivery.turnEndedOnItsOwn) {
    return undefined;
  }
  return claimMainTurnDeliveryTerminal(delivery) ? delivery.context : undefined;
}
