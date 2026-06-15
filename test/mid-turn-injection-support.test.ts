import assert from "node:assert/strict";
import test from "node:test";
import { supportsMidTurnPromptInjection } from "../src/acp/mid-turn-injection-support.js";

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
  // The bootstrapped default and dev-override forms of the bridge command both
  // support native mid-turn steering, so injection must be enabled for them.
  assert.equal(
    supportsMidTurnPromptInjection("node /opt/claude-pty-acp/acp-server-transcript.mjs"),
    true,
  );
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
