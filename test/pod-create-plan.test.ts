import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readLedgerFile } from "../src/capacity/ledger.js";
import {
  assertKnownPlanVersion,
  cloneSleepingPlan,
  CREATE_PLAN_UNSUPPORTED,
  decodeHarnessAnchor,
  encodeHarnessAnchor,
  FORK_ANCHOR_UNSUPPORTED,
  isRecordOnlyCreate,
  parseSleepingPlan,
  type SleepingPlanState,
} from "../src/pod/create-plan.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import {
  admissionDir,
  agentStarts,
  asAgent,
  createdRecordIds,
  type Fixture,
  makeBox,
  makeTarget,
  methods,
  operations,
  readRecord,
  recordPath,
  runCli,
  startStubAtrium,
  writeAtriumJson,
} from "./umq-rig.js";

// Block A2 (brick 569497cb) — C1.3 the create plan, with amendment A-15. Every guarantee below has a
// committed negative case: an input well-formed in every other respect, wrong in exactly what the
// clause protects. Pod mode is made true by the test seam A1 defined (`ACPX_POD_TEST_HOME`,
// honoured only under `node --test`), never by weakening the production rule.

const CUT: SleepingPlanState = {
  since: "2026-11-21T12:00:00.000Z",
  plan: 1,
  fork: {
    from: "source-1",
    cut: {
      message_index: 5,
      log_index: 5,
      expect_entry: "agent:" + "a".repeat(40),
      harness_anchor: "claude-uuid:d591f13c-613f-47c0-b310-6561d42f8a33",
    },
    byway: true,
  },
};

// ─── the plan's shape: parse, clone, version ───────────────────────────────────────────────────

test("C1.3: the whole plan (version, cut, by-the-way) survives the record parser and the turn-path clone", () => {
  assert.deepEqual(parseSleepingPlan(JSON.parse(JSON.stringify(CUT))), CUT);
  const rebased = cloneSessionAcpxState({ sleeping: CUT });
  assert.deepEqual(rebased?.sleeping, CUT, "cloneSessionAcpxState keeps every plan field");
  assert.notEqual(rebased?.sleeping?.fork?.cut, CUT.fork?.cut, "a copy, not the same object");
  // The pre-plan shape is read back exactly as it was: no version is invented for it.
  const legacy = { since: CUT.since, fork: { from: "template-1" } };
  assert.deepEqual(parseSleepingPlan(legacy), legacy);
  assert.deepEqual(cloneSleepingPlan(legacy), legacy);
});

test("C1.3 negative: a DAMAGED cut never degrades to a whole-source fork — the plan becomes unknown and the wake refuses it", () => {
  const damaged = { ...CUT, fork: { from: "source-1", cut: { message_index: "five" } } };
  const parsed = parseSleepingPlan(damaged);
  assert.equal(parsed?.fork?.cut, undefined);
  assert.equal(parsed?.plan, -1);
  assert.ok(parsed);
  assert.throws(
    () => assertKnownPlanVersion(parsed, "r1"),
    (error: Error) => error.message.startsWith(CREATE_PLAN_UNSUPPORTED),
  );
});

test("C1.3 / rule 1 negative: a plan version this build does not know is refused; absent and 1 are known", () => {
  assert.doesNotThrow(() => assertKnownPlanVersion({ since: "x" }, "r"));
  assert.doesNotThrow(() => assertKnownPlanVersion({ since: "x", plan: 1 }, "r"));
  assert.throws(
    () => assertKnownPlanVersion({ since: "x", plan: 2 }, "r"),
    (error: Error) => error.message.startsWith(CREATE_PLAN_UNSUPPORTED),
  );
});

test("A-15: harness_anchor names its kind; an unknown kind, or a bare value, is FORK_ANCHOR_UNSUPPORTED", () => {
  const anchor = { kind: "claude-uuid" as const, value: "d591f13c-613f-47c0-b310-6561d42f8a33" };
  assert.deepEqual(decodeHarnessAnchor(encodeHarnessAnchor(anchor)), anchor);
  for (const raw of ["pi-entry:8112d380", "d591f13c-613f-47c0-b310-6561d42f8a33", "claude-uuid:"]) {
    assert.throws(
      () => decodeHarnessAnchor(raw),
      (error: Error) => error.message.startsWith(FORK_ANCHOR_UNSUPPORTED),
      raw,
    );
  }
});

// ─── the switch ────────────────────────────────────────────────────────────────────────────────

function podEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    ACPX_STATE_HOME: home,
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: home,
    NV_POD_NAME: "dev-server-0",
    NV_POD_UID: "00000000-0000-0000-0000-000000000001",
    NV_NODE_NAME: "node-a",
    ...extra,
  };
}

test("C1.1: a create is record-only exactly in pod mode on the CONTROL pod — the switch, the canonical home, the pod's identity, no .nv-agent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-a2-switch-"));
  try {
    assert.equal(isRecordOnlyCreate(podEnv(home)), true);
    assert.equal(isRecordOnlyCreate(podEnv(home, { ACPX_OWNER_PLACEMENT: undefined })), false);
    assert.equal(
      isRecordOnlyCreate(podEnv(home, { ACPX_STATE_HOME: path.join(home, "elsewhere") })),
      false,
      "a non-canonical state home is today's behaviour",
    );
    assert.throws(
      () => isRecordOnlyCreate(podEnv(home, { NV_POD_UID: "" })),
      /pod_identity_missing/u,
      "switched on without a pod identity: refused, neither mode",
    );
    fs.writeFileSync(path.join(home, ".nv-agent"), "ag-0123456789abcdef01234567\n");
    assert.equal(isRecordOnlyCreate(podEnv(home)), false, "an agent pod never writes a new record");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ─── creates through the real CLI (the UMQ rig: a mock agent that logs every start and op) ──────

const pod = (f: Fixture, env: NodeJS.ProcessEnv = f.env): NodeJS.ProcessEnv => ({
  ...env,
  ACPX_OWNER_PLACEMENT: "pod",
  ACPX_POD_TEST_HOME: f.root,
  NV_POD_NAME: "dev-server-0",
  NV_POD_UID: "00000000-0000-0000-0000-000000000001",
  NV_NODE_NAME: "node-a",
});

const base = (f: Fixture): string[] => [
  "--agent",
  f.agent,
  "--cwd",
  path.join(f.root, "work"),
  "--approve-all",
  "--format",
  "json",
];

type Json = Record<string, unknown> & { acpxRecordId: string };
const lastJson = (stdout: string): Json =>
  JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Json;

type PlanRecord = {
  acp_session_id: string;
  forked_at_message_index?: number;
  messages?: unknown[];
  metadata?: Record<string, string>;
  acpx: { sleeping?: SleepingPlanState };
};

/** A stub atrium that accepts every message (202), and the pod-mode env that reaches it. */
async function withAtrium<T>(
  f: Fixture,
  run: (env: NodeJS.ProcessEnv, stub: Awaited<ReturnType<typeof startStubAtrium>>) => Promise<T>,
): Promise<T> {
  const stub = await startStubAtrium(() => ({
    status: 202,
    body: { delivery_id: "d-1", to: "x", status: "queued" },
  }));
  try {
    return await run(pod(f, { ...f.env, ACPX_UI_INTERNAL_URL: stub.url }), stub);
  } finally {
    await stub.close();
  }
}

async function warmTarget(f: Fixture, turns: number): Promise<string> {
  const target = await makeTarget(f);
  for (let i = 1; i <= turns; i += 1) {
    const run = await runCli(
      ["--agent", f.agent, "--cwd", path.join(f.root, "work"), "--approve-all", "prompt"].concat([
        "--session-id",
        target,
        `turn ${i}`,
      ]),
      f.env,
      f.root,
    );
    assert.equal(run.code, 0, run.stderr);
  }
  return target;
}

test("C1.3: `sessions new` in pod mode on a FULL box writes the record (plan 1) and starts nothing; the control without pod mode is refused for room", async () => {
  const f = makeBox({ requestMib: 2048 });
  const automation = { ...f.env, ACPX_ADMISSION_CLASS: "automation" };
  const gated = await runCli([...base(f), "sessions", "new"], automation, f.root);
  assert.equal(gated.code, 75, "the control: without pod mode a full box refuses (exit 75)");

  const run = await runCli([...base(f), "sessions", "new"], pod(f, automation), f.root);
  assert.equal(run.code, 0, run.stderr);
  const created = lastJson(run.stdout);
  assert.equal(created.acpxSessionId, "");
  assert.equal(agentStarts(f), 0, "no adapter spawn");
  assert.deepEqual(operations(f), [], "no ACP operation");
  assert.deepEqual(await readLedgerFile(admissionDir(f)), [], "no admission ticket");
  const record = readRecord(f, created.acpxRecordId) as PlanRecord;
  assert.equal(record.acp_session_id, "");
  assert.equal(record.acpx.sleeping?.plan, 1);
  assert.equal(record.acpx.sleeping?.fork, undefined);
});

test("C1.3: a successor (`sessions new --from`) in pod mode is record-only too", async () => {
  const f = makeBox({ requestMib: 4000 });
  const predecessor = await makeTarget(f);
  const startsBefore = agentStarts(f);
  const run = await runCli([...base(f), "sessions", "new", "--from", predecessor], pod(f), f.root);
  assert.equal(run.code, 0, run.stderr);
  const record = readRecord(f, lastJson(run.stdout).acpxRecordId) as PlanRecord & {
    seat_id?: string;
  };
  assert.equal(record.acpx.sleeping?.plan, 1);
  assert.equal(record.acp_session_id, "");
  assert.equal(agentStarts(f), startsBefore, "no adapter for the successor");
  const pred = readRecord(f, predecessor) as { seat_id?: string };
  assert.equal(record.seat_id, pred.seat_id, "the successor joins the predecessor's seat");
});

test("C1.3: a fork at a cut in pod mode copies the inherited messages NOW, pins the cut, starts nothing — and the first wake forks the harness at that cut", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await warmTarget(f, 2); // 4 entries: U A U A
  const opsBefore = methods(f).length;
  const startsBefore = agentStarts(f);
  const { run, posted } = await withAtrium(f, async (env, stub) => {
    const result = await runCli(
      [...base(f), "sessions", "copy", "--from", source, "--at-log-index", "2"],
      env,
      f.root,
    );
    return { run: result, posted: [...stub.requests] };
  });
  assert.equal(run.code, 0, run.stderr);
  const created = lastJson(run.stdout);
  const notice = posted.find((r) => r.url === `/api/sessions/${created.acpxRecordId}/message`);
  assert.match(
    String((notice?.body as { text?: string } | undefined)?.text),
    /^⟦FORK-NOTICE⟧\n/u,
    "the fork notice went into atrium's queue",
  );
  assert.equal(agentStarts(f), startsBefore, "no adapter at create");
  assert.equal(methods(f).length, opsBefore, "no ACP operation at create");
  const record = readRecord(f, created.acpxRecordId) as PlanRecord;
  assert.equal(record.acp_session_id, "");
  assert.equal(record.forked_at_message_index, 2);
  const sidecar = fs
    .readFileSync(
      path.join(
        path.dirname(recordPath(f, created.acpxRecordId)),
        `${created.acpxRecordId}.messages.ndjson`,
      ),
      "utf8",
    )
    .trim()
    .split("\n");
  assert.equal(
    sidecar.length,
    2,
    "the two inherited messages are stored now (messages sidecar, as a live fork)",
  );
  const cut = record.acpx.sleeping?.fork?.cut;
  assert.equal(record.acpx.sleeping?.fork?.from, source);
  assert.equal(cut?.message_index, 2);
  assert.equal(cut?.log_index, 2);
  assert.match(
    cut?.expect_entry ?? "",
    /^agent:[0-9a-f]{40}$/u,
    "the last inherited entry's print",
  );
  assert.equal(cut?.harness_anchor, undefined, "a non-Claude harness forks by index: no anchor");

  const wake = await runCli(
    [...base(f), "prompt", "--session-id", created.acpxRecordId, "after the cut"],
    f.env,
    f.root,
  );
  assert.equal(wake.code, 0, wake.stderr);
  const fork = operations(f)
    .slice(opsBefore)
    .find((op) => op.method === "session/fork") as { sourceSessionId?: string } | undefined;
  assert.ok(fork, methods(f).join(","));
  // The index on the wire is not in the mock's log; the real-agent proof (verification/TESTER-PLAN.md)
  // checks what the harness's fork holds.
  assert.equal(
    fork.sourceSessionId,
    (readRecord(f, source) as { acp_session_id: string }).acp_session_id,
    "the wake forked the SOURCE's conversation",
  );
  const woken = readRecord(f, created.acpxRecordId) as PlanRecord;
  assert.notEqual(woken.acp_session_id, "");
  assert.equal(woken.acpx.sleeping, undefined);
  assert.equal(woken.forked_at_message_index, 2, "the wake took nothing more from the source");
});

test("A-15 negative: an UNANCHORED cut whose source moved under it fails the wake with FORK_CUT_MOVED and stays sleeping with its plan unchanged", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await warmTarget(f, 2);
  const run = await withAtrium(f, async (env) =>
    runCli([...base(f), "sessions", "copy", "--from", source, "--at-log-index", "2"], env, f.root),
  );
  assert.equal(run.code, 0, run.stderr);
  const id = lastJson(run.stdout).acpxRecordId;
  const file = recordPath(f, id);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as PlanRecord;
  const cut = record.acpx.sleeping?.fork?.cut;
  assert.ok(cut);
  cut.expect_entry = `agent:${"0".repeat(40)}`; // what a rewrite of entry n-1 looks like
  fs.writeFileSync(file, JSON.stringify(record));
  const wake = await runCli(
    [...base(f), "prompt", "--session-id", id, "after the cut"],
    f.env,
    f.root,
  );
  assert.notEqual(wake.code, 0);
  assert.match(wake.stdout + wake.stderr, /FORK_CUT_MOVED/u);
  const after = readRecord(f, id) as PlanRecord;
  assert.equal(after.acp_session_id, "", "still never run");
  assert.deepEqual(after.acpx.sleeping, record.acpx.sleeping, "the plan is as created");
});

test("A-15 negative: an anchor kind the wake cannot execute (unknown, or claude-uuid on a non-Claude harness) is FORK_ANCHOR_UNSUPPORTED and the record stays sleeping", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await warmTarget(f, 2);
  for (const anchor of ["pi-entry:8112d380", "claude-uuid:d591f13c-613f-47c0-b310-6561d42f8a33"]) {
    const run = await withAtrium(f, async (env) =>
      runCli(
        [...base(f), "sessions", "copy", "--from", source, "--at-log-index", "2"],
        env,
        f.root,
      ),
    );
    assert.equal(run.code, 0, run.stderr);
    const id = lastJson(run.stdout).acpxRecordId;
    const file = recordPath(f, id);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as PlanRecord;
    const cut = record.acpx.sleeping?.fork?.cut;
    assert.ok(cut);
    cut.harness_anchor = anchor;
    fs.writeFileSync(file, JSON.stringify(record));
    const wake = await runCli([...base(f), "prompt", "--session-id", id, "x"], f.env, f.root);
    assert.notEqual(wake.code, 0, anchor);
    assert.match(wake.stdout + wake.stderr, /FORK_ANCHOR_UNSUPPORTED/u, anchor);
    assert.equal((readRecord(f, id) as PlanRecord).acp_session_id, "", anchor);
  }
});

test("A-15 negative: a cut of a SLEEPING source is refused at create with FORK_SOURCE_SLEEPING; nothing is created", async () => {
  const f = makeBox({ requestMib: 4000 });
  const sleeping = await runCli([...base(f), "sessions", "new"], pod(f), f.root);
  assert.equal(sleeping.code, 0, sleeping.stderr);
  const sourceId = lastJson(sleeping.stdout).acpxRecordId;
  const before = createdRecordIds(f).length;
  const run = await runCli(
    [...base(f), "sessions", "copy", "--from", sourceId, "--at-log-index", "0"],
    pod(f),
    f.root,
  );
  assert.notEqual(run.code, 0);
  assert.match(run.stdout + run.stderr, /FORK_SOURCE_SLEEPING/u);
  assert.equal(createdRecordIds(f).length, before);
});

test("C1.3: a by-the-way (`--ephemeral`) in pod mode marks the plan `byway` and carries no fork notice", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await warmTarget(f, 1);
  const run = await runCli(
    [...base(f), "sessions", "copy", "--from", source, "--at-log-index", "2", "--ephemeral"],
    pod(f),
    f.root,
  );
  assert.equal(run.code, 0, run.stderr);
  const created = lastJson(run.stdout);
  assert.equal(created.forkNotice, undefined);
  const record = readRecord(f, created.acpxRecordId) as PlanRecord;
  assert.equal(record.acpx.sleeping?.fork?.byway, true);
  assert.equal(record.metadata?.byway, "1");
});

test("C1.3: a resume in pod mode binds the record to the conversation (not sleeping) and starts nothing", async () => {
  const f = makeBox({ requestMib: 4000 });
  const run = await runCli(
    [...base(f), "sessions", "new", "--resume-session", "conversation-77"],
    pod(f),
    f.root,
  );
  assert.equal(run.code, 0, run.stderr);
  const record = readRecord(f, lastJson(run.stdout).acpxRecordId) as PlanRecord;
  assert.equal(record.acp_session_id, "conversation-77");
  assert.equal(record.acpx.sleeping, undefined);
  assert.equal(agentStarts(f), 0);
});

test("C1.3: the first message of a pod-mode create goes into atrium's queue — a person's through the session route, an agent's through the agent-send route — and never to an owner", async () => {
  const f = makeBox({ requestMib: 4000 });
  const stub = await startStubAtrium(() => ({
    status: 202,
    body: { delivery_id: "d-1", to: "x", status: "queued" },
  }));
  try {
    const person = await runCli(
      [...base(f), "sessions", "new", "--prompt", "hello from a person"],
      pod(f, { ...f.env, ACPX_UI_INTERNAL_URL: stub.url }),
      f.root,
    );
    assert.equal(person.code, 0, person.stderr);
    const personId = lastJson(person.stdout).acpxRecordId;
    const personPost = stub.requests.find((r) => r.url === `/api/sessions/${personId}/message`);
    assert.equal((personPost?.body as { text?: string } | undefined)?.text, "hello from a person");

    writeAtriumJson(f, { internalUrl: stub.url });
    const agent = await runCli(
      [...base(f), "sessions", "new", "--prompt", "hello from an agent"],
      pod(f, asAgent(f, { ACPX_UI_INTERNAL_URL: stub.url })),
      f.root,
    );
    assert.equal(agent.code, 0, agent.stderr);
    const agentId = lastJson(agent.stdout).acpxRecordId;
    const agentPost = stub.requests.find((r) => r.url === `/api/sessions/${agentId}/message`);
    assert.ok((agentPost?.body as { delivery_id?: string } | undefined)?.delivery_id);
    assert.equal(agentStarts(f), 0, "no owner, no adapter");
  } finally {
    await stub.close();
  }
});

test("C1.3 negative: atrium unreachable — the first message is NOT queued (exit non-zero, promptQueued false), the record stays, and nothing is delivered directly", async () => {
  const f = makeBox({ requestMib: 4000 });
  const run = await runCli(
    [...base(f), "sessions", "new", "--prompt", "nobody listens"],
    pod(f, { ...f.env, ACPX_UI_INTERNAL_URL: "http://127.0.0.1:9" }),
    f.root,
  );
  assert.notEqual(run.code, 0);
  assert.match(run.stdout, /"promptQueued":false/u);
  assert.equal(createdRecordIds(f).length, 1, "the new record is there");
  assert.equal(agentStarts(f), 0, "no direct fallback: no owner was started");
});

// ─── C6.2 at most once ─────────────────────────────────────────────────────────────────────────

const RECORD_ID = "6f9a1c2e-0b7d-4c3e-9a8f-1e2d3c4b5a69";
const CALL_ID = "0e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a21";

test("C6.2: --created-by-call stores the call id in the create's own write; a replay answers with the same record and writes nothing", async () => {
  const f = makeBox({ requestMib: 4000 });
  const args = [
    ...base(f),
    "sessions",
    "new",
    "--record-id",
    RECORD_ID,
    "--created-by-call",
    CALL_ID,
  ];
  const first = await runCli(args, pod(f), f.root);
  assert.equal(first.code, 0, first.stderr);
  assert.equal((readRecord(f, RECORD_ID) as PlanRecord).metadata?.created_by_call, CALL_ID);
  const bytes = fs.readFileSync(recordPath(f, RECORD_ID), "utf8");
  const replay = await runCli(args, pod(f), f.root);
  assert.equal(replay.code, 0, replay.stderr);
  assert.equal(lastJson(replay.stdout).acpxRecordId, RECORD_ID);
  assert.equal(fs.readFileSync(recordPath(f, RECORD_ID), "utf8"), bytes, "nothing written");
  assert.deepEqual(createdRecordIds(f), [RECORD_ID]);
});

test("C6.2 negatives: another call on the same record id is refused; --created-by-call needs --record-id; it cannot carry a prompt; the metadata key is reserved", async () => {
  const f = makeBox({ requestMib: 4000 });
  const first = await runCli(
    [...base(f), "sessions", "new", "--record-id", RECORD_ID, "--created-by-call", CALL_ID],
    pod(f),
    f.root,
  );
  assert.equal(first.code, 0, first.stderr);
  const other = await runCli(
    [
      ...base(f),
      "sessions",
      "new",
      "--record-id",
      RECORD_ID,
      "--created-by-call",
      "11111111-2222-4333-8444-555555555555",
    ],
    pod(f),
    f.root,
  );
  assert.notEqual(other.code, 0, "a different call never adopts the record");
  for (const extra of [
    ["--created-by-call", CALL_ID],
    [
      "--record-id",
      "7a9a1c2e-0b7d-4c3e-9a8f-1e2d3c4b5a69",
      "--created-by-call",
      CALL_ID,
      "--prompt",
      "x",
    ],
    ["--metadata", `created_by_call=${CALL_ID}`],
  ]) {
    const run = await runCli([...base(f), "sessions", "new", ...extra], pod(f), f.root);
    assert.equal(run.code, 2, `${extra.join(" ")}: ${run.stderr}`);
  }
  assert.deepEqual(createdRecordIds(f), [RECORD_ID], "only the first create wrote anything");
});

test("C6.2: a pass-through copy returns its fork notice for atrium to queue, posts nothing, and a replay returns the same notice", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await warmTarget(f, 1);
  const stub = await startStubAtrium(() => ({ status: 500 }));
  try {
    const args = [
      ...base(f),
      "sessions",
      "copy",
      "--from",
      source,
      "--record-id",
      RECORD_ID,
      "--created-by-call",
      CALL_ID,
    ];
    const env = pod(f, { ...f.env, ACPX_UI_INTERNAL_URL: stub.url });
    const first = await runCli(args, env, f.root);
    assert.equal(first.code, 0, first.stderr);
    const notice = lastJson(first.stdout).forkNotice;
    assert.match(String(notice), /^⟦FORK-NOTICE⟧\n/u);
    assert.equal(stub.requests.length, 0, "atrium queues it — acpx posts nothing");
    const replay = await runCli(args, env, f.root);
    assert.equal(replay.code, 0, replay.stderr);
    assert.equal(lastJson(replay.stdout).forkNotice, notice);
  } finally {
    await stub.close();
  }
});

test("C6.2 for `sessions import` (a create form): --record-id + --created-by-call — fresh writes the call id, a replay answers with the same record and writes nothing, another call on that id is refused", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await makeTarget(f);
  const archive = path.join(f.root, "archive.json");
  const exported = await runCli(
    [...base(f), "sessions", "export", "--session-id", source, "--output", archive],
    f.env,
    f.root,
  );
  assert.equal(exported.code, 0, exported.stderr);
  fs.rmSync(recordPath(f, source)); // one record per provider session, as the import test does

  const args = [
    ...base(f),
    "sessions",
    "import",
    archive,
    "--record-id",
    RECORD_ID,
    "--created-by-call",
    CALL_ID,
  ];
  const first = await runCli(args, f.env, f.root);
  assert.equal(first.code, 0, first.stderr);
  assert.equal((JSON.parse(first.stdout) as { record_id?: string }).record_id, RECORD_ID);
  assert.equal((readRecord(f, RECORD_ID) as PlanRecord).metadata?.created_by_call, CALL_ID);
  const bytes = fs.readFileSync(recordPath(f, RECORD_ID), "utf8");

  const replay = await runCli(args, f.env, f.root);
  assert.equal(replay.code, 0, replay.stderr);
  assert.deepEqual(JSON.parse(replay.stdout), JSON.parse(first.stdout), "the same answer");
  assert.equal(fs.readFileSync(recordPath(f, RECORD_ID), "utf8"), bytes, "nothing written");

  const other = await runCli(
    args.map((arg) => (arg === CALL_ID ? "11111111-2222-4333-8444-555555555555" : arg)),
    f.env,
    f.root,
  );
  assert.notEqual(other.code, 0, "a different call never adopts the record");
  const withoutId = await runCli(
    [...base(f), "sessions", "import", archive, "--created-by-call", CALL_ID],
    f.env,
    f.root,
  );
  assert.equal(withoutId.code, 2, "--created-by-call needs --record-id");
  assert.deepEqual(createdRecordIds(f), [RECORD_ID]);
});
