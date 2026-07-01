// Regression coverage for acpx's core fork feature: mid-turn prompt injection,
// including injection that arrives during a RETRIED attempt.
//
// The fork lets a task that arrives while a turn is in flight be injected into
// that turn (a second, concurrent `client.prompt()` whose response the agent
// surfaces mid-turn). The wiring lives in `runSessionPrompt`:
//   - `buildPromptStartedHook(sessionId, attempt)` returns an `onPromptStarted`
//     hook that (re)registers the mid-turn handler via `setMidTurnHandler`.
//     Crucially, when an injection handler is wanted it is registered on EVERY
//     attempt, including retries — NOT just attempt 0. (Upstream returns
//     `undefined` on retries, which silently drops a mid-turn injection that
//     arrives during a retried attempt. The retry scenario below is a guard
//     against regressing to that behavior: it fails if buildPromptStartedHook
//     returns undefined on retry.)
//   - the registered handler calls `client.prompt()` for the injected task and
//     tracks wait-for-completion promises so the turn can await them.
//   - `drainInjectedPrompts()` clears the handler and awaits tracked in-flight
//     injected prompts before the turn settles (on both the success and the
//     failure/retry paths). Fire-and-forget injected prompts are deliberately
//     not tracked because Codex ACP can act on them without returning a terminal
//     JSON-RPC response for that injected request.
//
// These tests drive the real `runQueuedTask` -> `runSessionPrompt` -> retry
// path with a mock `AcpClient` (passed as `sharedClient`) and a real
// `setMidTurnHandler` capture, so the production injection/retry logic runs
// unmodified. They assert: the handler is (re)registered on every attempt, the
// injected prompt fires exactly once and settles exactly once with a result,
// the ordering is correct, and there are zero unhandled rejections.

import assert from "node:assert/strict";
import test from "node:test";
import type { AcpClient } from "../src/acp/client.js";
import { supportsMidTurnPromptInjection } from "../src/acp/mid-turn-injection-support.js";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { type PromptInput, textPrompt } from "../src/prompt-content.js";
import { listSessionEvents } from "../src/session/events.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import {
  makeSessionRecord as makeSessionRecordFixture,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

const MAIN_PROMPT_TEXT = "main turn prompt";
const INJECTED_PROMPT_TEXT = "injected mid-turn prompt";

type PromptResponse = { stopReason: "end_turn" };

// A retryable ACP failure: -32603 (internal error) is classified retryable by
// isRetryablePromptError, so the attempt 0 -> attempt 1 retry path is exercised.
function makeRetryableAcpError(): Error {
  const error = new Error("prompt failed (internal error)");
  (error as Error & { error?: unknown }).error = { code: -32603, message: "Internal error" };
  return error;
}

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

function promptText(input: PromptInput | string): string {
  if (typeof input === "string") {
    return input;
  }
  return input.map((block) => (block.type === "text" ? block.text : "")).join("");
}

// A macrotask tick. Used to defer a main-turn rejection until after
// runPromptTurn has attached its handler to the prompt promise (via
// `await withTimeout(...)`), so a rejecting main turn never momentarily looks
// like an unhandled rejection.
function tick(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// A record of every client.prompt() call the production code makes, tagged by
// whether it was the main turn prompt or an injected mid-turn prompt, plus the
// 0-based main-turn attempt index that was active when the call was made.
type PromptCall = {
  kind: "main" | "injected";
  sessionId: string;
  attempt: number;
  messageId?: string;
};

function eventMethod(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const method = (event as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function eventParams(event: unknown): Record<string, unknown> {
  if (typeof event !== "object" || event === null) {
    return {};
  }
  const params = (event as { params?: unknown }).params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return {};
  }
  return params as Record<string, unknown>;
}

function turnPhases(events: unknown[]): unknown[] {
  return events
    .filter((event) => eventMethod(event) === "acpx/turn")
    .map((event) => eventParams(event).phase);
}

function deliveryEventParams(events: unknown[]): Record<string, unknown>[] {
  return events
    .filter((event) => eventMethod(event) === "acpx/delivery")
    .map((event) => eventParams(event));
}

function deliveryEventSummaries(events: unknown[]): Record<string, unknown>[] {
  return deliveryEventParams(events).map((event) => ({
    messageId: event.messageId,
    requestId: event.requestId,
    phase: event.phase,
    stopReason: event.stopReason,
  }));
}

type MockClientControl = {
  client: AcpClient;
  promptCalls: PromptCall[];
  // 0-based index of the main turn attempt currently in flight.
  activeAttempt: number;
};

// Builds a mock AcpClient. Only `prompt()` carries test logic; the rest is the
// minimal surface that connectAndLoadSession + runSessionPrompt touch on the
// reuse happy-path (`hasReusableSession` -> true skips start/resume/load/create
// and `getAgentLifecycleSnapshot` reports no unexpected exit so retries are
// allowed). `prompt()` distinguishes the main turn from an injected one by the
// prompt text.
function makeMockClient(handlers: {
  onMainPrompt: (attempt: number, sessionId: string) => Promise<PromptResponse>;
  onInjectedPrompt: (sessionId: string) => Promise<PromptResponse>;
}): MockClientControl {
  const control: MockClientControl = {
    client: undefined as unknown as AcpClient,
    promptCalls: [],
    activeAttempt: 0,
  };
  let nextMainAttempt = 0;

  const mock = {
    // connect/load happy path: reuse the already-loaded session.
    hasReusableSession: () => true,
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    start: async () => {},
    getAgentLifecycleSnapshot: () => ({ running: true }),
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,

    // runtime option / event handler plumbing (no-ops; never firing
    // onSessionUpdate keeps promptTurnHadSideEffects false so the retry is allowed).
    updateRuntimeOptions: () => {},
    setEventHandlers: () => {},
    clearEventHandlers: () => {},

    // active-session controller surface (unused on the happy path).
    hasActivePrompt: () => false,
    requestCancelActivePrompt: async () => false,
    cancelActivePrompt: async () => {},
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    close: async () => {},
    waitForSessionUpdatesIdle: async () => {},

    prompt: (
      sessionId: string,
      input: PromptInput | string,
      options?: { messageId?: string },
    ): Promise<PromptResponse> => {
      const text = promptText(input);
      if (text === INJECTED_PROMPT_TEXT) {
        control.promptCalls.push({
          kind: "injected",
          sessionId,
          attempt: control.activeAttempt,
          messageId: options?.messageId,
        });
        return handlers.onInjectedPrompt(sessionId);
      }
      const attempt = nextMainAttempt;
      nextMainAttempt += 1;
      control.activeAttempt = attempt;
      control.promptCalls.push({ kind: "main", sessionId, attempt, messageId: options?.messageId });
      return handlers.onMainPrompt(attempt, sessionId);
    },
  };

  control.client = mock as unknown as AcpClient;
  return control;
}

// Wraps setMidTurnHandler: counts registrations/clears and notifies on each
// (non-undefined) registration. The handler is preserved verbatim so the
// production injection path runs unmodified.
type MidTurnControl = {
  setMidTurnHandler: (handler: ((task: QueueTask) => void) | undefined) => void;
  registrations: number;
  clears: number;
  currentHandler: ((task: QueueTask) => void) | undefined;
};

function makeMidTurnControl(
  onRegistered: (registration: number, control: MidTurnControl) => void,
): MidTurnControl {
  const control: MidTurnControl = {
    setMidTurnHandler: () => {},
    registrations: 0,
    clears: 0,
    currentHandler: undefined,
  };
  control.setMidTurnHandler = (handler) => {
    if (handler === undefined) {
      control.clears += 1;
      control.currentHandler = undefined;
      return;
    }
    control.registrations += 1;
    control.currentHandler = handler;
    onRegistered(control.registrations, control);
  };
  return control;
}

function makeQueueTask(
  requestId: string,
  text: string,
  onSend: (message: QueueOwnerMessage) => void,
  onClose: () => void,
  waitForCompletion = true,
  messageId?: string,
): QueueTask {
  return {
    requestId,
    ...(messageId !== undefined ? { messageId } : {}),
    message: text,
    prompt: textPrompt(text),
    permissionMode: "approve-all",
    timeoutMs: 10_000,
    waitForCompletion,
    enqueuedAt: Date.now(),
    send: onSend,
    close: onClose,
  } satisfies QueueTask;
}

function makeSessionRecord(cwd: string, agentCommand = "node mock-agent.js"): SessionRecord {
  return makeSessionRecordFixture(
    {
      acpxRecordId: "mid-turn-injection",
      acpSessionId: "mid-turn-injection-session",
      agentCommand,
      cwd,
    },
    { defaultName: false },
  );
}

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-mid-turn-injection-home-", run);
}

// Captures unhandled rejections for the duration of a run and asserts none fired.
async function withNoUnhandledRejections(run: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await run();
    // Flush microtasks/timers so any late rejection surfaces before we assert.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(unhandled, [], "no unhandled rejections");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

// Scenario (a): inject during the active turn on attempt 0, where attempt 0
// then fails (retryable) and the injected prompt is drained on the failure path
// before the turn is retried and succeeds.
async function runAttempt0InjectionScenario(): Promise<void> {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const injectedSends: QueueOwnerMessage[] = [];
      let injectedCloses = 0;
      const injectionInitiated = createDeferred<void>();
      const injectedResponse = createDeferred<PromptResponse>();

      const control = makeMockClient({
        onMainPrompt: async (attempt) => {
          if (attempt === 0) {
            // Wait until the injected prompt is in flight, then fail this
            // attempt with a retryable error. The injected prompt must be
            // drained (awaited) on the failure path before the retry decision.
            await injectionInitiated.promise;
            await tick();
            throw makeRetryableAcpError();
          }
          // Attempt 1 (the retry): no injection happens here; just succeed.
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => {
          injectionInitiated.resolve();
          return await injectedResponse.promise;
        },
      });

      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          // Inject during attempt 0's in-flight turn, on a microtask so the
          // injected client.prompt() runs concurrently with the pending main turn.
          const injectedTask = makeQueueTask(
            "req-injected-attempt0",
            INJECTED_PROMPT_TEXT,
            (message) => injectedSends.push(message),
            () => {
              injectedCloses += 1;
            },
          );
          queueMicrotask(() => {
            ctrl.currentHandler?.(injectedTask);
            // Settle the injected prompt once it has been initiated.
            injectedResponse.resolve({ stopReason: "end_turn" });
          });
        }
      });

      const mainSends: QueueOwnerMessage[] = [];
      let mainCloses = 0;
      const mainTask = makeQueueTask(
        "req-main",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {
          mainCloses += 1;
        },
      );

      await runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        setMidTurnHandler: midTurn.setMidTurnHandler,
        promptRetries: 1,
        suppressSdkConsoleErrors: true,
      });

      // The main turn ultimately succeeds (after the retry) and is closed once.
      const mainResult = mainSends.find((m) => m.type === "result");
      assert.ok(mainResult, "main task should settle with a result");
      assert.equal(mainCloses, 1, "main task closed exactly once");

      // The mid-turn handler was (re)registered on BOTH attempts.
      assert.equal(
        midTurn.registrations,
        2,
        "mid-turn handler must be registered on every attempt, including the retry",
      );
      // And cleared on every attempt (drainInjectedPrompts on failure + on success).
      assert.equal(midTurn.clears, 2, "mid-turn handler cleared once per attempt drain");

      // Two main prompt calls (attempt 0 failed, attempt 1 succeeded) + exactly
      // one injected prompt call, which happened during attempt 0.
      const mainCalls = control.promptCalls.filter((c) => c.kind === "main");
      const injectedCalls = control.promptCalls.filter((c) => c.kind === "injected");
      assert.equal(mainCalls.length, 2, "main prompt ran on attempt 0 and the retry");
      assert.equal(injectedCalls.length, 1, "injected prompt fired exactly once");
      assert.equal(injectedCalls[0]?.attempt, 0, "injection happened during attempt 0");

      // The injected prompt settled exactly once with a result and was closed once.
      const injectedResults = injectedSends.filter((m) => m.type === "result");
      assert.equal(injectedResults.length, 1, "injected task got exactly one result message");
      assert.equal(injectedResults[0]?.requestId, "req-injected-attempt0");
      assert.equal(
        injectedSends.filter((m) => m.type === "error").length,
        0,
        "injected task produced no error message",
      );
      assert.equal(injectedCloses, 1, "injected task closed exactly once");
    });
  });
}

// Scenario (b): inject during a RETRIED attempt (attempt 1, after attempt 0
// fails). This is the core fork guard: with upstream's behavior
// `buildPromptStartedHook` returns undefined on retry, the handler is never
// re-registered, the injection never fires, and this scenario fails.
async function runRetryInjectionScenario(): Promise<void> {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const injectedSends: QueueOwnerMessage[] = [];
      let injectedCloses = 0;
      let injectedSettledAt: "attempt-1" | undefined;
      const injectionInitiated = createDeferred<void>();
      const injectedResponse = createDeferred<PromptResponse>();

      const control = makeMockClient({
        onMainPrompt: async (attempt) => {
          if (attempt === 0) {
            // Fail attempt 0 with a retryable error and NO injection, forcing a retry.
            await tick();
            throw makeRetryableAcpError();
          }
          // Attempt 1 (the retry): the injection is wired to fire now (see the
          // handler-registration trigger below). Wait until the injected prompt
          // is in flight, then succeed. drainInjectedPrompts() on the success
          // path awaits the injected prompt.
          await injectionInitiated.promise;
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => {
          injectionInitiated.resolve();
          const response = await injectedResponse.promise;
          injectedSettledAt = "attempt-1";
          return response;
        },
      });

      const midTurn = makeMidTurnControl((registration, ctrl) => {
        // Inject ONLY on the second registration — i.e. during the retried
        // attempt (attempt 1). With upstream's behavior buildPromptStartedHook
        // returns undefined on retry, so this second registration never happens,
        // currentHandler stays cleared from the attempt-0 drain, and the
        // injected prompt never fires — failing the assertions below.
        if (registration === 2) {
          const injectedTask = makeQueueTask(
            "req-injected-retry",
            INJECTED_PROMPT_TEXT,
            (message) => injectedSends.push(message),
            () => {
              injectedCloses += 1;
            },
          );
          queueMicrotask(() => {
            ctrl.currentHandler?.(injectedTask);
            injectedResponse.resolve({ stopReason: "end_turn" });
          });
        }
      });

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-main",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
      );

      await runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        setMidTurnHandler: midTurn.setMidTurnHandler,
        promptRetries: 1,
        suppressSdkConsoleErrors: true,
      });

      // The main turn ultimately succeeds.
      assert.ok(
        mainSends.find((m) => m.type === "result"),
        "main task settled with a result",
      );

      // GUARD: the handler must be registered on attempt 1 (the retry). If
      // buildPromptStartedHook reverts to returning undefined on retry, this
      // stays at 1 and the test fails.
      assert.equal(
        midTurn.registrations,
        2,
        "mid-turn handler MUST be re-registered on the retried attempt (core fork behavior)",
      );

      // The injected prompt fired exactly once, during attempt 1 (the retry).
      const injectedCalls = control.promptCalls.filter((c) => c.kind === "injected");
      assert.equal(injectedCalls.length, 1, "injected prompt fired exactly once on the retry");
      assert.equal(injectedCalls[0]?.attempt, 1, "injection fired during the RETRIED attempt");
      assert.equal(injectedSettledAt, "attempt-1", "injected prompt settled during the retry");

      // It settled exactly once with a result and was closed once.
      const injectedResults = injectedSends.filter((m) => m.type === "result");
      assert.equal(injectedResults.length, 1, "injected task got exactly one result message");
      assert.equal(injectedResults[0]?.requestId, "req-injected-retry");
      assert.equal(
        injectedSends.filter((m) => m.type === "error").length,
        0,
        "injected task produced no error message",
      );
      assert.equal(injectedCloses, 1, "injected task closed exactly once");
    });
  });
}

async function runFireAndForgetInjectionWithoutTerminalResponseScenario(): Promise<void> {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const injectionInitiated = createDeferred<void>();

      const control = makeMockClient({
        onMainPrompt: async () => {
          await injectionInitiated.promise;
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => {
          injectionInitiated.resolve();
          return await new Promise<PromptResponse>(() => {});
        },
      });

      const injectedSends: QueueOwnerMessage[] = [];
      let injectedCloses = 0;
      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          const injectedTask = makeQueueTask(
            "req-fire-and-forget-injected",
            INJECTED_PROMPT_TEXT,
            (message) => injectedSends.push(message),
            () => {
              injectedCloses += 1;
            },
            false,
          );
          queueMicrotask(() => {
            ctrl.currentHandler?.(injectedTask);
          });
        }
      });

      const mainSends: QueueOwnerMessage[] = [];
      let mainCloses = 0;
      const mainTask = makeQueueTask(
        "req-main-fire-and-forget",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {
          mainCloses += 1;
        },
      );

      await Promise.race([
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          setMidTurnHandler: midTurn.setMidTurnHandler,
          suppressSdkConsoleErrors: true,
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("timed out waiting for fire-and-forget injected prompt drain"));
          }, 250);
        }),
      ]);

      assert.ok(
        mainSends.find((m) => m.type === "result"),
        "main task settled even though injected prompt never returned",
      );
      assert.equal(mainCloses, 1, "main task closed exactly once");
      assert.equal(midTurn.registrations, 1, "mid-turn handler registered for the main attempt");
      assert.equal(midTurn.clears, 1, "mid-turn handler cleared after the main attempt");

      const injectedCalls = control.promptCalls.filter((c) => c.kind === "injected");
      assert.equal(injectedCalls.length, 1, "fire-and-forget injected prompt was still sent");
      assert.deepEqual(injectedSends, [], "fire-and-forget injected task sent no result/error");
      assert.equal(injectedCloses, 0, "pending fire-and-forget task was not double-closed");
    });
  });
}

// #1 root fix (bugs/stuck-red-turn-end-not-persisted): a Claude backend's
// `--no-wait` (waitForCompletion:false) injected prompt that returns a terminal
// MUST now be AWAITED by the turn — so its output folds into the record and its
// delivery terminal is written before the turn finalizes. Asserts the turn does
// NOT finalize while the injected prompt is still in flight, and DOES once it
// returns its terminal. (Pre-fix, the turn finalized immediately and the
// injected output/terminal were lost — the "stuck red" bug.)
async function runClaudeNoWaitInjectionIsAwaitedScenario(): Promise<void> {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      // Claude backend ⇒ injectionReturnsTerminalResponse ⇒ awaited.
      const record = makeSessionRecord(homeDir, "node /opt/claude-agent-acp/dist/index.js");
      await writeSessionRecordFile(homeDir, record);

      const injectionInitiated = createDeferred<void>();
      // The injected prompt resolves with a terminal only when the test releases
      // it, so we can observe whether the turn waits for it.
      const injectedRelease = createDeferred<PromptResponse>();

      const control = makeMockClient({
        onMainPrompt: async () => {
          await injectionInitiated.promise;
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => {
          injectionInitiated.resolve();
          return await injectedRelease.promise;
        },
      });

      const injectedSends: QueueOwnerMessage[] = [];
      let injectedCloses = 0;
      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          const injectedTask = makeQueueTask(
            "req-claude-nowait-injected",
            INJECTED_PROMPT_TEXT,
            (message) => injectedSends.push(message),
            () => {
              injectedCloses += 1;
            },
            false, // waitForCompletion:false — the UI/board --no-wait path.
          );
          queueMicrotask(() => {
            ctrl.currentHandler?.(injectedTask);
          });
        }
      });

      const mainSends: QueueOwnerMessage[] = [];
      let mainCloses = 0;
      const mainTask = makeQueueTask(
        "req-main-claude-nowait",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {
          mainCloses += 1;
        },
      );

      const runPromise = runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        setMidTurnHandler: midTurn.setMidTurnHandler,
        suppressSdkConsoleErrors: true,
      });

      // With the injected prompt still in flight, the turn must NOT finalize —
      // it is awaiting the drain. (250 ms is the same window the fire-and-forget
      // scenario uses to prove the opposite for a non-awaited backend.)
      const phase = await Promise.race([
        runPromise.then(() => "finalized" as const),
        new Promise<"still-draining">((resolve) =>
          setTimeout(() => resolve("still-draining"), 250),
        ),
      ]);
      assert.equal(
        phase,
        "still-draining",
        "Claude --no-wait injected prompt is awaited: the turn must not finalize while it is in flight",
      );

      // Release the injected terminal — the drain completes and the turn closes.
      injectedRelease.resolve({ stopReason: "end_turn" });
      await runPromise;

      assert.ok(
        mainSends.find((m) => m.type === "result"),
        "main task settled once the drain completed",
      );
      assert.equal(mainCloses, 1, "main task closed exactly once");
      const injectedCalls = control.promptCalls.filter((c) => c.kind === "injected");
      assert.equal(injectedCalls.length, 1, "injected prompt was sent exactly once");
      assert.equal(injectedCloses, 1, "awaited injected task closed exactly once");
      // waitForCompletion:false ⇒ the --no-wait contract is unchanged: no
      // result/error is sent back to the injected caller even though we awaited it.
      assert.deepEqual(
        injectedSends,
        [],
        "no-wait injected task sent no result/error (the --no-wait SEND contract is preserved)",
      );
    });
  });
}

// #1 non-regression (the regression the impl agent caught): a Codex backend
// steered mid-turn via `--no-wait` acts on the steer in-turn and returns NO
// terminal for the injected request, so it must STAY fire-and-forget — the turn
// finalizes promptly without awaiting it, and the backstop never engages. Same
// shape as runFireAndForgetInjectionWithoutTerminalResponseScenario but pinned
// to a real Codex command (not the unknown mock), proving the gate is by backend.
async function runCodexNoWaitInjectionStaysFireAndForgetScenario(): Promise<void> {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      // Codex backend ⇒ injectionReturnsTerminalResponse is false ⇒ not awaited.
      const record = makeSessionRecord(homeDir, "codex-acp");
      await writeSessionRecordFile(homeDir, record);

      const injectionInitiated = createDeferred<void>();
      const mainMessageId = "55555555-5555-4555-8555-555555555555";
      const injectedMessageId = "66666666-6666-4666-8666-666666666666";

      const control = makeMockClient({
        onMainPrompt: async () => {
          await injectionInitiated.promise;
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => {
          injectionInitiated.resolve();
          // Codex never returns a terminal for the injected steer.
          return await new Promise<PromptResponse>(() => {});
        },
      });

      const injectedSends: QueueOwnerMessage[] = [];
      let injectedCloses = 0;
      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          const injectedTask = makeQueueTask(
            "req-codex-nowait-injected",
            INJECTED_PROMPT_TEXT,
            (message) => injectedSends.push(message),
            () => {
              injectedCloses += 1;
            },
            false,
            injectedMessageId,
          );
          queueMicrotask(() => {
            ctrl.currentHandler?.(injectedTask);
          });
        }
      });

      const mainSends: QueueOwnerMessage[] = [];
      let mainCloses = 0;
      const mainTask = makeQueueTask(
        "req-main-codex-nowait",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {
          mainCloses += 1;
        },
        true,
        mainMessageId,
      );

      await Promise.race([
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          setMidTurnHandler: midTurn.setMidTurnHandler,
          suppressSdkConsoleErrors: true,
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("Codex --no-wait steer must not block turn finalization"));
          }, 250);
        }),
      ]);

      assert.ok(
        mainSends.find((m) => m.type === "result"),
        "Codex turn finalized promptly despite the injected steer never returning a terminal",
      );
      assert.equal(mainCloses, 1, "main task closed exactly once");
      const injectedCalls = control.promptCalls.filter((c) => c.kind === "injected");
      assert.equal(injectedCalls.length, 1, "Codex injected steer was still sent");
      assert.equal(injectedCalls[0]?.messageId, injectedMessageId);
      assert.deepEqual(injectedSends, [], "Codex fire-and-forget steer sent no result/error");
      assert.equal(injectedCloses, 1, "absorbed Codex steer was closed exactly once");

      const streamEvents = await listSessionEvents(record.acpxRecordId);
      assert.deepEqual(turnPhases(streamEvents), ["active", "idle"]);
      const deliveryEvents = deliveryEventParams(streamEvents);
      assert.deepEqual(
        deliveryEvents.map(({ at: _at, ...params }) => params),
        [
          {
            messageId: mainMessageId,
            requestId: "req-main-codex-nowait",
            phase: "accepted",
            stopReason: null,
            error: { code: 0, message: "", detailCode: "" },
          },
          {
            messageId: injectedMessageId,
            requestId: "req-codex-nowait-injected",
            phase: "accepted",
            stopReason: null,
            error: { code: 0, message: "", detailCode: "" },
          },
          {
            messageId: injectedMessageId,
            requestId: "req-codex-nowait-injected",
            phase: "done",
            stopReason: null,
            error: { code: 0, message: "", detailCode: "" },
          },
          {
            messageId: mainMessageId,
            requestId: "req-main-codex-nowait",
            phase: "done",
            stopReason: "end_turn",
            error: { code: 0, message: "", detailCode: "" },
          },
        ],
      );
      assert.equal(
        deliveryEvents.every((event) => typeof event.at === "string"),
        true,
      );
    });
  });
}

async function runCodexStackedNoWaitInjectionsGetTerminalsScenario(): Promise<void> {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir, "codex-acp");
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "77777777-7777-4777-8777-777777777777";
      const injectedMessageIdA = "88888888-8888-4888-8888-888888888888";
      const injectedMessageIdB = "99999999-9999-4999-8999-999999999999";
      const firstInjectionInitiated = createDeferred<void>();
      const bothInjectionsInitiated = createDeferred<void>();
      let injectedPromptCount = 0;

      const control = makeMockClient({
        onMainPrompt: async () => {
          await bothInjectionsInitiated.promise;
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => {
          injectedPromptCount += 1;
          if (injectedPromptCount === 1) {
            firstInjectionInitiated.resolve();
          }
          if (injectedPromptCount === 2) {
            bothInjectionsInitiated.resolve();
          }
          return await new Promise<PromptResponse>(() => {});
        },
      });

      let injectedCloses = 0;
      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          const firstInjectedTask = makeQueueTask(
            "req-codex-stacked-a",
            INJECTED_PROMPT_TEXT,
            () => {},
            () => {
              injectedCloses += 1;
            },
            false,
            injectedMessageIdA,
          );
          const secondInjectedTask = makeQueueTask(
            "req-codex-stacked-b",
            INJECTED_PROMPT_TEXT,
            () => {},
            () => {
              injectedCloses += 1;
            },
            false,
            injectedMessageIdB,
          );
          queueMicrotask(() => {
            ctrl.currentHandler?.(firstInjectedTask);
            void firstInjectionInitiated.promise.then(() => {
              ctrl.currentHandler?.(secondInjectedTask);
            });
          });
        }
      });

      const mainTask = makeQueueTask(
        "req-main-codex-stacked",
        MAIN_PROMPT_TEXT,
        () => {},
        () => {},
        true,
        mainMessageId,
      );

      await runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        setMidTurnHandler: midTurn.setMidTurnHandler,
        suppressSdkConsoleErrors: true,
      });

      const injectedCalls = control.promptCalls.filter((c) => c.kind === "injected");
      assert.equal(injectedCalls.length, 2, "both stacked Codex steers were sent");
      assert.equal(injectedCloses, 2, "both absorbed Codex steers were closed exactly once");

      const streamEvents = await listSessionEvents(record.acpxRecordId);
      assert.deepEqual(deliveryEventSummaries(streamEvents), [
        {
          messageId: mainMessageId,
          requestId: "req-main-codex-stacked",
          phase: "accepted",
          stopReason: null,
        },
        {
          messageId: injectedMessageIdA,
          requestId: "req-codex-stacked-a",
          phase: "accepted",
          stopReason: null,
        },
        {
          messageId: injectedMessageIdB,
          requestId: "req-codex-stacked-b",
          phase: "accepted",
          stopReason: null,
        },
        {
          messageId: injectedMessageIdA,
          requestId: "req-codex-stacked-a",
          phase: "done",
          stopReason: null,
        },
        {
          messageId: injectedMessageIdB,
          requestId: "req-codex-stacked-b",
          phase: "done",
          stopReason: null,
        },
        {
          messageId: mainMessageId,
          requestId: "req-main-codex-stacked",
          phase: "done",
          stopReason: "end_turn",
        },
      ]);
    });
  });
}

async function runCodexNoWaitInjectionFailsWithContainingTurnScenario(): Promise<void> {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir, "codex-acp");
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const injectedMessageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const injectionInitiated = createDeferred<void>();

      const control = makeMockClient({
        onMainPrompt: async () => {
          await injectionInitiated.promise;
          throw new Error("containing turn failed");
        },
        onInjectedPrompt: async () => {
          injectionInitiated.resolve();
          return await new Promise<PromptResponse>(() => {});
        },
      });

      let injectedCloses = 0;
      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          const injectedTask = makeQueueTask(
            "req-codex-failed-injected",
            INJECTED_PROMPT_TEXT,
            () => {},
            () => {
              injectedCloses += 1;
            },
            false,
            injectedMessageId,
          );
          queueMicrotask(() => {
            ctrl.currentHandler?.(injectedTask);
          });
        }
      });

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-main-codex-failed",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
        true,
        mainMessageId,
      );

      await runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        setMidTurnHandler: midTurn.setMidTurnHandler,
        suppressSdkConsoleErrors: true,
      });

      assert.equal(
        mainSends.some((message) => message.type === "result"),
        false,
        "main task did not report success after the containing turn failed",
      );
      assert.equal(injectedCloses, 1, "failed containing turn closed the absorbed steer");
      const streamEvents = await listSessionEvents(record.acpxRecordId);
      assert.deepEqual(deliveryEventSummaries(streamEvents), [
        {
          messageId: mainMessageId,
          requestId: "req-main-codex-failed",
          phase: "accepted",
          stopReason: null,
        },
        {
          messageId: injectedMessageId,
          requestId: "req-codex-failed-injected",
          phase: "accepted",
          stopReason: null,
        },
        {
          messageId: injectedMessageId,
          requestId: "req-codex-failed-injected",
          phase: "failed",
          stopReason: null,
        },
        {
          messageId: mainMessageId,
          requestId: "req-main-codex-failed",
          phase: "failed",
          stopReason: null,
        },
      ]);
    });
  });
}

// One standing test covering both injection scenarios: injection during the
// active turn on attempt 0 (drained across a failed-then-retried turn),
// injection during the retried attempt itself (the core fork guard), and a
// Codex ACP fire-and-forget injection that never returns a terminal response.
// Kept as a single test so the scenarios share the same isolated, sequential
// run.
test("mid-turn prompt injection fires and settles exactly once, including across a retry", async () => {
  await runAttempt0InjectionScenario();
  await runRetryInjectionScenario();
  await runFireAndForgetInjectionWithoutTerminalResponseScenario();
});

// #1 root fix + non-regression, gated by backend (bugs/stuck-red-turn-end-not-
// persisted): a Claude `--no-wait` injected prompt (returns a terminal) is now
// AWAITED so its output/terminal land before the turn finalizes; a Codex
// `--no-wait` steer (returns no terminal) stays fire-and-forget so the turn
// still finalizes promptly. Kept as one sequential test for isolation.
test("backend-gated mid-turn injection: Claude --no-wait is awaited, Codex stays fire-and-forget", async () => {
  await runClaudeNoWaitInjectionIsAwaitedScenario();
  await runCodexNoWaitInjectionStaysFireAndForgetScenario();
  await runCodexStackedNoWaitInjectionsGetTerminalsScenario();
  await runCodexNoWaitInjectionFailsWithContainingTurnScenario();
});

// Gate wiring: the claude-pty bridge command must now opt a session into
// mid-turn injection, exactly as the queue owner derives it
// (queue-owner-runtime.ts: midTurnInjectionSupported =
// supportsMidTurnPromptInjection(sessionRecord.agentCommand), then passed as
// setMidTurnHandler to runSessionPrompt). This test mirrors that derivation for
// a bridge session and asserts a mid-turn task actually routes through the
// injection handler (concurrent client.prompt), rather than being serialized
// behind the active turn. Guards the A.i gate flip from regressing.
test("claude-pty bridge session opts into mid-turn injection and routes a mid-turn task through the handler", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const bridgeCommand = "node /opt/claude-pty-acp/dist/index.js";
      const record = makeSessionRecord(homeDir, bridgeCommand);
      await writeSessionRecordFile(homeDir, record);

      // The exact gate the queue owner consults to decide whether to register
      // the mid-turn handler for this session's adapter.
      const midTurnInjectionSupported = supportsMidTurnPromptInjection(record.agentCommand);
      assert.equal(
        midTurnInjectionSupported,
        true,
        "claude-pty bridge command must support mid-turn injection",
      );

      const injectionInitiated = createDeferred<void>();
      const control = makeMockClient({
        onMainPrompt: async () => {
          await injectionInitiated.promise;
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => {
          injectionInitiated.resolve();
          return { stopReason: "end_turn" };
        },
      });

      const injectedSends: QueueOwnerMessage[] = [];
      let injectedCloses = 0;
      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          const injectedTask = makeQueueTask(
            "req-injected-bridge",
            INJECTED_PROMPT_TEXT,
            (message) => injectedSends.push(message),
            () => {
              injectedCloses += 1;
            },
          );
          queueMicrotask(() => {
            ctrl.currentHandler?.(injectedTask);
          });
        }
      });

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-main-bridge",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
      );

      await runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        // Mirror queue-owner-runtime.ts:591 — the handler is wired only because
        // the gate (A.i) reports the bridge supports injection.
        setMidTurnHandler: midTurnInjectionSupported ? midTurn.setMidTurnHandler : undefined,
        suppressSdkConsoleErrors: true,
      });

      assert.ok(
        mainSends.find((m) => m.type === "result"),
        "main task settled with a result",
      );
      assert.equal(midTurn.registrations, 1, "mid-turn handler registered for the bridge session");

      const injectedCalls = control.promptCalls.filter((c) => c.kind === "injected");
      assert.equal(injectedCalls.length, 1, "mid-turn task routed through the injection handler");
      const injectedResults = injectedSends.filter((m) => m.type === "result");
      assert.equal(injectedResults.length, 1, "injected task settled exactly once");
      assert.equal(injectedResults[0]?.requestId, "req-injected-bridge");
      assert.equal(injectedCloses, 1, "injected task closed exactly once");
    });
  });
});

test("runQueuedTask emits active before prompt execution and idle after completion", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      let activeSeenInsidePrompt = false;
      const control = makeMockClient({
        onMainPrompt: async () => {
          const events = await listSessionEvents(record.acpxRecordId);
          const phases = turnPhases(events);
          assert.deepEqual(phases, ["active"]);
          const turnParams = eventParams(
            events.find((event) => eventMethod(event) === "acpx/turn"),
          );
          assert.equal(turnParams.sessionId, record.acpxRecordId);
          assert.equal(typeof turnParams.at, "string");
          activeSeenInsidePrompt = true;
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => ({ stopReason: "end_turn" }),
      });

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-turn-markers",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
      );

      await runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        suppressSdkConsoleErrors: true,
      });

      assert.equal(activeSeenInsidePrompt, true);
      assert.ok(mainSends.find((message) => message.type === "result"));

      const events = await listSessionEvents(record.acpxRecordId);
      assert.deepEqual(turnPhases(events), ["active", "idle"]);
      const idleParams = eventParams(
        events.findLast((event) => eventMethod(event) === "acpx/turn"),
      );
      assert.equal(idleParams.sessionId, record.acpxRecordId);
      assert.equal(typeof idleParams.at, "string");
    });
  });
});

test("idle marker waits for pending mid-turn injected prompt drain", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const injectionInitiated = createDeferred<void>();
      const mainReturned = createDeferred<void>();
      const injectedResponse = createDeferred<PromptResponse>();
      const mainMessageId = "33333333-3333-4333-8333-333333333333";
      const injectedMessageId = "44444444-4444-4444-8444-444444444444";
      const control = makeMockClient({
        onMainPrompt: async () => {
          await injectionInitiated.promise;
          mainReturned.resolve();
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => {
          injectionInitiated.resolve();
          return await injectedResponse.promise;
        },
      });

      const injectedSends: QueueOwnerMessage[] = [];
      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          const injectedTask = makeQueueTask(
            "req-injected-turn-marker",
            INJECTED_PROMPT_TEXT,
            (message) => injectedSends.push(message),
            () => {},
            true,
            injectedMessageId,
          );
          queueMicrotask(() => {
            ctrl.currentHandler?.(injectedTask);
          });
        }
      });

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-main-turn-marker",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
        true,
        mainMessageId,
      );

      const runPromise = runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        setMidTurnHandler: midTurn.setMidTurnHandler,
        suppressSdkConsoleErrors: true,
      });

      await mainReturned.promise;
      await tick();
      try {
        const eventsBeforeInjectedDrain = await listSessionEvents(record.acpxRecordId);
        assert.deepEqual(turnPhases(eventsBeforeInjectedDrain), ["active"]);
        assert.equal(
          mainSends.find((message) => message.type === "result"),
          undefined,
          "main result must wait for injected prompt drain",
        );
      } finally {
        injectedResponse.resolve({ stopReason: "end_turn" });
      }

      await runPromise;

      assert.ok(mainSends.find((message) => message.type === "result"));
      assert.ok(injectedSends.find((message) => message.type === "result"));

      const events = await listSessionEvents(record.acpxRecordId);
      assert.deepEqual(turnPhases(events), ["active", "idle"]);
      const idleIndex = events.findLastIndex((event) => eventMethod(event) === "acpx/turn");
      const lastDeliveryIndex = events.findLastIndex(
        (event) => eventMethod(event) === "acpx/delivery",
      );
      assert.ok(lastDeliveryIndex >= 0);
      assert.ok(idleIndex > lastDeliveryIndex);
    });
  });
});

test("mid-turn prompt injection threads messageId and emits delivery events", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "11111111-1111-4111-8111-111111111111";
      const injectedMessageId = "22222222-2222-4222-8222-222222222222";
      const injectionInitiated = createDeferred<void>();

      const control = makeMockClient({
        onMainPrompt: async () => {
          await injectionInitiated.promise;
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => {
          injectionInitiated.resolve();
          return { stopReason: "end_turn" };
        },
      });

      const injectedSends: QueueOwnerMessage[] = [];
      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          const injectedTask = makeQueueTask(
            "req-injected-delivery",
            INJECTED_PROMPT_TEXT,
            (message) => injectedSends.push(message),
            () => {},
            true,
            injectedMessageId,
          );
          setTimeout(() => {
            ctrl.currentHandler?.(injectedTask);
          }, 10);
        }
      });

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-main-delivery",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
        true,
        mainMessageId,
      );

      await runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        setMidTurnHandler: midTurn.setMidTurnHandler,
        suppressSdkConsoleErrors: true,
      });

      assert.ok(mainSends.find((m) => m.type === "result"));
      assert.ok(injectedSends.find((m) => m.type === "result"));

      const mainCalls = control.promptCalls.filter((c) => c.kind === "main");
      const injectedCalls = control.promptCalls.filter((c) => c.kind === "injected");
      assert.equal(mainCalls.length, 1);
      assert.equal(injectedCalls.length, 1);
      assert.equal(mainCalls[0]?.messageId, mainMessageId);
      assert.equal(injectedCalls[0]?.messageId, injectedMessageId);

      const stored = await resolveSessionRecord(record.acpxRecordId);
      const userIds = stored.messages.flatMap((message) => {
        if (typeof message !== "object" || message === null || !("User" in message)) {
          return [];
        }
        return [message.User.id];
      });
      assert.deepEqual(userIds, [mainMessageId, injectedMessageId]);
      assert.equal(typeof stored.lastPromptAt, "string");

      const streamEvents = await listSessionEvents(record.acpxRecordId);
      assert.deepEqual(turnPhases(streamEvents), ["active", "idle"]);
      const idleIndex = streamEvents.findLastIndex((event) => eventMethod(event) === "acpx/turn");
      const lastDeliveryIndex = streamEvents.findLastIndex(
        (event) => eventMethod(event) === "acpx/delivery",
      );
      assert.ok(
        idleIndex > lastDeliveryIndex,
        "idle marker must be emitted after main and injected delivery events drain",
      );

      const deliveryEvents = deliveryEventParams(streamEvents);

      assert.deepEqual(
        deliveryEvents.map(({ at: _at, ...params }) => params),
        [
          {
            messageId: mainMessageId,
            requestId: "req-main-delivery",
            phase: "accepted",
            stopReason: null,
            error: { code: 0, message: "", detailCode: "" },
          },
          {
            messageId: injectedMessageId,
            requestId: "req-injected-delivery",
            phase: "accepted",
            stopReason: null,
            error: { code: 0, message: "", detailCode: "" },
          },
          {
            messageId: injectedMessageId,
            requestId: "req-injected-delivery",
            phase: "done",
            stopReason: "end_turn",
            error: { code: 0, message: "", detailCode: "" },
          },
          {
            messageId: mainMessageId,
            requestId: "req-main-delivery",
            phase: "done",
            stopReason: "end_turn",
            error: { code: 0, message: "", detailCode: "" },
          },
        ],
      );
      assert.equal(
        deliveryEvents.every((event) => typeof event.at === "string"),
        true,
      );
    });
  });
});
