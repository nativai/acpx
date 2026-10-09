// brick a147982f — I-layer rows for the C1 turn watchdog's Claude arming (CONCEPTION §6).
//
// The real `runQueuedTask` -> `runSessionPrompt` runtime, with real stream and delivery files,
// against the scripted Claude adapter in test/pathological-adapter-helpers.ts. Every signal
// goes through the SAME production taps the real AcpClient feeds (`onAcpMessage` inbound, then
// `onSessionUpdate`), never into the watchdog directly. The adapter's end-of-turn modes are
// `ClaudeAdapterEndMode`: lifecycle (the fixed adapter), legacy (today's deployed adapter),
// foreign, routing-hole and lost-response.
//
// Rows here: P6 P7 P8 P10, the cancel-answer recovery row, N1 N2 N3 N6 N7 N10 (and N12's
// emission half). P9 and P11 extend the existing C1 tests in test/mid-turn-injection.test.ts;
// P15 is the existing codex test there, unedited. Unit rows: test/turn-watchdog-arming.test.ts.

import assert from "node:assert/strict";
import test from "node:test";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { textPrompt } from "../src/prompt-content.js";
import { listSessionEvents } from "../src/session/events.js";
import type { SessionNotification, SessionRecord } from "../src/types.js";
import {
  CLAUDE_AGENT_COMMAND,
  type PathologicalControl,
  cancelResolvesPrompt,
  emitClaudeTurnEnd,
  FOREIGN_PROMPT_ID,
  MAIN_PROMPT_TEXT,
  makePathologicalClient,
} from "./pathological-adapter-helpers.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

// The watchdog interval for these rows. Every negative row waits 3 × this with NO response,
// so a watchdog that wrongly armed would have fired tier 1 (and tier 2) inside the window.
const TIMEOUT_MS = 60;
const SILENCE_MS = TIMEOUT_MS * 3;
// Deadline for a turn that must finish. A healthy turn here finishes in milliseconds and a
// wrong one hangs forever, so the deadline sits far above box noise (measured: these rows take
// several seconds each at load average ~80 on devbox, 2026-10-09).
const MUST_FINISH_MS = 30_000;

function makeSessionRecord(cwd: string): SessionRecord {
  return makeSessionRecordFixture({
    acpxRecordId: "turn-watchdog-lifecycle",
    acpSessionId: "turn-watchdog-lifecycle-session",
    agentCommand: CLAUDE_AGENT_COMMAND,
    cwd,
  });
}

function makeQueueTask(
  requestId: string,
  messageId: string,
  onSend: (message: QueueOwnerMessage) => void,
): QueueTask {
  return {
    requestId,
    messageId,
    message: MAIN_PROMPT_TEXT,
    prompt: textPrompt(MAIN_PROMPT_TEXT),
    permissionMode: "approve-all",
    timeoutMs: 10_000,
    waitForCompletion: true,
    enqueuedAt: Date.now(),
    send: onSend,
    close: () => {},
  } satisfies QueueTask;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTurnResponseTimeout<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ACPX_TURN_RESPONSE_TIMEOUT_MS;
  process.env.ACPX_TURN_RESPONSE_TIMEOUT_MS = String(ms);
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_TURN_RESPONSE_TIMEOUT_MS;
    } else {
      process.env.ACPX_TURN_RESPONSE_TIMEOUT_MS = previous;
    }
  }
}

async function withRaceTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function withNoUnhandledRejections(run: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await run();
    await sleep(10);
    assert.deepEqual(unhandled, [], "no unhandled rejections");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

function eventMethod(event: unknown): string | undefined {
  const method = (event as { method?: unknown } | null)?.method;
  return typeof method === "string" ? method : undefined;
}

function eventParams(event: unknown): Record<string, unknown> {
  const params = (event as { params?: unknown } | null)?.params;
  return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

type TurnObservation = {
  terminals: Record<string, unknown>[];
  watchdogEvents: Record<string, unknown>[];
  lifecycleEvents: Record<string, unknown>[];
  sends: QueueOwnerMessage[];
};

async function observe(
  record: SessionRecord,
  messageId: string,
  sends: QueueOwnerMessage[],
): Promise<TurnObservation> {
  const events = await listSessionEvents(record.acpxRecordId);
  return {
    terminals: events
      .filter((event) => eventMethod(event) === "acpx/delivery")
      .map(eventParams)
      .filter((params) => params.messageId === messageId && params.phase !== "accepted"),
    watchdogEvents: events
      .filter((event) => eventMethod(event) === "acpx/turn-watchdog")
      .map(eventParams),
    lifecycleEvents: events
      .filter((event) => eventMethod(event) === "_claude/promptLifecycle")
      .map(eventParams),
    sends,
  };
}

/**
 * One Claude main turn against the scripted adapter. `drive` runs once the main prompt is in
 * flight and scripts the adapter (signals, frames, the response). Returns what the stream
 * and the delivery record hold afterwards.
 */
async function runClaudeTurn(params: {
  messageId: string;
  timeoutMs?: number;
  setup?: (control: PathologicalControl) => void;
  drive: (control: PathologicalControl) => Promise<void>;
}): Promise<TurnObservation & { control: PathologicalControl }> {
  let observation: (TurnObservation & { control: PathologicalControl }) | undefined;
  await withNoUnhandledRejections(async () => {
    await withTempHomeFixture("acpx-turn-watchdog-lifecycle-", async (homeDir) => {
      const record = makeSessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);
      const control = makePathologicalClient({ acpSessionId: record.acpSessionId });
      params.setup?.(control);
      const sends: QueueOwnerMessage[] = [];
      const task = makeQueueTask(`req-${params.messageId}`, params.messageId, (message) =>
        sends.push(message),
      );
      const run = withTurnResponseTimeout(params.timeoutMs ?? TIMEOUT_MS, () =>
        runQueuedTask(record.acpxRecordId, task, {
          sharedClient: control.client,
          suppressSdkConsoleErrors: true,
        }),
      );
      await control.mainPromptInFlight;
      await sleep(0);
      await params.drive(control);
      await withRaceTimeout(run, MUST_FINISH_MS, "the turn never finished");
      observation = { ...(await observe(record, params.messageId, sends)), control };
    });
  });
  assert.ok(observation);
  return observation;
}

function agentMessageChunk(acpSessionId: string, text: string): SessionNotification {
  return {
    sessionId: acpSessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  } as unknown as SessionNotification;
}

const ACP_SESSION_ID = "turn-watchdog-lifecycle-session";

function onlyTerminal(observation: TurnObservation): Record<string, unknown> {
  assert.equal(observation.terminals.length, 1, "exactly one delivery terminal");
  const [terminal] = observation.terminals;
  assert.ok(terminal);
  return terminal;
}

function assertCleanCompletion(observation: TurnObservation & { control: PathologicalControl }) {
  assert.equal(observation.control.cancelCount(), 0, "no session/cancel was sent");
  assert.deepEqual(observation.watchdogEvents, [], "no acpx/turn-watchdog record");
  const terminal = onlyTerminal(observation);
  assert.equal(terminal.phase, "done");
  assert.equal(terminal.stopReason, "end_turn");
  assert.equal("recoveredBy" in terminal, false, "a clean completion is not a recovery");
  assert.ok(
    observation.sends.find((message) => message.type === "result"),
    "the caller got its result",
  );
}

// --- positive rows ----------------------------------------------------------

// P6 — the fixed adapter's normal end: attributed `sdk_idle` + `completing`, then the
// response well inside the interval. The watchdog arms and the response disposes it.
test("P6: attributed lifecycle signals then the response — no cancel, done/end_turn", async () => {
  const observation = await runClaudeTurn({
    messageId: "p6000000-0000-4000-8000-000000000000",
    drive: async (control) => {
      emitClaudeTurnEnd(control, "lifecycle");
      control.resolveMainPrompt({ stopReason: "end_turn" });
      await sleep(SILENCE_MS);
    },
  });
  assertCleanCompletion(observation);
  // The signals reached the stream, attributed to the prompt the runtime sent.
  const promptId = observation.control.mainPromptId();
  assert.ok(promptId);
  assert.deepEqual(
    observation.lifecycleEvents.map((event) => [event.phase, event.promptId]),
    [
      ["sdk_idle", promptId],
      ["completing", promptId],
    ],
  );
});

// P7 — the async-Agent continuation (c919c17f's shape): a mid-prompt usage_update with NO
// marker (the fixed adapter, A1), then 2.5 × the interval of sub-agent/main activity, then the
// signals and the response.
test("P7: a continuation running 2.5 × the interval after a mid-prompt result is never cut", async () => {
  const observation = await runClaudeTurn({
    messageId: "p7000000-0000-4000-8000-000000000000",
    drive: async (control) => {
      control.emitSessionUpdate({
        sessionId: ACP_SESSION_ID,
        update: { sessionUpdate: "usage_update", used: 100, size: 200_000 },
      } as unknown as SessionNotification);
      for (let i = 0; i < 10; i += 1) {
        control.emitSessionUpdate(agentMessageChunk(ACP_SESSION_ID, `continuation ${i}`));
        await sleep(TIMEOUT_MS / 4);
      }
      emitClaudeTurnEnd(control, "lifecycle");
      control.resolveMainPrompt({ stopReason: "end_turn" });
    },
  });
  assertCleanCompletion(observation);
});

// P8 — a SILENT wait (a background task with no output, census class C) of 3 × the interval,
// then the signals and the response. Version-proof: no assumption about which task kinds
// the SDK holds the prompt open for (F4).
test("P8: a silent wait of 3 × the interval before the turn ends is never cut", async () => {
  const observation = await runClaudeTurn({
    messageId: "p8000000-0000-4000-8000-000000000000",
    drive: async (control) => {
      await sleep(SILENCE_MS);
      emitClaudeTurnEnd(control, "lifecycle");
      control.resolveMainPrompt({ stopReason: "end_turn" });
    },
  });
  assertCleanCompletion(observation);
});

// P10 — the backstop's second class (AC4b): `completing{end_turn}`, then the response is
// lost. Tier 1 cancels; nothing arrived after arming, so it is a recovery that reports the
// reason `completing` carried.
test("P10: lost response after completing{end_turn} — tier-1 recovers it as done/end_turn + recoveredBy", async () => {
  const observation = await runClaudeTurn({
    messageId: "p1000000-0000-4000-8000-000000000000",
    setup: (control) => cancelResolvesPrompt(control, "cancelled"),
    drive: async (control) => {
      emitClaudeTurnEnd(control, "lost-response");
    },
  });
  assert.ok(observation.control.cancelCount() >= 1, "tier 1 sent a cancel");
  const terminal = onlyTerminal(observation);
  assert.equal(terminal.phase, "done");
  assert.equal(terminal.stopReason, "end_turn");
  assert.equal(terminal.recoveredBy, "turn-watchdog");
  assert.equal(observation.watchdogEvents.length, 1);
  assert.equal(observation.watchdogEvents[0]?.tier, 1);
  // `sdk_idle` arrives first and starts the clock; `completing` supplies the reason.
  assert.equal(observation.watchdogEvents[0]?.armedBy, "sdk_idle");
  assert.equal(observation.watchdogEvents[0]?.markerReason, "end_turn");
});

// The HoD's bracket row for X3 (paired with N6): frames the adapter emits IN ANSWER to the
// watchdog's cancel (a tool marked cancelled, a final usage_update) arrive after the cancel,
// not before it. They say nothing about whether work was still going on, so a clean arm with
// no frames before the cancel stays a recovery.
test("X3 bracket: frames that only answer the watchdog's cancel keep it a recovery (done + recoveredBy)", async () => {
  const observation = await runClaudeTurn({
    messageId: "x3b00000-0000-4000-8000-000000000000",
    setup: (control) =>
      control.setCancelBehavior(() => {
        control.emitSessionUpdate({
          sessionId: ACP_SESSION_ID,
          update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" },
        } as unknown as SessionNotification);
        control.emitSessionUpdate({
          sessionId: ACP_SESSION_ID,
          update: { sessionUpdate: "usage_update", used: 10, size: 200_000 },
        } as unknown as SessionNotification);
        control.resolveMainPrompt({ stopReason: "cancelled" });
      }),
    drive: async (control) => {
      emitClaudeTurnEnd(control, "routing-hole");
    },
  });
  assert.ok(observation.control.cancelCount() >= 1, "tier 1 sent a cancel");
  const terminal = onlyTerminal(observation);
  assert.equal(terminal.phase, "done");
  assert.equal(terminal.stopReason, null);
  assert.equal(terminal.recoveredBy, "turn-watchdog");
  assert.equal((terminal.error as { detailCode?: string }).detailCode, "");
});

// --- committed negative rows ------------------------------------------------

// N1 — TODAY's adapter: the unattributed `_claude/lastTurnEndReason` usage_update marker
// mid-prompt (the async-Agent shape), then 3 × the interval of silence, then the response.
// It must not arm. This is what makes shipping acpx first end every cut.
test("N1: the legacy usage_update marker never arms a Claude turn", async () => {
  const observation = await runClaudeTurn({
    messageId: "n1000000-0000-4000-8000-000000000000",
    drive: async (control) => {
      emitClaudeTurnEnd(control, "legacy");
      await sleep(SILENCE_MS);
      assert.equal(control.cancelCount(), 0, "no cancel during the silence");
      control.resolveMainPrompt({ stopReason: "end_turn" });
    },
  });
  assertCleanCompletion(observation);
});

// N2 — a FOREIGN prompt's lifecycle signals (da67c967: an orphaned injected prompt's end
// armed the next turn's watchdog), then silence. They must not arm. The second half is the
// paired positive control: an attributed `sdk_idle` in the same turn DOES arm, so the
// silence above was a real chance to fire, not a rig that cannot.
test("N2: a foreign prompt's lifecycle signal never arms; the attributed one does", async () => {
  const observation = await runClaudeTurn({
    messageId: "n2000000-0000-4000-8000-000000000000",
    setup: (control) => cancelResolvesPrompt(control, "cancelled"),
    drive: async (control) => {
      emitClaudeTurnEnd(control, "foreign");
      await sleep(SILENCE_MS);
      assert.equal(control.cancelCount(), 0, "the foreign signal did not arm the watchdog");
      assert.notEqual(control.mainPromptId(), FOREIGN_PROMPT_ID);
      emitClaudeTurnEnd(control, "routing-hole");
    },
  });
  assert.ok(observation.control.cancelCount() >= 1, "the attributed signal armed it");
  const terminal = onlyTerminal(observation);
  assert.equal(terminal.recoveredBy, "turn-watchdog");
  // Only the attributed signal is named as the arming one, and its id is the guarded one.
  assert.equal(observation.watchdogEvents.length, 1);
  assert.equal(observation.watchdogEvents[0]?.promptId, observation.control.mainPromptId());
});

// N3 — even a marker that carries the guarded `_claude/promptId`, on a `session/update`,
// does not arm a Claude turn: only `_claude/promptLifecycle` does.
test("N3: an attributed _claude/lastTurnEndReason on a session/update does not arm", async () => {
  const observation = await runClaudeTurn({
    messageId: "n3000000-0000-4000-8000-000000000000",
    drive: async (control) => {
      const promptId = control.mainPromptId();
      assert.ok(promptId, "the main prompt carried a _claude/promptId");
      control.emitSessionUpdate({
        sessionId: ACP_SESSION_ID,
        update: { sessionUpdate: "usage_update", used: 1, size: 200_000 },
        _meta: { "_claude/lastTurnEndReason": "end_turn", "_claude/promptId": promptId },
      } as unknown as SessionNotification);
      control.emitSessionUpdate({
        sessionId: ACP_SESSION_ID,
        update: {
          sessionUpdate: "session_info_update",
          _meta: { "_claude/lastTurnEndReason": "end_turn", "_claude/promptId": promptId },
        },
      } as unknown as SessionNotification);
      await sleep(SILENCE_MS);
      assert.equal(control.cancelCount(), 0, "no cancel during the silence");
      control.resolveMainPrompt({ stopReason: "end_turn" });
    },
  });
  assertCleanCompletion(observation);
});

// N6 — the cut (G3/AC5): the watchdog armed, but the turn kept producing output BEFORE tier 1
// cancelled it. That cancel cut live work, so the delivery is `failed /
// TURN_WATCHDOG_CANCELLED` — never `end_turn`, never `recoveredBy`. (N12's emission half:
// acpx emits exactly the exported message and code.)
test("N6: a watchdog cancel that lands after post-arm output is failed / TURN_WATCHDOG_CANCELLED", async () => {
  const observation = await runClaudeTurn({
    messageId: "n6000000-0000-4000-8000-000000000000",
    setup: (control) => cancelResolvesPrompt(control, "cancelled"),
    drive: async (control) => {
      emitClaudeTurnEnd(control, "lost-response");
      control.emitSessionUpdate(agentMessageChunk(ACP_SESSION_ID, "still working"));
      control.emitSessionUpdate({
        sessionId: ACP_SESSION_ID,
        update: { sessionUpdate: "tool_call", toolCallId: "t-live", status: "pending" },
      } as unknown as SessionNotification);
    },
  });
  assert.ok(observation.control.cancelCount() >= 1, "tier 1 sent a cancel");
  const terminal = onlyTerminal(observation);
  assert.equal(terminal.phase, "failed");
  assert.notEqual(terminal.stopReason, "end_turn");
  assert.equal("recoveredBy" in terminal, false);
  // Dynamic import: on a build without the constants this reads `undefined` and the
  // assertion fails, instead of the whole file failing to link.
  const contract = (await import("../src/cli/queue/delivery-terminals.js")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(terminal.error, {
    code: 0,
    message: contract.TURN_WATCHDOG_CANCELLED_MESSAGE,
    detailCode: contract.TURN_WATCHDOG_CANCELLED_DETAIL_CODE,
  });
  assert.equal((terminal.error as { detailCode?: string }).detailCode, "TURN_WATCHDOG_CANCELLED");
});

// N7 — a USER cancel (the same `requestCancelActivePrompt` path acpx's cancel uses) after an
// attributed `completing{end_turn}` and, separately, after a legacy marker. Neither is the
// watchdog's cancel, so neither is ever rewritten to `end_turn` (AC6). The interval is long so
// the watchdog cannot be the one cancelling.
for (const mode of ["lifecycle", "legacy"] as const) {
  test(`N7: a user cancel after a ${mode} end signal is reported cancelled, never end_turn`, async () => {
    const observation = await runClaudeTurn({
      messageId: `n7${mode === "lifecycle" ? "a" : "b"}00000-0000-4000-8000-000000000000`,
      timeoutMs: 60_000,
      setup: (control) => cancelResolvesPrompt(control, "cancelled"),
      drive: async (control) => {
        emitClaudeTurnEnd(control, mode);
        await control.client.requestCancelActivePrompt();
      },
    });
    assert.equal(observation.control.cancelCount(), 1, "only the user's cancel");
    assert.deepEqual(observation.watchdogEvents, [], "the watchdog never fired");
    const terminal = onlyTerminal(observation);
    assert.equal(terminal.phase, "cancelled");
    assert.equal(terminal.stopReason, "cancelled");
    assert.equal("recoveredBy" in terminal, false);
  });
}

// N10 — brick ddd76838's zero-output warning still fires for a Claude turn that produced no
// content frame, because lifecycle signals are ext notifications, not `session/update` frames.
test("N10: lifecycle signals are not frames — a content-less Claude turn still gets the zero-output warning", async () => {
  const observation = await runClaudeTurn({
    messageId: "n1000000-0000-4000-8000-0000000000aa",
    drive: async (control) => {
      assert.ok(control.mainPromptId(), "precondition: the main prompt carried a _claude/promptId");
      emitClaudeTurnEnd(control, "lifecycle");
      control.resolveMainPrompt({ stopReason: "end_turn" });
    },
  });
  assert.equal(observation.lifecycleEvents.length, 2, "both signals reached the stream");
  const terminal = onlyTerminal(observation);
  assert.equal(terminal.phase, "done");
  assert.equal(terminal.warning, "completed with no agent output");
});
