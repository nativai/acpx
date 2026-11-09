import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { GovProc } from "../src/capacity/governor/classify.js";
import {
  parallelScanner,
  type ProcScanner,
  streamingScanner,
} from "../src/capacity/governor/scan.js";
import { FakeBox } from "./governor-fixtures.js";

// brick 07f4fde2 — CONCEPTION 5d7a23b6 §19 D5 "kill on crossing, mid-scan", and the parallel /proc scan
// that lets the count reach 128 while one `stat` read is blocked in the kernel (the D3a profile).

function box(t: { after: (fn: () => void) => void }): FakeBox {
  const b = new FakeBox();
  t.after(() => b.cleanup());
  b.standardSystem();
  return b;
}

const crossingLine = (b: FakeBox) => b.logs.find((l) => / on_crossing=\d+/u.test(l));

/** A tool command remembered below the limit by a first full scan, then grown past it. */
function rememberedStorm(b: FakeBox, grow: number) {
  const { claudePid } = b.owner(100, "sess-cross-0001", "seat-cross-1");
  b.toolSession(2000, claudePid, 100);
  return () => b.addMany(grow, { ppid: 2000, pgid: 2001, sid: 2000, comm: "bash" }, 2100);
}

test("§19 D5 crossing: the scan's 128th member of a remembered session triggers the sweep — only pgids that pass the guard are signalled", async (t) => {
  const b = box(t);
  const grow = rememberedStorm(b, 200);
  const g = b.governor();
  assert.deepEqual(g.start(), { started: true });
  g.tick(); // 100 members: placed and remembered, nothing signalled
  assert.equal(b.signals.length, 0);
  grow();
  // A pgid of the same session that FAILS the guard: live `node` members whose argv cannot be read.
  const guarded = b.addMany(3, { ppid: 2000, pgid: 2400, sid: 2000, comm: "node" }, 2400);
  for (const pid of guarded) {
    fs.rmSync(path.join(b.proc, String(pid), "cmdline"));
  }
  b.nowMs += 100;
  g.tick();
  await g.settle();

  const line = crossingLine(b);
  assert.ok(line, "the sweep came from the crossing, mid-scan");
  // 128 counted; +1 when the leader was read fresh because the cursor had not reached it yet.
  assert.match(line, /sid=2000 .* on_crossing=12[89]\b/u);
  assert.ok(
    b.groupKills().every((pgid) => pgid === 2000 || pgid === 2001),
    `group kills ${JSON.stringify(b.groupKills())} — never the guarded pgid 2400`,
  );
  assert.ok(b.groupKills().includes(2001));
  assert.deepEqual(
    b.members(2000).map((p) => p.pid),
    guarded,
    "the storm is gone; the guarded members were never signalled",
  );
  assert.equal(
    b.signals.filter((s) => guarded.includes(s.target)).length,
    0,
    "no per-pid signal to a guarded member either",
  );
  const killed = b.events().filter((e) => e.action === "killed");
  assert.equal(killed.length, 1, "one kill: the full-scan R1 does not sweep the session again");
  assert.ok(Number(killed[0].processes) >= 128);
  assert.match(b.stderrOf(2000), /^process-governor: KILLED this command/u);
});

test("§19 D5 crossing never fires for an exempt session: system, verified owners (token, lease), observe mode, exempt terminal", async (t) => {
  const b = box(t);
  b.owner(100, "sess-owner-big");
  b.add({ pid: 200, ppid: 1, comm: "node" }); // lease-only owner
  b.lease("sess-lease-200", 200);
  b.add({ pid: 3000, ppid: 41, comm: "bash", tty: 34816 }); // a ttyd terminal
  const g = b.governor({}, { governTerminals: false });
  assert.deepEqual(g.start(), { started: true });
  g.tick(); // every session placed and remembered
  b.addMany(200, { ppid: 40, pgid: 6, sid: 6, comm: "node" }, 7000); // system session
  b.addMany(200, { ppid: 102, pgid: 100, sid: 100, comm: "bash" }, 8000); // token owner session
  b.addMany(200, { ppid: 200, pgid: 200, sid: 200, comm: "bash" }, 9000); // lease owner session
  b.addMany(200, { ppid: 3000, pgid: 3001, sid: 3000, comm: "bash" }, 10_000); // exempt terminal
  b.nowMs += 100;
  g.tick();
  await g.settle();
  assert.deepEqual(b.signals, []);
  assert.equal(crossingLine(b), undefined);
  assert.equal(b.events().filter((e) => e.action === "killed").length, 0);
  assert.equal(
    b.events().filter((e) => e.action === "would_kill" && e.notify_status === "exempt-terminal")
      .length,
    1,
    "the terminal storm is still seen (§18 C4), by the full-scan path",
  );

  // Observe mode: a remembered tool storm crossing 128 is not signalled; the full scan's would_kill stands.
  const o = box(t);
  const grow = rememberedStorm(o, 200);
  const og = o.governor({}, { mode: "observe" });
  assert.deepEqual(og.start(), { started: true });
  og.tick();
  grow();
  o.nowMs += 100;
  og.tick();
  await og.settle();
  assert.deepEqual(o.signals, []);
  assert.equal(crossingLine(o), undefined);
  assert.equal(o.events().filter((e) => e.action === "would_kill").length, 1);
});

test("§19 D5 crossing: the partial-view kill is followed by the full sweep — a group born in the race dies too (0 survivors)", async (t) => {
  const b = box(t);
  const grow = rememberedStorm(b, 300);
  let raced = false;
  const g = b.governor(
    {},
    {},
    {
      // The first group kill races a job-control shell creating a NEW group (F2): round 2's fresh full scan
      // must find and kill it.
      signal: (target, sig) => {
        if (!raced && target < 0) {
          raced = true;
          b.addMany(30, { ppid: 2000, pgid: 2500, sid: 2000, comm: "bash" }, 2500);
        }
        b.signal(target, sig);
      },
    },
  );
  assert.deepEqual(g.start(), { started: true });
  g.tick();
  grow();
  b.nowMs += 100;
  g.tick();
  await g.settle();
  assert.ok(crossingLine(b));
  assert.ok(raced);
  assert.ok(b.groupKills().includes(2500), "the racing group was swept by a later round");
  assert.deepEqual(b.members(2000), []);
  const killed = b.events().find((e) => e.action === "killed");
  assert.equal(killed?.survivors, 0);
  assert.ok(Number(killed?.rounds) >= 2);
});

test("§19 D7 first sight: a non-exempt storm first seen in THIS scan is crossed at its 128th member, placed and remembered", async (t) => {
  const b = box(t);
  const { claudePid } = b.owner(100, "sess-first-0001", "seat-first-1");
  b.toolSession(2000, claudePid, 300);
  const g = b.governor();
  assert.deepEqual(g.start(), { started: true });
  g.tick(); // the session's first sight: no earlier full scan placed it
  await g.settle();
  assert.match(crossingLine(b) ?? "", /sid=2000 .* on_crossing=12[89]\b/u);
  assert.deepEqual(b.members(2000), []);
  const killed = b.events().filter((e) => e.action === "killed");
  assert.equal(killed.length, 1);
  assert.equal(
    killed[0].session_kind,
    "tool",
    "placed by the normal classifier on the partial view",
  );
  assert.equal(killed[0].session_id, "sess-first-0001", "attributed through the owner lease");
  assert.ok(b.atriumCalls.length > 0, "the seat is told, as for any attributed kill");
});

test("§19 D7 first sight never crosses the system session, a token-owner leader, a lease-named sid, or a terminal under governTerminals:false", async (t) => {
  const b = box(t);
  b.addMany(200, { ppid: 40, pgid: 6, sid: 6, comm: "node" }, 7000); // system session
  b.owner(100, "sess-owner-first");
  b.addMany(200, { ppid: 102, pgid: 100, sid: 100, comm: "bash" }, 8000); // token-owner leader
  b.add({ pid: 200, ppid: 1, comm: "node" }); // no argv token: only the lease names it
  b.lease("sess-lease-first", 200);
  b.addMany(200, { ppid: 200, pgid: 200, sid: 200, comm: "bash" }, 9000);
  b.add({ pid: 3000, ppid: 41, comm: "bash", tty: 34816 }); // a ttyd terminal
  b.addMany(200, { ppid: 3000, pgid: 3001, sid: 3000, comm: "bash" }, 10_000);
  const g = b.governor({}, { governTerminals: false });
  assert.deepEqual(g.start(), { started: true });
  g.tick(); // every one of them is a first sight, each past 128
  await g.settle();
  assert.equal(b.signals.length, 0);
  assert.equal(crossingLine(b), undefined);
  assert.equal(b.events().filter((e) => e.action === "killed").length, 0);
});

test("§19 D7 first sight WAITS when the leader's argv cannot be read; the full scan then decides as before", async (t) => {
  const b = box(t);
  const { claudePid } = b.owner(100, "sess-unreadable-1");
  b.toolSession(2000, claudePid, 300);
  fs.rmSync(path.join(b.proc, "2000", "cmdline")); // the leader's owner token: undecidable
  const g = b.governor();
  assert.deepEqual(g.start(), { started: true });
  g.tick();
  await g.settle();
  assert.equal(crossingLine(b), undefined, "no crossing on an undecided first sight");
  assert.ok(
    b.logs.some((l) => /process-governor sweep sid=2000 /u.test(l)),
    "the full-scan R1 still acted",
  );
  assert.ok(
    !b.groupKills().includes(2000),
    "the guard still refuses the unverified leader's own group",
  );
});

/** A scanner whose first `incomplete` scans lose `dropped` pids, as a stuck reader's share is lost. */
function droppingScanner(b: FakeBox, dropped: ReadonlySet<number>, incomplete = 1): ProcScanner {
  const inner = streamingScanner(b.proc);
  let calls = 0;
  return (visit) => {
    calls += 1;
    if (calls > incomplete) {
      return inner(visit);
    }
    const isDropped = (pid: number) => dropped.has(pid);
    const r = inner(
      visit && ((entry, byPid) => !isDropped(entry.pid) && visit(entry, byPid, isDropped)),
    );
    for (const pid of dropped) {
      r.byPid.delete(pid);
    }
    return { ...r, complete: false };
  };
}

test("TE F3: an incomplete scan never persists a first-sight placement — the next complete scan places it", (t) => {
  const b = box(t);
  const { claudePid } = b.owner(100, "sess-f3-0001");
  b.toolSession(2000, claudePid, 5);
  // The first scan loses the harness (`claude`): from that view the command would place as `outside`.
  const g = b.governor({}, {}, { scanner: droppingScanner(b, new Set([claudePid])) });
  assert.deepEqual(g.start(), { started: true });
  g.tick();
  b.nowMs += 1000;
  g.tick(); // complete
  g.shutdown();
  const groups = JSON.parse(fs.readFileSync(path.join(b.dir, "groups.json"), "utf8")) as Array<{
    sid: number;
    placement: { governed: boolean; kind?: string; reason?: string };
  }>;
  const placement = groups.find((r) => r.sid === 2000)?.placement;
  assert.equal(placement?.governed, true, `remembered ${JSON.stringify(placement)}`);
  assert.equal(placement?.kind, "tool");
});

test("§19 D7 waits when THIS scan did not deliver the leader (its reader dropped) — no first-sight crossing", async (t) => {
  const b = box(t);
  const { claudePid } = b.owner(100, "sess-noleader-1");
  b.toolSession(2000, claudePid, 300);
  const g = b.governor({}, {}, { scanner: droppingScanner(b, new Set([2000])) });
  assert.deepEqual(g.start(), { started: true });
  g.tick();
  await g.settle();
  assert.equal(crossingLine(b), undefined);
});

// ---------------------------------------------------------------------------
// the parallel scanner
// ---------------------------------------------------------------------------

function scannerFor(t: { after: (fn: () => unknown) => void }, b: FakeBox, stuckMs = 250) {
  const logs: string[] = [];
  const s = parallelScanner({
    procRoot: b.proc,
    readers: 4,
    nice: 0,
    stuckMs,
    log: (l) => logs.push(l),
  });
  t.after(() => s.close());
  return { ...s, logs };
}

const table = (byPid: ReadonlyMap<number, GovProc>) =>
  [...byPid.values()].map((p) => `${p.pid}:${p.sid}:${p.pgid}:${p.startTicks}`).toSorted();

test("parallel scanner: reads the same table as the streaming scanner; a stopping visit ends the scan and the next is full", (t) => {
  const b = box(t);
  b.toolSession(2000, 41, 300);
  const s = scannerFor(t, b);
  const full = s.scan();
  assert.equal(full.complete, true);
  assert.equal(full.stopped, false);
  assert.deepEqual(table(full.byPid), table(streamingScanner(b.proc)().byPid));
  assert.ok(
    s.logs.some((l) => /scan reader \d: (nice|could not set nice)/u.test(l)),
    "each reader reports its nice",
  );

  let seen = 0;
  const partial = s.scan((entry) => entry.sid === 2000 && ++seen === 50);
  assert.equal(partial.stopped, true);
  assert.equal(partial.complete, false);
  assert.ok(partial.byPid.size < full.byPid.size);
  const again = s.scan();
  assert.equal(again.complete, true);
  assert.deepEqual(table(again.byPid), table(full.byPid));
});

/** Turn `pid`'s stat into a FIFO: reading it blocks in the kernel until released (the D3a stall). */
function blockStat(t: { after: (fn: () => void) => void }, b: FakeBox, pid: number): () => void {
  const stat = path.join(b.proc, String(pid), "stat");
  const line = fs.readFileSync(stat, "utf8");
  fs.rmSync(stat);
  execFileSync("mkfifo", [stat]);
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    const fd = fs.openSync(stat, "w"); // completes the blocked reader's open()
    fs.rmSync(stat);
    fs.writeFileSync(stat, line); // later scans read a plain file again
    fs.writeSync(fd, line);
    fs.closeSync(fd);
  };
  t.after(release); // register BEFORE the scanner: a thread blocked in open() cannot be terminated
  return release;
}

test("parallel scanner: a reader blocked on a /proc read is dropped after stuckMs and logged, never blocks the count or the crossing, and rejoins once released", async (t) => {
  const b = box(t);
  b.toolSession(2000, 41, 400);
  const blockedPid = 2003; // reader 3's share (2003 % 4)
  const release = blockStat(t, b, blockedPid); // registered first: released before the scanner closes
  const s = scannerFor(t, b, 250);

  // 1. A full scan: reader 3 goes silent inside it; the scan completes without its share after the bound.
  const t0 = performance.now();
  const full = s.scan();
  const fullMs = performance.now() - t0;
  assert.equal(full.complete, false);
  assert.ok(fullMs >= 240 && fullMs < 2000, `bounded by stuckMs (${Math.round(fullMs)} ms)`);
  assert.ok(full.byPid.size > 300, "the other readers' shares are all there");
  assert.ok(!full.byPid.has(blockedPid));
  assert.ok(s.logs.some((l) => /scan reader 3 silent > 250 ms/u.test(l)));

  // 2. The crossing: reader 3 is still blocked (silent past the bound), so it is left out AT ONCE and
  //    the 128th member of sid 2000 is counted from the other readers without waiting for it.
  let count = 0;
  const t1 = performance.now();
  const crossing = s.scan((entry) => entry.sid === 2000 && ++count === 128);
  const crossingMs = performance.now() - t1;
  assert.equal(crossing.stopped, true);
  assert.ok(
    crossingMs < 250,
    `crossing counted in ${Math.round(crossingMs)} ms, not after the bound`,
  );

  // 3. Released: the reader finishes, rejoins, and a scan is complete again.
  release();
  let after = s.scan();
  for (let i = 0; i < 50 && !after.complete; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    after = s.scan();
  }
  assert.equal(after.complete, true);
  assert.ok(after.byPid.has(blockedPid));
});
