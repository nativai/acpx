import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyPersonMessagesAnswer,
  closeWouldCloseRows,
  decideOnOpenPersonRequests,
  openRequestsMessage,
  readOpenPersonRequests,
} from "../src/cli/session/open-person-requests-guard.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// Brick 2587d30e (ACPX-G, addressing v3 §8.3 / K18 P6) — `sessions close` refuses a session with
// an open request to a person unless `--force`. TEST-PLAN §5 ACPXG-1..3, each with its committed
// negative. The mechanism (O-11) is a READ of atrium's `GET /api/sessions/<id>/person-messages`;
// the CLI rows below drive the REAL compiled CLI against a stub atrium that answers the real
// route's shapes (A2's `server/person-message-routes.ts`) and the real 404 JSON of a build
// without the route (TEST-PLAN amendment v1.2 / L0-6).

const CLI_PATH = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent.js", import.meta.url));
const MOCK_AGENT_COMMAND = `node ${JSON.stringify(MOCK_AGENT_PATH)}`;

const ID = "11111111-2222-4333-8444-555555555555";
const PERSON = { id: "p-1", name: "Daniel Laatz", handle: "laatz" };
const OTHER = { id: "p-2", name: "Ada Voss" };
const NOT_FOUND = { status: 404, body: JSON.stringify({ error: "Not found" }) };
const UNKNOWN_SESSION = { status: 404, body: JSON.stringify({ error: "unknown-session" }) };

function row(state: string, to: { id: string; name: string; handle?: string } = PERSON) {
  return {
    message_id: `msgsent-${state}`,
    holder_session: ID,
    to,
    state,
    created_at: "2026-11-01T12:00:00.000Z",
    closed_at: state === "open" ? null : "2026-11-01T12:05:00.000Z",
  };
}

function answer(rows: unknown[]): { status: number; body: string } {
  return { status: 200, body: JSON.stringify({ seat: ID, rows }) };
}

test("R1 A1 · only open questions block: explicit, legacy, and mixed rows", () => {
  for (const needs_answer of [false, 0]) {
    const read = classifyPersonMessagesAnswer(200, answer([{ ...row("open"), needs_answer }]).body);
    assert.deepEqual(read, { kind: "answered", open: [] });
    assert.equal(decideOnOpenPersonRequests(ID, read).proceed, true);
  }
  for (const question of [
    row("open"),
    { ...row("open"), needs_answer: true },
    { ...row("open"), needs_answer: 1 },
  ]) {
    const read = classifyPersonMessagesAnswer(
      200,
      answer([
        { ...row("open", OTHER), needs_answer: false },
        question,
        { ...row("done", OTHER), needs_answer: true },
      ]).body,
    );
    assert.ok(read.kind === "answered");
    assert.deepEqual(
      read.open.map((r) => r.to),
      [PERSON],
    );
    assert.equal(decideOnOpenPersonRequests(ID, read).proceed, false);
  }
});

// ─── The read: what each answer of the route means ───────────────────────────

test("ACPXG-1 · an open row is read as an open request; a closed row of every other state is not (positive control for the refusal)", () => {
  const read = classifyPersonMessagesAnswer(
    200,
    JSON.stringify({
      seat: ID,
      rows: [
        row("open"),
        row("replied"),
        row("done"),
        row("resolved"),
        row("session-closed", OTHER),
      ],
    }),
  );
  assert.equal(read.kind, "answered");
  assert.ok(read.kind === "answered");
  assert.deepEqual(
    read.open.map((request) => request.to.name),
    ["Daniel Laatz"],
  );
  assert.equal(read.open[0]?.messageId, "msgsent-open");
});

test("ACPXG-3 · NEGATIVE — route-absent is NEVER read as `0 open`: the build's own 404 JSON, a 404 without JSON and a 200 non-JSON are `route-absent`, not `answered`", () => {
  for (const [status, text] of [
    [404, JSON.stringify({ error: "Not found" })],
    [404, "<html>Cannot GET</html>"],
    [404, ""],
    [200, "<!doctype html><html></html>"],
  ] as const) {
    assert.deepEqual(
      classifyPersonMessagesAnswer(status, text),
      { kind: "route-absent" },
      `${status} ${text}`,
    );
  }
  // The positive control of the pair: a LIVE route that does not know the session IS an answer.
  assert.deepEqual(
    classifyPersonMessagesAnswer(404, JSON.stringify({ error: "unknown-session" })),
    {
      kind: "answered",
      open: [],
    },
  );
  // And a live route with no rows is `answered`, the one shape that means "0 open".
  assert.deepEqual(classifyPersonMessagesAnswer(200, JSON.stringify({ seat: ID, rows: [] })), {
    kind: "answered",
    open: [],
  });
});

test("ACPXG-3 · NEGATIVE — a body that is not the rows shape never reads as `0 open`: it is `unreachable` (unknown), whatever the row", () => {
  const unknown = [
    [500, JSON.stringify({ error: "internal" })],
    [401, ""],
    [403, JSON.stringify({ error: "forbidden" })],
    [200, JSON.stringify({ seat: ID })],
    [200, JSON.stringify({ seat: ID, rows: "open" })],
    [200, JSON.stringify([row("open")])],
    [200, JSON.stringify({ rows: [{ ...row("open"), to: "Daniel" }] })],
    [200, JSON.stringify({ rows: [{ ...row("open"), state: 1 }] })],
    [200, JSON.stringify({ rows: [row("replied"), null] })],
  ] as const;
  for (const [status, text] of unknown) {
    const read = classifyPersonMessagesAnswer(status, text);
    assert.equal(read.kind, "unreachable", `${status} ${text}`);
  }
});

test("ACPXG-3 · an unreachable atrium (refused, a rejected fetch, a timeout) reads `unreachable` — never `answered`", async () => {
  const refused = await readOpenPersonRequests("http://127.0.0.1:1", ID);
  assert.equal(refused.kind, "unreachable");
  const rejected = await readOpenPersonRequests("http://atrium.test", ID, () =>
    Promise.reject(new Error("boom")),
  );
  assert.deepEqual(rejected, { kind: "unreachable", reason: "boom" });
});

// ─── The decision: what the close does with each answer ──────────────────────

test("ACPXG-1 · open requests refuse with the exact wording, the names de-duplicated; no open request lets the close through", () => {
  const read = classifyPersonMessagesAnswer(
    200,
    answer([row("open"), row("open", OTHER), row("open")]).body,
  );
  const decision = decideOnOpenPersonRequests(ID, read);
  assert.equal(decision.proceed, false);
  assert.ok(!decision.proceed);
  assert.equal(
    decision.message,
    `${ID} has open requests to Daniel Laatz, Ada Voss; resolve them or add --force`,
  );
  assert.equal(decision.message, openRequestsMessage(ID, decision.open));
  assert.deepEqual(decideOnOpenPersonRequests(ID, { kind: "answered", open: [] }), {
    proceed: true,
  });
});

test("ACPXG-3 · the route-absent decision proceeds, says so only under --verbose, and differs from `0 open` (which says nothing)", () => {
  const absent = decideOnOpenPersonRequests(ID, { kind: "route-absent" });
  assert.ok(absent.proceed && absent.note?.verboseOnly === true, JSON.stringify(absent));
  assert.match(absent.note.text, /no person-messages route/);
  assert.equal(decideOnOpenPersonRequests(ID, { kind: "answered", open: [] }).proceed, true);
  assert.equal(
    (decideOnOpenPersonRequests(ID, { kind: "answered", open: [] }) as { note?: unknown }).note,
    undefined,
  );
});

test("ACPXG-3 · the unreachable decision proceeds and says so, under --verbose only", () => {
  const decision = decideOnOpenPersonRequests(ID, { kind: "unreachable", reason: "boom" });
  assert.ok(decision.proceed && decision.note?.verboseOnly === true, JSON.stringify(decision));
  assert.match(decision.note.text, /could not check .* for open requests to people \(boom\)/);
});

// ─── Who is asked: only a close that would close the rows ────────────────────

function seatRecord(patch: Partial<SessionRecord>): SessionRecord {
  return {
    ...makeSessionRecord({
      acpxRecordId: ID,
      acpSessionId: "acp-1",
      agentCommand: "agent",
      cwd: "/tmp",
    }),
    ...patch,
  };
}

test("ACPXG-2 · a seat's ACTIVE holder and a seat-less session are asked", () => {
  assert.equal(closeWouldCloseRows(seatRecord({})), true);
  assert.equal(closeWouldCloseRows(seatRecord({ seatId: "seat-1", holderActive: true })), true);
});

test("ACPXG-2 · NEGATIVE — a retired predecessor, a prepared successor and an already-closed session are NOT asked: a hand-over keeps the rows open", () => {
  // `sessions activate` retires the predecessor WITHOUT closing it and prints "close it yourself".
  assert.equal(closeWouldCloseRows(seatRecord({ seatId: "seat-1", holderActive: false })), false);
  // `sessions new --seat` prepares a successor: it carries the seat and no active flag.
  assert.equal(closeWouldCloseRows(seatRecord({ seatId: "seat-1" })), false);
  assert.equal(closeWouldCloseRows(seatRecord({ closed: true })), false);
});

// ─── The real CLI against a stub atrium ──────────────────────────────────────

type Reply = { status: number; body: string };
type Stub = { origin: string; requests: string[]; reply: (r: Reply) => void; close: () => void };

async function startStubAtrium(initial: Reply): Promise<Stub> {
  let current = initial;
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(current.status, { "content-type": "application/json" });
    res.end(current.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    reply: (r) => {
      current = r;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

type CliResult = { code: number | null; stdout: string; stderr: string };

/** An agent's shell, as acpx sets it on every agent it runs (the byway guard's detection set). */
const AGENT_ENV: NodeJS.ProcessEnv = {
  ACPX_SESSION_URL: "https://ui.example.test/?session=aaaaaaaa-1111-4222-8333-444455556666",
  ACPX_SEAT_URL: "https://ui.example.test/?seat=bbbbbbbb-1111-4222-8333-444455556666",
};

function runCli(
  args: string[],
  homeDir: string,
  atrium: string,
  callerEnv: NodeJS.ProcessEnv,
): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      ACPX_UI_BASE_URL: atrium,
      ACPX_SESSION_PRIMER_COMMAND: "/nonexistent/acpx-test-primer.sh",
    };
    delete env.ACPX_STATE_HOME;
    delete env.ACPX_UI_INTERNAL_URL;
    for (const key of [
      "ACPX_SESSION_URL",
      "ACPX_SESSION_RECORD_ID",
      "ACPX_SEAT_URL",
      "ACPX_SESSION_NAME",
    ]) {
      delete env[key];
    }
    Object.assign(env, callerEnv);
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

type Rig = {
  stub: Stub;
  /** An AGENT's invocation — the caller the guard is for. */
  cli: (args: string[], atrium?: string, env?: NodeJS.ProcessEnv) => Promise<CliResult>;
  /** A person's: no identity variable (atrium's UI close delegation, a human at a terminal). */
  person: (args: string[]) => Promise<CliResult>;
  create: (name: string | undefined, extra?: string[]) => Promise<string>;
  onDisk: (id: string) => Promise<Record<string, unknown>>;
};

async function withRig(initial: Reply, run: (rig: Rig) => Promise<void>): Promise<void> {
  const stub = await startStubAtrium(initial);
  try {
    await withTempHome("acpx-close-open-requests-", async (homeDir) => {
      const cwd = path.join(homeDir, "workspace");
      await fs.mkdir(cwd, { recursive: true });
      const base = ["--cwd", cwd, "--agent", MOCK_AGENT_COMMAND, "--approve-all"];
      const cli = (
        args: string[],
        atrium: string = stub.origin,
        env: NodeJS.ProcessEnv = AGENT_ENV,
      ) => runCli([...base, ...args], homeDir, atrium, env);
      const person = (args: string[]) => runCli([...base, ...args], homeDir, stub.origin, {});
      // `--seat` refuses a name: the seat already has its own.
      const create = async (name: string | undefined, extra: string[] = []) => {
        const named = name === undefined ? [] : ["-s", name];
        const made = await person(["--format", "json", "sessions", "new", ...named, ...extra]);
        assert.equal(made.code, 0, made.stderr);
        const line = made.stdout.trim().split("\n").at(-1) ?? "";
        return String((JSON.parse(line) as { acpxRecordId?: unknown }).acpxRecordId);
      };
      const onDisk = async (id: string) =>
        JSON.parse(
          await fs.readFile(path.join(homeDir, ".acpx", "sessions", `${id}.json`), "utf8"),
        ) as Record<string, unknown>;
      await run({ stub, cli, person, create, onDisk });
    });
  } finally {
    stub.close();
  }
}

test("ACPXG-1 · `sessions close` is REFUSED while a request is open — exit 1, the exact wording, the record untouched; after the request is resolved the SAME close succeeds", async () => {
  await withRig(answer([row("open")]), async (rig) => {
    const id = await rig.create("asker");
    const refused = await rig.cli(["sessions", "close", "--session-id", id]);
    assert.equal(refused.code, 1, refused.stderr);
    assert.ok(
      refused.stderr.includes(
        `${id} has open requests to Daniel Laatz; resolve them or add --force`,
      ),
      refused.stderr,
    );
    assert.notEqual((await rig.onDisk(id)).closed, true, "a refused close moved the record");
    assert.ok(
      rig.stub.requests.includes(`GET /api/sessions/${id}/person-messages`),
      JSON.stringify(rig.stub.requests),
    );

    const json = await rig.cli(["--format", "json", "sessions", "close", "--session-id", id]);
    assert.equal(json.code, 1, json.stderr);
    const payload = JSON.parse(json.stdout.trim().split("\n").at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(payload.ok, false);
    assert.equal(payload.code, "OPEN_PERSON_REQUESTS");
    assert.equal(payload.sessionId, id);
    assert.deepEqual(
      (payload.openRequests as { to: { name: string } }[]).map((request) => request.to.name),
      ["Daniel Laatz"],
    );

    // The positive control: the person's answer (or `--resolve`) closed the row; nothing else changed.
    rig.stub.reply(answer([row("resolved")]));
    const closed = await rig.cli(["sessions", "close", "--session-id", id]);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal((await rig.onDisk(id)).closed, true);
  });
});

test("ACPXG-1 · NEGATIVE — the SAME close by a non-agent caller (no identity variable: atrium's UI close delegation, a human's shell) is never refused, asked or warned", async () => {
  await withRig(answer([row("open")]), async (rig) => {
    const id = await rig.create("asker");
    const refused = await rig.cli(["sessions", "close", "--session-id", id]);
    assert.equal(refused.code, 1, "the agent's close was not refused (the control)");
    rig.stub.requests.length = 0;

    // The spawn shape of atrium's UI close (acpx-ui server/closeOwnerDelegation): json, no flags.
    const ui = await rig.person(["--format", "json", "sessions", "close", "--session-id", id]);
    assert.equal(ui.code, 0, ui.stderr);
    assert.equal((await rig.onDisk(id)).closed, true);
    assert.ok(!/open requests|could not check/.test(ui.stderr + ui.stdout), ui.stderr);
    assert.deepEqual(rig.stub.requests, [], "a person's close asked atrium");
  });
});

test("ACPXG-1 · detection breadth — NEGATIVE: ANY ONE identity variable makes an agent (a seat URL alone, a URL that does not parse), blank ones do not", async () => {
  await withRig(answer([row("open")]), async (rig) => {
    const id = await rig.create("asker");
    const { callerIsAgent } = await import("../src/cli/session/byway-close-guard.js");
    assert.equal(callerIsAgent({ ACPX_SEAT_URL: "https://x/?seat=s" }), true);
    assert.equal(callerIsAgent({ ACPX_SESSION_URL: "not a url" }), true);
    assert.equal(callerIsAgent({ ACPX_SESSION_URL: "  " }), false);
    assert.equal(callerIsAgent({}), false);
    assert.equal(rig.stub.requests.length, 0);
    const refused = await rig.cli(["sessions", "close", "--session-id", id]);
    assert.equal(refused.code, 1, refused.stderr);
  });
});

test("ACPXG-1 · an agent closing ITSELF with a request open is refused too (no self-close exemption)", async () => {
  await withRig(answer([row("open")]), async (rig) => {
    const id = await rig.create("self");
    const self = { ACPX_SESSION_URL: `https://ui.example.test/?session=${id}` };
    const refused = await rig.cli(["sessions", "close", "--session-id", id], undefined, self);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /has open requests to Daniel Laatz/);
    assert.notEqual((await rig.onDisk(id)).closed, true);
  });
});

test("ACPXG-2 · `--force` closes with the request still open and never asks atrium", async () => {
  await withRig(answer([row("open")]), async (rig) => {
    const id = await rig.create("asker");
    const closed = await rig.cli(["sessions", "close", "--session-id", id, "--force"]);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal((await rig.onDisk(id)).closed, true);
    assert.deepEqual(rig.stub.requests, [], "--force still read the rows");
  });
});

test("R1 A1 · an agent closes after a plain message without --force", async () => {
  await withRig(answer([{ ...row("open"), needs_answer: false }]), async (rig) => {
    const id = await rig.create("last-status");
    const closed = await rig.cli(["sessions", "close", "--session-id", id]);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal((await rig.onDisk(id)).closed, true);
    assert.ok(rig.stub.requests.includes(`GET /api/sessions/${id}/person-messages`));
  });
});

test("ACPXG-2 · NEGATIVE — a hand-over keeps the rows: closing the RETIRED predecessor is not refused and asks nothing; closing the new ACTIVE holder still is", async () => {
  await withRig(answer([row("open")]), async (rig) => {
    const old = await rig.create("old-holder");
    const seat = String((await rig.onDisk(old)).seat_id);
    const successor = await rig.create(undefined, ["--seat", seat]);
    // The prepared successor is not the holder yet: closing it is not asked either.
    assert.equal(closeWouldCloseRows(await asRecord(rig, successor)), false);
    const activated = await rig.cli(["sessions", "activate", seat, successor, "--no-notify"]);
    assert.equal(activated.code, 0, activated.stderr);
    assert.equal((await rig.onDisk(old)).holder_active, false, "the predecessor is not retired");

    const closedOld = await rig.cli(["sessions", "close", "--session-id", old]);
    assert.equal(closedOld.code, 0, closedOld.stderr);
    assert.equal((await rig.onDisk(old)).closed, true);
    assert.deepEqual(rig.stub.requests, [], "closing the predecessor asked atrium");

    const refused = await rig.cli(["sessions", "close", "--session-id", successor]);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, /has open requests to Daniel Laatz/);
  });
});

async function asRecord(rig: Rig, id: string): Promise<SessionRecord> {
  const raw = await rig.onDisk(id);
  return {
    ...makeSessionRecord({
      acpxRecordId: id,
      acpSessionId: "x",
      agentCommand: "agent",
      cwd: "/tmp",
    }),
    ...(typeof raw.seat_id === "string" ? { seatId: raw.seat_id } : {}),
    ...(raw.holder_active === true ? { holderActive: true } : {}),
    ...(raw.holder_active === false ? { holderActive: false } : {}),
  };
}

test("ACPXG-3 · route-absent through the CLI: the build's own 404 JSON lets the close through — silent by default, named under --verbose (never `0 open`)", async () => {
  await withRig(NOT_FOUND, async (rig) => {
    const quiet = await rig.create("on-old-atrium");
    const closed = await rig.cli(["sessions", "close", "--session-id", quiet]);
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal((await rig.onDisk(quiet)).closed, true);
    assert.ok(!closed.stderr.includes("person-messages"), closed.stderr);

    const loud = await rig.create("on-old-atrium-verbose");
    const verbose = await rig.cli(["--verbose", "sessions", "close", "--session-id", loud]);
    assert.equal(verbose.code, 0, verbose.stderr);
    assert.match(verbose.stderr, /this atrium has no person-messages route/);
  });
});

test("ACPXG-3 · a live route that knows no such session lets the close through silently (the store's own `nothing open`)", async () => {
  await withRig(UNKNOWN_SESSION, async (rig) => {
    const id = await rig.create("unknown-to-atrium");
    const closed = await rig.cli(["sessions", "close", "--session-id", id]);
    assert.equal(closed.code, 0, closed.stderr);
    assert.ok(!/person-messages|could not check/.test(closed.stderr), closed.stderr);
  });
});

test("ACPXG-3 · an unreachable atrium lets the close through — silent by default (agent wrap-ups parse stderr), named under --verbose", async () => {
  await withRig(answer([row("open")]), async (rig) => {
    const id = await rig.create("atrium-down");
    const closed = await rig.cli(
      ["sessions", "close", "--session-id", id],
      "http://127.0.0.1:1", // nothing listens: connection refused
    );
    assert.equal(closed.code, 0, closed.stderr);
    assert.equal((await rig.onDisk(id)).closed, true);
    assert.ok(!closed.stderr.includes("could not check"), closed.stderr);

    const loud = await rig.create("atrium-down-verbose");
    const verbose = await rig.cli(
      ["--verbose", "sessions", "close", "--session-id", loud],
      "http://127.0.0.1:1",
    );
    assert.equal(verbose.code, 0, verbose.stderr);
    assert.match(verbose.stderr, /could not check .* for open requests to people/);
  });
});

test("ACPXG-1 · `--force` is shown in `sessions close --help` and carried by the background-task retry command", async () => {
  await withRig(answer([]), async (rig) => {
    const help = await rig.cli(["sessions", "close", "--help"]);
    assert.match(help.stdout, /--force/);
    const text = help.stdout.replace(/\s+/g, " ");
    assert.match(text, /open questions to people/);
    assert.match(text, /Open questions and messages remain open/);
    assert.match(text, /plain messages do not require --force/);
    assert.doesNotMatch(text, /requests are closed as session-closed/);
  });
  const { closeRetryArgs } = await import("../src/cli/background-task-gate.js");
  assert.deepEqual(closeRetryArgs({ force: true }), ["--force"]);
  assert.deepEqual(closeRetryArgs({}), []);
});
