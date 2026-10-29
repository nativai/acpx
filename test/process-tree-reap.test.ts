import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { warnReapSurvivors } from "../src/cli/background-task-gate.js";
import { formatOwnerReapLine } from "../src/cli/session/owner-task-reap.js";
import {
  parseProcStat,
  reapSnapshot,
  signalSnapshot,
  snapshotSessionTree,
  type Signaller,
} from "../src/process-tree-reap.js";

// brick ad6ba1c2 — the reap module (CONCEPTION §5.1, §10 R1–R5) against REAL process trees shaped
// like the production one: owner (group leader) → adapter → setsid'd task shell → `sleep` in a third
// group. Plus the owner-side paths O1–O3 through `bg-task-owner-child.ts`.

const CHILD_PATH = fileURLToPath(new URL("./bg-task-owner-child.js", import.meta.url));
const linux = process.platform === "linux";

function entry(pid: number) {
  try {
    return parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
}

function aliveAs(pid: number, startTicks: string): boolean {
  const current = entry(pid);
  return current?.startTicks === startTicks && current.state !== "Z" && current.state !== "X";
}

async function waitFor<T>(read: () => T | undefined, what: string, timeoutMs = 15_000): Promise<T> {
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

type Tree = {
  ownerPid: number;
  adapterPid: number;
  shellPid: number;
  sleepPid: number;
  nestedOwnerPid?: number;
  nestedChildPid?: number;
  ticks: Map<number, string>;
  killAll: () => void;
};

/**
 * owner (detached: group + session leader) → adapter (same group) → task shell (setsid) → sleep
 * (`set -m`: its own group, same session). With `nested`, the task shell ALSO runs a "cli" whose
 * child is a detached node carrying the `__queue-owner` argv token, plus that owner's own child —
 * another session's owner spawned by an agent inside this one (D12).
 */
async function spawnTree(dir: string, options: { nested?: boolean } = {}): Promise<Tree> {
  const pidFile = path.join(dir, `tree-${Date.now()}-${Math.random()}.json`);
  const nestedOwner =
    "const{spawn}=require('node:child_process');" +
    "spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
    "setInterval(()=>{},1000);";
  const cli = options.nested
    ? `node -e "require('node:child_process').spawn(process.execPath,['-e',process.argv[1],'__queue-owner'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)" "${nestedOwner}" & `
    : "";
  const shellScript = `set -m; ${cli}sleep 300 & wait`;
  const adapter =
    "const{spawn}=require('node:child_process');const fs=require('node:fs');" +
    `const s=spawn('bash',['-c',${JSON.stringify(shellScript)}],{detached:true,stdio:'ignore'});` +
    "fs.writeFileSync(process.argv[1],JSON.stringify({adapterPid:process.pid,shellPid:s.pid}));" +
    "setInterval(()=>{},1000);";
  const owner =
    "const{spawn}=require('node:child_process');" +
    "spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'ignore'});" +
    "setInterval(()=>{},1000);";
  const ownerChild = spawn(process.execPath, ["-e", owner, adapter, pidFile], {
    detached: true,
    stdio: "ignore",
  });
  ownerChild.unref();
  const ownerPid = ownerChild.pid as number;
  const written = await waitFor(
    () =>
      fs.existsSync(pidFile)
        ? (JSON.parse(fs.readFileSync(pidFile, "utf8")) as { adapterPid: number; shellPid: number })
        : undefined,
    "the tree",
  );
  const all = () => [...fs.readdirSync("/proc")].filter((n) => /^\d+$/.test(n)).map(Number);
  const sleepPid = await waitFor(
    () =>
      all().find((pid) => {
        const e = entry(pid);
        return e?.sid === written.shellPid && e.comm === "sleep";
      }),
    "the sleep",
  );
  let nestedOwnerPid: number | undefined;
  let nestedChildPid: number | undefined;
  if (options.nested) {
    // Scoped to THIS tree: other test files spawn real `__queue-owner` processes concurrently, so a
    // box-wide match would latch onto a foreign owner (it did, once, in the full suite).
    const cliPid = await waitFor(
      () =>
        all().find((pid) => {
          const e = entry(pid);
          return e?.sid === written.shellPid && e.comm === "node";
        }),
      "the nested cli",
    );
    nestedOwnerPid = await waitFor(
      () =>
        all().find((pid) => {
          const e = entry(pid);
          return (
            e !== undefined &&
            e.ppid === cliPid &&
            e.pid === e.sid &&
            fs.readFileSync(`/proc/${pid}/cmdline`, "latin1").includes("\0__queue-owner")
          );
        }),
      "the nested owner",
    );
    nestedChildPid = await waitFor(
      () => all().find((pid) => entry(pid)?.ppid === nestedOwnerPid),
      "the nested owner's child",
    );
  }
  const pids = [ownerPid, written.adapterPid, written.shellPid, sleepPid];
  const extra = [nestedOwnerPid, nestedChildPid].filter((p): p is number => p !== undefined);
  const ticks = new Map<number, string>();
  for (const pid of [...pids, ...extra]) {
    ticks.set(pid, entry(pid)?.startTicks ?? "");
  }
  // Also every process in the task session (the nested "cli") — teardown by verified pid only.
  for (const pid of all()) {
    const e = entry(pid);
    if (e?.sid === written.shellPid) {
      ticks.set(pid, e.startTicks);
    }
  }
  return {
    ownerPid,
    adapterPid: written.adapterPid,
    shellPid: written.shellPid,
    sleepPid,
    nestedOwnerPid,
    nestedChildPid,
    ticks,
    killAll: () => {
      for (const [pid, startTicks] of ticks) {
        if (aliveAs(pid, startTicks)) {
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

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "acpx-reap-"));
  try {
    await run(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("R1: a setsid'd task pair SURVIVES the owner's group kill (the leak is real) and the sid reap ends it", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withDir(async (dir) => {
    const tree = await spawnTree(dir);
    try {
      const shellEntry = entry(tree.shellPid);
      const sleepEntry = entry(tree.sleepPid);
      assert.equal(shellEntry?.sid, tree.shellPid, "the task shell leads its own session");
      assert.notEqual(sleepEntry?.pgid, shellEntry?.pgid, "the command sits in a third group");
      const snapshot = snapshotSessionTree({
        rootPid: tree.ownerPid,
        rootStartTicks: tree.ticks.get(tree.ownerPid),
        includeRoot: true,
        excludeSelfAncestry: true,
      });
      assert.equal(snapshot.measured, true);
      const members = snapshot.members.map((m) => m.pid).toSorted((a, b) => a - b);
      assert.deepEqual(
        members,
        [tree.ownerPid, tree.adapterPid, tree.shellPid, tree.sleepPid].toSorted((a, b) => a - b),
      );

      // NEGATIVE CONTROL: today's mechanism, the owner's process-group SIGKILL.
      process.kill(-tree.ownerPid, "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(!aliveAs(tree.adapterPid, tree.ticks.get(tree.adapterPid) as string));
      assert.ok(
        aliveAs(tree.shellPid, tree.ticks.get(tree.shellPid) as string) &&
          aliveAs(tree.sleepPid, tree.ticks.get(tree.sleepPid) as string),
        "the rig must reproduce the leak, or this test proves nothing",
      );

      const report = await reapSnapshot(snapshot);
      assert.equal(report.measured, true);
      assert.equal(report.taskProcesses, 2);
      assert.equal(report.survivors, 0);
      assert.ok(!aliveAs(tree.shellPid, tree.ticks.get(tree.shellPid) as string));
      assert.ok(!aliveAs(tree.sleepPid, tree.ticks.get(tree.sleepPid) as string));
    } finally {
      tree.killAll();
    }
  });
});

test("R2: a nested acpx owner (argv token __queue-owner) and its child are pruned — the task session is still ended", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withDir(async (dir) => {
    const tree = await spawnTree(dir, { nested: true });
    const nestedOwner = tree.nestedOwnerPid as number;
    const nestedChild = tree.nestedChildPid as number;
    try {
      const input = {
        rootPid: tree.ownerPid,
        includeRoot: true,
        excludeSelfAncestry: true,
      };
      // NEGATIVE CONTROL: without the prune the nested owner IS a member — the reap would kill it.
      const unpruned = snapshotSessionTree({ ...input, isNestedOwner: () => false });
      assert.ok(unpruned.members.some((m) => m.pid === nestedOwner));
      assert.ok(unpruned.members.some((m) => m.pid === nestedChild));

      const snapshot = snapshotSessionTree(input);
      assert.ok(!snapshot.members.some((m) => m.pid === nestedOwner), "nested owner not pruned");
      assert.ok(!snapshot.members.some((m) => m.pid === nestedChild), "its child not pruned");
      const report = await reapSnapshot(snapshot);
      assert.equal(report.survivors, 0);
      assert.ok(!aliveAs(tree.sleepPid, tree.ticks.get(tree.sleepPid) as string));
      assert.ok(aliveAs(nestedOwner, tree.ticks.get(nestedOwner) as string), "nested owner killed");
      assert.ok(aliveAs(nestedChild, tree.ticks.get(nestedChild) as string), "its child killed");
    } finally {
      tree.killAll();
    }
  });
});

/** A synthetic /proc: `<root>/<pid>/stat` files the test controls. */
function writeStat(
  root: string,
  e: { pid: number; ppid: number; pgid: number; sid: number; ticks: string; comm?: string },
) {
  fs.mkdirSync(path.join(root, String(e.pid)), { recursive: true });
  // Fields after ")": state ppid pgrp session, then tty_nr … itrealvalue (15), then starttime.
  const after = ["S", e.ppid, e.pgid, e.sid, ...Array<string>(15).fill("0"), e.ticks];
  fs.writeFileSync(
    path.join(root, String(e.pid), "stat"),
    `${e.pid} (${e.comm ?? "sleep"}) ${after.join(" ")} 0 0\n`,
  );
}

test("R3: pid reuse — a member whose start ticks changed is NEVER signalled (positive control: unchanged is)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-fakeproc-"));
  try {
    writeStat(root, { pid: 1000, ppid: 1, pgid: 1000, sid: 1000, ticks: "10", comm: "node" });
    writeStat(root, { pid: 1001, ppid: 1000, pgid: 1001, sid: 1001, ticks: "11", comm: "bash" });
    writeStat(root, { pid: 1002, ppid: 1001, pgid: 1002, sid: 1001, ticks: "12" });
    const snapshot = snapshotSessionTree({
      rootPid: 1000,
      includeRoot: false,
      procRoot: root,
      isNestedOwner: () => false,
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
    // The number 1002 now names a DIFFERENT process (new start ticks), and so does the leader.
    writeStat(root, { pid: 1002, ppid: 1, pgid: 1002, sid: 1002, ticks: "99" });
    writeStat(root, { pid: 1001, ppid: 1, pgid: 1001, sid: 1001, ticks: "98", comm: "bash" });
    assert.equal(signalSnapshot(snapshot, "SIGKILL", recorder), 0);
    assert.deepEqual(signalled, [], "a reused pid was signalled");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("R4: /proc not measurable — measured:false, never a census", async () => {
  const snapshot = snapshotSessionTree({
    rootPid: process.pid,
    includeRoot: false,
    procRoot: path.join(os.tmpdir(), "acpx-no-such-proc-root"),
  });
  assert.equal(snapshot.measured, false);
  assert.equal(snapshot.skipped, "identity-unverified");
  const report = await reapSnapshot(snapshot);
  assert.equal(report.measured, false);
  assert.equal(report.survivors, 0);
  assert.equal(report.taskProcesses, 0);
  assert.match(formatOwnerReapLine("s", "SIGTERM", report), /could NOT census .*\(measured=false/);
});

test("R5: a survivor is reported (count, pid, comm) on stderr and in the owner.log line — never silent", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withDir(async (dir) => {
    const tree = await spawnTree(dir);
    try {
      const snapshot = snapshotSessionTree({
        rootPid: tree.ownerPid,
        includeRoot: true,
        excludeSelfAncestry: true,
      });
      // The seam swallows every signal for the `sleep` (a D-state process in production).
      const swallowSleep: Signaller = (pid, signal) => {
        if (pid !== tree.sleepPid) {
          process.kill(pid, signal);
        }
      };
      const report = await reapSnapshot(snapshot, {
        graceMs: 400,
        killWaitMs: 100,
        signal: swallowSleep,
      });
      assert.equal(report.measured, true);
      assert.equal(report.survivors, 1);
      assert.deepEqual(report.survivorPids, [tree.sleepPid]);
      assert.equal(report.survivorDetails[0]?.comm, "sleep");

      const written: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => {
        written.push(chunk);
        return true;
      }) as typeof process.stderr.write;
      try {
        warnReapSurvivors("r5-session", report);
      } finally {
        process.stderr.write = original;
      }
      assert.match(
        written.join(""),
        new RegExp(
          `WARNING: 1 process\\(es\\) of session r5-session survived SIGKILL: pid ${tree.sleepPid} \\(sleep, start \\d+\\)`,
        ),
      );
      assert.match(
        formatOwnerReapLine("r5-session", "idle-memory", report),
        new RegExp(
          `reaped 2 background task process\\(es\\) of session r5-session after idle-memory \\(survivors=1: pid ${tree.sleepPid} \\(sleep, start \\d+\\)\\)`,
        ),
      );
    } finally {
      tree.killAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Owner side (§5.2 E, G; §5.4) through a stand-in owner process.
// ---------------------------------------------------------------------------

type ChildRig = {
  lines: () => Array<Record<string, unknown>>;
  stderr: () => string;
  ready: Record<string, number>;
  ticks: Map<number, string>;
  killAll: () => void;
};

async function startChild(dir: string, mode: string): Promise<ChildRig> {
  const outFile = path.join(dir, `${mode}.out`);
  const errFile = path.join(dir, `${mode}.err`);
  const errFd = fs.openSync(errFile, "a");
  const child = spawn(process.execPath, [CHILD_PATH, mode, outFile, `rig-${mode}`], {
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
  for (const key of ["ownerPid", "adapterPid", "shellPid", "sleepPid"]) {
    const pid = ready[key];
    ticks.set(pid, entry(pid)?.startTicks ?? "");
  }
  return {
    lines,
    stderr: () => fs.readFileSync(errFile, "utf8"),
    ready,
    ticks,
    killAll: () => {
      for (const [pid, startTicks] of ticks) {
        if (aliveAs(pid, startTicks)) {
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

function alive(rig: ChildRig, key: string): boolean {
  const pid = rig.ready[key];
  return aliveAs(pid, rig.ticks.get(pid) as string);
}

async function settle(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test("O1: SIGTERM to an owner WITH the reaper ends its setsid'd task pair and logs it; WITHOUT it (today's code) the pair survives", async (t) => {
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
      assert.ok(await settle(() => !alive(withReaper, "ownerPid") && !alive(without, "ownerPid")));
      assert.ok(
        await settle(() => !alive(withReaper, "shellPid") && !alive(withReaper, "sleepPid")),
      );
      assert.ok(!alive(withReaper, "adapterPid"));
      assert.match(
        withReaper.stderr(),
        /queue owner reaped 2 background task process\(es\) of session rig-fatal after SIGTERM/,
      );
      // NEGATIVE CONTROL: the group SIGKILL alone took the adapter, never the task pair.
      assert.ok(!alive(without, "adapterPid"));
      assert.ok(
        alive(without, "shellPid") && alive(without, "sleepPid"),
        "the leak must reproduce",
      );
    } finally {
      withReaper.killAll();
      without.killAll();
    }
  });
});

test("O2: the graceful exit reap (snapshot before the client close) ends the task pair, spares the owner's own group, logs once", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withDir(async (dir) => {
    const rig = await startChild(dir, "exit-reap");
    try {
      const result = await waitFor(() => rig.lines().find((line) => "report" in line), "O2 result");
      const report = result.report as Record<string, unknown>;
      assert.equal(report.measured, true);
      assert.equal(report.taskProcesses, 2);
      assert.equal(report.survivors, 0);
      const snapshotPids = result.snapshotPids as number[];
      assert.ok(
        !snapshotPids.includes(rig.ready.adapterPid),
        "the owner-side reap must never signal its own group (the adapter, claude)",
      );
      assert.ok(!alive(rig, "shellPid") && !alive(rig, "sleepPid"));
      assert.match(
        rig.stderr(),
        /queue owner reaped 2 background task process\(es\) of session rig-exit-reap after idle-memory \(survivors=0\)/,
      );
    } finally {
      rig.killAll();
    }
  });
});

test("O3: remembered task sessions — the 'claude' dies first and orphans the pair OUT of the tree; the exit reap still ends it", async (t) => {
  if (!linux) {
    t.skip("linux /proc");
    return;
  }
  await withDir(async (dir) => {
    const rig = await startChild(dir, "remembered");
    try {
      const probe = await waitFor(
        () => rig.lines().find((line) => "treeOnlyTaskMembers" in line),
        "O3 probe",
      );
      // NEGATIVE CONTROL: from the tree alone the orphaned pair is invisible.
      assert.equal(probe.treeOnlyTaskMembers, 0);
      assert.equal(probe.remembered, 1);
      const result = await waitFor(() => rig.lines().find((line) => "report" in line), "O3 result");
      const report = result.report as Record<string, unknown>;
      assert.equal(report.survivors, 0);
      assert.equal(report.taskProcesses, 2);
      assert.ok(!alive(rig, "shellPid") && !alive(rig, "sleepPid"), "the orphan survived");
    } finally {
      rig.killAll();
    }
  });
});
