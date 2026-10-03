import { InvalidArgumentError } from "commander";
import { SessionNotFoundError } from "../../errors.js";
import {
  mergeSessionOptions,
  sessionOptionsFromRecord,
  type SessionAgentOptions,
} from "../../runtime/engine/session-options.js";
import { resolveSessionRecord } from "../../session/persistence.js";
import type { SessionRecord } from "../../types.js";
import { parseSessionIdFromUrl } from "../session-selector.js";

// `sessions new --from <old-session-id|url>` (brick 06b01b6b; Daniel 2026-09-28: "passing in an
// old session and … relevant options are being automatically transferred"). The old session is a
// source of DEFAULTS: every explicit flag on the command line still wins. What transfers is
// exactly: model, effort, subscription/profile, auto-failover policy, allowed tools, system
// prompt, output style, cwd, parent, brick link — and, when the old session holds a seat, the
// new session is created INTO that seat as its prepared successor. Nothing else (name, history,
// favorite, closed state). The model/effort/profile/output-style/brick legs ride the existing
// parent-inheritance code in command-handlers.ts; this module owns the rest.

/** Resolve `--from` by acpx record id or acpx-ui session URL — never by name. */
export async function resolveFromSessionRecord(ref: string): Promise<SessionRecord> {
  const id = parseSessionIdFromUrl(ref) ?? ref.trim();
  try {
    return await resolveSessionRecord(id);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      throw new InvalidArgumentError(`--from refers to unknown session: ${ref}`);
    }
    throw error;
  }
}

/** `--from` names a predecessor; `--from-template` instantiates a template. Never both. */
export function refuseFromWithTemplate(flags: { from?: string; fromTemplate?: string }): void {
  if (flags.from !== undefined && flags.fromTemplate !== undefined) {
    throw new InvalidArgumentError("--from cannot be combined with --from-template");
  }
}

/**
 * The parent flags `--from` supplies when the command line names none: the old session's own
 * parent. `undefined` when an explicit parent flag is present or the old session has no parent.
 */
export function fromParentFlags(
  flags: { parentId?: string; parentSessionUrl?: string },
  from: SessionRecord | undefined,
): { parentId?: string; parentSessionUrl?: string } | undefined {
  if (!from?.parentSessionId || flags.parentId || flags.parentSessionUrl) {
    return undefined;
  }
  return { parentId: from.parentSessionId, parentSessionUrl: from.parentSessionUrl };
}

/**
 * The seat a new session is created INTO: an explicit `--seat` wins; otherwise the old
 * session's seat under `--from`, which NAMES the predecessor (the handover's create step).
 * `undefined` means "mint a fresh seat", as every create does without these.
 */
export function seatToJoin(
  flags: { seat?: string },
  from: SessionRecord | undefined,
): string | undefined {
  return flags.seat ?? from?.seatId;
}

/**
 * Layer the options this module owns (allowed tools, system prompt, auto-failover policy) under
 * the already-resolved `options`. They are agent-specific, so they cross only to the same agent.
 */
export function withFromOptions(
  options: SessionAgentOptions,
  from: SessionRecord | undefined,
  sameAgent: boolean,
): SessionAgentOptions {
  if (!from || !sameAgent) {
    return options;
  }
  const { allowedTools, systemPrompt, autoFailover } = sessionOptionsFromRecord(from) ?? {};
  return mergeSessionOptions(options, { allowedTools, systemPrompt, autoFailover }) ?? options;
}

/** The agent-specific options the old session carries, named for the "skipped" note. */
export function agentSpecificOptionsOf(from: SessionRecord): string[] {
  const stored = sessionOptionsFromRecord(from) ?? {};
  const effort = stored.reasoningEffort ?? from.acpx?.desired_config_options?.effort;
  const present: Array<[string, unknown]> = [
    ["model", stored.model],
    ["effort", effort],
    ["profile", stored.profile ?? stored.subscription],
    ["output style", stored.outputStyle],
    ["allowed tools", stored.allowedTools],
    ["system prompt", stored.systemPrompt],
    ["auto-failover", stored.autoFailover],
  ];
  return present.filter(isPresent).map(([name]) => name);
}

function isPresent([, value]: [string, unknown]): boolean {
  return value !== undefined;
}

/** One stderr line when agent-specific options were NOT carried because the agents differ. */
export function skippedFromOptionsNote(from: SessionRecord, ref: string): string | undefined {
  const skipped = agentSpecificOptionsOf(from);
  if (skipped.length === 0) {
    return undefined;
  }
  return (
    `[acpx] --from ${ref}: skipped ${skipped.join(", ")} — the new session's agent differs ` +
    `from the old session's, and these options are agent-specific\n`
  );
}
