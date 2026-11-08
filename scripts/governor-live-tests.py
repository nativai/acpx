#!/usr/bin/env python3
"""Live tests of the runaway process-tree governor (brick 5d7a23b6, CONCEPTION §11 N1-N5).

REAL processes, so this refuses to run unless ALL of these hold (run it through
scripts/governor-live-tests.sh, which sets the caps):
  - ACPX_GOVERNOR_LIVE_TESTS=1;
  - not a control pod (/data/runtime or /opt/acpx-ui present => refuse): workbench only;
  - RLIMIT_NPROC soft limit set and <= 2000 (`ulimit -u`);
  - ACPX_GOVERNOR_LIVE_UNDER_TIMEOUT=1 (the wrapper's promise that `timeout -s KILL` wraps it).
Every storm is depth-capped (DMAX) and its leaf sleeps, so it is finite even if every kill fails.

Basis: the conception's evidence/killrace.py (same storm shape, same /proc reads). The storm is a
job-control shell (`set -m`, like Claude Code's Bash tool shell) running a recursive pipeline
function — the 2026-11-08 shape. No argv or environ of any process is read, except the harness's
own N5 children, matched by comm + a distinctive sleep length.

Usage: governor-live-tests.py <dist main.js> <results.jsonl> N1x20 N2 N3x10 N4x3 N5
Prints one JSON line per trial, and appends it to <results.jsonl>.
"""
import json, os, resource, signal, subprocess, sys, tempfile, threading, time

DIST_MAIN = sys.argv[1]
RESULTS = sys.argv[2]
PLAN = sys.argv[3:]

DMAX = int(os.environ.get("DMAX", "400"))
STEP = os.environ.get("STEP", "0.02")
LEAF_S = os.environ.get("LEAF_S", "120")
SLOW_STEP = os.environ.get("SLOW_STEP", "0.2")

# `unset FUNCNEST` INSIDE the storm: acpx exports FUNCNEST=64 into every agent environment (c2af7c83) and
# workbench-exec forwards it, so without this bash stops the recursion at depth 64 — below R1's 128 — and N1
# false-FAILs from any agent seat (TE finding F7). The AC1 prompt does the same. The depth cap is DMAX.
STORM = r'''
unset FUNCNEST
set -m
f(){ local d=$1; if [ "$d" -ge %d ]; then sleep %s; return; fi; sleep %s; echo x | cat | f $((d+1)); }
f 0
'''


def refuse(why):
    print(json.dumps({"refused": why}), flush=True)
    sys.exit(3)


def preflight():
    if os.environ.get("ACPX_GOVERNOR_LIVE_TESTS") != "1":
        refuse("ACPX_GOVERNOR_LIVE_TESTS=1 not set")
    if os.path.exists("/data/runtime") or os.path.exists("/opt/acpx-ui"):
        refuse("this looks like a control pod; live storms run only in a workbench")
    soft, _ = resource.getrlimit(resource.RLIMIT_NPROC)
    if soft == resource.RLIM_INFINITY or soft > 2000:
        refuse("RLIMIT_NPROC soft limit must be set and <= 2000 (ulimit -u 2000)")
    if os.environ.get("ACPX_GOVERNOR_LIVE_UNDER_TIMEOUT") != "1":
        refuse("run through scripts/governor-live-tests.sh (timeout -s KILL)")


def scan():
    procs = {}
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            with open(f"/proc/{d}/stat") as fh:
                s = fh.read()
        except OSError:
            continue
        r = s.rfind(")")
        f = s[r + 2:].split()
        procs[int(d)] = (int(f[1]), int(f[2]), int(f[3]), f[0], s[s.find("(") + 1:r])  # ppid pgrp sid state comm
    return procs


def members(sid):
    return {p: v for p, v in scan().items() if v[2] == sid and v[3] != "Z"}


def descendants(root):
    procs = scan()
    kids = {}
    for p, v in procs.items():
        kids.setdefault(v[0], []).append(p)
    out, stack = [], [root]
    while stack:
        x = stack.pop()
        for c in kids.get(x, []):
            out.append(c)
            stack.append(c)
    return out


def kill(pid):
    try:
        os.kill(pid, signal.SIGKILL)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def end_session(sid):
    for _ in range(100):
        m = members(sid)
        if not m:
            return 0
        for g in {v[1] for v in m.values()}:
            kill(-g)
        time.sleep(0.02)
    return len(members(sid))


class Sampler(threading.Thread):
    """The harness's own 50 ms /proc sampler for one sid — never the governor's log."""

    def __init__(self, sid):
        super().__init__(daemon=True)
        self.sid, self.stop_at = sid, None
        self.crossed_at = self.empty_at = None
        self.crossed_bound = False
        self.last_below_at = None
        self.peak = 0
        self.running = True

    def run(self):
        while self.running:
            n = len(members(self.sid))
            now = time.monotonic()
            self.peak = max(self.peak, n)
            if self.crossed_at is None and n >= 128:
                self.crossed_at = now
            elif self.crossed_at is None and n > 0:
                self.last_below_at = now
            if self.empty_at is None and n == 0 and self.peak >= 64:
                if self.crossed_at is None and self.last_below_at is not None:
                    # The governor killed the storm at 128 BETWEEN two of our samples (measured: 1 trial in
                    # 20). The crossing then lies after our last sample below 128: bound it by that sample.
                    # N1 checks the governor's own event says >= 128.
                    self.crossed_at, self.crossed_bound = self.last_below_at, True
                if self.crossed_at is not None:
                    self.empty_at = now
            time.sleep(0.05)


class Governor:
    def __init__(self, home):
        self.home = home
        env = dict(os.environ, ACPX_GOVERNOR_TEST="1", ACPX_STATE_HOME=home,
                   ACPX_GOVERNOR_ATRIUM_URL="http://127.0.0.1:9")
        self.log = open(os.path.join(home, "governor.log"), "w")
        self.proc = subprocess.Popen(["node", "--max-old-space-size=64", DIST_MAIN, "--test-rig"],
                                     cwd="/", env=env, stdout=self.log, stderr=subprocess.STDOUT,
                                     start_new_session=True)
        hb = os.path.join(home, ".acpx", "governor", "heartbeat.json")
        for _ in range(100):
            if os.path.exists(hb):
                return
            time.sleep(0.1)
        raise RuntimeError("governor wrote no heartbeat")

    def events(self):
        try:
            with open(os.path.join(self.home, ".acpx", "governor", "events.ndjson")) as fh:
                return [json.loads(line) for line in fh if line.strip()]
        except OSError:
            return []

    def rss_kb(self):
        try:
            with open(f"/proc/{self.proc.pid}/status") as fh:
                for line in fh:
                    if line.startswith("VmRSS:"):
                        return int(line.split()[1])
        except OSError:
            return None

    def stop(self):
        self.proc.send_signal(signal.SIGTERM)
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()


# The production shape: Claude Code runs each Bash tool command as a NEW SESSION whose leader's parent is
# the `claude` process (F1). A command whose session is born OUTSIDE any governed session is, by design,
# never governed (§3.2) — and under `workbench-exec --detach` this harness's own session is parented by
# PID 1, so storms spawned directly by it were classified `outside` and only raised ungoverned_burst.
# So every command here is started by a stand-in harness: python under the comm name `claude`.
FAKE_CLAUDE_DIR = tempfile.mkdtemp(prefix="govlive-claude-")
FAKE_CLAUDE = os.path.join(FAKE_CLAUDE_DIR, "claude")
os.symlink(sys.executable, FAKE_CLAUDE)
LAUNCH = ("import subprocess,sys\n"
          "p=subprocess.Popen(sys.argv[1:],start_new_session=True,stdout=subprocess.DEVNULL)\n"
          "print(p.pid,flush=True)\n"
          "sys.exit(p.wait())\n")


def as_tool_command(argv, stderr=None):
    """Run `argv` as a tool command: a new session whose leader's parent is a process named `claude`."""
    harness = subprocess.Popen([FAKE_CLAUDE, "-I", "-c", LAUNCH] + argv, stdout=subprocess.PIPE,
                               stderr=stderr if stderr is not None else subprocess.DEVNULL)
    sid = int(harness.stdout.readline().decode().strip())
    harness.sid = sid
    return harness


def storm(step):
    return as_tool_command(["bash", "-c", STORM % (DMAX, LEAF_S, step)], stderr=subprocess.PIPE)


def n1(gov):
    """A storm (~50 levels/s) is killed within 5 s of crossing 128; zero survivors at +1/+3/+30 s."""
    p = storm(STEP)
    sid = p.sid
    s = Sampler(sid)
    s.start()
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline and (s.crossed_at is None or s.empty_at is None):
        time.sleep(0.05)
    s.running = False
    after = {}
    t0 = time.monotonic()
    for mark in (1, 3, 30):
        time.sleep(max(0, t0 + mark - time.monotonic()))
        after[f"survivors_after_{mark}s"] = len(members(sid))
    try:
        p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    stderr = p.stderr.read().decode("utf-8", "replace") if p.stderr else ""
    ev = [e for e in gov.events() if e.get("action") == "killed" and e.get("kill_ms") is not None]
    last = ev[-1] if ev else {}
    leftover = end_session(sid)
    ok = (s.crossed_at is not None and s.empty_at is not None and s.empty_at - s.crossed_at <= 5
          and all(v == 0 for v in after.values())
          and (not s.crossed_bound or (last.get("processes") or 0) >= 128))
    return dict(test="N1", pass_=ok, peak=s.peak, crossing_bounded_by_last_sample_below=s.crossed_bound,
                cross_to_empty_s=None if s.empty_at is None or s.crossed_at is None else round(s.empty_at - s.crossed_at, 3),
                **after, inband_line="process-governor: KILLED" in stderr,
                event_processes=last.get("processes"), event_rounds=last.get("rounds"), event_kill_ms=last.get("kill_ms"),
                event_kind=last.get("session_kind"), leftover_after_cleanup=leftover)


def n2(gov):
    """100 parallel processes for 20 s, and one 1.2 GiB process, are NOT killed (below R2's line)."""
    before = len(gov.events())
    par = as_tool_command(["bash", "-c", "seq 100 | xargs -P 100 -I{} sleep 20"])
    mem = as_tool_command([sys.executable, "-I", "-c",
                           "import time\nb=bytearray(1288490188)\nfor i in range(0,len(b),4096): b[i]=1\ntime.sleep(25)"])
    time.sleep(3)
    par_peak = len(members(par.sid))
    rc_par = par.wait(timeout=60)
    rc_mem = mem.wait(timeout=60)
    new = [e for e in gov.events()[before:] if e.get("action") in ("killed", "would_kill")]
    return dict(test="N2", pass_=(rc_par == 0 and rc_mem == 0 and not new), parallel_peak=par_peak,
                rc_parallel=rc_par, rc_1_2gib=rc_mem, kill_events=len(new))


def n3(_gov):
    """Control (no governor): the claude-style snapshot kill leaves a regrowing remainder in some trials."""
    p = storm(STEP)
    sid = p.sid
    time.sleep(1.5)
    snap = descendants(sid)
    kill(-sid)
    for c in snap:
        kill(c)
    time.sleep(1.0)
    a1 = len(members(sid))
    time.sleep(2.0)
    a3 = len(members(sid))
    leftover = end_session(sid)
    try:
        p.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    return dict(test="N3", snapshot=len(snap), survivors_after_1s=a1, survivors_after_3s=a3,
                regrew=a3 > a1 > 0 or a3 > 0, leftover_after_cleanup=leftover)


def n4(gov):
    """`setsid ./job.sh` inside a command: a DERIVED session, counted on its own, killed at 128."""
    before = len(gov.events())
    job = STORM % (DMAX, LEAF_S, STEP)
    outer = as_tool_command(["bash", "-c", 'setsid bash -c "$1" >&2 & echo $! >&2; wait', "outer", job],
                            stderr=subprocess.PIPE)
    inner_sid = int(outer.stderr.readline().decode().strip())
    s = Sampler(inner_sid)
    s.start()
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline and (s.crossed_at is None or s.empty_at is None):
        time.sleep(0.05)
    s.running = False
    time.sleep(1)
    try:
        outer.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    outer_killed = outer.returncode == 256 - signal.SIGKILL  # the stand-in exits with its child's -9 & 0xff
    killed = [e for e in gov.events()[before:] if e.get("action") == "killed"]
    end_session(inner_sid)
    end_session(outer.sid)
    kinds = [e.get("session_kind") for e in killed]
    return dict(test="N4", pass_=(s.empty_at is not None and "derived" in kinds and len(killed) == 1 and not outer_killed),
                peak=s.peak, kinds=kinds, outer_command_killed=outer_killed,
                cross_to_empty_s=None if s.empty_at is None or s.crossed_at is None else round(s.empty_at - s.crossed_at, 3))


def n5(gov):
    """200 double-forked `setsid sleep &` children of a job-control shell: ungoverned_burst, NOT killed.

    The alarm is rate-limited to one per `alarmRepeatMs` (60 s) by design, so each trial first waits until the
    previous burst event is more than 61 s old — otherwise a later trial would wrongly read "no alarm"."""
    last = [e for e in gov.events() if e.get("action") == "ungoverned_burst"]
    if last:
        at = time.mktime(time.strptime(last[-1]["captured_at"][:19], "%Y-%m-%d %H:%M:%S")) - time.timezone
        time.sleep(max(0, at + 61 - time.time()))
    before = len(gov.events())
    mark = "37.123"
    sh = as_tool_command(["bash", "-c", f"set -m; for i in $(seq 200); do setsid sleep {mark} & done; wait"])
    sh.wait(timeout=30)
    time.sleep(3)

    def ours():
        out = []
        for p, v in scan().items():
            if v[4] != "sleep":
                continue
            try:
                with open(f"/proc/{p}/cmdline", "rb") as fh:  # our own children: match-only
                    if mark.encode() in fh.read():
                        out.append(p)
            except OSError:
                pass
        return out

    alive = ours()
    new = gov.events()[before:]
    burst = [e for e in new if e.get("action") == "ungoverned_burst"]
    killed = [e for e in new if e.get("action") in ("killed", "would_kill")]
    for p in alive:
        kill(p)
    return dict(test="N5", pass_=(len(alive) == 200 and len(burst) >= 1 and not killed),
                alive_after_3s=len(alive), burst_events=len(burst), burst_gain=burst[0].get("processes") if burst else None,
                kill_events=len(killed))


# TE's X2: the classic `&` binary fork bomb, depth-capped at 9 (<= 1,023 shells + 512 leaf sleeps). A
# doubling bomb used to finish inside one idle 1 s interval (killed at 1,535 = the whole capped tree);
# with the §19 D3 pid watcher it must die at <= 256.
BOMB = 'unset FUNCNEST; b(){ if [ "$1" -ge 9 ]; then sleep 30; return; fi; b $(($1+1)) & b $(($1+1)) & wait; }; b 0'


def n6(gov):
    """X2: a depth-capped `&` doubling bomb is killed at <= 256 processes (§19 D3), none left."""
    before = len(gov.events())
    # NICE_STORM=19 emulates production's priority gap in a workbench (no CAP_SYS_NICE there, so the
    # governor runs at nice 0): CFS weight nice 0 / nice 19 = 1024/15 ≈ 68×, production nice −20 / 0 =
    # 88761/1024 ≈ 87×. Reported in every row; 0 = no emulation.
    nice = int(os.environ.get("NICE_STORM", "0"))
    p = as_tool_command(["nice", "-n", str(nice), "bash", "-c", BOMB])
    sid = p.sid
    s = Sampler(sid)
    s.start()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and not [e for e in gov.events()[before:] if e.get("action") == "killed"]:
        time.sleep(0.05)
    time.sleep(1.0)
    s.running = False
    killed = [e for e in gov.events()[before:] if e.get("action") == "killed"]
    survivors = len(members(sid))
    time.sleep(3)
    after3 = len(members(sid))
    end_session(sid)
    first = killed[0] if killed else {}
    return dict(test="N6", nice_storm=nice, pass_=bool(killed) and (first.get("processes") or 10**6) <= 256 and survivors == 0 and after3 == 0,
                killed_at_processes=first.get("processes"), rounds=first.get("rounds"), kill_ms=first.get("kill_ms"),
                sampler_peak=s.peak, survivors_after_1s=survivors, survivors_after_4s=after3, kills=len(killed))


TESTS = {"N1": n1, "N2": n2, "N3": n3, "N4": n4, "N5": n5, "N6": n6}


def main():
    preflight()
    home = tempfile.mkdtemp(prefix="govlive-")
    out = open(RESULTS, "a")
    gov = None
    try:
        for item in PLAN:
            name, _, n = item.partition("x")
            fn = TESTS[name]
            if name == "N3":
                if gov:
                    gov.stop()
                    gov = None
            elif gov is None:
                gov = Governor(home)
            for i in range(int(n or 1)):
                started = time.time()
                row = fn(gov)
                row.update(trial=i + 1, at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
                           dmax=DMAX, step=STEP, governor_rss_kb=gov.rss_kb() if gov else None)
                line = json.dumps(row)
                print(line, flush=True)
                out.write(line + "\n")
                out.flush()
                time.sleep(0.5)
    finally:
        if gov:
            gov.stop()
        out.close()
        print(json.dumps({"governor_home": home}), flush=True)


if __name__ == "__main__":
    main()
