import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { SessionSendOptions } from "../src/cli/session/contracts.js";
import type {
  OwnerExitInfo,
  QueueOwnerRuntimeOptions,
  SpawnedQueueOwner,
} from "../src/cli/session/queue-owner-process.js";
import {
  readQueueOwnerStartupFailureDetail,
  spawnQueueOwnerProcess,
} from "../src/cli/session/queue-owner-process.js";
import {
  defaultSendSessionRuntimeDeps,
  type SendSessionRuntimeDeps,
  sendSession,
  spawnAndAwaitQueueOwner,
} from "../src/cli/session/queue-owner-runtime.js";
import { QueueConnectionError } from "../src/errors.js";
import { textPrompt } from "../src/prompt-content.js";
import type { OutputFormatter, SessionSendOutcome } from "../src/types.js";
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
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

// W13-24-14 P1 — cold-respawn gap: a single cold-spawned queue owner that died
// before creating its lock + listening used to fail the whole message in ~6.5 s
// (poll-loop exhaustion, never re-spawning). These tests pin the fix: bounded
// re-spawn on detected owner death, fail-fast + exit-reason when it persists, and
// the deliver-now (no-wait) path benefiting from the same re-spawn.

const NOOP_OUTPUT_FORMATTER: OutputFormatter = {
  setContext() {
    // no-op
  },
  onAcpMessage() {
    // no-op
  },
  onError() {
    // no-op
  },
  onPermissionEscalation() {
    // no-op
  },
  flush() {
    // no-op
  },
};

const SESSION_ID = "cold-respawn-session";

function makeSendOptions(overrides: Partial<SessionSendOptions> = {}): SessionSendOptions {
  return {
    sessionId: SESSION_ID,
    prompt: textPrompt("hi"),
    permissionMode: "approve-reads",
    outputFormatter: NOOP_OUTPUT_FORMATTER,
    ...overrides,
  };
}

const ENQUEUE_OUTCOME: SessionSendOutcome = {
  queued: true,
  sessionId: SESSION_ID,
  requestId: "req-cold-respawn",
};

const DEAD_EXIT: OwnerExitInfo = { code: 1, signal: null };

// One spawn's simulated fate: an OwnerExitInfo means dead-on-arrival (exit set
// immediately); "alive" means the owner stays up (exit never flips).
type SpawnScriptEntry = OwnerExitInfo | "alive";

type FakeRuntime = {
  deps: SendSessionRuntimeDeps;
  spawnCount: () => number;
  disposeCount: () => number;
  submitWaitFlags: () => boolean[];
};

// Deterministic fake of the cold-respawn dependencies. The real spawn + exit
// detection primitive is proven separately (the real-spawn test below) and
// end-to-end by the reproduce-first selftest; here we isolate the orchestration.
function makeFakeRuntime(params: {
  spawnScript: SpawnScriptEntry[];
  submitAlwaysUndefined?: boolean;
  detail?: string;
  startupBudgetMs?: number;
  maxSpawnAttempts?: number;
}): FakeRuntime {
  let spawnIndex = 0;
  let disposed = 0;
  let currentAlive = false;
  let clockMs = 0;
  const submitWaitFlags: boolean[] = [];

  const deps: SendSessionRuntimeDeps = {
    spawnQueueOwnerProcess: (_options: QueueOwnerRuntimeOptions): SpawnedQueueOwner => {
      const entry = params.spawnScript[Math.min(spawnIndex, params.spawnScript.length - 1)];
      spawnIndex += 1;
      const exit = entry === "alive" ? undefined : entry;
      currentAlive = entry === "alive";
      return {
        get exit() {
          return exit;
        },
        dispose() {
          disposed += 1;
        },
      };
    },
    submitToRunningOwner: async (_options, waitForCompletion) => {
      submitWaitFlags.push(waitForCompletion);
      if (params.submitAlwaysUndefined) {
        return undefined;
      }
      return currentAlive ? ENQUEUE_OUTCOME : undefined;
    },
    waitMs: async (ms) => {
      // instant in real time; advances the injected clock so the wall-clock
      // startup budget is exercised without sleeping
      clockMs += ms;
    },
    readStartupFailureDetail: () => params.detail,
    startupBudgetMs: params.startupBudgetMs ?? 2_500,
    nowMs: () => clockMs,
    maxSpawnAttempts: params.maxSpawnAttempts ?? 3,
  };

  return {
    deps,
    spawnCount: () => spawnIndex,
    disposeCount: () => disposed,
    submitWaitFlags: () => submitWaitFlags,
  };
}

describe("spawnAndAwaitQueueOwner — bounded re-spawn", () => {
  it("re-spawns a dead-on-arrival owner and succeeds within the bound", async () => {
    const fake = makeFakeRuntime({ spawnScript: [DEAD_EXIT, "alive"] });

    const outcome = await spawnAndAwaitQueueOwner(makeSendOptions(), fake.deps);

    assert.deepEqual(outcome, ENQUEUE_OUTCOME);
    assert.equal(fake.spawnCount(), 2, "owner should be re-spawned exactly once after dying");
    // Every spawned owner's exit listener is released exactly once (no leaks).
    assert.equal(fake.disposeCount(), fake.spawnCount());
  });

  it("self-heals only on the final allowed re-spawn", async () => {
    // Dead, dead, then alive — must still recover at the 3rd (last) spawn.
    const fake = makeFakeRuntime({
      spawnScript: [DEAD_EXIT, DEAD_EXIT, "alive"],
      maxSpawnAttempts: 3,
    });

    const outcome = await spawnAndAwaitQueueOwner(makeSendOptions(), fake.deps);

    assert.deepEqual(outcome, ENQUEUE_OUTCOME);
    assert.equal(fake.spawnCount(), 3);
    assert.equal(fake.disposeCount(), 3);
  });

  it("fails fast and bounded when every owner dies on arrival, surfacing the exit reason", async () => {
    const fake = makeFakeRuntime({
      spawnScript: [DEAD_EXIT],
      submitAlwaysUndefined: true,
      detail: "[acpx] queue owner failed: EISDIR: illegal operation on a directory",
      maxSpawnAttempts: 3,
      // A generous startup budget that must NOT be consumed: fail-fast breaks out
      // after the bounded spawns are spent, not after the budget is used up.
      startupBudgetMs: 1_000_000,
    });

    await assert.rejects(
      async () => await spawnAndAwaitQueueOwner(makeSendOptions(), fake.deps),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /failed to start for session cold-respawn-session/);
        assert.match(error.message, /after 3 spawn attempt\(s\)/);
        assert.match(error.message, /owner process died on startup: exit code 1/);
        assert.match(error.message, /EISDIR/);
        return true;
      },
    );
    // Bounded: exactly maxSpawnAttempts spawns, then stop (no corpse-polling).
    assert.equal(fake.spawnCount(), 3);
    assert.equal(fake.disposeCount(), 3);
  });

  it("reports a signal-killed owner in the failure reason", async () => {
    const fake = makeFakeRuntime({
      spawnScript: [{ code: null, signal: "SIGKILL" }],
      submitAlwaysUndefined: true,
      maxSpawnAttempts: 2,
      startupBudgetMs: 5_000,
    });

    await assert.rejects(
      async () => await spawnAndAwaitQueueOwner(makeSendOptions(), fake.deps),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /killed by signal SIGKILL/);
        assert.match(error.message, /after 2 spawn attempt\(s\)/);
        return true;
      },
    );
    assert.equal(fake.spawnCount(), 2);
  });

  it("does NOT re-spawn a hung-but-alive owner; fails bounded after the startup budget", async () => {
    const fake = makeFakeRuntime({
      spawnScript: ["alive"],
      submitAlwaysUndefined: true,
      startupBudgetMs: 250,
      maxSpawnAttempts: 3,
    });

    await assert.rejects(
      async () => await spawnAndAwaitQueueOwner(makeSendOptions(), fake.deps),
      (error: unknown) => {
        assert(error instanceof Error);
        // No owner exit observed → no "died on startup" diagnostic, just the count.
        assert.match(error.message, /after 1 spawn attempt\(s\)/);
        assert.doesNotMatch(error.message, /died on startup/);
        return true;
      },
    );
    // A live (if wedged) owner is never re-spawned — a fresh owner would only
    // defer on its lease. Bounded by the startup budget, not hanging.
    assert.equal(fake.spawnCount(), 1);
    assert.equal(fake.disposeCount(), 1);
  });
});

// brick://addea939 A1 — every cold start passes through "lease written, listener not
// yet bound". The real `trySubmitToRunningOwner` THROWS QUEUE_NOT_ACCEPTING_REQUESTS
// there (after ~2 s of connect retries) instead of returning `undefined`, and the
// poll loop used to let that throw end the send while the owner was healthy.
type StartupPhase = "no-lease" | "lease-not-listening" | "listening";

// ~ what one real not-accepting poll costs: 40 connect attempts × 50 ms.
const NOT_ACCEPTING_POLL_COST_MS = 2_000;

function notAcceptingError(): QueueConnectionError {
  return new QueueConnectionError(
    "Session queue owner is running but not accepting queue requests",
    {
      detailCode: "QUEUE_NOT_ACCEPTING_REQUESTS",
      origin: "queue",
      retryable: true,
    },
  );
}

function makeStartupWindowRuntime(params: {
  phases: StartupPhase[];
  // After this many polls the spawned owner reports an exit (undefined = stays alive).
  ownerExitsAfterPolls?: number;
  startupBudgetMs?: number;
}) {
  let polls = 0;
  let spawns = 0;
  let clockMs = 0;
  const deps: SendSessionRuntimeDeps = {
    spawnQueueOwnerProcess: () => {
      spawns += 1;
      const spawnedAtPoll = polls;
      return {
        get exit() {
          return params.ownerExitsAfterPolls !== undefined &&
            polls - spawnedAtPoll >= params.ownerExitsAfterPolls
            ? DEAD_EXIT
            : undefined;
        },
        dispose() {
          // no-op
        },
      };
    },
    submitToRunningOwner: async () => {
      const phase = params.phases[Math.min(polls, params.phases.length - 1)];
      polls += 1;
      if (phase === "lease-not-listening") {
        clockMs += NOT_ACCEPTING_POLL_COST_MS;
        throw notAcceptingError();
      }
      return phase === "listening" ? ENQUEUE_OUTCOME : undefined;
    },
    waitMs: async (ms) => {
      clockMs += ms;
    },
    readStartupFailureDetail: () => undefined,
    startupBudgetMs: params.startupBudgetMs ?? 30_000,
    nowMs: () => clockMs,
    maxSpawnAttempts: 3,
  };
  return { deps, polls: () => polls, spawns: () => spawns, clock: () => clockMs };
}

describe("spawnAndAwaitQueueOwner — lease-before-listen window (A1)", () => {
  it("T-A1: keeps polling through a lease-not-listening poll and reaches the owner", async () => {
    const fake = makeStartupWindowRuntime({
      phases: ["no-lease", "lease-not-listening", "listening"],
    });

    const outcome = await spawnAndAwaitQueueOwner(makeSendOptions(), fake.deps);

    assert.deepEqual(outcome, ENQUEUE_OUTCOME);
    assert.equal(fake.polls(), 3);
    assert.equal(fake.spawns(), 1, "a healthy owner that is still starting is never re-spawned");
  });

  it("T-A1: survives several consecutive not-accepting polls inside the budget", async () => {
    const fake = makeStartupWindowRuntime({
      phases: [
        "no-lease",
        "lease-not-listening",
        "lease-not-listening",
        "lease-not-listening",
        "listening",
      ],
    });

    assert.deepEqual(await spawnAndAwaitQueueOwner(makeSendOptions(), fake.deps), ENQUEUE_OUTCOME);
    assert.equal(fake.polls(), 5);
  });

  it("T-A1b: an owner that never listens fails bounded by the wall-clock budget, with the retryable not-accepting error unchanged", async () => {
    const fake = makeStartupWindowRuntime({
      phases: ["lease-not-listening"],
      startupBudgetMs: 30_000,
    });

    await assert.rejects(
      async () => await spawnAndAwaitQueueOwner(makeSendOptions(), fake.deps),
      (error: unknown) => {
        // Nothing was submitted: callers (acpx-ui classifyEnqueueFailure) must see the
        // same class as the first-attempt failure, not "failed to start".
        assert(error instanceof QueueConnectionError);
        assert.equal(error.detailCode, "QUEUE_NOT_ACCEPTING_REQUESTS");
        assert.equal(error.retryable, true);
        assert.equal(error.origin, "queue");
        assert.match(error.message, /running but not accepting queue requests/);
        assert.doesNotMatch(error.message, /failed to start/);
        return true;
      },
    );
    assert.equal(fake.spawns(), 1, "a live-but-wedged owner is never re-spawned");
    // Time-bounded: stopped as soon as the injected clock passed the budget.
    assert.ok(fake.clock() >= 30_000, `clock ${fake.clock()} should have reached the budget`);
    assert.ok(
      fake.clock() < 30_000 + NOT_ACCEPTING_POLL_COST_MS + 100,
      `clock ${fake.clock()} overshot the budget by more than one poll`,
    );
    // ~2 s per not-accepting poll ⇒ ~14 polls; a 120-poll cap would have run ~4 min.
    assert.ok(fake.polls() < 20, `${fake.polls()} polls: the loop must be time-bound`);
  });

  it("T-A1b control: no lease within the budget still fails with 'failed to start'", async () => {
    const fake = makeStartupWindowRuntime({ phases: ["no-lease"], startupBudgetMs: 5_000 });

    await assert.rejects(
      async () => await spawnAndAwaitQueueOwner(makeSendOptions(), fake.deps),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.ok(!(error instanceof QueueConnectionError));
        assert.match(error.message, /failed to start for session cold-respawn-session/);
        assert.match(error.message, /after 1 spawn attempt\(s\)/);
        assert.doesNotMatch(error.message, /died on startup/);
        return true;
      },
    );
    assert.equal(fake.spawns(), 1);
  });

  it("T-A1b dead owner: a lease that never listened and an owner that exited keeps the exit diagnostic", async () => {
    const fake = makeStartupWindowRuntime({
      phases: ["lease-not-listening"],
      ownerExitsAfterPolls: 1,
    });

    await assert.rejects(
      async () => await spawnAndAwaitQueueOwner(makeSendOptions(), fake.deps),
      (error: unknown) => {
        assert(error instanceof Error);
        assert.ok(!(error instanceof QueueConnectionError));
        assert.match(error.message, /owner process died on startup: exit code 1/);
        return true;
      },
    );
  });

  it("T-A1c: a not-accepting owner that then exits is re-spawned, as before", async () => {
    const fake = makeStartupWindowRuntime({
      // First owner: lease written, never listens, then dies. The second one is reachable.
      phases: ["no-lease", "lease-not-listening", "lease-not-listening", "listening"],
      ownerExitsAfterPolls: 2,
    });

    const outcome = await spawnAndAwaitQueueOwner(makeSendOptions(), fake.deps);

    assert.deepEqual(outcome, ENQUEUE_OUTCOME);
    assert.equal(fake.spawns(), 2, "the dead owner is replaced exactly once");
  });

  it("any other error from the submit still propagates immediately", async () => {
    const fake = makeStartupWindowRuntime({ phases: ["no-lease"] });
    fake.deps.submitToRunningOwner = async () => {
      throw new QueueConnectionError("permission denied by queue control", {
        detailCode: "QUEUE_CONTROL_REQUEST_FAILED",
        origin: "queue",
        retryable: false,
      });
    };

    await assert.rejects(
      async () => await spawnAndAwaitQueueOwner(makeSendOptions(), fake.deps),
      /permission denied by queue control/,
    );
    assert.equal(fake.spawns(), 1);
  });
});

// A2, real transport: a second send reaches an owner another client spawned a moment
// earlier. Real lease file + real keeper pid + a real net.Server that binds the socket
// path only after the client's first submit has already failed.
describe("sendSession — young lease that is not yet listening (A2, real socket)", () => {
  const A2_SESSION = "a2-startup-window";

  async function withLeaseFixture(
    leaseAgeMs: number,
    run: (context: { socketPath: string; lockPath: string }) => Promise<void>,
  ): Promise<void> {
    await withTempHome(async (homeDir) => {
      await writeSessionRecordFile(
        homeDir,
        makeSessionRecord({
          acpxRecordId: A2_SESSION,
          acpSessionId: `acp-${A2_SESSION}`,
          agentCommand: "agent",
          cwd: homeDir,
        }),
      );
      const keeper = await startKeeperProcess();
      const { lockPath, socketPath } = queuePaths(homeDir, A2_SESSION);
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId: A2_SESSION,
        socketPath,
        createdAt: new Date(Date.now() - leaseAgeMs).toISOString(),
      });
      try {
        await run({ socketPath, lockPath });
      } finally {
        stopProcess(keeper);
      }
    });
  }

  const noSpawnDeps: SendSessionRuntimeDeps = {
    ...defaultSendSessionRuntimeDeps,
    spawnQueueOwnerProcess: () => {
      throw new Error("a second owner must never be spawned for a live starting owner");
    },
  };

  it("T-A2: waits for the listener of a young lease and delivers", async () => {
    await withLeaseFixture(500, async ({ socketPath }) => {
      const server = createSingleRequestServer((socket, request) => {
        assert.equal(request.type, "submit_prompt");
        socket.write(`${JSON.stringify({ type: "accepted", requestId: request.requestId })}\n`);
        socket.end();
      });
      // Bind only after the client's first submit (≈2 s of connect retries) has failed.
      const bindLater = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          listenServer(server, socketPath).then(resolve, reject);
        }, 3_000);
      });
      try {
        const outcome = await sendSession(
          makeSendOptions({ sessionId: A2_SESSION, waitForCompletion: false }),
          noSpawnDeps,
        );
        assert.ok(
          "queued" in outcome && outcome.queued,
          "delivered as an enqueue on the late listener",
        );
        await bindLater;
      } finally {
        await bindLater.catch(() => undefined);
        await closeServer(server);
      }
    });
  });

  it("T-A2: a young lease that never listens rethrows the ORIGINAL not-accepting error at budget expiry", async () => {
    await withLeaseFixture(0, async () => {
      await assert.rejects(
        async () =>
          await sendSession(makeSendOptions({ sessionId: A2_SESSION, waitForCompletion: false }), {
            ...noSpawnDeps,
            startupBudgetMs: 1_500,
          }),
        (error: unknown) => {
          assert(error instanceof QueueConnectionError);
          assert.equal(error.detailCode, "QUEUE_NOT_ACCEPTING_REQUESTS");
          assert.equal(error.retryable, true);
          assert.match(error.message, /running but not accepting queue requests/);
          return true;
        },
      );
    });
  });

  it("T-A2 control: an OLD lease with no listener keeps today's error and spawns nothing", async () => {
    await withLeaseFixture(10 * 60_000, async () => {
      await assert.rejects(
        async () =>
          await sendSession(
            makeSendOptions({ sessionId: A2_SESSION, waitForCompletion: false }),
            noSpawnDeps,
          ),
        (error: unknown) => {
          assert(error instanceof QueueConnectionError);
          assert.equal(error.detailCode, "QUEUE_NOT_ACCEPTING_REQUESTS");
          assert.match(error.message, /running but not accepting queue requests/);
          return true;
        },
      );
    });
  });
});

describe("spawnAndAwaitQueueOwner — deliver-now / background message", () => {
  it("retries (re-spawns) a no-wait deliver-now send instead of dropping it", async () => {
    const fake = makeFakeRuntime({ spawnScript: [DEAD_EXIT, "alive"] });

    const outcome = await spawnAndAwaitQueueOwner(
      makeSendOptions({ waitForCompletion: false }),
      fake.deps,
    );

    // The deliver-now message is enqueued on the re-spawned owner, not lost.
    assert.deepEqual(outcome, ENQUEUE_OUTCOME);
    assert.equal(fake.spawnCount(), 2);
    // The no-wait intent is preserved across the re-spawn for every submit attempt.
    assert.ok(fake.submitWaitFlags().length >= 1);
    assert.ok(fake.submitWaitFlags().every((wait) => !wait));
  });
});

describe("spawnQueueOwnerProcess — exit detection (real spawn)", () => {
  it("captures a dead-on-arrival owner's exit code", async () => {
    await withTempHome(async () => {
      const previous = process.env.ACPX_QUEUE_OWNER_ARGS;
      // Real child process that dies immediately with a known code — stands in
      // for an owner that exits before lock+listen. NOT a mock: a real process is
      // spawned and really exits.
      process.env.ACPX_QUEUE_OWNER_ARGS = JSON.stringify(["-e", "process.exit(7)"]);
      try {
        const spawned = spawnQueueOwnerProcess({
          sessionId: "exit-detect",
          permissionMode: "approve-reads",
        });
        const exit = await waitForOwnerExit(spawned, 5_000);
        assert.deepEqual(exit, { code: 7, signal: null });
        spawned.dispose();
      } finally {
        if (previous === undefined) {
          delete process.env.ACPX_QUEUE_OWNER_ARGS;
        } else {
          process.env.ACPX_QUEUE_OWNER_ARGS = previous;
        }
      }
    });
  });
});

describe("readQueueOwnerStartupFailureDetail", () => {
  it("returns the most recent explicit owner-failure line", async () => {
    await withTempHome(async (home) => {
      const dir = join(home, ".acpx", "sessions");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "detail-s1.owner.log"),
        "[acpx] queue owner failed: first reason\nunrelated chatter\n" +
          "[acpx] queue owner failed: EISDIR boom on unlink\n",
        "utf8",
      );
      assert.match(
        readQueueOwnerStartupFailureDetail("detail-s1") ?? "",
        /queue owner failed: EISDIR boom on unlink/,
      );
    });
  });

  it("falls back to the last non-empty line when there is no explicit failure line", async () => {
    await withTempHome(async (home) => {
      const dir = join(home, ".acpx", "sessions");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "detail-s2.owner.log"), "line one\nlast crash line\n", "utf8");
      assert.equal(readQueueOwnerStartupFailureDetail("detail-s2"), "last crash line");
    });
  });

  it("returns undefined for a missing or empty log", async () => {
    await withTempHome(async (home) => {
      assert.equal(readQueueOwnerStartupFailureDetail("absent"), undefined);
      const dir = join(home, ".acpx", "sessions");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "empty.owner.log"), "", "utf8");
      assert.equal(readQueueOwnerStartupFailureDetail("empty"), undefined);
    });
  });
});

async function waitForOwnerExit(
  spawned: SpawnedQueueOwner,
  timeoutMs: number,
): Promise<OwnerExitInfo> {
  const deadline = Date.now() + timeoutMs;
  while (spawned.exit === undefined) {
    if (Date.now() > deadline) {
      throw new Error("spawned owner did not exit within the timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return spawned.exit;
}
