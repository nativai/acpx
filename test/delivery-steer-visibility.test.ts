// brick ddd76838 / 7ada04b9 — a delivery must never record a CLEAN SUCCESS for a
// delivery whose window observed nothing, and a steered delivery must not read
// as a completed turn of its own.
//
// The 5.5 h wedge RCA: a pi steer-ack (`end_turn` + `_meta.piAcp.steered`, ZERO
// `session/update` frames) was recorded by acpx as a clean `done` — every layer
// read its own blind spot. The fix is two additive terminal annotations, both
// READS OF DATA ALREADY ON THE WIRE, sharing one `warning` wire field:
//
//   • `warning: "steered into active turn"` — ANY `done` terminal carrying
//     `steered: true`, unconditionally, regardless of frame count.
//   • `warning: "completed with no agent output"` — a `done` terminal for a
//     GENUINE (non-steered) completion whose delivery window observed ZERO
//     session/update frames (window = frames between the delivery's `accepted`
//     event and its terminal).
//   • `steered: true` — the adapter's `_meta.piAcp.steered` forwarded onto the
//     terminal; `stopReason` STAYS `end_turn` (the union and the dedup keyed on
//     it are unchanged).
//
// 2026-09-24 RECURRENCE: pi-acp's steer-visibility fix (ec12cdb, deployed) now
// emits TWO cosmetic session/update frames on every absorbed steer (a banner
// chunk + a session_info_update). That made the zero-output frame-counting
// check permanently silent for every steered delivery — fix 1 of the original
// round structurally disabled fix 2. The remedy is that a steered terminal is
// no longer decided by frame count AT ALL: `steeredDeliveryWarning` is checked
// BEFORE `zeroAgentOutputWarning` (`deliveryTerminalWarning`'s precedence), so
// it fires on the `steered` flag alone and can never be defeated by a cosmetic
// frame.
//
// Narrowness is the design: a cancelled/failed terminal with no frames is
// unremarkable (no warning), a `deduplicated` terminal has no turn at all (no
// warning), and the codex absorbed-steer terminal carries `stopReason: null` BY
// DESIGN (the steer acts inside the containing turn, producing no frames of its
// own — no warning, since it is also not `steered: true`). Overlapping windows
// can only UNDER-count a zero, so the worst case for the zero-output half is a
// missed warning, never a false one.

import assert from "node:assert/strict";
import test from "node:test";
import type { AcpClient } from "../src/acp/client.js";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { textPrompt, type PromptInput } from "../src/prompt-content.js";
import { runPromptTurn } from "../src/runtime/engine/prompt-turn.js";
import { createSessionConversation } from "../src/session/conversation-model.js";
import {
  buildDeliveryEvent,
  deliveryTerminalWarning,
  hasCompletedDeliveryFor,
  isGenuineCompletionStopReason,
  steeredDeliveryWarning,
  zeroAgentOutputWarning,
  STEERED_INTO_ACTIVE_TURN_WARNING,
  ZERO_AGENT_OUTPUT_WARNING,
} from "../src/session/delivery-events.js";
import { listSessionEvents } from "../src/session/events.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

const MAIN_PROMPT_TEXT = "main turn prompt";
const INJECTED_PROMPT_TEXT = "injected mid-turn prompt";

// ---------------------------------------------------------------------------
// Unit layer — the reads themselves (mirrors test/turn-error-meta.test.ts).
// ---------------------------------------------------------------------------

async function turnWith(meta: unknown) {
  const client = {
    prompt: async () => ({
      stopReason: "end_turn" as const,
      ...(meta !== undefined ? { _meta: meta } : {}),
    }),
    waitForSessionUpdatesIdle: async () => {},
  };
  const result = await runPromptTurn({
    client: client as unknown as Parameters<typeof runPromptTurn>[0]["client"],
    sessionId: "session-under-test",
    prompt: "hello",
    conversation: createSessionConversation(),
  });
  return result;
}

test("ddd76838: a pi steer-ack surfaces as result.steered — read off _meta.piAcp.steered", async () => {
  const result = await turnWith({ piAcp: { steered: true } });
  assert.equal(result.steered, true, "the steer-ack flag is read off _meta");
  assert.equal(result.stopReason, "end_turn", "the wire stop reason is unchanged");
  assert.equal(result.source, "rpc");
});

test("ddd76838 CONTROL: a plain turn sets NO steered flag", async () => {
  const noMeta = await turnWith(undefined);
  assert.ok(!("steered" in noMeta) || noMeta.steered === undefined, "no _meta invents nothing");

  const emptyMeta = await turnWith({});
  assert.ok(!emptyMeta.steered, "an empty _meta invents nothing");

  const otherHarness = await turnWith({ claudeAcp: { steered: true } });
  assert.ok(!otherHarness.steered, "another harness's namespace is not read");

  const falsy = await turnWith({ piAcp: { steered: "yes" } });
  assert.ok(!falsy.steered, "an ill-typed value invents nothing");
});

test("ddd76838: buildDeliveryEvent forwards steered/warning; absence leaves no residue", () => {
  const withBoth = buildDeliveryEvent({
    messageId: "m1",
    requestId: "r1",
    phase: "done",
    stopReason: "end_turn",
    steered: true,
    warning: ZERO_AGENT_OUTPUT_WARNING,
  });
  const params = (withBoth as { params?: Record<string, unknown> }).params ?? {};
  assert.equal(params.steered, true);
  assert.equal(params.warning, ZERO_AGENT_OUTPUT_WARNING);

  // A clean terminal carries NEITHER key — the control that keeps acpx-ui's
  // whitelist safe to ignore unknown fields, and keeps ordinary turns untouched.
  const clean = buildDeliveryEvent({
    messageId: "m2",
    requestId: "r2",
    phase: "done",
    stopReason: "end_turn",
  });
  const cleanParams = (clean as { params?: Record<string, unknown> }).params ?? {};
  assert.equal("steered" in cleanParams, false, "no steered residue on a clean terminal");
  assert.equal("warning" in cleanParams, false, "no warning residue on a clean terminal");
});

test("ddd76838: the zero-output rule fires on genuine completions only", () => {
  const W = (over: Partial<Parameters<typeof zeroAgentOutputWarning>[0]>) =>
    zeroAgentOutputWarning({
      terminal: true,
      phase: "done",
      stopReason: "end_turn",
      framesAtStart: 0,
      framesAtTerminal: 0,
      ...over,
    });
  assert.equal(W({}), ZERO_AGENT_OUTPUT_WARNING, "a zero-frame done terminal warns");
  assert.equal(W({ framesAtTerminal: 3 }), undefined, "frames observed ⇒ no warning");
  assert.equal(W({ framesAtStart: undefined }), undefined, "unknown window stays silent");
  assert.equal(W({ phase: "failed" }), undefined, "a failed terminal never warns");
  assert.equal(W({ phase: "cancelled" }), undefined, "a cancelled terminal never warns");
  assert.equal(W({ stopReason: "deduplicated" }), undefined, "dedup is not a completion");
  assert.equal(W({ stopReason: null }), undefined, "absorbed (null) is not a completion");
  assert.equal(W({ terminal: false }), undefined, "non-terminals never warn");
  // brick 7ada04b9: a steered terminal is never genuine, even with zero frames —
  // it must NOT get the zero-output warning; steeredDeliveryWarning owns it.
  assert.equal(
    W({ steered: true }),
    undefined,
    "steered ⇒ not a genuine completion, no zero-output warning even at zero frames",
  );
  assert.equal(
    W({ steered: true, framesAtTerminal: 3 }),
    undefined,
    "steered ⇒ still no zero-output warning regardless of frame count",
  );

  assert.equal(isGenuineCompletionStopReason("end_turn"), true);
  assert.equal(isGenuineCompletionStopReason("end_turn"), true);
  assert.equal(isGenuineCompletionStopReason("max_tokens"), true);
  assert.equal(isGenuineCompletionStopReason("max_turns"), true);
  // `deduplicated` is NOT a completion (dedup must not fire on it — Defect B),
  // and null/undefined/cancelled are not either.
  assert.equal(isGenuineCompletionStopReason("deduplicated"), false);
  assert.equal(isGenuineCompletionStopReason("cancelled"), false);
  assert.equal(isGenuineCompletionStopReason(null), false);
  assert.equal(isGenuineCompletionStopReason(undefined), false);
  // brick 7ada04b9: the load-bearing defect — pi's steer-ack reuses the GENUINE
  // "end_turn" value, so `steered` must be read explicitly or this wrongly
  // returns true for an absorbed steer, exactly as it did before the fix.
  assert.equal(
    isGenuineCompletionStopReason("end_turn", true),
    false,
    "a steered end_turn is not a genuine completion",
  );
  assert.equal(
    isGenuineCompletionStopReason("end_turn", false),
    true,
    "steered:false is unaffected",
  );
  assert.equal(isGenuineCompletionStopReason("max_tokens", true), false);
});

test("7ada04b9: steeredDeliveryWarning fires on any done+steered terminal, independent of frames", () => {
  const S = (over: Partial<Parameters<typeof steeredDeliveryWarning>[0]>) =>
    steeredDeliveryWarning({ terminal: true, phase: "done", steered: true, ...over });
  assert.equal(S({}), STEERED_INTO_ACTIVE_TURN_WARNING, "a steered done terminal always warns");
  assert.equal(S({ steered: false }), undefined, "not steered ⇒ this function stays silent");
  assert.equal(S({ steered: undefined }), undefined, "absent steered ⇒ silent");
  assert.equal(S({ terminal: false }), undefined, "non-terminal ⇒ silent");
  assert.equal(S({ phase: "failed" }), undefined, "a failed terminal never gets this annotation");
  assert.equal(
    S({ phase: "cancelled" }),
    undefined,
    "a cancelled terminal never gets this annotation",
  );
});

// NOTE ON SCOPE: this exercises the FINAL composed output of
// deliveryTerminalWarning for steered inputs. It is NOT independent proof that
// the `??` ORDERING inside deliveryTerminalWarning matters — both branches
// read the same `params.steered`, and `zeroAgentOutputWarning`'s own
// precondition (isGenuineCompletionStopReason's `steered` check, pinned in
// "the zero-output rule fires on genuine completions only" above) already
// returns `undefined` for every steered input before the `??` has anything to
// choose between. Verified directly: reordering the `??` operands in
// deliveryTerminalWarning does not change any assertion in this file — the
// order is deliberate defense-in-depth (see its doc comment), not something a
// standing test can prove without mutating isGenuineCompletionStopReason
// itself (forbidden — no mutation testing in this repo). Don't cite this test
// as proof of precedence; it proves the composed OUTPUT, which is what
// callers actually observe.
test("7ada04b9: deliveryTerminalWarning returns the steered annotation for steered inputs, at any frame count", () => {
  const D = (over: Partial<Parameters<typeof deliveryTerminalWarning>[0]>) =>
    deliveryTerminalWarning({
      terminal: true,
      phase: "done",
      stopReason: "end_turn",
      framesAtStart: 0,
      framesAtTerminal: 0,
      ...over,
    });
  // THE INCIDENT SHAPE, replayed directly against the pure function: a `done`
  // terminal, stopReason "end_turn", steered:true, with TWO session/update
  // frames observed in the window (pi-acp ec12cdb's cosmetic banner +
  // session_info_update) — exactly what defeated the old frame-counting check.
  assert.equal(
    D({ steered: true, framesAtStart: 0, framesAtTerminal: 2 }),
    STEERED_INTO_ACTIVE_TURN_WARNING,
    "steered still gets the steered annotation even though frames were observed",
  );
  // Same shape but the pre-visibility-fix pi-acp (zero frames): still the
  // steered text, from steeredDeliveryWarning alone (zeroAgentOutputWarning's
  // own precondition already excludes steered inputs — see the note above).
  assert.equal(
    D({ steered: true, framesAtStart: 0, framesAtTerminal: 0 }),
    STEERED_INTO_ACTIVE_TURN_WARNING,
    "steered gets the steered annotation at zero frames too",
  );
  // Not steered, zero frames: the original ddd76838 behaviour is preserved.
  assert.equal(D({ steered: false }), ZERO_AGENT_OUTPUT_WARNING);
  assert.equal(D({}), ZERO_AGENT_OUTPUT_WARNING, "steered omitted behaves like steered:false");
  // Not steered, frames observed: clean, no warning at all.
  assert.equal(D({ steered: false, framesAtTerminal: 2 }), undefined);
});

// brick 7ada04b9 — the dedup invariant `hasCompletedDeliveryFor` is DELIBERATELY
// left unchanged (documented in delivery-events.ts with a ⚠️). A steered
// delivery's content still reached and was acted on by the agent, so it must
// still dedup like any other delivered prompt — a retry for the same messageId
// must NOT re-send content the agent already saw. A prose comment is not a
// test: this pins the invariant so a future edit that makes `steered` exclude
// the event from dedup (a plausible-looking "fix" given
// deliveryTerminalWarning's opposite-looking behaviour) goes red here.
test("7ada04b9: hasCompletedDeliveryFor still dedups a steered terminal — the message reached the agent", () => {
  const messageId = "steer-dedup-0001";
  const steeredDone = buildDeliveryEvent({
    messageId,
    requestId: "req-1",
    phase: "done",
    stopReason: "end_turn",
    steered: true,
    warning: STEERED_INTO_ACTIVE_TURN_WARNING,
  });
  assert.equal(
    hasCompletedDeliveryFor([steeredDone], messageId),
    true,
    "a steered delivery's content reached the agent — dedup must still find it",
  );
  // CONTROL: an ordinary, non-steered completion still dedups too (unaffected
  // by this brick) — the property this test protects is additive, not a
  // narrowing of the existing contract.
  const plainDone = buildDeliveryEvent({
    messageId,
    requestId: "req-2",
    phase: "done",
    stopReason: "end_turn",
  });
  assert.equal(hasCompletedDeliveryFor([plainDone], messageId), true);
});

// ---------------------------------------------------------------------------
// Integration layer — the real runQueuedTask -> runSessionPrompt path with a
// mock AcpClient whose setEventHandlers is CAPTURED so a test can fire live
// session/update frames into the production tap (the harness in
// mid-turn-injection.test.ts never fires any; these tests need both arms).
// ---------------------------------------------------------------------------

type PromptResponse = { stopReason: "end_turn"; _meta?: unknown };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type MockClientControl = {
  client: AcpClient;
};

// Minimal mock AcpClient: the reuse happy-path surface runSessionPrompt touches,
// plus a captured event-handler set. `prompt()` delegates to the test handler;
// the optional `emit` lets the handler push live session/update notifications
// through the production onSessionUpdate tap while the turn is in flight.
function makeMockClient(handlers: {
  onMainPrompt: (
    sessionId: string,
    emit: (notification: unknown) => void,
  ) => Promise<PromptResponse>;
  onInjectedPrompt?: (sessionId: string) => Promise<PromptResponse>;
}): MockClientControl {
  let sessionUpdateTap: ((notification: unknown) => void) | undefined;
  const emit = (notification: unknown): void => {
    assert.ok(sessionUpdateTap, "onSessionUpdate tap must be wired before the turn runs");
    sessionUpdateTap(notification);
  };
  const mock = {
    hasReusableSession: () => true,
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    start: async () => {},
    getAgentLifecycleSnapshot: () => ({ running: true }),
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,
    updateRuntimeOptions: () => {},
    setEventHandlers: (h: Record<string, unknown>) => {
      sessionUpdateTap = h.onSessionUpdate as (notification: unknown) => void;
    },
    clearEventHandlers: () => {},
    hasActivePrompt: () => false,
    requestCancelActivePrompt: async () => false,
    cancelActivePrompt: async () => {},
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    close: async () => {},
    waitForSessionUpdatesIdle: async () => {},
    getEffectiveAccountMetadata: () => undefined,
    prompt: (sessionId: string, input: PromptInput | string): Promise<PromptResponse> => {
      const text = promptText(input);
      if (text === INJECTED_PROMPT_TEXT) {
        // Pre-F1 codex adapter: the injected steer never returns a terminal.
        return handlers.onInjectedPrompt
          ? handlers.onInjectedPrompt(sessionId)
          : new Promise<PromptResponse>(() => {});
      }
      return handlers.onMainPrompt(sessionId, emit);
    },
  };
  return { client: mock as unknown as AcpClient };
}

function promptText(input: PromptInput | string): string {
  if (typeof input === "string") {
    return input;
  }
  return input.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function makeSessionRecord(cwd: string, agentCommand = "node mock-agent.js"): SessionRecord {
  return makeSessionRecordFixture(
    {
      acpxRecordId: "steer-visibility",
      acpSessionId: "steer-visibility-session",
      agentCommand,
      cwd,
    },
    { defaultName: false },
  );
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-steer-visibility-home-", run);
}

function makeQueueTask(
  requestId: string,
  text: string,
  messageId: string,
  onSend: (message: QueueOwnerMessage) => void,
): QueueTask {
  return {
    requestId,
    messageId,
    message: text,
    prompt: textPrompt(text),
    permissionMode: "approve-all",
    timeoutMs: 10_000,
    waitForCompletion: true,
    enqueuedAt: Date.now(),
    send: onSend,
    close: () => {},
  } satisfies QueueTask;
}

// A valid session/update notification: an ordinary agent text chunk — the most
// common frame on the wire, and the one whose ABSENCE defined the incident.
function agentChunk(text = "model output"): unknown {
  return {
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  };
}

function deliveryEventsFor(events: unknown[], messageId: string): Record<string, unknown>[] {
  return events
    .filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { method?: unknown }).method === "acpx/delivery" &&
        (event as { params?: Record<string, unknown> }).params?.messageId === messageId,
    )
    .map((event) => (event as { params: Record<string, unknown> }).params);
}

// pi steer-ack (end_turn + _meta.piAcp.steered, ZERO frames — the pre-visibility
// -fix pi-acp shape). The terminal must record `steered` AND the "steered into
// active turn" annotation — never a clean bare end_turn, and never the generic
// zero-output text once `steered` is known (brick 7ada04b9: the more specific
// annotation wins).
test("ddd76838/7ada04b9: a steered delivery with ZERO frames records steered + the steered annotation", async () => {
  await withTempHome(async (homeDir) => {
    const record = makeSessionRecord(homeDir);
    await writeSessionRecordFile(homeDir, record);

    const messageId = "ddd00001-1111-4111-8111-111111111111";
    const control = makeMockClient({
      onMainPrompt: async () => {
        // No frames at all: the pre-fix pi-acp steer-ack shape.
        return { stopReason: "end_turn", _meta: { piAcp: { steered: true } } };
      },
    });

    const sends: QueueOwnerMessage[] = [];
    const task = makeQueueTask("req-incident", MAIN_PROMPT_TEXT, messageId, (m) => sends.push(m));

    await runQueuedTask(record.acpxRecordId, task, {
      sharedClient: control.client,
      suppressSdkConsoleErrors: true,
    });

    assert.ok(
      sends.find((m) => m.type === "result"),
      "the delivery settled with a result",
    );
    const terminals = deliveryEventsFor(
      await listSessionEvents(record.acpxRecordId),
      messageId,
    ).filter((e) => e.phase === "done");
    assert.equal(terminals.length, 1, "exactly one done terminal");
    assert.equal(
      terminals[0]?.stopReason,
      "end_turn",
      "stopReason is UNCHANGED (dedup keyed on it)",
    );
    assert.equal(terminals[0]?.steered, true, "the steer-ack is recorded on the delivery record");
    assert.equal(
      terminals[0]?.warning,
      STEERED_INTO_ACTIVE_TURN_WARNING,
      "the zero-frame steered delivery gets the steered annotation, not the generic zero-output one",
    );
  });
});

// THE 2026-09-24 RECURRENCE, REPRODUCED END-TO-END: pi-acp's steer-visibility
// fix (ec12cdb, deployed) makes every absorbed steer emit TWO session/update
// frames — an agent_message_chunk banner + a session_info_update — which is
// exactly the shape that silenced the old frame-counting warning for all three
// absorbed messages in the 2026-09-24 occurrence. `steered` must still be
// recorded AND the terminal must still carry the "steered into active turn"
// warning — proving the annotation survives the cosmetic frames, not just the
// absence of frames.
test("7ada04b9: a steered delivery WITH two cosmetic frames still warns — the recurrence shape", async () => {
  await withTempHome(async (homeDir) => {
    const record = makeSessionRecord(homeDir);
    await writeSessionRecordFile(homeDir, record);

    const messageId = "ddd00002-2222-4222-8222-222222222222";
    const control = makeMockClient({
      onMainPrompt: async (_sessionId, emit) => {
        // Post-fix pi-acp: two cosmetic frames arrive in the window, nothing else.
        emit(agentChunk("⏩ Steered into the active turn"));
        emit({ update: { sessionUpdate: "session_info_update" } });
        return { stopReason: "end_turn", _meta: { piAcp: { steered: true } } };
      },
    });

    const sends: QueueOwnerMessage[] = [];
    const task = makeQueueTask("req-steered-frames", MAIN_PROMPT_TEXT, messageId, (m) =>
      sends.push(m),
    );

    await runQueuedTask(record.acpxRecordId, task, {
      sharedClient: control.client,
      suppressSdkConsoleErrors: true,
    });

    const terminals = deliveryEventsFor(
      await listSessionEvents(record.acpxRecordId),
      messageId,
    ).filter((e) => e.phase === "done");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.steered, true);
    assert.equal(
      terminals[0]?.warning,
      STEERED_INTO_ACTIVE_TURN_WARNING,
      "two cosmetic frames must not silence the steered annotation (this is the exact 2026-09-24 defect)",
    );
  });
});

// CONTROL (false-alarm direction, no steering): a NORMAL turn that produced
// output must carry neither annotation — the property that keeps the warning
// from stamping every busy session.
test("ddd76838 CONTROL: a normal turn with observed output records neither annotation", async () => {
  await withTempHome(async (homeDir) => {
    const record = makeSessionRecord(homeDir);
    await writeSessionRecordFile(homeDir, record);

    const messageId = "ddd00003-3333-4333-8333-333333333333";
    const control = makeMockClient({
      onMainPrompt: async (_sessionId, emit) => {
        emit(agentChunk("here is the answer"));
        return { stopReason: "end_turn" };
      },
    });

    const sends: QueueOwnerMessage[] = [];
    const task = makeQueueTask("req-normal", MAIN_PROMPT_TEXT, messageId, (m) => sends.push(m));

    await runQueuedTask(record.acpxRecordId, task, {
      sharedClient: control.client,
      suppressSdkConsoleErrors: true,
    });

    const terminals = deliveryEventsFor(
      await listSessionEvents(record.acpxRecordId),
      messageId,
    ).filter((e) => e.phase === "done");
    assert.equal(terminals.length, 1);
    assert.equal("steered" in terminals[0], false);
    assert.equal("warning" in terminals[0], false);
  });
});

// A clean-looking end_turn with ZERO frames is exactly the wedge shape WITHOUT
// the steered flag (a silent adapter). The warning fires; `steered` stays absent.
test("ddd76838: a plain end_turn with ZERO frames still warns (the silent-adapter shape)", async () => {
  await withTempHome(async (homeDir) => {
    const record = makeSessionRecord(homeDir);
    await writeSessionRecordFile(homeDir, record);

    const messageId = "ddd00004-4444-4444-8444-444444444444";
    const control = makeMockClient({
      onMainPrompt: async () => ({ stopReason: "end_turn" }),
    });

    const sends: QueueOwnerMessage[] = [];
    const task = makeQueueTask("req-silent", MAIN_PROMPT_TEXT, messageId, (m) => sends.push(m));

    await runQueuedTask(record.acpxRecordId, task, {
      sharedClient: control.client,
      suppressSdkConsoleErrors: true,
    });

    const terminals = deliveryEventsFor(
      await listSessionEvents(record.acpxRecordId),
      messageId,
    ).filter((e) => e.phase === "done");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.warning, ZERO_AGENT_OUTPUT_WARNING);
    assert.equal("steered" in terminals[0], false);
  });
});

// Narrowness control: a codex ABSORBED steer is completed by the containing turn
// with `stopReason: null` BY DESIGN and produces no frames of its own — it must
// NOT acquire the warning, or every absorbed codex steer becomes an alarm.
test("ddd76838 CONTROL: an absorbed (codex) steer terminal gets no warning despite zero frames", async () => {
  await withTempHome(async (homeDir) => {
    const record = makeSessionRecord(homeDir, "codex-acp");
    await writeSessionRecordFile(homeDir, record);

    const mainMessageId = "ddd00005-5555-4555-8555-555555555555";
    const injectedMessageId = "ddd00006-6666-4666-8666-666666666666";
    // The main prompt must still be in flight when the injection lands — mirror
    // the F4 gate: resolve a deferred from the injected prompt's START.
    const injectionInitiated = createDeferred<void>();

    // Pre-F1 codex adapter: the injected steer never returns a terminal; the
    // containing turn's completion closes its lifecycle with stopReason null.
    const control = makeMockClient({
      onMainPrompt: async () => {
        await injectionInitiated.promise;
        return { stopReason: "end_turn" };
      },
      onInjectedPrompt: () => {
        injectionInitiated.resolve();
        return new Promise<PromptResponse>(() => {});
      },
    });
    // The injection path needs the real mid-turn plumbing: capture the handler.
    let midTurnHandler: ((task: QueueTask) => void) | undefined;
    const setMidTurnHandler = (handler: ((task: QueueTask) => void) | undefined): void => {
      if (handler !== undefined) {
        // Inject on a microtask so the injection lands while the main turn runs.
        queueMicrotask(() => {
          midTurnHandler?.({
            requestId: "req-absorbed",
            messageId: injectedMessageId,
            message: INJECTED_PROMPT_TEXT,
            prompt: textPrompt(INJECTED_PROMPT_TEXT),
            permissionMode: "approve-all",
            timeoutMs: 10_000,
            waitForCompletion: false,
            enqueuedAt: Date.now(),
            send: () => {},
            close: () => {},
          } satisfies QueueTask);
        });
      }
      midTurnHandler = handler;
    };

    const sends: QueueOwnerMessage[] = [];
    const task = makeQueueTask("req-codex-main", MAIN_PROMPT_TEXT, mainMessageId, (m) =>
      sends.push(m),
    );

    await runQueuedTask(record.acpxRecordId, task, {
      sharedClient: control.client,
      setMidTurnHandler,
      suppressSdkConsoleErrors: true,
    });

    assert.ok(
      sends.find((m) => m.type === "result"),
      "the containing turn finalized",
    );
    const absorbedTerminals = deliveryEventsFor(
      await listSessionEvents(record.acpxRecordId),
      injectedMessageId,
    ).filter((e) => e.phase === "done");
    assert.equal(absorbedTerminals.length, 1, "exactly one terminal for the absorbed steer");
    assert.equal(
      absorbedTerminals[0]?.stopReason,
      null,
      "absorbed terminal carries stopReason null",
    );
    assert.equal(
      "warning" in absorbedTerminals[0],
      false,
      "an absorbed steer with zero frames is BY DESIGN, not an alarm",
    );
  });
});
