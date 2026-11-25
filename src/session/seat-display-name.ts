import type { SessionRecord } from "../types.js";
import { sessionBaseDir } from "./persistence.js";
import {
  readSeatStore,
  seatFromStore,
  type SeatRecord,
  type SeatStore,
} from "./persistence/seat-store.js";

/** The seat's trimmed, non-empty name from an already-read store; `undefined` otherwise. */
export function seatNameFromStore(
  store: SeatStore,
  seatId: string | undefined,
): string | undefined {
  if (seatId === undefined) {
    return undefined;
  }
  const trimmed = seatFromStore(store, seatId)?.name?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The holder-metadata key that marks a MACHINE-MADE seat name (brick fac2128a §4.2): its value is the
 * exact name the seat was created with by acpx (a copy's `<source> (fork)` default) or by a caller that
 * passed a generated `--name` (atrium's Telegram fallback, a voice seat, a kept fork default).
 *
 * It lives on the HOLDER, never the seat row — the seat's field set is closed (Daniel, 2026-09-28,
 * `seat-store.ts`), and a seat-row key would be stripped by every field-by-field rewrite. A handover
 * successor carries it (`withInheritedSeatAutoName`); a copy never inherits the source's.
 */
export const SEAT_AUTO_NAME_KEY = "seat_auto_name";

/**
 * THE generic-name predicate (brick fac2128a §4.2) — the one place acpx decides whether a seat's agent
 * should name the seat: **generic ⇔ the seat has no name, OR the holder's `metadata.seat_auto_name`
 * equals the seat's current name.**
 *
 * "Cleared on any rename" needs no write: the predicate reads the CURRENT name, so any rename — atrium,
 * an agent, a sync, a hand edit — makes the two differ. ⚠️ Do not "harden" this by also matching name
 * PATTERNS (`(fork)`, `tg-…`, ` · voice`): live seats carry those strings as names agents and people
 * chose, so a pattern would report a person's name generic and get it overwritten
 * (`test/seat-name-generic.test.ts` → "a person-chosen name that looks machine-made is not generic").
 *
 * Fails safe: a missing marker (older acpx, a caller that forgot it) reads NOT generic for a named seat.
 * acpx-ui mirrors this function (`server/seatNameGeneric.ts`); change both together.
 */
export function seatNameIsGeneric(
  seat: Pick<SeatRecord, "name">,
  holder: Pick<SessionRecord, "metadata"> | undefined,
): boolean {
  const name = seat.name?.trim();
  if (!name) {
    return true;
  }
  return holder?.metadata?.[SEAT_AUTO_NAME_KEY] === name;
}

/**
 * Brick fac2128a §4.2 — a create keeps a `seat_auto_name` only when it equals the name the seat will
 * actually carry (`storedName`: the trimmed `-s` of a fresh mint, the joined seat's current name on a
 * join/handover); otherwise the key is DROPPED. So a caller mistake — or a handover marker gone stale
 * because the seat was renamed — can never mark a name the seat does not carry. Pure, no IO.
 */
export function withVerifiedSeatAutoName(
  metadata: Record<string, string> | undefined,
  storedName: string | undefined,
): Record<string, string> | undefined {
  const marker = metadata?.[SEAT_AUTO_NAME_KEY];
  if (marker === undefined || marker === storedName?.trim()) {
    return metadata;
  }
  const { [SEAT_AUTO_NAME_KEY]: _dropped, ...rest } = metadata ?? {};
  return Object.keys(rest).length > 0 ? rest : undefined;
}

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
  return (await seatNamingForRecord(record)).seatName;
}

/**
 * The seat's display name AND whether it is still generic ({@link seatNameIsGeneric}) for a holder
 * record, from ONE store read — what a record-backed spawn exports as `ACPX_SESSION_NAME` and
 * `ACPX_SEAT_NAME_GENERIC`. Best-effort like {@link seatDisplayName}: a seat-less record, a missing
 * row and an unreadable store all answer `generic: false` (fail safe — no automatic rename).
 */
export async function seatNamingForRecord(
  record: Pick<SessionRecord, "seatId" | "metadata">,
): Promise<{ seatName: string | undefined; generic: boolean }> {
  if (record.seatId !== undefined) {
    try {
      const seat = seatFromStore(await readSeatStore(sessionBaseDir()), record.seatId);
      if (seat) {
        const trimmed = seat.name?.trim();
        return {
          seatName: trimmed ? trimmed : undefined,
          generic: seatNameIsGeneric(seat, record),
        };
      }
    } catch {
      // display-only: a label never fails a spawn
    }
  }
  return { seatName: undefined, generic: false };
}
