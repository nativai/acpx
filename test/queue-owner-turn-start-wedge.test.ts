// brick://b8e251eb — an owner that ACCEPTED a task must never silently hold it.
//
// The specimen (devbox, 2026-10-05, session 67f2803e): a cold-spawned owner took
// Daniel's steer (`acpx/received` 10:23:42Z) while another process held the
// brick-outbox SQLite write lock. For the next 14 minutes it started no turn, wrote
// no delivery event and nothing to owner.log, and `acpx status` said
// `queue owner healthy`. acpx-ui kept the item `delivering` until a manual
// `sessions recover` let it re-drive.
//
// THE MECHANISM (reproduced here, file:line at the unrepaired base 79fe783):
//   - the owner pulls the task and calls `runQueuedTask`
//     (queue-owner-runtime.ts:1159);
//   - `runSessionPrompt` → `recordPromptStart` → `writeSessionRecordAtBoundary`
//     (runtime.ts:1704) throws `OutboxError("outbox-busy")` after the outbox's own
//     4 s busy budget. That is BEFORE the main turn try (runtime.ts:3030), so no
//     `failed` delivery terminal is written by the turn;
//   - `runQueuedTask`'s catch (runtime.ts:1417-1426) only terminalizes the
//     closed-record and reserved-capacity classes, and `sendQueuedTaskError`
//     returns at once for a `waitForCompletion:false` task — which every acpx-ui
//     delivery is. Then `task.close()`, `runQueuedTask` RESOLVES, and the owner loop
//     goes back to `nextTask()` with a healthy heartbeat.
// The a8eb45f2 hotfix (294d674) is NOT the swallow point: it only touched the
// sub-agent boundary-write chain. The error here is caught by design and dropped
// because nothing writes a terminal for its class.
//
// The production interaction shape these rows enter: a real SessionQueueOwner,
// a real IPC `submit_prompt` with `waitForCompletion:false` + `messageId` (the
// exact acpx-ui `prompt --no-wait --message-id` shape), the task pulled by
// `nextTask()`, and the lock held by a SEPARATE PROCESS — the cross-process holder
// that a same-process serialisation fix (42d9327) cannot remove.

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

// Resolved into the SOURCE tree: `build:test` does not copy `.mjs` fixtures into
// `dist-test/`. From `dist-test/test/` two levels up is the repo root.
const HOLDER_PATH = fileURLToPath(
  new URL("../../test/fixtures/outbox-lock-holder.mjs", import.meta.url),
);

const MESSAGE_ID = "b8e251eb-0000-4000-8000-000000000001";
const PROMPT_TEXT = "a steer from Daniel";

type Holder = { release: () => Promise<void>; alive: () => boolean };

// Holds `$HOME/.acpx/brick-outbox.db`'s write lock from another process until
// released. Asserts it ACTED before returning, so a row can never pass against a
// holder that never took the lock.
async function holdOutboxLock(home: string): Promise<Holder> {
  const dbPath = path.join(home, ".acpx", "brick-outbox.db");
  assert.ok(fsSync.existsSync(dbPath), "no outbox DB to hold — the instrument is blind");
  assert.ok(fsSync.existsSync(HOLDER_PATH), `lock-holder fixture missing at ${HOLDER_PATH}`);
  const marker = path.join(home, "holder-acted");
  const holder = fork(HOLDER_PATH, [dbPath, marker], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
  const deadline = Date.now() + 5_000;
  while (!fsSync.existsSync(marker) && Date.now() < deadline && holder.exitCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(fsSync.existsSync(marker), `holder never took the lock (exit=${holder.exitCode})`);
  let released = false;
  return {
    alive: () => holder.exitCode === null && holder.signalCode === null,
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.send("release");
        await exited;
      }
    },
  };
}

type MockClient = { client: AcpClient; promptCalls: () => number };

// The reuse happy-path surface `runSessionPrompt` touches (same shape as
// delivery-steer-visibility.test.ts). `prompt` either ends the turn or throws.
function makeMockClient(onPrompt: () => Promise<{ stopReason: "end_turn" }>): MockClient {
  let calls = 0;
  const mock = {
    hasReusableSession: () => true,
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    start: async () => {},
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

// One owner, one accepted no-wait task, exactly as acpx-ui submits it.
async function withAcceptedNoWaitTask(
  prefix: string,
  run: (context: { home: string; sessionId: string; task: QueueTask }) => Promise<void>,
): Promise<void> {
  await withTempHome(prefix, async (home) => {
    const sessionId = `${prefix}session`;
    const record = makeSessionRecord({
      acpxRecordId: sessionId,
      acpSessionId: `acp-${sessionId}`,
      agentCommand: "node mock-agent.js",
      cwd: home,
    });
    // Through the real write path, so the outbox DB exists to be held.
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
    const socket = await connectSocket(lease.socketPath);
    const lines = readline.createInterface({ input: socket });
    try {
      socket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: `${prefix}request`,
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
      await run({ home, sessionId, task });
    } finally {
      lines.close();
      socket.destroy();
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
}

test("b8e251eb: an accepted no-wait task whose turn cannot start under outbox-busy is handed back LOUDLY with a retryable terminal, never held silently", async () => {
  await withAcceptedNoWaitTask("acpx-b8e251eb-wedge-", async ({ home, sessionId, task }) => {
    const mock = makeMockClient(async () => ({ stopReason: "end_turn" }));
    const holder = await holdOutboxLock(home);
    let abandoned = 0;
    const sleeps: number[] = [];
    try {
      const { stderr } = await captureStderr(
        async () =>
          await runQueuedTask(sessionId, task, {
            sharedClient: mock.client,
            suppressSdkConsoleErrors: true,
            onTurnStartAbandoned: () => {
              abandoned += 1;
            },
            // ONE retry, and the lock stays held through it: the bounded retry is
            // exhausted on purpose. The sleep is recorded, never real.
            turnStartRetry: {
              delaysMs: [1],
              sleep: async (ms) => {
                sleeps.push(ms);
              },
            },
          }),
      );
      assert.ok(holder.alive(), "the holder must still hold — otherwise this row proved nothing");

      const events = await deliveryEvents(sessionId);
      // THE WEDGE: on the unrepaired base this is 0 — no terminal, no turn, nothing.
      assert.equal(
        events.length,
        1,
        `an accepted task that never started must leave exactly ONE delivery terminal; got ${JSON.stringify(events)}`,
      );
      assert.equal(events[0].phase, "failed");
      // The one detail code deployed acpx-ui re-drives (delivery-store.ts, D3):
      // retryable, and honest only because the owner then actually exits.
      assert.equal(events[0].error.detailCode, "QUEUE_OWNER_SHUTDOWN");
      assert.equal(abandoned, 1, "the owner was told to release, so the terminal is true");
      assert.deepEqual(sleeps, [1], "the bounded retry ran once, through the async sleep");
      assert.equal(mock.promptCalls(), 0, "nothing reached the model");
      // Named for what it is in owner.log — not a generic line, not silence.
      assert.match(stderr, /could not start the turn/);
      assert.match(stderr, /OutboxError outbox-busy/);
      assert.match(stderr, new RegExp(MESSAGE_ID));
    } finally {
      await holder.release();
    }
  });
});

test("b8e251eb: a transient outbox-busy at turn start is retried in-owner, and the turn then runs normally", async () => {
  await withAcceptedNoWaitTask("acpx-b8e251eb-retry-", async ({ home, sessionId, task }) => {
    const mock = makeMockClient(async () => ({ stopReason: "end_turn" }));
    const holder = await holdOutboxLock(home);
    let abandoned = 0;
    try {
      await captureStderr(
        async () =>
          await runQueuedTask(sessionId, task, {
            sharedClient: mock.client,
            suppressSdkConsoleErrors: true,
            onTurnStartAbandoned: () => {
              abandoned += 1;
            },
            // The contention ends DURING the backoff: deterministic, no timing race.
            turnStartRetry: { delaysMs: [1, 1], sleep: async () => await holder.release() },
          }),
      );
      assert.equal(mock.promptCalls(), 1, "the retried turn reached the model exactly once");
      const events = await deliveryEvents(sessionId);
      assert.deepEqual(
        events.map((event) => event.phase),
        ["accepted", "done"],
        "one accepted + one done — the busy attempt left no stray terminal",
      );
      assert.equal(abandoned, 0, "a recovered start must not recycle the owner");
    } finally {
      await holder.release();
    }
  });
});

test("b8e251eb: a NON-transient failure before the turn starts is failed loudly and definitively, with no retry and no recycle", async () => {
  await withAcceptedNoWaitTask("acpx-b8e251eb-hard-", async ({ home, sessionId, task }) => {
    const mock = makeMockClient(async () => ({ stopReason: "end_turn" }));
    // A record that can no longer be parsed: nothing a retry can fix.
    await fs.writeFile(sessionFilePath(home, sessionId), "{not json", "utf8");
    let abandoned = 0;
    const sleeps: number[] = [];
    const { stderr } = await captureStderr(
      async () =>
        await runQueuedTask(sessionId, task, {
          sharedClient: mock.client,
          suppressSdkConsoleErrors: true,
          onTurnStartAbandoned: () => {
            abandoned += 1;
          },
          turnStartRetry: {
            delaysMs: [1, 1],
            sleep: async (ms) => {
              sleeps.push(ms);
            },
          },
        }),
    );
    const events = await deliveryEvents(sessionId);
    assert.equal(events.length, 1, `exactly one terminal; got ${JSON.stringify(events)}`);
    assert.equal(events[0].phase, "failed");
    assert.equal(
      events[0].error.detailCode,
      QUEUE_TURN_START_FAILED_DETAIL_CODE,
      "a deterministic failure must not be minted retryable — acpx-ui would bounce it for 2 h",
    );
    // The contract's `messageMatch: prefix`: the fixed text, then the real reason.
    assert.ok(
      events[0].error.message.startsWith(`${QUEUE_TURN_START_FAILED_MESSAGE}: `),
      events[0].error.message,
    );
    assert.match(events[0].error.message, /SessionNotFoundError/, "the failure carries its reason");
    assert.deepEqual(sleeps, [], "only a transient class is retried");
    assert.equal(abandoned, 0);
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
    let abandoned = 0;
    await captureStderr(
      async () =>
        await runQueuedTask(sessionId, task, {
          sharedClient: mock.client,
          suppressSdkConsoleErrors: true,
          onTurnStartAbandoned: () => {
            abandoned += 1;
          },
          turnStartRetry: { delaysMs: [1], sleep: async () => {} },
        }),
    );
    assert.equal(mock.promptCalls(), 1, "the turn started — the model was asked");
    const terminals = (await deliveryEvents(sessionId)).filter(
      (event) => event.phase !== "accepted",
    );
    assert.equal(terminals.length, 1, `exactly one terminal; got ${JSON.stringify(terminals)}`);
    assert.equal(terminals[0].phase, "failed");
    assert.notEqual(terminals[0].error.detailCode, "QUEUE_OWNER_SHUTDOWN");
    assert.equal(abandoned, 0, "a started turn is never handed back as never-delivered");
  });
});
