import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import {
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
