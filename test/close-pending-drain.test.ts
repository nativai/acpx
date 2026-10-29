import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import {
  QUEUE_OWNER_CLOSE_PENDING_DETAIL_CODE,
  QUEUE_OWNER_CLOSE_PENDING_MESSAGE,
  QUEUE_OWNER_CLOSING_DETAIL_CODE,
  SESSION_CLOSED_UNDELIVERED_DETAIL_CODE,
} from "../src/cli/queue/delivery-terminals.js";
import {
  isOwnerShutdownDetailCode,
  type QueueOwnerControlHandlers,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import {
  isSessionCloseDrainActive,
  resetSessionCloseIntentForTests,
} from "../src/cli/queue/session-close-intent.js";
import type { LiveBackgroundTask } from "../src/cli/session/background-task-tracker.js";
import type { DepthProjection } from "../src/session/depth-projection.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { FIXTURE_TASKS } from "./bg-task-fixtures.js";
import { connectSocket, nextJsonLine, withTempHome } from "./queue-test-helpers.js";

// brick ad6ba1c2 v3.1 (CONCEPTION §6.4) — an UNFORCED close drains in two phases. P1 (close-pending) is
// fully reversible: retryable rejections whose text acpx-ui re-drives, no new work, no close note, no
// custody terminals, and a background-task CHECK on every poll. A live task ABORTS (the close is
// refused, the owner resumes); otherwise the drain COMMITS, synchronously with the last CHECK, into
// today's irreversible drain. The negative control replays the same script on today's drain.

const MONITOR: LiveBackgroundTask = FIXTURE_TASKS[1];

type Scripted = { activeTurn: boolean; tasks: LiveBackgroundTask[] };

function handlers(state: Scripted): QueueOwnerControlHandlers {
  return {
    cancelPrompt: async () => false,
    closeSession: async () => true,
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }) as SetSessionConfigOptionResponse,
    setDepth: async (requested: string): Promise<DepthProjection> => ({
      kind: "send-nothing",
      requested,
    }),
    queryActiveTurn: () => state.activeTurn,
    queryBackgroundTasks: () => ({ source: "adapter", tasks: state.tasks, monitorCommands: [] }),
  };
}

async function withOwner(
  sessionId: string,
  state: Scripted,
  run: (owner: SessionQueueOwner, socketPath: string) => Promise<void>,
): Promise<void> {
  resetSessionCloseIntentForTests();
  await fs.mkdir(path.dirname(sessionEventActivePath(sessionId)), { recursive: true });
  const lease = await tryAcquireQueueOwnerLease(sessionId);
  assert(lease, "expected to acquire a queue-owner lease");
  const owner = await SessionQueueOwner.start(lease, handlers(state), { maxQueueDepth: 32 });
  try {
    await run(owner, lease.socketPath);
  } finally {
    await owner.close();
    resetSessionCloseIntentForTests();
  }
}

/** Submits a deliver-now prompt and returns the owner's FIRST frame (accepted, or the rejection). */
async function submit(socketPath: string, id: string): Promise<Record<string, unknown>> {
  const socket = await connectSocket(socketPath);
  const lines = readline.createInterface({ input: socket });
  socket.write(
    `${JSON.stringify({
      type: "submit_prompt",
      requestId: `req-${id}`,
      messageId: `msg-${id}`,
      message: `hello ${id}`,
      permissionMode: "approve-all",
      waitForCompletion: false,
    })}\n`,
  );
  const first = (await nextJsonLine(lines[Symbol.asyncIterator]())) as Record<string, unknown>;
  lines.close();
  socket.destroy();
  return first;
}

async function terminalsFor(sessionId: string, messageId: string): Promise<unknown[]> {
  const raw = await fs.readFile(sessionEventActivePath(sessionId), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as { method?: string; params?: { messageId?: string; phase?: string } },
    )
    .filter(
      (event) =>
        event.method === "acpx/delivery" &&
        event.params?.messageId === messageId &&
        (event.params.phase === "failed" || event.params.phase === "done"),
    );
}

test("T-RACE-1: a Monitor registering DURING an unforced close's drain ABORTS it — nothing noted or terminalized, S1 retryable, P0 kept and handed out, later submissions accepted", async () => {
  await withTempHome(async () => {
    const sessionId = "race-abort";
    const state: Scripted = { activeTurn: true, tasks: [] };
    await withOwner(sessionId, state, async (owner, socketPath) => {
      assert.equal((await submit(socketPath, "p0")).type, "accepted");
      assert.equal(owner.queueDepth(), 1, "P0 pinned before the drain");

      const drain = owner.drainDeliveries("session-close", 30_000, true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(owner.isClosePending(), true);
      assert.equal(owner.isDraining(), false, "P1 is not the irreversible drain");
      // A runtime parked in nextTask during P1 gets nothing yet…
      let parkedResult: unknown = "pending";
      const parked = owner.nextTask(10_000).then((task) => {
        parkedResult = task;
      });
      const s1 = await submit(socketPath, "s1");
      assert.equal(s1.type, "error");
      assert.equal(s1.detailCode, QUEUE_OWNER_CLOSE_PENDING_DETAIL_CODE);
      assert.equal(s1.retryable, true);
      assert.doesNotMatch(String(s1.message).toLowerCase(), /session is closed/);

      // At +200 ms the model's Monitor registers.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(parkedResult, "pending", "P1 must hand out no work");
      state.tasks = [MONITOR];
      const report = await drain;

      assert.equal(report.taskCheck, "refused");
      assert.deepEqual(report.tasks, [MONITOR]);
      assert.deepEqual([report.drained, report.undelivered], [0, []]);
      assert.equal(owner.isDraining(), false);
      assert.equal(owner.isClosePending(), false);
      assert.equal(isSessionCloseDrainActive(sessionId), false, "no close note on an abort");
      assert.deepEqual(
        await terminalsFor(sessionId, "msg-p0"),
        [],
        "P0 got a terminal on an abort",
      );
      // …and on ABORT the parked waiter receives the held item.
      await parked;
      assert.equal((parkedResult as { messageId?: string } | undefined)?.messageId, "msg-p0");
      assert.equal((await submit(socketPath, "after")).type, "accepted", "service resumed");
    });
  });
});

test("T-RACE-1 negative control: the SAME script on today's drain (no check) terminalizes P0 as closed, stays draining, and rejects S1 as 'Session is closed'", async () => {
  await withTempHome(async () => {
    const sessionId = "race-today";
    const state: Scripted = { activeTurn: true, tasks: [] };
    await withOwner(sessionId, state, async (owner, socketPath) => {
      assert.equal((await submit(socketPath, "p0")).type, "accepted");
      const drain = owner.drainDeliveries("session-close", 400);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const s1 = await submit(socketPath, "s1");
      assert.equal(s1.detailCode, QUEUE_OWNER_CLOSING_DETAIL_CODE);
      assert.match(String(s1.message).toLowerCase(), /session is closed/);
      state.tasks = [MONITOR];
      const report = await drain;
      assert.equal(report.taskCheck, undefined, "today's drain has no check");
      assert.equal(owner.isDraining(), true);
      const terminals = (await terminalsFor(sessionId, "msg-p0")) as Array<{
        params: { error?: { detailCode?: string } };
      }>;
      assert.equal(terminals[0]?.params.error?.detailCode, SESSION_CLOSED_UNDELIVERED_DETAIL_CODE);
    });
  });
});

test("T-RACE-3: no task during the drain ⇒ COMMIT — taskCheck:passed, and today's drain report and terminals, unchanged", async () => {
  await withTempHome(async () => {
    const sessionId = "race-commit";
    const state: Scripted = { activeTurn: true, tasks: [] };
    await withOwner(sessionId, state, async (owner, socketPath) => {
      assert.equal((await submit(socketPath, "p0")).type, "accepted");
      const drain = owner.drainDeliveries("session-close", 30_000, true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      state.activeTurn = false;
      const report = await drain;
      assert.equal(report.taskCheck, "passed");
      assert.equal(report.turnSettled, true);
      assert.deepEqual(report.undelivered, [{ requestId: "req-p0", messageId: "msg-p0" }]);
      assert.equal(owner.isDraining(), true, "committed: irreversible from here");
      assert.equal(owner.isClosePending(), false);
      assert.equal(isSessionCloseDrainActive(sessionId), true);
      const terminals = (await terminalsFor(sessionId, "msg-p0")) as Array<{
        params: { error?: { detailCode?: string } };
      }>;
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0]?.params.error?.detailCode, SESSION_CLOSED_UNDELIVERED_DETAIL_CODE);
      assert.equal((await submit(socketPath, "late")).detailCode, QUEUE_OWNER_CLOSING_DETAIL_CODE);
    });
  });
});

test("T-RACE-3b: a drain whose deadline passes with the turn still running commits too (turnSettled:false) when no task is live", async () => {
  await withTempHome(async () => {
    const state: Scripted = { activeTurn: true, tasks: [] };
    await withOwner("race-deadline", state, async (owner) => {
      const report = await owner.drainDeliveries("session-close", 150, true);
      assert.deepEqual([report.taskCheck, report.turnSettled], ["passed", false]);
      assert.equal(owner.isDraining(), true);
    });
  });
});

test("T-RACE-5: the close-pending rejection text holds none of acpx-ui's terminal words, and the code is not an owner-shutdown code", () => {
  const text = QUEUE_OWNER_CLOSE_PENDING_MESSAGE.toLowerCase();
  for (const terminal of ["session is closed", "read-only", "template"]) {
    assert.ok(
      !text.includes(terminal),
      `"${terminal}" would make acpx-ui fail the delivery for good`,
    );
  }
  assert.equal(isOwnerShutdownDetailCode(QUEUE_OWNER_CLOSE_PENDING_DETAIL_CODE), false);
  // Positive control: the predicate does recognise the real shutdown codes.
  assert.equal(isOwnerShutdownDetailCode("QUEUE_OWNER_SHUTTING_DOWN"), true);
});
