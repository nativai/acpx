// brick://7531ef5c — the injected-prompt drain backstop, and AT MOST ONE LIVE
// AGENT TURN PER SESSION.
//
// Specimens (devbox, 2026-10-05): the Claude adapter returns a turn's MAIN
// request at the first mid-turn (injected) message, and the drain backstop timed
// its 30 min from there. Workers still busy 30 min later got a false
// `acpx/turn idle` and their consumed injected delivery `failed` "outcome
// unknown" (lanes A and C). On lane A the next message then started a SECOND
// turn while the first was still running — and because that turn re-picked a
// subscription it spawned a second adapter beside the live one: two agent loops
// in one session, editing one worktree.
//
// The rows run the production path below the CLI — `runQueuedTask` →
// `runSessionPrompt` with the owner's shared client and a real mid-turn
// injection — against a mock adapter whose prompt bookkeeping mirrors
// AcpClient's (`activePrompt` is replaced by each new prompt, cleared when that
// prompt settles, cleared by `close()`). The backstop is shortened through its
// env knob, ACPX_INJECTED_DRAIN_TIMEOUT_MS.

import assert from "node:assert/strict";
import test from "node:test";
import type { AcpClient } from "../src/acp/client.js";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import { endPreviousLiveTurn, runQueuedTask } from "../src/cli/session/runtime.js";
import { type PromptInput, textPrompt } from "../src/prompt-content.js";
import { listSessionEvents } from "../src/session/events.js";
import type { SessionRecord } from "../src/types.js";
import {
  CLAUDE_AGENT_COMMAND,
  createDeferred,
  type Deferred,
  INJECTED_PROMPT_TEXT,
  MAIN_PROMPT_TEXT,
  type PromptResponse,
} from "./pathological-adapter-helpers.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

const SECOND_PROMPT_TEXT = "the next delivered message";
const MAIN_ID = "7531ef5c-0000-4000-8000-00000000000a";
const INJECTED_ID = "7531ef5c-0000-4000-8000-00000000000b";
const SECOND_ID = "7531ef5c-0000-4000-8000-00000000000c";

type Handlers = {
  onAcpMessage?: (direction: unknown, message: unknown) => void;
  onSessionUpdate?: (notification: unknown) => void;
};

type PromptCall = { text: string; inFlightAtStart: number };

type AdapterControl = {
  client: AcpClient;
  calls: PromptCall[];
  mainInFlight: Promise<void>;
  injectedInFlight: Promise<void>;
  resolveMain: () => void;
  resolveInjected: () => void;
  /** One inbound ACP message from the adapter — what a working agent streams. */
  emitAgentOutput: () => void;
  /** A tool-call frame, delivered the way AcpClient delivers a session/update. */
  emitToolCall: (
    kind: "tool_call" | "tool_call_update",
    toolCallId: string,
    status: "pending" | "in_progress" | "completed" | "failed",
  ) => void;
  cancels: () => number;
  closes: () => number;
  inFlight: () => number;
};

function promptText(input: PromptInput | string): string {
  return typeof input === "string"
    ? input
    : input.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function makeAdapter(options: { honoursCancel: boolean }): AdapterControl {
  const handlers: Handlers = {};
  const calls: PromptCall[] = [];
  const inFlight = new Set<Deferred<PromptResponse>>();
  let active: Deferred<PromptResponse> | undefined;
  let cancels = 0;
  let closes = 0;
  const mainStarted = createDeferred<void>();
  const injectedStarted = createDeferred<void>();
  let main: Deferred<PromptResponse> | undefined;
  let injected: Deferred<PromptResponse> | undefined;

  const mock = {
    hasReusableSession: () => true,
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    start: async () => {},
    getAgentLifecycleSnapshot: () => ({ running: true }),
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,
    updateRuntimeOptions: () => {},
    setEventHandlers: (next: Handlers) => {
      Object.assign(handlers, next);
    },
    clearEventHandlers: () => {
      delete handlers.onAcpMessage;
      delete handlers.onSessionUpdate;
    },
    hasActivePrompt: () => active !== undefined,
    requestCancelActivePrompt: async () => false,
    cancelActivePrompt: async () => {
      cancels += 1;
      if (options.honoursCancel) {
        // ACP `session/cancel` is session-wide: every prompt in flight ends.
        for (const deferred of inFlight) {
          deferred.resolve({ stopReason: "cancelled" });
        }
        await Promise.resolve();
      }
      return undefined;
    },
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    close: async () => {
      closes += 1;
      // Stopping the adapter rejects whatever it was still running.
      for (const deferred of inFlight) {
        deferred.reject(new Error("agent process closed"));
      }
      active = undefined;
      await Promise.resolve();
    },
    waitForSessionUpdatesIdle: async () => {},
    getEffectiveAccountMetadata: () => undefined,
    prompt: (_sessionId: string, input: PromptInput | string): Promise<PromptResponse> => {
      const text = promptText(input);
      calls.push({ text, inFlightAtStart: inFlight.size });
      const deferred = createDeferred<PromptResponse>();
      inFlight.add(deferred);
      active = deferred;
      void deferred.promise
        .finally(() => {
          inFlight.delete(deferred);
          if (active === deferred) {
            active = undefined;
          }
        })
        .catch(() => {});
      if (text === MAIN_PROMPT_TEXT) {
        main = deferred;
        mainStarted.resolve();
      } else if (text === INJECTED_PROMPT_TEXT) {
        injected = deferred;
        injectedStarted.resolve();
      } else {
        // Any later turn simply completes.
        deferred.resolve({ stopReason: "end_turn" });
      }
      return deferred.promise;
    },
  };

  return {
    client: mock as unknown as AcpClient,
    calls,
    mainInFlight: mainStarted.promise,
    injectedInFlight: injectedStarted.promise,
    resolveMain: () => main?.resolve({ stopReason: "end_turn" }),
    resolveInjected: () => injected?.resolve({ stopReason: "end_turn" }),
    emitToolCall: (kind, toolCallId, status) => {
      const params = {
        sessionId: "acp-7531ef5c",
        update: { sessionUpdate: kind, toolCallId, status, title: "Bash" },
      };
      handlers.onAcpMessage?.("inbound", { jsonrpc: "2.0", method: "session/update", params });
      handlers.onSessionUpdate?.(params);
    },
    emitAgentOutput: () => {
      handlers.onAcpMessage?.("inbound", {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "acp-7531ef5c",
          update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" },
        },
      });
    },
    cancels: () => cancels,
    closes: () => closes,
    inFlight: () => inFlight.size,
  };
}

function queueTask(
  requestId: string,
  text: string,
  messageId: string,
  waitForCompletion: boolean,
): QueueTask {
  return {
    requestId,
    messageId,
    message: text,
    prompt: textPrompt(text),
    permissionMode: "approve-all",
    timeoutMs: 60_000,
    waitForCompletion,
    enqueuedAt: Date.now(),
    send: () => {},
    close: () => {},
  } satisfies QueueTask;
}

function sessionRecord(cwd: string): SessionRecord {
  return makeSessionRecord(
    {
      acpxRecordId: "single-live-turn",
      acpSessionId: "acp-7531ef5c",
      agentCommand: CLAUDE_AGENT_COMMAND,
      cwd,
      // The fixture default (1 KiB, one segment) would rotate the delivery
      // events out from under the agent-output frames these rows emit.
      eventLog: {
        active_path: ".stream.ndjson",
        segment_count: 1,
        max_segment_bytes: 64 * 1024 * 1024,
        max_segments: 1,
        last_write_at: "2026-01-01T00:00:00.000Z",
        last_write_error: null,
      },
    },
    { defaultName: false },
  );
}

async function withDrainTimeout<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ACPX_INJECTED_DRAIN_TIMEOUT_MS;
  process.env.ACPX_INJECTED_DRAIN_TIMEOUT_MS = String(ms);
  // The backstop timer is unref'd by design; while a row waits on it nothing
  // else holds the event loop, so hold it here (the C3 row does the same with a
  // ref'd race timeout).
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    return await run();
  } finally {
    clearInterval(keepAlive);
    if (previous === undefined) {
      delete process.env.ACPX_INJECTED_DRAIN_TIMEOUT_MS;
    } else {
      process.env.ACPX_INJECTED_DRAIN_TIMEOUT_MS = previous;
    }
  }
}

type StreamEvent = { method?: string; params?: Record<string, unknown> };

async function streamEvents(sessionId: string): Promise<StreamEvent[]> {
  return (await listSessionEvents(sessionId)) as StreamEvent[];
}

function terminalFor(
  events: StreamEvent[],
  messageId: string,
): Record<string, unknown> | undefined {
  return events.find(
    (event) =>
      event.method === "acpx/delivery" &&
      event.params?.messageId === messageId &&
      event.params?.phase !== "accepted",
  )?.params;
}

// Turn 1: the main request returns as soon as one message has been injected —
// the Claude adapter's promptQueueing shape — and the injected prompt is what
// keeps the agent working.
async function startTurnWithInjection(
  sessionId: string,
  adapter: AdapterControl,
): Promise<{ run: Promise<void> }> {
  let injectedOnce = false;
  const run = runQueuedTask(sessionId, queueTask("req-main", MAIN_PROMPT_TEXT, MAIN_ID, true), {
    sharedClient: adapter.client,
    suppressSdkConsoleErrors: true,
    setMidTurnHandler: (handler) => {
      if (handler && !injectedOnce) {
        injectedOnce = true;
        queueMicrotask(() =>
          handler(queueTask("req-injected", INJECTED_PROMPT_TEXT, INJECTED_ID, false)),
        );
      }
    },
  });
  await adapter.mainInFlight;
  await adapter.injectedInFlight;
  adapter.resolveMain();
  // Wrapped: an async function returning a promise would flatten into it.
  return { run };
}

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

// --- (1) the backstop times SILENCE, not the age of the turn ---------------

test("7531ef5c: an agent still producing output past the backstop window keeps its turn — no false idle, its injected delivery ends done", async () => {
  await withTempHome("acpx-7531ef5c-alive-", async (home) => {
    const record = sessionRecord(home);
    await writeSessionRecordFile(home, record);
    const adapter = makeAdapter({ honoursCancel: true });
    const windowMs = 600;

    await withDrainTimeout(windowMs, async () => {
      const { run } = await startTurnWithInjection(record.acpxRecordId, adapter);
      let finished = false;
      void run.then(() => {
        finished = true;
      });
      // The agent works for 4 windows, streaming every 100 ms (6x margin).
      const workUntil = Date.now() + 4 * windowMs;
      while (Date.now() < workUntil) {
        adapter.emitAgentOutput();
        await sleep(100);
      }
      // On the unrepaired base the turn finalized one window after the main
      // request returned, with the injected delivery `failed`.
      assert.equal(finished, false, "the turn was finalized while the agent was still working");
      adapter.resolveInjected();
      await run;
    });

    const events = await streamEvents(record.acpxRecordId);
    const injected = terminalFor(events, INJECTED_ID);
    assert.equal(injected?.phase, "done", `injected delivery: ${JSON.stringify(injected)}`);
    const idleAt = events.findIndex(
      (event) => event.method === "acpx/turn" && event.params?.phase === "idle",
    );
    const injectedAt = events.indexOf(
      events.find((event) => event.params === injected) as StreamEvent,
    );
    assert.ok(idleAt > injectedAt, "idle is written only after the injected prompt settled");
  });
});

test("7531ef5c CONTROL: a SILENT agent is still bounded — the backstop fires one window after its last output", async () => {
  await withTempHome("acpx-7531ef5c-silent-", async (home) => {
    const record = sessionRecord(home);
    await writeSessionRecordFile(home, record);
    const adapter = makeAdapter({ honoursCancel: false });
    const windowMs = 400;
    let lastOutputAt = 0;

    await withDrainTimeout(windowMs, async () => {
      const { run } = await startTurnWithInjection(record.acpxRecordId, adapter);
      // Output for 2 windows, then silence. The injected prompt never settles.
      const workUntil = Date.now() + 2 * windowMs;
      while (Date.now() < workUntil) {
        adapter.emitAgentOutput();
        lastOutputAt = Date.now();
        await sleep(50);
      }
      await run;
      const finishedAt = Date.now();
      assert.ok(
        finishedAt - lastOutputAt >= windowMs - 50,
        `finalized ${finishedAt - lastOutputAt}ms after the last output — before a full silence window`,
      );
    });

    const injected = terminalFor(await streamEvents(record.acpxRecordId), INJECTED_ID);
    assert.equal(injected?.phase, "failed");
    assert.equal(
      (injected?.error as { detailCode?: string } | undefined)?.detailCode,
      "INJECTED_RESPONSE_TIMEOUT",
    );
  });
});

// F1 (te-7531, VERIFICATION.md S2b): the steer is consumed, then ONE tool call runs
// silently for longer than the window — claude-agent-acp sends `tool_call` at the
// start and nothing until the tool returns. That is work, not silence.
test("7531ef5c F1: an OPEN tool call holds the window — a silent tool longer than the window is no false idle, the steer ends done", async () => {
  await withTempHome("acpx-7531ef5c-tool-", async (home) => {
    const record = sessionRecord(home);
    await writeSessionRecordFile(home, record);
    const adapter = makeAdapter({ honoursCancel: true });
    const windowMs = 400;

    await withDrainTimeout(windowMs, async () => {
      const { run } = await startTurnWithInjection(record.acpxRecordId, adapter);
      let finished = false;
      void run.then(() => {
        finished = true;
      });
      adapter.emitToolCall("tool_call", "bash-long", "in_progress");
      // Silent for 4 windows: no frames at all while the tool runs.
      await sleep(4 * windowMs);
      // On 98351e9b the backstop fired one window after the tool started.
      assert.equal(finished, false, "the turn was finalized while a tool call was still open");
      adapter.emitToolCall("tool_call_update", "bash-long", "completed");
      adapter.resolveInjected();
      await run;
    });

    const events = await streamEvents(record.acpxRecordId);
    const injected = terminalFor(events, INJECTED_ID);
    assert.equal(injected?.phase, "done", `injected delivery: ${JSON.stringify(injected)}`);
    assert.equal(adapter.cancels(), 0, "nothing cancelled the running tool");
  });
});

// CONTROL for F1: the hold ends with the tool. Once it completes, timing resumes
// from the completion — a finished tool followed by silence still fires.
test("7531ef5c F1 CONTROL: after the tool call COMPLETES, silence is timed from the completion and the backstop still fires", async () => {
  await withTempHome("acpx-7531ef5c-toolend-", async (home) => {
    const record = sessionRecord(home);
    await writeSessionRecordFile(home, record);
    const adapter = makeAdapter({ honoursCancel: false });
    const windowMs = 400;
    let completedAt = 0;

    await withDrainTimeout(windowMs, async () => {
      const { run } = await startTurnWithInjection(record.acpxRecordId, adapter);
      adapter.emitToolCall("tool_call", "bash-short", "in_progress");
      await sleep(2 * windowMs);
      adapter.emitToolCall("tool_call_update", "bash-short", "completed");
      completedAt = Date.now();
      await run;
      const elapsed = Date.now() - completedAt;
      assert.ok(
        elapsed >= windowMs - 50,
        `fired ${elapsed}ms after the tool completed — before a full silence window`,
      );
    });

    const injected = terminalFor(await streamEvents(record.acpxRecordId), INJECTED_ID);
    assert.equal(injected?.phase, "failed");
    assert.equal(
      (injected?.error as { detailCode?: string } | undefined)?.detailCode,
      "INJECTED_RESPONSE_TIMEOUT",
    );
  });
});

// --- (2) at most ONE live agent turn per session ---------------------------

async function backstoppedTurnThenNextTurn(adapter: AdapterControl): Promise<{
  secondCall: PromptCall | undefined;
  secondTerminal: Record<string, unknown> | undefined;
}> {
  let secondTerminal: Record<string, unknown> | undefined;
  await withTempHome("acpx-7531ef5c-two-", async (home) => {
    const record = sessionRecord(home);
    await writeSessionRecordFile(home, record);
    await withDrainTimeout(200, async () => {
      // Turn 1 is finalized by the backstop while its injected prompt is still
      // running on the adapter — a genuinely stalled agent (te-7531 S5: Claude
      // Code waiting on a slow / retrying API between tool calls).
      await (
        await startTurnWithInjection(record.acpxRecordId, adapter)
      ).run;
      assert.equal(adapter.inFlight(), 1, "turn 1's injected prompt is still live on the adapter");
      // The next delivered message, on the SAME shared client.
      await runQueuedTask(
        record.acpxRecordId,
        queueTask("req-second", SECOND_PROMPT_TEXT, SECOND_ID, true),
        { sharedClient: adapter.client, suppressSdkConsoleErrors: true },
      );
    });
    secondTerminal = terminalFor(await streamEvents(record.acpxRecordId), SECOND_ID);
  });
  return {
    secondCall: adapter.calls.find((call) => call.text === SECOND_PROMPT_TEXT),
    secondTerminal,
  };
}

// B1 (te-7531 round 2, BLOCKING on 7ec48822): on the SAME client there is no
// second loop to prevent — claude-agent-acp queues the new prompt behind the
// live one, and the baseline loses nothing. Cancelling there killed the old
// turn's remaining work and pinned its late `cancelled` on the NEW message.
test("7531ef5c B1: on the SAME client a live previous turn is LEFT RUNNING — the next message queues behind it, nothing cancelled", async () => {
  const adapter = makeAdapter({ honoursCancel: true });
  const { secondCall, secondTerminal } = await backstoppedTurnThenNextTurn(adapter);
  assert.ok(secondCall, "the next message reached the agent");
  // On 7ec48822: 1 cancel — the stalled turn's remaining work was killed.
  assert.equal(adapter.cancels(), 0, "the live previous turn was cancelled");
  assert.equal(adapter.closes(), 0, "the adapter was stopped");
  assert.equal(adapter.inFlight(), 1, "the previous turn is still running, as on the baseline");
  assert.equal(
    secondCall.inFlightAtStart,
    1,
    "the next prompt was queued beside it on ONE adapter",
  );
  assert.equal(secondTerminal?.phase, "done", `next delivery: ${JSON.stringify(secondTerminal)}`);
  adapter.resolveInjected();
});

// The two-loop defect needs a FRESH client (subscription switch / failover).
// The unit harness cannot drive a real switch, so the guard's fresh-client branch
// is pinned directly: the next turn's client is a different object.
test("7531ef5c: before a turn on a DIFFERENT client, a live previous turn on the shared client is cancelled first", async () => {
  const previous = makeAdapter({ honoursCancel: true });
  const next = makeAdapter({ honoursCancel: true });
  await withTempHome("acpx-7531ef5c-fresh-", async (home) => {
    const record = sessionRecord(home);
    await writeSessionRecordFile(home, record);
    await withDrainTimeout(200, async () => {
      await (
        await startTurnWithInjection(record.acpxRecordId, previous)
      ).run;
    });
  });
  assert.equal(previous.inFlight(), 1, "the previous turn is live");
  await endPreviousLiveTurn(previous.client, next.client, "single-live-turn");
  assert.equal(previous.cancels(), 1, "the live turn was cancelled");
  assert.equal(previous.closes(), 0, "a turn that honours cancel keeps its adapter");
  assert.equal(previous.inFlight(), 0, "no live turn remains before the fresh client starts");
});

test("7531ef5c: before a turn on a DIFFERENT client, a previous turn that ignores cancel has its ADAPTER STOPPED", async () => {
  const previous = makeAdapter({ honoursCancel: false });
  const next = makeAdapter({ honoursCancel: true });
  await withTempHome("acpx-7531ef5c-fresh2-", async (home) => {
    const record = sessionRecord(home);
    await writeSessionRecordFile(home, record);
    await withDrainTimeout(200, async () => {
      await (
        await startTurnWithInjection(record.acpxRecordId, previous)
      ).run;
    });
  });
  await endPreviousLiveTurn(previous.client, next.client, "single-live-turn");
  assert.equal(previous.cancels(), 1);
  assert.equal(previous.closes(), 1, "the adapter running the unkillable turn was stopped");
  assert.equal(previous.inFlight(), 0);
});

// NEGATIVE CASE for the guard's PLACEMENT (round 2): a delivery that is then
// REFUSED must not touch a live previous turn. Round 1 ran the guard first thing
// in runQueuedTask, ahead of every refusal — it would cancel live work for a
// message that never ran, and it turned the Codex cap denial into
// QUEUE_RUNTIME_PROMPT_FAILED (codex-subscription-cap.test.ts).
test("7531ef5c: a REFUSED delivery (closed session) leaves a live previous turn running — nothing cancelled or stopped", async () => {
  await withTempHome("acpx-7531ef5c-refused-", async (home) => {
    const record = sessionRecord(home);
    await writeSessionRecordFile(home, record);
    const adapter = makeAdapter({ honoursCancel: true });
    await withDrainTimeout(200, async () => {
      await (
        await startTurnWithInjection(record.acpxRecordId, adapter)
      ).run;
      assert.equal(adapter.inFlight(), 1, "turn 1's injected prompt is still live on the adapter");
      // The user closes the session; the next delivery is refused before any turn.
      await writeSessionRecordFile(home, {
        ...record,
        closed: true,
        closedAt: new Date().toISOString(),
      });
      await runQueuedTask(
        record.acpxRecordId,
        queueTask("req-refused", SECOND_PROMPT_TEXT, SECOND_ID, false),
        { sharedClient: adapter.client, suppressSdkConsoleErrors: true },
      );
    });
    assert.equal(adapter.cancels(), 0, "a refused delivery cancelled the live turn");
    assert.equal(adapter.closes(), 0, "a refused delivery stopped the live adapter");
    assert.equal(adapter.inFlight(), 1, "the live turn is untouched");
    assert.ok(
      !adapter.calls.some((call) => call.text === SECOND_PROMPT_TEXT),
      "the refused message never reached the agent",
    );
    adapter.resolveInjected();
  });
});

// NEGATIVE CASE: an idle shared client is left alone — the guard must not
// cancel or restart an adapter that has no turn running.
test("7531ef5c CONTROL: with no live previous turn, the next turn neither cancels nor stops anything", async () => {
  await withTempHome("acpx-7531ef5c-idle-", async (home) => {
    const record = sessionRecord(home);
    await writeSessionRecordFile(home, record);
    const adapter = makeAdapter({ honoursCancel: true });
    await runQueuedTask(
      record.acpxRecordId,
      queueTask("req-second", SECOND_PROMPT_TEXT, SECOND_ID, true),
      { sharedClient: adapter.client, suppressSdkConsoleErrors: true },
    );
    assert.equal(adapter.calls.length, 1);
    assert.equal(adapter.cancels(), 0);
    assert.equal(adapter.closes(), 0);
  });
});
