// Concurrent session-record writes must not collide on their temp filename.
//
// `writeSessionRecord` writes to `<file>.<pid>.<Date.now()>.tmp` and renames it
// into place. That name is unique per *millisecond*, not per *call*, so two
// writes from this process in the same millisecond built the IDENTICAL temp
// path: the first rename won and the second hit
//   ENOENT: no such file or directory, rename '<id>.json.<pid>.<ms>.tmp' -> '<id>.json'
// which surfaces as a thrown error from an ordinary record write.
//
// This is reachable on a normal path, not just under synthetic load: the queue
// owner drains the whole `midTurnBuffer` synchronously in a for-loop
// (queue-owner-runtime.ts), so several injected prompts start in one tick and
// race each other's `recordPromptStart`. Observed at ~70% of runs while
// building the brick://9beafe1c F1 test rig, where it turned a real injected
// message into a bogus `failed` delivery terminal carrying the ENOENT text.
//
// The cure is UNIQUENESS, not serialization — the predicate is a filename
// collision, and write ordering here is deliberately unconstrained. Adding a
// mutex would put ordering constraints on a hot path to fix something that
// isn't an ordering problem.
//
// `Date.now` is frozen for the duration so "same millisecond" is deterministic
// rather than a race the test hopes to win; that is exactly the condition the
// old name could not survive.

import assert from "node:assert/strict";
import test from "node:test";
import { writeSessionRecord } from "../src/session/persistence.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

const FROZEN_NOW = 1_785_000_000_000;
const CONCURRENT_WRITES = 6;

test("concurrent session-record writes in the same millisecond all land (unique temp name)", async () => {
  await withTempHome("acpx-concurrent-record-write-home-", async (homeDir) => {
    const seed = makeSessionRecord(
      {
        acpxRecordId: "concurrent-record-write",
        acpSessionId: "concurrent-record-write-session",
        agentCommand: "node mock-agent.js",
        cwd: homeDir,
      },
      { defaultName: false },
    );
    await writeSessionRecordFile(homeDir, seed);

    const realNow = Date.now;
    Date.now = () => FROZEN_NOW;
    let settled: PromiseSettledResult<void>[];
    try {
      settled = await Promise.allSettled(
        Array.from({ length: CONCURRENT_WRITES }, (_unused, index) =>
          writeSessionRecord(
            makeSessionRecord(
              {
                acpxRecordId: "concurrent-record-write",
                acpSessionId: "concurrent-record-write-session",
                agentCommand: "node mock-agent.js",
                cwd: homeDir,
                name: `writer-${index}`,
              },
              { defaultName: false },
            ),
          ),
        ),
      );
    } finally {
      Date.now = realNow;
    }

    const failures = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => String(result.reason));
    assert.deepEqual(
      failures,
      [],
      `every concurrent write must land; a temp-name collision shows up here as an ENOENT rename`,
    );
  });
});
