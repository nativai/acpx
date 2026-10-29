import {
  formatSurvivors,
  publicReap,
  type ReapReport,
  type ReapSummary,
} from "../process-tree-reap.js";
import type { SessionRecord } from "../types.js";
import type { OutputFormat } from "../types.js";
import { emitJsonResult } from "./output/json-output.js";
import type { BackgroundTasksQuery } from "./queue/ipc.js";
import type { LiveBackgroundTask } from "./session/background-task-tracker.js";

/**
 * brick ad6ba1c2 (Contract C2/C3) — `sessions close` and `sessions template` refuse a session whose
 * live owner reports live background tasks, unless the caller passed `--kill-background-tasks`.
 *
 * The gate lives in the HANDLERS, never in `closeSession()`: acpx's own internal closes stay
 * ungated (and are always reaped). It fails OPEN — an owner that cannot be asked (none, old,
 * foreign, wedged, slower than 2 s) is no refusal, and the reap still runs.
 */
export const LIVE_BACKGROUND_TASKS_EXIT_CODE = 7;
export const LIVE_BACKGROUND_TASKS_CODE = "LIVE_BACKGROUND_TASKS";
export const KILL_BACKGROUND_TASKS_FLAG = "--kill-background-tasks";

export type BackgroundTaskGateVerb = "close" | "template";

export type BackgroundTasksGate = {
  queried: boolean;
  /** Live when the close began; [] when none, or when the owner could not be asked. */
  tasks: LiveBackgroundTask[];
  /** true iff tasks were live AND the caller passed the flag. */
  killed: boolean;
};

export type LiveBackgroundTasksRefusal = {
  verb: BackgroundTaskGateVerb;
  sessionId: string;
  tasks: LiveBackgroundTask[];
  retryCommand: string;
};

export type BackgroundTasksJson = {
  queried: boolean;
  killed: boolean;
  tasks: Array<LiveBackgroundTask & { outcome: "ended" | "unverified" }>;
  reap: ReapSummary;
};

/**
 * ⚠️ THE RETRY COMMAND MUST DO THE RIGHT THING WHEN RUN LITERALLY, AND REPRODUCE THE CALLER'S
 * INTENT (HoD ruling 2026-10-29, amending the Contract's template example). It is the caller's own
 * command plus `--kill-background-tasks`:
 *   - `--session-id <the resolved acpxRecordId>` — never the caller's `--seat` or a name, which could
 *     resolve to another session by the time it runs;
 *   - the agent token only if the caller gave one, and no `--format`;
 *   - EVERY option the caller gave the verb (`retryArgs`, from {@link closeRetryArgs} /
 *     {@link templateRetryArgs}), shell-quoted — a retry that dropped `--slug` or `--auto-prompt`
 *     would mark a DIFFERENT template.
 * `test/background-task-close-gate.test.ts` EXECUTES it through a shell.
 */
export function backgroundTaskRetryCommand(
  verb: BackgroundTaskGateVerb,
  acpxRecordId: string,
  explicitAgentName: string | undefined,
  retryArgs: readonly string[] = [],
): string {
  const agent = explicitAgentName ? [explicitAgentName] : [];
  const target =
    verb === "close" ? ["close", "--session-id", acpxRecordId] : ["template", acpxRecordId];
  return ["acpx", ...agent, "sessions", ...target, ...retryArgs, KILL_BACKGROUND_TASKS_FLAG]
    .map(shellQuote)
    .join(" ");
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quoting for anything that is not plainly safe (`''` for the empty string). */
export function shellQuote(arg: string): string {
  return SHELL_SAFE.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

/** The `sessions close` options the caller gave, as argv (Commander's `--no-drain` is `drain:false`). */
export function closeRetryArgs(flags: {
  drain?: boolean;
  drainTimeout?: number;
  failOnUndelivered?: boolean;
}): string[] {
  return [
    ...(flags.drain === false ? ["--no-drain"] : []),
    ...(flags.drainTimeout !== undefined ? ["--drain-timeout", String(flags.drainTimeout)] : []),
    ...(flags.failOnUndelivered ? ["--fail-on-undelivered"] : []),
  ];
}

/** The `sessions template` options the caller gave, as argv. `--auto-prompt ""` (clear) is kept. */
export function templateRetryArgs(flags: {
  enable?: boolean;
  slug?: string;
  autoPrompt?: string;
}): string[] {
  return [
    ...(flags.enable ? ["--enable"] : []),
    ...(flags.slug !== undefined ? ["--slug", flags.slug] : []),
    ...(flags.autoPrompt !== undefined ? ["--auto-prompt", flags.autoPrompt] : []),
  ];
}

/** `7m24s`, `1m03s`, `0m09s` — the owner log's age format. */
export function formatTaskAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function taskLabel(task: LiveBackgroundTask): string {
  const tool = task.toolName ?? task.taskType;
  return task.description ? `${tool} "${task.description}"` : tool;
}

/** `Monitor "sleep watcher" (task b1gq8csg3, running 7m24s)` — description and age when known. */
export function formatTaskLine(task: LiveBackgroundTask, nowMs: number): string {
  const startedAt = task.startedAt ? Date.parse(task.startedAt) : Number.NaN;
  const age = Number.isFinite(startedAt) ? `, running ${formatTaskAge(nowMs - startedAt)}` : "";
  return `${taskLabel(task)} (task ${task.taskId}${age})`;
}

function countPhrase(count: number): string {
  return count === 1 ? "1 live background task" : `${count} live background tasks`;
}

function refusalClause(verb: BackgroundTaskGateVerb): { would: string; anyway: string } {
  return verb === "close"
    ? { would: "that closing it would kill", anyway: "to close it anyway and kill them" }
    : {
        would: "that marking it as a template would kill (marking it as a template closes it)",
        anyway: "to mark it as a template anyway and kill them",
      };
}

export function liveBackgroundTasksErrorMessage(refusal: LiveBackgroundTasksRefusal): string {
  const { would, anyway } = refusalClause(refusal.verb);
  const list = refusal.tasks.map((task) => `${taskLabel(task)} (task ${task.taskId})`).join(", ");
  return (
    `refused: session ${refusal.sessionId} has ${countPhrase(refusal.tasks.length)} ${would}: ` +
    `${list}. Re-run with ${KILL_BACKGROUND_TASKS_FLAG} ${anyway}.`
  );
}

export function liveBackgroundTasksRefusalText(
  refusal: LiveBackgroundTasksRefusal,
  nowMs: number,
): string {
  const { would } = refusalClause(refusal.verb);
  const doing = refusal.verb === "close" ? "close it" : "mark it as a template";
  const lines = [
    `sessions ${refusal.verb}: ${LIVE_BACKGROUND_TASKS_CODE}: refused: session ${refusal.sessionId} has ${countPhrase(refusal.tasks.length)} ${would}:`,
    ...refusal.tasks.map((task) => `  - ${formatTaskLine(task, nowMs)}`),
    `Nothing was closed or stopped. To ${doing} anyway and kill these tasks, run:`,
    `  ${refusal.retryCommand}`,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Asks the owner, decides. A refusal touches nothing: no drain, no `close_session`, no signal, no
 * record write — the caller returns right after emitting it.
 */
export async function evaluateBackgroundTaskGate(params: {
  record: SessionRecord;
  killBackgroundTasks: boolean | undefined;
  explicitAgentName: string | undefined;
  verb: BackgroundTaskGateVerb;
  /** The caller's own verb options, reproduced in the retry command. */
  retryArgs?: readonly string[];
  query?: (sessionId: string) => Promise<BackgroundTasksQuery>;
}): Promise<{ refusal?: LiveBackgroundTasksRefusal; gate: BackgroundTasksGate }> {
  // Lazy: this module is on every CLI start path; the queue client is needed only by a close.
  const query =
    params.query ?? (await import("./queue/ipc.js")).tryQueryBackgroundTasksOnRunningOwner;
  const answer = await query(params.record.acpxRecordId);
  const tasks = answer.queried ? answer.tasks : [];
  const force = params.killBackgroundTasks === true;
  const gate = { queried: answer.queried, tasks, killed: tasks.length > 0 && force };
  if (tasks.length === 0 || force) {
    return { gate };
  }
  return {
    gate,
    refusal: {
      verb: params.verb,
      sessionId: params.record.acpxRecordId,
      tasks,
      retryCommand: backgroundTaskRetryCommand(
        params.verb,
        params.record.acpxRecordId,
        params.explicitAgentName,
        params.retryArgs,
      ),
    },
  };
}

/** text → stderr block; json → one stdout line; quiet → nothing. Exit 7 in every format. */
export function emitLiveBackgroundTasksRefusal(
  refusal: LiveBackgroundTasksRefusal,
  format: OutputFormat,
  nowMs: number = Date.now(),
): void {
  const payload = {
    ok: false,
    code: LIVE_BACKGROUND_TASKS_CODE,
    error: liveBackgroundTasksErrorMessage(refusal),
    sessionId: refusal.sessionId,
    liveBackgroundTasks: refusal.tasks,
    forceFlag: KILL_BACKGROUND_TASKS_FLAG,
    retryCommand: refusal.retryCommand,
  };
  if (!emitJsonResult(format, payload) && format !== "quiet") {
    process.stderr.write(liveBackgroundTasksRefusalText(refusal, nowMs));
  }
  process.exitCode = LIVE_BACKGROUND_TASKS_EXIT_CODE;
}

/** `outcome` is "ended" iff the reap measured AND nothing survived; anything else is unverified. */
export function backgroundTasksJson(
  gate: BackgroundTasksGate,
  reap: ReapReport,
): BackgroundTasksJson {
  const outcome = reap.measured && reap.survivors === 0 ? "ended" : "unverified";
  return {
    queried: gate.queried,
    killed: gate.killed,
    tasks: gate.tasks.map((task) => ({ ...task, outcome })),
    reap: publicReap(reap),
  };
}

/** The optional top-level `backgroundTasks` field of a success line. */
export function backgroundTasksField(backgroundTasks: BackgroundTasksJson | undefined): {
  backgroundTasks?: BackgroundTasksJson;
} {
  return backgroundTasks ? { backgroundTasks } : {};
}

/** A survivor is never silent: stderr, in every format (Contract C2/C6). */
export function warnReapSurvivors(sessionId: string, reap: ReapReport): void {
  if (!reap.measured || reap.survivors === 0) {
    return;
  }
  process.stderr.write(
    `[acpx] WARNING: ${reap.survivors} process(es) of session ${sessionId} survived SIGKILL: ` +
      `${formatSurvivors(reap.survivorDetails)}\n`,
  );
}

function reapOutcomeClause(reap: ReapReport): string {
  return reap.measured
    ? `${reap.taskProcesses} task processes ended, ${reap.survivors} survived`
    : `task processes could not be verified (${reap.skipped ?? "not measured"})`;
}

/** The forced-close summary (text mode) plus the survivor WARNING (any format). */
export function reportBackgroundTaskOutcome(
  sessionId: string,
  gate: BackgroundTasksGate,
  reap: ReapReport,
  format: OutputFormat,
): void {
  if (gate.killed && format === "text") {
    const list = gate.tasks.map((task) => `${taskLabel(task)} (${task.taskId})`).join(", ");
    process.stderr.write(
      `[acpx] killed ${countPhrase(gate.tasks.length)} of ${sessionId}: ${list}; ` +
        `${reapOutcomeClause(reap)}\n`,
    );
  }
  warnReapSurvivors(sessionId, reap);
}

/** Setter recycles (§5.2 D): `reap` in the JSON, and S5's silent kill is no longer silent. */
export function reportOwnerRecycleReap(
  sessionId: string,
  reap: ReapReport | undefined,
  format: OutputFormat,
): Record<string, unknown> {
  if (!reap) {
    return {};
  }
  if (format === "text" && reap.measured && reap.taskProcesses > 0) {
    process.stderr.write(
      `[acpx] restarting the owner of ${sessionId} ended ${reap.taskProcesses} background task process(es)\n`,
    );
  }
  warnReapSurvivors(sessionId, reap);
  return { reap: publicReap(reap) };
}
