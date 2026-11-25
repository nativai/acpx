import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AcpxOperationalError } from "../src/errors.js";
import {
  admissionBusyRefusal,
  agentCapRefusal,
  podStartingRefusal,
  refusalForCaller,
  withHoldPromise,
} from "../src/pod/pod-refusal.js";
import { agentPodKey } from "../src/pod/routed-call.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { startFakeApiServer, type PodSeed } from "./pod-kit/fake-apiserver.js";
import { type BrokerScript, startFakeBroker } from "./pod-kit/fake-broker.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
import {
  agentStarts,
  type Fixture,
  makeBox,
  makeTarget,
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

const BATCH = JSON.stringify({
  v: 1,
  messages: [
    { messageId: "11111111-1111-4111-8111-aaaaaaaaaaaa", prompt: [{ type: "text", text: "one" }] },
    { messageId: "22222222-2222-4222-8222-bbbbbbbbbbbb", prompt: [{ type: "text", text: "two" }] },
  ],
});

type Shape = {
  reason: Reason;
  addressing: "session-id" | "seat";
  /** `shell`: a shell on the control pod. `ssh-remote`: what ssh-remote gives — no seat, locator or identity. */
  env: "shell" | "ssh-remote";
  messageId?: boolean;
  /** atrium's batch spawn: `--batch-file -` with two members on stdin; never `--message-id`. */
  batch?: boolean;
  json?: boolean;
  /** Default `--no-wait`. */
  wait?: boolean;
  /** A session that is awake: its pod exists and is Ready; the transport answers `stub`. */
  woken?: { exit: number; stderr?: string };
  /** Replaces `prompt` (e.g. `cancel`, a routed-if-pod command). */
  verb?: string[];
  /** Extra environment (e.g. an agent's identity and admission class). */
  extraEnv?: NodeJS.ProcessEnv;
  /** Use the rig's mock agent as the session's harness, so a start on the control pod is observable. */
  mockAgent?: boolean;
  /** atrium's runner sets the admission class on both its spawn shapes (ACPX_ADMISSION_CLASS, read once at start). */
  runnerClass?: boolean;
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
  const command = shape.mockAgent ? f.agent : shape.reason === "home_full" ? CODEX : CLAUDE;
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
    ...(shape.batch ? ["--batch-file", "-"] : ["hello"]),
  ];
  const args = [
    ...(shape.json ? ["--format", "json"] : []),
    "--agent",
    command,
    "--approve-all",
    ...verb,
  ];
  const result = await runCli(
    args,
    {
      ...env,
      ...(shape.runnerClass ? { ACPX_ADMISSION_CLASS: "delivery" } : {}),
      ...shape.extraEnv,
    },
    "/workspace",
    shape.batch ? BATCH : "",
  );
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
    brokerUrl,
    brokerRequests: broker.requests.length,
    agentStarts: agentStarts(f),
    admissionLog: (() => {
      const dir = path.join(f.root, "admission", "log");
      return fs.existsSync(dir)
        ? fs
            .readdirSync(dir)
            .map((name) => fs.readFileSync(path.join(dir, name), "utf8"))
            .join("")
        : "";
    })(),
    recordUnchanged: sha256(sessionFile) === before,
    recordText: fs.readFileSync(sessionFile, "utf8"),
    close: async () => {
      await Promise.all([stub.close(), broker.close(), api.close()]);
    },
  };
}

type Out = Awaited<ReturnType<typeof run>>;
const PROMPT = ["prompt", "--session-id", SESSION, "--no-wait", "hello"];
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
          error?: { data?: Record<string, unknown> };
        }
      ).error;
      const detail = error?.data;
      assert.ok(detail, `${reason}: error.data in ${out.result.stdout}`);
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
    await withRun(
      { reason, env: "shell", addressing: "session-id", messageId: true, runnerClass: true },
      (out) => {
        assert.equal(out.result.code, 75, `${reason}: ${out.result.stderr}`);
        assert.deepEqual(lines(out.result.stderr), [BASE[reason].token, BASE[reason].old], reason);
        assertNothingHappened(out, `${reason}/message-id`);
      },
    );
    await withRun(
      {
        reason,
        env: "shell",
        addressing: "session-id",
        messageId: true,
        runnerClass: true,
        json: true,
      },
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

test("ee99 G1' batch twin (79.2) · atrium's batch spawn (`--batch-file -`, never --message-id) keeps the hold sentence and queued=true — token identical to G1's; with room it is sent to the pod exactly once", async () => {
  for (const reason of REASONS) {
    await withRun(
      { reason, env: "shell", addressing: "session-id", batch: true, runnerClass: true },
      (out) => {
        assert.equal(out.result.code, 75, `${reason}: ${out.result.stderr}`);
        assert.deepEqual(lines(out.result.stderr), [BASE[reason].token, BASE[reason].old], reason);
        assertNothingHappened(out, `${reason}/batch`);
      },
    );
    await withRun(
      {
        reason,
        env: "shell",
        addressing: "session-id",
        batch: true,
        runnerClass: true,
        json: true,
      },
      (out) => {
        assert.match(out.result.stdout, /"queued":\s*true/u, reason);
        assert.ok(
          out.result.stdout.includes(JSON.stringify(BASE[reason].old).slice(1, -1)),
          reason,
        );
      },
    );
  }
  // "With room": a Ready pod. The same rig, per reason, first WITHOUT the pod (it must be refused with this
  // reason's own token — so the iteration really is that reason), then WITH it (sent to the pod exactly once).
  // admission_busy's rig is a broker that never answers (a closed port): a Ready pod must not need it.
  for (const reason of REASONS) {
    const shape: Shape = {
      reason,
      env: "shell",
      addressing: "session-id",
      batch: true,
      runnerClass: true,
    };
    await withRun(shape, (out) => {
      assert.equal(out.result.code, 75, `${reason}/no room: ${out.result.stderr}`);
      assert.equal(lines(out.result.stderr)[0], BASE[reason].token, `${reason}/no room: the token`);
    });
    await withRun({ ...shape, woken: { exit: 0 } }, async (out) => {
      assert.equal(out.result.code, 0, `${reason}/room: ${out.result.stderr}`);
      assert.equal(
        out.calls.length,
        1,
        `${reason}/room: the batch goes to the pod once; the owner delivers each member once by its id`,
      );
      assert.equal((out.calls[0] ?? []).filter((arg) => arg === "--batch-file").length, 1, reason);
      assert.equal(out.brokerRequests, 0, `${reason}/room: a Ready pod needs no broker`);
      assert.doesNotMatch(out.result.stderr, /REFUSED/u, `${reason}/room: nothing refused`);
      if (reason === "admission_busy") {
        await assert.rejects(
          fetch(out.brokerUrl),
          `${reason}/room: the broker really is silent (closed port)`,
        );
      }
    });
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
    {
      reason: "cap",
      env: "shell",
      addressing: "session-id",
      woken: ending,
      messageId: true,
      runnerClass: true,
    },
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
      // A-79 row 79.3: a command with no message names none — no message, no queue, no later delivery.
      assert.match(text, /Nothing was run; repeat the command after about 3 s\./u);
      assert.doesNotMatch(text, /queue|queued|message|send-message|deliver/iu);
    },
  );
});

// ───────────────────────── G3: an atrium-held delivery is delivered exactly once when room frees ─────────────────────────

test("ee99 G3 · a refused delivery leaves no trace (record, atrium, pods): the same --message-id once room frees runs the turn exactly once", async () => {
  // Refused twice (atrium re-drives): still nothing happened — nothing a later delivery could double.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await withRun(
      { reason: "cap", env: "shell", addressing: "session-id", messageId: true, runnerClass: true },
      (out) => {
        assert.equal(out.result.code, 75);
        assertNothingHappened(out, `refused attempt ${attempt}`);
      },
    );
  }
  // Room frees: the same command with the same message id goes to the pod once, carrying that id once.
  await withRun(
    {
      reason: "cap",
      env: "shell",
      addressing: "session-id",
      messageId: true,
      runnerClass: true,
      woken: { exit: 0 },
    },
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

// ───────────────────────── row 79.6: a mark passed by hand, without the runner's class ─────────────────────────

test("ee99 79.6 · a --message-id or --batch-file passed by hand (no ACPX_ADMISSION_CLASS) counts for nothing: no-holder sentence, queued=false; with the class set as the runner sets it, the hold stands (79.2's pair)", async () => {
  for (const reason of REASONS) {
    for (const mark of [{ messageId: true }, { batch: true }] as const) {
      const label = `${reason}/${Object.keys(mark)[0]}`;
      await withRun(
        { reason, env: "ssh-remote", addressing: "session-id", json: true, ...mark },
        (out) => {
          assert.equal(out.result.code, 75, `${label}: ${out.result.stderr}`);
          assert.equal(lines(out.result.stderr)[0], BASE[reason].token, label);
          const data = (
            JSON.parse(lines(out.result.stdout).at(-1) ?? "{}") as {
              error: { data: Record<string, unknown> };
            }
          ).error.data;
          assert.equal(data.queued, false, label);
          assert.match(String(data.message), /the message was NOT queued and NOT sent/u, label);
          assert.doesNotMatch(String(data.message), QUEUE_PROMISE, label);
          assertNothingHappened(out, label);
        },
      );
      await withRun(
        {
          reason,
          env: "ssh-remote",
          addressing: "session-id",
          json: true,
          runnerClass: true,
          ...mark,
        },
        (out) => {
          const data = (
            JSON.parse(lines(out.result.stdout).at(-1) ?? "{}") as {
              error: { data: Record<string, unknown> };
            }
          ).error.data;
          assert.equal(data.queued, true, `${label}: the same call with the runner's class`);
          assert.equal(data.message, BASE[reason].old, label);
        },
      );
    }
  }
});

test("ee99 79.6 · with room, the same hand-marked call is sent to the pod each time it is made (the transport never re-sends); the owner's one-message-per-id rule (stream-appenders: a duplicate --message-id is deduplicated) is what makes a repeat deliver once", async () => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await withRun(
      {
        reason: "cap",
        env: "shell",
        addressing: "session-id",
        messageId: true,
        woken: { exit: 0 },
      },
      (out) => {
        assert.equal(out.result.code, 0, out.result.stderr);
        assert.equal(out.calls.length, 1);
        assert.equal((out.calls[0] ?? []).filter((arg) => arg === MESSAGE_ID).length, 1);
      },
    );
  }
});

// ───────────────────────── refusalForCaller / builders ─────────────────────────

test("builders: a session's refusal DEFAULTS to the sentence that names no message and promises no hold (queued=false); withHoldPromise and refusalForCaller are the only ways to a promise; idempotent", () => {
  const defaults = [
    agentCapRefusal({ live: 3, cap: 3, box: "b", why: "cap", wake: "w1" }),
    podStartingRefusal({ phase: "pulling", wake: "w1" }),
    admissionBusyRefusal(),
  ];
  for (const error of defaults) {
    assert.equal(error.capacityRefusal.queued, false);
    const text = error.message.split("\n").slice(1).join("\n");
    assert.match(text, /repeat the command after about \d+ s\.$/u);
    assert.doesNotMatch(
      text,
      /queue|queued|message|send-message|deliver/iu,
      "no message, no queue, no later delivery",
    );
    const held = withHoldPromise(error);
    assert.equal(held.capacityRefusal.queued, true);
    assert.equal(held.stderrLine, error.stderrLine, "token line untouched");
    assert.match(held.message, /the message stays queued/u);
    assert.equal(withHoldPromise(held).message, held.message, "idempotent");
    // back to the default for a command with no message
    assert.equal(refusalForCaller(held, ["cancel", "--session-id", "x"]).message, error.message);
  }
  const silent = [
    agentCapRefusal({ live: 3, cap: 3, box: "b", why: "waiting-line" }), // a create's refusal
    agentCapRefusal({ live: 3, cap: 3, box: "b", why: "cap" }), // utility pod: no wake
    podStartingRefusal({ phase: "starting" }),
    admissionBusyRefusal({ utility: true }),
  ];
  for (const error of silent) {
    assert.equal(error.capacityRefusal.queued, undefined, "carries no queued");
    assert.equal(withHoldPromise(error), error);
    assert.equal(refusalForCaller(error, PROMPT, true), error);
  }
  const other = new AcpxOperationalError("boom", { outputCode: "RUNTIME", origin: "cli" });
  assert.equal(refusalForCaller(other, PROMPT), other);
  assert.equal(refusalForCaller("text", PROMPT), "text");
});

test("refusalForCaller: the hold needs a mark AND the runner's class, on a prompt; every other prompt is told NOT queued; a command with no message names none", () => {
  const error = podStartingRefusal({ phase: "turnover", wake: "w1" });
  const held = (argv: string[], hasClass: boolean) =>
    refusalForCaller(error, argv, hasClass).capacityRefusal.queued;
  for (const marked of [
    ["prompt", "--session-id", "x", "--message-id", "m", "hi"],
    ["prompt", "--session-id", "x", "--message-id=m", "hi"],
    ["prompt", "--session-id", "x", "--no-wait", "--batch-file", "-"],
    ["prompt", "--session-id", "x", "--batch-file=b.json"],
  ]) {
    assert.equal(held(marked, true), true, marked.join(" "));
    assert.equal(held(marked, false), false, `${marked.join(" ")} without the class`);
  }
  // negatives of the same shape: a mark after `--` is text; no mark at all; the class alone is no mark
  assert.equal(held(["prompt", "--session-id", "x", "--", "--message-id"], true), false);
  assert.equal(held(["prompt", "--session-id", "x", "--no-wait", "hi"], true), false);
  // a command with no message is never held by a mark, and names no message
  const none = refusalForCaller(error, ["cancel", "--session-id", "x", "--message-id", "m"], true);
  assert.equal(none.capacityRefusal.queued, false);
  assert.doesNotMatch(none.message.split("\n").slice(1).join("\n"), /message|queue|deliver/iu);
});

// ───────────────────────── row 79.5 (brick 7db5c780, F-R1): a pod-less `set` is answered from the record ─────────────────────────

const WAKE_CLASS_AGENT = {
  ACPX_SESSION_RECORD_ID: "caller-agent-session",
  ACPX_SESSION_URL: "https://atrium.example.test/?session=5e55c0de-0000-4000-8000-0000000000aa",
  ACPX_ADMISSION_CLASS: "spawn",
};

test("ee99 79.5 (7db5c780) · pod mode, a session whose pod is gone (record not sleeping), the broker at its cap: `set mode` / `set model` from a shell and from an agent with a wake class — exit 0, the request written to the record, no wake-gate decision, no adapter started, no refusal, nothing that promises a hold", async () => {
  for (const [who, extraEnv] of [
    ["shell", {}],
    ["agent with a wake class", WAKE_CLASS_AGENT],
  ] as const) {
    for (const verb of [
      ["set-mode", "plan"],
      ["set", "model", "x-model"],
    ]) {
      const label = `${who} / ${verb.join(" ")}`;
      await withRun(
        {
          reason: "cap",
          env: "shell",
          addressing: "session-id",
          mockAgent: true,
          verb: [...verb, "--session-id", SESSION],
          extraEnv,
        },
        (out) => {
          assert.equal(out.result.code, 0, `${label}: ${out.result.stderr}`);
          assert.equal(
            out.admissionLog,
            "",
            `${label}: no wake-gate decision (not even a log line)`,
          );
          assert.equal(out.agentStarts, 0, `${label}: no adapter started on the control pod`);
          assert.doesNotMatch(
            out.result.stderr,
            /REFUSED|bridge_on_control_pod|queued|agent_cap/u,
            label,
          );
          assert.equal(out.atriumRequests, 0, label);
          assert.equal(out.calls.length, 0, `${label}: nothing reached a pod either`);
          assert.equal(
            out.recordUnchanged,
            false,
            `${label}: the request is written to the record`,
          );
          const record = JSON.parse(out.recordText) as { acpx?: Record<string, unknown> };
          const pinned = JSON.stringify(record.acpx ?? {});
          assert.match(
            pinned,
            verb[0] === "set-mode" ? /desired_mode_id/u : /desired_model_id|x-model/u,
            label,
          );
        },
      );
    }
  }
});

test("ee99 79.5 pair · the same `set` on a session whose pod LIVES is routed into the pod (one transport call), as before", async () => {
  await withRun(
    {
      reason: "cap",
      env: "shell",
      addressing: "session-id",
      woken: { exit: 0 },
      verb: ["set-mode", "plan", "--session-id", SESSION],
    },
    (out) => {
      assert.equal(out.result.code, 0, out.result.stderr);
      assert.equal(out.calls.length, 1);
    },
  );
});

test("ee99 79.1 pair · NOT in pod mode the same shell prompt is not gated at all, even on a full box, and starts the agent (not-gated why=no-class)", async () => {
  const f = makeBox({ requestMib: 2048 }); // a FULL box: no slot for any agent
  const id = await makeTarget(f);
  const run = await runCli(
    [
      "--agent",
      f.agent,
      "--cwd",
      path.join(f.root, "work"),
      "--approve-all",
      "--format",
      "quiet",
      "prompt",
      "--session-id",
      id,
      "hello",
    ],
    f.env,
    f.root,
  );
  assert.equal(run.code, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /REFUSED|NOT queued/u);
  assert.equal(agentStarts(f) >= 1, true, "the agent started: the shell was never gated");
});
