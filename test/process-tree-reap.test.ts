import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { taskOutcome, warnReapSurvivors } from "../src/cli/background-task-gate.js";
import {
  createOwnerSignalReap,
  createOwnerTaskReaper,
  formatOwnerReapLine,
  reapAndLogOnOwnerExit,
} from "../src/cli/session/owner-task-reap.js";
import {
  normalizeCommandForMatch,
  reapSnapshot,
  signalSnapshot,
  snapshotSessionTree,
  unprovenTaskWarning,
  type BackgroundTaskSet,
  type Signaller,
} from "../src/process-tree-reap.js";
import {
  allEntries,
  newSessionId,
  readEntry,
  rigTaskFile,
  spawnRig,
  waitFor,
  type Rig,
} from "./reap-rig.js";

// brick ad6ba1c2 — the reap module, CONCEPTION v3 §5.1 / §10, against REAL processes shaped like
// Claude Code's: a fake claude (its own session, spared like the owner's) whose setsid shells hold
// the kernel facts the proofs read. Each v3 negative (N-*) carries a control proving its fixture
// CAN fail: the v2 position rule, or the v2 leader-gated follow, selects what v3 must spare.

const CHILD_PATH = fileURLToPath(new URL("./bg-task-owner-child.js", import.meta.url));
const linux = process.platform === "linux";

const LOOP = "while :; do sleep 5; done";
const FORK_ON_TERM = `bash -c 'trap "sleep 600 & exit 0" TERM; while :; do sleep 2 & wait $!; done'`;

/** The fork-on-TERM task's inner bash, once its loop runs (its trap is installed by then). */
async function forkLoopInner(rig: Rig): Promise<number> {
  const inner = await waitFor(
    () =>
      rig.sessionMembers(rig.pids.bg).find((e) => e.comm === "bash" && e.ppid === rig.pids.bg)?.pid,
    "inner bash",
  );
  await waitFor(
    () =>
      rig.sessionMembers(rig.pids.bg).some((e) => e.comm === "sleep" && e.ppid === inner)
        ? true
        : undefined,
    "the loop's first sleep",
  );
  return inner;
}

/** The TERM handler's fork: the `sleep` still in the task's session once the inner bash has exited. */
async function trapFork(rig: Rig, inner: number, exclude: ReadonlySet<number>): Promise<number> {
  await waitFor(
    () => (readEntry(inner) === undefined || readEntry(inner)?.state === "Z" ? true : undefined),
    "the trap to exit",
  );
  return await waitFor(
    () =>
      rig.sessionMembers(rig.pids.bg).find((e) => e.comm === "sleep" && !exclude.has(e.pid))?.pid,
    "the TERM handler's fork",
  );
}

function bashTask(taskId: string): BackgroundTaskSet["tasks"][number] {
  return { taskId, taskType: "local_bash", toolName: "Bash" };
}

function monitorTask(taskId: string): BackgroundTaskSet["tasks"][number] {
  return { taskId, taskType: "local_bash", toolName: "Monitor" };
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "acpx-reap-"));
  try {
    await run(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function withRig(
  plan: Parameters<typeof spawnRig>[1],
  run: (rig: Rig, dir: string) => Promise<void>,
): Promise<void> {
  await withDir(async (dir) => {
    const rig = await spawnRig(dir, plan);
    try {
      await run(rig, dir);
    } finally {
      rig.killAll();
    }
  });
}

function closerSnapshot(
  rig: Rig,
  bg: BackgroundTaskSet | undefined,
  extra: Partial<Parameters<typeof snapshotSessionTree>[0]> = {},
) {
  return snapshotSessionTree({
    bg,
    acpSessionId: rig.acpSessionId,
    ownerPid: rig.claudePid,
    excludeSelfAncestry: true,
    ...extra,
  });
}

function alive(rig: Rig, pid: number | undefined): boolean {
  const entry = pid === undefined ? undefined : readEntry(pid);
  return entry !== undefined && entry.state !== "Z" && entry.state !== "X";
}

const sleepOf = (rig: Rig, sid: number) =>
  waitFor(
    () => rig.sessionMembers(sid).find((e) => e.comm === "sleep" && e.pid !== sid)?.pid,
    `sleep in ${sid}`,
  );

/** The v2 POSITION rule, as a negative control: every process in a non-owner session under claude. */
function v2PositionMembers(rig: Rig): Set<number> {
  const entries = allEntries();
  const claude = readEntry(rig.claudePid);
  const underClaude = new Set<number>();
  const queue = [rig.claudePid];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of entries.filter((e) => e.ppid === pid)) {
      underClaude.add(child.sid);
      queue.push(child.pid);
    }
  }
  underClaude.delete(claude?.sid ?? -1);
  return new Set(entries.filter((e) => underClaude.has(e.sid)).map((e) => e.pid));
}

function captureStderr<T>(run: () => T): { value: T; text: string } {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: run(), text: written.join("") };
  } finally {
    process.stderr.write = original;
  }
}

async function captureStderrAsync<T>(run: () => Promise<T>): Promise<{ value: T; text: string }> {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await run(), text: written.join("") };
  } finally {
    process.stderr.write = original;
  }
}

// ---------------------------------------------------------------------------
// R1–R5
// ---------------------------------------------------------------------------

test("R1: a proven Bash task pair SURVIVES the owner-session's group kill (the leak is real); the proof-gated reap ends it", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withRig(
    [{ name: "bg", stdout: "task:BG1", script: "set -m; sleep 300 & wait" }],
    async (rig) => {
      const bgSleep = await sleepOf(rig, rig.pids.bg);
      assert.notEqual(
        readEntry(bgSleep)?.pgid,
        readEntry(rig.pids.bg)?.pgid,
        "the command sits in a third group",
      );
      const snapshot = closerSnapshot(rig, { tasks: [bashTask("BG1")], monitorCommands: [] });
      assert.equal(snapshot.measured, true);
      assert.deepEqual(
        snapshot.sessions.map((s) => [s.sid, s.taskId]),
        [[rig.pids.bg, "BG1"]],
      );
      assert.deepEqual(
        snapshot.members.map((m) => m.pid).toSorted((a, b) => a - b),
        [rig.pids.bg, bgSleep].toSorted((a, b) => a - b),
      );

      // NEGATIVE CONTROL: today's mechanism, a process-group SIGKILL of the owner side.
      process.kill(-rig.claudePid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(!alive(rig, rig.claudePid));
      assert.ok(alive(rig, rig.pids.bg) && alive(rig, bgSleep), "the rig must reproduce the leak");

      const report = await reapSnapshot(snapshot);
      assert.deepEqual([report.measured, report.taskProcesses, report.survivors], [true, 2, 0]);
      assert.deepEqual(report.provenTaskIds, ["BG1"]);
      assert.equal(rig.sessionMembers(rig.pids.bg).length, 0);
    },
  );
});

test("R2: a nested acpx owner below an admitted SINGLE is pruned (argv token __queue-owner); the single still ends", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  // The single: a node process (NOT its session's leader) that holds the task file itself (node
  // opens it O_CLOEXEC, so the nested owner does not inherit it) and has spawned another session's
  // owner, as `acpx prompt --session-id <other>` run from a background task would.
  const single =
    "const fs=require('node:fs');const{spawn}=require('node:child_process');" +
    "globalThis.k=fs.openSync(process.env.RIG_TASK_FILE,'a');" +
    "const nested=spawn(process.execPath,['-e',\"require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)\",'__queue-owner'],{detached:true,stdio:'ignore'});" +
    "fs.writeFileSync(process.env.RIG_NESTED_PID,String(nested.pid));setInterval(()=>{},1000);";
  await withDir(async (dir) => {
    const S = newSessionId();
    const nestedPidFile = path.join(dir, "nested.pid");
    const taskFile = rigTaskFile(dir, S, "BG1");
    await fsp.mkdir(path.dirname(taskFile), { recursive: true });
    const rig = await spawnRig(
      dir,
      [
        {
          name: "leader",
          stdout: "ignore",
          script: 'node -e "$RIG_SINGLE" & wait',
          env: { RIG_SINGLE: single, RIG_NESTED_PID: nestedPidFile, RIG_TASK_FILE: taskFile },
        },
      ],
      S,
    );
    try {
      const nestedPid = await waitFor(
        () =>
          fs.existsSync(nestedPidFile) ? Number(fs.readFileSync(nestedPidFile, "utf8")) : undefined,
        "the nested owner",
      );
      const singlePid = await waitFor(
        () => rig.sessionMembers(rig.pids.leader).find((e) => e.comm === "node")?.pid,
        "the single",
      );
      const nestedChild = await waitFor(
        () => allEntries().find((e) => e.ppid === nestedPid)?.pid,
        "nested child",
      );
      for (const pid of [singlePid, nestedPid, nestedChild]) {
        rig.track(pid);
      }
      const bg = { tasks: [bashTask("BG1")], monitorCommands: [] };
      // NEGATIVE CONTROL: without the prune the nested owner IS a member of the single's walk.
      const unpruned = closerSnapshot(rig, bg, { isNestedOwner: () => false });
      assert.ok(unpruned.members.some((m) => m.pid === nestedPid));
      const snapshot = closerSnapshot(rig, bg);
      assert.deepEqual(
        snapshot.singles.map((x) => x.pid),
        [singlePid],
      );
      assert.ok(!snapshot.members.some((m) => m.pid === nestedPid || m.pid === nestedChild));
      const report = await reapSnapshot(snapshot);
      assert.equal(report.survivors, 0);
      assert.ok(!alive(rig, singlePid), "the single survived");
      assert.ok(
        alive(rig, nestedPid) && alive(rig, nestedChild),
        "the nested owner (or its child) was killed",
      );
    } finally {
      rig.killAll();
    }
  });
});

/** A synthetic /proc: `<root>/<pid>/{stat,fd/<n>,fdinfo/<n>}` the test controls. */
function writeFakeProc(
  root: string,
  e: {
    pid: number;
    ppid: number;
    pgid: number;
    sid: number;
    ticks: string;
    comm?: string;
    taskFile?: string;
  },
) {
  const dir = path.join(root, String(e.pid));
  fs.mkdirSync(path.join(dir, "fd"), { recursive: true });
  fs.mkdirSync(path.join(dir, "fdinfo"), { recursive: true });
  // Fields after ")": state ppid pgrp session, then tty_nr … itrealvalue (15), then starttime.
  const after = ["S", e.ppid, e.pgid, e.sid, ...Array<string>(15).fill("0"), e.ticks];
  fs.writeFileSync(
    path.join(dir, "stat"),
    `${e.pid} (${e.comm ?? "bash"}) ${after.join(" ")} 0 0\n`,
  );
  if (e.taskFile) {
    fs.rmSync(path.join(dir, "fd", "1"), { force: true });
    fs.symlinkSync(e.taskFile, path.join(dir, "fd", "1"));
    fs.writeFileSync(path.join(dir, "fdinfo", "1"), "pos:\t0\nflags:\t02001\nmnt_id:\t1\n");
  }
}

test("R3: pid reuse — an admitted session whose leader number now names another process is NEVER signalled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-fakeproc-"));
  try {
    const taskFile = `/tmp/claude-1000/proj/S1/tasks/T1.output`;
    writeFakeProc(root, { pid: 900, ppid: 1, pgid: 900, sid: 900, ticks: "5", comm: "node" });
    writeFakeProc(root, { pid: 1001, ppid: 900, pgid: 1001, sid: 1001, ticks: "11", taskFile });
    writeFakeProc(root, {
      pid: 1002,
      ppid: 1001,
      pgid: 1002,
      sid: 1001,
      ticks: "12",
      comm: "sleep",
    });
    const snapshot = snapshotSessionTree({
      bg: { tasks: [bashTask("T1")], monitorCommands: [] },
      acpSessionId: "S1",
      ownerPid: 900,
      procRoot: root,
    });
    assert.deepEqual(
      snapshot.members.map((m) => m.pid).toSorted((a, b) => a - b),
      [1001, 1002],
    );
    const signalled: number[] = [];
    const recorder: Signaller = (pid) => {
      signalled.push(pid);
    };
    assert.equal(signalSnapshot(snapshot, "SIGTERM", recorder), 2, "positive control");
    signalled.length = 0;
    // Both numbers now name DIFFERENT processes (new start ticks); 1001 leads a new session.
    writeFakeProc(root, { pid: 1001, ppid: 1, pgid: 1001, sid: 1001, ticks: "98" });
    writeFakeProc(root, {
      pid: 1002,
      ppid: 1001,
      pgid: 1002,
      sid: 1001,
      ticks: "99",
      comm: "sleep",
    });
    assert.equal(signalSnapshot(snapshot, "SIGKILL", recorder), 0);
    assert.deepEqual(signalled, [], "a reused pid was signalled");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("R4: /proc not measurable, or no task set — measured:false, never a census", async () => {
  const unreadable = snapshotSessionTree({
    bg: { tasks: [], monitorCommands: [] },
    acpSessionId: "S",
    ownerPid: process.pid,
    procRoot: path.join(os.tmpdir(), "acpx-no-such-proc-root"),
  });
  assert.deepEqual([unreadable.measured, unreadable.skipped], [false, "identity-unverified"]);
  const report = await reapSnapshot(unreadable);
  assert.deepEqual([report.measured, report.survivors, report.taskProcesses], [false, 0, 0]);
  assert.match(formatOwnerReapLine("s", "SIGTERM", report), /could NOT census .*\(measured=false/);
  if (linux) {
    const noSet = snapshotSessionTree({ bg: undefined, acpSessionId: "S", ownerPid: process.pid });
    assert.deepEqual([noSet.measured, noSet.skipped], [false, "no-task-set"]);
    assert.equal(
      taskOutcome({ ...bashTask("x"), description: "" }, await reapSnapshot(noSet), true),
      "unverified",
    );
  }
});

test("R5: a survivor is reported (count, pid, comm) on stderr and in the owner.log line — never silent", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withRig(
    [{ name: "bg", stdout: "task:BG1", script: "set -m; sleep 300 & wait" }],
    async (rig) => {
      const bgSleep = await sleepOf(rig, rig.pids.bg);
      const snapshot = closerSnapshot(rig, { tasks: [bashTask("BG1")], monitorCommands: [] });
      const swallowSleep: Signaller = (pid, signal) => {
        if (pid !== bgSleep) {
          process.kill(pid, signal);
        }
      };
      const report = await reapSnapshot(snapshot, {
        graceMs: 400,
        killWaitMs: 100,
        signal: swallowSleep,
      });
      assert.deepEqual(
        [report.measured, report.survivors, report.survivorPids],
        [true, 1, [bgSleep]],
      );
      assert.equal(report.survivorDetails[0]?.comm, "sleep");
      assert.deepEqual(report.survivingTaskIds, ["BG1"]);
      const { text } = captureStderr(() => warnReapSurvivors("r5-session", report));
      assert.match(
        text,
        new RegExp(
          `WARNING: 1 process\\(es\\) of session r5-session survived SIGKILL: pid ${bgSleep} \\(sleep, start \\d+\\)`,
        ),
      );
      assert.match(
        formatOwnerReapLine("r5-session", "idle-memory", report),
        new RegExp(
          `reaped 2 background task process\\(es\\) of session r5-session after idle-memory \\(survivors=1: pid ${bgSleep} \\(sleep, start \\d+\\)\\)`,
        ),
      );
      assert.equal(
        taskOutcome({ ...bashTask("BG1"), description: "" }, report, true),
        "unverified",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// v3 negatives
// ---------------------------------------------------------------------------

/**
 * The TE's ADV-DAEMON shape: a background task BG1, and a FOREGROUND call (its own task id FG1,
 * never in BG) that starts daemon A (inherits FG1) and daemon B (`> daemon.log 2>&1`), then
 * EXITS (or, in-flight, holds). Daemon pids are written by the foreground shell itself.
 */
function dmnPlan(dir: string, inFlight: boolean): Parameters<typeof spawnRig>[1] {
  const fg =
    `nohup bash -c '${LOOP}' & echo $! > ${dir}/daemonA.pid; ` +
    `nohup bash -c '${LOOP}' > ${dir}/daemon.log 2>&1 & echo $! > ${dir}/daemonB.pid; ` +
    // `; echo held` keeps bash from exec-optimizing its last command into the sleep.
    (inFlight ? "sleep 60; echo held" : "sleep 1; echo held");
  return [
    { name: "bg", stdout: "task:BG1", script: "set -m; sleep 300 & wait" },
    { name: "fg", stdout: "task:FG1", script: fg },
  ];
}

async function daemonPids(dir: string): Promise<[number, number]> {
  const read = (name: string) => () =>
    fs.existsSync(path.join(dir, name)) && fs.readFileSync(path.join(dir, name), "utf8").trim()
      ? Number(fs.readFileSync(path.join(dir, name), "utf8"))
      : undefined;
  return [
    await waitFor(read("daemonA.pid"), "daemon A"),
    await waitFor(read("daemonB.pid"), "daemon B"),
  ];
}

const DMN_BG: BackgroundTaskSet = { tasks: [bashTask("BG1")], monitorCommands: [] };

type DmnEntry = "closer" | "owner-graceful" | "owner-signal";

async function runDmnEntry(entry: DmnEntry, rig: Rig): Promise<number> {
  if (entry === "closer") {
    return (await reapSnapshot(closerSnapshot(rig, DMN_BG))).taskProcesses;
  }
  // The owner side runs in-process: this test process is the "owner" (its session spared), the rig
  // is a box-wide neighbour that only the proofs can reach.
  const reaper = createOwnerTaskReaper({
    getTaskSet: () => DMN_BG,
    getAcpSessionId: () => rig.acpSessionId,
  });
  if (entry === "owner-graceful") {
    const { value } = await captureStderrAsync(
      async () => await reapAndLogOnOwnerExit("dmn", "deploy-staleness", reaper.snapshot()),
    );
    return value?.taskProcesses ?? -1;
  }
  const signalReap = createOwnerSignalReap("dmn", reaper);
  const { text } = captureStderr(() => {
    signalReap.term();
    signalReap.kill("SIGTERM");
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  return Number(/reaped (\d+) background task/.exec(text)?.[1] ?? -1);
}

for (const entry of ["closer", "owner-graceful", "owner-signal"] as const) {
  test(`N-DMN (${entry}): a FOREGROUND call's daemons, with and without a redirect, SURVIVE; only the background task ends`, async (t) => {
    if (!linux) {
      t.skip("linux /proc");
      return;
    }
    await withDir(async (dir) => {
      const rig = await spawnRig(dir, dmnPlan(dir, false));
      try {
        const [daemonA, daemonB] = await daemonPids(dir);
        rig.track(daemonA);
        rig.track(daemonB);
        const bgSleep = await sleepOf(rig, rig.pids.bg);
        // NEGATIVE CONTROL (v2): while the foreground call lives, the position rule selects both daemons.
        const v2 = v2PositionMembers(rig);
        assert.ok(v2.has(daemonA) && v2.has(daemonB), "the fixture must be able to fail");
        await waitFor(
          () => (alive(rig, rig.pids.fg) ? undefined : true),
          "the foreground call to end",
        );
        assert.equal(readEntry(daemonA)?.ppid, 1, "daemon A left the tree");

        const counted = await runDmnEntry(entry, rig);
        assert.ok(!alive(rig, rig.pids.bg) && !alive(rig, bgSleep), "the background task survived");
        assert.ok(alive(rig, daemonA), "daemon A (inherits the foreground task file) was killed");
        assert.ok(alive(rig, daemonB), "daemon B (redirected) was killed");
        if (entry !== "owner-signal") {
          assert.equal(counted, 2, "the report counts only BG1's processes");
        }
      } finally {
        rig.killAll();
      }
    });
  });
}

test("N-DMN-INFLIGHT: while the foreground call still runs, it, its child and both daemons SURVIVE (RV-1)", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withDir(async (dir) => {
    const rig = await spawnRig(dir, dmnPlan(dir, true));
    try {
      const [daemonA, daemonB] = await daemonPids(dir);
      rig.track(daemonA);
      rig.track(daemonB);
      const fgSleep = await waitFor(
        () =>
          rig.sessionMembers(rig.pids.fg).find((e) => e.comm === "sleep" && e.ppid === rig.pids.fg)
            ?.pid,
        "the foreground sleep",
      );
      // NEGATIVE CONTROL: v2's position rule selects the whole in-flight foreground tree (TE N4).
      assert.ok(v2PositionMembers(rig).has(fgSleep));
      const report = await reapSnapshot(closerSnapshot(rig, DMN_BG));
      assert.equal(report.taskProcesses, 2);
      assert.ok(!alive(rig, rig.pids.bg));
      for (const [name, pid] of [
        ["fg shell", rig.pids.fg],
        ["fg sleep", fgSleep],
        ["daemon A", daemonA],
        ["daemon B", daemonB],
      ] as const) {
        assert.ok(alive(rig, pid), `${name} was killed`);
      }
    } finally {
      rig.killAll();
    }
  });
});

test("N-FORK: a task whose TERM handler forks AFTER its leader died is followed by sid — zero alive, the fork counted; the honest variant reports it", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  const plan = [{ name: "bg", stdout: "task:BG1", script: `set -m; ${FORK_ON_TERM} & wait` }];
  // Positive control (TE fkctl): SIGTERM the inner bash directly ⇒ a new `sleep 600` in the same sid.
  await withRig(plan, async (rig) => {
    const innerPid = await forkLoopInner(rig);
    const before = new Set(rig.sessionMembers(rig.pids.bg).map((e) => e.pid));
    process.kill(rig.pids.bg, "SIGTERM");
    process.kill(innerPid, "SIGTERM");
    const fork = await trapFork(rig, innerPid, before);
    rig.track(fork);
    // v2's leader-gated follow would skip it: the session's leader is already dead.
    assert.ok(!alive(rig, rig.pids.bg), "the leader must be dead for the control to mean anything");
    assert.ok(alive(rig, fork));
  });
  await withRig(plan, async (rig) => {
    await forkLoopInner(rig);
    const snapshot = closerSnapshot(rig, { tasks: [bashTask("BG1")], monitorCommands: [] });
    const admitted = snapshot.members.length;
    const report = await reapSnapshot(snapshot);
    assert.equal(report.survivors, 0);
    assert.ok(report.taskProcesses > admitted, "the fork born at TERM is counted");
    assert.equal(
      rig.sessionMembers(rig.pids.bg).length,
      0,
      "a live member remains in the task's session",
    );
  });
  await withRig(plan, async (rig) => {
    await forkLoopInner(rig);
    const snapshot = closerSnapshot(rig, { tasks: [bashTask("BG1")], monitorCommands: [] });
    const admittedPids = new Set(snapshot.members.map((m) => m.pid));
    // The seam refuses every signal for pids born after admission (the fork): it survives, so the
    // count must name it rather than report survivors:0.
    const refuseLateKill: Signaller = (pid, signal) => {
      if (admittedPids.has(pid)) {
        process.kill(pid, signal);
      }
    };
    const report = await reapSnapshot(snapshot, { graceMs: 300, signal: refuseLateKill });
    const forks = rig.sessionMembers(rig.pids.bg).map((e) => e.pid);
    for (const pid of forks) {
      rig.track(pid);
    }
    assert.equal(report.survivors, forks.length);
    assert.ok(report.survivors >= 1, "the honest count must name the fork");
    assert.deepEqual(
      report.survivorPids.toSorted((a, b) => a - b),
      forks.toSorted((a, b) => a - b),
    );
    assert.equal(taskOutcome({ ...bashTask("BG1"), description: "" }, report, true), "unverified");
  });
});

const MON_CMD = "sleep 301; echo done";

test("N-MON: Proof M admits a Monitor shell (socket stdout, session env, its command in argv) and ends it; four look-alikes are NOT admitted", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withDir(async (dir) => {
    const S = newSessionId("smon");
    const env = { CLAUDE_CODE_SESSION_ID: S };
    const rig = await spawnRig(
      dir,
      [
        { name: "mon", stdout: "socket", script: `eval '${MON_CMD}'`, env },
        {
          name: "otherSession",
          stdout: "socket",
          script: `eval '${MON_CMD}'`,
          env: { CLAUDE_CODE_SESSION_ID: "someone-else" },
        },
        { name: "fileStdout", stdout: "task:FG9", script: `eval '${MON_CMD}'`, env },
        { name: "notInBg", stdout: "socket", script: "eval 'sleep 302; echo other'", env },
        {
          name: "nodeComm",
          stdout: "socket",
          node: true,
          script: `/* eval '${MON_CMD}' */ setInterval(()=>{},1000)`,
          env,
        },
      ],
      S,
    );
    try {
      await sleepOf(rig, rig.pids.mon);
      const bg = {
        tasks: [monitorTask("M1")],
        monitorCommands: [{ taskId: "M1", command: MON_CMD }],
      };
      const snapshot = closerSnapshot(rig, bg);
      assert.deepEqual(
        snapshot.sessions.map((x) => x.sid),
        [rig.pids.mon],
      );
      const report = await reapSnapshot(snapshot);
      assert.equal(report.survivors, 0);
      assert.equal(rig.sessionMembers(rig.pids.mon).length, 0);
      for (const name of ["otherSession", "fileStdout", "notInBg", "nodeComm"]) {
        assert.ok(alive(rig, rig.pids[name]), `${name} was killed`);
      }
    } finally {
      rig.killAll();
    }
  });
});

test("N-MON quoting: a command with ' and \" is admitted after normalization", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  const command = `tail -n0 -F "x.log" | grep -E 'ERR|WARN'`;
  assert.equal(normalizeCommandForMatch(command), "tail -n0 -F x.log | grep -E ERR|WARN");
  await withDir(async (dir) => {
    const S = newSessionId("sq");
    const rig = await spawnRig(
      dir,
      [
        {
          name: "mon",
          stdout: "socket",
          script: `eval "tail -n0 -F \\"x.log\\" | grep -E 'ERR|WARN'"`,
          env: { CLAUDE_CODE_SESSION_ID: S },
        },
      ],
      S,
    );
    try {
      await waitFor(
        () => (rig.sessionMembers(rig.pids.mon).length >= 3 ? true : undefined),
        "the pipeline",
      );
      const snapshot = closerSnapshot(rig, {
        tasks: [monitorTask("M2")],
        monitorCommands: [{ taskId: "M2", command }],
      });
      assert.deepEqual(
        snapshot.sessions.map((x) => x.sid),
        [rig.pids.mon],
      );
      await reapSnapshot(snapshot);
      assert.equal(rig.sessionMembers(rig.pids.mon).length, 0);
    } finally {
      rig.killAll();
    }
  });
});

test("N-SCOPE: a READ-only holder of this session's task file, and a writer of the same task id under ANOTHER session, are not proven and stay alive", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withDir(async (dir) => {
    const S = newSessionId("scope");
    const taskFile = rigTaskFile(dir, S, "BG1");
    await fsp.mkdir(path.dirname(taskFile), { recursive: true });
    await fsp.writeFile(taskFile, "");
    const rig = await spawnRig(
      dir,
      [
        { name: "reader", stdout: "ignore", script: `exec tail -f ${taskFile}` },
        { name: "foreign", stdout: `task:BG1@${S}-other`, script: "set -m; sleep 300 & wait" },
      ],
      S,
    );
    try {
      await sleepOf(rig, rig.pids.foreign);
      const snapshot = closerSnapshot(rig, { tasks: [bashTask("BG1")], monitorCommands: [] });
      assert.deepEqual([snapshot.sessions.length, snapshot.singles.length], [0, 0]);
      await reapSnapshot(snapshot);
      assert.ok(alive(rig, rig.pids.reader) && alive(rig, rig.pids.foreign));
    } finally {
      rig.killAll();
    }
  });
});

test("N-OUTCOME: a proven Bash task reads ended; a live but UNPROVABLE Monitor reads unverified even with survivors:0 — and the K-of-N WARNING fires", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withDir(async (dir) => {
    const S = newSessionId("sout");
    const rig = await spawnRig(
      dir,
      [
        { name: "bg", stdout: "task:T1", script: "set -m; sleep 300 & wait" },
        // Its argv lacks the command BG says it runs: unprovable.
        {
          name: "mon",
          stdout: "socket",
          script: "eval 'sleep 303; echo x'",
          env: { CLAUDE_CODE_SESSION_ID: S },
        },
      ],
      S,
    );
    try {
      await sleepOf(rig, rig.pids.bg);
      const bg = {
        tasks: [bashTask("T1"), monitorTask("T2")],
        monitorCommands: [{ taskId: "T2", command: "tail -n0 -F other.log" }],
      };
      const report = await reapSnapshot(closerSnapshot(rig, bg));
      assert.equal(report.survivors, 0);
      assert.equal(taskOutcome({ ...bashTask("T1"), description: "" }, report, true), "ended");
      assert.equal(
        taskOutcome({ ...monitorTask("T2"), description: "" }, report, true),
        "unverified",
      );
      assert.ok(alive(rig, rig.pids.mon), "the unprovable shell is (by design, RV-3) left alone");
      // The loud warning (HoD, v3), on the CLI side through the survivor reporter.
      const { text } = captureStderr(() => warnReapSurvivors("s-out", report));
      assert.equal(
        text,
        "[acpx] WARNING: session s-out: proof matched 1 of 2 live background tasks — the unmatched ones may survive; Claude Code's task layout may have changed (brick ad6ba1c2)\n",
      );
    } finally {
      rig.killAll();
    }
  });
});

test("K-of-N warning: silent when every process-backed task is proven, or none is live; in-process tasks never count", () => {
  const facts = (process: string[], proven: string[]) => ({
    measured: true,
    processTaskIds: process,
    provenTaskIds: proven,
  });
  assert.equal(unprovenTaskWarning("s", facts(["a", "b"], ["a", "b"])), undefined);
  assert.equal(unprovenTaskWarning("s", facts([], [])), undefined);
  assert.equal(unprovenTaskWarning("s", { ...facts(["a"], []), measured: false }), undefined);
  assert.match(
    unprovenTaskWarning("s", facts(["a", "b", "c"], ["b"])) ?? "",
    /proof matched 1 of 3 live background tasks/,
  );
  const snapshot = snapshotSessionTree({
    bg: {
      tasks: [{ taskId: "agent1", taskType: "local_agent" }, bashTask("b1")],
      monitorCommands: [],
    },
    acpSessionId: "S",
    ownerPid: process.pid,
    procRoot: path.join(os.tmpdir(), "acpx-no-such-proc-root"),
  });
  assert.deepEqual(snapshot.processTaskIds, ["b1"], "a sub-agent has no processes to prove");
});

// ---------------------------------------------------------------------------
// Owner side (§5.2 E, G; path I) through a stand-in owner process.
// ---------------------------------------------------------------------------

type ChildRig = {
  lines: () => Array<Record<string, unknown>>;
  stderr: () => string;
  ready: Record<string, number>;
  ticks: Map<number, string>;
  killAll: () => void;
};

const TASK_KEYS = ["shellPid", "sleepPid", "monShellPid", "monSleepPid"] as const;

async function startChild(dir: string, mode: string): Promise<ChildRig> {
  const outFile = path.join(dir, `${mode}.out`);
  const errFile = path.join(dir, `${mode}.err`);
  const taskRoot = path.join(dir, `claude-${os.userInfo().uid}`, "proj");
  const errFd = fs.openSync(errFile, "a");
  const child = spawn(process.execPath, [CHILD_PATH, mode, outFile, `rig-${mode}`, taskRoot], {
    detached: true,
    stdio: ["ignore", "ignore", errFd],
  });
  fs.closeSync(errFd);
  child.unref();
  const lines = () =>
    fs.existsSync(outFile)
      ? fs
          .readFileSync(outFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
  const ready = (await waitFor(
    () => lines().find((line) => line.ready === true),
    `child ${mode}`,
  )) as Record<string, number>;
  const ticks = new Map<number, string>();
  for (const key of ["ownerPid", "claudePid", ...TASK_KEYS]) {
    const pid = ready[key];
    ticks.set(pid, readEntry(pid)?.startTicks ?? "");
  }
  return {
    lines,
    stderr: () => fs.readFileSync(errFile, "utf8"),
    ready,
    ticks,
    killAll: () => {
      for (const [pid, startTicks] of ticks) {
        const entry = readEntry(pid);
        if (entry?.startTicks === startTicks && entry.state !== "Z") {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // gone
          }
        }
      }
    },
  };
}

function childAlive(rig: ChildRig, key: string): boolean {
  const pid = rig.ready[key];
  const entry = readEntry(pid);
  return (
    entry !== undefined &&
    entry.startTicks === rig.ticks.get(pid) &&
    entry.state !== "Z" &&
    entry.state !== "X"
  );
}

async function settle(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test("O1: SIGTERM to an owner WITH the reaper ends its proven Bash and Monitor tasks and logs it; WITHOUT it (today) both survive", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withDir(async (dir) => {
    const withReaper = await startChild(dir, "fatal");
    const without = await startChild(dir, "fatal-noreap");
    try {
      process.kill(withReaper.ready.ownerPid, "SIGTERM");
      process.kill(without.ready.ownerPid, "SIGTERM");
      assert.ok(
        await settle(() => !childAlive(withReaper, "ownerPid") && !childAlive(without, "ownerPid")),
      );
      assert.ok(
        await settle(() => TASK_KEYS.every((key) => !childAlive(withReaper, key))),
        "a task process survived",
      );
      assert.match(
        withReaper.stderr(),
        /queue owner reaped 4 background task process\(es\) of session rig-fatal after SIGTERM/,
      );
      // NEGATIVE CONTROL: the group SIGKILL alone took claude, never the task processes.
      assert.ok(!childAlive(without, "claudePid"));
      assert.ok(
        TASK_KEYS.every((key) => childAlive(without, key)),
        "the leak must reproduce",
      );
    } finally {
      withReaper.killAll();
      without.killAll();
    }
  });
});

test("O2: the graceful exit reap (admission before the client close) ends both tasks, spares the owner's session, logs once", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withDir(async (dir) => {
    const rig = await startChild(dir, "exit-reap");
    try {
      const result = await waitFor(() => rig.lines().find((line) => "report" in line), "O2 result");
      const report = result.report as Record<string, unknown>;
      assert.deepEqual([report.measured, report.taskProcesses, report.survivors], [true, 4, 0]);
      assert.ok(
        !(result.snapshotPids as number[]).includes(rig.ready.claudePid),
        "the owner's session must never be admitted",
      );
      assert.ok(TASK_KEYS.every((key) => !childAlive(rig, key)));
      assert.match(
        rig.stderr(),
        /queue owner reaped 4 background task process\(es\) of session rig-exit-reap after idle-memory \(survivors=0\)/,
      );
      assert.doesNotMatch(rig.stderr(), /proof matched/, "both tasks were proven: no warning");
    } finally {
      rig.killAll();
    }
  });
});

test("O3b: path I — claude dies first and BOTH task shells reparent out of the tree; the box-wide proofs still end them (no memo)", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withDir(async (dir) => {
    const rig = await startChild(dir, "crash");
    try {
      const probe = await waitFor(
        () => rig.lines().find((line) => "reparented" in line),
        "O3b probe",
      );
      assert.deepEqual(
        probe.reparented,
        [true, true],
        "the shells must have left the tree for this to test path I",
      );
      const result = await waitFor(
        () => rig.lines().find((line) => "report" in line),
        "O3b result",
      );
      const report = result.report as Record<string, unknown>;
      assert.deepEqual([report.taskProcesses, report.survivors], [4, 0]);
      assert.ok(
        TASK_KEYS.every((key) => !childAlive(rig, key)),
        "an orphaned task process survived",
      );
    } finally {
      rig.killAll();
    }
  });
});

test("N-FORK (owner signal handler, path G, no closer): the bounded follow between TERM and KILL catches the TERM-handler's fork; an immediate TERM→KILL (the control) lets it escape", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  const plan = [{ name: "bg", stdout: "task:BG1", script: `set -m; ${FORK_ON_TERM} & wait` }];
  const bg = { tasks: [bashTask("BG1")], monitorCommands: [] };
  // CONTROL (deterministic): KILL that does not FOLLOW — only the pids admitted before TERM, sent
  // once the TERM handler's fork exists (a fork born after a single KILL scan). The fork survives it.
  await withRig(plan, async (rig) => {
    await forkLoopInner(rig);
    const snapshot = closerSnapshot(rig, bg, { ownerPid: process.pid, excludeSelfAncestry: false });
    const admitted = new Set(snapshot.members.map((m) => m.pid));
    signalSnapshot(snapshot, "SIGTERM");
    const fork = await waitFor(
      () =>
        rig.sessionMembers(rig.pids.bg).find((e) => e.comm === "sleep" && !admitted.has(e.pid))
          ?.pid,
      "the TERM handler's fork",
    );
    rig.track(fork);
    for (const member of snapshot.members) {
      if (alive(rig, member.pid)) {
        process.kill(member.pid, "SIGKILL");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(
      alive(rig, fork),
      "the control must show a non-following KILL leaving the fork alive",
    );
  });
  await withRig(plan, async (rig) => {
    await forkLoopInner(rig);
    const reaper = createOwnerTaskReaper({
      getTaskSet: () => bg,
      getAcpSessionId: () => rig.acpSessionId,
    });
    const signalReap = createOwnerSignalReap("fork-g", reaper);
    const { text } = captureStderr(() => {
      signalReap.term();
      signalReap.kill("SIGTERM");
    });
    assert.match(text, /reaped \d+ background task process\(es\) of session fork-g after SIGTERM/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const left = rig.sessionMembers(rig.pids.bg);
    for (const member of left) {
      rig.track(member.pid);
    }
    assert.deepEqual(
      left.map((e) => e.comm),
      [],
      "a fork escaped the signal handler",
    );
  });
});
