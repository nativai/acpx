// brick://3356183e — the owner's count of background tasks live on its adapter. It
// gates proactive subscription selection and is printed on every turn-boundary
// recycle, so a task it misses is killed silently and a phantom it adopts defers
// selection for the owner's whole life. Every frame below is the wire shape
// claude-agent-acp actually sends (main 116f845d / dev, and Surface B cec4c064).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import { createBackgroundTaskTracker } from "../src/cli/session/background-task-tracker.js";

const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));

function toolUpdate(toolCallId: string, claudeCode: Record<string, unknown>): unknown {
  return {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "acp-1",
      update: { _meta: { claudeCode }, toolCallId, sessionUpdate: "tool_call_update" },
    },
  };
}

function bashStarted(toolCallId: string, taskId: string): unknown {
  return toolUpdate(toolCallId, {
    toolName: "Bash",
    toolResponse: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: taskId },
  });
}

function monitorStarted(toolCallId: string, taskId: string): unknown {
  return toolUpdate(toolCallId, {
    toolName: "Monitor",
    toolResponse: { taskId, timeoutMs: 300000, persistent: false },
  });
}

test("main-adapter shape: a bg Bash is live from its result until task_completed{subagentId}", () => {
  const tracker = createBackgroundTaskTracker();
  tracker.observe("inbound", bashStarted("toolu_a", "bir2wvygy"));
  assert.equal(tracker.liveCount(), 1);
  tracker.observe(
    "inbound",
    toolUpdate("toolu_a", { toolName: "Agent", status: "task_completed", subagentId: "bir2wvygy" }),
  );
  assert.equal(tracker.liveCount(), 0);
});

test("dev-adapter shape: a Monitor ends on task_stopped keyed by its toolCallId alone", () => {
  const tracker = createBackgroundTaskTracker();
  tracker.observe("inbound", monitorStarted("toolu_m", "bdg2ufdok"));
  assert.equal(tracker.liveCount(), 1);
  tracker.observe(
    "inbound",
    toolUpdate("toolu_m", { toolName: "Monitor", status: "task_stopped" }),
  );
  assert.equal(tracker.liveCount(), 0);
});

test("a background Agent is live from teammate_spawned until task_failed", () => {
  const tracker = createBackgroundTaskTracker();
  tracker.observe(
    "inbound",
    toolUpdate("toolu_g", { toolName: "Agent", status: "teammate_spawned", subagentId: "a9" }),
  );
  assert.equal(tracker.liveCount(), 1);
  tracker.observe(
    "inbound",
    toolUpdate("toolu_g", { toolName: "Agent", status: "task_failed", subagentId: "a9" }),
  );
  assert.equal(tracker.liveCount(), 0);
});

test("TaskStop and TaskOutput results name the task they ACT ON — never adopted as live", () => {
  const tracker = createBackgroundTaskTracker();
  tracker.observe(
    "inbound",
    toolUpdate("toolu_s", { toolName: "TaskStop", toolResponse: { taskId: "x1" } }),
  );
  tracker.observe(
    "inbound",
    toolUpdate("toolu_o", {
      toolName: "TaskOutput",
      toolResponse: { taskId: "x1", status: "running" },
    }),
  );
  assert.equal(tracker.liveCount(), 0);
  // Positive control on the same field: a Monitor's `.taskId` IS a start.
  tracker.observe("inbound", monitorStarted("toolu_m", "x2"));
  assert.equal(tracker.liveCount(), 1);
});

test("outbound frames and plain tool results start nothing", () => {
  const tracker = createBackgroundTaskTracker();
  tracker.observe("outbound", bashStarted("toolu_a", "t1"));
  tracker.observe(
    "inbound",
    toolUpdate("toolu_b", { toolName: "Bash", toolResponse: { stdout: "x" } }),
  );
  assert.equal(tracker.liveCount(), 0);
});

test("_claude/backgroundTasks is authoritative once seen (replace semantics, empty included)", () => {
  const tracker = createBackgroundTaskTracker();
  tracker.observe("inbound", bashStarted("toolu_a", "t1"));
  tracker.observe("inbound", bashStarted("toolu_b", "t2"));
  const forwarded = (tasks: string[]) => ({
    jsonrpc: "2.0",
    method: "_claude/backgroundTasks",
    params: {
      sessionId: "acp-1",
      at: "2026-10-10T00:00:00.000Z",
      tasks: tasks.map((taskId) => ({
        taskId,
        taskType: "local_bash",
        description: "d",
        startedAt: "x",
      })),
    },
  });
  tracker.observe("inbound", forwarded(["t1"]));
  assert.equal(tracker.liveCount(), 1, "the forwarded set replaces the derived one");
  tracker.observe("inbound", forwarded([]));
  assert.equal(tracker.liveCount(), 0);
});

test("reset forgets every task: the adapter that held them was closed", () => {
  const tracker = createBackgroundTaskTracker();
  tracker.observe("inbound", bashStarted("toolu_a", "t1"));
  tracker.reset();
  assert.equal(tracker.liveCount(), 0);
});

// The owner feeds the tracker from AcpClient.observeInbound because its event
// handlers are CLEARED between a turn and the idle drain: a completion landing in
// that window reaches no handler, and a tracker fed from handlers would hold a
// phantom live task that defers selection for the owner's whole life. Real adapter
// process (the mock), real wire; the handler capture is the negative control.
test("observeInbound sees a completion that lands while no event handler is set", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-observe-inbound-"));
  const client = new AcpClient({
    agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(MOCK_AGENT_PATH)}`,
    cwd,
    permissionMode: "approve-all",
  });
  const observed: unknown[] = [];
  const handled: unknown[] = [];
  try {
    client.observeInbound((message) => observed.push(message));
    client.setEventHandlers({ onAcpMessage: (_direction, message) => handled.push(message) });
    await client.start();
    const { sessionId } = await client.createSession(cwd);
    await client.prompt(sessionId, "bg-task 300 obs1");
    client.clearEventHandlers();
    await new Promise((resolve) => setTimeout(resolve, 900));

    const isCompletion = (message: unknown) => JSON.stringify(message).includes('"task_completed"');
    assert.equal(handled.some(isCompletion), false, "control: the cleared handler saw nothing");
    assert.equal(observed.some(isCompletion), true, "the observer saw the completion");
    const tracker = createBackgroundTaskTracker();
    for (const message of observed) {
      tracker.observe("inbound", message);
    }
    assert.equal(tracker.liveCount(), 0, "start and end both reached the tracker");
  } finally {
    await client.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
