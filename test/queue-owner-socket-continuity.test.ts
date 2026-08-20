import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  readQueueOwnerLiveness,
  recoverQueueOwnerForSession,
  tryQueryActiveTurnOnRunningOwner,
  trySubmitToRunningOwner,
} from "../src/cli/queue/ipc.js";
import {
  spawnQueueOwnerProcess,
  type SpawnedQueueOwner,
} from "../src/cli/session/queue-owner-process.js";
import { listSessionEvents } from "../src/session/events.js";
import type { AcpJsonRpcMessage, OutputFormatter, SessionSendOutcome } from "../src/types.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

type CapturingFormatter = {
  formatter: OutputFormatter;
  messages: AcpJsonRpcMessage[];
};

function createCapturingFormatter(): CapturingFormatter {
  const messages: AcpJsonRpcMessage[] = [];
  return {
    messages,
    formatter: {
      setContext() {
        // no-op
      },
      onAcpMessage(message) {
        messages.push(message);
      },
      onError(error) {
        throw new Error(`unexpected queue output error: ${error.detailCode ?? error.message}`);
      },
      onPermissionEscalation() {
        // no-op
      },
      flush() {
        // no-op
      },
    },
  };
}

async function waitUntil<T>(
  description: string,
  probe: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() <= deadline) {
    lastValue = await probe();
    if (accept(lastValue)) {
      return lastValue;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${description} not observed within ${timeoutMs}ms`);
}

async function readStreamEvents(sessionId: string): Promise<AcpJsonRpcMessage[]> {
  return await listSessionEvents(sessionId);
}

function assertCompletedOutcome(outcome: SessionSendOutcome): void {
  assert.equal("queued" in outcome, false, "wait-for-completion submit must return a turn result");
  if (!("queued" in outcome)) {
    assert.equal(outcome.stopReason, "end_turn");
  }
}

function assertCapturedText(capture: CapturingFormatter, expected: string): void {
  assert.match(JSON.stringify(capture.messages), new RegExp(expected));
}

async function submitPrompt(params: {
  sessionId: string;
  messageId: string;
  message: string;
  capture: CapturingFormatter;
}): Promise<SessionSendOutcome> {
  return await trySubmitToRunningOwner({
    sessionId: params.sessionId,
    messageId: params.messageId,
    message: params.message,
    permissionMode: "approve-reads",
    outputFormatter: params.capture.formatter,
    waitForCompletion: true,
  }).then((outcome) => {
    assert(outcome, "the live owner must accept the prompt");
    return outcome;
  });
}

async function withRealQueueOwner(
  name: string,
  run: (params: { sessionId: string; owner: SpawnedQueueOwner }) => Promise<void>,
): Promise<void> {
  await withTempHome(`acpx-socket-continuity-${name}-`, async (homeDir) => {
    const previousStateHome = process.env.ACPX_STATE_HOME;
    const previousOwnerArgs = process.env.ACPX_QUEUE_OWNER_ARGS;
    const previousBrickDb = process.env.ACPX_BRICK_DB;
    process.env.ACPX_STATE_HOME = homeDir;
    process.env.ACPX_QUEUE_OWNER_ARGS = JSON.stringify([CLI_PATH, "__queue-owner"]);
    process.env.ACPX_BRICK_DB = "0";

    const sessionId = `socket-continuity-${name}`;
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    await writeSessionRecordFile(
      homeDir,
      makeSessionRecord({
        acpxRecordId: sessionId,
        acpSessionId: `${sessionId}-acp`,
        agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK_AGENT_PATH)}`,
        cwd,
      }),
    );

    const owner = spawnQueueOwnerProcess({
      sessionId,
      permissionMode: "approve-reads",
      // brick://113073b8 — 60s, not 0. `ttlMs: 0` makes `nextTask` never time out,
      // which makes the idle-release branch structurally unreachable: such an owner
      // is IMMORTAL and, if this file process is killed before the `finally` below
      // runs, survives until the box reboots. 60_000 keeps the test's premise intact
      // — the first poll timeout is 60s, far past this test's ~4s runtime, so no
      // idle check can fire mid-test and the owner is just as quiet as at ttl 0.
      ttlMs: 60_000,
    });

    try {
      await waitUntil(
        "healthy queue owner",
        async () => await readQueueOwnerLiveness(sessionId),
        (state) => state.state === "healthy" && state.pidAlive && state.socketReachable === true,
      );
      await run({ sessionId, owner });
    } finally {
      await recoverQueueOwnerForSession(sessionId).catch(() => {
        // Test cleanup is best effort after an assertion failure.
      });
      owner.dispose();
      if (previousStateHome === undefined) {
        delete process.env.ACPX_STATE_HOME;
      } else {
        process.env.ACPX_STATE_HOME = previousStateHome;
      }
      if (previousOwnerArgs === undefined) {
        delete process.env.ACPX_QUEUE_OWNER_ARGS;
      } else {
        process.env.ACPX_QUEUE_OWNER_ARGS = previousOwnerArgs;
      }
      if (previousBrickDb === undefined) {
        delete process.env.ACPX_BRICK_DB;
      } else {
        process.env.ACPX_BRICK_DB = previousBrickDb;
      }
    }
  });
}

test("an idle live owner restores an externally unlinked socket before the submit budget expires", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withRealQueueOwner("idle-repair", async ({ sessionId }) => {
    const initialCapture = createCapturingFormatter();
    const initialOutcome = await submitPrompt({
      sessionId,
      messageId: "11111111-1111-4111-8111-111111111111",
      message: "echo INITIAL_SOCKET_CONTINUITY_NONCE",
      capture: initialCapture,
    });
    assertCompletedOutcome(initialOutcome);
    assertCapturedText(initialCapture, "INITIAL_SOCKET_CONTINUITY_NONCE");

    await waitUntil(
      "idle owner after initial turn",
      async () => await tryQueryActiveTurnOnRunningOwner(sessionId),
      (active) => active === false,
    );
    const beforeFault = await readQueueOwnerLiveness(sessionId);
    assert.equal(beforeFault.state, "healthy");
    assert(beforeFault.socketPath);
    assert(beforeFault.pid);
    assert(beforeFault.ownerGeneration);

    await fs.unlink(beforeFault.socketPath);
    const fault = await waitUntil(
      "live socket-unreachable owner",
      async () => await readQueueOwnerLiveness(sessionId),
      (state) => state.state === "socket_unreachable",
    );
    assert.equal(fault.pidAlive, true);
    assert.equal(fault.alive, true);
    assert.equal(fault.recoverable, false);
    assert.equal(fault.pid, beforeFault.pid);
    assert.equal(fault.ownerGeneration, beforeFault.ownerGeneration);

    const repairedCapture = createCapturingFormatter();
    const repairedMessageId = "22222222-2222-4222-8222-222222222222";
    const repairedOutcome = await submitPrompt({
      sessionId,
      messageId: repairedMessageId,
      message: "echo REPAIRED_SOCKET_CONTINUITY_NONCE",
      capture: repairedCapture,
    });
    assertCompletedOutcome(repairedOutcome);
    assertCapturedText(repairedCapture, "REPAIRED_SOCKET_CONTINUITY_NONCE");

    const afterRepair = await readQueueOwnerLiveness(sessionId);
    assert.equal(afterRepair.state, "healthy");
    assert.equal(afterRepair.socketReachable, true);
    assert.equal(afterRepair.pid, beforeFault.pid, "repair must preserve the owner process");
    assert.equal(
      afterRepair.ownerGeneration,
      beforeFault.ownerGeneration,
      "repair must preserve lease ownership and generation",
    );

    const events = await readStreamEvents(sessionId);
    const deliveryPhases = events
      .filter((event) => (event as { method?: unknown }).method === "acpx/delivery")
      .map((event) => (event as { params?: Record<string, unknown> }).params)
      .filter((params) => params?.messageId === repairedMessageId)
      .map((params) => params?.phase);
    assert.deepEqual(deliveryPhases, ["accepted", "done"]);
  });
});

test("socket continuity never interrupts active work and repairs at the idle boundary", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withRealQueueOwner("active-safety", async ({ sessionId }) => {
    const activeCapture = createCapturingFormatter();
    let activeTurnSettled = false;
    const activeTurn = submitPrompt({
      sessionId,
      messageId: "33333333-3333-4333-8333-333333333333",
      message: "sleep 1500",
      capture: activeCapture,
    }).finally(() => {
      activeTurnSettled = true;
    });

    await waitUntil(
      "active turn",
      async () => await tryQueryActiveTurnOnRunningOwner(sessionId),
      (active) => active === true,
    );
    const beforeFault = await readQueueOwnerLiveness(sessionId);
    assert(beforeFault.socketPath);
    assert(beforeFault.pid);
    assert(beforeFault.ownerGeneration);
    await fs.unlink(beforeFault.socketPath);

    await new Promise<void>((resolve) => setTimeout(resolve, 750));
    assert.equal(activeTurnSettled, false, "the active turn must still be running");
    await assert.rejects(fs.access(beforeFault.socketPath), {
      code: "ENOENT",
    });
    const duringFault = await readQueueOwnerLiveness(sessionId);
    assert.equal(duringFault.state, "socket_unreachable");
    assert.equal(duringFault.pid, beforeFault.pid);
    assert.equal(duringFault.pidAlive, true);

    const activeOutcome = await activeTurn;
    assertCompletedOutcome(activeOutcome);
    assertCapturedText(activeCapture, "slept 1500ms");

    const restored = await waitUntil(
      "socket restoration after active turn",
      async () => await readQueueOwnerLiveness(sessionId),
      (state) => state.state === "healthy" && state.socketReachable === true,
    );
    assert.equal(restored.pid, beforeFault.pid);
    assert.equal(restored.ownerGeneration, beforeFault.ownerGeneration);

    const followupCapture = createCapturingFormatter();
    const followupOutcome = await submitPrompt({
      sessionId,
      messageId: "44444444-4444-4444-8444-444444444444",
      message: "echo ACTIVE_WORK_PRESERVED_NONCE",
      capture: followupCapture,
    });
    assertCompletedOutcome(followupOutcome);
    assertCapturedText(followupCapture, "ACTIVE_WORK_PRESERVED_NONCE");
  });
});
