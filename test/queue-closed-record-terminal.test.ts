// A11 (brick://53437107 §G2b, TESTER-PLAN L1.13) — the task-refused silent drop.
//
// The acpx-ui Close button flips `closed:true` on the record and nothing else: it
// never kills the queue owner. So a live owner eventually pulls a deliver-now
// (`waitForCompletion:false`) task off `pending`, `runSessionPrompt` re-resolves the
// record, sees `closed` and throws `SessionClosedError` — deliberately, per
// brick://8f3aaa73's no-auto-reopen rule. That refusal is correct. What was wrong is
// what happened next: `sendQueuedTaskError` returns immediately when there is no
// waiter, so the owner dropped the message having written NOTHING — no delivery
// event, no terminal, no trace. Every inter-agent `/message` delivery is in that
// class.
//
// Determinism note (TESTER-PLAN §0 / §9 trap 1): there is no race here to reproduce
// and no `sleep` anywhere below. Custody is a *state* — the record is closed before
// the owner is ever asked for the task — so the pull is pinned, not timed.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import readline from "node:readline";
import test from "node:test";
import {
  type QueueTask,
  releaseQueueOwnerLease,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { connectSocket, nextJsonLine, withTempHome } from "./queue-test-helpers.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";

type DeliveryEvent = {
  method: string;
  params: {
    messageId: string;
    requestId: string;
    phase: string;
    error: { code: number; message: string; detailCode: string };
  };
};

async function readDeliveryEvents(sessionId: string): Promise<DeliveryEvent[]> {
  let payload: string;
  try {
    payload = await fs.readFile(sessionEventActivePath(sessionId), "utf8");
  } catch {
    return [];
  }
  return payload
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DeliveryEvent)
    .filter((event) => event.method === "acpx/delivery");
}

// `appendDeliveryStreamEvent` is a deliberate fire-and-forget async append
// (ipc-server.ts:154), so the write may land a tick after runQueuedTask resolves.
// Poll for the file rather than assert on a promise — same shape as
// queue-ipc-server.test.ts's waitForStreamLines. Bounded, and it is a wait for a
// write already issued, not a wait for a race to resolve.
async function waitForDeliveryEvents(sessionId: string, count: number): Promise<DeliveryEvent[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const events = await readDeliveryEvents(sessionId);
    if (events.length >= count) {
      return events;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return await readDeliveryEvents(sessionId);
}

// A local mirror of acpx-ui's `isDefinitiveGiveUp` fallback rule
// (acpx-ui `server/senderNotify.ts`): deployed acpx-ui does NOT yet know the
// `SESSION_CLOSED_UNDELIVERED` detail code (that vocabulary lands in stage 1), so
// the ONLY thing that makes it notify the sender is this case-insensitive substring
// over the human-readable reason. TESTER-PLAN §9 trap 4: assert the classification
// PROPERTY against whatever acpx actually emitted — never against a hand-copied
// duplicate of the string, which is the original class-C defect re-created in the
// test suite.
function isDefinitiveGiveUpByDeployedAcpxUi(reason: string): boolean {
  return reason.toLowerCase().includes("session closed");
}

type SubmittedTask = {
  task: QueueTask;
  // The next line the submitting client reads off its own socket — how a
  // `waitForCompletion:true` caller learns the turn's outcome.
  nextClientMessage: () => Promise<unknown>;
};

async function withClosedRecordOwner(
  sessionId: string,
  run: (context: {
    owner: SessionQueueOwner;
    submit: (options: {
      requestId: string;
      waitForCompletion: boolean;
      messageId?: string;
    }) => Promise<SubmittedTask>;
  }) => Promise<void>,
): Promise<void> {
  await withTempHome(async (homeDir) => {
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: sessionId,
        acpSessionId: `acp-${sessionId}`,
        agentCommand: "claude",
        cwd: homeDir,
        // Exactly what the acpx-ui Close button writes, and nothing else: the
        // record says closed while the owner below is very much alive.
        closed: true,
        closedAt: "2026-07-30T15:38:00.007Z",
      }),
    );

    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    const owner = await SessionQueueOwner.start(lease, {
      cancelPrompt: async () => false,
      closeSession: async () => true,
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async () => ({ configOptions: [] }),
      queryActiveTurn: () => false,
    });

    const sockets: Array<() => void> = [];
    try {
      await run({
        owner,
        submit: async ({ requestId, waitForCompletion, messageId }) => {
          const socket = await connectSocket(lease.socketPath);
          const lines = readline.createInterface({ input: socket });
          const iterator = lines[Symbol.asyncIterator]();
          sockets.push(() => {
            lines.close();
            socket.destroy();
          });
          socket.write(
            `${JSON.stringify({
              type: "submit_prompt",
              requestId,
              ownerGeneration: lease.ownerGeneration,
              ...(messageId !== undefined ? { messageId } : {}),
              message: "a consequential inter-agent message",
              permissionMode: "approve-reads",
              waitForCompletion,
            })}\n`,
          );
          const accepted = (await nextJsonLine(iterator)) as { type: string };
          assert.equal(accepted.type, "accepted");
          const task = await owner.nextTask();
          assert(task);
          return { task, nextClientMessage: async () => await nextJsonLine(iterator) };
        },
      });
    } finally {
      for (const close of sockets.splice(0)) {
        close();
      }
      await owner.close();
      await releaseQueueOwnerLease(lease);
    }
  });
}

test("A11/L1.13: a deliver-now task refused by a closed record writes a SESSION_CLOSED_UNDELIVERED terminal to disk", async () => {
  const sessionId = "a11-closed-record-deliver-now";
  await withClosedRecordOwner(sessionId, async ({ submit }) => {
    const { task } = await submit({
      requestId: "req-a11-deliver-now",
      waitForCompletion: false,
      messageId: MESSAGE_ID,
    });

    // The owner pulls it and runs it against the closed record. This must not
    // throw: the refusal is handled, not propagated.
    await runQueuedTask(sessionId, task, {});

    const events = await waitForDeliveryEvents(sessionId, 1);
    assert.equal(
      events.length,
      1,
      "exactly one acpx/delivery event — the refusal is labelled, not dropped and not double-written",
    );
    const [terminal] = events;
    assert.equal(terminal.params.messageId, MESSAGE_ID);
    assert.equal(terminal.params.requestId, "req-a11-deliver-now");
    assert.equal(terminal.params.phase, "failed");
    assert.equal(terminal.params.error.detailCode, "SESSION_CLOSED_UNDELIVERED");
  });
});

test("A11/HC-1: the terminal acpx actually emits is classified a definitive give-up by deployed acpx-ui", async () => {
  const sessionId = "a11-closed-record-classification";
  await withClosedRecordOwner(sessionId, async ({ submit }) => {
    const { task } = await submit({
      requestId: "req-a11-classification",
      waitForCompletion: false,
      messageId: MESSAGE_ID,
    });
    await runQueuedTask(sessionId, task, {});

    const events = await waitForDeliveryEvents(sessionId, 1);
    assert.equal(events.length, 1);
    // The string under test is read back OFF DISK — it is the literal acpx emits,
    // not a copy this test maintains. Reword the message without keeping the
    // `session closed` substring and this goes red, which is the point: deployed
    // acpx-ui would silently stop notifying the sender.
    const emittedReason = events[0].params.error.message;
    assert.ok(
      isDefinitiveGiveUpByDeployedAcpxUi(emittedReason),
      `deployed acpx-ui's isDefinitiveGiveUp substring rule must match the emitted reason; got: ${emittedReason}`,
    );
  });
});

// B3 (RCA b2ca4bd0 §B.6) — the same refusal, for a task with NO messageId.
//
// A11 above covers every inter-agent `/message` delivery, which always carries one.
// A bare CLI `prompt --no-wait` does not, so `deliveryStreamLine`'s `!messageId`
// early return meant this refusal wrote nothing at all — measured: `grep -c
// SESSION_CLOSED` over the session's `.stream.ndjson` was 0.
//
// An already-closed session is now refused synchronously at the CLI enqueue
// boundary, before `[queued]` is printed. What still reaches HERE is the residual
// race — a record that closed between that check and this pull — which cannot be
// prevented from the CLI side. It is made honest instead of silent.
async function readRefusedEvents(sessionId: string): Promise<DeliveryEvent[]> {
  let payload: string;
  try {
    payload = await fs.readFile(sessionEventActivePath(sessionId), "utf8");
  } catch {
    return [];
  }
  return payload
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DeliveryEvent)
    .filter((event) => event.method === "acpx/refused");
}

test("B3: a messageId-less task refused by a closed record leaves a durable trace, not silence", async () => {
  const sessionId = "b3-closed-record-no-message-id";
  await withClosedRecordOwner(sessionId, async ({ submit }) => {
    const { task } = await submit({
      requestId: "req-b3-no-message-id",
      waitForCompletion: false,
      // No messageId — this is what a bare CLI `prompt --no-wait` submits.
    });

    await runQueuedTask(sessionId, task, {});

    const refused = await readRefusedEvents(sessionId);
    assert.equal(refused.length, 1, "the refusal must leave exactly one trace, keyed on requestId");
    assert.equal(refused[0].params.requestId, "req-b3-no-message-id");
    assert.equal(refused[0].params.phase, "failed");
    assert.equal(refused[0].params.error.detailCode, "SESSION_CLOSED_UNDELIVERED");

    // The `acpx/delivery` writer must stay silent: there is no delivery lifecycle
    // to update, and inventing one would put a phantom item in front of acpx-ui.
    assert.deepEqual(await readDeliveryEvents(sessionId), []);

    // Same classification gate as HC-1, over the NEW path, asserted against the
    // string read back OFF DISK rather than a copy this test maintains.
    const emittedReason = refused[0].params.error.message;
    assert.ok(
      isDefinitiveGiveUpByDeployedAcpxUi(emittedReason),
      `the no-messageId trace must carry the same classifiable reason; got: ${emittedReason}`,
    );
  });
});

test("A11/HC-2: a task already terminalized by the closed-record refusal is not terminalized again on owner close", async () => {
  const sessionId = "a11-closed-record-single-terminal";
  await withClosedRecordOwner(sessionId, async ({ owner, submit }) => {
    const { task } = await submit({
      requestId: "req-a11-single-terminal",
      waitForCompletion: false,
      messageId: MESSAGE_ID,
    });
    await runQueuedTask(sessionId, task, {});
    assert.equal((await waitForDeliveryEvents(sessionId, 1)).length, 1);

    // Put the already-terminalized task back in front of the owner-exit writer —
    // the same `requeueAll` the mid-turn-buffer leftover path uses. `close()`
    // writes a QUEUE_OWNER_SHUTDOWN terminal for every un-terminalized deliver-now
    // task in `pending`; this one must be skipped.
    owner.requeueAll([task]);
    await owner.close();

    const events = await readDeliveryEvents(sessionId);
    assert.equal(
      events.length,
      1,
      `exactly one terminal per task, ever; got ${JSON.stringify(events.map((event) => event.params.error.detailCode))}`,
    );
    assert.equal(events[0].params.error.detailCode, "SESSION_CLOSED_UNDELIVERED");
  });
});

test("A11/HC-3: a deliver-and-wait task refused by a closed record still answers its waiter and writes no delivery terminal", async () => {
  const sessionId = "a11-closed-record-wait-for-completion";
  await withClosedRecordOwner(sessionId, async ({ submit }) => {
    const { task, nextClientMessage } = await submit({
      requestId: "req-a11-waiter",
      waitForCompletion: true,
      messageId: MESSAGE_ID,
    });

    await runQueuedTask(sessionId, task, {});

    const error = (await nextClientMessage()) as { type: string; detailCode?: string };
    assert.equal(error.type, "error");
    assert.equal(error.detailCode, "SESSION_CLOSED");

    // A11 is scoped to the class that gets NOTHING today. A waiter is told
    // directly over its own socket, so the delivery stream stays untouched.
    assert.deepEqual(await readDeliveryEvents(sessionId), []);
  });
});
