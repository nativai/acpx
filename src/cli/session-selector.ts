import { InvalidArgumentError, type Command } from "commander";
import { normalizeName, resolveSessionRecord } from "../session/persistence.js";
import type { SessionRecord } from "../types.js";
import { resolveSessionSelectorFromFlags, type SessionSelectorFlags } from "./flags.js";

export type SessionTargetSelector = {
  sessionId?: string;
  sessionUrl?: string;
};

export function parseSessionIdFromUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get("session");
    return id && id.trim().length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
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
  };
}

function assertSingleExplicitSelector(flags: SessionSelectorFlags): void {
  if (flags.sessionId !== undefined && flags.sessionUrl !== undefined) {
    throw new InvalidArgumentError("Pass only one of --session-id or --session-url");
  }
}

export function explicitSessionIdFromSelector(selector: SessionTargetSelector): string | undefined {
  if (selector.sessionUrl !== undefined) {
    const id = parseSessionIdFromUrl(selector.sessionUrl);
    if (!id) {
      throw new InvalidArgumentError(
        "--session-url must include a non-empty ?session=<id> query parameter",
      );
    }
    return id;
  }
  return selector.sessionId;
}

export async function resolveExplicitSessionRecord(
  selector: SessionTargetSelector,
): Promise<SessionRecord | undefined> {
  const sessionId = explicitSessionIdFromSelector(selector);
  return sessionId === undefined ? undefined : await resolveSessionRecord(sessionId);
}

export class NoSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoSessionError";
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
