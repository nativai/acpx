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
  isReleaseName,
  resolveReleases,
  runRoutedCall,
  sweepRoutedPayloads,
  transportRefusalReason,
  type AgentPodLookup,
  type RoutedCallOptions,
  type RoutedClass,
} from "../src/pod/routed-call.js";
import { OPTIONAL_RELEASE_TOOLS } from "./pod-kit/fake-broker.js";
import { RELEASE_TOOLS, startFakeBroker } from "./pod-kit/fake-broker.js";
import { rawHttp } from "./pod-raw-http.js";

// A6.0 — the routed call, caller side (C2, C4 caller, C7.2 lines), against a STUB transport that
// implements exactly the agent-exec CLI of reports/TRANSPORT-INTERFACE.md with scripted outcomes.
// Lane T1 builds the real one; its gate row (the real transport against the loopback pod) is T1's.

const SESSION = "11111111-1111-4111-8111-111111111111";
const SEAT = "22222222-2222-4222-8222-222222222222";
const UID = "33333333-3333-4333-8333-333333333333";
const KEY = agentPodKey(SESSION);
const READY = `ready ip=10.1.2.3 pod=ag-${KEY} uid=${UID} node=n1 placement=pool`;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "a6-routed-"));
/** A `releases` the real broker accepts: every tool C9 names (the kit judges the body as `broker.py` does). */
const FULL_RELEASES: Record<string, string> = Object.fromEntries(
  RELEASE_TOOLS.map((tool) => [tool, "rel-1"]),
);

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
  await runRoutedCall(oneShotOptions(stub, { expectUid: UID, deadlineMs: 7_000 }));
  const [call] = stub.calls();
  assert.ok(call);
  const delta = Number(flag(call, "--deadline-ms")) - Date.now();
  assert.ok(delta > 5_000 && delta <= 7_000, `one-shot deadline is its own: ${delta}`);
  // Negative: a one-shot without a deadline of its own is a programming error — never defaulted.
  const { deadlineMs: _own, ...withoutDeadline } = oneShotOptions(stub, { expectUid: UID });
  await assert.rejects(runRoutedCall(withoutDeadline));
  // Negative: neither the pod's uid nor a lookup to find it by.
  await assert.rejects(runRoutedCall(oneShotOptions(stub, { lookup: undefined })));
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
  const broker = await startFakeBroker({ default: { steps: ["scheduling"], final: READY } });
  try {
    let asked = 0;
    const lookup: AgentPodLookup = async () =>
      asked++ === 0
        ? { state: "absent" }
        : { state: "exists", uid: UID, ready: true, readyAtMs: Date.now() - 120_000 };
    const stub = makeStub(UNREACHABLE);
    const options = ensureOptions(stub, broker.url, { lookup });
    const error = await expectRouted(runRoutedCall(options));
    assert.equal(error.reason, "agent_unreachable");
    assert.equal(asked, 2, "the pod's Ready time was read from the API server after the refusal");
  } finally {
    await broker.close();
  }
  // And inside the bound by the API server's time → held as pod_starting phase=starting.
  const broker2 = await startFakeBroker({ default: { final: READY } });
  try {
    let asked = 0;
    const lookup: AgentPodLookup = async () =>
      asked++ === 0
        ? { state: "absent" }
        : { state: "exists", uid: UID, ready: true, readyAtMs: Date.now() - 5_000 };
    const refusal = await expectRefusal(
      runRoutedCall(ensureOptions(makeStub(UNREACHABLE), broker2.url, { lookup })),
    );
    assert.match(refusal.stderrLine, /reason=pod_starting .* phase=starting wake=/);
  } finally {
    await broker2.close();
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
    releases: { ok: true, releases: FULL_RELEASES },
    broker: { origin },
    argv: ["prompt", "--file", "-"],
    ...overrides,
  });
}

/** A-7: a one-shot's target is a utility pod — no session, no seat (A-10). */
function oneShotOptions(stub: Stub, overrides: Partial<RoutedCallOptions> = {}) {
  return baseOptions(stub, {
    class: "one-shot",
    key: "util-pool",
    target: { sessionId: "", seat: "", harness: "utility" },
    deadlineMs: 5_000,
    argv: ["acpx", "exec", "hello"],
    releases: { ok: true, releases: FULL_RELEASES },
    ...overrides,
  });
}

test("owner-ensure: no pod → the broker is asked (C4 body incl. releases), then the call goes to the uid the broker named", async () => {
  const broker = await startFakeBroker({ default: { steps: ["scheduling"], final: READY } });
  try {
    const stub = makeStub({ exit: 0 });
    const options = ensureOptions(stub, broker.url, {
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
    const body = broker.requests[0]?.body ?? {};
    assert.deepEqual(body, {
      contract: 1,
      sessionId: SESSION,
      seat: SEAT,
      harness: "pi",
      placement: "auto",
      class: "spawn",
      releases: FULL_RELEASES,
      sessionUrl: "https://h/?session=1",
      brick: "b1",
    });
    const [call] = stub.calls();
    assert.equal(flag(call, "--expect-uid"), UID);
    const delta = Number(flag(call, "--deadline-ms")) - Date.now();
    assert.ok(delta > 40_000 && delta <= OWNER_ENSURE_DEADLINE_MS);
  } finally {
    await broker.close();
  }
});

test("owner-ensure: a READY pod never touches the broker (C4: asked only when the API server shows no pod)", async () => {
  const broker = await startFakeBroker({ default: { final: READY } });
  try {
    const stub = makeStub();
    await runRoutedCall(ensureOptions(stub, broker.url, { lookup: PRESENT }));
    assert.equal(broker.requests.length, 0);
    assert.equal(stub.calls().length, 1);
  } finally {
    await broker.close();
  }
});

test("owner-ensure: an API server that does not answer → admission_busy, nothing asked, nothing sent", async () => {
  const broker = await startFakeBroker({ default: { final: READY } });
  try {
    const stub = makeStub();
    const refusal = await expectRefusal(
      runRoutedCall(
        ensureOptions(stub, broker.url, { lookup: async () => ({ state: "unknown" }) }),
      ),
    );
    assert.match(
      refusal.stderrLine,
      /^acpx: REFUSED reason=admission_busy nothing_started=true protocol=1 /,
    );
    assert.equal(broker.requests.length, 0);
    assert.equal(stub.calls().length, 0);
  } finally {
    await broker.close();
  }
});

test("owner-ensure: a broker that does not answer → admission_busy; nothing sent", async () => {
  const dead = await startFakeBroker({});
  const origin = dead.url;
  await dead.close();
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
    const broker = await startFakeBroker({ default: { steps: [phase], hang: true } });
    try {
      const stub = makeStub();
      const refusal = await expectRefusal(
        runRoutedCall(
          ensureOptions(stub, broker.url, {
            broker: { origin: broker.url, wakeBoundMs: 1000 },
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
      await broker.close();
    }
  }
});

test("owner-ensure: the bound before any step → pod_starting phase=scheduling", async () => {
  const broker = await startFakeBroker({ default: { hang: true } });
  try {
    const stub = makeStub();
    const refusal = await expectRefusal(
      runRoutedCall(
        ensureOptions(stub, broker.url, {
          broker: { origin: broker.url, wakeBoundMs: 1000 },
        }),
      ),
    );
    assert.match(refusal.stderrLine, /phase=scheduling wake=/);
  } finally {
    await broker.close();
  }
});

test("owner-ensure: refused by the broker → agent_cap with live/cap/box/why, retry_after_s=60", async () => {
  const cases: Array<[string, string]> = [
    ["agent_cap", "cap"],
    ["quota", "quota"],
    ["home_full", "home_full"],
  ];
  for (const [reason, why] of cases) {
    const broker = await startFakeBroker({
      default: { final: `refused reason=${reason} live=99 cap=100` },
    });
    try {
      const stub = makeStub();
      const refusal = await expectRefusal(runRoutedCall(ensureOptions(stub, broker.url)));
      assert.match(
        refusal.stderrLine,
        new RegExp(
          `^acpx: REFUSED reason=agent_cap nothing_started=true protocol=1 retry_after_s=60 live=99 cap=100 box=\\S+ why=${why} wake=${SESSION}$`,
        ),
      );
      assert.equal(stub.calls().length, 0);
    } finally {
      await broker.close();
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
  const broker = await startFakeBroker({
    default: { steps: ["scaling-up", "pool-at-maximum"], hang: true },
    status: {
      live: agents.live,
      cap: agents.cap,
      reserve: agents.reserve,
      quota: agents.quota,
      home: agents.home,
      pool: agents.pool,
    },
  });
  try {
    const stub = makeStub();
    const refusal = await expectRefusal(
      runRoutedCall(
        ensureOptions(stub, broker.url, {
          broker: { origin: broker.url, wakeBoundMs: 1000 },
        }),
      ),
    );
    assert.match(
      refusal.stderrLine,
      /reason=agent_cap .* live=12 cap=100 box=\S+ why=pool-at-maximum wake=/,
    );
  } finally {
    await broker.close();
  }
  // A `GET /v1/agents` whose answer carries no usable figures — a shape the real broker never produces (it builds the
  // figures itself), so a raw row for acpx's own strictness.
  const noFigures = await rawHttp((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ live: "x" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("pool-at-maximum\n");
  });
  try {
    const refusal = await expectRefusal(
      runRoutedCall(
        ensureOptions(makeStub(), noFigures.url, {
          broker: { origin: noFigures.url, wakeBoundMs: 1000 },
        }),
      ),
    );
    assert.match(refusal.stderrLine, /reason=admission_busy/);
  } finally {
    noFigures.close();
  }
});

test("owner-ensure: broker `error <reason>` — a bad image (pull), a bad config/template, a failed start, an old contract — stays a named FINAL failure (exit 1, not_run), nothing sent (f8078700 N6 negative: only `too_big` became holdable)", async () => {
  for (const [line, reason] of [
    ["error unsupported_contract", "broker_unsupported_contract"],
    ["error template_rejected -- bad", "broker_template_rejected"],
    ["error start_failed", "broker_start_failed"],
    ["error image_pull_failed -- ErrImagePull", "broker_image_pull_failed"],
    ["error invalid_config -- bad env", "broker_invalid_config"],
  ] as const) {
    const broker = await startFakeBroker({ default: { final: line } });
    try {
      const stub = makeStub();
      const options = ensureOptions(stub, broker.url);
      const error = await expectRouted(runRoutedCall(options));
      assert.equal(
        error.stderrLine,
        `acpx: ROUTED outcome=not_run reason=${reason} call_id=${options.callId}`,
      );
      assert.equal(error.outcome, "not_run");
      assert.equal(stub.calls().length, 0);
    } finally {
      await broker.close();
    }
  }
});

test("owner-ensure: broker `refused reason=too_big` is HELD, never not_run — pod_starting phase=unfit, a long retry_after_s, exit 75, nothing sent (f8078700 C5 / N6)", async () => {
  const broker = await startFakeBroker({
    default: { final: "refused reason=too_big live=1 cap=2" },
  });
  try {
    const stub = makeStub();
    const refusal = await expectRefusal(runRoutedCall(ensureOptions(stub, broker.url)));
    assert.equal(
      refusal.stderrLine,
      `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=300 phase=unfit wake=${SESSION}`,
    );
    assert.equal(exitCodeForOutputErrorCode(normalizeOutputError(refusal).code), 75);
    assert.equal(refusal.capacityRefusal.nothingStarted, true);
    assert.equal(refusal.capacityRefusal.reason, "pod_starting");
    assert.equal(refusal.capacityRefusal.retryAfterS, 300);
    assert.equal(stub.calls().length, 0, "nothing sent to a pod that cannot be placed");
  } finally {
    await broker.close();
  }
});

test("a utility pod that is too_big is held too — pod_starting phase=unfit WITHOUT `wake=` (no message waits for it), exit 75", async () => {
  const broker = await startFakeBroker({
    default: { final: "refused reason=too_big live=0 cap=2" },
  });
  try {
    const stub = makeStub();
    const refusal = await expectRefusal(
      runRoutedCall(
        oneShotOptions(stub, { lookup: ABSENT, broker: { origin: broker.url, wakeBoundMs: 500 } }),
      ),
    );
    assert.equal(
      refusal.stderrLine,
      "acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=300 phase=unfit",
    );
    assert.equal(exitCodeForOutputErrorCode(normalizeOutputError(refusal).code), 75);
    assert.equal(stub.calls().length, 0);
  } finally {
    await broker.close();
  }
});

test("the broker is asked by owner-ensure for a session's pod, and by a one-shot for its utility pod only (A-7): owner-if-pod never, a one-shot that is handed its pod's uid never", async () => {
  const broker = await startFakeBroker({ default: { final: READY } });
  try {
    const stub = makeStub();
    await runRoutedCall(
      baseOptions(stub, {
        class: "owner-if-pod",
        lookup: PRESENT,
        broker: { origin: broker.url },
      }),
    );
    await runRoutedCall(
      oneShotOptions(stub, {
        key: "util-home",
        expectUid: UID,
        broker: { origin: broker.url },
      }),
    );
    // A READY utility pod needs no broker either: the API server answers first, as for a session's pod.
    await runRoutedCall(oneShotOptions(stub, { lookup: PRESENT, broker: { origin: broker.url } }));
    assert.equal(broker.requests.length, 0);
    assert.equal(stub.calls().length, 3);
  } finally {
    await broker.close();
  }
});

test("A-7: a one-shot with no utility pod starts it through the broker — no sessionId, no seat, class utility, the key's placement (never auto) — then runs in it", async () => {
  for (const [key, placement] of [
    ["util-pool", "pool"],
    ["util-home", "home"],
  ] as const) {
    // The kit's home cap is the real broker's default, 0: `util-home` is `home_full` unless the box has one.
    const broker = await startFakeBroker({
      default: { steps: ["scheduling"], final: READY },
      status: { home: { cap: 5 } },
    });
    try {
      const stub = makeStub({ exit: 0, stdout: "styles\n" });
      const options = oneShotOptions(stub, {
        key,
        lookup: ABSENT,
        broker: { origin: broker.url },
        target: { sessionId: "", seat: "", harness: "utility", admissionClass: "interactive" },
      });
      assert.deepEqual(await runRoutedCall(options), {
        kind: "completed",
        exitCode: 0,
        callId: options.callId,
      });
      const body = broker.requests[0]?.body ?? {};
      assert.equal(body.harness, "utility");
      assert.equal(body.class, "utility");
      assert.equal(body.placement, placement);
      assert.equal("sessionId" in body, false);
      assert.equal("seat" in body, false);
      assert.match(broker.requests[0]?.path ?? "", new RegExp(`/v1/agents/${key}$`));
      const [call] = stub.calls();
      assert.equal(flag(call, "--key"), key);
      assert.equal(flag(call, "--expect-uid"), UID, "the call goes to the uid the broker named");
    } finally {
      await broker.close();
    }
  }
});

test("A-7 (negative): a one-shot may start the utility pod and NOTHING else — a session's harness, a session's key, an unknown key are refused with nothing sent and the broker never asked; owner-ensure never reaches a utility pod", async () => {
  const broker = await startFakeBroker({ default: { final: READY } });
  try {
    const stub = makeStub();
    const refused = async (options: RoutedCallOptions) => {
      await assert.rejects(runRoutedCall(options), (error: Error) => {
        assert.equal(error.name, "UtilityScopeError");
        assert.match(
          error.message,
          /A-7: class one-shot may start the box's utility pod and nothing else/,
        );
        return true;
      });
    };
    const viaBroker = { lookup: ABSENT, broker: { origin: broker.url } };
    // a one-shot aimed at a SESSION's pod (the session's harness, a session's key)…
    await refused(
      oneShotOptions(stub, {
        ...viaBroker,
        target: { sessionId: SESSION, seat: SEAT, harness: "claude" },
      }),
    );
    await refused(oneShotOptions(stub, { ...viaBroker, key: KEY }));
    // …at a key that is not one of the two utility pods, even with a utility harness…
    await refused(oneShotOptions(stub, { ...viaBroker, key: "util-elsewhere" }));
    // …and even when it is handed a uid (no uid short-cut around the scope).
    await refused(oneShotOptions(stub, { ...viaBroker, key: KEY, expectUid: UID }));
    // The reverse: owner-ensure never starts a utility pod.
    await refused(
      ensureOptions(stub, broker.url, {
        key: "util-pool",
        target: { sessionId: SESSION, seat: SEAT, harness: "utility" },
      }),
    );
    await refused(ensureOptions(stub, broker.url, { key: "util-home" }));
    assert.equal(broker.requests.length, 0, "the broker was never asked");
    assert.equal(stub.calls().length, 0, "nothing was sent");
  } finally {
    await broker.close();
  }
});

test("A-7: a utility pod that is not ready within the wake bound is pod_starting WITHOUT `wake=` (no message waits for it), exit 75; a full box is agent_cap without `wake=`", async () => {
  const broker = await startFakeBroker({ default: { steps: ["pulling"], hang: true } });
  try {
    const stub = makeStub();
    const refusal = await expectRefusal(
      runRoutedCall(
        oneShotOptions(stub, {
          lookup: ABSENT,
          broker: { origin: broker.url, wakeBoundMs: 500 },
        }),
      ),
    );
    assert.equal(
      refusal.stderrLine,
      "acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=15 phase=pulling",
    );
    assert.equal(exitCodeForOutputErrorCode(normalizeOutputError(refusal).code), 75);
    assert.equal(stub.calls().length, 0);
  } finally {
    await broker.close();
  }
  const full = await startFakeBroker({
    default: { final: "refused reason=agent_cap live=7 cap=7" },
  });
  try {
    const refusal = await expectRefusal(
      runRoutedCall(
        oneShotOptions(makeStub(), {
          lookup: ABSENT,
          broker: { origin: full.url, wakeBoundMs: 500 },
        }),
      ),
    );
    assert.match(refusal.stderrLine, /^acpx: REFUSED reason=agent_cap .* why=cap$/);
    assert.equal(exitCodeForOutputErrorCode(normalizeOutputError(refusal).code), 75);
  } finally {
    await full.close();
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
  const broker = await startFakeBroker({ default: { final: READY } });
  try {
    const stub = makeStub();
    const options = ensureOptions(stub, broker.url, {
      releases: { ok: false, tool: "claude-agent-acp" },
    });
    const error = await expectRouted(runRoutedCall(options));
    assert.equal(
      error.stderrLine,
      `acpx: ROUTED outcome=not_run reason=release_unresolved tool=claude-agent-acp call_id=${options.callId}`,
    );
    assert.equal(exitCodeForOutputErrorCode(normalizeOutputError(error).code), 1);
    assert.equal(broker.requests.length, 0, "the broker was not called");
    assert.equal(stub.calls().length, 0);
    // A READY pod needs no releases at all: the failure belongs to the broker call only.
    await runRoutedCall(
      ensureOptions(stub, broker.url, {
        lookup: PRESENT,
        releases: { ok: false, tool: "acpx" },
      }),
    );
    assert.equal(stub.calls().length, 1);
  } finally {
    await broker.close();
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
  const required = [
    "acpx",
    "acpx-ui",
    "claude-agent-acp",
    "codex-acp",
    "claude-pty-acp",
    "pi",
    "pi-acp",
  ];
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

test("M1 F-B fix round 1: a one-shot's deadline counts from `startedAtMs` when the caller gives one (work before the call is the call's own) — and from the call start when it does not", async () => {
  const stub = makeStub();
  const startedAtMs = Date.now() - 4_000; // the caller's capacity read took 4 s before it called
  await runRoutedCall(oneShotOptions(stub, { expectUid: UID, deadlineMs: 7_000, startedAtMs }));
  const [call] = stub.calls();
  assert.ok(call);
  assert.equal(Number(flag(call, "--deadline-ms")), startedAtMs + 7_000);
  // Negative: without it the deadline is 7 s from NOW, i.e. later than the one above by the 4 s.
  const plain = makeStub();
  await runRoutedCall(oneShotOptions(plain, { expectUid: UID, deadlineMs: 7_000 }));
  const [other] = plain.calls();
  assert.ok(other);
  assert.ok(Number(flag(other, "--deadline-ms")) > startedAtMs + 7_000 + 3_000);
});

test("M1 F-B fix round 2: the broker's WAKE BOUND is what is left after the caller's work before the call (`startedAtMs`); without it the whole bound; never below zero", async () => {
  const hang = async (overrides: Partial<RoutedCallOptions>) => {
    const broker = await startFakeBroker({ default: { steps: ["scheduling"], hang: true } });
    try {
      const stub = makeStub();
      const t0 = Date.now();
      const refusal = await expectRefusal(
        runRoutedCall(
          oneShotOptions(stub, {
            lookup: ABSENT, // no Ready pod: the broker is asked
            broker: { origin: broker.url, wakeBoundMs: 1_500 },
            ...overrides,
          }),
        ),
      );
      // pod_starting once a step was seen; a bound spent to zero never hears one: the broker "did not answer"
      assert.match(refusal.stderrLine, /^acpx: REFUSED reason=(pod_starting|admission_busy) /);
      return Date.now() - t0;
    } finally {
      await broker.close();
    }
  };
  const spent = await hang({ startedAtMs: Date.now() - 1_000 }); // 1 s of the 1.5 s bound already spent
  assert.ok(spent < 1_200, `the bound left is ~0.5 s: ${spent}`);
  const whole = await hang({}); // negative: no clock start given → the whole bound
  assert.ok(whole >= 1_400, `without startedAtMs the whole bound: ${whole}`);
  const over = await hang({ startedAtMs: Date.now() - 5_000 }); // more spent than the bound: zero, not negative
  assert.ok(over < 1_000, `a spent bound ends the wait at once: ${over}`);
});

test("deadline counts from the CALL START: a 20 s wake leaves a 25 s deadline in the per-call values", async () => {
  const broker = await startFakeBroker({ default: { steps: ["scheduling"], final: READY } });
  try {
    const stub = makeStub();
    const base = 1_800_000_000_000;
    let reads = 0;
    // The first read is the call start; every later read is 20 s on (the wake took 20 s).
    const now = () => base + (reads++ === 0 ? 0 : 20_000);
    await runRoutedCall(ensureOptions(stub, broker.url, { now }));
    const [call] = stub.calls();
    assert.ok(call);
    assert.equal(Number(flag(call, "--deadline-ms")), base + OWNER_ENSURE_DEADLINE_MS);
    assert.equal(Number(flag(call, "--deadline-ms")) - (base + 20_000), 25_000);
  } finally {
    await broker.close();
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

/** A runtime directory with a release-shaped link for each tool in `tools`. */
function runtimeWith(tools: readonly string[]): string {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, "runtime-opt-"));
  for (const tool of tools) {
    fs.mkdirSync(path.join(dir, ".releases", tool, "r"), { recursive: true });
    fs.symlinkSync(`.releases/${tool}/r`, path.join(dir, tool));
  }
  return dir;
}

const ALL_TOOLS: string[] = [...RELEASE_TOOLS_REQUIRED, ...RELEASE_TOOLS_OPTIONAL];

test("releases (C9, A-40/A-41): the optional set is pi-extensions, pi and claude-pty-acp — each omitted when its link is absent, named when it resolves; every REQUIRED tool absent is named as unresolved", () => {
  assert.deepEqual([...RELEASE_TOOLS_OPTIONAL].toSorted(), [
    "claude-pty-acp",
    "pi",
    "pi-extensions",
  ]);
  assert.deepEqual([...RELEASE_TOOLS_REQUIRED].toSorted(), [
    "acpx",
    "acpx-ui",
    "claude-agent-acp",
    "codex-acp",
    "pi-acp",
  ]);
  // 40.1 / 41.1: each optional link absent on its own, and all three together, every other tool linked.
  const absences: string[][] = [
    ...RELEASE_TOOLS_OPTIONAL.map((tool): string[] => [tool]),
    [...RELEASE_TOOLS_OPTIONAL],
  ];
  for (const absent of absences) {
    const result = resolveReleases(runtimeWith(ALL_TOOLS.filter((tool) => !absent.includes(tool))));
    assert.equal(result.ok, true, `${absent.join("+")} absent still resolves`);
    const names = Object.keys((result as { releases: Record<string, string> }).releases);
    for (const tool of absent) {
      assert.equal(names.includes(tool), false, `${tool} is omitted`);
    }
    for (const tool of ALL_TOOLS.filter((t) => !absent.includes(t))) {
      assert.equal(names.includes(tool), true, `${tool} is still sent`);
    }
  }
  // Control: every link present → every optional tool is NAMED (optional, not dropped).
  const everything = resolveReleases(runtimeWith(ALL_TOOLS));
  assert.deepEqual(
    Object.keys((everything as { releases: Record<string, string> }).releases).toSorted(),
    [...ALL_TOOLS].toSorted(),
  );
  // Negative: a REQUIRED tool absent fails, named — one by one.
  for (const tool of RELEASE_TOOLS_REQUIRED) {
    assert.deepEqual(
      resolveReleases(runtimeWith(ALL_TOOLS.filter((t) => t !== tool))),
      { ok: false, tool },
      `${tool} absent`,
    );
  }
});

test("releases (A-40/A-41): a PRESENT optional link that is not release-shaped still fails the call, naming the tool", () => {
  for (const tool of RELEASE_TOOLS_OPTIONAL) {
    const others = ALL_TOOLS.filter((t) => t !== tool);
    // A real directory, not a link into .releases/<tool>/.
    const directory = runtimeWith(others);
    fs.mkdirSync(path.join(directory, tool));
    assert.deepEqual(resolveReleases(directory), { ok: false, tool }, `${tool}: a directory`);
    // A link into ANOTHER tool's releases.
    const foreign = runtimeWith(others);
    fs.symlinkSync(".releases/acpx/r", path.join(foreign, tool));
    assert.deepEqual(resolveReleases(foreign), { ok: false, tool }, `${tool}: a foreign link`);
    // A dangling-shape link (right place, wrong tool segment).
    const shaped = runtimeWith(others);
    fs.symlinkSync("somewhere/else", path.join(shaped, tool));
    assert.deepEqual(resolveReleases(shaped), { ok: false, tool }, `${tool}: not release-shaped`);
  }
});

// ⚠️ ROW 40.4 IS ONLY HALF CHECKED HERE: acpx's copy against the FAKE broker kit's (which carries the A-40/A-41
// set ahead of the real broker). The REAL broker's `OPTIONAL_RELEASE_TOOLS` (broker.py:558 at argocd db6f1050 is
// still `('pi-extensions',)`) and infra's link table stay OPEN for the integration gate.
test("the three copies of the optional set (row 40.4): acpx's equals the broker kit's — and a copy missing `pi` is caught, naming the copy and the tool", () => {
  const copies: Record<string, readonly string[]> = {
    "acpx RELEASE_TOOLS_OPTIONAL": RELEASE_TOOLS_OPTIONAL,
    "broker kit OPTIONAL_RELEASE_TOOLS": OPTIONAL_RELEASE_TOOLS,
  };
  const disagreements = (all: Record<string, readonly string[]>): string[] => {
    const union = [...new Set(Object.values(all).flat())].toSorted();
    return Object.entries(all).flatMap(([name, set]) =>
      union.filter((tool) => !set.includes(tool)).map((tool) => `${name} lacks ${tool}`),
    );
  };
  assert.deepEqual(disagreements(copies), []);
  // The check discriminates: one copy without `pi` is named.
  assert.deepEqual(
    disagreements({
      ...copies,
      "broker kit OPTIONAL_RELEASE_TOOLS": OPTIONAL_RELEASE_TOOLS.filter((tool) => tool !== "pi"),
    }),
    ["broker kit OPTIONAL_RELEASE_TOOLS lacks pi"],
  );
});

test("C9 (A-41): `pi` is OPTIONAL and is sent when its link resolves; `pi-home` is not a release tool and is never sent", () => {
  assert.ok((RELEASE_TOOLS_OPTIONAL as readonly string[]).includes("pi"));
  assert.equal((RELEASE_TOOLS_REQUIRED as readonly string[]).includes("pi"), false);
  const dir = runtimeWith([...ALL_TOOLS, "pi-home"]);
  const result = resolveReleases(dir);
  assert.equal(result.ok, true);
  const names = Object.keys((result as { releases: Record<string, string> }).releases);
  assert.equal(names.includes("pi"), true);
  assert.equal(names.includes("pi-home"), false);
});

test("a required tool that cannot be resolved (pi-acp) fails the call BEFORE the broker is asked, naming it", async () => {
  const broker = await startFakeBroker({ default: { final: READY } });
  try {
    const options = ensureOptions(makeStub(), broker.url, {
      releases: { ok: false, tool: "pi-acp" },
    });
    const error = await expectRouted(runRoutedCall(options));
    assert.equal(
      error.stderrLine,
      `acpx: ROUTED outcome=not_run reason=release_unresolved tool=pi-acp call_id=${options.callId}`,
    );
    assert.equal(broker.requests.length, 0);
  } finally {
    await broker.close();
  }
});

test("A-41: a Pi session whose `releases` lacks `pi` is refused at acpx's call, named, BEFORE the broker; a Claude, Codex or Pi-with-`pi` call is not", async () => {
  const { pi: _pi, ...fullWithoutPi } = FULL_RELEASES;
  const withoutPi = { ok: true as const, releases: fullWithoutPi };
  const withPi = { ok: true as const, releases: FULL_RELEASES };
  const broker = await startFakeBroker({ default: { final: READY } });
  try {
    const options = ensureOptions(makeStub(), broker.url, {
      target: { sessionId: SESSION, seat: SEAT, harness: "pi" },
      releases: withoutPi,
    });
    const error = await expectRouted(runRoutedCall(options));
    assert.equal(error.reason, "release_unresolved");
    assert.equal(
      error.stderrLine,
      `acpx: ROUTED outcome=not_run reason=release_unresolved tool=pi call_id=${options.callId}`,
    );
    assert.equal(broker.requests.length, 0, "the broker was never asked");
    // Controls: the same call is not refused when the harness is not pi, or when pi is named.
    for (const [harness, releases] of [
      ["claude", withoutPi],
      ["codex", withoutPi],
      ["pi", withPi],
    ] as const) {
      const before: number = broker.requests.length;
      await runRoutedCall(
        ensureOptions(makeStub(), broker.url, {
          target: { sessionId: SESSION, seat: SEAT, harness },
          releases,
        }),
      );
      assert.equal(broker.requests.length, before + 1, `${harness}: the broker was asked`);
    }
  } finally {
    await broker.close();
  }
});

test("A-10: a utility pod's POST carries neither seat nor sessionId; a session's carries both", async () => {
  const broker = await startFakeBroker({ default: { final: READY } });
  try {
    await runRoutedCall(
      oneShotOptions(makeStub(), {
        lookup: ABSENT,
        broker: { origin: broker.url },
        target: { sessionId: SESSION, seat: SEAT, harness: "utility" },
      }),
    );
    const utility = broker.requests[0]?.body ?? {};
    assert.equal("seat" in utility, false);
    assert.equal("sessionId" in utility, false);
    assert.equal(utility.harness, "utility");
    await runRoutedCall(ensureOptions(makeStub(), broker.url, { lookup: ABSENT }));
    const session = broker.requests[1]?.body ?? {};
    assert.equal(session.seat, SEAT);
    assert.equal(session.sessionId, SESSION);
  } finally {
    await broker.close();
  }
});

test("C4 `error deleted`: the pod was deleted by a concurrent DELETE → pod_starting phase=turnover (exit 75), never retried inside acpx; a NEW call after the DELETE wakes a fresh pod", async () => {
  const broker = await startFakeBroker({
    jobs: [
      { steps: ["scheduling"], final: "error deleted" },
      { steps: ["scheduling"], final: READY },
    ],
  });
  try {
    const stub = makeStub({ exit: 0, stdout: "woken\n" });
    const refusal = await expectRefusal(runRoutedCall(ensureOptions(stub, broker.url)));
    assert.equal(
      refusal.stderrLine,
      `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=3 phase=turnover wake=${SESSION}`,
    );
    assert.equal(exitCodeForOutputErrorCode(normalizeOutputError(refusal).code), 75);
    assert.equal(
      broker.requests.filter((r) => r.method === "POST").length,
      1,
      "the request was not retried",
    );
    assert.equal(stub.calls().length, 0, "nothing was sent to a pod");
    // Atrium re-drives it as a NEW call (recover: DELETE answered, then a new POST): a fresh pod is woken.
    const options = ensureOptions(stub, broker.url);
    assert.equal((await runRoutedCall(options)).kind, "completed");
    assert.equal(broker.requests.filter((r) => r.method === "POST").length, 2);
    assert.equal(stub.calls().length, 1);
    assert.equal(options.out.text, "woken\n");
  } finally {
    await broker.close();
  }
});

test("L-3: the wake bound covers the WHOLE ensure — pool-at-maximum with a `GET /v1/agents` that never answers is admission_busy WITHIN the bound, not after it", async () => {
  // A `GET /v1/agents` that never answers. A REAL shape under a slow kube API (up to three sequential 10 s kube calls
  // against acpx's 20 s bound); the kit has no delayed GET, so this row stays raw for THAT reason.
  const broker = await rawHttp((request, response) => {
    if (request.method === "GET") {
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("pool-at-maximum\n");
  });
  try {
    const started = Date.now();
    const refusal = await expectRefusal(
      runRoutedCall(
        ensureOptions(makeStub(), broker.url, {
          broker: { origin: broker.url, wakeBoundMs: 1000 },
        }),
      ),
    );
    const elapsed = Date.now() - started;
    assert.match(refusal.stderrLine, /^acpx: REFUSED reason=admission_busy /);
    assert.ok(
      elapsed < 1000 + 600,
      `answered at ${elapsed} ms, the bound is 1000 ms (the figures read used to run AFTER it)`,
    );
  } finally {
    broker.close();
  }
});

test("L-2: the admission_busy sentence of the pod plane names the broker and the API server — not the admission lock, never `nothing queued`", async () => {
  const refusal = await expectRefusal(
    runRoutedCall(baseOptions(makeStub(), { lookup: async () => ({ state: "unknown" }) })),
  );
  const [token, sentence] = refusal.message.split("\n");
  assert.match(
    token ?? "",
    /^acpx: REFUSED reason=admission_busy nothing_started=true protocol=1 /,
  );
  assert.match(sentence ?? "", /broker or the Kubernetes API server did not answer/);
  assert.doesNotMatch(sentence ?? "", /admission lock|creations|nothing was started or queued/i);
  assert.equal(refusal.message.split("\n").length, 2);
});

// ───────────────────────── A-46 (row 46.1): ONE release-name grammar ─────────────────────────

const REAL_NAMES = [
  `${"a".repeat(40)}-20261122T025946Z`,
  `${"0123456789abcdef".repeat(2)}01234567-20261122T025946Z-in-place`,
  "rel-1",
  "r",
  "a".repeat(128),
];
const BAD_NAMES = [
  ".",
  "..",
  ".hidden",
  "a/b",
  "a+b",
  "previous",
  "a".repeat(129),
  "",
  "-leading-dash",
  "../x",
  "x/..",
  "a b",
  "a\nb",
];

test("A-46 the grammar: every bootstrap name passes; `.`, `..`, hidden, separators, `+`, `previous`, 129 characters and the empty name never do", () => {
  for (const name of REAL_NAMES) {
    assert.equal(isReleaseName(name), true, name);
  }
  for (const name of BAD_NAMES) {
    assert.equal(isReleaseName(name), false, JSON.stringify(name));
  }
  assert.equal(isReleaseName(undefined), false);
  // `previous` is refused as a whole name only: it is fine inside a longer one.
  assert.equal(isReleaseName("previous-1"), true);
});

test("A-46 a control-pod link whose release name is bad fails resolveReleases, naming the tool — `.releases/pi/..` included; a real name resolves", () => {
  for (const tool of ["pi", "acpx", "claude-pty-acp"]) {
    for (const bad of BAD_NAMES.filter((name) => name !== "" && !name.includes("/"))) {
      const dir = runtimeWith(ALL_TOOLS.filter((t) => t !== tool));
      fs.symlinkSync(`.releases/${tool}/${bad}`, path.join(dir, tool));
      assert.deepEqual(
        resolveReleases(dir),
        { ok: false, tool },
        `${tool} → ${JSON.stringify(bad)}`,
      );
    }
    for (const real of REAL_NAMES) {
      const dir = runtimeWith(ALL_TOOLS.filter((t) => t !== tool));
      fs.symlinkSync(`.releases/${tool}/${real}`, path.join(dir, tool));
      const result = resolveReleases(dir) as { ok: true; releases: Record<string, string> };
      assert.equal(result.ok, true, real);
      assert.equal(result.releases[tool], real);
    }
  }
});

test("A-46 a `releases` that names a bad release for one tool is refused release_unresolved tool=<that tool> BEFORE the broker; with every name real, the broker is asked", async () => {
  const broker = await startFakeBroker({ default: { final: READY } });
  try {
    for (const bad of [".", "..", ".hidden", "a+b", "previous", "a".repeat(129)]) {
      const options = ensureOptions(makeStub(), broker.url, {
        releases: { ok: true, releases: { ...FULL_RELEASES, "claude-agent-acp": bad } },
      });
      const error = await expectRouted(runRoutedCall(options));
      assert.equal(error.reason, "release_unresolved", bad);
      assert.equal(
        error.stderrLine,
        `acpx: ROUTED outcome=not_run reason=release_unresolved tool=claude-agent-acp call_id=${options.callId}`,
      );
      assert.equal(broker.requests.length, 0, `${JSON.stringify(bad)}: the broker was never asked`);
    }
    for (const real of REAL_NAMES) {
      const before: number = broker.requests.length;
      await runRoutedCall(
        ensureOptions(makeStub(), broker.url, {
          releases: { ok: true, releases: { ...FULL_RELEASES, "claude-agent-acp": real } },
        }),
      );
      assert.equal(broker.requests.length, before + 1, `${real}: the broker was asked`);
      assert.deepEqual(
        broker.requests[before]?.problems,
        [],
        `${real}: the broker accepts the body`,
      );
    }
  } finally {
    await broker.close();
  }
});
