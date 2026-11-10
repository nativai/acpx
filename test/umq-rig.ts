import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MIB } from "../src/capacity/constants.js";

// The UMQ lane-A2 rig: a fixture box (podinfo, cgroup, /proc, leases) in which the READER sits inside
// a live owner's tree — the shape of an agent running `acpx` from its shell — plus a stub atrium and
// the mock agent behind a wrapper that records every start and, with `opsLog`, every ACP operation.
// Same fixture as test/capacity-wake.test.ts, kept in one place for the A2 test files.

export const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_HREF = pathToFileURL(
  fileURLToPath(new URL("./mock-agent.js", import.meta.url)),
).href;
const GiB = 1024 * MIB;
const NS = "pid:[4026532839]";
const CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
export const CALLER = "sess-caller";
const SEAT = "5ea7c0de-0000-4000-8000-000000000001";

type Proc = { pid: number; ppid: number; ticks: string; rssAnonKb: number };

const CALLER_TREE: Proc[] = [
  { pid: 100, ppid: 1, ticks: "5000", rssAnonKb: 100 * 1024 },
  { pid: 101, ppid: 100, ticks: "5001", rssAnonKb: 50 * 1024 },
  { pid: 102, ppid: 101, ticks: "5002", rssAnonKb: 150 * 1024 },
  { pid: 103, ppid: 102, ticks: "5003", rssAnonKb: 4 * 1024 },
];
const READER: Proc = { pid: 4242, ppid: 103, ticks: "9000", rssAnonKb: 50 * 1024 };

/** MiB. 2700 ⇒ exactly ONE agent slot; 2048 ⇒ none (a FULL box); 4000 ⇒ four. Absent ⇒ no podinfo. */
export type Box = { requestMib?: number; inOwnerTree?: boolean; withMockExtraArgs?: string[] };

export type Fixture = {
  root: string;
  env: NodeJS.ProcessEnv;
  /** One line per adapter start (`agent-starts.ndjson`). */
  marker: string;
  /** The ACP operation log of every adapter this rig starts (`session/new`, `session/prompt`, …). */
  opsLog: string;
  agent: string;
};

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

export function makeBox(box: Box = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-umq-"));
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
    `some avg10=0.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n`,
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
  const opsLog = path.join(root, "agent-ops.ndjson");
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
    // The rig never reaches the box's real atrium by accident.
    ACPX_UI_INTERNAL_URL: "",
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
  const extra = ["--supports-fork-session", "--supports-resume-session", "--advertise-models"];
  return {
    root,
    env,
    marker,
    opsLog,
    agent: [
      "node",
      JSON.stringify(wrapper),
      ...extra,
      ...(box.withMockExtraArgs ?? []),
      "--operation-log",
      JSON.stringify(opsLog),
    ].join(" "),
  };
}

/** The agent's shell: an identity, as acpx hands every harness it starts. */
export const asAgent = (f: Fixture, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...f.env,
  ACPX_SESSION_RECORD_ID: CALLER,
  ...extra,
});

/**
 * Atrium's child env: the caller identity stripped exactly as acpx-ui's `withoutCallerIdentity`
 * (`server/promptChildEnv.ts` at 03674b91) does — `ACPX_SESSION_URL`, `ACPX_SEAT_URL`,
 * `ACPX_SESSION_RECORD_ID` and every `ACPX_PARENT_*`. Kept in lockstep by hand: a drift here makes
 * the loop-safety row weaker, so it names its source.
 */
export function withoutCallerIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of Object.keys(out)) {
    if (
      name === "ACPX_SESSION_URL" ||
      name === "ACPX_SEAT_URL" ||
      name === "ACPX_SESSION_RECORD_ID" ||
      name.startsWith("ACPX_PARENT_")
    ) {
      delete out[name];
    }
  }
  return out;
}

export type Run = { code: number | null; stdout: string; stderr: string; ms: number };

export function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  stdin = "",
): Promise<Run> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { env, cwd, stdio: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end(stdin);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - startedAt });
    });
  });
}

export const sessionsDir = (f: Fixture) => path.join(f.root, ".acpx", "sessions");
export const recordPath = (f: Fixture, id: string) => path.join(sessionsDir(f), `${id}.json`);
export const admissionDir = (f: Fixture) => path.join(f.root, "admission");
export const sha256 = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function readRecord(f: Fixture, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(recordPath(f, id), "utf8")) as Record<string, unknown>;
}

/** The ACP operations the mock adapters of this rig logged, in order. */
export function operations(f: Fixture): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(f.opsLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

export const methods = (f: Fixture): string[] => operations(f).map((op) => String(op.method));

export function agentStarts(f: Fixture): number {
  try {
    return fs.readFileSync(f.marker, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

export function leaseFiles(f: Fixture): string[] {
  return fs.readdirSync(path.join(f.root, ".acpx", "queues")).filter((n) => n.endsWith(".lock"));
}

/** Every session record in the rig's store but the caller's fixture. */
export function createdRecordIds(f: Fixture): string[] {
  return fs
    .readdirSync(sessionsDir(f))
    .filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name))
    .map((name) => name.replace(/\.json$/u, ""));
}

/** A real session record (a non-agent create on a box with room, so nothing is reserved for it). */
export async function makeTarget(f: Fixture, extra: string[] = []): Promise<string> {
  const before = new Set(createdRecordIds(f));
  const run = await runCli(
    ["--agent", f.agent, "--cwd", path.join(f.root, "work"), ...extra, "sessions", "new"],
    f.env,
    f.root,
  );
  assert.equal(run.code, 0, run.stderr);
  const created = createdRecordIds(f).filter((id) => !before.has(id));
  assert.equal(created.length, 1);
  return created[0];
}

// ─── atrium ───────────────────────────────────────────────────────────────────────────────────

export const ATRIUM_FEATURES = ["message-content", "message-delivery-id", "message-task-options"];

export function writeAtriumJson(
  f: Fixture,
  body: {
    internalUrl: string;
    features?: string[];
    ageMs?: number;
    schema?: number;
  },
): string {
  const file = path.join(f.root, ".acpx", "atrium.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      schema: body.schema ?? 1,
      internalUrl: body.internalUrl,
      writer: "atrium-test",
      features: body.features ?? ATRIUM_FEATURES,
      writtenAt: new Date().toISOString(),
    }),
  );
  if (body.ageMs !== undefined) {
    const at = new Date(Date.now() - body.ageMs);
    fs.utimesSync(file, at, at);
  }
  return file;
}

export type RecordedRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
};

export type StubReply = { status: number; body?: unknown; delayMs?: number; never?: boolean };

export type StubAtrium = {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
};

/** A stub atrium: records every request, answers per `reply`. `never` holds the connection open. */
export async function startStubAtrium(
  reply: (request: RecordedRequest) => StubReply,
): Promise<StubAtrium> {
  const requests: RecordedRequest[] = [];
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown = text;
      try {
        body = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
      } catch {
        // keep the text
      }
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      };
      requests.push(recorded);
      const answer = reply(recorded);
      if (answer.never) {
        open.add(res);
        return;
      }
      setTimeout(() => {
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const res of open) {
        res.destroy();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A free loopback port nothing listens on: a connect there is refused at once. */
export async function refusedUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}
