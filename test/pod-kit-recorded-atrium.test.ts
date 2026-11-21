import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";
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

function callBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: 1,
    call_id: randomUUID(),
    argv: ["sessions", "new", "--name", "x"],
    cwd: "/workspace",
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
    assert.deepEqual(record?.body?.argv, ["sessions", "new", "--name", "x"]);
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
      ["no cwd", { cwd: undefined }, "cwd"],
      ["no caller", { caller: undefined }, "caller"],
      [
        "caller without seat_url",
        { caller: { session_url: "x", record_id: "r" } },
        "caller.seat_url",
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
      assert.equal(answer.status, 200);
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
    atrium.setScript({ messages: { status: 409, body: { error: "gone" } } });
    const scripted = await post(atrium, "/api/sessions/sess-2/message", {});
    assert.equal(scripted.status, 409);
    assert.deepEqual(JSON.parse(scripted.text), { error: "gone" });
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
      ["ended", "ended: reason", { pod: { uid: "u" }, reason: "tired" }, "reason"],
    ];
    for (const [kind, name, body, problem] of bad) {
      await post(atrium, `/api/agent-pods/k/${kind}`, body);
      assert.ok(
        atrium.requests.at(-1)?.problems.includes(problem),
        `${name}: ${JSON.stringify(atrium.requests.at(-1)?.problems)}`,
      );
    }
    for (const reason of ["idle", "closed", "stale-release", "deadline", "term"]) {
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
      assert.deepEqual(statuses, [503, 503, 503, 200, 200]);
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
      assert.equal((await post(atrium, "/api/seats/t/message", {})).status, 200);
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
      200,
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
      200,
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
