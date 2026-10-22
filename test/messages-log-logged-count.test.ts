/**
 * The logged-message count has ONE authority per messages array (brick://5b608eaa).
 *
 * `record` and the working `conversation` share one `messages` array once
 * `applyConversation` ran, so a boundary write through `record` must be visible
 * through `conversation`, and no later `applyConversation` may lower it. Two
 * overlapping boundary writes of one record must append each entry exactly once.
 * The runtime trim must splice in place — a re-based array is a second copy of
 * the count that goes stale the moment an in-flight write advances the first —
 * and must adjust the count BEFORE the splice, because the getter clamps to the
 * array's current length.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { applyConversation } from "../src/runtime/engine/lifecycle.js";
import {
  cloneSessionConversation,
  trimConversationForRuntime,
} from "../src/session/conversation-model.js";
import {
  getLoggedMessageCount,
  markAllMessagesLogged,
} from "../src/session/messages-log-bookkeeping.js";
import { resolveSessionRecord, writeSessionRecordAtBoundary } from "../src/session/persistence.js";
import type { SessionMessage, SessionRecord } from "../src/types.js";
import { CLAUDE_AGENT_COMMAND } from "./pathological-adapter-helpers.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

function user(id: string): SessionMessage {
  return { User: { id, content: [{ Text: `prompt ${id}` }] } };
}

function agent(text: string): SessionMessage {
  return { Agent: { content: [{ Text: text }], tool_results: {} } };
}

function keyOf(raw: string): string {
  const parsed = JSON.parse(raw) as {
    User?: { id: string };
    Agent?: { content: Array<{ Text?: string }> };
  };
  return parsed.User
    ? `U:${parsed.User.id}`
    : `A:${(parsed.Agent?.content ?? []).map((c) => c.Text ?? "").join("")}`;
}

async function logKeys(logPath: string): Promise<string[]> {
  const text = await fs.readFile(logPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map(keyOf);
}

async function withSplitRecord(
  id: string,
  seed: SessionMessage[],
  run: (live: SessionRecord, logPath: string) => Promise<void>,
): Promise<void> {
  await withTempHome(`acpx-5b608eaa-${id}-`, async (homeDir) => {
    const record = makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: `${id}-session`,
      agentCommand: CLAUDE_AGENT_COMMAND,
      cwd: homeDir,
    });
    await writeSessionRecordFile(homeDir, record);
    const live = await resolveSessionRecord(id);
    live.messages.push(...seed);
    await writeSessionRecordAtBoundary(live); // split form, every seed entry logged
    const logPath = path.join(
      path.dirname(sessionFilePath(homeDir, id)),
      `${encodeURIComponent(id)}.messages.ndjson`,
    );
    await run(live, logPath);
  });
}

function conversationOf(length: number) {
  const conversation = cloneSessionConversation(undefined);
  for (let index = 0; index < length; index += 1) {
    conversation.messages.push(index % 2 === 0 ? user(`u${index}`) : agent(`a${index}`));
  }
  return conversation;
}

test("a boundary write through record is visible through the conversation sharing its array; a later apply cannot lower it", async () => {
  await withSplitRecord("carriers", [user("u0")], async (live, logPath) => {
    const conversation = cloneSessionConversation(live);
    conversation.messages.push(agent("a0"), user("u1"));
    applyConversation(live, conversation);
    // A boundary write with no copy-back (the floor and guard mirrors), then the
    // checkpoint's / finally's applyConversation — the specimen's regression step.
    await writeSessionRecordAtBoundary(live);
    applyConversation(live, conversation);
    assert.equal(getLoggedMessageCount(live), 3, "record still counts u0,a0,u1 as logged");
    assert.equal(getLoggedMessageCount(conversation), 3, "the conversation sees the same count");
    conversation.messages.push(agent("a1"));
    applyConversation(live, conversation);
    await writeSessionRecordAtBoundary(live);
    assert.deepEqual(await logKeys(logPath), ["U:u0", "A:a0", "U:u1", "A:a1"]);
  });
});

test("two overlapping boundary writes of one record append each entry exactly once", async () => {
  await withSplitRecord("overlap", [user("u0")], async (live, logPath) => {
    live.messages.push(agent("a0"), user("u1"));
    const first = writeSessionRecordAtBoundary(live);
    live.messages.push(user("u2")); // a second injection lands before the first write resolves
    const second = writeSessionRecordAtBoundary(live);
    await Promise.all([first, second]);
    const keys = await logKeys(logPath);
    assert.deepEqual(keys, ["U:u0", "A:a0", "U:u1", "U:u2"]);
    const size = (await fs.stat(logPath)).size;
    assert.equal(live.messagesLog?.bytes, size, "watermark bytes == file size");
    assert.equal(live.messagesLog?.count, keys.length, "watermark count == lines");
  });
});

test("the runtime trim keeps the messages array (no second copy of the count)", () => {
  const conversation = conversationOf(201);
  const before = conversation.messages;
  trimConversationForRuntime(conversation);
  assert.equal(conversation.messages.length, 200);
  assert.equal(conversation.messages, before, "trim must splice in place, not re-base the array");
});

test("the runtime trim of a fully logged array keeps every survivor logged (count before splice)", () => {
  const conversation = conversationOf(201);
  markAllMessagesLogged(conversation);
  trimConversationForRuntime(conversation);
  assert.equal(conversation.messages.length, 200);
  // 201 logged − 1 dropped = 200. Splicing first would clamp 201 to 200 and then
  // drop to 199, so the next boundary write would re-append the last entry.
  assert.equal(getLoggedMessageCount(conversation), 200);
});
