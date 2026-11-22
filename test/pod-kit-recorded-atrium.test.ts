import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PASS_THROUGH_INHERIT } from "../src/pod/command-classes.js";
import { RECORD_ID_CREATE_PATHS as REAL_RECORD_ID_CREATE_PATHS } from "../src/pod/pass-through-args.js";
import {
  INHERIT_ALLOWED,
  RECORD_ID_CREATE_PATHS,
  startRecordedAtrium,
} from "./pod-kit/recorded-atrium.js";
import type { AtriumScript, RecordedAtrium } from "./pod-kit/recorded-atrium.js";

// Self-test of the X1 recorded atrium (CONTRACTS-r4.md C6): the wire shapes it answers, what it
// records, and that each mode (away, refused, hang, away-then-back) really happens on the wire.

async function withAtrium(script: AtriumScript, run: (atrium: RecordedAtrium) => Promise<void>) {
  const atrium = await startRecordedAtrium(script);
  try {
    await run(atrium);
  } finally {
    await atrium.close();
  }
}

const RECORD = "3f1c1e1a-2b3c-4d5e-8f60-7a8b9c0d1e2f";

function callBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: 1,
    call_id: randomUUID(),
    argv: ["sessions", "new", "--name", "x", "--record-id", RECORD],
    caller: {
      session_url: "https://atrium.invalid/?session=s1",
      seat_url: "https://atrium.invalid/?seat=t1",
      record_id: "r1",
    },
    admission_class: "spawn",
    inherit: { ACPX_SUBSCRIPTION: "sub1" },
    deadline_ms: 30_000,
    ...overrides,
  };
}

async function post(
  atrium: RecordedAtrium,
  path: string,
  body: unknown,
): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(`${atrium.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const readyHint = {
  contract: 1,
  pod: { name: "ag-k", uid: "u-1", node: "n1" },
  placement: "pool",
  releases: { acpx: "r1" },
};

test("POST /api/acpx/call answers {exit, stdout, stderr} and records the request in full", async () => {
  await withAtrium({}, async (atrium) => {
    const body = callBody({ stdin_b64: Buffer.from("a brief\n").toString("base64") });
    const answer = await post(atrium, "/api/acpx/call", body);
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.text), { exit: 0, stdout: "", stderr: "" });
    const [record] = atrium.requests;
    assert.equal(record?.route, "call");
    assert.deepEqual(record?.problems, []);
    assert.equal(record?.callId, body.call_id);
    assert.equal(record?.stdin, "a brief\n");
    assert.deepEqual(record?.body?.argv, ["sessions", "new", "--name", "x", "--record-id", RECORD]);
    assert.equal(record?.mode, "normal");
  });
});

test("departures from C6.2's request shape are recorded by name, never silently accepted", async () => {
  await withAtrium({}, async (atrium) => {
    const huge = Buffer.alloc(8 * 1024 * 1024 + 1, 97).toString("base64");
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["contract 2", { contract: 2 }, "contract"],
      ["no call_id", { call_id: undefined }, "call_id"],
      ["argv with a non-string", { argv: ["a", 1] }, "argv"],
      ["stdin not base64", { stdin_b64: "not base64!" }, "stdin_b64"],
      ["stdin over 8 MiB", { stdin_b64: huge }, "stdin_b64_too_large"],
      [
        "a cwd that IS present (A-9: the pass-through carries none)",
        { cwd: "/workspace" },
        "cwd_present",
      ],
      ["no caller", { caller: undefined }, "caller"],
      [
        "caller without record_id",
        { caller: { session_url: "x", seat_url: "y" } },
        "caller.record_id",
      ],
      ["no admission_class", { admission_class: undefined }, "admission_class"],
      ["deadline over 60 s", { deadline_ms: 60_001 }, "deadline_ms"],
      ["no deadline", { deadline_ms: undefined }, "deadline_ms"],
    ];
    for (const [name, overrides, problem] of cases) {
      await post(atrium, "/api/acpx/call", callBody(overrides));
      const last = atrium.requests.at(-1);
      assert.ok(
        last?.problems.includes(problem),
        `${name}: expected ${problem}, got ${JSON.stringify(last?.problems)}`,
      );
    }
    await post(atrium, "/api/acpx/call", callBody({ stdin_b64: "AAAA", deadline_ms: 60_000 }));
    assert.deepEqual(
      atrium.requests.at(-1)?.problems,
      [],
      "8 MiB and 60 s are the bounds, inclusive",
    );
    await post(atrium, "/api/acpx/call", "{nope");
    assert.deepEqual(atrium.requests.at(-1)?.problems, ["body"]);
  });
});

test("call rules: first matching unspent rule answers; exit codes, class-not-passable and a delivery pass through", async () => {
  await withAtrium(
    {
      calls: [
        {
          argvPrefix: ["sessions", "new"],
          times: 1,
          answer: { exit: 0, stdout: '{"id":"a"}\n', delivery: { state: "queued" } },
        },
        {
          argvPrefix: ["sessions", "new"],
          answer: { exit: 75, stderr: "acpx: REFUSED reason=agent_cap\n" },
        },
        {
          argvPrefix: ["capacity"],
          answer: { status: 400, body: { error: "class-not-passable" } },
        },
      ],
    },
    async (atrium) => {
      const first = JSON.parse((await post(atrium, "/api/acpx/call", callBody())).text);
      assert.deepEqual(first, {
        exit: 0,
        stdout: '{"id":"a"}\n',
        stderr: "",
        delivery: { state: "queued" },
      });
      const second = JSON.parse((await post(atrium, "/api/acpx/call", callBody())).text);
      assert.equal(second.exit, 75);
      assert.match(second.stderr, /REFUSED reason=agent_cap/);
      const refused = await post(atrium, "/api/acpx/call", callBody({ argv: ["capacity", "x"] }));
      assert.equal(refused.status, 400);
      assert.deepEqual(JSON.parse(refused.text), { error: "class-not-passable" });
    },
  );
});

test("at most once: the same call_id returns the first answer; a lost answer is found by the retry", async () => {
  await withAtrium(
    {
      calls: [
        { times: 1, loseAnswer: true, answer: { exit: 0, stdout: "created\n" } },
        { answer: { exit: 1, stdout: "ran twice\n" } },
      ],
    },
    async (atrium) => {
      const body = callBody();
      await assert.rejects(
        post(atrium, "/api/acpx/call", body),
        "the first attempt's connection is cut",
      );
      const retry = JSON.parse((await post(atrium, "/api/acpx/call", body)).text);
      assert.deepEqual(
        retry,
        { exit: 0, stdout: "created\n", stderr: "" },
        "the retry finds the first attempt's result",
      );
      assert.deepEqual(
        atrium.requests.map((entry) => [entry.outcome, entry.replayed]),
        [
          ["lost_answer", false],
          ["replayed", true],
        ],
      );
      const other = JSON.parse((await post(atrium, "/api/acpx/call", callBody())).text);
      assert.equal(other.stdout, "ran twice\n", "a different call_id is a different call");
    },
  );
});

test("message routes record their target and body; default answer is a queued delivery; the answer is scriptable", async () => {
  await withAtrium({}, async (atrium) => {
    const session = await post(atrium, "/api/sessions/sess-1/message", {
      message: "hi",
      from: "x",
    });
    const seat = await post(atrium, "/api/seats/seat-1/message", { message: "yo" });
    for (const answer of [session, seat]) {
      assert.equal(answer.status, 202, "EVERY accepted message answers 202, never 200");
      const parsed = JSON.parse(answer.text) as { delivery_id: string; status: string };
      assert.equal(parsed.status, "queued");
      assert.match(parsed.delivery_id, /^[0-9a-f-]{36}$/);
    }
    assert.deepEqual(
      atrium.requests.map((entry) => [entry.route, entry.target, entry.body?.message]),
      [
        ["session_message", "sess-1", "hi"],
        ["seat_message", "seat-1", "yo"],
      ],
    );
    atrium.setScript({ messages: { default: { status: 409, body: { error: "gone" } } } });
    const scripted = await post(atrium, "/api/sessions/sess-2/message", {});
    assert.equal(scripted.status, 409);
    assert.deepEqual(JSON.parse(scripted.text), { error: "gone" });
  });
});

test("message routes: both answers — 200 queued when accepted, 202 held when queued for room — in the scripted order", async () => {
  await withAtrium(
    {
      messages: {
        answers: ["queued", "held", { held: { reason: "agent_cap", ahead: 2 } }],
        default: "queued",
      },
    },
    async (atrium) => {
      const answers: Array<{ status: number; body: Record<string, unknown> }> = [];
      for (const path of [
        "/api/sessions/a/message",
        "/api/seats/b/message",
        "/api/sessions/c/message",
        "/api/seats/d/message",
      ]) {
        const answer = await post(atrium, path, { message: "m" });
        answers.push({
          status: answer.status,
          body: JSON.parse(answer.text) as Record<string, unknown>,
        });
      }
      assert.deepEqual(
        answers.map((entry) => [entry.status, entry.body.status, "held" in entry.body]),
        [
          [202, "queued", false],
          [202, "queued", true],
          [202, "queued", true],
          [202, "queued", false],
        ],
        "202 always, status STAYS queued; a hold is marked by `held` + `message`, never by a status",
      );
      assert.deepEqual(answers[1]?.body.held, { reason: "pod_starting" });
      assert.deepEqual(answers[2]?.body.held, { reason: "agent_cap", ahead: 2 });
      for (const index of [1, 2]) {
        assert.equal(typeof answers[index]?.body.message, "string");
      }
      assert.equal(answers[0]?.body.message, undefined);
      assert.deepEqual(
        [answers[0]?.body.from, answers[0]?.body.to, answers[0]?.body.to_seat],
        ["anonymous", "a", undefined],
        "a session route: to = the session, no to_seat",
      );
      assert.deepEqual(
        [answers[1]?.body.to, answers[1]?.body.to_seat],
        ["session-of-b", "b"],
        "a seat route: to_seat = the seat",
      );
      for (const entry of answers) {
        assert.match(String(entry.body.delivery_id), /^[0-9a-f-]{36}$/);
      }
      assert.deepEqual(
        atrium.requests.map((entry) => entry.outcome),
        ["answered", "held", "held", "answered"],
      );
    },
  );
});

test("inherit is validated: a name outside the closed list is 400 inherit-not-allowed and NOTHING runs", async () => {
  await withAtrium(
    { calls: [{ times: 1, answer: { exit: 0, stdout: "ran\n" } }, { answer: { exit: 9 } }] },
    async (atrium) => {
      assert.deepEqual([...INHERIT_ALLOWED], ["ACPX_SUBSCRIPTION", "ATRIUM_OS"]);
      const callId = randomUUID();
      const refused = await post(
        atrium,
        "/api/acpx/call",
        callBody({ call_id: callId, inherit: { ACPX_SUBSCRIPTION: "s", PATH: "/evil" } }),
      );
      assert.equal(refused.status, 400);
      assert.deepEqual(JSON.parse(refused.text), { error: "inherit-not-allowed", name: "PATH" });
      assert.equal(atrium.requests[0]?.outcome, "inherit_not_allowed");
      assert.deepEqual(
        atrium.requests[0]?.problems,
        [],
        "a disallowed name is the server's refusal, not a shape problem",
      );
      // nothing ran: the first rule is unspent and the call id was not remembered
      const ok = await post(
        atrium,
        "/api/acpx/call",
        callBody({ call_id: callId, inherit: { ATRIUM_OS: "/os", ACPX_SUBSCRIPTION: "s" } }),
      );
      assert.equal(ok.status, 200);
      assert.equal(
        JSON.parse(ok.text).stdout,
        "ran\n",
        "the first call that ran still got the first rule",
      );
      assert.equal(atrium.requests[1]?.replayed, false);
      const none = await post(atrium, "/api/acpx/call", callBody({ inherit: undefined }));
      assert.equal(none.status, 200, "no inherit at all is fine");
    },
  );
});

test("inherit: not an object is 400 bad-inherit; a non-string value is 400 inherit-not-string naming it — nothing runs", async () => {
  await withAtrium({ calls: [{ answer: { exit: 0, stdout: "ran\n" } }] }, async (atrium) => {
    const a = await post(atrium, "/api/acpx/call", callBody({ inherit: ["ACPX_SUBSCRIPTION"] }));
    assert.deepEqual([a.status, JSON.parse(a.text)], [400, { error: "bad-inherit" }]);
    const b = await post(atrium, "/api/acpx/call", callBody({ inherit: { ACPX_SUBSCRIPTION: 7 } }));
    assert.deepEqual(
      [b.status, JSON.parse(b.text)],
      [400, { error: "inherit-not-string", name: "ACPX_SUBSCRIPTION" }],
    );
    const c = await post(atrium, "/api/acpx/call", callBody({ inherit: { PATH: 7 } }));
    assert.equal(
      JSON.parse(c.text).error,
      "inherit-not-string",
      "the shape is checked before the name",
    );
    assert.deepEqual(
      atrium.requests.map((entry) => entry.outcome),
      ["bad_inherit", "inherit_not_string", "inherit_not_string"],
    );
    assert.equal(
      atrium.requestsFor("call").every((entry) => entry.stdin === null),
      true,
    );
    const ok = JSON.parse((await post(atrium, "/api/acpx/call", callBody())).text);
    assert.equal(ok.stdout, "ran\n", "no call was consumed by the refusals");
  });
});

test("INHERIT_ALLOWED and RECORD_ID_CREATE_PATHS equal acpx's own exports (the kit's copies cannot drift)", () => {
  assert.deepEqual([...INHERIT_ALLOWED], [...PASS_THROUGH_INHERIT]);
  assert.deepEqual([...RECORD_ID_CREATE_PATHS], [...REAL_RECORD_ID_CREATE_PATHS]);
});

test("A-27: a create's --created-by-call must be call_id (400 call-id-mismatch); --record-id must be one uuid; one first message", async () => {
  await withAtrium({ calls: [{ answer: { exit: 0, stdout: "ran\n" } }] }, async (atrium) => {
    const callId = randomUUID();
    const create = (extra: string[], id = callId) =>
      callBody({ call_id: id, argv: ["sessions", "new", ...extra] });
    const refusal = async (body: Record<string, unknown>) => {
      const answer = await post(atrium, "/api/acpx/call", body);
      return [answer.status, JSON.parse(answer.text)] as const;
    };
    assert.deepEqual(
      await refusal(create(["--record-id", RECORD, "--created-by-call", randomUUID()])),
      [400, { error: "call-id-mismatch" }],
    );
    assert.deepEqual(await refusal(create(["--created-by-call", callId])), [
      400,
      { error: "record-id-required" },
    ]);
    assert.deepEqual(await refusal(create(["--record-id", "not-a-uuid"])), [
      400,
      { error: "record-id-required" },
    ]);
    assert.deepEqual(
      await refusal(create(["--record-id", RECORD, "--record-id", RECORD])),
      [400, { error: "record-id-required" }],
      "more than one --record-id",
    );
    assert.deepEqual(
      await refusal(create(["--record-id", RECORD, "--prompt", "a", "--prompt-file", "-"])),
      [400, { error: "more-than-one-first-message" }],
    );
    assert.equal(atrium.requests.length, 5);
    assert.equal(
      atrium.requests.every((entry) => entry.outcome !== "answered"),
      true,
      "nothing ran",
    );
    // the same shapes that are right: both flags with call_id (also the `=` form and any case), a create
    // without --created-by-call runs as sent, and handover carries neither flag by design
    for (const argv of [
      ["sessions", "new", "--record-id", RECORD, "--created-by-call", callId.toUpperCase()],
      [
        "sessions",
        "copy",
        `--record-id=${RECORD}`,
        `--created-by-call=${callId}`,
        "--prompt",
        "hi",
      ],
      ["sessions", "import", "--record-id", RECORD],
      ["sessions", "handover", "--brief", "-"],
      ["sessions", "list"],
    ]) {
      const answer = await post(atrium, "/api/acpx/call", callBody({ call_id: callId, argv }));
      assert.equal(answer.status, 200, argv.join(" "));
      atrium.setScript({ calls: [{ answer: { exit: 0, stdout: "ran\n" } }] });
    }
  });
});

test("the caller gate's final 403 (C6.1): mode forbidden answers 403 on every route, and it is not away", async () => {
  await withAtrium({ phases: [{ mode: "forbidden" }] }, async (atrium) => {
    for (const [path, body] of [
      ["/api/acpx/call", callBody()],
      ["/api/sessions/s/message", {}],
      ["/api/agent-pods/k/ready", readyHint],
    ] as const) {
      const answer = await post(atrium, path, body);
      assert.deepEqual([answer.status, JSON.parse(answer.text)], [403, { error: "forbidden" }]);
      assert.equal(answer.headers.get("retry-after"), null, "a 403 carries no Retry-After");
    }
  });
});

test("hints: well-formed ready and ended are recorded clean; departures are named", async () => {
  await withAtrium({}, async (atrium) => {
    assert.equal((await post(atrium, "/api/agent-pods/key1/ready", readyHint)).status, 200);
    assert.equal(
      (await post(atrium, "/api/agent-pods/key1/ended", { pod: { uid: "u-1" }, reason: "idle" }))
        .status,
      200,
    );
    assert.deepEqual(
      atrium.requests.map((entry) => [entry.route, entry.target, entry.problems]),
      [
        ["hint_ready", "key1", []],
        ["hint_ended", "key1", []],
      ],
    );
    const bad: Array<[string, string, unknown, string]> = [
      ["ready", "ready: contract 2", { ...readyHint, contract: 2 }, "contract"],
      ["ready", "ready: no node", { ...readyHint, pod: { name: "a", uid: "u" } }, "pod"],
      ["ready", "ready: placement", { ...readyHint, placement: "auto" }, "placement"],
      ["ready", "ready: releases", { ...readyHint, releases: undefined }, "releases"],
      ["ended", "ended: no uid", { pod: {}, reason: "idle" }, "pod"],
      ["ended", "ended: reason not a string", { pod: { uid: "u" }, reason: 5 }, "reason"],
    ];
    for (const [kind, name, body, problem] of bad) {
      await post(atrium, `/api/agent-pods/k/${kind}`, body);
      assert.ok(
        atrium.requests.at(-1)?.problems.includes(problem),
        `${name}: ${JSON.stringify(atrium.requests.at(-1)?.problems)}`,
      );
    }
    for (const reason of [
      "idle",
      "closed",
      "stale-release",
      "deadline",
      "term",
      "unused",
      "anything-new",
    ]) {
      await post(atrium, "/api/agent-pods/k/ended", { pod: { uid: "u" }, reason });
      assert.deepEqual(atrium.requests.at(-1)?.problems, [], reason);
    }
  });
});

test('away is the forwarder\'s answer exactly: 503, Retry-After 5, {"error":"atrium-away"} — on every route', async () => {
  await withAtrium({ phases: [{ mode: "away" }] }, async (atrium) => {
    for (const [path, body] of [
      ["/api/acpx/call", callBody()],
      ["/api/sessions/s/message", {}],
      ["/api/seats/t/message", {}],
      ["/api/agent-pods/k/ready", readyHint],
      ["/api/agent-pods/k/ended", { pod: { uid: "u" }, reason: "idle" }],
    ] as const) {
      const answer = await post(atrium, path, body);
      assert.equal(answer.status, 503, path);
      assert.equal(answer.headers.get("retry-after"), "5");
      assert.equal(answer.text, '{"error":"atrium-away"}');
    }
    assert.ok(atrium.requests.every((entry) => entry.outcome === "away" && entry.mode === "away"));
    const awayCall = atrium.requestsFor("call")[0];
    assert.equal(
      awayCall?.callId,
      awayCall?.body?.call_id,
      "an away call is recorded with the call id the client sent",
    );
  });
});

test("away for the first N requests, then back — counted in requests, no clock involved", async () => {
  await withAtrium(
    { phases: [{ mode: "away", forRequests: 3 }, { mode: "normal" }] },
    async (atrium) => {
      const statuses: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        statuses.push((await post(atrium, "/api/seats/t/message", {})).status);
      }
      assert.deepEqual(statuses, [503, 503, 503, 202, 202]);
      assert.deepEqual(
        atrium.requests.map((entry) => entry.mode),
        ["away", "away", "away", "normal", "normal"],
      );
    },
  );
});

test("away for N ms, then back — the stub changes state on its own clock, the record keeps the times", async () => {
  await withAtrium(
    { phases: [{ mode: "away", forMs: 300 }, { mode: "normal" }] },
    async (atrium) => {
      assert.equal((await post(atrium, "/api/seats/t/message", {})).status, 503);
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal((await post(atrium, "/api/seats/t/message", {})).status, 202);
      const [first, second] = atrium.requests;
      assert.ok((second?.atMs ?? 0) - (first?.atMs ?? 0) >= 300);
      assert.equal(atrium.mode, "normal");
    },
  );
});

test("refused: a real ECONNREFUSED on the same port, open connections cut, then back after forMs", async () => {
  await withAtrium({}, async (atrium) => {
    const { port } = atrium;
    assert.equal(
      (await post(atrium, "/api/seats/t/message", {})).status,
      202,
      "keep-alive connection is open",
    );
    atrium.setMode("refused", 400);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        post(atrium, "/api/seats/t/message", {}),
        (error: Error & { cause?: { code?: string } }) => {
          assert.equal(error.cause?.code, "ECONNREFUSED");
          return true;
        },
      );
    }
    assert.equal(atrium.requests.length, 1, "nothing reached the stub while refusing");
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(atrium.port, port);
    assert.equal(
      (await post(atrium, "/api/seats/t/message", {})).status,
      202,
      "back on the same port",
    );
  });
});

test("hang accepts the request and never answers", async () => {
  await withAtrium({ phases: [{ mode: "hang" }] }, async (atrium) => {
    await assert.rejects(
      fetch(`${atrium.url}/api/seats/t/message`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(300),
      }),
    );
    assert.equal(atrium.requests[0]?.outcome, "hang");
    assert.equal(atrium.requests[0]?.status, null);
  });
});

test("an unknown path under /api and a GET are 404", async () => {
  await withAtrium({}, async (atrium) => {
    assert.equal((await post(atrium, "/api/nothing", {})).status, 404);
    assert.equal((await fetch(`${atrium.url}/api/acpx/call`)).status, 404);
  });
});

test("run as a process from its TypeScript source: prints its port, honours --script, mode is steerable over /_kit", async () => {
  const source = fileURLToPath(new URL("../../test/pod-kit/recorded-atrium.ts", import.meta.url));
  const script = JSON.stringify({ calls: [{ answer: { exit: 7, stdout: "x" } }] });
  const child = spawn(process.execPath, [source, "--port", "0", "--script", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const firstLine = await new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.includes("\n")) {
          resolve(text.slice(0, text.indexOf("\n")));
        }
      });
      child.once("exit", (code) =>
        reject(new Error(`fake atrium exited early rc=${String(code)}`)),
      );
    });
    const announced = JSON.parse(firstLine) as { fake: string; port: number };
    assert.equal(announced.fake, "atrium");
    const base = `http://127.0.0.1:${String(announced.port)}`;
    const call = async (): Promise<number> => {
      const response = await fetch(`${base}/api/acpx/call`, {
        method: "POST",
        body: JSON.stringify(callBody()),
      });
      return response.status;
    };
    assert.equal(await call(), 200);
    await fetch(`${base}/_kit/mode`, { method: "POST", body: JSON.stringify({ mode: "away" }) });
    assert.equal(await call(), 503);
    await fetch(`${base}/_kit/mode`, { method: "POST", body: JSON.stringify({ mode: "normal" }) });
    assert.equal(await call(), 200);
    const record = (await (await fetch(`${base}/_kit/record`)).json()) as {
      requests: Array<{ mode: string; outcome: string }>;
    };
    assert.deepEqual(
      record.requests.map((entry) => entry.outcome),
      ["answered", "away", "answered"],
    );
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
