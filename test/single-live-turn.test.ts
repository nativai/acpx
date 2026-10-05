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
import { runQueuedTask } from "../src/cli/session/runtime.js";
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

type Handlers = { onAcpMessage?: (direction: unknown, message: unknown) => void };

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

// --- (2) at most ONE live agent turn per session ---------------------------

async function backstoppedTurnThenNextTurn(adapter: AdapterControl): Promise<{
  secondCall: PromptCall | undefined;
  sessionId: string;
}> {
  let sessionId = "";
  await withTempHome("acpx-7531ef5c-two-", async (home) => {
    const record = sessionRecord(home);
    sessionId = record.acpxRecordId;
    await writeSessionRecordFile(home, record);
    await withDrainTimeout(200, async () => {
      // Turn 1 is finalized by the backstop while its injected prompt is still
      // running on the adapter — the state lane A's owner was in at 13:23:54Z.
      await (
        await startTurnWithInjection(record.acpxRecordId, adapter)
      ).run;
      assert.equal(adapter.inFlight(), 1, "turn 1's injected prompt is still live on the adapter");
      // The next delivered message.
      await runQueuedTask(
        record.acpxRecordId,
        queueTask("req-second", SECOND_PROMPT_TEXT, SECOND_ID, true),
        { sharedClient: adapter.client, suppressSdkConsoleErrors: true },
      );
    });
  });
  return {
    secondCall: adapter.calls.find((call) => call.text === SECOND_PROMPT_TEXT),
    sessionId,
  };
}

test("7531ef5c: the next turn first ENDS a still-live previous turn — never two prompts running in one agent", async () => {
  const adapter = makeAdapter({ honoursCancel: true });
  const { secondCall } = await backstoppedTurnThenNextTurn(adapter);
  assert.ok(secondCall, "the next turn ran");
  // On the unrepaired base: 1 — turn 1's injected prompt was still running.
  assert.equal(secondCall.inFlightAtStart, 0, "a previous turn was still live when the next began");
  assert.equal(adapter.cancels(), 1, "the live turn was cancelled first");
  assert.equal(adapter.closes(), 0, "a turn that honours cancel keeps its adapter");
});

test("7531ef5c: a previous turn that ignores cancel has its ADAPTER STOPPED before the next turn starts", async () => {
  const adapter = makeAdapter({ honoursCancel: false });
  const { secondCall } = await backstoppedTurnThenNextTurn(adapter);
  assert.ok(secondCall, "the next turn ran");
  assert.equal(secondCall.inFlightAtStart, 0, "a previous turn was still live when the next began");
  assert.equal(adapter.cancels(), 1);
  assert.equal(adapter.closes(), 1, "the adapter running the unkillable turn was stopped");
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
