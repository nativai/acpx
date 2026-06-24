// Regression lock for W13-24-03: `acpx <agent> set effort` / `set model` must
// RECYCLE a live idle queue owner so a mid-session thinking-depth / model change
// binds on the NEXT turn.
//
// The deployed WARM bug (CONCEPTION §2.2, evidence/PROBE-FINDINGS.md): the queue
// owner binds sessionContext.reasoningEffort / the model at spawn and re-asserts +
// re-persists it every turn, so a live IPC set is REVERTED on the next warm turn.
// W12-19 (8bedd44) fixed only the COLD reconnect replay; the warm-owner
// re-assert was never closed. The fix mirrors `setSessionProfile`: refuse if a
// turn is in flight, persist the desired value, then terminate the live owner.
// The next prompt cold-resumes (same CLAUDE_CONFIG_DIR → in-place transcript
// reused, so context is preserved) and replays the desired value, which sticks.
//
// These lock the deterministic seams (same shape/philosophy as the W12-19 suite
// in spawn-flag-correctness-regression.test.ts):
//   T5.1/T5.2 WARM recycle: a live owner is terminated, ownerRestarted=true, and
//             the desired value (incl. the session_options.effort sync the fresh
//             owner reads) is persisted.
//   T5.3/T5.4 TURN-IN-FLIGHT: a change with a turn in flight is REFUSED (the
//             TURN_IN_FLIGHT detailCode acpx-ui maps to 409) and the owner survives.
//   T5.5/T5.6 MULTI-CALLER GUARD (the #1 risk): recycleOwner defaults OFF, so the
//             SAME call without it leaves a live owner ALIVE — internal/replay
//             callers (ensureSession, prompt-runner, reconnect) never recycle.
//   T5.7/T5.8 COLD: persist + session_options sync; recycle is a no-op (no owner).
//   T5.9      structural: the CLI handlers set recycleOwner; ensureSession does NOT.
//
// The full warm-revert end-to-end (in-turn $CLAUDE_EFFORT held across TWO warm
// turns on a real claude session) is the live TE in the task folder (CONCEPTION
// §8 A4); these CI-tier sentinels lock the deterministic seams it rides.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isProcessAlive, readQueueOwnerProcessIdentity } from "../src/cli/queue/lease-store.js";
import { setSessionConfigOption, setSessionModel } from "../src/cli/session/session-control.js";
import { resolveSessionRecord } from "../src/session/persistence/repository.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import type { SessionRecord } from "../src/types.js";
import {
  closeServer,
  createSingleRequestServer,
  listenServer,
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// Repo-root/src — the committed TypeScript source the structural sentinels read.
const SRC_DIR = fileURLToPath(new URL("../../src/", import.meta.url));

async function waitUntilDead(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function sessionFilePath(homeDir: string, acpxRecordId: string): string {
  return path.join(homeDir, ".acpx", "sessions", `${encodeURIComponent(acpxRecordId)}.json`);
}

async function seedSessionJson(homeDir: string, record: SessionRecord): Promise<void> {
  const filePath = sessionFilePath(homeDir, record.acpxRecordId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(serializeSessionRecordForDisk(record), null, 2)}\n`,
    "utf8",
  );
}

// A mock queue owner that serves the control socket: it answers query_active_turn
// with `active`, and set_config_option / set_model with an empty result. Mirrors
// the wire format in queue-ipc-errors.test.ts ("accepted" then the typed result).
function createMockOwnerServer(active: boolean): ReturnType<typeof createSingleRequestServer> {
  return createSingleRequestServer((socket, request) => {
    socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
    if (request.type === "query_active_turn") {
      socket.write(
        `${JSON.stringify({
          type: "query_active_turn_result",
          requestId: request.requestId,
          active,
        })}\n`,
      );
    } else if (request.type === "set_config_option") {
      socket.write(
        `${JSON.stringify({
          type: "set_config_option_result",
          requestId: request.requestId,
          response: { configOptions: [] },
        })}\n`,
      );
    } else if (request.type === "set_model") {
      socket.write(
        `${JSON.stringify({
          type: "set_model_result",
          requestId: request.requestId,
          modelId: (request as { modelId?: string }).modelId ?? "",
        })}\n`,
      );
    }
    socket.end();
  });
}

// Plant a live idle queue owner: a keeper process (so the lease pid is alive) +
// a control socket served by `server` + a lease with a MATCHING processIdentity
// (so liveness/terminate see a healthy, signalable owner). The keeper is a normal
// child — terminateQueueOwnerForSession kills a single PID (SIGTERM→SIGKILL), not
// the process group, so it never reaps the test runner.
type Keeper = Awaited<ReturnType<typeof startKeeperProcess>>;

async function plantLiveOwner(
  homeDir: string,
  sessionId: string,
  server: ReturnType<typeof createSingleRequestServer>,
): Promise<{ keeper: Keeper }> {
  const keeper = await startKeeperProcess();
  const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
  await listenServer(server, socketPath);
  const processIdentity = keeper.pid ? await readQueueOwnerProcessIdentity(keeper.pid) : undefined;
  await writeQueueOwnerLock({ lockPath, pid: keeper.pid, sessionId, socketPath, processIdentity });
  return { keeper };
}

function seedRecord(
  homeDir: string,
  sessionId: string,
  acpx: SessionRecord["acpx"],
): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: sessionId,
    acpSessionId: `${sessionId}-acp`,
    agentCommand: "agent",
    cwd: homeDir,
    acpx,
  });
}

// ---------------------------------------------------------------------------
// T5.1 / T5.2 — WARM recycle (the headline new behavior)
// ---------------------------------------------------------------------------

test("T5.1 WARM: set effort recycles a live idle owner — terminated, ownerRestarted, persisted", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "recycle-warm-effort";
    const server = createMockOwnerServer(false); // turn NOT in flight
    const { keeper } = await plantLiveOwner(homeDir, sessionId, server);
    await seedSessionJson(homeDir, seedRecord(homeDir, sessionId, {})); // genuine default

    try {
      const result = await setSessionConfigOption({
        sessionId,
        configId: "effort",
        value: "low",
        recycleOwner: true,
      });

      // The live owner was recycled so the next prompt cold-resumes + replays.
      assert.equal(result.ownerRestarted, true);
      await waitUntilDead(keeper.pid as number);
      assert.equal(isProcessAlive(keeper.pid), false);

      // Both fields persisted to DISK: desired_config_options.effort (replayed on
      // resume) AND session_options.effort (read into the fresh owner's context).
      const onDisk = await resolveSessionRecord(sessionId);
      assert.equal(onDisk.acpx?.desired_config_options?.effort, "low");
      assert.equal(onDisk.acpx?.session_options?.effort, "low");
    } finally {
      await closeServer(server);
      stopProcess(keeper);
    }
  });
});

test("T5.2 WARM: set model recycles a live idle owner — terminated, ownerRestarted, persisted", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "recycle-warm-model";
    const server = createMockOwnerServer(false);
    const { keeper } = await plantLiveOwner(homeDir, sessionId, server);
    await seedSessionJson(homeDir, seedRecord(homeDir, sessionId, {}));

    try {
      const result = await setSessionModel({ sessionId, modelId: "sonnet", recycleOwner: true });

      assert.equal(result.ownerRestarted, true);
      await waitUntilDead(keeper.pid as number);
      assert.equal(isProcessAlive(keeper.pid), false);

      const onDisk = await resolveSessionRecord(sessionId);
      assert.equal(onDisk.acpx?.session_options?.model, "sonnet");
      assert.equal(onDisk.acpx?.current_model_id, "sonnet");
    } finally {
      await closeServer(server);
      stopProcess(keeper);
    }
  });
});

// ---------------------------------------------------------------------------
// T5.3 / T5.4 — TURN-IN-FLIGHT refusal (the 409 contract; owner must survive)
// ---------------------------------------------------------------------------

test("T5.3 TURN-IN-FLIGHT: set effort with an active turn is refused; owner survives", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "recycle-effort-inflight";
    const server = createMockOwnerServer(true); // turn IN flight
    const { keeper } = await plantLiveOwner(homeDir, sessionId, server);
    await seedSessionJson(homeDir, seedRecord(homeDir, sessionId, {}));

    try {
      await assert.rejects(
        async () =>
          await setSessionConfigOption({
            sessionId,
            configId: "effort",
            value: "low",
            recycleOwner: true,
            sessionName: "my-session",
          }),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.equal(error.name, "ConfigOptionTurnInFlightError");
          // The cross-repo 409 contract acpx-ui keys on.
          assert.equal((error as Error & { detailCode?: string }).detailCode, "TURN_IN_FLIGHT");
          return true;
        },
      );
      // Refused, NOT recycled — the live turn must not be SIGKILLed mid-stream.
      assert.equal(isProcessAlive(keeper.pid), true);
      // The desired value was NOT persisted (the change is refused, not deferred).
      const onDisk = await resolveSessionRecord(sessionId);
      assert.equal(onDisk.acpx?.desired_config_options?.effort, undefined);
    } finally {
      await closeServer(server);
      stopProcess(keeper);
    }
  });
});

test("T5.4 TURN-IN-FLIGHT: set model with an active turn is refused; owner survives", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "recycle-model-inflight";
    const server = createMockOwnerServer(true);
    const { keeper } = await plantLiveOwner(homeDir, sessionId, server);
    await seedSessionJson(homeDir, seedRecord(homeDir, sessionId, {}));

    try {
      await assert.rejects(
        async () =>
          await setSessionModel({
            sessionId,
            modelId: "sonnet",
            recycleOwner: true,
            sessionName: "my-session",
          }),
        (error: unknown) => {
          assert(error instanceof Error);
          assert.equal(error.name, "ModelTurnInFlightError");
          assert.equal((error as Error & { detailCode?: string }).detailCode, "TURN_IN_FLIGHT");
          return true;
        },
      );
      assert.equal(isProcessAlive(keeper.pid), true);
      const onDisk = await resolveSessionRecord(sessionId);
      assert.equal(onDisk.acpx?.session_options?.model, undefined);
    } finally {
      await closeServer(server);
      stopProcess(keeper);
    }
  });
});

// ---------------------------------------------------------------------------
// T5.5 / T5.6 — MULTI-CALLER GUARD (the #1 risk): recycleOwner defaults OFF, so
// internal/replay callers (which omit it) must NOT recycle a live owner. Same
// inputs, the ONLY difference is the absent recycleOwner flag → owner survives.
// ---------------------------------------------------------------------------

test("T5.5 GUARD: setSessionConfigOption WITHOUT recycleOwner leaves a live owner ALIVE", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "guard-effort-no-recycle";
    const server = createMockOwnerServer(false);
    const { keeper } = await plantLiveOwner(homeDir, sessionId, server);
    await seedSessionJson(homeDir, seedRecord(homeDir, sessionId, {}));

    try {
      // No recycleOwner — the existing live-IPC apply path. The owner is NOT killed.
      const result = await setSessionConfigOption({ sessionId, configId: "effort", value: "low" });
      assert.notEqual(result.ownerRestarted, true);
      assert.equal(isProcessAlive(keeper.pid), true);
    } finally {
      await closeServer(server);
      stopProcess(keeper);
    }
  });
});

test("T5.6 GUARD: setSessionModel WITHOUT recycleOwner leaves a live owner ALIVE", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "guard-model-no-recycle";
    const server = createMockOwnerServer(false);
    const { keeper } = await plantLiveOwner(homeDir, sessionId, server);
    await seedSessionJson(homeDir, seedRecord(homeDir, sessionId, {}));

    try {
      const result = await setSessionModel({ sessionId, modelId: "sonnet" });
      assert.notEqual(result.ownerRestarted, true);
      assert.equal(isProcessAlive(keeper.pid), true);
    } finally {
      await closeServer(server);
      stopProcess(keeper);
    }
  });
});

// ---------------------------------------------------------------------------
// T5.7 / T5.8 — COLD: no live owner. Recycle is a no-op (nothing to terminate);
// the desired value is persisted (with the session_options sync) so the next
// prompt cold-spawns + replays it. ownerRestarted=false.
// ---------------------------------------------------------------------------

test("T5.7 COLD: set effort recycle persists desired + session_options.effort sync, no restart", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "recycle-cold-effort";
    await seedSessionJson(homeDir, seedRecord(homeDir, sessionId, {})); // no owner lease

    const result = await setSessionConfigOption({
      sessionId,
      configId: "effort",
      value: "xhigh",
      recycleOwner: true,
    });

    assert.equal(result.ownerRestarted, false);
    const onDisk = await resolveSessionRecord(sessionId);
    assert.equal(onDisk.acpx?.desired_config_options?.effort, "xhigh");
    assert.equal(onDisk.acpx?.session_options?.effort, "xhigh");
  });
});

test("T5.8 COLD: set model recycle persists desired + current model, no restart", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "recycle-cold-model";
    await seedSessionJson(homeDir, seedRecord(homeDir, sessionId, {}));

    const result = await setSessionModel({ sessionId, modelId: "haiku", recycleOwner: true });

    assert.equal(result.ownerRestarted, false);
    const onDisk = await resolveSessionRecord(sessionId);
    assert.equal(onDisk.acpx?.session_options?.model, "haiku");
    assert.equal(onDisk.acpx?.current_model_id, "haiku");
  });
});

// ---------------------------------------------------------------------------
// T5.9 — structural sentinels (same idiom as the W12-19 suite's T4.2). The
// recycle is wired ONLY on the CLI-verb handlers; the internal ensure path must
// stay default-off. A future refactor that drops/adds either would re-open the
// warm-revert bug or wedge ordinary prompts.
// ---------------------------------------------------------------------------

test("T5.9 structural: handleSetModel sets recycleOwner: true (CLI-verb recycle wired)", async () => {
  const source = await fs.readFile(path.join(SRC_DIR, "cli/command-handlers.ts"), "utf8");
  assert.match(
    source,
    /setSessionModel\(\{[\s\S]*?recycleOwner:\s*true/,
    "handleSetModel must pass recycleOwner: true to setSessionModel",
  );
});

test("T5.9 structural: handleSetConfigOption gates recycleOwner on isDepthConfigOption", async () => {
  const source = await fs.readFile(path.join(SRC_DIR, "cli/command-handlers.ts"), "utf8");
  assert.match(
    source,
    /setSessionConfigOption\(\{[\s\S]*?recycleOwner:\s*isDepthConfigOption\(/,
    "handleSetConfigOption must scope recycleOwner to depth options via isDepthConfigOption()",
  );
});

test("T5.9 structural: ensureSession (internal caller) does NOT recycle the owner", async () => {
  const source = await fs.readFile(path.join(SRC_DIR, "cli/session/session-management.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /recycleOwner/,
    "session-management.ts must NOT pass recycleOwner — internal callers already cold-reconnect (multi-caller guard)",
  );
});
