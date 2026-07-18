import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import {
  appendDeliveryStreamEvent,
  type QueueTask,
  SessionQueueOwner,
  releaseQueueOwnerLease,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { connectSocket, nextJsonLine, withTempHome } from "./queue-test-helpers.js";

async function readStreamLines(filePath: string): Promise<unknown[]> {
  const payload = await fs.readFile(filePath, "utf8");
  return payload
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

async function waitForStreamLines(filePath: string, count: number): Promise<unknown[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const lines = await readStreamLines(filePath);
      if (lines.length >= count) {
        return lines;
      }
    } catch {
      // stream may not exist until the fire-and-forget append lands
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return await readStreamLines(filePath);
}

test("SessionQueueOwner handles control requests and nextTask timeouts", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-control-success");
    assert(lease);

    let cancelled = 0;
    let closeSessionCalls = 0;
    const modes: string[] = [];
    const configRequests: Array<{ id: string; value: string }> = [];

    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => {
        cancelled += 1;
        return true;
      },
      closeSession: async () => {
        closeSessionCalls += 1;
        return true;
      },
      setSessionMode: async (modeId) => {
        modes.push(modeId);
      },
      setSessionModel: async () => {
        // no-op
      },
      setSessionConfigOption: async (configId, value) => {
        configRequests.push({ id: configId, value });
        return {
          configOptions: [],
        } as SetSessionConfigOptionResponse;
      },
      queryActiveTurn: () => false,
    });

    try {
      assert.equal(await owner.nextTask(10), undefined);

      const cancelSocket = await connectSocket(lease.socketPath);
      const cancelLines = readline.createInterface({ input: cancelSocket });
      const cancelIterator = cancelLines[Symbol.asyncIterator]();
      cancelSocket.write(
        `${JSON.stringify({
          type: "cancel_prompt",
          requestId: "req-cancel",
        })}\n`,
      );

      const cancelAccepted = (await nextJsonLine(cancelIterator)) as { type: string };
      const cancelResult = (await nextJsonLine(cancelIterator)) as {
        type: string;
        cancelled: boolean;
      };
      assert.equal(cancelAccepted.type, "accepted");
      assert.equal(cancelResult.type, "cancel_result");
      assert.equal(cancelResult.cancelled, true);
      cancelLines.close();
      cancelSocket.destroy();

      const modeSocket = await connectSocket(lease.socketPath);
      const modeLines = readline.createInterface({ input: modeSocket });
      const modeIterator = modeLines[Symbol.asyncIterator]();
      modeSocket.write(
        `${JSON.stringify({
          type: "set_mode",
          requestId: "req-mode",
          modeId: "plan",
          timeoutMs: 250,
        })}\n`,
      );

      const modeAccepted = (await nextJsonLine(modeIterator)) as { type: string };
      const modeResult = (await nextJsonLine(modeIterator)) as { type: string; modeId: string };
      assert.equal(modeAccepted.type, "accepted");
      assert.equal(modeResult.type, "set_mode_result");
      assert.equal(modeResult.modeId, "plan");
      modeLines.close();
      modeSocket.destroy();

      const configSocket = await connectSocket(lease.socketPath);
      const configLines = readline.createInterface({ input: configSocket });
      const configIterator = configLines[Symbol.asyncIterator]();
      configSocket.write(
        `${JSON.stringify({
          type: "set_config_option",
          requestId: "req-config",
          configId: "thinking_level",
          value: "high",
          timeoutMs: 250,
        })}\n`,
      );

      const configAccepted = (await nextJsonLine(configIterator)) as { type: string };
      const configResult = (await nextJsonLine(configIterator)) as {
        type: string;
        response: { configOptions: unknown[] };
      };
      assert.equal(configAccepted.type, "accepted");
      assert.equal(configResult.type, "set_config_option_result");
      assert.deepEqual(configResult.response.configOptions, []);
      configLines.close();
      configSocket.destroy();

      const closeSocket = await connectSocket(lease.socketPath);
      const closeLines = readline.createInterface({ input: closeSocket });
      const closeIterator = closeLines[Symbol.asyncIterator]();
      closeSocket.write(
        `${JSON.stringify({
          type: "close_session",
          requestId: "req-close-session",
          timeoutMs: 250,
        })}\n`,
      );

      const closeAccepted = (await nextJsonLine(closeIterator)) as { type: string };
      const closeResult = (await nextJsonLine(closeIterator)) as {
        type: string;
        closed: boolean;
      };
      assert.equal(closeAccepted.type, "accepted");
      assert.equal(closeResult.type, "close_session_result");
      assert.equal(closeResult.closed, true);
      closeLines.close();
      closeSocket.destroy();

      assert.equal(cancelled, 1);
      assert.equal(closeSessionCalls, 1);
      assert.deepEqual(modes, ["plan"]);
      assert.deepEqual(configRequests, [{ id: "thinking_level", value: "high" }]);
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("SessionQueueOwner nextTask without ttl waits until a prompt arrives", async () => {
  await withTempHome(async () => {
    const sessionId = "owner-ttl-zero";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);

    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => false,
      closeSession: async () => false,
      setSessionMode: async () => {
        // no-op
      },
      setSessionModel: async () => {
        // no-op
      },
      setSessionConfigOption: async () =>
        ({
          configOptions: [],
        }) as SetSessionConfigOptionResponse,
      queryActiveTurn: () => false,
    });

    try {
      const pendingTask = owner.nextTask(undefined);
      const beforePrompt = await Promise.race([
        pendingTask.then(() => "resolved"),
        new Promise<"waiting">((resolve) => {
          setTimeout(() => resolve("waiting"), 30);
        }),
      ]);
      assert.equal(beforePrompt, "waiting");

      const promptSocket = await connectSocket(lease.socketPath);
      const promptLines = readline.createInterface({ input: promptSocket });
      const promptIterator = promptLines[Symbol.asyncIterator]();
      promptSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-ttl-zero",
          ownerGeneration: lease.ownerGeneration,
          message: "hello",
          permissionMode: "approve-reads",
          waitForCompletion: false,
        })}\n`,
      );

      const accepted = (await nextJsonLine(promptIterator)) as { type: string };
      assert.equal(accepted.type, "accepted");
      const task = await pendingTask;
      assert(task);
      assert.equal(task.requestId, "req-ttl-zero");
      promptLines.close();
      promptSocket.destroy();
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("SessionQueueOwner coalesces concurrent repairs of an externally unlinked socket", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withTempHome(async () => {
    const sessionId = "owner-socket-repair";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);

    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => false,
      closeSession: async () => false,
      setSessionMode: async () => {
        // no-op
      },
      setSessionModel: async () => {
        // no-op
      },
      setSessionConfigOption: async () =>
        ({
          configOptions: [],
        }) as SetSessionConfigOptionResponse,
      queryActiveTurn: () => false,
    });

    try {
      await fs.unlink(lease.socketPath);
      await assert.rejects(fs.access(lease.socketPath), { code: "ENOENT" });

      const repairs = await Promise.all([
        owner.repairSocketIfMissing(),
        owner.repairSocketIfMissing(),
        owner.repairSocketIfMissing(),
      ]);
      assert.equal(
        repairs.filter(Boolean).length >= 1,
        true,
        "at least one coalesced caller observes the completed repair",
      );
      assert.equal((await fs.stat(lease.socketPath)).isSocket(), true);

      const promptSocket = await connectSocket(lease.socketPath);
      const promptLines = readline.createInterface({ input: promptSocket });
      const promptIterator = promptLines[Symbol.asyncIterator]();
      promptSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-after-socket-repair",
          ownerGeneration: lease.ownerGeneration,
          messageId: "55555555-5555-4555-8555-555555555555",
          message: "accepted exactly once",
          permissionMode: "approve-reads",
          waitForCompletion: false,
        })}\n`,
      );

      const accepted = (await nextJsonLine(promptIterator)) as {
        type: string;
        ownerGeneration?: number;
      };
      assert.equal(accepted.type, "accepted");
      assert.equal(accepted.ownerGeneration, lease.ownerGeneration);
      const task = await owner.nextTask();
      assert(task);
      assert.equal(task.requestId, "req-after-socket-repair");
      assert.equal(task.messageId, "55555555-5555-4555-8555-555555555555");
      assert.equal(await owner.nextTask(25), undefined, "repair must not duplicate the task");
      promptLines.close();
      promptSocket.destroy();
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("SessionQueueOwner enqueues fire-and-forget prompts and rejects invalid owner generations", async () => {
  await withTempHome(async () => {
    const sessionId = "owner-prompt-success";
    const streamPath = sessionEventActivePath(sessionId);
    await fs.mkdir(path.dirname(streamPath), { recursive: true });
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);

    const queueDepths: number[] = [];
    const owner = await SessionQueueOwner.start(
      lease,
      {
        cancelPrompt: async () => false,
        closeSession: async () => false,
        setSessionMode: async () => {
          // no-op
        },
        setSessionModel: async () => {
          // no-op
        },
        setSessionConfigOption: async () =>
          ({
            configOptions: [],
          }) as SetSessionConfigOptionResponse,
        queryActiveTurn: () => false,
      },
      {
        maxQueueDepth: 4,
        onQueueDepthChanged: (depth) => {
          queueDepths.push(depth);
        },
      },
    );

    try {
      const promptSocket = await connectSocket(lease.socketPath);
      const promptLines = readline.createInterface({ input: promptSocket });
      const promptIterator = promptLines[Symbol.asyncIterator]();
      promptSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-submit",
          ownerGeneration: lease.ownerGeneration,
          messageId: "11111111-1111-4111-8111-111111111111",
          message: "hello from queue",
          permissionMode: "approve-reads",
          waitForCompletion: false,
        })}\n`,
      );

      const accepted = (await nextJsonLine(promptIterator)) as {
        type: string;
        ownerGeneration?: number;
      };
      assert.equal(accepted.type, "accepted");
      assert.equal(accepted.ownerGeneration, lease.ownerGeneration);

      const receivedEvents = await waitForStreamLines(streamPath, 1);
      assert.deepEqual(receivedEvents[0], {
        jsonrpc: "2.0",
        method: "acpx/received",
        params: {
          requestId: "req-submit",
          messageId: "11111111-1111-4111-8111-111111111111",
          at: (receivedEvents[0] as { params: { at: string } }).params.at,
        },
      });
      assert.equal(typeof (receivedEvents[0] as { params: { at: unknown } }).params.at, "string");

      const task = await owner.nextTask();
      assert(task);
      assert.equal(task.requestId, "req-submit");
      assert.equal(task.messageId, "11111111-1111-4111-8111-111111111111");
      assert.equal(task.message, "hello from queue");
      assert.deepEqual(task.prompt, [{ type: "text", text: "hello from queue" }]);
      assert.equal(owner.queueDepth(), 0);
      assert.deepEqual(queueDepths, [1, 0]);
      promptLines.close();
      promptSocket.destroy();

      const noMessageIdSocket = await connectSocket(lease.socketPath);
      const noMessageIdLines = readline.createInterface({ input: noMessageIdSocket });
      const noMessageIdIterator = noMessageIdLines[Symbol.asyncIterator]();
      noMessageIdSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-submit-no-message-id",
          ownerGeneration: lease.ownerGeneration,
          message: "hello without message id",
          permissionMode: "approve-reads",
          waitForCompletion: false,
        })}\n`,
      );

      const noMessageIdAccepted = (await nextJsonLine(noMessageIdIterator)) as {
        type: string;
        ownerGeneration?: number;
      };
      assert.equal(noMessageIdAccepted.type, "accepted");
      assert.equal(noMessageIdAccepted.ownerGeneration, lease.ownerGeneration);
      const secondReceivedEvents = await waitForStreamLines(streamPath, 2);
      const noMessageIdEvent = secondReceivedEvents[1] as {
        method: string;
        params: Record<string, unknown>;
      };
      assert.equal(noMessageIdEvent.method, "acpx/received");
      assert.equal(noMessageIdEvent.params.requestId, "req-submit-no-message-id");
      assert.equal(Object.hasOwn(noMessageIdEvent.params, "messageId"), false);
      assert.equal(typeof noMessageIdEvent.params.at, "string");

      const noMessageIdTask = await owner.nextTask();
      assert(noMessageIdTask);
      assert.equal(noMessageIdTask.requestId, "req-submit-no-message-id");
      assert.equal(noMessageIdTask.messageId, undefined);
      noMessageIdLines.close();
      noMessageIdSocket.destroy();

      const badSocket = await connectSocket(lease.socketPath);
      const badLines = readline.createInterface({ input: badSocket });
      const badIterator = badLines[Symbol.asyncIterator]();
      badSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-bad-generation",
          ownerGeneration: lease.ownerGeneration + 1,
          message: "stale",
          permissionMode: "approve-reads",
          waitForCompletion: true,
        })}\n`,
      );

      const mismatch = (await nextJsonLine(badIterator)) as {
        type: string;
        detailCode?: string;
      };
      assert.equal(mismatch.type, "error");
      assert.equal(mismatch.detailCode, "QUEUE_OWNER_GENERATION_MISMATCH");
      badLines.close();
      badSocket.destroy();

      const invalidSocket = await connectSocket(lease.socketPath);
      const invalidLines = readline.createInterface({ input: invalidSocket });
      const invalidIterator = invalidLines[Symbol.asyncIterator]();
      invalidSocket.write(
        `${JSON.stringify({
          type: "set_mode",
          requestId: "req-invalid",
          modeId: "",
        })}\n`,
      );

      const invalid = (await nextJsonLine(invalidIterator)) as {
        type: string;
        detailCode?: string;
      };
      assert.equal(invalid.type, "error");
      assert.equal(invalid.detailCode, "QUEUE_REQUEST_INVALID");
      invalidLines.close();
      invalidSocket.destroy();
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

test("SessionQueueOwner rejects stale-generation submit_prompt without enqueueing", async () => {
  await withTempHome(async () => {
    const sessionId = "owner-stale-generation-submit";
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);

    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => false,
      closeSession: async () => false,
      setSessionMode: async () => {
        // no-op
      },
      setSessionModel: async () => {
        // no-op
      },
      setSessionConfigOption: async () =>
        ({
          configOptions: [],
        }) as SetSessionConfigOptionResponse,
      queryActiveTurn: () => false,
    });

    try {
      const badSocket = await connectSocket(lease.socketPath);
      const badLines = readline.createInterface({ input: badSocket });
      const badIterator = badLines[Symbol.asyncIterator]();
      badSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-stale-generation-submit",
          ownerGeneration: lease.ownerGeneration + 1,
          messageId: "44444444-4444-4444-8444-444444444444",
          message: "must not enqueue",
          permissionMode: "approve-reads",
          waitForCompletion: false,
        })}\n`,
      );

      const mismatch = (await nextJsonLine(badIterator)) as {
        type: string;
        detailCode?: string;
      };
      assert.equal(mismatch.type, "error");
      assert.equal(mismatch.detailCode, "QUEUE_OWNER_GENERATION_MISMATCH");
      assert.equal(await owner.nextTask(25), undefined);
      badLines.close();
      badSocket.destroy();
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});

// --- C4: midTurnBuffer order, visibility, owner-exit safety (FIX-DESIGN §2.4) --

const NOOP_CONTROL_HANDLERS = {
  cancelPrompt: async () => false,
  closeSession: async () => false,
  setSessionMode: async () => {},
  setSessionModel: async () => {},
  setSessionConfigOption: async () => ({ configOptions: [] }) as SetSessionConfigOptionResponse,
  queryActiveTurn: () => false,
};

function makeDirectTask(requestId: string, enqueuedAt: number, messageId?: string): QueueTask {
  return {
    requestId,
    ...(messageId !== undefined ? { messageId } : {}),
    message: requestId,
    prompt: [{ type: "text", text: requestId }],
    permissionMode: "approve-all",
    waitForCompletion: false,
    enqueuedAt,
    send: () => {},
    close: () => {},
  } as QueueTask;
}

function deliveryEventsOnStream(lines: unknown[]): Record<string, unknown>[] {
  return lines
    .filter((line) => (line as { method?: unknown }).method === "acpx/delivery")
    .map((line) => (line as { params: Record<string, unknown> }).params);
}

// C4 FIFO: requeueAll preserves arrival order (oldest-first) instead of the old
// per-item unshift that reversed the batch (RCA §3, a2520124). A newer task
// requeued in a later call still sorts behind older ones.
test("SessionQueueOwner requeueAll drains buffered tasks in arrival order, not reversed", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-requeue-order");
    assert(lease);
    const owner = await SessionQueueOwner.start(lease, NOOP_CONTROL_HANDLERS);
    try {
      // Batch presented newest-first (as the reversing unshift would have left it);
      // requeueAll must still hand them back oldest-first.
      owner.requeueAll([
        makeDirectTask("c", 3_000),
        makeDirectTask("a", 1_000),
        makeDirectTask("b", 2_000),
      ]);
      // A task that arrived even earlier, requeued in a SEPARATE later call, must
      // still jump ahead — arrival time is the single invariant.
      owner.requeueAll([makeDirectTask("older", 500)]);

      const order: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const task = await owner.nextTask(50);
        assert(task, `expected task ${i}`);
        order.push(task.requestId);
      }
      assert.deepEqual(order, ["older", "a", "b", "c"]);
    } finally {
      await owner.close();
    }
  });
});

// C4 visibility: appendDeliveryStreamEvent writes an acpx/delivery event straight
// to the session stream (the direct-appendFile pattern), and skips tasks with no
// messageId (no delivery lifecycle to update).
test("appendDeliveryStreamEvent writes a queued visibility event and skips message-id-less tasks", async () => {
  await withTempHome(async () => {
    const sessionId = "owner-queued-visibility";
    const streamPath = sessionEventActivePath(sessionId);
    await fs.mkdir(path.dirname(streamPath), { recursive: true });

    appendDeliveryStreamEvent(
      sessionId,
      { requestId: "req-queued", messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      "queued",
    );
    // No messageId ⇒ no delivery event emitted.
    appendDeliveryStreamEvent(
      sessionId,
      { requestId: "req-no-mid", messageId: undefined },
      "queued",
    );

    const lines = await waitForStreamLines(streamPath, 1);
    const deliveries = deliveryEventsOnStream(lines);
    assert.equal(
      deliveries.length,
      1,
      "exactly one delivery event (the message-id-less one is skipped)",
    );
    assert.equal(deliveries[0]?.messageId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(deliveries[0]?.requestId, "req-queued");
    assert.equal(deliveries[0]?.phase, "queued");
    assert.equal(typeof deliveries[0]?.at, "string");
  });
});

// C4 owner-exit safety: on close(), a deliver-now (waitForCompletion:false)
// pending task — whose socket was already closed on acceptance — gets a retryable
// QUEUE_OWNER_SHUTDOWN terminal on the stream so it is not accepted-forever. A
// wait-mode pending task still gets its QUEUE_OWNER_SHUTTING_DOWN socket error and
// NO stream terminal (its caller is notified directly).
test("SessionQueueOwner.close writes a QUEUE_OWNER_SHUTDOWN terminal for a dropped deliver-now task", async () => {
  await withTempHome(async () => {
    const sessionId = "owner-shutdown-terminal";
    const streamPath = sessionEventActivePath(sessionId);
    await fs.mkdir(path.dirname(streamPath), { recursive: true });
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const owner = await SessionQueueOwner.start(lease, NOOP_CONTROL_HANDLERS);

    const deliverNowMessageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const waitModeMessageId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    // Submit a deliver-now prompt; its socket closes on acceptance and it lands
    // in pending (nothing consumes it — no adapter loop here).
    const deliverNowSocket = await connectSocket(lease.socketPath);
    const deliverNowLines = readline.createInterface({ input: deliverNowSocket });
    const deliverNowIterator = deliverNowLines[Symbol.asyncIterator]();
    deliverNowSocket.write(
      `${JSON.stringify({
        type: "submit_prompt",
        requestId: "req-deliver-now",
        ownerGeneration: lease.ownerGeneration,
        messageId: deliverNowMessageId,
        message: "deliver now",
        permissionMode: "approve-reads",
        waitForCompletion: false,
      })}\n`,
    );
    assert.equal(((await nextJsonLine(deliverNowIterator)) as { type: string }).type, "accepted");

    // Submit a wait-mode prompt; it stays pending with its socket open.
    const waitSocket = await connectSocket(lease.socketPath);
    const waitLines = readline.createInterface({ input: waitSocket });
    const waitIterator = waitLines[Symbol.asyncIterator]();
    waitSocket.write(
      `${JSON.stringify({
        type: "submit_prompt",
        requestId: "req-wait-mode",
        ownerGeneration: lease.ownerGeneration,
        messageId: waitModeMessageId,
        message: "wait mode",
        permissionMode: "approve-reads",
        waitForCompletion: true,
      })}\n`,
    );
    assert.equal(((await nextJsonLine(waitIterator)) as { type: string }).type, "accepted");
    // Both `acpx/received` markers landed before we shut down.
    await waitForStreamLines(streamPath, 2);

    // Shut the owner down with both tasks still pending.
    await owner.close();

    // The wait-mode caller is notified on its socket …
    const waitError = (await nextJsonLine(waitIterator)) as {
      type: string;
      detailCode?: string;
      retryable?: boolean;
    };
    assert.equal(waitError.type, "error");
    assert.equal(waitError.detailCode, "QUEUE_OWNER_SHUTTING_DOWN");

    const deliveries = deliveryEventsOnStream(await readStreamLines(streamPath));
    // … the deliver-now task gets a stream terminal (its socket was already closed) …
    const shutdownTerminal = deliveries.find((event) => event.messageId === deliverNowMessageId);
    assert.ok(shutdownTerminal, "deliver-now task got a QUEUE_OWNER_SHUTDOWN terminal");
    assert.equal(shutdownTerminal?.phase, "failed");
    assert.equal(
      (shutdownTerminal?.error as { detailCode?: string } | undefined)?.detailCode,
      "QUEUE_OWNER_SHUTDOWN",
    );
    // … and the wait-mode task gets NO stream terminal (notified via its socket).
    assert.equal(
      deliveries.some((event) => event.messageId === waitModeMessageId),
      false,
      "wait-mode task is notified on its socket, not via a stream terminal",
    );

    deliverNowLines.close();
    deliverNowSocket.destroy();
    waitLines.close();
    waitSocket.destroy();
  });
});

// P2d (brick c85d7737 §6) — the primitive the owner's final-poll-before-release relies
// on: a task submitted in the release window is retrievable by a NON-BLOCKING
// nextTask(0), and an empty queue returns undefined immediately (so releasing when
// truly idle is not delayed).
test("P2d: nextTask(0) is a non-blocking peek — returns a pending task at once, else undefined", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("owner-p2d-final-poll");
    assert(lease);
    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => false,
      closeSession: async () => false,
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async () => ({ configOptions: [] }) as SetSessionConfigOptionResponse,
      queryActiveTurn: () => false,
    });
    try {
      // Empty queue → the non-blocking peek returns undefined (release proceeds).
      assert.equal(await owner.nextTask(0), undefined, "empty queue: nextTask(0) is undefined");

      // A task raced into the queue (the TOCTOU window) → nextTask(0) returns it
      // immediately, so the owner processes it instead of releasing.
      const promptSocket = await connectSocket(lease.socketPath);
      const promptLines = readline.createInterface({ input: promptSocket });
      const promptIterator = promptLines[Symbol.asyncIterator]();
      promptSocket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-p2d-latetask",
          ownerGeneration: lease.ownerGeneration,
          message: "raced the release decision",
          permissionMode: "approve-reads",
          waitForCompletion: false,
        })}\n`,
      );
      const accepted = (await nextJsonLine(promptIterator)) as { type: string };
      assert.equal(accepted.type, "accepted");

      const late = await owner.nextTask(0);
      assert(late, "nextTask(0) returns the raced task without blocking");
      assert.equal(late.requestId, "req-p2d-latetask");
      // Consumed → a subsequent peek is empty again.
      assert.equal(await owner.nextTask(0), undefined);
      promptLines.close();
      promptSocket.destroy();
    } finally {
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
});
