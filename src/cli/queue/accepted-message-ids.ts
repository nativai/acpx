// brick a0182aed (TE F1) — the message ids a turn of THIS queue-owner process handed to the model, per session,
// with the request (copy) that carried each.
//
// The runtime notes an id when it writes that delivery's `accepted` (the prompt goes on the wire right after it),
// marks it when that same delivery ends `cancelled` (F3), and forgets it when it ends `failed`. The owner's custody sweep reads it: a
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
// F3 (case C6): a deferred copy whose sibling copy ended `cancelled` (the user stopped it) settles `cancelled` at the
// turn's end instead of being requeued — nothing runs after a cancel (queue-owner-runtime.ts). A sibling that ended
// `failed` is forgotten, so the deferred copy stays the re-drive.
// In-process only, by design: a deferred copy exists only inside the owner process whose turn deferred it.

const MAX_IDS_PER_SESSION = 1_000;
type CopyState = "accepted" | "cancelled";
const copiesBySession = new Map<string, Map<string, Map<string, CopyState>>>();

function copiesOf(sessionId: string, messageId: string): Map<string, CopyState> | undefined {
  return copiesBySession.get(sessionId)?.get(messageId);
}

function setCopyState(
  sessionId: string,
  messageId: string,
  requestId: string,
  state: CopyState,
): void {
  let ids = copiesBySession.get(sessionId);
  if (!ids) {
    ids = new Map();
    copiesBySession.set(sessionId, ids);
  }
  const copies = ids.get(messageId) ?? new Map<string, CopyState>();
  ids.delete(messageId);
  ids.set(messageId, copies.set(requestId, state));
  if (ids.size > MAX_IDS_PER_SESSION) {
    const oldest = ids.keys().next().value;
    if (oldest !== undefined) {
      ids.delete(oldest);
    }
  }
}

export function noteMessageAccepted(sessionId: string, messageId: string, requestId: string): void {
  setCopyState(sessionId, messageId, requestId, "accepted");
}

/** F3 — the copy ended `cancelled`: a deferred sibling copy must not run after it. */
export function noteMessageCancelled(
  sessionId: string,
  messageId: string,
  requestId: string,
): void {
  setCopyState(sessionId, messageId, requestId, "cancelled");
}

/** The copy ended `failed`: it vouches for nothing, and a deferred sibling copy is the re-drive. */
export function forgetMessageAccepted(
  sessionId: string,
  messageId: string,
  requestId: string,
): void {
  const copies = copiesOf(sessionId, messageId);
  if (!copies) {
    return;
  }
  copies.delete(requestId);
  if (copies.size === 0) {
    copiesBySession.get(sessionId)?.delete(messageId);
  }
}

function anotherCopyIn(
  sessionId: string,
  messageId: string,
  requestId: string,
  state: CopyState,
): boolean {
  for (const [copy, copyState] of copiesOf(sessionId, messageId) ?? []) {
    if (copy !== requestId && copyState === state) {
      return true;
    }
  }
  return false;
}

/** True when a copy of `messageId` OTHER than `requestId` was accepted here and has not failed or been cancelled. */
export function wasMessageAcceptedByAnotherCopy(
  sessionId: string,
  messageId: string,
  requestId: string,
): boolean {
  return anotherCopyIn(sessionId, messageId, requestId, "accepted");
}

/** F3 — true when a copy of `messageId` OTHER than `requestId` ended `cancelled` here. */
export function wasAnotherCopyCancelled(
  sessionId: string,
  messageId: string,
  requestId: string,
): boolean {
  return anotherCopyIn(sessionId, messageId, requestId, "cancelled");
}

export function resetAcceptedMessageIdsForTests(): void {
  copiesBySession.clear();
}
