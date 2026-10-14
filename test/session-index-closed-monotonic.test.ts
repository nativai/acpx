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
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { closeSession, reopenSession } from "../src/cli/session/session-control.js";
import { withSessionIndexLock } from "../src/session/persistence/index-lock.js";
import {
  ChildLines,
  childEnv,
  readIndexEntry,
  readRecordOnDisk,
  seedOpenSessions,
  sessionsDirOf,
} from "./index-lock-holder-helpers.js";
import { withTempHome } from "./queue-test-helpers.js";

const CHILD_PATH = fileURLToPath(new URL("./index-monotonic-child.js", import.meta.url));

function spawnChild(homeDir: string, args: string[]): ChildLines {
  return new ChildLines(
    spawn(process.execPath, [CHILD_PATH, ...args], {
      env: childEnv(homeDir),
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
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
