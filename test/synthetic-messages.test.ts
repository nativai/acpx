import assert from "node:assert/strict";
import test from "node:test";
import { enforceModelFloorPostServe } from "../src/session/model-floor-enforce.js";
import {
  isSyntheticAgentEntry,
  messagesHaveRealAgentTurn,
} from "../src/session/synthetic-messages.js";
import type { SessionAgentMessage, SessionMessage } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

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

// brick://c327efb5 — the floor advisory was REWORDED ("below pinned model floor"
// → "does not match the pinned floor"), and the legacy prefix list was
// deliberately NOT updated to match, because that list describes bytes already on
// disk in pre-tag records. This pins both halves of that decision:
//
//   1. the CURRENT message — built by the real production path, not hand-typed —
//      is still recognized as synthetic, via its `synthetic:true` tag;
//   2. the LEGACY text stays recognized (covered by the verbatim test above).
//
// Without (1) a reworded-and-untagged advisory would silently start counting as a
// real model turn, which is the brick://de3645c6 failure class: it makes a
// never-run session look like it has irreplaceable history.
test("c327efb5: the REWORDED floor advisory is still synthetic (by tag, not by prefix)", async () => {
  const record = await withTempHome("acpx-c327-syn-", async () => {
    const rec = makeSessionRecord({
      acpxRecordId: "c327-syn",
      acpSessionId: "c327-syn",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: "/workspace",
      acpx: { session_options: { model: "opus" } },
    });
    await enforceModelFloorPostServe(rec, { servedModel: "claude-sonnet-5" });
    return rec;
  });

  const advisory = record.messages.at(-1);
  assert.ok(
    typeof advisory === "object" && advisory !== null && "Agent" in advisory,
    "the floor check must mirror an advisory message",
  );
  // It really is the new wording — otherwise this test would pass on the old text
  // and prove nothing about the rewording.
  assert.match(
    String((advisory.Agent.content as Array<{ Text?: string }>)[0]?.Text),
    /served model does not match the pinned floor/,
  );
  assert.equal(isSyntheticAgentEntry(advisory.Agent), true);
  assert.equal(messagesHaveRealAgentTurn(record.messages), false);
});
