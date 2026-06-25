// W13-24-10 — queue-owner reaper North-Star regression suite.
//
// North Star: never auto-kill/auto-release an owner whose process is ALIVE
// (active, quiet, busy, or heartbeat-lagged); clean up ONLY a provably-gone
// owner's orphan lease; never auto-restart. These tests pin the behaviour of the
// Path-2 single-predicate fix (drop stale_owner from "recoverable") and assert the
// user-initiated Paths 3/4 still terminate a live owner by explicit request.
//
// Every test uses a REAL process (a detached keeper for "alive", a never-used pid
// for "dead") and real liveness signals — the lifecycle is never mocked.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  isProcessAlive,
  readQueueOwnerLiveness,
  readQueueOwnerProcessIdentity,
  readQueueOwnerRecord,
  readQueueOwnerStatus,
  recoverQueueOwnerForSession,
  terminateQueueOwnerForSession,
  tryAcquireQueueOwnerLease,
  releaseQueueOwnerLease,
} from "../src/cli/queue/lease-store.js";
import {
  queuePaths,
  startKeeperProcess,
  stopProcess,
  withTempHome,
  writeQueueOwnerLock,
} from "./queue-test-helpers.js";

const STALE_HEARTBEAT = "2000-01-01T00:00:00.000Z";
const DEAD_PID = 999_999;

async function waitForPidExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessAlive(pid);
}

// #1 — the single predicate: a stale-but-alive owner is NOT recoverable; only a
// provably-gone owner (dead pid / reused pid) is.
test("W13-24-10 #1: stale-but-alive is not recoverable; dead/pid-reused are", async () => {
  await withTempHome(async (homeDir) => {
    // stale-but-alive
    const staleKeeper = await startKeeperProcess();
    const stalePaths = queuePaths(homeDir, "ns-pred-stale");
    await writeQueueOwnerLock({
      lockPath: stalePaths.lockPath,
      pid: staleKeeper.pid,
      sessionId: "ns-pred-stale",
      socketPath: stalePaths.socketPath,
      heartbeatAt: STALE_HEARTBEAT,
    });

    // dead
    const deadPaths = queuePaths(homeDir, "ns-pred-dead");
    await writeQueueOwnerLock({
      lockPath: deadPaths.lockPath,
      pid: DEAD_PID,
      sessionId: "ns-pred-dead",
      socketPath: deadPaths.socketPath,
      heartbeatAt: STALE_HEARTBEAT,
    });

    try {
      const stale = await readQueueOwnerLiveness("ns-pred-stale");
      assert.equal(stale.state, "stale_owner");
      assert.equal(stale.pidAlive, true);
      assert.equal(stale.recoverable, false, "a stale heartbeat != a dead process");

      const dead = await readQueueOwnerLiveness("ns-pred-dead");
      assert.equal(dead.state, "dead_owner");
      assert.equal(dead.pidAlive, false);
      assert.equal(dead.recoverable, true);

      if (process.platform === "linux" && staleKeeper.pid) {
        // pid_reused: live pid, mismatched process identity.
        const currentIdentity = await readQueueOwnerProcessIdentity(staleKeeper.pid);
        assert(currentIdentity);
        const reusedPaths = queuePaths(homeDir, "ns-pred-reused");
        await writeQueueOwnerLock({
          lockPath: reusedPaths.lockPath,
          pid: staleKeeper.pid,
          sessionId: "ns-pred-reused",
          socketPath: reusedPaths.socketPath,
          processIdentity: {
            kind: "linux-proc-stat-starttime",
            startTimeTicks: currentIdentity.startTimeTicks === "1" ? "2" : "1",
          },
        });
        const reused = await readQueueOwnerLiveness("ns-pred-reused");
        assert.equal(reused.state, "pid_reused");
        assert.equal(reused.recoverable, true);
        await fs.rm(reusedPaths.lockPath, { force: true });
      }
    } finally {
      stopProcess(staleKeeper);
      await fs.rm(stalePaths.lockPath, { force: true });
      await fs.rm(deadPaths.lockPath, { force: true });
    }
  });
});

// #2 — cleanup NEVER signals a process. For a stale-but-alive owner cleanup is a
// no-op (owner survives, lease preserved); for a dead owner the orphan lease is
// cleared. (readQueueOwnerStatus is the public entry that invokes cleanup.)
test("W13-24-10 #2: cleanup never signals; no-op for stale, clears lease for dead", async () => {
  await withTempHome(async (homeDir) => {
    // stale-but-alive: status read must NOT terminate it and must keep the lease.
    const keeper = await startKeeperProcess();
    const stalePaths = queuePaths(homeDir, "ns-clean-stale");
    await writeQueueOwnerLock({
      lockPath: stalePaths.lockPath,
      pid: keeper.pid,
      sessionId: "ns-clean-stale",
      socketPath: stalePaths.socketPath,
      heartbeatAt: STALE_HEARTBEAT,
    });

    // dead: status read must clear the orphan lease.
    const deadPaths = queuePaths(homeDir, "ns-clean-dead");
    await writeQueueOwnerLock({
      lockPath: deadPaths.lockPath,
      pid: DEAD_PID,
      sessionId: "ns-clean-dead",
      socketPath: deadPaths.socketPath,
      heartbeatAt: STALE_HEARTBEAT,
    });

    try {
      const staleStatus = await readQueueOwnerStatus("ns-clean-stale");
      assert(staleStatus, "stale-but-alive owner must still report a status");
      assert.equal(staleStatus.state, "stale_owner");
      assert.equal(staleStatus.recoverable, false);
      assert.equal(isProcessAlive(keeper.pid), true, "stale owner must NOT be signalled");
      assert.notEqual(await readQueueOwnerRecord("ns-clean-stale"), undefined, "lease preserved");

      const deadStatus = await readQueueOwnerStatus("ns-clean-dead");
      assert.equal(deadStatus, undefined, "dead owner status read returns undefined after cleanup");
      assert.equal(await readQueueOwnerRecord("ns-clean-dead"), undefined, "dead lease cleared");
    } finally {
      stopProcess(keeper);
      await fs.rm(stalePaths.lockPath, { force: true });
      await fs.rm(deadPaths.lockPath, { force: true });
    }
  });
});

// #4 — status read with the kill side-effect must NOT kill a stale_owner (it is
// alive) yet still clean a dead_owner lease. (Distinct framing from #2: the hot
// probeQueueOwnerHealth consumer reads through readQueueOwnerStatus.)
test("W13-24-10 #4: readQueueOwnerStatus does not kill a stale-but-alive owner", async () => {
  await withTempHome(async (homeDir) => {
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, "ns-statusread-stale");
    await writeQueueOwnerLock({
      lockPath: paths.lockPath,
      pid: keeper.pid,
      sessionId: "ns-statusread-stale",
      socketPath: paths.socketPath,
      heartbeatAt: STALE_HEARTBEAT,
    });

    try {
      // Read repeatedly (every health probe could trigger the old kill side-effect).
      for (let i = 0; i < 3; i += 1) {
        const status = await readQueueOwnerStatus("ns-statusread-stale");
        assert(status);
        assert.equal(status.state, "stale_owner");
      }
      assert.equal(isProcessAlive(keeper.pid), true, "repeated status reads never kill the owner");
      assert.notEqual(await readQueueOwnerRecord("ns-statusread-stale"), undefined);
    } finally {
      stopProcess(keeper);
      await fs.rm(paths.lockPath, { force: true });
    }
  });
});

// #5 — lease acquisition (a second-owner spawn attempt) must NOT kill a
// stale-but-alive holder (it keeps its lease), but must clear a dead holder's
// lease so a fresh owner can acquire on retry.
test("W13-24-10 #5: lease-acquire never kills a stale-but-alive owner; clears dead", async () => {
  await withTempHome(async (homeDir) => {
    // stale-but-alive: a competing acquire must fail (live owner keeps the lease).
    const keeper = await startKeeperProcess();
    const stalePaths = queuePaths(homeDir, "ns-acquire-stale");
    await writeQueueOwnerLock({
      lockPath: stalePaths.lockPath,
      pid: keeper.pid,
      sessionId: "ns-acquire-stale",
      socketPath: stalePaths.socketPath,
      heartbeatAt: STALE_HEARTBEAT,
    });

    try {
      const blocked = await tryAcquireQueueOwnerLease("ns-acquire-stale");
      assert.equal(blocked, undefined, "must not acquire over a live owner's lease");
      assert.equal(isProcessAlive(keeper.pid), true, "lease-acquire must NOT kill the live owner");
      assert.notEqual(await readQueueOwnerRecord("ns-acquire-stale"), undefined, "lease preserved");
    } finally {
      stopProcess(keeper);
      await fs.rm(stalePaths.lockPath, { force: true });
    }

    // dead: first acquire clears the orphan lease, a retry succeeds.
    const deadPaths = queuePaths(homeDir, "ns-acquire-dead");
    await writeQueueOwnerLock({
      lockPath: deadPaths.lockPath,
      pid: DEAD_PID,
      sessionId: "ns-acquire-dead",
      socketPath: deadPaths.socketPath,
      heartbeatAt: STALE_HEARTBEAT,
    });
    assert.equal(await tryAcquireQueueOwnerLease("ns-acquire-dead"), undefined);
    assert.equal(await readQueueOwnerRecord("ns-acquire-dead"), undefined, "dead lease cleared");
    const lease = await tryAcquireQueueOwnerLease("ns-acquire-dead");
    assert(lease, "a fresh owner can acquire after the dead lease is cleared");
    await releaseQueueOwnerLease(lease);
  });
});

// #7 — Paths 3 (recycle) and 4 (manual recover) gate on canSignalQueueOwner, NOT
// on `recoverable`, so they STILL terminate a stale-but-alive owner by explicit
// user request. The Path-2 fix neutralised only the AUTONOMOUS kills.
test("W13-24-10 #7: manual recover (Path 4) still kills a stale-but-alive owner", async () => {
  await withTempHome(async (homeDir) => {
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, "ns-recover-stale");
    await writeQueueOwnerLock({
      lockPath: paths.lockPath,
      pid: keeper.pid,
      sessionId: "ns-recover-stale",
      socketPath: paths.socketPath,
      heartbeatAt: STALE_HEARTBEAT,
    });

    try {
      const result = await recoverQueueOwnerForSession("ns-recover-stale");
      assert.equal(result.ownerFound, true);
      assert.equal(result.state, "stale_owner");
      assert.equal(result.killed, true, "explicit user recover MUST still kill a stale owner");
      assert.equal(await waitForPidExit(keeper.pid as number), true);
      assert.equal(await readQueueOwnerRecord("ns-recover-stale"), undefined);
    } finally {
      stopProcess(keeper);
      await fs.rm(paths.lockPath, { force: true });
    }
  });
});

test("W13-24-10 #7: recycle terminate (Path 3) still kills a stale-but-alive owner", async () => {
  await withTempHome(async (homeDir) => {
    const keeper = await startKeeperProcess();
    const paths = queuePaths(homeDir, "ns-recycle-stale");
    await writeQueueOwnerLock({
      lockPath: paths.lockPath,
      pid: keeper.pid,
      sessionId: "ns-recycle-stale",
      socketPath: paths.socketPath,
      heartbeatAt: STALE_HEARTBEAT,
    });

    try {
      await terminateQueueOwnerForSession("ns-recycle-stale");
      assert.equal(await waitForPidExit(keeper.pid as number), true, "recycle must kill the owner");
      assert.equal(await readQueueOwnerRecord("ns-recycle-stale"), undefined);
    } finally {
      stopProcess(keeper);
      await fs.rm(paths.lockPath, { force: true });
    }
  });
});
