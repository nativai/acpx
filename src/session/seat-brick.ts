import type { SessionRecord } from "../types.js";
import { sessionBaseDir } from "./persistence/repository.js";
import { readSeatStore, seatFromStore, type SeatRecord } from "./persistence/seat-store.js";

/**
 * THE ONE PLACE THAT DECIDES A SESSION'S BRICK (brick fb1a7a9c; Daniel,
 * D-BRICK-ON-SEAT: *"in future a session doesn't have a brick connection,
 * instead the seat has"*).
 *
 * A seated session's brick is its SEAT's `brick_id`. `metadata.brick` on the
 * record is a CACHE of it — written at mint and join, never the authority — so
 * every site that must act on "which brick does this session have" (the four
 * `ACPX_BRICK` env builders, the `session-started` stamp, what a child inherits)
 * asks THIS function and never reads `metadata.brick` itself.
 *
 * Falls back to `metadata.brick` in exactly two cases, and no other:
 *   - the record carries no `seatId` (a seat-less record has nothing else), or
 *   - its seat has no link (absence means UNKNOWN, not "none" — the same rule
 *     `resolveJoinedSeatBrickMetadata` applies on the join path).
 *
 * 🛑 FAILS OPEN. This runs on the spawn path of every session; an absent,
 * malformed or unreadable seat store must degrade to the cache, never refuse a
 * spawn over a brick label. (`seatFromStore` throws for the latter two on purpose;
 * the catch below is the one place that turns that into a fallback.)
 */
export type DecidedBrick = {
  readonly ref: string;
  /** `unknown` — a seat-less record or a pre-9984c510 holder: no state was ever
   * recorded, which is not the same fact as `unvalidated` (a recorded timeout). */
  readonly validation: "validated" | "unvalidated" | "unknown";
  readonly source: "seat" | "metadata";
};

type BrickSubject = Pick<SessionRecord, "seatId" | "metadata">;

/** The state word the holder's `metadata.brick_validation` cache carries. */
export function brickValidationFromMetadata(
  metadata: Record<string, string> | undefined,
): DecidedBrick["validation"] {
  const word = metadata?.brick_validation;
  return word === "validated" || word === "unvalidated" ? word : "unknown";
}

/** Pure half — the seat row (or `undefined`) and the record's cache in, the decision out. */
export function decideBrick(
  seat: Pick<SeatRecord, "brickId"> | undefined,
  metadata: Record<string, string> | undefined,
): DecidedBrick | undefined {
  const link = seat?.brickId;
  if (link !== undefined) {
    return {
      ref: link.ref,
      validation: link.validated ? "validated" : "unvalidated",
      source: "seat",
    };
  }
  const raw: unknown = metadata?.brick;
  const cached = typeof raw === "string" ? raw.trim() : undefined;
  return cached
    ? { ref: cached, validation: brickValidationFromMetadata(metadata), source: "metadata" }
    : undefined;
}

/** IO half — one `seats.json` read per call, and none for a seat-less record. */
export async function decideSessionBrick(
  subject: BrickSubject,
  sessionDir: string = sessionBaseDir(),
): Promise<DecidedBrick | undefined> {
  let seat: SeatRecord | undefined;
  if (subject.seatId !== undefined) {
    try {
      seat = seatFromStore(await readSeatStore(sessionDir), subject.seatId);
    } catch {
      seat = undefined;
    }
  }
  return decideBrick(seat, subject.metadata);
}
