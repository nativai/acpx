import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
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
  parseSleepingPlan,
  type SleepingPlanState,
} from "../src/pod/create-plan.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";
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

test("M-1 / C1.3 negative: a cut field that is PRESENT but not a valid value damages the whole cut — never dropped (a dropped anchor wakes the cut BY POSITION)", () => {
  const damagedFields: Array<[string, unknown]> = [
    ["harness_anchor", 42],
    ["harness_anchor", ""],
    ["harness_anchor", null],
    ["harness_anchor", { kind: "claude-uuid" }],
    ["expect_entry", 42],
    ["expect_entry", ""],
    ["log_index", "5"],
    ["log_index", -1],
    ["log_index", 1.5],
  ];
  for (const [field, bad] of damagedFields) {
    const raw = JSON.parse(JSON.stringify(CUT)) as { fork: { cut: Record<string, unknown> } };
    raw.fork.cut[field] = bad;
    const parsed = parseSleepingPlan(raw);
    assert.equal(parsed?.plan, -1, `${field}=${JSON.stringify(bad)}: the plan becomes unknown`);
    assert.equal(
      parsed?.fork?.cut,
      undefined,
      `${field}=${JSON.stringify(bad)}: no half-read cut survives`,
    );
    assert.ok(parsed);
    assert.throws(
      () => assertKnownPlanVersion(parsed, "r1"),
      (error: Error) => error.message.startsWith(CREATE_PLAN_UNSUPPORTED),
      `${field}=${JSON.stringify(bad)}: the wake refuses by name`,
    );
  }
  // The control: the same cut with every field valid, and with the optional ones absent, is read whole.
  assert.deepEqual(parseSleepingPlan(JSON.parse(JSON.stringify(CUT))), CUT);
  const bare = { since: CUT.since, plan: 1, fork: { from: "s", cut: { message_index: 2 } } };
  assert.deepEqual(parseSleepingPlan(bare)?.fork?.cut, { message_index: 2 });
});

/** One rule for every field the plan reader knows: PRESENT and invalid means damaged (R2-F1, M-1). */
const DAMAGE: Array<{ field: string; edit: (plan: Record<string, unknown>) => void }> = [
  {
    field: "sleeping.plan = 1.5",
    edit: (p) => {
      p.plan = 1.5;
    },
  },
  {
    field: "sleeping.plan = null",
    edit: (p) => {
      p.plan = null;
    },
  },
  {
    field: "sleeping.fork = 42",
    edit: (p) => {
      p.fork = 42;
    },
  },
  {
    field: "sleeping.fork = null",
    edit: (p) => {
      p.fork = null;
    },
  },
  {
    field: "fork.from = 42",
    edit: (p) => {
      (p.fork as Record<string, unknown>).from = 42;
    },
  },
  {
    field: 'fork.from = ""',
    edit: (p) => {
      (p.fork as Record<string, unknown>).from = "";
    },
  },
  {
    field: "fork.from absent",
    edit: (p) => {
      delete (p.fork as Record<string, unknown>).from;
    },
  },
  {
    field: "fork.cut = 42",
    edit: (p) => {
      (p.fork as Record<string, unknown>).cut = 42;
    },
  },
  {
    field: "fork.cut = null",
    edit: (p) => {
      (p.fork as Record<string, unknown>).cut = null;
    },
  },
  {
    field: 'fork.byway = "yes"',
    edit: (p) => {
      (p.fork as Record<string, unknown>).byway = "yes";
    },
  },
  {
    field: "fork.byway = false",
    edit: (p) => {
      (p.fork as Record<string, unknown>).byway = false;
    },
  },
  {
    field: "cut.message_index = 'five'",
    edit: (p) => {
      (p.fork as { cut: Record<string, unknown> }).cut.message_index = "five";
    },
  },
  {
    field: "cut.log_index = '5'",
    edit: (p) => {
      (p.fork as { cut: Record<string, unknown> }).cut.log_index = "5";
    },
  },
  {
    field: "cut.expect_entry = 42",
    edit: (p) => {
      (p.fork as { cut: Record<string, unknown> }).cut.expect_entry = 42;
    },
  },
  {
    field: "cut.harness_anchor = 42",
    edit: (p) => {
      (p.fork as { cut: Record<string, unknown> }).cut.harness_anchor = 42;
    },
  },
];

test("R2-F1 / M-1 negative: EVERY plan field that is present but invalid damages the plan (sleeping.plan, sleeping.fork, fork.from, fork.cut, fork.byway, cut.message_index, cut.log_index, cut.expect_entry, cut.harness_anchor) — the wake refuses; none silently becomes a fresh agent", () => {
  for (const { field, edit } of DAMAGE) {
    const raw = JSON.parse(JSON.stringify(CUT)) as Record<string, unknown>;
    edit(raw);
    const parsed = parseSleepingPlan(raw);
    assert.ok(parsed, `${field}: still a sleeping record`);
    assert.equal(parsed.plan, -1, `${field}: the plan becomes unknown`);
    assert.equal(parsed.fork, undefined, `${field}: nothing of a damaged fork is executable`);
    assert.throws(
      () => assertKnownPlanVersion(parsed, "r1"),
      (error: Error) => error.message.startsWith(CREATE_PLAN_UNSUPPORTED),
      `${field}: the wake refuses by name`,
    );
  }
  // The controls: unknown extra fields are ignored (rule 2), a valid plan and a valid byway are read whole.
  const extra = { ...JSON.parse(JSON.stringify(CUT)), future_field: { x: 1 } } as Record<
    string,
    unknown
  >;
  assert.deepEqual(parseSleepingPlan(extra), CUT);
  assert.equal(
    parseSleepingPlan({ since: "t", fork: { from: "s", byway: true } })?.fork?.byway,
    true,
  );
});

test("R2-F2: a damaged plan keeps its RAW value in memory and the record serializer writes it back unchanged — the parsed view is never what reaches the disk", () => {
  for (const { field, edit } of DAMAGE) {
    const raw = JSON.parse(JSON.stringify(CUT)) as Record<string, unknown>;
    edit(raw);
    const parsed = parseSleepingPlan(raw);
    assert.ok(parsed);
    for (const copy of [
      parsed,
      cloneSleepingPlan(parsed),
      cloneSessionAcpxState({ sleeping: parsed })?.sleeping,
    ]) {
      const record = makeSessionRecord({
        acpxRecordId: "r-damaged",
        acpSessionId: "",
        agentCommand: "agent",
        cwd: "/tmp",
        acpx: { sleeping: copy },
      });
      const persisted = serializeSessionRecordForDisk(record) as { acpx: { sleeping: unknown } };
      assert.deepEqual(
        persisted.acpx.sleeping,
        raw,
        `${field}: every byte of the damaged plan, valid fields included`,
      );
    }
  }
  // The control: a VALID plan is written from its fields, with nothing extra.
  const valid = serializeSessionRecordForDisk(
    makeSessionRecord({
      acpxRecordId: "r-ok",
      acpSessionId: "",
      agentCommand: "agent",
      cwd: "/tmp",
      acpx: { sleeping: CUT },
    }),
  ) as { acpx: { sleeping: unknown } };
  assert.deepEqual(valid.acpx.sleeping, CUT);
});

test("M-1 / R2-F1 / R2-F2 through a real wake: a record with ANY damaged plan field is refused by name, stays sleeping, is not cut by position and does not become a fresh agent — and its plan on disk is exactly what was there before the wake", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await warmTarget(f, 2);
  const wakeCases = DAMAGE.filter(({ field }) =>
    [
      "fork.from = 42",
      'fork.from = ""',
      "fork.byway = false",
      "cut.harness_anchor = 42",
      "cut.expect_entry = 42",
      "sleeping.fork = 42",
    ].includes(field),
  );
  assert.equal(wakeCases.length, 6, "the field list did not shrink");
  for (const { field, edit } of wakeCases) {
    const created = await withAtrium(f, async (env) =>
      runCli(
        [...base(f), "sessions", "copy", "--from", source, "--at-log-index", "2"],
        env,
        f.root,
      ),
    );
    assert.equal(created.code, 0, created.stderr);
    const id = lastJson(created.stdout).acpxRecordId;
    const file = recordPath(f, id);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as {
      acpx: { sleeping: Record<string, unknown> };
    };
    edit(record.acpx.sleeping);
    fs.writeFileSync(file, JSON.stringify(record));
    const planBefore = JSON.parse(JSON.stringify(record.acpx.sleeping)) as unknown;
    const opsBefore = methods(f).length;
    const wake = await runCli([...base(f), "prompt", "--session-id", id, "x"], f.env, f.root);
    assert.notEqual(wake.code, 0, field);
    assert.match(wake.stdout + wake.stderr, /CREATE_PLAN_UNSUPPORTED/u, field);
    const after = readRecord(f, id) as PlanRecord & { acpx: { sleeping?: unknown } };
    assert.equal(after.acp_session_id, "", `${field}: still never run`);
    assert.deepEqual(
      after.acpx.sleeping,
      planBefore,
      `${field}: the plan on disk is byte-identical to before the wake, valid fields included`,
    );
    assert.equal(
      methods(f)
        .slice(opsBefore)
        .filter((m) => m === "session/fork" || m === "session/new").length,
      0,
      `${field}: no fork by position and no fresh session`,
    );
  }
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

// ─── creates through the real CLI (the UMQ rig: a mock agent that logs every start and op) ──────

/** Pod mode through A1's seams (`ACPX_POD_TEST_HOME`, `ACPX_POD_SA_DIR` — honoured under `node --test` only). */
const pod = (f: Fixture, env: NodeJS.ProcessEnv = f.env): NodeJS.ProcessEnv => {
  const sa = path.join(f.root, "serviceaccount");
  fs.mkdirSync(sa, { recursive: true });
  fs.writeFileSync(path.join(sa, "namespace"), "dev-devbox\n");
  return {
    ...env,
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: f.root,
    ACPX_POD_SA_DIR: sa,
    NV_POD_NAME: "dev-server-0",
    NV_POD_UID: "00000000-0000-0000-0000-000000000001",
    NV_NODE_NAME: "node-a",
  };
};

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

async function warmTarget(f: Fixture, turns: number, extra: string[] = []): Promise<string> {
  const target = await makeTarget(f, extra);
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

/** A record without the four fields that describe the stream's appended events (see the L-1 row). */
function withoutStreamBookkeeping(record: unknown): unknown {
  const copy = structuredClone(record) as Record<string, unknown> & {
    event_log?: Record<string, unknown>;
  };
  for (const key of ["last_seq", "last_request_id", "last_used_at"]) {
    delete copy[key];
  }
  if (copy.event_log) {
    delete copy.event_log.last_write_at;
  }
  return copy;
}

/** The session's stream file, or undefined when no event was ever appended (a refused wake appends none). */
function streamBytes(f: Fixture, id: string): string | undefined {
  try {
    return fs.readFileSync(
      path.join(path.dirname(recordPath(f, id)), `${id}.stream.ndjson`),
      "utf8",
    );
  } catch {
    return undefined;
  }
}

test("L-1 / C1.3: a REFUSED first wake leaves the record exactly as it was before the wake — no dead adapter pid, no agent_started_at, no last_seq, no stream events (anchor refusal and FORK_CUT_MOVED)", async () => {
  const f = makeBox({ requestMib: 4000 });
  // R2-F3: the second source PINS A MODEL — the shape of a real Claude session (`--model haiku`). The
  // record write funnel realigns `acpx.current_model_id` to a pin on the first write of a record that has
  // none, so a refused wake used to add it (Claude only: the TE's Pi session pinned no model).
  const sources = [await warmTarget(f, 2), await warmTarget(f, 2, ["--model", "sonnet"])];
  const pinnedSource = sources[1];
  assert.equal(
    (readRecord(f, pinnedSource) as { acpx: { session_options?: { model?: string } } }).acpx
      .session_options?.model,
    "sonnet",
    "the control: this source really pins a model",
  );
  const tampers: Array<{
    name: string;
    code: RegExp;
    edit: (cut: NonNullable<SleepingPlanState["fork"]>["cut"]) => void;
  }> = [
    {
      name: "unknown anchor kind",
      code: /FORK_ANCHOR_UNSUPPORTED/u,
      edit: (cut) => {
        if (cut) {
          cut.harness_anchor = "pi-entry:8112d380";
        }
      },
    },
    {
      name: "moved unanchored cut",
      code: /FORK_CUT_MOVED/u,
      edit: (cut) => {
        if (cut) {
          cut.expect_entry = `agent:${"0".repeat(40)}`;
        }
      },
    },
  ];
  for (const [source, tamper] of sources.flatMap((src) => tampers.map((t) => [src, t] as const))) {
    const label = `${tamper.name}${source === pinnedSource ? " (model pinned)" : ""}`;
    const created = await withAtrium(f, async (env) =>
      runCli(
        [...base(f), "sessions", "copy", "--from", source, "--at-log-index", "2"],
        env,
        f.root,
      ),
    );
    assert.equal(created.code, 0, created.stderr);
    const id = lastJson(created.stdout).acpxRecordId;
    const file = recordPath(f, id);
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as PlanRecord;
    tamper.edit(record.acpx.sleeping?.fork?.cut);
    fs.writeFileSync(file, JSON.stringify(record));
    const recordBefore = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const streamBefore = streamBytes(f, id);
    const wake = await runCli([...base(f), "prompt", "--session-id", id, "x"], f.env, f.root);
    assert.notEqual(wake.code, 0, label);
    assert.match(wake.stdout + wake.stderr, tamper.code, label);
    // The record equals what it was before the wake EXCEPT the stream's own bookkeeping — the refused
    // attempt's turn log is really appended to the stream (and a failed delivery's terminal must be, C1.3),
    // so `last_seq`, `last_request_id`, `last_used_at` and `event_log.last_write_at` describe those events.
    assert.deepEqual(
      withoutStreamBookkeeping(readRecord(f, id)),
      withoutStreamBookkeeping(recordBefore),
      `${label}: the record is as it was before the wake (no dead adapter pid, start time, prompt time, OS observation, current_model_id)`,
    );
    const after = readRecord(f, id) as { last_seq: number };
    const lines = (streamBytes(f, id) ?? "").split("\n").filter(Boolean).length;
    assert.ok(
      after.last_seq > 0 && lines >= after.last_seq,
      `${label}: last_seq (${after.last_seq}) counts events really in the stream (${lines})`,
    );
    assert.ok(
      (streamBytes(f, id) ?? "").startsWith(streamBefore ?? ""),
      `${label}: the stream only grew`,
    );
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
    assert.equal((personPost?.body as { from?: string } | undefined)?.from, "acpx:first-message");
    assert.equal(lastJson(person.stdout).promptQueued, true, "queued, and the answer says so");
    assert.equal(lastJson(person.stdout).sleeping, true);

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

// ─── A-18: a cut never ends inside the source's in-progress agent entry (Pi, Codex) ─────────────

/** The source as the running turn leaves it mid-way (measured, `verification/real-agent/p3-*`, `p8-*`):
 *  the turn's User and its growing Agent entry are in the record's INLINE tail, not yet in the log. */
function putTurnInProgress(f: Fixture, sourceId: string, userId: string, partial: string): void {
  const file = recordPath(f, sourceId);
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  record.messages = [
    { User: { id: userId, content: [{ Text: "a question still being answered" }] } },
    { Agent: { content: [{ Text: partial }], tool_results: {} } },
  ];
  fs.writeFileSync(file, JSON.stringify(record));
}

test("A-18 (Pi, Codex): a by-the-way cut at the end of a RUNNING turn is moved to before the in-progress agent entry; it survives the entry growing and wakes", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await warmTarget(f, 1); // 2 entries, both at a turn boundary (in the log)
  const userId = "a18a18a1-0000-4000-8000-000000000001";
  putTurnInProgress(f, source, userId, "1\n2\n3");
  const run = await runCli(
    [
      ...base(f),
      "sessions",
      "copy",
      "--from",
      source,
      "--at-log-index",
      "4",
      "--ephemeral",
      "--record-id",
      RECORD_ID,
      "--created-by-call",
      CALL_ID,
    ],
    pod(f),
    f.root,
  );
  assert.equal(run.code, 0, run.stderr);
  const record = readRecord(f, RECORD_ID) as PlanRecord & {
    forked_at_message_index_requested?: number;
  };
  assert.equal(record.forked_at_message_index, 3, "moved down past the in-progress agent entry");
  assert.equal(record.forked_at_message_index_requested, 4, "the move is recorded");
  const cut = record.acpx.sleeping?.fork?.cut;
  assert.equal(cut?.message_index, 3);
  assert.equal(cut?.log_index, 3);
  assert.equal(
    cut?.expect_entry,
    `user:${userId}`,
    "the last inherited entry is the turn's user message",
  );

  putTurnInProgress(f, source, userId, "1\n2\n3\n4\n5\n6 — the reply kept growing after create");
  const wake = await runCli([...base(f), "prompt", "--session-id", RECORD_ID, "x"], f.env, f.root);
  assert.equal(wake.code, 0, `the grown entry is not part of the cut: ${wake.stderr}`);
  assert.notEqual((readRecord(f, RECORD_ID) as PlanRecord).acp_session_id, "");
});

test("A-18 negative: a cut whose last entry is a COMPLETED agent entry (the turn is over) is not moved", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await warmTarget(f, 2); // 4 entries, all at turn boundaries
  const run = await runCli(
    [
      ...base(f),
      "sessions",
      "copy",
      "--from",
      source,
      "--at-log-index",
      "4",
      "--ephemeral",
      "--record-id",
      RECORD_ID,
      "--created-by-call",
      CALL_ID,
    ],
    pod(f),
    f.root,
  );
  assert.equal(run.code, 0, run.stderr);
  const record = readRecord(f, RECORD_ID) as PlanRecord & {
    forked_at_message_index_requested?: number;
  };
  assert.equal(record.forked_at_message_index, 4);
  assert.equal(record.forked_at_message_index_requested, undefined);
  assert.equal(record.acpx.sleeping?.fork?.cut?.message_index, 4);
});

test("C6.2: a replay prints byte for byte what the first answer printed — every create form that can carry a fork notice (S2 tester N-A2-1: a plain copy with --metadata byway=1 lost its notice on replay)", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await warmTarget(f, 2);
  const template = await warmTarget(f, 1);
  const marked = await runCli(
    [...base(f), "sessions", "template", template, "--enable", "--auto-prompt", "do the thing"],
    f.env,
    f.root,
  );
  assert.equal(marked.code, 0, marked.stderr);
  const forms: Array<{ name: string; argv: string[] }> = [
    { name: "new", argv: ["sessions", "new"] },
    { name: "plain copy", argv: ["sessions", "copy", "--from", source] },
    {
      name: "plain copy with --metadata byway=1",
      argv: ["sessions", "copy", "--from", source, "--metadata", "byway=1"],
    },
    { name: "by-the-way", argv: ["sessions", "copy", "--from", source, "--ephemeral"] },
    { name: "cut", argv: ["sessions", "copy", "--from", source, "--at-log-index", "2"] },
    { name: "from a template", argv: ["sessions", "new", "--from-template", template] },
  ];
  for (const [index, form] of forms.entries()) {
    const recordId = `5a5a5a5a-0000-4000-8000-00000000000${index}`;
    const callId = `c0c0c0c0-0000-4000-8000-00000000000${index}`;
    const argv = [...base(f), ...form.argv, "--record-id", recordId, "--created-by-call", callId];
    const first = await runCli(argv, pod(f), f.root);
    assert.equal(first.code, 0, `${form.name}: ${first.stderr}`);
    const replay = await runCli(argv, pod(f), f.root);
    assert.equal(replay.code, 0, `${form.name} replay: ${replay.stderr}`);
    assert.equal(
      replay.stdout,
      first.stdout,
      `${form.name}: the replay's answer is the first answer`,
    );
  }
});

test("M-2 / C6.2 negative: a replay (same --record-id + --created-by-call) whose REQUEST differs from what the record holds is refused CREATE_REPLAY_MISMATCH and writes nothing — another cut, an added --prompt, another source, another template; only the identical request returns the first answer", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await warmTarget(f, 3); // 6 entries: cuts at 6 and at 4 differ
  const other = await warmTarget(f, 1);
  const template = await warmTarget(f, 1);
  const marked = await runCli(
    [...base(f), "sessions", "template", template, "--enable", "--auto-prompt", "do the thing"],
    f.env,
    f.root,
  );
  assert.equal(marked.code, 0, marked.stderr);
  const ids = (n: number) => ({
    record: `4d4d4d4d-0000-4000-8000-00000000000${n}`,
    call: `d0d0d0d0-0000-4000-8000-00000000000${n}`,
  });
  const cases: Array<{ name: string; first: string[]; changed: string[][] }> = [
    {
      name: "cut",
      first: ["sessions", "copy", "--from", source, "--at-log-index", "6"],
      changed: [
        ["sessions", "copy", "--from", source, "--at-log-index", "4"],
        ["sessions", "copy", "--from", source, "--at-log-index", "6", "--ephemeral"],
        ["sessions", "copy", "--from", source, "--at-log-index", "6", "--prompt", "hello"],
        ["sessions", "copy", "--from", other, "--at-log-index", "2"],
      ],
    },
    {
      name: "new",
      first: ["sessions", "new"],
      changed: [
        ["sessions", "new", "--prompt", "hello"],
        ["sessions", "new", "--name", "another"],
      ],
    },
    {
      name: "template",
      first: ["sessions", "new", "--from-template", template],
      changed: [["sessions", "new", "--from-template", other]],
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const { record, call } = ids(index);
    const tail = ["--record-id", record, "--created-by-call", call];
    const first = await runCli([...base(f), ...scenario.first, ...tail], pod(f), f.root);
    assert.equal(first.code, 0, `${scenario.name}: ${first.stderr}`);
    const bytes = fs.readFileSync(recordPath(f, record), "utf8");
    const known = createdRecordIds(f).length;
    for (const changed of scenario.changed) {
      const run = await runCli([...base(f), ...changed, ...tail], pod(f), f.root);
      assert.notEqual(run.code, 0, `${scenario.name}: ${changed.join(" ")} must be refused`);
      assert.match(run.stdout + run.stderr, /CREATE_REPLAY_MISMATCH/u, changed.join(" "));
      assert.equal(
        fs.readFileSync(recordPath(f, record), "utf8"),
        bytes,
        `${changed.join(" ")}: the record is unchanged`,
      );
      assert.equal(createdRecordIds(f).length, known, `${changed.join(" ")}: nothing was created`);
    }
    const again = await runCli([...base(f), ...scenario.first, ...tail], pod(f), f.root);
    assert.equal(again.code, 0, `${scenario.name}: the identical request is still a replay`);
    assert.equal(again.stdout, first.stdout, `${scenario.name}: ... and gets the first answer`);
  }
});

test("L-2 / C6.2 (as built): after the first wake a replay returns the CURRENT record with exit 0 — the answer is rebuilt from the record, so it is no longer the first answer's bytes (the contract's byte-for-byte window is 'still sleeping')", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await warmTarget(f, 2);
  const argv = [
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
  const first = await runCli(argv, pod(f), f.root);
  assert.equal(first.code, 0, first.stderr);
  const firstAnswer = lastJson(first.stdout);
  assert.equal(firstAnswer.acpxSessionId, "", "the first answer: sleeping, no conversation yet");
  const sleepingReplay = await runCli(argv, pod(f), f.root);
  assert.equal(sleepingReplay.stdout, first.stdout, "while the record still sleeps: byte for byte");

  const wake = await runCli([...base(f), "prompt", "--session-id", RECORD_ID, "x"], f.env, f.root);
  assert.equal(wake.code, 0, wake.stderr);
  const woken = await runCli(argv, pod(f), f.root);
  assert.equal(woken.code, 0, woken.stderr);
  const replay = lastJson(woken.stdout);
  assert.equal(replay.acpxRecordId, RECORD_ID, "the same record");
  assert.notEqual(replay.acpxSessionId, "", "the CURRENT record: it has a conversation now");
  assert.deepEqual(createdRecordIds(f).includes(RECORD_ID), true);
});

test("R2-F4 / C6.2 for a FILE-valued argument: the import's request fingerprint covers the archive's BYTES, not its path — the same bytes at another (temp) path replay; different bytes at the same path are refused CREATE_REPLAY_MISMATCH", async () => {
  const f = makeBox({ requestMib: 4000 });
  const source = await makeTarget(f);
  const other = await makeTarget(f);
  const exportTo = async (id: string, file: string) => {
    const run = await runCli(
      [...base(f), "sessions", "export", "--session-id", id, "--output", file],
      f.env,
      f.root,
    );
    assert.equal(run.code, 0, run.stderr);
  };
  const archive = path.join(f.root, "archive.json");
  const elsewhere = path.join(f.root, "retry", "attempt-2.json");
  const different = path.join(f.root, "different.json");
  await exportTo(source, archive);
  await exportTo(other, different);
  assert.notEqual(
    fs.readFileSync(archive, "utf8"),
    fs.readFileSync(different, "utf8"),
    "the control: two archives that differ",
  );
  fs.rmSync(recordPath(f, source));
  fs.rmSync(recordPath(f, other));

  const tail = ["--record-id", RECORD_ID, "--created-by-call", CALL_ID];
  const first = await runCli([...base(f), "sessions", "import", archive, ...tail], f.env, f.root);
  assert.equal(first.code, 0, first.stderr);
  const bytes = fs.readFileSync(recordPath(f, RECORD_ID), "utf8");

  // Same bytes, another path (a pass-through writes a per-attempt temp file): an identical request.
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
  fs.copyFileSync(archive, elsewhere);
  const movedFile = await runCli(
    [...base(f), "sessions", "import", elsewhere, ...tail],
    f.env,
    f.root,
  );
  assert.equal(movedFile.code, 0, `same bytes at another path must replay: ${movedFile.stderr}`);
  assert.equal(movedFile.stdout, first.stdout, "... and get the first answer");

  // Different bytes behind the SAME path: not the request that was made.
  fs.copyFileSync(different, archive);
  const swapped = await runCli([...base(f), "sessions", "import", archive, ...tail], f.env, f.root);
  assert.notEqual(swapped.code, 0, "different bytes at the same path must be refused");
  assert.match(swapped.stdout + swapped.stderr, /CREATE_REPLAY_MISMATCH/u);
  assert.equal(fs.readFileSync(recordPath(f, RECORD_ID), "utf8"), bytes, "nothing was written");
  assert.deepEqual(createdRecordIds(f), [RECORD_ID], "the other archive was not imported");
});

test("A-21 (brick db8fe858): `acpx --format json capacity` lists `fork-cut` in AND out of pod mode — the promise that this build executes C1.3's plan at the first wake (pinned or computed) and refuses an unknown plan version or anchor kind by name; atrium never delivers a fork at a cut to an acpx that does not list it", async () => {
  const f = makeBox({ requestMib: 4000 });
  const features = (stdout: string): string[] =>
    (JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { features?: string[] }).features ??
    [];
  const off = await runCli(["--format", "json", "capacity"], f.env, f.root);
  assert.equal(off.code, 0, off.stderr);
  assert.ok(features(off.stdout).includes("fork-cut"), "pod mode OFF lists fork-cut");
  const on = await runCli(["--format", "json", "capacity"], pod(f), f.root);
  assert.equal(on.code, 0, on.stderr);
  assert.ok(features(on.stdout).includes("fork-cut"), "pod mode ON lists fork-cut");
  // The control: the older features are still listed beside it, so the row reads a real features array.
  for (const feature of ["prompt-batch", "sessions-new-sleeping", "run-build", "cpu-guard"]) {
    assert.ok(features(on.stdout).includes(feature), `${feature} is still listed`);
  }
});
