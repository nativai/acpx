#!/usr/bin/env python3
"""The governor rig's own instruments (brick 5d7a23b6, CONCEPTION §10) — run INSIDE the rig's workbench.

  governor-rig-sampler.py <heartbeat.json> <out.jsonl>   sample /proc every 50 ms (run under timeout -s KILL 900)
  governor-rig-sampler.py --report <out.jsonl>           summarise a sampling run
  governor-rig-sampler.py --orphan <sid>                 AC2: cut every parent link of a storm

The sampler is the harness's timer for AC1(a) — "within 5 s of that session reaching 128 processes, timed by the
test harness's own 50 ms /proc sampler, not by the governor's log" — and for AC1(f), the heartbeat gaps, and AC2's
regrowth checks. It records, per session id: the first sample at >= 128 live members, the first sample after that
with none, and the member count 3 s and 30 s later (a regrowth = wave 2). Only /proc/<pid>/stat is read.
"""
import json, os, signal, sys, time


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
        if f[0] in ("Z", "X"):
            continue
        procs[int(d)] = dict(ppid=int(f[1]), pgid=int(f[2]), sid=int(f[3]), start=int(f[19]), comm=s[s.find("(") + 1:r])
    return procs


def by_sid(procs):
    out = {}
    for p in procs.values():
        out[p["sid"]] = out.get(p["sid"], 0) + 1
    return out


def heartbeat_at(path):
    try:
        with open(path) as fh:
            return json.load(fh).get("lastScanAt")
    except (OSError, ValueError):
        return None


def sample(hb_path, out_path):
    out = open(out_path, "a")

    def emit(**row):
        row["wall"] = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"
        out.write(json.dumps(row) + "\n")
        out.flush()

    emit(event="start", heartbeat=hb_path)
    crossed, emptied, rechecks = {}, {}, []
    last_hb, last_hb_change, max_gap, storm_gap = None, time.monotonic(), 0.0, 0.0
    last_summary = time.monotonic()
    while True:
        now = time.monotonic()
        counts = by_sid(scan())
        storming = any(n >= 32 for n in counts.values())
        hb = heartbeat_at(hb_path)
        if hb != last_hb:
            last_hb, last_hb_change = hb, now
        gap = now - last_hb_change
        max_gap = max(max_gap, gap)
        if storming:
            storm_gap = max(storm_gap, gap)
        for sid, n in counts.items():
            if n >= 128 and sid not in crossed:
                crossed[sid] = now
                emit(event="crossed", sid=sid, count=n)
        for sid, at in crossed.items():
            if sid not in emptied and counts.get(sid, 0) == 0:
                emptied[sid] = now
                emit(event="empty", sid=sid, cross_to_empty_s=round(now - at, 3))
                rechecks += [(now + 3, sid, 3), (now + 30, sid, 30)]
        for item in [r for r in rechecks if r[0] <= now]:
            rechecks.remove(item)
            emit(event="recheck", sid=item[1], after_s=item[2], survivors=counts.get(item[1], 0))
        if now - last_summary >= 5:
            emit(event="heartbeat", max_gap_s=round(max_gap, 3), max_gap_during_storm_s=round(storm_gap, 3),
                 largest_session=max(counts.values()) if counts else 0)
            last_summary = now
        time.sleep(0.05)


def report(path):
    rows = [json.loads(line) for line in open(path) if line.strip()]
    sids = {}
    for r in rows:
        if "sid" in r:
            sids.setdefault(r["sid"], []).append(r)
    for sid, rs in sids.items():
        crossed = next((r for r in rs if r["event"] == "crossed"), None)
        empty = next((r for r in rs if r["event"] == "empty"), None)
        checks = {r["after_s"]: r["survivors"] for r in rs if r["event"] == "recheck"}
        ok = bool(empty) and empty["cross_to_empty_s"] <= 5 and all(v == 0 for v in checks.values()) and len(checks) == 2
        print(json.dumps(dict(sid=sid, crossed_at=crossed and crossed["wall"], cross_to_empty_s=empty and empty["cross_to_empty_s"],
                              survivors_after_3s=checks.get(3), survivors_after_30s=checks.get(30), ac1a_pass=ok)))
    hbs = [r for r in rows if r["event"] == "heartbeat"]
    if hbs:
        print(json.dumps(dict(heartbeat_max_gap_s=max(r["max_gap_s"] for r in hbs),
                              heartbeat_max_gap_during_storm_s=max(r["max_gap_during_storm_s"] for r in hbs),
                              ac1f_pass=max(r["max_gap_during_storm_s"] for r in hbs) <= 2)))


def orphan(sid):
    """Kill the storm's shell and every intermediate, keep its newest shell (the recursion frontier)."""
    procs = scan()
    members = {p: v for p, v in procs.items() if v["sid"] == sid}
    shells = [p for p, v in members.items() if v["comm"] in ("bash", "sh", "dash", "zsh")]
    if not shells:
        print(json.dumps(dict(error="no shell member", sid=sid, members=len(members))))
        return 1
    leaf = max(shells, key=lambda p: members[p]["start"])
    killed = 0
    for p, v in members.items():
        if p == leaf:
            continue
        try:
            with open(f"/proc/{p}/stat") as fh:
                s = fh.read()
            if int(s[s.rfind(")") + 2:].split()[19]) != v["start"]:
                continue  # the pid moved on
            os.kill(p, signal.SIGKILL)
            killed += 1
        except (OSError, ValueError):
            pass
    time.sleep(0.5)
    left = {p: v for p, v in scan().items() if v["sid"] == sid}
    print(json.dumps(dict(sid=sid, members_before=len(members), killed=killed, leaf=leaf,
                          leaf_ppid_now=left.get(leaf, {}).get("ppid"), members_after=len(left))))
    return 0


if __name__ == "__main__":
    if sys.argv[1] == "--report":
        report(sys.argv[2])
    elif sys.argv[1] == "--orphan":
        sys.exit(orphan(int(sys.argv[2])))
    else:
        sample(sys.argv[1], sys.argv[2])
