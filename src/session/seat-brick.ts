import fs from "node:fs";
import type { SessionRecord } from "../types.js";
import {
  parseSeatStore,
  readSeatStore,
  seatFromStore,
  seatStorePath,
  type SeatRecord,
} from "./persistence/seat-store.js";

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
  sessionDir: string,
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

/** The synchronous twin, for the callers that decide inside a sync lock (the brick outbox).
 * Same fail-open contract; the SAME `decideBrick`, so the two cannot drift. */
export function decideSessionBrickSync(
  subject: BrickSubject,
  sessionDir: string,
): DecidedBrick | undefined {
  let seat: SeatRecord | undefined;
  if (subject.seatId !== undefined) {
    try {
      const storePath = seatStorePath(sessionDir);
      seat = seatFromStore(
        parseSeatStore(fs.readFileSync(storePath, "utf8"), storePath),
        subject.seatId,
      );
    } catch {
      seat = undefined;
    }
  }
  return decideBrick(seat, subject.metadata);
}

/** The synchronous twin, for the callers that read inside a sync lock (the brick outbox).
 * Same fail-open contract: any unreadable store, a missing seat or a blank name is `null`. */
export function seatNameSync(seatId: string | undefined, sessionDir: string): string | null {
  if (seatId === undefined) {
    return null;
  }
  try {
    const storePath = seatStorePath(sessionDir);
    const name = seatFromStore(
      parseSeatStore(fs.readFileSync(storePath, "utf8"), storePath),
      seatId,
    )?.name;
    return name?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The cache a seated (or seat-less) holder carries for a brick link: `metadata.brick` and its
 * validation word TOGETHER, or neither. THE ONLY place the pair is spelled — a state word that
 * outlives its ref (or a ref with a stale word) is exactly the "validated-by-assumption" bug.
 * `link === undefined` clears both (a detach). Returns `undefined` rather than `{}`.
 */
export function withBrickCache(
  metadata: Record<string, string> | undefined,
  link: { readonly ref: string; readonly validated: boolean } | undefined,
): Record<string, string> | undefined {
  const { brick: _brick, brick_validation: _word, ...rest } = metadata ?? {};
  if (link === undefined) {
    return Object.keys(rest).length > 0 ? rest : undefined;
  }
  return {
    ...rest,
    brick: link.ref,
    brick_validation: link.validated ? "validated" : "unvalidated",
  };
}
