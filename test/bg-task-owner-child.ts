// brick ad6ba1c2 — a stand-in queue owner for the background-task gate and reap tests.
//
// Compiled to `dist-test/test/bg-task-owner-child.js` and spawned `detached: true` (a process-group
// leader, like the real owner). It builds the PRODUCTION interaction shape at process level:
//
//   this owner (group leader) → fake adapter (same group) → task shell (setsid: its own session and
//   group, like Claude Code's `detached:true` shell) → `sleep` (bash job control: a THIRD group)
//
// so a process-group kill of this owner provably misses the task pair (REPRODUCTION.md). Not a test
// file — only spawned. Writes `{ownerPid, adapterPid, shellPid, sleepPid}` (and per-mode results) to
// `<outFile>` as JSON lines. Never prints argv or environ.
//
// Modes:
//   owner         real SessionQueueOwner answering query_background_tasks with the fixture tasks,
//                 fatal handler WITH the task reaper (production after this brick)
//   owner-none    the same, but the owner reports no live tasks
//   old-owner     a raw socket that answers every request with QUEUE_REQUEST_INVALID (an owner
//                 built before this verb existed), fatal handler WITHOUT the task reaper
//   fatal         only the fatal handler, WITH the task reaper (O1)
//   fatal-noreap  only the fatal handler, WITHOUT it (O1's negative control: today's code)
//   exit-reap     owner-side exit reap after a client close that kills only the adapter (O2)
//   remembered    the adapter (the "claude") dies first, orphaning the task; then the exit reap (O3)
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
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
import { scanProcTable, snapshotSessionTree } from "../src/process-tree-reap.js";
import { FIXTURE_TASKS } from "./bg-task-fixtures.js";

const [mode, outFile, sessionId] = process.argv.slice(2);
if (!mode || !outFile) {
  process.stderr.write("usage: bg-task-owner-child <mode> <outFile> [sessionId]\n");
  process.exit(2);
}

function emit(line: Record<string, unknown>): void {
  fs.appendFileSync(outFile, `${JSON.stringify(line)}\n`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const ADAPTER_SCRIPT = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  "const shell = spawn('bash', ['-c', 'set -m; sleep 300 & wait'], { detached: true, stdio: 'ignore' });",
  "fs.writeFileSync(process.argv[1], String(shell.pid));",
  "setInterval(() => {}, 1000);",
].join("\n");

async function spawnAdapterWithTask(): Promise<{
  adapterPid: number;
  shellPid: number;
  sleepPid: number;
}> {
  const pidFile = `${outFile}.shell-pid`;
  const adapter = spawn(process.execPath, ["-e", ADAPTER_SCRIPT, pidFile], { stdio: "ignore" });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const shellPid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : 0);
    const sleepEntry = shellPid
      ? [...scanProcTable().byPid.values()].find(
          (entry) => entry.sid === shellPid && entry.pid !== shellPid && entry.comm === "sleep",
        )
      : undefined;
    if (sleepEntry) {
      return { adapterPid: adapter.pid as number, shellPid, sleepPid: sleepEntry.pid };
    }
    await sleep(20);
  }
  throw new Error("bg-task-owner-child: the task shell never started");
}

function stubHandlers(
  log: (what: string) => void,
  tasks: LiveBackgroundTask[],
): QueueOwnerControlHandlers {
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
    queryBackgroundTasks: () => ({ source: "adapter", tasks }),
  };
}

async function runOwner(tasks: LiveBackgroundTask[]): Promise<void> {
  const lease = await tryAcquireQueueOwnerLease(sessionId);
  if (!lease) {
    throw new Error("bg-task-owner-child: could not acquire the lease");
  }
  const pids = await spawnAdapterWithTask();
  const reaper = createOwnerTaskReaper({ getAgentPid: () => pids.adapterPid });
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
  const pids = await spawnAdapterWithTask();
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
  const pids = await spawnAdapterWithTask();
  const reaper = createOwnerTaskReaper({ getAgentPid: () => pids.adapterPid });
  installQueueOwnerFatalShutdown({
    sessionId: sessionId ?? "fatal-rig",
    ...(withReaper ? { getTaskReaper: () => reaper } : {}),
  });
  emit({ ready: true, ownerPid: process.pid, ...pids });
  setInterval(() => {}, 1000);
}

function killAdapter(adapterPid: number): void {
  try {
    process.kill(adapterPid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function runExitReap(remembered: boolean): Promise<void> {
  const pids = await spawnAdapterWithTask();
  const reaper = createOwnerTaskReaper({ getAgentPid: () => pids.adapterPid });
  emit({ ready: true, ownerPid: process.pid, ...pids });
  if (remembered) {
    // A task-set change was observed while the tree was intact (§5.4).
    reaper.noteTaskSetChange();
    await sleep(50);
    // The "claude" crashes: its task shell is reparented out of this owner's tree (path I).
    killAdapter(pids.adapterPid);
    await sleep(300);
    const treeOnly = snapshotSessionTree({ rootPid: process.pid, includeRoot: false });
    emit({
      treeOnlyTaskMembers: treeOnly.members.filter((member) => member.inTaskSession).length,
      remembered: reaper.remembered().length,
    });
  }
  // §5.2 E: snapshot BEFORE the client close; the close kills only the adapter (this owner's group).
  const snapshot = reaper.snapshotOwnerExit();
  killAdapter(pids.adapterPid);
  const report = await reapAndLogOnOwnerExit(sessionId ?? "exit-rig", "idle-memory", snapshot);
  emit({ report: report ?? null, snapshotPids: snapshot.members.map((member) => member.pid) });
  process.exit(0);
}

const modes: Record<string, () => Promise<void>> = {
  owner: async () => await runOwner(FIXTURE_TASKS),
  "owner-none": async () => await runOwner([]),
  "old-owner": runOldOwner,
  fatal: async () => await runFatal(true),
  "fatal-noreap": async () => await runFatal(false),
  "exit-reap": async () => await runExitReap(false),
  remembered: async () => await runExitReap(true),
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
