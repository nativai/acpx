import assert from "node:assert/strict";
import test from "node:test";
import { isClaudeAcpCommand } from "../src/acp/agent-command.js";
import { splitCommandLine } from "../src/acp/client-process.js";
import { isCodexAcpCommand } from "../src/acp/codex-compat.js";

// brick://5a7cf1f0 — the adapter detectors match a path SEGMENT, never a substring.
//
// Why this file exists as its own suite: the codex answer gates admission (the
// subscription cap HOLDS a turn when acpx-ui's quota endpoint is unreachable) and
// selects the OS primer channel, so a false positive both caps a non-Codex session
// and blocks it entirely while acpx-ui is down. Measured under brick c028c10e: four
// `cli.test.ts` BRICK tests, whose agent is `node <mock-agent.js>`, were classified
// as Codex because they passed `--operation-log …/codex-acp-ops.jsonl`.
//
// ⚠️ EVERY ROW BELOW IS WRITTEN TO FAIL AGAINST THE OLD SUBSTRING TEST OR AGAINST A
// NAIVE BASENAME TEST — those are the two ways to get this wrong, and a row that
// cannot distinguish them pins nothing. The `…-ops.jsonl` rows fail the substring
// version; the `/opt/<token>/dist/index.js` rows fail the basename version.

function classifyCodex(agentCommand: string): boolean {
  const { command, args } = splitCommandLine(agentCommand);
  return isCodexAcpCommand(command, args);
}

function classifyClaude(agentCommand: string): boolean {
  const { command, args } = splitCommandLine(agentCommand);
  return isClaudeAcpCommand(command, args);
}

// Every genuine codex spelling that occurs in this repo or on a dev box. A miss here
// silently drops the primer channel and the subscription cap for a real Codex session.
const GENUINE_CODEX = [
  "codex-acp",
  "node /opt/codex-acp/dist/index.js",
  "npx @agentclientprotocol/codex-acp",
  "npx -y @agentclientprotocol/codex-acp",
  "npx -y @agentclientprotocol/codex-acp@^0.0.1",
  "npx -y @agentclientprotocol/codex-acp@^0.0.44",
  "npx @zed-industries/codex-acp@^0.12.0",
] as const;

for (const agentCommand of GENUINE_CODEX) {
  test(`codex is detected in a genuine invocation: ${agentCommand}`, () => {
    assert.equal(classifyCodex(agentCommand), true);
  });
}

test("a Windows shim basename is detected despite its extension", () => {
  assert.equal(classifyCodex("/home/u/bin/codex-acp.cmd"), true);
});

// The suite's mock agent is adapter-agnostic, so a test that needs an
// adapter-classified session DECLARES one with a flag named after the adapter
// (`test/cli.test.ts:329` uses `--claude-agent-acp`, consumed by `test/mock-agent.ts`).
// This is a deliberate seam, not an accident — removing it reds 14 claude rows.
test("a flag named after the adapter is a deliberate declaration and still classifies", () => {
  assert.equal(classifyClaude("node /tmp/mock-agent.js --claude-agent-acp"), true);
  assert.equal(classifyCodex("node /tmp/mock-agent.js --codex-acp"), true);
});

test("an unrelated flag whose name merely contains the token does NOT classify", () => {
  assert.equal(classifyCodex("node /tmp/mock-agent.js --codex-acp-ops /tmp/x"), false);
  assert.equal(classifyCodex("node /tmp/mock-agent.js --operation-log /h/x.jsonl"), false);
});

// The regression. Each of these mentions the token but carries it in NO segment.
const MENTIONS_ONLY = [
  // The measured false positive — a mock agent writing a log file.
  'node /tmp/mock-agent.js --operation-log "/home/u/codex-acp-ops.jsonl"',
  // Same shape, other affixes.
  "node /tmp/mock-agent.js --out /home/u/my-codex-acp-notes.txt",
  "node /tmp/mock-agent.js --out /home/u/codex-acpx/log.txt",
] as const;

for (const agentCommand of MENTIONS_ONLY) {
  test(`a mention that is not a segment does NOT classify as codex: ${agentCommand}`, () => {
    assert.equal(classifyCodex(agentCommand), false);
  });
}

test("the claude detector has the same segment semantics", () => {
  // Genuine — and the token is a DIRECTORY, so a basename test would miss it.
  // PROJECT.md records that every real claude record is a `…/claude-agent-acp/…`
  // path, measured across all 2,924 records.
  assert.equal(classifyClaude("node /opt/claude-agent-acp/dist/index.js"), true);
  assert.equal(classifyClaude("claude-agent-acp"), true);
  assert.equal(classifyClaude("npx @zed-industries/claude-agent-acp@^0.5.0"), true);
  // Mention only.
  assert.equal(classifyClaude("node /tmp/m.js --log /h/claude-agent-acp-notes.txt"), false);
});

test("the two detectors do not answer for each other", () => {
  assert.equal(classifyClaude("node /opt/codex-acp/dist/index.js"), false);
  assert.equal(classifyCodex("node /opt/claude-agent-acp/dist/index.js"), false);
});
