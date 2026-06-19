import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  ensureOwnerIsUsable,
  hasLiveProcessGroup,
  isProcessAlive,
  readQueueOwnerLiveness,
  readQueueOwnerProcessIdentity,
  readQueueOwnerRecord,
  readQueueOwnerStatus,
  recoverQueueOwnerForSession,
  refreshQueueOwnerLease,
  releaseQueueOwnerLease,
  signalProcessGroup,
  terminateProcess,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/lease-store.js";
import { queueBaseDir, queueLockFilePath, queueSocketBaseDir } from "../src/cli/queue/paths.js";
import {
  queuePaths,
  startDetachedKeeperProcess,
  startDetachedOwnerWithChild,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

async function waitUntilDead(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("readQueueOwnerRecord returns undefined for missing and malformed lock files", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "missing-record";
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);

    const lockPath = queueLockFilePath(sessionId, homeDir);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, "{not-json\n", "utf8");
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);

    await fs.writeFile(lockPath, `${JSON.stringify({ pid: "bad" })}\n`, "utf8");
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);
  });
});

test("tryAcquireQueueOwnerLease creates a lease that can be refreshed and released", async () => {
  await withTempHome(async () => {
    const lease = await tryAcquireQueueOwnerLease("lease-create");
    assert(lease);
    assert.equal(lease.sessionId, "lease-create");
    if (process.platform === "linux") {
      assert.equal(lease.processIdentity?.kind, "linux-proc-stat-starttime");
      assert.match(lease.processIdentity?.startTimeTicks ?? "", /^\d+$/);
    }

    await refreshQueueOwnerLease(
      lease,
      {
        queueDepth: 1.7,
      },
      () => "2026-03-26T00:00:00.000Z",
    );

    const record = await readQueueOwnerRecord("lease-create");
    assert(record);
    assert.equal(record.queueDepth, 2);
    assert.equal(record.heartbeatAt, "2026-03-26T00:00:00.000Z");
    assert.deepEqual(record.processIdentity, lease.processIdentity);

    await releaseQueueOwnerLease(lease);
    assert.equal(await readQueueOwnerRecord("lease-create"), undefined);
  });
});

test("tryAcquireQueueOwnerLease assigns collision-resistant owner generations", async () => {
  await withTempHome(async () => {
    const originalDateNow = Date.now;
    const originalMathRandom = Math.random;
    Date.now = () => 1_777_072_400_000;
    Math.random = () => 0;

    try {
      const first = await tryAcquireQueueOwnerLease("lease-generation-a");
      const second = await tryAcquireQueueOwnerLease("lease-generation-b");
      assert(first);
      assert(second);
      assert.notEqual(first.ownerGeneration, second.ownerGeneration);
      assert(Number.isSafeInteger(first.ownerGeneration));
      assert(Number.isSafeInteger(second.ownerGeneration));
      assert(first.ownerGeneration > 0);
      assert(second.ownerGeneration > 0);
      await releaseQueueOwnerLease(first);
      await releaseQueueOwnerLease(second);
    } finally {
      Date.now = originalDateNow;
      Math.random = originalMathRandom;
    }
  });
});

test("tryAcquireQueueOwnerLease tightens queue directory permissions", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withTempHome(async (homeDir) => {
    const baseDir = queueBaseDir(homeDir);
    const socketDir = queueSocketBaseDir(homeDir);
    assert(socketDir);

    await fs.mkdir(baseDir, { recursive: true, mode: 0o777 });
    await fs.chmod(baseDir, 0o777);
    await fs.mkdir(socketDir, { recursive: true, mode: 0o777 });
    await fs.chmod(socketDir, 0o777);

    const lease = await tryAcquireQueueOwnerLease("lease-permissions");
    assert(lease);

    try {
      const baseMode = (await fs.stat(baseDir)).mode & 0o777;
      const socketMode = (await fs.stat(socketDir)).mode & 0o777;
      assert.equal(baseMode, 0o700);
      assert.equal(socketMode, 0o700);
    } finally {
      await releaseQueueOwnerLease(lease);
      await fs.rm(socketDir, { recursive: true, force: true });
    }
  });
});

test("tryAcquireQueueOwnerLease clears stale dead owners and can acquire on retry", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-dead-owner";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    await writeQueueOwnerLock({
      lockPath,
      pid: 999_999,
      sessionId,
      socketPath,
      heartbeatAt: "2000-01-01T00:00:00.000Z",
    });

    assert.equal(await tryAcquireQueueOwnerLease(sessionId), undefined);
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);

    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease);
    await releaseQueueOwnerLease(lease);
  });
});

test("readQueueOwnerStatus returns live owner details for a healthy owner", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "healthy-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    const processIdentity = keeper.pid
      ? await readQueueOwnerProcessIdentity(keeper.pid)
      : undefined;

    try {
      if (process.platform !== "win32") {
        await fs.mkdir(path.dirname(socketPath), { recursive: true });
        await fs.writeFile(socketPath, "", "utf8");
      }
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        queueDepth: 3,
        processIdentity,
      });

      const status = await readQueueOwnerStatus(sessionId);
      assert(status);
      assert.equal(status.pid, keeper.pid);
      assert.equal(status.alive, true);
      assert.equal(status.stale, false);
      assert.equal(status.state, "healthy");
      assert.equal(status.recoverable, false);
      assert.equal(status.processIdentityMatched, processIdentity ? true : null);
      assert.equal(status.socketReachable, process.platform === "win32" ? null : true);
      assert.equal(status.queueDepth, 3);
    } finally {
      stopProcess(keeper);
      await fs.rm(lockPath, { force: true });
      if (process.platform !== "win32") {
        await fs.rm(socketPath, { force: true });
      }
    }
  });
});

test("ensureOwnerIsUsable cleans up stale live owners", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "stale-live-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    const processIdentity = keeper.pid
      ? await readQueueOwnerProcessIdentity(keeper.pid)
      : undefined;

    try {
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
        processIdentity,
      });

      const owner = await readQueueOwnerRecord(sessionId);
      assert(owner);
      assert.equal(await ensureOwnerIsUsable(sessionId, owner), false);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
    } finally {
      stopProcess(keeper);
    }
  });
});

test("recoverQueueOwnerForSession succeeds idempotently when no owner lease exists", async () => {
  await withTempHome(async () => {
    const result = await recoverQueueOwnerForSession("no-such-owner");
    assert.equal(result.ownerFound, false);
    assert.equal(result.wasAlive, false);
    assert.equal(result.killed, false);
    assert.equal(result.alive, false);
    assert.equal(result.pid, undefined);
  });
});

test("recoverQueueOwnerForSession clears a stale lease for an already-dead owner", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "recover-stale-dead";
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    await writeQueueOwnerLock({ lockPath, pid: 999_999, sessionId, socketPath });

    const result = await recoverQueueOwnerForSession(sessionId);
    assert.equal(result.ownerFound, true);
    assert.equal(result.wasAlive, false);
    assert.equal(result.killed, false);
    assert.equal(result.alive, false);
    // "Already gone" is success — the stale lease is cleared so the next prompt
    // can cold-spawn a fresh owner.
    assert.equal(await readQueueOwnerRecord(sessionId), undefined);
  });
});

test("recoverQueueOwnerForSession kills a live owner and clears the lease", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "recover-live-owner";
    const keeper = await startDetachedKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);
    const processIdentity = keeper.pid
      ? await readQueueOwnerProcessIdentity(keeper.pid)
      : undefined;

    try {
      assert.equal(isProcessAlive(keeper.pid), true);
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        processIdentity,
      });

      const result = await recoverQueueOwnerForSession(sessionId);
      assert.equal(result.ownerFound, true);
      assert.equal(result.pid, keeper.pid);
      assert.equal(result.wasAlive, true);
      assert.equal(result.killed, true);
      assert.equal(result.alive, false);
      assert.equal(result.processIdentityMatched, processIdentity ? true : null);
      assert.equal(isProcessAlive(keeper.pid), false);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
    } finally {
      stopProcess(keeper);
    }
  });
});

test("recoverQueueOwnerForSession kills the owner's whole process group (reaps grandchild, R2)", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withTempHome(async (homeDir) => {
    const sessionId = "recover-process-group";
    const pidFile = path.join(homeDir, "grandchild.pid");
    const { owner, childPid } = await startDetachedOwnerWithChild(pidFile);
    const ownerPid = owner.pid;
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      assert(ownerPid && Number.isInteger(ownerPid));
      assert(childPid && Number.isInteger(childPid));
      assert.equal(isProcessAlive(ownerPid), true);
      assert.equal(isProcessAlive(childPid), true);

      await writeQueueOwnerLock({ lockPath, pid: ownerPid, sessionId, socketPath });

      const result = await recoverQueueOwnerForSession(sessionId);
      assert.equal(result.killed, true);
      assert.equal(result.alive, false);
      assert.equal(isProcessAlive(ownerPid), false);

      // The grandchild (e.g. a native-blocked SDK child) shares the owner's
      // process group, so the group SIGKILL must reap it rather than orphan it.
      await waitUntilDead(childPid);
      assert.equal(isProcessAlive(childPid), false);
    } finally {
      stopProcess(owner);
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});

test("readQueueOwnerLiveness classifies PID reuse read-only without killing the live pid", async () => {
  if (process.platform !== "linux") {
    return;
  }

  await withTempHome(async (homeDir) => {
    const sessionId = "recover-pid-reused";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      assert(keeper.pid);
      const currentIdentity = await readQueueOwnerProcessIdentity(keeper.pid);
      assert(currentIdentity);
      const staleIdentity = {
        kind: "linux-proc-stat-starttime" as const,
        startTimeTicks: currentIdentity.startTimeTicks === "1" ? "2" : "1",
      };
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        processIdentity: staleIdentity,
      });

      const liveness = await readQueueOwnerLiveness(sessionId);
      assert.equal(liveness.ownerFound, true);
      assert.equal(liveness.state, "pid_reused");
      assert.equal(liveness.recoverable, true);
      assert.equal(liveness.pidAlive, true);
      assert.equal(liveness.alive, false);
      assert.equal(liveness.processIdentityMatched, false);
      assert.notEqual(await readQueueOwnerRecord(sessionId), undefined);
      assert.equal(isProcessAlive(keeper.pid), true);
    } finally {
      await fs.rm(lockPath, { force: true });
      stopProcess(keeper);
    }
  });
});

test("recovery clears PID-reused lease without killing unrelated live process", async () => {
  if (process.platform !== "linux") {
    return;
  }

  await withTempHome(async (homeDir) => {
    const sessionId = "pid-reused-no-kill";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      assert(keeper.pid);
      const currentIdentity = await readQueueOwnerProcessIdentity(keeper.pid);
      assert(currentIdentity);
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        processIdentity: {
          kind: "linux-proc-stat-starttime",
          startTimeTicks: currentIdentity.startTimeTicks === "1" ? "2" : "1",
        },
      });

      const result = await recoverQueueOwnerForSession(sessionId);
      assert.equal(result.ownerFound, true);
      assert.equal(result.pid, keeper.pid);
      assert.equal(result.state, "pid_reused");
      assert.equal(result.pidAlive, true);
      assert.equal(result.wasAlive, true);
      assert.equal(result.killed, false);
      assert.equal(result.alive, false);
      assert.equal(result.killSkipped, true);
      assert.equal(result.processIdentityMatched, false);
      assert.equal(isProcessAlive(keeper.pid), true);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
    } finally {
      await fs.rm(lockPath, { force: true });
      stopProcess(keeper);
    }
  });
});

test("process group helpers detect and signal a detached owner group", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withTempHome(async (homeDir) => {
    const pidFile = path.join(homeDir, "helper-grandchild.pid");
    const { owner, childPid } = await startDetachedOwnerWithChild(pidFile);
    const ownerPid = owner.pid;

    try {
      assert(ownerPid && Number.isInteger(ownerPid));
      assert(childPid && Number.isInteger(childPid));
      assert.equal(hasLiveProcessGroup(ownerPid), true);
      assert.equal(hasLiveProcessGroup(999_999), false);

      signalProcessGroup(ownerPid, "SIGKILL");
      await waitUntilDead(ownerPid);
      await waitUntilDead(childPid);

      assert.equal(isProcessAlive(ownerPid), false);
      assert.equal(isProcessAlive(childPid), false);
      assert.equal(hasLiveProcessGroup(ownerPid), false);
    } finally {
      stopProcess(owner);
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  });
});

test("readQueueOwnerLiveness reports liveness read-only and never reaps the lease", async () => {
  await withTempHome(async (homeDir) => {
    const missing = await readQueueOwnerLiveness("no-lease");
    assert.equal(missing.ownerFound, false);
    assert.equal(missing.state, "no_owner");
    assert.equal(missing.recoverable, false);
    assert.equal(missing.pid, null);

    const sessionId = "liveness-stale-live";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      // Live pid but a stale heartbeat: readQueueOwnerStatus would terminate +
      // remove this owner; readQueueOwnerLiveness must only report it.
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
        heartbeatAt: "2000-01-01T00:00:00.000Z",
      });

      const liveness = await readQueueOwnerLiveness(sessionId);
      assert(liveness);
      assert.equal(liveness.ownerFound, true);
      assert.equal(liveness.pid, keeper.pid);
      assert.equal(liveness.pidAlive, true);
      assert.equal(liveness.alive, true);
      assert.equal(liveness.stale, true);
      assert.equal(liveness.state, "stale_owner");
      assert.equal(liveness.recoverable, true);
      assert.equal(liveness.heartbeatAt, "2000-01-01T00:00:00.000Z");

      // The lease is still on disk (no reaping side effect) and the owner is alive.
      assert.notEqual(await readQueueOwnerRecord(sessionId), undefined);
      assert.equal(isProcessAlive(keeper.pid), true);
    } finally {
      stopProcess(keeper);
      await fs.rm(lockPath, { force: true });
    }
  });
});

test("terminateProcess and terminateQueueOwnerForSession handle live and missing owners", async () => {
  await withTempHome(async (homeDir) => {
    assert.equal(isProcessAlive(undefined), false);
    assert.equal(isProcessAlive(process.pid), false);
    assert.equal(await terminateProcess(999_999), false);

    const sessionId = "terminate-owner";
    const keeper = await startKeeperProcess();
    const { lockPath, socketPath } = queuePaths(homeDir, sessionId);

    try {
      assert.equal(isProcessAlive(keeper.pid), true);
      await writeQueueOwnerLock({
        lockPath,
        pid: keeper.pid,
        sessionId,
        socketPath,
      });

      await terminateQueueOwnerForSession(sessionId);
      assert.equal(await readQueueOwnerRecord(sessionId), undefined);
    } finally {
      stopProcess(keeper);
    }
  });
});
