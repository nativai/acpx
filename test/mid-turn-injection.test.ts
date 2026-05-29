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
//     tracks the promise so the turn can await it.
//   - `drainInjectedPrompts()` clears the handler and awaits all in-flight
//     injected prompts before the turn settles (on both the success and the
//     failure/retry paths).
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
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { type PromptInput, textPrompt } from "../src/prompt-content.js";
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
type PromptCall = { kind: "main" | "injected"; sessionId: string; attempt: number };

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

    prompt: (sessionId: string, input: PromptInput | string): Promise<PromptResponse> => {
      const text = promptText(input);
      if (text === INJECTED_PROMPT_TEXT) {
        control.promptCalls.push({ kind: "injected", sessionId, attempt: control.activeAttempt });
        return handlers.onInjectedPrompt(sessionId);
      }
      const attempt = nextMainAttempt;
      nextMainAttempt += 1;
      control.activeAttempt = attempt;
      control.promptCalls.push({ kind: "main", sessionId, attempt });
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
): QueueTask {
  return {
    requestId,
    message: text,
    prompt: textPrompt(text),
    permissionMode: "approve-all",
    timeoutMs: 10_000,
    waitForCompletion: true,
    enqueuedAt: Date.now(),
    send: onSend,
    close: onClose,
  } satisfies QueueTask;
}

function makeSessionRecord(cwd: string): SessionRecord {
  return makeSessionRecordFixture(
    {
      acpxRecordId: "mid-turn-injection",
      acpSessionId: "mid-turn-injection-session",
      agentCommand: "node mock-agent.js",
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

// One standing test covering both injection scenarios: injection during the
// active turn on attempt 0 (drained across a failed-then-retried turn), and
// injection during the retried attempt itself (the core fork guard). Kept as a
// single test so the two scenarios share the same isolated, sequential run.
test("mid-turn prompt injection fires and settles exactly once, including across a retry", async () => {
  await runAttempt0InjectionScenario();
  await runRetryInjectionScenario();
});
