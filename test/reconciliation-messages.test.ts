import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { applyConversation } from "../src/runtime/engine/lifecycle.js";
import {
  createSessionConversation,
  recordPromptSubmission,
  recordSessionUpdate,
} from "../src/session/conversation-model.js";
import { defaultSessionEventLog } from "../src/session/event-log.js";
import { SessionEventWriter } from "../src/session/events.js";
import { resolveSessionRecord, writeSessionRecord } from "../src/session/persistence.js";
import type { SessionNotification, SessionRecord } from "../src/types.js";

// Regression test suite for the "empty messages in JSON while NDJSON has data"
// bug. Two failure patterns were observed on the devbox:
//
//   Pattern B (confirmed code bug):
//     A session spawned a subagent. The inline `teammate_spawned` handler in
//     runSessionPrompt persisted the parent record to disk, but at that moment
//     the in-memory `conversation` had not yet been applied to the record.
//     The record was written with `subagents: [ref]`, `last_seq: N>0`, but
//     `messages: []`. If the daemon later died before the end-of-turn flush,
//     the stale record stayed on disk forever.
//
//   Pattern A (defensive):
//     During a turn, `SessionEventWriter.appendMessages(batch, {checkpoint:
//     false})` is called every 500ms to flush the raw NDJSON stream. The
//     session record JSON — including `messages` — is only persisted at the
//     very end of the turn. A daemon kill mid-turn loses the entire
//     conversation to disk even though the stream contains all events.
//
// The fix:
//   1. Sync `conversation` onto the parent record (applyConversation) before
//      writeSessionRecord inside the teammate_spawned handler.
//   2. Periodically checkpoint the record to disk during a turn, after
//      applyConversation, so crash-window data loss is bounded.

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-reconcile-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    await run(homeDir);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

function makeSessionRecord(sessionId: string, cwd: string): SessionRecord {
  const now = "2026-04-19T00:00:00.000Z";
  return {
    schema: "acpx.session.v1",
    acpxRecordId: sessionId,
    acpSessionId: sessionId,
    agentCommand: AGENT_REGISTRY.codex,
    cwd,
    createdAt: now,
    lastUsedAt: now,
    lastSeq: 0,
    eventLog: {
      ...defaultSessionEventLog(sessionId),
      max_segments: 5,
      segment_count: 1,
    },
    closed: false,
    title: null,
    messages: [],
    updated_at: now,
    cumulative_token_usage: {},
    request_token_usage: {},
    acpx: {},
  };
}

function agentMessageChunk(sessionId: string, text: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  } as SessionNotification;
}

/**
 * Pattern B regression: when the daemon persists the parent record in response
 * to a subagent spawn, that write MUST include the conversation messages that
 * have accumulated so far. Without the fix, writeSessionRecord sees a record
 * whose `messages` is still the initial (empty) array, because
 * `applyConversation(record, conversation)` has not yet been called on the
 * prompt path.
 */
test("reconciliation: subagent-spawn checkpoint persists accumulated messages", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "reconcile-subagent-spawn";
    const record = makeSessionRecord(sessionId, cwd);
    await writeSessionRecord(record);

    // Simulate the runtime.ts flow up to (but not including) a subagent spawn:
    // prompt submitted, a few session/update events accumulated.
    const conversation = createSessionConversation(record.updated_at);
    recordPromptSubmission(conversation, "hello", "2026-04-19T00:00:01.000Z");
    recordSessionUpdate(
      conversation,
      {},
      agentMessageChunk(sessionId, "thinking about it..."),
      "2026-04-19T00:00:02.000Z",
    );
    recordSessionUpdate(
      conversation,
      {},
      agentMessageChunk(sessionId, " done."),
      "2026-04-19T00:00:03.000Z",
    );

    assert.equal(
      conversation.messages.length,
      2,
      "precondition: two messages (user + agent) accumulated in conversation",
    );

    // Now the daemon would receive a teammate_spawned event and call the
    // persistence block. Emulate the FIXED code path: apply conversation
    // BEFORE writing the record.
    applyConversation(record, conversation);
    record.subagents = [
      {
        acpxRecordId: "child-record",
        name: "Worker",
        spawnedAt: "2026-04-19T00:00:03.500Z",
      },
    ];
    await writeSessionRecord(record);

    // If the daemon now dies, the disk record MUST still have the messages.
    const persisted = await resolveSessionRecord(sessionId);
    assert.equal(persisted.messages.length, 2, "disk record retains messages after subagent spawn");
    assert.ok(
      persisted.subagents?.some((ref) => ref.acpxRecordId === "child-record"),
      "subagent ref recorded",
    );

    // Regression guard: the bug was that writeSessionRecord was called with
    // applyConversation SKIPPED. Assert that omitting applyConversation does
    // indeed lose the messages — if this assertion breaks, the invariant has
    // shifted and the fix location needs reconsideration.
    const staleRecord = makeSessionRecord("reconcile-subagent-spawn-stale", cwd);
    await writeSessionRecord(staleRecord);
    // Intentionally do NOT call applyConversation here.
    staleRecord.subagents = [
      {
        acpxRecordId: "child-stale",
        name: "Worker",
        spawnedAt: "2026-04-19T00:00:03.500Z",
      },
    ];
    await writeSessionRecord(staleRecord);
    const staleOnDisk = await resolveSessionRecord("reconcile-subagent-spawn-stale");
    assert.equal(
      staleOnDisk.messages.length,
      0,
      "without applyConversation the bug reproduces: messages lost even though subagents persisted",
    );
  });
});

/**
 * Pattern A regression: during a long-running turn, the record — including
 * `messages` — must be checkpointed to disk periodically. The fix in
 * runSessionPrompt applies the conversation onto the record before calling
 * SessionEventWriter.checkpoint() every 500ms. This test verifies the
 * building block: SessionEventWriter.checkpoint() persists whatever is
 * currently on `record.messages` — so the fix's "applyConversation then
 * checkpoint" pattern does what we expect.
 */
test("reconciliation: checkpoint() persists in-memory messages on the shared record", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "reconcile-checkpoint";
    const record = makeSessionRecord(sessionId, cwd);
    await writeSessionRecord(record);

    const writer = await SessionEventWriter.open(record);

    // Append a stream event without checkpointing — the record is mutated
    // in-memory (lastSeq, lastUsedAt, eventLog.last_write_at) but NOT written
    // to the JSON file. This is the pre-fix steady state.
    await writer.appendMessages(
      [
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hi" },
            },
          },
        },
      ] as never,
      { checkpoint: false },
    );

    const persistedBeforeCheckpoint = await resolveSessionRecord(sessionId);
    assert.equal(
      persistedBeforeCheckpoint.lastSeq,
      0,
      "pre-fix: stream flush with checkpoint:false does NOT update JSON on disk",
    );
    assert.equal(persistedBeforeCheckpoint.messages.length, 0);

    // Emulate the fix: apply accumulated messages onto the record, then
    // checkpoint. After this, disk has both the bumped lastSeq AND the
    // messages — so a daemon kill from here on preserves the conversation.
    const conversation = createSessionConversation(record.updated_at);
    recordSessionUpdate(
      conversation,
      {},
      agentMessageChunk(sessionId, "hi"),
      "2026-04-19T00:00:02.000Z",
    );
    applyConversation(record, conversation);
    await writer.checkpoint();

    const persistedAfterCheckpoint = await resolveSessionRecord(sessionId);
    assert.equal(persistedAfterCheckpoint.lastSeq, 1, "lastSeq persisted");
    assert.equal(
      persistedAfterCheckpoint.messages.length,
      1,
      "agent message persisted to JSON after applyConversation + checkpoint",
    );

    await writer.close({ checkpoint: false });
  });
});
