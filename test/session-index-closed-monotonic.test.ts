// brick 19ee17ab — the session index must never revert a closed session to open.
//
// RCA 2338b781 Path A: the per-process index queue held an entry projected BEFORE a close
// (5 s trailing timer, a lock-queue wait, a deferral) and later replaced the on-disk entry
// with it wholesale, so a close written by another process was put back to `closed:false`.
// The fix (CONCEPTION §3.1, "M2"): every flush re-projects each pending file from its record
// as it stands on disk, read INSIDE the index lock; the record's own monotonicity guard is
// then the only one and the index inherits it. Plus the bounded exit contract (§3.2b):
// a deferred write is retried once at exit and then dropped LOUDLY, never looped on forever
// and never dropped in silence.
//
// Every cross-process row runs the REAL writer in a second process
// (`index-monotonic-child.ts`) against a temp HOME; nothing here touches the real ~/.acpx.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closeSession, reopenSession } from "../src/cli/session/session-control.js";
import { withSessionIndexLock } from "../src/session/persistence/index-lock.js";
import {
  ChildLines,
  childEnv,
  holdLiveIndexLock,
  readIndexEntry,
  readRecordOnDisk,
  seedOpenSessions,
  sessionsDirOf,
} from "./index-lock-holder-helpers.js";
import "./install-owner-reaper.js";
import { withTempHome } from "./queue-test-helpers.js";

const CHILD_PATH = fileURLToPath(new URL("./index-monotonic-child.js", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// The counter's NAME is product surface — read across processes through ACPX_PERF_METRICS_FILE —
// so it is pinned here as a literal (index-update-queue.ts SESSION_INDEX_UPDATE_DEFERRED_COUNTER).
const DEFERRED_COUNTER = "session.index_update_deferred";
const DEFERRAL_WARNING = "[acpx] WARNING: session index update deferred";
const DROPPED_AT_EXIT = "[acpx] WARNING: session index update dropped at exit";

function spawnChild(homeDir: string, args: string[]): ChildLines {
  return new ChildLines(
    spawn(process.execPath, [CHILD_PATH, ...args], {
      env: childEnv(homeDir),
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function countersOf(child: ChildLines): Record<string, number> {
  const line = child.stdout.split("\n").find((entry) => entry.startsWith("COUNTERS "));
  assert.ok(line, `child printed no COUNTERS line; stdout=${child.stdout}`);
  return JSON.parse(line.slice("COUNTERS ".length)) as Record<string, number>;
}

async function mkTempHome(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** The pending child's trailing flush must not have fired before the close — else the row is vacuous. */
function assertStillPendingAt(pendingLine: string, closedAt: number): void {
  const { firstWrittenAt } = JSON.parse(pendingLine.slice("PENDING ".length)) as {
    firstWrittenAt: number;
  };
  assert.ok(
    closedAt - firstWrittenAt < 4_500,
    `the close landed ${closedAt - firstWrittenAt} ms after the child's first write — its 5 s ` +
      `trailing flush may already have run, so this run proves nothing`,
  );
}

// ---------------------------------------------------------------------------
// T1a — the RCA's R2 run, cross-process: a stale pending flush after a close.
// ---------------------------------------------------------------------------
test("T1a a pending index update flushed after another process's close leaves the index closed", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "t1a-session";
    await seedOpenSessions(homeDir, [sessionId]);
    const owner = spawnChild(homeDir, ["pending", sessionId, "7000"]);
    const pendingLine = await owner.line("PENDING ", 15_000);

    await closeSession(sessionId); // no lease → the non-self arm, immediate index write
    assertStillPendingAt(pendingLine, Date.now());
    assert.equal((await readIndexEntry(homeDir, sessionId))?.closed, true, "the close's own write");

    const exit = await owner.exited;
    assert.equal(exit.code, 0, owner.stderr);
    const record = await readRecordOnDisk(homeDir, sessionId);
    const entry = await readIndexEntry(homeDir, sessionId);
    assert.equal(record.closed, true);
    assert.equal(entry?.closed, true, "the child's trailing flush must not revert the close");
    assert.equal(entry?.lastUsedAt, record.last_used_at, "the entry is the record's projection");
  });
});

// ---------------------------------------------------------------------------
// T1b — the read happens UNDER the lock: a flush that started (and would have read the record)
// before the close, but whose write lands after it, still leaves the index closed. This row also
// fails an implementation that reads the record BEFORE taking the index lock.
// ---------------------------------------------------------------------------
test("T1b a flush queued behind the lock across a close re-projects the record under the lock", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "t1b-session";
    await seedOpenSessions(homeDir, [sessionId]);
    const goFile = path.join(homeDir, "t1b-go");
    const owner = spawnChild(homeDir, ["flush-on-go", sessionId, goFile]);
    await owner.line("PENDING ", 15_000);

    await withSessionIndexLock(sessionsDirOf(homeDir), async () => {
      await fs.writeFile(goFile, "go\n");
      await owner.line("FLUSHING", 10_000);
      // The child is now inside its flush, waiting for the lock this process holds.
      await new Promise((resolve) => setTimeout(resolve, 400));
      // The close's privileged write; its index update re-enters the lock held here.
      await closeSession(sessionId);
      assert.equal((await readIndexEntry(homeDir, sessionId))?.closed, true);
    });

    await owner.line("FLUSHED", 25_000);
    const exit = await owner.exited;
    assert.equal(exit.code, 0, owner.stderr);
    assert.equal((await readRecordOnDisk(homeDir, sessionId)).closed, true);
    assert.equal(
      (await readIndexEntry(homeDir, sessionId))?.closed,
      true,
      "a flush that waited out a close must write what the record says when it gets the lock",
    );
  });
});

// ---------------------------------------------------------------------------
// T6a — negative control: a genuine reopen still opens the index entry. Exists to fail a
// "sticky closed" implementation (never write false over true), which breaks every reopen.
// ---------------------------------------------------------------------------
test("T6a close then a genuine reopen leaves the index entry open", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "t6a-session";
    await seedOpenSessions(homeDir, [sessionId]);
    await closeSession(sessionId);
    assert.equal((await readIndexEntry(homeDir, sessionId))?.closed, true);

    const reopened = await reopenSession(sessionId);
    assert.equal(reopened.reopened, true);
    assert.equal((await readRecordOnDisk(homeDir, sessionId)).closed, false);
    assert.equal((await readIndexEntry(homeDir, sessionId))?.closed, false);
  });
});

// ---------------------------------------------------------------------------
// T6b — a reopen cycle stays monotonic: close → reopen → a process queues an (open) update →
// close again → that process's trailing flush must leave the index closed.
// ---------------------------------------------------------------------------
test("T6b after close → reopen, a stale pending update cannot undo the second close", async () => {
  await withTempHome(async (homeDir) => {
    const sessionId = "t6b-session";
    await seedOpenSessions(homeDir, [sessionId]);
    await closeSession(sessionId);
    assert.equal((await reopenSession(sessionId)).reopened, true);
    assert.equal((await readIndexEntry(homeDir, sessionId))?.closed, false);

    const owner = spawnChild(homeDir, ["pending", sessionId, "7000"]);
    const pendingLine = await owner.line("PENDING ", 15_000);
    await closeSession(sessionId);
    assertStillPendingAt(pendingLine, Date.now());

    const exit = await owner.exited;
    assert.equal(exit.code, 0, owner.stderr);
    assert.equal((await readRecordOnDisk(homeDir, sessionId)).closed, true);
    assert.equal(
      (await readIndexEntry(homeDir, sessionId))?.closed,
      true,
      "the trailing flush of an update queued after the reopen must not undo the second close",
    );
  });
});

// ---------------------------------------------------------------------------
// T4 + T5a + T5b — the deferral contract, behind a LIVE lock holder (never taken over, so every
// waiter runs the full 20 s budget). Run concurrently in separate stores so the suite pays one
// ~45 s wait (the T15 pattern). Holder FIRST: each lock file exists before the process under
// test is spawned (`holdLiveIndexLock` returns only after writing it).
// ---------------------------------------------------------------------------

/** T4 — a deferred pre-close entry, retried after the close, leaves the index closed. */
async function deferredRetryAfterClose(): Promise<void> {
  const homeDir = await mkTempHome("acpx-t4-");
  try {
    const sessionId = "t4-session";
    await seedOpenSessions(homeDir, [sessionId]);
    const lock = await holdLiveIndexLock(sessionsDirOf(homeDir));
    try {
      const owner = spawnChild(homeDir, ["defer", sessionId, "9000"]);
      const deferred = await owner.line("DEFERRED ", 30_000);
      const { blockedMs } = JSON.parse(deferred.slice("DEFERRED ".length)) as {
        blockedMs: number;
      };
      assert.ok(blockedMs >= 19_000, `the write must wait the full budget (${blockedMs} ms)`);
      // Release, then close at once: the owner's 5 s retry fires after the close lands.
      await lock.release();
      const closer = spawnChild(homeDir, ["close", sessionId]);
      assert.equal((await closer.exited).code, 0, closer.stderr);
      assert.equal((await readIndexEntry(homeDir, sessionId))?.closed, true, "the close's write");

      const exit = await owner.exited;
      assert.equal(exit.code, 0, owner.stderr);
      assert.equal((await readRecordOnDisk(homeDir, sessionId)).closed, true);
      assert.equal(
        (await readIndexEntry(homeDir, sessionId))?.closed,
        true,
        "T4: the deferred retry must not resurrect the pre-close entry",
      );
      assert.ok(owner.stderr.includes(DEFERRAL_WARNING), `T4 stderr: ${owner.stderr}`);
      assert.ok((countersOf(owner)[DEFERRED_COUNTER] ?? 0) >= 1, `T4 counter: ${owner.stdout}`);
      assert.equal(owner.stderr.includes("dropped"), false, "the retry landed; nothing dropped");
    } finally {
      await lock.release();
    }
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

/** T5a — the real `acpx sessions close` behind a wedged lock: no hang, no silence, rc 0. */
async function cliCloseBehindWedgedLock(): Promise<void> {
  const homeDir = await mkTempHome("acpx-t5a-");
  try {
    const sessionId = "t5a-session";
    await seedOpenSessions(homeDir, [sessionId]);
    const lock = await holdLiveIndexLock(sessionsDirOf(homeDir));
    try {
      const env = childEnv(homeDir);
      for (const key of Object.keys(env)) {
        // a caller identity would route the close through agent-only paths
        if (key.startsWith("ACPX_SESSION_") || key.startsWith("ACPX_PARENT_")) {
          delete env[key];
        }
      }
      const startedAt = Date.now();
      const cli = new ChildLines(
        spawn(
          process.execPath,
          [CLI_PATH, "--cwd", homeDir, "sessions", "close", "--session-id", sessionId],
          { env, stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
      const killTimer = setTimeout(() => cli.child.kill("SIGKILL"), 50_000);
      const exit = await cli.exited;
      clearTimeout(killTimer);
      const elapsedMs = Date.now() - startedAt;
      assert.ok(
        exit.signal === null && elapsedMs < 50_000,
        `T5a: the CLI must exit by itself in < 50 s behind a wedged lock (ran ${elapsedMs} ms, ` +
          `signal ${exit.signal}); stderr=${cli.stderr}`,
      );
      assert.equal(exit.code, 0, `T5a rc; stderr=${cli.stderr}`);
      assert.match(cli.stdout, /closed: true \(read back from record\)/);
      assert.ok(cli.stderr.includes(DEFERRAL_WARNING), `T5a stderr: ${cli.stderr}`);
      assert.ok(
        cli.stderr.includes(DROPPED_AT_EXIT) && cli.stderr.includes(sessionId),
        `T5a must name the dropped session: ${cli.stderr}`,
      );
      assert.equal((await readRecordOnDisk(homeDir, sessionId)).closed, true);
      // Correct, not a bug: the projection was dropped and the record is the authority.
      // acpx-ui's closed-drift reconcile heals this entry (CONCEPTION §3.3).
      assert.equal((await readIndexEntry(homeDir, sessionId))?.closed, false);
      assert.equal(
        await fs.readFile(path.join(sessionsDirOf(homeDir), "index.json.lock"), "utf8"),
        lock.body,
      );
    } finally {
      await lock.release();
    }
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

/** T5b — a deferred entry dropped by `process.exit()` is reported, synchronously. */
async function deferredDroppedByProcessExit(): Promise<void> {
  const homeDir = await mkTempHome("acpx-t5b-");
  try {
    const sessionId = "t5b-session";
    await seedOpenSessions(homeDir, [sessionId]);
    const lock = await holdLiveIndexLock(sessionsDirOf(homeDir));
    try {
      const child = spawnChild(homeDir, ["defer", sessionId, "exit"]);
      const exit = await child.exited;
      assert.equal(exit.code, 0, child.stderr);
      assert.ok(child.stdout.includes("DEFERRED "), child.stdout);
      assert.ok(
        child.stderr.includes(DROPPED_AT_EXIT) && child.stderr.includes(sessionId),
        `T5b must report the entry process.exit() dropped: ${child.stderr}`,
      );
    } finally {
      await lock.release();
    }
  } finally {
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

test("T4/T5a/T5b deferral behind a live lock holder: retried without resurrection, bounded, loud", async (t) => {
  if (process.platform !== "linux") {
    t.skip("linux identity");
    return;
  }
  const results = await Promise.allSettled([
    deferredRetryAfterClose(),
    cliCloseBehindWedgedLock(),
    deferredDroppedByProcessExit(),
  ]);
  const failures = results.flatMap((result, i) =>
    result.status === "rejected" ? [`${["T4", "T5a", "T5b"][i]}: ${String(result.reason)}`] : [],
  );
  assert.deepEqual(failures, []);
});
