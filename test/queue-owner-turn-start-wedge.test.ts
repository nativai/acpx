// brick://b8e251eb — an owner that ACCEPTED a task must never silently hold it.
//
// The specimen (devbox, 2026-10-05, session 67f2803e): a cold-spawned owner took
// Daniel's steer (`acpx/received` 10:23:42Z) while another process held the
// brick-outbox SQLite write lock. For the next 14 minutes it started no turn, wrote
// no delivery event and nothing to owner.log, and `acpx status` said
// `queue owner healthy`. acpx-ui kept the item `delivering` until a manual
// `sessions recover` let it re-drive.
//
// THE MECHANISM (file:line at the unrepaired base 79fe783):
//   - the owner pulls the task and calls `runQueuedTask`
//     (queue-owner-runtime.ts:1159);
//   - `runSessionPrompt` → `recordPromptStart` → `writeSessionRecordAtBoundary`
//     (runtime.ts:1704) threw (then: outbox-busy). That is BEFORE the main turn try
//     (runtime.ts:3030), so no `failed` delivery terminal is written by the turn;
//   - `runQueuedTask`'s catch (runtime.ts:1417-1426) only terminalizes the
//     closed-record and reserved-capacity classes, and `sendQueuedTaskError`
//     returns at once for a `waitForCompletion:false` task — which every acpx-ui
//     delivery is. Then `task.close()`, `runQueuedTask` RESOLVES, and the owner loop
//     goes back to `nextTask()` with a healthy heartbeat.
// The defect is the dropped error, not its cause: ANY throw from that write is lost
// the same way. Since the spawn-ledger reduction an ordinary record write no longer
// opens SQLite, so the wedge row makes the SAME write fail without a lock (the
// sessions directory made read-only once the task is accepted, so the write's
// temp file cannot be created) — the specimen's throw site, deterministically,
// with no ledger involved.
//
// THE FIX (re-scoped 2026-10-05, Daniel): every such pre-turn failure gets one
// DEFINITIVE QUEUE_TURN_START_FAILED terminal (never reached the model,
// resend-safe, not auto-retried) and a named owner.log line.
//
// The production interaction shape these rows enter: a real SessionQueueOwner,
// a real IPC `submit_prompt` with `waitForCompletion:false` + `messageId` (the
// exact acpx-ui `prompt --no-wait --message-id` shape), and the task pulled by
// `nextTask()`.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import type { AcpClient } from "../src/acp/client.js";
import {
  QUEUE_TURN_START_FAILED_DETAIL_CODE,
  QUEUE_TURN_START_FAILED_MESSAGE,
} from "../src/cli/queue/delivery-terminals.js";
import {
  type QueueTask,
  releaseQueueOwnerLease,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import type { PromptInput } from "../src/prompt-content.js";
import type { DepthProjection } from "../src/session/depth-projection.js";
import { listSessionEvents } from "../src/session/events.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import { connectSocket, nextJsonLine } from "./queue-test-helpers.js";
import { makeSessionRecord, sessionFilePath, withTempHome } from "./runtime-test-helpers.js";

const MESSAGE_ID = "b8e251eb-0000-4000-8000-000000000001";
const PROMPT_TEXT = "a steer from Daniel";

function messagesLogFile(home: string, sessionId: string): string {
  return path.join(home, ".acpx", "sessions", `${encodeURIComponent(sessionId)}.messages.ndjson`);
}

type MockClient = { client: AcpClient; promptCalls: () => number };

// The reuse happy-path surface `runSessionPrompt` touches (same shape as
// delivery-steer-visibility.test.ts). `prompt` either ends the turn or throws.
// With `onStart`, the client is NOT reusable: every connect awaits `start()` and
// creates a fresh session — a hook point INSIDE the turn, before the prompt (the
// adapter failing to start is a real pre-model failure there).
function makeMockClient(
  onPrompt: () => Promise<{ stopReason: "end_turn" }>,
  hooks: { onStart?: () => Promise<void> } = {},
): MockClient {
  let calls = 0;
  const mock = {
    hasReusableSession: () => hooks.onStart === undefined,
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    start: async () => await hooks.onStart?.(),
    createSession: async () => ({ sessionId: "acp-fresh-session" }),
    getAgentLifecycleSnapshot: () => ({ running: true }),
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,
    updateRuntimeOptions: () => {},
    setEventHandlers: () => {},
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
    prompt: async (_sessionId: string, _input: PromptInput | string) => {
      calls += 1;
      return await onPrompt();
    },
  };
  return { client: mock as unknown as AcpClient, promptCalls: () => calls };
}

type DeliveryParams = {
  messageId: string;
  requestId: string;
  phase: string;
  error: { code: number; message: string; detailCode: string };
};

async function deliveryEvents(sessionId: string): Promise<DeliveryParams[]> {
  return (await listSessionEvents(sessionId))
    .filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { method?: unknown }).method === "acpx/delivery",
    )
    .map((event) => (event as { params: DeliveryParams }).params)
    .filter((params) => params.messageId === MESSAGE_ID);
}

// Captures what the owner writes to its owner.log (its stderr) for the duration
// of one call, so a row can assert the failure was NAMED there, not only on disk.
async function captureStderr<T>(run: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    return { value: await run(), stderr: captured };
  } finally {
    process.stderr.write = original;
  }
}

// `.messages.ndjson` — the conversation history acpx-ui renders.
async function userRowsFor(home: string, sessionId: string): Promise<number> {
  const lines = (await fs.readFile(messagesLogFile(home, sessionId), "utf8"))
    .split("\n")
    .filter(Boolean);
  return lines.filter((line) => {
    const row = JSON.parse(line) as { User?: { id?: string } };
    return row.User?.id === MESSAGE_ID;
  }).length;
}

// One owner, one accepted no-wait task, exactly as acpx-ui submits it. `submit`
// delivers the SAME messageId again — acpx-ui's re-drive.
async function withAcceptedNoWaitTask(
  prefix: string,
  run: (context: {
    home: string;
    sessionId: string;
    task: QueueTask;
    submit: (requestId: string) => Promise<QueueTask>;
  }) => Promise<void>,
): Promise<void> {
  await withTempHome(prefix, async (home) => {
    const sessionId = `${prefix}session`;
    const record = makeSessionRecord({
      acpxRecordId: sessionId,
      acpSessionId: `acp-${sessionId}`,
      agentCommand: "node mock-agent.js",
      cwd: home,
    });
    await writeSessionRecord(record);

    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => false,
      closeSession: async () => true,
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async () => ({ configOptions: [] }),
      setDepth: async (requested: string): Promise<DepthProjection> => ({
        kind: "send-nothing",
        requested,
      }),
      queryActiveTurn: () => false,
    });
    const closers: Array<() => void> = [];
    const submit = async (requestId: string): Promise<QueueTask> => {
      const socket = await connectSocket(lease.socketPath);
      const lines = readline.createInterface({ input: socket });
      closers.push(() => {
        lines.close();
        socket.destroy();
      });
      socket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId,
          ownerGeneration: lease.ownerGeneration,
          messageId: MESSAGE_ID,
          message: PROMPT_TEXT,
          permissionMode: "approve-all",
          waitForCompletion: false,
        })}\n`,
      );
      const accepted = (await nextJsonLine(lines[Symbol.asyncIterator]())) as { type: string };
      assert.equal(accepted.type, "accepted", "the owner accepted the task — custody is ours");
      const task = await owner.nextTask();
      assert(task);
      return task;
    };
    try {
      const task = await submit(`${prefix}request`);
      await run({ home, sessionId, task, submit });
    } finally {
      for (const close of closers.splice(0)) {
        close();
      }
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
}

test("b8e251eb: an accepted no-wait task whose turn-start record write throws gets ONE definitive terminal and a named owner.log line, never silence", async () => {
  await withAcceptedNoWaitTask("acpx-b8e251eb-wedge-", async ({ home, sessionId, task }) => {
    const mock = makeMockClient(async () => ({ stopReason: "end_turn" }));
    // recordPromptStart's boundary write creates files in the sessions dir; make
    // that dir read-only AFTER the task was accepted so exactly that write throws.
    // Existing files (the stream the terminal is appended to) stay writable.
    const sessionsDir = path.dirname(messagesLogFile(home, sessionId));
    await fs.chmod(sessionsDir, 0o555);
    let stderr: string;
    try {
      ({ stderr } = await captureStderr(
        async () =>
          await runQueuedTask(sessionId, task, {
            sharedClient: mock.client,
            suppressSdkConsoleErrors: true,
          }),
      ));
    } finally {
      await fs.chmod(sessionsDir, 0o755);
    }

    const events = await deliveryEvents(sessionId);
    // THE WEDGE: on the unrepaired base this is 0 — no terminal, no turn, nothing.
    assert.equal(
      events.length,
      1,
      `an accepted task that never started must leave exactly ONE delivery terminal; got ${JSON.stringify(events)}`,
    );
    assert.equal(events[0].phase, "failed");
    assert.equal(events[0].error.detailCode, QUEUE_TURN_START_FAILED_DETAIL_CODE);
    assert.ok(
      events[0].error.message.startsWith(`${QUEUE_TURN_START_FAILED_MESSAGE}: `),
      events[0].error.message,
    );
    assert.match(
      events[0].error.message,
      /EACCES/,
      "the failure carries its reason — and proves the lever bit (a root run cannot be denied)",
    );
    assert.equal(mock.promptCalls(), 0, "nothing reached the model");
    // Named for what it is in owner.log — not a generic line, not silence.
    assert.match(stderr, /could not start the turn/);
    assert.match(stderr, /EACCES/);
    assert.match(stderr, new RegExp(MESSAGE_ID));
  });
});

test("b8e251eb: a NON-outbox failure before the turn starts gets the same definitive terminal", async () => {
  await withAcceptedNoWaitTask("acpx-b8e251eb-hard-", async ({ home, sessionId, task }) => {
    const mock = makeMockClient(async () => ({ stopReason: "end_turn" }));
    // A record that can no longer be parsed.
    await fs.writeFile(sessionFilePath(home, sessionId), "{not json", "utf8");
    const { stderr } = await captureStderr(
      async () =>
        await runQueuedTask(sessionId, task, {
          sharedClient: mock.client,
          suppressSdkConsoleErrors: true,
        }),
    );
    const events = await deliveryEvents(sessionId);
    assert.equal(events.length, 1, `exactly one terminal; got ${JSON.stringify(events)}`);
    assert.equal(events[0].phase, "failed");
    assert.equal(events[0].error.detailCode, QUEUE_TURN_START_FAILED_DETAIL_CODE);
    // The contract's `messageMatch: prefix`: the fixed text, then the real reason.
    assert.ok(
      events[0].error.message.startsWith(`${QUEUE_TURN_START_FAILED_MESSAGE}: `),
      events[0].error.message,
    );
    assert.match(events[0].error.message, /SessionNotFoundError/, "the failure carries its reason");
    assert.equal(mock.promptCalls(), 0);
    assert.match(stderr, /could not start the turn/);
  });
});

// NEGATIVE CASE for the turn-started boundary: a turn that DID start and then
// failed already writes its own `failed` terminal (runtime.ts failRuntimePrompt).
// The new fallback must not add a second one — a duplicate terminal is
// brick://932a1e5e.
test("b8e251eb: a turn that started and then failed keeps exactly ONE terminal (no fallback double-write)", async () => {
  await withAcceptedNoWaitTask("acpx-b8e251eb-started-", async ({ sessionId, task }) => {
    const mock = makeMockClient(async () => {
      throw new Error("adapter blew up mid-turn");
    });
    await captureStderr(
      async () =>
        await runQueuedTask(sessionId, task, {
          sharedClient: mock.client,
          suppressSdkConsoleErrors: true,
        }),
    );
    assert.equal(mock.promptCalls(), 1, "the turn started — the model was asked");
    const terminals = (await deliveryEvents(sessionId)).filter(
      (event) => event.phase !== "accepted",
    );
    assert.equal(terminals.length, 1, `exactly one terminal; got ${JSON.stringify(terminals)}`);
    assert.equal(terminals[0].phase, "failed");
    assert.notEqual(terminals[0].error.detailCode, QUEUE_TURN_START_FAILED_DETAIL_CODE);
  });
});

// F2 (te-B, VERIFICATION.md): a message whose first attempt failed before the
// model saw it is re-sent with the SAME messageId (resend-safe). The User row the
// first attempt persisted must not be appended a second time.
test("b8e251eb F2: a re-drive of a message whose first attempt never reached the model leaves ONE User row in the history", async () => {
  await withAcceptedNoWaitTask("acpx-b8e251eb-f2-", async ({ home, sessionId, task, submit }) => {
    let adapterStarts = true;
    // Attempt 1 persists the User row (turn start succeeds), then the adapter fails
    // to start inside the turn — before the prompt is ever sent.
    const mock = makeMockClient(async () => ({ stopReason: "end_turn" }), {
      onStart: async () => {
        if (!adapterStarts) {
          throw new Error("adapter failed to start");
        }
      },
    });
    adapterStarts = false;
    await captureStderr(
      async () =>
        await runQueuedTask(sessionId, task, {
          sharedClient: mock.client,
          suppressSdkConsoleErrors: true,
        }),
    );
    assert.equal(mock.promptCalls(), 0, "attempt 1 never reached the model");
    assert.equal(await userRowsFor(home, sessionId), 1, "attempt 1 persisted the User row");

    // The re-drive of the SAME messageId, adapter healthy again.
    adapterStarts = true;
    const redriven = await submit("acpx-b8e251eb-f2-redrive");
    await captureStderr(
      async () =>
        await runQueuedTask(sessionId, redriven, {
          sharedClient: mock.client,
          suppressSdkConsoleErrors: true,
        }),
    );
    assert.equal(mock.promptCalls(), 1, "the re-drive delivered it");
    // On the unrepaired base: 2.
    assert.equal(await userRowsFor(home, sessionId), 1, "one message id, one User row");
  });
});
