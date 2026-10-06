import assert from "node:assert/strict";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SpawnLedger, type DiskRecord } from "../src/spawn-ledger.js";
import { withTempHome } from "./runtime-test-helpers.js";

/**
 * THE LIVELOCK (brick eb4c8d06; devbox incident 2026-10-05).
 *
 * A holder that needs the event loop to reach COMMIT cannot get it while a contender in the SAME
 * process waits for the lock with `Atomics.wait`: the holder commits only after the contender
 * gives up its whole 4 s budget, and the contender fails `outbox-busy`. These rows pin the async
 * record writer to a yielding wait. The holder here is a raw SQLite connection that commits on a
 * timer — the spawn ledger itself no longer holds its lock across an await anywhere.
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

/** Holds the ledger's write lock until a timer — i.e. until the event loop runs again. */
function holdUntilTimer(dbPath: string, holdMs: number): Promise<void> {
  const holder = new DatabaseSync(dbPath);
  holder.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  return new Promise((resolve) => {
    setTimeout(() => {
      holder.exec("COMMIT");
      holder.close();
      resolve();
    }, holdMs);
  });
}

/**
 * ROW 1 — THE DISCRIMINATOR. saveRecordAsync waits WITHOUT freezing the loop, so the holder
 * commits on time and the contender gets the lock right after it.
 */
test("saveRecordAsync contender in the same process yields the loop: holder commits on time, write lands", async () => {
  await withTempHome("acpx-ledger-async-wait-", async () => {
    const ledger = new SpawnLedger();
    try {
      const holding = holdUntilTimer(ledger.dbPath, 50);
      const started = performance.now();
      const contending = ledger.saveRecordAsync(diskRecord("contender-record"));
      // A timer scheduled WHILE the contender is waiting must fire promptly.
      const timerLag = new Promise<number>((resolve) => {
        const scheduled = performance.now();
        setTimeout(() => resolve(performance.now() - scheduled), 10);
      });
      const [holdOutcome, contendOutcome] = await Promise.allSettled([holding, contending]);
      const elapsed = performance.now() - started;
      assert.equal(holdOutcome.status, "fulfilled");
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
      assert.equal(ledger.readRecord("contender-record")?.acpx_record_id, "contender-record");
    } finally {
      ledger.close();
    }
  });
});

/**
 * ROW 2 — THE CONTROL. The SYNCHRONOUS saveRecord in the identical shape freezes the loop and
 * fails outbox-busy. It stays for acpx-ui's synchronous spawn API, and this row proves the
 * harness above can produce the stall at all.
 */
test("control: the synchronous saveRecord in the same shape stalls the holder and fails outbox-busy", async () => {
  await withTempHome("acpx-ledger-sync-wait-", async () => {
    const ledger = new SpawnLedger();
    try {
      const holding = holdUntilTimer(ledger.dbPath, 50);
      const started = performance.now();
      assert.throws(() => ledger.saveRecord(diskRecord("contender-record")), /outbox-busy/);
      assert.ok(
        performance.now() - started >= 3500,
        "the synchronous contender gave up early — the stall was not reproduced",
      );
      await holding;
    } finally {
      ledger.close();
    }
  });
});
