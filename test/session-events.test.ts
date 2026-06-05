import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { buildDeliveryEvent } from "../src/session/delivery-events.js";
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

test("appendMessages persists _claude/sessionStatus markers but leaves last_write_at unchanged", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-activity-neutral-marker";
    const record = makeSessionRecord(sessionId, cwd, 5);
    await writeSessionRecord(record);

    const writer = await SessionEventWriter.open(record);

    // A real agent message advances last_write_at + lastUsedAt.
    await writer.appendMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "real output" },
        },
      },
    } as never);
    const lastWriteAfterReal = writer.getRecord().eventLog.last_write_at;
    const lastUsedAfterReal = writer.getRecord().lastUsedAt;
    const seqAfterReal = writer.getRecord().lastSeq;
    assert.equal(typeof lastWriteAfterReal, "string");

    // Delay so that IF the marker wrongly bumped the clock the ISO timestamp would
    // differ (guards against a same-millisecond false pass).
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The adapter heartbeat marker: persisted to the stream + advances lastSeq
    // (it IS a stream line), but must NOT advance last_write_at / lastUsedAt — else
    // a heartbeat during a silent turn would reset acpx-ui's wedge clock.
    await writer.appendMessage({
      jsonrpc: "2.0",
      method: "_claude/sessionStatus",
      params: { sessionId, phase: "turn_no_activity", elapsedMs: 90_000 },
    } as never);

    assert.equal(
      writer.getRecord().eventLog.last_write_at,
      lastWriteAfterReal,
      "marker must NOT advance last_write_at",
    );
    assert.equal(
      writer.getRecord().lastUsedAt,
      lastUsedAfterReal,
      "marker must NOT advance lastUsedAt",
    );
    assert.equal(
      writer.getRecord().lastSeq,
      seqAfterReal + 1,
      "marker is still a stream line, so lastSeq advances",
    );

    // A subsequent real message DOES advance the clock again (mechanism intact).
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writer.appendMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "more output" },
        },
      },
    } as never);
    assert.notEqual(
      writer.getRecord().eventLog.last_write_at,
      lastWriteAfterReal,
      "a real message after a marker must advance last_write_at",
    );

    await writer.close({ checkpoint: true });

    // The marker IS in the stream (live transcript + debug); the persisted record's
    // last_write_at reflects only real agent output.
    const events = await listSessionEvents(sessionId);
    assert.equal(events.length, 3);
    assert.equal((events[1] as { method?: string }).method, "_claude/sessionStatus");
  });
});

test("acpx/delivery events are stream lines but do not advance last_write_at", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-delivery-neutral";
    const record = makeSessionRecord(sessionId, cwd, 5);
    await writeSessionRecord(record);

    const writer = await SessionEventWriter.open(record);
    await writer.appendMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "real output" },
        },
      },
    } as never);
    const lastWriteAfterReal = writer.getRecord().eventLog.last_write_at;
    const lastUsedAfterReal = writer.getRecord().lastUsedAt;
    const seqAfterReal = writer.getRecord().lastSeq;

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writer.appendMessage(
      buildDeliveryEvent({
        messageId: "11111111-1111-4111-8111-111111111111",
        requestId: "req-delivery",
        phase: "accepted",
        at: "2026-06-05T00:00:00.000Z",
      }),
    );

    assert.equal(writer.getRecord().eventLog.last_write_at, lastWriteAfterReal);
    assert.equal(writer.getRecord().lastUsedAt, lastUsedAfterReal);
    assert.equal(writer.getRecord().lastSeq, seqAfterReal + 1);

    const events = await listSessionEvents(sessionId);
    assert.equal(events.length, 2);
    assert.deepEqual(events[1], {
      jsonrpc: "2.0",
      method: "acpx/delivery",
      params: {
        messageId: "11111111-1111-4111-8111-111111111111",
        requestId: "req-delivery",
        phase: "accepted",
        stopReason: null,
        error: { code: 0, message: "", detailCode: "" },
        at: "2026-06-05T00:00:00.000Z",
      },
    });
  });
});

test("Codex agent_progress_update advances last_write_at activity", async () => {
  await withTempHome(async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const sessionId = "session-codex-progress-activity";
    const record = makeSessionRecord(sessionId, cwd, 5);
    await writeSessionRecord(record);

    const writer = await SessionEventWriter.open(record);
    await writer.appendMessage({
      jsonrpc: "2.0",
      method: "_claude/sessionStatus",
      params: { sessionId, phase: "turn_no_activity", elapsedMs: 90_000 },
    } as never);
    assert.equal(writer.getRecord().eventLog.last_write_at, undefined);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writer.appendMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_progress_update",
          progress: {
            phase: "thinking",
            tokens: { reasoning: 42 },
            source: "codex",
          },
        },
      },
    } as never);

    assert.equal(typeof writer.getRecord().eventLog.last_write_at, "string");
    assert.equal(writer.getRecord().lastSeq, 2);
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
