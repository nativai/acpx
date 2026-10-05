/**
 * Sub-agent shadow-record saves are coalesced (brick://5e7c2a85).
 *
 * The transcript tailer hands the runtime a batch every 300 ms per child, and
 * every batch used to be one FULL record save. With 7 children that held the
 * brick-outbox write lock 58–61 % of the time on the production volume. The
 * writer now keeps at most one save in flight and one pending per child, saves
 * the newest state at most once per interval, and flushes on demand.
 *
 * Each guarantee below has a row that goes red if it breaks:
 *   (a) N rapid updates cost ≤ ceil(window / interval) + 1 saves, and the
 *       last state is the one on "disk";
 *   (b) a completion flush saves at once — unit row here, and the runtime
 *       wiring (task_completed → flush) in the last row, through the real
 *       `runQueuedTask` handler chain;
 *   (c) a slow save never overwrites a newer state, and saves never overlap;
 *   (d) a shutdown flush with a save in flight AND one pending waits for both
 *       and lands the newest state.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { AcpClient } from "../src/acp/client.js";
import type { QueueTask } from "../src/cli/queue/ipc.js";
import { runQueuedTask } from "../src/cli/session/runtime.js";
import {
  createSubagentBoundaryWriteEnqueuer,
  setSubagentRecordSaveIntervalForTests,
} from "../src/cli/session/subagent-boundary-write.js";
import { transcriptCwdHash } from "../src/config/subscription-transcript.js";
import { textPrompt } from "../src/prompt-content.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import type { AcpJsonRpcMessage, SessionNotification, SessionRecord } from "../src/types.js";
import {
  makeSessionRecord,
  withTempHome as withTempHomeFixture,
  writeSessionRecordFile,
} from "./runtime-test-helpers.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A snapshot carrying its version, so the "disk" can say which state it holds. */
function snapshot(version: number, id = "child"): SessionRecord {
  return { acpxRecordId: id, lastSeq: version } as unknown as SessionRecord;
}

function fakeDisk(writeMs: (version: number) => number) {
  // Tracks the "child" record; other ids land in `others`.
  const disk = {
    version: -1,
    writes: [] as number[],
    overlaps: 0,
    active: 0,
    others: new Map<string, number>(),
  };
  const write = async (record: SessionRecord): Promise<void> => {
    const version = record.lastSeq;
    if (record.acpxRecordId !== "child") {
      disk.others.set(record.acpxRecordId, version);
      return;
    }
    disk.active += 1;
    if (disk.active > 1) {
      disk.overlaps += 1;
    }
    await sleep(writeMs(version));
    disk.version = version;
    disk.writes.push(version);
    disk.active -= 1;
  };
  return { disk, write };
}

test("(a) N rapid updates coalesce to ≤ ceil(window/interval)+1 saves, final state on disk", async () => {
  const intervalMs = 50;
  const { disk, write } = fakeDisk(() => 2);
  const writer = createSubagentBoundaryWriteEnqueuer({ write, onWriteError: () => {}, intervalMs });

  const updates = 100;
  const started = performance.now();
  for (let version = 0; version < updates; version += 1) {
    void writer.enqueue("child", snapshot(version)).catch(() => {});
    await sleep(5);
  }
  const windowMs = performance.now() - started;
  await writer.flush();

  const bound = Math.ceil(windowMs / intervalMs) + 1;
  assert.ok(
    disk.writes.length <= bound,
    `${disk.writes.length} saves for ${updates} updates over ${windowMs.toFixed(0)} ms; bound ${bound}`,
  );
  assert.equal(disk.version, updates - 1, "the last state enqueued must be the one on disk");
  assert.equal(writer.pendingCount(), 0);
});

test("(b) a flush saves the pending state at once, not after the interval", async () => {
  const { disk, write } = fakeDisk(() => 1);
  const writer = createSubagentBoundaryWriteEnqueuer({
    write,
    onWriteError: () => {},
    intervalMs: 60_000,
  });

  void writer.enqueue("child", snapshot(1)).catch(() => {});
  const started = performance.now();
  const outcome = await Promise.race([
    writer.flush("child").then(() => "flushed"),
    sleep(2_000).then(() => "still waiting on the interval"),
  ]);

  assert.equal(outcome, "flushed");
  assert.equal(disk.version, 1);
  assert.ok(performance.now() - started < 2_000);
});

test("(c) a slow save never overwrites a newer state, and saves never overlap", async () => {
  // Version 0's save is slow; everything enqueued meanwhile must land after it.
  const { disk, write } = fakeDisk((version) => (version === 0 ? 80 : 1));
  const writer = createSubagentBoundaryWriteEnqueuer({
    write,
    onWriteError: () => {},
    intervalMs: 5,
  });

  void writer.enqueue("child", snapshot(0)).catch(() => {});
  await sleep(20); // version 0 is now in flight
  for (let version = 1; version <= 5; version += 1) {
    void writer.enqueue("child", snapshot(version)).catch(() => {});
    await sleep(3);
  }
  await writer.flush();

  assert.equal(disk.overlaps, 0, "two saves for one child ran at once");
  const sorted = disk.writes.toSorted((a, b) => a - b);
  assert.deepEqual(disk.writes, sorted, `saves landed out of order: ${disk.writes.join(",")}`);
  assert.equal(disk.version, 5);
  // Five updates during one slow save coalesce into ONE follow-up save.
  assert.deepEqual(disk.writes, [0, 5]);
});

test("(d) a shutdown flush waits for the save in flight and the pending one, newest last", async () => {
  const { disk, write } = fakeDisk((version) => (version === 0 ? 50 : 1));
  const writer = createSubagentBoundaryWriteEnqueuer({
    write,
    onWriteError: () => {},
    intervalMs: 60_000,
  });

  void writer.enqueue("child", snapshot(0)).catch(() => {});
  void writer.flush("child"); // version 0 starts now
  await sleep(10);
  void writer.enqueue("child", snapshot(1)).catch(() => {}); // pending behind it
  void writer.enqueue("other-child", snapshot(7, "other-child")).catch(() => {});

  const outcome = await Promise.race([
    writer.flush().then(() => "flushed"),
    sleep(2_000).then(() => "still waiting on the interval"),
  ]);

  assert.equal(outcome, "flushed");
  assert.deepEqual(disk.writes, [0, 1]);
  assert.equal(disk.others.get("other-child"), 7);
  assert.equal(writer.pendingCount(), 0);
});

test("a throwing onWriteError does not stop the child's later saves", async () => {
  let call = 0;
  const saved: number[] = [];
  const writer = createSubagentBoundaryWriteEnqueuer({
    write: async (record) => {
      call += 1;
      if (call === 1) {
        throw new Error("outbox-busy");
      }
      saved.push(record.lastSeq);
    },
    onWriteError: () => {
      throw new Error("reporter broke");
    },
    intervalMs: 60_000,
  });

  await writer.enqueue("child", snapshot(1)).catch(() => {});
  void writer.flush("child");
  await sleep(10);
  void writer.enqueue("child", snapshot(2)).catch(() => {});
  const outcome = await Promise.race([
    writer.flush("child").then(() => "flushed"),
    sleep(2_000).then(() => "stuck"),
  ]);

  assert.equal(outcome, "flushed");
  assert.deepEqual(saved, [2]);
});

// ─── Runtime wiring: completion and turn end flush the coalesced save ───────
//
// Driven through runQueuedTask → runSessionPrompt's REAL onSessionUpdate and
// onAcpMessage handlers with a minimal AcpClient mock (the convention
// seat-creation-paths.test.ts uses for this handler chain). The real tailer
// reads a real JSONL file, so the child's save is genuinely held behind the
// production interval when the flush is due.

function teammateSpawned(sessionId: string, subagentId: string): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      _meta: { claudeCode: { status: "teammate_spawned", subagentId, subagentName: "worker" } },
    },
  } as unknown as SessionNotification;
}

function taskCompleted(sessionId: string, subagentId: string): AcpJsonRpcMessage {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      _meta: { claudeCode: { subagentId, status: "task_completed" } },
      update: { sessionUpdate: "tool_call_update", toolCallId: "t1" },
    },
  } as unknown as AcpJsonRpcMessage;
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) {
      return value;
    }
    await sleep(25);
  }
  return undefined;
}

interface SubagentTurn {
  childId?: string;
  childFile?: string;
  messagesBeforeFlush?: number;
  mtimeBeforeFlush?: number;
  /** The child's state was on disk while the turn was still running. */
  landedInsideTurn?: boolean;
}

/**
 * One parent turn that spawns a child, feeds its transcript, waits until the
 * tailer's batch is enqueued (and held by the interval), then either completes
 * the child or simply ends the turn.
 *
 * `intervalMs` is the runtime's coalescing interval for this turn. The rows
 * set it so that the timer CANNOT be what lands the state they observe, which
 * makes them structural rather than wall-clock bounds. A wall-clock bound red
 * at box load 65 (integration suite, 2026-10-05): one save alone took > 2 s
 * there, behind the per-record lock.
 */
async function runSubagentTurn(
  homeDir: string,
  mode: "complete" | "end-turn" | "watch-without-completion",
  intervalMs: number,
): Promise<SubagentTurn> {
  const cwd = path.join(homeDir, "workspace");
  await fs.mkdir(cwd, { recursive: true });
  const claudeConfigDir = path.join(homeDir, "claude-config");
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  setSubagentRecordSaveIntervalForTests(intervalMs);
  try {
    const parent = makeSessionRecord({
      acpxRecordId: "parent-session",
      acpSessionId: "parent-session-acp",
      agentCommand: "node mock-agent.js",
      cwd,
    });
    await writeSessionRecordFile(homeDir, parent);
    const sessionsDir = path.join(homeDir, ".acpx", "sessions");

    const observed: SubagentTurn = {};
    let handlers: {
      onSessionUpdate?: (n: SessionNotification) => void;
      onAcpMessage?: (direction: "outbound" | "inbound", m: AcpJsonRpcMessage) => void;
    } = {};
    const client = {
      hasReusableSession: () => true,
      supportsLoadSession: () => false,
      supportsResumeSession: () => false,
      start: async () => {},
      getAgentLifecycleSnapshot: () => ({ running: true }),
      getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
      initializeResult: undefined,
      updateRuntimeOptions: () => {},
      setEventHandlers: (h: typeof handlers) => {
        handlers = h;
      },
      clearEventHandlers: () => {},
      hasActivePrompt: () => false,
      requestCancelActivePrompt: async () => false,
      cancelActivePrompt: async () => {},
      setSessionMode: async () => {},
      setSessionModel: async () => {},
      setSessionConfigOption: async () => ({ configOptions: [] }),
      close: async () => {},
      waitForSessionUpdatesIdle: async () => {},
      getEffectiveAccountMetadata: () => undefined,
      prompt: async () => {
        handlers.onSessionUpdate?.(teammateSpawned("parent-session-acp", "worker-1"));
        // The child id is minted internally; find its shadow record on disk.
        const childId = await waitFor(async () => {
          for (const name of await fs.readdir(sessionsDir)) {
            if (!name.endsWith(".json") || name === "index.json") {
              continue;
            }
            const raw = await fs.readFile(path.join(sessionsDir, name), "utf8");
            if (raw.includes('"kind":"subagent"') || raw.includes('"kind": "subagent"')) {
              return name.slice(0, -".json".length);
            }
          }
          return undefined;
        }, 5_000);
        observed.childId = childId;
        if (!childId) {
          return { stopReason: "end_turn" as const };
        }
        observed.childFile = path.join(sessionsDir, `${childId}.json`);
        const dir = path.join(
          claudeConfigDir,
          "projects",
          transcriptCwdHash(cwd),
          "parent-session-acp",
          "subagents",
        );
        await fs.mkdir(dir, { recursive: true });
        const lines = [
          { type: "user", message: { role: "user", content: "do the thing" } },
          { type: "assistant", message: { role: "assistant", content: "done" } },
        ];
        await fs.writeFile(
          path.join(dir, "agent-worker-1.jsonl"),
          lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
        );
        // Two tailer polls: the batch is read and its save enqueued, then held
        // by the interval.
        await sleep(700);
        observed.messagesBeforeFlush = (await resolveSessionRecord(childId)).messages.length;
        observed.mtimeBeforeFlush = (await fs.stat(observed.childFile)).mtimeMs;

        if (mode === "watch-without-completion") {
          // Same in-turn watch, no task_completed: nothing may land the state.
          const landed = await waitFor(async () => {
            const child = await resolveSessionRecord(childId);
            return child.messages.length > 0 ? true : undefined;
          }, 3_000);
          observed.landedInsideTurn = landed === true;
        }
        if (mode === "complete") {
          handlers.onAcpMessage?.("inbound", taskCompleted("parent-session-acp", "worker-1"));
          // Generous: this bounds only how long a slow box may take to write,
          // never what is being proven — that is "before the turn returned".
          const landed = await waitFor(async () => {
            const child = await resolveSessionRecord(childId);
            return child.messages.length > 0 ? true : undefined;
          }, 30_000);
          observed.landedInsideTurn = landed === true;
        }
        return { stopReason: "end_turn" as const };
      },
    } as unknown as AcpClient;

    const task: QueueTask = {
      requestId: "req-1",
      message: "spawn a subagent",
      prompt: textPrompt("spawn a subagent"),
      permissionMode: "approve-all",
      timeoutMs: 60_000,
      waitForCompletion: true,
      enqueuedAt: Date.now(),
      send: () => {},
      close: () => {},
    };
    await runQueuedTask("parent-session", task, {
      sharedClient: client,
      suppressSdkConsoleErrors: true,
    });
    return observed;
  } finally {
    setSubagentRecordSaveIntervalForTests(undefined);
    if (originalClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    }
  }
}

// Far beyond anything the completion row waits: the timer can never land it.
const COMPLETION_ROW_INTERVAL_MS = 600_000;
// Long enough that a leaked timer cannot fire before the turn returns, short
// enough to wait out afterwards.
const TURN_END_ROW_INTERVAL_MS = 5_000;

test("runtime: task_completed persists the child's final state without waiting out the interval", async () => {
  await withTempHomeFixture("acpx-subagent-coalesce-", async (homeDir) => {
    const observed = await runSubagentTurn(homeDir, "complete", COMPLETION_ROW_INTERVAL_MS);

    assert.ok(observed.childId, "no sub-agent shadow record reached disk");
    // Control: the tailer's batch is held, not saved per batch. A per-batch
    // save path would land it whatever the interval is.
    assert.equal(
      observed.messagesBeforeFlush,
      0,
      "the tailer's batch reached disk before any flush — saves are not coalesced",
    );
    // Observed INSIDE the turn (turn end has not flushed yet), with the timer
    // ten minutes away: only the completion flush can have landed it (the
    // negative row below shows nothing else does).
    assert.equal(
      observed.landedInsideTurn,
      true,
      "the child's final state did not reach disk after task_completed while the turn was " +
        "still running — completion did not flush",
    );
    const finalChild = await resolveSessionRecord(observed.childId);
    assert.equal(finalChild.messages.length, 2);
  });
});

test("runtime (negative control): without task_completed, nothing lands the state inside the turn", async () => {
  await withTempHomeFixture("acpx-subagent-coalesce-", async (homeDir) => {
    const observed = await runSubagentTurn(
      homeDir,
      "watch-without-completion",
      COMPLETION_ROW_INTERVAL_MS,
    );

    assert.ok(observed.childId, "no sub-agent shadow record reached disk");
    // The completion row's "landed inside the turn" can therefore only mean the
    // completion flush — not the event stream, the writer, or anything else.
    assert.equal(observed.landedInsideTurn, false, "the state landed inside the turn unflushed");
    // And turn end still lands it.
    assert.equal((await resolveSessionRecord(observed.childId)).messages.length, 2);
  });
});

test("runtime: turn end flushes a pending child save, and no save outlives the turn", async () => {
  await withTempHomeFixture("acpx-subagent-coalesce-", async (homeDir) => {
    const observed = await runSubagentTurn(homeDir, "end-turn", TURN_END_ROW_INTERVAL_MS);

    assert.ok(observed.childId && observed.childFile, "no sub-agent shadow record reached disk");
    assert.equal(observed.messagesBeforeFlush, 0, "the batch was not held by the interval");
    const finalChild = await resolveSessionRecord(observed.childId);
    assert.equal(finalChild.messages.length, 2, "the child's final state is not on disk");

    // The instrument sees a save: the record file changed across the turn end.
    const mtimeAtReturn = (await fs.stat(observed.childFile)).mtimeMs;
    assert.notEqual(mtimeAtReturn, observed.mtimeBeforeFlush, "no save at turn end was observed");
    // The pending save was FLUSHED, not left to its timer: nothing rewrites
    // the record after the turn has returned. (The event writer's close also
    // saves the record at turn end, so the state check above alone cannot tell
    // a flush from a leaked timer; this one can.)
    await sleep(TURN_END_ROW_INTERVAL_MS + 1_000);
    assert.equal(
      (await fs.stat(observed.childFile)).mtimeMs,
      mtimeAtReturn,
      "the child's record was rewritten after the turn ended — a coalesced save outlived it",
    );
  });
});
