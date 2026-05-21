import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { defaultSessionEventLog } from "../src/session/event-log.js";
import { SessionEventWriter, listSessionEvents } from "../src/session/events.js";
import { resolveSessionRecord, writeSessionRecord } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-events-home-"));
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

function makeSessionRecord(sessionId: string, cwd: string, maxSegments: number): SessionRecord {
  const now = "2026-02-28T00:00:00.000Z";
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
      max_segments: maxSegments,
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

test("listSessionEvents reads all configured stream segments", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-stream-max-window";
    const record = makeSessionRecord(sessionId, cwd, 7);
    await writeSessionRecord(record);

    const writer = await SessionEventWriter.open(record, {
      maxSegmentBytes: 1,
      maxSegments: 7,
    });

    for (let index = 0; index < 8; index += 1) {
      await writer.appendMessage({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `event-${index + 1}` },
          },
        },
      } as never);
    }
    await writer.close({ checkpoint: true });

    const events = await listSessionEvents(sessionId);
    assert.equal(events.length, 8);
    assert.equal(
      events.every((event) => event.jsonrpc === "2.0"),
      true,
    );
  });
});

test("SessionEventWriter stores actual segment_count and increments lastSeq", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-stream-segment-count";
    const record = makeSessionRecord(sessionId, cwd, 7);
    await writeSessionRecord(record);

    const writer = await SessionEventWriter.open(record, {
      maxSegmentBytes: 1,
      maxSegments: 7,
    });

    await writer.appendMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "first" },
        },
      },
    } as never);
    assert.equal(writer.getRecord().eventLog.segment_count, 1);

    await writer.appendMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "second" },
        },
      },
    } as never);
    assert.equal(writer.getRecord().eventLog.segment_count, 2);

    await writer.appendMessage({
      jsonrpc: "2.0",
      id: "req-3",
      result: { stopReason: "end_turn" },
    } as never);
    assert.equal(writer.getRecord().eventLog.segment_count, 3);
    assert.equal(writer.getRecord().lastSeq, 3);
    assert.equal(writer.getRecord().lastRequestId, "req-3");

    await writer.close({ checkpoint: true });

    const stored = await resolveSessionRecord(sessionId);
    assert.equal(stored.eventLog.segment_count, 3);
    assert.equal(stored.eventLog.max_segments, 7);
    assert.equal(stored.lastSeq, 3);
  });
});

test("listSessionEvents skips malformed NDJSON lines", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-stream-skip-malformed";
    const record = makeSessionRecord(sessionId, cwd, 5);
    await writeSessionRecord(record);

    await fs.mkdir(path.dirname(record.eventLog.active_path), { recursive: true });
    const validOne = JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "first" },
        },
      },
    });
    const validTwo = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-2",
      result: { stopReason: "end_turn" },
    });
    await fs.writeFile(
      record.eventLog.active_path,
      `${validOne}\n{invalid-json\n${validTwo}\n`,
      "utf8",
    );

    const events = await listSessionEvents(sessionId);
    assert.equal(events.length, 2);
    assert.equal(
      events.every((event) => event.jsonrpc === "2.0"),
      true,
    );
  });
});

test("SessionEventWriter serializes concurrent appendMessages in FIFO order", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-stream-concurrent-fifo";
    const record = makeSessionRecord(sessionId, cwd, 5);
    await writeSessionRecord(record);

    const writer = await SessionEventWriter.open(record);

    // Fire B concurrent batches without awaiting between them. Each batch
    // contains K messages tagged (batch,index). With a per-writer mutex the
    // batches must land contiguously and in dispatch order; without it, the
    // libuv threadpool can interleave per-message appendFile syscalls.
    const batchCount = 12;
    const messagesPerBatch = 8;
    const pending: Promise<void>[] = [];
    for (let batch = 0; batch < batchCount; batch += 1) {
      const payload = Array.from({ length: messagesPerBatch }, (_unused, index) => ({
        jsonrpc: "2.0" as const,
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `batch-${batch}-msg-${index}` },
          },
        },
      }));
      pending.push(writer.appendMessages(payload as never));
    }
    await Promise.all(pending);
    await writer.close({ checkpoint: true });

    const events = await listSessionEvents(sessionId);
    assert.equal(events.length, batchCount * messagesPerBatch);

    // Reconstruct (batch, index) pairs from each event and assert ordering:
    // batch ids appear in dispatch order, and within a batch indices are 0..K-1.
    const seen: Array<{ batch: number; index: number }> = [];
    for (const event of events) {
      const params = (event as { params?: { update?: { content?: { text?: string } } } }).params;
      const text = params?.update?.content?.text;
      assert.ok(typeof text === "string", "expected text content");
      const match = /^batch-(\d+)-msg-(\d+)$/.exec(text);
      assert.ok(match, `unexpected event text: ${text}`);
      seen.push({ batch: Number(match[1]), index: Number(match[2]) });
    }

    for (let batch = 0; batch < batchCount; batch += 1) {
      for (let index = 0; index < messagesPerBatch; index += 1) {
        const position = batch * messagesPerBatch + index;
        assert.deepEqual(
          seen[position],
          { batch, index },
          `event at position ${position} should be batch ${batch} index ${index}, got batch ${seen[position].batch} index ${seen[position].index}`,
        );
      }
    }
  });
});

test("SessionEventWriter recovers stale stream lock files", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-stream-stale-lock";
    const record = makeSessionRecord(sessionId, cwd, 5);
    await writeSessionRecord(record);

    const lockPath = path.join(
      homeDir,
      ".acpx",
      "sessions",
      `${encodeURIComponent(sessionId)}.stream.lock`,
    );
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 999_999,
        created_at: "2026-01-01T00:00:00.000Z",
      })}\n`,
      "utf8",
    );

    const writer = await SessionEventWriter.open(record);
    await writer.appendMessage({
      jsonrpc: "2.0",
      id: "req-stale-lock",
      result: { stopReason: "end_turn" },
    } as never);
    await writer.close({ checkpoint: true });

    const stored = await resolveSessionRecord(sessionId);
    assert.equal(stored.lastRequestId, "req-stale-lock");
  });
});
