import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AcpxOperationalError, CapacityRefusedError } from "../src/errors.js";
import {
  admissionBusyRefusal,
  agentCapRefusal,
  podStartingRefusal,
  withoutQueuePromise,
} from "../src/pod/pod-refusal.js";
import { agentPodKey } from "../src/pod/routed-call.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { startFakeApiServer, type PodSeed } from "./pod-kit/fake-apiserver.js";
import { type BrokerScript, startFakeBroker } from "./pod-kit/fake-broker.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import {
  type Fixture,
  makeBox,
  recordPath,
  refusedUrl,
  runCli,
  sha256,
  startStubAtrium,
  writeAtriumJson,
} from "./umq-rig.js";

// brick ee9980e3 — "the message stays queued" must be true, or not said.
//
// On a pod-mode control pod every `prompt` is routed (`routed-ensure`) and never reaches atrium's message
// route. A refusal there (no room / pod on its way / broker silent) exits 75 and writes NOTHING. Only
// atrium's own delivery spawn (`--message-id`) has a holder, so only its sentence may promise a hold. Every
// other caller — a shell on the control pod, an ssh-remote script — is told plainly: NOT queued, NOT sent.
// The token line and the exit code are the wire format atrium and scripts parse: untouched, byte for byte.

const CLAUDE = "node /opt/claude-agent-acp/release-2/dist/index.js";
const CODEX = "node /opt/codex-acp/dist/index.js";
const SESSION = "5e55c0de-0000-4000-8000-0000000000e9";
const SEAT = "e9e9e9e9-1111-4111-8111-111111111111";
const MESSAGE_ID = "d00dfeed-0000-4000-8000-0000000000e9";
const UID = "33333333-3333-4333-8333-333333333333";
const KEY = agentPodKey(SESSION);

// What ea3f69f9 printed, token line and sentence — pinned as literals (the token must not move).
const BASE = {
  cap: {
    token: `acpx: REFUSED reason=agent_cap nothing_started=true protocol=1 retry_after_s=60 live=10 cap=10 box=devbox why=cap wake=${SESSION}`,
    old: "acpx: no agent pod can be started on this box now (10 of 10 in use; cap). Nothing was started; the message stays queued until room frees.",
    retry: 60,
  },
  home_full: {
    token: `acpx: REFUSED reason=agent_cap nothing_started=true protocol=1 retry_after_s=60 live=0 cap=10 box=devbox why=home_full wake=${SESSION}`,
    old: "acpx: no agent pod can be started on this box now (0 of 10 in use; home_full). Nothing was started; the message stays queued until room frees.",
    retry: 60,
  },
  pod_starting: {
    token: `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=3 phase=scheduling wake=${SESSION}`,
    old: "acpx: the session's agent pod is being placed on a machine. Nothing was run; the message stays queued and is delivered when the pod is ready.",
    retry: 3,
  },
  admission_busy: {
    token:
      "acpx: REFUSED reason=admission_busy nothing_started=true protocol=1 retry_after_s=5 queued_ahead=0",
    old: "acpx: the broker or the Kubernetes API server did not answer, so the session's agent pod could not be checked or started. Nothing was started; the message stays queued and is delivered when they answer.",
    retry: 5,
  },
} as const;
type Reason = keyof typeof BASE;
const REASONS = Object.keys(BASE) as Reason[];

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const script = JSON.parse(fs.readFileSync(path.join(dir, "script.json"), "utf8"));
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
if (script.stderr) process.stderr.write(script.stderr);
process.exitCode = script.exit ?? 0;
`;

type Shape = {
  reason: Reason;
  addressing: "session-id" | "seat";
  /** `shell`: a shell on the control pod. `ssh-remote`: what ssh-remote gives — no seat, locator or identity. */
  env: "shell" | "ssh-remote";
  messageId?: boolean;
  json?: boolean;
  /** Default `--no-wait`. */
  wait?: boolean;
  /** A session that is awake: its pod exists and is Ready; the transport answers `stub`. */
  woken?: { exit: number; stderr?: string };
  /** Replaces `prompt` (e.g. `cancel`, a routed-if-pod command). */
  verb?: string[];
};

function writeRecord(f: Fixture, command: string): void {
  const record = makeSessionRecord({
    acpxRecordId: SESSION,
    acpSessionId: `acp-${SESSION}`,
    agentCommand: command,
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
        created_at: "2026-11-24T10:00:00.000Z",
        active_holder_id: SESSION,
        next_ordinal: 2,
        closed_at: null,
      },
    }),
  );
}

function brokerScript(reason: Reason): { script: BrokerScript; wakeBoundMs?: number } {
  switch (reason) {
    case "cap":
      return {
        script: {
          status: { live: 10, cap: 10 },
          default: { final: { refused: { reason: "agent_cap", live: 10, cap: 10 } } },
        },
      };
    case "home_full":
      return {
        script: {
          status: { live: 0, cap: 10, home: { live: 0, cap: 0 } },
          default: { final: { refused: { reason: "home_full", live: 0, cap: 0 } } },
        },
      };
    case "pod_starting":
      return {
        script: { status: { live: 1, cap: 10 }, default: { steps: ["scheduling"], hang: true } },
        wakeBoundMs: 300,
      };
    default:
      // admission_busy: the broker never answers (the rig points the caller at a closed port).
      return { script: {} };
  }
}

async function run(shape: Shape) {
  const f = makeBox({ requestMib: 4000 });
  const command = shape.reason === "home_full" ? CODEX : CLAUDE;
  writeRecord(f, command);
  const sessionFile = recordPath(f, SESSION);
  const before = sha256(sessionFile);

  const { script, wakeBoundMs } = brokerScript(shape.reason);
  const broker = await startFakeBroker(script);
  const brokerUrl = shape.reason === "admission_busy" ? await refusedUrl() : broker.url;
  const stub = await startStubAtrium((request) => ({
    status: 202,
    body: {
      delivery_id: (request.body as { delivery_id?: string } | undefined)?.delivery_id,
      status: "queued",
    },
  }));
  writeAtriumJson(f, { internalUrl: stub.url });

  const pods: PodSeed[] = shape.woken
    ? [
        {
          name: `ag-${KEY}-abcde`,
          uid: UID,
          podIP: "10.9.8.7",
          readyTransitionTime: "2026-11-21T12:00:00Z",
          labels: { "workbench.nativai.de/session-key": KEY },
        },
      ]
    : [];
  const api = await startFakeApiServer({ namespace: "dev-devbox", token: "tok-1", pods });
  const sa = path.join(f.root, "serviceaccount");
  fs.mkdirSync(sa, { recursive: true });
  fs.writeFileSync(path.join(sa, "namespace"), "dev-devbox\n");
  fs.writeFileSync(path.join(sa, "token"), "tok-1\n");
  const stubDir = fs.mkdtempSync(path.join(f.root, "stub-"));
  fs.writeFileSync(path.join(stubDir, "agent-exec"), STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(stubDir, "script.json"), JSON.stringify(shape.woken ?? {}));
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
  const rig: NodeJS.ProcessEnv = {
    NODE_TEST_CONTEXT: "child",
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: f.root,
    ACPX_POD_SA_DIR: sa,
    ACPX_POD_API_URL: api.url,
    NV_POD_NAME: "dev-server-0",
    NV_POD_UID: "00000000-0000-0000-0000-000000000001",
    NV_NODE_NAME: "node-a",
    NV_AGENT_BROKER_URL: brokerUrl,
    ACPX_AGENT_EXEC: path.join(stubDir, "agent-exec"),
    ACPX_TEST_RUNTIME_DIR: runtime,
    ...(wakeBoundMs ? { ACPX_TEST_WAKE_BOUND_MS: String(wakeBoundMs) } : {}),
  };
  const env: NodeJS.ProcessEnv =
    shape.env === "shell"
      ? { ...f.env, ...rig }
      : {
          // ssh-remote: a login shell and nothing else of the caller — no seat, locator or identity variable.
          PATH: process.env.PATH,
          HOME: f.env.HOME,
          LANG: "C.UTF-8",
          ACPX_STATE_HOME: f.env.ACPX_STATE_HOME,
          ACPX_ADMISSION_DIR: f.env.ACPX_ADMISSION_DIR,
          ACPX_CAPACITY_PODINFO_DIR: f.env.ACPX_CAPACITY_PODINFO_DIR,
          ACPX_CAPACITY_CGROUP_ROOT: f.env.ACPX_CAPACITY_CGROUP_ROOT,
          ACPX_CAPACITY_PROC_ROOT: f.env.ACPX_CAPACITY_PROC_ROOT,
          ACPX_UI_INTERNAL_URL: "",
          ...rig,
        };

  const target = shape.addressing === "seat" ? ["--seat", SEAT] : ["--session-id", SESSION];
  const verb = shape.verb ?? [
    "prompt",
    ...target,
    ...(shape.wait ? [] : ["--no-wait"]),
    ...(shape.messageId ? ["--message-id", MESSAGE_ID] : []),
    "hello",
  ];
  const args = [
    ...(shape.json ? ["--format", "json"] : []),
    "--agent",
    command,
    "--approve-all",
    ...verb,
  ];
  const result = await runCli(args, env, "/workspace");
  const calls = (): string[][] => {
    const file = path.join(stubDir, "calls.jsonl");
    return fs.existsSync(file)
      ? fs
          .readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
      : [];
  };
  return {
    result,
    calls: calls(),
    atriumRequests: stub.requests.length,
    recordUnchanged: sha256(sessionFile) === before,
    close: async () => {
      await Promise.all([stub.close(), broker.close(), api.close()]);
    },
  };
}

type Out = Awaited<ReturnType<typeof run>>;
const QUEUE_PROMISE = /stays queued|will be queued|is queued|is delivered when/iu;
const lines = (text: string): string[] => text.split("\n").filter((line) => line.length > 0);

async function withRun<T>(shape: Shape, check: (out: Out) => T | Promise<T>): Promise<T> {
  const out = await run(shape);
  try {
    return await check(out);
  } finally {
    await out.close();
  }
}

function assertNothingHappened(out: Out, label: string): void {
  assert.equal(out.calls.length, 0, `${label}: nothing reached a pod`);
  assert.equal(out.atriumRequests, 0, `${label}: nothing was written to atrium either`);
  assert.equal(out.recordUnchanged, true, `${label}: the record is untouched`);
}

// ───────────────────────── G1: no promise without a holder, every reason × entry shape ─────────────────────────

for (const reason of REASONS) {
  test(`ee99 G1 · ${reason}: no hold is promised to a caller with no holder — shell and ssh-remote, --session-id and --seat; token line and exit unchanged`, async () => {
    for (const env of ["shell", "ssh-remote"] as const) {
      for (const addressing of ["session-id", "seat"] as const) {
        const label = `${reason}/${env}/${addressing}`;
        await withRun({ reason, env, addressing }, (out) => {
          const [token, ...sentence] = lines(out.result.stderr);
          assert.equal(out.result.code, 75, `${label}: ${out.result.stderr}`);
          assert.equal(
            token,
            BASE[reason].token,
            `${label}: the token line is byte-identical to ea3f69f9`,
          );
          const text = sentence.join("\n");
          assert.doesNotMatch(text, QUEUE_PROMISE, `${label}: a promise with no holder`);
          assert.match(text, /was NOT queued and NOT sent/u, label);
          assert.match(text, new RegExp(`again in about ${BASE[reason].retry} s`, "u"), label);
          assert.match(text, /send-message\.sh/u, label);
          assertNothingHappened(out, label);
        });
      }
    }
  });
}

test("ee99 G1 · the wait form (no --no-wait) is refused the same way — a waiter is never told the message waits", async () => {
  await withRun({ reason: "cap", env: "shell", addressing: "session-id", wait: true }, (out) => {
    assert.equal(out.result.code, 75, out.result.stderr);
    assert.equal(lines(out.result.stderr)[0], BASE.cap.token);
    assert.doesNotMatch(out.result.stderr, QUEUE_PROMISE);
    assert.match(out.result.stderr, /was NOT queued and NOT sent/u);
    assertNothingHappened(out, "wait");
  });
});

// ───────────────────────── G2: loud — the JSON form carries queued=false ─────────────────────────

test("ee99 G2 · the JSON form: exit 75, queued=false, the message says NOT queued, the token is the same on stderr and in tokenLine", async () => {
  for (const reason of REASONS) {
    await withRun({ reason, env: "ssh-remote", addressing: "session-id", json: true }, (out) => {
      assert.equal(out.result.code, 75, `${reason}: ${out.result.stderr}`);
      assert.equal(lines(out.result.stderr)[0], BASE[reason].token, reason);
      const error = (
        JSON.parse(lines(out.result.stdout).at(-1) ?? "{}") as {
          error?: { data?: { capacityRefusal?: Record<string, unknown>; tokenLine?: string } };
        }
      ).error;
      const detail = error?.data?.capacityRefusal;
      assert.ok(detail, `${reason}: error.data.capacityRefusal in ${out.result.stdout}`);
      assert.equal(detail.queued, false, reason);
      assert.equal(detail.tokenLine, BASE[reason].token, reason);
      assert.match(String(detail.message), /was NOT queued and NOT sent/u, reason);
      assert.doesNotMatch(String(detail.message), QUEUE_PROMISE, reason);
    });
  }
});

// ───────────────────────── G1' twin: atrium's delivery (--message-id) keeps today's sentence ─────────────────────────

test("ee99 G1' twin · a --message-id delivery (atrium holds it): sentence and token exactly as at ea3f69f9; JSON queued=true", async () => {
  for (const reason of REASONS) {
    await withRun({ reason, env: "shell", addressing: "session-id", messageId: true }, (out) => {
      assert.equal(out.result.code, 75, `${reason}: ${out.result.stderr}`);
      assert.deepEqual(lines(out.result.stderr), [BASE[reason].token, BASE[reason].old], reason);
      assertNothingHappened(out, `${reason}/message-id`);
    });
    await withRun(
      { reason, env: "shell", addressing: "session-id", messageId: true, json: true },
      (out) => {
        const text = out.result.stdout;
        assert.match(text, /"queued":\s*true/u, reason);
        assert.ok(
          text.includes(JSON.stringify(BASE[reason].old).slice(1, -1)),
          `${reason}: old sentence in json`,
        );
      },
    );
  }
});

// ───────────────────────── woken sessions ─────────────────────────

test("ee99 woken · a Ready pod takes the prompt (no refusal, so nothing to say): exactly one transport call, exit 0", async () => {
  await withRun(
    { reason: "cap", env: "shell", addressing: "session-id", woken: { exit: 0 } },
    (out) => {
      assert.equal(out.result.code, 0, out.result.stderr);
      assert.equal(out.calls.length, 1);
    },
  );
});

test("ee99 woken · a pod that is ending (turnover, pod_starting) is refused with NOT queued; with --message-id it keeps its promise", async () => {
  const ending = {
    exit: 75,
    stderr: "agent-exec: REFUSED reason=agent_ending command_not_run=true\nthe pod is ending\n",
  };
  const token = `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 retry_after_s=3 phase=turnover wake=${SESSION}`;
  for (const addressing of ["session-id", "seat"] as const) {
    await withRun({ reason: "cap", env: "ssh-remote", addressing, woken: ending }, (out) => {
      assert.equal(out.result.code, 75, out.result.stderr);
      const [first, ...rest] = lines(out.result.stderr);
      assert.equal(first, token);
      assert.doesNotMatch(rest.join("\n"), QUEUE_PROMISE);
      assert.match(rest.join("\n"), /was NOT queued and NOT sent/u);
      assert.equal(out.atriumRequests, 0);
    });
  }
  await withRun(
    { reason: "cap", env: "shell", addressing: "session-id", woken: ending, messageId: true },
    (out) => {
      assert.equal(out.result.code, 75, out.result.stderr);
      const [first, ...rest] = lines(out.result.stderr);
      assert.equal(first, token);
      assert.match(
        rest.join("\n"),
        /the message stays queued and is delivered when the pod is ready\.$/u,
      );
    },
  );
});

test("ee99 woken · a non-prompt routed call refused as pod_starting says `call`, not `message` (no message exists)", async () => {
  const ending = {
    exit: 75,
    stderr: "agent-exec: REFUSED reason=agent_ending command_not_run=true\nthe pod is ending\n",
  };
  await withRun(
    {
      reason: "cap",
      env: "shell",
      addressing: "session-id",
      woken: ending,
      verb: ["cancel", "--session-id", SESSION],
    },
    (out) => {
      assert.equal(out.result.code, 75, out.result.stderr);
      const text = lines(out.result.stderr).slice(1).join("\n");
      assert.match(text, /the call was NOT queued and NOT sent/u);
      assert.doesNotMatch(text, /the message was/u);
    },
  );
});

// ───────────────────────── G3: an atrium-held delivery is delivered exactly once when room frees ─────────────────────────

test("ee99 G3 · a refused delivery leaves no trace (record, atrium, pods): the same --message-id once room frees runs the turn exactly once", async () => {
  // Refused twice (atrium re-drives): still nothing happened — nothing a later delivery could double.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await withRun(
      { reason: "cap", env: "shell", addressing: "session-id", messageId: true },
      (out) => {
        assert.equal(out.result.code, 75);
        assertNothingHappened(out, `refused attempt ${attempt}`);
      },
    );
  }
  // Room frees: the same command with the same message id goes to the pod once, carrying that id once.
  await withRun(
    { reason: "cap", env: "shell", addressing: "session-id", messageId: true, woken: { exit: 0 } },
    (out) => {
      assert.equal(out.result.code, 0, out.result.stderr);
      assert.equal(out.calls.length, 1, "exactly one transport call");
      const argv = out.calls[0] ?? [];
      assert.equal(
        argv.filter((arg) => arg === MESSAGE_ID).length,
        1,
        "the message id travels exactly once",
      );
      assert.equal(argv[argv.indexOf("--message-id") + 1], MESSAGE_ID);
    },
  );
});

// ───────────────────────── withoutQueuePromise itself ─────────────────────────

test("withoutQueuePromise: rewrites exactly the three promising refusals; anything else is returned as it is; it is idempotent", () => {
  const promising = [
    agentCapRefusal({ live: 3, cap: 3, box: "b", why: "cap", wake: "w1" }),
    podStartingRefusal({ phase: "pulling", wake: "w1" }),
    admissionBusyRefusal(),
  ];
  for (const error of promising) {
    assert.equal(error.capacityRefusal.queued, true);
    const out = withoutQueuePromise(error, { prompt: true });
    assert.ok(out instanceof CapacityRefusedError);
    assert.notEqual(out, error);
    assert.equal(out.stderrLine, error.stderrLine, "token line untouched");
    assert.equal(out.capacityRefusal.retryAfterS, error.capacityRefusal.retryAfterS);
    assert.equal(out.capacityRefusal.queued, false);
    assert.doesNotMatch(out.message, QUEUE_PROMISE);
    assert.equal(
      withoutQueuePromise(out, { prompt: true }),
      out,
      "already NOT queued: returned as it is",
    );
  }
  const silent = [
    agentCapRefusal({ live: 3, cap: 3, box: "b", why: "waiting-line" }), // a create's refusal: no message waits
    agentCapRefusal({ live: 3, cap: 3, box: "b", why: "cap" }), // utility pod: no wake
    podStartingRefusal({ phase: "starting" }),
    admissionBusyRefusal({ utility: true }),
  ];
  for (const error of silent) {
    assert.equal(error.capacityRefusal.queued, undefined);
    assert.equal(withoutQueuePromise(error, { prompt: true }), error);
  }
  const other = new AcpxOperationalError("boom", { outputCode: "RUNTIME", origin: "cli" });
  assert.equal(withoutQueuePromise(other, { prompt: true }), other);
  assert.equal(withoutQueuePromise("text", { prompt: true }), "text");
});
