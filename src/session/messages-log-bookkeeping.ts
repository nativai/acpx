import type { SessionConversation, SessionRecord } from "../types.js";

type MessageCarrier = Pick<SessionConversation | SessionRecord, "messages">;

const loggedMessageCounts = new WeakMap<object, number>();

function clampLoggedCount(carrier: MessageCarrier, count: number): number {
  return Math.max(0, Math.min(Math.trunc(count), carrier.messages.length));
}

export function getLoggedMessageCount(carrier: MessageCarrier): number {
  return clampLoggedCount(carrier, loggedMessageCounts.get(carrier as object) ?? 0);
}

export function setLoggedMessageCount(carrier: MessageCarrier, count: number): void {
  loggedMessageCounts.set(carrier as object, clampLoggedCount(carrier, count));
}

export function copyLoggedMessageCount(source: MessageCarrier, target: MessageCarrier): void {
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
