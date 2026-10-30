// brick 9d34a178 — the decision logic of a deferred close, at the owner and in the CLI's choice of
// arm. The end-to-end proof with a real owner and a real agent is test/deferred-self-close.test.ts;
// these rows pin each rule on its own so a regression names the rule it broke.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import {
  type QueueOwnerControlHandlers,
  type QueueTask,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
  tryScheduleCloseOnRunningOwner,
} from "../src/cli/queue/ipc.js";
import { parseQueueOwnerMessage, parseQueueRequest } from "../src/cli/queue/messages.js";
import { resetSessionCloseIntentForTests } from "../src/cli/queue/session-close-intent.js";
import { ownerExitReapsTranscripts } from "../src/cli/session/owner-exit-transcript-reap.js";
import { formatDeferredCloseRefusedLine } from "../src/cli/session/queue-owner-runtime.js";
import {
  closeDefersToTurnEnd,
  DeferredCloseUnavailableError,
} from "../src/cli/session/session-control.js";
import type { DepthProjection } from "../src/session/depth-projection.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { connectSocket, nextJsonLine, withTempHome } from "./queue-test-helpers.js";

type Scripted = { activeTurn: boolean };

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
    queryBackgroundTasks: () => ({ source: "adapter", tasks: [], monitorCommands: [] }),
  };
}

async function withOwner(
  sessionId: string,
  state: Scripted,
  run: (owner: SessionQueueOwner, socketPath: string) => Promise<void>,
): Promise<void> {
  await withTempHome(async () => {
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
  });
}

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

test("arm choice: a self-close defers unless --now; any other caller only with --after-turn", () => {
  assert.equal(closeDefersToTurnEnd(true, "default"), true);
  assert.equal(closeDefersToTurnEnd(true, "after-turn"), true);
  assert.equal(closeDefersToTurnEnd(true, "now"), false, "--now keeps the immediate self arm");
  assert.equal(closeDefersToTurnEnd(false, "default"), false, "a plain close is unchanged");
  assert.equal(closeDefersToTurnEnd(false, "now"), false);
  assert.equal(closeDefersToTurnEnd(false, "after-turn"), true);
});

test("schedule_close round-trips through the wire parsers; unknown flags are dropped, not trusted", () => {
  assert.deepEqual(
    parseQueueRequest({
      type: "schedule_close",
      requestId: "r1",
      killBackgroundTasks: true,
      onlyIfActiveTurn: true,
    }),
    {
      type: "schedule_close",
      requestId: "r1",
      ownerGeneration: undefined,
      killBackgroundTasks: true,
      onlyIfActiveTurn: true,
    },
  );
  // NEGATIVE: a non-`true` value is never read as force.
  assert.deepEqual(
    parseQueueRequest({ type: "schedule_close", requestId: "r2", killBackgroundTasks: "yes" }),
    { type: "schedule_close", requestId: "r2", ownerGeneration: undefined },
  );
  assert.deepEqual(
    parseQueueOwnerMessage({
      type: "schedule_close_result",
      requestId: "r1",
      scheduled: true,
      activeTurn: false,
    }),
    {
      type: "schedule_close_result",
      requestId: "r1",
      ownerGeneration: undefined,
      scheduled: true,
      activeTurn: false,
    },
  );
  // NEGATIVE: a result missing its booleans is malformed, never "scheduled".
  assert.equal(
    parseQueueOwnerMessage({ type: "schedule_close_result", requestId: "r1", scheduled: true }),
    null,
  );
});

test("owner: a request during a turn is recorded; force only ever accumulates; take() clears it", async () => {
  await withOwner("dc-record", { activeTurn: true }, async (owner) => {
    assert.deepEqual(owner.scheduleClose({ killBackgroundTasks: false, onlyIfActiveTurn: false }), {
      scheduled: true,
      activeTurn: true,
    });
    owner.scheduleClose({ killBackgroundTasks: true, onlyIfActiveTurn: false });
    owner.scheduleClose({ killBackgroundTasks: false, onlyIfActiveTurn: false });
    const taken = owner.takeDeferredClose();
    assert.equal(taken?.killBackgroundTasks, true, "a later unforced request never drops force");
    assert.equal(typeof taken?.requestedAt, "string");
    assert.equal(owner.hasDeferredClose(), false);
    assert.equal(owner.takeDeferredClose(), undefined);
  });
});

test("owner: --after-turn on an IDLE owner records nothing (the caller closes now)", async () => {
  await withOwner("dc-idle", { activeTurn: false }, async (owner) => {
    assert.deepEqual(owner.scheduleClose({ killBackgroundTasks: false, onlyIfActiveTurn: true }), {
      scheduled: false,
      activeTurn: false,
    });
    assert.equal(owner.hasDeferredClose(), false);
  });
});

test("owner: a self request on an IDLE owner wakes the parked runtime at once, empty-handed", async () => {
  await withOwner("dc-wake", { activeTurn: false }, async (owner) => {
    const startedAt = Date.now();
    const parked = owner.nextTask(30_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    owner.scheduleClose({ killBackgroundTasks: false, onlyIfActiveTurn: false });
    assert.equal(await parked, undefined);
    assert.ok(Date.now() - startedAt < 5_000, "woken, not timed out");
  });
});

test("G3: while a deferred close waits, a queued prompt is never handed out — and is once it is dropped", async () => {
  await withOwner("dc-nostart", { activeTurn: true }, async (owner, socketPath) => {
    owner.scheduleClose({ killBackgroundTasks: false, onlyIfActiveTurn: false });
    assert.equal((await submit(socketPath, "late")).type, "accepted", "accepted into custody");
    assert.equal(owner.queueDepth(), 1);
    assert.equal(await owner.nextTask(0), undefined, "nothing starts while the close waits");
    assert.equal(owner.queueDepth(), 1, "and nothing was taken off the queue");
    // NEGATIVE control: the same queue hands the task out once the request is gone (fail open).
    owner.takeDeferredClose();
    assert.equal((await owner.nextTask(0))?.messageId, "msg-late");
  });
});

test("G3: while a deferred close waits, an arriving task is NOT injected mid-turn — it queues", async () => {
  await withOwner("dc-noinject", { activeTurn: true }, async (owner, socketPath) => {
    const injected: QueueTask[] = [];
    owner.setMidTurnHandler((task) => {
      injected.push(task);
      return true;
    });
    // NEGATIVE control first: with no close pending the task IS injected.
    assert.equal((await submit(socketPath, "before")).type, "accepted");
    assert.deepEqual(
      injected.map((task) => task.messageId),
      ["msg-before"],
    );
    owner.scheduleClose({ killBackgroundTasks: false, onlyIfActiveTurn: false });
    assert.equal((await submit(socketPath, "during")).type, "accepted");
    assert.deepEqual(
      injected.map((task) => task.messageId),
      ["msg-before"],
      "not injected",
    );
    assert.equal(owner.queueDepth(), 1, "queued instead");
  });
});

test("the scheduling client: a real owner answers scheduled; no lease reads no-owner", async () => {
  await withOwner("dc-client", { activeTurn: true }, async () => {
    assert.deepEqual(
      await tryScheduleCloseOnRunningOwner("dc-client", {
        killBackgroundTasks: false,
        onlyIfActiveTurn: true,
      }),
      { kind: "scheduled", activeTurn: true, ownerPid: process.pid },
    );
    assert.deepEqual(
      await tryScheduleCloseOnRunningOwner("dc-no-such-session", {
        killBackgroundTasks: false,
        onlyIfActiveTurn: false,
      }),
      { kind: "no-owner" },
    );
  });
});

test("the refusal error names --now for a self-close and never claims anything was closed", () => {
  const self = new DeferredCloseUnavailableError("s1", true, {
    kind: "unsupported",
    detail: "QUEUE_REQUEST_INVALID",
  });
  assert.match(self.message, /QUEUE_REQUEST_INVALID/);
  assert.match(self.message, /nothing was closed/);
  assert.match(self.message, /--now/);
  assert.match(self.message, /nothing you would write after it is generated/);
  const outside = new DeferredCloseUnavailableError("s1", false, { kind: "no-owner" });
  assert.doesNotMatch(outside.message, /--now/);
  assert.match(outside.message, /without --after-turn/);
});

test("the fail-open owner.log line names the session, the tasks and the way out", () => {
  const line = formatDeferredCloseRefusedLine(
    "sess-1",
    { killBackgroundTasks: false, requestedAt: "2026-10-30T00:00:00.000Z" },
    { tasks: [{ taskId: "bg-a" }, { taskId: "bg-b" }] },
  );
  assert.match(line, /deferred close NOT performed for session sess-1/);
  assert.match(line, /2 background task\(s\)/);
  assert.match(line, /bg-a,bg-b/);
  assert.match(line, /stays OPEN/);
  assert.match(line, /--kill-background-tasks/);
});

test("a session-close owner exit runs the transcript reap; a turn-boundary recycle still does not", () => {
  assert.equal(ownerExitReapsTranscripts("session-close"), true);
  assert.equal(ownerExitReapsTranscripts("idle-release"), true);
  assert.equal(ownerExitReapsTranscripts("turn-boundary-recycle"), false);
  assert.equal(ownerExitReapsTranscripts("other"), false);
});
