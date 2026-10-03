import fs from "node:fs/promises";
import path from "node:path";
import { sessionArchiveDirFor } from "../archive/paths.js";
import { listSessionRecordFiles } from "./index.js";
import { readSeatStore, SEAT_STORE_NO_CHANGE, withSeatStoreWrite } from "./seat-store.js";

/**
 * A SEAT EXISTS ONLY FOR A SESSION THAT HAS A RECORD — brick `6cb4f4dc`.
 *
 * The population this module names: a seat row **none of whose holders has a session
 * record file**, in the hot tier or in the archive tier. Measured on devbox-staging:
 * acpx-ui's codex-model-catalogue probe runs `sessions new` (record written, THEN the
 * row minted — record-first, so the order is not the defect), `sessions close`, and
 * `sessions prune` — which deletes the record and never touched the row. 28–29 rows
 * were left, each naming a holder that no longer exists. Nothing reaped them.
 *
 * ## The class is deliberately NARROW, and each edge is on purpose
 *
 * - **A holder is a record FILE, not a parsed record.** An unparseable record is still
 *   a record: it is evidence the seat has a holder, and whether it parses is the
 *   repair-by-hand question, not a licence to delete the seat it names. The active
 *   holder is checked by filename (`<encoded id>.json`); every other holder is found by
 *   the `seat_id` its record carries, read tolerantly — `JSON.parse` first, then a
 *   key-anchored scan of the raw text when the file is not valid JSON.
 * - **The archive counts.** An archived session is a session with a record; the archive
 *   is flat (`<encoded id>.json`, original filenames byte for byte), so the same
 *   filename check and the same scan work there.
 * - **A malformed ROW is never touched** — only rows that parse (`store.seats`). An
 *   unparsed row is carried, never repaired (D8(4)).
 * - **An unhealthy store reaps nothing** — `findHolderlessSeats` returns `[]` and the
 *   writer refuses, so a store this module could not read cannot be shrunk by it.
 *
 * ⚠️ WHAT THIS CANNOT SEE: a non-active holder whose record is not valid JSON AND whose
 * text carries no `"seat_id": "<id>"` key. Its seat is reaped if the active holder's
 * file is also gone. That is a record with no readable link to the seat at all.
 */
export type HolderlessSeat = {
  seatId: string;
  /** The row's pointer at the time it was found — the compare-and-swap value of the reap. */
  activeHolderId: string | null;
  name: string | undefined;
};

/** The `seat_id` a record file carries, readable even when the file does not parse. */
function seatIdOfRecordText(text: string): string | undefined {
  try {
    const raw = JSON.parse(text) as unknown;
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      const seatId = (raw as Record<string, unknown>).seat_id;
      return typeof seatId === "string" && seatId.length > 0 ? seatId : undefined;
    }
    return undefined;
  } catch {
    // The leading quote is what separates `"seat_id"` from `"parent_seat_id"`.
    return /"seat_id"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  }
}

function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Only ENOENT reads as "no such tier". Any other failure THROWS: this module's verdict
 * is "no holder exists", and a directory it merely could not read must never produce it. */
async function recordFilesOf(dir: string): Promise<string[]> {
  try {
    return await listSessionRecordFiles(dir);
  } catch (error) {
    if (isAbsent(error)) {
      return [];
    }
    throw error;
  }
}

async function referencedSeatIds(dirs: readonly string[]): Promise<Set<string>> {
  const referenced = new Set<string>();
  for (const dir of dirs) {
    for (const file of await recordFilesOf(dir)) {
      let text: string;
      try {
        text = await fs.readFile(path.join(dir, file), "utf8");
      } catch (error) {
        if (isAbsent(error)) {
          continue; // moved or deleted between the listing and the read
        }
        throw error;
      }
      const seatId = seatIdOfRecordText(text);
      if (seatId !== undefined) {
        referenced.add(seatId);
      }
    }
  }
  return referenced;
}

async function recordFileExists(dirs: readonly string[], holderId: string): Promise<boolean> {
  for (const dir of dirs) {
    try {
      await fs.access(path.join(dir, `${encodeURIComponent(holderId)}.json`));
      return true;
    } catch (error) {
      if (!isAbsent(error)) {
        throw error;
      }
    }
  }
  return false;
}

/**
 * The seat rows with no holder record anywhere. `candidateSeatIds` narrows the question
 * to the seats of just-deleted records (prune); omitted, every row is asked (backfill).
 *
 * Reads only — never writes. The record scan runs only when some candidate's active
 * holder file is already gone, so the common prune (every seat still held) costs one
 * `access` per candidate.
 */
export async function findHolderlessSeats(
  sessionDir: string,
  candidateSeatIds?: ReadonlySet<string>,
): Promise<HolderlessSeat[]> {
  const store = await readSeatStore(sessionDir);
  if (store.fileState !== "ok") {
    return [];
  }
  const dirs = [sessionDir, sessionArchiveDirFor(sessionDir)];
  const maybeHolderless: HolderlessSeat[] = [];
  for (const row of store.seats.values()) {
    if (candidateSeatIds !== undefined && !candidateSeatIds.has(row.seatId)) {
      continue;
    }
    if (row.activeHolderId !== null && (await recordFileExists(dirs, row.activeHolderId))) {
      continue;
    }
    maybeHolderless.push({
      seatId: row.seatId,
      activeHolderId: row.activeHolderId,
      name: row.name,
    });
  }
  if (maybeHolderless.length === 0) {
    return [];
  }
  const referenced = await referencedSeatIds(dirs);
  return maybeHolderless.filter((seat) => !referenced.has(seat.seatId));
}

/**
 * Remove the named rows. Each is re-checked INSIDE the hold against the pointer it was
 * found with: a row whose active holder moved since (a succession landed) is left
 * alone, and a row already gone is simply not counted. Returns the ids removed.
 */
export async function reapHolderlessSeats(
  sessionDir: string,
  seats: readonly HolderlessSeat[],
): Promise<string[]> {
  if (seats.length === 0) {
    return [];
  }
  return await withSeatStoreWrite(sessionDir, (store) => {
    const remaining = new Map(store.seats);
    const reaped: string[] = [];
    for (const seat of seats) {
      if (remaining.get(seat.seatId)?.activeHolderId === seat.activeHolderId) {
        remaining.delete(seat.seatId);
        reaped.push(seat.seatId);
      }
    }
    if (reaped.length === 0) {
      return { mutation: SEAT_STORE_NO_CHANGE, result: reaped };
    }
    return { mutation: { kind: "write", seats: remaining } as const, result: reaped };
  });
}
