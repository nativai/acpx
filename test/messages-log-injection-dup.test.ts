/**
 * A delivery injected mid-turn must produce exactly one messages-log entry per
 * conversation entry (brick://5b608eaa).
 *
 * The logged-message count used to live per CARRIER (`record`, `conversation`)
 * while both shared one `messages` array. `recordPromptStart` advanced it on
 * `record` inside its awaited boundary write and copied it back only after the
 * write returned; the turn's 500 ms live checkpoint ran `applyConversation`
 * inside that window, copied the stale count back over the fresh one, and the
 * next boundary write re-appended the tail it had just logged — specimen
 * a6c485c6 lines 6-10: `A(x) U(d) A(x) U(d) A(y)`.
 *
 * The window is held open deterministically: the test holds `<id>.json.lock`
 * (an unjudgeable body is waited on, never broken, inside 15 s), so the
 * injection's log append lands and its record write then parks in
 * `withRecordFileLock` while a `session/update` arms the checkpoint.
 *
 * The last row pins the claude-pty steer-uuid stamp: the steer ack settles while
 * the turn still streams, so the stamp must be a checkpoint, never a boundary —
 * a boundary there appends the in-progress Agent entry to an append-only log.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import type { QueueOwnerMessage } from "../src/cli/queue/messages.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { textPrompt } from "../src/prompt-content.js";
import type { SessionNotification } from "../src/types.js";
import {
  CLAUDE_AGENT_COMMAND,
  INJECTED_PROMPT_TEXT,
  MAIN_PROMPT_TEXT,
  createDeferred,
  makePathologicalClient,
  type PromptResponse,
} from "./pathological-adapter-helpers.js";
import {
  makeSessionRecord,
  sessionFilePath,
  withTempHome,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

const CHECKPOINT_SETTLE_MS = 1_200; // > LiveSessionCheckpoint's 500 ms interval

const MAIN = "main-0000-4000-8000-000000000000";
const INJ_A = "45143e51-0000-4000-8000-000000000001";
const INJ_B = "fe199e35-0000-4000-8000-000000000002";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTask(
  requestId: string,
  text: string,
  messageId: string,
  send: (message: QueueOwnerMessage) => void = () => {},
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
    send,
    close: () => {},
  } satisfies QueueTask;
}

function agentChunk(acpSessionId: string, text: string): SessionNotification {
  return {
    sessionId: acpSessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  } as unknown as SessionNotification;
}

type LogEntry = { kind: "User" | "Agent"; key: string };

async function readLog(logPath: string): Promise<LogEntry[]> {
  const text = await fs.readFile(logPath, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((raw) => {
      const parsed = JSON.parse(raw) as {
        User?: { id: string };
        Agent?: { content: Array<{ Text?: string }> };
      };
      if (parsed.User) {
        return { kind: "User" as const, key: parsed.User.id };
      }
      const textOf = (parsed.Agent?.content ?? []).map((c) => c.Text ?? "").join("");
      return { kind: "Agent" as const, key: textOf };
    });
}

function shape(entries: LogEntry[]): string[] {
  return entries.map((e) => (e.kind === "User" ? `U(${e.key})` : `A(${e.key})`));
}

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startTurn(homeDir: string, name: string) {
  const record = makeSessionRecord({
    acpxRecordId: `dup-${name}`,
    acpSessionId: `dup-${name}-session`,
    agentCommand: CLAUDE_AGENT_COMMAND,
    cwd: homeDir,
  });
  await writeSessionRecordFile(homeDir, record);
  const recordFile = sessionFilePath(homeDir, record.acpxRecordId);
  const logPath = path.join(
    path.dirname(recordFile),
    `${encodeURIComponent(record.acpxRecordId)}.messages.ndjson`,
  );
  return { record, recordFile, logPath };
}

type Scenario = {
  name: string;
  injections: string[];
  /** Emit a session/update (→ live checkpoint) while the injection writes are parked. */
  updateInsideWindow: boolean;
};

async function runParkedInjectionScenario(scenario: Scenario): Promise<LogEntry[]> {
  return await withTempHome("acpx-5b608eaa-", async (homeDir) => {
    const { record, recordFile, logPath } = await startTurn(homeDir, scenario.name);

    const injectedInFlight = scenario.injections.map(() => createDeferred<void>());
    const injectedRelease = createDeferred<PromptResponse>();
    let injectedCalls = 0;
    const control = makePathologicalClient({
      acpSessionId: record.acpSessionId,
      onInjectedPrompt: async () => {
        injectedInFlight[injectedCalls]?.resolve();
        injectedCalls += 1;
        return await injectedRelease.promise;
      },
    });

    let midTurnHandler: ((task: QueueTask) => void) | undefined;
    const handlerRegistered = createDeferred<void>();
    const run = runQueuedTask(record.acpxRecordId, makeTask("req-main", MAIN_PROMPT_TEXT, MAIN), {
      sharedClient: control.client,
      setMidTurnHandler: (handler) => {
        midTurnHandler = handler;
        if (handler) {
          handlerRegistered.resolve();
        }
      },
      suppressSdkConsoleErrors: true,
    });

    await control.mainPromptInFlight;
    await handlerRegistered.promise;
    // The main turn streams Agent(x); let its checkpoint settle so the window
    // below starts from a quiescent record.
    control.emitSessionUpdate(agentChunk(record.acpSessionId, "partial answer x"));
    await sleep(CHECKPOINT_SETTLE_MS);

    // Park every record write on the record lock (the log append is NOT under it).
    const lockPath = `${recordFile}.lock`;
    await fs.writeFile(lockPath, "{}");
    for (const [index, messageId] of scenario.injections.entries()) {
      midTurnHandler?.(makeTask(`req-inj-${index}`, INJECTED_PROMPT_TEXT, messageId));
      // The injection's boundary append has landed, and its record write is now parked.
      await waitFor(
        async () => (await readLog(logPath)).some((e) => e.kind === "User" && e.key === messageId),
        `log append of ${messageId}`,
      );
    }
    if (scenario.updateInsideWindow) {
      control.emitSessionUpdate(agentChunk(record.acpSessionId, "continued answer y"));
      await sleep(CHECKPOINT_SETTLE_MS); // the checkpoint's applyConversation runs in here
    }
    await fs.rm(lockPath, { force: true });
    for (const deferred of injectedInFlight) {
      await deferred.promise;
    }
    if (!scenario.updateInsideWindow) {
      control.emitSessionUpdate(agentChunk(record.acpSessionId, "continued answer y"));
    }

    // Claude-shaped hand-over: the main prompt ends first, the injected prompt carries the turn.
    control.resolveMainPrompt({ stopReason: "end_turn" });
    injectedRelease.resolve({ stopReason: "end_turn" });
    await run;
    return await readLog(logPath);
  });
}

test("a checkpoint inside an injection's boundary write does not re-append the tail (specimen lines 6-10)", async () => {
  const entries = await runParkedInjectionScenario({
    name: "one",
    injections: [INJ_A],
    updateInsideWindow: true,
  });
  assert.deepEqual(shape(entries), [
    `U(${MAIN})`,
    "A(partial answer x)",
    `U(${INJ_A})`,
    "A(continued answer y)",
  ]);
});

test("two injections in one checkpointed window do not re-append (specimen lines 39-47 shape)", async () => {
  const entries = await runParkedInjectionScenario({
    name: "two",
    injections: [INJ_A, INJ_B],
    updateInsideWindow: true,
  });
  assert.deepEqual(shape(entries), [
    `U(${MAIN})`,
    "A(partial answer x)",
    `U(${INJ_A})`,
    `U(${INJ_B})`,
    "A(continued answer y)",
  ]);
});

test("CONTROL: the same injection with no update inside the window logs each entry once", async () => {
  const entries = await runParkedInjectionScenario({
    name: "control",
    injections: [INJ_A],
    updateInsideWindow: false,
  });
  assert.deepEqual(shape(entries), [
    `U(${MAIN})`,
    "A(partial answer x)",
    `U(${INJ_A})`,
    "A(continued answer y)",
  ]);
});

test("a claude-pty steer ack settling mid-stream logs the final Agent entry once and complete", async () => {
  await withTempHome("acpx-5b608eaa-steer-", async (homeDir) => {
    const { record, logPath } = await startTurn(homeDir, "steer");

    const injectedInFlight = createDeferred<void>();
    const injectedRelease = createDeferred<PromptResponse>();
    const control = makePathologicalClient({
      acpSessionId: record.acpSessionId,
      onInjectedPrompt: async () => {
        injectedInFlight.resolve();
        return await injectedRelease.promise;
      },
    });

    let midTurnHandler: ((task: QueueTask) => void) | undefined;
    const handlerRegistered = createDeferred<void>();
    const run = runQueuedTask(record.acpxRecordId, makeTask("req-main", MAIN_PROMPT_TEXT, MAIN), {
      sharedClient: control.client,
      setMidTurnHandler: (handler) => {
        midTurnHandler = handler;
        if (handler) {
          handlerRegistered.resolve();
        }
      },
      suppressSdkConsoleErrors: true,
    });

    await control.mainPromptInFlight;
    await handlerRegistered.promise;
    control.emitSessionUpdate(agentChunk(record.acpSessionId, "partial answer x"));
    await sleep(CHECKPOINT_SETTLE_MS);

    const injectedResult = createDeferred<void>();
    midTurnHandler?.(
      makeTask("req-steer", INJECTED_PROMPT_TEXT, INJ_A, (message) => {
        if (message.type === "result") {
          injectedResult.resolve();
        }
      }),
    );
    await injectedInFlight.promise;
    // The turn streams on into a NEW Agent entry after the steer's User entry.
    control.emitSessionUpdate(agentChunk(record.acpSessionId, "continued answer y"));
    await sleep(CHECKPOINT_SETTLE_MS);

    // claude-pty acks the confirmed steer immediately, mid-turn, with the stamp.
    injectedRelease.resolve({
      stopReason: "end_turn",
      _meta: { steerBoundaryUuid: "pre-steer-tail-uuid" },
    });
    await injectedResult.promise; // the stamp's write has returned

    control.emitSessionUpdate(agentChunk(record.acpSessionId, " final"));
    await sleep(CHECKPOINT_SETTLE_MS);
    control.resolveMainPrompt({ stopReason: "end_turn" });
    await run;

    assert.deepEqual(shape(await readLog(logPath)), [
      `U(${MAIN})`,
      "A(partial answer x)",
      `U(${INJ_A})`,
      "A(continued answer y final)",
    ]);
  });
});
