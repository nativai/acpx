import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { capacitySourcesFromEnv, readCapacity } from "../src/capacity/reading.js";
import { NO_WAITING } from "../src/capacity/waiting.js";
import {
  ATRIUM_REQUIRED_FEATURES,
  type AtriumJsonV1,
  formatAhead,
  readAtriumJson,
  readerInsideOwnerTreeNow,
  type RouteInput,
  shouldRouteAgentPrompt,
} from "../src/cli/prompt-routing.js";
import {
  asAgent,
  ATRIUM_FEATURES,
  CALLER,
  type Fixture,
  leaseFiles,
  makeBox,
  makeTarget,
  methods,
  operations,
  readRecord,
  recordPath,
  refusedUrl,
  runCli,
  sha256,
  startStubAtrium,
  type RecordedRequest,
  type StubReply,
  withoutCallerIdentity,
  writeAtriumJson,
  agentStarts,
} from "./umq-rig.js";

// UMQ lane A2, D1 (CONCEPTION §7.2, CONTRACTS §3.2, §5, §10) — an agent's `acpx prompt` is routed
// through atrium's queue. The stub atrium records every request; N-A2-* ids are the committed
// negative cases of TEST-PLAN §4.2.

const SESSION_URL = "https://atrium.example.test/?session=5e55c0de-0000-4000-8000-0000000000aa";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const agentEnv = (f: Fixture, extra: NodeJS.ProcessEnv = {}) =>
  asAgent(f, { ACPX_SESSION_URL: SESSION_URL, ...extra });

const baseArgs = (f: Fixture, global: string[] = []): string[] => [
  "--agent",
  f.agent,
  "--cwd",
  path.join(f.root, "work"),
  "--approve-all",
  ...global,
];

function promptArgs(f: Fixture, id: string, text = "do the work", extra: string[] = []): string[] {
  return [
    ...baseArgs(f),
    "--format",
    "json",
    "prompt",
    "--session-id",
    id,
    "--no-wait",
    ...extra,
    text,
  ];
}

const answerFor = (request: RecordedRequest, extra: Record<string, unknown> = {}): StubReply => {
  const body = request.body as { delivery_id?: string };
  return {
    status: 202,
    body: {
      delivery_id: body.delivery_id,
      from: SESSION_URL,
      to: "recipient",
      status: "queued",
      ...extra,
    },
  };
};

function lastJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

/** Polls the rig's ACP operation log until `method` appears (an owner's turn runs after `--no-wait` returns). */
async function waitForMethod(f: Fixture, method: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!methods(f).includes(method)) {
    if (Date.now() > deadline) {
      throw new Error(`no ${method} within ${timeoutMs} ms: ${methods(f).join(",")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function ledgerLines(f: Fixture): string[] {
  const dir = path.join(f.root, ".acpx", "message-ledger");
  try {
    return fs
      .readdirSync(dir)
      .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").split("\n"))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function routedRig(reply: (request: RecordedRequest) => StubReply = answerFor, box = {}) {
  const f = makeBox({ requestMib: 4000, ...box });
  const id = await makeTarget(f);
  const stub = await startStubAtrium(reply);
  writeAtriumJson(f, { internalUrl: stub.url });
  return { f, id, stub };
}

// ─── N-A2-5 · the predicate ───────────────────────────────────────────────────────────────────

const GOOD_ATRIUM: AtriumJsonV1 = {
  schema: 1,
  internalUrl: "http://127.0.0.1:3456",
  writer: "atrium-test",
  features: [...ATRIUM_FEATURES],
  writtenAt: new Date().toISOString(),
};
const GOOD_INPUT: RouteInput = {
  caller: { session: CALLER, seat: null, url: SESSION_URL },
  insideOwnerTree: true,
  batchFile: false,
  atrium: GOOD_ATRIUM,
};

test("N-A2-5 · D1/K8 predicate: the routed input with exactly one field changed is NOT routed; the unchanged input is", () => {
  assert.equal(shouldRouteAgentPrompt(GOOD_INPUT), true, "the control");
  const changed: Array<[string, RouteInput]> = [
    ["no caller identity", { ...GOOD_INPUT, caller: undefined }],
    ["caller outside an owner tree", { ...GOOD_INPUT, insideOwnerTree: false }],
    ["--message-id given", { ...GOOD_INPUT, messageId: "7f0c0000-0000-4000-8000-000000000000" }],
    ["--batch-file", { ...GOOD_INPUT, batchFile: true }],
    ["no atrium.json", { ...GOOD_INPUT, atrium: undefined }],
    ...ATRIUM_REQUIRED_FEATURES.map((missing): [string, RouteInput] => [
      `atrium.json missing ${missing}`,
      {
        ...GOOD_INPUT,
        atrium: {
          ...GOOD_ATRIUM,
          features: GOOD_ATRIUM.features.filter((name) => name !== missing),
        },
      },
    ]),
  ];
  for (const [label, input] of changed) {
    assert.equal(shouldRouteAgentPrompt(input), false, label);
  }
});

test("N-A2-5 · atrium.json: stale (≥ 5 min), 3 s in the future, wrong schema or a non-http URL read as absent; −2 s … 5 min counts", async () => {
  const f = makeBox();
  const saved = process.env.ACPX_STATE_HOME;
  process.env.ACPX_STATE_HOME = f.root;
  try {
    const url = "http://127.0.0.1:3456";
    writeAtriumJson(f, { internalUrl: url });
    assert.equal(readAtriumJson()?.internalUrl, url, "fresh");
    writeAtriumJson(f, { internalUrl: `${url}///` });
    assert.equal(readAtriumJson()?.internalUrl, url, "trailing slashes stripped");
    writeAtriumJson(f, { internalUrl: url, ageMs: 4 * 60_000 });
    assert.ok(readAtriumJson(), "4 min old still counts");
    writeAtriumJson(f, { internalUrl: url, ageMs: 5 * 60_000 + 1_000 });
    assert.equal(readAtriumJson(), undefined, "stale");
    writeAtriumJson(f, { internalUrl: url, ageMs: -1_000 });
    assert.ok(readAtriumJson(), "a fraction in the future (NFS clock) counts");
    writeAtriumJson(f, { internalUrl: url, ageMs: -3_000 });
    assert.equal(readAtriumJson(), undefined, "3 s in the future");
    writeAtriumJson(f, { internalUrl: url, schema: 2 });
    assert.equal(readAtriumJson(), undefined, "another schema");
    writeAtriumJson(f, { internalUrl: "ftp://x" });
    assert.equal(readAtriumJson(), undefined, "not http(s)");
    fs.writeFileSync(path.join(f.root, ".acpx", "atrium.json"), "{not json");
    assert.equal(readAtriumJson(), undefined, "unparseable");
  } finally {
    if (saved === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = saved;
    }
  }
});

test("owner tree: the ancestry check agrees with the census (`self`) inside and outside an owner tree", () => {
  const saved = process.env.ACPX_STATE_HOME;
  try {
    for (const inOwnerTree of [true, false]) {
      const f = makeBox({ requestMib: 4000, inOwnerTree });
      process.env.ACPX_STATE_HOME = f.root;
      const census = readCapacity({
        agent: "claude",
        sources: capacitySourcesFromEnv(f.env),
        pending: [],
        waiting: NO_WAITING,
        admissionClass: "spawn",
        now: new Date(),
      }).owners.trees.some((tree) => tree.self);
      assert.equal(census, inOwnerTree, "the fixture means what it says");
      assert.equal(readerInsideOwnerTreeNow(f.env), census, `inOwnerTree=${inOwnerTree}`);
    }
  } finally {
    if (saved === undefined) {
      delete process.env.ACPX_STATE_HOME;
    } else {
      process.env.ACPX_STATE_HOME = saved;
    }
  }
});

// ─── the routed send ──────────────────────────────────────────────────────────────────────────

test("routed prompt: delivering now → `[sent] delivery <id> → <seat>`; the CLI-minted id is the wire id; no owner started, no CLI ledger line", async () => {
  const { f, id, stub } = await routedRig();
  try {
    const startsBefore = agentStarts(f);
    const leasesBefore = leaseFiles(f);
    const opsBefore = operations(f).length; // the target's own creation spawn
    const run = await runCli(
      [...baseArgs(f), "prompt", "--session-id", id, "--no-wait", "do the work"],
      agentEnv(f),
      f.root,
    );
    assert.equal(run.code, 0, run.stderr);
    assert.equal(stub.requests.length, 1);
    const [request] = stub.requests;
    assert.equal(request.method, "POST");
    assert.equal(request.url, `/api/sessions/${id}/message`);
    assert.equal(request.headers["x-source-session"], SESSION_URL);
    const body = request.body as Record<string, unknown>;
    assert.equal(body.text, "do the work");
    assert.match(String(body.delivery_id), UUID);
    assert.equal(Object.hasOwn(body, "content"), false, "plain text carries no content blocks");
    assert.equal(Object.hasOwn(body, "task_options"), false, "an option-less prompt carries none");
    const line = run.stdout.trim();
    assert.match(line, new RegExp(`^\\[sent\\] delivery ${String(body.delivery_id)} → \\S+`, "u"));
    assert.doesNotMatch(
      line,
      /\[queued/u,
      "N-A2-15: a delivering prompt prints [sent], never [queued]",
    );
    assert.equal(agentStarts(f), startsBefore, "the CLI started no adapter");
    assert.deepEqual(leaseFiles(f), leasesBefore, "and no owner");
    assert.equal(operations(f).length, opsBefore, "and delivered nothing itself");
    assert.deepEqual(ledgerLines(f), [], "a routed send writes no CLI ledger line");
  } finally {
    await stub.close();
  }
});

test("routed prompt --format json: today's keys plus the route's, `routed: true`, status stays 'queued'", async () => {
  const { f, id, stub } = await routedRig();
  try {
    const run = await runCli(promptArgs(f, id), agentEnv(f), f.root);
    assert.equal(run.code, 0, run.stderr);
    const json = lastJson(run.stdout);
    const sent = stub.requests[0].body as { delivery_id: string };
    assert.equal(json.action, "prompt_queued");
    assert.equal(json.acpxRecordId, id);
    assert.equal(json.requestId, sent.delivery_id);
    assert.equal(json.delivery_id, sent.delivery_id);
    assert.equal(json.routed, true);
    assert.equal(json.status, "queued");
    assert.equal(Object.hasOwn(json, "held"), false);
  } finally {
    await stub.close();
  }
});

test("routed prompt by SEAT uses the seat route (late binding kept); by session the session route", async () => {
  const { f, id, stub } = await routedRig();
  try {
    const seat = String(readRecord(f, id).seat_id);
    const bySeat = await runCli(
      [...baseArgs(f), "prompt", "--seat", seat, "--no-wait", "hello"],
      agentEnv(f),
      f.root,
    );
    assert.equal(bySeat.code, 0, bySeat.stderr);
    assert.equal(stub.requests[0].url, `/api/seats/${seat}/message`);
    const bySession = await runCli(promptArgs(f, id), agentEnv(f), f.root);
    assert.equal(bySession.code, 0, bySession.stderr);
    assert.equal(stub.requests[1].url, `/api/sessions/${id}/message`);
  } finally {
    await stub.close();
  }
});

test("routed prompt: task_options carry what THIS command line asked (--model, --timeout, --max-turns, --prompt-retries) and nothing it did not", async () => {
  const { f, id, stub } = await routedRig();
  try {
    const modelRun = await runCli(
      [
        "--agent",
        f.agent,
        "--cwd",
        path.join(f.root, "work"),
        "--approve-all",
        "--model",
        "haiku",
        "prompt",
        "--session-id",
        id,
        "--no-wait",
        "hello",
      ],
      agentEnv(f),
      f.root,
    );
    assert.equal(modelRun.code, 0, modelRun.stderr);
    const first = (stub.requests[0].body as { task_options?: Record<string, unknown> })
      .task_options;
    assert.deepEqual(first, { sessionOptions: { model: "haiku", modelSource: "explicit" } });
    // `--deny-all` is accepted but inert on this fleet (every agent runs with full permissions): it
    // resolves to approve-all, which rides no member. Real per-task options do.
    const optionsRun = await runCli(
      [
        "--agent",
        f.agent,
        "--cwd",
        path.join(f.root, "work"),
        "--deny-all",
        "--timeout",
        "30",
        "--max-turns",
        "3",
        "--prompt-retries",
        "2",
        "prompt",
        "--session-id",
        id,
        "--no-wait",
        "hello",
      ],
      agentEnv(f),
      f.root,
    );
    assert.equal(optionsRun.code, 0, optionsRun.stderr);
    const second = (stub.requests[1].body as { task_options?: Record<string, unknown> })
      .task_options;
    assert.deepEqual(second, {
      timeoutMs: 30_000,
      promptRetries: 2,
      sessionOptions: { maxTurns: 3 },
    });
  } finally {
    await stub.close();
  }
});

test("routed prompt: a command line whose only session option is one the queue protocol does not carry (--output-style) sends NO task_options — never an empty sessionOptions", async () => {
  const { f, id, stub } = await routedRig();
  try {
    const run = await runCli(
      [
        ...baseArgs(f),
        "--output-style",
        "concise",
        "prompt",
        "--session-id",
        id,
        "--no-wait",
        "hi",
      ],
      agentEnv(f),
      f.root,
    );
    assert.equal(run.code, 0, run.stderr);
    assert.equal(stub.requests.length, 1);
    const body = stub.requests[0].body as { task_options?: unknown };
    assert.equal(
      body.task_options,
      undefined,
      `unexpected task_options ${JSON.stringify(body.task_options)}`,
    );
  } finally {
    await stub.close();
  }
});

test("routed prompt with image blocks carries `content` (the full ACP blocks) and the text as its preview", async () => {
  const { f, id, stub } = await routedRig();
  try {
    const file = path.join(f.root, "blocks.json");
    fs.writeFileSync(
      file,
      JSON.stringify([
        { type: "text", text: "look at this" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ]),
    );
    const run = await runCli(
      [...baseArgs(f), "prompt", "--session-id", id, "--no-wait", "-f", file],
      agentEnv(f),
      f.root,
    );
    assert.equal(run.code, 0, run.stderr);
    const body = stub.requests[0].body as { text: string; content?: Array<{ type: string }> };
    assert.equal(body.text, "look at this");
    assert.deepEqual(
      body.content?.map((block) => block.type),
      ["text", "image"],
    );
  } finally {
    await stub.close();
  }
});

test("N-A2-15 · UX §11 / CONTRACTS §5.5: a held answer prints `(next in line)` at 0 ahead — never `(0 ahead)` — `(3 ahead)` otherwise, with atrium's sentence on stderr", async () => {
  for (const [ahead, place] of [
    [0, "(next in line)"],
    [3, "(3 ahead)"],
  ] as const) {
    const sentence = `Queued for room (delivery X): recipient has no running agent and the box has no room ${place}.`;
    const { f, id, stub } = await routedRig((request) =>
      answerFor(request, {
        held: { since: "2026-11-09T12:00:00.000Z", reason: "no_capacity", ahead },
        message: sentence,
      }),
    );
    try {
      const run = await runCli(
        [...baseArgs(f), "prompt", "--session-id", id, "--no-wait", "hello"],
        agentEnv(f),
        f.root,
      );
      assert.equal(run.code, 0, run.stderr);
      const delivery = (stub.requests[0].body as { delivery_id: string }).delivery_id;
      assert.match(
        run.stdout.trim(),
        new RegExp(
          `^\\[queued for room\\] delivery ${delivery} \\(${place.slice(1, -1)}\\) → \\S+$`,
          "u",
        ),
      );
      assert.doesNotMatch(run.stdout, /\(0 ahead\)/u);
      assert.ok(run.stderr.includes(sentence), "atrium's sentence, verbatim, on stderr");
      const json = await runCli(promptArgs(f, id), agentEnv(f), f.root);
      const parsed = lastJson(json.stdout);
      assert.deepEqual((parsed.held as { ahead: number }).ahead, ahead);
      assert.equal(parsed.status, "queued", "status stays queued; `held` marks the hold");
    } finally {
      await stub.close();
    }
  }
  assert.equal(formatAhead(0), "next in line");
  assert.equal(formatAhead(1), "1 ahead");
});

test("N-A2-4 · G8: a routed send the route refuses persists NO owner options and leaves the record unchanged — twin: a 2xx persists them", async () => {
  // The target was created with the default permission mode; an EXPLICIT `--approve-all` on the prompt
  // is what `sendSession` would persist into owner_options — only after the route said yes.
  const refusals: Array<[string, StubReply]> = [
    ["closed", { status: 409, body: { code: "SESSION_CLOSED", error: "session is closed" } }],
    ["archived", { status: 409, body: { error: "session is archived" } }],
    ["template", { status: 409, body: { error: "session is a template" } }],
  ];
  for (const [label, refusal] of refusals) {
    const { f, id, stub } = await routedRig(() => refusal);
    try {
      const planted = readRecord(f, id);
      const plantedAcpx = { ...(planted.acpx as Record<string, unknown>) };
      delete plantedAcpx.owner_options; // so that a (wrong) persist would be visible as a write
      fs.writeFileSync(recordPath(f, id), JSON.stringify({ ...planted, acpx: plantedAcpx }));
      const before = sha256(recordPath(f, id));
      const opsBefore = operations(f).length;
      const run = await runCli(
        [...baseArgs(f), "prompt", "--session-id", id, "--no-wait", "hello"],
        agentEnv(f),
        f.root,
      );
      assert.equal(run.code, 1, `${label}: ${run.stderr}`);
      assert.equal(stub.requests.length, 1, label);
      assert.equal(sha256(recordPath(f, id)), before, `${label}: the record is unchanged`);
      assert.equal(operations(f).length, opsBefore, `${label}: nothing was delivered`);
      if (label === "closed") {
        assert.match(run.stderr, /closed/u);
      }
    } finally {
      await stub.close();
    }
  }
  // The twin: the same call, the route says yes — and only THEN are the owner options written.
  const { f, id, stub } = await routedRig();
  try {
    const record = readRecord(f, id);
    const acpx = { ...(record.acpx as Record<string, unknown>) };
    delete acpx.owner_options; // as a record whose owner options were never established
    fs.writeFileSync(recordPath(f, id), JSON.stringify({ ...record, acpx }));
    const run = await runCli(
      [...baseArgs(f), "prompt", "--session-id", id, "--no-wait", "hello"],
      agentEnv(f),
      f.root,
    );
    assert.equal(run.code, 0, run.stderr);
    const after = (readRecord(f, id).acpx as { owner_options?: { permission_mode?: string } })
      .owner_options;
    assert.equal(after?.permission_mode, "approve-all", "persisted after the 2xx");
  } finally {
    await stub.close();
  }
});

test("routed prompt to a target already closed in the local store: SESSION_CLOSED, exit 1, no request, record unchanged (today's direct-path answer)", async () => {
  const { f, id, stub } = await routedRig();
  try {
    const closed = await runCli(
      [...baseArgs(f), "sessions", "close", "--session-id", id],
      f.env,
      f.root,
    );
    assert.equal(closed.code, 0, closed.stderr);
    const before = sha256(recordPath(f, id));
    const run = await runCli(promptArgs(f, id), agentEnv(f), f.root);
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stdout + run.stderr, /SESSION_CLOSED|is closed/u);
    assert.equal(stub.requests.length, 0);
    assert.equal(sha256(recordPath(f, id)), before);
  } finally {
    await stub.close();
  }
});

// ─── N-A2-2 · loop safety ─────────────────────────────────────────────────────────────────────

test("N-A2-2 · G8 loop safety: a prompt run with atrium's real child env (withoutCallerIdentity) inside an owner tree NEVER routes — the stub atrium fails the test on any request", async () => {
  // Any request is a failure of the guarantee: the stub records it (asserted below) and answers 500.
  const { f, id, stub } = await routedRig(() => ({
    status: 500,
    body: { error: "LOOP: a prompt reached atrium's message route from atrium's own child env" },
  }));
  try {
    const identity = agentEnv(f, {
      ACPX_SEAT_URL: "https://atrium.example.test/?seat=5ea7c0de-0000-4000-8000-000000000001",
      ACPX_PARENT_SESSION_URL:
        "https://atrium.example.test/?session=5e55c0de-0000-4000-8000-0000000000bb",
      ACPX_PARENT_SEAT_URL:
        "https://atrium.example.test/?seat=5ea7c0de-0000-4000-8000-000000000002",
    });
    const child = withoutCallerIdentity(identity);
    for (const name of [
      "ACPX_SESSION_URL",
      "ACPX_SEAT_URL",
      "ACPX_SESSION_RECORD_ID",
      "ACPX_PARENT_SESSION_URL",
    ]) {
      assert.equal(child[name], undefined, `${name} stripped`);
    }
    const run = await runCli(
      [...baseArgs(f), "prompt", "--session-id", id, "--no-wait", "atrium delivers this"],
      child,
      f.root,
    );
    assert.equal(run.code, 0, run.stderr);
    assert.equal(stub.requests.length, 0, "the stub atrium saw NO request");
    await waitForMethod(f, "session/prompt"); // it took the direct path and ran the turn

    // The second fence: `--message-id` keeps an identity-carrying caller direct as well.
    const fenced = await runCli(
      [
        ...baseArgs(f),
        "prompt",
        "--session-id",
        id,
        "--no-wait",
        "--message-id",
        "7f0c1111-0000-4000-8000-000000000001",
        "second fence",
      ],
      identity,
      f.root,
    );
    assert.equal(fenced.code, 0, fenced.stderr);
    assert.equal(stub.requests.length, 0, "--message-id is a second fence");

    // The control: the same prompt WITH the identity routes (one request).
    await runCli(promptArgs(f, id, "routed control"), identity, f.root); // (the stub answers 500)
    assert.equal(stub.requests.length, 1, "the identity-carrying caller routes");
  } finally {
    await stub.close();
  }
});

test("a caller OUTSIDE any owner tree stays direct (a person's shell with a leaked identity variable)", async () => {
  const { f, id, stub } = await routedRig(undefined, { inOwnerTree: false });
  try {
    const run = await runCli(promptArgs(f, id), agentEnv(f), f.root);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(stub.requests.length, 0);
  } finally {
    await stub.close();
  }
});

// ─── fallbacks: N-A2-13, N-A2-3, the one wake refusal ─────────────────────────────────────────

test("N-A2-13 · §7.2: connect refused and an unresolvable origin fall back at once to the direct path (`routed:false`, the stderr line); a delivery follows", async () => {
  for (const [label, makeUrl] of [
    ["connect refused", async () => await refusedUrl()],
    ["unresolvable origin", async () => "http://acpx-umq-no-such-host.invalid:3456"],
  ] as const) {
    const f = makeBox({ requestMib: 4000 });
    const id = await makeTarget(f);
    writeAtriumJson(f, { internalUrl: await makeUrl() });
    const run = await runCli(promptArgs(f, id), agentEnv(f), f.root);
    assert.equal(run.code, 0, `${label}: ${run.stderr}`);
    assert.ok(run.ms < 60_000, `${label}: a connect failure fails fast (${run.ms} ms)`);
    const json = lastJson(run.stdout);
    assert.equal(json.routed, false, label);
    assert.equal(json.action, "prompt_queued");
    await waitForMethod(f, "session/prompt"); // ${label}: delivered directly
    const text = await runCli(
      [...baseArgs(f), "prompt", "--session-id", id, "--no-wait", "again"],
      agentEnv(f),
      f.root,
    );
    assert.match(
      text.stderr,
      /acpx: atrium's message queue did not answer; delivered directly \(delivery [0-9a-f-]{36}\)/u,
      label,
    );
    assert.equal(
      ledgerLines(f).length > 0,
      true,
      `${label}: the direct fallback keeps its ledger line`,
    );
  }
});

test("N-A2-13/M-A-6 · connect refused on a FULL box: the direct path's wake gate refuses (75) and the LAST line is the one sentence a sender can still see", async () => {
  const f = makeBox({ requestMib: 4000 });
  const id = await makeTarget(f);
  fs.writeFileSync(path.join(f.root, "podinfo", "memory_request"), String(2048 * 1024 * 1024));
  writeAtriumJson(f, { internalUrl: await refusedUrl() });
  const startsBefore = agentStarts(f);
  const run = await runCli(
    [...baseArgs(f), "prompt", "--session-id", id, "--no-wait", "hello"],
    agentEnv(f),
    f.root,
  );
  assert.equal(run.code, 75, run.stderr);
  const lines = run.stderr.trim().split("\n");
  const token = lines.findIndex((line) => line.startsWith("acpx: REFUSED "));
  assert.ok(token >= 0, run.stderr);
  assert.match(lines[token + 1] ?? "", /^acpx: no memory to wake /u, "the figures line");
  assert.match(
    lines.at(-1) ?? "",
    /^acpx: no room to wake .+, and atrium's message queue did not answer, so nothing was queued; it must be sent again once atrium answers \('acpx capacity' shows the box\)\.$/u,
  );
  assert.equal(lines.length, token + 3, "token line, figures, the sentence — nothing else");
  assert.equal(agentStarts(f), startsBefore, "nothing started");
});

test("N-A2-13 · connected-but-silent: the CLI waits for the answer, reads the status route by the id it minted, and — not found — delivers directly with --message-id", async () => {
  const { f, id, stub } = await routedRig((request) =>
    request.method === "POST"
      ? { status: 200, never: true }
      : { status: 404, body: { error: "unknown delivery" } },
  );
  try {
    const run = await runCli(
      promptArgs(f, id),
      { ...agentEnv(f), ACPX_ROUTED_PROMPT_ANSWER_TIMEOUT_MS: "1500" },
      f.root,
    );
    assert.equal(run.code, 0, run.stderr);
    assert.ok(run.ms >= 1_400, `it waited for the answer window (${run.ms} ms)`);
    assert.deepEqual(
      stub.requests.map((request) => request.method),
      ["POST", "GET"],
    );
    const delivery = (stub.requests[0].body as { delivery_id: string }).delivery_id;
    assert.equal(stub.requests[1].url, `/api/sessions/${id}/delivery/${delivery}`);
    assert.equal(lastJson(run.stdout).routed, false);
    await waitForMethod(f, "session/prompt");
  } finally {
    await stub.close();
  }
});

test("connected-but-silent, then the status route FINDS the item: the CLI reports atrium's answer and delivers nothing itself", async () => {
  const { f, id, stub } = await routedRig((request) =>
    request.method === "POST"
      ? { status: 200, never: true }
      : {
          status: 200,
          body: {
            delivery_id: request.url.split("/").at(-1),
            to: "recipient",
            held: {
              since: "2026-11-09T12:00:00.000Z",
              reason: "no_capacity",
              position: 1,
              message: "Queued for room (delivery X): next in line.",
            },
          },
        },
  );
  try {
    const opsBefore = operations(f).length;
    const run = await runCli(
      promptArgs(f, id),
      { ...agentEnv(f), ACPX_ROUTED_PROMPT_ANSWER_TIMEOUT_MS: "1200" },
      f.root,
    );
    assert.equal(run.code, 0, run.stderr);
    const json = lastJson(run.stdout);
    assert.equal(json.routed, true);
    assert.equal((json.held as { ahead: number }).ahead, 0, "position 1 = next in line");
    assert.equal(operations(f).length, opsBefore, "nothing delivered directly");
  } finally {
    await stub.close();
  }
});

test("N-A2-3 · G8 no double delivery: atrium appends AFTER the CLI's timeout + direct fallback — the owner deduplicates by the shared id: ONE turn", async () => {
  const { f, id, stub } = await routedRig((request) =>
    request.method === "POST"
      ? { status: 200, never: true }
      : { status: 404, body: { error: "unknown delivery" } },
  );
  try {
    const run = await runCli(
      promptArgs(f, id, "once only"),
      { ...agentEnv(f), ACPX_ROUTED_PROMPT_ANSWER_TIMEOUT_MS: "1200" },
      f.root,
    );
    assert.equal(run.code, 0, run.stderr);
    const delivery = (stub.requests[0].body as { delivery_id: string }).delivery_id;
    await waitForMethod(f, "session/prompt");
    const turnsAfterFallback = methods(f).filter((method) => method === "session/prompt").length;
    assert.equal(turnsAfterFallback, 1, "the direct fallback ran ONE turn");

    // Atrium's late append: the same message, the same id, delivered by atrium's own spawn
    // (no agent identity, `--message-id <id>`).
    const late = await runCli(
      [
        ...baseArgs(f),
        "prompt",
        "--session-id",
        id,
        "--no-wait",
        "--message-id",
        delivery,
        "once only",
      ],
      f.env,
      f.root,
    );
    assert.equal(late.code, 0, late.stderr);
    // Let any (wrongly) accepted second copy run its turn before counting.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(
      methods(f).filter((method) => method === "session/prompt").length,
      turnsAfterFallback,
      "the second copy did not start a second turn",
    );
  } finally {
    await stub.close();
  }
});

// ─── wait mode ────────────────────────────────────────────────────────────────────────────────

test("wait mode (no --no-wait): a recipient with no running agent is ROUTED and not waited for — says so, exit 0; a LIVE recipient takes the direct path", async () => {
  const { f, id, stub } = await routedRig();
  try {
    const routed = await runCli(
      [...baseArgs(f), "prompt", "--session-id", id, "hello"],
      agentEnv(f),
      f.root,
    );
    assert.equal(routed.code, 0, routed.stderr);
    assert.equal(stub.requests.length, 1);
    assert.match(routed.stdout, /^\[sent\] delivery /u);
    assert.match(routed.stderr, /was not waited for/u);

    // Make the recipient live: a person's prompt starts its owner and keeps it warm.
    const warm = await runCli(
      [...baseArgs(f), "--ttl", "120", "prompt", "--session-id", id, "wake up"],
      f.env,
      f.root,
    );
    assert.equal(warm.code, 0, warm.stderr);
    const direct = await runCli(
      [...baseArgs(f), "prompt", "--session-id", id, "to a live recipient"],
      agentEnv(f),
      f.root,
    );
    assert.equal(direct.code, 0, direct.stderr);
    assert.equal(stub.requests.length, 1, "a live recipient is not routed");
    assert.match(direct.stdout, /unrecognized prompt: to a live recipient/u, "the reply streamed");
  } finally {
    await stub.close();
  }
});

test("a caller with NO agent identity stays direct, and so does a prompt to atrium.json-less state (older atrium)", async () => {
  const { f, id, stub } = await routedRig();
  try {
    const person = await runCli(promptArgs(f, id), f.env, f.root);
    assert.equal(person.code, 0, person.stderr);
    assert.equal(stub.requests.length, 0, "no identity ⇒ never routed");
    fs.rmSync(path.join(f.root, ".acpx", "atrium.json"));
    const older = await runCli(promptArgs(f, id), agentEnv(f), f.root);
    assert.equal(older.code, 0, older.stderr);
    assert.equal(stub.requests.length, 0, "no atrium.json ⇒ today's direct path");
    assert.equal(
      Object.hasOwn(lastJson(older.stdout), "routed"),
      false,
      "no routed key on the plain direct path",
    );
  } finally {
    await stub.close();
  }
});
