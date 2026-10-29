// brick ad6ba1c2 v3 — real-process rigs for `process-tree-reap.test.ts`. Not a test file.
//
// `spawnRig(plan)` starts a detached "fake claude" (its own session, like the queue owner's session
// that v3 spares wholesale). It spawns one setsid bash per plan entry, with the stdio a v3 proof
// reads: a task output file under `<taskRoot>/<S>/tasks/<id>.output` (WR|APPEND, Proof F), a SOCKET
// (Proof M), a read-only holder, or nothing. Every pid is resolved from /proc and torn down BY
// VERIFIED PID (start ticks), never by pattern. Never prints argv or environ.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProcStat, type ProcEntry } from "../src/process-tree-reap.js";

export type ShellPlan = {
  name: string;
  /** `task:<id>` / `task:<id>@<otherS>` (append), `socket`, or `ignore`. */
  stdout: string;
  script: string;
  env?: Record<string, string>;
  /** Run as `node -e <script>` instead of bash (comm `node`). */
  node?: boolean;
};

export type Rig = {
  claudePid: number;
  pids: Record<string, number>;
  taskRoot: string;
  acpSessionId: string;
  taskFile: (taskId: string, session?: string) => string;
  entry: (pid: number) => ProcEntry | undefined;
  /** Every live process in the session `sid` (pid + start ticks). */
  sessionMembers: (sid: number) => ProcEntry[];
  aliveAs: (pid: number, startTicks: string) => boolean;
  track: (pid: number) => void;
  killAll: () => void;
};

export function readEntry(pid: number): ProcEntry | undefined {
  try {
    return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

function isLive(entry: ProcEntry | undefined): entry is ProcEntry {
  return entry !== undefined && entry.state !== "Z" && entry.state !== "X";
}

export function allEntries(): ProcEntry[] {
  return fs
    .readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map((name) => readEntry(Number(name)))
    .filter(isLive);
}

export async function waitFor<T>(
  read: () => T | undefined,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const CLAUDE_SCRIPT = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [planFile, pidFile, taskRoot, session] = process.argv.slice(1);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const pids = {};
for (const shell of plan) {
  let out = 'ignore';
  if (shell.stdout.startsWith('task:')) {
    const [id, other] = shell.stdout.slice(5).split('@');
    const dir = taskRoot + '/' + (other || session) + '/tasks';
    fs.mkdirSync(dir, { recursive: true });
    out = fs.openSync(dir + '/' + id + '.output', 'a');
  } else if (shell.stdout === 'socket') {
    out = 'pipe';
  }
  const cmd = shell.node ? process.execPath : 'bash';
  const args = shell.node ? ['-e', shell.script] : ['-c', shell.script];
  const child = spawn(cmd, args, {
    detached: true,
    cwd: taskRoot,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...(shell.env || {}) },
  });
  if (out === 'pipe') { child.stdout.resume(); child.stderr.resume(); }
  // Like the real claude (measured): it holds NO task-file fd itself, only its children do.
  if (typeof out === 'number') { fs.closeSync(out); }
  pids[shell.name] = child.pid;
}
// Atomic: spawnRig waits for the file to EXIST, so it must never exist half-written.
fs.writeFileSync(pidFile + '.tmp', JSON.stringify(pids));
fs.renameSync(pidFile + '.tmp', pidFile);
setInterval(() => {}, 1000);
`;

/** The rig's task root: a path with a `claude-<uid>` segment, like `/tmp/claude-1000/<proj>`. */
export function rigTaskRoot(dir: string): string {
  return path.join(dir, `claude-${os.userInfo().uid}`, "proj");
}

export function rigTaskFile(dir: string, acpSessionId: string, taskId: string): string {
  return path.join(rigTaskRoot(dir), acpSessionId, "tasks", `${taskId}.output`);
}

export function newSessionId(prefix = "s"): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function spawnRig(
  dir: string,
  plan: ShellPlan[],
  acpSessionId: string = newSessionId(),
): Promise<Rig> {
  const taskRoot = rigTaskRoot(dir);
  fs.mkdirSync(taskRoot, { recursive: true });
  const planFile = path.join(dir, `plan-${acpSessionId}.json`);
  const pidFile = path.join(dir, `pids-${acpSessionId}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const claude = spawn(
    process.execPath,
    ["-e", CLAUDE_SCRIPT, planFile, pidFile, taskRoot, acpSessionId],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  claude.unref();
  const pids = await waitFor(
    () =>
      fs.existsSync(pidFile)
        ? (JSON.parse(fs.readFileSync(pidFile, "utf8")) as Record<string, number>)
        : undefined,
    "the rig",
  );
  const tracked = new Map<number, string>();
  const track = (pid: number) => {
    const entry = readEntry(pid);
    if (entry) {
      tracked.set(pid, entry.startTicks);
    }
  };
  track(claude.pid as number);
  for (const pid of Object.values(pids)) {
    track(pid);
  }
  const aliveAs = (pid: number, startTicks: string) => {
    const entry = readEntry(pid);
    return isLive(entry) && entry.startTicks === startTicks;
  };
  const sessionMembers = (sid: number) => allEntries().filter((entry) => entry.sid === sid);
  return {
    claudePid: claude.pid as number,
    pids,
    taskRoot,
    acpSessionId,
    taskFile: (taskId, session = acpSessionId) =>
      path.join(taskRoot, session, "tasks", `${taskId}.output`),
    entry: readEntry,
    sessionMembers,
    aliveAs,
    track,
    killAll: () => {
      // Every tracked pid, plus every member of each rig shell's session (re-forked loop sleeps).
      for (const sid of Object.values(pids)) {
        for (const member of sessionMembers(sid)) {
          tracked.set(member.pid, member.startTicks);
        }
      }
      for (const [pid, startTicks] of tracked) {
        if (aliveAs(pid, startTicks)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // gone meanwhile
          }
        }
      }
      // SIGKILL is asynchronous: wait (bounded) until the deaths are visible, so a teardown check
      // that follows never sees a dying rig process as a leak.
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && [...tracked].some(([pid, ticks]) => aliveAs(pid, ticks))) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    },
  };
}
