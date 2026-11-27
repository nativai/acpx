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
import { warnUncheckedBackgroundTasks } from "../src/cli/background-task-gate.js";
import { QueueConnectionError, QueueProtocolError } from "../src/errors.js";
import {
  type QueueOwnerControlHandlers,
  SessionQueueOwner,
  tryAcquireQueueOwnerLease,
  releaseErrorDetail,
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
  IDLE_PREDICATE_PATH,
  IDLE_PREDICATE_TEST_ENV,
  IDLE_PREDICATE_TIMEOUT_MS,
  idlePredicatePath,
  runIdlePredicate,
} from "../src/pod/idle-predicate.js";
import {
  clearReclaimMark,
  podRunDir,
  reclaimMarkPath,
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
      reason: "turn_running",
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
      name: "the pod is busy",
      input: { podMarks: () => ({ ok: false, reason: "busy", detail: "x" }) },
      reason: "pod_busy:busy",
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
    if (name === "a background task is live") {
      assert.match(!verdict.ok ? verdict.detail : "", /^background:/);
    }
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
    "pod_busy:busy",
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
    "pod_busy:busy",
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
// The pod's idle predicate (`nv-agent-idle --check`): REAL stub executables in a temp directory.
// ---------------------------------------------------------------------------------------------------------

function withStub(script: string, run: (stub: string, argvFile: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "idle-predicate-"));
  try {
    const stub = path.join(root, "nv-agent-idle");
    const argvFile = path.join(root, "argv");
    fs.writeFileSync(stub, `#!/bin/sh\necho "$@" > ${JSON.stringify(argvFile)}\n${script}\n`, {
      mode: 0o755,
    });
    run(stub, argvFile);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const ask = (path: string, overrides: Partial<Parameters<typeof runIdlePredicate>[0]> = {}) =>
  runIdlePredicate({ path, ownerPid: 4242, ...overrides });

test("predicate: exit 0 ⇒ idle (the positive control of the table below)", () => {
  withStub("exit 0", (stub) => {
    assert.deepEqual(ask(stub), { ok: true });
  });
});

test("predicate: each busy exit maps to ITS reason — 10 browser_open, 11 call_in_flight, 12 busy (committed negatives)", () => {
  const rows: Array<[number, string]> = [
    [10, "browser_open"],
    [11, "call_in_flight"],
    [12, "busy"],
  ];
  for (const [code, reason] of rows) {
    withStub(`echo ${reason}\nexit ${code}`, (stub) => {
      const verdict = ask(stub);
      assert.equal(refusalOf(verdict), reason, `exit ${code}`);
      assert.equal(!verdict.ok && verdict.detail, reason, "the reason word is kept");
    });
  }
});

test("predicate: ANYTHING else is unknown, never idle — another exit code, a signal, a timeout, a missing binary (committed negatives)", () => {
  for (const code of [1, 2, 3, 9, 13, 64, 126, 127, 255]) {
    withStub(`exit ${code}`, (stub) => {
      assert.equal(refusalOf(ask(stub)), "unknown", `exit ${code}`);
    });
  }
  withStub("kill -9 $$", (stub) => {
    assert.equal(refusalOf(ask(stub)), "unknown", "ended by a signal");
  });
  const started = Date.now();
  withStub("exec sleep 30", (stub) => {
    assert.equal(refusalOf(ask(stub, { timeoutMs: 300 })), "unknown", "a timeout");
  });
  assert.ok(Date.now() - started < 10_000, "the timeout bounds the call");
  assert.equal(
    refusalOf(ask("/nonexistent/nv-agent-idle")),
    "unknown",
    "the predicate is not installed yet (the image carrying it lands after the devbox switch)",
  );
  withStub("exit 0", (stub) => {
    fs.chmodSync(stub, 0o644);
    assert.equal(refusalOf(ask(stub)), "unknown", "present but not executable");
  });
});

test("predicate: the call passes --check, the owner's pid and the asking call's id; with no call id none is passed", () => {
  withStub("exit 0", (stub, argvFile) => {
    ask(stub, { excludeCallId: "call-7" });
    assert.equal(
      fs.readFileSync(argvFile, "utf8").trim(),
      "--check --owner-pid 4242 --exclude-call-id call-7",
    );
    ask(stub);
    assert.equal(fs.readFileSync(argvFile, "utf8").trim(), "--check --owner-pid 4242");
  });
});

test("predicate: the path is infra's fixed install path; the test override is honoured ONLY under node --test", () => {
  assert.equal(idlePredicatePath({}), IDLE_PREDICATE_PATH);
  assert.equal(IDLE_PREDICATE_PATH, "/usr/local/bin/nv-agent-idle");
  // NEGATIVE: a box (no NODE_TEST_CONTEXT) setting the override changes nothing.
  assert.equal(idlePredicatePath({ [IDLE_PREDICATE_TEST_ENV]: "/tmp/evil" }), IDLE_PREDICATE_PATH);
  assert.equal(
    idlePredicatePath({ [IDLE_PREDICATE_TEST_ENV]: "/tmp/stub", NODE_TEST_CONTEXT: "child-v8" }),
    "/tmp/stub",
  );
});

test("predicate: the spawn is synchronous and bounded at 5 s (the owner holds its loop for the call)", () => {
  assert.equal(IDLE_PREDICATE_TIMEOUT_MS, 5_000);
  let seen: { timeout?: number } | undefined;
  const verdict = runIdlePredicate({
    path: "x",
    ownerPid: 1,
    spawn: ((_path: string, _args: readonly string[], options: { timeout?: number }) => {
      seen = options;
      return { status: 0, signal: null, stdout: "", stderr: "", output: [], pid: 1 };
    }) as unknown as typeof import("node:child_process").spawnSync,
  });
  assert.deepEqual(verdict, { ok: true });
  assert.equal(seen?.timeout, 5_000);
});

test("run dir: the idle loop's own knob, default /run/nv-agent", () => {
  assert.equal(podRunDir({ NV_AG_RUN_DIR: "/r" }), "/r");
  assert.equal(podRunDir({}), "/run/nv-agent");
});

test("reclaim mark: written whole and atomically with the session and the held target; cleared; a failed write leaves nothing", () => {
  withRunDir((rig) => {
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
    // The pod's rule `reclaimed` ignores a symlink and wants a regular file (its mtime >= the loop's start).
    const stat = fs.lstatSync(reclaimMarkPath(rig.runDir));
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
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

function withRunDir(run: (rig: { runDir: string }) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-mark-"));
  try {
    fs.mkdirSync(path.join(root, "inflight"));
    run({ runDir: root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

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

test("owner: asking twice — the second is REFUSED (one slot, one release); an owner already closing refuses; an old owner without the gate says unsupported", async () => {
  await withOwner("ri-twice", newState(), async () => {
    assert.equal((await tryReleaseIfIdleOnRunningOwner("ri-twice", {})).kind, "released");
    // L3 (TE): a SECOND ask for the same candidate must NOT also say released — two held messages would
    // each believe they freed a slot, and only one slot is freed. It is a refusal that sends atrium to
    // its next candidate at once: `turn_running`, detail `reclaiming:`.
    const second = await tryReleaseIfIdleOnRunningOwner("ri-twice", {});
    assert.equal(second.kind, "refused");
    assert.equal(second.kind === "refused" && second.reason, "turn_running");
    assert.match(second.kind === "refused" ? (second.detail ?? "") : "", /^reclaiming:/);
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

test("L3 RACE: two CONCURRENT releases of one candidate — exactly ONE says released, the other is refused turn_running (reclaiming)", async () => {
  for (let i = 0; i < 10; i += 1) {
    const state = newState({ parked: true });
    await withOwner(`ri-two-${i}`, state, async (owner) => {
      const [a, b] = await Promise.all([
        tryReleaseIfIdleOnRunningOwner(`ri-two-${i}`, { heldTarget: "held-a" }),
        tryReleaseIfIdleOnRunningOwner(`ri-two-${i}`, { heldTarget: "held-b" }),
      ]);
      const kinds = [a.kind, b.kind].toSorted();
      assert.deepEqual(kinds, ["refused", "released"], JSON.stringify([a, b]));
      const loser = a.kind === "refused" ? a : b;
      assert.equal(loser.kind === "refused" && loser.reason, "turn_running");
      assert.equal(state.markWrites, 1, "ONE reclaim mark, written once");
      assert.equal(owner.isReclaiming(), true);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------
// L2 (TE): a `sessions close` that meets a reclaiming owner must say so, not "older acpx".
// ---------------------------------------------------------------------------------------------------------

function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

test("L2/D-L3: the close's unanswered-owner warning names a RECLAIM only when the mark belongs to the CURRENT owner (owner_pid == the lease pid the close saw); a stale mark keeps the old warning", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-warn-"));
  const saved = process.env.NV_AG_RUN_DIR;
  process.env.NV_AG_RUN_DIR = root;
  try {
    const unanswered = (ownerPid?: number) => ({
      queried: false as const,
      ownerUnanswered: true as const,
      ...(ownerPid === undefined ? {} : { ownerPid }),
    });
    const OLD = /owner runs an older acpx or did not answer/;
    // CONTROL: no mark ⇒ the old wording, untouched.
    assert.match(
      captureStderr(() => warnUncheckedBackgroundTasks("sess-1", unanswered(4242))),
      OLD,
    );

    writeReclaimMark(root, { sessionId: "sess-1", at: Date.now(), ownerPid: 4242, heldTarget: "h" });
    const reclaimed = captureStderr(() => warnUncheckedBackgroundTasks("sess-1", unanswered(4242)));
    assert.match(reclaimed, /being reclaimed/);
    assert.match(reclaimed, /no live background task/);
    assert.doesNotMatch(reclaimed, /older acpx|may still be running/);

    // D-L3 NEGATIVE (the TE's TE-13b shape): a STALE mark naming this session — its owner_pid is a PREVIOUS
    // owner, the release was refused or the pod did not end — says nothing about the owner the close saw.
    assert.match(
      captureStderr(() => warnUncheckedBackgroundTasks("sess-1", unanswered(9999))),
      OLD,
      "owner_pid differs from the lease pid the close saw",
    );
    // NEGATIVE: the close could not name the owner's pid ⇒ the mark cannot be matched ⇒ old warning.
    assert.match(captureStderr(() => warnUncheckedBackgroundTasks("sess-1", unanswered())), OLD);
    // NEGATIVE: a mark with no owner_pid line.
    fs.writeFileSync(path.join(root, "reclaim"), "session=sess-1\nreason=reclaim\n");
    assert.match(captureStderr(() => warnUncheckedBackgroundTasks("sess-1", unanswered(4242))), OLD);

    // NEGATIVE: a mark for ANOTHER session says nothing about this one.
    writeReclaimMark(root, { sessionId: "sess-1", at: Date.now(), ownerPid: 4242 });
    assert.match(captureStderr(() => warnUncheckedBackgroundTasks("sess-2", unanswered(4242))), OLD);

    // NEGATIVE: an answered query / an absent owner stays silent either way.
    assert.equal(
      captureStderr(() => warnUncheckedBackgroundTasks("sess-1", { queried: false })),
      "",
    );
  } finally {
    if (saved === undefined) {
      delete process.env.NV_AG_RUN_DIR;
    } else {
      process.env.NV_AG_RUN_DIR = saved;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("D-L2: a release that loses its owner mid-call says SO — only a real protocol mismatch says `older acpx`", () => {
  const closed = new QueueConnectionError("Queue owner is closed", {
    detailCode: "QUEUE_OWNER_CLOSED",
    origin: "queue",
    retryable: true,
  });
  const dropped = new QueueConnectionError("disconnected", {
    detailCode: "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
    origin: "queue",
    retryable: true,
  });
  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  for (const error of [closed, dropped, epipe]) {
    const detail = releaseErrorDetail(error);
    assert.match(detail, /went away mid-release/);
    assert.doesNotMatch(detail, /older acpx/);
  }
  // NEGATIVE: an owner that answers with a protocol error IS the older-acpx shape.
  const old = new QueueProtocolError("malformed", {
    detailCode: "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
    origin: "queue",
  });
  assert.match(releaseErrorDetail(old), /older acpx/);
  assert.match(releaseErrorDetail(old), /QUEUE_PROTOCOL_MALFORMED_MESSAGE/);
  // Anything else keeps its own text.
  assert.equal(releaseErrorDetail(new Error("boom")), "boom");
});
