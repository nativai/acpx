import assert from "node:assert/strict";
// END-EDGE regression for mid-turn steering (brick 7daa105e, HoD standing caution):
// a deliver-now steer that races the turn's END edge must land as a QUEUED post-turn
// turn — never dropped, never lost.
//
// The seam under test is the queue owner's mid-turn-handler contract, the one the
// queue-owner runtime registers for the owner's lifetime
// (queue-owner-runtime.ts:1005):
//
//   handler(task) -> boolean
//     true  — the runtime took custody (injected into the active turn, or pinned in
//             the capture buffer, whose leftovers are requeued at turn end).
//     false — the runtime is NOT in a turn (the end-edge state: the turn's drain
//             already cleared the handler and capture is inactive) → the task must
//             land in the owner's pending queue, where nextTask returns it as the
//             next sequential — post-turn — turn.
//
// This file pins the OWNER side of that contract against the real SessionQueueOwner
// over its real IPC socket, deterministically (no sleeps — the decline is
// synchronous, so custody is a state, not a window). The runtime-side half of the
// edge — the handler is cleared exactly once at the drain's end — is pinned in
// mid-turn-injection.test.ts (midTurn.clears assertions).
import fs from "node:fs/promises";
import type net from "node:net";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { SessionQueueOwner, tryAcquireQueueOwnerLease } from "../src/cli/queue/ipc.js";
import type { DepthProjection } from "../src/session/depth-projection.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { connectSocket } from "./queue-test-helpers.js";
import { withTempHome as withTempHomeFixture } from "./runtime-test-helpers.js";

async function withTempHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  await withTempHomeFixture("acpx-end-edge-home-", run);
}

function stubControlHandlers(): Parameters<typeof SessionQueueOwner.start>[1] {
  return {
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
  };
}

async function withOwner(
  sessionId: string,
  run: (owner: SessionQueueOwner, socketPath: string) => Promise<void>,
): Promise<void> {
  // The delivery-event writers treat a missing directory as best-effort no-op;
  // create it or asserted stream events silently vanish.
  await fs.mkdir(path.dirname(sessionEventActivePath(sessionId)), { recursive: true });
  const lease = await tryAcquireQueueOwnerLease(sessionId);
  assert(lease, "expected to acquire a queue-owner lease");
  const owner = await SessionQueueOwner.start(lease, stubControlHandlers(), { maxQueueDepth: 32 });
  try {
    await run(owner, lease.socketPath);
  } finally {
    await owner.close();
  }
}

// Submits a real deliver-now (waitForCompletion:false) task over the owner's real
// socket and resolves once the owner has acknowledged it.
async function submitDeliverNow(
  socketPath: string,
  requestId: string,
): Promise<{ socket: net.Socket; frames: unknown[] }> {
  const socket = await connectSocket(socketPath);
  const lines = readline.createInterface({ input: socket });
  const frames: unknown[] = [];
  const done = (async () => {
    const iterator = lines[Symbol.asyncIterator]();
    frames.push((await iterator.next()).value);
  })();
  socket.write(
    `${JSON.stringify({
      type: "submit_prompt",
      requestId,
      message: `end-edge steer ${requestId}`,
      permissionMode: "approve-all",
      waitForCompletion: false,
    })}\n`,
  );
  await done;
  return { socket, frames };
}

test(
  "END-EDGE: a deliver-now steer the runtime declines (turn already ended) lands in pending " +
    "and nextTask returns it as the next sequential post-turn turn — never dropped",
  async () => {
    await withTempHome(async (homeDir) => {
      const sessionId = `end-edge-declined-${path.basename(homeDir)}`;
      await withOwner(sessionId, async (owner, socketPath) => {
        // The queue-owner runtime's registration shape: the handler routes to the
        // active runtime handler / capture buffer, and DECLINES (false) when the
        // runtime is not in a turn — exactly the state after the turn's drain.
        // The end edge IS this state: the turn's drain already cleared the handler
        // and capture is inactive, so the runtime's predicate declines.
        owner.setMidTurnHandler((_task) => {
          // No active handler exists (drain cleared it); capture is inactive.
          return false;
        });

        // END EDGE: main turn drained (handler cleared, capture inactive). The
        // steer raced the turn's end and arrives NOW.
        const { socket } = await submitDeliverNow(socketPath, "req-end-edge");
        try {
          // Declined by the runtime → the OWNER must hold it in pending, not drop it.
          assert.equal(owner.queueDepth(), 1, "the raced steer is in the owner's pending queue");

          // The owner loop's next pull returns it as the next sequential turn.
          const task = await owner.nextTask(0);
          assert.ok(task, "nextTask returns the raced steer for a post-turn turn");
        } finally {
          socket.end();
        }
      });
    });
  },
);

test(
  "END-EDGE control: a steer the runtime ACCEPTS mid-turn is never in the pending queue " +
    "(the two branches are disjoint)",
  async () => {
    await withTempHome(async () => {
      const sessionId = `end-edge-accepted-${Date.now()}`;
      await withOwner(sessionId, async (owner, socketPath) => {
        let activeHandler: ((task: unknown) => void) | undefined;
        owner.setMidTurnHandler((task) => {
          if (activeHandler) {
            activeHandler(task);
            return true;
          }
          return false;
        });
        // Turn active: the runtime registered its handler. (Assigned AFTER the
        // registration, mirroring the runtime's sequencing — the owner handler is
        // registered once at owner start; the runtime's active handler arrives
        // when the turn's prompt starts.)
        activeHandler = () => {};
        assert.ok(activeHandler, "the runtime's handler is active");

        const { socket } = await submitDeliverNow(socketPath, "req-accepted");
        try {
          assert.equal(owner.queueDepth(), 0, "an accepted steer never lands in pending");
          assert.ok(activeHandler, "the active handler received the steer");
        } finally {
          socket.end();
        }
      });
    });
  },
);
