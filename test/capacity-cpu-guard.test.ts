import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePressure } from "../src/capacity/cgroup.js";
import { CAPACITY_CONSTANTS, MIB } from "../src/capacity/constants.js";
import { readLedgerFile } from "../src/capacity/ledger.js";
import { ACPX_FEATURES, readCapacity } from "../src/capacity/reading.js";
import { cpuLine } from "../src/cli/capacity-command.js";
import { removeTempHomeSync } from "./temp-home.js";

// brick 4d74a0d9 — G5, the CPU guard (CONCEPTION 25479d40 §4.2, §5.1, §9; review R1). Every source
// is a FIXTURE tree (podinfo, cgroup, /proc, leases) as in test/capacity-admission.test.ts, and the
// `cpu.pressure` reading is a fixture FILE: no row loads the real box.
//
// The guarantee under test is a SHAPE: G5 is a create-only check for class `spawn`. It must never
// reach a wake, a delivery, atrium's `--class automation` probe, an interactive create or any
// memory figure (`freeSlots`, `bindingGuard`, `verdict`) — each of those has a row that feeds it a
// SATURATED box and asserts it is not refused.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_HREF = pathToFileURL(
  fileURLToPath(new URL("./mock-agent.js", import.meta.url)),
).href;
const GiB = 1024 * MIB;
const NS = "pid:[4026532839]";
const CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const CALLER = "sess-caller";

type Proc = { pid: number; ppid: number; ticks: string; rssAnonKb: number };

const CALLER_TREE: Proc[] = [
  { pid: 100, ppid: 1, ticks: "5000", rssAnonKb: 100 * 1024 },
  { pid: 101, ppid: 100, ticks: "5001", rssAnonKb: 50 * 1024 },
  { pid: 102, ppid: 101, ticks: "5002", rssAnonKb: 150 * 1024 },
  { pid: 103, ppid: 102, ticks: "5003", rssAnonKb: 4 * 1024 },
];
const READER: Proc = { pid: 4242, ppid: 103, ticks: "9000", rssAnonKb: 50 * 1024 };

/** `cpu.pressure some` as the kernel prints it; `undefined` ⇒ the file is absent (unreadable). */
type Cpu = { avg10?: number; avg60: number; avg300: number } | undefined;
const SATURATED: Cpu = { avg10: 70, avg60: 62, avg300: 48 };

type Box = {
  /** MiB. 4000 ⇒ room for four agents; 2048 ⇒ none; absent ⇒ no podinfo at all. */
  requestMib?: number;
  cpu?: Cpu;
};

type Fixture = { root: string; env: NodeJS.ProcessEnv; marker: string; agent: string };

function statLine(p: Proc): string {
  return `${p.pid} (node) S ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${p.ticks} 1000 200 18446744073709551615\n`;
}

function writeProc(proc: string, p: Proc): void {
  fs.mkdirSync(path.join(proc, String(p.pid), "ns"), { recursive: true });
  fs.writeFileSync(path.join(proc, String(p.pid), "stat"), statLine(p));
  fs.writeFileSync(
    path.join(proc, String(p.pid), "status"),
    `Name:\tnode\nPid:\t${p.pid}\nPPid:\t${p.ppid}\nRssAnon:\t${p.rssAnonKb} kB\nVmPTE:\t0 kB\n`,
  );
  fs.symlinkSync(NS, path.join(proc, String(p.pid), "ns", "pid"));
}

function writeCpuPressure(cgroup: string, cpu: Cpu): void {
  const file = path.join(cgroup, "cpu.pressure");
  if (cpu === undefined) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(
    file,
    `some avg10=${(cpu.avg10 ?? cpu.avg60).toFixed(2)} avg60=${cpu.avg60.toFixed(2)} avg300=${cpu.avg300.toFixed(2)} total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n`,
  );
}

const setCpu = (f: Fixture, cpu: Cpu): void => writeCpuPressure(path.join(f.root, "cgroup"), cpu);

function makeBox(t: test.TestContext, box: Box): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-cpu-guard-"));
  t.after(() => removeTempHomeSync(root));
  const podinfo = path.join(root, "podinfo");
  const cgroup = path.join(root, "cgroup");
  const proc = path.join(root, "proc");
  const queues = path.join(root, ".acpx", "queues");
  const sessions = path.join(root, ".acpx", "sessions");
  for (const dir of [cgroup, proc, queues, sessions, path.join(root, "work")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (box.requestMib !== undefined) {
    fs.mkdirSync(podinfo);
    fs.writeFileSync(path.join(podinfo, "memory_request"), String(box.requestMib * MIB));
    fs.writeFileSync(path.join(podinfo, "memory_limit"), String(12 * GiB));
    fs.writeFileSync(path.join(podinfo, "annotations"), "");
  }
  fs.writeFileSync(
    path.join(cgroup, "memory.stat"),
    `anon ${1000 * MIB}\nkernel ${150 * MIB}\nslab ${100 * MIB}\n`,
  );
  fs.writeFileSync(path.join(cgroup, "memory.max"), String(12 * GiB));
  fs.writeFileSync(path.join(cgroup, "memory.current"), String(3 * GiB));
  fs.writeFileSync(
    path.join(cgroup, "memory.pressure"),
    "some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n",
  );
  writeCpuPressure(cgroup, box.cpu);
  fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal: 16000000 kB\nMemAvailable: 9000000 kB\n");
  fs.writeFileSync(path.join(proc, "loadavg"), "1.00 1.00 1.00 2/300 12345\n");
  for (const p of CALLER_TREE) {
    writeProc(proc, p);
  }
  writeProc(proc, READER);
  fs.symlinkSync(String(READER.pid), path.join(proc, "self"));
  fs.writeFileSync(
    path.join(queues, "caller.lock"),
    JSON.stringify({
      pid: 100,
      sessionId: CALLER,
      socketPath: "/x",
      ownerGeneration: 1,
      queueDepth: 0,
      processIdentity: {
        kind: "linux-proc-stat-starttime",
        startTimeTicks: "5000",
        bootId: "6f60c842-c0f4-423e-8559-0577865d44f2",
        pidNamespace: NS,
        timeNamespace: "time:[4026531834]",
      },
    }),
  );
  fs.writeFileSync(
    path.join(sessions, `${CALLER}.json`),
    JSON.stringify({ acpx_record_id: CALLER, agent_command: CLAUDE_COMMAND, messages: [] }),
  );
  const marker = path.join(root, "agent-starts.ndjson");
  const wrapper = path.join(root, "agent.mjs");
  fs.writeFileSync(
    wrapper,
    `import fs from "node:fs";\n` +
      `fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }) + "\\n");\n` +
      `await import(${JSON.stringify(MOCK_AGENT_HREF)});\n`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    ACPX_STATE_HOME: root,
    ACPX_ADMISSION_DIR: path.join(root, "admission"),
    ACPX_CAPACITY_PODINFO_DIR: podinfo,
    ACPX_CAPACITY_CGROUP_ROOT: cgroup,
    ACPX_CAPACITY_PROC_ROOT: proc,
  };
  for (const key of [
    "ACPX_SESSION_URL",
    "ACPX_SEAT_URL",
    "ACPX_SESSION_NAME",
    "ACPX_SESSION_RECORD_ID",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_PARENT_SEAT_URL",
    "ACPX_ADMISSION_CLASS",
    "ACPX_BRICK",
    "ACPX_BRICK_PATH",
    "ACPX_TASK_FOLDER",
    "ACPX_OWNER_LOG",
  ]) {
    delete env[key];
  }
  return { root, env, marker, agent: `node ${JSON.stringify(wrapper)}` };
}

const asAgent = (f: Fixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...f.env,
  ACPX_SESSION_RECORD_ID: CALLER,
  ...extra,
});

type Run = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env, cwd, stdio: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const newSession = (f: Fixture, env: NodeJS.ProcessEnv, extra: string[] = []) =>
  runCli(
    ["--agent", f.agent, "--cwd", path.join(f.root, "work"), "sessions", "new", ...extra],
    env,
    f.root,
  );

const sessionsDir = (f: Fixture) => path.join(f.root, ".acpx", "sessions");
const admission = (f: Fixture) => path.join(f.root, "admission");

function createdRecords(f: Fixture): string[] {
  return fs.readdirSync(sessionsDir(f)).filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name));
}

function agentStarts(f: Fixture): number {
  try {
    return fs.readFileSync(f.marker, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function leaseFiles(f: Fixture): string[] {
  return fs.readdirSync(path.join(f.root, ".acpx", "queues")).filter((n) => n.endsWith(".lock"));
}

function decisionLog(f: Fixture): Array<Record<string, unknown>> {
  const dir = path.join(admission(f), "log");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type CapacityJson = {
  features: string[];
  verdict: string;
  freeSlots: Record<string, number> | null;
  slotsAfterMakeRoom: Record<string, number> | null;
  bindingGuard: Record<string, string> | null;
  warnings: string[];
  pressure: { cpuPsiSomeAvg10: number | null };
  cpu: {
    state: string;
    refusesAgentCreates: boolean;
    someAvg10: number | null;
    someAvg60: number | null;
    someAvg300: number | null;
    cpus: number;
    load1: number | null;
  };
  needMet?: boolean;
  needMetReason?: string;
};

async function capacityJson(
  f: Fixture,
  args: string[],
  env: NodeJS.ProcessEnv = asAgent(f),
): Promise<{ run: Run; json: CapacityJson }> {
  const run = await runCli(["--format", "json", "capacity", ...args], env, os.tmpdir());
  let json: CapacityJson;
  try {
    json = JSON.parse(run.stdout) as CapacityJson;
  } catch {
    assert.fail(`capacity printed no JSON (rc ${run.code}): ${run.stdout}\n${run.stderr}`);
  }
  return { run, json };
}

const REFUSED_CPU =
  /^acpx: REFUSED reason=cpu_pressure nothing_started=true protocol=1 box=\S+ cpu_some_avg60=62 cpu_some_avg300=48 live=1 retry_after_s=120 queued_ahead=0$/mu;

// ---------------------------------------------------------------------------------------------
// the reading: parsePressure + the `cpu` object
// ---------------------------------------------------------------------------------------------

test("parsePressure reads some avg10/avg60/avg300 and full avg10; an absent field stays absent", () => {
  assert.deepEqual(
    parsePressure(
      "some avg10=1.50 avg60=62.25 avg300=48.00 total=99\nfull avg10=0.25 avg60=9.00 avg300=9.00 total=1\n",
    ),
    { someAvg10: 1.5, someAvg60: 62.25, someAvg300: 48, fullAvg10: 0.25 },
  );
  assert.deepEqual(parsePressure("some avg10=3.00 total=1\n"), { someAvg10: 3 });
  assert.deepEqual(parsePressure(undefined), {});
  assert.deepEqual(parsePressure("garbage\n"), {});
});

type Sources = Parameters<typeof readCapacity>[0]["sources"];
const sourcesOf = (f: Fixture): Sources => ({
  podinfoDir: path.join(f.root, "podinfo"),
  cgroupRoot: path.join(f.root, "cgroup"),
  procRoot: path.join(f.root, "proc"),
  queueDir: path.join(f.root, ".acpx", "queues"),
  sessionsDir: sessionsDir(f),
});

test("states and boundaries: ok < 30 ≤ busy; saturated needs avg60 ≥ 50 AND avg300 ≥ 40 (≥, not >)", (t) => {
  const f = makeBox(t, { requestMib: 4000 });
  const cases: Array<[number, number, string, boolean]> = [
    [29.99, 90, "ok", false],
    [30, 0, "busy", false],
    [49.99, 90, "busy", false],
    [50, 40, "saturated", true],
    [50, 39.99, "busy", false],
    [100, 100, "saturated", true],
    // the persistence condition: a spike (avg60 high, avg300 low) must not refuse anyone
    [80, 10, "busy", false],
    // the inverse: a long-ago storm (avg300 high, avg60 now low) does not either
    [5, 90, "ok", false],
  ];
  for (const [avg60, avg300, state, refuses] of cases) {
    setCpu(f, { avg60, avg300 });
    const { cpu } = readCapacity({ agent: "claude", sources: sourcesOf(f) });
    assert.equal(cpu.state, state, `avg60=${avg60} avg300=${avg300}`);
    assert.equal(cpu.refusesAgentCreates, refuses, `avg60=${avg60} avg300=${avg300}`);
    assert.equal(cpu.someAvg60, avg60);
    assert.equal(cpu.someAvg300, avg300);
  }
});

test("the thresholds are the specified constants, not tuned (K10)", () => {
  assert.equal(CAPACITY_CONSTANTS.cpuBusyAvg60, 30);
  assert.equal(CAPACITY_CONSTANTS.cpuSaturatedAvg60, 50);
  assert.equal(CAPACITY_CONSTANTS.cpuSaturatedAvg300, 40);
});

test("fail open: an unreadable cpu.pressure never refuses — state ok, a warning, null readings", (t) => {
  const f = makeBox(t, { requestMib: 4000, cpu: undefined });
  const { cpu, warnings } = readCapacity({ agent: "claude", sources: sourcesOf(f) });
  assert.equal(cpu.state, "ok");
  assert.equal(cpu.refusesAgentCreates, false);
  assert.equal(cpu.someAvg60, null);
  assert.equal(cpu.someAvg300, null);
  assert.ok(
    warnings.some((w) => /cpu\.pressure unreadable/u.test(w)),
    warnings.join("\n"),
  );
  // a readable avg60 with no avg300 can at most be `busy`: `saturated` needs both windows
  fs.writeFileSync(path.join(f.root, "cgroup", "cpu.pressure"), "some avg10=90.00 avg60=90.00\n");
  const half = readCapacity({ agent: "claude", sources: sourcesOf(f) });
  assert.equal(half.cpu.state, "busy");
  assert.equal(half.cpu.refusesAgentCreates, false);
});

test("an unconfigured box (no podinfo) and an unmeasured one report saturated but never refuse", (t) => {
  const unconfigured = makeBox(t, { cpu: SATURATED });
  const a = readCapacity({ agent: "claude", sources: sourcesOf(unconfigured) });
  assert.equal(a.cpu.state, "saturated");
  assert.equal(a.cpu.refusesAgentCreates, false, "unconfigured: nothing is ever refused");
  const unmeasured = makeBox(t, { requestMib: 4000, cpu: SATURATED });
  fs.rmSync(path.join(unmeasured.root, "cgroup", "memory.stat"));
  const b = readCapacity({ agent: "claude", sources: sourcesOf(unmeasured) });
  assert.equal(b.cpu.state, "saturated");
  assert.equal(b.cpu.refusesAgentCreates, false, "unmeasured: nothing is ever refused");
});

test("G5 is not a formula guard: a saturated box and an ok one have IDENTICAL memory figures", (t) => {
  const f = makeBox(t, { requestMib: 4000, cpu: { avg60: 1, avg300: 1 } });
  const ok = readCapacity({ agent: "claude", sources: sourcesOf(f) });
  setCpu(f, SATURATED);
  const sat = readCapacity({ agent: "claude", sources: sourcesOf(f) });
  assert.equal(sat.cpu.refusesAgentCreates, true);
  assert.ok((ok.freeSlots?.claude ?? 0) > 0);
  for (const key of ["freeSlots", "slotsAfterMakeRoom", "bindingGuard", "verdict"] as const) {
    assert.deepEqual(sat[key], ok[key], `${key} stays memory-only`);
  }
});

test("features lists cpu-guard; the text line names the refusal and the figures", (t) => {
  assert.ok(ACPX_FEATURES.includes("cpu-guard"));
  const f = makeBox(t, { requestMib: 4000, cpu: SATURATED });
  const snapshot = readCapacity({ agent: "claude", sources: sourcesOf(f) });
  assert.match(
    cpuLine(snapshot),
    /^cpu: saturated \(some avg60 62 %, avg300 48 %; \d+ CPUs?\) — new agent sessions are refused until it eases$/u,
  );
  setCpu(f, { avg60: 35, avg300: 35 });
  assert.match(
    cpuLine(readCapacity({ agent: "claude", sources: sourcesOf(f) })),
    /^cpu: busy \(some avg60 35 %, avg300 35 %; \d+ CPUs?\) — warning only; new agent sessions are still admitted$/u,
  );
  setCpu(f, { avg60: 3, avg300: 4 });
  assert.match(cpuLine(readCapacity({ agent: "claude", sources: sourcesOf(f) })), /^cpu: ok \(/u);
});

// ---------------------------------------------------------------------------------------------
// the create gate: refuses an agent's `spawn` create, and ONLY that
// ---------------------------------------------------------------------------------------------

test("NEGATIVE: a saturated box refuses an agent's create — exit 75 cpu_pressure, nothing created, nothing reserved, logged", async (t) => {
  const f = makeBox(t, { requestMib: 4000, cpu: SATURATED });
  const run = await newSession(f, asAgent(f), ["--prompt", "do the work"]);
  assert.equal(run.code, 75, run.stderr);
  const lines = run.stderr.trim().split("\n");
  const at = lines.findIndex((line) => line.startsWith("acpx: REFUSED "));
  assert.match(lines[at] ?? "", REFUSED_CPU);
  assert.match(
    lines[at + 1] ?? "",
    /^acpx: the box's CPU is saturated \(62 % of the last minute waiting for CPU, 1 sessions live\)\. No session was created\. Spawn fewer, or later; messages to existing sessions are still delivered\.$/u,
  );
  assert.deepEqual(createdRecords(f), [], "no session record");
  assert.equal(agentStarts(f), 0, "no transient adapter was started");
  assert.deepEqual(leaseFiles(f), ["caller.lock"], "no owner was started");
  assert.deepEqual(await readLedgerFile(admission(f)), [], "nothing reserved");
  const [line] = decisionLog(f);
  assert.equal(line.decision, "refused");
  assert.equal(line.reason, "cpu_pressure");
  assert.equal(line.cpuPsiSomeAvg10, 70);
  assert.equal(line.cpuPsiSomeAvg60, 62);
  assert.equal(line.cpuPsiSomeAvg300, 48);
  assert.equal(line.cpuState, "saturated");
});

test("control: the SAME agent create with the CPU eased is admitted and creates its session", async (t) => {
  const f = makeBox(t, { requestMib: 4000, cpu: SATURATED });
  assert.equal((await newSession(f, asAgent(f))).code, 75);
  setCpu(f, { avg60: 20, avg300: 45 });
  const run = await newSession(f, asAgent(f));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(createdRecords(f).length, 1);
});

test("NEGATIVE: avg60 ≥ 50 with avg300 < 40 (a spike, not saturation) does not refuse; busy only warns", async (t) => {
  const f = makeBox(t, { requestMib: 4000, cpu: { avg60: 80, avg300: 30 } });
  const spike = await newSession(f, asAgent(f));
  assert.equal(spike.code, 0, spike.stderr);
  setCpu(f, { avg60: 35, avg300: 90 });
  const busy = await newSession(f, asAgent(f));
  assert.equal(busy.code, 0, busy.stderr);
  assert.equal(createdRecords(f).length, 2);
});

test("NEGATIVE: unreadable cpu.pressure fails open — an agent's create is admitted", async (t) => {
  const f = makeBox(t, { requestMib: 4000, cpu: undefined });
  const run = await newSession(f, asAgent(f));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(createdRecords(f).length, 1);
});

test("the memory decision comes first: a full AND saturated box is refused no_capacity, not cpu_pressure", async (t) => {
  const f = makeBox(t, { requestMib: 2048, cpu: SATURATED });
  const run = await newSession(f, asAgent(f));
  assert.equal(run.code, 75, run.stderr);
  assert.match(run.stderr, /REFUSED reason=no_capacity /u);
  assert.doesNotMatch(run.stderr, /cpu_pressure/u);
});

test("--format json: the refusal carries acpxCode CAPACITY, reason cpu_pressure, retryAfterS 120 and the snapshot's cpu object", async (t) => {
  const f = makeBox(t, { requestMib: 4000, cpu: SATURATED });
  const run = await runCli(
    ["--format", "json", "--agent", f.agent, "--cwd", path.join(f.root, "work"), "sessions", "new"],
    asAgent(f),
    f.root,
  );
  assert.equal(run.code, 75, run.stderr);
  assert.match(run.stderr, REFUSED_CPU, "acpx-ui reads stderr: the token must be there too");
  const data = (
    JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "") as {
      error: { data: Record<string, unknown> };
    }
  ).error.data;
  assert.equal(data.acpxCode, "CAPACITY");
  assert.equal(data.reason, "cpu_pressure");
  assert.equal(data.retryAfterS, 120);
  assert.equal(data.nothingStarted, true);
  const capacity = data.capacity as CapacityJson;
  assert.equal(capacity.cpu.state, "saturated");
  assert.equal(capacity.cpu.refusesAgentCreates, true);
  assert.deepEqual(createdRecords(f), []);
});

test("NEGATIVE: a saturated box never refuses an interactive create, a non-agent create, or an automation-class create", async (t) => {
  const f = makeBox(t, { requestMib: 4000, cpu: SATURATED });
  const human = await newSession(f, asAgent(f, { ACPX_ADMISSION_CLASS: "interactive" }));
  assert.equal(human.code, 0, `interactive: ${human.stderr}`);
  const outside = await newSession(f, f.env);
  assert.equal(outside.code, 0, `not an agent: ${outside.stderr}`);
  const automation = await newSession(f, asAgent(f, { ACPX_ADMISSION_CLASS: "automation" }));
  assert.equal(automation.code, 0, `automation: ${automation.stderr}`);
  assert.equal(createdRecords(f).length, 3);
  // …while the spawn create beside them, in the same saturated window, IS refused
  const agent = await newSession(f, asAgent(f));
  assert.equal(agent.code, 75, agent.stderr);
  assert.equal(createdRecords(f).length, 3);
});

// ---------------------------------------------------------------------------------------------
// the probe: `capacity --need N` mirrors G5 for class spawn only
// ---------------------------------------------------------------------------------------------

test("probe: `--need 1` (class spawn, the default) exits 75 cpu_pressure on a saturated box; the text says so", async (t) => {
  const f = makeBox(t, { requestMib: 4000, cpu: SATURATED });
  const { run, json } = await capacityJson(f, ["--need", "1"]);
  assert.equal(run.code, 75);
  assert.equal(json.needMet, false);
  assert.match(json.needMetReason ?? "", /^cpu_pressure: /u);
  assert.equal(json.cpu.state, "saturated");
  assert.equal(json.cpu.refusesAgentCreates, true);
  assert.equal(json.pressure.cpuPsiSomeAvg10, 70, "the avg10 figure stays");
  assert.ok(json.features.includes("cpu-guard"));
  assert.ok(json.cpu.cpus >= 1);
  const text = await runCli(["capacity", "--need", "1"], asAgent(f), os.tmpdir());
  assert.equal(text.code, 75);
  assert.match(
    text.stdout,
    /^cpu: saturated \(some avg60 62 %, avg300 48 %; \d+ CPUs?\) — new agent sessions are refused until it eases$/mu,
  );
  assert.match(text.stdout, /NOT MET \(exit 75\) — cpu_pressure: /u);
});

test("NEGATIVE: `--class automation --need 1` (atrium's release probe) is NOT refused on a saturated box — exit 0", async (t) => {
  const f = makeBox(t, { requestMib: 4000, cpu: SATURATED });
  const { run, json } = await capacityJson(f, ["--class", "automation", "--need", "1"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(json.needMet, true);
  assert.doesNotMatch(json.needMetReason ?? "", /cpu/u);
  assert.equal(json.cpu.state, "saturated", "the state is reported to every class");
});

test("probe and gate agree: with the CPU ok `--need 1` exits 0 and a create is admitted; with a spike (avg300 < 40) both stay open", async (t) => {
  const f = makeBox(t, { requestMib: 4000, cpu: { avg60: 80, avg300: 10 } });
  const { run } = await capacityJson(f, ["--need", "1"]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal((await newSession(f, asAgent(f))).code, 0);
});

// ---------------------------------------------------------------------------------------------
// the wake gate: never CPU
// ---------------------------------------------------------------------------------------------

/** A real session record, created on room by a non-agent (nothing reserved), its owner then gone. */
async function makeTarget(f: Fixture): Promise<string> {
  const before = new Set(fs.readdirSync(sessionsDir(f)));
  const run = await runCli(
    ["--agent", f.agent, "--cwd", path.join(f.root, "work"), "sessions", "new"],
    f.env,
    f.root,
  );
  assert.equal(run.code, 0, run.stderr);
  const created = fs
    .readdirSync(sessionsDir(f))
    .filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name) && !before.has(name));
  assert.equal(created.length, 1);
  return created[0].replace(/\.json$/u, "");
}

test("NEGATIVE: a saturated box never refuses a wake — an agent's prompt to a released session, and atrium's admit-wake for a delivery and for automation", async (t) => {
  const f = makeBox(t, { requestMib: 4000, cpu: SATURATED });
  const id = await makeTarget(f);
  // atrium's pre-admission of a held message: `--class delivery` and `--class automation`
  for (const wakeClass of ["delivery", "automation"]) {
    const run = await runCli(
      ["--format", "json", "capacity", "admit-wake", "--session-id", id, "--class", wakeClass],
      f.env,
      os.tmpdir(),
    );
    assert.equal(run.code, 0, `${wakeClass}: ${run.stderr}`);
    const parsed = JSON.parse(run.stdout) as { decision: string };
    assert.ok(
      ["admitted", "already-reserved", "not-needed", "not-gated"].includes(parsed.decision),
      `${wakeClass}: ${run.stdout}`,
    );
    assert.notEqual(parsed.decision, "refused");
  }
  // an agent's own `acpx prompt` to the released session: the wake is admitted and the turn runs
  const prompt = await runCli(["prompt", "--session-id", id, "hello"], asAgent(f), f.root);
  assert.equal(prompt.code, 0, prompt.stderr);
  assert.doesNotMatch(prompt.stderr, /cpu_pressure|REFUSED/u);
  const wakes = decisionLog(f).filter((line) => line.kind === "wake");
  assert.ok(wakes.length >= 1);
  for (const line of wakes) {
    assert.notEqual(line.decision, "refused", JSON.stringify(line));
  }
});
