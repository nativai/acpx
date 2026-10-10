import assert from "node:assert/strict";
import test from "node:test";
import type { AcpClient } from "../src/acp/client.js";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { textPrompt } from "../src/prompt-content.js";
import { listSessionEvents } from "../src/session/events.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

// NB4 (brick 29d54652, e09628a1 CONCEPTION-ADDENDUM §B.4) — THE GUARD ON CRITERION (a).
//
// acpx-ui classifies a failed item carrying `SESSION_RESUME_REQUIRED` or `codex-subscription-cap` as
// `not_delivered` / `resendSafe:true` / `never_reached` (its `FAILURE_CODE_OUTCOMES`). That row is only
// true because acpx mints both codes BEFORE the prompt reaches the model: the resume failure inside the
// turn's connect, the cap inside the pre-submit admission block — both ahead of the `accepted` delivery
// event and of `client.prompt`.
//
// ⚠️ DO NOT MOVE EITHER MINT SITE AFTER `accepted`, AND DO NOT DELETE THESE ROWS AS "REDUNDANT WITH THE
// acpx-ui ROW". The acpx-ui verdict cannot see acpx's ordering: if a future change minted either code
// after `accepted`, acpx-ui would still call the message "never reached — safe to resend" for every item
// whose `acceptedAt` it missed, which is the duplicate-resend hazard (brick 932a1e5e). These rows are the
// only place that ordering is asserted. Permanent, per part 3's approval of the addendum.

const CODEX_AGENT_COMMAND = "node /opt/codex-acp/dist/index.js";

type StreamEvent = { method?: string; params?: Record<string, unknown> };

function deliveryEventsFor(events: StreamEvent[], messageId: string): Record<string, unknown>[] {
  return events
    .filter((event) => event.method === "acpx/delivery" && event.params?.messageId === messageId)
    .map((event) => event.params ?? {});
}

function codexRecord(cwd: string, id: string): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `${id}-acp`,
    agentCommand: CODEX_AGENT_COMMAND,
    cwd,
    eventLog: {
      active_path: ".stream.ndjson",
      segment_count: 1,
      max_segment_bytes: 64 * 1024 * 1024,
      max_segments: 1,
      last_write_at: "2026-01-01T00:00:00.000Z",
      last_write_error: null,
    },
  });
}

function task(
  messageId: string,
  sent: QueueOwnerMessage[],
  extra: Partial<QueueTask> = {},
): QueueTask {
  return {
    requestId: `req-${messageId}`,
    messageId,
    message: "nb4 probe",
    prompt: textPrompt("nb4 probe"),
    permissionMode: "approve-all",
    timeoutMs: 30_000,
    waitForCompletion: true,
    enqueuedAt: Date.now(),
    send: (message) => sent.push(message),
    close: () => {},
    ...extra,
  } satisfies QueueTask;
}

// A client whose loaded session can be neither reused, resumed nor loaded. Under the
// `same-session-only` resume policy `loadOrCreateRuntimeSession` then throws
// `SessionResumeRequiredError` — a real mint site (`reconnect.ts` `makeSessionResumeRequiredError`).
// The rest of the surface is the turn path's (same shape as single-live-turn.test.ts's adapter).
function unresumableClient(counter: { prompts: number }): AcpClient {
  return {
    hasReusableSession: () => false,
    start: async () => {},
    getAgentLifecycleSnapshot: () => ({ running: true }),
    supportsResumeSession: () => false,
    supportsLoadSession: () => false,
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,
    updateRuntimeOptions: () => {},
    setEventHandlers: () => {},
    clearEventHandlers: () => {},
    hasActivePrompt: () => false,
    requestCancelActivePrompt: async () => false,
    cancelActivePrompt: async () => undefined,
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

async function withQuotaEnv(value: string, run: () => Promise<void>): Promise<void> {
  const original = process.env.ACPX_TEST_CODEX_QUOTA_JSON;
  process.env.ACPX_TEST_CODEX_QUOTA_JSON = value;
  try {
    await run();
  } finally {
    if (original === undefined) {
      delete process.env.ACPX_TEST_CODEX_QUOTA_JSON;
    } else {
      process.env.ACPX_TEST_CODEX_QUOTA_JSON = original;
    }
  }
}

function atCapQuota(): string {
  const resetsAtMs = Date.now() + 4 * 24 * 60 * 60 * 1_000;
  return JSON.stringify({
    capturedAt: new Date().toISOString(),
    secondary: {
      windowMinutes: 10_080,
      usedPercent: 97,
      elapsed: false,
      resetsAt: new Date(resetsAtMs).toISOString(),
      resetsAtEpoch: Math.floor(resetsAtMs / 1_000),
    },
  });
}

test("NB4 CONTROL: a turn that reaches the model DOES write `accepted` — the instrument below can see one", async () => {
  // Without this row, "no accepted event" in the two rows below could be a reader that never finds any.
  await withTempHome("acpx-nb4-control-", async (homeDir) => {
    const record = codexRecord(homeDir, "nb4-control");
    await writeSessionRecordFile(homeDir, record);
    const counter = { prompts: 0 };
    const client = {
      ...(unresumableClient(counter) as unknown as Record<string, unknown>),
      hasReusableSession: () => true,
    } as unknown as AcpClient;
    const sent: QueueOwnerMessage[] = [];
    await runQueuedTask(record.acpxRecordId, task("nb4-control-msg", sent), {
      sharedClient: client,
      suppressSdkConsoleErrors: true,
    });
    assert.equal(
      counter.prompts,
      1,
      `the control turn must reach client.prompt: ${JSON.stringify(sent)}`,
    );
    const phases = deliveryEventsFor(
      (await listSessionEvents(record.acpxRecordId)) as StreamEvent[],
      "nb4-control-msg",
    ).map((params) => params.phase);
    assert.ok(
      phases.includes("accepted"),
      `expected an accepted event, got ${JSON.stringify(phases)}`,
    );
  });
});

test("NB4: SESSION_RESUME_REQUIRED is minted at connect — no `accepted` event, no prompt, before its terminal", async () => {
  await withTempHome("acpx-nb4-resume-", async (homeDir) => {
    const record = codexRecord(homeDir, "nb4-resume");
    await writeSessionRecordFile(homeDir, record);
    const counter = { prompts: 0 };
    const sent: QueueOwnerMessage[] = [];
    await runQueuedTask(
      record.acpxRecordId,
      task("nb4-resume-msg", sent, { resumePolicy: "same-session-only" }),
      { sharedClient: unresumableClient(counter), suppressSdkConsoleErrors: true },
    ).catch(() => {});

    assert.equal(counter.prompts, 0, "client.prompt ran before SESSION_RESUME_REQUIRED was minted");
    const terminal = sent.find((message) => message.type === "error");
    assert(
      terminal && terminal.type === "error",
      `no terminal error reached IPC: ${JSON.stringify(sent)}`,
    );
    assert.equal(terminal.detailCode, "SESSION_RESUME_REQUIRED", JSON.stringify(terminal));
    const delivery = deliveryEventsFor(
      (await listSessionEvents(record.acpxRecordId)) as StreamEvent[],
      "nb4-resume-msg",
    );
    assert.equal(
      delivery.filter((params) => params.phase === "accepted").length,
      0,
      `an accepted event precedes SESSION_RESUME_REQUIRED: ${JSON.stringify(delivery)}`,
    );
  });
});

test("NB4: codex-subscription-cap is minted at pre-submit admission — no `accepted` event, no prompt, before its terminal", async () => {
  await withTempHome("acpx-nb4-cap-", async (homeDir) => {
    const record = codexRecord(homeDir, "nb4-cap");
    await writeSessionRecordFile(homeDir, record);
    const counter = { prompts: 0 };
    const sent: QueueOwnerMessage[] = [];
    // The env seam is an INPUT, not a skip: an at-cap canned observation holds (codex-subscription-cap.test.ts).
    await withQuotaEnv(atCapQuota(), async () => {
      await runQueuedTask(
        record.acpxRecordId,
        task("nb4-cap-msg", sent, { codexSubscriptionCapWeeklyPercent: 90 }),
        {
          sharedClient: {
            ...(unresumableClient(counter) as unknown as Record<string, unknown>),
            hasReusableSession: () => true,
          } as unknown as AcpClient,
          suppressSdkConsoleErrors: true,
        },
      ).catch(() => {});
    });

    assert.equal(counter.prompts, 0, "client.prompt ran before codex-subscription-cap was minted");
    const terminal = sent.find((message) => message.type === "error");
    assert(
      terminal && terminal.type === "error",
      `no terminal error reached IPC: ${JSON.stringify(sent)}`,
    );
    assert.equal(terminal.detailCode, "codex-subscription-cap", JSON.stringify(terminal));
    const delivery = deliveryEventsFor(
      (await listSessionEvents(record.acpxRecordId)) as StreamEvent[],
      "nb4-cap-msg",
    );
    assert.equal(
      delivery.filter((params) => params.phase === "accepted").length,
      0,
      `an accepted event precedes codex-subscription-cap: ${JSON.stringify(delivery)}`,
    );
  });
});
