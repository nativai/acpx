// brick a0182aed (TE F1) — the message ids a turn of THIS queue-owner process handed to the model, per session.
//
// The runtime notes an id when it writes that delivery's `accepted` (the prompt goes on the wire right after it).
// The owner's custody sweep reads it: a DEFERRED copy of an in-flight id (`deferUntilTurnEnds`, runtime.ts) that a
// close drains is settled `done / deduplicated` when its id was accepted here — the model has it (done, or still in
// the running turn, which the close settles under e50e171d) — instead of `failed / SESSION_CLOSED_UNDELIVERED` and a
// "NOT delivered … safe to resend" the close would print about a message the agent read.
// ⚠️ DO NOT KEY THIS ON "done": the close that cuts the first copy's turn (C4b) drains the deferred copy BEFORE that
// turn writes its terminal, and acpx-ui's first-terminal-wins would then read a delivered id "Outcome unknown".
// A copy whose id was never accepted keeps SESSION_CLOSED_UNDELIVERED (C4a). test/same-id-during-connect.test.ts.
// In-process only, by design: a deferred copy exists only inside the owner process whose turn deferred it.

const MAX_IDS_PER_SESSION = 1_000;
const acceptedBySession = new Map<string, Set<string>>();

export function noteMessageAccepted(sessionId: string, messageId: string): void {
  let ids = acceptedBySession.get(sessionId);
  if (!ids) {
    ids = new Set();
    acceptedBySession.set(sessionId, ids);
  }
  ids.delete(messageId);
  ids.add(messageId);
  if (ids.size > MAX_IDS_PER_SESSION) {
    const oldest = ids.values().next().value;
    if (oldest !== undefined) {
      ids.delete(oldest);
    }
  }
}

export function wasMessageAccepted(sessionId: string, messageId: string): boolean {
  return acceptedBySession.get(sessionId)?.has(messageId) === true;
}

export function resetAcceptedMessageIdsForTests(): void {
  acceptedBySession.clear();
}
