import type { SessionConversation, SessionMessage, SessionRecord } from "../types.js";

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

// ---------------------------------------------------------------------------------------------
// C3.5 (i) — WHOSE INLINE ENTRY IS IT (A-60). A write appends to the messages log only its OWN
// entries. An inline entry that a hydrate loaded from disk belongs to whoever published it (the
// owner's streamed partial, usually): an outside writer's copy of it stays unlogged, and its
// publisher logs it at its own boundary.
//
// "Loaded" is by IDENTITY plus the bytes it had at load, so an entry this writer then CHANGED (a
// retry streaming into it) is its own again — never lost to a stale mark. The writer also keeps
// what ITS OWN last write published inline (`ownInlinePublished`, keyed by its messages array, like
// the logged count): the next write replaces exactly those on disk and leaves every other inline
// entry as it finds it. A second copy of the record in the same process has its own array, so it
// neither owns nor erases the first copy's partial.
// ---------------------------------------------------------------------------------------------
const loadedInlineSerialization = new WeakMap<object, string>();
const ownInlinePublished = new WeakMap<object, ReadonlySet<string>>();

export function markLoadedInlineEntries(entries: readonly SessionMessage[]): void {
  for (const entry of entries) {
    // The bare "Resume" marker is a string: nothing to key on, and nobody else's partial.
    if (typeof entry === "object") {
      loadedInlineSerialization.set(entry, JSON.stringify(entry));
    }
  }
}

/** What this copy's last write published inline as its own unfinished entries (serialized). */
export function getOwnInlinePublished(carrier: MessageCarrier): ReadonlySet<string> {
  return ownInlinePublished.get(carrier.messages) ?? new Set();
}

export function setOwnInlinePublished(carrier: MessageCarrier, serialized: ReadonlySet<string>) {
  ownInlinePublished.set(carrier.messages, serialized);
}

/** True for an entry another writer published inline and this copy still holds as it was loaded. */
export function isForeignInlineEntry(carrier: MessageCarrier, entry: SessionMessage): boolean {
  const atLoad = typeof entry === "object" ? loadedInlineSerialization.get(entry) : undefined;
  if (atLoad === undefined) {
    return false;
  }
  return atLoad === JSON.stringify(entry) && !getOwnInlinePublished(carrier).has(atLoad);
}
