import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMMAND_TABLE, PASS_THROUGH_INHERIT } from "../src/pod/command-classes.js";
import { addRecord } from "./pod-a3-helpers.js";
import { INHERIT_ALLOWED, startRecordedAtrium } from "./pod-kit/recorded-atrium.js";
import type { AtriumScript, Classify, RecordedAtrium } from "./pod-kit/recorded-atrium.js";

// Self-test of the X1 recorded atrium. The rule of the kit: the fake follows the REAL atrium
// (acpx-ui agent-pods `server/acpxCall/passThrough.ts`, `server/message-routes.ts`,
// `server/agentPods/hints.ts`, `server/callerGate`), and where C6 differs from it, the real side wins
// (TESTER-PLAN "Contract notes"). Each test names a shape the real side answers, or a fault that
// really happens on the wire.

const RECORD = "3f1c1e1a-2b3c-4d5e-8f60-7a8b9c0d1e2f";
const OTHER_RECORD = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const THIRD_RECORD = "5d4c3b2a-1f0e-4d9c-8b7a-6a5b4c3d2e1f";

async function withAtrium(
  script: AtriumScript,
  run: (atrium: RecordedAtrium) => Promise<void>,
  options: { classify?: Classify } = {},
) {
  const atrium = await startRecordedAtrium(script, options);
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
    argv: ["sessions", "new", "--name", "x", "--record-id", RECORD],
    caller: {
      session_url: "https://atrium.invalid/?session=s1",
      seat_url: "https://atrium.invalid/?seat=t1",
      record_id: RECORD,
    },
    admission_class: "spawn",
    inherit: { ACPX_SUBSCRIPTION: "sub1" },
    deadline_ms: 30_000,
    ...overrides,
  };
}

interface Answer {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, any>;
}

async function post(
  atrium: RecordedAtrium,
  path: string,
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<Answer> {
  const response = await fetch(`${atrium.url}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    json = {};
  }
  return { status: response.status, headers: response.headers, text, json };
}

const call = (atrium: RecordedAtrium, body: unknown, headers?: Record<string, string>) =>
  post(atrium, "/api/acpx/call", body, headers);

const KEY = "ab".repeat(12);
const readyHint = {
  contract: 1,
  pod: { name: "ag-k", uid: "u-1", node: "n1" },
  placement: "pool",
  releases: { acpx: "r1" },
};

test("POST /api/acpx/call answers {exit, stdout, stderr} and records the request in full", async () => {
  await withAtrium({}, async (atrium) => {
    const body = callBody({ stdin_b64: Buffer.from("a brief\n").toString("base64") });
    const answer = await call(atrium, body);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { exit: 0, stdout: "", stderr: "" });
    const [record] = atrium.requests;
    assert.equal(record?.route, "call");
    assert.deepEqual(record?.problems, []);
    assert.equal(record?.callId, body.call_id);
    assert.equal(record?.stdin, "a brief\n");
    assert.deepEqual(record?.body?.argv, body.argv);
    assert.deepEqual(record?.ranArgv, body.argv);
    assert.equal(record?.mode, "normal");
  });
});

test("A-9: the pass-through carries no cwd — a cwd that IS present is named (cwd_present), never refused", async () => {
  await withAtrium({}, async (atrium) => {
    assert.equal((await call(atrium, callBody())).status, 200);
    assert.deepEqual(atrium.requests.at(-1)?.problems, []);
    const withCwd = await call(atrium, callBody({ cwd: "/workspace" }));
    assert.equal(withCwd.status, 200, "atrium ignores the field");
    assert.deepEqual(atrium.requests.at(-1)?.problems, ["cwd_present"]);
  });
});

test("F5: what atrium's parseCallBody refuses is refused with its status and token — and nothing runs", async () => {
  await withAtrium({ calls: [{ answer: { exit: 0, stdout: "ran\n" } }] }, async (atrium) => {
    const huge = Buffer.alloc(8 * 1024 * 1024 + 1, 97).toString("base64");
    const cases: Array<[string, Record<string, unknown>, number, Record<string, unknown>]> = [
      ["contract 2", { contract: 2 }, 400, { error: "unsupported-contract", contract: 2 }],
      [
        "no contract",
        { contract: undefined },
        400,
        { error: "unsupported-contract", contract: null },
      ],
      ["call_id not a uuid", { call_id: "not-a-uuid" }, 400, { error: "bad-call-id" }],
      ["no call_id", { call_id: undefined }, 400, { error: "bad-call-id" }],
      ["argv empty", { argv: [] }, 400, { error: "bad-argv" }],
      ["argv with a non-string", { argv: ["a", 1] }, 400, { error: "bad-argv" }],
      ["no argv", { argv: undefined }, 400, { error: "bad-argv" }],
      ["stdin not base64", { stdin_b64: "not base64!" }, 400, { error: "bad-stdin" }],
      ["stdin of the wrong length", { stdin_b64: "AAA" }, 400, { error: "bad-stdin" }],
      [
        "stdin over 8 MiB",
        { stdin_b64: huge },
        413,
        { error: "stdin-too-large", limit_bytes: 8388608 },
      ],
      [
        "caller.record_id not a uuid",
        { caller: { session_url: "x", record_id: "r1" } },
        400,
        { error: "bad-caller" },
      ],
      [
        "caller without session_url",
        { caller: { record_id: RECORD } },
        400,
        { error: "bad-caller" },
      ],
      [
        "caller.seat_url empty",
        { caller: { session_url: "x", record_id: RECORD, seat_url: " " } },
        400,
        { error: "bad-caller", field: "seat_url" },
      ],
      [
        "unknown admission class",
        { admission_class: "batch" },
        400,
        { error: "bad-admission-class" },
      ],
      ["inherit an array", { inherit: ["ACPX_SUBSCRIPTION"] }, 400, { error: "bad-inherit" }],
      [
        "inherit a non-string value",
        { inherit: { PATH: 7 } },
        400,
        { error: "inherit-not-string", name: "PATH" },
      ],
      ["deadline 0", { deadline_ms: 0 }, 400, { error: "bad-deadline", max_ms: 60000 }],
      [
        "deadline over 60 s",
        { deadline_ms: 60_001 },
        400,
        { error: "bad-deadline", max_ms: 60000 },
      ],
      [
        "deadline not an integer",
        { deadline_ms: 1.5 },
        400,
        { error: "bad-deadline", max_ms: 60000 },
      ],
      ["deadline a string", { deadline_ms: "30" }, 400, { error: "bad-deadline", max_ms: 60000 }],
    ];
    for (const [name, overrides, status, expected] of cases) {
      const answer = await call(atrium, callBody(overrides));
      assert.equal(answer.status, status, name);
      assert.deepEqual(answer.json, expected, name);
    }
    assert.equal(
      atrium.requests.every((entry) => entry.ranArgv === null),
      true,
      "nothing ran",
    );
    // the order: the contract first, then the call id, the argv, the stdin, the caller …
    assert.equal(
      (await call(atrium, callBody({ contract: 2, call_id: "x", argv: [] }))).json.error,
      "unsupported-contract",
    );
    // what is optional: no deadline (default 60 s), no admission class, no inherit
    const minimal = await call(
      atrium,
      callBody({ deadline_ms: undefined, admission_class: undefined, inherit: undefined }),
    );
    assert.deepEqual(
      minimal.json,
      { exit: 0, stdout: "ran\n", stderr: "" },
      "the rule was not consumed by a refusal",
    );
    // the bounds are inclusive
    assert.equal(
      (await call(atrium, callBody({ deadline_ms: 60_000, stdin_b64: "AAAA" }))).status,
      200,
    );
    assert.equal((await call(atrium, callBody({ deadline_ms: 1 }))).status, 200);
  });
});

test("F5: a request that is not `Content-Type: application/json` is read as an EMPTY body (express.json), a malformed JSON body is the framework's 400", async () => {
  await withAtrium({}, async (atrium) => {
    const noType = await call(atrium, callBody(), {});
    assert.deepEqual(
      [noType.status, noType.json],
      [400, { error: "unsupported-contract", contract: null }],
    );
    const plain = await call(atrium, callBody(), { "content-type": "text/plain" });
    assert.equal(plain.json.error, "unsupported-contract");
    assert.equal(atrium.requests.at(-1)?.body, null, "not parsed");
    const broken = await call(atrium, "{not json");
    assert.equal(broken.status, 400);
    assert.match(broken.text, /Bad Request/);
    assert.equal(broken.headers.get("content-type")?.startsWith("text/html"), true);
    assert.equal(atrium.requests.at(-1)?.outcome, "bad_json");
  });
});

test("F5: a call with no caller is 400 bad-caller from a local peer, fine from a utility agent pod", async () => {
  await withAtrium({}, async (atrium) => {
    const answer = await call(atrium, callBody({ caller: undefined }));
    assert.deepEqual([answer.status, answer.json], [400, { error: "bad-caller" }]);
  });
  await withAtrium({ callerClass: "agent-pod", agentPod: { utility: true } }, async (atrium) => {
    const ok = await call(
      atrium,
      callBody({ caller: undefined, argv: ["sessions", "prune", "--dry-run"] }),
    );
    assert.equal(ok.status, 200);
    const create = await call(atrium, callBody({ caller: undefined }));
    assert.deepEqual(
      [create.status, create.json],
      [400, { error: "class-not-passable", reason: "no-caller" }],
      "a utility pod creates nothing",
    );
  });
});

test("the claimed caller is checked against the calling pod (agent-pod class): a session pod speaks as its own session only", async () => {
  const key = createHash("sha256").update(RECORD).digest("hex").slice(0, 24);
  await withAtrium({ callerClass: "agent-pod", agentPod: { sessionKey: key } }, async (atrium) => {
    assert.equal((await call(atrium, callBody())).status, 200);
    const other = await call(
      atrium,
      callBody({ caller: { session_url: "x", record_id: OTHER_RECORD } }),
    );
    assert.deepEqual([other.status, other.json], [403, { error: "caller-mismatch" }]);
    const utility = await call(atrium, callBody({ caller: undefined }));
    assert.equal(
      utility.json.error,
      "caller-mismatch",
      "a session pod may not claim no caller either",
    );
    assert.equal(atrium.requests.at(-1)?.ranArgv, null);
  });
  await withAtrium({ callerClass: "agent-pod", agentPod: { utility: true } }, async (atrium) => {
    const claimed = await call(atrium, callBody());
    assert.equal(claimed.json.error, "caller-mismatch", "a utility pod claims no caller at all");
  });
});

test("F5: class-not-passable comes from acpx's class table (loaded in-process): a prompt, --help; a leading `acpx` is read as an agent name", async () => {
  await withAtrium({}, async (atrium) => {
    const refusals = async (argv: string[]) => {
      const answer = await call(atrium, callBody({ argv }));
      return [answer.status, answer.json] as const;
    };
    // the real classifier reads a leading `acpx` as an AGENT name and classifies what follows (measured:
    // ["acpx","sessions","new",...] => path "sessions new", class create) — the A-24 shape is NOT refused by the
    // table; atrium's create checks then apply to it as to any create
    assert.equal(
      (await call(atrium, callBody({ argv: ["acpx", "sessions", "new", "--record-id", RECORD] })))
        .status,
      200,
    );
    assert.deepEqual(
      await refusals(["acpx", "sessions", "new", "--created-by-call", randomUUID()]),
      [400, { error: "record-id-required" }],
    );
    // a class that does not pass: an owner-ensure verb (a prompt) and a one-shot
    const prompt = await refusals(["prompt", "hello"]);
    assert.equal(prompt[1].error, "class-not-passable");
    assert.ok(["class", "target-unresolved"].includes(String(prompt[1].reason)));
    const help = await refusals(["sessions", "new", "--help"]);
    assert.equal(help[1].error, "class-not-passable");
    assert.equal(
      atrium.requests.filter((entry) => entry.ranArgv !== null).length,
      1,
      "only the one create that passed ran",
    );
    // and the ones that pass: a create and a control-store verb
    assert.equal(
      (await call(atrium, callBody({ argv: ["sessions", "prune", "--dry-run"] }))).status,
      200,
    );
    assert.equal((await call(atrium, callBody())).status, 200);
  });
});

test("class-not-passable: an injected classifier decides (record / owner-if-pod about the caller's OWN session or an unresolved one is refused)", async () => {
  const verdicts: Record<
    string,
    { kind: string; path: string; class: string; targetSessionId?: string | null }
  > = {
    own: { kind: "classified", path: "sessions reopen", class: "record", targetSessionId: RECORD },
    unresolved: {
      kind: "classified",
      path: "sessions reopen",
      class: "record",
      targetSessionId: null,
    },
    other: {
      kind: "classified",
      path: "sessions reopen",
      class: "record",
      targetSessionId: OTHER_RECORD,
    },
  };
  const classify: Classify = async (argv) =>
    verdicts[argv[0] ?? ""] ?? { kind: "unclassified", path: "" };
  await withAtrium(
    {},
    async (atrium) => {
      assert.deepEqual((await call(atrium, callBody({ argv: ["own"] }))).json, {
        error: "class-not-passable",
        reason: "own-session",
      });
      assert.equal(
        (await call(atrium, callBody({ argv: ["unresolved"] }))).json.reason,
        "target-unresolved",
      );
      assert.equal((await call(atrium, callBody({ argv: ["other"] }))).status, 200);
    },
    { classify },
  );
});

test("a record command whose target atrium cannot resolve is refused (target-unresolved); resolveTargetAs says the session exists on the control pod", async () => {
  const argv = ["sessions", "set-metadata", "--session-id", "nobody-here", "--key", "k"];
  await withAtrium({}, async (atrium) => {
    const refused = await call(atrium, callBody({ argv }));
    assert.deepEqual(
      [refused.status, refused.json],
      [400, { error: "class-not-passable", reason: "target-unresolved" }],
    );
  });
  await withAtrium({ resolveTargetAs: OTHER_RECORD }, async (atrium) => {
    assert.equal((await call(atrium, callBody({ argv }))).status, 200);
    const own = await call(
      atrium,
      callBody({ argv, caller: { session_url: "x", record_id: OTHER_RECORD } }),
    );
    assert.equal(own.json.reason, "own-session", "still not the caller's own session");
  });
});

test("a create's file arguments are refused: --prompt-file <path>, a handover brief that is not an absolute shared path", async () => {
  await withAtrium({}, async (atrium) => {
    const promptFile = await call(
      atrium,
      callBody({
        argv: ["sessions", "new", "--record-id", RECORD, "--prompt-file", "/tmp/brief.md"],
      }),
    );
    assert.deepEqual(promptFile.json, {
      error: "class-not-passable",
      reason: "file-argument",
      flag: "--prompt-file",
    });
    const noStdin = await call(
      atrium,
      callBody({ argv: ["sessions", "new", "--record-id", RECORD, "--prompt-file", "-"] }),
    );
    assert.deepEqual(noStdin.json, { error: "stdin-required", flag: "--prompt-file" });
    for (const brief of ["relative.md", "/tmp/pod-only.md"]) {
      const handover = await call(
        atrium,
        callBody({ argv: ["sessions", "handover", "--brief", brief] }),
      );
      assert.equal(handover.json.reason, "file-argument", brief);
    }
    const shared = await call(
      atrium,
      callBody({ argv: ["sessions", "handover", "--brief", "/workspace/brief.md"] }),
    );
    assert.equal(shared.status, 200);
  });
});

test("inherit: a name outside the closed list is 400 inherit-not-allowed (+name); the shape errors come first", async () => {
  await withAtrium(
    { calls: [{ times: 1, answer: { exit: 0, stdout: "ran\n" } }, { answer: { exit: 9 } }] },
    async (atrium) => {
      assert.deepEqual([...INHERIT_ALLOWED], ["ACPX_SUBSCRIPTION", "ATRIUM_OS"]);
      const refused = await call(
        atrium,
        callBody({ inherit: { ACPX_SUBSCRIPTION: "s", PATH: "/evil" } }),
      );
      assert.deepEqual(
        [refused.status, refused.json],
        [400, { error: "inherit-not-allowed", name: "PATH" }],
      );
      assert.equal(atrium.requests[0]?.outcome, "refused:inherit-not-allowed");
      const ok = await call(
        atrium,
        callBody({ inherit: { ATRIUM_OS: "/os", ACPX_SUBSCRIPTION: "s" } }),
      );
      assert.equal(ok.json.stdout, "ran\n", "the refusal consumed no rule");
      const shape = await call(atrium, callBody({ inherit: { PATH: 7 } }));
      assert.equal(shape.json.error, "inherit-not-string", "the shape is checked before the name");
    },
  );
});

test("the kit's one copy cannot drift: INHERIT_ALLOWED = PASS_THROUGH_INHERIT; create-ness comes from the class table itself (no copy)", () => {
  assert.deepEqual([...INHERIT_ALLOWED], [...PASS_THROUGH_INHERIT]);
  // atrium derives "is a create" from the table's verdict (`class === "create"`, not `sessions handover`); the kit does the
  // same at run time, so a create path added to the table is checked as a create without any list to update. Pin it.
  const creates = new Set(
    Object.entries(COMMAND_TABLE)
      .filter(([, entry]) => entry.class === "create")
      .map(([path]) => path),
  );
  assert.ok(creates.has("sessions new") && creates.has("sessions handover"), "the table's creates");
});

test("A-27: a create's --created-by-call must be call_id (400 call-id-mismatch); --record-id must be one uuid; one first message", async () => {
  await withAtrium({ calls: [{ answer: { exit: 0, stdout: "ran\n" } }] }, async (atrium) => {
    const callId = randomUUID();
    const create = (extra: string[], id = callId) =>
      callBody({ call_id: id, argv: ["sessions", "new", ...extra] });
    const refusal = async (body: Record<string, unknown>) => {
      const answer = await call(atrium, body);
      return [answer.status, answer.json] as const;
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
      atrium.requests.every((entry) => entry.ranArgv === null),
      true,
      "nothing ran",
    );
    // the same shapes that are right: both flags with call_id (the `=` form, any case), no --created-by-call at
    // all, an import with its record id; handover carries neither flag by design
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
      ["sessions", "handover", "--brief", "/workspace/b.md"],
      ["sessions", "prune", "--dry-run"],
    ]) {
      const answer = await call(atrium, callBody({ call_id: callId, argv }));
      assert.equal(answer.status, 200, argv.join(" "));
    }
    const own = randomUUID();
    assert.equal(
      (
        await call(
          atrium,
          callBody({
            call_id: own,
            argv: [
              "sessions",
              "new",
              "--record-id",
              RECORD,
              "--created-by-call",
              own.toUpperCase(),
            ],
          }),
        )
      ).status,
      200,
      "the id compares case-insensitively",
    );
  });
});

test("the first message is taken out of the argv acpx runs with; rules match the RUN argv; the delivery names it", async () => {
  await withAtrium(
    {
      calls: [
        {
          argvPrefix: ["sessions", "new", "--record-id", RECORD],
          answer: { exit: 0, stdout: "{}\n" },
        },
      ],
    },
    async (atrium) => {
      const callId = randomUUID();
      const answer = await call(
        atrium,
        callBody({
          call_id: callId,
          argv: [
            "sessions",
            "new",
            "--record-id",
            RECORD,
            "--created-by-call",
            callId,
            "--prompt",
            "do it",
            "--name",
            "n",
          ],
        }),
      );
      assert.equal(answer.status, 200);
      assert.deepEqual(atrium.requests[0]?.ranArgv, [
        "sessions",
        "new",
        "--record-id",
        RECORD,
        "--created-by-call",
        callId,
        "--name",
        "n",
      ]);
      assert.deepEqual(answer.json.delivery, { delivery_id: callId, to: RECORD, status: "queued" });
      // --prompt-file - : the message is the stdin, and acpx gets none of it
      const second = randomUUID();
      const viaStdin = await call(
        atrium,
        callBody({
          call_id: second,
          stdin_b64: Buffer.from("from stdin").toString("base64"),
          argv: ["sessions", "new", "--record-id", OTHER_RECORD, "--prompt-file", "-"],
        }),
      );
      assert.deepEqual(atrium.requests[1]?.ranArgv, [
        "sessions",
        "new",
        "--record-id",
        OTHER_RECORD,
      ]);
      assert.equal(viaStdin.json.delivery?.delivery_id, second);
    },
  );
});

test("F6: only a RECORDED create is replayed (`delivery.replay:true`, acpx is run again); everything else re-runs, a changed message is refused", async () => {
  await withAtrium({ calls: [{ answer: { exit: 0, stdout: "ran\n" } }] }, async (atrium) => {
    const callId = randomUUID();
    const argv = [
      "sessions",
      "new",
      "--record-id",
      RECORD,
      "--created-by-call",
      callId,
      "--prompt",
      "hello",
    ];
    const first = await call(atrium, callBody({ call_id: callId, argv }));
    assert.equal(first.json.delivery.replay, undefined);
    const repeat = await call(atrium, callBody({ call_id: callId, argv }));
    assert.deepEqual(repeat.json.delivery, {
      delivery_id: callId,
      to: RECORD,
      status: "queued",
      replay: true,
    });
    assert.equal(
      repeat.json.stdout,
      "ran\n",
      "acpx WAS run again — the answer is its, not the first one's",
    );
    assert.equal(atrium.requests[1]?.replayed, true);
    assert.deepEqual(
      atrium.requests.map((entry) => entry.outcome),
      ["answered", "replayed"],
    );
    // a replay with another first message: atrium's own refusal, acpx's shape, nothing runs
    const changed = await call(
      atrium,
      callBody({ call_id: callId, argv: [...argv.slice(0, -1), "something else"] }),
    );
    assert.equal(changed.json.exit, 2);
    assert.equal(changed.json.error, "create-replay-mismatch");
    assert.match(String(changed.json.stderr), /CREATE_REPLAY_MISMATCH/);
    assert.equal(atrium.requests[2]?.ranArgv, null);
    // a replay with a changed --record-id is a second record, run as it comes
    const otherRecord = await call(
      atrium,
      callBody({
        call_id: callId,
        argv: [
          "sessions",
          "new",
          "--record-id",
          OTHER_RECORD,
          "--created-by-call",
          callId,
          "--prompt",
          "hello",
        ],
      }),
    );
    assert.equal(
      otherRecord.json.delivery.replay,
      true,
      "atrium keys on call_id, whatever the argv else says",
    );
    assert.equal(otherRecord.json.delivery.to, OTHER_RECORD);
    // another caller reusing the id: refused, nothing runs
    const stolen = await call(
      atrium,
      callBody({ call_id: callId, argv, caller: { session_url: "x", record_id: OTHER_RECORD } }),
    );
    assert.deepEqual(
      [stolen.status, stolen.json],
      [409, { error: "delivery-id-conflict", delivery_id: callId }],
    );
    // a create with NO message records nothing: its repeat re-runs and is no replay
    const quiet = randomUUID();
    const quietArgv = ["sessions", "new", "--record-id", THIRD_RECORD, "--created-by-call", quiet];
    const q1 = await call(atrium, callBody({ call_id: quiet, argv: quietArgv }));
    const q2 = await call(atrium, callBody({ call_id: quiet, argv: quietArgv }));
    assert.equal(q1.json.delivery, undefined);
    assert.equal(q2.json.delivery, undefined);
    // a non-create with a repeated call_id is simply run again
    const same = randomUUID();
    for (let i = 0; i < 2; i += 1) {
      const ran = await call(
        atrium,
        callBody({ call_id: same, argv: ["sessions", "prune", "--dry-run"] }),
      );
      assert.equal(ran.json.delivery, undefined);
      assert.equal(ran.json.stdout, "ran\n");
    }
    assert.equal(atrium.requests.at(-1)?.replayed, false);
  });
});

test("F6: a lost answer — the create ran and recorded its first message; the retry is atrium's replay and acpx runs again", async () => {
  await withAtrium(
    {
      calls: [
        { times: 1, loseAnswer: true, answer: { exit: 0, stdout: "created\n" } },
        { answer: { exit: 0, stdout: "again\n" } },
      ],
    },
    async (atrium) => {
      const callId = randomUUID();
      const body = callBody({
        call_id: callId,
        argv: [
          "sessions",
          "new",
          "--record-id",
          RECORD,
          "--created-by-call",
          callId,
          "--prompt",
          "hi",
        ],
      });
      await assert.rejects(call(atrium, body), "the first attempt's connection is cut");
      const retry = await call(atrium, body);
      assert.equal(retry.json.stdout, "again\n", "run again — it is not the first answer replayed");
      assert.equal(retry.json.delivery.replay, true);
      assert.deepEqual(
        atrium.requests.map((entry) => [entry.outcome, entry.replayed]),
        [
          ["lost_answer", false],
          ["replayed", true],
        ],
      );
    },
  );
});

test("call rules: first matching unspent rule; exit codes and a whole HTTP answer pass through", async () => {
  await withAtrium(
    {
      calls: [
        {
          argvPrefix: ["sessions", "prune"],
          times: 1,
          answer: { exit: 0, stdout: '{"id":"a"}\n' },
        },
        {
          argvPrefix: ["sessions", "prune"],
          answer: { exit: 75, stderr: "acpx: REFUSED reason=agent_cap\n" },
        },
        {
          argvPrefix: ["sessions", "new"],
          answer: { status: 500, body: { error: "pass-through-failed" } },
        },
      ],
    },
    async (atrium) => {
      const prune = () => call(atrium, callBody({ argv: ["sessions", "prune", "--dry-run"] }));
      assert.deepEqual((await prune()).json, { exit: 0, stdout: '{"id":"a"}\n', stderr: "" });
      const second = (await prune()).json;
      assert.equal(second.exit, 75);
      assert.match(second.stderr, /REFUSED reason=agent_cap/);
      const whole = await call(atrium, callBody());
      assert.deepEqual([whole.status, whole.json], [500, { error: "pass-through-failed" }]);
    },
  );
});

test("message routes: EVERY accepted message is 202 {delivery_id, from, to, to_seat?, status:queued}; the client's delivery_id is echoed", async () => {
  await withAtrium({}, async (atrium) => {
    const mine = randomUUID();
    const session = await post(atrium, `/api/sessions/${RECORD}/message`, {
      text: "hi",
      from: "  sender-1 ",
      delivery_id: mine,
    });
    assert.equal(session.status, 202, "202, never 200");
    assert.deepEqual(session.json, {
      delivery_id: mine,
      from: "sender-1",
      to: RECORD,
      status: "queued",
    });
    const seat = await post(atrium, "/api/seats/seat-1/message", { text: "yo" });
    assert.equal(seat.status, 202);
    assert.match(
      String(seat.json.delivery_id),
      /^[0-9a-f-]{36}$/,
      "no delivery_id sent: a fresh uuid",
    );
    assert.equal(seat.json.to_seat, "seat-1");
    assert.match(
      String(seat.json.to),
      /^[0-9a-f-]{36}$/,
      "the seat's holder is a record id, not an invented name",
    );
    assert.equal(seat.json.from, "anonymous");
    assert.deepEqual(
      atrium.requests.map((entry) => [entry.route, entry.target, entry.body?.text]),
      [
        ["session_message", RECORD, "hi"],
        ["seat_message", "seat-1", "yo"],
      ],
    );
  });
  await withAtrium(
    { messages: { seats: { "seat-1": RECORD }, seatOf: { [RECORD]: "seat-1" } } },
    async (atrium) => {
      assert.equal(
        (await post(atrium, "/api/seats/seat-1/message", { text: "x" })).json.to,
        RECORD,
      );
      assert.equal(
        (await post(atrium, `/api/sessions/${RECORD}/message`, { text: "x" })).json.to_seat,
        "seat-1",
      );
    },
  );
});

test("message routes: `from` falls back to the X-Source-Session header (what acpx sends); the body's wins", async () => {
  await withAtrium({}, async (atrium) => {
    const headers = { "content-type": "application/json", "x-source-session": " sess-header " };
    assert.equal(
      (await post(atrium, "/api/sessions/s/message", { text: "a" }, headers)).json.from,
      "sess-header",
    );
    assert.equal(
      (await post(atrium, "/api/sessions/s/message", { text: "a", from: "body" }, headers)).json
        .from,
      "body",
    );
  });
});

test("message routes refuse what the real route refuses: no text, a delivery_id that is not a lowercase uuid", async () => {
  await withAtrium({}, async (atrium) => {
    const empty = await post(atrium, "/api/sessions/s/message", {});
    assert.deepEqual([empty.status, empty.json], [400, { error: "text is required" }]);
    const blank = await post(atrium, "/api/sessions/s/message", { text: "   " });
    assert.equal(blank.status, 400);
    const upper = await post(atrium, "/api/sessions/s/message", {
      text: "a",
      delivery_id: randomUUID().toUpperCase(),
    });
    assert.deepEqual(
      [upper.status, upper.json],
      [400, { error: "delivery_id must be a lowercase UUID", code: "bad-delivery-id" }],
    );
    assert.equal(
      (await post(atrium, "/api/sessions/s/message", { text: "a", delivery_id: 7 })).json.code,
      "bad-delivery-id",
    );
    const noType = await post(atrium, "/api/sessions/s/message", { text: "a" }, {});
    assert.equal(noType.status, 400, "no JSON content type: the body is empty, so no text");
    assert.equal(
      (
        await post(atrium, "/api/sessions/s/message", {
          content: [{ type: "text", text: "blocks" }],
        })
      ).status,
      202,
    );
    assert.equal(atrium.requests.filter((entry) => entry.outcome.startsWith("refused:")).length, 5);
  });
});

test("message routes: a message held for room is 202 with status STILL queued, plus held{since, reason, ahead} and message", async () => {
  await withAtrium(
    {
      messages: {
        answers: ["queued", "held", { held: { reason: "agent_cap", ahead: 2 } }],
        default: "queued",
      },
    },
    async (atrium) => {
      const answers: Answer[] = [];
      for (const path of [
        "/api/sessions/aaaaaaaa-1/message",
        "/api/seats/b/message",
        "/api/sessions/cccccccc-3/message",
        "/api/seats/d/message",
      ]) {
        answers.push(await post(atrium, path, { text: "m" }));
      }
      assert.deepEqual(
        answers.map((a) => [a.status, a.json.status, "held" in a.json]),
        [
          [202, "queued", false],
          [202, "queued", true],
          [202, "queued", true],
          [202, "queued", false],
        ],
        "202 always, status stays queued; a hold is marked by `held` + `message`, never by a status",
      );
      assert.equal(answers[1]?.json.held.reason, "pod_starting");
      assert.equal(answers[1]?.json.held.ahead, 0);
      assert.match(String(answers[1]?.json.held.since), /^\d{4}-\d\d-\d\dT/);
      assert.match(String(answers[1]?.json.message), /^Starting \(delivery [0-9a-f-]{36}\): /);
      assert.equal(answers[2]?.json.held.reason, "agent_cap");
      assert.equal(answers[2]?.json.held.ahead, 2);
      assert.match(String(answers[2]?.json.message), /^Queued for room \(delivery .*\(2 ahead\)/);
      assert.equal(answers[0]?.json.message, undefined);
      assert.deepEqual(
        atrium.requests.map((entry) => entry.outcome),
        ["answered", "held", "held", "answered"],
      );
    },
  );
  await withAtrium(
    { messages: { default: { status: 409, body: { error: "gone" } } } },
    async (atrium) => {
      const scripted = await post(atrium, "/api/sessions/s/message", { text: "a" });
      assert.deepEqual([scripted.status, scripted.json], [409, { error: "gone" }]);
    },
  );
});

test("a create's first message can be held for room: delivery.held{since, reason, ahead}", async () => {
  await withAtrium({ firstMessageHold: { reason: "agent_cap", ahead: 1 } }, async (atrium) => {
    const callId = randomUUID();
    const answer = await call(
      atrium,
      callBody({
        call_id: callId,
        argv: [
          "sessions",
          "new",
          "--record-id",
          RECORD,
          "--created-by-call",
          callId,
          "--prompt",
          "go",
        ],
      }),
    );
    assert.equal(answer.json.delivery.held.reason, "agent_cap");
    assert.equal(answer.json.delivery.held.ahead, 1);
    assert.equal(answer.json.delivery.status, "queued");
  });
});

test("hints: the key is 24 lower-case hex (400 bad-key), a present contract must be 1, ready reports `redriven`, ended answers {ok:true}", async () => {
  await withAtrium({ hints: { redriven: 3 } }, async (atrium) => {
    const ready = await post(atrium, `/api/agent-pods/${KEY}/ready`, readyHint);
    assert.deepEqual([ready.status, ready.json], [200, { ok: true, redriven: 3 }]);
    const ended = await post(atrium, `/api/agent-pods/${KEY}/ended`, {
      pod: { uid: "u-1" },
      reason: "idle",
    });
    assert.deepEqual([ended.status, ended.json], [200, { ok: true }]);
    assert.deepEqual(
      atrium.requests.map((entry) => [entry.route, entry.target, entry.problems]),
      [
        ["hint_ready", KEY, []],
        ["hint_ended", KEY, []],
      ],
    );
    for (const key of ["key1", KEY.toUpperCase(), "ab".repeat(11)]) {
      for (const kind of ["ready", "ended"]) {
        const refused = await post(atrium, `/api/agent-pods/${key}/${kind}`, readyHint);
        assert.deepEqual([refused.status, refused.json.error], [400, "bad-key"], `${key}/${kind}`);
      }
    }
    const wrong = await post(atrium, `/api/agent-pods/${KEY}/ready`, { ...readyHint, contract: 2 });
    assert.deepEqual(
      [wrong.status, wrong.json],
      [400, { error: "unsupported-contract", contract: 2 }],
    );
    const absent = await post(atrium, `/api/agent-pods/${KEY}/ready`, {
      ...readyHint,
      contract: undefined,
    });
    assert.equal(
      absent.status,
      200,
      "an ABSENT contract is not refused (only a present one that is not 1)",
    );
    assert.ok(atrium.requests.at(-1)?.problems.includes("contract"), "the kit still names it");
    for (const reason of [
      "idle",
      "closed",
      "stale-release",
      "deadline",
      "term",
      "unused",
      "anything-new",
    ]) {
      const answer = await post(atrium, `/api/agent-pods/${KEY}/ended`, {
        pod: { uid: "u" },
        reason,
      });
      assert.equal(answer.status, 200, reason);
      assert.deepEqual(atrium.requests.at(-1)?.problems, [], reason);
    }
  });
});

test("hints: shape departures the real route does not refuse are named by the kit (problems)", async () => {
  await withAtrium({}, async (atrium) => {
    const bad: Array<[string, string, unknown, string]> = [
      ["ready", "no node", { ...readyHint, pod: { name: "a", uid: "u" } }, "pod"],
      ["ready", "placement", { ...readyHint, placement: "auto" }, "placement"],
      ["ready", "releases", { ...readyHint, releases: undefined }, "releases"],
      ["ended", "no uid", { pod: {}, reason: "idle" }, "pod"],
      ["ended", "reason not a string", { pod: { uid: "u" }, reason: 5 }, "reason"],
    ];
    for (const [kind, name, body, problem] of bad) {
      const answer = await post(atrium, `/api/agent-pods/${KEY}/${kind}`, body);
      assert.equal(answer.status, 200, name);
      assert.ok(
        atrium.requests.at(-1)?.problems.includes(problem),
        `${name}: ${JSON.stringify(atrium.requests.at(-1)?.problems)}`,
      );
    }
  });
});

test("F8 / K-R2-5: the gate's final 403 is the REAL CALLER_NOT_ALLOWED body on the control route only; the messaging and public routes are open to every caller", async () => {
  await withAtrium({ phases: [{ mode: "forbidden" }] }, async (atrium) => {
    const refusal = (routeClass: string) => ({
      error:
        "This route is not available to this caller. Run the command on the target box itself (ssh-remote), or use the UI.",
      code: "CALLER_NOT_ALLOWED",
      caller_class: "remote",
      route_class: routeClass,
    });
    const answer = await call(atrium, callBody());
    assert.deepEqual([answer.status, answer.json], [403, refusal("control")]);
    assert.equal(answer.headers.get("retry-after"), null, "a 403 carries no Retry-After");
    // callerGate `isAllowed`: `messaging` and `public` are open to EVERY caller — a 403 there is one the real gate cannot produce
    assert.equal((await post(atrium, "/api/sessions/s/message", { text: "a" })).status, 202);
    assert.equal((await post(atrium, "/api/seats/t/message", { text: "a" })).status, 202);
    assert.equal(
      (await post(atrium, `/api/agent-pods/${KEY}/ready`, readyHint)).status,
      200,
      "public: not guarded",
    );
    assert.equal(
      (await post(atrium, `/api/agent-pods/${KEY}/ended`, { reason: "idle" })).status,
      200,
    );
    assert.equal(atrium.requests.at(0)?.ranArgv, null, "nothing ran");
  });
});

test("K-R2-1: a create REPLAYED without --created-by-call is refused by acpx (the record id exists): exit 1, no delivery, never replay:true", async () => {
  await withAtrium({}, async (atrium) => {
    const callId = randomUUID();
    const withFlag = [
      "sessions",
      "new",
      "--record-id",
      RECORD,
      "--created-by-call",
      callId,
      "--prompt",
      "hello",
    ];
    assert.equal((await call(atrium, callBody({ call_id: callId, argv: withFlag }))).json.exit, 0);
    // the retry that forgot the flag — A-27's whole duty
    const forgot = await call(
      atrium,
      callBody({
        call_id: callId,
        argv: ["sessions", "new", "--record-id", RECORD, "--prompt", "hello"],
      }),
    );
    assert.equal(forgot.json.exit, 1);
    assert.match(
      String(forgot.json.stderr),
      /record-id destination already exists; refusing to create another ACP session/,
    );
    assert.equal(forgot.json.delivery, undefined, "no delivery, and never replay:true");
    assert.equal(atrium.requests.at(-1)?.replayed, false);
    // another call id on the same record id is refused the same way, even with the flag
    const other = randomUUID();
    const stolen = await call(
      atrium,
      callBody({
        call_id: other,
        argv: ["sessions", "new", "--record-id", RECORD, "--created-by-call", other],
      }),
    );
    assert.equal(stolen.json.exit, 1);
    // with the flag, the identical repeat is answered (replay)
    const same = await call(atrium, callBody({ call_id: callId, argv: withFlag }));
    assert.equal(same.json.delivery.replay, true);
  });
});

test("K-R2-2: the kit never touches a store it was not given — the test process's HOME is neither read nor written", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pod-kit-hermetic-"));
  const kit = pathToFileURL(
    fileURLToPath(new URL("./pod-kit/recorded-atrium.js", import.meta.url)),
  ).href;
  const driver = `
    const { startRecordedAtrium } = await import(${JSON.stringify(kit)});
    const atrium = await startRecordedAtrium({});
    const body = { contract: 1, call_id: ${JSON.stringify(randomUUID())}, argv: ["sessions", "set-metadata", "--session-id", "nobody", "--key", "k"],
      caller: { session_url: "x", record_id: ${JSON.stringify(RECORD)} } };
    const r = await fetch(atrium.url + "/api/acpx/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    console.log(r.status, await r.text());
    await atrium.close();
  `;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  for (const name of Object.keys(env)) {
    if (name.startsWith("ACPX_")) {
      delete env[name];
    }
  }
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", driver], {
    env,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /^400 .*target-unresolved/,
    "an unknown target is unresolved, not looked up in the box's store",
  );
  assert.deepEqual(
    fs.readdirSync(home),
    [],
    "nothing was created under HOME — no .acpx, no index.json",
  );
  fs.rmSync(home, { recursive: true });
});

test("K-R3-2: the same ids with a DIFFERENT request — another --name, reordered flags — is acpx's CREATE_REPLAY_MISMATCH (exit 2), never replay:true", async () => {
  await withAtrium({}, async (atrium) => {
    const callId = randomUUID();
    const base = ["sessions", "new", "--record-id", RECORD, "--created-by-call", callId];
    const first = await call(
      atrium,
      callBody({ call_id: callId, argv: [...base, "--name", "one"] }),
    );
    assert.equal(first.json.exit, 0);
    // the identical request: acpx answers from the record
    assert.equal(
      (await call(atrium, callBody({ call_id: callId, argv: [...base, "--name", "one"] }))).json
        .exit,
      0,
    );
    for (const argv of [
      [...base, "--name", "two"],
      ["sessions", "new", "--created-by-call", callId, "--record-id", RECORD, "--name", "one"],
      [...base],
    ]) {
      const mismatch = await call(atrium, callBody({ call_id: callId, argv }));
      assert.equal(mismatch.json.exit, 2, argv.join(" "));
      assert.match(String(mismatch.json.stderr), /^CREATE_REPLAY_MISMATCH: record /);
      assert.equal(mismatch.json.delivery, undefined);
      assert.equal(atrium.requests.at(-1)?.replayed, false);
    }
    // with --format json acpx writes the JSON-RPC error on stdout and leaves stderr empty
    const json = await call(
      atrium,
      callBody({ call_id: callId, argv: ["--format", "json", ...base, "--name", "three"] }),
    );
    assert.equal(json.json.exit, 2);
    assert.equal(json.json.stderr, "");
    assert.equal(
      (JSON.parse(String(json.json.stdout)) as { error: { data: { detailCode: string } } }).error
        .data.detailCode,
      "CREATE_REPLAY_MISMATCH",
    );
  });
});

test("K-R3-2 / K-R2-1: the `record-id already exists` refusal is a JSON-RPC error on stdout under --format json", async () => {
  await withAtrium({}, async (atrium) => {
    const id = randomUUID();
    await call(
      atrium,
      callBody({
        call_id: id,
        argv: ["sessions", "new", "--record-id", RECORD, "--created-by-call", id],
      }),
    );
    const again = randomUUID();
    const refused = await call(
      atrium,
      callBody({
        call_id: again,
        argv: ["--format", "json", "sessions", "new", "--record-id", RECORD],
      }),
    );
    assert.equal(refused.json.exit, 1);
    assert.equal(refused.json.stderr, "");
    const rpc = JSON.parse(String(refused.json.stdout)) as {
      error: { code: number; message: string };
    };
    assert.equal(rpc.error.code, -32603);
    assert.match(rpc.error.message, /record-id destination already exists/);
  });
});

test("K-R3-4: a caller-chosen delivery id is compared as atrium's ACTOR — from X-Source-Session only; seat first; anonymous never matches", async () => {
  await withAtrium({}, async (atrium) => {
    const send = (
      id: string,
      headers: Record<string, string>,
      body: Record<string, unknown> = {},
    ) =>
      post(
        atrium,
        "/api/sessions/s/message",
        { text: "a", delivery_id: id, ...body },
        {
          "content-type": "application/json",
          ...headers,
        },
      );
    const seatUrl = (seat: string, session?: string) =>
      `https://atrium.invalid/?seat=${seat}${session === undefined ? "" : `&session=${session}`}`;
    // the same session / seat re-sends under its own id; a SUCCESSOR on the same seat does too
    const a = randomUUID();
    assert.equal(
      (await send(a, { "x-source-session": seatUrl("seat-1", "sess-old") })).status,
      202,
    );
    assert.equal(
      (await send(a, { "x-source-session": seatUrl("seat-1", "sess-old") })).status,
      202,
    );
    assert.equal(
      (await send(a, { "x-source-session": seatUrl("seat-1", "sess-new") })).status,
      202,
      "the seat is compared first",
    );
    // another seat: refused
    assert.equal(
      (await send(a, { "x-source-session": seatUrl("seat-2", "sess-old") })).json.code,
      "delivery-id-conflict",
    );
    // a body-only `from` is not an identity: unattributed never matches
    const b = randomUUID();
    assert.equal((await send(b, {}, { from: "alice" })).status, 202);
    assert.equal(
      (await send(b, {}, { from: "alice" })).json.code,
      "delivery-id-conflict",
      "not even itself",
    );
    assert.equal(
      (
        await send(
          b,
          { "x-source-session": "https://atrium.invalid/?session=sess-x" },
          { from: "alice" },
        )
      ).json.code,
      "delivery-id-conflict",
    );
    // the same SESSION (no seats on either side) matches
    const c = randomUUID();
    assert.equal(
      (await send(c, { "x-source-session": "https://atrium.invalid/?session=sess-1" })).status,
      202,
    );
    assert.equal(
      (await send(c, { "x-source-session": "https://atrium.invalid/?session=sess-1" })).status,
      202,
    );
    assert.equal(
      (await send(c, { "x-source-session": "https://atrium.invalid/?session=sess-2" })).json.code,
      "delivery-id-conflict",
    );
    // a call's id and the call's caller (record id + seat url) are the same actor model
    const callId = randomUUID();
    await call(
      atrium,
      callBody({
        call_id: callId,
        argv: [
          "sessions",
          "new",
          "--record-id",
          RECORD,
          "--created-by-call",
          callId,
          "--prompt",
          "x",
        ],
        caller: { session_url: "x", record_id: RECORD, seat_url: seatUrl("seat-9") },
      }),
    );
    const successor = await call(
      atrium,
      callBody({
        call_id: callId,
        argv: [
          "sessions",
          "new",
          "--record-id",
          RECORD,
          "--created-by-call",
          callId,
          "--prompt",
          "x",
        ],
        caller: { session_url: "x", record_id: OTHER_RECORD, seat_url: seatUrl("seat-9") },
      }),
    );
    assert.equal(successor.status, 200, "a successor on the same seat is not a stranger");
  });
});

test("K-R2-2: with `stateHome` a target resolves against THAT store (acpx's own resolver, in a child), and only that one", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pod-kit-state-"));
  const known = "cccccccc-0000-4000-8000-000000000b01";
  await addRecord(home, known, "acp-known");
  const before = fs.readdirSync(path.join(home, ".acpx", "sessions")).toSorted();
  await withAtrium({ stateHome: home }, async (atrium) => {
    const about = (id: string, as = OTHER_RECORD) =>
      call(
        atrium,
        callBody({
          argv: ["sessions", "set-metadata", "--session-id", id, "--key", "k"],
          caller: { session_url: "x", record_id: as },
        }),
      );
    assert.equal((await about(known)).status, 200, "a session in the given store resolves");
    assert.deepEqual((await about("not-in-the-store")).json, {
      error: "class-not-passable",
      reason: "target-unresolved",
    });
    assert.equal(
      (await about(known, known)).json.reason,
      "own-session",
      "the caller's own session is still refused",
    );
  });
  assert.ok(
    before.every((name) => fs.existsSync(path.join(home, ".acpx", "sessions", name))),
    "the given store was read (acpx's resolver writes only its own index and lock files there)",
  );
  fs.rmSync(home, { recursive: true });
});

test("K-R2-7: --format json: the create-replay-mismatch is a JSON-RPC error on STDOUT, stderr empty", async () => {
  await withAtrium({}, async (atrium) => {
    const callId = randomUUID();
    const argv = (message: string, format: string[] = []) => [
      ...format,
      "sessions",
      "new",
      "--record-id",
      RECORD,
      "--created-by-call",
      callId,
      "--prompt",
      message,
    ];
    await call(atrium, callBody({ call_id: callId, argv: argv("first") }));
    const text = await call(atrium, callBody({ call_id: callId, argv: argv("second") }));
    assert.equal(text.json.exit, 2);
    assert.match(String(text.json.stderr), /^CREATE_REPLAY_MISMATCH: /);
    assert.equal(text.json.stdout, "");
    const json = await call(
      atrium,
      callBody({ call_id: callId, argv: argv("second", ["--format", "json"]) }),
    );
    assert.equal(json.json.stderr, "");
    const rpc = JSON.parse(String(json.json.stdout)) as {
      error: { code: number; data: { detailCode: string } };
    };
    assert.equal(rpc.error.code, -32602);
    assert.equal(rpc.error.data.detailCode, "CREATE_REPLAY_MISMATCH");
  });
});

test("K-R2-7: a fork notice / template prompt in acpx's answer is queued — `delivery` names the message, else the notice; both ids are conflict-checked", async () => {
  await withAtrium({ forkNotice: "copied from X" }, async (atrium) => {
    const callId = randomUUID();
    const argv = ["sessions", "copy", "--record-id", RECORD, "--created-by-call", callId];
    const first = await call(atrium, callBody({ call_id: callId, argv }));
    const noticeId = String(first.json.delivery.delivery_id);
    assert.notEqual(
      noticeId,
      callId,
      "a notice-only copy: delivery names the NOTICE (uuid5(call_id, 'fork-notice'))",
    );
    assert.match(noticeId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const replay = await call(atrium, callBody({ call_id: callId, argv }));
    assert.deepEqual(replay.json.delivery, {
      delivery_id: noticeId,
      to: RECORD,
      status: "queued",
      replay: true,
    });
    // another sender's call whose NOTICE id is recorded for someone else: refused, though its call id is fresh? the
    // derivation is from the call id, so the same call id from another caller hits the notice id
    const stolen = await call(
      atrium,
      callBody({ call_id: callId, argv, caller: { session_url: "x", record_id: OTHER_RECORD } }),
    );
    assert.deepEqual([stolen.status, stolen.json.error], [409, "delivery-id-conflict"]);
    assert.equal(stolen.json.delivery_id, noticeId);
  });
  await withAtrium({ templatePrompt: "the template's own prompt" }, async (atrium) => {
    const callId = randomUUID();
    const answer = await call(
      atrium,
      callBody({
        call_id: callId,
        argv: ["sessions", "copy", "--record-id", RECORD, "--created-by-call", callId],
      }),
    );
    assert.equal(
      answer.json.delivery.delivery_id,
      callId,
      "the template prompt is the message (id = call_id)",
    );
    // a caller's own message replaces the template's
    const second = randomUUID();
    await call(
      atrium,
      callBody({
        call_id: second,
        argv: [
          "sessions",
          "copy",
          "--record-id",
          THIRD_RECORD,
          "--created-by-call",
          second,
          "--prompt",
          "mine",
        ],
      }),
    );
    const replayMismatch = await call(
      atrium,
      callBody({
        call_id: second,
        argv: [
          "sessions",
          "copy",
          "--record-id",
          THIRD_RECORD,
          "--created-by-call",
          second,
          "--prompt",
          "not mine",
        ],
      }),
    );
    assert.equal(replayMismatch.json.error, "create-replay-mismatch");
  });
});

test("K-R2-7: message content and task_options are validated as the real route does", async () => {
  await withAtrium({}, async (atrium) => {
    const to = "/api/sessions/s/message";
    const codes = async (body: Record<string, unknown>) => {
      const answer = await post(atrium, to, body);
      return [answer.status, answer.json.code ?? answer.json.error] as const;
    };
    assert.deepEqual(await codes({ content: [] }), [400, "bad-content"]);
    assert.deepEqual(await codes({ content: "x" }), [400, "bad-content"]);
    assert.deepEqual(await codes({ content: [{ type: "video" }] }), [400, "bad-content"]);
    assert.deepEqual(await codes({ content: [{ type: "text", text: 5 }] }), [400, "bad-content"]);
    assert.deepEqual(await codes({ content: [{ type: "image" }] }), [400, "bad-content"]);
    assert.deepEqual(await codes({ text: "a", task_options: [] }), [400, "bad-task-options"]);
    assert.deepEqual(await codes({ text: "a", task_options: { big: "x".repeat(17_000) } }), [
      400,
      "task-options-too-large",
    ]);
    assert.equal((await post(atrium, to, { text: "a", task_options: { a: 1 } })).status, 202);
    assert.equal(
      (
        await post(atrium, to, {
          content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
        })
      ).status,
      202,
    );
    assert.equal(
      (await post(atrium, to, { content: [{ type: "resource_link", uri: "x" }], text: "t" }))
        .status,
      202,
    );
  });
});

test("K-R2-7: the recipient's state — seat 404 / 409 vacant, session 404 / archived / template / closing / closed (reopen:true passes) — and the id ownership", async () => {
  await withAtrium(
    {
      messages: {
        recipients: {
          ghost: "unknown",
          "holder-1": "not-a-seat",
          "seat-vac": "vacant",
          arch: "archived",
          tmpl: "template",
          closing: "closing",
          closed: "closed",
        },
      },
    },
    async (atrium) => {
      const seat = (id: string) => post(atrium, `/api/seats/${id}/message`, { text: "a" });
      const session = (id: string, extra: Record<string, unknown> = {}, who?: string) =>
        post(
          atrium,
          `/api/sessions/${id}/message`,
          { text: "a", ...extra },
          {
            "content-type": "application/json",
            ...(who === undefined
              ? {}
              : { "x-source-session": `https://atrium.invalid/?session=${who}` }),
          },
        );
      assert.deepEqual(
        [(await seat("ghost")).status, (await seat("ghost")).json.code],
        [404, "not-a-seat"],
      );
      assert.equal(
        (await seat("holder-1")).json.error,
        "holder-1 is not a seat id known to this box",
      );
      const vacant = await seat("seat-vac");
      assert.deepEqual(
        [vacant.status, vacant.json.code, vacant.json.seatId],
        [409, "SEAT_VACANT", "seat-vac"],
      );
      const unknown = await session("ghost");
      assert.deepEqual(
        [unknown.status, unknown.json],
        [404, { error: "no session or seat with this id" }],
      );
      const archived = await session("arch");
      assert.deepEqual(
        [archived.status, archived.json.code, archived.json.archived],
        [409, "SESSION_ARCHIVED", true],
      );
      assert.equal((await session("tmpl")).json.code, "template-session-read-only");
      assert.equal((await session("closing")).json.code, "SESSION_CLOSING");
      const closed = await session("closed");
      assert.deepEqual(
        [closed.status, closed.json.code, closed.json.closed],
        [409, "SESSION_CLOSED", true],
      );
      assert.equal(
        (await session("closed", { reopen: true })).status,
        202,
        "reopen:true delivers anyway",
      );
      // R4: a caller-chosen delivery id belongs to its first sender
      const id = randomUUID();
      assert.equal((await session("fine", { delivery_id: id }, "alice")).status, 202);
      assert.equal(
        (await session("fine", { delivery_id: id }, "alice")).status,
        202,
        "its own re-send",
      );
      const conflict = await session("fine", { delivery_id: id }, "bob");
      assert.deepEqual(
        [conflict.status, conflict.json.code, conflict.json.delivery_id],
        [409, "delivery-id-conflict", id],
      );
      assert.match(String(conflict.json.error), /already belongs to a message of another sender/);
    },
  );
});

test("K-R2-7: heldSentence names the paused / held-by-policy reasons and the recipient's NAME", async () => {
  await withAtrium(
    {
      messages: {
        names: { "seat-1": "Atlas" },
        answers: [
          { held: { reason: "paused" } },
          { held: { reason: "held-by-policy" } },
          { held: { reason: "pod_starting" } },
        ],
      },
    },
    async (atrium) => {
      const paused = await post(atrium, "/api/seats/seat-1/message", { text: "a" });
      assert.match(
        String(paused.json.message),
        /^Held \(delivery [0-9a-f-]{36}\): a person paused Atlas's queue;/,
      );
      const policy = await post(atrium, "/api/seats/seat-1/message", { text: "a" });
      assert.match(String(policy.json.message), /Atlas is being held deliberately/);
      const starting = await post(atrium, "/api/seats/seat-1/message", { text: "a" });
      assert.match(
        String(starting.json.message),
        /^Starting \(delivery .*\): Atlas's agent is starting;/,
      );
    },
  );
});

test("K-R2-6 / K-R3-3: with the class table UNLOADED (a bare process) every call is refused `table-unavailable`, creates included — as the real door does", async () => {
  const source = fileURLToPath(new URL("../../test/pod-kit/recorded-atrium.ts", import.meta.url));
  const child = spawn(process.execPath, [source, "--port", "0", "--script", "{}"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const hello = await new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.includes("\n")) {
          resolve(text.slice(0, text.indexOf("\n")));
        }
      });
      child.once("exit", () => reject(new Error("exited early")));
    });
    const base = `http://127.0.0.1:${String((JSON.parse(hello) as { port: number }).port)}`;
    const callWith = async (argv: string[]) => {
      const response = await fetch(`${base}/api/acpx/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(callBody({ argv })),
      });
      return [response.status, (await response.json()) as Record<string, unknown>] as const;
    };
    const unavailable = [400, { error: "class-not-passable", reason: "table-unavailable" }];
    for (const argv of [
      ["sessions", "new", "--record-id", RECORD],
      ["sessions", "prune", "--dry-run"],
      ["prompt", "hi"],
      ["--format", "json", "sessions", "new", "--name", "x"],
    ]) {
      assert.deepEqual(await callWith(argv), unavailable, argv.join(" "));
    }
    // the shape refusals still come first, as in the real parser
    const noCallId = await fetch(`${base}/api/acpx/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...callBody(), call_id: "x" }),
    });
    assert.equal(((await noCallId.json()) as { error: string }).error, "bad-call-id");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

test('away is the forwarder\'s answer exactly: 503, Retry-After 5, Connection: close, {"error":"atrium-away"} — on every route', async () => {
  await withAtrium({ phases: [{ mode: "away" }] }, async (atrium) => {
    for (const [path, body] of [
      ["/api/acpx/call", callBody()],
      ["/api/sessions/s/message", { text: "a" }],
      ["/api/seats/t/message", { text: "a" }],
      [`/api/agent-pods/${KEY}/ready`, readyHint],
      [`/api/agent-pods/${KEY}/ended`, { pod: { uid: "u" }, reason: "idle" }],
    ] as const) {
      const answer = await post(atrium, path, body);
      assert.equal(answer.status, 503, path);
      assert.equal(answer.headers.get("retry-after"), "5");
      assert.equal(answer.headers.get("connection"), "close");
      assert.equal(answer.text, '{"error":"atrium-away"}');
    }
    assert.ok(atrium.requests.every((entry) => entry.outcome === "away" && entry.mode === "away"));
    const awayCall = atrium.requestsFor("call")[0];
    assert.equal(
      awayCall?.callId,
      awayCall?.body?.call_id,
      "an away call is recorded with the call id the client sent",
    );
    assert.equal(awayCall?.ranArgv, null);
  });
});

test("away for the first N requests, then back — counted in requests, no clock involved", async () => {
  await withAtrium(
    { phases: [{ mode: "away", forRequests: 3 }, { mode: "normal" }] },
    async (atrium) => {
      const statuses: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        statuses.push((await post(atrium, "/api/seats/t/message", { text: "a" })).status);
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
      assert.equal((await post(atrium, "/api/seats/t/message", { text: "a" })).status, 503);
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.equal((await post(atrium, "/api/seats/t/message", { text: "a" })).status, 202);
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
      (await post(atrium, "/api/seats/t/message", { text: "a" })).status,
      202,
      "keep-alive connection is open",
    );
    atrium.setMode("refused", 400);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(
        post(atrium, "/api/seats/t/message", { text: "a" }),
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
      (await post(atrium, "/api/seats/t/message", { text: "a" })).status,
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
        headers: { "content-type": "application/json" },
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
  const script = JSON.stringify({ messages: { default: "queued" } });
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
    const callStatus = async (): Promise<number> => {
      const response = await fetch(`${base}/api/seats/t/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      return response.status;
    };
    assert.equal(await callStatus(), 202);
    await fetch(`${base}/_kit/mode`, { method: "POST", body: JSON.stringify({ mode: "away" }) });
    assert.equal(await callStatus(), 503);
    await fetch(`${base}/_kit/mode`, { method: "POST", body: JSON.stringify({ mode: "normal" }) });
    assert.equal(await callStatus(), 202);
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
