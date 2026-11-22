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
import { refuseRoutedTwice, ROUTED_TWICE_REFUSAL } from "../src/pod/routed-twice.js";
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
      : { acpxRecordId: SESSION, agentCommand: CLAUDE, seatId: "seat-1" };
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

const ctx = (writes: string[] = []) => ({
  argv: [] as string[],
  write: (line: string) => {
    writes.push(line);
  },
  writeStdout: () => undefined,
});

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
    await handlers["routed-ensure"](decisionFor(argv), ctx()),
    7,
    "the pod command's exit code",
  );
  const [run] = h.runs;
  assert.ok(run);
  assert.equal(run.class, "owner-ensure");
  assert.equal(run.key, KEY);
  assert.deepEqual(
    run.argv,
    ["acpx", ...argv],
    "argv[0] is the string acpx, never a path (C2 A-24)",
  );
  assert.deepEqual(run.releases, { ok: true, releases: { acpx: "r1" } });
  assert.deepEqual(run.target, {
    sessionId: SESSION,
    seat: "seat-1",
    harness: "claude",
    placement: "auto", // A-45: Claude is not home-only
    admissionClass: "delivery",
  });
  assert.equal(h.stdinReads, 0, "text given: stdin is not read");
});

test('routed-if-pod: class owner-if-pod, never asks for releases, `no_pod` → "proceed" (answered from the record)', async () => {
  const h = harness({ outcome: "no_pod", argv: () => ["cancel", "--session-id", SESSION] });
  const handlers = routedBranchHandlers(h.deps);
  const result = await handlers["routed-if-pod"](
    decisionFor(["cancel", "--session-id", SESSION]),
    ctx(),
  );
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
      ctx(),
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
      ctx(),
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
        ctx(),
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
    ctx(),
  );
  assert.equal(h.runs.length, 0);
  const failure = h.failures[0];
  assert.ok(failure instanceof RoutedCallError);
  assert.equal(failure.reason, "harness_unsupported");
});

// A-39 (brick b69eeecf): the terminal harness is not in phase 1.
test("A-39: a `claude-pty` harness is refused by name before anything is asked — even if the adapter classifier ever names it; claude, codex and pi still route", async () => {
  const classifiedAs = (kind: string) =>
    harness({
      record: { acpxRecordId: SESSION, agentCommand: `node /opt/${kind}/dist/index.js` },
      harnessOf: () => kind,
    });
  const refused = classifiedAs("claude-pty");
  await routedBranchHandlers(refused.deps)["routed-ensure"](
    decisionFor(["claude", "prompt", "--session-id", SESSION, "x"]),
    ctx(),
  );
  assert.equal(refused.runs.length, 0, "nothing was routed, so nothing was asked");
  const failure = refused.failures[0];
  assert.ok(failure instanceof RoutedCallError);
  assert.equal(failure.reason, "harness_unsupported");
  assert.equal(failure.outcome, "not_run");
  for (const kind of ["claude", "codex", "pi"]) {
    const routed = classifiedAs(kind);
    await routedBranchHandlers(routed.deps)["routed-ensure"](
      decisionFor(["claude", "prompt", "--session-id", SESSION, "x"]),
      ctx(),
    );
    assert.equal(routed.failures.length, 0, kind);
    assert.equal(routed.runs.length, 1, `${kind} still routes`);
  }
});

// A-45 (brick 25e97206): a session's placement follows the SAME home-only function as a one-shot's pod key.
test("A-45 unit: a home-only harness is placed `home`, anything else `auto`; with P1's per-box fact Pi is `auto` for sessions — codex never leaves home", async () => {
  const placementOf = async (kind: string, env: NodeJS.ProcessEnv = {}) => {
    const h = harness({
      record: { acpxRecordId: SESSION, agentCommand: `node /opt/${kind}/dist/index.js` },
      harnessOf: () => kind,
      env: { PATH: "/usr/bin", ...env },
    });
    await routedBranchHandlers(h.deps)["routed-ensure"](
      decisionFor(["claude", "prompt", "--session-id", SESSION, "x"]),
      ctx(),
    );
    assert.equal(h.runs.length, 1, kind);
    return h.runs[0]?.target.placement;
  };
  assert.equal(await placementOf("codex"), "home");
  assert.equal(await placementOf("pi"), "home", "before P1");
  assert.equal(await placementOf("claude"), "auto");
  const p1 = { NODE_TEST_CONTEXT: "child", ACPX_TEST_P1_ON_BOX: "1" };
  assert.equal(await placementOf("pi", p1), "auto", "with P1's fact");
  assert.equal(await placementOf("codex", p1), "home", "codex stays home");
  assert.equal(await placementOf("claude", p1), "auto");
  // The seam outside a test, or with another value, is no signal: the acpx release alone never moves Pi.
  assert.equal(await placementOf("pi", { ACPX_TEST_P1_ON_BOX: "1" }), "home");
  assert.equal(
    await placementOf("pi", { NODE_TEST_CONTEXT: "child", ACPX_TEST_P1_ON_BOX: "0" }),
    "home",
  );
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
  const exit = await routedBranchHandlers(h.deps)["routed-ensure"](decisionFor(argv), ctx());
  assert.equal(exit, 2);
  assert.deepEqual(h.stderr, [`${PROMPT_REQUIRED_MESSAGE}\n`]);
  assert.equal(h.runs.length, 0);
  assert.equal(h.stdinReads, 0);
});

test("stdin: no text and a terminal in JSON mode → acpx's usage error through the failure printer (exit 2 by its code), nothing run", async () => {
  const h = harness({ isTty: () => true });
  const argv = ["claude", "prompt", "--session-id", SESSION, "--json-strict"];
  h.deps.argv = () => argv;
  const exit = await routedBranchHandlers(h.deps)["routed-ensure"](decisionFor(argv), ctx());
  assert.equal(exit, 1, "the stub printer returns 1; the real one maps USAGE to 2");
  assert.equal(h.runs.length, 0);
  assert.equal(h.stderr.length, 0, "json-strict keeps stderr clean: the printer owns the output");
  assert.equal((h.failures[0] as { outputCode?: string }).outputCode, "USAGE");
});

test("classifyArgv carries the operand count the stdin rule reads", () => {
  const count = (argv: string[]) => {
    const c = classifyArgv(argv, { builtInAgents: ["claude"] });
    return c.kind === "classified" ? c.operandIndexes.length : -1;
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
    // A5 round 1 (death-proof's 404 rule): a 404 — even a well-formed Status NotFound — is never `absent`
    // for a LIST (only a 200 with an items list can say so); a proxy answering 404 to every path would
    // otherwise send every prompt to the broker.
    {
      status: 404,
      raw: JSON.stringify({ kind: "Status", reason: "NotFound", details: { kind: "pods" } }),
    },
    { status: 404, raw: "404 page not found" },
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
fs.appendFileSync(calls, JSON.stringify({ argv, payload, env: process.env }) + "\\n");
if (script.stdout) process.stdout.write(script.stdout);
process.exitCode = script.exit ?? 0;
`;

type Pod = {
  home: string;
  env: NodeJS.ProcessEnv;
  calls(): Array<{ argv: string[]; payload?: string; env: Record<string, string> }>;
  closeAll(): void;
  brokerSeen: () => number;
  brokerBodies: () => Array<Record<string, unknown>>;
};

async function podFixture(opts: {
  /** The record's agent command (default: the Claude SDK adapter). */
  command?: string;
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
    "pi",
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
      agentCommand: opts.command ?? CLAUDE,
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
    "ACPX_SEAT_URL",
    "ACPX_SESSION_RECORD_ID",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_PARENT_SEAT_URL",
    "ACPX_STATE_HOME",
    "ACPX_ROUTED",
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
            .map(
              (l) =>
                JSON.parse(l) as { argv: string[]; payload?: string; env: Record<string, string> },
            )
        : [];
    },
    closeAll: () => {
      api.close();
      broker.close();
    },
    brokerSeen: () => broker.seen.length,
    brokerBodies: () =>
      broker.seen
        .filter((r) => r.method === "POST")
        .map((r) => JSON.parse(r.body) as Record<string, unknown>),
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
    // C2 (A-24): the routed argv is the WHOLE command — `acpx` (the string, never a path) and then
    // acpx's own arguments unchanged. Without the program the pod ran `claude …` as a program (TE F-1).
    assert.deepEqual(call.argv.slice(call.argv.indexOf("--") + 1), [
      "acpx",
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
    assert.equal(tail[0], "acpx");
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
    const cancelCall = withPod.calls()[0];
    assert.ok(cancelCall);
    assert.deepEqual(cancelCall.argv.slice(cancelCall.argv.indexOf("--") + 1), [
      "acpx",
      "cancel",
      "--session-id",
      SESSION,
    ]);
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

test("A-39 CLI pod mode: a REAL claude-pty record's prompt gives ROUTED not_run harness_unsupported (exit 1); the broker sees zero requests, nothing reaches a pod", async () => {
  const pod = await podFixture({
    command: "node /opt/claude-pty-acp/dist/index.js",
    api: { items: [] },
    broker: { lines: ["scheduling", READY] },
    stub: { exit: 0, stdout: "must-not-run\n" },
  });
  try {
    const result = await cli(["claude", "prompt", "--session-id", SESSION, "hello"], pod.env);
    assert.equal(result.code, 1, result.stderr);
    assert.match(
      result.stderr.split("\n")[0] ?? "",
      /^acpx: ROUTED outcome=not_run reason=harness_unsupported call_id=\S+$/,
    );
    assert.equal(pod.brokerSeen(), 0, "no broker request");
    assert.equal(pod.brokerBodies().length, 0, "not even a POST");
    assert.equal(pod.calls().length, 0);
    assert.equal(result.stdout.includes("must-not-run"), false);
  } finally {
    pod.closeAll();
  }
});

test("A-39 CLI pod mode, the controls in the same rig: claude, codex and pi records still route — the broker is asked once and the call reaches the pod", async () => {
  for (const command of [
    CLAUDE,
    "node /opt/codex-acp/dist/index.js",
    "node /opt/pi-acp/dist/index.js",
  ]) {
    const pod = await podFixture({
      command,
      api: { items: [] },
      broker: { lines: ["scheduling", READY] },
      stub: { exit: 0, stdout: "queued\n" },
    });
    try {
      const result = await cli(["claude", "prompt", "--session-id", SESSION, "hello"], pod.env);
      assert.equal(result.code, 0, `${command}: ${result.stderr}`);
      assert.equal(result.stdout, "queued\n", command);
      assert.equal(pod.brokerSeen(), 1, command);
      assert.equal(pod.calls().length, 1, command);
    } finally {
      pod.closeAll();
    }
  }
});

test("A-39 off pod mode: a claude-pty record behaves exactly as today — no harness refusal, no broker, the local path runs", async () => {
  const pod = await podFixture({
    command: "node /opt/claude-pty-acp/dist/index.js",
    api: { items: [] },
    broker: { lines: [READY] },
  });
  try {
    const off = { ...pod.env };
    delete off.ACPX_OWNER_PLACEMENT;
    // `cancel` is local without a pod: it answers from the record and never mentions the harness.
    const result = await cli(["cancel", "--session-id", SESSION], off);
    assert.equal(result.stderr.includes("harness_unsupported"), false, result.stderr);
    assert.equal(result.stderr.includes("ROUTED"), false, result.stderr);
    assert.equal(pod.brokerSeen(), 0);
    assert.equal(pod.calls().length, 0);
  } finally {
    pod.closeAll();
  }
});

test("A-45 rows 45.1/45.2 (CLI, pod mode): the wake of a Codex session posts `placement: home`, a Claude session `auto`, a Pi session `home` before P1 and `auto` with P1's fact", async () => {
  const wake = async (command: string, extra: NodeJS.ProcessEnv = {}) => {
    const pod = await podFixture({
      command,
      api: { items: [] },
      broker: { lines: ["scheduling", READY] },
      stub: { exit: 0, stdout: "queued\n" },
    });
    try {
      const result = await cli(["claude", "prompt", "--session-id", SESSION, "hello"], {
        ...pod.env,
        ...extra,
      });
      assert.equal(result.code, 0, `${command}: ${result.stderr}`);
      const [body, ...rest] = pod.brokerBodies();
      assert.equal(rest.length, 0, command);
      return body?.placement;
    } finally {
      pod.closeAll();
    }
  };
  assert.equal(await wake("node /opt/codex-acp/dist/index.js"), "home", "45.1");
  assert.equal(await wake(CLAUDE), "auto", "45.1 control");
  assert.equal(await wake("node /opt/pi-acp/dist/index.js"), "home", "45.2 before P1");
  assert.equal(
    await wake("node /opt/pi-acp/dist/index.js", { ACPX_TEST_P1_ON_BOX: "1" }),
    "auto",
    "45.2 with P1's fact",
  );
  assert.equal(
    await wake("node /opt/codex-acp/dist/index.js", { ACPX_TEST_P1_ON_BOX: "1" }),
    "home",
  );
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

test("CLI pod mode: the failure keeps the command's output mode — json: error object on stdout AND the ROUTED line first on stderr; --json-strict: stderr empty", async () => {
  const pod = await podFixture({ api: { items: [] } });
  try {
    const target = ["--session-id", "00000000-0000-4000-8000-00000000dead"];
    const json = await cli(["--format", "json", "claude", "prompt", ...target, "hi"], pod.env);
    assert.equal(json.code, 1);
    assert.match(
      json.stderr.split("\n")[0] ?? "",
      /^acpx: ROUTED outcome=not_run reason=target_unresolved call_id=\S+$/,
    );
    assert.ok(
      JSON.parse(json.stdout.trim().split("\n")[0] ?? "{}").error,
      "an error object on stdout",
    );
    const strict = await cli(
      ["--format", "json", "--json-strict", "claude", "prompt", ...target, "hi"],
      pod.env,
    );
    assert.equal(strict.code, 1);
    assert.equal(strict.stderr, "");
    assert.ok(JSON.parse(strict.stdout.trim().split("\n")[0] ?? "{}").error);
  } finally {
    pod.closeAll();
  }
});

// ───────────────────────── G-2: routed_twice ─────────────────────────

test("routed_twice (A-8): a command that arrives ROUTED (ACPX_ROUTED=1) is never routed again — refused before anything is resolved or run, by the helper block A3 shares", async () => {
  const argv = ["claude", "prompt", "--session-id", SESSION, "hello"];
  for (const branch of ["routed-ensure", "routed-if-pod"] as const) {
    const twice = harness({ env: { PATH: "/usr/bin", ACPX_ROUTED: "1" } });
    const lines: string[] = [];
    const exit = await routedBranchHandlers(twice.deps)[branch](decisionFor(argv), ctx(lines));
    assert.equal(exit, 2, "exit 2, like unclassified_command");
    assert.equal(lines[0], "acpx: REFUSED reason=routed_twice");
    assert.equal(lines.length, 2, "both lines in text mode");
    assert.equal(twice.runs.length, 0);
    assert.equal(twice.stdinReads, 0);
  }
  // ONE helper: the lines are exactly the ones A3's pass-through prints.
  assert.deepEqual(ROUTED_TWICE_REFUSAL.lines[0], "acpx: REFUSED reason=routed_twice");
  assert.equal(
    refuseRoutedTwice(
      "json",
      () => undefined,
      () => undefined,
    ),
    2,
  );
  const jsonLines: string[] = [];
  refuseRoutedTwice(
    "json",
    (line) => jsonLines.push(line),
    () => undefined,
  );
  assert.deepEqual(jsonLines, [ROUTED_TWICE_REFUSAL.lines[0]], "json: line 1 only");
  // The negative: the same command WITHOUT the marker is routed as usual (and ACPX_ROUTED=0 is no marker).
  for (const env of [{ PATH: "/usr/bin" }, { PATH: "/usr/bin", ACPX_ROUTED: "0" }]) {
    const normal = harness({ env });
    await routedBranchHandlers(normal.deps)["routed-ensure"](decisionFor(argv), ctx());
    assert.equal(normal.runs.length, 1, JSON.stringify(env));
  }
});

test("CLI pod mode: ACPX_ROUTED=1 → `acpx: REFUSED reason=routed_twice` first line, exit 2, nothing asked, nothing sent", async () => {
  const pod = await podFixture({ api: { items: [POD()] }, broker: { lines: [READY] } });
  try {
    const result = await cli(["claude", "prompt", "--session-id", SESSION, "hello"], {
      ...pod.env,
      ACPX_ROUTED: "1",
    });
    assert.equal(result.code, 2);
    assert.equal(result.stderr.split("\n")[0], "acpx: REFUSED reason=routed_twice");
    assert.equal(pod.brokerSeen(), 0);
    assert.equal(pod.calls().length, 0);
    // Control: without the marker the same command is routed.
    const routed = await cli(["claude", "prompt", "--session-id", SESSION, "hello"], pod.env);
    assert.equal(routed.code, 0, routed.stderr);
    assert.equal(pod.calls().length, 1);
  } finally {
    pod.closeAll();
  }
});

test("C4 request: sessionUrl (the target's URL on the box's base URL) is sent; `seat` and `sessionId` too", async () => {
  const pod = await podFixture({
    api: { items: [] },
    broker: { lines: ["scheduling", READY] },
    stub: { exit: 0 },
  });
  try {
    const env = { ...pod.env, ACPX_UI_BASE_URL: "https://atrium.test.invalid" };
    const result = await cli(["claude", "prompt", "--session-id", SESSION, "hello"], env);
    assert.equal(result.code, 0, result.stderr);
    const body = pod.brokerBodies()[0];
    assert.equal(body?.sessionUrl, `https://atrium.test.invalid/?session=${SESSION}`);
    assert.equal(body?.sessionId, SESSION);
  } finally {
    pod.closeAll();
  }
});

// ───────────────────────── G-1: caller identity (C2) ─────────────────────────

const IDENTITY_ENV = {
  ACPX_SESSION_URL: "https://h/?session=caller-s",
  ACPX_SEAT_URL: "https://h/?seat=caller-t",
  ACPX_SESSION_RECORD_ID: "caller-record",
  ACPX_PARENT_SESSION_URL: "https://h/?session=parent-s",
  ACPX_PARENT_SEAT_URL: "https://h/?seat=parent-t",
};

test("caller identity (C2): handed to the call exactly when the environment carries it (an agent caused the call through the pass-through) — and only those five names", async () => {
  const argv = ["claude", "prompt", "--session-id", SESSION, "hello"];
  const agent = harness({
    env: { PATH: "/usr/bin", ...IDENTITY_ENV, ANTHROPIC_API_KEY: "k", ACPX_SOMETHING_ELSE: "x" },
  });
  await routedBranchHandlers(agent.deps)["routed-ensure"](decisionFor(argv), ctx());
  assert.deepEqual(agent.runs[0]?.callerIdentity, IDENTITY_ENV);
  // Negative: no identity in the environment (a person, a delivery atrium spawned) → none is handed over.
  const person = harness({ env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k" } });
  await routedBranchHandlers(person.deps)["routed-ensure"](decisionFor(argv), ctx());
  assert.deepEqual(person.runs[0]?.callerIdentity, {});
  // Empty values are no identity.
  const empty = harness({ env: { PATH: "/usr/bin", ACPX_SESSION_URL: "  ", ACPX_SEAT_URL: "" } });
  await routedBranchHandlers(empty.deps)["routed-if-pod"](decisionFor(argv), ctx());
  assert.deepEqual(empty.runs[0]?.callerIdentity, {});
});

test("CLI pod mode, identity each way: an agent-caused call (identity in the environment) carries it into the pod; a call without it carries none", async () => {
  const pod = await podFixture({ api: { items: [POD()] }, stub: { exit: 0 } });
  try {
    const withIdentity = await cli(["cancel", "--session-id", SESSION], {
      ...pod.env,
      ...IDENTITY_ENV,
      ANTHROPIC_API_KEY: "must-not-travel",
    });
    assert.equal(withIdentity.code, 0, withIdentity.stderr);
    const first = pod.calls()[0];
    assert.ok(first);
    for (const [name, value] of Object.entries(IDENTITY_ENV)) {
      assert.equal(first.env[name], value, name);
    }
    assert.equal(
      "ANTHROPIC_API_KEY" in first.env,
      false,
      "nothing else of the environment travels",
    );
    const without = await cli(["cancel", "--session-id", SESSION], pod.env);
    assert.equal(without.code, 0, without.stderr);
    const second = pod.calls()[1];
    assert.ok(second);
    for (const name of Object.keys(IDENTITY_ENV)) {
      assert.equal(name in second.env, false, `${name} must not travel without an agent cause`);
    }
  } finally {
    pod.closeAll();
  }
});

test("L-6: routed_twice honours the output mode like A1's refusals — text: both lines on stderr; json: the error object on stdout and line 1 on stderr; json-strict: stderr empty", async () => {
  const pod = await podFixture({ api: { items: [POD()] } });
  try {
    const base = ["claude", "prompt", "--session-id", SESSION, "hello"];
    const env = { ...pod.env, ACPX_ROUTED: "1" };
    const text = await cli(base, env);
    assert.equal(text.code, 2);
    assert.equal(text.stdout, "");
    assert.equal(text.stderr.trim().split("\n").length, 2);
    for (const [flags, stderrLines] of [
      [["--format", "json"], 1],
      [["--format", "json", "--json-strict"], 0],
    ] as const) {
      const result = await cli([...flags, ...base], env);
      assert.equal(result.code, 2, flags.join(" "));
      const error = (
        JSON.parse(result.stdout.trim()) as {
          error: { code: number; data: Record<string, unknown> };
        }
      ).error;
      assert.equal(error.code, -32602);
      assert.equal(error.data.reason, "routed_twice");
      assert.equal(error.data.tokenLine, "acpx: REFUSED reason=routed_twice");
      const lines = result.stderr.trim() === "" ? [] : result.stderr.trim().split("\n");
      assert.equal(lines.length, stderrLines, flags.join(" "));
    }
    assert.equal(pod.calls().length, 0);
  } finally {
    pod.closeAll();
  }
});

test("G-1 direct call: an agent calling directly on the control pod (identity in its own environment) sends the identity variables; a caller with none sends none", async () => {
  const pod = await podFixture({ api: { items: [POD()] }, stub: { exit: 0 } });
  try {
    const direct = await cli(["claude", "prompt", "--session-id", SESSION, "hi"], {
      ...pod.env,
      ...IDENTITY_ENV,
    });
    assert.equal(direct.code, 0, direct.stderr);
    const sent = pod.calls()[0];
    assert.ok(sent);
    for (const [name, value] of Object.entries(IDENTITY_ENV)) {
      assert.equal(sent.env[name], value, name);
    }
    const none = await cli(["claude", "prompt", "--session-id", SESSION, "hi"], pod.env);
    assert.equal(none.code, 0, none.stderr);
    const second = pod.calls()[1];
    assert.ok(second);
    for (const name of Object.keys(IDENTITY_ENV)) {
      assert.equal(name in second.env, false, name);
    }
  } finally {
    pod.closeAll();
  }
});
