// brick 570d2570 — a main turn cut by a session close gets an honest delivery terminal.
//
// The real `runQueuedTask` -> `runSessionPrompt` runtime against the scripted Claude adapter
// (test/pathological-adapter-helpers.ts), beside a REAL `SessionQueueOwner` for the same session: the
// close's owner-facing step is the owner's own `drainDeliveries("session-close")`, and the kill is the
// owner's own signal-path sweep `terminalizeCustodyOnSignal()` — the method the SIGTERM handler calls
// (`installQueueOwnerFatalSignalHandlers`). Only the SIGTERM itself is not sent: it would end the test
// process. test/cli.test.ts drives the whole `sessions close` verb, final SIGTERM included.
//
// Every row PINS the state it measures before it closes — the main prompt withheld, or resolved while an
// injected prompt holds the runtime — so no row races the close against the runtime.

import assert from "node:assert/strict";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import {
  SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE,
  SESSION_CLOSED_TURN_CANCELLED_MESSAGE,
  TURN_WATCHDOG_CANCELLED_DETAIL_CODE,
} from "../src/cli/queue/delivery-terminals.js";
import {
  type QueueOwnerControlHandlers,
  type QueueTask,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { resetSessionCloseIntentForTests } from "../src/cli/queue/session-close-intent.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { textPrompt } from "../src/prompt-content.js";
import type { DepthProjection } from "../src/session/depth-projection.js";
import { listSessionEvents } from "../src/session/events.js";
import type { SessionNotification, SessionRecord } from "../src/types.js";
import {
  CLAUDE_AGENT_COMMAND,
  cancelResolvesPrompt,
  createDeferred,
  emitClaudeTurnEnd,
  INJECTED_PROMPT_TEXT,
  MAIN_PROMPT_TEXT,
  makePathologicalClient,
  type PathologicalControl,
  type PromptResponse,
} from "./pathological-adapter-helpers.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

// A healthy turn here finishes in milliseconds and a wrong one hangs forever, so the deadline sits far
// above box noise (the sibling watchdog rows measured several seconds each at load ~80, 2026-10-09).
const MUST_FINISH_MS = 30_000;

type DeliveryParams = {
  messageId?: string;
  phase?: string;
  stopReason?: string | null;
  error?: { message?: string; detailCode?: string };
};

type Rig = {
  record: SessionRecord;
  control: PathologicalControl;
  owner: SessionQueueOwner;
  run: Promise<void>;
  /** The mid-turn handler the runtime registered for the main attempt. */
  inject: (task: QueueTask) => void;
};

function stubControlHandlers(): QueueOwnerControlHandlers {
  return {
    cancelPrompt: async () => false,
    closeSession: async () => true,
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }) as SetSessionConfigOptionResponse,
    setDepth: async (requested: string): Promise<DepthProjection> => ({
      kind: "send-nothing",
      requested,
    }),
    queryActiveTurn: () => true,
  };
}

function makeTask(params: {
  requestId: string;
  messageId: string;
  text: string;
  waitForCompletion: boolean;
}): QueueTask {
  return {
    requestId: params.requestId,
    messageId: params.messageId,
    message: params.text,
    prompt: textPrompt(params.text),
    permissionMode: "approve-all",
    timeoutMs: 10_000,
    waitForCompletion: params.waitForCompletion,
    enqueuedAt: Date.now(),
    send: (_message: QueueOwnerMessage) => {},
    close: () => {},
  } satisfies QueueTask;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/** Every non-`accepted` delivery event for `messageId`, in stream order. */
async function terminalsFor(record: SessionRecord, messageId: string): Promise<DeliveryParams[]> {
  const events = (await listSessionEvents(record.acpxRecordId)) as Array<{
    method?: string;
    params?: DeliveryParams;
  }>;
  return events
    .filter((event) => event.method === "acpx/delivery")
    .map((event) => event.params ?? {})
    .filter((params) => params.messageId === messageId && params.phase !== "accepted");
}

function assertCloseCut(terminals: DeliveryParams[], what: string): void {
  assert.equal(terminals.length, 1, `${what}: exactly one delivery terminal`);
  const [terminal] = terminals;
  assert.equal(terminal?.phase, "failed", `${what}: phase`);
  assert.equal(
    terminal?.error?.detailCode,
    SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE,
    `${what}: code`,
  );
  assert.equal(terminal?.error?.message, SESSION_CLOSED_TURN_CANCELLED_MESSAGE, `${what}: message`);
}

/**
 * One Claude main turn (delivery `mainMessageId`) in flight against the scripted adapter, plus a real
 * queue owner for the same session. `body` runs once the main prompt is in flight; the rig waits for the
 * run to finish afterwards and closes the owner.
 */
async function withMainTurn(
  params: {
    sessionId: string;
    mainMessageId: string;
    watchdogTimeoutMs?: number;
    onInjectedPrompt?: (messageId?: string) => Promise<PromptResponse>;
  },
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  await withTempHome("acpx-close-cut-main-turn-", async (homeDir) => {
    const record = makeSessionRecord({
      acpxRecordId: params.sessionId,
      acpSessionId: `${params.sessionId}-acp`,
      agentCommand: CLAUDE_AGENT_COMMAND,
      cwd: homeDir,
    });
    await writeSessionRecordFile(homeDir, record);
    const lease = await tryAcquireQueueOwnerLease(record.acpxRecordId);
    assert(lease, "expected to acquire a queue-owner lease");
    const owner = await SessionQueueOwner.start(lease, stubControlHandlers(), {
      maxQueueDepth: 8,
    });
    const control = makePathologicalClient({
      acpSessionId: record.acpSessionId,
      ...(params.onInjectedPrompt ? { onInjectedPrompt: params.onInjectedPrompt } : {}),
    });
    let midTurnHandler: ((task: QueueTask) => void) | undefined;
    const mainTask = makeTask({
      requestId: `req-${params.mainMessageId}`,
      messageId: params.mainMessageId,
      text: MAIN_PROMPT_TEXT,
      waitForCompletion: false,
    });
    const run = withTurnResponseTimeout(params.watchdogTimeoutMs ?? 60_000, () =>
      runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        suppressSdkConsoleErrors: true,
        setMidTurnHandler: (handler) => {
          if (handler) {
            midTurnHandler = handler;
          }
        },
      }),
    );
    try {
      await control.mainPromptInFlight;
      await sleep(0);
      await body({
        record,
        control,
        owner,
        run,
        inject: (task) => {
          assert.ok(midTurnHandler, "the runtime registered its mid-turn handler");
          midTurnHandler(task);
        },
      });
      await withRaceTimeout(run, MUST_FINISH_MS, "the turn never finished");
    } finally {
      await owner.close();
      resetSessionCloseIntentForTests();
    }
  });
}

async function drainForClose(owner: SessionQueueOwner): Promise<void> {
  // timeout 0: the close's drain never waits here — the state is already pinned.
  await owner.drainDeliveries("session-close", 0);
}

function agentMessageChunk(acpSessionId: string, text: string): SessionNotification {
  return {
    sessionId: acpSessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  } as unknown as SessionNotification;
}

// --- the defect ----------------------------------------------------------------------------------

// THE SHAPE FROM THE EVIDENCE (a147982f VERIFICATION "HoD addition to AC7 (c)"): the main turn is
// mid-tool, the close drains and kills the owner, and the adapter has not answered the prompt. Before
// the fix the sweep wrote nothing for the main delivery — it stayed `accepted` and acpx-ui read it
// done/delivered. The adapter's late `cancelled` (what session/close produces) must not add a second.
test("570d2570: the signal sweep after a close drain gives the cut main turn failed/SESSION_CLOSED_TURN_CANCELLED", async () => {
  const mainMessageId = "57000001-0000-4000-8000-000000000001";
  await withMainTurn({ sessionId: "close-cut-main-1", mainMessageId }, async (rig) => {
    await drainForClose(rig.owner);
    const written = rig.owner.terminalizeCustodyOnSignal();
    assertCloseCut(await terminalsFor(rig.record, mainMessageId), "at the kill");
    assert.equal(written, 1, "the sweep reports the one terminal it wrote");
    // The adapter answers the close's cancel; in production the owner is already gone.
    rig.control.resolveMainPrompt({ stopReason: "cancelled" });
    await withRaceTimeout(rig.run, MUST_FINISH_MS, "the turn never finished");
    assertCloseCut(await terminalsFor(rig.record, mainMessageId), "after the late cancel");
  });
});

// --- what must not change ------------------------------------------------------------------------

// HoD point 1: a turn that ENDED ON ITS OWN must never get the close's code. The main prompt resolved
// end_turn and the runtime is still in its post-resolution awaits (held here by an injected prompt, the
// production way: `drainInjectedPrompts` keeps the turn open while one is unsettled) when the kill lands.
// The sweep writes nothing; the turn's own `done` follows once the runtime finishes.
test("570d2570: a main turn that resolved on its own before the kill never gets the close's code", async () => {
  const mainMessageId = "57000002-0000-4000-8000-000000000002";
  const injectedMessageId = "57000002-0000-4000-8000-0000000000aa";
  const injected = createDeferred<PromptResponse>();
  const injectedInFlight = createDeferred<void>();
  await withMainTurn(
    {
      sessionId: "close-cut-main-2",
      mainMessageId,
      onInjectedPrompt: async () => {
        injectedInFlight.resolve();
        return await injected.promise;
      },
    },
    async (rig) => {
      rig.inject(
        makeTask({
          requestId: "req-injected-2",
          messageId: injectedMessageId,
          text: INJECTED_PROMPT_TEXT,
          waitForCompletion: false,
        }),
      );
      await injectedInFlight.promise;
      rig.control.resolveMainPrompt({ stopReason: "end_turn" });
      // Let the resolution reach the runtime; it then parks in `drainInjectedPrompts` on the injected
      // prompt, which is a state, not a window — the sleep only has to outlast a microtask chain.
      await sleep(100);
      assert.deepEqual(
        await terminalsFor(rig.record, mainMessageId),
        [],
        "parked: no terminal yet",
      );
      await drainForClose(rig.owner);
      assert.equal(rig.owner.terminalizeCustodyOnSignal(), 0, "the sweep wrote nothing");
      assert.deepEqual(
        await terminalsFor(rig.record, mainMessageId),
        [],
        "no close code for a turn that ended on its own",
      );
      injected.resolve({ stopReason: "end_turn" });
      await withRaceTimeout(rig.run, MUST_FINISH_MS, "the turn never finished");
      const terminals = await terminalsFor(rig.record, mainMessageId);
      assert.equal(terminals.length, 1, "exactly one terminal: the turn's own");
      assert.equal(terminals[0]?.phase, "done");
      assert.equal(terminals[0]?.stopReason, "end_turn");
    },
  );
});

// The injected-message path is unchanged: the sweep never touches an injected delivery, and the
// adapter's `cancelled` for it still becomes the runtime's own failed/SESSION_CLOSED_TURN_CANCELLED
// (71fdcaf2) — the line the evidence showed working before this brick (ead85d8e L31).
test("570d2570: the injected delivery still gets its own close terminal, untouched by the sweep", async () => {
  const mainMessageId = "57000003-0000-4000-8000-000000000003";
  const injectedMessageId = "57000003-0000-4000-8000-0000000000bb";
  const injected = createDeferred<PromptResponse>();
  const injectedInFlight = createDeferred<void>();
  await withMainTurn(
    {
      sessionId: "close-cut-main-3",
      mainMessageId,
      onInjectedPrompt: async () => {
        injectedInFlight.resolve();
        return await injected.promise;
      },
    },
    async (rig) => {
      rig.inject(
        makeTask({
          requestId: "req-injected-3",
          messageId: injectedMessageId,
          text: INJECTED_PROMPT_TEXT,
          waitForCompletion: false,
        }),
      );
      await injectedInFlight.promise;
      await drainForClose(rig.owner);
      rig.owner.terminalizeCustodyOnSignal();
      assert.deepEqual(
        await terminalsFor(rig.record, injectedMessageId),
        [],
        "the sweep wrote nothing for the injected delivery",
      );
      // session/close cancels both prompts (claude-agent-acp `cancel`).
      injected.resolve({ stopReason: "cancelled" });
      rig.control.resolveMainPrompt({ stopReason: "cancelled" });
      await withRaceTimeout(rig.run, MUST_FINISH_MS, "the turn never finished");
      assertCloseCut(await terminalsFor(rig.record, injectedMessageId), "injected");
      assertCloseCut(await terminalsFor(rig.record, mainMessageId), "main");
    },
  );
});

// An idle close invents nothing: the turn finished `done` before the close, so the sweep finds no open
// main delivery.
test("570d2570: a close after the turn finished writes no terminal for it", async () => {
  const mainMessageId = "57000004-0000-4000-8000-000000000004";
  await withMainTurn({ sessionId: "close-cut-main-4", mainMessageId }, async (rig) => {
    rig.control.resolveMainPrompt({ stopReason: "end_turn" });
    await withRaceTimeout(rig.run, MUST_FINISH_MS, "the turn never finished");
    await drainForClose(rig.owner);
    assert.equal(rig.owner.terminalizeCustodyOnSignal(), 0, "the sweep wrote nothing");
    const terminals = await terminalsFor(rig.record, mainMessageId);
    assert.equal(terminals.length, 1, "exactly one terminal: the turn's own");
    assert.equal(terminals[0]?.phase, "done");
  });
});

// The OwnerExitCause doctrine: an owner that was never told about a close (`--no-drain`, a pod
// SIGTERM, a force-restart) writes nothing for the main turn on its way out.
test("570d2570: without a close drain the signal sweep writes nothing for the main turn", async () => {
  const mainMessageId = "57000005-0000-4000-8000-000000000005";
  await withMainTurn({ sessionId: "close-cut-main-5", mainMessageId }, async (rig) => {
    assert.equal(rig.owner.terminalizeCustodyOnSignal(), 0, "the sweep wrote nothing");
    assert.deepEqual(await terminalsFor(rig.record, mainMessageId), []);
    rig.control.resolveMainPrompt({ stopReason: "end_turn" });
  });
});

// --- the watchdog: one terminal, and the close's -----------------------------------------------

// The watchdog is armed (attributed sdk_idle + completing) and the agent kept producing output after
// the signal, so a tier-1 cancel would be a CUT. The close kills the owner FIRST: the sweep writes the
// close's code, and the runtime's later cut (TURN_WATCHDOG_CANCELLED, mapped or not) adds nothing.
test("570d2570: a close during a watchdog-armed turn, sweep first, then the watchdog's cut — one terminal, the close's", async () => {
  const mainMessageId = "57000006-0000-4000-8000-000000000006";
  await withMainTurn(
    { sessionId: "close-cut-main-6", mainMessageId, watchdogTimeoutMs: 400 },
    async (rig) => {
      cancelResolvesPrompt(rig.control, "cancelled");
      emitClaudeTurnEnd(rig.control, "lifecycle");
      rig.control.emitSessionUpdate(agentMessageChunk(rig.record.acpSessionId, "still working"));
      await drainForClose(rig.owner);
      rig.owner.terminalizeCustodyOnSignal();
      assertCloseCut(await terminalsFor(rig.record, mainMessageId), "at the kill");
      await withRaceTimeout(rig.run, MUST_FINISH_MS, "the turn never finished");
      assert.ok(rig.control.cancelCount() > 0, "the watchdog's tier-1 cancel fired after the kill");
      const terminals = await terminalsFor(rig.record, mainMessageId);
      assertCloseCut(terminals, "after the watchdog's cut");
      assert.ok(
        terminals.every(
          (terminal) => terminal.error?.detailCode !== TURN_WATCHDOG_CANCELLED_DETAIL_CODE,
        ),
        "no TURN_WATCHDOG_CANCELLED terminal",
      );
    },
  );
});

// The other order: the watchdog cuts DURING the close drain, so the runtime's choke point writes the
// close's code itself (a147982f); the sweep at the kill then adds nothing.
test("570d2570: a close during a watchdog-armed turn, watchdog's cut first, then the sweep — one terminal, the close's", async () => {
  const mainMessageId = "57000007-0000-4000-8000-000000000007";
  await withMainTurn(
    { sessionId: "close-cut-main-7", mainMessageId, watchdogTimeoutMs: 60 },
    async (rig) => {
      cancelResolvesPrompt(rig.control, "cancelled");
      await drainForClose(rig.owner);
      emitClaudeTurnEnd(rig.control, "lifecycle");
      rig.control.emitSessionUpdate(agentMessageChunk(rig.record.acpSessionId, "still working"));
      await withRaceTimeout(rig.run, MUST_FINISH_MS, "the turn never finished");
      assert.ok(rig.control.cancelCount() > 0, "the watchdog's tier-1 cancel fired");
      assert.equal(rig.owner.terminalizeCustodyOnSignal(), 0, "the sweep wrote nothing");
      assertCloseCut(await terminalsFor(rig.record, mainMessageId), "after the kill");
    },
  );
});
