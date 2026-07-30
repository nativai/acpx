import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type net from "node:net";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import {
  ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE,
  ABSORBED_TURN_NEVER_ENDED_MESSAGE,
  QUEUE_OWNER_CLOSING_DETAIL_CODE,
  QUEUE_OWNER_CLOSING_MESSAGE,
  QUEUE_OWNER_SHUTDOWN_DETAIL_CODE,
  QUEUE_OWNER_SHUTDOWN_MESSAGE,
  SESSION_CLOSED_UNDELIVERED_DETAIL_CODE,
  SESSION_CLOSED_UNDELIVERED_MESSAGE,
} from "../src/cli/queue/delivery-terminals.js";
import {
  type QueueOwnerControlHandlers,
  type QueueTask,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import {
  registerAbsorbedDeliveries,
  terminalizeAbsorbedDeliveriesOnOwnerExit,
} from "../src/cli/session/absorbed-delivery-registry.js";
import { textPrompt } from "../src/prompt-content.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { connectSocket, nextJsonLine, withTempHome } from "./queue-test-helpers.js";

// ---------------------------------------------------------------------------
// D1 — the close-drain barrier (brick://53437107), acpx unit gates L1.1–L1.8,
// L1.12 and the L3.1 wire fixture.
//
// THE GOVERNING RULE OF THIS FILE: never test this race by racing it. The
// specimen was a 2.356 s window; a test that sends, sleeps and closes is the
// same guess the specimen's agent made and will pass for the wrong reason on
// every box. Every gate below PINS custody first — the owner provably holds the
// task and provably cannot inject it, because `nextTask` is never called — and
// only then drains. There is no `sleep` in this file, and there must never be.
// ---------------------------------------------------------------------------

type DeliveryEventParams = {
  messageId: string;
  requestId: string;
  phase: string;
  error?: { message: string; detailCode: string };
};

type StreamEvent = { method?: string; params?: DeliveryEventParams };

// In production the session directory always exists (the record lives there), so
// the writers treat a missing directory as a best-effort no-op. Tests must
// create it or every terminal is silently dropped.
async function ensureSessionStreamDir(sessionId: string): Promise<void> {
  await fs.mkdir(path.dirname(sessionEventActivePath(sessionId)), { recursive: true });
}

async function readStreamEvents(sessionId: string): Promise<StreamEvent[]> {
  const payload = await fs.readFile(sessionEventActivePath(sessionId), "utf8").catch(() => "");
  return payload
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as StreamEvent);
}

async function readDeliveryEvents(sessionId: string): Promise<DeliveryEventParams[]> {
  const events = await readStreamEvents(sessionId);
  return events
    .filter((event) => event.method === "acpx/delivery")
    .map((event) => event.params as DeliveryEventParams);
}

function stubControlHandlers(
  overrides: Partial<QueueOwnerControlHandlers> = {},
): QueueOwnerControlHandlers {
  return {
    cancelPrompt: async () => false,
    closeSession: async () => true,
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }) as SetSessionConfigOptionResponse,
    queryActiveTurn: () => false,
    ...overrides,
  };
}

type PinnedSubmission = {
  socket: net.Socket;
  lines: readline.Interface;
  frames: unknown[];
};

/**
 * PIN CUSTODY — the determinism primitive for every gate here.
 *
 * Submits a real `waitForCompletion:false` (deliver-now) task over the owner's
 * real socket and returns once the owner has acknowledged it. Because the test
 * never calls `nextTask`, the task provably sits in the owner's `pending` array
 * from this moment until something sweeps it. `pending` is a synchronous array,
 * so custody is a STATE, not a window: the test may then take as long as it likes.
 */
async function pinPendingTask(
  socketPath: string,
  options: { requestId: string; messageId?: string; waitForCompletion?: boolean },
): Promise<PinnedSubmission> {
  const socket = await connectSocket(socketPath);
  const lines = readline.createInterface({ input: socket });
  const iterator = lines[Symbol.asyncIterator]();
  socket.write(
    `${JSON.stringify({
      type: "submit_prompt",
      requestId: options.requestId,
      ...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
      message: `pinned ${options.requestId}`,
      permissionMode: "approve-all",
      waitForCompletion: options.waitForCompletion ?? false,
    })}\n`,
  );

  const first = (await nextJsonLine(iterator)) as { type: string };
  return { socket, lines, frames: [first] };
}

function closeSubmission(submission: PinnedSubmission): void {
  submission.lines.close();
  submission.socket.destroy();
}

async function withOwner(
  sessionId: string,
  handlers: QueueOwnerControlHandlers,
  run: (owner: SessionQueueOwner, socketPath: string) => Promise<void>,
): Promise<void> {
  await ensureSessionStreamDir(sessionId);
  const lease = await tryAcquireQueueOwnerLease(sessionId);
  assert(lease, "expected to acquire a queue-owner lease");
  const owner = await SessionQueueOwner.start(lease, handlers, { maxQueueDepth: 32 });
  try {
    await run(owner, lease.socketPath);
  } finally {
    await owner.close();
  }
}

// L1.1 — THE CORE CUSTODY REGRESSION. This is the shape that has been losing
// 1–4 inter-agent messages a day for six weeks.
test("L1.1 drain terminalizes a pinned pending delivery exactly once and never injects it", async () => {
  await withTempHome(async () => {
    const sessionId = "drain-core-custody";
    await withOwner(sessionId, stubControlHandlers(), async (owner, socketPath) => {
      const submission = await pinPendingTask(socketPath, {
        requestId: "req-core",
        messageId: "msg-core",
      });
      assert.equal((submission.frames[0] as { type: string }).type, "accepted");
      // Custody is pinned: the owner holds it and nothing has pulled it.
      assert.equal(owner.queueDepth(), 1);

      const report = await owner.drainDeliveries("session-close", 0);

      assert.equal(report.drained, 1);
      assert.deepEqual(report.undelivered, [{ requestId: "req-core", messageId: "msg-core" }]);
      assert.equal(report.activeTurnAtEntry, false);
      assert.equal(report.turnSettled, true);
      assert.equal(owner.queueDepth(), 0);

      // (a) Exactly one terminal, carrying the close-caused code — and it is
      // already ON DISK when the drain resolves, because the sweep writes
      // synchronously. No polling, no clock.
      const afterDrain = await readDeliveryEvents(sessionId);
      assert.equal(afterDrain.length, 1);
      assert.equal(afterDrain[0].phase, "failed");
      assert.equal(afterDrain[0].messageId, "msg-core");
      assert.equal(afterDrain[0].error?.detailCode, SESSION_CLOSED_UNDELIVERED_DETAIL_CODE);
      assert.equal(afterDrain[0].error?.message, SESSION_CLOSED_UNDELIVERED_MESSAGE);

      // The message must NOT have been handed to the agent: close never starts
      // new work (KD-2 / C-2).
      assert.equal(await owner.nextTask(0), undefined);

      // (d) A subsequent owner.close() writes NO second terminal. A duplicate
      // here would reopen brick://932a1e5e.
      await owner.close();
      const afterClose = await readDeliveryEvents(sessionId);
      assert.equal(afterClose.length, 1);

      closeSubmission(submission);
    });
  });
});

// L1.2 — the SECOND custody store. A task buffered in the runtime's mid-turn
// capture window is just as lost as one in `pending`, and the drain must walk
// both (corollary C-1).
test("L1.2 drain terminalizes tasks pinned in the runtime mid-turn buffer", async () => {
  await withTempHome(async () => {
    const sessionId = "drain-midturn-custody";
    await withOwner(sessionId, stubControlHandlers(), async (owner, socketPath) => {
      // Reproduce the runtime's capture phase: a registered mid-turn handler
      // that buffers instead of injecting (`midTurnCaptureActive`).
      const midTurnBuffer: QueueTask[] = [];
      owner.setMidTurnHandler((task) => {
        midTurnBuffer.push(task);
        return true;
      });
      owner.setMidTurnCustodySource(() => midTurnBuffer.splice(0));

      const submission = await pinPendingTask(socketPath, {
        requestId: "req-buffered",
        messageId: "msg-buffered",
      });
      assert.equal(midTurnBuffer.length, 1);
      assert.equal(owner.queueDepth(), 0, "buffered tasks never reach pending");

      const report = await owner.drainDeliveries("session-close", 0);

      assert.equal(report.drained, 1);
      assert.deepEqual(report.undelivered, [
        { requestId: "req-buffered", messageId: "msg-buffered" },
      ]);
      assert.equal(midTurnBuffer.length, 0);

      const events = await readDeliveryEvents(sessionId);
      assert.equal(events.length, 1);
      assert.equal(events[0].error?.detailCode, SESSION_CLOSED_UNDELIVERED_DETAIL_CODE);

      closeSubmission(submission);
    });
  });
});

// L1.3 — QUIESCE. This is where the RCA's TOCTOU actually closes: at the owner,
// the only process authoritative about its own liveness.
test("L1.3 a draining owner rejects new submissions instead of enqueuing them", async () => {
  await withTempHome(async () => {
    const sessionId = "drain-quiesce";
    await withOwner(sessionId, stubControlHandlers(), async (owner, socketPath) => {
      await owner.drainDeliveries("session-close", 0);

      const socket = await connectSocket(socketPath);
      const lines = readline.createInterface({ input: socket });
      const iterator = lines[Symbol.asyncIterator]();
      socket.write(
        `${JSON.stringify({
          type: "submit_prompt",
          requestId: "req-late",
          messageId: "msg-late",
          message: "arrived after the drain began",
          permissionMode: "approve-all",
          waitForCompletion: false,
        })}\n`,
      );

      const frame = (await nextJsonLine(iterator)) as {
        type: string;
        detailCode?: string;
        retryable?: boolean;
        message?: string;
      };

      // The FIRST frame must be the rejection, never an `accepted`: `accepted`
      // is what resolves a deliver-now submit as {queued:true} on the client
      // side, i.e. the same false assurance this brick exists to remove.
      assert.equal(frame.type, "error");
      assert.equal(frame.detailCode, QUEUE_OWNER_CLOSING_DETAIL_CODE);
      assert.equal(frame.retryable, false);
      assert.equal(frame.message, QUEUE_OWNER_CLOSING_MESSAGE);

      assert.equal(owner.queueDepth(), 0, "a quiesced owner must land nothing in pending");
      assert.equal(await owner.nextTask(0), undefined);
      assert.deepEqual(await readDeliveryEvents(sessionId), []);

      lines.close();
      socket.destroy();
    });
  });
});

// L1.4 / L3.1 — THE KD-4 PIN. Asserts the CLASSIFICATION of the literal text
// acpx actually emits, not a hand-copied string (TESTER-PLAN trap 4). A test
// that keeps its own copy of the wording passes forever while prod diverges —
// that is the original class-C defect, re-created in the test suite.
test("L1.4/L3.1 the emitted contract strings match the checked-in cross-repo fixture", async () => {
  const fixturePath = path.resolve(process.cwd(), "test/fixtures/delivery-contract.fixture.json");
  const bytes = await fs.readFile(fixturePath);
  const fixture = JSON.parse(bytes.toString("utf8")) as {
    quiesceRejection: {
      detailCode: string;
      message: string;
      retryable: boolean;
      requiredSubstringLowercased: string;
    };
    ownerExitTerminals: Array<{
      detailCode: string;
      message: string;
      requiredSubstringLowercased: string | null;
    }>;
  };

  // The sha binds acpx's copy to acpx-ui's. acpx-ui vendors the same bytes and
  // asserts the same digest, so a one-sided reword reds one of the two suites
  // rather than silently diverging for six weeks.
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "9594e346089f7f09554fdd7b64b74579ebb1ff6f089b8eeeb1e4df75f7fb7052",
    "delivery-contract.fixture.json changed — re-broker the sha to the acpx-ui lanes before merging",
  );

  // What acpx EMITS is exactly what the fixture promises acpx-ui.
  assert.equal(fixture.quiesceRejection.detailCode, QUEUE_OWNER_CLOSING_DETAIL_CODE);
  assert.equal(fixture.quiesceRejection.message, QUEUE_OWNER_CLOSING_MESSAGE);
  assert.equal(fixture.quiesceRejection.retryable, false);

  const emitted = new Map(
    fixture.ownerExitTerminals.map((entry) => [entry.detailCode, entry] as const),
  );
  assert.equal(
    emitted.get(QUEUE_OWNER_SHUTDOWN_DETAIL_CODE)?.message,
    QUEUE_OWNER_SHUTDOWN_MESSAGE,
  );
  assert.equal(
    emitted.get(SESSION_CLOSED_UNDELIVERED_DETAIL_CODE)?.message,
    SESSION_CLOSED_UNDELIVERED_MESSAGE,
  );
  assert.equal(
    emitted.get(ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE)?.message,
    ABSORBED_TURN_NEVER_ENDED_MESSAGE,
  );

  // And the classification rule holds against those literal texts. acpx-ui's
  // `isTerminalEnqueueFailure` / `isDefinitiveGiveUp` both LOWER-CASE the text
  // and substring-match, so this is that predicate applied to what we emit.
  assert.ok(
    QUEUE_OWNER_CLOSING_MESSAGE.toLowerCase().includes(
      fixture.quiesceRejection.requiredSubstringLowercased,
    ),
    "the quiesce rejection no longer satisfies acpx-ui's isTerminalEnqueueFailure",
  );
  for (const entry of fixture.ownerExitTerminals) {
    if (entry.requiredSubstringLowercased === null) {
      continue;
    }
    assert.ok(
      entry.message.toLowerCase().includes(entry.requiredSubstringLowercased),
      `${entry.detailCode} no longer satisfies acpx-ui's isDefinitiveGiveUp substring rule`,
    );
  }
});

// L1.7 — THE CAUSE SPLIT, all three codes in one place so the owner-exit
// vocabulary is visible as a set rather than as three unrelated strings.
test("L1.7 the owner-exit vocabulary splits by cause: close vs self-exit vs absorbed", async () => {
  await withTempHome(async () => {
    // (1) Drain FOR CLOSE → definitive SESSION_CLOSED_UNDELIVERED.
    const closingSession = "vocab-session-close";
    await withOwner(closingSession, stubControlHandlers(), async (owner, socketPath) => {
      const submission = await pinPendingTask(socketPath, {
        requestId: "req-close",
        messageId: "msg-close",
      });
      await owner.drainDeliveries("session-close", 0);
      const events = await readDeliveryEvents(closingSession);
      assert.equal(events.length, 1);
      assert.equal(events[0].error?.detailCode, SESSION_CLOSED_UNDELIVERED_DETAIL_CODE);
      closeSubmission(submission);
    });

    // (2) Owner SELF-EXIT on an open session (idle release / TTL) → retryable
    // QUEUE_OWNER_SHUTDOWN, exactly as before. Narrowing the code must not
    // change this leg.
    const exitingSession = "vocab-owner-exit";
    await withOwner(exitingSession, stubControlHandlers(), async (owner, socketPath) => {
      const submission = await pinPendingTask(socketPath, {
        requestId: "req-exit",
        messageId: "msg-exit",
      });
      await owner.close();
      const events = await readDeliveryEvents(exitingSession);
      assert.equal(events.length, 1);
      assert.equal(events[0].error?.detailCode, QUEUE_OWNER_SHUTDOWN_DETAIL_CODE);
      assert.equal(events[0].error?.message, QUEUE_OWNER_SHUTDOWN_MESSAGE);
      closeSubmission(submission);
    });

    // (3) An absorbed injection whose turn never settled → unchanged F3
    // ABSORBED_TURN_NEVER_ENDED (outcome-unknown, never auto-resend).
    const absorbedSession = "vocab-absorbed";
    await ensureSessionStreamDir(absorbedSession);
    const absorbed = [
      {
        context: { messageId: "msg-absorbed", requestId: "req-absorbed" },
        terminalWritten: false,
      },
    ];
    registerAbsorbedDeliveries(absorbedSession, absorbed);
    assert.equal(terminalizeAbsorbedDeliveriesOnOwnerExit(absorbedSession), 1);
    const absorbedEvents = await readDeliveryEvents(absorbedSession);
    assert.equal(absorbedEvents.length, 1);
    assert.equal(absorbedEvents[0].error?.detailCode, ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE);
    assert.equal(absorbedEvents[0].error?.message, ABSORBED_TURN_NEVER_ENDED_MESSAGE);
  });
});

// L1.8 / E4 — two concurrent closes of the same session. The second must find
// nothing and must never produce a second terminal.
test("L1.8 concurrent drains are idempotent: one terminal per item, second report empty", async () => {
  await withTempHome(async () => {
    const sessionId = "drain-idempotent";
    await withOwner(sessionId, stubControlHandlers(), async (owner, socketPath) => {
      const submission = await pinPendingTask(socketPath, {
        requestId: "req-idem",
        messageId: "msg-idem",
      });

      const [first, second] = await Promise.all([
        owner.drainDeliveries("session-close", 0),
        owner.drainDeliveries("session-close", 0),
      ]);

      const reports = [first, second].toSorted((a, b) => b.drained - a.drained);
      assert.equal(reports[0].drained, 1);
      assert.deepEqual(reports[1].undelivered, []);

      const events = await readDeliveryEvents(sessionId);
      assert.equal(events.length, 1, "a second drain must never double-write a terminal");

      closeSubmission(submission);
    });
  });
});

// L1.12 / E10 — a plain CLI `prompt` submission has no acpx-ui delivery
// counterpart. The drain must still report the lost custody and must not
// invent a delivery event keyed on a messageId that does not exist.
test("L1.12 drain handles a task with no acpx-ui counterpart without error", async () => {
  await withTempHome(async () => {
    const sessionId = "drain-no-counterpart";
    await withOwner(sessionId, stubControlHandlers(), async (owner, socketPath) => {
      const submission = await pinPendingTask(socketPath, { requestId: "req-cli-only" });

      const report = await owner.drainDeliveries("session-close", 0);

      assert.equal(report.drained, 1);
      assert.deepEqual(report.undelivered, [{ requestId: "req-cli-only" }]);
      assert.deepEqual(
        await readDeliveryEvents(sessionId),
        [],
        "a task with no messageId has no delivery lifecycle to terminalize",
      );

      closeSubmission(submission);
    });
  });
});

// E1 — the drain must NEVER cancel a running turn, and must proceed when the
// settle budget expires. Absorbed injections are F3's to label, not ours.
test("E1 drain waits for an active turn without cancelling it, then proceeds on expiry", async () => {
  await withTempHome(async () => {
    const sessionId = "drain-active-turn";
    let cancelCalls = 0;
    let turnActive = true;
    const handlers = stubControlHandlers({
      queryActiveTurn: () => turnActive,
      cancelPrompt: async () => {
        cancelCalls += 1;
        return true;
      },
    });

    await withOwner(sessionId, handlers, async (owner, socketPath) => {
      const submission = await pinPendingTask(socketPath, {
        requestId: "req-busy",
        messageId: "msg-busy",
      });

      // Budget expires while the turn is still running.
      const expired = await owner.drainDeliveries("session-close", 60);
      assert.equal(expired.activeTurnAtEntry, true);
      assert.equal(expired.turnSettled, false);
      assert.equal(
        expired.drained,
        1,
        "custody that never reached the agent is still terminalized",
      );
      assert.equal(cancelCalls, 0, "the drain must never cancel a running turn");

      // A drain that observes the turn end reports it settled.
      turnActive = false;
      const settled = await owner.drainDeliveries("session-close", 60);
      assert.equal(settled.turnSettled, true);
      assert.deepEqual(settled.undelivered, []);

      closeSubmission(submission);
    });
  });
});

// E5 — the property that makes the SIGTERM handler's QUEUE_OWNER_SHUTDOWN
// default provably correct: nothing can be enqueued between the drain and the
// kill, so a drained-for-close owner can never be holding an item that a later
// signal would mislabel.
test("E5 nothing can be enqueued between the drain and the kill", async () => {
  await withTempHome(async () => {
    const sessionId = "drain-quiesce-window";
    await withOwner(sessionId, stubControlHandlers(), async (owner, socketPath) => {
      await owner.drainDeliveries("session-close", 0);

      for (const requestId of ["late-1", "late-2", "late-3"]) {
        const socket = await connectSocket(socketPath);
        const lines = readline.createInterface({ input: socket });
        const iterator = lines[Symbol.asyncIterator]();
        socket.write(
          `${JSON.stringify({
            type: "submit_prompt",
            requestId,
            messageId: `msg-${requestId}`,
            message: "raced the close",
            permissionMode: "approve-all",
            waitForCompletion: false,
          })}\n`,
        );
        const frame = (await nextJsonLine(iterator)) as { type: string; detailCode?: string };
        assert.equal(frame.type, "error");
        assert.equal(frame.detailCode, QUEUE_OWNER_CLOSING_DETAIL_CODE);
        lines.close();
        socket.destroy();
      }

      assert.equal(owner.queueDepth(), 0);
      const signalTerminals = owner.terminalizeCustodyOnSignal();
      assert.equal(signalTerminals, 0, "a quiesced owner holds nothing for a later signal to find");
    });
  });
});

// F2 / brick://932a1e5e — the ORDERING case a per-path test never reaches:
// drain, then a signal, then owner.close(), all over the same custody. Three
// sweeps, one terminal. The `terminalWritten` flag (the F3 discipline, shared
// with the A11 closed-record refusal path) is what makes that hold; removal
// from `pending` alone would not, because a task can be reachable from more
// than one structure.
test("F2 drain → signal → close writes exactly one terminal per message", async () => {
  await withTempHome(async () => {
    const sessionId = "drain-then-signal";
    await withOwner(sessionId, stubControlHandlers(), async (owner, socketPath) => {
      const midTurnBuffer: QueueTask[] = [];
      owner.setMidTurnCustodySource(() => midTurnBuffer.splice(0));

      const pending = await pinPendingTask(socketPath, {
        requestId: "req-pending",
        messageId: "msg-pending",
      });

      // A task the drain sweeps out of `pending`, plus one the runtime hands
      // back into the buffer AFTER the drain (the leftover-requeue ordering) —
      // so the signal pass genuinely has something to re-examine.
      const report = await owner.drainDeliveries("session-close", 0);
      assert.equal(report.drained, 1);
      const swept = report.undelivered[0];
      midTurnBuffer.push({
        requestId: swept.requestId,
        messageId: swept.messageId,
        message: "leftover handed back after the drain",
        prompt: textPrompt("leftover"),
        permissionMode: "approve-all",
        waitForCompletion: false,
        enqueuedAt: Date.now(),
        terminalWritten: true,
        send: () => {},
        close: () => {},
      });

      assert.equal(
        owner.terminalizeCustodyOnSignal(),
        0,
        "an already-terminalized task is skipped",
      );
      await owner.close();

      const events = await readDeliveryEvents(sessionId);
      assert.equal(events.length, 1, "three sweeps over the same custody, one terminal");
      assert.equal(events[0].error?.detailCode, SESSION_CLOSED_UNDELIVERED_DETAIL_CODE);

      closeSubmission(pending);
    });
  });
});

// E13-adjacent — control verbs must keep working while draining, or the second
// of two concurrent closes could not even ask.
test("E13 a draining owner still answers control verbs over the socket", async () => {
  await withTempHome(async () => {
    const sessionId = "drain-control-verbs";
    await withOwner(sessionId, stubControlHandlers(), async (owner, socketPath) => {
      await owner.drainDeliveries("session-close", 0);

      const socket = await connectSocket(socketPath);
      const lines = readline.createInterface({ input: socket });
      const iterator = lines[Symbol.asyncIterator]();
      socket.write(
        `${JSON.stringify({ type: "drain_deliveries", requestId: "req-2nd", reason: "session-close" })}\n`,
      );

      const accepted = (await nextJsonLine(iterator)) as { type: string };
      const result = (await nextJsonLine(iterator)) as {
        type: string;
        drained: number;
        undelivered: unknown[];
        turnSettled: boolean;
        activeTurnAtEntry: boolean;
      };
      assert.equal(accepted.type, "accepted");
      assert.equal(result.type, "drain_deliveries_result");
      assert.equal(result.drained, 0);
      assert.deepEqual(result.undelivered, []);
      assert.equal(result.turnSettled, true);
      assert.equal(result.activeTurnAtEntry, false);

      lines.close();
      socket.destroy();
    });
  });
});
