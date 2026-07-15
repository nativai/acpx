import assert from "node:assert/strict";
import test from "node:test";
import {
  emitsTurnEndMarker,
  injectionAbsorbsIntoActiveTurn,
  injectionReturnsTerminalResponse,
  supportsMidTurnPromptInjection,
} from "../src/acp/mid-turn-injection-support.js";

test("supportsMidTurnPromptInjection accepts Claude ACP and Codex ACP commands", () => {
  assert.equal(supportsMidTurnPromptInjection("node /opt/claude-agent-acp/dist/index.js"), true);
  assert.equal(supportsMidTurnPromptInjection("claude-agent-acp"), true);
  assert.equal(supportsMidTurnPromptInjection("codex-acp"), true);
  assert.equal(
    supportsMidTurnPromptInjection("npx -y @agentclientprotocol/codex-acp@^0.0.44"),
    true,
  );
});

test("supportsMidTurnPromptInjection accepts the claude-pty bridge command", () => {
  // The bootstrapped built default and dev-override forms of the bridge command both
  // support native mid-turn steering, so injection must be enabled for them.
  assert.equal(supportsMidTurnPromptInjection("node /opt/claude-pty-acp/dist/index.js"), true);
  assert.equal(
    supportsMidTurnPromptInjection(
      "node /workspace/projects/claude-pty-acp/main/acp-server-transcript.mjs",
    ),
    true,
  );
});

test("supportsMidTurnPromptInjection rejects unrelated ACP command text", () => {
  assert.equal(supportsMidTurnPromptInjection("gemini --experimental-acp"), false);
  assert.equal(supportsMidTurnPromptInjection("node ./mock-agent.js --codex-compatible"), false);
  assert.equal(supportsMidTurnPromptInjection("node ./mock-agent.js --claude-compatible"), false);
  assert.equal(supportsMidTurnPromptInjection("node 'unterminated"), false);
});

// injectionReturnsTerminalResponse is NARROWER than supportsMidTurnPromptInjection:
// it gates whether the turn may AWAIT an injected prompt. Only backends whose
// injected prompt returns a terminal JSON-RPC response qualify — Claude and
// claude-pty. Codex supports injection but acts on the steer in-turn and returns
// no terminal, so it must NOT be awaited (stays fire-and-forget). Unknown
// backends default to false.
test("injectionReturnsTerminalResponse is TRUE for Claude ACP and the claude-pty bridge", () => {
  assert.equal(injectionReturnsTerminalResponse("node /opt/claude-agent-acp/dist/index.js"), true);
  assert.equal(injectionReturnsTerminalResponse("claude-agent-acp"), true);
  assert.equal(injectionReturnsTerminalResponse("node /opt/claude-pty-acp/dist/index.js"), true);
  assert.equal(
    injectionReturnsTerminalResponse(
      "node /workspace/projects/claude-pty-acp/main/acp-server-transcript.mjs",
    ),
    true,
  );
});

test("injectionReturnsTerminalResponse is FALSE for Codex (no terminal) and unknown backends", () => {
  // Codex supports injection but its injected steer returns no terminal response.
  assert.equal(injectionReturnsTerminalResponse("codex-acp"), false);
  assert.equal(
    injectionReturnsTerminalResponse("npx -y @agentclientprotocol/codex-acp@^0.0.44"),
    false,
  );
  // Unknown / mock / unrelated backends default to false (conservative).
  assert.equal(injectionReturnsTerminalResponse("node mock-agent.js"), false);
  assert.equal(injectionReturnsTerminalResponse("gemini --experimental-acp"), false);
  assert.equal(injectionReturnsTerminalResponse("node 'unterminated"), false);
});

test("injectionAbsorbsIntoActiveTurn is TRUE only for Codex", () => {
  assert.equal(injectionAbsorbsIntoActiveTurn("codex-acp"), true);
  assert.equal(
    injectionAbsorbsIntoActiveTurn("npx -y @agentclientprotocol/codex-acp@^0.0.44"),
    true,
  );

  assert.equal(injectionAbsorbsIntoActiveTurn("node /opt/claude-agent-acp/dist/index.js"), false);
  assert.equal(injectionAbsorbsIntoActiveTurn("claude-agent-acp"), false);
  assert.equal(injectionAbsorbsIntoActiveTurn("node /opt/claude-pty-acp/dist/index.js"), false);
  assert.equal(injectionAbsorbsIntoActiveTurn("node mock-agent.js"), false);
  assert.equal(injectionAbsorbsIntoActiveTurn("node 'unterminated"), false);
});

// emitsTurnEndMarker gates the C1 turn-completion watchdog (493729fc F2): true
// for backends whose adapter emits an end-of-turn marker — Claude / claude-pty
// (`_claude/lastTurnEndReason`) and codex-acp (`_codex/lastTurnEndReason`,
// since the 493729fc F1 fix). Including codex is safe against older deployed
// adapters: arming is marker-driven, no marker → no timers.
test("emitsTurnEndMarker is TRUE for Claude ACP, claude-pty, and Codex ACP", () => {
  assert.equal(emitsTurnEndMarker("node /opt/claude-agent-acp/dist/index.js"), true);
  assert.equal(emitsTurnEndMarker("claude-agent-acp"), true);
  assert.equal(emitsTurnEndMarker("node /opt/claude-pty-acp/dist/index.js"), true);
  assert.equal(emitsTurnEndMarker("node /opt/codex-acp/dist/index.js"), true);
  assert.equal(emitsTurnEndMarker("codex-acp"), true);
  assert.equal(emitsTurnEndMarker("npx -y @agentclientprotocol/codex-acp@^0.0.44"), true);
});

test("emitsTurnEndMarker is FALSE for unknown backends and malformed commands", () => {
  assert.equal(emitsTurnEndMarker("gemini --experimental-acp"), false);
  assert.equal(emitsTurnEndMarker("node ./mock-agent.js --codex-compatible"), false);
  assert.equal(emitsTurnEndMarker("node 'unterminated"), false);
});
