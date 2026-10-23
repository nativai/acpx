import { SessionNotFoundError } from "../errors.js";
import {
  listSessionIndexEntries,
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
 * seat's `brick_id` + `brick_id_validated`, then `metadata.brick` + `brick_validation` on EVERY
 * holder of the seat — active, retired and prepared alike (and on any record the caller names).
 *
 * 🛑 EVERY HOLDER, NOT ONLY THE ACTIVE ONE (brick fced3ab0). A retired holder left out kept the old
 * `metadata.brick`; after `--unset` the seat has no link, `decideBrick` reads that as UNKNOWN (the
 * rule pre-link seats need) and fell back to the stale cache, so the retired holder still "had"
 * the detached brick. Clearing the cache everywhere keeps that rule AND makes every reader agree. `sessions set-metadata brick`, `seats
 * set-brick` and the mint/join paths' cache all spell the pair through `withBrickCache`; a path that
 * wrote one half was the defect (a detach that did not detach, an index that said `validated` for
 * a ref `brick show` had not found).
 *
 * `link === undefined` is a DETACH: the seat's link and the cache are cleared together.
 *
 * 🛑 RE-POINTING A LINKED SEAT IS A DELIBERATE ACT (brick 641ea2f3, Daniel: "a session is assigned to
 * a brick and then stays there"). When the seat row already carries a DIFFERENT brick than `link`,
 * the write is REFUSED with `SeatBrickReassignRequiredError` unless the caller passes
 * `reassign: true`. The comparison reads the SEAT ROW's `brickId` (never a holder's cache) INSIDE the
 * seat-store hold, so a concurrent writer cannot slip between the check and the write. The check
 * lives HERE, in the one writer, and not in each caller's `guard`: a caller added tomorrow takes it
 * by construction. Unlinked → link, same brick → written as today, detach → never checked.
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
  /** Permit moving a seat that is already on a DIFFERENT brick. Absent/false ⇒ that is refused. */
  reassign?: boolean;
  guard?: (store: SeatStore) => SeatRecord;
  sessionDir?: string;
}): Promise<{
  previous: SeatBrickLink | undefined;
  activeHolderId: string | null | undefined;
  reassigned: boolean;
}> {
  const sessionDir = params.sessionDir ?? sessionBaseDir();
  let previous: SeatBrickLink | undefined;
  let activeHolderId: string | null | undefined;
  let reassigned = false;
  if (params.seatId !== undefined) {
    const seatId = params.seatId;
    const seen = await withSeatStoreWrite(sessionDir, (store) => {
      const row = params.guard ? params.guard(store) : store.seats.get(seatId);
      if (row === undefined) {
        return { mutation: SEAT_STORE_NO_CHANGE, result: undefined };
      }
      const repoint = isRepoint(row.brickId, params.link);
      if (repoint && params.reassign !== true) {
        throw new SeatBrickReassignRequiredError(seatId, row.brickId?.ref, params.link?.ref);
      }
      const seats = new Map(store.seats);
      seats.set(seatId, { ...row, brickId: params.link });
      return {
        mutation: { kind: "write" as const, seats },
        result: { previous: row.brickId, activeHolderId: row.activeHolderId, reassigned: repoint },
      };
    });
    previous = seen?.previous;
    activeHolderId = seen?.activeHolderId;
    reassigned = seen?.reassigned ?? false;
  }
  for (const id of await cacheTargets(params.seatId, params.recordIds, activeHolderId)) {
    await writeCache(id, params.link);
  }
  return { previous, activeHolderId, reassigned };
}

/**
 * The seat is ALREADY on a brick and `requested` is a different one. A detach (`requested`
 * undefined) is its own explicit verb, never a re-point; an unlinked seat is a first link.
 */
function isRepoint(current: SeatBrickLink | undefined, requested: SeatBrickLink | undefined) {
  return current !== undefined && requested !== undefined && current.ref !== requested.ref;
}

export const SEAT_BRICK_REASSIGN_REQUIRED = "SEAT_BRICK_REASSIGN_REQUIRED";

/**
 * Refusal of a re-point without `reassign`. The message names IDS only: this layer never resolves a
 * brick title (resolving means running the `brick` CLI — see `parseBrickIdOrThrow`); a caller that
 * can resolve titles (acpx-ui) enriches its own rendering from `currentBrickId`/`requestedBrickId`.
 * Contract: /wisdom/Bricks/641ea2f3-849f-4289-828a-9c03b7737805/conception/CONTRACT.md.
 */
export class SeatBrickReassignRequiredError extends Error {
  readonly code = SEAT_BRICK_REASSIGN_REQUIRED;

  constructor(
    readonly seatId: string,
    readonly currentBrickId: string | undefined,
    readonly requestedBrickId: string | undefined,
  ) {
    const current = (currentBrickId ?? "").slice(0, 8);
    super(
      `refused: seat ${seatId.slice(0, 8)} is already on brick ${current}.\n` +
        `A session stays on the brick it was assigned to; this would re-point it to ` +
        `${(requestedBrickId ?? "").slice(0, 8)}.\n` +
        `New work that came up mid-session: file it as a part of your own brick\n` +
        `  (brick new "<title>" --part-of ${current}) or give it to a new session linked at ` +
        `spawn (acpx sessions new … --brick <uuid>).\n` +
        `Moving this seat is really intended? Re-run with --reassign.`,
    );
    this.name = "SeatBrickReassignRequiredError";
  }
}

// The named records, the row's active holder, and every holder the index lists for the seat.
async function cacheTargets(
  seatId: string | undefined,
  recordIds: readonly string[] | undefined,
  activeHolderId: string | null | undefined,
): Promise<Set<string>> {
  const targets = new Set<string>(recordIds ?? []);
  if (activeHolderId) {
    targets.add(activeHolderId);
  }
  for (const id of seatId === undefined ? [] : await seatHolderIds(seatId)) {
    targets.add(id);
  }
  return targets;
}

// THE ONE HOLDER ENUMERATION: every index entry carrying this seat id. Best-effort and loud like
// the cache step itself — an unreadable index degrades to the active holder + named records.
async function seatHolderIds(seatId: string): Promise<string[]> {
  try {
    return (await listSessionIndexEntries())
      .filter((entry) => entry.seatId === seatId)
      .map((entry) => entry.acpxRecordId);
  } catch (error) {
    process.stderr.write(
      `[acpx] warning: could not list the holders of seat ${seatId} to update their brick cache: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return [];
  }
}

async function writeCache(recordId: string, link: SeatBrickLink | undefined): Promise<void> {
  try {
    const record = await resolveSessionRecord(recordId);
    if (cacheMatches(record.metadata, link)) {
      return; // already in step — no write, so a retired holder's record is not churned
    }
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

// Whether `withBrickCache` would change nothing. Compared key-for-key WITHOUT naming the field:
// the cache pair is spelled only in seat-brick.ts (`brick-decision-sites.test.ts` holds that).
function cacheMatches(
  metadata: Record<string, string> | undefined,
  link: SeatBrickLink | undefined,
): boolean {
  const before = metadata ?? {};
  const after = withBrickCache(metadata, link) ?? {};
  const keys = Object.keys(after);
  return (
    keys.length === Object.keys(before).length && keys.every((key) => before[key] === after[key])
  );
}
