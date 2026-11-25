import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { agentPodKey } from "../src/pod/routed-call.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { startFakeApiServer } from "./pod-kit/fake-apiserver.js";
import { startFakeBroker } from "./pod-kit/fake-broker.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import {
  makeBox,
  recordPath,
  runCli,
  sha256,
  startStubAtrium,
  writeAtriumJson,
} from "./umq-rig.js";

// brick da4b08ec — atrium's batch spawn at a spawned child's first wake, on a pod-mode control pod.
//
// atrium's `prompt --no-wait --session-id <id> --batch-file -` carries the batch on STDIN. A routed call
// (C2) has no stdin: the control pod must read it HERE and ship it as the payload file, exactly as it
// does for `--file -`. Until this brick `planPayload` only knew `--file`/`-f`, so `--batch-file -` went
// into the pod unchanged, the pod read an empty stdin and answered `acpx: --batch-file body is not JSON`
// (exit 2) — which atrium reads as "this acpx has no --batch-file" and switches prompt-batch off box-wide.
// ee99's 79.2 row only counted the `--batch-file` token in the routed argv, so it passed all along.
//
// The stub transport below stands in for the pod's acpx: it receives the routed argv and no stdin, and
// answers what the real `readBatchMembersOrExit` answers for what it can read.

const CLAUDE = "node /opt/claude-agent-acp/release-2/dist/index.js";
const SESSION = "5e55c0de-0000-4000-8000-0000000000da";
const SEAT = "dadadada-1111-4111-8111-111111111111";
const UID = "44444444-4444-4444-8444-444444444444";
const KEY = agentPodKey(SESSION);

const BATCH = JSON.stringify({
  v: 1,
  messages: [
    {
      messageId: "11111111-1111-4111-8111-aaaaaaaaaaaa",
      prompt: [{ type: "text", text: "the brief" }],
      options: { sessionOptions: { model: "claude-opus-4-1" } },
    },
    {
      messageId: "22222222-2222-4222-8222-bbbbbbbbbbbb",
      prompt: [{ type: "text", text: "a second message" }],
    },
  ],
});

// The pod side: no stdin. A `--batch-file` value that names a readable file is parsed as the pod's acpx
// parses it; `-` reads stdin, which is empty; anything else cannot be read. Every call is recorded.
const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
let value;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--batch-file") value = argv[i + 1];
  else if (argv[i].startsWith("--batch-file=")) value = argv[i].slice("--batch-file=".length);
}
let body = "";
let source = "none";
if (value === "-") source = "stdin";
else if (value !== undefined) {
  try { body = fs.readFileSync(value, "utf8"); source = "file"; } catch { source = "unreadable"; }
}
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ argv, value, source, body }) + "\\n");
let ok = false;
try { ok = JSON.parse(body).v === 1; } catch { ok = false; }
if (!ok) {
  process.stderr.write(source === "unreadable" ? "acpx: --batch-file cannot read " + value + "\\n" : "acpx: --batch-file body is not JSON\\n");
  process.exitCode = 2;
}
`;

type Call = { argv: string[]; value: string | undefined; source: string; body: string };

async function run(batchFlag: string[], stdin: string, options: { noPod?: boolean } = {}) {
  const f = makeBox({ requestMib: 4000 });
  const record = makeSessionRecord({
    acpxRecordId: SESSION,
    acpSessionId: `acp-${SESSION}`,
    agentCommand: CLAUDE,
    cwd: f.root,
    seatId: SEAT,
  });
  const dir = path.join(f.root, ".acpx", "sessions");
  fs.writeFileSync(
    path.join(dir, `${SESSION}.json`),
    `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "seats.json"),
    JSON.stringify({
      [SEAT]: {
        seat_id: SEAT,
        created_at: "2026-11-25T10:00:00.000Z",
        active_holder_id: SESSION,
        next_ordinal: 2,
        closed_at: null,
      },
    }),
  );
  const before = sha256(recordPath(f, SESSION));
  const broker = await startFakeBroker(
    options.noPod
      ? {
          default: {
            final: {
              ready: {
                ip: "10.9.8.7",
                pod: `ag-${KEY}-abcde`,
                uid: UID,
                node: "node-a",
                placement: "home",
              },
            },
          },
        }
      : {},
  );
  const atrium = await startStubAtrium(() => ({ status: 202, body: { status: "queued" } }));
  writeAtriumJson(f, { internalUrl: atrium.url });
  const api = await startFakeApiServer({
    namespace: "dev-devbox",
    token: "tok-1",
    pods: options.noPod
      ? []
      : [
          {
            name: `ag-${KEY}-abcde`,
            uid: UID,
            podIP: "10.9.8.7",
            readyTransitionTime: "2026-11-21T12:00:00Z",
            labels: { "workbench.nativai.de/session-key": KEY },
          },
        ],
  });
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
    // atrium's runner sets the admission class on its batch spawn.
    ACPX_ADMISSION_CLASS: "delivery",
  };
  // atrium's exact argv (server/promptInvocation.ts `buildBatchPromptInvocation`) with the flag under test.
  const args = [
    "--approve-all",
    "--cwd",
    "/workspace",
    "--agent",
    CLAUDE,
    "prompt",
    "--no-wait",
    "--session-id",
    SESSION,
    ...batchFlag,
  ];
  const result = await runCli(args, env, "/workspace", stdin);
  const callsFile = path.join(stubDir, "calls.jsonl");
  const calls: Call[] = fs.existsSync(callsFile)
    ? fs
        .readFileSync(callsFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Call)
    : [];
  return {
    result,
    calls,
    brokerRequests: broker.requests.length,
    recordUnchanged: sha256(recordPath(f, SESSION)) === before,
    close: async () => {
      await Promise.all([atrium.close(), broker.close(), api.close()]);
    },
  };
}

async function withRun(
  batchFlag: string[],
  stdin: string,
  check: (out: Awaited<ReturnType<typeof run>>) => void,
  options: { noPod?: boolean } = {},
) {
  const out = await run(batchFlag, stdin, options);
  try {
    check(out);
  } finally {
    await out.close();
  }
}

for (const [label, flag] of [
  ["`--batch-file -`", ["--batch-file", "-"]],
  ["`--batch-file=-`", ["--batch-file=-"]],
] as const) {
  test(`da4b · ${label} on a pod-mode control pod: the batch on stdin is read HERE and reaches the pod as a file; accepted (exit 0), the pod called once`, async () => {
    await withRun([...flag], BATCH, (out) => {
      assert.equal(out.result.code, 0, `exit: ${out.result.stderr}`);
      assert.equal(out.calls.length, 1, "the batch goes to the pod once");
      const call = out.calls[0];
      assert.equal(
        call.source,
        "file",
        `the pod got ${JSON.stringify(call.value)}, which it must be able to read`,
      );
      assert.notEqual(call.value, "-", "never the stdin placeholder: a routed call has no stdin");
      assert.match(call.value ?? "", /\.payload$/u, "the payload file, as `--file -` is carried");
      assert.equal(call.body, BATCH, "the pod reads exactly the batch atrium sent");
      const delivered = (
        JSON.parse(call.body) as { messages: Array<{ messageId: string }> }
      ).messages.map((m) => m.messageId);
      assert.deepEqual(
        delivered,
        ["11111111-1111-4111-8111-aaaaaaaaaaaa", "22222222-2222-4222-8222-bbbbbbbbbbbb"],
        "every member, in order, once",
      );
      assert.equal(out.brokerRequests, 0, "a Ready pod needs no broker");
      assert.doesNotMatch(out.result.stderr, /not JSON|usage/iu);
    });
  });
}

test("da4b · negative: a path form is untouched (nothing read from stdin) and the pod sees the same path", async () => {
  await withRun(["--batch-file", "/workspace/da4b-no-such-batch.json"], "", (out) => {
    assert.equal(out.calls.length, 1);
    assert.equal(out.calls[0].value, "/workspace/da4b-no-such-batch.json");
  });
});

test("da4b · negative: a genuinely malformed batch on stdin is still refused with exit 2 (the pod's own `acpx: --batch-file …` line, relayed), never swallowed", async () => {
  await withRun(["--batch-file", "-"], "this is not json", (out) => {
    assert.equal(out.result.code, 2, out.result.stderr);
    assert.match(out.result.stderr, /acpx: --batch-file body is not JSON/u);
    assert.equal(out.calls.length, 1, "it reached the pod once and was refused there, not retried");
  });
});

test("da4b · the NO-POD-YET path: the broker ensures the pod, and the batch still arrives as the payload file (the plan is made before the broker call)", async () => {
  await withRun(
    ["--batch-file", "-"],
    BATCH,
    (out) => {
      assert.equal(out.result.code, 0, `exit: ${out.result.stderr}`);
      assert.ok(out.brokerRequests >= 1, "the broker was asked for the pod");
      assert.equal(out.calls.length, 1);
      assert.equal(out.calls[0].source, "file");
      assert.equal(out.calls[0].body, BATCH);
    },
    { noPod: true },
  );
});
