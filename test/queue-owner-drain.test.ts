// brick c92f6bdc, Fix A — graceful drain on the VOLUNTARY self-teardown path.
// closeQueueOwnerRuntime used to end with an unconditional group-SIGKILL (the
// orphan backstop) that also destroyed live background work. The drain prepends a
// bounded SIGTERM-every-member-except-self → poll-until-only-leader → report
// survivors step BEFORE that final SIGKILL, so a background job gets a chance to
// finish / checkpoint; the group-SIGKILL stays as the LAST act (orphan backstop,
// bricks 1dda30b3/f22ad667). This suite pins `drainProcessGroupExceptSelf`'s
// ordering against real detached process groups. Mirrors the group helpers in
// queue-lease-store.test.ts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  drainProcessGroupExceptSelf,
  hasLiveProcessGroup,
  isProcessAlive,
} from "../src/cli/queue/lease-store.js";
import { withTempHome } from "./queue-test-helpers.js";

async function waitUntilDead(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readPidFile(file: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const raw = (await fs.readFile(file, "utf8")).trim();
      const parsed = Number(raw);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return 0;
}

// A detached group LEADER that spawns one child in its group. The child registers
// its SIGTERM disposition FIRST, THEN writes its pid to `readyFile` — so a test
// that waits for readyFile is guaranteed the handler is installed before it drains
// (no SIGTERM-vs-handler-registration race). `mode`:
//   - "ignore" → an empty SIGTERM handler (stays alive on SIGTERM) → a survivor.
//   - "exit"   → exits cleanly on SIGTERM → drained within grace, not a survivor.
async function startLeaderWithChild(
  mode: "ignore" | "exit",
  readyFile: string,
): Promise<{ leader: ReturnType<typeof spawn>; childPid: number }> {
  const handler =
    mode === "ignore"
      ? "process.on('SIGTERM',()=>{});"
      : "process.on('SIGTERM',()=>process.exit(0));";
  const childCode = `${handler}require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);`;
  const leaderCode =
    "const{spawn}=require('node:child_process');" +
    `spawn(process.execPath,['-e',${JSON.stringify(childCode)},process.argv[1]],{stdio:'ignore'});` +
    "setInterval(()=>{},1000);";
  const leader = spawn(process.execPath, ["-e", leaderCode, readyFile], {
    stdio: "ignore",
    detached: true,
  });
  await once(leader, "spawn");
  const childPid = await readPidFile(readyFile);
  return { leader, childPid };
}

function killQuietly(pid: number | undefined): void {
  if (pid && pid > 0) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

// A child that traps SIGTERM and exits cleanly → the drain must let it finish
// within grace and must NOT report it as a survivor (no forced SIGKILL).
test("drainProcessGroupExceptSelf: a SIGTERM-honoring child exits in grace, no survivors", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withTempHome(async (homeDir) => {
    const { leader, childPid } = await startLeaderWithChild(
      "exit",
      path.join(homeDir, "child.pid"),
    );
    const leaderPid = leader.pid;
    try {
      assert(leaderPid && Number.isInteger(leaderPid));
      assert(childPid && Number.isInteger(childPid), "child pid captured");
      assert.equal(isProcessAlive(childPid), true);

      let survivorsReported: number[] | undefined;
      await drainProcessGroupExceptSelf(leaderPid, 3_000, (survivors) => {
        survivorsReported = survivors;
      });

      await waitUntilDead(childPid);
      assert.equal(isProcessAlive(childPid), false, "the child honored SIGTERM and exited");
      assert.equal(
        survivorsReported,
        undefined,
        "onSurvivors must NOT fire — the child exited within grace, no SIGKILL needed",
      );
      // The leader itself is untouched by the drain (drain excludes self).
      assert.equal(isProcessAlive(leaderPid), true, "the leader is never signalled by the drain");
    } finally {
      killQuietly(childPid);
      killQuietly(leaderPid);
    }
  });
});

// A child that IGNORES SIGTERM → after grace it must be reported as a survivor,
// so the caller's group-SIGKILL reaps it. We then verify it is still alive right
// after the drain (proving the drain did NOT itself SIGKILL — that is the caller's
// last-act backstop) and reap it ourselves.
test("drainProcessGroupExceptSelf: a SIGTERM-ignoring child is reported as a survivor after grace", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withTempHome(async (homeDir) => {
    const { leader, childPid } = await startLeaderWithChild(
      "ignore",
      path.join(homeDir, "child.pid"),
    );
    const leaderPid = leader.pid;
    try {
      assert(leaderPid && Number.isInteger(leaderPid));
      assert(childPid && Number.isInteger(childPid), "child pid captured");

      let survivorsReported: number[] | undefined;
      const startedAt = Date.now();
      await drainProcessGroupExceptSelf(leaderPid, 500, (survivors) => {
        survivorsReported = survivors;
      });
      const elapsed = Date.now() - startedAt;

      assert(survivorsReported, "onSurvivors fires for a child that outlived the grace");
      assert(
        survivorsReported.includes(childPid),
        "the SIGTERM-ignoring child is named as a survivor",
      );
      assert(
        elapsed >= 500,
        `the drain waited the full grace before giving up (waited ${elapsed}ms)`,
      );
      assert.equal(
        isProcessAlive(childPid),
        true,
        "the drain does NOT SIGKILL the survivor — that is the caller's final backstop",
      );
    } finally {
      killQuietly(childPid);
      killQuietly(leaderPid);
    }
  });
});

// graceMs === 0 → immediate: no SIGTERM wait. A SIGTERM-ignoring child is a
// survivor right away (restores the legacy immediate-kill escape hatch, where the
// caller's group-SIGKILL does all the killing).
test("drainProcessGroupExceptSelf: graceMs 0 reports survivors immediately (legacy immediate-kill)", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withTempHome(async (homeDir) => {
    const { leader, childPid } = await startLeaderWithChild(
      "ignore",
      path.join(homeDir, "child.pid"),
    );
    const leaderPid = leader.pid;
    try {
      assert(leaderPid && Number.isInteger(leaderPid));
      assert(childPid && Number.isInteger(childPid), "child pid captured");
      let survivorsReported: number[] | undefined;
      const startedAt = Date.now();
      await drainProcessGroupExceptSelf(leaderPid, 0, (survivors) => {
        survivorsReported = survivors;
      });
      const elapsed = Date.now() - startedAt;
      assert(survivorsReported?.includes(childPid), "the child is a survivor with zero grace");
      assert(elapsed < 400, `no grace wait with graceMs 0 (elapsed ${elapsed}ms)`);
    } finally {
      killQuietly(childPid);
      killQuietly(leaderPid);
    }
  });
});

// A clean group (only the leader, no other members) drains to no survivors fast.
test("drainProcessGroupExceptSelf: a group with only the leader reports no survivors", async () => {
  if (process.platform === "win32") {
    return;
  }
  const leader = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
    detached: true,
  });
  await once(leader, "spawn");
  const leaderPid = leader.pid;
  try {
    assert(leaderPid && Number.isInteger(leaderPid));
    assert.equal(hasLiveProcessGroup(leaderPid), true);
    let survivorsReported: number[] | undefined;
    await drainProcessGroupExceptSelf(leaderPid, 1_000, (survivors) => {
      survivorsReported = survivors;
    });
    assert.equal(survivorsReported, undefined, "no non-leader members ⇒ onSurvivors never fires");
    assert.equal(isProcessAlive(leaderPid), true, "the leader is left alive by the drain");
  } finally {
    killQuietly(leaderPid);
  }
});
