import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CAPACITY_CONSTANTS, type CapacityConstants, MIB } from "../src/capacity/constants.js";
import { Notifier, type NotifyFetch } from "../src/capacity/governor/notify.js";
import { ClickHouseWriter, type FetchLike } from "../src/capacity/governor/record.js";
import {
  Governor,
  type GovernorDeps,
  type GovernorSettings,
} from "../src/capacity/governor/run.js";
import { queueOwnerTokenState } from "../src/process-tree-reap.js";

// brick 5d7a23b6 — a whole control pod as FILES: /proc (stat, status, cmdline, fd/2), the cgroup's
// memory files, the queue-owner leases and session records. The fake signal sink plays the kernel:
// a group SIGKILL removes every member of the pgid, a per-pid SIGKILL removes the pid, a SIGSTOP
// marks it stopped. Nothing here touches a real process.

export const GiB = 1024 * MIB;
export const UID = 1000;
/** A planted secret: it must never appear in any event, log line or message (U3). */
export const SECRET = "SECRET-TOKEN-do-not-print";

export type FakeProcess = {
  pid: number;
  ppid: number;
  pgid?: number;
  sid?: number;
  comm: string;
  state?: string;
  tty?: number;
  threads?: number;
  ticks?: number;
  /** argv carries `__queue-owner` (a queue owner, recognised by acpx's token check). */
  owner?: boolean;
  rssKb?: number;
  uid?: number;
  /** A group or pid kill of this process fails EPERM (root-owned, E19). */
  immortal?: boolean;
};

export type SignalCall = { target: number; signal: NodeJS.Signals };
export type FetchCall = { url: string; headers: Record<string, string>; body: string };

let tickCounter = 1000;

export class FakeBox {
  readonly root: string;
  readonly proc: string;
  readonly cgroup: string;
  readonly queue: string;
  readonly sessions: string;
  readonly dir: string;
  readonly procs = new Map<number, FakeProcess>();
  readonly signals: SignalCall[] = [];
  readonly logs: string[] = [];
  readonly atriumCalls: FetchCall[] = [];
  readonly clickhouseCalls: FetchCall[] = [];
  atriumStatus = 200;
  atriumBody = "{}";
  atriumDown = false;
  clickhouseStatus = 200;
  nowMs = Date.parse("2026-11-08T18:00:00.000Z");

  constructor() {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-governor-"));
    this.proc = path.join(this.root, "proc");
    this.cgroup = path.join(this.root, "cgroup");
    this.queue = path.join(this.root, "queues");
    this.sessions = path.join(this.root, "sessions");
    this.dir = path.join(this.root, "governor");
    for (const dir of [this.proc, this.cgroup, this.queue, this.sessions]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(path.join(this.proc, "stat"), "cpu 0 0 0 0\nbtime 1762560000\n");
    this.memory({ anon: 1 * GiB, kernel: 256 * MIB, max: 12 * GiB });
  }

  cleanup(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  memory(m: { anon: number; kernel: number; max: number | "max" }): void {
    fs.writeFileSync(
      path.join(this.cgroup, "memory.stat"),
      `anon ${Math.round(m.anon)}\nkernel ${Math.round(m.kernel)}\nfile 0\n`,
    );
    fs.writeFileSync(path.join(this.cgroup, "memory.max"), `${m.max}\n`);
    fs.writeFileSync(
      path.join(this.cgroup, "memory.pressure"),
      "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=1.50 avg60=0.00 avg300=0.00 total=0\n",
    );
  }

  add(p: FakeProcess): FakeProcess {
    const full: FakeProcess = {
      pgid: p.pid,
      sid: p.sid ?? p.pgid ?? p.pid,
      state: "S",
      tty: 0,
      threads: 1,
      ticks: (tickCounter += 1),
      rssKb: 4096,
      uid: UID,
      ...p,
    };
    this.procs.set(full.pid, full);
    this.write(full);
    return full;
  }

  /** `n` processes in one session/pgid, children of `ppid`. */
  addMany(n: number, base: Omit<FakeProcess, "pid">, firstPid: number): number[] {
    const pids: number[] = [];
    for (let i = 0; i < n; i += 1) {
      this.add({ ...base, pid: firstPid + i });
      pids.push(firstPid + i);
    }
    return pids;
  }

  private write(p: FakeProcess): void {
    const dir = path.join(this.proc, String(p.pid));
    fs.mkdirSync(path.join(dir, "fd"), { recursive: true });
    const stat =
      `${p.pid} (${p.comm}) ${p.state} ${p.ppid} ${p.pgid} ${p.sid} ${p.tty} -1 4194560 0 0 0 0 0 0 0 0 20 0 ` +
      `${p.threads} 0 ${p.ticks} 1000 200 18446744073709551615\n`;
    fs.writeFileSync(path.join(dir, "stat"), stat);
    fs.writeFileSync(
      path.join(dir, "status"),
      `Name:\t${p.comm}\nUid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}\nRssAnon:\t${p.rssKb} kB\nVmPTE:\t0 kB\n`,
    );
    fs.writeFileSync(
      path.join(dir, "cmdline"),
      p.owner ? `node\0/opt/acpx/dist/cli.js\0__queue-owner\0` : `${p.comm}\0-c\0${SECRET}\0`,
    );
    fs.writeFileSync(path.join(dir, "environ"), `ANTHROPIC_API_KEY=${SECRET}\0`);
    if (!fs.existsSync(path.join(dir, "fd", "2"))) {
      fs.writeFileSync(path.join(dir, "fd", "2"), "");
    }
  }

  remove(pid: number): void {
    this.procs.delete(pid);
    fs.rmSync(path.join(this.proc, String(pid)), { recursive: true, force: true });
  }

  /** What the killed command's stderr received. */
  stderrOf(pid: number): string {
    try {
      return fs.readFileSync(path.join(this.proc, String(pid), "fd", "2"), "utf8");
    } catch {
      return this.removedStderr.get(pid) ?? "";
    }
  }

  private readonly removedStderr = new Map<number, string>();

  lease(sessionId: string, pid: number, seatId?: string): void {
    const p = this.procs.get(pid) as FakeProcess;
    fs.writeFileSync(
      path.join(this.queue, `${sessionId.slice(0, 8)}.lock`),
      JSON.stringify({ pid, sessionId, processIdentity: { startTimeTicks: String(p.ticks) } }),
    );
    fs.writeFileSync(
      path.join(this.sessions, `${sessionId}.json`),
      JSON.stringify({
        agent_command: "node /opt/claude-agent-acp/dist/index.js",
        ...(seatId ? { seat_id: seatId } : {}),
      }),
    );
  }

  members(sid: number): FakeProcess[] {
    return [...this.procs.values()].filter((p) => p.sid === sid);
  }

  /** The fake kernel. */
  signal = (target: number, sig: NodeJS.Signals): void => {
    this.signals.push({ target, signal: sig });
    const hit =
      target < 0
        ? [...this.procs.values()].filter((p) => p.pgid === -target)
        : [this.procs.get(target)].filter((p): p is FakeProcess => p !== undefined);
    if (hit.length === 0) {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    }
    const allowed = hit.filter((p) => !p.immortal);
    for (const p of allowed) {
      if (sig === "SIGSTOP") {
        p.state = "T";
        this.write(p);
      } else if (sig === "SIGKILL") {
        this.removedStderr.set(p.pid, this.stderrOf(p.pid));
        this.remove(p.pid);
      }
    }
    if (allowed.length === 0) {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    }
  };

  readonly atriumFetch: NotifyFetch = async (url, init) => {
    this.atriumCalls.push({ url, headers: init.headers, body: init.body });
    if (this.atriumDown) {
      throw new Error("ECONNREFUSED");
    }
    const status = this.atriumStatus;
    const body = this.atriumBody;
    return { status, text: async () => body };
  };

  readonly clickhouseFetch: FetchLike = async (url, init) => {
    this.clickhouseCalls.push({ url, headers: init.headers, body: init.body });
    return { status: this.clickhouseStatus };
  };

  readStatus = (pid: number): string | undefined => {
    try {
      return fs.readFileSync(path.join(this.proc, String(pid), "status"), "utf8");
    } catch {
      return undefined;
    }
  };

  /** The entrypoint session (sid 6, PID 1's earliest child) with the governor inside it. */
  standardSystem(): { governorPid: number } {
    this.add({ pid: 6, ppid: 1, comm: "bash", ticks: 10 });
    this.add({ pid: 40, ppid: 6, pgid: 6, sid: 6, comm: "node" }); // atrium
    this.add({ pid: 41, ppid: 6, pgid: 6, sid: 6, comm: "ttyd" });
    this.add({ pid: 42, ppid: 6, pgid: 6, sid: 6, comm: "sshd" });
    this.add({ pid: 43, ppid: 6, pgid: 6, sid: 6, comm: "node" }); // VS Code pty host
    this.add({ pid: 50, ppid: 6, pgid: 6, sid: 6, comm: "node" }); // the governor
    return { governorPid: 50 };
  }

  /** A Claude owner tree (owner → adapter → claude), leased with a seat. */
  owner(ownerPid: number, sessionId: string, seatId?: string): { claudePid: number } {
    this.add({ pid: ownerPid, ppid: 1, comm: "node", owner: true });
    this.add({ pid: ownerPid + 1, ppid: ownerPid, pgid: ownerPid, sid: ownerPid, comm: "node" });
    this.add({
      pid: ownerPid + 2,
      ppid: ownerPid + 1,
      pgid: ownerPid,
      sid: ownerPid,
      comm: "claude",
    });
    this.lease(sessionId, ownerPid, seatId);
    return { claudePid: ownerPid + 2 };
  }

  /** A Bash tool command: a setsid shell under claude, its pipeline in a second group. */
  toolSession(sid: number, claudePid: number, processes: number): void {
    this.add({ pid: sid, ppid: claudePid, comm: "bash" });
    this.addMany(processes - 1, { ppid: sid, pgid: sid + 1, sid, comm: "bash" }, sid + 1);
  }

  governor(
    overrides: Partial<GovernorSettings> = {},
    constants: Partial<CapacityConstants["governor"]> = {},
    deps: Partial<GovernorDeps> = {},
  ): Governor {
    const merged: CapacityConstants = {
      ...CAPACITY_CONSTANTS,
      governor: { ...CAPACITY_CONSTANTS.governor, ...constants },
    };
    const log = (line: string) => {
      this.logs.push(line);
    };
    return new Governor(
      {
        procRoot: this.proc,
        cgroupRoot: this.cgroup,
        queueDir: this.queue,
        sessionsDir: this.sessions,
        dir: this.dir,
        now: () => this.nowMs,
        signal: this.signal,
        sleepSync: () => {},
        notifier: new Notifier({
          atriumUrl: "http://atrium.test:3456",
          outboxDir: path.join(this.dir, "outbox"),
          fetchImpl: this.atriumFetch,
          constants: merged.governor,
          log,
        }),
        clickhouse: new ClickHouseWriter(
          {
            enabled: true,
            endpoint: "http://127.0.0.1:18123",
            password: "pw",
            fetchImpl: this.clickhouseFetch,
          },
          log,
        ),
        log,
        readStatus: this.readStatus,
        tokenState: (pid) => queueOwnerTokenState(pid, this.proc),
        selfPid: 50,
        uid: UID,
        setPriority: () => {},
        ...deps,
      },
      {
        constants: merged,
        configuredMode: "enforce",
        testMode: false,
        testRig: false,
        box: "devbox.test.invalid",
        clickhouseAllowed: true,
        ...overrides,
      },
    );
  }

  events(): Array<Record<string, unknown>> {
    try {
      return fs
        .readFileSync(path.join(this.dir, "events.ndjson"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  groupKills(): number[] {
    return this.signals.filter((s) => s.target < 0 && s.signal === "SIGKILL").map((s) => -s.target);
  }
}
