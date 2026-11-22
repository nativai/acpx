import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TOP_LEVEL_VERBS } from "../src/cli-core.js";
import { classifyArgv, COMMAND_TABLE } from "../src/pod/command-classes.js";
import { routeFor } from "../src/pod/placement-step.js";
import { agentPodName, sessionKey } from "../src/pod/placement.js";
import {
  answerScreenLease,
  clampTtlS,
  isClaudePtyCommand,
  liveTerminal,
  presenceFilePath,
  procStartTime,
  screenDir,
} from "../src/pod/screen-lease.js";
import { loadWakeupLiveness } from "../src/session/archive/liveness.js";
import { revalidateBeforeApply } from "../src/session/archive/move.js";
import {
  applyArchiveRun,
  createContext,
  planArchiveRun,
} from "../src/session/archive/operations.js";
import { resolveBoundaries } from "../src/session/archive/retention.js";
import { isPtyScreenFile } from "../src/session/persistence/session-dir-files.js";
import {
  addRecord,
  agentPodEnv,
  agentPodHome,
  OTHER_SESSION as OTHER_POD_SESSION,
  POD_SESSION,
  runCli,
} from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";
import { startBroker } from "./pod-local-fake-broker.js";
import { makeSessionRecord, withTempDir, writeSessionRecordFile } from "./runtime-test-helpers.js";

// Block A12 (brick 66b66707) — the screen lease, acpx side (C12.1, A-30; test rows 30.1–30.6, plus the
// delete list and the archive step). Rows 30.7–30.14 are the bridge's, in claude-pty-acp.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "a12-lease-"));
const SESSION = "11111111-1111-4111-8111-111111111111";
const ACP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** A real claude-pty record's command (sampled from the live store: record 407c1e4d-5104-48eb-b497-c103b8cebb69). */
const PTY_COMMAND = "node /opt/claude-pty-acp/dist/index.js";
const CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const UID = "33333333-3333-4333-8333-333333333333";

// ───────────────────────── the pieces: clamp, name forms, harness test ─────────────────────────

test("the TTL is clamped to 5–120 s: 0 → 5, 999 → 120, 30 → 30, the bounds stay (30.5)", () => {
  assert.equal(clampTtlS(0), 5);
  assert.equal(clampTtlS(-7), 5);
  assert.equal(clampTtlS(999), 120);
  assert.equal(clampTtlS(30), 30);
  assert.equal(clampTtlS(5), 5);
  assert.equal(clampTtlS(120), 120);
});

test("isPtyScreenFile: the file and its temp name of THIS id only — never another id's, never a .json (A-13)", () => {
  const id = "abc";
  assert.equal(isPtyScreenFile(id, "abc.pty-screen"), true);
  assert.equal(isPtyScreenFile(id, "abc.pty-screen.tmp-4242"), true);
  assert.equal(isPtyScreenFile(id, "abcd.pty-screen"), false, "another id sharing a prefix");
  assert.equal(isPtyScreenFile(id, "abc.json"), false);
  assert.equal(isPtyScreenFile(id, "abc.pty-screen.json"), false);
  assert.equal(isPtyScreenFile(id, "abc.markers.ndjson"), false);
});

test("isClaudePtyCommand: the sampled real command and the script-name form match; the other harnesses and the empty command do not", () => {
  assert.equal(isClaudePtyCommand(PTY_COMMAND), true);
  assert.equal(isClaudePtyCommand("node /x/acp-server-transcript.mjs"), true);
  assert.equal(isClaudePtyCommand("node /opt/claude-pty-acp/dist/index.js --flag"), true);
  assert.equal(isClaudePtyCommand(CLAUDE_COMMAND), false);
  assert.equal(isClaudePtyCommand("node /opt/codex-acp/dist/index.js"), false);
  assert.equal(isClaudePtyCommand("claude"), false);
  assert.equal(isClaudePtyCommand(""), false);
  assert.equal(isClaudePtyCommand("node /opt/not-claude-pty-acp-at-all/index.js"), false);
});

// ───────────────────────── the presence file and the four answers ─────────────────────────

type Seam = { home: string; env: NodeJS.ProcessEnv };

function seam(): Seam {
  const home = fs.mkdtempSync(path.join(ROOT, "seam-"));
  return { home, env: { NODE_TEST_CONTEXT: "child", ACPX_POD_TEST_HOME: home } };
}

function writePresence(s: Seam, acpId: string, body: Record<string, unknown>): void {
  const dir = screenDir(s.env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `terminal.${acpId}`), JSON.stringify(body));
}

function livePresence(acpId: string, pid: number): Record<string, unknown> {
  return {
    v: 1,
    pid,
    pid_start: procStartTime(pid),
    acp_session_id: acpId,
    tmux_session: `m2-acp-${pid}-aaaaaaaa-aaaa`,
    started_at: "2026-11-22T06:00:00.000Z",
  };
}

const NOW = Date.parse("2026-11-22T06:10:00.000Z");

function lease(s: Seam, over: Partial<Parameters<typeof answerScreenLease>[0]> = {}) {
  return answerScreenLease({
    recordId: SESSION,
    acpSessionId: ACP_ID,
    agentCommand: PTY_COMMAND,
    ttlS: 30,
    place: "own-pod",
    now: NOW,
    env: s.env,
    ...over,
  });
}

function leaseFile(s: Seam): string {
  return path.join(screenDir(s.env), "lease");
}

test("30.2 leased: a live terminal → the lease holds both ids and until = now + TTL, mode 0600 in a 0700 directory, no temp name left", () => {
  const s = seam();
  writePresence(s, ACP_ID, livePresence(ACP_ID, process.pid));
  assert.deepEqual(lease(s), {
    v: 1,
    state: "leased",
    until: NOW + 30_000,
    run_started_at: "2026-11-22T06:00:00.000Z",
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(leaseFile(s), "utf8")), {
    v: 1,
    record_id: SESSION,
    acp_session_id: ACP_ID,
    until: NOW + 30_000,
  });
  assert.equal(fs.statSync(leaseFile(s)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(screenDir(s.env)).mode & 0o777, 0o700);
  assert.deepEqual(
    fs.readdirSync(screenDir(s.env)).toSorted(),
    ["lease", `terminal.${ACP_ID}`],
    "the lease was renamed into place: no temp name remains",
  );
  // A renewal replaces it.
  assert.equal(
    (lease(s, { now: NOW + 10_000 }) as { until: number }).until,
    NOW + 40_000,
    "a renewal moves `until`",
  );
  assert.equal(JSON.parse(fs.readFileSync(leaseFile(s), "utf8")).until, NOW + 40_000);
});

test("30.5 the TTL on the wire: 0 → 5 s, 999 → 120 s, 30 → 30 s (and a value inside is kept)", () => {
  const s = seam();
  writePresence(s, ACP_ID, livePresence(ACP_ID, process.pid));
  for (const [asked, kept] of [
    [0, 5],
    [999, 120],
    [30, 30],
    [64, 64],
  ] as const) {
    assert.equal((lease(s, { ttlS: asked }) as { until: number }).until, NOW + kept * 1000);
  }
});

test("30.3 a REUSED pid is never the terminal: the pid lives with another start time → no_terminal, no lease written", async () => {
  const s = seam();
  writePresence(s, ACP_ID, { ...livePresence(ACP_ID, process.pid), pid_start: "1" });
  assert.deepEqual(lease(s), { v: 1, state: "no_terminal" });
  assert.equal(fs.existsSync(leaseFile(s)), false);
  // Positive control: the same file with the true start time is alive (so the above was the start time).
  writePresence(s, ACP_ID, livePresence(ACP_ID, process.pid));
  assert.equal((lease(s) as { state: string }).state, "leased");
  // A pid that is gone.
  const gone = spawn(process.execPath, ["-e", "0"]);
  await new Promise((resolve) => gone.on("close", resolve));
  const s2 = seam();
  writePresence(s2, ACP_ID, {
    ...livePresence(ACP_ID, process.pid),
    pid: gone.pid,
    pid_start: "12345",
  });
  assert.deepEqual(lease(s2), { v: 1, state: "no_terminal" });
  assert.equal(fs.existsSync(leaseFile(s2)), false);
});

test("no_terminal for every unusable presence: absent, another session's, unparseable, wrong version, path-like id", () => {
  const s = seam();
  assert.deepEqual(lease(s), { v: 1, state: "no_terminal" }, "no presence file at all");
  writePresence(s, ACP_ID, livePresence("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", process.pid));
  assert.deepEqual(lease(s), { v: 1, state: "no_terminal" }, "the file names another session");
  fs.writeFileSync(path.join(screenDir(s.env), `terminal.${ACP_ID}`), "{not json");
  assert.deepEqual(lease(s), { v: 1, state: "no_terminal" });
  writePresence(s, ACP_ID, { ...livePresence(ACP_ID, process.pid), v: 2 });
  assert.deepEqual(lease(s), { v: 1, state: "no_terminal" });
  // A record that has never woken has an empty ACP id; a path-shaped id names no file.
  assert.deepEqual(lease(s, { acpSessionId: "" }), { v: 1, state: "no_terminal" });
  assert.equal(presenceFilePath("../lease", s.env), undefined);
  assert.equal(presenceFilePath("a/b", s.env), undefined);
  assert.equal(liveTerminal("../lease", s.env), undefined);
  assert.equal(fs.existsSync(leaseFile(s)), false, "nothing was ever written");
});

test("30.4 not_terminal: a record whose harness is not claude-pty answers it ANYWHERE and writes nothing — even with a live presence file and in the control place", () => {
  const s = seam();
  writePresence(s, ACP_ID, livePresence(ACP_ID, process.pid));
  assert.deepEqual(lease(s, { agentCommand: CLAUDE_COMMAND }), { v: 1, state: "not_terminal" });
  assert.deepEqual(lease(s, { agentCommand: CLAUDE_COMMAND, place: "control" }), {
    v: 1,
    state: "not_terminal",
  });
  assert.deepEqual(lease(s, { agentCommand: "" }), { v: 1, state: "not_terminal" });
  assert.equal(fs.existsSync(leaseFile(s)), false);
});

test("no_pod: on the control pod the record alone answers — nothing is read or written, even where a presence file would exist", () => {
  const s = seam();
  writePresence(s, ACP_ID, livePresence(ACP_ID, process.pid));
  assert.deepEqual(lease(s, { place: "control" }), { v: 1, state: "no_pod" });
  assert.equal(fs.existsSync(leaseFile(s)), false);
});

test("the class table: `__screen-lease` is owner-if-pod, named by --session-id; own pod local, another pod passes through (30.6)", () => {
  const entry = COMMAND_TABLE["__screen-lease"];
  assert.equal(entry?.class, "owner-if-pod");
  assert.deepEqual(entry?.target?.flags, ["--session-id"]);
  const argv = ["__screen-lease", "--session-id", SESSION, "--ttl-s", "30"];
  const classified = classifyArgv(argv, { builtInAgents: ["claude"] });
  assert.equal(classified.kind, "classified");
  if (classified.kind === "classified") {
    assert.equal(classified.path, "__screen-lease");
    assert.equal(classified.class, "owner-if-pod");
    assert.deepEqual(classified.target, { via: "flag", flag: "--session-id", value: SESSION });
  }
  assert.equal(routeFor("owner-if-pod", "control").kind, "branch");
  assert.equal(routeFor("owner-if-pod", "own-pod").kind, "local");
  const other = routeFor("owner-if-pod", "other-pod");
  assert.equal(other.kind === "branch" ? other.branch : undefined, "pass-through");
  assert.ok(
    TOP_LEVEL_VERBS.has("__screen-lease"),
    "the second registration (an unknown verb is an agent name)",
  );
});

// ───────────────────────── the real CLI ─────────────────────────

type Cli = { code: number | null; stdout: string; stderr: string };

function cli(args: string[], env: NodeJS.ProcessEnv): Promise<Cli> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      cwd: "/workspace",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    // A refusal must come back; a call that never returns is a failure, not a hang of the suite.
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const SCRUB = [
  "ACPX_SESSION_URL",
  "ACPX_SESSION_NAME",
  "ACPX_SEAT_URL",
  "ACPX_SESSION_RECORD_ID",
  "ACPX_PARENT_SESSION_URL",
  "ACPX_PARENT_SEAT_URL",
  "ACPX_STATE_HOME",
  "ACPX_ROUTED",
  "ACPX_ADMISSION_CLASS",
  "ACPX_OWNER_PLACEMENT",
  "ACPX_DEFAULT_OWNER",
] as const;

function baseEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NODE_TEST_CONTEXT: "child" };
  for (const name of SCRUB) {
    delete env[name];
  }
  env.ACPX_POD_TEST_HOME = home;
  return env;
}

function saFixture(): string {
  const dir = fs.mkdtempSync(path.join(ROOT, "sa-"));
  fs.writeFileSync(path.join(dir, "namespace"), "dev-devbox\n");
  fs.writeFileSync(path.join(dir, "token"), "tok-1\n");
  return dir;
}

/** A session pod's world: the place file names this session's pod, identity variables present. */
async function ownPod(
  id: string,
  fields: { agentCommand: string; acpSessionId: string },
): Promise<{ home: string; env: NodeJS.ProcessEnv; dir: string }> {
  const home = fs.mkdtempSync(path.join(ROOT, "own-"));
  const podName = agentPodName(id);
  fs.writeFileSync(path.join(home, ".nv-agent"), `${podName}\n`);
  await writeSessionRecordFile(
    home,
    makeSessionRecord({ acpxRecordId: id, cwd: "/workspace", ...fields }),
  );
  const env = baseEnv(home);
  env.NV_POD_NAME = podName;
  env.NV_POD_UID = UID;
  env.NV_NODE_NAME = "node-a";
  env.ACPX_POD_SA_DIR = saFixture();
  return { home, env, dir: path.join(home, "run", "acpx", "screen") };
}

function startTerminalStandIn(): ChildProcess {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  assert.ok(child.pid);
  return child;
}

const LEASE_ARGS = ["__screen-lease", "--session-id", SESSION, "--ttl-s", "30"];

test("30.2 on the real CLI, in the session's own pod: leased, one JSON line, exit 0 — and the lease file names both ids", async () => {
  const pod = await ownPod(SESSION, { agentCommand: PTY_COMMAND, acpSessionId: ACP_ID });
  const terminal = startTerminalStandIn();
  try {
    const presence = livePresence(ACP_ID, terminal.pid as number);
    fs.mkdirSync(pod.dir, { recursive: true });
    fs.writeFileSync(path.join(pod.dir, `terminal.${ACP_ID}`), JSON.stringify(presence));
    const before = Date.now();
    const result = await cli(LEASE_ARGS, pod.env);
    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "one JSON line");
    const answer = JSON.parse(lines[0]) as { v: number; state: string; until: number };
    assert.equal(answer.state, "leased");
    assert.ok(answer.until >= before + 29_000 && answer.until <= Date.now() + 31_000);
    const written = JSON.parse(fs.readFileSync(path.join(pod.dir, "lease"), "utf8"));
    assert.deepEqual(written, {
      v: 1,
      record_id: SESSION,
      acp_session_id: ACP_ID,
      until: answer.until,
    });
    // The clamp through the real flag parser.
    for (const [asked, kept] of [
      ["0", 5],
      ["999", 120],
    ] as const) {
      const at = Date.now();
      const r = await cli(["__screen-lease", "--session-id", SESSION, "--ttl-s", asked], pod.env);
      assert.equal(r.code, 0, r.stderr);
      const until = (JSON.parse(r.stdout) as { until: number }).until;
      assert.ok(until >= at + kept * 1000 - 100 && until <= Date.now() + kept * 1000 + 100, asked);
    }
    // No --ttl-s: the start value 30.
    const dflt = await cli(["__screen-lease", "--session-id", SESSION], pod.env);
    assert.equal(dflt.code, 0, dflt.stderr);
    // Positive/negative pair: the same pod with the terminal's start time wrong → no_terminal (30.3).
    fs.writeFileSync(
      path.join(pod.dir, `terminal.${ACP_ID}`),
      JSON.stringify({ ...presence, pid_start: "1" }),
    );
    fs.rmSync(path.join(pod.dir, "lease"));
    const reused = await cli(LEASE_ARGS, pod.env);
    assert.equal(reused.code, 0, reused.stderr);
    assert.deepEqual(JSON.parse(reused.stdout), { v: 1, state: "no_terminal" });
    assert.equal(fs.existsSync(path.join(pod.dir, "lease")), false);
  } finally {
    terminal.kill("SIGKILL");
  }
});

test("30.4 on the real CLI: a claude (not claude-pty) record answers not_terminal and writes nothing", async () => {
  const pod = await ownPod(SESSION, { agentCommand: CLAUDE_COMMAND, acpSessionId: ACP_ID });
  const result = await cli(LEASE_ARGS, pod.env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { v: 1, state: "not_terminal" });
  assert.equal(fs.existsSync(pod.dir), false, "no directory, no lease");
});

test("the verb is argv[1]: any option AHEAD of it is refused, never silently accepted (the pod's entry marks a lease call by argv[1])", async () => {
  const pod = await ownPod(SESSION, { agentCommand: PTY_COMMAND, acpSessionId: ACP_ID });
  const terminal = startTerminalStandIn();
  try {
    fs.mkdirSync(pod.dir, { recursive: true });
    fs.writeFileSync(
      path.join(pod.dir, `terminal.${ACP_ID}`),
      JSON.stringify(livePresence(ACP_ID, terminal.pid as number)),
    );
    const tail = ["--session-id", SESSION, "--ttl-s", "30"];
    const shapes: string[][] = [
      ["--format", "json", "__screen-lease", ...tail],
      ["--cwd", "/tmp", "__screen-lease", ...tail],
      ["--format=json", "__screen-lease", ...tail],
      ["--agent", "claude", "__screen-lease", ...tail],
    ];
    for (const shape of shapes) {
      const result = await cli(shape, pod.env);
      assert.notEqual(result.code, 0, `refused: ${shape.join(" ")}`);
      assert.equal(result.stdout.includes('"state"'), false, `no answer: ${shape.join(" ")}`);
      assert.match(
        `${result.stdout}${result.stderr}`,
        /__screen-lease must be the first argument/,
        shape.join(" "),
      );
      assert.equal(fs.existsSync(path.join(pod.dir, "lease")), false, "no lease was written");
    }
    // The control: the very same call with the verb first is answered.
    const ok = await cli(["__screen-lease", ...tail], pod.env);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal((JSON.parse(ok.stdout) as { state: string }).state, "leased");
  } finally {
    terminal.kill("SIGKILL");
  }
});

/** The handler's own refusals: a plain host (no pod), where the call is not routed anywhere first. */
async function plainWorld(): Promise<{ home: string; env: NodeJS.ProcessEnv }> {
  const home = fs.mkdtempSync(path.join(ROOT, "plain-"));
  await writeSessionRecordFile(
    home,
    makeSessionRecord({
      acpxRecordId: SESSION,
      acpSessionId: ACP_ID,
      agentCommand: PTY_COMMAND,
      cwd: "/workspace",
    }),
  );
  const env = baseEnv(home);
  delete env.ACPX_POD_TEST_HOME;
  env.ACPX_STATE_HOME = home;
  return { home, env };
}

test("bad input gets the normal refusals, not an answer: no --session-id, a non-numeric or fractional TTL, an unknown session, a stray operand", async () => {
  const world = await plainWorld();
  const bad: string[][] = [
    ["__screen-lease", "--ttl-s", "30"],
    ["__screen-lease", "--session-id", SESSION, "--ttl-s", "soon"],
    ["__screen-lease", "--session-id", SESSION, "--ttl-s", "1.5"],
    ["__screen-lease", "--session-id", "00000000-0000-4000-8000-00000000dead", "--ttl-s", "30"],
    ["__screen-lease", "bogus", "--session-id", SESSION],
  ];
  for (const args of bad) {
    const started = Date.now();
    const result = await cli(args, world.env);
    assert.notEqual(result.code, null, `answered, not killed: ${args.join(" ")}`);
    assert.ok(Date.now() - started < 20_000, `prompt refusal: ${args.join(" ")}`);
    assert.notEqual(result.code, 0, `refused: ${args.join(" ")}`);
    assert.equal(result.stdout.includes('"state"'), false, args.join(" "));
    assert.equal(
      result.stderr.includes("No acpx session found (searched up to"),
      false,
      `a registered verb, never an agent name: ${args.join(" ")}`,
    );
  }
  // The control: the well-formed call on the same world is answered — no_pod (outside pod mode).
  const ok = await cli(LEASE_ARGS, world.env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { v: 1, state: "no_pod" });
});

test("a bad TTL is refused inside a pod too, and writes no lease", async () => {
  const pod = await ownPod(SESSION, { agentCommand: PTY_COMMAND, acpSessionId: ACP_ID });
  const terminal = startTerminalStandIn();
  try {
    fs.mkdirSync(pod.dir, { recursive: true });
    fs.writeFileSync(
      path.join(pod.dir, `terminal.${ACP_ID}`),
      JSON.stringify(livePresence(ACP_ID, terminal.pid as number)),
    );
    const result = await cli(
      ["__screen-lease", "--session-id", SESSION, "--ttl-s", "soon"],
      pod.env,
    );
    assert.notEqual(result.code, null);
    assert.notEqual(result.code, 0);
    assert.equal(fs.existsSync(path.join(pod.dir, "lease")), false);
  } finally {
    terminal.kill("SIGKILL");
  }
});

// ───────────────────────── the control pod in pod mode: 30.1, 30.6 ─────────────────────────

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ argv }) + "\\n");
process.stdout.write('{"v":1,"state":"leased","until":1,"run_started_at":"x"}\\n');
`;

async function startApi(items: unknown[]): Promise<{ url: string; close(): void }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ kind: "PodList", items }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

async function controlPod(acpSessionId: string, items: (key: string) => unknown[]) {
  const home = fs.mkdtempSync(path.join(ROOT, "ctl-"));
  const stubDir = fs.mkdtempSync(path.join(ROOT, "stub-"));
  fs.writeFileSync(path.join(stubDir, "agent-exec"), STUB, { mode: 0o755 });
  const runtime = fs.mkdtempSync(path.join(ROOT, "runtime-"));
  for (const tool of [
    "acpx",
    "acpx-ui",
    "claude-agent-acp",
    "codex-acp",
    "claude-pty-acp",
    "pi",
    "pi-acp",
  ]) {
    fs.mkdirSync(path.join(runtime, ".releases", tool, "r"), { recursive: true });
    fs.symlinkSync(`.releases/${tool}/r`, path.join(runtime, tool));
  }
  const api = await startApi(items(sessionKey(SESSION)));
  const broker = await startBroker({ lines: [] });
  await writeSessionRecordFile(
    home,
    makeSessionRecord({
      acpxRecordId: SESSION,
      acpSessionId,
      agentCommand: PTY_COMMAND,
      cwd: "/workspace",
    }),
  );
  const env = baseEnv(home);
  Object.assign(env, {
    ACPX_OWNER_PLACEMENT: "pod",
    NV_POD_NAME: "dev-server-abc",
    NV_POD_UID: "ctl-uid-1",
    NV_NODE_NAME: "node-a",
    ACPX_POD_SA_DIR: saFixture(),
    ACPX_POD_API_URL: api.url,
    NV_AGENT_BROKER_URL: broker.origin,
    ACPX_AGENT_EXEC: path.join(stubDir, "agent-exec"),
    ACPX_TEST_RUNTIME_DIR: runtime,
  });
  const calls = (): Array<{ argv: string[] }> => {
    const file = path.join(stubDir, "calls.jsonl");
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { argv: string[] })
      : [];
  };
  return {
    env,
    calls,
    brokerSeen: () => broker.seen.length,
    close: () => {
      api.close();
      broker.close();
    },
  };
}

const READY_POD = (key: string) => [
  {
    metadata: { uid: UID, name: `ag-${key}-abcde` },
    status: {
      phase: "Running",
      podIP: "10.9.8.7",
      conditions: [{ type: "Ready", status: "True", lastTransitionTime: "2026-11-21T12:00:00Z" }],
    },
  },
];

test("30.1 control pod, pod mode, the lookup shows NO pod: no_pod from the record, no routed call, the broker receives no request — also for a record that never woke", async () => {
  for (const acpSessionId of [ACP_ID, ""]) {
    const pod = await controlPod(acpSessionId, () => []);
    try {
      const result = await cli(LEASE_ARGS, pod.env);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { v: 1, state: "no_pod" }, acpSessionId);
      assert.equal(pod.calls().length, 0, "no routed call was made");
      assert.equal(pod.brokerSeen(), 0, "the broker was never asked");
    } finally {
      pod.close();
    }
  }
});

test("30.1 positive control: the same record with a Ready pod → exactly one routed call, argv[0] acpx, the verb first; the broker is still not asked", async () => {
  const pod = await controlPod(ACP_ID, READY_POD);
  try {
    const result = await cli(LEASE_ARGS, pod.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { state: string }).state, "leased");
    const [call, ...rest] = pod.calls();
    assert.equal(rest.length, 0, "one routed call");
    assert.ok(call);
    assert.deepEqual(call.argv.slice(call.argv.indexOf("--") + 1), ["acpx", ...LEASE_ARGS]);
    assert.equal(pod.brokerSeen(), 0, "a lease call never asks the broker");
  } finally {
    pod.close();
  }
});

test("30.6 from ANOTHER agent pod: the call is passed through to atrium as the caller (never as session B); this pod answers nothing and writes no lease", async () => {
  const { home } = agentPodHome();
  await addRecord(home, OTHER_POD_SESSION, ACP_ID);
  const atrium = await startRecordedAtrium({
    resolveTargetAs: OTHER_POD_SESSION,
    calls: [{ answer: { exit: 0, stdout: '{"v":1,"state":"leased","until":1}\n', stderr: "" } }],
  });
  try {
    const argv = ["__screen-lease", "--session-id", OTHER_POD_SESSION, "--ttl-s", "30"];
    const result = await runCli(argv, agentPodEnv(home, atrium.url), { timeoutMs: 20_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      '{"v":1,"state":"leased","until":1}\n',
      "the server's answer, verbatim",
    );
    const calls = atrium.requests.filter((r) => r.route === "call");
    assert.equal(calls.length, 1, "one call reached atrium");
    assert.deepEqual(calls[0]?.body?.argv, argv, "the verb travels first, exactly as typed");
    // The caller stays the caller: it names THIS pod's session, never session B.
    const caller = calls[0]?.body?.caller as { record_id?: string } | undefined;
    assert.equal(caller?.record_id, POD_SESSION);
    assert.equal(
      fs.existsSync(path.join(home, "run", "acpx", "screen", "lease")),
      false,
      "this pod wrote no lease",
    );
  } finally {
    await atrium.close();
  }
});

// ───────────────────────── the file's life: delete list and archive ─────────────────────────

const OLD_MS = 30 * 24 * 60 * 60 * 1000;

async function writeClosedRecord(hotDir: string, id: string): Promise<void> {
  const file = path.join(hotDir, `${id}.json`);
  const closedAt = new Date(Date.now() - OLD_MS).toISOString();
  await fsp.writeFile(
    file,
    JSON.stringify({
      acpx_record_id: id,
      closed: true,
      closed_at: closedAt,
      last_used_at: closedAt,
      cwd: "/tmp",
    }),
    "utf8",
  );
  const old = new Date(Date.now() - OLD_MS);
  await fsp.utimes(file, old, old);
}

test("the archive step REMOVES the pane snapshot (and a leftover temp name) instead of archiving it; another id's snapshot stays", async () => {
  await withTempDir("acpx-a12-archive-", async (hotDir) => {
    const id = "pty-session-one";
    await writeClosedRecord(hotDir, id);
    // The snapshot is FRESH — written by a bridge a moment ago — and must not make the session "touched recently".
    await fsp.writeFile(path.join(hotDir, `${id}.pty-screen`), '{"v":1}', "utf8");
    await fsp.writeFile(path.join(hotDir, `${id}.pty-screen.tmp-4242`), "{", "utf8");
    // A snapshot of a session that is NOT archived (its record is fresh) must stay.
    const keep = "pty-session-keep";
    await fsp.writeFile(
      path.join(hotDir, `${keep}.json`),
      JSON.stringify({ acpx_record_id: keep, closed: false, cwd: "/tmp" }),
      "utf8",
    );
    await fsp.writeFile(path.join(hotDir, `${keep}.pty-screen`), '{"v":1}', "utf8");

    const context = createContext(hotDir, "a12");
    const boundaries = resolveBoundaries(context.nowMs);
    const plan = await planArchiveRun(context, boundaries, {
      includeOrphans: false,
      liveness: { primary: undefined, wakeups: await loadWakeupLiveness(hotDir) },
    });
    const result = await applyArchiveRun({
      context,
      boundaries,
      plan,
      dryRun: false,
      allowFirstRun: true,
    });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(
      result.moved.map((moved) => moved.id),
      [id],
      "the old closed session archived (the fresh snapshot did not block it)",
    );
    assert.deepEqual(result.moved[0]?.files, [`${id}.json`], "only the record moved");
    const hot = await fsp.readdir(hotDir);
    assert.equal(hot.includes(`${id}.pty-screen`), false, "the snapshot is gone from the hot dir");
    assert.equal(hot.includes(`${id}.pty-screen.tmp-4242`), false);
    assert.equal(
      hot.includes(`${keep}.pty-screen`),
      true,
      "an unarchived session's snapshot stays",
    );
    const archived = await fsp.readdir(context.archiveDir);
    assert.equal(
      archived.some((name) => name.includes("pty-screen")),
      false,
      "and it was not archived either",
    );
    assert.equal(archived.includes(`${id}.json`), true, "positive control: the record is archived");
  });
});

test("revalidateBeforeApply sets the snapshot aside: it is not in the files to move and does not count toward touched-recently", async () => {
  await withTempDir("acpx-a12-revalidate-", async (hotDir) => {
    const id = "pty-reval";
    await writeClosedRecord(hotDir, id);
    await fsp.writeFile(path.join(hotDir, `${id}.pty-screen`), "{}", "utf8");
    const result = await revalidateBeforeApply(
      hotDir,
      id,
      [`${id}.json`, `${id}.pty-screen`],
      true,
      60_000,
      Date.now(),
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.stats.map((stat) => stat.file),
        [`${id}.json`],
      );
      assert.deepEqual(result.screenFiles, [`${id}.pty-screen`]);
    }
    // Control: a fresh NON-screen sidecar of the same age still reads touched-recently.
    await fsp.writeFile(path.join(hotDir, `${id}.owner.log`), "x", "utf8");
    const touched = await revalidateBeforeApply(
      hotDir,
      id,
      [`${id}.json`, `${id}.owner.log`],
      true,
      60_000,
      Date.now(),
    );
    assert.equal(touched.ok, false);
  });
});
