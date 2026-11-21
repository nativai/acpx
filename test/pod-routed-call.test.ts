import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import {
  exitCodeForOutputErrorCode,
  normalizeOutputError,
} from "../src/acp/error-normalization.js";
import { CapacityRefusedError } from "../src/errors.js";
import { RoutedCallError } from "../src/pod/pod-refusal.js";
import {
  AGENT_UNREACHABLE_BOUND_MS,
  agentPodKey,
  brokerClassOf,
  buildTransportEnv,
  isUnderSharedRoot,
  OWNER_ENSURE_DEADLINE_MS,
  OWNER_IF_POD_DEADLINE_MS,
  RELEASE_TOOLS_OPTIONAL,
  RELEASE_TOOLS_REQUIRED,
  resolveReleases,
  runRoutedCall,
  sweepRoutedPayloads,
  transportRefusalReason,
  type AgentPodLookup,
  type RoutedCallOptions,
  type RoutedClass,
} from "../src/pod/routed-call.js";
import { startBroker } from "./pod-local-fake-broker.js";

// A6.0 — the routed call, caller side (C2, C4 caller, C7.2 lines), against a STUB transport that
// implements exactly the agent-exec CLI of reports/TRANSPORT-INTERFACE.md with scripted outcomes.
// Lane T1 builds the real one; its gate row (the real transport against the loopback pod) is T1's.

const SESSION = "11111111-1111-4111-8111-111111111111";
const SEAT = "22222222-2222-4222-8222-222222222222";
const UID = "33333333-3333-4333-8333-333333333333";
const KEY = agentPodKey(SESSION);
const READY = `ready ip=10.1.2.3 pod=ag-${KEY} uid=${UID} node=n1 placement=pool`;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "a6-routed-"));

type StubScript = {
  exit?: number;
  stdout?: string;
  stderr?: string;
  signal?: string;
};
type StubCall = {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  payload?: { path: string; mode: number; content: string };
};

const STUB_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const script = JSON.parse(fs.readFileSync(path.join(dir, "script.json"), "utf8"));
const calls = path.join(dir, "calls.json");
const all = fs.existsSync(calls) ? JSON.parse(fs.readFileSync(calls, "utf8")) : [];
const argv = process.argv.slice(2);
const at = argv.indexOf("--payload");
let payload;
if (at >= 0) {
  const p = argv[at + 1];
  payload = fs.existsSync(p) ? { path: p, mode: fs.statSync(p).mode & 0o777, content: fs.readFileSync(p, "utf8") } : { path: p, mode: -1, content: "" };
}
all.push({ argv, env: process.env, cwd: process.cwd(), stdin: fs.readlinkSync("/proc/self/fd/0"), payload });
fs.writeFileSync(calls, JSON.stringify(all));
if (script.stderr) process.stderr.write(script.stderr);
if (script.stdout) process.stdout.write(script.stdout);
if (script.signal) process.kill(process.pid, script.signal);
process.exitCode = script.exit ?? 0;
`;

type Stub = {
  path: string;
  dir: string;
  calls(): StubCall[];
  script(s: StubScript): void;
  payloadDir: string;
};

function makeStub(script: StubScript = {}): Stub {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, "stub-"));
  const stubPath = path.join(dir, "agent-exec");
  fs.writeFileSync(stubPath, STUB_SOURCE, { mode: 0o755 });
  const payloadDir = path.join(dir, "routed");
  const stub: Stub = {
    path: stubPath,
    dir,
    payloadDir,
    calls: () => {
      const file = path.join(dir, "calls.json");
      return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as StubCall[]) : [];
    },
    script: (s) => fs.writeFileSync(path.join(dir, "script.json"), JSON.stringify(s)),
  };
  stub.script(script);
  return stub;
}

class Sink extends Writable {
  text = "";
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString("utf8");
    cb();
  }
}

const PRESENT: AgentPodLookup = async () => ({
  state: "exists",
  uid: UID,
  ready: true,
  readyAtMs: Date.now(),
});
const ABSENT: AgentPodLookup = async () => ({ state: "absent" });

function baseOptions(
  stub: Stub,
  overrides: Partial<RoutedCallOptions> = {},
): RoutedCallOptions & {
  out: Sink;
  err: Sink;
} {
  const out = new Sink();
  const err = new Sink();
  return {
    class: "owner-if-pod",
    key: KEY,
    target: { sessionId: SESSION, seat: SEAT, harness: "claude" },
    argv: ["sessions", "close", SESSION],
    cwd: "/workspace",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/home/node" },
    lookup: PRESENT,
    callId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    stdout: out,
    stderr: err,
    transportPath: stub.path,
    payloadDir: stub.payloadDir,
    out,
    err,
    ...overrides,
  };
}

async function expectRefusal(promise: Promise<unknown>): Promise<CapacityRefusedError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(
    caught instanceof CapacityRefusedError,
    `expected a capacity refusal, got ${String(caught)}`,
  );
  return caught;
}

async function expectRouted(promise: Promise<unknown>): Promise<RoutedCallError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(caught instanceof RoutedCallError, `expected a RoutedCallError, got ${String(caught)}`);
  return caught;
}

function flag(call: StubCall, name: string): string | undefined {
  const at = call.argv.indexOf(name);
  return at >= 0 ? call.argv[at + 1] : undefined;
}

// ───────────────────────── the call as the transport receives it ─────────────────────────

test("call: the transport gets key, call id, contract, deadline, expected uid, then `--` and the argv verbatim; stdin is /dev/null; cwd is the caller's", async () => {
  const stub = makeStub({ exit: 0, stdout: "ok\n" });
  const options = baseOptions(stub, {
    argv: ["sessions", "close", "a b", "--x=$HOME"],
    cwd: "/workspace/projects",
  });
  const before = Date.now();
  const result = await runRoutedCall(options);
  assert.deepEqual(result, { kind: "completed", exitCode: 0, callId: options.callId });
  const [call] = stub.calls();
  assert.ok(call);
  assert.equal(flag(call, "--key"), KEY);
  assert.equal(flag(call, "--call-id"), options.callId);
  assert.equal(flag(call, "--contract"), "1");
  assert.equal(
    flag(call, "--expect-uid"),
    UID,
    "the transport always gets the uid the caller expects",
  );
  const deadline = Number(flag(call, "--deadline-ms"));
  assert.ok(
    deadline >= before + OWNER_IF_POD_DEADLINE_MS &&
      deadline <= Date.now() + OWNER_IF_POD_DEADLINE_MS,
  );
  assert.deepEqual(call.argv.slice(call.argv.indexOf("--") + 1), [
    "sessions",
    "close",
    "a b",
    "--x=$HOME",
  ]);
  assert.equal(call.cwd, "/workspace/projects");
  assert.equal(call.stdin, "/dev/null");
  assert.equal(call.payload, undefined, "no payload flag without a payload");
  assert.equal(options.out.text, "ok\n");
});

test("deadlines by class: owner-ensure 45 s, owner-if-pod 20 s, one-shot the caller's own", async () => {
  assert.equal(OWNER_ENSURE_DEADLINE_MS, 45_000);
  assert.equal(OWNER_IF_POD_DEADLINE_MS, 20_000);
  const stub = makeStub();
  await runRoutedCall(
    baseOptions(stub, { class: "one-shot", key: "util-pool", expectUid: UID, deadlineMs: 7_000 }),
  );
  const [call] = stub.calls();
  assert.ok(call);
  const delta = Number(flag(call, "--deadline-ms")) - Date.now();
  assert.ok(delta > 5_000 && delta <= 7_000, `one-shot deadline is its own: ${delta}`);
  // Negative: a one-shot without a deadline of its own, or without the pod's uid, is a programming error — never defaulted.
  await assert.rejects(
    runRoutedCall(baseOptions(stub, { class: "one-shot", key: "util-pool", expectUid: UID })),
  );
  await assert.rejects(
    runRoutedCall(baseOptions(stub, { class: "one-shot", key: "util-pool", deadlineMs: 5_000 })),
  );
});

test("cwd: under a shared root, or refused with nothing run — never re-rooted", async () => {
  for (const ok of [
    "/workspace",
    "/workspace/a/b",
    "/wisdom/Bricks",
    "/spaces/nativai/x",
    "/opt/atrium-os/current",
    "/home/node/.acpx/routed",
  ]) {
    assert.equal(isUnderSharedRoot(ok), true, ok);
  }
  for (const bad of [
    "/tmp",
    "/home/node",
    "/workspaceX",
    "/workspace/../etc",
    "relative/path",
    "/",
    "/opt/acpx-ui",
    "/home/node/.acpxx",
  ]) {
    assert.equal(isUnderSharedRoot(bad), false, bad);
  }
  const stub = makeStub();
  const error = await expectRouted(runRoutedCall(baseOptions(stub, { cwd: "/tmp/elsewhere" })));
  assert.equal(
    error.stderrLine,
    `acpx: ROUTED outcome=not_run reason=cwd_not_shared call_id=cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
  );
  assert.equal(stub.calls().length, 0, "nothing was sent");
});

// ───────────────────────── nothing else of the caller's environment travels ─────────────────────────

const FORBIDDEN_CLASSES: Record<string, Record<string, string>> = {
  credentials: {
    ANTHROPIC_API_KEY: "sk-secret",
    GH_TOKEN: "ghp_secret",
    AWS_SECRET_ACCESS_KEY: "aws",
    OPENROUTER_API_KEY: "or",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
  },
  "the caller's own routed values": {
    ACPX_ROUTED: "1",
    ACPX_ROUTED_CONTRACT: "9",
    ACPX_ROUTED_CALL_ID: "forged",
    ACPX_ROUTED_DEADLINE_MS: "1",
    ACPX_ROUTED_PAYLOAD: "/etc/passwd",
  },
  "acpx settings and state": {
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_STATE_HOME: "/tmp/other-home",
    ACPX_SUBSCRIPTION: "sub9",
    ACPX_UI_BASE_URL: "http://x",
    ATRIUM_OS: "/tmp/os",
  },
  "identity when no agent caused the call": {
    ACPX_SESSION_URL: "https://x/?session=1",
    ACPX_SEAT_URL: "https://x/?seat=1",
    ACPX_SESSION_RECORD_ID: "rec",
    ACPX_PARENT_SESSION_URL: "p",
    ACPX_PARENT_SEAT_URL: "p",
  },
  "the box and the shell": {
    NODE_OPTIONS: "--require /tmp/x.js",
    LD_PRELOAD: "/tmp/x.so",
    NV_DEV_SERVER_ROLE: "control",
    ACPX_AGENT_EXEC: "/tmp/not-this",
    BASH_ENV: "/tmp/b",
  },
};

for (const [name, vars] of Object.entries(FORBIDDEN_CLASSES)) {
  test(`env: nothing of the class "${name}" reaches the transport`, async () => {
    const stub = makeStub();
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/home/node", ...vars };
    await runRoutedCall(
      baseOptions(stub, { env, target: { sessionId: SESSION, seat: SEAT, harness: "claude" } }),
    );
    const [call] = stub.calls();
    assert.ok(call);
    for (const variable of Object.keys(vars)) {
      assert.equal(variable in call.env, false, `${variable} must not travel`);
    }
  });
}

test("env: exactly the per-call values that are the caller's to give — class, locked-by, identity when an agent caused the call", async () => {
  const stub = makeStub();
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: "/home/node",
    ACPX_LOCKED_BY: "atrium",
    ANTHROPIC_API_KEY: "x",
  };
  await runRoutedCall(
    baseOptions(stub, {
      env,
      target: { sessionId: SESSION, seat: SEAT, harness: "claude", admissionClass: "spawn" },
      callerIdentity: {
        ACPX_SESSION_URL: "https://h/?session=a",
        ACPX_SEAT_URL: "https://h/?seat=b",
        ACPX_SESSION_RECORD_ID: "a",
        ACPX_PARENT_SESSION_URL: "https://h/?session=p",
        ACPX_PARENT_SEAT_URL: "https://h/?seat=p",
        // @ts-expect-error — a name outside the C2 list is not even typeable
        ACPX_SOMETHING_ELSE: "no",
      },
    }),
  );
  const [call] = stub.calls();
  assert.ok(call);
  assert.deepEqual(Object.keys(call.env).toSorted(), [
    "ACPX_ADMISSION_CLASS",
    "ACPX_LOCKED_BY",
    "ACPX_PARENT_SEAT_URL",
    "ACPX_PARENT_SESSION_URL",
    "ACPX_SEAT_URL",
    "ACPX_SESSION_RECORD_ID",
    "ACPX_SESSION_URL",
    "HOME",
    "PATH",
  ]);
  assert.equal(call.env.ACPX_ADMISSION_CLASS, "spawn");
  assert.equal(call.env.ACPX_LOCKED_BY, "atrium");
  // Negative: a name outside C2's list given as "identity" is dropped by the builder itself.
  const built = buildTransportEnv({
    env: {},
    callerIdentity: { ACPX_SOMETHING_ELSE: "no" } as never,
  });
  assert.deepEqual(built, {});
});

// ───────────────────────── payload ─────────────────────────

test("payload: temp + rename, 0600, named in --payload and in the argv, removed when the call returns", async () => {
  const stub = makeStub();
  const seenArgv: Array<string | undefined> = [];
  const prevUmask = process.umask(0o000);
  try {
    await runRoutedCall(
      baseOptions(stub, {
        class: "owner-if-pod",
        payload: "the prompt text — ünïcode",
        argv: (payloadPath) => {
          seenArgv.push(payloadPath);
          return ["prompt", "--file", payloadPath ?? "?"];
        },
      }),
    );
  } finally {
    process.umask(prevUmask);
  }
  const [call] = stub.calls();
  assert.ok(call?.payload);
  assert.equal(
    call.payload.path,
    path.join(stub.payloadDir, "cccccccc-cccc-4ccc-8ccc-cccccccccccc.payload"),
  );
  assert.equal(call.payload.mode, 0o600, "0600 even under a 000 umask");
  assert.equal(call.payload.content, "the prompt text — ünïcode");
  assert.equal(seenArgv[0], call.payload.path);
  assert.deepEqual(call.argv.slice(call.argv.indexOf("--") + 1), [
    "prompt",
    "--file",
    call.payload.path,
  ]);
  assert.deepEqual(fs.readdirSync(stub.payloadDir), [], "removed when the call returned");
});

test("payload: removed also when the call ends in a refusal or an unknown outcome", async () => {
  for (const script of [
    {
      exit: 75,
      stderr: "agent-exec: REFUSED reason=agent_ending command_not_run=true protocol=3\n",
    },
    { exit: 255 },
    { exit: 124 },
  ]) {
    const stub = makeStub(script);
    await assert.rejects(runRoutedCall(baseOptions(stub, { payload: "x" })));
    assert.equal(stub.calls().length, 1);
    assert.deepEqual(fs.readdirSync(stub.payloadDir), []);
  }
});

test("payload sweep: anything older than one hour goes; younger payloads and other files stay", () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, "sweep-"));
  const old = path.join(dir, "old.payload");
  const oldTemp = path.join(dir, "old2.payload.tmp-123");
  const young = path.join(dir, "young.payload");
  const other = path.join(dir, "notes.txt");
  for (const file of [old, oldTemp, young, other]) {
    fs.writeFileSync(file, "x");
  }
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
  fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
  fs.utimesSync(oldTemp, twoHoursAgo, twoHoursAgo);
  fs.utimesSync(other, twoHoursAgo, twoHoursAgo);
  sweepRoutedPayloads(dir, Date.now());
  assert.deepEqual(fs.readdirSync(dir).toSorted(), ["notes.txt", "young.payload"]);
  assert.doesNotThrow(() => sweepRoutedPayloads(path.join(dir, "missing"), Date.now()));
});

// ───────────────────────── C2's outcome table ─────────────────────────

test("outcome: the command's exit code, stdout and stderr pass through unchanged", async () => {
  const stub = makeStub({ exit: 3, stdout: "out\n", stderr: "line one\nline two\n" });
  const options = baseOptions(stub);
  assert.deepEqual(await runRoutedCall(options), {
    kind: "completed",
    exitCode: 3,
    callId: options.callId,
  });
  assert.equal(options.out.text, "out\n");
  assert.equal(options.err.text, "line one\nline two\n");
});

test("outcome: acpx's own refusal inside the pod (exit 75, `acpx: REFUSED …`) passes through byte-exact — it is the command's, not the transport's", async () => {
  const line =
    "acpx: REFUSED reason=cpu_pressure nothing_started=true protocol=1 retry_after_s=120 queued_ahead=0\nsecond line\n";
  const stub = makeStub({ exit: 75, stderr: line });
  const options = baseOptions(stub);
  assert.deepEqual(await runRoutedCall(options), {
    kind: "completed",
    exitCode: 75,
    callId: options.callId,
  });
  assert.equal(options.err.text, line);
});

test("outcome: 64 / 69 / 75 without the transport's refusal line is the command's own exit code", async () => {
  for (const exit of [64, 69, 75]) {
    const stub = makeStub({ exit, stderr: "something else entirely\n" });
    const options = baseOptions(stub);
    assert.equal((await runRoutedCall(options)).kind, "completed");
    assert.equal(options.err.text, "something else entirely\n");
  }
  // …and the transport's line with an exit code the transport never uses for it is not a refusal either.
  const stub = makeStub({
    exit: 1,
    stderr: "agent-exec: REFUSED reason=host_key command_not_run=true protocol=3\n",
  });
  assert.equal((await runRoutedCall(baseOptions(stub))).kind, "completed");
  assert.equal(
    transportRefusalReason(1, "agent-exec: REFUSED reason=host_key command_not_run=true"),
    undefined,
  );
  assert.equal(
    transportRefusalReason(
      69,
      "agent-exec: REFUSED reason=host_key command_not_run=true protocol=3",
    ),
    "host_key",
  );
  assert.equal(
    transportRefusalReason(69, "agent-exec: REFUSED reason=host_key"),
    undefined,
    "command_not_run=true is part of it",
  );
});

test("outcome: transport 64 / 69 → exit 1, `acpx: ROUTED outcome=not_run reason=<…> call_id=<…>`, nothing relayed", async () => {
  const cases: Array<[number, string]> = [
    [64, "cwd_not_shared"],
    [69, "host_key"],
    [69, "identity"],
    [69, "uid_mismatch"],
    // T1 fix round F-4: the pod cannot write its in-flight mark — a broken pod, so 69 (not 75): visible, not held.
    [69, "agent_state_unwritable"],
  ];
  for (const [exit, reason] of cases) {
    const stub = makeStub({
      exit,
      stderr: `agent-exec: REFUSED reason=${reason} command_not_run=true protocol=3\nremedy sentence\n`,
    });
    const options = baseOptions(stub);
    const error = await expectRouted(runRoutedCall(options));
    assert.equal(
      error.stderrLine,
      `acpx: ROUTED outcome=not_run reason=${reason} call_id=${options.callId}`,
    );
    assert.equal(options.err.text, "", "the transport's own lines are replaced, not relayed");
    assert.equal(exitCodeForOutputErrorCode(normalizeOutputError(error).code), 1);
  }
});

test("outcome: pod ending (75 agent_ending) and contract older than the call needs (69 contract) → pod_starting phase=turnover, exit 75", async () => {
  const cases: Array<[number, string]> = [
    [75, "agent_ending"],
    [69, "contract"],
  ];
  for (const [exit, reason] of cases) {
    const stub = makeStub({
      exit,
      stderr: `agent-exec: REFUSED reason=${reason} command_not_run=true protocol=3\n`,
    });
    const refusal = await expectRefusal(runRoutedCall(baseOptions(stub)));
    assert.equal(
      refusal.stderrLine,
      `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=3 phase=turnover wake=${SESSION}`,
    );
    assert.equal(exitCodeForOutputErrorCode(normalizeOutputError(refusal).code), 75);
    assert.equal(refusal.message.split("\n").length, 2, "token line, then one plain sentence");
  }
});

test("outcome: 124 / 255 → exit 1, `ROUTED outcome=unknown reason=<deadline|connection>`; a command's output before it does not go first", async () => {
  for (const [exit, reason] of [
    [124, "deadline"],
    [255, "connection"],
  ] as const) {
    const stub = makeStub({ exit, stderr: "partial line from the command\n" });
    const options = baseOptions(stub);
    const error = await expectRouted(runRoutedCall(options));
    assert.equal(
      error.stderrLine,
      `acpx: ROUTED outcome=unknown reason=${reason} call_id=${options.callId}`,
    );
    assert.equal(error.outcome, "unknown");
    assert.equal(options.err.text, "", "nothing written ahead of the ROUTED line");
  }
});

test("outcome: a transport killed by a signal is unknown, not a result", async () => {
  const stub = makeStub({ signal: "SIGKILL" });
  const error = await expectRouted(runRoutedCall(baseOptions(stub)));
  assert.equal(error.outcome, "unknown");
});

test("outcome: no transport at all → not_run reason=transport_unavailable", async () => {
  const stub = makeStub();
  const options = baseOptions(stub, { transportPath: path.join(stub.dir, "no-such-transport") });
  const error = await expectRouted(runRoutedCall(options));
  assert.equal(
    error.stderrLine,
    `acpx: ROUTED outcome=not_run reason=transport_unavailable call_id=${options.callId}`,
  );
});

test("AT MOST ONCE: no outcome re-sends — the transport runs exactly once for every kind of ending", async () => {
  const endings: StubScript[] = [
    { exit: 0 },
    { exit: 255 },
    { exit: 124 },
    {
      exit: 75,
      stderr: "agent-exec: REFUSED reason=agent_ending command_not_run=true protocol=3\n",
    },
    { exit: 69, stderr: "agent-exec: REFUSED reason=contract command_not_run=true protocol=3\n" },
    {
      exit: 75,
      stderr: "agent-exec: REFUSED reason=agent_unreachable command_not_run=true protocol=3\n",
    },
    { signal: "SIGKILL" },
  ];
  for (const script of endings) {
    const stub = makeStub(script);
    await runRoutedCall(baseOptions(stub)).catch(() => undefined);
    assert.equal(stub.calls().length, 1, JSON.stringify(script));
  }
});

// ───────────────────────── C2 amendment: agent_unreachable ─────────────────────────

const UNREACHABLE = {
  exit: 75,
  stderr: "agent-exec: REFUSED reason=agent_unreachable command_not_run=true protocol=3\n",
};

test("agent_unreachable inside the bound (counted from the pod's Ready) → pod_starting phase=starting retry_after_s=3", async () => {
  assert.equal(AGENT_UNREACHABLE_BOUND_MS, 60_000);
  const stub = makeStub(UNREACHABLE);
  const refusal = await expectRefusal(
    runRoutedCall(
      baseOptions(stub, {
        lookup: async () => ({
          state: "exists",
          uid: UID,
          ready: true,
          readyAtMs: Date.now() - 10_000,
        }),
      }),
    ),
  );
  assert.equal(
    refusal.stderrLine,
    `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=3 phase=starting wake=${SESSION}`,
  );
});

test("agent_unreachable past the bound → `ROUTED outcome=not_run reason=agent_unreachable`, exit 1 — never held for ever", async () => {
  const stub = makeStub(UNREACHABLE);
  const options = baseOptions(stub, {
    lookup: async () => ({
      state: "exists",
      uid: UID,
      ready: true,
      readyAtMs: Date.now() - AGENT_UNREACHABLE_BOUND_MS - 1_000,
    }),
  });
  const error = await expectRouted(runRoutedCall(options));
  assert.equal(
    error.stderrLine,
    `acpx: ROUTED outcome=not_run reason=agent_unreachable call_id=${options.callId}`,
  );
});

test("agent_unreachable with no Ready time known (a pod that already existed, API server gave none) counts as past the bound", async () => {
  const stub = makeStub(UNREACHABLE);
  const error = await expectRouted(
    runRoutedCall(
      baseOptions(stub, { lookup: async () => ({ state: "exists", uid: UID, ready: true }) }),
    ),
  );
  assert.equal(error.reason, "agent_unreachable");
});

test("agent_unreachable: the bound is counted from the API server's Ready time (A-1), never from the broker's `ready` line", async () => {
  // The broker's ready line is fresh (this call saw it), but the API server says the pod became Ready
  // two minutes ago: past the bound, so not_run — the broker line does not extend it.
  const broker = await startBroker({ lines: ["scheduling", READY] });
  try {
    let asked = 0;
    const lookup: AgentPodLookup = async () =>
      asked++ === 0
        ? { state: "absent" }
        : { state: "exists", uid: UID, ready: true, readyAtMs: Date.now() - 120_000 };
    const stub = makeStub(UNREACHABLE);
    const options = ensureOptions(stub, broker.origin, { lookup });
    const error = await expectRouted(runRoutedCall(options));
    assert.equal(error.reason, "agent_unreachable");
    assert.equal(asked, 2, "the pod's Ready time was read from the API server after the refusal");
  } finally {
    broker.close();
  }
  // And inside the bound by the API server's time → held as pod_starting phase=starting.
  const broker2 = await startBroker({ lines: [READY] });
  try {
    let asked = 0;
    const lookup: AgentPodLookup = async () =>
      asked++ === 0
        ? { state: "absent" }
        : { state: "exists", uid: UID, ready: true, readyAtMs: Date.now() - 5_000 };
    const refusal = await expectRefusal(
      runRoutedCall(ensureOptions(makeStub(UNREACHABLE), broker2.origin, { lookup })),
    );
    assert.match(refusal.stderrLine, /reason=pod_starting .* phase=starting wake=/);
  } finally {
    broker2.close();
  }
});

test("agent_unreachable: an API server that does not answer the Ready-time read counts as past the bound (never held for ever)", async () => {
  let asked = 0;
  const lookup: AgentPodLookup = async () =>
    asked++ === 0
      ? { state: "exists", uid: UID, ready: true, readyAtMs: Date.now() }
      : { state: "unknown" };
  const error = await expectRouted(runRoutedCall(baseOptions(makeStub(UNREACHABLE), { lookup })));
  assert.equal(error.reason, "agent_unreachable");
});

test("an unlisted reason on 64/69/75 stays `ROUTED outcome=not_run reason=<as given>` (interim for every other unknown reason)", async () => {
  for (const [exit, reason] of [
    [75, "agent_something_new"],
    [69, "brand_new"],
    [64, "odd"],
  ] as const) {
    const stub = makeStub({
      exit,
      stderr: `agent-exec: REFUSED reason=${reason} command_not_run=true protocol=3\n`,
    });
    const options = baseOptions(stub);
    const error = await expectRouted(runRoutedCall(options));
    assert.equal(
      error.stderrLine,
      `acpx: ROUTED outcome=not_run reason=${reason} call_id=${options.callId}`,
    );
  }
});

// ───────────────────────── classes and the broker (C1.2, C3.3 via a lookup, C4) ─────────────────────────

function ensureOptions(stub: Stub, origin: string, overrides: Partial<RoutedCallOptions> = {}) {
  return baseOptions(stub, {
    class: "owner-ensure" as RoutedClass,
    lookup: ABSENT,
    releases: { ok: true, releases: { acpx: "rel-1", pi: "rel-2" } },
    broker: { origin },
    argv: ["prompt", "--file", "-"],
    ...overrides,
  });
}

test("owner-ensure: no pod → the broker is asked (C4 body incl. releases), then the call goes to the uid the broker named", async () => {
  const broker = await startBroker({ lines: ["scheduling", READY] });
  try {
    const stub = makeStub({ exit: 0 });
    const options = ensureOptions(stub, broker.origin, {
      target: {
        sessionId: SESSION,
        seat: SEAT,
        harness: "pi",
        admissionClass: "spawn",
        sessionUrl: "https://h/?session=1",
        brick: "b1",
      },
    });
    assert.equal((await runRoutedCall(options)).kind, "completed");
    const body = JSON.parse(broker.seen[0]?.body ?? "{}") as Record<string, unknown>;
    assert.deepEqual(body, {
      contract: 1,
      sessionId: SESSION,
      seat: SEAT,
      harness: "pi",
      placement: "auto",
      class: "spawn",
      releases: { acpx: "rel-1", pi: "rel-2" },
      sessionUrl: "https://h/?session=1",
      brick: "b1",
    });
    const [call] = stub.calls();
    assert.equal(flag(call, "--expect-uid"), UID);
    const delta = Number(flag(call, "--deadline-ms")) - Date.now();
    assert.ok(delta > 40_000 && delta <= OWNER_ENSURE_DEADLINE_MS);
  } finally {
    broker.close();
  }
});

test("owner-ensure: a READY pod never touches the broker (C4: asked only when the API server shows no pod)", async () => {
  const broker = await startBroker({ lines: [READY] });
  try {
    const stub = makeStub();
    await runRoutedCall(ensureOptions(stub, broker.origin, { lookup: PRESENT }));
    assert.equal(broker.seen.length, 0);
    assert.equal(stub.calls().length, 1);
  } finally {
    broker.close();
  }
});

test("owner-ensure: an API server that does not answer → admission_busy, nothing asked, nothing sent", async () => {
  const broker = await startBroker({ lines: [READY] });
  try {
    const stub = makeStub();
    const refusal = await expectRefusal(
      runRoutedCall(
        ensureOptions(stub, broker.origin, { lookup: async () => ({ state: "unknown" }) }),
      ),
    );
    assert.match(
      refusal.stderrLine,
      /^acpx: REFUSED reason=admission_busy nothing_started=true protocol=1 /,
    );
    assert.equal(broker.seen.length, 0);
    assert.equal(stub.calls().length, 0);
  } finally {
    broker.close();
  }
});

test("owner-ensure: a broker that does not answer → admission_busy; nothing sent", async () => {
  const dead = await startBroker({});
  const origin = dead.origin;
  dead.close();
  const stub = makeStub();
  const refusal = await expectRefusal(runRoutedCall(ensureOptions(stub, origin)));
  assert.match(refusal.stderrLine, /reason=admission_busy/);
  assert.equal(stub.calls().length, 0);
});

test("owner-ensure: the pod is not ready within the wake bound → pod_starting with the phase and its retry_after_s", async () => {
  const phases: Array<[string, number]> = [
    ["scheduling", 3],
    ["starting", 3],
    ["pulling", 15],
    ["scaling-up", 60],
  ];
  for (const [phase, retry] of phases) {
    const broker = await startBroker({ lines: [phase], stall: true });
    try {
      const stub = makeStub();
      const refusal = await expectRefusal(
        runRoutedCall(
          ensureOptions(stub, broker.origin, {
            broker: { origin: broker.origin, wakeBoundMs: 1000 },
          }),
        ),
      );
      assert.equal(
        refusal.stderrLine,
        `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=${retry} phase=${phase} wake=${SESSION}`,
      );
      assert.equal(exitCodeForOutputErrorCode(normalizeOutputError(refusal).code), 75);
      assert.equal(stub.calls().length, 0, "nothing sent to a pod that is not ready");
    } finally {
      broker.close();
    }
  }
});

test("owner-ensure: the bound before any step → pod_starting phase=scheduling", async () => {
  const broker = await startBroker({ lines: [], stall: true });
  try {
    const stub = makeStub();
    const refusal = await expectRefusal(
      runRoutedCall(
        ensureOptions(stub, broker.origin, {
          broker: { origin: broker.origin, wakeBoundMs: 1000 },
        }),
      ),
    );
    assert.match(refusal.stderrLine, /phase=scheduling wake=/);
  } finally {
    broker.close();
  }
});

test("owner-ensure: refused by the broker → agent_cap with live/cap/box/why, retry_after_s=60", async () => {
  const cases: Array<[string, string]> = [
    ["agent_cap", "cap"],
    ["quota", "quota"],
    ["home_full", "home_full"],
  ];
  for (const [reason, why] of cases) {
    const broker = await startBroker({ lines: [`refused reason=${reason} live=99 cap=100`] });
    try {
      const stub = makeStub();
      const refusal = await expectRefusal(runRoutedCall(ensureOptions(stub, broker.origin)));
      assert.match(
        refusal.stderrLine,
        new RegExp(
          `^acpx: REFUSED reason=agent_cap nothing_started=true protocol=1 retry_after_s=60 live=99 cap=100 box=\\S+ why=${why} wake=${SESSION}$`,
        ),
      );
      assert.equal(stub.calls().length, 0);
    } finally {
      broker.close();
    }
  }
});

test("owner-ensure: the bound with the pool at its maximum → agent_cap why=pool-at-maximum, figures from GET /v1/agents; no figures → admission_busy", async () => {
  const agents = {
    live: 12,
    cap: 100,
    reserve: 1,
    quota: { used: 12, hard: 100 },
    home: { live: 0, cap: 4 },
    pool: { state: "at-max" },
  };
  const broker = await startBroker({
    lines: ["scaling-up", "pool-at-maximum"],
    stall: true,
    agents,
  });
  try {
    const stub = makeStub();
    const refusal = await expectRefusal(
      runRoutedCall(
        ensureOptions(stub, broker.origin, {
          broker: { origin: broker.origin, wakeBoundMs: 1000 },
        }),
      ),
    );
    assert.match(
      refusal.stderrLine,
      /reason=agent_cap .* live=12 cap=100 box=\S+ why=pool-at-maximum wake=/,
    );
  } finally {
    broker.close();
  }
  const noFigures = await startBroker({
    lines: ["pool-at-maximum"],
    stall: true,
    agents: { live: "x" },
  });
  try {
    const refusal = await expectRefusal(
      runRoutedCall(
        ensureOptions(makeStub(), noFigures.origin, {
          broker: { origin: noFigures.origin, wakeBoundMs: 1000 },
        }),
      ),
    );
    assert.match(refusal.stderrLine, /reason=admission_busy/);
  } finally {
    noFigures.close();
  }
});

test("owner-ensure: broker `error <reason>` and `too_big` are named failures (exit 1), nothing sent", async () => {
  for (const [line, reason] of [
    ["error unsupported_contract", "broker_unsupported_contract"],
    ["error template_rejected -- bad", "broker_template_rejected"],
    ["error start_failed", "broker_start_failed"],
    ["refused reason=too_big live=1 cap=2", "broker_too_big"],
  ] as const) {
    const broker = await startBroker({ lines: [line] });
    try {
      const stub = makeStub();
      const options = ensureOptions(stub, broker.origin);
      const error = await expectRouted(runRoutedCall(options));
      assert.equal(
        error.stderrLine,
        `acpx: ROUTED outcome=not_run reason=${reason} call_id=${options.callId}`,
      );
      assert.equal(stub.calls().length, 0);
    } finally {
      broker.close();
    }
  }
});

test("only owner-ensure may ask the broker: owner-if-pod and one-shot never do", async () => {
  const broker = await startBroker({ lines: [READY] });
  try {
    const stub = makeStub();
    await runRoutedCall(
      baseOptions(stub, {
        class: "owner-if-pod",
        lookup: PRESENT,
        broker: { origin: broker.origin },
      }),
    );
    await runRoutedCall(
      baseOptions(stub, {
        class: "one-shot",
        key: "util-home",
        expectUid: UID,
        deadlineMs: 5_000,
        broker: { origin: broker.origin },
      }),
    );
    assert.equal(broker.seen.length, 0);
    assert.equal(stub.calls().length, 2);
  } finally {
    broker.close();
  }
});

test("owner-if-pod: no pod → `no_pod` (answered from the record) with nothing sent; unknown → admission_busy", async () => {
  const stub = makeStub();
  assert.deepEqual(await runRoutedCall(baseOptions(stub, { lookup: ABSENT })), { kind: "no_pod" });
  assert.equal(stub.calls().length, 0);
  const refusal = await expectRefusal(
    runRoutedCall(baseOptions(stub, { lookup: async () => ({ state: "unknown" }) })),
  );
  assert.match(refusal.stderrLine, /reason=admission_busy/);
  assert.equal(stub.calls().length, 0);
});

test("owner-ensure: a required tool whose link cannot be resolved fails BEFORE the broker, naming it", async () => {
  const broker = await startBroker({ lines: [READY] });
  try {
    const stub = makeStub();
    const options = ensureOptions(stub, broker.origin, {
      releases: { ok: false, tool: "claude-agent-acp" },
    });
    const error = await expectRouted(runRoutedCall(options));
    assert.equal(
      error.stderrLine,
      `acpx: ROUTED outcome=not_run reason=release_unresolved tool=claude-agent-acp call_id=${options.callId}`,
    );
    assert.equal(exitCodeForOutputErrorCode(normalizeOutputError(error).code), 1);
    assert.equal(broker.seen.length, 0, "the broker was not called");
    assert.equal(stub.calls().length, 0);
    // A READY pod needs no releases at all: the failure belongs to the broker call only.
    await runRoutedCall(
      ensureOptions(stub, broker.origin, {
        lookup: PRESENT,
        releases: { ok: false, tool: "acpx" },
      }),
    );
    assert.equal(stub.calls().length, 1);
  } finally {
    broker.close();
  }
});

// ───────────────────────── small pieces ─────────────────────────

test("agentPodKey: first 24 hex of the SHA-256 of the session id (the lease key)", () => {
  assert.match(KEY, /^[0-9a-f]{24}$/);
  assert.equal(agentPodKey("a"), "ca978112ca1bbdcafac231b3");
});

test("brokerClassOf: a person (interactive, or undeclared) is interactive; an agent's delivery is spawn; spawn and automation as declared; a one-shot is utility", () => {
  assert.equal(brokerClassOf("spawn", "owner-ensure"), "spawn");
  assert.equal(brokerClassOf("automation", "owner-ensure"), "automation");
  assert.equal(brokerClassOf("interactive", "owner-ensure"), "interactive");
  // Negative: an agent's delivery must NOT pass the reserve that exists so a person can always get a pod.
  assert.equal(brokerClassOf("delivery", "owner-ensure"), "spawn");
  assert.equal(brokerClassOf(undefined, "owner-ensure"), "interactive");
  assert.equal(brokerClassOf("spawn", "one-shot"), "utility");
});

test("releases (C9): the directory name each tool's link points to now; a missing or malformed required link is named", () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, "runtime-"));
  const required = ["acpx", "acpx-ui", "claude-agent-acp", "codex-acp", "claude-pty-acp", "pi-acp"];
  for (const tool of required) {
    fs.mkdirSync(path.join(dir, ".releases", tool, `${tool}-rel`), { recursive: true });
    fs.symlinkSync(`.releases/${tool}/${tool}-rel`, path.join(dir, tool));
  }
  const ok = resolveReleases(dir);
  assert.deepEqual(ok, {
    ok: true,
    releases: Object.fromEntries(required.map((t) => [t, `${t}-rel`])),
  });
  // pi-extensions is optional and joins when linked.
  fs.mkdirSync(path.join(dir, ".releases", "pi-extensions", "x1"), { recursive: true });
  fs.symlinkSync(".releases/pi-extensions/x1", path.join(dir, "pi-extensions"));
  assert.equal(
    (resolveReleases(dir) as { releases: Record<string, string> }).releases["pi-extensions"],
    "x1",
  );
  // Negative: a required tool that is a real directory (the in-place layout), not a link into .releases/<tool>/.
  fs.rmSync(path.join(dir, "codex-acp"));
  fs.mkdirSync(path.join(dir, "codex-acp"));
  assert.deepEqual(resolveReleases(dir), { ok: false, tool: "codex-acp" });
  // Negative: a link that points into another tool's releases.
  fs.rmSync(path.join(dir, "codex-acp"), { recursive: true });
  fs.symlinkSync(".releases/pi-acp/pi-acp-rel", path.join(dir, "codex-acp"));
  assert.deepEqual(resolveReleases(dir), { ok: false, tool: "codex-acp" });
  // Negative: a missing required link.
  fs.rmSync(path.join(dir, "codex-acp"));
  assert.deepEqual(resolveReleases(dir), { ok: false, tool: "codex-acp" });
});

test("deadline counts from the CALL START: a 20 s wake leaves a 25 s deadline in the per-call values", async () => {
  const broker = await startBroker({ lines: ["scheduling", READY] });
  try {
    const stub = makeStub();
    const base = 1_800_000_000_000;
    let reads = 0;
    // The first read is the call start; every later read is 20 s on (the wake took 20 s).
    const now = () => base + (reads++ === 0 ? 0 : 20_000);
    await runRoutedCall(ensureOptions(stub, broker.origin, { now }));
    const [call] = stub.calls();
    assert.ok(call);
    assert.equal(Number(flag(call, "--deadline-ms")), base + OWNER_ENSURE_DEADLINE_MS);
    assert.equal(Number(flag(call, "--deadline-ms")) - (base + 20_000), 25_000);
  } finally {
    broker.close();
  }
});

test("deadline: owner-if-pod counts its 20 s from the call start too", async () => {
  const stub = makeStub();
  const base = 1_800_000_000_000;
  let reads = 0;
  await runRoutedCall(baseOptions(stub, { now: () => base + (reads++ === 0 ? 0 : 5_000) }));
  const [call] = stub.calls();
  assert.ok(call);
  assert.equal(Number(flag(call, "--deadline-ms")), base + OWNER_IF_POD_DEADLINE_MS);
});

test("unknown outcome: the dropped partial stderr goes to the debug sink, never lost silently", async () => {
  const stub = makeStub({ exit: 255, stderr: "partial one\npartial two" });
  const seen: Array<{ callId: string; reason: string; stderr: string }> = [];
  const options = baseOptions(stub, { debug: (entry) => seen.push(entry) });
  await expectRouted(runRoutedCall(options));
  assert.deepEqual(seen, [
    { callId: options.callId ?? "", reason: "connection", stderr: "partial one\npartial two" },
  ]);
  // Negative: no sink handed in → the default log beside the payload directory gets the line.
  const stub2 = makeStub({ exit: 124, stderr: "late words\n" });
  await expectRouted(runRoutedCall(baseOptions(stub2)));
  const log = fs.readFileSync(path.join(stub2.dir, "routed-calls.log"), "utf8").trim();
  const entry = JSON.parse(log) as { reason: string; dropped_stderr: string };
  assert.equal(entry.reason, "deadline");
  assert.equal(entry.dropped_stderr, "late words\n");
  // A call that ends normally leaves nothing in it.
  const stub3 = makeStub({ exit: 0, stderr: "fine\n" });
  await runRoutedCall(baseOptions(stub3));
  assert.equal(fs.existsSync(path.join(stub3.dir, "routed-calls.log")), false);
});

test("releases (C9): ONLY pi-extensions may be left out; every other tool, absent, is named as unresolved", () => {
  assert.deepEqual([...RELEASE_TOOLS_OPTIONAL], ["pi-extensions"]);
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, "runtime-each-"));
  for (const tool of RELEASE_TOOLS_REQUIRED) {
    fs.mkdirSync(path.join(dir, ".releases", tool, "r"), { recursive: true });
    fs.symlinkSync(`.releases/${tool}/r`, path.join(dir, tool));
  }
  assert.equal(resolveReleases(dir).ok, true, "without pi-extensions it still resolves");
  for (const tool of RELEASE_TOOLS_REQUIRED) {
    fs.rmSync(path.join(dir, tool));
    assert.deepEqual(resolveReleases(dir), { ok: false, tool }, `${tool} absent`);
    fs.symlinkSync(`.releases/${tool}/r`, path.join(dir, tool));
  }
});

test("--address: the pod IP from the broker's ready line, or from the API lookup, goes to the transport; never a non-IP", async () => {
  const broker = await startBroker({ lines: [READY] });
  try {
    const stub = makeStub();
    await runRoutedCall(ensureOptions(stub, broker.origin));
    const [fromBroker] = stub.calls();
    assert.ok(fromBroker);
    assert.equal(flag(fromBroker, "--address"), "10.1.2.3");
  } finally {
    broker.close();
  }
  const stub2 = makeStub();
  await runRoutedCall(
    baseOptions(stub2, {
      lookup: async () => ({ state: "exists", uid: UID, ready: true, ip: "fd00::5" }),
    }),
  );
  assert.equal(flag(stub2.calls()[0], "--address"), "fd00::5");
  // Negatives: no IP known, or something that is not an IP (a hostname, a flag-looking string), is not passed.
  for (const ip of [undefined, "ag-x.ag.dev-devbox.svc", "--evil", "10.1.2", ""]) {
    const stub3 = makeStub();
    await runRoutedCall(
      baseOptions(stub3, { lookup: async () => ({ state: "exists", uid: UID, ready: true, ip }) }),
    );
    assert.equal(stub3.calls()[0]?.argv.includes("--address"), false, String(ip));
  }
});

test("transport lines beyond the table (T1): bad_request → not_run; 124 DEADLINE lines → unknown; a trailing TEST MODE line changes nothing", async () => {
  const stub = makeStub({
    exit: 64,
    stderr:
      "agent-exec: REFUSED reason=bad_request command_not_run=true protocol=1\nremedy\nagent-exec: TEST MODE target-config=/x (loopback agent pod only; never production)\n",
  });
  const options = baseOptions(stub);
  const error = await expectRouted(runRoutedCall(options));
  assert.equal(
    error.stderrLine,
    `acpx: ROUTED outcome=not_run reason=bad_request call_id=${options.callId}`,
  );
  for (const line of [
    "agent-exec: DEADLINE call_id=c command_not_run=true protocol=1\n",
    "agent-exec: DEADLINE call_id=c command_ended=true protocol=1\n",
    "partial output\nagent-exec: DEADLINE call_id=c client watchdog\n",
  ]) {
    const unknown = await expectRouted(
      runRoutedCall(baseOptions(makeStub({ exit: 124, stderr: line }))),
    );
    assert.equal(unknown.outcome, "unknown");
    assert.equal(unknown.reason, "deadline");
  }
});

test("C9: `pi` and `pi-home` are not in `releases` until IM4 moves pi into the release layout, even when linked", () => {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, "runtime-pi-"));
  for (const tool of [...RELEASE_TOOLS_REQUIRED, "pi", "pi-home"]) {
    fs.mkdirSync(path.join(dir, ".releases", tool, "r"), { recursive: true });
    fs.symlinkSync(`.releases/${tool}/r`, path.join(dir, tool));
  }
  const result = resolveReleases(dir);
  assert.equal(result.ok, true);
  const names = Object.keys((result as { releases: Record<string, string> }).releases);
  assert.equal(names.includes("pi"), false);
  assert.equal(names.includes("pi-home"), false);
});

test("A-10: a utility pod's POST carries neither seat nor sessionId; a session's carries both", async () => {
  const broker = await startBroker({ lines: [READY] });
  try {
    await runRoutedCall(
      ensureOptions(makeStub(), broker.origin, {
        key: "util-pool",
        target: { sessionId: SESSION, seat: SEAT, harness: "utility" },
      }),
    );
    const utility = JSON.parse(broker.seen[0]?.body ?? "{}") as Record<string, unknown>;
    assert.equal("seat" in utility, false);
    assert.equal("sessionId" in utility, false);
    assert.equal(utility.harness, "utility");
    await runRoutedCall(ensureOptions(makeStub(), broker.origin, { lookup: ABSENT }));
    const session = JSON.parse(broker.seen[1]?.body ?? "{}") as Record<string, unknown>;
    assert.equal(session.seat, SEAT);
    assert.equal(session.sessionId, SESSION);
  } finally {
    broker.close();
  }
});

test("C4 `error deleted`: the pod was deleted by a concurrent DELETE → pod_starting phase=turnover (exit 75), never retried inside acpx; a NEW call after the DELETE wakes a fresh pod", async () => {
  const broker = await startBroker({
    perPost: [
      ["scheduling", "error deleted"],
      ["scheduling", READY],
    ],
  });
  try {
    const stub = makeStub({ exit: 0, stdout: "woken\n" });
    const refusal = await expectRefusal(runRoutedCall(ensureOptions(stub, broker.origin)));
    assert.equal(
      refusal.stderrLine,
      `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=3 phase=turnover wake=${SESSION}`,
    );
    assert.equal(exitCodeForOutputErrorCode(normalizeOutputError(refusal).code), 75);
    assert.equal(
      broker.seen.filter((r) => r.method === "POST").length,
      1,
      "the request was not retried",
    );
    assert.equal(stub.calls().length, 0, "nothing was sent to a pod");
    // Atrium re-drives it as a NEW call (recover: DELETE answered, then a new POST): a fresh pod is woken.
    const options = ensureOptions(stub, broker.origin);
    assert.equal((await runRoutedCall(options)).kind, "completed");
    assert.equal(broker.seen.filter((r) => r.method === "POST").length, 2);
    assert.equal(stub.calls().length, 1);
    assert.equal(options.out.text, "woken\n");
  } finally {
    broker.close();
  }
});
