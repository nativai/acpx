import assert from "node:assert/strict";
import test from "node:test";
import type { AcpClient } from "../src/acp/client.js";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { textPrompt } from "../src/prompt-content.js";
import { listSessionEvents } from "../src/session/events.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

// UMQ lane A2, N-A2-6 (TEST-PLAN §4.2), the NB4 pattern (test/delivery-pre-accept-terminals.test.ts):
// a sleeping session's FIRST-WAKE failure writes each member's own `failed` terminal, and writes it
// BEFORE the `accepted` delivery event and before any prompt — which is the one fact that makes it
// resend-safe. atrium classifies by code (`FAILURE_CODE_OUTCOMES`); `SESSION_MATERIALISATION_FAILED`
// is the code every such failure carries.

type StreamEvent = { method?: string; params?: Record<string, unknown> };

function deliveryEventsFor(events: StreamEvent[], messageId: string): Record<string, unknown>[] {
  return events
    .filter((event) => event.method === "acpx/delivery" && event.params?.messageId === messageId)
    .map((event) => event.params ?? {});
}

function sleepingRecord(cwd: string, id: string): SessionRecord {
  return makeSessionRecord(
    {
      acpxRecordId: id,
      acpSessionId: "",
      agentCommand: "node /opt/codex-acp/dist/index.js",
      cwd,
      acpx: { sleeping: { since: "2026-11-09T10:00:00.000Z" } },
      eventLog: {
        active_path: ".stream.ndjson",
        segment_count: 1,
        max_segment_bytes: 64 * 1024 * 1024,
        max_segments: 1,
        last_write_at: "2026-01-01T00:00:00.000Z",
        last_write_error: null,
      },
    },
    { defaultAcpx: false },
  );
}

function task(messageId: string, sent: QueueOwnerMessage[], waitForCompletion = true): QueueTask {
  return {
    requestId: `req-${messageId}`,
    messageId,
    message: "first wake probe",
    prompt: textPrompt("first wake probe"),
    permissionMode: "approve-all",
    timeoutMs: 30_000,
    waitForCompletion,
    enqueuedAt: Date.now(),
    send: (message) => sent.push(message),
    close: () => {},
  } satisfies QueueTask;
}

/** The turn path's adapter surface (single-live-turn.test.ts's shape) with a `session/new` that may fail. */
function clientWhoseNewSession(counter: { prompts: number }, fail: boolean): AcpClient {
  return {
    hasReusableSession: () => false,
    start: async () => {},
    markAdvertisement: () => 0,
    advertisedConfigOptionsSince: () => undefined,
    getAgentLifecycleSnapshot: () => ({ running: true }),
    supportsResumeSession: () => true,
    supportsLoadSession: () => true,
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,
    updateRuntimeOptions: () => {},
    setEventHandlers: () => {},
    clearEventHandlers: () => {},
    hasActivePrompt: () => false,
    requestCancelActivePrompt: async () => false,
    cancelActivePrompt: async () => undefined,
    createSession: async () => {
      if (fail) {
        throw new Error("adapter will not start");
      }
      return { sessionId: "first-wake-session", agentSessionId: "first-wake-agent" };
    },
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    close: async () => {},
    waitForSessionUpdatesIdle: async () => {},
    getEffectiveAccountMetadata: () => undefined,
    prompt: async () => {
      counter.prompts += 1;
      return { stopReason: "end_turn" as const };
    },
  } as unknown as AcpClient;
}

test("N-A2-6 terminal CONTROL: the same sleeping record with a working session/new DOES write `accepted`, runs the prompt and ends the sleep", async () => {
  // Without this row, "no accepted event" below could be a reader that never finds any.
  await withTempHome("acpx-fw-control-", async (homeDir) => {
    const record = sleepingRecord(homeDir, "fw-control");
    await writeSessionRecordFile(homeDir, record);
    const counter = { prompts: 0 };
    const sent: QueueOwnerMessage[] = [];
    await runQueuedTask(record.acpxRecordId, [task("fw-control-msg", sent)], {
      sharedClient: clientWhoseNewSession(counter, false),
      suppressSdkConsoleErrors: true,
    });
    assert.equal(counter.prompts, 1, JSON.stringify(sent));
    const phases = deliveryEventsFor(
      (await listSessionEvents(record.acpxRecordId)) as StreamEvent[],
      "fw-control-msg",
    ).map((params) => params.phase);
    assert.ok(phases.includes("accepted"), JSON.stringify(phases));
  });
});

test("N-A2-6 terminal · a first-wake failure writes EACH member's own SESSION_MATERIALISATION_FAILED terminal — no `accepted`, no prompt — and the record is still sleeping", async () => {
  await withTempHome("acpx-fw-fail-", async (homeDir) => {
    const record = sleepingRecord(homeDir, "fw-fail");
    await writeSessionRecordFile(homeDir, record);
    const counter = { prompts: 0 };
    const waiting: QueueOwnerMessage[] = [];
    const silent: QueueOwnerMessage[] = [];
    // One turn, two members — the shape atrium's batch gives the owner: the head may be a waiting caller
    // (answered over IPC), the rest have none (their terminal is the delivery event alone).
    await runQueuedTask(
      record.acpxRecordId,
      [task("fw-fail-a", waiting), task("fw-fail-b", silent, false)],
      { sharedClient: clientWhoseNewSession(counter, true), suppressSdkConsoleErrors: true },
    ).catch(() => {});

    assert.equal(counter.prompts, 0, "client.prompt ran before the materialisation failed");
    const terminal = waiting.find((message) => message.type === "error");
    assert(terminal && terminal.type === "error", `no terminal: ${JSON.stringify(waiting)}`);
    assert.equal(terminal.detailCode, "SESSION_MATERIALISATION_FAILED");
    assert.match(terminal.message, /could not be started: adapter will not start/u);
    assert.match(terminal.message, /Nothing was sent to the agent/u);

    const onDisk = await resolveSessionRecord(record.acpxRecordId);
    assert.equal(onDisk.acpSessionId, "", "still not started");
    assert.ok(onDisk.acpx?.sleeping, "still sleeping");

    const events = (await listSessionEvents(record.acpxRecordId)) as StreamEvent[];
    for (const messageId of ["fw-fail-a", "fw-fail-b"]) {
      const delivery = deliveryEventsFor(events, messageId);
      assert.equal(
        delivery.filter((params) => params.phase === "accepted").length,
        0,
        `${messageId}: an accepted event precedes the materialisation terminal: ${JSON.stringify(delivery)}`,
      );
      const failed = delivery.find((params) => params.phase === "failed");
      assert.ok(failed, `${messageId}: no failed delivery event: ${JSON.stringify(delivery)}`);
      assert.equal(
        (failed.error as { detailCode?: string } | undefined)?.detailCode,
        "SESSION_MATERIALISATION_FAILED",
        messageId,
      );
    }
  });
});
