import { InvalidArgumentError, type Command } from "commander";
import {
  normalizeName,
  parseSeatRefOrThrow,
  readSeatStore,
  resolveSessionRecord,
  seatFromStore,
  sessionBaseDir,
} from "../session/persistence.js";
import { archivedSeatRefusal } from "../session/persistence/seat-archive.js";
import { SEAT_UNRESOLVED_DETAIL_CODE, type SessionRecord } from "../types.js";
import { resolveSessionSelectorFromFlags, type SessionSelectorFlags } from "./flags.js";

export type SessionTargetSelector = {
  sessionId?: string;
  sessionUrl?: string;
  /** `--seat <uuid|?seat= url>` — resolved to the seat's ACTIVE holder at call time. */
  seat?: string;
};

function urlParam(url: string | undefined, key: "session" | "seat"): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const id = new URL(url).searchParams.get(key);
    return id && id.trim().length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

export function parseSessionIdFromUrl(url: string | undefined): string | undefined {
  return urlParam(url, "session");
}

/** The `?seat=<id>` of an acpx-ui URL, when it carries one (unvalidated). */
export function parseSeatIdFromUrl(url: string | undefined): string | undefined {
  return urlParam(url, "seat");
}

/**
 * A seat reference — a seat id, or an acpx-ui URL carrying `?seat=<id>` — reduced to the
 * seat id, validated at this origin (D8: rejected, never repaired). A URL naming BOTH a
 * seat and a session is refused: it names two agents, and picking one silently is the
 * defect class this resolver exists to close.
 */
export function seatIdFromRef(label: string, value: string): string {
  if (value.includes("?") || value.includes("://")) {
    if (parseSessionIdFromUrl(value) !== undefined && parseSeatIdFromUrl(value) !== undefined) {
      throw new InvalidArgumentError(
        `${label} names both ?seat= and ?session= — pass one address, not two`,
      );
    }
    const seatId = parseSeatIdFromUrl(value);
    if (seatId === undefined) {
      throw new InvalidArgumentError(`${label} must be a seat id or a URL carrying ?seat=<id>`);
    }
    return parseSeatRefOrThrowAsArgument(label, seatId);
  }
  return parseSeatRefOrThrowAsArgument(label, value);
}

function parseSeatRefOrThrowAsArgument(label: string, value: string): string {
  try {
    return parseSeatRefOrThrow(label, value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * THE ONE SEAT → HOLDER RESOLVER (hole #18; shared by `--parent-seat`, `set-parent` and the
 * `--seat` selector). Reads the seat row fresh at CALL time and returns its ACTIVE holder,
 * so an address held across a succession reaches the successor.
 *
 * Every unresolvable case is a refusal that names its own cause — never a fallback to the
 * caller's own session, which is what made `--parent-session-url ?seat=` silently mis-parent
 * (hole #1). Thrown as `NoSessionError` (exit 4): there is no session to address. An
 * unhealthy store or a malformed row throws its own error from `seatFromStore` unchanged.
 */
export async function resolveSeatActiveHolder(
  label: string,
  value: string,
): Promise<{ seatId: string; holderId: string }> {
  const seatId = seatIdFromRef(label, value);
  const store = await readSeatStore(sessionBaseDir());
  const seat = seatFromStore(store, seatId);
  if (!seat) {
    // Brick 87497c17: same refusal, same code — but an ARCHIVED seat names its way back.
    const archived = await archivedSeatRefusal(sessionBaseDir(), seatId);
    if (archived) {
      throw new NoSessionError(`${label}: ${archived}`, SEAT_UNRESOLVED_DETAIL_CODE);
    }
    throw new NoSessionError(
      `${label}: seat ${seatId} is not in this box's seat store (${store.storePath}) — a typo, ` +
        `a seat on another box, or a seat that predates the store (\`acpx seats list\` shows ` +
        `the seats here).`,
      SEAT_UNRESOLVED_DETAIL_CODE,
    );
  }
  if (seat.closedAt !== null) {
    throw new NoSessionError(
      `${label}: seat ${seatId} is closed (at ${seat.closedAt}) — a closed seat has no holder to address.`,
      SEAT_UNRESOLVED_DETAIL_CODE,
    );
  }
  if (seat.activeHolderId === null) {
    throw new NoSessionError(
      `${label}: seat ${seatId} has no active holder (vacant) — activate one with ` +
        `\`acpx sessions activate ${seatId} <session>\`.`,
      SEAT_UNRESOLVED_DETAIL_CODE,
    );
  }
  return { seatId, holderId: seat.activeHolderId };
}

const SESSION_ID_LOOKS_LIKE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// D-IDENTITY (brick 61dc1302) — a session is addressed by its id and by nothing else, so a
// NAME handed to a verb that targets a session — through `-s/--session` or as a positional —
// is refused rather than looked up. The message names the working form; a uuid passed
// positionally gets the same hint, because that is the most likely mistake.
function refuseSessionName(via: string, value: string): never {
  const hint = SESSION_ID_LOOKS_LIKE_UUID_RE.test(value)
    ? ` "${value}" looks like a session id — pass it as --session-id ${value}.`
    : " A name identifies nothing; pass --session-id <id> (or --session-url <url>).";
  throw new InvalidArgumentError(`${via} no longer selects a session.${hint}`);
}

export function resolveSessionTargetSelector(params: {
  flags: SessionSelectorFlags;
  command: Command;
  positionalName?: string;
}): SessionTargetSelector {
  const flags = resolveSessionSelectorFromFlags(params.flags, params.command);
  const positional = normalizeName(params.positionalName);
  if (positional !== undefined) {
    refuseSessionName("A positional session name", positional);
  }
  if (flags.session !== undefined) {
    refuseSessionName("-s/--session", flags.session);
  }
  assertSingleExplicitSelector(flags);

  return {
    sessionId: flags.sessionId,
    sessionUrl: flags.sessionUrl,
    ...(flags.seat === undefined ? {} : { seat: flags.seat }),
  };
}

function assertSingleExplicitSelector(flags: SessionSelectorFlags): void {
  if (
    flags.seat !== undefined &&
    (flags.sessionId !== undefined || flags.sessionUrl !== undefined)
  ) {
    throw new InvalidArgumentError(
      "--seat cannot be combined with --session-id or --session-url — pass one address",
    );
  }
  if (flags.sessionId !== undefined && flags.sessionUrl !== undefined) {
    throw new InvalidArgumentError("Pass only one of --session-id or --session-url");
  }
}

/**
 * The session id a selector names WITHOUT a seat lookup. A seat address (`--seat`, or a
 * `--session-url` carrying `?seat=`) has no id until the store is read, so it yields
 * `undefined` here; use `resolveExplicitSessionRecord` for those.
 */
export function explicitSessionIdFromSelector(selector: SessionTargetSelector): string | undefined {
  if (selector.sessionUrl !== undefined) {
    const id = parseSessionIdFromUrl(selector.sessionUrl);
    if (!id) {
      throw new InvalidArgumentError(
        "--session-url must include a non-empty ?session=<id> (or ?seat=<id>) query parameter",
      );
    }
    return id;
  }
  return selector.sessionId;
}

// A `--session-url` that carries `?seat=` (and no `?session=`) is a seat address.
function seatRefFromSelector(selector: SessionTargetSelector): string | undefined {
  if (selector.seat !== undefined) {
    return selector.seat;
  }
  const url = selector.sessionUrl;
  return url !== undefined && parseSeatIdFromUrl(url) !== undefined ? url : undefined;
}

export async function resolveExplicitSessionRecord(
  selector: SessionTargetSelector,
): Promise<SessionRecord | undefined> {
  const seatRef = seatRefFromSelector(selector);
  if (seatRef !== undefined) {
    const label = selector.seat !== undefined ? "--seat" : "--session-url";
    const { holderId } = await resolveSeatActiveHolder(label, seatRef);
    return await resolveSessionRecord(holderId);
  }
  const sessionId = explicitSessionIdFromSelector(selector);
  return sessionId === undefined ? undefined : await resolveSessionRecord(sessionId);
}

export class NoSessionError extends Error {
  /** Read by `normalizeOutputError` (`readOutputErrorMeta`) into the rendered error. */
  readonly detailCode?: string;

  constructor(message: string, detailCode?: string) {
    super(message);
    this.name = "NoSessionError";
    if (detailCode !== undefined) {
      this.detailCode = detailCode;
    }
  }
}

// The refusal for a call that names no session — with the create form named, because
// `acpx <agent> "<prompt>"` is what a caller who forgot the id wrote, and the create is the
// one thing they may actually want (AC-ID2).
export function noSessionIdMessage(agentName: string): string {
  return (
    `⚠ No acpx session found: no session id was given. Every acpx call names its session by id — ` +
    `pass --session-id <id> ` +
    `(or --session-url <url>).\nNo session yet? Create one: acpx ${agentName} sessions new`
  );
}

export async function requireExplicitSessionRecord(
  selector: SessionTargetSelector,
  agentName: string,
): Promise<SessionRecord> {
  const record = await resolveExplicitSessionRecord(selector);
  if (!record) {
    throw new NoSessionError(noSessionIdMessage(agentName));
  }
  return record;
}
