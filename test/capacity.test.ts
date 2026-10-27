import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  BASIS_ANNOTATION,
  BUDGET_OVERRIDE_ANNOTATION,
  type PodInfo,
  parseAnnotations,
  resolveBudget,
} from "../src/capacity/budget.js";
import { committedFromMemoryStat, parseFlatKeyed } from "../src/capacity/cgroup.js";
import { CAPACITY_CONSTANTS, MIB } from "../src/capacity/constants.js";
import { computeFormula, verdictFor } from "../src/capacity/formula.js";
import { censusOwners, type OwnerTree, parseProcStat } from "../src/capacity/owners.js";
import { needMet, readCapacity } from "../src/capacity/reading.js";
import { TOP_LEVEL_VERBS } from "../src/cli-core.js";
import { registerDefaultCommands } from "../src/cli/command-registration.js";
import type { ResolvedAcpxConfig } from "../src/cli/config.js";

// brick afdb5784 — CONCEPTION f7587c86 §3, §4, §8.1, §10.1. Every source the capacity module reads
// (podinfo, cgroup, /proc, leases, records) is a FIXTURE TREE here, so no row depends on the box
// (or the workbench) the suite runs on — except the one row that replays a REAL owner captured on
// devbox (`test/fixtures/capacity/real-devbox-owner`, see its row).

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const REAL_OWNER_FIXTURE = fileURLToPath(
  new URL("../../test/fixtures/capacity/real-devbox-owner", import.meta.url),
);
const GiB = 1024 * MIB;
const K = CAPACITY_CONSTANTS;
// The real spelling of a deployed Claude record's agent command (sampled live, devbox 2026-10-27).
const CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const NS = "pid:[4026532839]";

type FixtureProcess = {
  pid: number;
  ppid: number;
  ticks: string;
  comm?: string;
  rssAnonKb?: number;
  pteKb?: number;
};

type FixtureLease = {
  sessionId: string;
  pid: number;
  ticks?: string;
  pidNamespace?: string;
  ageMs?: number;
  raw?: string;
};

type FixtureBox = {
  podinfo?: { request?: string; limit?: string; annotations?: Record<string, string> };
  memoryStat?: Record<string, number>;
  memoryMax?: string;
  memoryCurrent?: number;
  psiFullAvg10?: number;
  nodeAvailableKb?: number;
  processes?: FixtureProcess[];
  leases?: FixtureLease[];
  records?: Record<string, string>;
};

function statLine(p: FixtureProcess): string {
  // fields after ')': state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime
  // stime cutime cstime priority nice num_threads itrealvalue STARTTIME ...
  return `${p.pid} (${p.comm ?? "node"}) S ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${p.ticks} 1000 200 18446744073709551615\n`;
}

function statusText(p: FixtureProcess): string {
  const lines = [`Name:\t${p.comm ?? "node"}`, `Pid:\t${p.pid}`, `PPid:\t${p.ppid}`];
  if (p.rssAnonKb !== undefined) {
    lines.push(`RssAnon:\t${p.rssAnonKb} kB`, `RssFile:\t999999 kB`);
  }
  if (p.pteKb !== undefined) {
    lines.push(`VmPTE:\t${p.pteKb} kB`);
  }
  return `${lines.join("\n")}\n`;
}

/** A whole box as files: the env the CLI reads, or the sources the module reads. */
function makeBox(box: FixtureBox): { root: string; env: NodeJS.ProcessEnv } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-capacity-"));
  const podinfo = path.join(root, "podinfo");
  const cgroup = path.join(root, "cgroup");
  const proc = path.join(root, "proc");
  const queues = path.join(root, ".acpx", "queues");
  const sessions = path.join(root, ".acpx", "sessions");
  for (const dir of [cgroup, proc, queues, sessions, path.join(proc, "self", "ns")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.symlinkSync(NS, path.join(proc, "self", "ns", "pid"));
  if (box.podinfo) {
    fs.mkdirSync(podinfo);
    if (box.podinfo.request !== undefined) {
      fs.writeFileSync(path.join(podinfo, "memory_request"), box.podinfo.request);
    }
    if (box.podinfo.limit !== undefined) {
      fs.writeFileSync(path.join(podinfo, "memory_limit"), box.podinfo.limit);
    }
    const annotations = Object.entries(box.podinfo.annotations ?? {})
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n");
    fs.writeFileSync(path.join(podinfo, "annotations"), annotations);
  }
  const stat = box.memoryStat ?? { anon: 2000 * MIB, kernel: 300 * MIB, slab: 200 * MIB };
  fs.writeFileSync(
    path.join(cgroup, "memory.stat"),
    Object.entries(stat)
      .map(([key, value]) => `${key} ${value}`)
      .join("\n"),
  );
  fs.writeFileSync(path.join(cgroup, "memory.max"), box.memoryMax ?? String(12 * GiB));
  fs.writeFileSync(path.join(cgroup, "memory.current"), String(box.memoryCurrent ?? 5 * GiB));
  fs.writeFileSync(
    path.join(cgroup, "memory.pressure"),
    `some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=${(box.psiFullAvg10 ?? 0).toFixed(2)} avg60=0.00 avg300=0.00 total=1\n`,
  );
  fs.writeFileSync(path.join(cgroup, "memory.events"), "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n");
  fs.writeFileSync(
    path.join(proc, "meminfo"),
    `MemTotal: 16000000 kB\nMemAvailable: ${box.nodeAvailableKb ?? 9_000_000} kB\n`,
  );
  fs.writeFileSync(path.join(proc, "loadavg"), "1.50 1.20 1.00 2/300 12345\n");
  for (const p of box.processes ?? []) {
    fs.mkdirSync(path.join(proc, String(p.pid)));
    fs.writeFileSync(path.join(proc, String(p.pid), "stat"), statLine(p));
    fs.writeFileSync(path.join(proc, String(p.pid), "status"), statusText(p));
  }
  for (const [index, lease] of (box.leases ?? []).entries()) {
    const file = path.join(queues, `lease${index}.lock`);
    fs.writeFileSync(
      file,
      lease.raw ??
        JSON.stringify({
          pid: lease.pid,
          sessionId: lease.sessionId,
          socketPath: "/x",
          ownerGeneration: 1,
          queueDepth: 0,
          ...(lease.ticks === undefined
            ? {}
            : {
                processIdentity: {
                  kind: "linux-proc-stat-starttime",
                  startTimeTicks: lease.ticks,
                  bootId: "6f60c842-c0f4-423e-8559-0577865d44f2",
                  pidNamespace: lease.pidNamespace ?? NS,
                  timeNamespace: "time:[4026531834]",
                },
              }),
        }),
    );
    if (lease.ageMs !== undefined) {
      const at = new Date(Date.now() - lease.ageMs);
      fs.utimesSync(file, at, at);
    }
  }
  for (const [sessionId, command] of Object.entries(box.records ?? {})) {
    fs.writeFileSync(
      path.join(sessions, `${sessionId}.json`),
      JSON.stringify({ acpx_record_id: sessionId, agent_command: command, messages: [] }),
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    ACPX_STATE_HOME: root,
    ACPX_CAPACITY_PODINFO_DIR: podinfo,
    ACPX_CAPACITY_CGROUP_ROOT: cgroup,
    ACPX_CAPACITY_PROC_ROOT: proc,
  };
  for (const key of ["ACPX_SESSION_URL", "ACPX_SESSION_NAME", "ACPX_PARENT_SESSION_URL"]) {
    delete env[key];
  }
  return { root, env };
}

function sourcesOf(root: string) {
  return {
    podinfoDir: path.join(root, "podinfo"),
    cgroupRoot: path.join(root, "cgroup"),
    procRoot: path.join(root, "proc"),
    queueDir: path.join(root, ".acpx", "queues"),
    sessionsDir: path.join(root, ".acpx", "sessions"),
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env, cwd, stdio: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
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

const owner = (measuredMib: number, harness: OwnerTree["harness"] = "claude"): OwnerTree => ({
  sessionId: `s-${measuredMib}-${harness}`,
  pid: 1000 + measuredMib,
  harness,
  processes: 3,
  measuredBytes: measuredMib * MIB,
});

// ---------------------------------------------------------------------------------------------
// Budget resolution matrix (§3.2, §3.3)
// ---------------------------------------------------------------------------------------------

const L = 12 * GiB;
const podinfo = (request?: string, annotations: Record<string, string> = {}): PodInfo => ({
  present: true,
  memoryRequest: request,
  memoryLimit: String(L),
  annotations: Object.entries(annotations)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n"),
});
const resolve = (pi: PodInfo, cgroupLimitBytes: number | undefined = L) =>
  resolveBudget({ podinfo: pi, cgroupLimitBytes, constants: K });

test("budget: no /etc/podinfo ⇒ unconfigured, basis none, the limit shown as the budget", () => {
  const b = resolve({ present: false });
  assert.equal(b.configured, false);
  assert.equal(b.basis, "none");
  assert.equal(b.budgetBytes, L);
  assert.equal(b.requestBytes, undefined);
});

test("budget: a valid request is the default basis (absent annotation)", () => {
  const b = resolve(podinfo(String(8 * GiB)));
  assert.equal(b.basis, "request");
  assert.equal(b.budgetBytes, 8 * GiB);
  assert.equal(b.requestBytes, 8 * GiB);
  assert.equal(b.limitBytes, L);
  assert.deepEqual(b.warnings, []);
});

test("budget: explicit basis=request behaves as the default; basis=limit selects L", () => {
  assert.equal(
    resolve(podinfo(String(8 * GiB), { [BASIS_ANNOTATION]: "request" })).basis,
    "request",
  );
  const limit = resolve(podinfo(String(1024 * MIB), { [BASIS_ANNOTATION]: "limit" }));
  assert.equal(limit.basis, "limit");
  assert.equal(limit.budgetBytes, L);
  assert.equal(limit.requestBytes, 1024 * MIB, "the request stays visible under the limit basis");
});

for (const [label, request] of [
  ["garbage", "5Gi"],
  ["zero", "0"],
  ["below 256 MiB (a divisor/unit error)", String(100 * MIB)],
  ["above the limit", String(13 * GiB)],
  ["missing", undefined],
] as const) {
  test(`budget: request ${label} ⇒ limit-fallback with a warning, never refuse-everything`, () => {
    const b = resolve(podinfo(request));
    assert.equal(b.basis, "limit-fallback");
    assert.equal(b.budgetBytes, L);
    assert.equal(b.configured, true);
    assert.ok(
      b.warnings.some((w) => w.includes("falling back to the limit basis")),
      b.warnings.join("; "),
    );
  });
}

test("budget: a request too small to admit one session on an empty box ⇒ limit-fallback", () => {
  // devbox-staging today: 1,024 MiB request. B − M − Q − b_floor = 1024 − 512 − 450 − 512 < 450.
  const b = resolve(podinfo(String(1024 * MIB)));
  assert.equal(b.basis, "limit-fallback");
  assert.ok(
    b.warnings.some((w) => w.includes("request too small")),
    b.warnings.join("; "),
  );
  // The smallest request that admits one: 512 + 450 + 512 + 450 = 1,924 MiB.
  assert.equal(resolve(podinfo(String(1924 * MIB))).basis, "request");
  assert.equal(resolve(podinfo(String(1923 * MIB))).basis, "limit-fallback");
});

test("budget: an override in MiB wins over the basis; garbage or out-of-bounds overrides fall back", () => {
  const ok = resolve(
    podinfo(String(1024 * MIB), {
      [BUDGET_OVERRIDE_ANNOTATION]: "6000",
      [BASIS_ANNOTATION]: "limit",
    }),
  );
  assert.equal(ok.basis, "override");
  assert.equal(ok.budgetBytes, 6000 * MIB);
  for (const bad of ["lots", "0", "99999999", "-5"]) {
    const b = resolve(podinfo(String(8 * GiB), { [BUDGET_OVERRIDE_ANNOTATION]: bad }));
    assert.equal(b.basis, "limit-fallback", `override ${bad}`);
  }
  // An EMPTY override is "unset", not garbage.
  assert.equal(
    resolve(podinfo(String(8 * GiB), { [BUDGET_OVERRIDE_ANNOTATION]: "" })).basis,
    "request",
  );
});

test("budget: an unknown basis value falls back to the limit, loudly", () => {
  const b = resolve(podinfo(String(8 * GiB), { [BASIS_ANNOTATION]: "requets" }));
  assert.equal(b.basis, "limit-fallback");
  assert.ok(b.warnings.some((w) => w.includes("neither request nor limit")));
});

test("budget: the cgroup limit wins over a disagreeing podinfo limit, with a warning", () => {
  const b = resolve({ ...podinfo(String(8 * GiB)), memoryLimit: String(16 * GiB) } as PodInfo);
  assert.equal(b.limitBytes, L);
  assert.ok(b.warnings.some((w) => w.includes("the cgroup wins")));
  // No cgroup limit (memory.max = max): the podinfo file is the only limit.
  const noCgroup = resolve(podinfo(String(8 * GiB)), undefined);
  assert.equal(noCgroup.limitBytes, L);
  assert.equal(noCgroup.basis, "request");
});

test("annotations: the whole-annotations projection, other keys and escapes included", () => {
  const map = parseAnnotations(
    [
      'kubectl.kubernetes.io/restartedAt="2026-10-27T09:00:00Z"',
      `${BASIS_ANNOTATION}="limit"`,
      'note="a \\"quoted\\" value"',
      "",
    ].join("\n"),
  );
  assert.equal(map.get(BASIS_ANNOTATION), "limit");
  assert.equal(map.get("note"), 'a "quoted" value');
  assert.equal(map.get(BUDGET_OVERRIDE_ANNOTATION), undefined);
});

// ---------------------------------------------------------------------------------------------
// Committed memory (§3.1, F7)
// ---------------------------------------------------------------------------------------------

test("committed = anon + kernel — kernel ⊇ slab, so slab is NEVER added", () => {
  const stat = parseFlatKeyed(
    "anon 4047798272\nfile 3795247104\nkernel 1014476800\nslab 931536952\nslab_reclaimable 923488904\nshmem 0\nsock 0\n",
  );
  const c = committedFromMemoryStat(stat);
  // The real devbox reading of 2026-10-27 09:22Z. anon + slab + kernel would read 5.99 GB.
  assert.equal(c?.committedBytes, 4047798272 + 1014476800);
  assert.notEqual(c?.committedBytes, 4047798272 + 1014476800 + 931536952);
  assert.deepEqual(c?.warnings, []);
});

test("committed: a kernel without the `kernel` line sums its components, slab once", () => {
  const c = committedFromMemoryStat(
    new Map([
      ["anon", 100],
      ["kernel_stack", 1],
      ["pagetables", 2],
      ["percpu", 3],
      ["vmalloc", 4],
      ["slab", 10],
      ["slab_reclaimable", 9],
    ]),
  );
  assert.equal(c?.committedBytes, 120);
  assert.equal(c?.warnings.length, 1);
  assert.equal(
    committedFromMemoryStat(new Map([["kernel", 5]])),
    undefined,
    "no anon ⇒ unmeasured",
  );
});

// ---------------------------------------------------------------------------------------------
// Owner attribution (§3.1, §5, §16)
// ---------------------------------------------------------------------------------------------

test("proc stat: comm with spaces and ')' is parsed after the LAST ')'", () => {
  const entry = parseProcStat(statLine({ pid: 42, ppid: 7, ticks: "123456", comm: "a) b (c" }));
  assert.deepEqual(entry, { pid: 42, ppid: 7, startTicks: "123456" });
});

function attributionBox() {
  return makeBox({
    processes: [
      { pid: 1, ppid: 0, ticks: "1", comm: "dumb-init", rssAnonKb: 100 },
      // owner A: owner → adapter → claude → bash grandchild
      { pid: 100, ppid: 1, ticks: "5000", rssAnonKb: 100_000, pteKb: 1000 },
      { pid: 101, ppid: 100, ticks: "5001", rssAnonKb: 50_000, pteKb: 500 },
      { pid: 102, ppid: 101, ticks: "5002", comm: "claude", rssAnonKb: 150_000, pteKb: 2000 },
      { pid: 103, ppid: 102, ticks: "5003", comm: "bash", rssAnonKb: 4000 },
      // owner B (codex)
      { pid: 200, ppid: 1, ticks: "6000", rssAnonKb: 80_000 },
      { pid: 201, ppid: 200, ticks: "6001", comm: "codex", rssAnonKb: 120_000 },
      // not an owner: atrium. Belongs to the base, never to an owner.
      { pid: 300, ppid: 1, ticks: "7000", comm: "node", rssAnonKb: 800_000 },
      // pid 400 was reused: the lease's start time is 8000, this process started at 9999.
      { pid: 400, ppid: 1, ticks: "9999", rssAnonKb: 300_000 },
      { pid: 600, ppid: 1, ticks: "3000", rssAnonKb: 300_000 },
    ],
    leases: [
      { sessionId: "sess-a", pid: 100, ticks: "5000" },
      { sessionId: "sess-b", pid: 200, ticks: "6000" },
      { sessionId: "sess-dead", pid: 500, ticks: "1" },
      { sessionId: "sess-reused", pid: 400, ticks: "8000" },
      { sessionId: "sess-legacy", pid: 300 },
      { sessionId: "sess-foreign", pid: 300, ticks: "7000", pidNamespace: "pid:[999]" },
      // A VALID live lease that is 10 min old: the mtime prefilter must not even parse it.
      { sessionId: "sess-stale", pid: 600, ticks: "3000", ageMs: 10 * 60_000 },
      { sessionId: "x", pid: 0, raw: "{not json" },
    ],
    records: { "sess-a": CLAUDE_COMMAND, "sess-b": "npx -y @zed-industries/codex-acp@^0.3.0" },
  });
}

test("owners: lease → verified pid → whole tree by ppid; RssAnon + VmPTE; exclusions counted", () => {
  const { root } = attributionBox();
  const census = censusOwners({
    ...sourcesOf(root),
    nowMs: Date.now(),
    freshMs: K.leaseFreshMs,
  });
  const byId = new Map(census.owners.map((o) => [o.sessionId, o]));
  assert.deepEqual([...byId.keys()].toSorted(), ["sess-a", "sess-b"]);
  assert.equal(byId.get("sess-a")?.processes, 4);
  assert.equal(
    byId.get("sess-a")?.measuredBytes,
    (100_000 + 1000 + 50_000 + 500 + 150_000 + 2000 + 4000) * 1024,
  );
  assert.equal(byId.get("sess-a")?.harness, "claude");
  assert.equal(byId.get("sess-b")?.measuredBytes, 200_000 * 1024);
  assert.equal(byId.get("sess-b")?.harness, "codex");
  assert.equal(census.leaseFiles, 8);
  assert.equal(census.freshLeases, 7, "the 10-min-old lease is filtered by mtime before parsing");
  assert.deepEqual(census.excluded, {
    unparsable: 1,
    dead: 1,
    "identity-mismatch": 1,
    "identity-unverified": 1,
    foreign: 1,
  });
});

test("owners: /proc is read through stat and status ONLY — never cmdline, never environ", (t) => {
  const { root } = attributionBox();
  // Plant the two files an owner's credentials live in; a census that opened them would record it.
  for (const pid of ["100", "102", "200"]) {
    fs.writeFileSync(path.join(root, "proc", pid, "cmdline"), "node\0--token\0SECRET\0");
    fs.writeFileSync(path.join(root, "proc", pid, "environ"), "ANTHROPIC_API_KEY=SECRET\0");
  }
  const reads: string[] = [];
  const original = fs.readFileSync.bind(fs);
  t.mock.method(fs, "readFileSync", (file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    reads.push(String(file));
    return (original as (...args: unknown[]) => unknown)(file, ...rest);
  });
  const census = censusOwners({ ...sourcesOf(root), nowMs: Date.now(), freshMs: K.leaseFreshMs });
  t.mock.restoreAll();
  assert.equal(census.owners.length, 2);
  const procReads = reads.filter((file) => file.includes(`${path.sep}proc${path.sep}`));
  assert.ok(
    procReads.some((file) => file.endsWith(`${path.sep}status`)),
    "positive control: status read",
  );
  assert.ok(
    procReads.some((file) => file.endsWith(`${path.sep}stat`)),
    "positive control: stat read",
  );
  const forbidden = procReads.filter((file) => /(?:cmdline|environ)$/u.test(file));
  assert.deepEqual(forbidden, []);
  const unexpected = procReads.filter((file) => !/\/(?:stat|status|meminfo|loadavg)$/u.test(file));
  assert.deepEqual(unexpected, [], "only stat and status per pid");
});

test("owners: REAL devbox owner — a live lease and its process tree, captured 2026-10-27", () => {
  // Captured on the devbox control pod by
  // /wisdom/Bricks/afdb5784-…/agents/92baa176/holders/e8bb2785/capture-real-owner.sh from the
  // live lease of session e8bb2785-926a-453f-9ce4-0affb297d349 (pid 838638): the lease file
  // verbatim, every tree member's /proc stat + status verbatim, the record's real agent_command,
  // and expected.json computed INDEPENDENTLY (bash + awk). acpx's own fixtures use synthetic
  // shapes; this row is the one that a real lease body / identity spelling / status layout drives.
  const expected = JSON.parse(
    fs.readFileSync(path.join(REAL_OWNER_FIXTURE, "expected.json"), "utf8"),
  ) as { sessionId: string; pid: number; processes: number; measuredBytes: number };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-capacity-real-"));
  fs.cpSync(REAL_OWNER_FIXTURE, root, { recursive: true, verbatimSymlinks: true });
  const census = censusOwners({
    queueDir: path.join(root, "queues"),
    sessionsDir: path.join(root, "sessions"),
    procRoot: path.join(root, "proc"),
    nowMs: Date.now(), // the copy's mtime is now: fresh
    freshMs: K.leaseFreshMs,
  });
  assert.equal(census.owners.length, 1, JSON.stringify(census.excluded));
  const [real] = census.owners;
  assert.equal(real.sessionId, expected.sessionId);
  assert.equal(real.pid, expected.pid);
  assert.equal(real.harness, "claude");
  assert.equal(real.processes, expected.processes);
  assert.equal(real.measuredBytes, expected.measuredBytes);
});

// ---------------------------------------------------------------------------------------------
// The charge and the free-slot arithmetic (§4.1, §4.2)
// ---------------------------------------------------------------------------------------------

const formula = (over: Partial<Parameters<typeof computeFormula>[0]> = {}) =>
  computeFormula({
    budgetBytes: 4096 * MIB,
    requestBytes: 4096 * MIB,
    limitBytes: L,
    committedBytes: 2000 * MIB,
    owners: [owner(200), owner(250), owner(500)],
    pendingBytes: 0,
    nodeAvailableBytes: 9000 * MIB,
    psiFullAvg10: 0,
    constants: K,
    ...over,
  });

test("formula: owners charged max(300, measured); base = max(512, C − Σm); K = b + Σ charge", () => {
  const f = formula();
  assert.equal(f.ownerChargeBytes, (300 + 300 + 500) * MIB);
  assert.equal(f.baseBytes, (2000 - 950) * MIB);
  assert.equal(f.chargedBytes, (1050 + 1100) * MIB);
  assert.equal(f.marginBytes, 512 * MIB, "max(512 MiB, 10 % of 4 GiB = 409.6)");
  // G1: ⌊(4096 − 512 − 450 − 2150) / 450⌋ = ⌊984 / 450⌋ = 2; interactive drops Q: ⌊1434/450⌋ = 3.
  assert.deepEqual(f.freeSlots, { claude: 2, codex: 2, pi: 2 });
  assert.deepEqual(f.freeSlotsInteractive, { claude: 3, codex: 4, pi: 3 });
  assert.equal(f.bindingGuard.claude, "G1");
  assert.equal(f.freeBytes, 984 * MIB);
});

test("formula: the base floor holds when owners account for nearly everything", () => {
  const f = formula({ committedBytes: 600 * MIB, owners: [owner(500)] });
  assert.equal(f.baseBytes, 512 * MIB);
});

test("formula: an unknown harness is charged the LARGEST floor; codex its own", () => {
  assert.equal(formula({ owners: [owner(100, "unknown")] }).ownerChargeBytes, 300 * MIB);
  assert.equal(formula({ owners: [owner(100, "codex")] }).ownerChargeBytes, 290 * MIB);
});

test("formula: G3 binds while borrowing above the request, counting unconsumed reservations", () => {
  // limit basis: B = L = 12 GiB, R = 4 GiB ⇒ borrowing. K − C = 150 MiB of unconsumed floor charge.
  const f = formula({ budgetBytes: L, nodeAvailableBytes: 4000 * MIB });
  // G1 would give ⌊(12288 − 1228.8 − 450 − 2150)/450⌋ = 18; G3 ⌊(4000 − 150 − 3072)/450⌋ = 1.
  assert.equal(f.freeSlots.claude, 1);
  assert.equal(f.bindingGuard.claude, "G3");
  // Not borrowing (B = R): G3 does not apply at all, however low the node is.
  assert.equal(formula({ nodeAvailableBytes: 0 }).freeSlots.claude, 2);
});

test("formula: G2 — the cgroup-OOM guard binds when C is close to the limit", () => {
  // B = L = 12 GiB, R undefined (unconfigured ⇒ treated as borrowing; node plentiful).
  const f = formula({
    budgetBytes: L,
    requestBytes: undefined,
    committedBytes: 11_000 * MIB,
    owners: [],
    nodeAvailableBytes: 100 * GiB,
  });
  // G1: (12288 − 1228.8 − 450 − 11000)/450 < 0 ⇒ 0. G2: (12288 − 614.4 − 11000)/450 = 1.49 ⇒ 1.
  assert.equal(f.freeSlots.claude, 0);
  assert.equal(f.freeSlotsInteractive.claude, 0);
  assert.equal(f.oomMarginBytes, Math.floor(0.05 * L));
  const loose = formula({
    budgetBytes: 40 * GiB,
    requestBytes: 40 * GiB,
    committedBytes: 11_000 * MIB,
    owners: [],
  });
  assert.equal(
    loose.bindingGuard.claude,
    "G2",
    "a budget above the limit is still held at the OOM line",
  );
  assert.equal(loose.freeSlots.claude, 1);
});

test("formula: G4 — a stalled box (PSI full avg10 ≥ 10) has 0 slots for everyone", () => {
  const f = formula({ psiFullAvg10: 12.5 });
  assert.deepEqual(f.freeSlots, { claude: 0, codex: 0, pi: 0 });
  assert.deepEqual(f.freeSlotsInteractive, { claude: 0, codex: 0, pi: 0 });
  assert.equal(f.bindingGuard.claude, "G4");
  assert.equal(formula({ psiFullAvg10: 9.99 }).freeSlots.claude, 2);
});

test("formula: §4.5's worked example — devbox at 15:32Z on a 5,024 MiB request is over budget", () => {
  // Σm 5,255 / Σ charge 5,365 (two trees under 300); C = 7,004 ⇒ b = 1,749, K = 7,114.
  const trees = [229, 261, 340, 350, 360, 380, 390, 400, 410, 420, 430, 440, 418, 427].map((m) =>
    owner(m),
  );
  assert.equal(
    trees.reduce((s, o) => s + o.measuredBytes, 0),
    5255 * MIB,
  );
  const f = formula({
    budgetBytes: 5024 * MIB,
    requestBytes: 5024 * MIB,
    committedBytes: 7004 * MIB,
    owners: trees,
  });
  assert.equal(f.ownerChargeBytes, 5365 * MIB);
  assert.equal(f.chargedBytes, 7114 * MIB);
  assert.equal(f.freeSlots.claude, 0);
  assert.equal(verdictFor(f.freeSlots.claude, f.freeSlotsInteractive.claude), "full");
});

test("verdict: room ≥ 2, tight at 1 or when only the human reserve is left, full at 0", () => {
  assert.equal(verdictFor(2, 3), "room");
  assert.equal(verdictFor(1, 2), "tight");
  assert.equal(verdictFor(0, 1), "tight");
  assert.equal(verdictFor(0, 0), "full");
});

// ---------------------------------------------------------------------------------------------
// The whole reading, and the two guarantees as committed negative cases (§3.3, §8.1)
// ---------------------------------------------------------------------------------------------

/** 2 GiB request, C = 3 GiB: committed alone is past the budget. */
const OVER_BUDGET: FixtureBox = {
  podinfo: { request: String(2 * GiB), limit: String(L) },
  memoryStat: { anon: 2800 * MIB, kernel: 272 * MIB, slab: 250 * MIB },
};

test("NEGATIVE: an over-budget configured box reads `full` and does not meet --need 1", () => {
  const { root } = makeBox(OVER_BUDGET);
  const s = readCapacity({ agent: "claude", sources: sourcesOf(root), box: "fixture" });
  assert.equal(s.basis, "request");
  assert.equal(s.verdict, "full");
  assert.deepEqual(s.freeSlots, { claude: 0, codex: 0, pi: 0 });
  assert.equal(needMet(s, 1), false);
});

test("NEGATIVE: the SAME over-budget memory without podinfo is `unconfigured`, never `full`", () => {
  const { root } = makeBox({ ...OVER_BUDGET, podinfo: undefined, memoryMax: String(3 * GiB) });
  const s = readCapacity({ agent: "claude", sources: sourcesOf(root), box: "fixture" });
  assert.equal(s.verdict, "unconfigured");
  assert.equal(s.basis, "none");
  assert.equal(s.freeSlots?.claude, 0, "the figures still say it is full…");
  assert.equal(needMet(s, 1), true, "…and it still fails open");
  assert.equal(needMet(s, 1000), true);
});

test("an unreadable cgroup on a configured box is `unmeasured` and fails open", () => {
  const { root } = makeBox({ podinfo: { request: String(8 * GiB) } });
  fs.rmSync(path.join(root, "cgroup", "memory.stat"));
  const s = readCapacity({ agent: "claude", sources: sourcesOf(root), box: "fixture" });
  assert.equal(s.verdict, "unmeasured");
  assert.equal(s.committedBytes, null);
  assert.equal(s.freeSlots, null);
  assert.equal(needMet(s, 5), true);
});

test("reading: both bases visible — the alternative is computed on the same measurement", () => {
  const { root } = makeBox({
    podinfo: {
      request: String(8 * GiB),
      limit: String(L),
      annotations: { [BASIS_ANNOTATION]: "limit" },
    },
  });
  const s = readCapacity({ agent: "claude", sources: sourcesOf(root), box: "fixture" });
  assert.equal(s.basis, "limit");
  assert.deepEqual(
    s.alternatives.map((a) => [a.basis, a.budgetBytes]),
    [["request", 8 * GiB]],
  );
  // Phase 1: nothing pending, no make-room ⇒ after-make-room equals free.
  assert.equal(s.pendingBytes, 0);
  assert.deepEqual(s.slotsAfterMakeRoom, s.freeSlots);
});

// ---------------------------------------------------------------------------------------------
// The CLI: shapes, exit codes, registrations (§8.1, PROJECT.md hazard)
// ---------------------------------------------------------------------------------------------

test("CLI: --need N met ⇒ 0; not met ⇒ 75; JSON carries the §8.1 fields", async () => {
  const { root, env } = makeBox({
    podinfo: { request: String(4096 * MIB), limit: String(L) },
    memoryStat: { anon: 1500 * MIB, kernel: 100 * MIB, slab: 80 * MIB },
  });
  // B 4096, M 512, Q 450, C 1600, no owners ⇒ b 1600, K 1600: ⌊(4096 − 512 − 450 − 1600)/450⌋ = 3.
  const ok = await runCli(["--format", "json", "capacity", "--need", "3"], env, root);
  assert.equal(ok.code, 0, ok.stderr);
  const json = JSON.parse(ok.stdout) as Record<string, unknown>;
  for (const key of [
    "action",
    "schema",
    "box",
    "measuredAt",
    "basis",
    "verdict",
    "budgetBytes",
    "requestBytes",
    "limitBytes",
    "marginBytes",
    "interactiveReserveBytes",
    "committedBytes",
    "workingSetBytes",
    "baseBytes",
    "chargedBytes",
    "pendingBytes",
    "freeBytes",
    "reserveNewBytes",
    "liveFloorBytes",
    "freeSlots",
    "freeSlotsInteractive",
    "slotsAfterMakeRoom",
    "owners",
    "pressure",
    "warnings",
    "need",
    "needMet",
  ]) {
    assert.ok(key in json, `missing ${key}`);
  }
  assert.equal(json.action, "capacity");
  assert.equal(json.verdict, "room");
  assert.deepEqual(json.freeSlots, { claude: 3, codex: 4, pi: 3 });
  assert.equal(json.needMet, true);

  const notMet = await runCli(["capacity", "--need", "4", "--format", "json"], env, root);
  assert.equal(notMet.code, 75, notMet.stderr);
  assert.equal((JSON.parse(notMet.stdout) as { needMet: boolean }).needMet, false);

  const codex = await runCli(["capacity", "--agent", "codex", "--need", "4"], env, root);
  assert.equal(codex.code, 0, "codex reserves 340 MiB: ⌊1534/340⌋ = 4");
});

test("CLI NEGATIVE: over budget ⇒ `--need 1` exits 75; the same box without podinfo exits 0", async () => {
  const full = makeBox(OVER_BUDGET);
  const refused = await runCli(["capacity", "--need", "1"], full.env, full.root);
  assert.equal(refused.code, 75, refused.stderr);
  assert.match(refused.stdout, /full: 0 new claude sessions/u);
  assert.match(refused.stdout, /NOT MET \(exit 75\)/u);

  const open = makeBox({ ...OVER_BUDGET, podinfo: undefined, memoryMax: String(3 * GiB) });
  const admitted = await runCli(["capacity", "--need", "1"], open.env, open.root);
  assert.equal(admitted.code, 0, admitted.stderr);
  assert.match(admitted.stdout, /UNCONFIGURED/u);
  assert.doesNotMatch(admitted.stdout, /^full/mu);
});

test("CLI: plain reading exits 0 and prints the human summary", async () => {
  const { root, env } = makeBox({ podinfo: { request: String(8 * GiB), limit: String(L) } });
  const r = await runCli(["capacity"], env, root);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /budget 8\.00 GiB \(request\) · request 8\.00 GiB · limit 12\.00 GiB/u);
  assert.match(r.stdout, /committed 2\.25 GiB \(anon \+ kernel\)/u);
  assert.match(r.stdout, /on the limit basis: budget 12\.00 GiB/u);
});

for (const args of [
  ["capacity", "--need", "0"],
  ["capacity", "--need", "two"],
  ["capacity", "--agent", "gemini"],
  ["capacity", "bogus"],
]) {
  test(`CLI usage error ⇒ exit 2, never a prompt: acpx ${args.join(" ")}`, async () => {
    const { root, env } = makeBox({});
    const r = await runCli(args, env, root);
    assert.equal(r.code, 2, `${r.stdout}\n${r.stderr}`);
    // The ABSENT control (TOP_LEVEL_VERBS comment): an agent-path fall-through would say this.
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /No acpx session found/u);
  });
}

test("registration: `capacity` is in BOTH registerDefaultCommands and TOP_LEVEL_VERBS", () => {
  const program = new Command();
  registerDefaultCommands(program, {
    defaultAgent: "codex",
    format: "text",
    agents: {},
  } as unknown as ResolvedAcpxConfig);
  assert.ok(program.commands.some((command) => command.name() === "capacity"));
  assert.ok(TOP_LEVEL_VERBS.has("capacity"));
});
