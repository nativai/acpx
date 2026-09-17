import assert from "node:assert/strict";
import test from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  cloneSessionAcpxState,
  createSessionConversation,
  hasUserMessageId,
  recordClientOperation,
  recordPromptSubmission,
  recordSessionUpdate,
} from "../src/session/conversation-model.js";

test("conversation model captures prompt, chunks, tool calls, and metadata", () => {
  const conversation = createSessionConversation("2026-02-27T10:00:00.000Z");
  let acpxState = undefined;

  recordPromptSubmission(conversation, "hello", "2026-02-27T10:00:00.000Z");

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hi " },
      },
    } as SessionNotification,
    "2026-02-27T10:00:01.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "thinking" },
      },
    } as SessionNotification,
    "2026-02-27T10:00:02.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "Run ls",
        status: "in_progress",
        kind: "execute",
        rawInput: { command: "ls" },
      },
    } as SessionNotification,
    "2026-02-27T10:00:03.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        rawOutput: { exitCode: 0 },
      },
    } as SessionNotification,
    "2026-02-27T10:00:04.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "create_plan", description: "create plan" }],
      },
    } as SessionNotification,
    "2026-02-27T10:00:05.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: "code",
      },
    } as SessionNotification,
    "2026-02-27T10:00:06.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "session_info_update",
        title: "My Session",
        updatedAt: "2026-02-27T10:00:06.000Z",
      },
    } as SessionNotification,
    "2026-02-27T10:00:06.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 100,
        size: 1000,
        _meta: {
          usage: {
            inputTokens: 60,
            outputTokens: 40,
            cachedWriteTokens: 10,
            cachedReadTokens: 15,
          },
        },
      },
    } as SessionNotification,
    "2026-02-27T10:00:07.000Z",
  );

  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_progress_update",
        progress: {
          phase: "thinking",
          tokens: { reasoning: 958 },
          final: true,
          source: "codex",
        },
      },
    } as unknown as SessionNotification,
    "2026-02-27T10:00:07.500Z",
  );

  acpxState = recordClientOperation(
    conversation,
    acpxState,
    {
      method: "terminal/create",
      status: "completed",
      summary: "Ran ls",
      timestamp: "2026-02-27T10:00:08.000Z",
    },
    "2026-02-27T10:00:08.000Z",
  );

  assert.equal(conversation.messages.length, 2);
  assert.equal(conversation.title, "My Session");

  const user = conversation.messages[0];
  const agent = conversation.messages[1];

  assert.ok(typeof user === "object" && user !== null && "User" in user);
  assert.ok(typeof agent === "object" && agent !== null && "Agent" in agent);

  if (!(typeof user === "object" && user !== null && "User" in user)) {
    assert.fail("expected User message");
  }
  if (!(typeof agent === "object" && agent !== null && "Agent" in agent)) {
    assert.fail("expected Agent message");
  }

  const tool = agent.Agent.content.find(
    (entry) => "ToolUse" in entry && entry.ToolUse.id === "call_1",
  );
  assert.ok(tool);
  assert.equal(agent.Agent.tool_results.call_1?.tool_name, "Run ls");
  assert.deepEqual(agent.Agent.tool_results.call_1?.output, { exitCode: 0 });

  const userId = user.User.id;
  assert.deepEqual(conversation.request_token_usage[userId], {
    input_tokens: 60,
    output_tokens: 40,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 15,
  });
  assert.deepEqual(conversation.cumulative_token_usage, {
    input_tokens: 60,
    output_tokens: 40,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 15,
  });

  assert.equal(acpxState?.current_mode_id, "code");
  assert.deepEqual(acpxState?.available_commands, ["create_plan"]);
  assert.deepEqual(acpxState?.progress, {
    phase: "thinking",
    tokens: { reasoning: 958 },
    final: true,
    source: "codex",
  });
});

test("recordPromptSubmission preserves audio prompt content", () => {
  const conversation = createSessionConversation("2026-02-27T10:00:00.000Z");

  const messageId = recordPromptSubmission(
    conversation,
    [
      { type: "text", text: "transcribe" },
      { type: "audio", mimeType: "audio/wav", data: "UklGRg==" },
    ],
    "2026-02-27T10:00:01.000Z",
  );

  assert.equal(typeof messageId, "string");
  assert.deepEqual(conversation.messages, [
    {
      User: {
        id: messageId,
        content: [
          { Text: "transcribe" },
          {
            Audio: {
              source: "UklGRg==",
              mime_type: "audio/wav",
            },
          },
        ],
      },
    },
  ]);
});

test("hasUserMessageId matches persisted user ids exactly", () => {
  const conversation = createSessionConversation("2026-02-27T10:00:00.000Z");
  const messageId = "11111111-1111-4111-8111-111111111111";

  recordPromptSubmission(conversation, "hello", "2026-02-27T10:00:01.000Z", messageId);

  assert.equal(hasUserMessageId(conversation, messageId), true);
  assert.equal(hasUserMessageId(conversation, "22222222-2222-4222-8222-222222222222"), false);
});

test("recordClientOperation keeps state and advances timestamp", () => {
  const conversation = createSessionConversation("2026-02-27T10:00:00.000Z");
  const state = recordClientOperation(
    conversation,
    { current_mode_id: "code" },
    {
      method: "terminal/output",
      status: "running",
      summary: "tail -f",
      timestamp: "2026-02-27T10:00:05.000Z",
    },
    "2026-02-27T10:00:05.000Z",
  );

  assert.equal(state?.current_mode_id, "code");
  assert.equal(conversation.updated_at, "2026-02-27T10:00:05.000Z");
});

test("cloneSessionAcpxState preserves desired mode id", () => {
  const cloned = cloneSessionAcpxState({
    current_mode_id: "auto",
    desired_mode_id: "plan",
    desired_config_options: {
      reasoning_effort: "high",
    },
    available_commands: ["review"],
    progress: {
      phase: "thinking",
      tokens: { reasoning: 123 },
      source: "codex",
    },
    session_options: {
      model: "sonnet",
      allowed_tools: ["Read", "Grep"],
      disallowed_tools: ["Skill", "ScheduleWakeup"],
      skills: [],
      max_turns: 7,
      subscription: "sub1",
    },
  });

  assert.equal(cloned?.current_mode_id, "auto");
  assert.equal(cloned?.desired_mode_id, "plan");
  assert.deepEqual(cloned?.desired_config_options, {
    reasoning_effort: "high",
  });
  assert.deepEqual(cloned?.available_commands, ["review"]);
  assert.deepEqual(cloned?.progress, {
    phase: "thinking",
    tokens: { reasoning: 123 },
    source: "codex",
  });
  assert.deepEqual(cloned?.session_options, {
    model: "sonnet",
    allowed_tools: ["Read", "Grep"],
    disallowed_tools: ["Skill", "ScheduleWakeup"],
    skills: [],
    max_turns: 7,
    subscription: "sub1",
    profile: undefined,
    effort: undefined,
  });
});

// brick 56d3532d — a pre-turn `agent_message_chunk` is a WRONG-CHANNEL emission.
// Measured on devbox 2026-09-06: of the five adapters acpx launches, only `pi`
// emits one (its `session/new` startup banner), and it lands as content[0] of
// the agent's reply to the user's FIRST prompt — so the reply reads
// "pi v0.84.4\n---\nPONG" where the model said "PONG".
test("a pre-turn agent_message_chunk is not folded into the agent-message channel", () => {
  const conversation = createSessionConversation("2026-09-06T23:00:00.000Z");

  // The banner arrives AFTER the user prompt is recorded locally and BEFORE the
  // prompt is submitted to the adapter — that ordering is the measured one, and
  // it is why "the conversation has no user message yet" cannot be the gate.
  recordPromptSubmission(
    conversation,
    "Reply with exactly the word: PONG",
    "2026-09-06T23:00:01.000Z",
  );

  const banner = {
    sessionId: "session-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "pi v0.84.4\n---\n" },
    },
  } as SessionNotification;

  let acpxState = recordSessionUpdate(conversation, undefined, banner, "2026-09-06T23:00:02.000Z", {
    promptEverSubmitted: false,
  });

  assert.equal(
    conversation.messages.length,
    1,
    "the suppressed banner must not create an agent message",
  );
  const first = conversation.messages[0];
  assert.ok(
    typeof first === "object" && first !== null && "User" in first,
    "the only message must still be the user prompt",
  );

  // The real reply, once the prompt IS in flight, must land normally. Without
  // this the assertion above is satisfied just as well by a handler that drops
  // every agent chunk.
  acpxState = recordSessionUpdate(
    conversation,
    acpxState,
    {
      sessionId: "session-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PONG" } },
    } as SessionNotification,
    "2026-09-06T23:00:03.000Z",
    { promptEverSubmitted: true },
  );

  const last = conversation.messages.at(-1);
  if (!(typeof last === "object" && last !== null && "Agent" in last)) {
    assert.fail("expected the reply to be recorded as an agent message");
  }
  assert.deepEqual(
    last.Agent.content,
    [{ Text: "PONG" }],
    "the reply must carry the model's words and nothing else",
  );
});

test("the pre-turn gate is opt-in and scoped to agent_message_chunk", () => {
  // 1. Option omitted -> unchanged behaviour. A caller that cannot answer
  //    truthfully must not be silently answered for.
  const legacy = createSessionConversation("2026-09-06T23:00:00.000Z");
  recordSessionUpdate(
    legacy,
    undefined,
    {
      sessionId: "session-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "banner" } },
    } as SessionNotification,
    "2026-09-06T23:00:01.000Z",
  );
  const legacyLast = legacy.messages.at(-1);
  if (!(typeof legacyLast === "object" && legacyLast !== null && "Agent" in legacyLast)) {
    assert.fail("expected the chunk to be recorded as an agent message");
  }
  assert.deepEqual(legacyLast.Agent.content, [{ Text: "banner" }]);

  // 2. Pre-turn, but a DIFFERENT update kind -> still applied. The gate must not
  //    widen into a general pre-turn mute: codex and claude both emit a
  //    pre-turn `available_commands_update`, which is legitimate.
  const scoped = createSessionConversation("2026-09-06T23:00:00.000Z");
  const acpxState = recordSessionUpdate(
    scoped,
    undefined,
    {
      sessionId: "session-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "compact", description: "", input: null }],
      },
    } as unknown as SessionNotification,
    "2026-09-06T23:00:01.000Z",
    { promptEverSubmitted: false },
  );
  assert.deepEqual(acpxState.available_commands, ["compact"]);
});
