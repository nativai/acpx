// P1 (brick e9f71106, ruling row (c)): a Pi fork whose source lives in a pod on ANOTHER machine. That
// machine's writes can reach this one's NFS client late, so the source's messages log can read SHORTER than
// the record's `messages_log.bytes`. `readMessagesLogEntries` clamps to the file, so before P1 every fork
// path inherited the short read in silence. These rows drive the two in-process entry points every Pi fork
// path goes through (`readFullSourceHistory`: copy-all, the create-time cut pin, the template wake;
// `resolveLogIndexForkWindow`: `--at-log-index` and the sleeping first wake `forkCutForSleepingSession`).

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  FORK_CUT_MOVED,
  FORK_SOURCE_SHORT_READ,
  ForkCutMovedError,
  ForkSourceShortReadError,
  readFullSourceHistory,
  resolveLogIndexForkWindow,
} from "../src/cli/session/fork-at-log-index.js";
import type { SessionMessage, SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

const PI = "node /nonexistent/pi-acp/dist/index.js";

function entry(position: number): SessionMessage {
  return position % 2 === 0
    ? { User: { id: `u-${position}`, content: [{ Text: `prompt ${position}` }] } }
    : { Agent: { content: [{ Text: `reply ${position}` }], tool_results: {} } };
}

/** The fingerprint `--expect-entry` carries for the entry at absolute position `position`. */
function fingerprint(position: number): string {
  const value = entry(position);
  return typeof value === "object" && "User" in value
    ? `user:${value.User.id}`
    : `agent:${createHash("sha1").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

/** A Pi source with `count` logged entries; the record counts every byte of them. */
async function piSource(home: string, id: string, count: number): Promise<SessionRecord> {
  const dir = path.join(home, ".acpx", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const payload = Array.from({ length: count }, (_, i) => `${JSON.stringify(entry(i))}\n`).join("");
  await fs.writeFile(path.join(dir, `${id}.messages.ndjson`), payload, "utf8");
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand: PI,
    cwd: home,
  });
  record.messagesLog = { v: 1, count, base_index: 0, bytes: Buffer.byteLength(payload) };
  return record;
}

/** What another machine's stale client cache shows: the first `keep` lines only. */
async function readsShort(home: string, id: string, keep: number): Promise<void> {
  const file = path.join(home, ".acpx", "sessions", `${id}.messages.ndjson`);
  const kept = (await fs.readFile(file, "utf8")).split("\n").slice(0, keep);
  await fs.writeFile(file, `${kept.join("\n")}\n`, "utf8");
}

test("P1 (c) positive control: a source read in full forks at a completed turn with exactly the kept entries", async () => {
  await withTempHome("acpx-p1c-ok-", async (home) => {
    const source = await piSource(home, "p1c-ok", 10);
    assert.equal((await readFullSourceHistory(source)).messages.length, 10);
    const window = await resolveLogIndexForkWindow({
      source,
      agentCommand: PI,
      atLogIndex: 6,
      expectEntry: fingerprint(5),
    });
    assert.equal(window.logIndex, 6);
    assert.equal(window.history.before.length, 6);
  });
});

test("P1 (c): a source log shorter than its record is refused FORK_SOURCE_SHORT_READ — whole history and every cut", async () => {
  await withTempHome("acpx-p1c-short-", async (home) => {
    const source = await piSource(home, "p1c-short", 10);
    await readsShort(home, "p1c-short", 7);
    const isShortRead = (error: unknown) => {
      assert.ok(error instanceof ForkSourceShortReadError, String(error));
      assert.equal(error.detailCode, FORK_SOURCE_SHORT_READ);
      const line = JSON.parse(error.stderrLine) as Record<string, unknown>;
      assert.equal(line.session, "p1c-short");
      assert.ok(Number(line.file_bytes) < Number(line.recorded_bytes));
      return true;
    };
    await assert.rejects(readFullSourceHistory(source), isShortRead);
    // A cut INSIDE the short read: its entry still matches, so only the size check can refuse it.
    await assert.rejects(
      resolveLogIndexForkWindow({
        source,
        agentCommand: PI,
        atLogIndex: 4,
        expectEntry: fingerprint(3),
      }),
      isShortRead,
    );
    // A cut past it (the turn the other machine has written and this one cannot see yet).
    await assert.rejects(
      resolveLogIndexForkWindow({
        source,
        agentCommand: PI,
        atLogIndex: 10,
        expectEntry: fingerprint(9),
      }),
      isShortRead,
    );
  });
});

test("P1 (c): a source whose log is GONE while the record counts bytes is refused, not forked as empty", async () => {
  await withTempHome("acpx-p1c-gone-", async (home) => {
    const source = await piSource(home, "p1c-gone", 4);
    await fs.rm(path.join(home, ".acpx", "sessions", "p1c-gone.messages.ndjson"));
    await assert.rejects(readFullSourceHistory(source), ForkSourceShortReadError);
  });
});

test("P1 (c): a cut whose entry differs from the expected one is refused FORK_CUT_MOVED", async () => {
  await withTempHome("acpx-p1c-moved-", async (home) => {
    const source = await piSource(home, "p1c-moved", 10);
    await assert.rejects(
      resolveLogIndexForkWindow({
        source,
        agentCommand: PI,
        atLogIndex: 6,
        expectEntry: "user:u-2",
      }),
      (error: unknown) => error instanceof ForkCutMovedError && error.detailCode === FORK_CUT_MOVED,
    );
  });
});
