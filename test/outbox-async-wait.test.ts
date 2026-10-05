import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { BrickOutbox, type DiskRecord } from "../src/brick-outbox.js";
import { withTempHome } from "./runtime-test-helpers.js";

/**
 * THE OUTBOX LIVELOCK (brick eb4c8d06; devbox incident 2026-10-05).
 *
 * `withAsyncMutation` holds `BEGIN IMMEDIATE` across an `await`, so the holder needs the event
 * loop to reach `COMMIT`. If a contender in the SAME process waits for the lock with
 * `Atomics.wait`, it freezes that loop: the holder cannot commit until the contender gives up
 * after its whole 4 s budget, and the contender fails `outbox-busy`. These rows pin the async
 * paths to a yielding wait.
 */

function diskRecord(id: string): DiskRecord {
  const now = new Date().toISOString();
  return {
    schema: "acpx.session.v1",
    kind: "session",
    acpx_record_id: id,
    acp_session_id: `acp-${id}`,
    agent_command: "agent",
    agent_name: "agent",
    cwd: os.homedir(),
    created_at: now,
    updated_at: now,
    last_used_at: now,
    last_seq: 0,
    messages: [],
    metadata: {},
  } as DiskRecord;
}

/** Holder: an async sidecar write that keeps the lock across a real await window. */
function holdAcrossAwait(holder: BrickOutbox, id: string, holdMs: number): Promise<void> {
  return holder.withOwnedSidecarWrite(id, diskRecord(id), async () => {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  });
}

/**
 * ROW 1 — THE DISCRIMINATOR. An async contender waits WITHOUT freezing the loop, so the holder
 * commits on time and the contender gets the lock right after it.
 *
 * Red on the pre-fix code (the async paths waited with `Atomics.wait`): the contender fails
 * `outbox-busy` after ~4 s, the holder's 50 ms hold stretches to ~4 s, and the probe timer fires
 * ~4 s late. Nothing but the wait style turns it: box load cannot make a 50 ms hold take 4 s
 * AND make the contender fail.
 */
test("async sidecar-write contender in the same process yields the loop: both land, holder commits on time", async () => {
  await withTempHome("acpx-outbox-async-wait-", async () => {
    const holder = new BrickOutbox();
    const contender = new BrickOutbox();
    try {
      const holding = holdAcrossAwait(holder, "holder-record", 50);
      // Let the holder take the lock before the contender starts.
      await new Promise((resolve) => setImmediate(resolve));
      const started = performance.now();
      const contending = contender.withOwnedSidecarWrite(
        "contender-record",
        diskRecord("contender-record"),
        async () => {},
      );
      // FM5: a timer scheduled WHILE the contender is waiting must fire promptly.
      const timerLag = new Promise<number>((resolve) => {
        const scheduled = performance.now();
        setTimeout(() => resolve(performance.now() - scheduled), 10);
      });
      const [holdOutcome, contendOutcome] = await Promise.allSettled([holding, contending]);
      const elapsed = performance.now() - started;
      assert.equal(holdOutcome.status, "fulfilled", `holder failed: ${String(holdOutcome)}`);
      assert.equal(
        contendOutcome.status,
        "fulfilled",
        contendOutcome.status === "rejected"
          ? `contender failed: ${(contendOutcome.reason as Error).message} — the async path is ` +
              "waiting with Atomics.wait again (brick eb4c8d06)"
          : "",
      );
      assert.ok(
        elapsed < 2000,
        `contender took ${elapsed.toFixed(0)} ms; expected ~the 50 ms hold`,
      );
      const lag = await timerLag;
      assert.ok(lag < 1000, `a 10 ms timer fired ${lag.toFixed(0)} ms late — the loop was frozen`);
    } finally {
      holder.close();
      contender.close();
    }
  });
});

/**
 * ROW 2 — THE CONTROL. The SYNCHRONOUS `saveRecord` in the identical shape still freezes the loop
 * and fails `outbox-busy`. It is kept for acpx-ui's synchronous spawn API, and this row proves the
 * harness above can produce the stall at all: without it, a green row 1 could come from a hold
 * that never overlapped the contender.
 */
test("control: the synchronous saveRecord in the same shape still stalls the holder and fails outbox-busy", async () => {
  await withTempHome("acpx-outbox-sync-wait-", async () => {
    const holder = new BrickOutbox();
    const contender = new BrickOutbox();
    try {
      const holding = holdAcrossAwait(holder, "holder-record", 50);
      await new Promise((resolve) => setImmediate(resolve));
      const started = performance.now();
      assert.throws(() => contender.saveRecord(diskRecord("contender-record")), /outbox-busy/);
      assert.ok(
        performance.now() - started >= 3500,
        "the synchronous contender gave up early — the stall was not reproduced",
      );
      await holding;
    } finally {
      holder.close();
      contender.close();
    }
  });
});

/**
 * ROW 3 — the record save the repository and the public file store use for spawn records,
 * `saveRecordAsync`, waits the same yielding way as row 1's sidecar write.
 */
test("saveRecordAsync contender in the same process yields the loop: both writes land", async () => {
  await withTempHome("acpx-outbox-async-save-", async () => {
    const holder = new BrickOutbox();
    const contender = new BrickOutbox();
    try {
      const holding = holdAcrossAwait(holder, "holder-record", 50);
      await new Promise((resolve) => setImmediate(resolve));
      const started = performance.now();
      const saved = await contender.saveRecordAsync(diskRecord("contender-record"));
      assert.equal(saved.acpx_record_id, "contender-record");
      assert.ok(performance.now() - started < 2000, "saveRecordAsync waited synchronously");
      await holding;
    } finally {
      holder.close();
      contender.close();
    }
  });
});
