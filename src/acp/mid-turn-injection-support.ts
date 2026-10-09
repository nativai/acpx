import { isClaudeAcpCommand } from "./agent-command.js";
import { splitCommandLine } from "./client-process.js";
import { isCodexAcpCommand } from "./codex-compat.js";
import { harnessIdForAgentCommand, HARNESS_FACTS } from "./harness-capabilities.js";

/**
 * Whether a mid-turn steer can be injected into this backend's active turn.
 *
 * B3: this was a hardcoded claude / codex name allow-list. It is now
 * the capability descriptor's `midTurnSteering` cell, so the declared capability
 * and the shipped behaviour cannot disagree — which is the entire failure mode
 * the descriptor exists to end. `test/harness-capabilities.test.ts` pins the two
 * against each other for every harness.
 *
 * ⚠️ The ANSWERS ARE UNCHANGED, deliberately. claude / codex declare
 * `midTurnSteering: true` and pi declares `false` (I2 R3 — its adapter does not
 * support it). This is a change of SOURCE, not of behaviour: it must stay
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
    return isClaudeAcpCommand(command, args) || isCodexAcpCommand(command, args);
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
//   Codex       → acts on the steer WITHIN the active turn and returns NO
//                 terminal for the injected request → must stay fire-and-forget
//                 (awaiting it would hold the turn open until the backstop).
//   unknown     → false (conservative: only await backends known to terminate,
//                 so an unknown fire-and-forget steer can never wedge a turn).
export function injectionReturnsTerminalResponse(agentCommand: string): boolean {
  try {
    // pi (fork build 0ecae6f+, brick 7daa105e): an injected prompt is steered into
    // the running agent loop and resolves IMMEDIATELY with a steer-ack terminal
    // (`end_turn` + `_meta.piAcp.steered`) — so awaiting it is safe and the delivery
    // lifecycle closes at ack time. On pre-steer builds (older fork / upstream) the
    // injected request resolves only at the containing turn's end; awaiting it is
    // still bounded by the drain backstop, never wedged.
    if (harnessIdForAgentCommand(agentCommand) === "pi") {
      return true;
    }
    const { command, args } = splitCommandLine(agentCommand);
    return isClaudeAcpCommand(command, args);
  } catch {
    return false;
  }
}

/**
 * What may arm the C1 turn-completion watchdog for this backend (brick a147982f).
 *
 *  - `claude-prompt-lifecycle` — claude-agent-acp. ONLY a `_claude/promptLifecycle` ext
 *    notification whose `promptId` equals the guarded attempt's own `_claude/promptId`
 *    arms it. The adapter's `_claude/lastTurnEndReason` `usage_update` marker never does:
 *    it rides on an SDK `result`, which ends one model loop, not the ACP prompt — a
 *    background Agent re-drives the model inside the same prompt after it, and the marker
 *    carries no prompt identity. Arming on it cut live work in at least 34 of 39 Claude
 *    firings. A deployed adapter that predates the lifecycle signal therefore leaves the
 *    Claude watchdog DORMANT — never firing, which is the safe direction.
 *  - `codex-turn-marker` — codex-acp. Only `_codex/lastTurnEndReason` (493729fc F1) arms it,
 *    exactly as before.
 *  - `none` — everything else, claude-pty-acp and pi-acp included: no watchdog at all.
 *
 * ⚠️ DO NOT route a Claude-family adapter to `codex-turn-marker`, and do not make
 * `claude-prompt-lifecycle` fall back to the usage_update marker "for older adapters".
 * That fallback IS the bug. `test/turn-watchdog-arming.test.ts` pins this table against real
 * command lines sampled from the live session store.
 */
export type TurnWatchdogArming = "claude-prompt-lifecycle" | "codex-turn-marker" | "none";

export function turnWatchdogArming(agentCommand: string): TurnWatchdogArming {
  try {
    const { command, args } = splitCommandLine(agentCommand);
    if (isClaudeAcpCommand(command, args)) {
      return "claude-prompt-lifecycle";
    }
    if (isCodexAcpCommand(command, args)) {
      return "codex-turn-marker";
    }
    return "none";
  } catch {
    return "none";
  }
}

// Whether this backend has a C1 turn-completion watchdog at all. What arms it is
// harness-specific — see `turnWatchdogArming`.
export function emitsTurnEndMarker(agentCommand: string): boolean {
  return turnWatchdogArming(agentCommand) !== "none";
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
