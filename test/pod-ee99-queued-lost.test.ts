import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { startFakeApiServer } from "./pod-kit/fake-apiserver.js";
import { type BrokerFinal, type BrokerStatus, startFakeBroker } from "./pod-kit/fake-broker.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import {
  asAgent,
  type Fixture,
  makeBox,
  recordPath,
  runCli,
  sha256,
  startStubAtrium,
  type RecordedRequest,
  writeAtriumJson,
} from "./umq-rig.js";

// brick ee9980e3 — a held message is held, or the CLI says LOUDLY that it is not. `acpx prompt --no-wait`
// at a full pod-mode box exits 75 with a sentence; the sentence said "the message stays queued until room
// frees" on EVERY shape, but only atrium's delivery path (a routed agent prompt, or a `--message-id`
// delivery) has anything behind it that holds. A plain shell (no agent identity — the ssh-remote shape)
// takes the direct path: nothing is written, nothing waits, and the sentence lied.

const CLAUDE = "node /opt/claude-agent-acp/release-2/dist/index.js";
const CODEX = "node /opt/codex-acp/dist/index.js";
const SESSION_URL = "https://atrium.example.test/?session=5e55c0de-0000-4000-8000-0000000000aa";

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.stdout.write("stub-answer\\n");
`;

/** The control pod in pod mode: a fake API server (no pod anywhere), the broker, a stub transport. */
async function podRig(f: Fixture, broker: { url: string }) {
  const sa = path.join(f.root, "serviceaccount");
  fs.mkdirSync(sa, { recursive: true });
  fs.writeFileSync(path.join(sa, "namespace"), "dev-devbox\n");
  fs.writeFileSync(path.join(sa, "token"), "tok-1\n");
  const stubDir = fs.mkdtempSync(path.join(f.root, "stub-"));
  fs.writeFileSync(path.join(stubDir, "agent-exec"), STUB, { mode: 0o755 });
  const runtime = fs.mkdtempSync(path.join(f.root, "runtime-"));
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
  const api = await startFakeApiServer({ namespace: "dev-devbox", token: "tok-1", pods: [] });
  const env: NodeJS.ProcessEnv = {
    ...f.env,
    NODE_TEST_CONTEXT: "child",
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: f.root,
    ACPX_POD_SA_DIR: sa,
    ACPX_POD_API_URL: api.url,
    NV_POD_NAME: "dev-server-0",
    NV_POD_UID: "00000000-0000-0000-0000-000000000001",
    NV_NODE_NAME: "node-a",
    NV_AGENT_BROKER_URL: broker.url,
    ACPX_AGENT_EXEC: path.join(stubDir, "agent-exec"),
    ACPX_TEST_RUNTIME_DIR: runtime,
  };
  return {
    env,
    calls: (): number => {
      const file = path.join(stubDir, "calls.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").length : 0;
    },
    close: async () => api.close(),
  };
}

function writeRecord(f: Fixture, id: string, agentCommand: string): void {
  const record = makeSessionRecord({
    acpxRecordId: id,
    acpSessionId: `acp-${id}`,
    agentCommand,
    cwd: f.root,
    seatId: `seat-${id}`,
  });
  fs.writeFileSync(
    path.join(f.root, ".acpx", "sessions", `${id}.json`),
    `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
  );
}

const FULL: BrokerFinal = { refused: { reason: "home_full", live: 2, cap: 100 } };

type Shape = {
  label: string;
  /** The caller: a plain shell (ssh-remote: no seat, no locator) or an agent in an owner tree. */
  caller: "shell" | "agent";
  addressing: "session-id" | "seat";
};

async function run(shape: Shape, refusal: BrokerFinal, command: string, atrium: "up" | "none") {
  const f = makeBox({ requestMib: 4000 });
  const id = "ee99-target";
  writeRecord(f, id, command);
  const broker = await startFakeBroker({
    status: { live: 10, cap: 10, home: { live: 0, cap: 0 } },
    default: { final: refusal },
  });
  const stub = await startStubAtrium((request: RecordedRequest) => ({
    status: 202,
    body: {
      delivery_id: (request.body as { delivery_id?: string }).delivery_id,
      to: id,
      status: "queued",
      held: { since: new Date().toISOString(), reason: "agent_cap", ahead: 0 },
    },
  }));
  if (atrium === "up") {
    writeAtriumJson(f, { internalUrl: stub.url });
  }
  const pod = await podRig(f, broker);
  const base = pod.env;
  const env =
    shape.caller === "agent"
      ? asAgent({ ...f, env: base }, { ACPX_SESSION_URL: SESSION_URL })
      : base;
  const target = shape.addressing === "seat" ? ["--seat", `seat-${id}`] : ["--session-id", id];
  const before = sha256(recordPath(f, id));
  const result = await runCli(
    ["--agent", command, "--approve-all", "prompt", ...target, "--no-wait", "hello"],
    env,
    "/workspace",
  );
  return {
    f,
    id,
    stub,
    result,
    calls: pod.calls(),
    recordChanged: sha256(recordPath(f, id)) !== before,
    close: async () => {
      await stub.close();
      await broker.close();
      await pod.close();
    },
  };
}

const HOME_FULL: BrokerFinal = { refused: { reason: "home_full", live: 2, cap: 100 } };

/**
 * THE GUARANTEE, as a predicate over what the caller saw and what is durably held: a CLI that says the
 * message is queued has put it where something will deliver it; otherwise it says plainly it did not.
 * A plain shell on the control pod has no holder — the only holder is atrium, and only for its own
 * deliveries (`--message-id`) or by a message-route POST.
 */
function assertQueuedOrLoud(out: Awaited<ReturnType<typeof run>>, label: string): void {
  const claimsQueued = /stays queued|is queued|will be delivered/iu.test(out.result.stderr);
  const heldByAtrium = out.stub.requests.some((r) => r.method === "POST");
  assert.notEqual(
    out.result.code,
    0,
    `${label}: a refused prompt is never a success: ${out.result.stderr}`,
  );
  assert.ok(
    !claimsQueued || heldByAtrium,
    `${label}: the CLI says the message is queued, but atrium holds nothing (exit ${out.result.code}): ${out.result.stderr}`,
  );
  assert.equal(out.calls, 0, `${label}: nothing reached a pod`);
  assert.equal(out.recordChanged, false, `${label}: the record is untouched`);
}

test("RED ee99 · a plain shell's `prompt --no-wait --session-id` at a full box says 'stays queued' while nothing holds the message (agent_cap why=cap)", async () => {
  const out = await run(
    { label: "shell/session-id", caller: "shell", addressing: "session-id" },
    FULL,
    CLAUDE,
    "up",
  );
  try {
    assertQueuedOrLoud(out, "shell/session-id/claude");
  } finally {
    await out.close();
  }
});

test("RED ee99 · the same for a home-only harness at home_full (the podlab FT-01 shape)", async () => {
  const out = await run(
    { label: "shell/session-id", caller: "shell", addressing: "session-id" },
    HOME_FULL,
    CODEX,
    "up",
  );
  try {
    assertQueuedOrLoud(out, "shell/session-id/cod