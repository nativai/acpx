import { isClaudeAcpCommand, isClaudePtyAcpCommand } from "./agent-command.js";
import { splitCommandLine } from "./client-process.js";
import { isCodexAcpCommand } from "./codex-compat.js";
import { harnessIdForAgentCommand, HARNESS_FACTS } from "./harness-capabilities.js";

/**
 * Whether a mid-turn steer can be injected into this backend's active turn.
 *
 * B3: this was a hardcoded claude / codex / claude-pty name allow-list. It is now
 * the capability descriptor's `midTurnSteering` cell, so the declared capability
 * and the shipped behaviour cannot disagree — which is the entire failure mode
 * the descriptor exists to end. `test/harness-capabilities.test.ts` pins the two
 * against each other for every harness.
 *
 * ⚠️ The ANSWERS ARE UNCHANGED, deliberately. claude / claude-pty / codex declare
 * `midTurnSteering: true` and opencode / pi declare `false` (I1 R3, I2 R3 — neither
 * adapter supports it). This is a change of SOURCE, not of behaviour: it must stay
 * that way, because widening steering to a harness that cannot absorb an injected
 * prompt is how a turn wedges open with no terminal response.
 *
 * ⚠️ An agent command the descriptor does not classify falls back to the original
 * predicate rather than to `false`. Returning `false` for an unrecognised adapter
 * would silently disable steering for any custom `ACPX_*_ACP_COMMAND` override the
 * detectors still recognise — a regression wearing a refactor's clothes.
 */
export function supportsMidTurnPromptInjection(agentCommand: string): boolean {
  try {
    const harness = harnessIdForAgentCommand(agentCommand);
    if (harness !== undefined) {
      return HARNESS_FACTS[harness].midTurnSteering;
    }
    const { command, args } = splitCommandLine(agentCommand);
    return (
      isClaudeAcpCommand(command, args) ||
      isCodexAcpCommand(command, args) ||
      // The claude-pty bridge's interactive TUI supports native mid-turn steering, so
      // enable injection: a steer is typed straight into the running terminal rather
      // than serialized behind the active turn. (Was omitted only because this gate
      // predated the bridge; not a deliberate exclusion.)
      isClaudePtyAcpCommand(command, args)
    );
  } catch {
    return false;
  }
}

// Whether an injected (mid-turn) prompt to this backend returns a terminal
// JSON-RPC response, so the turn can safely AWAIT it (push it into the drained
// set) without risking a turn that never closes. This is narrower than
// supportsMidTurnPromptInjection: a backend can support injection yet not
// return a terminal for the injected request.
//   Claude ACP  → a separate concurrent client.prompt() that resolves with
//                 result(stopReason) and can outlive the primary — the RCA bug;
//                 awaiting it IS the fix.
//   claude-pty  → injectSteer() always resolves with a terminal (steer-ack on a
//                 landed paste, else the turn-end fallback) — safe to await.
//   Codex       → acts on the steer WITHIN the active turn and returns NO
//                 terminal for the injected request → must stay fire-and-forget
//                 (awaiting it would hold the turn open until the backstop).
//   unknown     → false (conservative: only await backends known to terminate,
//                 so an unknown fire-and-forget steer can never wedge a turn).
export function injectionReturnsTerminalResponse(agentCommand: string): boolean {
  try {
    const { command, args } = splitCommandLine(agentCommand);
    return isClaudeAcpCommand(command, args) || isClaudePtyAcpCommand(command, args);
  } catch {
    return false;
  }
}

// Whether this backend's adapter emits an end-of-turn marker session update
// (`_claude/lastTurnEndReason` for Claude / claude-pty; `_codex/lastTurnEndReason`
// for codex-acp since the 493729fc F1 fix) that the C1 turn-completion watchdog
// can arm on. Safe to include a backend whose DEPLOYED adapter predates its
// marker: the watchdog only starts timers when a marker is actually seen, so
// with no marker it never fires and long-running turns are never truncated.
export function emitsTurnEndMarker(agentCommand: string): boolean {
  try {
    const { command, args } = splitCommandLine(agentCommand);
    return (
      isClaudeAcpCommand(command, args) ||
      isClaudePtyAcpCommand(command, args) ||
      isCodexAcpCommand(command, args)
    );
  } catch {
    return false;
  }
}

// Whether a non-waiting injected prompt is known to be absorbed into the
// already-active turn without producing an independent JSON-RPC terminal. For
// these backends acpx must complete the delivery lifecycle it opens once the
// containing turn ends, otherwise observers see accepted-with-no-terminal
// forever. Keep this positive and narrow: unknown false means "do not invent
// absorbed semantics."
export function injectionAbsorbsIntoActiveTurn(agentCommand: string): boolean {
  try {
    const { command, args } = splitCommandLine(agentCommand);
    return isCodexAcpCommand(command, args);
  } catch {
    return false;
  }
}
