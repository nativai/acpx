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
  SUBAGENT_RECORD_SAVE_INTERVAL_MS,
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

// ─── Runtime wiring: task_completed flushes the child's coalesced save ───────
//
// Driven through runQueuedTask → runSessionPrompt's REAL onSessionUpdate and
// onAcpMessage handlers with a minimal AcpClient mock (the convention
// seat-creation-paths.test.ts uses for this handler chain). The real tailer
// reads a real JSONL file, so the child's save is genuinely coalesced behind
// the production interval when task_completed arrives.

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

test("runtime: task_completed persists the child's final state without waiting out the interval", async () => {
  await withTempHomeFixture("acpx-subagent-coalesce-", async (homeDir) => {
    const cwd = path.join(homeDir, "workspace");
    await fs.mkdir(cwd, { recursive: true });
    const claudeConfigDir = path.join(homeDir, "claude-config");
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    try {
      const parent = makeSessionRecord({
        acpxRecordId: "parent-session",
        acpSessionId: "parent-session-acp",
        agentCommand: "node mock-agent.js",
        cwd,
      });
      await writeSessionRecordFile(homeDir, parent);

      const observed: {
        childId?: string;
        messagesBeforeCompletion?: number;
        msFromTranscriptToDisk?: number;
      } = {};
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
          const sessionsDir = path.join(homeDir, ".acpx", "sessions");
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
          const transcriptWrittenAt = performance.now();
          await fs.writeFile(
            path.join(dir, "agent-worker-1.jsonl"),
            lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
          );
          // Two tailer polls: the batch is read and its save enqueued, then held
          // by the interval.
          await sleep(700);
          observed.messagesBeforeCompletion = (await resolveSessionRecord(childId)).messages.length;

          handlers.onAcpMessage?.("inbound", taskCompleted("parent-session-acp", "worker-1"));
          const landed = await waitFor(async () => {
            const child = await resolveSessionRecord(childId);
            return child.messages.length > 0 ? performance.now() : undefined;
          }, 4_000);
          if (landed !== undefined) {
            observed.msFromTranscriptToDisk = landed - transcriptWrittenAt;
          }
          return { stopReason: "end_turn" as const };
        },
      } as unknown as AcpClient;

      const task: QueueTask = {
        requestId: "req-1",
        message: "spawn a subagent",
        prompt: textPrompt("spawn a subagent"),
        permissionMode: "approve-all",
        timeoutMs: 20_000,
        waitForCompletion: true,
        enqueuedAt: Date.now(),
        send: () => {},
        close: () => {},
      };
      await runQueuedTask("parent-session", task, {
        sharedClient: client,
        suppressSdkConsoleErrors: true,
      });

      assert.ok(observed.childId, "no sub-agent shadow record reached disk");
      // Positive control for the timing below: the batch was coalesced, not
      // saved per batch as before.
      assert.equal(
        observed.messagesBeforeCompletion,
        0,
        "the tailer's batch reached disk before the interval — saves are not coalesced",
      );
      // The save is held for the interval from its FIRST enqueue, which is no
      // earlier than the transcript write. Landing sooner than that can only be
      // the completion flush.
      assert.ok(
        observed.msFromTranscriptToDisk !== undefined &&
          observed.msFromTranscriptToDisk < SUBAGENT_RECORD_SAVE_INTERVAL_MS,
        `final state reached disk ${String(observed.msFromTranscriptToDisk?.toFixed(0))} ms after the ` +
          `transcript write; the interval is ${SUBAGENT_RECORD_SAVE_INTERVAL_MS} ms, so completion did not flush`,
      );
      const finalChild = await resolveSessionRecord(observed.childId);
      assert.equal(finalChild.messages.length, 2);
    } finally {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      }
    }
  });
});
