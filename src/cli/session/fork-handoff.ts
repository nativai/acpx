import { resolveAcpxUiBaseUrl } from "../../acp/auth-env.js";
import type { SessionRecord } from "../../types.js";

/**
 * Stable sentinel that MUST be the first line of every fork divergence notice.
 * The frontend keys on this string (not on exact prose) so the peel cannot
 * silently drift as wording changes.
 */
export const FORK_NOTICE_MARKER = "⟦FORK-NOTICE⟧";

/**
 * Compose the divergence notice delivered as turn 1 to every plain (non-ephemeral)
 * fork. All fields are sourced from the fork's own record — nothing is fabricated.
 * Mirrors the spirit of BYWAY_DIVERGENCE_HANDOFF (bywayPrompt.ts) but covers the
 * plain-fork case and adds the self-message-mitigation clause.
 *
 * Plain prose, no markdown — fork user bubbles render RAW.
 * Begins with FORK_NOTICE_MARKER on its own line.
 * Ends with \n\n so any following handoff prompt starts on its own line.
 */
export function composeForkDivergenceNotice(fork: SessionRecord, sourceSessionId: string): string {
  const ownUrl = `${resolveAcpxUiBaseUrl(process.env)}/?session=${fork.acpxRecordId}`;
  const ownName = fork.name ?? fork.acpxRecordId;
  const forkIndex = fork.forkedAtMessageIndex;
  const indexClause =
    forkIndex != null
      ? `Inherited context ends at message ${forkIndex} (everything above that index was copied from the source before the fork).`
      : `Inherited context is reference-only.`;

  return (
    `${FORK_NOTICE_MARKER}\n` +
    `You are a FORK — a divergent copy, not a continuation of the original session. ` +
    `Your identity is "${ownName}" (${ownUrl}). ` +
    `You were forked from session ${sourceSessionId}. ` +
    `${indexClause}\n\n` +
    `SELF-MESSAGE MITIGATION: You will likely perceive this message and the transcript above as coming ` +
    `from yourself, because you carry the source session's full context — but you ARE the fork, not the source; ` +
    `this instruction is addressed to YOU. ` +
    `Confirm with \`echo "$ACPX_SESSION_URL"\` (it will return YOUR id: ${fork.acpxRecordId}) before acting. ` +
    `Run \`printenv | grep ACPX_\` to see your live identity: ACPX_SESSION_NAME names YOU, not the source.\n\n` +
    `REFERENCE-ONLY HISTORY: Any session id, URL, env dump (printenv output, echo $ACPX_SESSION_URL, ` +
    `ACPX_SESSION_URL=… lines), startup primer, agents.md identity block, or self-identification shown ` +
    `in the COPIED transcript above is the SOURCE's, from before the fork — NOT your live identity. ` +
    `Your live $ACPX_SESSION_URL (= ${fork.acpxRecordId}) is the only authoritative source of your identity.\n\n` +
    `DO NOT resume or continue the inherited task. Drop any standing duties from the transcript ` +
    `(monitoring, heartbeat reports, task ownership, coordination, or any "fork/spawn yourself" framing) — ` +
    `those stay with the original line. ` +
    (forkIndex != null
      ? `Your scope is only what follows below this notice.`
      : `Confirm your identity and await instruction.`) +
    `\n\n`
  );
}
