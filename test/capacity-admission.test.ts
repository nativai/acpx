import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { capacityRefusal } from "../src/capacity/admission.js";
import { MIB } from "../src/capacity/constants.js";
import { CAPACITY_CONSTANTS } from "../src/capacity/constants.js";
import { ownerCharge } from "../src/capacity/formula.js";
import {
  ADMISSION_TTL_AUTOMATION_MS,
  ADMISSION_TTL_MS,
  boundEntry,
  containerInstance,
  liveEntries,
  newEntry,
  type PendingEntry,
  readLedgerFile,
  reservationsOf,
  withAdmissionLock,
  writeLedgerFile,
} from "../src/capacity/ledger.js";
import { partitionPending } from "../src/capacity/pending.js";
import {
  readProcessBirthIdentity,
  serializeProcessBirthIdentity,
} from "../src/process-identity.js";

// brick 8622b752 — the v1 create gate (CONCEPTION f7587c86 §5, §6.1 A2, §8.2; AMENDMENT
// 2026-10-29). Every memory source is a FIXTURE tree (podinfo, cgroup, /proc, leases), so no row
// depends on the pod the suite runs on; the gate's lock and ledger live in each box's own
// ACPX_ADMISSION_DIR. The fixture's /proc puts the READER (pid 4242, `/proc/self`) inside the caller's
// owner tree (100 → 101 → 102 → 103 → 4242), which is the shape of an agent running `acpx sessions
// new` from its shell.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_HREF = pathToFileURL(
  fileURLToPath(new URL("./mock-agent.js", import.meta.url)),
).href;
const GiB = 1024 * MIB;
const NS = "pid:[4026532839]";
const CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const CALLER = "sess-caller";

type Proc = { pid: number; ppid: number; ticks: string; rssAnonKb: number };

/** The caller's owner tree: owner 100, adapter 101, harness 102, its bash 103 — 304 MiB measured —
 *  and the reading CLI 4242 under the bash (excluded from the tree and from committed). */
const CALLER_TREE: Proc[] = [
  { pid: 100, ppid: 1, ticks: "5000", rssAnonKb: 100 * 1024 },
  { pid: 101, ppid: 100, ticks: "5001", rssAnonKb: 50 * 1024 },
  { pid: 102, ppid: 101, ticks: "5002", rssAnonKb: 150 * 1024 },
  { pid: 103, ppid: 102, ticks: "5003", rssAnonKb: 4 * 1024 },
];
const READER: Proc = { pid: 4242, ppid: 103, ticks: "9000", rssAnonKb: 50 * 1024 };

type Box = {
  /** MiB. 2700 ⇒ exactly ONE agent slot; 2048 ⇒ none; 4000 ⇒ four. Absent ⇒ no podinfo at all. */
  requestMib?: number;
  /** Is the reader inside the caller's owner tree? */
  inOwnerTree?: boolean;
  /** Is the caller's lease present (its owner live)? */
  callerLease?: boolean;
  psiFull?: number;
  memoryStat?: string;
  agentDelayMs?: number;
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

/**
 * B = request, L = 12 GiB, committed = anon + kernel − reader = 1100 MiB, the caller's owner charged
 * 304 MiB ⇒ base 796, K 1100. Free for an agent: B − 512 (margin) − 450 (human reserve) − 1100.
 */
function makeBox(box: Box): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-admission-"));
  const podinfo = path.join(root, "podinfo");
  const cgroup = path.join(root, "cgroup");
  const proc = path.join(root, "proc");
  const queues = path.join(root, ".acpx", "queues");
  const sessions = path.join(root, ".acpx", "sessions");
  const work = path.join(root, "work");
  for (const dir of [cgroup, proc, queues, sessions, work]) {
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
    box.memoryStat ?? `anon ${1000 * MIB}\nkernel ${150 * MIB}\nslab ${100 * MIB}\n`,
  );
  fs.writeFileSync(path.join(cgroup, "memory.max"), String(12 * GiB));
  fs.writeFileSync(path.join(cgroup, "memory.current"), String(3 * GiB));
  fs.writeFileSync(
    path.join(cgroup, "memory.pressure"),
    `some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=${(box.psiFull ?? 0).toFixed(2)} avg60=0.00 avg300=0.00 total=1\n`,
  );
  fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal: 16000000 kB\nMemAvailable: 9000000 kB\n");
  fs.writeFileSync(path.join(proc, "loadavg"), "1.00 1.00 1.00 2/300 12345\n");
  for (const p of CALLER_TREE) {
    writeProc(proc, p);
  }
  writeProc(proc, box.inOwnerTree === false ? { ...READER, ppid: 1 } : READER);
  fs.symlinkSync(String(READER.pid), path.join(proc, "self"));
  if (box.callerLease !== false) {
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
  }
  fs.writeFileSync(
    path.join(sessions, `${CALLER}.json`),
    JSON.stringify({ acpx_record_id: CALLER, agent_command: CLAUDE_COMMAND, messages: [] }),
  );
  // The agent: the mock adapter behind a wrapper that records every start — and whether the
  // admission class reached it (presence only; no environment is ever printed).
  const marker = path.join(root, "agent-starts.ndjson");
  const wrapper = path.join(root, "agent.mjs");
  fs.writeFileSync(
    wrapper,
    `import fs from "node:fs";\n` +
      `fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, classPresent: "ACPX_ADMISSION_CLASS" in process.env }) + "\\n");\n` +
      (box.agentDelayMs ? `await new Promise((r) => setTimeout(r, ${box.agentDelayMs}));\n` : "") +
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

/** The agent's shell: an identity, as acpx hands every harness it starts. */
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

/** Every session record on disk except the caller's fixture (records are `<uuid>.json`). */
function createdRecords(f: Fixture): string[] {
  return fs
    .readdirSync(path.join(f.root, ".acpx", "sessions"))
    .filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name));
}

/** The seat store sits beside the records. */
const seatStore = (f: Fixture) => path.join(f.root, ".acpx", "sessions", "seats.json");

function agentStarts(f: Fixture): Array<{ pid: number; classPresent: boolean }> {
  try {
    return fs
      .readFileSync(f.marker, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { pid: number; classPresent: boolean });
  } catch {
    return [];
  }
}

function leaseFiles(f: Fixture): string[] {
  return fs.readdirSync(path.join(f.root, ".acpx", "queues")).filter((n) => n.endsWith(".lock"));
}

const TOKEN =
  /^acpx: REFUSED reason=no_capacity nothing_started=true protocol=1 box=\S+ basis=request free_slots=0 need_mib=450 releasable_mib=0 retry_after_s=60 queued_ahead=0$/mu;

// ---------------------------------------------------------------------------------------------
// The two guarantees that matter (committed negative cases, §10.1)
// ---------------------------------------------------------------------------------------------

test("NEGATIVE: an agent's create on a full box exits 75 and leaves NOTHING — no record, no seat, no adapter, no owner", async () => {
  const f = makeBox({ requestMib: 2048 });
  const seatsBefore = fs.existsSync(seatStore(f));
  const run = await newSession(f, asAgent(f), ["--prompt", "do the work"]);
  assert.equal(run.code, 75, run.stderr);
  const lines = run.stderr.trim().split("\n");
  const at = lines.findIndex((line) => line.startsWith("acpx: REFUSED "));
  const [token, sentence] = [lines[at], lines[at + 1]];
  assert.match(token ?? "", TOKEN);
  assert.match(
    sentence ?? "",
    /^acpx: the box has no memory for another agent session \(1 live, 0 starting;/u,
  );
  assert.match(
    sentence ?? "",
    /Nothing was started or queued\. See 'acpx capacity'; close sessions/u,
  );
  assert.deepEqual(createdRecords(f), [], "no session record");
  assert.equal(seatsBefore, false);
  assert.equal(fs.existsSync(seatStore(f)), false, "no seat");
  assert.deepEqual(agentStarts(f), [], "no transient adapter was started");
  assert.deepEqual(leaseFiles(f), ["caller.lock"], "no owner was started");
  // …and nothing was reserved by the refused create.
  assert.deepEqual(await readLedgerFile(path.join(f.root, "admission")), []);
});

test("NEGATIVE control: the SAME agent create with room is admitted and creates its session", async () => {
  const f = makeBox({ requestMib: 4000 });
  const run = await newSession(f, asAgent(f));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(createdRecords(f).length, 1);
  assert.equal(agentStarts(f).length, 1, "the transient creation adapter");
});

test("--format json: the refusal is a JSON-RPC error carrying acpxCode CAPACITY + the snapshot; stderr keeps the token", async () => {
  const f = makeBox({ requestMib: 2048 });
  const run = await runCli(
    ["--format", "json", "--agent", f.agent, "--cwd", path.join(f.root, "work"), "sessions", "new"],
    asAgent(f),
    f.root,
  );
  assert.equal(run.code, 75, run.stderr);
  assert.match(run.stderr, TOKEN, "acpx-ui reads stderr: the token must be there in JSON mode too");
  const line = run.stdout.trim().split("\n").at(-1) ?? "";
  const parsed = JSON.parse(line) as {
    error: { code: number; message: string; data: Record<string, unknown> };
  };
  assert.equal(parsed.error.code, -32075);
  const data = parsed.error.data;
  assert.equal(data.acpxCode, "CAPACITY");
  assert.equal(data.detailCode, "no-capacity");
  assert.equal(data.retryable, true);
  assert.equal(data.nothingStarted, true);
  assert.equal(data.reason, "no_capacity");
  const capacity = data.capacity as {
    action: string;
    verdict: string;
    freeSlots: { claude: number };
  };
  assert.equal(capacity.action, "capacity");
  assert.equal(capacity.verdict, "full");
  assert.equal(capacity.freeSlots.claude, 0);
  assert.deepEqual(createdRecords(f), []);
});

test("copy: an agent's `sessions copy` on a full box exits 75, creates nothing, and leaves the source untouched", async () => {
  const f = makeBox({ requestMib: 4000 });
  const made = await newSession(f, f.env);
  assert.equal(made.code, 0, made.stderr);
  const [sourceFile] = createdRecords(f);
  const sourceId = sourceFile.replace(/\.json$/u, "");
  const sourcePath = path.join(f.root, ".acpx", "sessions", sourceFile);
  const before = fs.readFileSync(sourcePath, "utf8");
  fs.writeFileSync(path.join(f.root, "podinfo", "memory_request"), String(2048 * MIB));
  const startsBefore = agentStarts(f).length;
  const run = await runCli(
    ["--cwd", path.join(f.root, "work"), "sessions", "copy", "--from", sourceId],
    asAgent(f),
    f.root,
  );
  assert.equal(run.code, 75, run.stderr);
  assert.match(run.stderr, TOKEN);
  assert.deepEqual(createdRecords(f), [sourceFile], "no copy record");
  assert.equal(fs.readFileSync(sourcePath, "utf8"), before, "the source record is not mutated");
  assert.equal(agentStarts(f).length, startsBefore, "no adapter started for the copy");
});

test("the request is read FRESH on every create: shrinking it in place turns the next create into a refusal", async () => {
  // In-place pod resize updates the downwardAPI FILE; nothing may cache it (AMENDMENT 2026-10-29).
  const f = makeBox({ requestMib: 4000 });
  assert.equal((await newSession(f, asAgent(f))).code, 0);
  fs.writeFileSync(path.join(f.root, "podinfo", "memory_request"), String(2048 * MIB));
  assert.equal((await newSession(f, asAgent(f))).code, 75);
  fs.writeFileSync(path.join(f.root, "podinfo", "memory_request"), String(4000 * MIB));
  assert.equal((await newSession(f, asAgent(f))).code, 0);
});

// ---------------------------------------------------------------------------------------------
// Who is gated — humans, atrium, successors and automation never are (AMENDMENT 2026-10-27/29)
// ---------------------------------------------------------------------------------------------

test("class: atrium's shape — identity stripped (withoutCallerIdentity), even inside a tree — is never refused", async () => {
  // The brick CLI's local-mode trigger create runs inside an agent's tree with the identity
  // stripped by acpx-ui: v1 must not gate automation.
  const f = makeBox({ requestMib: 2048 });
  const run = await newSession(f, f.env);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(createdRecords(f).length, 1);
});

test("class: an identity that leaked into a process OUTSIDE every owner tree (atrium restarted from an agent shell) is never refused", async () => {
  const f = makeBox({ requestMib: 2048, inOwnerTree: false });
  const run = await newSession(f, asAgent(f));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(createdRecords(f).length, 1);
  const log = fs.readdirSync(path.join(f.root, "admission", "log"));
  const lines = fs.readFileSync(path.join(f.root, "admission", "log", log[0]), "utf8");
  assert.match(lines, /"decision":"not-gated".*"why":"not-in-owner-tree"/u);
});

test("class: ACPX_ADMISSION_CLASS decides when set — interactive/delivery pass, spawn and automation are gated without inference", async () => {
  const f = makeBox({ requestMib: 2048 });
  for (const cls of ["interactive", "delivery"]) {
    const run = await newSession(f, asAgent(f, { ACPX_ADMISSION_CLASS: cls }));
    assert.equal(run.code, 0, `${cls}: ${run.stderr}`);
  }
  // `spawn` from atrium (no identity, not in a tree) is still gated: atrium vouches for an agent.
  const outside = makeBox({ requestMib: 2048, inOwnerTree: false });
  const spawned = await newSession(outside, { ...outside.env, ACPX_ADMISSION_CLASS: "spawn" });
  assert.equal(spawned.code, 75, spawned.stderr);
  // `automation` likewise (CONCEPTION e8abe1e8 §3.2.1): atrium's wakeup / trigger create, outside
  // every owner tree and with the identity stripped, is gated because it SAYS it is automation.
  const automation = await newSession(outside, {
    ...outside.env,
    ACPX_ADMISSION_CLASS: "automation",
  });
  assert.equal(automation.code, 75, automation.stderr);
  // An unknown value is no class at all: inference decides, and the agent is gated.
  const bogus = await newSession(f, asAgent(f, { ACPX_ADMISSION_CLASS: "human-please" }));
  assert.equal(bogus.code, 75, bogus.stderr);
});

test("class: ACPX_ADMISSION_CLASS never reaches the transient adapter, the owner or its adapter", async () => {
  const f = makeBox({ requestMib: 4000 });
  const run = await newSession(f, { ...f.env, ACPX_ADMISSION_CLASS: "interactive" }, [
    "--prompt",
    "hello",
  ]);
  assert.equal(run.code, 0, run.stderr);
  const deadline = Date.now() + 30_000;
  while (agentStarts(f).length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const starts = agentStarts(f);
  assert.ok(starts.length >= 2, `transient + owner adapter expected, saw ${starts.length}`);
  assert.deepEqual(
    starts.map((s) => s.classPresent),
    starts.map(() => false),
  );
});

test("successor: `sessions new --from <live predecessor>` on a full box is never refused; a dead predecessor's successor is", async () => {
  const f = makeBox({ requestMib: 4000 });
  const made = await newSession(f, f.env);
  assert.equal(made.code, 0, made.stderr);
  const predecessor = createdRecords(f)[0].replace(/\.json$/u, "");
  fs.writeFileSync(path.join(f.root, "podinfo", "memory_request"), String(2048 * MIB));

  // Dead predecessor (no lease): an ordinary agent create, refused.
  const dead = await newSession(f, asAgent(f), ["--from", predecessor]);
  assert.equal(dead.code, 75, dead.stderr);

  // Live predecessor: its owner is the caller's own tree (the `sessions handover` shape).
  const lease = JSON.parse(
    fs.readFileSync(path.join(f.root, ".acpx", "queues", "caller.lock"), "utf8"),
  ) as Record<string, unknown>;
  fs.writeFileSync(
    path.join(f.root, ".acpx", "queues", "caller.lock"),
    JSON.stringify({ ...lease, sessionId: predecessor }),
  );
  const live = await newSession(f, asAgent(f), ["--from", predecessor]);
  assert.equal(live.code, 0, live.stderr);
});

test("NEGATIVE: an unconfigured box (no /etc/podinfo) never refuses — even an agent far over the limit", async () => {
  const f = makeBox({
    memoryStat: `anon ${11_000 * MIB}\nkernel ${900 * MIB}\n`,
  });
  const run = await newSession(f, asAgent(f));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(createdRecords(f).length, 1);
  assert.equal(fs.existsSync(path.join(f.root, "admission")), false, "no lock was even taken");
});

test("an unmeasured configured box (memory.stat unreadable) fails open", async () => {
  const f = makeBox({ requestMib: 2048, memoryStat: "garbage\n" });
  const run = await newSession(f, asAgent(f));
  assert.equal(run.code, 0, run.stderr);
});

test("a stalled box refuses with reason=memory_pressure", async () => {
  const f = makeBox({ requestMib: 4000, psiFull: 25 });
  const run = await newSession(f, asAgent(f));
  assert.equal(run.code, 75, run.stderr);
  assert.match(run.stderr, /^acpx: REFUSED reason=memory_pressure nothing_started=true /mu);
});

// ---------------------------------------------------------------------------------------------
// Probe and gate agree; the probe shows what is pending (§5, §8.1)
// ---------------------------------------------------------------------------------------------

async function probe(f: Fixture, need: number) {
  const run = await runCli(
    ["--format", "json", "capacity", "--need", String(need)],
    asAgent(f),
    f.root,
  );
  return { code: run.code, json: JSON.parse(run.stdout) as Record<string, unknown> };
}

test("probe and gate agree on the same fixture: `capacity --need 1` met ⇔ the create is admitted", async () => {
  for (const [requestMib, expected] of [
    [2048, 75],
    [2700, 0],
    [4000, 0],
  ] as const) {
    const f = makeBox({ requestMib });
    const p = await probe(f, 1);
    const create = await newSession(f, asAgent(f));
    assert.equal(p.code, expected, `probe at ${requestMib} MiB`);
    assert.equal(create.code, expected, `create at ${requestMib} MiB: ${create.stderr}`);
  }
});

function entryFor(over: Partial<PendingEntry> = {}): PendingEntry {
  return {
    ...newEntry({
      key: "adm-test",
      harness: "claude",
      bytes: 450 * MIB,
      admissionClass: "spawn",
      origin: "test",
      now: new Date(),
    }),
    ...over,
  };
}

test("probe: a create in flight shows as pendingBytes / owners.starting, and takes the last slot from the gate too", async () => {
  const f = makeBox({ requestMib: 2700 });
  const dir = path.join(f.root, "admission");
  fs.mkdirSync(dir, { recursive: true });
  const before = await probe(f, 1);
  assert.equal(before.code, 0);
  assert.equal(before.json.pendingBytes, 0);

  // An admitter that is alive (this test process) and has no owner yet.
  await writeLedgerFile(dir, [entryFor()]);
  const during = await probe(f, 1);
  assert.equal(during.code, 75);
  assert.equal(during.json.pendingBytes, 450 * MIB);
  assert.equal((during.json.owners as { starting: number }).starting, 1);
  assert.equal(
    during.json.chargedBytes,
    (before.json.chargedBytes as number) + 450 * MIB,
    "K includes P",
  );
  const create = await newSession(f, asAgent(f));
  assert.equal(create.code, 75, "the gate sees the same in-flight reservation");
});

test("pending: a reservation bound to a LIVE owner raises that owner's charge to it while within TTL", async () => {
  const f = makeBox({ requestMib: 2700 });
  const dir = path.join(f.root, "admission");
  fs.mkdirSync(dir, { recursive: true });
  const before = await probe(f, 1);
  await writeLedgerFile(dir, [entryFor({ sessionId: CALLER })]);
  const after = await probe(f, 1);
  assert.equal(after.json.pendingBytes, 0, "an owner exists: not pending");
  assert.equal(
    after.json.chargedBytes,
    (before.json.chargedBytes as number) + (450 - 304) * MIB,
    "the caller's owner (304 MiB measured) is charged its 450 MiB reservation",
  );
});

test("pending: a dead admitter with no owner, an expired entry, and another container's entry are not charged — and the gate prunes them", async () => {
  const dead = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
  const identity = readProcessBirthIdentity(dead.pid!);
  await new Promise((resolve) => dead.once("exit", resolve));
  const f = makeBox({ requestMib: 2700 });
  const dir = path.join(f.root, "admission");
  fs.mkdirSync(dir, { recursive: true });
  await writeLedgerFile(dir, [
    entryFor({
      key: "dead",
      admitterPid: dead.pid!,
      ...(identity ? { admitterIdentity: serializeProcessBirthIdentity(identity) } : {}),
    }),
    entryFor({ key: "expired", expiresAt: new Date(Date.now() - 1).toISOString() }),
    entryFor({ key: "other-container", instance: "pid:[1]:1" }),
  ]);
  const reading = await probe(f, 1);
  assert.equal(reading.json.pendingBytes, 0);
  assert.equal(reading.code, 0);
  const create = await newSession(f, asAgent(f));
  assert.equal(create.code, 0, create.stderr);
  const left = await readLedgerFile(dir);
  assert.equal(
    left.length,
    1,
    "the three stale entries were pruned; only the new create's remains",
  );
  assert.match(left[0].key, /^adm-/u);
  assert.equal(
    `${left[0].sessionId}.json`,
    createdRecords(f)[0],
    "…bound to the record it created",
  );
});

// ---------------------------------------------------------------------------------------------
// Race safety (§5): two creates for the last slot — exactly one admitted
// ---------------------------------------------------------------------------------------------

test("race: three simultaneous agent creates for ONE slot — exactly one admitted, the losers leave nothing (4 rounds)", async () => {
  for (let round = 0; round < 4; round += 1) {
    // The adapter sleeps 5 s, so the winner is provably still creating while the losers decide.
    const f = makeBox({ requestMib: 2700, agentDelayMs: 5_000 });
    const runs = await Promise.all([0, 1, 2].map(() => newSession(f, asAgent(f))));
    const codes = runs.map((run) => run.code ?? -1).toSorted((a, b) => a - b);
    assert.deepEqual(codes, [0, 75, 75], `round ${round}: ${runs.map((r) => r.stderr).join("\n")}`);
    assert.equal(createdRecords(f).length, 1, `round ${round}: exactly one record`);
    assert.equal(agentStarts(f).length, 1, `round ${round}: exactly one adapter started`);
  }
});

// ---------------------------------------------------------------------------------------------
// The lock (§3.3, §5)
// ---------------------------------------------------------------------------------------------

test("lock: contention past 5 s refuses with reason=admission_busy, exit 75, nothing created", async () => {
  const f = makeBox({ requestMib: 4000 });
  const dir = path.join(f.root, "admission");
  const run = await withAdmissionLock(dir, () => newSession(f, asAgent(f)));
  assert.equal(run.code, 75, run.stderr);
  assert.match(
    run.stderr,
    /^acpx: REFUSED reason=admission_busy nothing_started=true protocol=1 retry_after_s=5 queued_ahead=0$/mu,
  );
  assert.deepEqual(createdRecords(f), []);
});

test("lock: a dead holder is broken at once and the create proceeds", async () => {
  const f = makeBox({ requestMib: 4000 });
  const dir = path.join(f.root, "admission");
  fs.mkdirSync(dir, { recursive: true });
  const dead = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
  const identity = readProcessBirthIdentity(dead.pid!);
  await new Promise((resolve) => dead.once("exit", resolve));
  assert.ok(identity, "the holder's identity was read while it lived");
  fs.writeFileSync(
    path.join(dir, "admission.lock"),
    JSON.stringify({ pid: dead.pid, processIdentity: serializeProcessBirthIdentity(identity) }),
  );
  // A live holder would hold it past the 5 s budget ⇒ admission_busy, exit 75 (row above).
  const run = await newSession(f, asAgent(f));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(fs.existsSync(path.join(dir, "admission.lock")), false);
});

test("lock: an I/O fault (admission dir unusable) fails OPEN, loudly", async () => {
  const f = makeBox({ requestMib: 2048 });
  const blocker = path.join(f.root, "not-a-dir");
  fs.writeFileSync(blocker, "");
  const run = await newSession(f, asAgent(f, { ACPX_ADMISSION_DIR: path.join(blocker, "x") }));
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stderr, /session admission lock or ledger failed .*admitting without a check/u);
});

// ---------------------------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------------------------

test("partitionPending: owner-bound ⇒ raises the owner; no owner + live admitter ⇒ P; else dropped", () => {
  const live = new Set(["s-live"]);
  const result = partitionPending(
    [
      {
        key: "a",
        sessionId: "s-live",
        bytes: 450,
        admitterAlive: false,
        bound: true,
        spent: false,
      },
      {
        key: "b",
        sessionId: "s-gone",
        bytes: 450,
        admitterAlive: true,
        bound: false,
        spent: false,
      },
      { key: "c", bytes: 340, admitterAlive: true, bound: false, spent: false },
      {
        key: "d",
        sessionId: "s-gone",
        bytes: 450,
        admitterAlive: false,
        bound: false,
        spent: false,
      },
    ],
    live,
  );
  assert.deepEqual([...result.ownerReserved], [["s-live", 450]]);
  assert.equal(result.pendingBytes, 790);
  assert.equal(result.starting, 2);
  assert.deepEqual([...result.keptKeys].toSorted(), ["a", "b", "c"]);
});

test("ownerCharge: max(floor, measured, reservation)", () => {
  const base = {
    sessionId: "s",
    pid: 1,
    harness: "claude" as const,
    processes: 1,
    self: false,
  };
  const k = CAPACITY_CONSTANTS;
  assert.equal(ownerCharge({ ...base, measuredBytes: 50 * MIB }, k), 300 * MIB);
  assert.equal(
    ownerCharge({ ...base, measuredBytes: 50 * MIB, reservedBytes: 450 * MIB }, k),
    450 * MIB,
  );
  assert.equal(
    ownerCharge({ ...base, measuredBytes: 600 * MIB, reservedBytes: 450 * MIB }, k),
    600 * MIB,
  );
});

test("liveEntries: TTL and container instance; an entry written now lives 180 s", () => {
  const now = Date.now();
  const fresh = entryFor();
  assert.equal(Date.parse(fresh.expiresAt) - Date.parse(fresh.admittedAt), ADMISSION_TTL_MS);
  assert.equal(fresh.instance, containerInstance());
  assert.deepEqual(
    liveEntries(
      [
        fresh,
        entryFor({ key: "old", expiresAt: new Date(now - 1).toISOString() }),
        entryFor({ key: "foreign", instance: "pid:[1]:1" }),
      ],
      now,
    ).map((e) => e.key),
    containerInstance() === "unknown" ? ["adm-test", "foreign"] : ["adm-test"],
  );
});

test("refusal token: every reason carries nothing_started=true and protocol=1", () => {
  for (const reason of [
    "no_capacity",
    "memory_pressure",
    "node_pressure",
    "admission_busy",
  ] as const) {
    const error = capacityRefusal(reason);
    assert.match(
      error.stderrLine,
      new RegExp(`^acpx: REFUSED reason=${reason} nothing_started=true protocol=1 `, "u"),
    );
    assert.equal(error.outputCode, "CAPACITY");
    assert.equal(error.retryable, true);
    assert.equal(error.capacityRefusal.nothingStarted, true);
  }
});

// ---------------------------------------------------------------------------------------------
// brick e8abe1e8 — automation waits for room (CONCEPTION e8abe1e8 §3.2, §5, §10.2)
// ---------------------------------------------------------------------------------------------

/** The shared waiting-dir fixture (2 items) — acpx-ui copies it byte-identical. */
const WAITING_FIXTURE = fileURLToPath(
  new URL("../../test/fixtures/capacity/waiting/atrium-example.json", import.meta.url),
);

/** Atrium's create: outside every owner tree, identity stripped, the class said out loud. */
const asAutomation = (f: Fixture): NodeJS.ProcessEnv => ({
  ...f.env,
  ACPX_ADMISSION_CLASS: "automation",
});

/** Publishes the fixture's queue (its first `count` items) as one writer, `ageMs` old. */
function publishWaiting(f: Fixture, count = 2, ageMs = 0): void {
  const body = JSON.parse(fs.readFileSync(WAITING_FIXTURE, "utf8")) as { items: unknown[] };
  const dir = path.join(f.root, "admission", "waiting");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "atrium-test.json");
  fs.writeFileSync(file, JSON.stringify({ ...body, items: body.items.slice(0, count) }));
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
}

async function probeJson(f: Fixture, env: NodeJS.ProcessEnv, args: string[]) {
  const run = await runCli(["--format", "json", "capacity", ...args], env, f.root);
  return { code: run.code, json: JSON.parse(run.stdout) as Record<string, unknown> };
}

function decisionLog(f: Fixture): Array<Record<string, unknown>> {
  const dir = path.join(f.root, "admission", "log");
  return fs
    .readdirSync(dir)
    .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const slotsOf = (json: Record<string, unknown>, field: string): number =>
  (json[field] as { claude: number }).claude;

test("NEGATIVE automation: atrium's automation create on a full box exits 75 and leaves NOTHING — no record, seat, adapter or owner", async () => {
  const f = makeBox({ requestMib: 2048, inOwnerTree: false });
  const run = await newSession(f, asAutomation(f));
  assert.equal(run.code, 75, run.stderr);
  assert.match(run.stderr, TOKEN);
  assert.deepEqual(createdRecords(f), [], "no session record");
  assert.equal(fs.existsSync(seatStore(f)), false, "no seat");
  assert.deepEqual(agentStarts(f), [], "no transient adapter was started");
  assert.deepEqual(leaseFiles(f), ["caller.lock"], "no owner was started");
  assert.deepEqual(await readLedgerFile(path.join(f.root, "admission")), []);
  const [line] = decisionLog(f);
  assert.equal(line.decision, "refused");
  assert.equal(line.class, "automation");
  assert.equal(line.classSource, "env");
  assert.equal(line.waiting, 0);
});

test("NEGATIVE control: the SAME automation create with room is admitted, reserved as class automation", async () => {
  const f = makeBox({ requestMib: 4000, inOwnerTree: false });
  const run = await newSession(f, asAutomation(f));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(createdRecords(f).length, 1);
  const [entry] = await readLedgerFile(path.join(f.root, "admission"));
  assert.equal(entry.class, "automation");
});

test("queue first: W = 2 with 2 gross slots — spawn gets 0 and is refused with queued_ahead=2; automation gets 2 and is admitted", async () => {
  const f = makeBox({ requestMib: 3200 });
  const gross = await probeJson(f, asAgent(f), ["--class", "automation", "--need", "2"]);
  assert.equal(gross.code, 0, "2 gross slots before anything waits");
  publishWaiting(f, 2);

  const agent = await probeJson(f, asAgent(f), ["--need", "1"]);
  assert.equal(agent.code, 75);
  assert.equal(agent.json.class, "spawn");
  assert.equal((agent.json.waiting as { count: number }).count, 2);
  assert.equal(slotsOf(agent.json, "freeSlots"), 0);
  assert.equal(slotsOf(agent.json, "slotsAfterMakeRoom"), 0);
  assert.equal(agent.json.verdict, "tight", "the human reserve is still there");
  assert.match(String(agent.json.needMetReason), /after 2 queued automation session\(s\)/u);

  const drainer = await probeJson(f, asAgent(f), ["--class", "automation", "--need", "2"]);
  assert.equal(drainer.code, 0);
  assert.equal(drainer.json.class, "automation");
  assert.equal(slotsOf(drainer.json, "freeSlots"), 2);
  assert.equal(
    slotsOf(drainer.json, "freeSlotsInteractive"),
    slotsOf(agent.json, "freeSlotsInteractive"),
    "humans are never reduced by the queue",
  );

  const refused = await newSession(f, asAgent(f));
  assert.equal(refused.code, 75, refused.stderr);
  assert.match(
    refused.stderr,
    /^acpx: REFUSED reason=no_capacity nothing_started=true protocol=1 box=\S+ basis=request free_slots=0 need_mib=450 releasable_mib=0 retry_after_s=60 queued_ahead=2$/mu,
  );
  assert.match(
    refused.stderr,
    /Nothing was started or queued\. 2 automation sessions are queued for room ahead of new agent sessions and start first\./u,
  );
  assert.deepEqual(createdRecords(f), [], "the agent's refused create left nothing");

  const admitted = await newSession(f, asAutomation(f));
  assert.equal(admitted.code, 0, admitted.stderr);
  const lines = decisionLog(f);
  assert.deepEqual(
    lines.map((line) => [line.decision, line.class, line.waiting]),
    [
      ["refused", "spawn", 2],
      ["admitted", "automation", 2],
    ],
  );
});

test("queue first, JSON: an agent's refusal carries queuedAhead in error.data", async () => {
  const f = makeBox({ requestMib: 3200 });
  publishWaiting(f, 2);
  const run = await runCli(
    ["--format", "json", "--agent", f.agent, "--cwd", path.join(f.root, "work"), "sessions", "new"],
    asAgent(f),
    f.root,
  );
  assert.equal(run.code, 75, run.stderr);
  const data = (
    JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "") as {
      error: { data: Record<string, unknown> };
    }
  ).error.data;
  assert.equal(data.queuedAhead, 2);
});

test("queue first: W = 1 takes exactly one agent slot — --need 1 met, --need 2 not", async () => {
  const f = makeBox({ requestMib: 3200 });
  publishWaiting(f, 1);
  assert.equal((await probeJson(f, asAgent(f), ["--need", "1"])).code, 0);
  assert.equal((await probeJson(f, asAgent(f), ["--need", "2"])).code, 75);
});

test("NEGATIVE queue first: a STALE (6 min) or FUTURE waiting file is not counted — the agent gets the gross slots (fail open)", async () => {
  for (const ageMs of [6 * 60_000, -60_000]) {
    const f = makeBox({ requestMib: 3200 });
    publishWaiting(f, 2, ageMs);
    const probe = await probeJson(f, asAgent(f), ["--need", "2"]);
    assert.equal(probe.code, 0, `age ${ageMs} ms`);
    assert.equal((probe.json.waiting as { count: number }).count, 0);
    const create = await newSession(f, asAgent(f));
    assert.equal(create.code, 0, create.stderr);
  }
});

test("text: `acpx capacity` names what waits, in order — and says nothing when nothing waits", async () => {
  const f = makeBox({ requestMib: 3200 });
  const quiet = await runCli(["capacity"], asAgent(f), f.root);
  assert.equal(quiet.code, 0);
  assert.doesNotMatch(quiet.stdout, /^waiting:/mu);
  publishWaiting(f, 2);
  const spawnView = await runCli(["capacity"], asAgent(f), f.root);
  assert.match(
    spawnView.stdout,
    /^waiting: 2 automation sessions queued since (?:2026-10-31 )?01:00Z \(wakeup re-baker-2026-10-31, brick run 3f2a1c… "Implement X"\) — they start before new agent sessions; the slots above already leave room for them$/mu,
  );
  assert.match(spawnView.stdout, /^tight: 0 new claude sessions/mu);
  const drainerView = await runCli(["capacity", "--class", "automation"], asAgent(f), f.root);
  assert.match(drainerView.stdout, /^room: 2 new claude sessions/mu);
  assert.match(
    drainerView.stdout,
    /^waiting: 2 automation sessions .* class automation: the slots above are gross/mu,
  );
});

test("NEGATIVE --class: an unknown class is a usage error (exit 2), never a reading", async () => {
  const f = makeBox({ requestMib: 3200 });
  const run = await runCli(
    ["--format", "json", "capacity", "--class", "interactive"],
    asAgent(f),
    f.root,
  );
  assert.equal(run.code, 2, run.stderr);
  assert.doesNotMatch(run.stdout, /"action":"capacity"/u);
});

test("reservation: an automation create's reservation OUTLIVES its CLI — bound, counted after the admitter exited, 10-min TTL — so back-to-back starts cannot double-book", async () => {
  // Atrium creates prompt-less and delivers the first prompt from ANOTHER process (CONCEPTION
  // e8abe1e8 §3.2.2, AC14): with v1's rule this reservation vanished when `sessions new` exited.
  const f = makeBox({ requestMib: 3200, inOwnerTree: false });
  const first = await newSession(f, asAutomation(f));
  assert.equal(first.code, 0, first.stderr);
  const [entry] = await readLedgerFile(path.join(f.root, "admission"));
  assert.equal(`${entry.sessionId}.json`, createdRecords(f)[0]);
  assert.ok(entry.boundAt, "bind stamped boundAt");
  assert.equal(
    Date.parse(entry.expiresAt) - Date.parse(entry.boundAt),
    ADMISSION_TTL_AUTOMATION_MS,
  );

  const after = await probeJson(f, f.env, ["--class", "automation"]);
  assert.equal(
    after.json.pendingBytes,
    450 * MIB,
    "still reserved: its admitter is gone, it is bound",
  );
  assert.equal((after.json.owners as { starting: number }).starting, 1);
  assert.equal(slotsOf(after.json, "freeSlots"), 1);

  assert.equal((await newSession(f, asAutomation(f))).code, 0, "the second takes the last slot");
  const third = await newSession(f, asAutomation(f));
  assert.equal(third.code, 75, "…and a third is refused, not admitted against the same memory");
});

test("reservation: an agent's prompt-less create stays bound for 180 s after its CLI exits (the named R10 change)", async () => {
  const f = makeBox({ requestMib: 3200 });
  assert.equal((await newSession(f, asAgent(f))).code, 0);
  const [entry] = await readLedgerFile(path.join(f.root, "admission"));
  assert.equal(entry.class, "spawn");
  assert.equal(Date.parse(entry.expiresAt) - Date.parse(entry.boundAt ?? ""), ADMISSION_TTL_MS);
  const after = await probeJson(f, asAgent(f), []);
  assert.equal(after.json.pendingBytes, 450 * MIB);
});

/** A process that lived and is now provably gone — an admitter that exited. */
async function goneAdmitter(): Promise<Pick<PendingEntry, "admitterPid" | "admitterIdentity">> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"]);
  const pid = child.pid ?? 0;
  const identity = readProcessBirthIdentity(pid);
  await new Promise((resolve) => child.once("exit", resolve));
  assert.ok(identity, "the admitter's identity was read while it lived");
  return { admitterPid: pid, admitterIdentity: serializeProcessBirthIdentity(identity) };
}

function sessionsDirWith(records: Record<string, Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-n1-sessions-"));
  for (const [id, record] of Object.entries(records)) {
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({ acpx_record_id: id, ...record }),
    );
  }
  return dir;
}

/** P after the partition, with no live owner anywhere. */
const pendingOf = (entries: PendingEntry[], sessionsDir: string) =>
  partitionPending(reservationsOf(entries, sessionsDir), new Set());

test("NEGATIVE reservation (R14): a --record-id create killed BEFORE bind is dropped; the same entry bound is counted", async () => {
  const gone = await goneAdmitter();
  const sessions = sessionsDirWith({});
  const unbound = entryFor({ key: "killed", sessionId: "rec-1", ...gone });
  assert.equal(pendingOf([unbound], sessions).pendingBytes, 0, "sessionId alone is not 'bound'");
  const bound = { ...boundEntry(unbound, "rec-1", new Date()), ...gone };
  assert.equal(pendingOf([bound], sessions).pendingBytes, 450 * MIB);
});

test("N1: a bound reservation whose session already RAN a turn (at or after boundAt) is dropped", async () => {
  const gone = await goneAdmitter();
  const now = new Date();
  const bound = {
    ...boundEntry(entryFor({ class: "automation" }), "rec-ran", now),
    ...gone,
  };
  const ran = sessionsDirWith({
    "rec-ran": { last_prompt_at: new Date(now.getTime() + 1_000).toISOString() },
  });
  assert.equal(pendingOf([bound], ran).pendingBytes, 0);
  // Exactly at boundAt counts as a turn ("at or after").
  const atBind = sessionsDirWith({ "rec-ran": { last_prompt_at: bound.boundAt } });
  assert.equal(pendingOf([bound], atBind).pendingBytes, 0);
});

test("N1: a bound reservation whose record is CLOSED is dropped (self-closing job, human close, prompt-less create closed)", async () => {
  const gone = await goneAdmitter();
  const bound = { ...boundEntry(entryFor(), "rec-closed", new Date()), ...gone };
  const closed = sessionsDirWith({
    "rec-closed": { closed: true, closed_at: new Date().toISOString() },
  });
  assert.equal(pendingOf([bound], closed).pendingBytes, 0);
});

test("NEGATIVE N1: bound, no turn since bind, no owner, within its TTL ⇒ STILL counted — a turn from BEFORE bind, or a missing record, does not spend it", async () => {
  const gone = await goneAdmitter();
  const now = new Date();
  const bound = { ...boundEntry(entryFor(), "rec-waiting", now), ...gone };
  for (const [what, records] of [
    ["no turn at all", { "rec-waiting": {} }],
    [
      "a turn copied from before bind",
      { "rec-waiting": { last_prompt_at: new Date(now.getTime() - 60_000).toISOString() } },
    ],
    ["reopened (closed: false)", { "rec-waiting": { closed: false } }],
    ["no record on disk", {}],
  ] as const) {
    assert.equal(pendingOf([bound], sessionsDirWith(records)).pendingBytes, 450 * MIB, what);
  }
});

test("TTL by class: automation lives 10 min, every other class 180 s — at admission and again from bind", () => {
  const admitted = new Date("2026-10-31T01:00:00.000Z");
  const automation = newEntry({
    key: "a",
    harness: "claude",
    bytes: 450 * MIB,
    admissionClass: "automation",
    origin: "test",
    now: admitted,
  });
  assert.equal(Date.parse(automation.expiresAt) - admitted.getTime(), ADMISSION_TTL_AUTOMATION_MS);
  assert.equal(ADMISSION_TTL_AUTOMATION_MS, 600_000);
  const bindAt = new Date("2026-10-31T01:00:20.000Z");
  const bound = boundEntry(automation, "rec", bindAt);
  assert.equal(bound.boundAt, bindAt.toISOString());
  assert.equal(bound.sessionId, "rec");
  assert.equal(Date.parse(bound.expiresAt) - bindAt.getTime(), ADMISSION_TTL_AUTOMATION_MS);
  for (const cls of ["spawn", "interactive", "delivery"] as const) {
    const entry = newEntry({
      key: cls,
      harness: "claude",
      bytes: 1,
      origin: "t",
      admissionClass: cls,
      now: admitted,
    });
    assert.equal(Date.parse(entry.expiresAt) - admitted.getTime(), ADMISSION_TTL_MS, cls);
    assert.equal(
      Date.parse(boundEntry(entry, "r", bindAt).expiresAt) - bindAt.getTime(),
      ADMISSION_TTL_MS,
      cls,
    );
  }
});

test("refusal token: queued_ahead is appended last on every reason, admission_busy included", () => {
  const busy = capacityRefusal("admission_busy", undefined, 3);
  assert.match(busy.stderrLine, / retry_after_s=5 queued_ahead=3$/u);
  assert.equal(busy.capacityRefusal.queuedAhead, 3);
  assert.match(capacityRefusal("no_capacity").stderrLine, / queued_ahead=0$/u);
});

// ---------------------------------------------------------------------------------------------
// admissionLock (TE defect D2, HoD decision P rev 2): the probe sees what a waiting create would see
// ---------------------------------------------------------------------------------------------

/** Plants admission.lock held by `pid` (with its birth identity when readable), `ageMs` old. */
function plantLock(
  f: Fixture,
  pid: number,
  ageMs: number,
  identity = readProcessBirthIdentity(pid),
) {
  const dir = path.join(f.root, "admission");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "admission.lock");
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid,
      createdAt: new Date().toISOString(),
      ...(identity ? { processIdentity: serializeProcessBirthIdentity(identity) } : {}),
    }),
  );
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
}

const lockOf = (json: Record<string, unknown>) =>
  json.admissionLock as { busy: boolean; retryAfterS: number | null };

test("admissionLock: a LIVE holder for >= 5 s ⇒ busy, and --need exits 75 with admission_busy: — for automation AND spawn", async () => {
  const f = makeBox({ requestMib: 4000 });
  assert.ok(readProcessBirthIdentity(process.pid), "this test process can be judged live");
  plantLock(f, process.pid, 10_000);
  for (const cls of ["automation", "spawn"]) {
    const probe = await probeJson(f, asAgent(f), ["--class", cls, "--need", "1"]);
    assert.equal(probe.code, 75, cls);
    assert.deepEqual(lockOf(probe.json), { busy: true, retryAfterS: 5 }, cls);
    assert.equal(probe.json.needMet, false, cls);
    assert.match(String(probe.json.needMetReason), /^admission_busy: /u, cls);
    assert.equal(slotsOf(probe.json, "freeSlots") > 0, true, `${cls}: memory itself has room`);
  }
  // …which is exactly what a create starting now gets (the probe/gate invariant):
  const create = await newSession(f, asAgent(f));
  assert.equal(create.code, 75);
  assert.match(create.stderr, /^acpx: REFUSED reason=admission_busy /mu);
});

test("NEGATIVE admissionLock: a live holder YOUNGER than 5 s is not busy — a create's millisecond hold never reads as no room", async () => {
  const f = makeBox({ requestMib: 4000 });
  plantLock(f, process.pid, 0);
  const probe = await probeJson(f, asAgent(f), ["--class", "automation", "--need", "1"]);
  assert.equal(probe.code, 0);
  assert.deepEqual(lockOf(probe.json), { busy: false, retryAfterS: null });
});

test("NEGATIVE admissionLock: a DEAD holder, and an unjudgeable one, are free however old — the gate would break both", async () => {
  const gone = await goneAdmitter();
  const f = makeBox({ requestMib: 4000 });
  fs.mkdirSync(path.join(f.root, "admission"), { recursive: true });
  fs.writeFileSync(
    path.join(f.root, "admission", "admission.lock"),
    JSON.stringify({ pid: gone.admitterPid, processIdentity: gone.admitterIdentity }),
  );
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(f.root, "admission", "admission.lock"), old, old);
  const dead = await probeJson(f, asAgent(f), ["--class", "automation", "--need", "1"]);
  assert.equal(dead.code, 0);
  assert.equal(lockOf(dead.json).busy, false);

  fs.writeFileSync(path.join(f.root, "admission", "admission.lock"), "not a lock body");
  fs.utimesSync(path.join(f.root, "admission", "admission.lock"), old, old);
  const unjudgeable = await probeJson(f, asAgent(f), ["--class", "automation", "--need", "1"]);
  assert.equal(unjudgeable.code, 0);
  assert.equal(lockOf(unjudgeable.json).busy, false);
});

test("admissionLock: always present — every class, with and without --need, lock or no lock; without --need a busy lock keeps exit 0", async () => {
  const f = makeBox({ requestMib: 4000 });
  for (const args of [[], ["--class", "spawn"], ["--class", "automation"], ["--need", "1"]]) {
    const probe = await probeJson(f, asAgent(f), args);
    assert.equal(probe.code, 0, args.join(" "));
    assert.deepEqual(lockOf(probe.json), { busy: false, retryAfterS: null }, args.join(" "));
  }
  plantLock(f, process.pid, 10_000);
  const noNeed = await probeJson(f, asAgent(f), ["--class", "automation"]);
  assert.equal(noNeed.code, 0, "no --need: exit codes unchanged");
  assert.equal(lockOf(noNeed.json).busy, true);
  const text = await runCli(["capacity"], asAgent(f), f.root);
  assert.match(text.stdout, /^admission lock: BUSY — /mu);
});

test("admissionLock: on an UNCONFIGURED box a busy lock is reported but never turns --need into 75 — that box's gate takes no lock", async () => {
  const f = makeBox({});
  plantLock(f, process.pid, 10_000);
  const probe = await probeJson(f, asAgent(f), ["--class", "automation", "--need", "1"]);
  assert.equal(probe.code, 0);
  assert.equal(lockOf(probe.json).busy, true);
});
