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
import { terminalizeAbsorbedDeliveriesOnOwnerExit } from "../src/cli/session/absorbed-delivery-registry.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { type PromptInput, textPrompt } from "../src/prompt-content.js";
import { listSessionEvents } from "../src/session/events.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";
import {
  CLAUDE_AGENT_COMMAND,
  CODEX_AGENT_COMMAND,
  cancelResolvesPrompt,
  makePathologicalClient,
  neverRespondIgnoresCancel,
} from "./pathological-adapter-helpers.js";
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
    // Only touched on the terminal-failure path (failRuntimePrompt); undefined is fine.
    getEffectiveAccountMetadata: () => undefined,

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

      await withRaceTimeout(
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          setMidTurnHandler: midTurn.setMidTurnHandler,
          suppressSdkConsoleErrors: true,
        }),
        TURN_MUST_NOT_BLOCK_MS,
        "PRODUCT REGRESSION: the turn never finalized — it is still awaiting a fire-and-forget injected prompt that returns no terminal by design. A healthy turn finalizes in milliseconds; this is not a slow box.",
      );

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

      await withRaceTimeout(
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          setMidTurnHandler: midTurn.setMidTurnHandler,
          suppressSdkConsoleErrors: true,
        }),
        TURN_MUST_NOT_BLOCK_MS,
        "PRODUCT REGRESSION: a Codex --no-wait steer BLOCKED turn finalization — the absorbed injection was awaited, and it never returns a terminal by design, so the turn is wedged until the drain backstop. A healthy turn finalizes in milliseconds; this is not a slow box.",
      );

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

test("runQueuedTask emits subscription and effort in acpx/turn params", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecordFixture(
        {
          acpxRecordId: "turn-attribution-test",
          acpSessionId: "turn-attribution-session",
          agentCommand: "node mock-agent.js",
          cwd: homeDir,
          acpx: {
            session_options: { profile: "sub2" },
            desired_config_options: { effort: "high" },
          },
        },
        { defaultName: false },
      );
      await writeSessionRecordFile(homeDir, record);

      let activeSeenInsidePrompt = false;
      const control = makeMockClient({
        onMainPrompt: async () => {
          const events = await listSessionEvents(record.acpxRecordId);
          const activeEvent = events.find((event) => eventMethod(event) === "acpx/turn");
          const turnParams = eventParams(activeEvent);
          assert.equal(turnParams.subscription, "sub2");
          assert.equal(turnParams.effort, "high");
          activeSeenInsidePrompt = true;
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => ({ stopReason: "end_turn" }),
      });

      const mainTask = makeQueueTask(
        "req-turn-attribution",
        MAIN_PROMPT_TEXT,
        () => {},
        () => {},
      );

      await runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        suppressSdkConsoleErrors: true,
      });

      assert.equal(activeSeenInsidePrompt, true);

      const events = await listSessionEvents(record.acpxRecordId);
      const idleParams = eventParams(
        events.findLast((event) => eventMethod(event) === "acpx/turn"),
      );
      assert.equal(idleParams.subscription, "sub2");
      assert.equal(idleParams.effort, "high");
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

test("runQueuedTask deduplicates a repeated messageId before invoking the agent", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const messageId = "33333333-3333-4333-8333-333333333333";
      const control = makeMockClient({
        onMainPrompt: async () => ({ stopReason: "end_turn" }),
        onInjectedPrompt: async () => {
          throw new Error("unexpected injected prompt");
        },
      });

      const firstSends: QueueOwnerMessage[] = [];
      const firstTask = makeQueueTask(
        "req-first-delivery",
        MAIN_PROMPT_TEXT,
        (message) => firstSends.push(message),
        () => {},
        true,
        messageId,
      );
      await runQueuedTask(record.acpxRecordId, firstTask, {
        sharedClient: control.client,
        suppressSdkConsoleErrors: true,
      });

      const duplicateSends: QueueOwnerMessage[] = [];
      const duplicateTask = makeQueueTask(
        "req-duplicate-delivery",
        "duplicate should not run",
        (message) => duplicateSends.push(message),
        () => {},
        true,
        messageId,
      );
      await runQueuedTask(record.acpxRecordId, duplicateTask, {
        sharedClient: control.client,
        suppressSdkConsoleErrors: true,
      });

      assert.ok(firstSends.find((message) => message.type === "result"));
      assert.ok(duplicateSends.find((message) => message.type === "result"));
      assert.equal(control.promptCalls.filter((call) => call.kind === "main").length, 1);

      const stored = await resolveSessionRecord(record.acpxRecordId);
      const userIds = stored.messages.flatMap((message) => {
        if (typeof message !== "object" || message === null || !("User" in message)) {
          return [];
        }
        return [message.User.id];
      });
      assert.deepEqual(userIds, [messageId]);

      const streamEvents = await listSessionEvents(record.acpxRecordId);
      assert.deepEqual(deliveryEventSummaries(streamEvents), [
        {
          messageId,
          requestId: "req-first-delivery",
          phase: "accepted",
          stopReason: null,
        },
        {
          messageId,
          requestId: "req-first-delivery",
          phase: "done",
          stopReason: "end_turn",
        },
        {
          messageId,
          requestId: "req-duplicate-delivery",
          phase: "done",
          stopReason: "deduplicated",
        },
      ]);
    });
  });
});

test("runQueuedTask does not deduplicate a messageId whose first turn failed before completing", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const messageId = "44444444-4444-4444-8444-444444444444";
      const control = makeMockClient({
        // First delivery (attempt 0) fails before producing output — the User
        // message is persisted by recordPromptStart, but no real phase:"done" is
        // written (the b94c0828 specimen). The resend (attempt 1) succeeds.
        onMainPrompt: async (attempt) => {
          if (attempt === 0) {
            throw new Error("turn failed before output");
          }
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => {
          throw new Error("unexpected injected prompt");
        },
      });

      const firstSends: QueueOwnerMessage[] = [];
      const firstTask = makeQueueTask(
        "req-first-delivery",
        MAIN_PROMPT_TEXT,
        (message) => firstSends.push(message),
        () => {},
        true,
        messageId,
      );
      await runQueuedTask(record.acpxRecordId, firstTask, {
        sharedClient: control.client,
        suppressSdkConsoleErrors: true,
      });

      // The first turn failed: an error result was sent, not a success.
      assert.ok(firstSends.find((message) => message.type === "error"));

      const resendSends: QueueOwnerMessage[] = [];
      const resendTask = makeQueueTask(
        "req-resend-delivery",
        MAIN_PROMPT_TEXT,
        (message) => resendSends.push(message),
        () => {},
        true,
        messageId,
      );
      await runQueuedTask(record.acpxRecordId, resendTask, {
        sharedClient: control.client,
        suppressSdkConsoleErrors: true,
      });

      // The resend actually re-ran the agent (2 main calls) — it was NOT deduped.
      assert.equal(control.promptCalls.filter((call) => call.kind === "main").length, 2);
      assert.ok(resendSends.find((message) => message.type === "result"));

      const streamEvents = await listSessionEvents(record.acpxRecordId);
      const deliveries = deliveryEventSummaries(streamEvents);
      // The first delivery terminated failed; the resend terminated with a real
      // completion — and NOTHING was reported as a dedup echo.
      assert.ok(
        deliveries.some(
          (event) => event.requestId === "req-first-delivery" && event.phase === "failed",
        ),
        "first delivery must terminate failed",
      );
      assert.ok(
        deliveries.some(
          (event) =>
            event.requestId === "req-resend-delivery" &&
            event.phase === "done" &&
            event.stopReason === "end_turn",
        ),
        "resend must run a real turn, not dedup to done",
      );
      assert.equal(
        deliveries.some((event) => event.stopReason === "deduplicated"),
        false,
        "a failed-before-turn prompt must never be reported as deduplicated",
      );
    });
  });
});

// --- C1: turn-completion watchdog (brick 87edf583, FIX-DESIGN §2.1) ----------
// These extend the in-process mid-turn-injection harness with the scripted
// pathological adapter (test/pathological-adapter-helpers.ts): a Claude backend
// that emits its end-of-turn marker through the SAME production session-update
// tap the watchdog listens on, while withholding the client.prompt() response —
// the exact acpx-observable shape of the RCA §1.2 routing hole. The TE reuses
// those helpers against the real adapter process (see TESTER-PLAN.md).

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
  // The timer is CLEARED once the awaited promise settles. Without that, every
  // race leaves a live timer holding the event loop open for the rest of its
  // window after the test has already passed — which is what forces deadlines
  // to be chosen small, and small wall-clock deadlines are what make these
  // tests load-sensitive. Clearing it makes a generous deadline free, so the
  // deadline can be set where it only fires on real misbehaviour. It stays
  // REF'd (not `unref`'d) on purpose: a genuinely wedged turn must fail the
  // test, not let the process exit quietly with the assertions unrun.
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

// "This turn must not block on an injected steer that never returns a terminal."
//
// That property is BINARY, not a continuum: a healthy turn finalizes in
// milliseconds, while a regressed one awaits a promise that never settles and
// so hangs until the 30-minute drain backstop. There is no legitimate middle
// ground where a turn takes seconds for an honest reason, which means the
// deadline should sit far above box noise rather than near it.
//
// It previously sat at 250 ms and reproduced ~1 failure in 20 runs on a box at
// load 5-12 — a timeout-class red that says nothing about the product and
// teaches the next agent to re-run instead of read. At 30 s, losing the race
// genuinely means the turn is wedged.
const TURN_MUST_NOT_BLOCK_MS = 30_000;

function terminalsForMessage(events: unknown[], messageId: string): Record<string, unknown>[] {
  return deliveryEventSummaries(events).filter(
    (event) => event.messageId === messageId && event.phase !== "accepted",
  );
}

// C1 tier-1: the SDK turn ended (marker seen) but the response is withheld; the
// tier-1 cancel nudge settles it. Our own nudge yields `cancelled`, yet the
// marker said end_turn, so the delivery terminal reconciles to the semantic
// completion (Q2). Exactly one terminal for the messageId.
test("C1 watchdog: tier-1 cancel recovers a withheld, marker-ended turn with Q2 semantic done/end_turn", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir, CLAUDE_AGENT_COMMAND);
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "c1a11111-1111-4111-8111-111111111111";
      const control = makePathologicalClient({ acpSessionId: record.acpSessionId });
      cancelResolvesPrompt(control, "cancelled");

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-c1-tier1",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
        true,
        mainMessageId,
      );

      const run = withTurnResponseTimeout(40, () =>
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          suppressSdkConsoleErrors: true,
        }),
      );

      await control.mainPromptInFlight;
      await tick();
      control.emitTurnEndMarker("end_turn");
      await withRaceTimeout(run, 3_000, "tier-1 did not recover the withheld turn");

      assert.ok(
        mainSends.find((m) => m.type === "result"),
        "turn finalized after tier-1 recovery",
      );
      assert.ok(control.cancelCount() >= 1, "tier-1 issued at least one cancel nudge");

      const terminals = terminalsForMessage(
        await listSessionEvents(record.acpxRecordId),
        mainMessageId,
      );
      assert.equal(terminals.length, 1, "exactly one terminal for the received messageId");
      assert.deepEqual(terminals[0], {
        messageId: mainMessageId,
        requestId: "req-c1-tier1",
        phase: "done",
        stopReason: "end_turn",
      });
    });
  });
});

// C1 tier-2 + the design's mandatory late-response guard: an adapter that emits
// the marker, never responds, and ignores cancel is bounded at tier 2 with a
// retryable TURN_RESPONSE_TIMEOUT failed terminal; the owner survives. When the
// abandoned client.prompt() finally settles AFTER tier-2, it must be inert — no
// duplicate terminal, no record clobber, no crash / unhandled rejection.
test("C1 watchdog: tier-2 bounds a never-responding turn (TURN_RESPONSE_TIMEOUT); a late response is inert", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir, CLAUDE_AGENT_COMMAND);
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "c1b22222-2222-4222-8222-222222222222";
      const control = makePathologicalClient({ acpSessionId: record.acpSessionId });
      neverRespondIgnoresCancel(control);

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-c1-tier2",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
        true,
        mainMessageId,
      );

      const run = withTurnResponseTimeout(40, () =>
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          suppressSdkConsoleErrors: true,
        }),
      );

      await control.mainPromptInFlight;
      await tick();
      control.emitTurnEndMarker("end_turn");
      await withRaceTimeout(run, 3_000, "tier-2 did not bound the never-responding turn");

      const errorMessage = mainSends.find((m) => m.type === "error") as
        | { detailCode?: string; retryable?: boolean }
        | undefined;
      assert.ok(errorMessage, "turn failed at the tier-2 bound");
      assert.equal(errorMessage?.detailCode, "TURN_RESPONSE_TIMEOUT");
      assert.equal(errorMessage?.retryable, true);

      const eventsBefore = await listSessionEvents(record.acpxRecordId);
      const terminalsBefore = terminalsForMessage(eventsBefore, mainMessageId);
      assert.equal(terminalsBefore.length, 1, "exactly one terminal at tier-2");
      assert.equal(terminalsBefore[0]?.phase, "failed");
      const recordBefore = await resolveSessionRecord(record.acpxRecordId);

      // The abandoned prompt finally settles AFTER tier-2 — the guard.
      control.resolveMainPrompt({ stopReason: "end_turn" });
      await new Promise((resolve) => setTimeout(resolve, 60));

      const terminalsAfter = terminalsForMessage(
        await listSessionEvents(record.acpxRecordId),
        mainMessageId,
      );
      assert.deepEqual(
        terminalsAfter,
        terminalsBefore,
        "no duplicate terminal from the late response",
      );
      const recordAfter = await resolveSessionRecord(record.acpxRecordId);
      assert.deepEqual(
        recordAfter.messages,
        recordBefore.messages,
        "the late response did not clobber the finalized record",
      );
    });
  });
});

// C1 safety: a turn that never emits an end-marker (genuinely long-running, live
// work) is NEVER truncated — the watchdog is strictly marker-gated. The response
// is withheld well past both tiers, yet the turn neither fails nor finalizes
// until it actually responds.
test("C1 watchdog: a turn with no end-marker is never truncated (marker-gated)", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir, CLAUDE_AGENT_COMMAND);
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "c1c33333-3333-4333-8333-333333333333";
      const control = makePathologicalClient({ acpSessionId: record.acpSessionId });

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-c1-nomark",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
        true,
        mainMessageId,
      );

      const run = withTurnResponseTimeout(40, () =>
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          suppressSdkConsoleErrors: true,
        }),
      );

      await control.mainPromptInFlight;
      await tick();
      // Well past both tiers (2 x 40ms) with NO marker emitted.
      await new Promise((resolve) => setTimeout(resolve, 240));
      assert.equal(
        mainSends.find((m) => m.type === "error"),
        undefined,
        "no premature failure without an end-marker",
      );
      assert.equal(
        mainSends.find((m) => m.type === "result"),
        undefined,
        "still in flight — the watchdog never fired",
      );

      control.resolveMainPrompt({ stopReason: "end_turn" });
      await run;

      assert.ok(
        mainSends.find((m) => m.type === "result"),
        "turn completes normally once it responds",
      );
      const terminals = terminalsForMessage(
        await listSessionEvents(record.acpxRecordId),
        mainMessageId,
      );
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0]?.phase, "done");
    });
  });
});

// --- C2 / C3: durable delivery terminals (FIX-DESIGN §2.2, §2.3) -------------

async function withInjectedDrainTimeout<T>(ms: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ACPX_INJECTED_DRAIN_TIMEOUT_MS;
  process.env.ACPX_INJECTED_DRAIN_TIMEOUT_MS = String(ms);
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.ACPX_INJECTED_DRAIN_TIMEOUT_MS;
    } else {
      process.env.ACPX_INJECTED_DRAIN_TIMEOUT_MS = previous;
    }
  }
}

function deliveryParamsForMessage(events: unknown[], messageId: string): Record<string, unknown>[] {
  return deliveryEventParams(events).filter((event) => event.messageId === messageId);
}

async function waitForDeliveryTerminal(
  sessionId: string,
  messageId: string,
  timeoutMs = 5_000,
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The stream file may be momentarily unreadable (ENOENT during a concurrent
    // write/rotation under load) — treat a read error as "not ready yet" and
    // retry, mirroring queue-ipc-server.test.ts's waitForStreamLines.
    let terminal: Record<string, unknown> | undefined;
    try {
      const events = await listSessionEvents(sessionId);
      terminal = deliveryParamsForMessage(events, messageId).find(
        (event) => event.phase !== "accepted",
      );
    } catch {
      terminal = undefined;
    }
    if (terminal || Date.now() > deadline) {
      return terminal;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// C3 (G2 completeness): a still-pending injected delivery gets an
// INJECTED_RESPONSE_TIMEOUT `failed` terminal written at backstop time — so no
// delivery is left accepted-forever. The main turn still ends `done`, and there
// is exactly one terminal per messageId.
test("C3: drain backstop writes an INJECTED_RESPONSE_TIMEOUT terminal for a still-pending injected delivery", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir, CLAUDE_AGENT_COMMAND);
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "c3aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const injectedMessageId = "c3bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      // The injected prompt signals when it is actually in flight (deterministic,
      // load-independent), then hangs forever.
      const injectedInFlight = createDeferred<void>();
      const control = makePathologicalClient({
        acpSessionId: record.acpSessionId,
        onInjectedPrompt: () => {
          injectedInFlight.resolve();
          return new Promise<never>(() => {});
        },
      });

      let injectedCloses = 0;
      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          const injectedTask = makeQueueTask(
            "req-c3-injected",
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
        "req-c3-main",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
        true,
        mainMessageId,
      );

      const run = withInjectedDrainTimeout(40, () =>
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          setMidTurnHandler: midTurn.setMidTurnHandler,
          suppressSdkConsoleErrors: true,
        }),
      );

      await control.mainPromptInFlight;
      // Deterministically wait until the injected prompt is actually in flight.
      await injectedInFlight.promise;
      // Main turn ends; the injected prompt is left pending → drain backstop fires.
      control.resolveMainPrompt({ stopReason: "end_turn" });
      await withRaceTimeout(run, 3_000, "drain backstop did not finalize the turn");

      const events = await listSessionEvents(record.acpxRecordId);
      assert.deepEqual(terminalsForMessage(events, mainMessageId), [
        {
          messageId: mainMessageId,
          requestId: "req-c3-main",
          phase: "done",
          stopReason: "end_turn",
        },
      ]);

      const injectedTerminals = terminalsForMessage(events, injectedMessageId);
      assert.equal(injectedTerminals.length, 1, "exactly one terminal for the injected messageId");
      assert.equal(injectedTerminals[0]?.phase, "failed");
      const injectedTerminalParams = deliveryParamsForMessage(events, injectedMessageId).find(
        (event) => event.phase === "failed",
      );
      assert.equal(
        (injectedTerminalParams?.error as { detailCode?: string } | undefined)?.detailCode,
        "INJECTED_RESPONSE_TIMEOUT",
      );
      // The injected IIFE is still hung (its response never came), so its own
      // finally never ran: C3 writes the terminal WITHOUT force-closing the hung
      // task. The delivery lifecycle is complete on the stream regardless.
      assert.equal(injectedCloses, 0, "the never-resolving injected IIFE remains pending");
    });
  });
});

// C2 (G2): a delivery terminal written AFTER the per-turn event writer closed
// (a fire-and-forget injected prompt that returns its terminal late, once the
// containing turn has finalized) must still land durably via a standalone
// writer — not be swallowed into accepted-forever. Modeled on an unknown backend
// (not awaited, not absorbed) so the late terminal is the injected IIFE's own
// write, exercising appendDeliveryEvent's closed-writer fallback directly.
test("C2: a delivery terminal written after the per-turn writer closed still lands (standalone-writer fallback)", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      // Default (unknown) backend ⇒ injected prompt is fire-and-forget: not
      // awaited by the turn, so it settles after finalization.
      const record = makeSessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const injectedMessageId = "c2cccccc-cccc-4ccc-8ccc-cccccccccccc";
      const injectedRelease = createDeferred<{ stopReason: "end_turn" }>();
      const injectedInFlight = createDeferred<void>();
      const control = makePathologicalClient({
        acpSessionId: record.acpSessionId,
        onInjectedPrompt: () => {
          injectedInFlight.resolve();
          return injectedRelease.promise as Promise<never>;
        },
      });

      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          const injectedTask = makeQueueTask(
            "req-c2-injected",
            INJECTED_PROMPT_TEXT,
            () => {},
            () => {},
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
        "req-c2-main",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
        true,
        "c2mmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm",
      );

      const run = runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        setMidTurnHandler: midTurn.setMidTurnHandler,
        suppressSdkConsoleErrors: true,
      });

      await control.mainPromptInFlight;
      // Deterministically wait until the injected prompt is actually in flight.
      await injectedInFlight.promise;

      // Main turn ends and finalizes (the fire-and-forget injected is NOT awaited),
      // closing the per-turn event writer.
      control.resolveMainPrompt({ stopReason: "end_turn" });
      await run;
      assert.ok(
        mainSends.find((m) => m.type === "result"),
        "main turn finalized",
      );

      // The injected prompt now returns its terminal — AFTER the writer closed.
      injectedRelease.resolve({ stopReason: "end_turn" });

      const terminal = await waitForDeliveryTerminal(record.acpxRecordId, injectedMessageId);
      assert.ok(terminal, "the post-close injected terminal landed durably (not swallowed)");
      assert.equal(terminal?.phase, "done");
      assert.equal(terminal?.stopReason, "end_turn");
      const terminals = terminalsForMessage(
        await listSessionEvents(record.acpxRecordId),
        injectedMessageId,
      );
      assert.equal(terminals.length, 1, "exactly one terminal for the injected messageId");
    });
  });
});

// --- 493729fc F2/F3/F4: codex delivery-lifecycle hardening -------------------
// The codex analogues of the C-lane: the adapter's minted-turn-id contract
// violation (RCA 493729fc §3) wedges a main prompt forever and leaves absorbed
// steers accepted-without-terminal. F1 (codex-acp) fixes the adapter; these pin
// the acpx defense layers: the C1 watchdog armed by the codex end-of-turn
// marker (F2), owner-exit terminals for absorbed deliveries (F3), and wait-mode
// codex injections that no longer hold the turn open (F4).

// F2 tier-2: a codex main prompt that never responds while the adapter's
// `_codex/lastTurnEndReason` marker proves the turn ended is bounded at tier 2
// with the retryable TURN_RESPONSE_TIMEOUT failure — the 8-hour wedge class.
test("493729fc F2: codex watchdog tier-2 bounds a never-responding main turn via the _codex marker", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir, CODEX_AGENT_COMMAND);
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "f2a11111-1111-4111-8111-111111111111";
      const control = makePathologicalClient({ acpSessionId: record.acpSessionId });
      neverRespondIgnoresCancel(control);

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-f2-codex-tier2",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
        true,
        mainMessageId,
      );

      const run = withTurnResponseTimeout(40, () =>
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          suppressSdkConsoleErrors: true,
        }),
      );

      await control.mainPromptInFlight;
      await tick();
      control.emitCodexTurnEndMarker("end_turn");
      await withRaceTimeout(run, 3_000, "tier-2 did not bound the wedged codex turn");

      const errorMessage = mainSends.find((m) => m.type === "error") as
        | { detailCode?: string; retryable?: boolean }
        | undefined;
      assert.ok(errorMessage, "wedged codex turn failed at the tier-2 bound");
      assert.equal(errorMessage?.detailCode, "TURN_RESPONSE_TIMEOUT");
      assert.equal(errorMessage?.retryable, true);

      const terminals = terminalsForMessage(
        await listSessionEvents(record.acpxRecordId),
        mainMessageId,
      );
      assert.equal(terminals.length, 1, "exactly one terminal for the wedged main");
      assert.equal(terminals[0]?.phase, "failed");
    });
  });
});

// F2 safety: a codex turn with NO marker is never truncated — arming is strictly
// marker-driven, so a deployed pre-F1 adapter (which emits no marker) can never
// have live long-running work cut short by the widened gate.
test("493729fc F2: a codex turn with no end-marker is never truncated", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir, CODEX_AGENT_COMMAND);
      await writeSessionRecordFile(homeDir, record);

      const control = makePathologicalClient({ acpSessionId: record.acpSessionId });

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-f2-codex-nomark",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
        true,
        "f2b22222-2222-4222-8222-222222222222",
      );

      const run = withTurnResponseTimeout(40, () =>
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          suppressSdkConsoleErrors: true,
        }),
      );

      await control.mainPromptInFlight;
      await tick();
      // Well past both tiers (2 x 40ms) with NO marker emitted.
      await new Promise((resolve) => setTimeout(resolve, 240));
      assert.equal(
        mainSends.find((m) => m.type === "error"),
        undefined,
      );
      assert.equal(
        mainSends.find((m) => m.type === "result"),
        undefined,
      );

      control.resolveMainPrompt({ stopReason: "end_turn" });
      await run;
      assert.ok(
        mainSends.find((m) => m.type === "result"),
        "codex turn completes normally once it responds",
      );
    });
  });
});

// F4: a WAIT-mode codex injection must not be awaited (pre-F1 adapters return no
// terminal for it — awaiting guaranteed a 30-min drain-backstop hit). It is
// tracked as absorbed instead: the containing turn's end closes its delivery
// (done) and answers the waiting caller with an explicit steer-accepted result.
test("493729fc F4: codex wait-mode injection is absorbed — turn finalizes promptly, caller answered at turn end", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir, "codex-acp");
      await writeSessionRecordFile(homeDir, record);

      const injectionInitiated = createDeferred<void>();
      const mainMessageId = "f4a11111-1111-4111-8111-111111111111";
      const injectedMessageId = "f4b22222-2222-4222-8222-222222222222";

      const control = makeMockClient({
        onMainPrompt: async () => {
          await injectionInitiated.promise;
          return { stopReason: "end_turn" };
        },
        onInjectedPrompt: async () => {
          injectionInitiated.resolve();
          // Pre-F1 codex adapter: the injected steer never returns a terminal.
          return await new Promise<PromptResponse>(() => {});
        },
      });

      const injectedSends: QueueOwnerMessage[] = [];
      let injectedCloses = 0;
      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          const injectedTask = makeQueueTask(
            "req-f4-wait-injected",
            INJECTED_PROMPT_TEXT,
            (message) => injectedSends.push(message),
            () => {
              injectedCloses += 1;
            },
            true, // waitForCompletion — the F4 class
            injectedMessageId,
          );
          queueMicrotask(() => {
            ctrl.currentHandler?.(injectedTask);
          });
        }
      });

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-f4-main",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
        true,
        mainMessageId,
      );

      await withRaceTimeout(
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          setMidTurnHandler: midTurn.setMidTurnHandler,
          suppressSdkConsoleErrors: true,
        }),
        TURN_MUST_NOT_BLOCK_MS,
        "PRODUCT REGRESSION (493729fc F4): a Codex WAIT-mode steer BLOCKED turn finalization — the absorbed injection was awaited instead of being answered at turn end, so the turn is wedged until the drain backstop. A healthy turn finalizes in milliseconds; this is not a slow box.",
      );

      assert.ok(
        mainSends.find((m) => m.type === "result"),
        "main turn finalized promptly despite the wait-mode steer never returning a terminal",
      );
      // The waiting caller was answered at turn end with an explicit result.
      const injectedResult = injectedSends.find((m) => m.type === "result");
      assert.ok(injectedResult, "wait-mode caller received a result at turn end");
      assert.equal(injectedCloses, 1, "absorbed wait-mode steer closed exactly once");

      const terminals = terminalsForMessage(
        await listSessionEvents(record.acpxRecordId),
        injectedMessageId,
      );
      assert.equal(terminals.length, 1, "exactly one terminal for the wait-mode steer");
      assert.equal(terminals[0]?.phase, "done");
    });
  });
});

// F3: the owner-exit sweep writes an outcome-unknown terminal for an absorbed
// delivery whose containing turn never settled — the accepted-forever class.
// Registration happens inside the production runSessionPrompt; the sweep is the
// call the queue-owner close path makes. A later settle must not double-write.
test("493729fc F3: owner-exit sweep terminalizes still-open absorbed deliveries exactly once", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeSessionRecord(homeDir, "codex-acp");
      await writeSessionRecordFile(homeDir, record);

      const injectionInFlight = createDeferred<void>();
      const mainRelease = createDeferred<PromptResponse>();
      const mainMessageId = "f3a11111-1111-4111-8111-111111111111";
      const injectedMessageId = "f3b22222-2222-4222-8222-222222222222";

      const control = makeMockClient({
        onMainPrompt: async () => await mainRelease.promise,
        onInjectedPrompt: async () => {
          injectionInFlight.resolve();
          return await new Promise<PromptResponse>(() => {});
        },
      });

      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration === 1) {
          const injectedTask = makeQueueTask(
            "req-f3-injected",
            INJECTED_PROMPT_TEXT,
            () => {},
            () => {},
            false,
            injectedMessageId,
          );
          queueMicrotask(() => {
            ctrl.currentHandler?.(injectedTask);
          });
        }
      });

      const mainTask = makeQueueTask(
        "req-f3-main",
        MAIN_PROMPT_TEXT,
        () => {},
        () => {},
        true,
        mainMessageId,
      );

      const run = runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        setMidTurnHandler: midTurn.setMidTurnHandler,
        suppressSdkConsoleErrors: true,
      });

      // The steer is absorbed while the main turn is (wedged) in flight.
      await injectionInFlight.promise;
      await tick();

      // The owner exits while the turn never settled: the sweep must write the
      // outcome-unknown terminal for the absorbed delivery.
      const written = terminalizeAbsorbedDeliveriesOnOwnerExit(record.acpxRecordId);
      assert.equal(written, 1, "sweep wrote exactly one absorbed terminal");
      // The write is fire-and-forget; give it a beat to land.
      await new Promise((resolve) => setTimeout(resolve, 30));

      const terminals = terminalsForMessage(
        await listSessionEvents(record.acpxRecordId),
        injectedMessageId,
      );
      assert.equal(terminals.length, 1, "exactly one terminal after the sweep");
      assert.equal(terminals[0]?.phase, "failed");
      const error = (await listSessionEvents(record.acpxRecordId))
        .map((event) => (event as { params?: { error?: { detailCode?: string } } }).params)
        .find((params) => params?.error?.detailCode === "ABSORBED_TURN_NEVER_ENDED");
      assert.ok(error, "terminal carries detailCode ABSORBED_TURN_NEVER_ENDED");

      // The turn later settles anyway (e.g. the client teardown rejects it) —
      // the flag set by the sweep suppresses a duplicate terminal.
      mainRelease.resolve({ stopReason: "end_turn" });
      await run;
      const terminalsAfter = terminalsForMessage(
        await listSessionEvents(record.acpxRecordId),
        injectedMessageId,
      );
      assert.equal(
        terminalsAfter.length,
        1,
        "no duplicate terminal for the swept absorbed delivery after the turn settles",
      );
    });
  });
});

// --- 9beafe1c F1: the drain must not switch injection off -------------------
//
// D1: `drainInjectedPrompts` used to clear the mid-turn handler FIRST and only
// then block awaiting the in-flight injected prompts. Under claude-agent-acp's
// promptQueueing the primary's `end_turn` is a HANDOFF, not a turn end, so that
// await runs for the remainder of the REAL agent turn (bounded only by the
// 30-min backstop) — with injection switched off. Every message arriving in
// that window was buffered by the queue owner (queue-owner-runtime.ts:827-834),
// emitted `phase:"queued"`, and landed only at the turn's `finally`: 27 min 39 s
// late in specimen f4b8ca75, and racing acpx-ui's re-queued copy into a
// duplicate delivery.
//
// F1 splits the two decisions: keep injecting while any injected prompt is
// unsettled, drain in a loop, and unregister only once the turn is genuinely
// closing — under ONE shared deadline measured from the first drain entry.

// The shared fixture pins `max_segment_bytes: 1024` so ordinary tests exercise
// segment rotation. These F1 scenarios deliberately settle several injected
// prompts at once, and two concurrent terminal writes racing a rotation is a
// pre-existing SessionEventWriter hazard (unserialized appendMessages) that has
// nothing to do with what is under test here — so give the F1 records a segment
// large enough that no rotation can happen mid-scenario.
function makeF1SessionRecord(cwd: string): SessionRecord {
  const record = makeSessionRecord(cwd, CLAUDE_AGENT_COMMAND);
  record.eventLog.max_segment_bytes = 1_048_576;
  return record;
}

// The core regression. Pre-F1 the handler was already `undefined` by the time a
// second message arrived, so it could not be injected at all.
test("F1: a message arriving while the drain awaits an injected prompt is still injected (no injection-blind window)", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeF1SessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "f1a00000-0000-4000-8000-00000000000a";
      const firstInjectedId = "f1a00000-0000-4000-8000-000000000001";
      const secondInjectedId = "f1a00000-0000-4000-8000-000000000002";

      const firstRelease = createDeferred<PromptResponse>();
      const secondRelease = createDeferred<PromptResponse>();
      const firstInFlight = createDeferred<void>();
      const secondInFlight = createDeferred<void>();

      const control = makePathologicalClient({
        acpSessionId: record.acpSessionId,
        onInjectedPrompt: (messageId) => {
          if (messageId === firstInjectedId) {
            firstInFlight.resolve();
            return firstRelease.promise;
          }
          secondInFlight.resolve();
          return secondRelease.promise;
        },
      });

      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration !== 1) {
          return;
        }
        queueMicrotask(() => {
          ctrl.currentHandler?.(
            makeQueueTask(
              "req-f1a-injected-1",
              INJECTED_PROMPT_TEXT,
              () => {},
              () => {},
              false,
              firstInjectedId,
            ),
          );
        });
      });

      const mainTask = makeQueueTask(
        "req-f1a-main",
        MAIN_PROMPT_TEXT,
        () => {},
        () => {},
        true,
        mainMessageId,
      );

      const run = runQueuedTask(record.acpxRecordId, mainTask, {
        sharedClient: control.client,
        setMidTurnHandler: midTurn.setMidTurnHandler,
        suppressSdkConsoleErrors: true,
      });

      await control.mainPromptInFlight;
      await withRaceTimeout(firstInFlight.promise, 3_000, "the first injection never fired");
      // The adapter hands the turn over to the injected prompt and returns a
      // SYNTHETIC end_turn for the primary. The drain begins here while the
      // injected prompt still owns the real agent turn.
      control.resolveMainPrompt({ stopReason: "end_turn" });
      // Drain entry costs only microtasks after the primary settles, so this
      // sleep lands well inside the drain. (Landing early would only weaken the
      // assertion, never fail it — the polarity is a false pass, not a flake.)
      await new Promise((resolve) => setTimeout(resolve, 50));

      // THE REGRESSION: pre-F1 the handler was cleared at drain entry, so this
      // arrival was buffered and released only at the turn's `finally`.
      const handlerDuringDrain = midTurn.currentHandler;
      assert.ok(
        handlerDuringDrain,
        "the mid-turn handler must stay registered while injected prompts are unsettled",
      );
      assert.equal(midTurn.clears, 0, "the handler must not be cleared before the drain completes");
      handlerDuringDrain(
        makeQueueTask(
          "req-f1a-injected-2",
          INJECTED_PROMPT_TEXT,
          () => {},
          () => {},
          false,
          secondInjectedId,
        ),
      );

      await withRaceTimeout(
        secondInFlight.promise,
        3_000,
        "the message that arrived during the drain was never injected",
      );
      // Staggered for the same reason the injections are: two terminal writes
      // landing in one microtask race the session-record rename.
      firstRelease.resolve({ stopReason: "end_turn" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      secondRelease.resolve({ stopReason: "end_turn" });
      await withRaceTimeout(run, 5_000, "the turn never finalized after the drain loop");

      const events = await listSessionEvents(record.acpxRecordId);
      // The drain loop picked the second injection up even though it was added
      // after the first pass's snapshot, and it settled normally.
      for (const [label, messageId] of [
        ["first", firstInjectedId],
        ["second", secondInjectedId],
      ] as const) {
        const terminals = terminalsForMessage(events, messageId);
        assert.equal(terminals.length, 1, `exactly one terminal for the ${label} injection`);
        assert.equal(terminals[0]?.phase, "done", `the ${label} injection ends done`);
        assert.equal(terminals[0]?.stopReason, "end_turn");
      }
      assert.ok(
        deliveryParamsForMessage(events, secondInjectedId).some(
          (event) => event.phase === "accepted",
        ),
        "the drain-window arrival was accepted, not buffered",
      );
      assert.deepEqual(terminalsForMessage(events, mainMessageId), [
        {
          messageId: mainMessageId,
          requestId: "req-f1a-main",
          phase: "done",
          stopReason: "end_turn",
        },
      ]);
      assert.equal(
        deliveryEventParams(events).filter(
          (event) =>
            (event.error as { detailCode?: string } | undefined)?.detailCode ===
            "INJECTED_RESPONSE_TIMEOUT",
        ).length,
        0,
        "no false INJECTED_RESPONSE_TIMEOUT terminal — the backstop never fired",
      );
      // Unregistered exactly once, after the drain — never mid-turn.
      assert.equal(midTurn.clears, 1, "the handler is cleared exactly once, once the turn closes");
    });
  });
});

// The loop must run under ONE shared deadline measured from the first drain
// entry. Re-arming the backstop per iteration would let a continuous message
// stream hold the turn open forever: every injection here settles well inside
// the budget, so a re-armed deadline never expires and this test hangs.
test("F1: the drain backstop deadline is shared across loop passes, not re-armed per pass", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeF1SessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const drainBudgetMs = 200;
      const mainMessageId = "f1b00000-0000-4000-8000-00000000000a";
      let injections = 0;
      let stopped = false;

      const control = makePathologicalClient({
        acpSessionId: record.acpSessionId,
        // Every injected prompt settles quickly — the stream, not any single
        // prompt, is what would keep a re-armed deadline alive forever.
        onInjectedPrompt: () =>
          new Promise<PromptResponse>((resolve) => {
            setTimeout(() => resolve({ stopReason: "end_turn" }), 20);
          }),
      });

      // Injects the next message as soon as the previous one settles, so the
      // unsettled set is non-empty at the top of every loop pass.
      const injectNext = (ctrl: MidTurnControl): void => {
        if (stopped || ctrl.currentHandler === undefined) {
          return;
        }
        injections += 1;
        const id = `f1b00000-0000-4000-8000-${String(injections).padStart(12, "0")}`;
        ctrl.currentHandler(
          makeQueueTask(
            `req-f1b-injected-${injections}`,
            INJECTED_PROMPT_TEXT,
            () => {},
            () => injectNext(ctrl),
            false,
            id,
          ),
        );
      };

      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration !== 1) {
          return;
        }
        queueMicrotask(() => injectNext(ctrl));
      });

      const mainTask = makeQueueTask(
        "req-f1b-main",
        MAIN_PROMPT_TEXT,
        () => {},
        () => {},
        true,
        mainMessageId,
      );

      const run = withInjectedDrainTimeout(drainBudgetMs, () =>
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          setMidTurnHandler: midTurn.setMidTurnHandler,
          suppressSdkConsoleErrors: true,
        }),
      );

      await control.mainPromptInFlight;
      const drainStartedAt = Date.now();
      control.resolveMainPrompt({ stopReason: "end_turn" });
      try {
        await withRaceTimeout(
          run,
          5_000,
          "the drain never finalized — the deadline was re-armed per pass",
        );
      } finally {
        stopped = true;
      }
      const elapsedMs = Date.now() - drainStartedAt;

      assert.ok(
        injections > 1,
        `the stream produced more than one injection (got ${injections}) — the loop ran multiple passes`,
      );
      assert.ok(
        elapsedMs >= drainBudgetMs - 50,
        `the shared budget was actually spent (elapsed ${elapsedMs}ms, budget ${drainBudgetMs}ms)`,
      );
      assert.equal(
        midTurn.clears,
        1,
        "the handler is cleared exactly once, when the shared deadline closes the turn",
      );
      // Let any prompt still in flight at backstop time settle inside the temp
      // home rather than after it is torn down.
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  });
});

// The one new invariant obligation (CONCEPTION §4). The synthetic-failure pass
// must iterate the set CURRENT at backstop time: an injection accepted after
// the last pass's snapshot would otherwise reach the event-writer teardown with
// no terminal at all, breaking exactly-one-terminal.
test("F1: the backstop's synthetic terminals cover an injection added after the last snapshot", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeF1SessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "f1c00000-0000-4000-8000-00000000000a";
      const settlingId = "f1c00000-0000-4000-8000-000000000001";
      const stuckId = "f1c00000-0000-4000-8000-000000000002";
      const lateId = "f1c00000-0000-4000-8000-000000000003";

      const settlingRelease = createDeferred<PromptResponse>();
      const settlingInFlight = createDeferred<void>();
      const lateInFlight = createDeferred<void>();

      const control = makePathologicalClient({
        acpSessionId: record.acpSessionId,
        onInjectedPrompt: (messageId) => {
          if (messageId === settlingId) {
            settlingInFlight.resolve();
            return settlingRelease.promise;
          }
          if (messageId === lateId) {
            lateInFlight.resolve();
          }
          // `stuck` and `late` never settle on their own.
          return new Promise<PromptResponse>(() => {});
        },
      });

      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration !== 1) {
          return;
        }
        queueMicrotask(() => {
          // Injected one at a time on purpose: two injections started in the
          // same microtask race each other's `recordPromptStart` record write
          // (write-tmp + rename), which is a pre-existing acpx concurrency
          // property and not what this test is about.
          ctrl.currentHandler?.(
            makeQueueTask(
              "req-f1c-settling",
              INJECTED_PROMPT_TEXT,
              () => {},
              // Fires when `settling` completes — i.e. mid-drain, strictly
              // after the snapshot was taken. This is the late arrival.
              () => {
                ctrl.currentHandler?.(
                  makeQueueTask(
                    "req-f1c-late",
                    INJECTED_PROMPT_TEXT,
                    () => {},
                    () => {},
                    false,
                    lateId,
                  ),
                );
              },
              false,
              settlingId,
            ),
          );
        });
      });

      const mainTask = makeQueueTask(
        "req-f1c-main",
        MAIN_PROMPT_TEXT,
        () => {},
        () => {},
        true,
        mainMessageId,
      );

      const run = withInjectedDrainTimeout(400, () =>
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          setMidTurnHandler: midTurn.setMidTurnHandler,
          suppressSdkConsoleErrors: true,
        }),
      );

      await control.mainPromptInFlight;
      await withRaceTimeout(settlingInFlight.promise, 3_000, "`settling` never fired");
      // `stuck` keeps the first pass alive until the backstop; both it and
      // `settling` are therefore in that pass's snapshot.
      midTurn.currentHandler?.(
        makeQueueTask(
          "req-f1c-stuck",
          INJECTED_PROMPT_TEXT,
          () => {},
          () => {},
          false,
          stuckId,
        ),
      );
      control.resolveMainPrompt({ stopReason: "end_turn" });
      // Release `settling` only once the drain has entered and snapshotted, so
      // the late arrival it triggers is provably outside that snapshot.
      await new Promise((resolve) => setTimeout(resolve, 50));
      settlingRelease.resolve({ stopReason: "end_turn" });
      await withRaceTimeout(lateInFlight.promise, 3_000, "the late injection never fired");

      await withRaceTimeout(run, 5_000, "the drain backstop never finalized the turn");

      const events = await listSessionEvents(record.acpxRecordId);
      const settlingTerminals = terminalsForMessage(events, settlingId);
      assert.equal(settlingTerminals.length, 1, "the settled injection keeps its own terminal");
      assert.equal(settlingTerminals[0]?.phase, "done");

      for (const [label, messageId] of [
        ["snapshotted", stuckId],
        ["late (added after the snapshot)", lateId],
      ] as const) {
        const terminals = terminalsForMessage(events, messageId);
        assert.equal(terminals.length, 1, `exactly one terminal for the ${label} injection`);
        assert.equal(terminals[0]?.phase, "failed", `the ${label} injection is terminalized`);
        const failed = deliveryParamsForMessage(events, messageId).find(
          (event) => event.phase === "failed",
        );
        assert.equal(
          (failed?.error as { detailCode?: string } | undefined)?.detailCode,
          "INJECTED_RESPONSE_TIMEOUT",
          `the ${label} injection carries the backstop detailCode (got ${JSON.stringify(failed?.error)})`,
        );
      }
      assert.deepEqual(terminalsForMessage(events, mainMessageId), [
        {
          messageId: mainMessageId,
          requestId: "req-f1c-main",
          phase: "done",
          stopReason: "end_turn",
        },
      ]);
    });
  });
});

// --- 9beafe1c F1 amendment: the FAILURE call site stays in scope ------------
//
// `drainInjectedPrompts` is shared by the success and failure call sites and
// stays shared deliberately (CONCEPTION §4 "F1 amendment"). AC-8 pins the
// common transient-turn-failure shape as unchanged (obligation A1); AC-9 pins
// the case success-only scoping would have lost.

// A transient pre-output `-32603` that acpx-ui's isTransientTurnFailure
// recovers from. The classifier keys on the code + message pattern only.
function makeTransientTurnError(): Error {
  const error = new Error("session limit · resets 3pm");
  (error as Error & { error?: unknown }).error = {
    code: -32603,
    message: "session limit · resets 3pm",
  };
  return error;
}

// AC-8, first half (obligation A1). The overwhelmingly common turn-failure
// shape has NO injections in flight, so the drain must take its fast path and
// behave byte-for-byte as it did before F1: unregister, return, nothing else.
// This assertion is written to hold on the PRE-F1 code too — that equality is
// the proof, so it must not be loosened to accommodate the new code.
test("AC-8/A1: a transient turn failure with no injections in flight is unchanged by F1", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeF1SessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "ac800000-0000-4000-8000-00000000000a";
      const transient = makeTransientTurnError();
      const control = makeMockClient({
        onMainPrompt: async () => {
          // Defer past runPromptTurn attaching its handler (see `tick`).
          await tick();
          throw transient;
        },
        onInjectedPrompt: async () => {
          throw new Error("no injection is expected in this scenario");
        },
      });

      // Registered exactly as in production, but never invoked: the injected
      // set stays empty, which is the shape under test.
      const midTurn = makeMidTurnControl(() => {});
      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-ac8a-main",
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

      // The handler is registered once and unregistered once — the empty-set
      // fast path must NOT skip the unregister (A1).
      assert.equal(midTurn.registrations, 1, "the mid-turn handler was registered");
      assert.equal(midTurn.clears, 1, "the empty-set fast path still unregisters exactly once");

      const events = await listSessionEvents(record.acpxRecordId);
      // The full delivery sequence for the turn: accepted, then one failed
      // terminal carrying the primary's own error shape. Nothing else — no
      // backstop terminal, no injected events.
      assert.deepEqual(
        deliveryEventParams(events).map((event) => ({
          messageId: event.messageId,
          requestId: event.requestId,
          phase: event.phase,
          code: (event.error as { code?: number } | undefined)?.code,
          message: (event.error as { message?: string } | undefined)?.message,
        })),
        [
          {
            messageId: mainMessageId,
            requestId: "req-ac8a-main",
            phase: "accepted",
            code: 0,
            message: "",
          },
          {
            messageId: mainMessageId,
            requestId: "req-ac8a-main",
            phase: "failed",
            code: -32603,
            message: "session limit · resets 3pm",
          },
        ],
      );
      const errorMessage = mainSends.find((message) => message.type === "error") as
        | { message?: string }
        | undefined;
      assert.equal(
        errorMessage?.message,
        "session limit · resets 3pm",
        "the sender sees the primary's own error, unchanged",
      );
    });
  });
});

// AC-8, second half. When an injection IS in flight, its terminal must carry
// the SAME error shape as the primary's — `deliveryErrorFrom` is shared — so
// acpx-ui's isTransientTurnFailure (which keys only on the code + message, never
// on source/policy/injectedness) routes it down the same recoverable branch
// instead of surfacing a failure to the sender.
test("AC-8: an injected delivery failing with the primary carries a byte-identical error shape", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeF1SessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "ac810000-0000-4000-8000-00000000000a";
      const injectedMessageId = "ac810000-0000-4000-8000-000000000001";
      const transient = makeTransientTurnError();
      const injectedInFlight = createDeferred<void>();
      const injectedRelease = createDeferred<PromptResponse>();

      const control = makeMockClient({
        onMainPrompt: async () => {
          await tick();
          throw transient;
        },
        onInjectedPrompt: async () => {
          injectedInFlight.resolve();
          // The same underlying transport error reaches both prompts.
          return await injectedRelease.promise;
        },
      });

      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration !== 1) {
          return;
        }
        queueMicrotask(() => {
          ctrl.currentHandler?.(
            makeQueueTask(
              "req-ac8b-injected",
              INJECTED_PROMPT_TEXT,
              () => {},
              () => {},
              false,
              injectedMessageId,
            ),
          );
        });
      });

      const mainTask = makeQueueTask(
        "req-ac8b-main",
        MAIN_PROMPT_TEXT,
        () => {},
        () => {},
        true,
        mainMessageId,
      );

      const run = withInjectedDrainTimeout(2_000, () =>
        runQueuedTask(record.acpxRecordId, mainTask, {
          sharedClient: control.client,
          setMidTurnHandler: midTurn.setMidTurnHandler,
          suppressSdkConsoleErrors: true,
        }),
      );
      await withRaceTimeout(injectedInFlight.promise, 3_000, "the injection never fired");
      injectedRelease.reject(transient);
      await withRaceTimeout(run, 5_000, "the failure-path drain never finalized");

      const events = await listSessionEvents(record.acpxRecordId);
      const errorFor = (messageId: string): unknown =>
        deliveryParamsForMessage(events, messageId).find((event) => event.phase === "failed")
          ?.error;
      assert.ok(errorFor(mainMessageId), "the primary has a failed terminal");
      assert.deepEqual(
        errorFor(injectedMessageId),
        errorFor(mainMessageId),
        "the injected delivery's error is byte-identical to the primary's, so acpx-ui classifies both the same",
      );
      // NOT the backstop's terminal — that would be the delivery-truth
      // regression the amendment ruled out.
      assert.notEqual(
        (errorFor(injectedMessageId) as { detailCode?: string } | undefined)?.detailCode,
        "INJECTED_RESPONSE_TIMEOUT",
      );
    });
  });
});

// AC-9 — the regression sentinel for keeping the failure call site in scope.
// TurnWatchdog tier 2 rejects with TurnResponseTimeoutError exactly when the
// end-of-turn marker was seen but the response is overdue: the agent is ALIVE
// and still working. That lands in handlePromptFailure with injected prompts
// unsettled — the D1 shape on the failure path. If this regresses, the
// success-only scoping question is back open; do not work around it.
test("AC-9: the tier-2 watchdog path keeps injecting — an arriving message is injected, not buffered", async () => {
  await withNoUnhandledRejections(async () => {
    await withTempHome(async (homeDir) => {
      const record = makeF1SessionRecord(homeDir);
      await writeSessionRecordFile(homeDir, record);

      const mainMessageId = "ac900000-0000-4000-8000-00000000000a";
      const firstInjectedId = "ac900000-0000-4000-8000-000000000001";
      const arrivingId = "ac900000-0000-4000-8000-000000000002";

      const firstInFlight = createDeferred<void>();
      const arrivingInFlight = createDeferred<void>();
      const control = makePathologicalClient({
        acpSessionId: record.acpSessionId,
        onInjectedPrompt: (messageId) => {
          if (messageId === firstInjectedId) {
            firstInFlight.resolve();
          } else {
            arrivingInFlight.resolve();
          }
          // The agent is still working: neither injection answers.
          return new Promise<PromptResponse>(() => {});
        },
      });
      // Marker seen, response withheld, cancel ignored → tier-2 abandon.
      neverRespondIgnoresCancel(control);

      const midTurn = makeMidTurnControl((registration, ctrl) => {
        if (registration !== 1) {
          return;
        }
        queueMicrotask(() => {
          ctrl.currentHandler?.(
            makeQueueTask(
              "req-ac9-injected-1",
              INJECTED_PROMPT_TEXT,
              () => {},
              () => {},
              false,
              firstInjectedId,
            ),
          );
        });
      });

      const mainSends: QueueOwnerMessage[] = [];
      const mainTask = makeQueueTask(
        "req-ac9-main",
        MAIN_PROMPT_TEXT,
        (message) => mainSends.push(message),
        () => {},
        true,
        mainMessageId,
      );

      const run = withTurnResponseTimeout(40, () =>
        withInjectedDrainTimeout(600, () =>
          runQueuedTask(record.acpxRecordId, mainTask, {
            sharedClient: control.client,
            setMidTurnHandler: midTurn.setMidTurnHandler,
            suppressSdkConsoleErrors: true,
          }),
        ),
      );

      await control.mainPromptInFlight;
      await withRaceTimeout(firstInFlight.promise, 3_000, "the first injection never fired");
      control.emitTurnEndMarker("end_turn");
      // Tier 1 fires at timeoutMs, tier 2 at timeoutMs*2 (= 80 ms); the ensuing
      // handlePromptFailure drain then runs to its 600 ms backstop. 200 ms lands
      // squarely inside that drain.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const handlerDuringFailureDrain = midTurn.currentHandler;
      assert.ok(
        handlerDuringFailureDrain,
        "the mid-turn handler stays registered through the tier-2 failure drain",
      );
      handlerDuringFailureDrain(
        makeQueueTask(
          "req-ac9-arriving",
          INJECTED_PROMPT_TEXT,
          () => {},
          () => {},
          false,
          arrivingId,
        ),
      );
      await withRaceTimeout(
        arrivingInFlight.promise,
        3_000,
        "the message arriving during the tier-2 failure drain was NOT injected",
      );

      await withRaceTimeout(run, 5_000, "the failure-path drain never finalized");

      const events = await listSessionEvents(record.acpxRecordId);
      assert.ok(
        deliveryParamsForMessage(events, arrivingId).some((event) => event.phase === "accepted"),
        "the arriving message was accepted (injected), not buffered for the turn boundary",
      );
      const mainError = mainSends.find((message) => message.type === "error") as
        | { detailCode?: string }
        | undefined;
      assert.equal(
        mainError?.detailCode,
        "TURN_RESPONSE_TIMEOUT",
        "the primary still fails at the tier-2 bound — F1 does not touch its lifecycle",
      );
      assert.equal(midTurn.clears, 1, "the handler is cleared exactly once, at the drain's end");
    });
  });
});
