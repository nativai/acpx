/**
 * UMQ K7 (CONCEPTION §6.3) — the words and the one predicate for "no agent has run yet".
 *
 * A sleeping record (`sessions new|copy --sleeping`) carries `acpSessionId: ""` and `acpx.sleeping`
 * until its first wake materialises it. EVERY reader of `acpSessionId` reads `""` as "not started":
 * it names no adapter session, no transcript file and nothing to fork or reap.
 */

/** `acpx status`, `acpx seats show` (person-facing: "Sleeping — not started yet"). */
export const SLEEPING_TEXT = "sleeping — no agent has run yet; its first message wakes it";

/** A column (`acpx sessions list`). */
export const SLEEPING_SHORT = "sleeping";

/** True for an ACP session id that names a real adapter session (a sleeping record's is `""`). */
export function namesAgentSession(acpSessionId: string | undefined): acpSessionId is string {
  return typeof acpSessionId === "string" && acpSessionId.length > 0;
}

/** True while the record is a sleeping one (never run). */
export function isSleepingRecord(record: {
  acpSessionId?: string;
  acpx?: { sleeping?: unknown };
}): boolean {
  return record.acpx?.sleeping !== undefined;
}
