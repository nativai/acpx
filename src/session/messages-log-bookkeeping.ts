import type { SessionConversation, SessionRecord } from "../types.js";

type MessageCarrier = Pick<SessionConversation | SessionRecord, "messages">;

// Keyed by the messages ARRAY, never by the carrier (brick://5b608eaa). `applyConversation`
// makes `record` and the working `conversation` share one array, so they share one count by
// construction: a boundary write advancing it through one carrier is seen through the other,
// and nothing stale is left to copy back over it. A per-carrier count did exactly that — the
// turn's checkpoint copied the pre-append count over the fresh one and the next boundary write
// re-appended the tail (test/messages-log-injection-dup.test.ts).
//
// ⚠️ THE RULE THIS BUYS: a carrier given a NEW array starts at 0, i.e. "nothing logged", and
// its next boundary write re-appends up to the whole window. So mutate `messages` in place
// (`trimConversationForRuntime` splices); a site that must assign a new array sets its count
// in the same breath — hydrate, compaction (`markAllMessagesLogged`), a fork's fresh
// conversation (0 = append all, intended).
const loggedMessageCounts = new WeakMap<object, number>();

function clampLoggedCount(carrier: MessageCarrier, count: number): number {
  return Math.max(0, Math.min(Math.trunc(count), carrier.messages.length));
}

export function getLoggedMessageCount(carrier: MessageCarrier): number {
  return clampLoggedCount(carrier, loggedMessageCounts.get(carrier.messages) ?? 0);
}

export function setLoggedMessageCount(carrier: MessageCarrier, count: number): void {
  loggedMessageCounts.set(carrier.messages, clampLoggedCount(carrier, count));
}

export function copyLoggedMessageCount(source: MessageCarrier, target: MessageCarrier): void {
  if (source.messages === target.messages) {
    return;
  }
  setLoggedMessageCount(target, getLoggedMessageCount(source));
}

export function dropLoggedMessagesFromHead(carrier: MessageCarrier, dropped: number): void {
  if (dropped <= 0) {
    return;
  }
  setLoggedMessageCount(carrier, Math.max(0, getLoggedMessageCount(carrier) - dropped));
}

export function markAllMessagesLogged(carrier: MessageCarrier): void {
  setLoggedMessageCount(carrier, carrier.messages.length);
}
