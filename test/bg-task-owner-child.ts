// brick ad6ba1c2 — a stand-in queue owner for the background-task gate and reap tests (v3).
//
// Compiled to `dist-test/test/bg-task-owner-child.js` and spawned `detached: true` (a process-group
// and session leader, like the real owner). It builds the PRODUCTION interaction shape at process
// level, with the two kernel facts v3's proofs read (REPRODUCTION.md "v3 measurement"):
//
//   this owner → fake claude (same session) ─┬→ Bash task shell (setsid), fds 1/2 WR|APPEND on
//                                            │  <taskRoot>/<S>/tasks/b343f35rh.output → `sleep`
//                                            │  (bash job control: a THIRD group)          Proof F
//                                            └→ Monitor shell (setsid), fds 1/2 a SOCKET to claude,
//                                               CLAUDE_CODE_SESSION_ID=<S>, argv `eval '<cmd>'`
//                                               → `sleep`                                    Proof M
//
// A process-group kill of this owner provably misses both. Not a test file — only spawned. Writes
// `{ready, ownerPid, claudePid, shellPid, sleepPid, monShellPid, monSleepPid}` (and per-mode results)
// to `<outFile>` as JSON lines. Never prints argv or environ.
//
// argv: <mode> <outFile> <sessionId = S> <taskRoot: a dir whose path has a `claude-<uid>` segment>
//
// Modes:
//   owner         real SessionQueueOwner answering query_background_tasks with the fixture tasks and
//                 the Monitor's command; fatal handler WITH the task reaper (production)
//   owner-none    the same, but the owner reports no live tasks
//   owner-ghost   the fixture tasks plus a Bash task whose process does not exist (unprovable)
//   old-owner     a raw socket answering every request QUEUE_REQUEST_INVALID (an owner built before
//                 this verb), fatal handler WITHOUT the task reaper
//   fatal         only the fatal handler, WITH the task reaper (O1)
//   fatal-noreap  only the fatal handler, WITHOUT it (O1's negative control: today's code)
//   exit-reap     owner-side exit reap after a client close that kills only the fake claude (O2)
//   race          (v3.1 T-RACE-2) the owner reports NO task to the upfront query, then the Monitor from the
//                 next read on (the in-drain CHECK): a task started during the drain
//   late          (v3.1 T-RACE-4) no task to the gate nor to the in-drain CHECK, then both tasks from the
//                 third read on (the closer's pre-snapshot re-query): a task started after the commit
//   crash         the fake claude dies FIRST (both task shells reparent out of the tree), then the
//                 exit reap (O3b, path I: box-wide proofs, no memo)
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  type QueueOwnerControlHandlers,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
} from "../src/cli/queue/ipc.js";
import type { LiveBackgroundTask } from "../src/cli/session/background-task-tracker.js";
import {
  createOwnerTaskReaper,
  reapAndLogOnOwnerExit,
} from "../src/cli/session/owner-task-reap.js";
import { installQueueOwnerFatalShutdown } from "../src/cli/session/queue-owner-runtime.js";
import { scanProcTable } from "../src/process-tree-reap.js";
import { FIXTURE_MONITOR_COMMAND, FIXTURE_TASKS, GHOST_TASK } from "./bg-task-fixtures.js";

const [mode, outFile, sessionId, taskRoot] = process.argv.slice(2);
if (!mode || !outFile || !sessionId || !taskRoot) {
  process.stderr.write("usage: bg-task-owner-child <mode> <outFile> <sessionId> <taskRoot>\n");
  process.exit(2);
}

function emit(line: Record<string, unknown>): void {
  fs.appendFileSync(outFile, `${JSON.stringify(line)}\n`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const BASH_TASK_ID = "b343f35rh";
const taskFile = path.join(taskRoot, sessionId, "tasks", `${BASH_TASK_ID}.output`);

// The fake claude. Its stdout pipes to the Monitor shell stay open in it (the socket's other end).
const CLAUDE_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  "const [pidFile, taskFile, session, monitorShellArg] = process.argv.slice(1);",
  "const out = fs.openSync(taskFile, 'a');",
  "const shell = spawn('bash', ['-c', 'set -m; sleep 300 & wait'], { detached: true, stdio: ['ignore', out, out] });",
  "const mon = spawn('bash', ['-c', monitorShellArg], {",
  "  detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CODE_SESSION_ID: session } });",
  "mon.stdout.resume(); mon.stderr.resume();",
  // Like the real claude (measured): it holds NO task-file fd itself.
  "fs.closeSync(out);",
  // Atomic: the parent waits for the file to EXIST, so it must never exist half-written.
  "fs.writeFileSync(pidFile + '.tmp', JSON.stringify({ shellPid: shell.pid, monShellPid: mon.pid }));",
  "fs.renameSync(pidFile + '.tmp', pidFile);",
  "setInterval(() => {}, 1000);",
].join("\n");

type RigPids = {
  claudePid: number;
  shellPid: number;
  sleepPid: number;
  monShellPid: number;
  monSleepPid: number;
};

function sleepIn(sid: number): number | undefined {
  return [...scanProcTable().byPid.values()].find(
    (entry) => entry.sid === sid && entry.pid !== sid && entry.comm === "sleep",
  )?.pid;
}

async function spawnClaudeWithTasks(): Promise<RigPids> {
  fs.mkdirSync(path.dirname(taskFile), { recursive: true });
  const pidFile = `${outFile}.claude-pids`;
  const claude = spawn(
    process.execPath,
    // Claude Code's Monitor shell carries its command in argv inside an `eval '…'` (measured).
    ["-e", CLAUDE_SCRIPT, pidFile, taskFile, sessionId, `eval '${FIXTURE_MONITOR_COMMAND}'`],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const written = fs.existsSync(pidFile)
      ? (JSON.parse(fs.readFileSync(pidFile, "utf8")) as { shellPid: number; monShellPid: number })
      : undefined;
    const sleepPid = written ? sleepIn(written.shellPid) : undefined;
    const monSleepPid = written ? sleepIn(written.monShellPid) : undefined;
    if (written && sleepPid && monSleepPid) {
      return { claudePid: claude.pid as number, ...written, sleepPid, monSleepPid };
    }
    await sleep(20);
  }
  throw new Error("bg-task-owner-child: the task shells never started");
}

const MONITOR_COMMANDS = [{ taskId: "b2g1k6brj", command: FIXTURE_MONITOR_COMMAND }];

function reaperFor(tasks: LiveBackgroundTask[]) {
  return createOwnerTaskReaper({
    getTaskSet: () => ({ tasks, monitorCommands: MONITOR_COMMANDS }),
    getAcpSessionId: () => sessionId,
  });
}

type TaskSchedule = (read: number) => LiveBackgroundTask[];

function stubHandlers(
  log: (what: string) => void,
  tasks: LiveBackgroundTask[] | TaskSchedule,
): QueueOwnerControlHandlers {
  let reads = 0;
  const live = (): LiveBackgroundTask[] => {
    reads += 1;
    return typeof tasks === "function" ? tasks(reads) : tasks;
  };
  return {
    cancelPrompt: async () => false,
    closeSession: async () => {
      log("close_session");
      return true;
    },
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    setDepth: async (requested: string) => ({ kind: "send-nothing", requested }),
    queryActiveTurn: () => false,
    queryBackgroundTasks: () => {
      const now = live();
      emit({ taskRead: now.length });
      return { source: "adapter", tasks: now, monitorCommands: MONITOR_COMMANDS };
    },
  };
}

async function runOwner(tasks: LiveBackgroundTask[] | TaskSchedule): Promise<void> {
  const lease = await tryAcquireQueueOwnerLease(sessionId);
  if (!lease) {
    throw new Error("bg-task-owner-child: could not acquire the lease");
  }
  const pids = await spawnClaudeWithTasks();
  // The owner's own handler (path G) reaps what IS running: both rig tasks.
  const reaper = reaperFor(typeof tasks === "function" ? FIXTURE_TASKS : tasks);
  let owner: SessionQueueOwner | undefined;
  installQueueOwnerFatalShutdown({
    sessionId: sessionId,
    getOwner: () => owner,
    lease,
    getTaskReaper: () => reaper,
  });
  const log = (what: string) => emit({ request: what });
  owner = await SessionQueueOwner.start(lease, stubHandlers(log, tasks), { maxQueueDepth: 4 });
  // Every drain the closer sends lands here: the gate must send none on a refusal.
  const drainable = owner as unknown as { drainDeliveries: (...args: unknown[]) => unknown };
  const drain = drainable.drainDeliveries.bind(owner);
  drainable.drainDeliveries = (...args: unknown[]) => {
    log("drain_deliveries");
    return drain(...args);
  };
  emit({ ready: true, ownerPid: process.pid, ...pids });
  setInterval(() => {}, 1000);
}

async function runOldOwner(): Promise<void> {
  const lease = await tryAcquireQueueOwnerLease(sessionId);
  if (!lease) {
    throw new Error("bg-task-owner-child: could not acquire the lease");
  }
  const pids = await spawnClaudeWithTasks();
  installQueueOwnerFatalShutdown({ sessionId: sessionId, lease });
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (chunk: string) => {
      const type = (JSON.parse(chunk.split("\n")[0]) as { type?: string }).type;
      emit({ request: type });
      socket.end(
        `${JSON.stringify({
          type: "error",
          requestId: "unknown",
          code: "RUNTIME",
          detailCode: "QUEUE_REQUEST_INVALID",
          origin: "queue",
          message: "Invalid queue request",
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(lease.socketPath, resolve));
  emit({ ready: true, ownerPid: process.pid, ...pids });
}

async function runFatal(withReaper: boolean): Promise<void> {
  const pids = await spawnClaudeWithTasks();
  const reaper = reaperFor(FIXTURE_TASKS);
  installQueueOwnerFatalShutdown({
    sessionId: sessionId,
    ...(withReaper ? { getTaskReaper: () => reaper } : {}),
  });
  emit({ ready: true, ownerPid: process.pid, ...pids });
  setInterval(() => {}, 1000);
}

function killClaude(claudePid: number): void {
  try {
    process.kill(claudePid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function runExitReap(crashFirst: boolean): Promise<void> {
  const pids = await spawnClaudeWithTasks();
  const reaper = reaperFor(FIXTURE_TASKS);
  emit({ ready: true, ownerPid: process.pid, ...pids });
  if (crashFirst) {
    // Path I: claude crashes, both task shells reparent OUT of this owner's tree.
    killClaude(pids.claudePid);
    await sleep(300);
    const byPid = scanProcTable().byPid;
    emit({
      reparented: [pids.shellPid, pids.monShellPid].map(
        (pid) => byPid.get(pid)?.ppid !== pids.claudePid,
      ),
    });
  }
  // §5.2 E: admission BEFORE the client close; the close kills only the fake claude (this session).
  const snapshot = reaper.snapshot();
  killClaude(pids.claudePid);
  const report = await reapAndLogOnOwnerExit(sessionId, "idle-memory", snapshot);
  emit({ report: report ?? null, snapshotPids: snapshot.members.map((member) => member.pid) });
  process.exit(0);
}

const modes: Record<string, () => Promise<void>> = {
  owner: async () => await runOwner(FIXTURE_TASKS),
  "owner-none": async () => await runOwner([]),
  "owner-ghost": async () => await runOwner([...FIXTURE_TASKS, GHOST_TASK]),
  race: async () =>
    await runOwner((read) =>
      read === 1 ? [] : FIXTURE_TASKS.filter((t) => t.toolName === "Monitor"),
    ),
  late: async () => await runOwner((read) => (read <= 2 ? [] : FIXTURE_TASKS)),
  "old-owner": runOldOwner,
  fatal: async () => await runFatal(true),
  "fatal-noreap": async () => await runFatal(false),
  "exit-reap": async () => await runExitReap(false),
  crash: async () => await runExitReap(true),
};

const run = modes[mode];
if (!run) {
  process.stderr.write(`bg-task-owner-child: unknown mode ${mode}\n`);
  process.exit(2);
}
await run().catch((error: unknown) => {
  process.stderr.write(`bg-task-owner-child: ${String(error)}\n`);
  process.exit(1);
});
