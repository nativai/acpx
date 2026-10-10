// brick://3356183e — which background tasks are live on the owner's adapter.
//
// The queue owner must know this before it closes an adapter client: closing it
// kills the Claude CLI and every `run_in_background` Bash, Monitor and background
// Agent it still holds. Proactive subscription selection is deferred while the
// count is non-zero, and every turn-boundary recycle logs it.
//
// Two sources, read from the inbound ACP stream the owner already relays:
//  - `_claude/backgroundTasks` (claude-agent-acp, brick cec4c064): the live set
//    itself, REPLACE semantics. Authoritative from the first payload on.
//  - Otherwise, derived from tool updates. claude-agent-acp emits no task_started
//    line for a Bash or Monitor; the start is the tool's own result
//    (`toolResponse.backgroundTaskId` for Bash, `toolResponse.taskId` for Monitor)
//    or `teammate_spawned` for an Agent. The end is a `task_completed|failed|stopped`
//    tool_call_update keyed by `subagentId` = task id (older adapters) or by the
//    starting tool call's `toolCallId` (adapters that resolve the origin tool).

type AcpMessage = Record<string, unknown>;

type TrackedTask = { toolCallId?: string; taskId: string };

const BACKGROUND_TASKS_NOTIFICATION = "_claude/backgroundTasks";
const TERMINAL_TASK_STATUSES = new Set(["task_completed", "task_failed", "task_stopped"]);

export type BackgroundTaskTracker = {
  observe: (direction: "inbound" | "outbound", message: unknown) => void;
  liveCount: () => number;
  // The adapter that held the tasks was closed: nothing it held is live any more.
  reset: () => void;
};

function asRecord(value: unknown): AcpMessage | undefined {
  return typeof value === "object" && value !== null ? (value as AcpMessage) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ⚠️ `.taskId` ONLY FOR Monitor. TaskStop and TaskOutput results carry the
// `taskId` of the task they ACT ON (brick 4a3c6bcb); adopting it would count a
// stopped task as a new live one and defer selection for the owner's lifetime.
function startedTaskId(claudeCode: AcpMessage): string | undefined {
  const toolResponse = asRecord(claudeCode.toolResponse);
  if (!toolResponse) {
    return undefined;
  }
  const backgroundTaskId = asString(toolResponse.backgroundTaskId);
  if (backgroundTaskId) {
    return backgroundTaskId;
  }
  return claudeCode.toolName === "Monitor" ? asString(toolResponse.taskId) : undefined;
}

export function createBackgroundTaskTracker(): BackgroundTaskTracker {
  const derived = new Map<string, TrackedTask>();
  let forwarded: Set<string> | undefined;

  const end = (toolCallId: string | undefined, taskId: string | undefined): void => {
    for (const [key, task] of derived) {
      if ((toolCallId && task.toolCallId === toolCallId) || (taskId && task.taskId === taskId)) {
        derived.delete(key);
      }
    }
  };

  const observeToolCallUpdate = (update: AcpMessage): void => {
    const claudeCode = asRecord(asRecord(update._meta)?.claudeCode);
    if (!claudeCode) {
      return;
    }
    const toolCallId = asString(update.toolCallId);
    const status = asString(claudeCode.status);
    if (status && TERMINAL_TASK_STATUSES.has(status)) {
      end(toolCallId, asString(claudeCode.subagentId));
      return;
    }
    const taskId =
      status === "teammate_spawned" ? asString(claudeCode.subagentId) : startedTaskId(claudeCode);
    if (taskId) {
      derived.set(taskId, { toolCallId, taskId });
    }
  };

  const observeForwardedSet = (params: AcpMessage | undefined): void => {
    const tasks = params?.tasks;
    if (!Array.isArray(tasks)) {
      return;
    }
    forwarded = new Set(
      tasks
        .map((task) => asString(asRecord(task)?.taskId))
        .filter((id): id is string => id !== undefined),
    );
  };

  return {
    observe: (direction, message) => {
      const msg = asRecord(message);
      if (direction !== "inbound" || !msg) {
        return;
      }
      if (msg.method === BACKGROUND_TASKS_NOTIFICATION) {
        observeForwardedSet(asRecord(msg.params));
        return;
      }
      if (msg.method !== "session/update") {
        return;
      }
      const update = asRecord(asRecord(msg.params)?.update);
      if (update?.sessionUpdate === "tool_call_update") {
        observeToolCallUpdate(update);
      }
    },
    liveCount: () => (forwarded ? forwarded.size : derived.size),
    reset: () => {
      derived.clear();
      forwarded = undefined;
    },
  };
}
