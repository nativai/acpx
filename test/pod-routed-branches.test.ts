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
import { createAgentPodLookup, podFacts } from "../src/pod/agent-pod-lookup.js";
import { classifyArgv } from "../src/pod/command-classes.js";
import { RoutedCallError } from "../src/pod/pod-refusal.js";
import {
  planPayload,
  PROMPT_REQUIRED_MESSAGE,
  routedArgv,
  routedBranchHandlers,
  type BranchDeps,
  type RoutedRecord,
} from "../src/pod/routed-branches.js";
import { agentPodKey, type RoutedCallOptions } from "../src/pod/routed-call.js";
import { startBroker } from "./pod-local-fake-broker.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

// A6.1 — the routed-ensure / routed-if-pod branches (C1.2) on A1's placement step: unit rows with
// injected dependencies, the pod lookup against a fake API server (C3.3's `unknown` rule), and the
// REAL CLI end to end in pod mode (A1's seam: ACPX_POD_TEST_HOME) with a stub transport.

const SESSION = "11111111-1111-4111-8111-111111111111";
const UID = "33333333-3333-4333-8333-333333333333";
const KEY = agentPodKey(SESSION);
const CLAUDE = "node /opt/claude-agent-acp/dist/index.js";
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "a6-branches-"));

// ───────────────────────── unit rows: the handlers with injected dependencies ─────────────────────────

type Harness = {
  deps: BranchDeps;
  runs: RoutedCallOptions[];
  failures: unknown[];
  stderr: string[];
  stdinReads: number;
};

function harness(
  over: Partial<BranchDeps> & {
    record?: RoutedRecord | undefined;
    outcome?: "no_pod" | number | Error;
  } = {},
): Harness {
  const h: Harness = {
    deps: undefined as unknown as BranchDeps,
    runs: [],
    failures: [],
    stderr: [],
    stdinReads: 0,
  };
  const record: RoutedRecord | undefined =
    "record" in over
      ? over.record
      : { acpxRecordId: SESSION, agentCommand: CLAUDE, seatId: "seat-1", name: "worker" };
  const outcome = over.outcome ?? 0;
  h.deps = {
    argv: () => ["claude", "prompt", "--session-id", SESSION, "hello"],
    env: { PATH: "/usr/bin" },
    cwd: () => "/workspace",
    isTty: () => false,
    readStdin: async () => {
      h.stdinReads += 1;
      return "from stdin";
    },
    resolveTarget: async () => (record ? record.acpxRecordId : null),
    loadRecord: async () => record,
    harnessOf: (command) => (command.includes("claude-agent-acp") ? "claude" : undefined),
    lookup: async () => ({ state: "absent" }),
    releases: () => ({ ok: true, releases: { acpx: "r1" } }),
    admissionClass: () => "delivery",
    run: async (options) => {
      h.runs.push(options);
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome === "no_pod"
        ? { kind: "no_pod" }
        : { kind: "completed", exitCode: outcome, callId: "c" };
    },
    fail: async (error) => {
      h.failures.push(error);
      return 1;
    },
    stderr: (text) => h.stderr.push(text),
    ...over,
  };
  return h;
}

function decisionFor(argv: string[]) {
  const classification = classifyArgv(argv, { builtInAgents: ["claude", "pi", "codex"] });
  assert.equal(classification.kind, "classified");
  return {
    kind: "branch" as const,
    branch: "routed-ensure" as const,
    classification,
    place: "control" as const,
    output: classification.output,
  };
}

test("routed-ensure: the call goes to the session's key as class owner-ensure, with the argv, releases, class and harness", async () => {
  const h = harness({ outcome: 7 });
  const handlers = routedBranchHandlers(h.deps);
  const argv = ["claude", "prompt", "--session-id", SESSION, "hello"];
  assert.equal(
    await handlers["routed-ensure"](decisionFor(argv)),
    7,
    "the pod command's exit code",
  );
  const [run] = h.runs;
  assert.ok(run);
  assert.equal(run.class, "owner-ensure");
  assert.equal(run.key, KEY);
  assert.deepEqual(run.argv, argv);
  assert.deepEqual(run.releases, { ok: true, releases: { acpx: "r1" } });
  assert.deepEqual(run.target, {
    sessionId: SESSION,
    seat: "seat-1",
    harness: "claude",
    admissionClass: "delivery",
    sessionName: "worker",
  });
  assert.equal(h.stdinReads, 0, "text given: stdin is not read");
});

test('routed-if-pod: class owner-if-pod, never asks for releases, `no_pod` → "proceed" (answered from the record)', async () => {
  const h = harness({ outcome: "no_pod", argv: () => ["cancel", "--session-id", SESSION] });
  const handlers = routedBranchHandlers(h.deps);
  const result = await handlers["routed-if-pod"](decisionFor(["cancel", "--session-id", SESSION]));
  assert.equal(result, "proceed");
  assert.equal(h.runs[0]?.class, "owner-if-pod");
  assert.equal(
    h.runs[0]?.releases,
    undefined,
    "only owner-ensure may reach the broker, and only it needs releases",
  );
  // And the pod command's own exit code when there is a pod.
  const h2 = harness({ outcome: 5, argv: () => ["cancel", "--session-id", SESSION] });
  assert.equal(
    await routedBranchHandlers(h2.deps)["routed-if-pod"](
      decisionFor(["cancel", "--session-id", SESSION]),
    ),
    5,
  );
});

test("a refusal or failure thrown by the call goes to acpx's own failure printing, with the exit code it returns", async () => {
  const error = new RoutedCallError({ outcome: "unknown", reason: "deadline", callId: "c" });
  const h = harness({ outcome: error });
  assert.equal(
    await routedBranchHandlers(h.deps)["routed-ensure"](
      decisionFor(["claude", "prompt", "--session-id", SESSION, "x"]),
    ),
    1,
  );
  assert.deepEqual(h.failures, [error]);
});

test("a target acpx cannot resolve → `ROUTED outcome=not_run reason=target_unresolved`, nothing run", async () => {
  for (const h of [harness({ record: undefined }), harness({ resolveTarget: async () => null })]) {
    assert.equal(
      await routedBranchHandlers(h.deps)["routed-ensure"](
        decisionFor(["claude", "prompt", "--session-id", "nope", "x"]),
      ),
      1,
    );
    assert.equal(h.runs.length, 0);
    const failure = h.failures[0];
    assert.ok(failure instanceof RoutedCallError);
    assert.match(
      failure.stderrLine,
      /^acpx: ROUTED outcome=not_run reason=target_unresolved call_id=\S+$/,
    );
  }
});

test("a session on an adapter the broker has no harness for is refused before anything is asked (harness_unsupported)", async () => {
  const h = harness({
    record: { acpxRecordId: SESSION, agentCommand: "node ./some-other-agent.js" },
  });
  await routedBranchHandlers(h.deps)["routed-ensure"](
    decisionFor(["claude", "prompt", "--session-id", SESSION, "x"]),
  );
  assert.equal(h.runs.length, 0);
  const failure = h.failures[0];
  assert.ok(failure instanceof RoutedCallError);
  assert.equal(failure.reason, "harness_unsupported");
});

// ───────────────────────── stdin (the routed command has none) ─────────────────────────

async function plan(argv: string[], over: { tty?: boolean } = {}) {
  const h = harness({ isTty: () => over.tty === true });
  const classification = decisionFor(argv).classification;
  assert.equal(classification.kind, "classified");
  const result = await planPayload(classification as never, argv, h.deps);
  return { result, h };
}

test("stdin: `--file -` (both spellings) is read here and travels as the payload; the argument points at the file", async () => {
  const split = await plan(["claude", "prompt", "--session-id", SESSION, "--file", "-"]);
  assert.ok(split.result && split.result !== "prompt_required");
  assert.equal(split.result.text, "from stdin");
  assert.deepEqual(split.result.argvFor("/p/x.payload"), [
    "claude",
    "prompt",
    "--session-id",
    SESSION,
    "--file",
    "/p/x.payload",
  ]);
  const inline = await plan(["claude", "prompt", "--session-id", SESSION, "--file=-"]);
  assert.ok(inline.result && inline.result !== "prompt_required");
  assert.deepEqual(inline.result.argvFor("/p/x.payload"), [
    "claude",
    "prompt",
    "--session-id",
    SESSION,
    "--file=/p/x.payload",
  ]);
});

test("stdin: no text, no --file, stdin not a terminal (what the local CLI does) → read here, `--file <payload>` added", async () => {
  const bare = await plan(["claude", "prompt", "--session-id", SESSION]);
  assert.ok(bare.result && bare.result !== "prompt_required");
  assert.equal(bare.result.text, "from stdin");
  assert.deepEqual(bare.result.argvFor("/p/x.payload"), [
    "claude",
    "prompt",
    "--session-id",
    SESSION,
    "--file",
    "/p/x.payload",
  ]);
  const agentForm = await plan(["claude", "--session-id", SESSION]);
  assert.ok(agentForm.result && agentForm.result !== "prompt_required");
});

test("stdin NEGATIVES: text present, a file named, or a batch file → stdin is NOT read; a command that is no prompt never reads it", async () => {
  for (const argv of [
    ["claude", "prompt", "--session-id", SESSION, "hello", "world"],
    ["claude", "prompt", "--session-id", SESSION, "--file", "prompt.md"],
    ["claude", "prompt", "--session-id", SESSION, "--batch-file", "b.json"],
    ["claude", "--session-id", SESSION, "hello"],
  ]) {
    const { result, h } = await plan(argv);
    assert.equal(result, undefined, argv.join(" "));
    assert.equal(h.stdinReads, 0, argv.join(" "));
  }
  const { result, h } = await plan(["cancel", "--session-id", SESSION]);
  assert.equal(result, undefined);
  assert.equal(h.stdinReads, 0);
});

test("stdin: no text and a terminal → acpx's own usage line, said HERE (exit 2), never an 'empty stdin' from inside the pod", async () => {
  const h = harness({ isTty: () => true });
  const argv = ["claude", "prompt", "--session-id", SESSION];
  h.deps.argv = () => argv;
  const exit = await routedBranchHandlers(h.deps)["routed-ensure"](decisionFor(argv));
  assert.equal(exit, 2);
  assert.deepEqual(h.stderr, [`${PROMPT_REQUIRED_MESSAGE}\n`]);
  assert.equal(h.runs.length, 0);
  assert.equal(h.stdinReads, 0);
});

test("stdin: no text and a terminal in JSON mode → acpx's usage error through the failure printer (exit 2 by its code), nothing run", async () => {
  const h = harness({ isTty: () => true });
  const argv = ["claude", "prompt", "--session-id", SESSION, "--json-strict"];
  h.deps.argv = () => argv;
  const exit = await routedBranchHandlers(h.deps)["routed-ensure"](decisionFor(argv));
  assert.equal(exit, 1, "the stub printer returns 1; the real one maps USAGE to 2");
  assert.equal(h.runs.length, 0);
  assert.equal(h.stderr.length, 0, "json-strict keeps stderr clean: the printer owns the output");
  assert.equal((h.failures[0] as { outputCode?: string }).outputCode, "USAGE");
});

test("classifyArgv carries the operand count the stdin rule reads", () => {
  const count = (argv: string[]) => {
    const c = classifyArgv(argv, { builtInAgents: ["claude"] });
    return c.kind === "classified" ? c.operandCount : -1;
  };
  assert.equal(count(["claude", "prompt", "--session-id", "x"]), 0);
  assert.equal(count(["claude", "prompt", "--session-id", "x", "hi", "there"]), 2);
  assert.equal(count(["claude", "prompt", "--session-id", "x", "--file", "-"]), 0);
  assert.equal(count(["claude", "--session-id", "x", "hi"]), 1);
});

test("routedArgv: the same normalization as cli.ts (a lifecycle `--` is dropped)", () => {
  assert.deepEqual(routedArgv(["node", "acpx", "a", "b"], {}), ["a", "b"]);
  assert.deepEqual(routedArgv(["node", "acpx", "--", "a"], { npm_lifecycle_event: "x" }), ["a"]);
  assert.deepEqual(routedArgv(["node", "acpx", "--", "a"], {}), ["--", "a"]);
});

// ───────────────────────── the pod lookup against a fake API server (C3.3) ─────────────────────────

type ApiScript = { status?: number; items?: unknown[]; raw?: string; hang?: boolean };

async function startApi(
  script: ApiScript,
): Promise<{ url: string; seen: string[]; close(): void }> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ""}`);
    if (script.hang) {
      return;
    }
    res.writeHead(script.status ?? 200, { "content-type": "application/json" });
    res.end(script.raw ?? JSON.stringify({ kind: "PodList", items: script.items ?? [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
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

const POD = (over: Record<string, unknown> = {}, statusOver: Record<string, unknown> = {}) => ({
  metadata: { uid: UID, name: `ag-${KEY}-abcde` },
  status: {
    phase: "Running",
    podIP: "10.9.8.7",
    conditions: [{ type: "Ready", status: "True", lastTransitionTime: "2026-11-21T12:00:00Z" }],
    ...statusOver,
  },
  ...over,
});

function lookupEnv(url: string, sa: string): NodeJS.ProcessEnv {
  return { NODE_TEST_CONTEXT: "child", ACPX_POD_API_URL: url, ACPX_POD_SA_DIR: sa };
}

test("lookup: a Ready pod → exists{ready, readyAtMs from the Ready condition, ip}; the key's label is the selector, the token is sent", async () => {
  const api = await startApi({ items: [POD()] });
  try {
    const answer = await createAgentPodLookup(lookupEnv(api.url, saFixture()))(KEY);
    assert.deepEqual(answer, {
      state: "exists",
      uid: UID,
      ready: true,
      readyAtMs: Date.parse("2026-11-21T12:00:00Z"),
      ip: "10.9.8.7",
    });
    assert.match(
      api.seen[0] ?? "",
      /^GET \/api\/v1\/namespaces\/dev-devbox\/pods\?labelSelector=workbench\.nativai\.de%2Fsession-key%3D[0-9a-f]{24} auth=Bearer tok-1$/,
    );
  } finally {
    api.close();
  }
});

test("lookup: not Ready, terminating, terminal, several — each says what it is", async () => {
  const notReady = POD({}, { conditions: [{ type: "Ready", status: "False" }] });
  const terminating = POD({ metadata: { uid: UID, deletionTimestamp: "2026-11-21T12:01:00Z" } });
  const terminal = POD({}, { phase: "Succeeded" });
  const cases: Array<[unknown[], string, boolean?]> = [
    [[notReady], "exists", false],
    [[terminating], "exists", false],
    [[terminal], "absent"],
    [[], "absent"],
    // A terminating pod beside its Ready successor: the Ready one wins.
    [
      [terminating, POD({ metadata: { uid: "44444444-4444-4444-8444-444444444444" } })],
      "exists",
      true,
    ],
  ];
  for (const [items, state, ready] of cases) {
    const api = await startApi({ items });
    try {
      const answer = await createAgentPodLookup(lookupEnv(api.url, saFixture()))(KEY);
      assert.equal(answer.state, state, JSON.stringify(items));
      if (answer.state === "exists") {
        assert.equal(answer.ready, ready);
      }
    } finally {
      api.close();
    }
  }
  assert.equal(podFacts({ status: {} }), undefined, "an object with no uid is not a pod");
});

test("lookup NEGATIVES — any failure is `unknown`, NEVER `absent` (an API outage must not send a prompt to the broker as if the pod were gone)", async () => {
  const sa = saFixture();
  const scripts: ApiScript[] = [
    { status: 500, raw: "{}" },
    { status: 403, raw: JSON.stringify({ kind: "Status", status: "Failure" }) },
    { status: 200, raw: "not json" },
    { status: 200, raw: JSON.stringify({ kind: "PodList" }) }, // 200 but no items list
    { status: 200, raw: JSON.stringify({ items: "nope" }) },
  ];
  for (const script of scripts) {
    const api = await startApi(script);
    try {
      assert.equal(
        (await createAgentPodLookup(lookupEnv(api.url, sa))(KEY)).state,
        "unknown",
        JSON.stringify(script),
      );
    } finally {
      api.close();
    }
  }
  // Connection refused.
  const dead = await startApi({});
  const url = dead.url;
  dead.close();
  assert.equal((await createAgentPodLookup(lookupEnv(url, sa))(KEY)).state, "unknown");
  // No credentials / no namespace / a key that is not a key.
  const noToken = fs.mkdtempSync(path.join(ROOT, "sa-empty-"));
  assert.equal((await createAgentPodLookup(lookupEnv(url, noToken))(KEY)).state, "unknown");
  const live = await startApi({ items: [] });
  try {
    assert.equal((await createAgentPodLookup(lookupEnv(live.url, sa))("../x")).state, "unknown");
    assert.equal(live.seen.length, 0, "a bad key is never sent");
    // The control: the same server with a good key says `absent` — so `unknown` above was not a blanket.
    assert.equal((await createAgentPodLookup(lookupEnv(live.url, sa))(KEY)).state, "absent");
  } finally {
    live.close();
  }
});

test("lookup: the API address seam is honoured only under node --test (production reads the in-pod service)", async () => {
  const api = await startApi({ items: [] });
  try {
    const env = { ACPX_POD_API_URL: api.url, ACPX_POD_SA_DIR: saFixture() }; // no NODE_TEST_CONTEXT
    assert.equal((await createAgentPodLookup(env)(KEY)).state, "unknown");
    assert.equal(api.seen.length, 0);
  } finally {
    api.close();
  }
});

// ───────────────────────── the REAL CLI in pod mode (A1's seam) ─────────────────────────

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const script = JSON.parse(fs.readFileSync(path.join(dir, "script.json"), "utf8"));
const argv = process.argv.slice(2);
const at = argv.indexOf("--payload");
const payload = at >= 0 && fs.existsSync(argv[at + 1]) ? fs.readFileSync(argv[at + 1], "utf8") : undefined;
const calls = path.join(dir, "calls.jsonl");
fs.appendFileSync(calls, JSON.stringify({ argv, payload }) + "\\n");
if (script.stdout) process.stdout.write(script.stdout);
process.exitCode = script.exit ?? 0;
`;

type Pod = {
  home: string;
  env: NodeJS.ProcessEnv;
  calls(): Array<{ argv: string[]; payload?: string }>;
  closeAll(): void;
  brokerSeen: () => number;
};

async function podFixture(opts: {
  api: ApiScript;
  broker?: Parameters<typeof startBroker>[0];
  stub?: { exit?: number; stdout?: string };
}): Promise<Pod> {
  const home = fs.mkdtempSync(path.join(ROOT, "home-"));
  const stubDir = fs.mkdtempSync(path.join(ROOT, "stub-"));
  fs.writeFileSync(path.join(stubDir, "agent-exec"), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(stubDir, "script.json"), JSON.stringify(opts.stub ?? {}));
  const runtime = fs.mkdtempSync(path.join(ROOT, "runtime-"));
  for (const tool of [
    "acpx",
    "acpx-ui",
    "claude-agent-acp",
    "codex-acp",
    "claude-pty-acp",
    "pi-acp",
  ]) {
    fs.mkdirSync(path.join(runtime, ".releases", tool, "r"), { recursive: true });
    fs.symlinkSync(`.releases/${tool}/r`, path.join(runtime, tool));
  }
  const api = await startApi(opts.api);
  const broker = await startBroker(opts.broker ?? { lines: [] });
  await writeSessionRecordFile(
    home,
    makeSessionRecord({
      acpxRecordId: SESSION,
      acpSessionId: SESSION,
      agentCommand: CLAUDE,
      cwd: "/workspace",
    }),
  );
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
    "ACPX_PARENT_SESSION_URL",
    "ACPX_STATE_HOME",
    "ACPX_ADMISSION_CLASS",
  ]) {
    delete env[name];
  }
  return {
    home,
    env,
    calls: () => {
      const file = path.join(stubDir, "calls.jsonl");
      return fs.existsSync(file)
        ? fs
            .readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as { argv: string[]; payload?: string })
        : [];
    },
    closeAll: () => {
      api.close();
      broker.close();
    },
    brokerSeen: () => broker.seen.length,
  };
}

type Cli = { code: number | null; stdout: string; stderr: string };

function cli(args: string[], env: NodeJS.ProcessEnv, stdin?: string): Promise<Cli> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      cwd: "/workspace",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? "");
  });
}

const READY = `ready ip=10.1.2.3 pod=ag-${KEY}-abcde uid=${UID} node=n1 placement=pool`;

test("CLI pod mode: a prompt with no pod → the broker is asked, the call goes to the broker's uid and IP; the pod command's exit code is the CLI's", async () => {
  const pod = await podFixture({
    api: { items: [] },
    broker: { lines: ["scheduling", READY] },
    stub: { exit: 0, stdout: "queued\n" },
  });
  try {
    const result = await cli(["claude", "prompt", "--session-id", SESSION, "hello"], pod.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "queued\n");
    assert.equal(pod.brokerSeen(), 1);
    const [call] = pod.calls();
    assert.ok(call);
    assert.deepEqual(call.argv.slice(call.argv.indexOf("--") + 1), [
      "claude",
      "prompt",
      "--session-id",
      SESSION,
      "hello",
    ]);
    assert.equal(call.argv[call.argv.indexOf("--expect-uid") + 1], UID);
    assert.equal(call.argv[call.argv.indexOf("--address") + 1], "10.1.2.3");
    assert.equal(call.argv[call.argv.indexOf("--key") + 1], KEY);
  } finally {
    pod.closeAll();
  }
});

test("CLI pod mode: a READY pod never touches the broker; `--file -` travels as the payload file", async () => {
  const pod = await podFixture({ api: { items: [POD()] }, stub: { exit: 0 } });
  try {
    const result = await cli(
      ["claude", "prompt", "--session-id", SESSION, "--file", "-"],
      pod.env,
      "text from stdin",
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(pod.brokerSeen(), 0);
    const [call] = pod.calls();
    assert.ok(call);
    assert.equal(call.payload, "text from stdin");
    const tail = call.argv.slice(call.argv.indexOf("--") + 1);
    assert.equal(
      tail[tail.length - 1],
      call.argv[call.argv.indexOf("--payload") + 1],
      "the argument names the payload file",
    );
    // Implicit piped stdin, no text, no file.
    const implicit = await cli(
      ["claude", "prompt", "--session-id", SESSION],
      pod.env,
      "implicit text",
    );
    assert.equal(implicit.code, 0, implicit.stderr);
    assert.equal(pod.calls()[1]?.payload, "implicit text");
    // The payload files are gone once the calls returned.
    assert.deepEqual(fs.readdirSync(path.join(pod.home, ".acpx", "routed")), []);
  } finally {
    pod.closeAll();
  }
});

test("CLI pod mode: an API server that does not answer → admission_busy (exit 75), the broker is NOT asked, nothing is sent", async () => {
  const pod = await podFixture({ api: { status: 500, raw: "{}" }, broker: { lines: [READY] } });
  try {
    const result = await cli(["claude", "prompt", "--session-id", SESSION, "hello"], pod.env);
    assert.equal(result.code, 75);
    assert.match(
      result.stderr.split("\n")[0] ?? "",
      /^acpx: REFUSED reason=admission_busy nothing_started=true protocol=1 /,
    );
    assert.equal(pod.brokerSeen(), 0);
    assert.equal(pod.calls().length, 0);
  } finally {
    pod.closeAll();
  }
});

test("CLI pod mode: the pod is not ready within the wake bound → the first stderr line is the pod_starting token, exit 75", async () => {
  const pod = await podFixture({ api: { items: [] }, broker: { lines: ["pulling"], stall: true } });
  try {
    // The wake bound is 20 s in production; the test seam shortens it for the stalled broker.
    const env = { ...pod.env, ACPX_TEST_WAKE_BOUND_MS: "400" };
    const result = await cli(["claude", "prompt", "--session-id", SESSION, "hello"], env);
    assert.equal(result.code, 75);
    assert.equal(
      result.stderr.split("\n")[0],
      `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=15 phase=pulling wake=${SESSION}`,
    );
    assert.equal(pod.calls().length, 0);
  } finally {
    pod.closeAll();
  }
});

test("CLI pod mode: owner-if-pod with a pod goes to it (cancel); with NO pod it runs LOCALLY and its exit code and output are the local command's", async () => {
  const withPod = await podFixture({
    api: { items: [POD()] },
    stub: { exit: 0, stdout: "cancelled-in-pod\n" },
  });
  try {
    const routed = await cli(["cancel", "--session-id", SESSION], withPod.env);
    assert.equal(routed.code, 0, routed.stderr);
    assert.equal(routed.stdout, "cancelled-in-pod\n");
    assert.equal(withPod.brokerSeen(), 0, "owner-if-pod never asks the broker");
  } finally {
    withPod.closeAll();
  }
  const noPod = await podFixture({
    api: { items: [] },
    stub: { exit: 9, stdout: "must-not-run\n" },
  });
  try {
    const local = await cli(["cancel", "--session-id", SESSION], noPod.env);
    assert.equal(noPod.calls().length, 0, "nothing was sent to a pod");
    assert.equal(noPod.brokerSeen(), 0);
    // The reference: the same command with pod mode off, in an identical home.
    const off = { ...noPod.env };
    delete off.ACPX_OWNER_PLACEMENT;
    const reference = await cli(["cancel", "--session-id", SESSION], off);
    assert.equal(local.code, reference.code);
    assert.equal(local.stdout, reference.stdout);
  } finally {
    noPod.closeAll();
  }
});

test("CLI pod mode: a session acpx cannot resolve → `ROUTED outcome=not_run reason=target_unresolved`, exit 1, nothing asked", async () => {
  const pod = await podFixture({ api: { items: [] }, broker: { lines: [READY] } });
  try {
    const result = await cli(
      ["claude", "prompt", "--session-id", "00000000-0000-4000-8000-00000000dead", "hi"],
      pod.env,
    );
    assert.equal(result.code, 1);
    assert.match(
      result.stderr.split("\n")[0] ?? "",
      /^acpx: ROUTED outcome=not_run reason=target_unresolved call_id=\S+$/,
    );
    assert.equal(pod.brokerSeen(), 0);
    assert.equal(pod.calls().length, 0);
  } finally {
    pod.closeAll();
  }
});

test("seams: the release directory and payload directory seams are honoured only under node --test", async () => {
  const pod = await podFixture({ api: { items: [] }, broker: { lines: [READY] } });
  try {
    const env = { ...pod.env };
    delete env.NODE_TEST_CONTEXT;
    // Without NODE_TEST_CONTEXT the stub transport, broker address and API address are all ignored:
    // acpx reads the production sources, which do not exist here, so nothing reaches the stub.
    const result = await cli(["claude", "prompt", "--session-id", SESSION, "hello"], env);
    assert.notEqual(result.code, 0);
    assert.equal(pod.calls().length, 0);
    assert.equal(pod.brokerSeen(), 0);
  } finally {
    pod.closeAll();
  }
});
