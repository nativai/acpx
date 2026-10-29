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
  ADMISSION_TTL_MS,
  containerInstance,
  liveEntries,
  newEntry,
  type PendingEntry,
  readLedgerFile,
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
  /^acpx: REFUSED reason=no_capacity nothing_started=true protocol=1 box=\S+ basis=request free_slots=0 need_mib=450 releasable_mib=0 retry_after_s=60$/mu;

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

test("class: ACPX_ADMISSION_CLASS decides when set — interactive/delivery/automation pass, spawn is gated without inference", async () => {
  const f = makeBox({ requestMib: 2048 });
  for (const cls of ["interactive", "delivery", "automation"]) {
    const run = await newSession(f, asAgent(f, { ACPX_ADMISSION_CLASS: cls }));
    assert.equal(run.code, 0, `${cls}: ${run.stderr}`);
  }
  // `spawn` from atrium (no identity, not in a tree) is still gated: atrium vouches for an agent.
  const outside = makeBox({ requestMib: 2048, inOwnerTree: false });
  const spawned = await newSession(outside, { ...outside.env, ACPX_ADMISSION_CLASS: "spawn" });
  assert.equal(spawned.code, 75, spawned.stderr);
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
    /^acpx: REFUSED reason=admission_busy nothing_started=true protocol=1 retry_after_s=5$/mu,
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
      { key: "a", sessionId: "s-live", bytes: 450, admitterAlive: false },
      { key: "b", sessionId: "s-gone", bytes: 450, admitterAlive: true },
      { key: "c", bytes: 340, admitterAlive: true },
      { key: "d", sessionId: "s-gone", bytes: 450, admitterAlive: false },
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
