import assert from "node:assert/strict";
import test from "node:test";
import {
  isSyntheticAgentEntry,
  messagesHaveRealAgentTurn,
} from "../src/session/synthetic-messages.js";
import type { SessionAgentMessage, SessionMessage } from "../src/types.js";

// VERBATIM production specimen (b7d8d768, written 2026-07-23 by pre-tag acpx) —
// legacy recognition must match the real fleet data, not a hand-crafted sample.
const LEGACY_GUARD_TEXT =
  '⚠ implicit Fable blocked → forced opus: this session would have resolved to "fable" by ' +
  "inheritance/default, but Fable is never inherited automatically (brick://5bac5564). The model " +
  'was rewritten to "opus". Pass `--model fable` explicitly if a Fable session was actually intended.';

function agentEntry(overrides: Partial<SessionAgentMessage>): SessionAgentMessage {
  return { content: [{ Text: "x" }], tool_results: {}, ...overrides };
}

test("tagged breadcrumbs are synthetic regardless of content", () => {
  assert.equal(isSyntheticAgentEntry(agentEntry({ synthetic: true })), true);
});

test("legacy untagged breadcrumbs are recognized by verbatim production content", () => {
  assert.equal(isSyntheticAgentEntry(agentEntry({ content: [{ Text: LEGACY_GUARD_TEXT }] })), true);
  assert.equal(
    isSyntheticAgentEntry(
      agentEntry({
        content: [
          {
            Text: "⚠ Fable share exhausted on all subscriptions — degraded to opus for this session (fable_degrade_ok).",
          },
        ],
      }),
    ),
    true,
  );
  assert.equal(
    isSyntheticAgentEntry(
      agentEntry({
        content: [{ Text: '⚠ served below pinned model floor: this turn was served "sonnet"…' }],
      }),
    ),
    true,
  );
});

test("real turns are never misclassified", () => {
  // Ordinary output.
  assert.equal(
    isSyntheticAgentEntry(agentEntry({ content: [{ Text: "real prior turn" }] })),
    false,
  );
  // A terminal-error mirror is a real prompt attempt — must stay loud.
  assert.equal(
    isSyntheticAgentEntry(
      agentEntry({
        content: [{ Text: "⚠ turn failed: Persistent ACP session x could not be resumed" }],
        terminal_error: { message: "boom" },
      }),
    ),
    false,
  );
  // Multi-content turns never match the strict legacy shape.
  assert.equal(
    isSyntheticAgentEntry(
      agentEntry({ content: [{ Text: LEGACY_GUARD_TEXT }, { Text: "and more" }] }),
    ),
    false,
  );
  // Tool activity marks a real turn even if the text quotes an advisory.
  assert.equal(
    isSyntheticAgentEntry(
      agentEntry({
        content: [{ Text: LEGACY_GUARD_TEXT }],
        tool_results: {
          t1: { tool_use_id: "t1", tool_name: "Bash", is_error: false, content: { Text: "ok" } },
        },
      }),
    ),
    false,
  );
});

test("messagesHaveRealAgentTurn ignores synthetic entries but sees real turns", () => {
  const breadcrumbOnly: SessionMessage[] = [
    { Agent: agentEntry({ content: [{ Text: LEGACY_GUARD_TEXT }] }) },
    { User: { id: "u1", content: [{ Text: "do the thing" }] } },
  ];
  assert.equal(messagesHaveRealAgentTurn(breadcrumbOnly), false);

  const withRealTurn: SessionMessage[] = [
    ...breadcrumbOnly,
    { Agent: agentEntry({ content: [{ Text: "did the thing" }] }) },
  ];
  assert.equal(messagesHaveRealAgentTurn(withRealTurn), true);
});
