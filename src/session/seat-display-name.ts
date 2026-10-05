import type { SessionRecord } from "../types.js";
import { sessionBaseDir } from "./persistence.js";
import { readSeatStore, seatFromStore } from "./persistence/seat-store.js";

/**
 * The DISPLAY label for a session: its SEAT's name (D-IDENTITY, brick 61dc1302 —
 * a session has no name; the seat does, and the name identifies nothing). Feeds
 * only `ACPX_SESSION_NAME`, the git author name and the agent-folder slug.
 *
 * Best-effort by contract: a label must never fail a spawn, so a missing,
 * unhealthy or malformed seat store, a seat-less record and a nameless seat all
 * yield `undefined` — there is no record-side name to fall back to
 * (D-NAME-HARD-MIGRATION: the name lives on the seat only; callers show the uuid8).
 */
export async function seatDisplayName(
  record: Pick<SessionRecord, "seatId">,
): Promise<string | undefined> {
  if (record.seatId !== undefined) {
    try {
      const name = seatFromStore(await readSeatStore(sessionBaseDir()), record.seatId)?.name;
      const trimmed = name?.trim();
      if (trimmed) {
        return trimmed;
      }
    } catch {
      // display-only: a label never fails a spawn
    }
  }
  return undefined;
}
