import type { SessionRecord } from "../types.js";
import { sessionBaseDir } from "./persistence.js";
import { readSeatStore, seatFromStore } from "./persistence/seat-store.js";

/**
 * The DISPLAY label for a session: its SEAT's name (D-IDENTITY, brick 61dc1302 —
 * a session has no name; the seat does, and the name identifies nothing). Feeds
 * only `ACPX_SESSION_NAME`, the git author name and the agent-folder slug.
 *
 * Best-effort by contract: a label must never fail a spawn, so a missing,
 * unhealthy or malformed seat store degrades to the record's LEGACY name (a box
 * not yet backfilled) and then to nothing.
 */
export async function seatDisplayName(
  record: Pick<SessionRecord, "seatId" | "legacyName">,
): Promise<string | undefined> {
  if (record.seatId !== undefined) {
    try {
      const name = seatFromStore(await readSeatStore(sessionBaseDir()), record.seatId)?.name;
      const trimmed = name?.trim();
      if (trimmed) {
        return trimmed;
      }
    } catch {
      // display-only: fall through to the legacy label
    }
  }
  return record.legacyName;
}
