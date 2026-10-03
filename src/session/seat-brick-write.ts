import { SessionNotFoundError } from "../errors.js";
import {
  resolveSessionRecord,
  sessionBaseDir,
  writeSessionRecord,
} from "./persistence/repository.js";
import {
  SEAT_STORE_NO_CHANGE,
  withSeatStoreWrite,
  type SeatBrickLink,
  type SeatRecord,
  type SeatStore,
} from "./persistence/seat-store.js";
import { withBrickCache } from "./seat-brick.js";

/**
 * THE ONE WRITER OF A SESSION'S BRICK LINK (brick fb1a7a9c, TE verdict te-fail on 4423697c).
 *
 * For a SEATED record the seat is the authority and the cache is ALWAYS written WITH it: the
 * seat's `brick_id` + `brick_id_validated`, then `metadata.brick` + `brick_validation` on the seat's
 * active holder (and on any record the caller names). `sessions set-metadata brick`, `seats
 * set-brick` and the mint/join paths' cache all spell the pair through `withBrickCache`; a path that
 * wrote one half was the defect (a detach that did not detach, an index that said `validated` for
 * a ref `brick show` had not found).
 *
 * `link === undefined` is a DETACH: the seat's link and the cache are cleared together.
 *
 * - `seatId` absent (a seat-less record): only the named records' caches are written.
 * - the seat row missing: the seat step is skipped (a row-less record is a legitimate state), the
 *   caches are still written.
 * - `guard` runs INSIDE the seat-store hold and may throw a refusal — `seats set-brick` passes its
 *   own (unhealthy store / missing row) so the verb keeps its exact refusals.
 * - the cache step is best-effort and loud: the seat is the authority, so a holder that cannot be
 *   rewritten is said on stderr, never failed over.
 */
export async function writeBrickLink(params: {
  seatId?: string;
  recordIds?: readonly string[];
  link: SeatBrickLink | undefined;
  guard?: (store: SeatStore) => SeatRecord;
  sessionDir?: string;
}): Promise<{ previous: SeatBrickLink | undefined; activeHolderId: string | null | undefined }> {
  const sessionDir = params.sessionDir ?? sessionBaseDir();
  let previous: SeatBrickLink | undefined;
  let activeHolderId: string | null | undefined;
  if (params.seatId !== undefined) {
    const seatId = params.seatId;
    const seen = await withSeatStoreWrite(sessionDir, (store) => {
      const row = params.guard ? params.guard(store) : store.seats.get(seatId);
      if (row === undefined) {
        return { mutation: SEAT_STORE_NO_CHANGE, result: undefined };
      }
      const seats = new Map(store.seats);
      seats.set(seatId, { ...row, brickId: params.link });
      return {
        mutation: { kind: "write" as const, seats },
        result: { previous: row.brickId, activeHolderId: row.activeHolderId },
      };
    });
    previous = seen?.previous;
    activeHolderId = seen?.activeHolderId;
  }
  const targets = new Set<string>(params.recordIds ?? []);
  if (activeHolderId) {
    targets.add(activeHolderId);
  }
  for (const id of targets) {
    await writeCache(id, params.link);
  }
  return { previous, activeHolderId };
}

async function writeCache(recordId: string, link: SeatBrickLink | undefined): Promise<void> {
  try {
    const record = await resolveSessionRecord(recordId);
    // MUTATE THE LOADED RECORD, never spread it into a new object: the metadata baseline that lets a
    // write persist a key's DELETION (a detach) is keyed on this object's identity
    // (`metadata-merge.ts`), and a copy has none — its write is a union with the disk, so a cleared
    // `brick` would be merged straight back.
    record.metadata = withBrickCache(record.metadata, link);
    await writeSessionRecord(record);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return; // a holder whose record is gone has no cache to keep in step
    }
    process.stderr.write(
      `[acpx] warning: could not update the brick cache on session ${recordId}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}
