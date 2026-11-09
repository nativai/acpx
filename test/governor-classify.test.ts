import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  cachedTokenState,
  classifySessions,
  type ClassifyContext,
  entrypointSid,
  type GroupRecord,
  isExemptTerminal,
  loadGroupMemory,
  parseGovProcStat,
  type Placement,
  saveGroupMemory,
} from "../src/capacity/governor/classify.js";
import {
  protectedReason,
  sweepSession,
  type GuardContext,
} from "../src/capacity/governor/sweep.js";
import { queueOwnerTokenState, scanProcTable } from "../src/process-tree-reap.js";
import { FakeBox, type FakeProcess } from "./governor-fixtures.js";

// brick 5d7a23b6 — CONCEPTION §3 (positive origin), §5.1 (the sweep and its guard), §11 unit rows.
// Every /proc here is a fixture tree (test/governor-fixtures.ts); the signal sink plays the kernel.

function classify(
  box: FakeBox,
  leaseOwners = new Map<number, { sessionId?: string; seatId?: string }>(),
) {
  const byPid = scanProcTable(box.proc, parseGovProcStat).byPid;
  const ctx: ClassifyContext = {
    systemSid: 6,
    leaseOwners,
    tokenState: (pid) => queueOwnerTokenState(pid, box.proc),
  };
  const memory = new Map<number, GroupRecord>();
  return { ...classifySessions(byPid, ctx, memory, box.nowMs), memory, byPid, ctx };
}

function placementOf(
  box: FakeBox,
  sid: number,
  leaseOwners?: Map<number, { sessionId?: string; seatId?: string }>,
): Placement {
  const view = classify(box, leaseOwners).sessions.get(sid);
  assert.ok(view, `session ${sid} exists`);
  return view.record.placement;
}

test("classify: a Bash tool command under `claude` is a TOOL session, attributed to its owner's lease and seat", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-aaaa-1111", "seat-1");
  box.toolSession(200, claudePid, 3);
  const leases = new Map([[100, { sessionId: "sess-aaaa-1111", seatId: "seat-1" }]]);
  const placement = placementOf(box, 200, leases);
  assert.deepEqual(placement, {
    governed: true,
    kind: "tool",
    root: "tool",
    attribution: { label: "acpx-session", sessionId: "sess-aaaa-1111", seatId: "seat-1" },
  });
  // The owner tree itself is never governed (argv token) — §3.3 always wins.
  assert.deepEqual(placementOf(box, 100, leases), { governed: false, reason: "owner" });
});

test("classify: an owner known only by its argv token attributes its tool sessions as pid:<n>", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-x", "seat-x");
  box.toolSession(200, claudePid, 2);
  const placement = placementOf(box, 200, new Map());
  assert.equal(placement.governed && placement.attribution.label, "pid:100");
});

test("classify: a `node` at the harness position (owner → adapter → node) creates tool sessions; `tmux` there does NOT", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.add({ pid: 100, ppid: 1, comm: "node", owner: true });
  box.add({ pid: 101, ppid: 100, pgid: 100, sid: 100, comm: "node" });
  box.add({ pid: 102, ppid: 101, pgid: 100, sid: 100, comm: "node" }); // Pi harness
  box.add({ pid: 103, ppid: 101, pgid: 100, sid: 100, comm: "tmux: server" });
  box.add({ pid: 300, ppid: 102, comm: "bash" });
  box.add({ pid: 400, ppid: 103, comm: "bash" });
  assert.equal(
    placementOf(box, 300).governed && (placementOf(box, 300) as { kind: string }).kind,
    "tool",
  );
  assert.deepEqual(placementOf(box, 400), { governed: false, reason: "outside" });
});

test("classify: a `codex` parent creates tool sessions too", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.add({ pid: 100, ppid: 1, comm: "node", owner: true });
  box.add({ pid: 101, ppid: 100, pgid: 100, sid: 100, comm: "codex" });
  box.add({ pid: 300, ppid: 101, comm: "bash" });
  const p = placementOf(box, 300);
  assert.equal(p.governed && p.kind, "tool");
});

test("classify: TERMINAL sessions — a shell whose parent is in the system session (ttyd, VS Code) or is sshd", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.add({ pid: 500, ppid: 41, comm: "bash", tty: 34816 }); // ttyd
  box.add({ pid: 510, ppid: 43, comm: "bash", tty: 34817 }); // VS Code pty host (node)
  box.add({ pid: 520, ppid: 1, comm: "sshd-session" }); // per-connection sshd, own session
  box.add({ pid: 521, ppid: 520, comm: "bash" });
  box.add({ pid: 530, ppid: 40, comm: "python3" }); // a non-shell child of atrium in a new session
  const labels = [500, 510, 521].map((sid) => {
    const p = placementOf(box, sid);
    return p.governed ? `${p.kind}:${p.attribution.label}` : "ungoverned";
  });
  assert.deepEqual(labels, ["terminal:ttyd", "terminal:vscode", "terminal:ssh"]);
  assert.deepEqual(placementOf(box, 530), { governed: false, reason: "outside" });
});

test("classify: a DERIVED session (setsid inside a command) inherits the parent's lineage root and attribution", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-d", "seat-d");
  box.toolSession(200, claudePid, 2);
  box.add({ pid: 250, ppid: 201, comm: "job.sh" }); // setsid ./job.sh inside the tool command
  box.add({ pid: 600, ppid: 41, comm: "bash", tty: 34816 });
  box.add({ pid: 650, ppid: 600, comm: "sleep" }); // setsid from a ttyd terminal
  const leases = new Map([[100, { sessionId: "sess-d", seatId: "seat-d" }]]);
  assert.deepEqual(placementOf(box, 250, leases), {
    governed: true,
    kind: "derived",
    root: "tool",
    attribution: { label: "acpx-session", sessionId: "sess-d", seatId: "seat-d" },
  });
  const terminalChild = placementOf(box, 650);
  assert.equal(terminalChild.governed && terminalChild.root, "terminal");
});

test("classify: LEADERLESS — governed unless a live member is a VERIFIED owner (token or lease); a member merely NAMED claude is governed (§19 D1, TE X6)", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.addMany(5, { ppid: 1, pgid: 701, sid: 700, comm: "bash" }, 701); // leader 700 is gone
  box.addMany(3, { ppid: 1, pgid: 801, sid: 800, comm: "claude" }, 801); // renamed binary / nested claude
  box.add({ pid: 901, ppid: 1, pgid: 901, sid: 900, comm: "node", owner: true }); // a real owner, token
  box.add({ pid: 951, ppid: 1, pgid: 951, sid: 950, comm: "node" }); // a real owner, lease only
  const leases = new Map([[951, { sessionId: "sess-951" }]]);
  const leaderless = {
    governed: true,
    kind: "leaderless",
    root: "unknown",
    attribution: { label: "unknown" },
  };
  assert.deepEqual(placementOf(box, 700, leases), leaderless);
  assert.deepEqual(placementOf(box, 800, leases), leaderless, "a comm name never exempts");
  assert.deepEqual(placementOf(box, 900, leases), { governed: false, reason: "owner" });
  assert.deepEqual(placementOf(box, 950, leases), { governed: false, reason: "owner" });
});

test("classify: a REMEMBERED kind wins over every first-sight test (§19 D1a)", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-r", "seat-r");
  box.toolSession(200, claudePid, 3);
  const leases = new Map([[100, { sessionId: "sess-r", seatId: "seat-r" }]]);
  const first = classify(box, leases);
  // The leader dies and a member becomes a token-carrying process: a first-sight test would now say
  // "owner remains"; the memory of a tool session must win (the guard still never signals the owner).
  box.remove(200);
  box.add({ ...(box.procs.get(201) as FakeProcess), owner: true });
  const byPid = scanProcTable(box.proc, parseGovProcStat).byPid;
  const ctx: ClassifyContext = {
    systemSid: 6,
    leaseOwners: leases,
    tokenState: (pid) => queueOwnerTokenState(pid, box.proc),
  };
  const view = classifySessions(byPid, ctx, first.memory, box.nowMs).sessions.get(200);
  assert.equal(view?.record.placement.governed && view.record.placement.kind, "tool");
  assert.equal(
    classifySessions(byPid, ctx, new Map(), box.nowMs).sessions.get(200)?.record.placement.governed,
    false,
    "control: without memory it reads owner",
  );
});

test("classify: born OUTSIDE a governed session — parent PID 1, or started by an owner session — is never governed", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.owner(100, "sess-o");
  box.add({ pid: 900, ppid: 1, comm: "agent-browser" }); // a boot daemon
  box.add({ pid: 910, ppid: 101, comm: "ssh" }); // the adapter starts a ControlMaster in a new session
  assert.deepEqual(placementOf(box, 900), { governed: false, reason: "outside" });
  assert.deepEqual(placementOf(box, 910), { governed: false, reason: "outside" });
});

test("classify: a CHILD OWNER started under a tool command (blocking `acpx prompt`, F18) is an owner, never governed — by token and by lease", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-p");
  box.toolSession(200, claudePid, 2);
  box.add({ pid: 260, ppid: 201, comm: "node", owner: true }); // token
  box.add({ pid: 270, ppid: 201, comm: "node" }); // lease only
  const leases = new Map([
    [100, { sessionId: "sess-p" }],
    [270, { sessionId: "child-2" }],
  ]);
  assert.deepEqual(placementOf(box, 260, leases), { governed: false, reason: "owner" });
  assert.deepEqual(placementOf(box, 270, leases), { governed: false, reason: "owner" });
});

test("classify: the system session is never governed; entrypointSid is PID 1's EARLIEST child", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.add({ pid: 3, ppid: 1, comm: "late", ticks: 99_999 });
  const { byPid } = classify(box);
  assert.equal(entrypointSid(byPid), 6);
  assert.deepEqual(placementOf(box, 6), { governed: false, reason: "system" });
});

test("classify: a kind is decided at FIRST SIGHT and remembered; groups.json carries it across a restart (leaderless keeps attribution)", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-m", "seat-m");
  box.toolSession(200, claudePid, 4);
  const leases = new Map([[100, { sessionId: "sess-m", seatId: "seat-m" }]]);
  const first = classify(box, leases);
  const file = `${box.root}/groups.json`;
  saveGroupMemory(file, first.memory);
  // The tool call is stopped: its shell dies, the remainder is reparented to PID 1 (wave 2).
  box.remove(200);
  for (const pid of [201, 202, 203]) {
    box.add({ ...(box.procs.get(pid) as FakeProcess), ppid: 1 });
  }
  const memory = loadGroupMemory(file);
  const byPid = scanProcTable(box.proc, parseGovProcStat).byPid;
  const ctx: ClassifyContext = {
    systemSid: 6,
    leaseOwners: leases,
    tokenState: (pid) => queueOwnerTokenState(pid, box.proc),
  };
  const view = classifySessions(byPid, ctx, memory, box.nowMs).sessions.get(200);
  assert.ok(view);
  assert.equal(view.orphaned, true);
  assert.deepEqual(view.record.placement, first.sessions.get(200)?.record.placement);
  // Without the memory the same remainder is still governed — leaderless, attribution unknown (AC2 variant).
  const fresh = classifySessions(byPid, ctx, new Map(), box.nowMs).sessions.get(200);
  assert.deepEqual(fresh?.record.placement, {
    governed: true,
    kind: "leaderless",
    root: "unknown",
    attribution: { label: "unknown" },
  });
});

test("classify: governTerminals:false exempts ttyd and VS Code lineages only — ssh and tool sessions stay governed (§18 C3)", () => {
  const terminal = (label: string): Placement => ({
    governed: true,
    kind: "terminal",
    root: "terminal",
    attribution: { label },
  });
  assert.equal(isExemptTerminal(terminal("ttyd"), false), true);
  assert.equal(isExemptTerminal(terminal("vscode"), false), true);
  assert.equal(
    isExemptTerminal({ ...terminal("ttyd"), kind: "derived" } as Placement, false),
    true,
  );
  assert.equal(isExemptTerminal(terminal("ssh"), false), false);
  assert.equal(isExemptTerminal(terminal("ttyd"), true), false);
  assert.equal(
    isExemptTerminal(
      { governed: true, kind: "tool", root: "tool", attribution: { label: "unknown" } },
      false,
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// The guard and the sweep (§3.3, §5.1)
// ---------------------------------------------------------------------------

function guardFor(box: FakeBox, leaseOwnerPids: number[] = []): GuardContext {
  return {
    systemSid: 6,
    selfPid: 50,
    leaseOwnerPids: new Set(leaseOwnerPids),
    tokenState: (pid) => queueOwnerTokenState(pid, box.proc),
    stillAlive: (proc) => box.procs.has(proc.pid),
  };
}

function sweepDeps(box: FakeBox, guard: GuardContext) {
  return {
    scan: () => scanProcTable(box.proc, parseGovProcStat).byPid,
    signal: box.signal,
    guard,
    sleepSync: () => {},
    now: () => box.nowMs,
    recordStops: () => {},
  };
}

test("sweep: every pgid of the session is group-SIGKILLed until empty; nothing outside the session is touched", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-s");
  box.toolSession(200, claudePid, 6);
  box.add({ pid: 210, ppid: 201, pgid: 210, sid: 200, comm: "cat" }); // a third group
  const result = sweepSession(sweepDeps(box, guardFor(box)), {
    sid: 200,
    rounds: 10,
    roundIntervalMs: 10,
  });
  assert.equal(result.survivors, 0);
  assert.deepEqual(
    box.groupKills().toSorted((a, b) => a - b),
    [200, 201, 210],
  );
  assert.ok(box.procs.has(100) && box.procs.has(102), "owner tree untouched");
  assert.ok(box.procs.has(40), "system session untouched");
});

test("sweep U1: a pgid holding PID-1's group, the governor or an owner (token or lease) NEVER gets a group signal", (t) => {
  const cases: Array<{
    label: string;
    plant: (box: FakeBox) => void;
    leases: number[];
    selfPid: number;
    guarded: number;
  }> = [
    {
      label: "owner by argv token",
      plant: (box) =>
        box.add({ pid: 260, ppid: 201, pgid: 201, sid: 200, comm: "node", owner: true }),
      leases: [],
      selfPid: 50,
      guarded: 201,
    },
    {
      label: "owner by lease",
      plant: (box) => box.add({ pid: 260, ppid: 201, pgid: 201, sid: 200, comm: "node" }),
      leases: [260],
      selfPid: 50,
      guarded: 201,
    },
    {
      label: "the governor",
      plant: (box) => box.add({ pid: 260, ppid: 201, pgid: 201, sid: 200, comm: "node" }),
      leases: [],
      selfPid: 260,
      guarded: 201,
    },
    {
      label: "process group 1",
      plant: (box) => box.add({ pid: 260, ppid: 201, pgid: 1, sid: 200, comm: "node" }),
      leases: [],
      selfPid: 50,
      guarded: 1,
    },
  ];
  for (const c of cases) {
    const box = new FakeBox();
    t.after(() => box.cleanup());
    box.standardSystem();
    const { claudePid } = box.owner(100, "sess-u1");
    box.toolSession(200, claudePid, 5);
    c.plant(box);
    const guard = { ...guardFor(box, c.leases), selfPid: c.selfPid };
    const result = sweepSession(sweepDeps(box, guard), {
      sid: 200,
      rounds: 10,
      roundIntervalMs: 10,
    });
    assert.ok(
      !box.groupKills().includes(c.guarded),
      `${c.label}: pgid ${c.guarded} was group-signalled`,
    );
    assert.ok(box.procs.has(260), `${c.label}: the protected process survived`);
    assert.ok(
      !box.signals.some((s) => s.target === 260),
      `${c.label}: never signalled per pid either`,
    );
    assert.deepEqual(result.guardedPgids, [c.guarded], c.label);
    assert.ok(!box.procs.has(200), `${c.label}: the rest of the session still dies`);
  }
});

test("sweep U1: sweeping the SYSTEM session (or an owner session) signals nothing at all", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.owner(100, "sess-sys");
  for (const sid of [6, 100]) {
    const result = sweepSession(sweepDeps(box, guardFor(box)), {
      sid,
      rounds: 10,
      roundIntervalMs: 10,
    });
    assert.ok(result.guardedPgids.length > 0);
  }
  assert.deepEqual(box.signals, []);
  assert.ok(box.procs.has(40) && box.procs.has(102));
});

test("F12: the token cache keeps only POSITIVE answers — a process read `absent` that execs into a queue owner (same pid, same start ticks) is an owner at the next check, so the guard protects it", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-f12");
  box.toolSession(200, claudePid, 3);
  const byPid = () => scanProcTable(box.proc, parseGovProcStat).byPid;
  const cache = new Map<string, "owner" | "absent" | "unreadable">();
  const token = cachedTokenState(box.proc, byPid, cache);
  assert.equal(token(201), "absent");
  // node's detached spawn: fork -> setsid -> EXEC into `__queue-owner`. exec keeps pid and start ticks.
  const before = box.procs.get(201) as FakeProcess;
  box.add({ ...before, owner: true });
  assert.equal(box.procs.get(201)?.ticks, before.ticks, "same start ticks");
  assert.equal(token(201), "owner", "a negative is re-read, never served from the cache");
  const guard = { ...guardFor(box), tokenState: token };
  assert.equal(protectedReason(byPid().get(201)!, guard), "owner-token");
  // A positive IS cached: it survives even if the argv read would now fail.
  fs.rmSync(`${box.proc}/201/cmdline`);
  assert.equal(token(201), "owner");
});

test("sweep: protectedReason refuses pid 1, the system session, the governor, owners; an unreadable LIVE argv is unproven", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const plain = box.add({ pid: 300, ppid: 1, comm: "bash" });
  const owner = box.add({ pid: 310, ppid: 1, comm: "node", owner: true });
  const byPid = scanProcTable(box.proc, parseGovProcStat).byPid;
  const g = guardFor(box);
  assert.equal(protectedReason(byPid.get(300)!, g), undefined);
  assert.equal(protectedReason(byPid.get(310)!, g), "owner-token");
  assert.equal(protectedReason(byPid.get(40)!, g), "system");
  assert.equal(protectedReason(byPid.get(50)!, { ...g, systemSid: 999 }), "governor");
  const unreadable = { ...g, tokenState: () => "unreadable" as const };
  assert.equal(protectedReason(byPid.get(300)!, unreadable), "owner-unverified");
  assert.equal(
    protectedReason(byPid.get(300)!, { ...unreadable, stillAlive: () => false }),
    undefined,
    "a member that already died protects nothing",
  );
  void plain;
  void owner;
});

test("sweep: a terminal's spared leader group stays; the fallback STOPs top-down and records stops before sending", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.add({ pid: 500, ppid: 41, comm: "bash", tty: 34816 });
  box.addMany(4, { ppid: 500, pgid: 501, sid: 500, comm: "bash" }, 501);
  const result = sweepSession(sweepDeps(box, guardFor(box)), {
    sid: 500,
    sparePgid: 500,
    rounds: 10,
    roundIntervalMs: 10,
  });
  assert.equal(result.survivors, 0);
  assert.ok(box.procs.has(500), "the interactive shell is spared once");
  // Fallback: an owner planted in the storm's group forces STOP-then-KILL of the rest of that group.
  box.add({ pid: 520, ppid: 500, pgid: 520, sid: 500, comm: "bash" });
  box.add({ pid: 521, ppid: 520, pgid: 520, sid: 500, comm: "bash" });
  box.add({ pid: 522, ppid: 520, pgid: 520, sid: 500, comm: "node", owner: true });
  const recorded: number[][] = [];
  const deps = {
    ...sweepDeps(box, guardFor(box)),
    recordStops: (stops: readonly { pid: number }[]) => recorded.push(stops.map((s) => s.pid)),
  };
  const fallback = sweepSession(deps, {
    sid: 500,
    sparePgid: 500,
    rounds: 10,
    roundIntervalMs: 10,
  });
  assert.equal(fallback.fallbackStops, 2);
  const stopOrder = box.signals.filter((s) => s.signal === "SIGSTOP").map((s) => s.target);
  assert.deepEqual(stopOrder, [520, 521], "parents before children");
  assert.deepEqual(
    recorded[0]?.toSorted((a, b) => a - b),
    [520, 521],
    "recorded before the first SIGSTOP",
  );
  assert.deepEqual(recorded.at(-1), [], "cleared once killed");
  assert.ok(box.procs.has(522) && !box.procs.has(520) && !box.procs.has(521));
});

test("sweep (a): round 1 signals from the DECISION scan — no /proc re-scan before the first signal", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-a");
  box.toolSession(200, claudePid, 130);
  const decision = scanProcTable(box.proc, parseGovProcStat).byPid;
  const events: string[] = [];
  const deps = {
    ...sweepDeps(box, guardFor(box)),
    scan: () => {
      events.push("scan");
      return scanProcTable(box.proc, parseGovProcStat).byPid;
    },
    signal: (target: number, sig: NodeJS.Signals) => {
      events.push(`signal ${target}`);
      box.signal(target, sig);
    },
  };
  const result = sweepSession(deps, {
    sid: 200,
    rounds: 10,
    roundIntervalMs: 10,
    decisionScan: decision,
  });
  assert.equal(events[0].startsWith("signal"), true, `first action was ${events[0]}`);
  assert.equal(result.survivors, 0);
});

test("sweep: each argv is read at most ONCE per guard pass (the session leader's negative is not re-read per member)", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-memo");
  box.toolSession(200, claudePid, 130);
  const reads = new Map<number, number>();
  const guard = {
    ...guardFor(box),
    tokenState: (pid: number) => {
      reads.set(pid, (reads.get(pid) ?? 0) + 1);
      return queueOwnerTokenState(pid, box.proc);
    },
  };
  const decision = scanProcTable(box.proc, parseGovProcStat).byPid;
  sweepSession(sweepDeps(box, guard), {
    sid: 200,
    rounds: 1,
    roundIntervalMs: 10,
    decisionScan: decision,
  });
  assert.equal(reads.get(200), 1, "the leader's token: once in the pass, not once per member");
  assert.ok([...reads.values()].every((n) => n === 1));
});

test("sweep accounting: `signalled` counts every member of the signalled groups across rounds — not the decision count", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-acct");
  box.toolSession(200, claudePid, 130);
  const decision = scanProcTable(box.proc, parseGovProcStat).byPid; // 130 members seen
  // The storm keeps forking after the decision: 70 more in a new job's group of the same session.
  box.addMany(70, { ppid: 201, pgid: 900, sid: 200, comm: "bash" }, 900);
  const result = sweepSession(sweepDeps(box, guardFor(box)), {
    sid: 200,
    rounds: 10,
    roundIntervalMs: 10,
    decisionScan: decision,
  });
  assert.equal(result.survivors, 0);
  assert.equal(result.signalled, 200);
  assert.ok(result.rounds >= 2);
});

test("sweep: EPERM on a root-owned member is reported, and the members the governor may kill still die", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-e");
  box.toolSession(200, claudePid, 3);
  box.add({ pid: 230, ppid: 201, pgid: 230, sid: 200, comm: "sudo", immortal: true });
  const result = sweepSession(sweepDeps(box, guardFor(box)), {
    sid: 200,
    rounds: 3,
    roundIntervalMs: 10,
  });
  assert.equal(result.eperm, true);
  assert.equal(result.survivors, 1);
  assert.ok(!box.procs.has(201));
});
