// brick a0182aed (TE F1) — the message ids a turn of THIS queue-owner process handed to the model, per session,
// with the request (copy) that carried each.
//
// The runtime notes an id when it writes that delivery's `accepted` (the prompt goes on the wire right after it),
// and forgets it when that same delivery later ends `failed` or `cancelled`. The owner's custody sweep reads it: a
// DEFERRED copy of an in-flight id (`deferUntilTurnEnds`, runtime.ts) that a close drains is settled `done /
// deduplicated` when ANOTHER copy of its id was accepted here — the model has it (done, or still in the running
// turn, which the close settles under e50e171d) — instead of `failed / SESSION_CLOSED_UNDELIVERED` and a "NOT
// delivered … safe to resend" the close would print about a message the agent read.
// ⚠️ DO NOT KEY THIS ON "done": the close that cuts the first copy's turn (C4b) drains the deferred copy BEFORE that
// turn writes its terminal, and acpx-ui's first-terminal-wins would then read a delivered id "Outcome unknown".
// ⚠️ DO NOT DROP THE "ANOTHER REQUEST" CONDITION: a context split holds a batch's newer half in custody under the
// SAME requests that were `accepted` in the overflowing attempt, and never sent; a close must fail those
// (umq-batch-turn.test.ts N-A1-7). A copy whose id never reached the model keeps SESSION_CLOSED_UNDELIVERED (C4a).
// test/same-id-during-connect.test.ts, test/accepted-message-ids.test.ts.
// In-process only, by design: a deferred copy exists only inside the owner process whose turn deferred it.

const MAX_IDS_PER_SESSION = 1_000;
const acceptedBySession = new Map<string, Map<string, Set<string>>>();

export function noteMessageAccepted(sessionId: string, messageId: string, requestId: string): void {
  let ids = acceptedBySession.get(sessionId);
  if (!ids) {
    ids = new Map();
    acceptedBySession.set(sessionId, ids);
  }
  const requests = ids.get(messageId) ?? new Set<string>();
  ids.delete(messageId);
  ids.set(messageId, requests.add(requestId));
  if (ids.size > MAX_IDS_PER_SESSION) {
    const oldest = ids.keys().next().value;
    if (oldest !== undefined) {
      ids.delete(oldest);
    }
  }
}

export function forgetMessageAccepted(
  sessionId: string,
  messageId: string,
  requestId: string,
): void {
  const ids = acceptedBySession.get(sessionId);
  const requests = ids?.get(messageId);
  if (!ids || !requests) {
    return;
  }
  requests.delete(requestId);
  if (requests.size === 0) {
    ids.delete(messageId);
  }
}

/** True when a copy of `messageId` OTHER than `requestId` was accepted here and has not failed since. */
export function wasMessageAcceptedByAnotherCopy(
  sessionId: string,
  messageId: string,
  requestId: string,
): boolean {
  const requests = acceptedBySession.get(sessionId)?.get(messageId);
  if (!requests) {
    return false;
  }
  for (const accepted of requests) {
    if (accepted !== requestId) {
      return true;
    }
  }
  return false;
}

export function resetAcceptedMessageIdsForTests(): void {
  acceptedBySession.clear();
}
