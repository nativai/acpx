import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { resolvePtyForkMeta } from "../src/acp/client.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import {
  createSessionConversation,
  recordPromptSubmission,
  recordSessionUpdate,
  stampSteerBoundaryUuid,
} from "../src/session/conversation-model.js";
import {
  appendFinalizedMessagesToLog,
  hydrateSessionMessagesFromLog,
  messagesLogPath,
} from "../src/session/messages-log.js";
import type { SessionMessage } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// Durable byway-fork provenance — the acpx half (CONTRACT §7 A1-A6).

const TS = "2026-02-27T10:00:00.000Z";

function agentChunk(text: string, claudeUuid?: string): SessionNotification {
  return {
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      ...(claudeUuid ? { _meta: { claudeUuid } } : {}),
    },
  } as SessionNotification;
}

function tag(message: SessionMessage): "User" | "Agent" | "Resume" {
  if (message === "Resume") {
    return "Resume";
  }
  return "User" in message ? "User" : "Agent";
}

function agentClaudeUuid(message: SessionMessage | undefined): string | undefined {
  return message && message !== "Resume" && "Agent" in message
    ? message.Agent.claudeUuid
    : undefined;
}

function userClaudeUuid(message: SessionMessage | undefined): string | undefined {
  return message && message !== "Resume" && "User" in message ? message.User.claudeUuid : undefined;
}

// Build the CONCEPTION §3d T2 stream shape:
//   [U0, A1, U2, A3(pre-steer), U4(steer), A5(post-steer)]
// — a user prompt, an agent turn, a second user prompt, a long agentic turn
// whose tail is the pre-steer divider, a mid-turn steer, and the post-steer
// continuation.
function buildT2Conversation(
  steerBoundaryUuid?: string,
): ReturnType<typeof createSessionConversation> {
  const conversation = createSessionConversation(TS);
  let state = undefined;

  // index 0 — first User entry, no predecessor → no provenance (legacy path).
  recordPromptSubmission(conversation, "download any role or project", TS);

  // index 1 — Agent A1.
  state = recordSessionUpdate(conversation, state, agentChunk("I'll start by reading.", "a1"), TS);

  // index 2 — normal User prompt U2 → inherit-preceding fallback (A1's uuid).
  recordPromptSubmission(conversation, "print the numbers 1 to 10", TS);

  // index 3 — Agent A3, last-wins lands on the pre-steer transcript tail.
  state = recordSessionUpdate(conversation, state, agentChunk("1", "a3-pre-1"), TS);
  state = recordSessionUpdate(conversation, state, agentChunk("2", "pre-steer-tail"), TS);

  // index 4 — mid-turn steer User entry U4. Inherit-preceding gives the same
  // pre-steer tail; the explicit steerBoundaryUuid stamp is the primary path.
  const steerId = recordPromptSubmission(conversation, "stop", TS);
  if (steerId && steerBoundaryUuid) {
    stampSteerBoundaryUuid(conversation, steerId, steerBoundaryUuid);
  }

  // index 5 — Agent A5 (a new entry, after the steer User entry), last-wins → final.
  state = recordSessionUpdate(conversation, state, agentChunk("3", "final-1"), TS);
  recordSessionUpdate(conversation, state, agentChunk("4 Stopped at 4.", "final"), TS);

  return conversation;
}

test("(a) T2 stream stamps Agent/steer provenance: A3 == steerBoundaryUuid == pre-steer tail; A5 == final", () => {
  const conversation = buildT2Conversation("pre-steer-tail");
  const messages = conversation.messages;

  // Exact T2 segmentation.
  assert.equal(messages.length, 6);
  assert.deepEqual(messages.map(tag), ["User", "Agent", "User", "Agent", "User", "Agent"]);

  // index 0: first User entry has no provenance → legacy index path.
  assert.equal(userClaudeUuid(messages[0]), undefined);
  // index 1: Agent A1 stamped from _meta.claudeUuid.
  assert.equal(agentClaudeUuid(messages[1]), "a1");
  // index 2: normal User prompt inherits the preceding entry (A1).
  assert.equal(userClaudeUuid(messages[2]), "a1");

  // A3.claudeUuid == steerBoundaryUuid == pre-steer tail.
  assert.equal(agentClaudeUuid(messages[3]), "pre-steer-tail");
  assert.equal(userClaudeUuid(messages[4]), "pre-steer-tail");
  assert.equal(agentClaudeUuid(messages[3]), userClaudeUuid(messages[4]));

  // A5.claudeUuid == final (last-wins).
  assert.equal(agentClaudeUuid(messages[5]), "final");
});

test("(a') steerBoundaryUuid is the PRIMARY path: it overrides the inherit-preceding fallback", () => {
  // Distinct boundary uuid (≠ the inherited pre-steer tail) proves the stamp lands.
  const conversation = buildT2Conversation("explicit-boundary");
  assert.equal(userClaudeUuid(conversation.messages[4]), "explicit-boundary");

  // Without an explicit stamp, the steer entry still resolves correctly via
  // inherit-preceding (equals the preceding Agent's pre-steer tail).
  const inheritOnly = buildT2Conversation(undefined);
  assert.equal(userClaudeUuid(inheritOnly.messages[4]), "pre-steer-tail");
  assert.equal(userClaudeUuid(inheritOnly.messages[4]), agentClaudeUuid(inheritOnly.messages[3]));
});

test("(b) fork resolution 4/5/6 → resumeSessionAt preSteerTail/preSteerTail/final — distinct, no collapse", () => {
  const messages = buildT2Conversation("pre-steer-tail").messages;

  const at4 = resolvePtyForkMeta(messages, 4); // messages[3] = A3
  const at5 = resolvePtyForkMeta(messages, 5); // messages[4] = U4
  const at6 = resolvePtyForkMeta(messages, 6); // messages[5] = A5

  assert.deepEqual(at4, { claudeCode: { options: { resumeSessionAt: "pre-steer-tail" } } });
  assert.deepEqual(at5, { claudeCode: { options: { resumeSessionAt: "pre-steer-tail" } } });
  assert.deepEqual(at6, { claudeCode: { options: { resumeSessionAt: "final" } } });

  // The buggy collapse mapped 4/5/6 all to the final record. The fix maps the
  // pre-steer dividers (4,5) to the pre-steer tail and 6 to the final record.
  const resume = (meta: Record<string, unknown>): unknown =>
    (meta.claudeCode as { options: { resumeSessionAt: unknown } }).options.resumeSessionAt;
  assert.notEqual(resume(at4), resume(at6));
});

test("(c) an entry lacking claudeUuid resolves to the legacy forkAtMessageIndex path", () => {
  const messages = buildT2Conversation("pre-steer-tail").messages;

  // index 0 (the first User entry) carries no provenance → legacy fallback.
  assert.deepEqual(resolvePtyForkMeta(messages, 1), { acpx: { forkAtMessageIndex: 1 } });

  // A fully pre-provenance session (no entry carries claudeUuid) → legacy path
  // for every index, exactly as today.
  const legacy: SessionMessage[] = [
    { User: { id: "u0", content: [{ Text: "hi" }] } },
    { Agent: { content: [{ Text: "hello" }], tool_results: {} } },
  ];
  assert.deepEqual(resolvePtyForkMeta(legacy, 1), { acpx: { forkAtMessageIndex: 1 } });
  assert.deepEqual(resolvePtyForkMeta(legacy, 2), { acpx: { forkAtMessageIndex: 2 } });

  // undefined source messages → legacy path (defensive).
  assert.deepEqual(resolvePtyForkMeta(undefined, 3), { acpx: { forkAtMessageIndex: 3 } });
});

test("(A4) claudeUuid survives the messages_log round-trip", async () => {
  await withTempHome("acpx-byway-provenance-", async (homeDir) => {
    const sessionDir = path.join(homeDir, ".acpx", "sessions");
    const recordId = "provenance-roundtrip";
    const logPath = messagesLogPath(sessionDir, recordId);
    const messages: SessionMessage[] = [
      { User: { id: "u0", content: [{ Text: "prompt" }] } },
      { Agent: { content: [{ Text: "reply" }], tool_results: {}, claudeUuid: "agent-uuid" } },
      { User: { id: "u2", content: [{ Text: "stop" }], claudeUuid: "steer-uuid" } },
    ];

    const record = makeSessionRecord(
      {
        acpxRecordId: recordId,
        acpSessionId: recordId,
        agentCommand: AGENT_REGISTRY.codex,
        cwd: path.join(homeDir, "cwd"),
        messages: [],
      },
      { defaultName: false, defaultAcpx: false },
    );

    await appendFinalizedMessagesToLog(record, logPath, messages);
    record.messages = [];
    const hydrated = await hydrateSessionMessagesFromLog(record, logPath);

    assert.equal(hydrated.messages.length, 3);
    assert.equal(agentClaudeUuid(hydrated.messages[1]), "agent-uuid");
    assert.equal(userClaudeUuid(hydrated.messages[2]), "steer-uuid");
  });
});
