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
// Hole #16 — every fork mints a NEW seat (Daniel, 2026-09-22), and the seat is the durable
// address, so the notice names it first. A seat-less record (pre-Seat) has only its session.
function forkIdentityClauses(
  fork: SessionRecord,
  base: string | undefined,
): { identityClause: string; confirmClause: string } {
  const ownSession = base
    ? `${base}/?session=${fork.acpxRecordId}`
    : `session id ${fork.acpxRecordId}`;
  if (!fork.seatId) {
    return {
      identityClause: `Your identity is ${ownSession}. `,
      confirmClause: `Confirm with \`echo "$ACPX_SESSION_URL"\` (it will return YOUR id: ${fork.acpxRecordId}) before acting.\n\n`,
    };
  }
  const ownSeat = base ? `${base}/?seat=${fork.seatId}` : `seat id ${fork.seatId}`;
  return {
    identityClause:
      `You hold a NEW seat, minted for this fork: your durable address is ${ownSeat} ($ACPX_SEAT_URL); ` +
      `this holder is ${ownSession} ($ACPX_SESSION_URL). `,
    confirmClause: `Confirm with \`echo "$ACPX_SEAT_URL" "$ACPX_SESSION_URL"\` (they return YOUR seat ${fork.seatId} and YOUR session ${fork.acpxRecordId}) before acting.\n\n`,
  };
}

export function composeForkDivergenceNotice(
  fork: SessionRecord,
  sourceSessionId: string,
  sourceSeatId?: string,
): string {
  // "nothing is fabricated" (above) includes the URL. Where this box's acpx-ui host
  // is unknown the fork is identified by its ids alone — which is what the notice
  // then tells it to confirm with `$ACPX_SEAT_URL` / `$ACPX_SESSION_URL` anyway. A
  // guessed host here would be read by the fork as its own address and reported
  // onward as such.
  const { identityClause, confirmClause } = forkIdentityClauses(
    fork,
    resolveAcpxUiBaseUrl(process.env),
  );
  const sourceClause = sourceSeatId
    ? `You were forked from session ${sourceSessionId} (seat ${sourceSeatId}) — that seat is the SOURCE's, not yours. `
    : `You were forked from session ${sourceSessionId}. `;
  const forkIndex = fork.forkedAtMessageIndex;
  const indexClause =
    forkIndex != null
      ? `Inherited context ends at message ${forkIndex} (everything above that index was copied from the source before the fork).`
      : `Inherited context is reference-only.`;

  // ⚠️ DO NOT ADVISE AN ENV DUMP HERE (`printenv | grep ACPX_`, `env`). It prints every
  // ACPX_* value — queue-owner payloads and credentials included — into the transcript,
  // where it is re-sent on every later turn. Name the variables; never dump them.
  return (
    `${FORK_NOTICE_MARKER}\n` +
    `You are a FORK — a divergent copy, not a continuation of the original session. ` +
    identityClause +
    sourceClause +
    `${indexClause}\n\n` +
    `SELF-MESSAGE MITIGATION: You will likely perceive this message and the transcript above as coming ` +
    `from yourself, because you carry the source session's full context — but you ARE the fork, not the source; ` +
    `this instruction is addressed to YOU. ` +
    confirmClause +
    `REFERENCE-ONLY HISTORY: Any seat or session id, URL, env value (ACPX_SEAT_URL, ACPX_PARENT_SEAT_URL, ` +
    `ACPX_SESSION_URL=… lines), startup primer, agents.md identity block, or self-identification shown ` +
    `in the COPIED transcript above is the SOURCE's, from before the fork — NOT your live identity. ` +
    `Your live $ACPX_SEAT_URL and $ACPX_SESSION_URL are the only authoritative source of your identity.\n\n` +
    `DO NOT resume or continue the inherited task. Drop any standing duties from the transcript ` +
    `(monitoring, heartbeat reports, task ownership, coordination, or any "fork/spawn yourself" framing) — ` +
    `those stay with the original line. ` +
    (forkIndex != null
      ? `Your scope is only what follows below this notice.`
      : `Confirm your identity and await instruction.`) +
    `\n\n`
  );
}
