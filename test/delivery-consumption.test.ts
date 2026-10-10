// brick e09628a1 — R-CONSUMED: a Codex message the model CONSUMED before its turn was cut is written `done /
// consumed_before_cut` (+ a non-failing note keeping the cut's code), never the outcome-unknown failure.
//
// Three layers:
//   1. THE CONTRACT — `test/fixtures/delivery-consumption.fixture.json`, vendored byte-identically into
//      acpx-ui. Every vector is fed frame by frame through `ConsumptionTracker`; acpx-ui runs the same vectors
//      in batch. Expectations are READ FROM THE FIXTURE, never re-typed.
//   2. THE POLICY — `consumedCutNote`: a steer flips on every cut, a main prompt only on a close.
//   3. THE WIRING — the real `runQueuedTask` -> `runSessionPrompt` runtime against the scripted adapter
//      (`pathological-adapter-helpers.ts`) under the REAL codex-acp command line, beside a real
//      `SessionQueueOwner`: the inbound wire tap, the choke point, the owner-exit sweep and the close sweep.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { injectionAbsorbsIntoActiveTurn } from "../src/acp/mid-turn-injection-support.js";
import {
  ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE,
  CONSUMED_BEFORE_CUT_NOTE,
  CONSUMED_CUT_BY_CANCEL,
  CONSUMED_CUT_BY_OWNER_EXIT,
  CONSUMED_CUT_BY_SESSION_CLOSE,
  CONSUMED_CUT_BY_TURN_ERROR,
  consumedCutNote,
  SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE,
  TURN_WATCHDOG_CANCELLED_DETAIL_CODE,
} from "../src/cli/queue/delivery-terminals.js";
import {
  type QueueOwnerControlHandlers,
  type QueueTask,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import {
  type OpenMainTurnDelivery,
  registerOpenMainTurnDelivery,
  unregisterOpenMainTurnDelivery,
} from "../src/cli/queue/main-turn-delivery.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { resetSessionCloseIntentForTests } from "../src/cli/queue/session-close-intent.js";
import { terminalizeAbsorbedDeliveriesOnOwnerExit } from "../src/cli/session/absorbed-delivery-registry.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { AgentDisconnectedError } from "../src/errors.js";
import { textPrompt } from "../src/prompt-content.js";
import {
  CONSUMED_BEFORE_CUT,
  CONSUMED_BEFORE_CUT_BACKFILL,
  CONSUMED_BEFORE_CUT_INFERRED,
  CONSUMPTION_NEED,
  SYNTHESIZED_TEXT_PREFIXES,
  type ConsumptionKind,
  ConsumptionTracker,
  classifyConsumptionFrame,
} from "../src/session/delivery-consumption.js";
import { isGenuineCompletionStopReason } from "../src/session/delivery-events.js";
import type { DepthProjection } from "../src/session/depth-projection.js";
import { listSessionEvents } from "../src/session/events.js";
import type { SessionNotification, SessionRecord } from "../src/types.js";
import {
  CLAUDE_AGENT_COMMAND,
  CODEX_AGENT_COMMAND,
  INJECTED_PROMPT_TEXT,
  MAIN_PROMPT_TEXT,
  makePathologicalClient,
  type PathologicalControl,
  type PromptResponse,
} from "./pathological-adapter-helpers.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

// ---------------------------------------------------------------------------------------------------------
// 1. The contract
// ---------------------------------------------------------------------------------------------------------

// Over the FILE BYTES. acpx-ui asserts the same value over its vendored copy.
const CONSUMPTION_FIXTURE_SHA256 =
  "a5e6db38ddfa1eef86d9350b3413c40ccbd0263284c2bcfc15cdd21c0bc5ad80";

type Vector = {
  id: string;
  about: string;
  agentCommand: string;
  target: string;
  expected:
    | { applicable: false }
    | {
        applicable: true;
        kind: ConsumptionKind;
        consumed: boolean;
        counted?: number;
        completionCount?: number;
      };
  frames: Array<{ src: string; frame: unknown }>;
};

type ConsumptionFixture = {
  classification: {
    outputSessionUpdates: string[];
    excludedTextPrefixes: string[];
    completionSessionUpdate: string;
    completionMetaKey: string;
    terminalDeliveryPhases: string[];
  };
  need: { steer: number; main: number };
  stopReasons: { owner: string; inferred: string; backfill: string };
  note: { prefix: string; forbiddenSubstringsLowercased: string[] };
  adapterCommands: Array<{ agentCommand: string; applies: boolean }>;
  vectors: Vector[];
};

const fixtureBytes = fs.readFileSync(
  path.resolve(process.cwd(), "test/fixtures/delivery-consumption.fixture.json"),
);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as ConsumptionFixture;

test("e09628a1: the consumption fixture is the canonical bytes acpx-ui vendors", () => {
  assert.equal(
    crypto.createHash("sha256").update(fixtureBytes).digest("hex"),
    CONSUMPTION_FIXTURE_SHA256,
  );
});

test("e09628a1: stopReasons, note prefix, need and the compaction text are the fixture's", () => {
  assert.equal(CONSUMED_BEFORE_CUT, fixture.stopReasons.owner);
  assert.equal(CONSUMED_BEFORE_CUT_INFERRED, fixture.stopReasons.inferred);
  assert.equal(CONSUMED_BEFORE_CUT_BACKFILL, fixture.stopReasons.backfill);
  assert.equal(CONSUMED_BEFORE_CUT_NOTE, fixture.note.prefix);
  assert.deepEqual({ ...CONSUMPTION_NEED }, fixture.need);
  assert.deepEqual([...SYNTHESIZED_TEXT_PREFIXES], fixture.classification.excludedTextPrefixes);
  // None of them is a genuine completion: no zero-output warning on a consumed-at-cut done.
  for (const stopReason of [
    CONSUMED_BEFORE_CUT,
    CONSUMED_BEFORE_CUT_INFERRED,
    CONSUMED_BEFORE_CUT_BACKFILL,
  ]) {
    assert.equal(isGenuineCompletionStopReason(stopReason), false, stopReason);
  }
});

test("e09628a1: no note text acpx emits contains a substring acpx-ui reads as a close", () => {
  const texts = [
    CONSUMED_BEFORE_CUT_NOTE,
    CONSUMED_CUT_BY_OWNER_EXIT,
    CONSUMED_CUT_BY_SESSION_CLOSE,
    CONSUMED_CUT_BY_CANCEL,
    CONSUMED_CUT_BY_TURN_ERROR,
  ];
  for (const text of texts) {
    for (const forbidden of fixture.note.forbiddenSubstringsLowercased) {
      assert.ok(!text.toLowerCase().includes(forbidden), `${text} contains ${forbidden}`);
    }
  }
});

test("e09628a1: frame classification follows the fixture table — tool progress is never output", () => {
  const update = (sessionUpdate: string, extra: Record<string, unknown> = {}) => ({
    method: "session/update",
    params: { update: { sessionUpdate, ...extra } },
  });
  for (const kind of fixture.classification.outputSessionUpdates) {
    assert.equal(
      classifyConsumptionFrame(update(kind, { content: { type: "text", text: "x" } })),
      "output",
    );
  }
  for (const kind of ["agent_message_chunk", "agent_thought_chunk"]) {
    for (const prefix of fixture.classification.excludedTextPrefixes) {
      assert.equal(
        classifyConsumptionFrame(
          update(kind, { content: { type: "text", text: `${prefix}tail` } }),
        ),
        "other",
        `${kind} ${prefix}`,
      );
    }
  }
  // Matched at the START only: model text that merely CONTAINS a notice word is output.
  assert.equal(
    classifyConsumptionFrame(
      update("agent_message_chunk", {
        content: { type: "text", text: "I saw a Warning: in the log" },
      }),
    ),
    "output",
  );
  assert.equal(
    classifyConsumptionFrame(update("tool_call_update", { status: "completed" })),
    "other",
  );
  assert.equal(
    classifyConsumptionFrame(
      update(fixture.classification.completionSessionUpdate, {
        _meta: { [fixture.classification.completionMetaKey]: { unit: {} } },
      }),
    ),
    "completion",
  );
  assert.equal(classifyConsumptionFrame(update("usage_update", { used: 1, size: 2 })), "other");
});

test("e09628a1: the rule runs only where the adapter gate says, on the fixture's REAL agent commands", () => {
  for (const row of fixture.adapterCommands) {
    assert.equal(injectionAbsorbsIntoActiveTurn(row.agentCommand), row.applies, row.agentCommand);
  }
});

// The acpx side of a vector: register the target at its own prompt frame (as the runtime does just before it
// sends the prompt), observe every other frame, and stop at the target's first terminal — which can be written
// BEFORE its prompt frame (N9), leaving it never registered.
function runVector(vector: Vector & { expected: { applicable: true; kind: ConsumptionKind } }) {
  const tracker = new ConsumptionTracker();
  const terminalPhases = new Set(fixture.classification.terminalDeliveryPhases);
  for (const { frame } of vector.frames) {
    const message = frame as { method?: string; params?: { messageId?: string; phase?: string } };
    if (message.method === "acpx/delivery" && message.params?.messageId === vector.target) {
      if (terminalPhases.has(message.params.phase ?? "")) {
        break;
      }
      continue;
    }
    if (message.method === "session/prompt" && message.params?.messageId === vector.target) {
      tracker.register(vector.target, vector.expected.kind);
      continue;
    }
    tracker.observe(frame);
  }
  return {
    consumed: tracker.isConsumed(vector.target),
    evidence: tracker.evidence(vector.target) ?? {
      kind: vector.expected.kind,
      counted: 0,
      need: CONSUMPTION_NEED[vector.expected.kind],
      completionCount: 0,
    },
  };
}

for (const vector of fixture.vectors) {
  test(`e09628a1: fixture vector ${vector.id}: ${vector.about}`, () => {
    if (!vector.expected.applicable) {
      assert.equal(injectionAbsorbsIntoActiveTurn(vector.agentCommand), false);
      return;
    }
    assert.equal(injectionAbsorbsIntoActiveTurn(vector.agentCommand), true);
    const expected = vector.expected;
    const { consumed, evidence } = runVector({ ...vector, expected });
    assert.equal(consumed, expected.consumed);
    assert.equal(evidence.need, fixture.need[expected.kind]);
    if (expected.counted !== undefined) {
      assert.equal(evidence.counted, expected.counted);
    }
    if (expected.completionCount !== undefined) {
      assert.equal(evidence.completionCount, expected.completionCount);
    }
  });
}

test("e09628a1: the tracker fires onConsumed once, at the flip, and a re-registration keeps the first count", () => {
  const flips: string[] = [];
  const tracker = new ConsumptionTracker({ onConsumed: (id) => flips.push(id) });
  const out = { method: "session/update", params: { update: { sessionUpdate: "tool_call" } } };
  const done = {
    method: "session/update",
    params: { update: { sessionUpdate: "usage_update", _meta: { acpxUsage: {} } } },
  };
  tracker.register("s", "steer");
  tracker.observe(out);
  tracker.observe(done);
  tracker.register("s", "steer");
  assert.equal(tracker.isConsumed("s"), false);
  tracker.observe(out);
  tracker.observe(done);
  tracker.observe(out);
  tracker.observe(done);
  assert.deepEqual(flips, ["s"]);
  assert.equal(tracker.evidence("s")?.counted, 3);
  tracker.release("s");
  assert.equal(tracker.isConsumed("s"), false);
});

// ---------------------------------------------------------------------------------------------------------
// 2. The policy
// ---------------------------------------------------------------------------------------------------------

test("e09628a1: consumedCutNote — a steer flips on every cut, a main only on a close (CONCEPTION §5.2)", () => {
  const disconnected = {
    code: 0,
    message: "ACP agent disconnected",
    detailCode: "AGENT_DISCONNECTED",
  };
  const watchdog = {
    code: 0,
    message: "watchdog",
    detailCode: TURN_WATCHDOG_CANCELLED_DETAIL_CODE,
  };
  const note = (input: Parameters<typeof consumedCutNote>[0]) => consumedCutNote(input);

  // U6: a consumed steer cut by a turn error → done, the error's code kept.
  assert.deepEqual(
    note({
      kind: "steer",
      consumed: true,
      phase: "failed",
      error: disconnected,
      closeDrainActive: false,
    }),
    {
      code: 0,
      message: `${CONSUMED_BEFORE_CUT_NOTE}: ${CONSUMED_CUT_BY_TURN_ERROR} (AGENT_DISCONNECTED)`,
      detailCode: "AGENT_DISCONNECTED",
    },
  );
  // a consumed steer cut by a Stop / watchdog cancel → done.
  assert.equal(
    note({ kind: "steer", consumed: true, phase: "cancelled", closeDrainActive: false })?.message,
    `${CONSUMED_BEFORE_CUT_NOTE}: ${CONSUMED_CUT_BY_CANCEL}`,
  );
  // U3: a consumed main cancelled during a close drain → done, the close's code kept.
  assert.deepEqual(
    note({ kind: "main", consumed: true, phase: "cancelled", closeDrainActive: true }),
    {
      code: 0,
      message: `${CONSUMED_BEFORE_CUT_NOTE}: ${CONSUMED_CUT_BY_SESSION_CLOSE}`,
      detailCode: SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE,
    },
  );
  // U4: a consumed main cut by a turn error with no close → unchanged.
  assert.equal(
    note({
      kind: "main",
      consumed: true,
      phase: "failed",
      error: disconnected,
      closeDrainActive: false,
    }),
    undefined,
  );
  // U5: a consumed main cut by the watchdog with no close → unchanged.
  assert.equal(
    note({
      kind: "main",
      consumed: true,
      phase: "failed",
      error: watchdog,
      closeDrainActive: false,
    }),
    undefined,
  );
  // not consumed → unchanged, whatever the cut.
  assert.equal(
    note({ kind: "steer", consumed: false, phase: "failed", closeDrainActive: true }),
    undefined,
  );
  // a normal end is the turn's own terminal, never relabelled (U10).
  assert.equal(
    note({ kind: "steer", consumed: true, phase: "done", closeDrainActive: false }),
    undefined,
  );
  // an untracked delivery (no tracker, a Claude/pi backend) → unchanged (U9).
  assert.equal(
    note({ kind: undefined, consumed: true, phase: "failed", closeDrainActive: true }),
    undefined,
  );
});

// ---------------------------------------------------------------------------------------------------------
// 3. The wiring
// ---------------------------------------------------------------------------------------------------------

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
  inject: (task: QueueTask) => void;
  /** One model step as codex-acp streams it: a tool call, then the request's completion frame. */
  step: () => void;
  completionOnly: () => void;
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

function makeTask(requestId: string, messageId: string, text: string): QueueTask {
  return {
    requestId,
    messageId,
    message: text,
    prompt: textPrompt(text),
    permissionMode: "approve-all",
    timeoutMs: 10_000,
    waitForCompletion: false,
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

function toolCall(acpSessionId: string, id: string): SessionNotification {
  return {
    sessionId: acpSessionId,
    update: { sessionUpdate: "tool_call", toolCallId: id, title: "exec", status: "in_progress" },
  } as unknown as SessionNotification;
}

function completion(acpSessionId: string): SessionNotification {
  return {
    sessionId: acpSessionId,
    update: {
      sessionUpdate: "usage_update",
      used: 1,
      size: 2,
      _meta: { acpxUsage: { unit: { model: "gpt-test", input: 1, output: 1 } } },
    },
  } as unknown as SessionNotification;
}

/**
 * One main turn (delivery `mainMessageId`) in flight against the scripted adapter, under a REAL agent command,
 * plus a real queue owner for the same session. The main prompt is withheld until the body settles it; every
 * injected (steer) prompt never answers, as codex-acp holds a steer's response until its turn completes.
 */
async function withMainTurn(
  params: { sessionId: string; mainMessageId: string; agentCommand?: string },
  body: (rig: Rig) => Promise<void>,
): Promise<void> {
  await withTempHome("acpx-delivery-consumption-", async (homeDir) => {
    const record = makeSessionRecord({
      acpxRecordId: params.sessionId,
      acpSessionId: `${params.sessionId}-acp`,
      agentCommand: params.agentCommand ?? CODEX_AGENT_COMMAND,
      cwd: homeDir,
    });
    // As the F1 rows in mid-turn-injection.test.ts do: the shared fixture's 1 KB segment makes concurrent
    // terminal writes race a rotation (a pre-existing SessionEventWriter hazard unrelated to this rule).
    record.eventLog.max_segment_bytes = 1_048_576;
    await writeSessionRecordFile(homeDir, record);
    const lease = await tryAcquireQueueOwnerLease(record.acpxRecordId);
    assert(lease, "expected to acquire a queue-owner lease");
    const owner = await SessionQueueOwner.start(lease, stubControlHandlers(), { maxQueueDepth: 8 });
    const control = makePathologicalClient({
      acpSessionId: record.acpSessionId,
      onInjectedPrompt: async () => await new Promise<PromptResponse>(() => {}),
    });
    let midTurnHandler: ((task: QueueTask) => void) | undefined;
    const run = runQueuedTask(
      record.acpxRecordId,
      makeTask(`req-${params.mainMessageId}`, params.mainMessageId, MAIN_PROMPT_TEXT),
      {
        sharedClient: control.client,
        suppressSdkConsoleErrors: true,
        setMidTurnHandler: (handler) => {
          if (handler) {
            midTurnHandler = handler;
          }
        },
      },
    );
    let toolIds = 0;
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
        step: () => {
          toolIds += 1;
          control.emitSessionUpdate(toolCall(record.acpSessionId, `exec-${toolIds}`));
          control.emitSessionUpdate(completion(record.acpSessionId));
        },
        completionOnly: () => control.emitSessionUpdate(completion(record.acpSessionId)),
      });
      await withRaceTimeout(run, MUST_FINISH_MS, "the turn never finished");
    } finally {
      await owner.close();
      resetSessionCloseIntentForTests();
    }
  });
}

async function injectSteer(rig: Rig, requestId: string, messageId: string): Promise<void> {
  rig.inject(makeTask(requestId, messageId, INJECTED_PROMPT_TEXT));
  // A STATE, not a window: the runtime registers the steer with its tracker immediately before it calls
  // `client.prompt`, so once the adapter has the prompt, every later frame counts for it.
  const deadline = Date.now() + MUST_FINISH_MS;
  while (
    !rig.control.promptCalls.some(
      (call) => call.kind === "injected" && call.messageId === messageId,
    )
  ) {
    assert.ok(Date.now() < deadline, `the steer ${messageId} never reached the adapter`);
    await sleep(5);
  }
  await sleep(0);
}

const STEER_A = "e0960001-0000-4000-8000-00000000000a";
const STEER_B = "e0960001-0000-4000-8000-00000000000b";

// U6 + U4 + the negative: a turn error (adapter disconnect) cuts one consumed and one unconsumed steer.
test("e09628a1 U6/U4: an adapter disconnect writes done/consumed_before_cut for the consumed steer only; the main stays failed", async () => {
  const mainMessageId = "e0960001-0000-4000-8000-000000000001";
  await withMainTurn({ sessionId: "consumption-u6", mainMessageId }, async (rig) => {
    rig.step(); // the main consumed (need 1)
    await injectSteer(rig, "req-a", STEER_A);
    rig.step(); // A: 1 (the in-flight request)
    rig.step(); // A: 2 → consumed
    await injectSteer(rig, "req-b", STEER_B);
    rig.step(); // B: 1 only
    // U11 / KD-10: consumption writes nothing mid-turn.
    assert.deepEqual(await terminalsFor(rig.record, STEER_A), [], "no terminal at consumption");
    rig.control.rejectMainPrompt(new AgentDisconnectedError("process exited", 1, null));
    await rig.run.catch(() => {});
    const [a] = await terminalsFor(rig.record, STEER_A);
    assert.equal(a?.phase, "done");
    assert.equal(a?.stopReason, CONSUMED_BEFORE_CUT);
    assert.equal(a?.error?.detailCode, "AGENT_DISCONNECTED");
    assert.ok(a?.error?.message?.startsWith(CONSUMED_BEFORE_CUT_NOTE));
    const [b] = await terminalsFor(rig.record, STEER_B);
    assert.equal(b?.phase, "failed", "a steer with one counted completion is cut");
    assert.equal(b?.error?.detailCode, "AGENT_DISCONNECTED");
    const [main] = await terminalsFor(rig.record, mainMessageId);
    assert.equal(main?.phase, "failed", "U4: a consumed MAIN cut by a crash keeps its failure");
    assert.equal(main?.error?.detailCode, "AGENT_DISCONNECTED");
  });
});

// U10: a consumed steer whose turn ends normally keeps today's `done / null`.
test("e09628a1 U10: a normal turn end writes done/stopReason:null for a consumed steer, never consumed_before_cut", async () => {
  const mainMessageId = "e0960002-0000-4000-8000-000000000001";
  await withMainTurn({ sessionId: "consumption-u10", mainMessageId }, async (rig) => {
    await injectSteer(rig, "req-a", STEER_A);
    rig.step();
    rig.step();
    rig.control.resolveMainPrompt({ stopReason: "end_turn" });
    await withRaceTimeout(rig.run, MUST_FINISH_MS, "the turn never finished");
    const terminals = await terminalsFor(rig.record, STEER_A);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.phase, "done");
    assert.equal(terminals[0]?.stopReason, null);
  });
});

// U1 + U2: the owner-exit sweep (graceful and SIGTERM paths share it) — synchronous writes.
test("e09628a1 U1/U2: the owner-exit sweep writes done/consumed_before_cut for a consumed steer, failed for a counted-1 one — synchronously", async () => {
  const mainMessageId = "e0960003-0000-4000-8000-000000000001";
  await withMainTurn({ sessionId: "consumption-u1", mainMessageId }, async (rig) => {
    await injectSteer(rig, "req-a", STEER_A);
    rig.step();
    rig.step();
    await injectSteer(rig, "req-b", STEER_B);
    rig.step();
    const sweep = terminalizeAbsorbedDeliveriesOnOwnerExit(rig.record.acpxRecordId);
    assert.deepEqual(sweep, { failed: 1, consumed: 1 });
    // No await between the sweep and the read: the writes are synchronous (they must survive SIGTERM).
    const a = await terminalsFor(rig.record, STEER_A);
    assert.equal(a.length, 1);
    assert.equal(a[0]?.phase, "done");
    assert.equal(a[0]?.stopReason, CONSUMED_BEFORE_CUT);
    assert.equal(a[0]?.error?.detailCode, ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE);
    assert.equal(
      a[0]?.error?.message,
      `${CONSUMED_BEFORE_CUT_NOTE}: ${CONSUMED_CUT_BY_OWNER_EXIT}`,
    );
    const b = await terminalsFor(rig.record, STEER_B);
    assert.equal(b[0]?.phase, "failed");
    assert.equal(b[0]?.error?.detailCode, ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE);
    rig.control.resolveMainPrompt({ stopReason: "end_turn" });
    await withRaceTimeout(rig.run, MUST_FINISH_MS, "the turn never finished");
    assert.equal(
      (await terminalsFor(rig.record, STEER_A)).length,
      1,
      "the sweep's terminal is the only one",
    );
  });
});

// U7: the close sweep for a consumed main cut by a session close.
test("e09628a1 U7: a close drain + kill writes done/consumed_before_cut for a CONSUMED main turn", async () => {
  const mainMessageId = "e0960004-0000-4000-8000-000000000001";
  await withMainTurn({ sessionId: "consumption-u7", mainMessageId }, async (rig) => {
    rig.step();
    await rig.owner.drainDeliveries("session-close", 0);
    assert.equal(rig.owner.terminalizeCustodyOnSignal(), 1);
    const at = await terminalsFor(rig.record, mainMessageId);
    assert.equal(at.length, 1);
    assert.equal(at[0]?.phase, "done");
    assert.equal(at[0]?.stopReason, CONSUMED_BEFORE_CUT);
    assert.equal(at[0]?.error?.detailCode, SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE);
    rig.control.resolveMainPrompt({ stopReason: "cancelled" });
    await withRaceTimeout(rig.run, MUST_FINISH_MS, "the turn never finished");
    assert.equal(
      (await terminalsFor(rig.record, mainMessageId)).length,
      1,
      "one terminal per delivery",
    );
  });
});

// U7 negative: an UNCONSUMED main cut by the same close keeps the close's code.
test("e09628a1 U7 negative: a close drain + kill of an UNCONSUMED main keeps failed/SESSION_CLOSED_TURN_CANCELLED", async () => {
  const mainMessageId = "e0960005-0000-4000-8000-000000000001";
  await withMainTurn({ sessionId: "consumption-u7n", mainMessageId }, async (rig) => {
    rig.completionOnly(); // a completion with no output since the prompt does not count
    await rig.owner.drainDeliveries("session-close", 0);
    rig.owner.terminalizeCustodyOnSignal();
    const [at] = await terminalsFor(rig.record, mainMessageId);
    assert.equal(at?.phase, "failed");
    assert.equal(at?.error?.detailCode, SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE);
    rig.control.resolveMainPrompt({ stopReason: "cancelled" });
  });
});

// U3: the choke point — the adapter answers the close's cancel before any kill.
test("e09628a1 U3: a close-drain cancel reaching the choke point writes done/consumed_before_cut for a consumed main and steer", async () => {
  const mainMessageId = "e0960006-0000-4000-8000-000000000001";
  await withMainTurn({ sessionId: "consumption-u3", mainMessageId }, async (rig) => {
    rig.step();
    await injectSteer(rig, "req-a", STEER_A);
    rig.step();
    rig.step();
    await injectSteer(rig, "req-b", STEER_B);
    await rig.owner.drainDeliveries("session-close", 0);
    rig.control.resolveMainPrompt({ stopReason: "cancelled" });
    await withRaceTimeout(rig.run, MUST_FINISH_MS, "the turn never finished");
    const [main] = await terminalsFor(rig.record, mainMessageId);
    assert.equal(main?.phase, "done");
    assert.equal(main?.stopReason, CONSUMED_BEFORE_CUT);
    assert.equal(main?.error?.detailCode, SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE);
    const [a] = await terminalsFor(rig.record, STEER_A);
    assert.equal(a?.phase, "done");
    assert.equal(a?.stopReason, CONSUMED_BEFORE_CUT);
    const [b] = await terminalsFor(rig.record, STEER_B);
    assert.equal(b?.phase, "failed", "the steer injected after the last completion is cut");
    assert.equal(b?.error?.detailCode, SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE);
  });
});

// U8: 570d2570 C3 precedence — a turn that answered on its own keeps its own done, even when consumed. Driven
// through the owner's real close sweep with the open main delivery registered as the runtime registers it.
test("e09628a1 U8: the close sweep writes a consumed main's OWN done when it answered first (ownEnd wins)", async () => {
  await withTempHome("acpx-delivery-consumption-u8-", async (homeDir) => {
    for (const [index, ownEnd] of [
      [1, true],
      [2, false],
    ] as const) {
      const record = makeSessionRecord({
        acpxRecordId: `consumption-u8-${index}`,
        acpSessionId: `consumption-u8-${index}-acp`,
        agentCommand: CODEX_AGENT_COMMAND,
        cwd: homeDir,
      });
      await writeSessionRecordFile(homeDir, record);
      const lease = await tryAcquireQueueOwnerLease(record.acpxRecordId);
      assert(lease);
      const owner = await SessionQueueOwner.start(lease, stubControlHandlers(), {
        maxQueueDepth: 8,
      });
      const messageId = `e0960007-0000-4000-8000-00000000000${index}`;
      const delivery: OpenMainTurnDelivery = {
        context: { messageId, requestId: `req-u8-${index}` },
        terminalClaimed: false,
        consumed: true,
        ...(ownEnd ? { ownEnd: { stopReason: "end_turn" as const } } : {}),
      };
      registerOpenMainTurnDelivery(record.acpxRecordId, delivery);
      try {
        await owner.drainDeliveries("session-close", 0);
        assert.equal(owner.terminalizeCustodyOnSignal(), 1);
        const terminals = await terminalsFor(record, messageId);
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0]?.phase, "done");
        assert.equal(terminals[0]?.stopReason, ownEnd ? "end_turn" : CONSUMED_BEFORE_CUT);
      } finally {
        unregisterOpenMainTurnDelivery(record.acpxRecordId, delivery);
        await owner.close();
        resetSessionCloseIntentForTests();
      }
    }
  });
});

// U9: a Claude session gets no tracker — the same frames change nothing.
test("e09628a1 U9: a Claude main cut by a close keeps failed/SESSION_CLOSED_TURN_CANCELLED whatever it streamed", async () => {
  const mainMessageId = "e0960008-0000-4000-8000-000000000001";
  await withMainTurn(
    { sessionId: "consumption-u9", mainMessageId, agentCommand: CLAUDE_AGENT_COMMAND },
    async (rig) => {
      rig.step();
      rig.step();
      await rig.owner.drainDeliveries("session-close", 0);
      rig.owner.terminalizeCustodyOnSignal();
      const [at] = await terminalsFor(rig.record, mainMessageId);
      assert.equal(at?.phase, "failed");
      assert.equal(at?.error?.detailCode, SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE);
      rig.control.resolveMainPrompt({ stopReason: "cancelled" });
    },
  );
});
