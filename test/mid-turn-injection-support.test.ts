import assert from "node:assert/strict";
import test from "node:test";
import {
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
