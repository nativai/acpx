import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isClaudePtyCommand } from "../src/pod/harness-support.js";
import { newestRecordAdvertisement } from "../src/pod/probe-records.js";
import type { SessionRecord } from "../src/types.js";
import { startBroker } from "./pod-local-fake-broker.js";
import { sessionFilePath } from "./runtime-test-helpers.js";

// A-39 (brick b69eeecf), the REAL-SHAPED rows: the terminal harness `claude-pty` is not in phase 1, so in
// pod mode a claude-pty record must be refused BY NAME (`ROUTED outcome=not_run reason=harness_unsupported`)
// before the broker is asked, on every pod path that could carry it — the routed prompt (owner-ensure), the
// utility pod's one-shot, and the record-served probes (`output-styles`, `model-catalogue`), which must also
// never SERVE the claude-pty record as an answer.
//
// ⚠️ THE RECORD IS REAL-SHAPED ON PURPOSE. `acpAdapterKind` has no claude-pty kind (brick 19461b95), so a real
// record's harness reads as UNDEFINED there: a test that injects a classifier answer of "claude-pty" proves a
// path no real record takes. The fixture is `test/fixtures/pod-claude-pty-record.json`, sampled READ-ONLY from
// devbox's closed record 407c1e4d-5104-48eb-b497-c103b8cebb69 (last used 2026-06-18; its `agent_command` is the
// deployed `node /opt/claude-pty-acp/dist/index.js`) with every id, the cwd and the profile replaced.

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("../../test/fixtures/pod-claude-pty-record.json", import.meta.url),
);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "a39-pty-"));
const PTY_ID = "00000000-0000-4000-8000-0000000c1a7e";
const PTY_COMMAND = "node /opt/claude-pty-acp/dist/index.js";
const CLAUDE_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
const UID = "33333333-3333-4333-8333-333333333333";
const REFUSAL = /^acpx: ROUTED outcome=not_run reason=harness_unsupported call_id=\S+$/;

function fixtureRecord(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
}

test("the fixture is the sampled real shape: the deployed command, an ACP id, advertised models and config options, closed", () => {
  const record = fixtureRecord();
  assert.equal(record.agent_command, PTY_COMMAND);
  assert.equal(record.agent_name, "claude-pty");
  assert.equal(typeof record.acp_session_id, "string");
  assert.ok(String(record.acp_session_id).length > 0, "it has run: an ACP session id");
  const acpx = record.acpx as { available_models?: string[]; config_options?: unknown[] };
  assert.ok(
    (acpx.available_models?.length ?? 0) > 0,
    "it advertises models — it COULD answer a probe",
  );
  assert.ok((acpx.config_options?.length ?? 0) > 0, "and config options");
  assert.equal(
    JSON.stringify(record).includes("407c1e4d"),
    false,
    "the sampled id is not in the fixture",
  );
});

test("isClaudePtyCommand: the real command and the script-name form; never the other harnesses", () => {
  assert.equal(isClaudePtyCommand(PTY_COMMAND), true);
  assert.equal(isClaudePtyCommand("node /x/acp-server-transcript.mjs"), true);
  assert.equal(isClaudePtyCommand(CLAUDE_COMMAND), false);
  assert.equal(isClaudePtyCommand("node /opt/codex-acp/dist/index.js"), false);
  assert.equal(isClaudePtyCommand("node /opt/pi-acp/dist/index.js"), false);
  assert.equal(isClaudePtyCommand("node /opt/not-claude-pty-acp-really/index.js"), false);
  assert.equal(isClaudePtyCommand(undefined), false);
  assert.equal(isClaudePtyCommand(""), false);
});

// ───────────────────────── probes never serve a claude-pty record ─────────────────────────

function storeOf(command: string) {
  const record = fixtureRecord();
  const entries = async () => [
    {
      file: `${PTY_ID}.json`,
      acpxRecordId: PTY_ID,
      acpSessionId: String(record.acp_session_id),
      agentCommand: command,
      cwd: "/workspace",
      closed: true,
      lastUsedAt: String(record.last_used_at),
    },
  ];
  const load = async (): Promise<SessionRecord> =>
    ({ ...record, acpx: record.acpx }) as unknown as SessionRecord;
  return { entries: entries as never, load };
}

test("record-served probes: the real claude-pty record answers NOTHING — not for a claude-pty query, not for a claude query (the control: the same record under a claude command DOES answer)", async () => {
  const own = await newestRecordAdvertisement(
    { agentCommand: PTY_COMMAND, need: "config_options" },
    storeOf(PTY_COMMAND),
  );
  assert.equal(own, undefined, "a claude-pty query is never answered from its record");
  assert.equal(
    await newestRecordAdvertisement(
      { agentCommand: PTY_COMMAND, need: "available_models" },
      storeOf(PTY_COMMAND),
    ),
    undefined,
  );
  for (const need of ["config_options", "available_models"] as const) {
    assert.equal(
      await newestRecordAdvertisement({ agentCommand: CLAUDE_COMMAND, need }, storeOf(PTY_COMMAND)),
      undefined,
      `a claude query is not served the claude-pty record (${need})`,
    );
  }
  // Control: the identical record filed under the claude command answers — so `undefined` above was the harness.
  const served = await newestRecordAdvertisement(
    { agentCommand: CLAUDE_COMMAND, need: "config_options" },
    storeOf(CLAUDE_COMMAND),
  );
  assert.equal(served?.recordId, PTY_ID);
});

// ───────────────────────── the real CLI in pod mode ─────────────────────────

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.stdout.write("stub-answer\\n");
`;

async function startApi(): Promise<{ url: string; close(): void }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ kind: "PodList", items: [] }));
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

function saFixture(): string {
  const dir = fs.mkdtempSync(path.join(ROOT, "sa-"));
  fs.writeFileSync(path.join(dir, "namespace"), "dev-devbox\n");
  fs.writeFileSync(path.join(dir, "token"), "tok-1\n");
  return dir;
}

const READY = `ready ip=10.1.2.3 pod=ag-x-abcde uid=${UID} node=n1 placement=pool`;

/** The control pod in pod mode, no pod anywhere, the fixture record in its store. */
async function rig(recordCommand: string) {
  const home = fs.mkdtempSync(path.join(ROOT, "home-"));
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
  // The sampled record's messages-log sidecar is NOT carried into the fixture, so its pointer is dropped here —
  // else the loader prints a "messages log missing" warning ahead of the refusal line (a fixture artifact).
  const record = { ...fixtureRecord(), agent_command: recordCommand };
  delete (record as { messages_log?: unknown }).messages_log;
  const file = sessionFilePath(home, PTY_ID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const api = await startApi();
  const broker = await startBroker({ lines: ["scheduling", READY] });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    NODE_TEST_CONTEXT: "child",
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: home,
    NV_POD_NAME: "dev-server-abc",
    NV_POD_UID: "ctl-uid-1",
    NV_NODE_NAME: "node-a",
    ACPX_POD_SA_DIR: saFixture(),
    ACPX_POD_API_URL: api.url,
    NV_AGENT_BROKER_URL: broker.origin,
    ACPX_AGENT_EXEC: path.join(stubDir, "agent-exec"),
    ACPX_TEST_RUNTIME_DIR: runtime,
  };
  for (const name of [
    "ACPX_SESSION_URL",
    "ACPX_SESSION_NAME",
    "ACPX_SEAT_URL",
    "ACPX_SESSION_RECORD_ID",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_PARENT_SEAT_URL",
    "ACPX_STATE_HOME",
    "ACPX_ROUTED",
    "ACPX_ADMISSION_CLASS",
    "ACPX_DEFAULT_OWNER",
  ]) {
    delete env[name];
  }
  return {
    env,
    calls: (): number => {
      const callsFile = path.join(stubDir, "calls.jsonl");
      return fs.existsSync(callsFile)
        ? fs.readFileSync(callsFile, "utf8").trim().split("\n").length
        : 0;
    },
    brokerRequests: () => broker.seen.length,
    brokerPosts: () => broker.seen.filter((request) => request.method === "POST").length,
    close: () => {
      api.close();
      broker.close();
    },
  };
}

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
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const PTY_AGENT = ["--agent", PTY_COMMAND];
const CLAUDE_AGENT = ["--agent", CLAUDE_COMMAND];

async function refused(args: string[], label: string) {
  const pod = await rig(PTY_COMMAND);
  try {
    const result = await cli(args, pod.env);
    assert.equal(result.code, 1, `${label}: ${result.stderr}`);
    assert.match(result.stderr.split("\n")[0] ?? "", REFUSAL, label);
    assert.equal(pod.brokerRequests(), 0, `${label}: the broker saw nothing`);
    assert.equal(pod.brokerPosts(), 0, `${label}: not even a POST`);
    assert.equal(pod.calls(), 0, `${label}: nothing reached a pod`);
    assert.equal(result.stdout.includes("stub-answer"), false, label);
    // Never served as an answer: no value of the record's advertisement is on stdout.
    const acpx = fixtureRecord().acpx as {
      config_options?: Array<{ options?: Array<{ value: string }> }>;
    };
    for (const option of acpx.config_options?.[0]?.options ?? []) {
      assert.equal(
        result.stdout.includes(`"${option.value}"`),
        false,
        `${label}: ${option.value} was not served`,
      );
    }
  } finally {
    pod.close();
  }
}

test("A-39 routed prompt: the real claude-pty record's prompt is refused by name, zero broker requests", async () => {
  await refused(["--format", "json", "prompt", "--session-id", PTY_ID, "hello"], "prompt (json)");
  await refused(["prompt", "--session-id", PTY_ID, "hello"], "prompt (text)");
});

test("A-39 utility path: a one-shot on the claude-pty harness (exec, sessions list, flow-free probes) is refused by name before a utility pod is asked", async () => {
  await refused([...PTY_AGENT, "exec", "hello"], "exec");
  await refused([...PTY_AGENT, "sessions", "list"], "sessions list (asks the agent)");
});

test("A-39 record-served probes: output-styles and model-catalogue on the claude-pty harness are refused by name — with the real record, which advertises both, in the store — and serve nothing", async () => {
  await refused([...PTY_AGENT, "output-styles"], "output-styles");
  await refused([...PTY_AGENT, "model-catalogue"], "model-catalogue");
  await refused([...PTY_AGENT, "--format", "json", "output-styles"], "output-styles (json)");
});

test("A-39 controls in the same rig and store: a claude one-shot still goes to the utility pod (the broker IS asked) and is never answered from the claude-pty record", async () => {
  for (const args of [
    [...CLAUDE_AGENT, "exec", "hello"],
    [...CLAUDE_AGENT, "output-styles"],
    [...CLAUDE_AGENT, "model-catalogue"],
  ]) {
    const pod = await rig(PTY_COMMAND);
    try {
      const result = await cli(args, pod.env);
      assert.equal(
        result.stderr.includes("harness_unsupported"),
        false,
        `${args.join(" ")}: ${result.stderr}`,
      );
      assert.ok(
        pod.brokerRequests() > 0,
        `${args.join(" ")}: the broker was asked (nothing answered from the claude-pty record)`,
      );
    } finally {
      pod.close();
    }
  }
});

test("A-39 the other harnesses' prompts still route in this rig (the rig is live, so the refusals above are the harness)", async () => {
  const pod = await rig(CLAUDE_COMMAND);
  try {
    const result = await cli(["prompt", "--session-id", PTY_ID, "hello"], pod.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(pod.brokerRequests(), 1);
    assert.equal(pod.calls(), 1);
  } finally {
    pod.close();
  }
});

test("A-39 off pod mode: the claude-pty record's commands are unchanged — no harness refusal, no broker", async () => {
  const pod = await rig(PTY_COMMAND);
  try {
    const off = { ...pod.env };
    delete off.ACPX_OWNER_PLACEMENT;
    const result = await cli(["--format", "json", "sessions", "show", "--session-id", PTY_ID], off);
    assert.equal(result.stderr.includes("harness_unsupported"), false);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(
      result.stdout.includes(PTY_ID),
      "the local command answered about the claude-pty record",
    );
    assert.equal(pod.brokerRequests(), 0);
  } finally {
    pod.close();
  }
});
