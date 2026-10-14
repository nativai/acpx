// A second acpx process for the session-index `closed` monotonicity rows (brick 19ee17ab,
// test/session-index-closed-monotonic.test.ts and the T3 row in session-index-lock.test.ts).
//
// Compiled to `dist-test/test/index-monotonic-child.js` by `build:test` and spawned with HOME
// pointing at the row's temp store. It drives acpx's REAL record writer (`writeSessionRecord`,
// which enqueues the index half) and the real close, so the index update it holds is exactly
// the production one: projected from the record, then waiting (trailing timer, lock queue,
// deferral) while another process closes the session.
//
// Not a test file (no `.test.` in the name) — `node --test` never picks it up.
//
// Modes (stdout lines are the protocol the rows wait on):
//   pending <id> <aliveMs>      write the record twice → the 2nd is a pending (throttled) index
//                               update; print PENDING; stay alive aliveMs; exit naturally.
//   flush-on-go <id> <goFile>   as `pending`, then wait for goFile, print FLUSHING and flush.
//   defer <id> <aliveMs|exit>   one record write whose index half meets a live lock holder and
//                               DEFERS (~20 s); print DEFERRED; then stay alive aliveMs and exit
//                               naturally, or `process.exit(0)` at once.
//   write <id>                  one record write (membership-immediate index write); exit.
//   close <id>                  the real `closeSession` (no lease here → the non-self arm).
//                               Both print WRITING right before the write starts.
// Every mode prints `COUNTERS <json>` (perf counters) right before it ends.
import fs from "node:fs/promises";
import path from "node:path";
import { closeSession } from "../src/cli/session/session-control.js";
import { getPerfMetricsSnapshot } from "../src/perf-metrics.js";
import {
  flushPendingSessionIndexUpdates,
  parseSessionRecord,
  sessionBaseDir,
  sessionRecordFileName,
  writeSessionRecord,
} from "../src/session/persistence.js";
import type { SessionRecord } from "../src/types.js";

const [mode, sessionId, arg] = process.argv.slice(2);
if (!mode || !sessionId) {
  process.stderr.write("usage: index-monotonic-child <mode> <sessionId> [arg]\n");
  process.exit(2);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString();

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function printCounters(): void {
  say(`COUNTERS ${JSON.stringify(getPerfMetricsSnapshot().counters)}`);
}

/** The record as it stands on disk now — the shape a live owner holds in memory. */
async function loadRecord(): Promise<SessionRecord> {
  const file = path.join(sessionBaseDir(), sessionRecordFileName(sessionId));
  const record = parseSessionRecord(JSON.parse(await fs.readFile(file, "utf8")));
  if (!record) {
    throw new Error(`unparseable record ${file}`);
  }
  return record;
}

/** Two writes: the first is this process's membership-immediate one, the second goes pending. */
async function writeTwice(): Promise<void> {
  const record = await loadRecord();
  record.lastUsedAt = stamp();
  await writeSessionRecord(record);
  const firstWrittenAt = Date.now();
  await sleep(100);
  record.lastUsedAt = stamp();
  await writeSessionRecord(record);
  say(`PENDING ${JSON.stringify({ firstWrittenAt, pendingLastUsedAt: record.lastUsedAt })}`);
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.stat(file);
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`go-file ${file} never arrived`);
      }
      await sleep(10);
    }
  }
}

async function run(): Promise<void> {
  switch (mode) {
    case "pending":
      await writeTwice();
      await sleep(Number(arg ?? 8_000));
      break;
    case "flush-on-go":
      await writeTwice();
      await waitForFile(arg, 30_000);
      say("FLUSHING");
      await flushPendingSessionIndexUpdates(sessionBaseDir());
      say("FLUSHED");
      break;
    case "defer": {
      const record = await loadRecord();
      record.lastUsedAt = stamp();
      const startedAt = Date.now();
      await writeSessionRecord(record);
      say(`DEFERRED ${JSON.stringify({ blockedMs: Date.now() - startedAt })}`);
      if (arg === "exit") {
        printCounters();
        process.exit(0);
      }
      await sleep(Number(arg ?? 8_000));
      break;
    }
    case "write": {
      const record = await loadRecord();
      record.lastUsedAt = stamp();
      say("WRITING");
      await writeSessionRecord(record);
      break;
    }
    case "close": {
      say("WRITING");
      const result = await closeSession(sessionId);
      say(`CLOSED ${JSON.stringify({ closed: result.record.closed })}`);
      break;
    }
    default:
      throw new Error(`unknown mode ${mode}`);
  }
  printCounters();
}

await run();
