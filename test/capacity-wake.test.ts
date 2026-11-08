import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { finalReportOffer, PRE_S1_HINT } from "../src/capacity/admission.js";
import { MIB } from "../src/capacity/constants.js";
import {
  ADMISSION_TTL_MS,
  newEntry,
  type PendingEntry,
  readLedgerFile,
  reservationsOf,
  withAdmissionLock,
} from "../src/capacity/ledger.js";
import { partitionPending } from "../src/capacity/pending.js";
import { finalReportSupported } from "../src/capacity/waiting.js";
import { sendSession } from "../src/cli/session/queue-owner-runtime.js";

// brick 2b3b259f — A1, the WAKE gate (CONCEPTION §3–§5, TEST-MATRIX B11/B14/B15, C1–C19 acpx
// rows). Every memory source is a FIXTURE tree (podinfo, cgroup, /proc, leases) as in
// test/capacity-admission.test.ts; the gate's lock, ledger, log and capability marker live in each
// box's own ACPX_ADMISSION_DIR. The fixture's /proc puts the READER (pid 4242) inside the caller's
// owner tree (100 → 101 → 102 → 103 → 4242): an agent running `acpx prompt` from its shell.

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_HREF = pathToFileURL(
  fileURLToPath(new URL("./mock-agent.js", import.meta.url)),
).href;
const GiB = 1024 * MIB;
const NS = "pid:[4026532839]";
const CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const CALLER = "sess-caller";
const SEAT = "5ea7c0de-0000-4000-8000-000000000001";

type Proc = { pid: number; ppid: number; ticks: string; rssAnonKb: number };

const CALLER_TREE: Proc[] = [
  { pid: 100, ppid: 1, ticks: "5000", rssAnonKb: 100 * 1024 },
  { pid: 101, ppid: 100, ticks: "5001", rssAnonKb: 50 * 1024 },
  { pid: 102, ppid: 101, ticks: "5002", rssAnonKb: 150 * 1024 },
  { pid: 103, ppid: 102, ticks: "5003", rssAnonKb: 4 * 1024 },
];
const READER: Proc = { pid: 4242, ppid: 103, ticks: "9000", rssAnonKb: 50 * 1024 };

/** MiB. 2700 ⇒ exactly ONE agent slot; 2048 ⇒ none; 4000 ⇒ four. Absent ⇒ no podinfo. */
type Box = { requestMib?: number; inOwnerTree?: boolean; psiFull?: number };

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

function writeCallerLease(queues: string): void {
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

function setRequest(f: Fixture, mib: number): void {
  fs.writeFileSync(path.join(f.root, "podinfo", "memory_request"), String(mib * MIB));
}

function makeBox(box: Box): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-wake-"));
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
    `some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=${(box.psiFull ?? 0).toFixed(2)} avg60=0.00 avg300=0.00 total=1\n`,
  );
  fs.writeFileSync(path.join(proc, "meminfo"), "MemTotal: 16000000 kB\nMemAvailable: 9000000 kB\n");
  fs.writeFileSync(path.join(proc, "loadavg"), "1.00 1.00 1.00 2/300 12345\n");
  for (const p of CALLER_TREE) {
    writeProc(proc, p);
  }
  writeProc(proc, box.inOwnerTree === false ? { ...READER, ppid: 1 } : READER);
  fs.symlinkSync(String(READER.pid), path.join(proc, "self"));
  writeCallerLease(queues);
  fs.writeFileSync(
    path.join(sessions, `${CALLER}.json`),
    JSON.stringify({
      acpx_record_id: CALLER,
      agent_command: CLAUDE_COMMAND,
      seat_id: SEAT,
      holder_ordinal: 1,
      holder_active: true,
      last_used_at: new Date().toISOString(),
      messages: [],
    }),
  );
  const marker = path.join(root, "agent-starts.ndjson");
  const wrapper = path.join(root, "agent.mjs");
  fs.writeFileSync(
    wrapper,
    `import fs from "node:fs";\n` +
      `fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, classPresent: "ACPX_ADMISSION_CLASS" in process.env }) + "\\n");\n` +
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

const sessionsDir = (f: Fixture) => path.join(f.root, ".acpx", "sessions");
const recordPath = (f: Fixture, id: string) => path.join(sessionsDir(f), `${id}.json`);
const admission = (f: Fixture) => path.join(f.root, "admission");

/** A real session record (created on room by a non-agent, so nothing is reserved for it). */
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

function patchRecord(f: Fixture, id: string, patch: Record<string, unknown>): void {
  const file = recordPath(f, id);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete record[key];
    } else {
      record[key] = value;
    }
  }
  fs.writeFileSync(file, JSON.stringify(record));
}

const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

type AdmitWakeJson = {
  action: string;
  schema: number;
  sessionId: string;
  decision: string;
  why: string | null;
  key: string | null;
  expiresAt: string | null;
  refusal: {
    message: string;
    tokenLine: string;
    reason: string;
    retryAfterS: number;
    queuedAhead: number;
    box: string | null;
    live: number | null;
    starting: number | null;
    freeSlots: number | null;
    needMib: number | null;
    finalReport: { offered: boolean; why: string };
  } | null;
};

async function admitWakeCli(
  f: Fixture,
  id: string,
  extra: string[] = [],
  env: NodeJS.ProcessEnv = f.env,
): Promise<Run & { json: AdmitWakeJson }> {
  const run = await runCli(
    [
      "--format",
      "json",
      "capacity",
      "admit-wake",
      "--session-id",
      id,
      "--class",
      "delivery",
      ...extra,
    ],
    env,
    os.tmpdir(),
  );
  let json: AdmitWakeJson;
  try {
    json = JSON.parse(run.stdout) as AdmitWakeJson;
  } catch {
    assert.fail(`admit-wake printed no JSON (rc ${run.code}): ${run.stdout}\n${run.stderr}`);
  }
  return { ...run, json };
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

const wakeLines = (f: Fixture) => decisionLog(f).filter((line) => line.kind === "wake");

function writeMarker(
  f: Fixture,
  ageMs = 0,
  body: unknown = { schema: 1, finalReport: true },
): void {
  const dir = path.join(admission(f), "capabilities");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "atrium-test.json");
  fs.writeFileSync(file, JSON.stringify(body));
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
}

function leaseFiles(f: Fixture): string[] {
  return fs.readdirSync(path.join(f.root, ".acpx", "queues")).filter((n) => n.endsWith(".lock"));
}

function agentStarts(f: Fixture): number {
  try {
    return fs.readFileSync(f.marker, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

const LINE2 =
  /^acpx: no memory to wake session [0-9a-f]{8}: it has no running agent process \(released after idle, or stopped\), and starting one needs ~450 MiB the box does not have \(1 live, 0 starting; \d+\.\d\d GiB charged of a \d+\.\d\d GiB budget\)\. Nothing was started or queued\.$/u;
const LINE3 =
  "acpx: retry later — after one of your own sessions finishes, or after you close one you are done with — and never in a loop; 'acpx capacity --need 1' says when there is room.";
const LINE4_LEAF =
  "acpx: only if you have finished your work, will do no further work, and will close yourself right after this send: send it with 'send-message.sh --final-report' instead — it is held and delivered when room frees. Orchestrators, and any agent that will keep working, must not use it.";
const LINE_BLOCKED_LEAF =
  "acpx: blocked on the recipient's answer? Do not arm a wakeup to retry — it would take the slot the recipient needs to wake; end your turn with your question as its last output.";
const LINE4_ORCHESTRATOR =
  "acpx: (--final-report is only for a finished agent's last message before it closes itself; you have open sub-sessions, so it is not for you.)";

function tokenFor(id: string): RegExp {
  return new RegExp(
    `^acpx: REFUSED reason=no_capacity nothing_started=true protocol=1 box=\\S+ basis=request free_slots=0 need_mib=450 releasable_mib=0 retry_after_s=60 queued_ahead=0 wake=${id}$`,
    "mu",
  );
}

// ---------------------------------------------------------------------------------------------
// admit-wake: the CLI contract atrium builds against (CONCEPTION §4.1, IMPL-acpx.md)
// ---------------------------------------------------------------------------------------------

test("admit-wake: released target with room → admitted, one `wake:` entry bound at admission, 180 s, exit 0", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  const run = await admitWakeCli(f, id, ["--sender", CALLER]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(
    { ...run.json, expiresAt: typeof run.json.expiresAt },
    {
      action: "admit-wake",
      schema: 1,
      sessionId: id,
      decision: "admitted",
      why: null,
      key: `wake:${id}`,
      expiresAt: "string",
      refusal: null,
    },
  );
  const entries = await readLedgerFile(admission(f));
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.kind, "wake");
  assert.equal(entry.key, `wake:${id}`);
  assert.equal(entry.sessionId, id);
  assert.equal(entry.class, "delivery");
  assert.equal(entry.boundAt, entry.admittedAt, "bound from admission on (§3.4)");
  assert.equal(Date.parse(entry.expiresAt) - Date.parse(entry.admittedAt), ADMISSION_TTL_MS);
  assert.equal(entry.expiresAt, run.json.expiresAt);
});

test("admit-wake: a second call within 180 s → already-reserved, no second entry (one wake, one charge)", async () => {
  const f = makeBox({ requestMib: 2700 });
  const id = await makeTarget(f);
  assert.equal((await admitWakeCli(f, id)).json.decision, "admitted");
  const again = await admitWakeCli(f, id);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.decision, "already-reserved");
  assert.equal(again.json.key, `wake:${id}`);
  assert.equal((await readLedgerFile(admission(f))).length, 1);
  // …and the slot it holds is really taken: another released session is refused.
  const other = await makeTarget(f);
  assert.equal((await admitWakeCli(f, other)).code, 75);
});

test("NEGATIVE admit-wake: full box → exit 75, the refusal JSON, and NOTHING written — no entry, no lease, record byte-identical (G1)", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  setRequest(f, 2048);
  const before = sha256(recordPath(f, id));
  const leasesBefore = leaseFiles(f);
  const run = await admitWakeCli(f, id, ["--sender", CALLER]);
  assert.equal(run.code, 75, run.stderr);
  assert.equal(run.json.decision, "refused");
  assert.equal(run.json.key, null);
  const refusal = run.json.refusal;
  assert.ok(refusal);
  assert.match(refusal.tokenLine, tokenFor(id));
  assert.equal(refusal.reason, "no_capacity");
  assert.equal(refusal.retryAfterS, 60);
  assert.equal(refusal.queuedAhead, 0);
  assert.equal(refusal.live, 1);
  assert.equal(refusal.starting, 0);
  assert.equal(refusal.freeSlots, 0);
  assert.equal(refusal.needMib, 450);
  assert.equal(typeof refusal.box, "string");
  assert.deepEqual(refusal.finalReport, { offered: false, why: "no-capability" });
  assert.match(run.stderr, tokenFor(id), "the token line stays on stderr in JSON mode");
  assert.deepEqual(await readLedgerFile(admission(f)), [], "no reservation");
  assert.deepEqual(leaseFiles(f), leasesBefore, "no owner");
  assert.equal(sha256(recordPath(f, id)), before, "record unmodified");
});

test("admit-wake: a CLOSED target is never short-circuited — closed+room admitted, closed+full refused", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  patchRecord(f, id, { closed: true, closed_at: new Date().toISOString() });
  assert.equal((await admitWakeCli(f, id)).json.decision, "admitted");
  const other = await makeTarget(f);
  patchRecord(f, other, { closed: true, closed_at: new Date().toISOString() });
  setRequest(f, 2048);
  const refused = await admitWakeCli(f, other);
  assert.equal(refused.code, 75);
  assert.equal(refused.json.decision, "refused");
});

test("admit-wake: an unconfigured box (no podinfo) → not-gated unconfigured, exit 0, logged, no lock taken (B15)", async () => {
  const f = makeBox({});
  const id = await makeTarget(f);
  const run = await admitWakeCli(f, id);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.json.decision, "not-gated");
  assert.equal(run.json.why, "unconfigured");
  assert.equal(fs.existsSync(path.join(admission(f), "admission.lock")), false);
  const [line] = wakeLines(f);
  assert.equal(line.decision, "not-gated");
  assert.equal(line.why, "unconfigured");
});

test("admit-wake: CLI — usage errors exit 2; plain `acpx capacity --class` keeps its own classes beside it", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  const badClass = await runCli(
    ["capacity", "admit-wake", "--session-id", id, "--class", "spawn"],
    f.env,
    os.tmpdir(),
  );
  assert.equal(badClass.code, 2, badClass.stderr);
  const badRole = await runCli(
    ["capacity", "admit-wake", "--session-id", id, "--class", "delivery", "--sender-role", "x"],
    f.env,
    os.tmpdir(),
  );
  assert.equal(badRole.code, 2, badRole.stderr);
  const noId = await runCli(["capacity", "admit-wake", "--class", "delivery"], f.env, os.tmpdir());
  assert.equal(noId.code, 2, noId.stderr);
  const plain = await runCli(
    ["--format", "json", "capacity", "--class", "automation"],
    f.env,
    os.tmpdir(),
  );
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal((JSON.parse(plain.stdout) as { class: string }).class, "automation");
  assert.doesNotMatch(plain.stderr + plain.stdout, /No acpx session found/u);
});

// ---------------------------------------------------------------------------------------------
// The refusal text — ONE author, every variant (CONCEPTION §5.1 a–d; B11, C19, G15, G20)
// ---------------------------------------------------------------------------------------------

async function refusedText(f: Fixture, id: string, extra: string[]): Promise<string[]> {
  const run = await admitWakeCli(f, id, extra);
  assert.equal(run.code, 75, run.stderr);
  return run.json.refusal?.message.split("\n") ?? [];
}

test("text (a): a LEAF sender, marker fresh → lines 1–4 + the pre-S1 hint, offered:true why leaf", async () => {
  const f = makeBox({ requestMib: 2048 });
  const id = await makeTarget(f);
  writeMarker(f);
  const run = await admitWakeCli(f, id, ["--sender", CALLER, "--sender-role", "leaf"]);
  assert.equal(run.code, 75);
  const lines = run.json.refusal?.message.split("\n") ?? [];
  assert.equal(lines.length, 6, lines.join("\n"));
  assert.match(lines[0], tokenFor(id));
  assert.match(lines[1], LINE2);
  assert.equal(lines[2], LINE3);
  assert.equal(lines[3], LINE_BLOCKED_LEAF);
  assert.equal(lines[4], LINE4_LEAF);
  assert.equal(lines[5], PRE_S1_HINT);
  assert.equal(PRE_S1_HINT, "(If your send-message.sh does not know --final-report, retry later.)");
  assert.deepEqual(run.json.refusal?.finalReport, { offered: true, why: "leaf" });
});

test("text (b): an ORCHESTRATOR sender → line 4 is 'not for you', no hint, offered:false", async () => {
  const f = makeBox({ requestMib: 2048 });
  const id = await makeTarget(f);
  writeMarker(f);
  const lines = await refusedText(f, id, ["--sender-role", "orchestrator"]);
  assert.equal(lines.length, 4, lines.join("\n"));
  assert.equal(lines[3], LINE4_ORCHESTRATOR);
  assert.ok(!lines.includes(PRE_S1_HINT));
  assert.ok(
    !lines.includes(LINE_BLOCKED_LEAF),
    "an orchestrator is never told not to arm a wakeup",
  );
});

test("NEGATIVE text (c): marker absent, stale (6 min), future (+60 s) or not finalReport → --final-report is NEVER named", async () => {
  const f = makeBox({ requestMib: 2048 });
  const id = await makeTarget(f);
  const cases: Array<[string, () => void]> = [
    [
      "absent",
      () => fs.rmSync(path.join(admission(f), "capabilities"), { recursive: true, force: true }),
    ],
    ["stale", () => writeMarker(f, 6 * 60_000)],
    ["future", () => writeMarker(f, -60_000)],
    ["no finalReport", () => writeMarker(f, 0, { schema: 1, finalReport: false })],
    ["other schema", () => writeMarker(f, 0, { schema: 2, finalReport: true })],
  ];
  for (const [label, arrange] of cases) {
    arrange();
    for (const role of ["leaf", "orchestrator"]) {
      const run = await admitWakeCli(f, id, ["--sender-role", role]);
      assert.equal(run.code, 75, `${label}/${role}`);
      const message = run.json.refusal?.message ?? "";
      // The blocked-leaf line is about the sender's position, not atrium's capability: a leaf gets
      // it here too (4 lines); an orchestrator never does (3).
      assert.equal(
        message.split("\n").length,
        role === "leaf" ? 4 : 3,
        `${label}/${role}: ${message}`,
      );
      assert.equal(message.includes(LINE_BLOCKED_LEAF), role === "leaf", `${label}/${role}`);
      assert.doesNotMatch(message, /--final-report/u, `${label}/${role}`);
      assert.deepEqual(run.json.refusal?.finalReport, { offered: false, why: "no-capability" });
    }
  }
});

test("marker: fresh just-written (−2 s ≤ age < 5 min, the waiting-file rule) counts; 5 min does not", () => {
  const f = makeBox({ requestMib: 2048 });
  writeMarker(f, -1_000);
  assert.equal(finalReportSupported(admission(f)), true, "a fraction ahead (NFS clock) counts");
  writeMarker(f, 4 * 60_000);
  assert.equal(finalReportSupported(admission(f)), true);
  writeMarker(f, 5 * 60_000 + 1_000);
  assert.equal(finalReportSupported(admission(f)), false);
  fs.writeFileSync(path.join(admission(f), "capabilities", "atrium-test.json"), "{not json");
  assert.equal(finalReportSupported(admission(f)), false, "malformed fails closed");
});

test("text: no --sender-role (atrium could not judge) → line 4 omitted, why no-sender", async () => {
  const f = makeBox({ requestMib: 2048 });
  const id = await makeTarget(f);
  writeMarker(f);
  const run = await admitWakeCli(f, id, ["--sender", CALLER]);
  assert.equal(run.json.refusal?.message.split("\n").length, 3);
  assert.deepEqual(run.json.refusal?.finalReport, { offered: false, why: "no-sender" });
});

test("text (d): --cross-box → line 3 names the recipient's box and never local-box advice; a leaf is offered, why cross-box", async () => {
  const f = makeBox({ requestMib: 2048 });
  const id = await makeTarget(f);
  writeMarker(f);
  const run = await admitWakeCli(f, id, ["--cross-box", "--sender-role", "leaf"]);
  const lines = run.json.refusal?.message.split("\n") ?? [];
  const box = run.json.refusal?.box ?? "";
  assert.equal(
    lines[2],
    `acpx: the recipient's box (${box}) has no room right now; retry later, never in a loop — your own box's 'acpx capacity' cannot see it.`,
  );
  assert.doesNotMatch(lines.join("\n"), /acpx capacity --need 1/u);
  assert.equal(lines[3], LINE_BLOCKED_LEAF);
  assert.equal(lines[4], LINE4_LEAF);
  assert.deepEqual(run.json.refusal?.finalReport, { offered: true, why: "cross-box" });
});

test("text (§5.7): the blocked-leaf line sits between the retry line and the --final-report line, local and cross-box; an orchestrator never gets it, in either box shape", async () => {
  const f = makeBox({ requestMib: 2048 });
  const id = await makeTarget(f);
  writeMarker(f);
  for (const crossBox of [false, true]) {
    const cross = crossBox ? ["--cross-box"] : [];
    const leaf = await refusedText(f, id, [...cross, "--sender-role", "leaf"]);
    const at = leaf.indexOf(LINE_BLOCKED_LEAF);
    assert.ok(at > 0, `leaf crossBox=${crossBox}: ${leaf.join("\n")}`);
    assert.ok(leaf[at - 1].includes("retry later"), `crossBox=${crossBox}: retry line precedes it`);
    assert.equal(leaf[at + 1], LINE4_LEAF, `crossBox=${crossBox}: final-report line follows it`);
    const orchestrator = await refusedText(f, id, [...cross, "--sender-role", "orchestrator"]);
    assert.ok(
      !orchestrator.join("\n").includes("Do not arm a wakeup"),
      `orchestrator crossBox=${crossBox}: ${orchestrator.join("\n")}`,
    );
  }
});

test("text: the seat name leads <who> when the target's seat has one", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  const seatId = (JSON.parse(fs.readFileSync(recordPath(f, id), "utf8")) as { seat_id: string })
    .seat_id;
  const renamed = await runCli(["seats", "rename", seatId, "impl-a1"], f.env, os.tmpdir());
  assert.equal(renamed.code, 0, renamed.stderr);
  setRequest(f, 2048);
  const lines = await refusedText(f, id, []);
  assert.match(
    lines[1],
    new RegExp(`^acpx: no memory to wake impl-a1 \\(session ${id.slice(0, 8)}\\): `, "u"),
  );
});

test("text: memory_pressure → its own line 2; queued_ahead > 0 → line 2 ends with the waiting clause", async () => {
  const f = makeBox({ requestMib: 4000, psiFull: 40 });
  const id = await makeTarget(f);
  const run = await admitWakeCli(f, id);
  assert.equal(run.code, 75, run.stderr);
  assert.equal(run.json.refusal?.reason, "memory_pressure");
  assert.match(
    run.json.refusal?.message.split("\n")[1] ?? "",
    /^acpx: no memory to wake session [0-9a-f]{8} right now: the box is stalling on memory \(PSI full avg10 40 %\)\. Nothing was started or queued\.$/u,
  );

  const g = makeBox({ requestMib: 2700 });
  const other = await makeTarget(g);
  const dir = path.join(admission(g), "waiting");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "atrium-test.json"),
    JSON.stringify({
      schema: 1,
      writer: "atrium-test",
      writtenAt: new Date().toISOString(),
      items: [
        {
          key: "delivery:x",
          kind: "delivery",
          ref: "x",
          label: "c → p",
          harness: "claude",
          since: new Date().toISOString(),
          to: "x",
        },
      ],
    }),
  );
  const queued = await admitWakeCli(g, other);
  assert.equal(queued.code, 75, "W = 1 takes the one agent slot");
  assert.equal(queued.json.refusal?.queuedAhead, 1);
  assert.match(queued.json.refusal?.tokenLine ?? "", / queued_ahead=1 wake=/u);
  assert.match(
    queued.json.refusal?.message.split("\n")[1] ?? "",
    / Nothing was started or queued\. 1 waiting item takes the next free slots first\.$/u,
  );
});

test("finalReportOffer: the decision order (busy, capability, sender, role)", () => {
  const base = { finalReportSupported: true, crossBox: false } as const;
  assert.deepEqual(finalReportOffer({ ...base, reason: "admission_busy", senderRole: "leaf" }), {
    offered: false,
    why: "admission-busy",
  });
  assert.deepEqual(
    finalReportOffer({
      ...base,
      reason: "no_capacity",
      senderRole: "leaf",
      finalReportSupported: false,
    }),
    { offered: false, why: "no-capability" },
  );
  assert.deepEqual(finalReportOffer({ ...base, reason: "no_capacity", senderRole: undefined }), {
    offered: false,
    why: "no-sender",
  });
  assert.deepEqual(
    finalReportOffer({ ...base, reason: "node_pressure", senderRole: "orchestrator" }),
    {
      offered: false,
      why: "orchestrator",
    },
  );
  assert.deepEqual(finalReportOffer({ ...base, reason: "no_capacity", senderRole: "leaf" }), {
    offered: true,
    why: "leaf",
  });
});

// ---------------------------------------------------------------------------------------------
// The acpx-side gate: an agent's own `acpx prompt` (CONCEPTION §4.2; C1, B11)
// ---------------------------------------------------------------------------------------------

const promptCli = (f: Fixture, id: string, env: NodeJS.ProcessEnv, extra: string[] = []) =>
  runCli([...extra, "prompt", "--session-id", id, "hello"], env, f.root);

test("NEGATIVE prompt: an agent's `acpx prompt` to a released session on a full box exits 75 — nothing started, nothing reserved, record byte-identical", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  setRequest(f, 2048);
  writeMarker(f); // even with a fresh marker, a bare `acpx prompt` names no --final-report (R2-1)
  const before = sha256(recordPath(f, id));
  const startsBefore = agentStarts(f);
  const run = await promptCli(f, id, asAgent(f));
  assert.equal(run.code, 75, run.stderr);
  const lines = run.stderr.trim().split("\n");
  const at = lines.findIndex((line) => line.startsWith("acpx: REFUSED "));
  assert.ok(at >= 0, run.stderr);
  assert.match(lines[at], tokenFor(id));
  assert.match(lines[at + 1] ?? "", LINE2);
  assert.equal(lines[at + 2], LINE3);
  assert.doesNotMatch(run.stderr, /--final-report/u);
  assert.equal(sha256(recordPath(f, id)), before, "a refused prompt does not mutate its target");
  assert.equal(agentStarts(f), startsBefore, "no adapter started");
  assert.deepEqual(leaseFiles(f), ["caller.lock"], "no owner started");
  assert.deepEqual(await readLedgerFile(admission(f)), []);
  const [line] = wakeLines(f);
  assert.equal(line.decision, "refused");
  assert.equal(line.verb, "prompt");
  assert.equal(line.class, "spawn");
  assert.equal(line.classSource, "inferred");
  assert.equal(line.sender, CALLER);
});

test("prompt --format json: the refusal's data carries message (lines 2–3), wake and finalReport; the token stays on stderr", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  setRequest(f, 2048);
  writeMarker(f); // atrium supports it — a bare `acpx prompt` still offers nothing (no sender role)
  const run = await promptCli(f, id, asAgent(f), ["--format", "json"]);
  assert.equal(run.code, 75, run.stderr);
  assert.match(run.stderr, tokenFor(id));
  const last = run.stdout.trim().split("\n").at(-1) ?? "";
  const data = (JSON.parse(last) as { error: { data: Record<string, unknown> } }).error.data;
  assert.equal(data.acpxCode, "CAPACITY");
  assert.equal(data.reason, "no_capacity");
  const message = String(data.message).split("\n");
  assert.match(message[0], LINE2);
  assert.equal(message[1], LINE3);
  assert.equal(message.length, 2);
  const seatId = (JSON.parse(fs.readFileSync(recordPath(f, id), "utf8")) as { seat_id?: string })
    .seat_id;
  assert.deepEqual(data.wake, { sessionId: id, seatId: seatId ?? null });
  assert.deepEqual(data.finalReport, { offered: false, why: "no-sender" });
});

test("NEGATIVE control prompt: the SAME agent prompt with room is admitted — a wake entry, an owner, the turn runs", async () => {
  const f = makeBox({ requestMib: 2700 });
  const id = await makeTarget(f);
  const run = await promptCli(f, id, asAgent(f));
  assert.equal(run.code, 0, run.stderr);
  const [line] = wakeLines(f);
  assert.equal(line.decision, "admitted");
  assert.equal(line.key, `wake:${id}`);
  const record = JSON.parse(fs.readFileSync(recordPath(f, id), "utf8")) as {
    last_prompt_at?: string;
  };
  assert.ok(record.last_prompt_at, "the turn ran");
  // …and the entry is SPENT by that turn (last_prompt_at ≥ boundAt): no longer held as pending.
  const entries = await readLedgerFile(admission(f));
  const reservations = reservationsOf(entries, sessionsDir(f));
  assert.deepEqual(
    reservations.map((r) => r.spent),
    entries.map(() => true),
  );
});

test("NEGATIVE prompt: an older atrium's runner shape — no class, identity stripped — is never gated (skew-safe)", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  setRequest(f, 2048);
  const run = await promptCli(f, id, f.env);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(wakeLines(f), [], "nothing to log: no class, no agent");
});

test("class: ACPX_ADMISSION_CLASS on a prompt — delivery, automation, spawn gated; interactive never (logged overBudget, lock untouched); garbage → inference", async () => {
  const f = makeBox({ requestMib: 4000, inOwnerTree: false });
  const ids = [await makeTarget(f), await makeTarget(f), await makeTarget(f)];
  setRequest(f, 2048);
  for (const [i, cls] of ["delivery", "automation", "spawn"].entries()) {
    const run = await promptCli(f, ids[i], { ...f.env, ACPX_ADMISSION_CLASS: cls });
    assert.equal(run.code, 75, `${cls}: ${run.stderr}`);
  }
  // interactive: an authenticated human through atrium — over budget, still delivered, and it never
  // touches the admission lock (C18): with a LIVE holder on the lock for the whole run, a wake that
  // took it would wait 5 s and be refused admission_busy.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withAdmissionLock(admission(f), () => held);
  let human: Run;
  try {
    human = await promptCli(f, ids[0], { ...f.env, ACPX_ADMISSION_CLASS: "interactive" });
  } finally {
    release();
    await holder;
  }
  assert.equal(human.code, 0, human.stderr);
  const interactive = wakeLines(f).filter((line) => line.class === "interactive");
  assert.equal(interactive.length, 1);
  assert.equal(interactive[0].decision, "not-gated");
  assert.equal(interactive[0].why, "interactive");
  assert.equal(interactive[0].overBudget, true, "logged with a reading: the box was over budget");
  assert.equal(typeof interactive[0].guard, "string");
  // garbage: logged as invalidClass, decided by inference — outside every owner tree ⇒ not gated.
  const bogus = await promptCli(f, ids[2], {
    ...asAgent(f),
    ACPX_ADMISSION_CLASS: "human-please",
  });
  assert.equal(bogus.code, 0, bogus.stderr);
  const last = wakeLines(f).at(-1);
  assert.equal(last?.invalidClass, "human-please");
  assert.equal(last?.why, "not-in-owner-tree");
});

test("prompt: a LIVE owner on a full box is submitted to — admitWake is never asked (G3)", async () => {
  const f = makeBox({ requestMib: 2700 });
  const id = await makeTarget(f);
  assert.equal((await promptCli(f, id, asAgent(f))).code, 0, "first turn starts the owner");
  const linesBefore = wakeLines(f).length;
  setRequest(f, 2048);
  const run = await promptCli(f, id, asAgent(f));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(wakeLines(f).length, linesBefore, "no wake decision for a live target");
  const live = await admitWakeCli(f, id);
  assert.equal(live.code, 0);
  assert.equal(live.json.decision, "not-needed");
});

test("prompt: a closed record prompted WITH --message-id is never gated (its owner refuses it) — logged why=closed", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  patchRecord(f, id, { closed: true, closed_at: new Date().toISOString() });
  setRequest(f, 2048);
  const run = await runCli(
    ["prompt", "--session-id", id, "--message-id", randomUUID(), "--no-wait", "hello"],
    asAgent(f),
    f.root,
  );
  assert.notEqual(run.code, 75, run.stderr);
  const [line] = wakeLines(f);
  assert.ok(line, `no wake line (rc ${run.code}): ${run.stderr}`);
  assert.equal(line.decision, "not-gated");
  assert.equal(line.why, "closed");
});

// ---------------------------------------------------------------------------------------------
// Succession (§3.3, C14) and the decision log (§3.4, C12, C17)
// ---------------------------------------------------------------------------------------------

test("successor: (a) fresh successor of a LIVE lower-ordinal seat-mate → not gated; (b) retired, (c) already had a turn, (d) predecessor dead → gated", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  setRequest(f, 2048);
  const successor = {
    seat_id: SEAT,
    holder_ordinal: 2,
    holder_active: true,
    last_prompt_at: undefined,
  };
  patchRecord(f, id, successor);
  const fresh = await admitWakeCli(f, id);
  assert.equal(fresh.code, 0, fresh.stderr);
  assert.equal(fresh.json.decision, "not-gated");
  assert.equal(fresh.json.why, "successor");
  patchRecord(f, id, { ...successor, holder_active: false });
  assert.equal((await admitWakeCli(f, id)).code, 75, "(b) mail to a retired holder");
  patchRecord(f, id, { ...successor, last_prompt_at: new Date().toISOString() });
  assert.equal((await admitWakeCli(f, id)).code, 75, "(c) a later wake of the active holder");
  patchRecord(f, id, successor);
  fs.rmSync(path.join(f.root, ".acpx", "queues", "caller.lock"));
  assert.equal((await admitWakeCli(f, id)).code, 75, "(d) the predecessor is dead");
});

test("log: every wake line carries kind, target, targetSeat, verb, class, classSource, caller, sender — and live = liveRecent + liveIdle2to5m + liveIdleGe5m", async () => {
  const f = makeBox({ requestMib: 2048 });
  const id = await makeTarget(f);
  patchRecord(f, CALLER, { last_used_at: new Date(Date.now() - 3 * 60_000).toISOString() });
  await admitWakeCli(f, id, ["--sender", "sess-sender", "--sender-role", "leaf"]);
  const [line] = wakeLines(f);
  for (const field of [
    "target",
    "targetSeat",
    "verb",
    "class",
    "classSource",
    "caller",
    "sender",
  ]) {
    assert.ok(field in line, `missing ${field}`);
  }
  assert.equal(line.target, id);
  assert.equal(line.verb, "capacity admit-wake");
  assert.equal(line.class, "delivery");
  assert.equal(line.classSource, "flag");
  assert.equal(line.sender, "sess-sender");
  assert.equal(line.senderRole, "leaf");
  assert.equal(line.decision, "refused");
  assert.equal(line.reason, "no_capacity");
  assert.deepEqual(
    [line.liveRecent, line.liveIdle2to5m, line.liveIdleGe5m],
    [0, 1, 0],
    "the caller's owner, idle 3 min",
  );
  assert.equal(
    Number(line.liveRecent) + Number(line.liveIdle2to5m) + Number(line.liveIdleGe5m),
    line.live,
  );
});

// ---------------------------------------------------------------------------------------------
// The wake reservation (§3.4, C8) and races (§3.1, C3/C4, G6)
// ---------------------------------------------------------------------------------------------

test("wake ledger: a wake for a CLOSED record survives a concurrent decision (spent only by a turn, never by closed)", async () => {
  const f = makeBox({ requestMib: 4000 });
  const closedId = await makeTarget(f);
  patchRecord(f, closedId, { closed: true, closed_at: new Date().toISOString() });
  assert.equal((await admitWakeCli(f, closedId)).json.decision, "admitted");
  const other = await makeTarget(f);
  assert.equal((await admitWakeCli(f, other)).json.decision, "admitted");
  const keys = (await readLedgerFile(admission(f))).map((entry) => entry.key).toSorted();
  assert.deepEqual(keys, [`wake:${closedId}`, `wake:${other}`].toSorted());
});

test("wake ledger: spent ONLY by last_prompt_at ≥ boundAt; a create entry is still spent by closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-wake-sessions-"));
  const now = new Date();
  const wake = newEntry({
    key: "wake:rec",
    sessionId: "rec",
    harness: "claude",
    bytes: 450 * MIB,
    admissionClass: "delivery",
    origin: "test",
    now,
    kind: "wake",
  });
  const create: PendingEntry = { ...wake, key: "adm-x", kind: "create" };
  fs.writeFileSync(
    path.join(dir, "rec.json"),
    JSON.stringify({ acpx_record_id: "rec", closed: true }),
  );
  const spent = (entries: PendingEntry[]) => reservationsOf(entries, dir).map((r) => r.spent);
  assert.deepEqual(spent([wake, create]), [false, true]);
  fs.writeFileSync(
    path.join(dir, "rec.json"),
    JSON.stringify({
      acpx_record_id: "rec",
      last_prompt_at: new Date(now.getTime() + 5).toISOString(),
    }),
  );
  assert.deepEqual(spent([wake]), [true]);
  // A wake bound and unspent is charged whether or not its admitter lives (it is `bound`).
  assert.equal(
    partitionPending(
      reservationsOf([wake], fs.mkdtempSync(path.join(os.tmpdir(), "x-"))),
      new Set(),
    ).pendingBytes,
    450 * MIB,
  );
});

test("race: two concurrent wakes of TWO released sessions for ONE slot — exactly one admitted, the loser exit 75 (5 rounds)", async () => {
  for (let round = 0; round < 5; round += 1) {
    const f = makeBox({ requestMib: 2700 });
    const a = await makeTarget(f);
    const b = await makeTarget(f);
    const runs = await Promise.all([admitWakeCli(f, a), admitWakeCli(f, b)]);
    assert.deepEqual(
      runs.map((run) => run.code ?? -1).toSorted((x, y) => x - y),
      [0, 75],
      `round ${round}: ${runs.map((r) => r.stderr).join("\n")}`,
    );
    assert.equal((await readLedgerFile(admission(f))).length, 1);
  }
});

test("race: two concurrent wakes of the SAME released session, one slot — one entry, both admitted (5 rounds)", async () => {
  for (let round = 0; round < 5; round += 1) {
    const f = makeBox({ requestMib: 2700 });
    const a = await makeTarget(f);
    const runs = await Promise.all([admitWakeCli(f, a), admitWakeCli(f, a)]);
    assert.deepEqual(
      runs.map((run) => run.code),
      [0, 0],
      `round ${round}`,
    );
    assert.deepEqual(runs.map((run) => run.json.decision).toSorted(), [
      "admitted",
      "already-reserved",
    ]);
    assert.equal((await readLedgerFile(admission(f))).length, 1);
  }
});

test("lock: contention past 5 s refuses a wake with reason=admission_busy — its own text, no line 4, exit 75", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  writeMarker(f);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withAdmissionLock(admission(f), () => held);
  try {
    const run = await admitWakeCli(f, id, ["--sender-role", "leaf"]);
    assert.equal(run.code, 75, run.stderr);
    assert.deepEqual(run.json.refusal?.message.split("\n"), [
      `acpx: REFUSED reason=admission_busy nothing_started=true protocol=1 retry_after_s=5 queued_ahead=0 wake=${id}`,
      "acpx: other session starts held the box's admission lock for 5 s. Nothing was started or queued. Retry in a few seconds; 'acpx capacity' shows the room left.",
    ]);
    assert.deepEqual(run.json.refusal?.finalReport, { offered: false, why: "admission-busy" });
  } finally {
    release();
    await holder;
  }
});

// ---------------------------------------------------------------------------------------------
// The two call points in sendSession (§3.1) — a unit row with an injected gate
// ---------------------------------------------------------------------------------------------

test("fall-through: an owner live at the pre-check but gone at submit is gated before the spawn — and a refusal there spawns nothing", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  const previousHome = process.env.HOME;
  const previousState = process.env.ACPX_STATE_HOME;
  process.env.HOME = f.root;
  process.env.ACPX_STATE_HOME = f.root;
  const calls: string[] = [];
  try {
    await assert.rejects(
      sendSession(
        {
          sessionId: id,
          prompt: [{ type: "text", text: "hi" }],
          waitForCompletion: false,
        } as never,
        {
          submitToRunningOwner: async () => {
            calls.push("submit");
            return undefined; // the owner the pre-check saw is gone
          },
          spawnQueueOwnerProcess: () => {
            calls.push("spawn");
            throw new Error("must not spawn");
          },
          waitMs: async () => undefined,
          readStartupFailureDetail: () => undefined,
          startupBudgetMs: 0,
          nowMs: Date.now,
          maxSpawnAttempts: 1,
          wakeGate: () => ({
            beforePersist: async () => {
              calls.push("beforePersist");
            },
            beforeSpawn: async () => {
              calls.push("beforeSpawn");
              throw new Error("refused at the fall-through");
            },
          }),
        },
      ),
      /refused at the fall-through/u,
    );
  } finally {
    process.env.HOME = previousHome;
    process.env.ACPX_STATE_HOME = previousState;
  }
  assert.deepEqual(calls, ["beforePersist", "submit", "beforeSpawn"]);
});

// ---------------------------------------------------------------------------------------------
// Probe == gate (G12, C15) and the class never reaching an owner (C7)
// ---------------------------------------------------------------------------------------------

test("probe and gate agree: `capacity --need 1` met ⇔ admit-wake admits, over a sweep of fixture budgets", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  for (const mib of [2048, 2400, 2600, 2650, 2700, 2750, 3000, 3200, 4000]) {
    setRequest(f, mib);
    fs.rmSync(path.join(admission(f), "pending.json"), { force: true });
    const probe = await runCli(["capacity", "--need", "1"], f.env, os.tmpdir());
    const gate = await admitWakeCli(f, id);
    assert.equal(
      probe.code === 0,
      gate.code === 0,
      `${mib} MiB: probe ${probe.code}, gate ${gate.code}`,
    );
    assert.equal(gate.json.decision, probe.code === 0 ? "admitted" : "refused", `${mib} MiB`);
  }
});

test("class: ACPX_ADMISSION_CLASS never reaches the owner a woken prompt starts, or its adapter", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  const before = fs.existsSync(f.marker) ? fs.readFileSync(f.marker, "utf8") : "";
  const run = await promptCli(f, id, { ...f.env, ACPX_ADMISSION_CLASS: "delivery" });
  assert.equal(run.code, 0, run.stderr);
  const starts = fs
    .readFileSync(f.marker, "utf8")
    .slice(before.length)
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { classPresent: boolean });
  assert.ok(starts.length >= 1, "the woken owner's adapter started");
  assert.deepEqual(
    starts.map((s) => s.classPresent),
    starts.map(() => false),
  );
});

// ---------------------------------------------------------------------------------------------
// brick 5c44d8ba — the gate in front of an ownerless `set` direct connect (DESIGN §6 T2/T3, N6)
// ---------------------------------------------------------------------------------------------

const setModeCli = (f: Fixture, id: string, env: NodeJS.ProcessEnv) =>
  runCli(["set-mode", "plan", "--session-id", id], env, f.root);

function setToken(id: string, setting: string): RegExp {
  return new RegExp(
    `^acpx: REFUSED reason=no_capacity nothing_started=true protocol=1 box=\\S+ basis=request free_slots=0 need_mib=450 releasable_mib=0 retry_after_s=60 queued_ahead=0 set=${setting} wake=${id}$`,
    "mu",
  );
}

const SET_SENTENCE =
  /^acpx: Changing mode on session [0-9a-f]{8} needs to start its agent for a few seconds, and this box has no room for that right now\. Nothing was changed\. Retry in 60 s, or make the change while the session is running — a running session applies it without starting anything\.$/mu;

test("NEGATIVE set gate: an agent's ownerless `set-mode plan` on a full box exits 75 — set=mode before wake=<id>, nothing started, nothing reserved, record byte-identical (G6)", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  setRequest(f, 2048);
  writeMarker(f); // a set never offers --final-report, marker or not
  const before = sha256(recordPath(f, id));
  const starts = agentStarts(f);
  const run = await setModeCli(f, id, asAgent(f));
  assert.equal(run.code, 75, run.stderr);
  assert.match(run.stderr, setToken(id, "mode"));
  assert.match(run.stderr, SET_SENTENCE);
  assert.doesNotMatch(run.stderr, /--final-report/u);
  assert.equal(sha256(recordPath(f, id)), before, "a refused set does not mutate its target");
  assert.equal(agentStarts(f), starts, "no adapter started");
  assert.deepEqual(leaseFiles(f), ["caller.lock"]);
  assert.deepEqual(await readLedgerFile(admission(f)), []);
  const [line] = wakeLines(f);
  assert.equal(line.decision, "refused");
  assert.equal(line.verb, "set");
  assert.equal(line.setting, "mode");
  assert.equal(line.sender, CALLER);
});

test("set gate: a person is never refused — no identity (atrium's runner) runs ungated and unlogged; class interactive runs and is logged verb set", async () => {
  const f = makeBox({ requestMib: 4000, inOwnerTree: false });
  const ids = [await makeTarget(f), await makeTarget(f)];
  setRequest(f, 2048);
  const starts = agentStarts(f);
  const bare = await setModeCli(f, ids[0], f.env);
  assert.equal(bare.code, 0, bare.stderr);
  assert.equal(agentStarts(f), starts + 1, "the live path ran");
  assert.deepEqual(wakeLines(f), [], "no class, no agent: nothing to log");
  const human = await setModeCli(f, ids[1], { ...f.env, ACPX_ADMISSION_CLASS: "interactive" });
  assert.equal(human.code, 0, human.stderr);
  const [line] = wakeLines(f);
  assert.equal(line.decision, "not-gated");
  assert.equal(line.why, "interactive");
  assert.equal(line.verb, "set");
  assert.equal(line.setting, "mode");
});

test("set gate: an ADMITTED set's wake entry is released when its connect ends — on success and on failure (HoD 2026-11-07)", async () => {
  const f = makeBox({ requestMib: 2700 });
  const ok = await makeTarget(f);
  const run = await setModeCli(f, ok, asAgent(f));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(wakeLines(f).at(-1)?.decision, "admitted", "the set was admitted, so it reserved");
  assert.deepEqual(
    await readLedgerFile(admission(f)),
    [],
    "the admitted set's entry outlived its connect",
  );

  // Failure: the adapter dies at start — the connect throws, and the entry still goes.
  const failing = await makeTarget(f);
  const dead = path.join(f.root, "dead-agent.mjs");
  fs.writeFileSync(dead, "process.exit(1);\n");
  patchRecord(f, failing, { agent_command: `node ${JSON.stringify(dead)}` });
  const failed = await setModeCli(f, failing, asAgent(f));
  assert.notEqual(failed.code, 0, "the dead adapter fails the set");
  assert.notEqual(failed.code, 75, failed.stderr);
  assert.equal(wakeLines(f).at(-1)?.decision, "admitted");
  assert.deepEqual(await readLedgerFile(admission(f)), [], "a failed connect kept its entry");
});

test("set gate: a set the RECORD vouches for is never gated — an agent's `set model` on a full box succeeds, logs nothing, starts nothing (G1 under G6)", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  setRequest(f, 2048);
  // Real-shaped, classified (the PROJECT.md trap): an unclassified command would route live.
  const claude = path.join(f.root, "claude-agent-acp", "dist", "index.js");
  fs.mkdirSync(path.dirname(claude), { recursive: true });
  fs.writeFileSync(claude, "process.exit(1);\n");
  const record = JSON.parse(fs.readFileSync(recordPath(f, id), "utf8")) as { acpx?: object };
  patchRecord(f, id, {
    agent_command: `node ${claude}`,
    acpx: { ...record.acpx, available_models: ["default", "sonnet"] },
  });
  const starts = agentStarts(f);
  const run = await runCli(
    ["--format", "json", "set", "model", "sonnet", "--session-id", id],
    asAgent(f),
    f.root,
  );
  assert.equal(run.code, 0, run.stderr);
  const last = run.stdout.trim().split("\n").at(-1) ?? "";
  assert.equal((JSON.parse(last) as { validatedAgainst?: string }).validatedAgainst, "record");
  assert.equal(agentStarts(f), starts);
  assert.deepEqual(wakeLines(f), []);
});
