import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { CAPACITY_CONSTANTS, MIB } from "../src/capacity/constants.js";
import { emergencyLineBytes, oomMarginBytes } from "../src/capacity/governor/rules.js";
import { parseLastPid, pidsAllocated } from "../src/capacity/governor/run.js";
import { FakeBox, GiB, SECRET } from "./governor-fixtures.js";

// brick 5d7a23b6 — the governor daemon end to end on fixture boxes: R1, R2, the D1 configuration
// (observe / governTerminals), telling, the lock and the system-session check, restarts.
// CONCEPTION §4, §5, §6, §7.2, §11, §18 C1–C6.

const K = CAPACITY_CONSTANTS.governor;

function stormBox(t: { after: (fn: () => void) => void }, processes: number) {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-storm-0001", "seat-storm-1");
  box.toolSession(2000, claudePid, processes);
  return box;
}

function startedGovernor(box: FakeBox, ...args: Parameters<FakeBox["governor"]>) {
  const governor = box.governor(...args);
  const outcome = governor.start();
  assert.deepEqual(outcome, { started: true });
  return governor;
}

test("R1 boundary: 127 processes → nothing; 128 → the whole session is killed at once", async (t) => {
  const below = stormBox(t, 127);
  const g1 = startedGovernor(below);
  g1.tick();
  await g1.settle();
  assert.deepEqual(below.signals, []);
  assert.equal(below.events().filter((e) => e.action === "killed").length, 0);

  const at = stormBox(t, 128);
  const g2 = startedGovernor(at);
  g2.tick();
  await g2.settle();
  assert.deepEqual(at.members(2000), []);
  assert.deepEqual(
    at.groupKills().toSorted((a, b) => a - b),
    [2000, 2001],
  );
  assert.ok(
    at.procs.has(100) && at.procs.has(101) && at.procs.has(102),
    "owner, adapter, claude intact",
  );
});

test("R1 kill: in-band line on the leader's fd 2 only, seat message, events.ndjson + ClickHouse row, log line", async (t) => {
  const box = stormBox(t, 200);
  const governor = startedGovernor(box);
  governor.tick();
  await governor.settle();
  // (b) the in-band line, on the LEADER's stderr only. Since §19 D7 a first sight is crossed mid-scan, so the
  // line and the seat message report the members COUNTED at the decision (128, +1 when the leader was read
  // fresh); the event below records what the sweep killed (200).
  const line = box.stderrOf(2000);
  assert.match(
    line,
    /^process-governor: KILLED this command \(rule=fork-storm processes=12[89] limit=128; bash×12[89]\)/u,
  );
  assert.match(line, /workbench-exec/u);
  assert.equal(box.stderrOf(2001), "", "never another member's fd 2");
  // (c) the seat message through atrium
  assert.equal(box.atriumCalls.length, 1);
  const call = box.atriumCalls[0];
  assert.equal(call.url, "http://atrium.test:3456/api/seats/seat-storm-1/message");
  assert.equal(call.headers["X-Source-Session"], "process-governor");
  const body = JSON.parse(call.body) as { text: string; from: string };
  assert.equal(body.from, "process-governor");
  assert.match(body.text, /rule=fork-storm processes=12[89]\b/u);
  assert.match(body.text, /bash×12[89]\b/u);
  assert.match(body.text, /your session, its other commands and its context are intact/u);
  // (d) the event, locally and as a ClickHouse row
  const killed = box.events().filter((e) => e.action === "killed");
  assert.equal(killed.length, 1);
  assert.equal(killed[0].rule, "fork-storm");
  assert.equal(killed[0].session_kind, "tool");
  assert.equal(killed[0].session_id, "sess-storm-0001");
  assert.equal(killed[0].seat_id, "seat-storm-1");
  // max(decision count, members signalled) is a LOWER bound (TE G-F1''): the crossing signals the pgids it has
  // seen, and the group kill takes their unscanned members without the sweep counting them.
  assert.ok(
    Number(killed[0].processes) >= 128 && Number(killed[0].processes) <= 200,
    `processes ${String(killed[0].processes)}`,
  );
  assert.equal(killed[0].survivors, 0);
  assert.equal(
    killed[0].anon_bytes,
    null,
    "an R1 kill reads no status before the sweep (§19 D3 latency)",
  );
  assert.equal(killed[0].notify_status, "sent");
  assert.equal(killed[0].notified, true);
  assert.equal(killed[0].mode, "enforce");
  const rows = box.clickhouseCalls.flatMap((c) => c.body.split("\n").filter(Boolean));
  assert.equal(rows.length, 1);
  assert.equal((JSON.parse(rows[0]) as { event_id: string }).event_id, killed[0].event_id);
  assert.ok(box.logs.some((l) => l.includes("killed") && l.includes("rule=fork-storm")));
});

test("U2 — observe mode emits ZERO signals, ZERO in-band lines, ZERO messages for an R1-size and an R2 victim", async (t) => {
  const box = stormBox(t, 300);
  // Also an R2 victim: the box is past its emergency line and a governed session holds 2 GiB.
  box.add({ pid: 3000, ppid: 102, comm: "bash", rssKb: 2 * 1024 * 1024 });
  box.memory({ anon: 11.8 * GiB, kernel: 0.1 * GiB, max: 12 * GiB });
  // The constant's OTHER value, set explicitly: the shipped value is "enforce" (D1 "(a)").
  const governor = startedGovernor(box, {}, { mode: "observe" });
  for (let i = 0; i < 5; i += 1) {
    governor.tick();
    box.nowMs += 3000;
  }
  await governor.settle();
  assert.deepEqual(box.signals, [], "no signal of any kind");
  assert.equal(box.stderrOf(2000), "", "no in-band line");
  assert.equal(box.stderrOf(3000), "", "no in-band line");
  assert.deepEqual(box.atriumCalls, [], "no seat message");
  const would = box.events().filter((e) => e.action === "would_kill");
  assert.deepEqual(
    would.map((e) => `${String(e.rule)}:${String(e.notify_status)}`).toSorted(),
    ["fork-storm:observe", "memory-emergency:observe"],
    "one would_kill per (session, rule), not one per scan",
  );
  assert.equal(would.find((e) => e.rule === "memory-emergency")?.processes, 1);
});

test("the shipped configuration is D1 = (a): ENFORCE, terminals governed (decision/DECISION.md)", () => {
  assert.equal(K.mode, "enforce");
  assert.equal(K.governTerminals, true);
});

test("governTerminals:false — a 200-process ttyd terminal session is NEVER signalled; an ssh login still is (§18 C3, C4)", async (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.add({ pid: 500, ppid: 41, comm: "bash", tty: 34816 }); // ttyd terminal
  box.addMany(199, { ppid: 500, pgid: 501, sid: 500, comm: "bash" }, 501);
  box.add({ pid: 5200, ppid: 1, comm: "sshd-session" });
  box.add({ pid: 6000, ppid: 5200, comm: "bash" }); // ssh login
  box.addMany(149, { ppid: 6000, pgid: 6001, sid: 6000, comm: "bash" }, 6001);
  const governor = startedGovernor(box, {}, { governTerminals: false });
  governor.tick();
  await governor.settle();
  assert.equal(box.members(500).length, 200, "the ttyd terminal session is untouched");
  assert.ok(
    !box.signals.some(
      (s) => s.target === -500 || s.target === -501 || (s.target >= 500 && s.target < 700),
    ),
  );
  assert.equal(box.stderrOf(500), "");
  assert.equal(box.members(6000).length, 0, "the ssh login is governed and killed");
  const exempt = box.events().filter((e) => e.notify_status === "exempt-terminal");
  assert.equal(exempt.length, 1);
  assert.equal(exempt[0].action, "would_kill");
  assert.equal(exempt[0].attribution, "ttyd");
});

test("terminal session: the interactive shell keeps its own group on the first sweep, and goes on a second within 60 s", async (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.add({ pid: 500, ppid: 41, comm: "bash", tty: 34816 });
  box.addMany(130, { ppid: 500, pgid: 501, sid: 500, comm: "bash" }, 501);
  const governor = startedGovernor(box);
  governor.tick();
  assert.deepEqual(
    box.members(500).map((p) => p.pid),
    [500],
    "the shell survived the first sweep",
  );
  box.nowMs += 20_000;
  box.addMany(130, { ppid: 500, pgid: 700, sid: 500, comm: "bash" }, 700);
  governor.tick();
  await governor.settle();
  assert.deepEqual(box.members(500), [], "a loop typed at the prompt: the leader goes too");
  const lines = box.stderrOf(500).split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Nothing else in your session was touched/u);
  assert.match(
    lines[1],
    /Your shell was ended too/u,
    "F9: the second sweep says the shell went too",
  );
});

test("§19 D4 committed positive: an OUTSIDE session (setsid -f escape) at ≥ 128 is killed — in-band line, event, no seat message", async (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.add({ pid: 4000, ppid: 1, comm: "bash" }); // double-forked out of a tool command: parent PID 1
  box.addMany(140, { ppid: 4000, pgid: 4001, sid: 4000, comm: "bash" }, 4001);
  // ...under governTerminals:false too: an escape is unplaceable, so the terminal exemption cannot cover it.
  const governor = startedGovernor(box, {}, { governTerminals: false });
  governor.tick();
  await governor.settle();
  assert.deepEqual(box.members(4000), []);
  const killed = box.events().find((e) => e.action === "killed");
  assert.equal(killed?.session_kind, "outside");
  assert.equal(killed?.attribution, "unknown");
  assert.equal(killed?.notify_status, "no_target");
  assert.deepEqual(box.atriumCalls, []);
  assert.match(box.stderrOf(4000), /^process-governor: KILLED this command/u);
});

test("§19 D4 committed negatives: a verified-owner session and the system session at ≥ 128 are NEVER signalled; R1 on outside needs owner identification", async (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.owner(100, "sess-big"); // token owner: grows to 143 inside its own session
  box.addMany(140, { ppid: 102, pgid: 100, sid: 100, comm: "bash" }, 3000);
  box.add({ pid: 200, ppid: 1, comm: "node" }); // lease-only owner
  box.lease("sess-lease-200", 200);
  box.addMany(140, { ppid: 200, pgid: 200, sid: 200, comm: "bash" }, 5000);
  box.addMany(140, { ppid: 40, pgid: 6, sid: 6, comm: "node" }, 7000); // the system session (atrium's children)
  const governor = startedGovernor(box);
  governor.tick();
  await governor.settle();
  assert.deepEqual(box.signals, []);
  assert.equal(
    box.events().filter((e) => e.action === "killed" || e.action === "would_kill").length,
    0,
  );

  // The same outside storm, queue dir unreadable in both arms; only the argv token's answer differs.
  const outsideStorm = async (token: "absent" | "unreadable") => {
    const b = new FakeBox();
    t.after(() => b.cleanup());
    b.standardSystem();
    b.add({ pid: 4000, ppid: 1, comm: "bash" });
    b.addMany(140, { ppid: 4000, pgid: 4001, sid: 4000, comm: "bash" }, 4001);
    fs.chmodSync(b.queue, 0o000);
    let readable = true;
    try {
      fs.readdirSync(b.queue);
    } catch {
      readable = false;
    }
    const g = startedGovernor(b, {}, {}, { tokenState: () => token });
    g.tick();
    await g.settle();
    fs.chmodSync(b.queue, 0o755);
    return { box: b, readable };
  };

  // Positive control (TE G-F4): identification WORKS (the argv token is readable) → the storm IS killed,
  // so the blind arm below cannot pass on a fixture R1 would never have touched.
  const seeing = await outsideStorm("absent");
  assert.deepEqual(
    seeing.box.members(4000),
    [],
    "identification works: the outside storm is killed",
  );
  assert.equal(seeing.box.events().find((e) => e.action === "killed")?.session_kind, "outside");

  // Owner identification broken (queue dir unreadable AND argv unreadable): an outside storm is NOT killed.
  const { box: blind, readable } = await outsideStorm("unreadable");
  if (readable) {
    t.diagnostic(
      "running as a user that bypasses directory permissions: the blind arm is not exercised",
    );
    return;
  }
  assert.deepEqual(blind.signals, []);
  assert.equal(blind.members(4000).length, 141, "the blind arm left the storm alone");
});

test("R2 line: L − M_oom on both branches of M_oom (512 MiB floor, 5 % of L)", () => {
  const C = CAPACITY_CONSTANTS;
  assert.equal(oomMarginBytes(4 * GiB, C), 512 * MIB);
  assert.equal(emergencyLineBytes(4 * GiB, C), 3.5 * GiB);
  assert.equal(oomMarginBytes(16 * GiB, C), 0.05 * 16 * GiB);
  assert.equal(emergencyLineBytes(16 * GiB, C), 0.95 * 16 * GiB);
});

function pressureBox(t: { after: (fn: () => void) => void }) {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-r2", "seat-r2");
  box.memory({ anon: 11.7 * GiB, kernel: 0.2 * GiB, max: 12 * GiB });
  return { box, claudePid };
}

test("R2 ranks by freeable memory, honours the floor, and never picks an owner or the system session (U4)", async (t) => {
  const { box, claudePid } = pressureBox(t);
  // The system session and the owner hold the most memory; they must never be chosen.
  box.add({ pid: 44, ppid: 6, pgid: 6, sid: 6, comm: "node", rssKb: 6 * 1024 * 1024 });
  box.add({ pid: 103, ppid: 101, pgid: 100, sid: 100, comm: "node", rssKb: 5 * 1024 * 1024 });
  box.add({ pid: 2000, ppid: claudePid, comm: "bash", rssKb: 700 * 1024 }); // governed, 700 MiB
  box.add({ pid: 2100, ppid: claudePid, comm: "bash", rssKb: 900 * 1024 }); // governed, 900 MiB ← victim
  box.add({ pid: 2200, ppid: claudePid, comm: "bash", rssKb: 100 * 1024 }); // below the 307 MiB floor
  const governor = startedGovernor(box);
  governor.tick();
  await governor.settle();
  assert.deepEqual(box.groupKills(), [2100]);
  const killed = box.events().find((e) => e.action === "killed");
  assert.equal(killed?.rule, "memory-emergency");
  assert.match(box.stderrOf(2100), /rule=memory-emergency/u);
  // ≤ 1 kill per 2 s
  box.nowMs += 1000;
  governor.tick();
  assert.deepEqual(box.groupKills(), [2100]);
  box.nowMs += 1500;
  governor.tick();
  await governor.settle();
  assert.deepEqual(box.groupKills(), [2100, 2000]);
  // Nothing governed left above the floor: pressure_no_victim, rate limited, nothing signalled.
  box.nowMs += 2500;
  governor.tick();
  box.nowMs += 2500;
  governor.tick();
  await governor.settle();
  assert.deepEqual(box.groupKills(), [2100, 2000]);
  assert.equal(box.events().filter((e) => e.action === "pressure_no_victim").length, 1);
  assert.ok(box.procs.has(44) && box.procs.has(103));
});

test("R2: a runtime rebuild (refresh.sh) is chosen LAST; a session it failed to shrink is skipped for 30 s", async (t) => {
  const { box, claudePid } = pressureBox(t);
  box.add({ pid: 2000, ppid: claudePid, comm: "refresh.sh", rssKb: 2000 * 1024 });
  box.add({ pid: 2100, ppid: claudePid, comm: "bash", rssKb: 600 * 1024, immortal: true });
  const governor = startedGovernor(box);
  governor.tick();
  await governor.settle();
  const killedGroups = () => [...new Set(box.groupKills())];
  assert.deepEqual(killedGroups(), [2100], "the smaller non-maintenance session first");
  assert.ok(box.procs.has(2100), "…which could not be shrunk (EPERM)");
  assert.equal(
    box.events().find((e) => e.rule === "memory-emergency")?.action,
    "kill_failed_eperm",
  );
  box.nowMs += 2500;
  governor.tick();
  await governor.settle();
  assert.deepEqual(killedGroups(), [2100, 2000], "skip list: the refresh is next, not 2100 again");
});

test("R2 is BLIND, not guessing, on an unmeasured scan or with owner identification unavailable", async (t) => {
  const { box, claudePid } = pressureBox(t);
  box.add({ pid: 2000, ppid: claudePid, comm: "bash", rssKb: 900 * 1024 });
  fs.chmodSync(box.queue, 0o000);
  const readable = (() => {
    try {
      fs.readdirSync(box.queue);
      return true;
    } catch {
      return false;
    }
  })();
  const governor = startedGovernor(box, {}, {}, { tokenState: () => "unreadable" });
  governor.tick();
  await governor.settle();
  fs.chmodSync(box.queue, 0o755);
  if (readable) {
    t.diagnostic(
      "running as a user that bypasses directory permissions: the census-blind arm is not exercised",
    );
    return;
  }
  assert.deepEqual(box.groupKills(), []);
  const blind = box.events().filter((e) => e.action === "r2_blind");
  assert.equal(blind.length, 1);
  assert.equal(blind[0].notify_status, "owner-identification-unavailable");
});

test("ungoverned_burst: > 64 ungoverned processes in 60 s raises the alarm and kills nothing (§3.4, N5)", async (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const governor = startedGovernor(box);
  governor.tick();
  for (let i = 0; i < 200; i += 1) {
    box.add({ pid: 5000 + i, ppid: 1, comm: "sleep" }); // double-forked `setsid sleep &`: parent PID 1
  }
  box.nowMs += 1000;
  governor.tick();
  await governor.settle();
  assert.deepEqual(box.signals, []);
  const burst = box.events().filter((e) => e.action === "ungoverned_burst");
  assert.equal(burst.length, 1);
  assert.equal(burst[0].processes, 200);
});

test("ungoverned_burst counts OWNER sessions too (§19 D1c): an owner session gaining > 64 raises it, kills nothing", async (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.owner(100, "sess-burst");
  const governor = startedGovernor(box);
  governor.tick();
  box.addMany(100, { ppid: 102, pgid: 100, sid: 100, comm: "bash" }, 3000); // commands inside the owner's session
  box.nowMs += 1000;
  governor.tick();
  await governor.settle();
  assert.deepEqual(box.signals, []);
  assert.equal(box.events().filter((e) => e.action === "ungoverned_burst").length, 1);
});

test("leaderless remainder after a governor restart with groups.json deleted: killed, attribution unknown (AC2 variant)", async (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.addMany(140, { ppid: 1, pgid: 2001, sid: 2000, comm: "bash" }, 2001);
  const governor = startedGovernor(box);
  governor.tick();
  await governor.settle();
  assert.deepEqual(box.members(2000), []);
  const killed = box.events().find((e) => e.action === "killed");
  assert.equal(killed?.session_kind, "leaderless");
  assert.equal(killed?.attribution, "unknown");
  assert.equal(killed?.orphaned, true);
  assert.equal(killed?.notify_status, "no_target");
  assert.equal(killed?.started_at, null, "F8: first seen leaderless, its start is unknown");
  // §19 D2: with the leader dead, the in-band line goes to the OLDEST surviving member's fd 2, once.
  assert.match(box.stderrOf(2001), /^process-governor: KILLED this command/u);
  assert.equal(box.stderrOf(2002), "");
});

test("§19 D2: a dead leader's in-band line falls back to the oldest member's fd 1 when fd 2 is not writable", async (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.addMany(140, { ppid: 1, pgid: 2001, sid: 2000, comm: "bash" }, 2001);
  const fd2 = path.join(box.proc, "2001", "fd", "2");
  fs.rmSync(fd2);
  fs.mkdirSync(fd2); // an fd 2 that cannot be opened for writing
  const governor = startedGovernor(box);
  governor.tick();
  await governor.settle();
  assert.deepEqual(box.members(2000), []);
  assert.match(box.stderrOf(2001, "1"), /^process-governor: KILLED this command/u);
});

test("F8: an orphaned remainder's started_at is the REMEMBERED leader's start, not its oldest survivor's", async (t) => {
  const box = stormBox(t, 20);
  const leaderTicks = box.procs.get(2000)?.ticks as number;
  const governor = startedGovernor(box);
  governor.tick(); // first sight: a tool session, leader alive — remembered
  box.remove(2000); // the tool call is stopped: the shell dies, the remainder is reparented and regrows
  for (const p of box.members(2000)) {
    box.add({ ...p, ppid: 1 });
  }
  box.addMany(120, { ppid: 1, pgid: 2001, sid: 2000, comm: "bash" }, 5000);
  box.nowMs += 1000;
  governor.tick();
  await governor.settle();
  const killed = box.events().find((e) => e.action === "killed");
  const expected = new Date(1762560000 * 1000 + leaderTicks * 10)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "");
  assert.equal(killed?.orphaned, true);
  assert.equal(killed?.started_at, expected);
  assert.match(
    JSON.parse(box.atriumCalls[0].body).text as string,
    new RegExp(`started at ${expected.replaceAll(".", "\\.")} UTC`, "u"),
  );
});

test("verification: survivors at +1 s give kill_incomplete and another sweep; after three sweeps a LOUD event", async (t) => {
  const box = stormBox(t, 130);
  box.add({ pid: 2900, ppid: 2000, pgid: 2900, sid: 2000, comm: "sudo", immortal: true });
  const governor = startedGovernor(box);
  governor.tick();
  for (let i = 0; i < 30; i += 1) {
    box.nowMs += 1000;
    governor.tick();
  }
  await governor.settle();
  const incomplete = box.events().filter((e) => e.action === "kill_incomplete");
  assert.ok(incomplete.length >= 3);
  assert.ok(incomplete.some((e) => e.notify_status === "loud"));
  assert.ok(box.logs.some((l) => l.includes("LOUD")));
});

test("lock + system session: a governor outside the entrypoint's session exits 2; --test-rig takes its own session", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  box.add({ pid: 60, ppid: 1, comm: "bash" });
  box.add({ pid: 61, ppid: 60, pgid: 60, sid: 60, comm: "node" });
  const stray = box.governor({}, {}, { selfPid: 61 });
  assert.deepEqual(stray.start(), { exitCode: 2 });
  const rig = box.governor({ testRig: true }, {}, { selfPid: 61 });
  assert.deepEqual(rig.start(), { started: true });
  // E16: a second governor cannot take the lock while the first lives.
  const second = box.governor();
  assert.deepEqual(second.start(), { exitCode: 2 });
  rig.shutdown();
  const third = box.governor();
  assert.deepEqual(third.start(), { started: true }, "a released lock is free");
});

test("system-session check unavailable: observe-only with local events only, re-checked each minute (§18 C6)", async (t) => {
  const box = stormBox(t, 200);
  // No process has PID 1 as parent: the entrypoint cannot be identified.
  box.remove(6);
  box.remove(100);
  const governor = startedGovernor(box);
  governor.tick();
  await governor.settle();
  assert.deepEqual(box.signals, [], "observe-only");
  assert.ok(box.events().some((e) => e.action === "would_kill"));
  assert.deepEqual(box.clickhouseCalls, [], "no ClickHouse rows from a non-supervised governor");
  // The entrypoint appears; a minute later the check passes and the configured mode applies.
  box.add({ pid: 6, ppid: 1, comm: "bash", ticks: 10 });
  box.nowMs += 61_000;
  governor.tick();
  await governor.settle();
  assert.deepEqual(box.members(2000), []);
});

test("a STOP left in flight by a dead governor is finished (SIGKILL) on restart — never a frozen process", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const frozen = box.add({ pid: 700, ppid: 1, comm: "bash", state: "T" });
  fs.mkdirSync(box.dir, { recursive: true });
  fs.writeFileSync(
    path.join(box.dir, "state.json"),
    JSON.stringify({
      stopsInFlight: [
        { pid: 700, startTicks: String(frozen.ticks) },
        { pid: 701, startTicks: "1" },
      ],
    }),
  );
  startedGovernor(box);
  assert.ok(!box.procs.has(700));
  assert.deepEqual(box.signals, [{ target: 700, signal: "SIGKILL" }]);
  const state = JSON.parse(fs.readFileSync(path.join(box.dir, "state.json"), "utf8")) as {
    stopsInFlight: unknown[];
  };
  assert.deepEqual(state.stopsInFlight, []);
});

test("F5 committed negative: a recorded stop whose pid now belongs to an owner or the system session is never killed — SIGCONT + event", (t) => {
  const cases: Array<{ label: string; plant: (box: FakeBox) => number; leaseSession?: string }> = [
    {
      label: "queue owner (argv token)",
      plant: (box) =>
        box.add({ pid: 700, ppid: 1, comm: "node", owner: true, state: "T" }).ticks as number,
    },
    {
      label: "queue owner (lease only)",
      plant: (box) => box.add({ pid: 700, ppid: 1, comm: "node", state: "T" }).ticks as number,
      leaseSession: "sess-lease-700",
    },
    {
      label: "adapter inside an owner session",
      plant: (box) => {
        box.add({ pid: 690, ppid: 1, comm: "node", owner: true });
        return box.add({ pid: 700, ppid: 690, pgid: 690, sid: 690, comm: "node", state: "T" })
          .ticks as number;
      },
    },
    {
      label: "system-session member",
      plant: (box) =>
        box.add({ pid: 700, ppid: 6, pgid: 6, sid: 6, comm: "node", state: "T" }).ticks as number,
    },
  ];
  for (const c of cases) {
    const box = new FakeBox();
    t.after(() => box.cleanup());
    box.standardSystem();
    const ticks = c.plant(box);
    if (c.leaseSession) {
      box.lease(c.leaseSession, 700);
    }
    fs.mkdirSync(box.dir, { recursive: true });
    fs.writeFileSync(
      path.join(box.dir, "state.json"),
      JSON.stringify({ stopsInFlight: [{ pid: 700, startTicks: String(ticks) }] }),
    );
    startedGovernor(box);
    assert.ok(box.procs.has(700), `${c.label}: still alive`);
    assert.deepEqual(
      box.signals,
      [{ target: 700, signal: "SIGCONT" }],
      `${c.label}: SIGCONT only, never SIGKILL`,
    );
    assert.equal(box.procs.get(700)?.state, "S", `${c.label}: no longer frozen`);
    const released = box.events().filter((e) => e.action === "stop_released");
    assert.equal(released.length, 1, c.label);
    assert.match(String(released[0].notify_status), /^owner-|^system$/u, c.label);
  }
});

test("F5: in observe mode a recorded stop is released (SIGCONT), never killed", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const frozen = box.add({ pid: 700, ppid: 1, comm: "bash", state: "T" });
  fs.mkdirSync(box.dir, { recursive: true });
  fs.writeFileSync(
    path.join(box.dir, "state.json"),
    JSON.stringify({ stopsInFlight: [{ pid: 700, startTicks: String(frozen.ticks) }] }),
  );
  startedGovernor(box, {}, { mode: "observe" });
  assert.deepEqual(box.signals, [{ target: 700, signal: "SIGCONT" }]);
  assert.equal(box.events().find((e) => e.action === "stop_released")?.notify_status, "observe");
});

test("dedupe: one message per (session, rule) per 10 min; repeats are summarised when the window closes", async (t) => {
  const box = stormBox(t, 130);
  const governor = startedGovernor(box);
  governor.tick();
  await governor.settle();
  box.nowMs += 30_000;
  box.toolSession(4000, 102, 130);
  governor.tick();
  await governor.settle();
  assert.equal(box.atriumCalls.length, 1);
  assert.equal(box.events().findLast((e) => e.action === "killed")?.notify_status, "deduped");
  box.nowMs += 600_000;
  governor.tick();
  await governor.settle();
  assert.equal(box.atriumCalls.length, 2);
  assert.match(JSON.parse(box.atriumCalls[1].body).text as string, /1 more command/u);
});

test("outbox: atrium down → the message waits, is retried every 30 s, and lands; 409 SESSION_CLOSED is final; 1 h → dropped with an event", async (t) => {
  const box = stormBox(t, 130);
  box.atriumDown = true;
  const governor = startedGovernor(box);
  governor.tick();
  await governor.settle();
  assert.equal(box.events().find((e) => e.action === "killed")?.notify_status, "outbox");
  assert.equal(fs.readdirSync(path.join(box.dir, "outbox")).length, 1);
  box.atriumDown = false;
  box.nowMs += 31_000;
  governor.tick();
  await governor.settle();
  assert.equal(fs.readdirSync(path.join(box.dir, "outbox")).length, 0, "retried and delivered");
  assert.equal(box.atriumCalls.length, 2);

  const closed = stormBox(t, 130);
  closed.atriumStatus = 409;
  closed.atriumBody = '{"error":{"code":"SESSION_CLOSED"}}';
  const g2 = startedGovernor(closed);
  g2.tick();
  await g2.settle();
  assert.equal(closed.events().find((e) => e.action === "killed")?.notify_status, "session_closed");

  const expiring = stormBox(t, 130);
  expiring.atriumDown = true;
  const g3 = startedGovernor(expiring);
  g3.tick();
  await g3.settle();
  expiring.nowMs += 3_601_000;
  g3.tick();
  await g3.settle();
  assert.equal(expiring.events().filter((e) => e.action === "notify_dropped").length, 1);
  assert.equal(fs.readdirSync(path.join(expiring.dir, "outbox")).length, 0);
});

test("U3: the governor never opens `environ`, and argv content never reaches an event, log line or message", async (t) => {
  const box = stormBox(t, 200);
  box.memory({ anon: 11.8 * GiB, kernel: 0.1 * GiB, max: 12 * GiB });
  const opened: string[] = [];
  const realOpen = fs.openSync.bind(fs);
  const realRead = fs.readFileSync.bind(fs);
  t.mock.method(fs, "openSync", (file: fs.PathLike, ...rest: unknown[]) => {
    opened.push(String(file));
    return (realOpen as (...a: unknown[]) => number)(file, ...rest);
  });
  t.mock.method(fs, "readFileSync", (file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    opened.push(String(file));
    return (realRead as (...a: unknown[]) => unknown)(file, ...rest);
  });
  const governor = startedGovernor(box);
  governor.tick();
  box.nowMs += 2500;
  governor.tick();
  await governor.settle();
  t.mock.restoreAll();
  assert.ok(
    opened.some((f) => f.endsWith("/cmdline")),
    "positive control: the token check ran",
  );
  assert.deepEqual(
    opened.filter((f) => f.endsWith("/environ")),
    [],
  );
  const everything = [
    fs.readFileSync(path.join(box.dir, "events.ndjson"), "utf8"),
    ...box.logs,
    ...box.atriumCalls.map((c) => c.body),
    ...box.clickhouseCalls.map((c) => c.body),
    box.stderrOf(2000),
  ].join("\n");
  assert.ok(!everything.includes(SECRET), "a planted argv/environ secret leaked");
});

test("the governor NEVER forks: child_process stubbed to throw through start, ticks, a kill, telling and recording", async (t) => {
  const calls: string[] = [];
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ] as const) {
    t.mock.method(childProcess, name, () => {
      calls.push(name);
      throw new Error(`child_process.${name} called`);
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const box = stormBox(t, 200);
  box.memory({ anon: 11.8 * GiB, kernel: 0.1 * GiB, max: 12 * GiB });
  const governor = startedGovernor(box);
  for (let i = 0; i < 3; i += 1) {
    governor.tick();
    box.nowMs += 1500;
  }
  await governor.settle();
  governor.shutdown();
  assert.ok(
    box.events().some((e) => e.action === "killed"),
    "positive control: a kill happened",
  );
  assert.deepEqual(calls, []);
});

test("fast mode: a governed session growing by ≥ 16 between scans switches to 100 ms until 5 s without growth", (t) => {
  const box = stormBox(t, 2);
  const governor = startedGovernor(box);
  assert.deepEqual(governor.tick(), { nextMs: K.scanIntervalMs });
  box.addMany(20, { ppid: 2000, pgid: 2001, sid: 2000, comm: "bash" }, 2100);
  box.nowMs += 1000;
  assert.deepEqual(governor.tick(), { nextMs: K.fastScanIntervalMs });
  box.nowMs += 4000;
  assert.deepEqual(governor.tick(), { nextMs: K.fastScanIntervalMs });
  box.nowMs += 1100;
  assert.deepEqual(governor.tick(), { nextMs: K.scanIntervalMs });
});

test("§19 D3 trigger arithmetic: last pid from /proc/loadavg, pids allocated incl. the wrap at pid_max", () => {
  assert.equal(parseLastPid("0.08 0.12 0.10 1/617 777300\n"), 777300);
  assert.equal(parseLastPid("garbage"), undefined);
  assert.equal(pidsAllocated(777300, 777300, 4_194_304), 0);
  assert.equal(pidsAllocated(777300, 777316, 4_194_304), 16);
  // Wrap: the kernel allocates up to pid_max − 1, then from RESERVED_PIDS (300) again.
  assert.equal(pidsAllocated(4_194_300, 4_194_303, 4_194_304), 3);
  assert.equal(pidsAllocated(4_194_300, 300, 4_194_304), 4, "…4194301, 4194302, 4194303, 300");
  assert.equal(pidsAllocated(4_194_300, 311, 4_194_304), 15);
  assert.equal(pidsAllocated(4_194_300, 312, 4_194_304), 16);
  assert.equal(pidsAllocated(32_760, 310, 32_768), 18, "a small pid_max wraps the same way");
});

test("§19 D3a pid watcher: 10 ms; counts pids since the LAST FULL SCAN — 10 new pids per tick trigger on the SECOND tick", (t) => {
  assert.equal(K.pidWatchIntervalMs, 10);
  assert.equal(K.pidWatchTrigger, 16);
  const box = stormBox(t, 2);
  const loadavg = path.join(box.proc, "loadavg");
  const lastPid = (pid: number) => fs.writeFileSync(loadavg, `0.1 0.1 0.1 1/100 ${pid}\n`);
  fs.mkdirSync(path.join(box.proc, "sys", "kernel"), { recursive: true });
  fs.writeFileSync(path.join(box.proc, "sys", "kernel", "pid_max"), "32768\n");
  lastPid(32700);
  const governor = startedGovernor(box);
  assert.deepEqual(
    governor.tick(),
    { nextMs: K.scanIntervalMs },
    "the scan sets the baseline 32700",
  );
  lastPid(32710);
  assert.equal(governor.pidWatch(), false, "tick 1: 10 since the scan");
  lastPid(32720);
  assert.equal(governor.pidWatch(), true, "tick 2: 20 since the scan — cumulative, not per tick");
  assert.deepEqual(
    governor.tick(),
    { nextMs: K.fastScanIntervalMs },
    "the forced scan runs in fast mode",
  );
  lastPid(32730);
  assert.equal(governor.pidWatch(), false, "the scan reset the baseline to 32720");
  lastPid(310); // 32720 → wrap at 32768 → 310: 47 + 11 = 58
  assert.equal(governor.pidWatch(), true, "a wrap is counted, not read as a negative");
});

test("self-restart: a changed entry file, stable for 10 s, makes the governor exit 0 between sweeps", (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const entry = path.join(box.root, "main.js");
  fs.writeFileSync(entry, "v1");
  const governor = startedGovernor(box, {}, {}, { entryFile: entry });
  assert.ok("nextMs" in governor.tick());
  fs.writeFileSync(entry, "v2 — a rebuilt dist");
  box.nowMs += 1000;
  assert.ok("nextMs" in governor.tick(), "changed, not yet stable");
  box.nowMs += 9000;
  assert.ok("nextMs" in governor.tick());
  box.nowMs += 1500;
  assert.deepEqual(governor.tick(), { exitCode: 0 });
});

test("heartbeat: liveness, mode and kills for `acpx capacity` / `acpx governor status`", async (t) => {
  const box = stormBox(t, 130);
  const governor = startedGovernor(box);
  governor.tick();
  await governor.settle();
  const hb = JSON.parse(fs.readFileSync(path.join(box.dir, "heartbeat.json"), "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(hb.pid, 50);
  assert.equal(hb.mode, "enforce");
  assert.equal(hb.killsLast24h, 1);
  assert.equal((hb.lastKill as { rule: string }).rule, "fork-storm");
});

test("peaks: per kind, processes and anon as independent maxima; a finished day becomes rows at 00:00 with a stable id", async (t) => {
  const box = new FakeBox();
  t.after(() => box.cleanup());
  box.standardSystem();
  const { claudePid } = box.owner(100, "sess-pk", "seat-pk");
  box.toolSession(2000, claudePid, 20); // most processes
  box.add({ pid: 3000, ppid: claudePid, comm: "tsc", rssKb: 1200 * 1024 }); // most memory
  box.nowMs = Date.parse("2026-11-08T23:59:00.000Z");
  const governor = startedGovernor(box);
  governor.tick();
  box.nowMs = Date.parse("2026-11-09T00:00:05.000Z");
  governor.tick();
  await governor.settle();
  const peaks = box.events().filter((e) => e.action === "peaks");
  assert.equal(peaks.length, 1);
  assert.equal(peaks[0].session_kind, "tool");
  assert.equal(peaks[0].processes, 20);
  assert.ok(Number(peaks[0].anon_bytes) >= 1200 * MIB);
  assert.equal(peaks[0].captured_at, "2026-11-08 00:00:00.000");
  assert.deepEqual(peaks[0].comm_top, [["bash", 20]]);
});
