// brick a147982f — unit rows for the C1 turn-watchdog arming contract (CONCEPTION §6):
// N9 (activity neutrality), N11 (the adapter coverage table, on REAL command lines),
// N12 (the TURN_WATCHDOG_CANCELLED code contract) and X1 (the `_claude/promptId` request key).
// The runtime rows (P6–P11, N1–N3, N6, N7, N10) live in test/turn-watchdog-lifecycle.test.ts.

import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptRequest } from "../src/acp/client.js";
import { emitsTurnEndMarker, turnWatchdogArming } from "../src/acp/mid-turn-injection-support.js";
import {
  SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE,
  TURN_WATCHDOG_CANCELLED_DETAIL_CODE,
  TURN_WATCHDOG_CANCELLED_MESSAGE,
} from "../src/cli/queue/delivery-terminals.js";
import { buildDeliveryEvent } from "../src/session/delivery-events.js";
import { isActivityNeutralEventMessage } from "../src/session/events.js";
import type { AcpJsonRpcMessage } from "../src/types.js";

// N11 — `turnWatchdogArming` on the command lines the live store actually holds. acpx's
// fixtures use synthetic commands no real record carries (acpx PROJECT.md), so each row
// below was copied verbatim from a real record's `agent_command`, sampled read-only from
// devbox `~/.acpx/sessions/*.json` on 2026-10-09 (2,835 records: 2,067 claude-agent-acp,
// 177 codex-acp, 79 pi-acp, 3 claude-pty-acp on the deployed /opt paths). Record ids are
// beside each line.
const REAL_RECORD_COMMANDS: Array<{
  recordId: string;
  agentCommand: string;
  expected: ReturnType<typeof turnWatchdogArming>;
}> = [
  {
    recordId: "868dacf2-3045-4fdb-bd01-c0623469f63b",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    expected: "claude-prompt-lifecycle",
  },
  {
    // A dev build of the same adapter (an `ACPX_CLAUDE_ACP_COMMAND` override) opts in alike.
    recordId: "32d09a58-4d3c-4004-ba7f-cd809dd6e5a6",
    agentCommand: "node /workspace/projects/claude-agent-acp/te-f07e96d5/dist/index.js",
    expected: "claude-prompt-lifecycle",
  },
  {
    recordId: "ad740a5a-76b1-4242-8723-f8c91a691ddc",
    agentCommand: "node /opt/claude-pty-acp/dist/index.js",
    expected: "none",
  },
  {
    recordId: "0b7ad562-6ebd-4ad4-9f11-c15cc67291f0",
    agentCommand:
      "node /workspace/projects/acpx/feat-4539b033-perturn/probe/perturn/adapters/claude-pty-acp/proxy.mjs",
    expected: "none",
  },
  {
    recordId: "59f799ee-8aa2-497f-88fa-d7faa4f54806",
    agentCommand: "node /opt/pi-acp/dist/index.js",
    expected: "none",
  },
  {
    recordId: "01a12048-52bb-79d3-9d6f-b77384713cdf",
    agentCommand: "node /opt/codex-acp/dist/index.js",
    expected: "codex-turn-marker",
  },
  {
    recordId: "01a12077-89cf-7920-8a0f-acd421097a80",
    agentCommand: "node /workspace/projects/codex-acp/fix-f7b3e539-steer/dist/index.js",
    expected: "codex-turn-marker",
  },
];

test("N11: turnWatchdogArming returns the §4.3 coverage table for real deployed command lines", () => {
  for (const row of REAL_RECORD_COMMANDS) {
    assert.equal(
      turnWatchdogArming(row.agentCommand),
      row.expected,
      `${row.recordId}: ${row.agentCommand}`,
    );
    // emitsTurnEndMarker stays the derived "has a watchdog at all" predicate.
    assert.equal(
      emitsTurnEndMarker(row.agentCommand),
      row.expected !== "none",
      `${row.recordId}: emitsTurnEndMarker`,
    );
  }
});

test("N11: a Claude-family adapter never maps to the codex marker path", () => {
  for (const row of REAL_RECORD_COMMANDS) {
    if (row.agentCommand.includes("claude")) {
      assert.notEqual(turnWatchdogArming(row.agentCommand), "codex-turn-marker", row.recordId);
    }
  }
  // Unclassified and malformed commands have no watchdog.
  assert.equal(turnWatchdogArming("gemini --experimental-acp"), "none");
  assert.equal(turnWatchdogArming("node ./mock-agent.js --claude-compatible"), "none");
  assert.equal(turnWatchdogArming("node 'unterminated"), "none");
});

// N9 — the two new stream methods are chrome: appending them must not advance
// `event_log.last_write_at`, or a long silent wait would look like activity.
test("N9: acpx/turn-watchdog and _claude/promptLifecycle are activity-neutral", () => {
  const watchdogEvent = {
    jsonrpc: "2.0",
    method: "acpx/turn-watchdog",
    params: { tier: 1, action: "cancel" },
  } as AcpJsonRpcMessage;
  const lifecycle = {
    jsonrpc: "2.0",
    method: "_claude/promptLifecycle",
    params: { sessionId: "s", promptId: "p", phase: "sdk_idle" },
  } as AcpJsonRpcMessage;
  assert.equal(isActivityNeutralEventMessage(watchdogEvent), true);
  assert.equal(isActivityNeutralEventMessage(lifecycle), true);
  // Control: real agent output still counts.
  const update = {
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk" } },
  } as AcpJsonRpcMessage;
  assert.equal(isActivityNeutralEventMessage(update), false);
});

// N12 — the code contract acpx-ui keys on (F-UI-2), and the wording rules it must obey.
test("N12: TURN_WATCHDOG_CANCELLED is a distinct, outcome-partial, non-close code", () => {
  assert.equal(TURN_WATCHDOG_CANCELLED_DETAIL_CODE, "TURN_WATCHDOG_CANCELLED");
  assert.notEqual(TURN_WATCHDOG_CANCELLED_DETAIL_CODE, SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE);
  assert.ok(TURN_WATCHDOG_CANCELLED_MESSAGE.length > 0);
  // acpx-ui's substring backstops would classify a `session closed` text as a close.
  assert.equal(TURN_WATCHDOG_CANCELLED_MESSAGE.toLowerCase().includes("session closed"), false);
  assert.equal(TURN_WATCHDOG_CANCELLED_MESSAGE.toLowerCase().includes("session is closed"), false);
  // Outcome-partial: it must tell the reader work may have happened.
  assert.match(TURN_WATCHDOG_CANCELLED_MESSAGE, /may have happened/);
  assert.match(TURN_WATCHDOG_CANCELLED_MESSAGE, /watchdog/);
});

// X5 — `recoveredBy` is additive and appears only when set.
test("X5: buildDeliveryEvent carries recoveredBy only when given", () => {
  const plain = buildDeliveryEvent({
    messageId: "m",
    requestId: "r",
    phase: "done",
    stopReason: "end_turn",
    at: "2026-10-09T00:00:00.000Z",
  }) as { params: Record<string, unknown> };
  assert.equal("recoveredBy" in plain.params, false);
  const recovered = buildDeliveryEvent({
    messageId: "m",
    requestId: "r",
    phase: "done",
    stopReason: null,
    recoveredBy: "turn-watchdog",
    at: "2026-10-09T00:00:00.000Z",
  }) as { params: Record<string, unknown> };
  assert.equal(recovered.params.recoveredBy, "turn-watchdog");
  assert.equal(recovered.params.stopReason, null);
});

// X1 — the request carries `_meta["_claude/promptId"]` only when a promptId is given; with
// none it is byte- and key-order-identical to before (turn-context.test.ts A5 pins that half).
test("X1: buildPromptRequest adds _meta._claude/promptId only when promptId is set", () => {
  const prompt = [{ type: "text" as const, text: "hi" }];
  const withId = buildPromptRequest("s1", prompt, { messageId: "m1", promptId: "p-1" });
  assert.deepEqual(withId, {
    sessionId: "s1",
    prompt,
    messageId: "m1",
    _meta: { "_claude/promptId": "p-1" },
  });
  assert.deepEqual(Object.keys(withId), ["sessionId", "prompt", "messageId", "_meta"]);
  const withoutId = buildPromptRequest("s1", prompt, { messageId: "m1" });
  assert.equal("_meta" in withoutId, false);
  const undefinedId = buildPromptRequest("s1", prompt, { messageId: "m1", promptId: undefined });
  assert.equal("_meta" in undefinedId, false);
});
