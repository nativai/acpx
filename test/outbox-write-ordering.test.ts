import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getPerfMetricsSnapshot, resetPerfMetrics } from "../src/perf-metrics.js";
import { writeSessionRecord, writeSessionRecordAtBoundary } from "../src/session/persistence.js";
import { REENTRANT_RECORD_WRITE_COUNTER } from "../src/session/persistence/repository.js";
import type { SessionMessage } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

function reentrantWrites(): number {
  return getPerfMetricsSnapshot().counters[REENTRANT_RECORD_WRITE_COUNTER] ?? 0;
}

/**
 * THE ACCEPTANCE INSTRUMENT for brick 6b1e0038 — in-process ordering of same-process
 * `writeSessionRecord` calls.
 *
 * 🔑 THE MECHANISM, established by reading at `ef794177`. `brick-outbox.ts`'s
 * `withAsyncMutation` does `beginImmediateWithRetry()` -> `await action()` -> `COMMIT`, i.e.
 * it holds the exclusive SQLite lock ACROSS an `await`; and its busy retry waits with
 * `Atomics.wait`, which blocks the ONLY thread. So a second in-process write that overlaps
 * the first does not merely lose a lock race — it blocks the very thread the holder needs
 * in order to reach `COMMIT`. The holder cannot progress, the contender burns its entire
 * 4 s budget, and fails terminally with `outbox-busy`. TWO OVERLAPPING IN-PROCESS OUTBOX
 * WRITES LIVELOCK, deterministically.
 *
 * That is why the historical "k=1-in-6" was never a lock-fight rate: it was the rate at
 * which two writes happened to OVERLAP. It is also why a statistical battery cannot tell
 * "fixed" from "more tightly bounded", and why these rows are deterministic instead.
 *
 * 🛑 The repository's OWN CONTRACT already states the rule the async path breaks: the
 * synchronous sibling `writeOwnedRecord` carries the comment "callback must not yield while
 * holding the lock". The async path yields by design. The repair is made ABOVE the outbox —
 * `brick-outbox.ts` is deliberately not touched.
 */

/**
 * Resolved into the SOURCE tree, not beside the compiled file: `build:test` compiles `.ts`
 * and does NOT copy `.mjs` fixtures into `dist-test/`. Same reason `b14-lock-proof.ts`
 * reaches for `test/fixtures/...`. From `dist-test/test/` two levels up is the repo root.
 */
const HOLDER_PATH = fileURLToPath(
  new URL("../../test/fixtures/outbox-lock-holder.mjs", import.meta.url),
);

/** A payload big enough that the holder's boundary write spans a real await window. */
function bulkMessages(count: number): SessionMessage[] {
  return Array.from({ length: count }, (_unused, index) => ({
    Agent: {
      content: [{ Text: `m${index}-${"x".repeat(200)}` }],
      tool_results: {},
    },
  })) as SessionMessage[];
}

function outboxDbPath(home: string): string {
  return path.join(home, ".acpx", "brick-outbox.db");
}

/**
 * ROW 1 — THE DISCRIMINATOR. Red on the unrepaired base, green on the repair.
 *
 * Reproduces the production path-3 shape: the parent turn's own record write is in flight
 * (the checkpoint's boundary write) when the child shadow-record write starts. Under the
 * unrepaired base this fails `outbox-busy` after the full ~4 s budget, measured 5/5 at
 * `ef794177`. Under in-process ordering the child write is queued behind the parent's and
 * both land.
 *
 * 🛑 THIS ROW IS THE FALSIFIER. It is the one instrument in this block that can tell a FIX
 * from a TIGHTENED BOUND. Do not weaken it into a retry, a timeout bump or a sampled
 * battery: a battery of any size passes on unrepaired code (the diagnosis lane measured
 * 0/22 on exactly that), which is the trap this brick exists to correct.
 */
test("path 3 · an in-process child record write does NOT contend with the parent's own write", async () => {
  await withTempHome("acpx-outbox-ordering-", async (home) => {
    const parent = makeSessionRecord({
      acpxRecordId: "ordering-parent",
      acpSessionId: "acp-ordering-parent",
      agentCommand: "agent",
      cwd: home,
      messages: bulkMessages(4000),
    });
    const child = makeSessionRecord({
      acpxRecordId: "ordering-child",
      acpSessionId: "acp-ordering-child",
      agentCommand: "agent",
      cwd: home,
      kind: "subagent",
      parentSessionId: "ordering-parent",
    });

    // NON-VACUITY. If no outbox is opened there is no lock, and this row would pass while
    // observing nothing at all — the exact way this family of row goes quietly blind.
    await writeSessionRecord(child);
    assert.ok(
      fsSync.existsSync(outboxDbPath(home)),
      "no outbox DB was created, so this row exercises no lock and proves nothing — " +
        "it is blind, not passing",
    );

    // The parent's own write is in flight when the child's starts: the production shape.
    const parentWrite = writeSessionRecordAtBoundary(parent);
    const childWrite = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await writeSessionRecord(child);
    })();

    const [parentOutcome, childOutcome] = await Promise.allSettled([parentWrite, childWrite]);

    const describe = (outcome: PromiseSettledResult<unknown>): string =>
      outcome.status === "fulfilled"
        ? "fulfilled"
        : `REJECTED ${(outcome.reason as Error & { code?: string }).code ?? ""} ` +
          (outcome.reason as Error).message;

    assert.equal(
      childOutcome.status,
      "fulfilled",
      "THE CHILD RECORD WRITE LOST A RACE WITH THE PARENT'S OWN WRITE.\n" +
        `child=${describe(childOutcome)}\n` +
        `parent=${describe(parentOutcome)}\n` +
        "🛑 This is the brick-6b1e0038 defect, NOT a flake and NOT box load. Two overlapping\n" +
        "in-process outbox writes livelock: the holder keeps the SQLite lock across an await\n" +
        "while the contender blocks the only thread with Atomics.wait, so the holder can\n" +
        "never reach COMMIT and the contender fails terminally after its full 4 s budget.\n" +
        "Fix by ORDERING or LOCKING above the outbox — never by a retry, a poll or a wider\n" +
        "budget. A wider budget only tightens the bound; this row is what tells the two apart.",
    );
    assert.equal(
      parentOutcome.status,
      "fulfilled",
      `parent write failed: ${describe(parentOutcome)}`,
    );
  });
});

/**
 * ROW 2 — THE POSITIVE CONTROL. Expected to observe `outbox-busy` on BOTH arms.
 *
 * 🔑 WHY IT EXISTS: it proves the harness can produce `outbox-busy` AT ALL. Without it, a
 * green row 1 on the repair is indistinguishable from a row 1 that was never capable of
 * going red — and that ambiguity is the single most likely way this block ships a false
 * green.
 *
 * 🛑 IT IS NOT A DISCRIMINATOR AND MUST NEVER BE READ AS ONE. The holder is a SEPARATE
 * PROCESS, and the repair is in-process ordering only (ruling: single-process scope). An
 * external holder past the 4 s budget therefore produces `outbox-busy` with or without the
 * repair. Cross-process contention is explicitly out of scope for this brick; if it ever
 * fires in production it is a different brick.
 */
test("positive control · a cross-process lock holder still forces outbox-busy (out of scope, both arms)", async () => {
  await withTempHome("acpx-outbox-control-", async (home) => {
    const record = makeSessionRecord({
      acpxRecordId: "control-record",
      acpSessionId: "acp-control",
      agentCommand: "agent",
      cwd: home,
    });
    // Create the outbox DB before the holder opens it.
    await writeSessionRecord(record);
    const dbPath = outboxDbPath(home);
    assert.ok(fsSync.existsSync(dbPath), "no outbox DB to hold — the control is blind");

    // Fail LOUDLY if the fixture moves: without this, a missing holder presents as
    // "the holder never took the lock", which reads as a lock-semantics finding.
    assert.ok(
      fsSync.existsSync(HOLDER_PATH),
      `the lock-holder fixture is missing at ${HOLDER_PATH} — the control cannot run`,
    );

    const marker = path.join(home, "holder-acted");
    const holder = fork(HOLDER_PATH, [dbPath, marker], {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const exited = new Promise((resolve) => holder.once("exit", resolve));

    try {
      const deadline = Date.now() + 5000;
      while (!fsSync.existsSync(marker) && Date.now() < deadline && holder.exitCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(
        fsSync.existsSync(marker),
        `the holder never took the lock (exitCode=${holder.exitCode}) — the control is blind`,
      );

      await assert.rejects(
        async () => await writeSessionRecord(record),
        /outbox-busy/,
        "the harness did NOT produce outbox-busy while another PROCESS provably held the " +
          "lock. The instrument is broken: any green in this file is now meaningless, " +
          "because a row that cannot go red cannot pass either.",
      );
      // The holder is still alive: the lock is never taken over, only released on commit
      // or holder death.
      assert.equal(holder.exitCode, null, "the holder died early — the control proved nothing");
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill("SIGKILL");
        await exited;
      }
    }
  });
});

/**
 * ROW 3 — THE NESTED-WRITE BYPASS IS OBSERVABLE WHEN IT FIRES.
 *
 * 🔑 WHY THIS ROW EXISTS. The re-entrancy branch in `enqueueRecordWrite` BYPASSES the
 * serialisation: a nested write runs unordered, exactly as it did before the repair. That
 * is safe only while nothing in the product nests a write. If one ever does, it would
 * silently get the old unserialised behaviour and the livelock would be back for that path
 * with nothing to say so — the same quiet-degradation shape that disqualified
 * `index-lock.ts`'s `withAdvisoryLock` (it gives up after ~2 s and proceeds UNLOCKED). The
 * counter is what converts that silent regression into a signal, and this row is what keeps
 * the counter honest.
 *
 * BOTH DIRECTIONS (programme pattern P32):
 *  - RED before the repair's observability existed: the counter does not exist, so this row
 *    cannot even resolve its import — there is nothing to observe.
 *  - GREEN with it: a write issued from inside another write increments the counter, and
 *    the outer write still completes rather than deadlocking.
 *  - WHY THE REPAIR AND NOTHING ELSE TURNS IT: the nesting is created here deliberately, by
 *    mocking the `fs.readFile` that `readPersistedLifecycle` performs INSIDE the write. No
 *    box load, no timing and no other change can make a nested write appear or disappear.
 */
test("the nested-write bypass FIRES and is observable when a write is issued inside a write", async () => {
  await withTempHome("acpx-outbox-nested-", async (home) => {
    const outer = makeSessionRecord({
      acpxRecordId: "nested-outer",
      acpSessionId: "acp-nested-outer",
      agentCommand: "agent",
      cwd: home,
    });
    const inner = makeSessionRecord({
      acpxRecordId: "nested-inner",
      acpSessionId: "acp-nested-inner",
      agentCommand: "agent",
      cwd: home,
    });

    resetPerfMetrics();
    assert.equal(reentrantWrites(), 0, "the counter did not start clean");

    // Seed BEFORE the hook exists. `readPersistedLifecycle` reads the record's own file, and
    // on a first-ever write that file is absent, so the read rejects ENOENT and the hook
    // would never arm on it.
    await writeSessionRecord(outer);
    await writeSessionRecord(inner);

    // Reproduce session-reparent.test.ts's editDuringBatch shape: mock the fs.readFile that
    // readPersistedLifecycle performs INSIDE writeSessionRecordInternal, and write from it.
    const originalReadFile = fs.readFile;
    const outerFile = `${outer.acpxRecordId}.json`;
    let nested = false;
    (fs as { readFile: unknown }).readFile = async (...args: unknown[]) => {
      const result = await (originalReadFile as (...a: unknown[]) => unknown)(...args);
      // 🛑 GATED ON THE RECORD FILE, AND THAT GATE IS LOAD-BEARING. A write also reads
      // through `updateIndexForWrittenRecord` -> the index-update QUEUE and `index-lock`,
      // and those continuations run OUTSIDE this write's async context — so a write nested
      // there is not re-entrant, enqueues normally, and would simply wait for the chain the
      // outer write still holds. That is a deadlocked TEST, not the scenario under test.
      if (!nested && String(args[0]).endsWith(outerFile)) {
        nested = true; // claim BEFORE awaiting, or the nested write re-enters this hook
        await writeSessionRecord(inner);
      }
      return result;
    };
    resetPerfMetrics();
    try {
      await writeSessionRecord(outer);
    } finally {
      (fs as { readFile: unknown }).readFile = originalReadFile;
    }

    assert.ok(nested, "the nesting hook never fired — this row is blind, not passing");
    assert.ok(
      reentrantWrites() >= 1,
      "a write issued from INSIDE another write did not increment " +
        `${REENTRANT_RECORD_WRITE_COUNTER}. The bypass is now SILENT: a future product ` +
        "path that nests a write would quietly lose write ordering and nothing would " +
        "report it.",
    );
  });
});

/**
 * ROW 4 — AND IT DOES NOT FIRE ON ORDINARY PRODUCT WRITES.
 *
 * 🔑 WHY THIS ROW EXISTS. Row 3 alone could be satisfied by a counter that increments on
 * EVERY write, which would make the signal worthless. This row pins the other half: the
 * ordinary path — including the concurrent parent/child pair that row 1 exercises — must
 * leave the counter at exactly zero.
 *
 * BOTH DIRECTIONS (P32):
 *  - RED if the bypass branch is ever taken on a normal write (the counter would be > 0),
 *    which is precisely the state "the product now nests a write" that row 3's counter
 *    exists to expose.
 *  - GREEN while every product write is top-level, as it is today.
 *  - WHY THE REPAIR AND NOTHING ELSE TURNS IT: nothing but a genuine nested write can
 *    increment this counter — it is incremented on exactly one branch.
 */
test("the nested-write bypass does NOT fire on ordinary product writes", async () => {
  await withTempHome("acpx-outbox-nonested-", async (home) => {
    const parent = makeSessionRecord({
      acpxRecordId: "plain-parent",
      acpSessionId: "acp-plain-parent",
      agentCommand: "agent",
      cwd: home,
      messages: bulkMessages(500),
    });
    const child = makeSessionRecord({
      acpxRecordId: "plain-child",
      acpSessionId: "acp-plain-child",
      agentCommand: "agent",
      cwd: home,
    });

    await writeSessionRecord(parent);
    resetPerfMetrics();

    // Sequential writes, and the concurrent overlapping pair row 1 uses — the whole
    // ordinary surface of this repair.
    await writeSessionRecord(child);
    await writeSessionRecordAtBoundary(child);
    await Promise.all([writeSessionRecordAtBoundary(parent), writeSessionRecord(child)]);

    assert.equal(
      reentrantWrites(),
      0,
      `${REENTRANT_RECORD_WRITE_COUNTER} fired on an ordinary write. Either the product ` +
        "now nests a record write (a defect — the nested path loses write ordering and is " +
        "exposed to the outbox livelock), or the counter is firing indiscriminately and is " +
        "no longer a usable signal. Both are defects; find out which.",
    );
  });
});
