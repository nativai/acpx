import { InvalidArgumentError, type Command } from "commander";
import { normalizeName, resolveSessionRecord } from "../session/persistence.js";
import type { SessionRecord } from "../types.js";
import { resolveSessionSelectorFromFlags, type SessionSelectorFlags } from "./flags.js";

export type SessionTargetSelector = {
  name?: string;
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

export function resolveSessionTargetSelector(params: {
  flags: SessionSelectorFlags;
  command: Command;
  positionalName?: string;
}): SessionTargetSelector {
  const flags = resolveSessionSelectorFromFlags(params.flags, params.command);
  const name = resolveSelectorName(flags.session, params.positionalName);
  assertCompatibleSelectors(name, flags);

  return {
    name,
    sessionId: flags.sessionId,
    sessionUrl: flags.sessionUrl,
  };
}

function resolveSelectorName(flagName: string | undefined, positionalName: string | undefined) {
  const normalizedPosition = normalizeName(positionalName);
  if (normalizedPosition !== undefined && flagName !== undefined) {
    throw new InvalidArgumentError(
      "Pass the session name either positionally or with -s/--session, not both",
    );
  }
  return normalizedPosition ?? flagName;
}

function assertCompatibleSelectors(name: string | undefined, flags: SessionSelectorFlags): void {
  assertSingleExplicitSelector(flags);
  if (name !== undefined && (flags.sessionId !== undefined || flags.sessionUrl !== undefined)) {
    throw new InvalidArgumentError(
      "Pass either a session name or --session-id/--session-url, not both",
    );
  }
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
