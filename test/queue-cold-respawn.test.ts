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
  type SendSessionRuntimeDeps,
  spawnAndAwaitQueueOwner,
} from "../src/cli/session/queue-owner-runtime.js";
import { textPrompt } from "../src/prompt-content.js";
import type { OutputFormatter, SessionSendOutcome } from "../src/types.js";
import { withTempHome } from "./queue-test-helpers.js";

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
  maxPollAttempts?: number;
  maxSpawnAttempts?: number;
}): FakeRuntime {
  let spawnIndex = 0;
  let disposed = 0;
  let currentAlive = false;
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
    waitMs: async () => {
      // instant — keep the orchestration tests fast
    },
    readStartupFailureDetail: () => params.detail,
    maxPollAttempts: params.maxPollAttempts ?? 50,
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
      // A generous poll budget that must NOT be consumed: fail-fast breaks out
      // after the bounded spawns are spent, not after 1000 polls.
      maxPollAttempts: 1000,
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
      maxPollAttempts: 100,
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

  it("does NOT re-spawn a hung-but-alive owner; fails bounded after the poll budget", async () => {
    const fake = makeFakeRuntime({
      spawnScript: ["alive"],
      submitAlwaysUndefined: true,
      maxPollAttempts: 5,
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
    // defer on its lease. Bounded by the poll budget, not hanging.
    assert.equal(fake.spawnCount(), 1);
    assert.equal(fake.disposeCount(), 1);
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
