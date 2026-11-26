// brick 35d4e64b (acpx half of ef5934ba) — ON-DEMAND IDLE RELEASE: the rows of the decision, of the pod's
// marks, of the wire, and of the owner's atomic step. The end-to-end proof with a real owner process and a
// real CLI is test/release-if-idle-e2e.test.ts.
//
// EVERY GUARANTEE HAS A COMMITTED NEGATIVE: a state that is idle in every respect but one, asserted refused,
// with the owner untouched afterwards (it still accepts work). The positive control (all idle ⇒ ok) sits
// beside each table so a refusal can only come from the one thing that is wrong.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import {
  type QueueOwnerControlHandlers,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
  tryReleaseIfIdleOnRunningOwner,
} from "../src/cli/queue/ipc.js";
import {
  parseQueueOwnerMessage,
  parseQueueRequest,
  RELEASE_REFUSALS,
} from "../src/cli/queue/messages.js";
import { resetSessionCloseIntentForTests } from "../src/cli/queue/session-close-intent.js";
import { ownerExitReapsTranscripts } from "../src/cli/session/owner-exit-transcript-reap.js";
import {
  decideReclaim,
  formatOwnerReclaimLine,
  type ReclaimGateInput,
} from "../src/cli/session/reclaim-gate.js";
import { releaseOutcomePayload } from "../src/cli/session/session-control.js";
import {
  clearReclaimMark,
  podMarksConfigFromEnv,
  type PodMarksConfig,
  readPodIdleMarks,
  reclaimMarkPath,
  STATUS_FILE_MAX_AGE_MS,
  writeReclaimMark,
} from "../src/pod/reclaim-marks.js";
import type { DepthProjection } from "../src/session/depth-projection.js";
import { sessionEventActivePath } from "../src/session/event-log.js";
import { connectSocket, nextJsonLine, withTempHome } from "./queue-test-helpers.js";

// ---------------------------------------------------------------------------------------------------------
// The pure decision.
// ---------------------------------------------------------------------------------------------------------

/** The reason of a refusal, undefined for an `ok` verdict. */
function refusalOf(verdict: { ok: true } | { ok: false; reason: string }): string | undefined {
  return verdict.ok ? undefined : verdict.reason;
}

function idleInput(overrides: Partial<ReclaimGateInput> = {}): ReclaimGateInput {
  return {
    loopParked: true,
    hasActiveTurn: false,
    queued: false,
    quiescent: true,
    liveBackgroundTaskCount: 0,
    podMarks: () => ({ ok: true }),
    ...overrides,
  };
}

test("gate: the positive control — parked, nothing running, nothing queued, quiet, no task, pod clear ⇒ ok", () => {
  assert.deepEqual(decideReclaim(idleInput()), { ok: true });
});

test("gate: each refusal is idle in every respect but ONE (committed negatives)", () => {
  const cases: Array<{ name: string; input: Partial<ReclaimGateInput>; reason: string }> = [
    { name: "a turn is running", input: { hasActiveTurn: true }, reason: "turn_running" },
    {
      name: "the loop is between turns (batch handed out, turn not begun)",
      input: { loopParked: false },
      reason: "turn_running",
    },
    { name: "a prompt is queued", input: { queued: true }, reason: "queued" },
    { name: "inter-turn relay activity", input: { quiescent: false }, reason: "turn_running" },
    {
      name: "a background task is live",
      input: { liveBackgroundTaskCount: 1 },
      reason: "background",
    },
    {
      name: "an agent browser is open",
      input: { podMarks: () => ({ ok: false, reason: "browser_open", detail: "x" }) },
      reason: "pod_busy:browser_open",
    },
    {
      name: "a command is in flight",
      input: { podMarks: () => ({ ok: false, reason: "call_in_flight", detail: "x" }) },
      reason: "pod_busy:call_in_flight",
    },
    {
      name: "the marks cannot be read",
      input: { podMarks: () => ({ ok: false, reason: "unknown", detail: "x" }) },
      reason: "pod_busy:unknown",
    },
  ];
  for (const { name, input, reason } of cases) {
    const verdict = decideReclaim(idleInput(input));
    assert.equal(verdict.ok, false, `${name} must refuse`);
    assert.equal(refusalOf(verdict), reason, name);
    assert.ok(RELEASE_REFUSALS.includes(reason as (typeof RELEASE_REFUSALS)[number]));
  }
});

test("gate: the pod's marks are read ONLY after every owner-side condition holds (cost ordering)", () => {
  let reads = 0;
  const podMarks = () => {
    reads += 1;
    return { ok: true } as const;
  };
  for (const input of [
    { hasActiveTurn: true },
    { loopParked: false },
    { queued: true },
    { quiescent: false },
    { liveBackgroundTaskCount: 2 },
  ]) {
    assert.equal(decideReclaim(idleInput({ ...input, podMarks })).ok, false);
  }
  assert.equal(reads, 0, "an owner-side refusal never reads the pod");
  assert.equal(decideReclaim(idleInput({ podMarks })).ok, true);
  assert.equal(reads, 1);
});

test("gate: `--ttl 0` is NOT an exemption — the gate has no ttl input at all (Option A)", () => {
  // The owner built with `--ttl 0` and one with the default hand the gate the same fields: there is no
  // field through which a never-recycle switch could say no. The real `--ttl 0` owner is released in
  // test/release-if-idle-e2e.test.ts.
  assert.deepEqual(Object.keys(idleInput()).toSorted(), [
    "hasActiveTurn",
    "liveBackgroundTaskCount",
    "loopParked",
    "podMarks",
    "queued",
    "quiescent",
  ]);
});

test("log line: ONE loud line naming the session, the idle time and the held message's target", () => {
  const line = formatOwnerReclaimLine({
    sessionId: "sess-1",
    at: Date.UTC(2026, 10, 26, 12, 0, 0),
    idleMs: 125_000,
    heldTarget: "sess-9",
  });
  assert.equal(line.split("\n").length, 2, "one line, newline-terminated");
  assert.match(line, /queue owner RECLAIMED session sess-1/);
  assert.match(line, /idle=2m05s/);
  assert.match(line, /held_target=sess-9/);
  assert.match(line, /at=2026-11-26T12:00:00.000Z/);
  assert.match(
    formatOwnerReclaimLine({ sessionId: "s", at: 0, idleMs: 0, heldTarget: undefined }),
    /held_target=unknown/,
  );
});

test("exit kind: a reclaim reaps the transcript copies like an idle release; a recycle still does not", () => {
  assert.equal(ownerExitReapsTranscripts("reclaim"), true);
  assert.equal(ownerExitReapsTranscripts("idle-release"), true);
  assert.equal(ownerExitReapsTranscripts("turn-boundary-recycle"), false);
});

// ---------------------------------------------------------------------------------------------------------
// The wire.
// ---------------------------------------------------------------------------------------------------------

test("wire: the request keeps heldTarget and a well-formed callId, and drops what is not one", () => {
  assert.deepEqual(
    parseQueueRequest({
      type: "release_if_idle",
      requestId: "r1",
      heldTarget: "  sess-9  ",
      callId: "3f2a9c1e-0000-4000-8000-000000000001",
    }),
    {
      type: "release_if_idle",
      requestId: "r1",
      ownerGeneration: undefined,
      heldTarget: "sess-9",
      callId: "3f2a9c1e-0000-4000-8000-000000000001",
    },
  );
  // NEGATIVES: a call id with a path or newline in it is dropped (it would only ever be compared, but the
  // owner trusts nothing it did not shape); an empty target is dropped.
  for (const callId of ["../x", "a\nb", "", 7, null]) {
    assert.deepEqual(
      parseQueueRequest({ type: "release_if_idle", requestId: "r2", heldTarget: " ", callId }),
      { type: "release_if_idle", requestId: "r2", ownerGeneration: undefined },
    );
  }
});

test("the verb's JSON: EVERY outcome — released, each refusal, no_owner, unsupported — is a session_release line, and the reasons are the closed set", () => {
  const closed = new Set([
    "turn_running",
    "queued",
    "pod_busy:browser_open",
    "pod_busy:call_in_flight",
    "pod_busy:unknown",
    "no_owner",
    "unsupported",
    "held_target_self",
  ]);
  assert.deepEqual(releaseOutcomePayload("s1", { kind: "released", ownerPid: 1, idleMs: 5 }), {
    action: "session_release",
    sessionId: "s1",
    released: true,
    idleMs: 5,
  });
  const refusals = [
    ...RELEASE_REFUSALS.map((reason) => ({ kind: "refused" as const, ownerPid: 1, reason })),
    { kind: "no-owner" as const },
    { kind: "unsupported" as const, detail: "QUEUE_REQUEST_INVALID" },
  ];
  for (const outcome of refusals) {
    const payload = releaseOutcomePayload("s1", outcome);
    assert.equal(payload.action, "session_release");
    assert.equal(payload.sessionId, "s1");
    assert.equal(payload.released, false);
    assert.ok(closed.has(String(payload.reason)), `reason ${String(payload.reason)} is in the set`);
  }
  assert.deepEqual([...RELEASE_REFUSALS].toSorted(), [
    "held_target_self",
    "pod_busy:browser_open",
    "pod_busy:call_in_flight",
    "pod_busy:unknown",
    "queued",
    "turn_running",
    "unsupported",
  ]);
});

test("wire: a result round-trips; a malformed one is never read as released", () => {
  assert.deepEqual(
    parseQueueOwnerMessage({
      type: "release_if_idle_result",
      requestId: "r1",
      released: true,
      idleMs: 4000,
    }),
    {
      type: "release_if_idle_result",
      requestId: "r1",
      ownerGeneration: undefined,
      released: true,
      idleMs: 4000,
    },
  );
  assert.deepEqual(
    parseQueueOwnerMessage({
      type: "release_if_idle_result",
      requestId: "r1",
      released: false,
      reason: "pod_busy:browser_open",
      detail: "x",
    }),
    {
      type: "release_if_idle_result",
      requestId: "r1",
      ownerGeneration: undefined,
      released: false,
      reason: "pod_busy:browser_open",
      detail: "x",
    },
  );
  // NEGATIVES: no boolean; a refusal without a known reason.
  assert.equal(parseQueueOwnerMessage({ type: "release_if_idle_result", requestId: "r1" }), null);
  assert.equal(
    parseQueueOwnerMessage({ type: "release_if_idle_result", requestId: "r1", released: false }),
    null,
  );
  assert.equal(
    parseQueueOwnerMessage({
      type: "release_if_idle_result",
      requestId: "r1",
      released: false,
      reason: "because",
    }),
    null,
  );
});

// ---------------------------------------------------------------------------------------------------------
// The pod's marks (files in a temp directory standing for /run/nv-agent and the status directory).
// ---------------------------------------------------------------------------------------------------------

type PodRig = { runDir: string; statusDir: string; config: PodMarksConfig };

function withPod(run: (rig: PodRig) => void, ownCallId?: string): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-marks-"));
  try {
    const runDir = path.join(root, "run");
    const statusDir = path.join(root, "status");
    fs.mkdirSync(path.join(runDir, "inflight"), { recursive: true });
    fs.mkdirSync(statusDir, { recursive: true });
    const config: PodMarksConfig = {
      runDir,
      statusDir,
      sessionKey: "key1",
      ownCallId,
      now: () => Date.UTC(2026, 10, 26, 12, 0, 0),
    };
    run({ runDir, statusDir, config });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeStatus(rig: PodRig, overrides: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(rig.statusDir, "key1.json"),
    `${JSON.stringify({
      version: 1,
      kind: "agent",
      state: "running",
      updatedAt: "2026-11-26T11:59:30Z",
      browser: { open: false, since: null },
      ...overrides,
    })}\n`,
  );
}

function writeMark(rig: PodRig, name: string, body: string): void {
  fs.writeFileSync(path.join(rig.runDir, "inflight", name), body);
}

const markBody = (pid: number, child: number, callId = "c") =>
  `pid=${pid}\npid_start=1\nchild=${child}\nstart_ms=1\ndeadline_ms=2\ncall_id=${callId}\n`;

test("marks: the positive control — a running idle loop, browser closed, nothing in flight ⇒ ok", () => {
  withPod((rig) => {
    writeStatus(rig);
    assert.deepEqual(readPodIdleMarks(rig.config), { ok: true });
  });
});

test("marks: an agent browser open ⇒ browser_open (committed negative)", () => {
  withPod((rig) => {
    writeStatus(rig, { browser: { open: true, since: "2026-11-26T11:00:00Z", pages: 1 } });
    const verdict = readPodIdleMarks(rig.config);
    assert.equal(refusalOf(verdict), "browser_open");
  });
});

test("marks: a command in flight ⇒ call_in_flight (committed negative); the call that ASKS is not work", () => {
  withPod((rig) => {
    writeStatus(rig);
    // The routed entry's own mark for THIS release call: its call_id is the asker's ACPX_ROUTED_CALL_ID.
    writeMark(rig, "ask-call.500", markBody(500, 501, "ask-call"));
    assert.deepEqual(readPodIdleMarks(rig.config), { ok: true }, "the asker's own mark is ignored");
    // NEGATIVE: the same pod with ANOTHER call in flight is refused — even one whose pids equal the
    // asker's (only the call id identifies the asker).
    writeMark(rig, "other-call.500", markBody(500, 501, "other-call"));
    const verdict = readPodIdleMarks(rig.config);
    assert.equal(refusalOf(verdict), "call_in_flight");
  }, "ask-call");
  // NEGATIVE: with no call id (not a routed call) NO mark is ignored.
  withPod((rig) => {
    writeStatus(rig);
    writeMark(rig, "ask-call.500", markBody(500, 501, "ask-call"));
    const verdict = readPodIdleMarks(rig.config);
    assert.equal(refusalOf(verdict), "call_in_flight");
  });
});

test("marks: a mark nobody can parse counts as in flight (a doubt is not idle)", () => {
  withPod((rig) => {
    writeStatus(rig);
    writeMark(rig, "junk.1", "not a mark at all\n");
    const verdict = readPodIdleMarks(rig.config);
    assert.equal(refusalOf(verdict), "call_in_flight");
  });
});

test("marks: every unreadable input is `unknown`, never idle (committed negatives)", () => {
  const cases: Array<{
    name: string;
    arrange: (rig: PodRig) => void;
    config?: Partial<PodMarksConfig>;
  }> = [
    { name: "no status file", arrange: () => {} },
    {
      name: "a status file that is not JSON",
      arrange: (rig) => fs.writeFileSync(path.join(rig.statusDir, "key1.json"), "{not json"),
    },
    {
      name: "a status file that is not an object",
      arrange: (rig) => fs.writeFileSync(path.join(rig.statusDir, "key1.json"), "[1,2]\n"),
    },
    {
      name: "no session key",
      arrange: (rig) => writeStatus(rig),
      config: { sessionKey: undefined },
    },
    {
      name: "a session key that is not a key",
      arrange: (rig) => writeStatus(rig),
      config: { sessionKey: "../escape" },
    },
    { name: "state is not running", arrange: (rig) => writeStatus(rig, { state: "ending" }) },
    { name: "state ended", arrange: (rig) => writeStatus(rig, { state: "ended" }) },
    {
      name: "a status file older than the idle loop's cadence allows",
      arrange: (rig) =>
        writeStatus(rig, {
          updatedAt: new Date(
            Date.UTC(2026, 10, 26, 12, 0, 0) - STATUS_FILE_MAX_AGE_MS - 1000,
          ).toISOString(),
        }),
    },
    { name: "no updatedAt", arrange: (rig) => writeStatus(rig, { updatedAt: undefined }) },
    { name: "no browser record", arrange: (rig) => writeStatus(rig, { browser: undefined }) },
    {
      name: "browser.open that is not a boolean",
      arrange: (rig) => writeStatus(rig, { browser: { open: "no" } }),
    },
    {
      name: "no in-flight directory",
      arrange: (rig) => {
        writeStatus(rig);
        fs.rmSync(path.join(rig.runDir, "inflight"), { recursive: true });
      },
    },
  ];
  for (const { name, arrange, config } of cases) {
    withPod((rig) => {
      arrange(rig);
      const verdict = readPodIdleMarks({ ...rig.config, ...config });
      assert.equal(refusalOf(verdict), "unknown", name);
    });
  }
});

test("marks: the control for the table above — the same pod, repaired, is ok", () => {
  withPod((rig) => {
    writeStatus(rig);
    assert.deepEqual(readPodIdleMarks(rig.config), { ok: true });
    assert.deepEqual(
      readPodIdleMarks({
        ...rig.config,
        now: () => Date.UTC(2026, 10, 26, 12, 0, 0) + 60_000,
      }),
      { ok: true },
      "a status file a minute old is fresh (the loop rewrites it every 60 s)",
    );
  });
});

test("marks: the config reads the idle loop's own knobs from the environment", () => {
  const config = podMarksConfigFromEnv(
    { NV_AG_RUN_DIR: "/r", NV_AG_STATUS_DIR: "/s", NV_AGENT_SESSION_KEY: "k" },
    "call-7",
  );
  assert.equal(config.runDir, "/r");
  assert.equal(config.statusDir, "/s");
  assert.equal(config.sessionKey, "k");
  assert.equal(config.ownCallId, "call-7");
  const defaults = podMarksConfigFromEnv({}, undefined);
  assert.equal(defaults.runDir, "/run/nv-agent");
  assert.equal(defaults.statusDir, "/workspace/.workbench/agents");
  assert.equal(defaults.sessionKey, undefined);
});

test("reclaim mark: written whole and atomically with the session and the held target; cleared; a failed write leaves nothing", () => {
  withPod((rig) => {
    writeReclaimMark(rig.runDir, {
      sessionId: "sess-1",
      at: Date.UTC(2026, 10, 26, 12, 0, 0),
      ownerPid: 4242,
      heldTarget: "sess-9",
    });
    const text = fs.readFileSync(reclaimMarkPath(rig.runDir), "utf8");
    assert.match(text, /^session=sess-1$/m);
    assert.match(text, /^owner_pid=4242$/m);
    assert.match(text, /^held_target=sess-9$/m);
    assert.deepEqual(
      fs.readdirSync(rig.runDir).toSorted(),
      ["inflight", "reclaim"],
      "no temp file is left beside the mark",
    );
    clearReclaimMark(rig.runDir);
    assert.equal(fs.existsSync(reclaimMarkPath(rig.runDir)), false);
    clearReclaimMark(rig.runDir); // absent: no throw

    // NEGATIVE: an unwritable run directory throws (the owner then refuses, untouched) and leaves no temp.
    const missing = path.join(rig.runDir, "no-such-dir");
    assert.throws(() =>
      writeReclaimMark(missing, { sessionId: "s", at: 0, ownerPid: 1, heldTarget: undefined }),
    );
    assert.equal(fs.existsSync(missing), false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The owner's atomic step, on a real queue-owner socket. The runtime's `loopParked` is modelled by the test
// (the real loop is exercised end to end in test/release-if-idle-e2e.test.ts).
// ---------------------------------------------------------------------------------------------------------

type Scripted = {
  activeTurn: boolean;
  parked: boolean;
  background: number;
  marks: () => ReturnType<ReclaimGateInput["podMarks"]>;
  markWrites: number;
  gateCalls: Array<{ queued: boolean; heldTarget?: string; callId?: string }>;
};

function newState(overrides: Partial<Scripted> = {}): Scripted {
  return {
    activeTurn: false,
    parked: true,
    background: 0,
    marks: () => ({ ok: true }),
    markWrites: 0,
    gateCalls: [],
    ...overrides,
  };
}

function handlers(state: Scripted, withGate = true): QueueOwnerControlHandlers {
  return {
    cancelPrompt: async () => false,
    closeSession: async () => true,
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }) as SetSessionConfigOptionResponse,
    setDepth: async (requested: string): Promise<DepthProjection> => ({
      kind: "send-nothing",
      requested,
    }),
    queryActiveTurn: () => state.activeTurn,
    queryBackgroundTasks: () => ({ source: "adapter", tasks: [], monitorCommands: [] }),
    ...(withGate
      ? {
          // The same shape as the runtime's: decide with the pure gate, write the mark only on ok.
          reclaimGate: (params) => {
            state.gateCalls.push(params);
            const verdict = decideReclaim({
              loopParked: state.parked,
              hasActiveTurn: state.activeTurn,
              queued: params.queued,
              quiescent: true,
              liveBackgroundTaskCount: state.background,
              podMarks: state.marks,
            });
            if (!verdict.ok) {
              return verdict;
            }
            state.markWrites += 1;
            return { ok: true, idleMs: 1234 };
          },
        }
      : {}),
  };
}

async function withOwner(
  sessionId: string,
  state: Scripted,
  run: (owner: SessionQueueOwner, socketPath: string) => Promise<void>,
  withGate = true,
): Promise<void> {
  await withTempHome(async () => {
    resetSessionCloseIntentForTests();
    await fsp.mkdir(path.dirname(sessionEventActivePath(sessionId)), { recursive: true });
    const lease = await tryAcquireQueueOwnerLease(sessionId);
    assert(lease, "expected to acquire a queue-owner lease");
    const owner = await SessionQueueOwner.start(lease, handlers(state, withGate), {
      maxQueueDepth: 32,
    });
    try {
      await run(owner, lease.socketPath);
    } finally {
      await owner.close();
      resetSessionCloseIntentForTests();
    }
  });
}

async function submit(socketPath: string, id: string): Promise<Record<string, unknown>> {
  const socket = await connectSocket(socketPath);
  const lines = readline.createInterface({ input: socket });
  socket.write(
    `${JSON.stringify({
      type: "submit_prompt",
      requestId: `req-${id}`,
      messageId: `msg-${id}`,
      message: `hello ${id}`,
      permissionMode: "approve-all",
      waitForCompletion: false,
    })}\n`,
  );
  const first = (await nextJsonLine(lines[Symbol.asyncIterator]())) as Record<string, unknown>;
  lines.close();
  socket.destroy();
  return first;
}

/** Every refusal must leave the owner exactly as it was: not committed, still taking work. */
async function assertUntouched(
  owner: SessionQueueOwner,
  socketPath: string,
  state: Scripted,
  label: string,
): Promise<void> {
  assert.equal(owner.isReclaiming(), false, `${label}: the owner did not commit`);
  assert.equal(state.markWrites, 0, `${label}: no reclaim mark was written`);
  state.activeTurn = false;
  assert.equal(
    (await submit(socketPath, `after-${label.replaceAll(/\W/g, "")}`)).type,
    "accepted",
    `${label}: the owner still accepts a prompt`,
  );
}

test("owner: idle ⇒ released, the owner COMMITS (no work handed out, submissions refused retryably) and the parked loop is woken after the reply", async () => {
  await withOwner("ri-idle", newState({ parked: true }), async (owner, socketPath) => {
    const parked = owner.nextBatch(30_000).then((batch) => batch?.[0]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const outcome = await tryReleaseIfIdleOnRunningOwner("ri-idle", {
      heldTarget: "sess-9",
      callId: "call-1",
    });
    assert.deepEqual(outcome, { kind: "released", ownerPid: process.pid, idleMs: 1234 });
    assert.equal(owner.isReclaiming(), true);
    assert.equal(await parked, undefined, "the parked loop is woken empty-handed");
    // A prompt arriving now is refused BEFORE `accepted`, retryably, with wording acpx-ui re-drives.
    const refused = await submit(socketPath, "late");
    assert.equal(refused.type, "error");
    assert.equal(refused.detailCode, "QUEUE_OWNER_RECLAIMING");
    assert.equal(refused.retryable, true);
    assert.doesNotMatch(String(refused.message), /session is closed|read-only|template/i);
    assert.equal(owner.queueDepth(), 0, "nothing was queued into the dying owner");
    assert.equal(await owner.nextBatch(0), undefined);
  });
});

test("owner: the asker's call id and the held target reach the runtime's gate", async () => {
  const state = newState();
  await withOwner("ri-args", state, async () => {
    await tryReleaseIfIdleOnRunningOwner("ri-args", { heldTarget: "sess-9", callId: "call-2" });
    assert.deepEqual(state.gateCalls, [{ queued: false, heldTarget: "sess-9", callId: "call-2" }]);
  });
});

test("owner: a refusal leaves it UNTOUCHED — turn running, loop between turns, background, pod busy (committed negatives)", async () => {
  const rows: Array<{ label: string; arrange: (s: Scripted) => void; reason: string }> = [
    { label: "turn running", arrange: (s) => (s.activeTurn = true), reason: "turn_running" },
    { label: "between turns", arrange: (s) => (s.parked = false), reason: "turn_running" },
    { label: "background", arrange: (s) => (s.background = 2), reason: "turn_running" },
    {
      label: "browser open",
      arrange: (s) => (s.marks = () => ({ ok: false, reason: "browser_open", detail: "d" })),
      reason: "pod_busy:browser_open",
    },
    {
      label: "call in flight",
      arrange: (s) => (s.marks = () => ({ ok: false, reason: "call_in_flight", detail: "d" })),
      reason: "pod_busy:call_in_flight",
    },
    {
      label: "marks unknown",
      arrange: (s) => (s.marks = () => ({ ok: false, reason: "unknown", detail: "d" })),
      reason: "pod_busy:unknown",
    },
  ];
  for (const row of rows) {
    const state = newState();
    row.arrange(state);
    await withOwner(`ri-${row.label.replaceAll(" ", "-")}`, state, async (owner, socketPath) => {
      const outcome = await tryReleaseIfIdleOnRunningOwner(
        `ri-${row.label.replaceAll(" ", "-")}`,
        {},
      );
      assert.equal(outcome.kind, "refused", row.label);
      assert.equal(outcome.kind === "refused" && outcome.reason, row.reason, row.label);
      await assertUntouched(owner, socketPath, state, row.label);
    });
  }
});

test("owner: something QUEUED ⇒ refused(queued), the queued prompt is not lost, and the owner is untouched", async () => {
  const state = newState({ parked: true });
  await withOwner("ri-queued", state, async (owner, socketPath) => {
    // No waiter is parked on `nextBatch` here, so the prompt lands in `pending` (as it does while the
    // loop is mid-way between two turns).
    assert.equal((await submit(socketPath, "first")).type, "accepted");
    assert.equal(owner.queueDepth(), 1);
    const outcome = await tryReleaseIfIdleOnRunningOwner("ri-queued", {});
    assert.equal(outcome.kind === "refused" && outcome.reason, "queued");
    assert.equal(owner.isReclaiming(), false);
    assert.equal(state.markWrites, 0);
    assert.equal(owner.queueDepth(), 1, "the queued prompt is still there");
    assert.equal((await owner.nextBatch(0).then((batch) => batch?.[0]))?.messageId, "msg-first");
  });
});

test("owner: asking twice is idempotent; an owner already closing refuses; an old owner without the gate says unsupported", async () => {
  await withOwner("ri-twice", newState(), async () => {
    assert.equal((await tryReleaseIfIdleOnRunningOwner("ri-twice", {})).kind, "released");
    assert.equal(
      (await tryReleaseIfIdleOnRunningOwner("ri-twice", {})).kind,
      "released",
      "a second ask finds the committed owner and says so",
    );
  });
  await withOwner("ri-closing", newState(), async (owner) => {
    owner.scheduleClose({ killBackgroundTasks: false, onlyIfActiveTurn: false });
    const outcome = await tryReleaseIfIdleOnRunningOwner("ri-closing", {});
    assert.equal(outcome.kind === "refused" && outcome.reason, "turn_running");
    assert.match(outcome.kind === "refused" ? (outcome.detail ?? "") : "", /closing/);
    assert.equal(owner.isReclaiming(), false);
  });
  await withOwner(
    "ri-old",
    newState(),
    async (owner) => {
      const outcome = await tryReleaseIfIdleOnRunningOwner("ri-old", {});
      assert.equal(outcome.kind === "refused" && outcome.reason, "unsupported");
      assert.equal(owner.isReclaiming(), false);
    },
    false,
  );
  assert.deepEqual(await tryReleaseIfIdleOnRunningOwner("ri-no-such-session", {}), {
    kind: "no-owner",
  });
});

test("RACE: a prompt and a release in the same tick — either the prompt is kept and the release refused, or the release wins and the prompt is refused RETRYABLY; never both, never neither", async () => {
  let kept = 0;
  let released = 0;
  for (let i = 0; i < 25; i += 1) {
    const state = newState({ parked: true });
    await withOwner(`ri-race-${i}`, state, async (owner, socketPath) => {
      const [outcome, answer] = await Promise.all([
        tryReleaseIfIdleOnRunningOwner(`ri-race-${i}`, {}),
        submit(socketPath, `race${i}`),
      ]);
      if (outcome.kind === "released") {
        released += 1;
        assert.equal(answer.type, "error", "the owner committed: the prompt is refused");
        assert.equal(answer.detailCode, "QUEUE_OWNER_RECLAIMING");
        assert.equal(answer.retryable, true);
        assert.equal(owner.queueDepth(), 0);
      } else {
        kept += 1;
        assert.equal(outcome.kind === "refused" && outcome.reason, "queued");
        assert.equal(answer.type, "accepted", "the prompt got in first: it is kept");
        assert.equal(owner.queueDepth(), 1);
        assert.equal(owner.isReclaiming(), false);
      }
    });
  }
  assert.equal(kept + released, 25);
});
