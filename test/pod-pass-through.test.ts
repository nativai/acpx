import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { COMMAND_TABLE } from "../src/pod/command-classes.js";
import { COMMAND_GRAMMAR } from "../src/pod/command-grammar.js";
import {
  ABSOLUTIZED_PATH_FLAGS,
  buildPassThroughCall,
  MAX_STDIN_BYTES,
  NO_RECORD_ID_CREATE_PATHS,
  PassThroughUsageError,
  RECORD_ID_CREATE_PATHS,
  STDIN_FILE_FLAGS,
  type PassThroughInput,
} from "../src/pod/pass-through-branch.js";
import {
  agentPodEnv,
  agentPodHome,
  OTHER_SESSION,
  POD_SESSION,
  runCli,
  snapshot,
  tmpDir,
} from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";
import type { AtriumScript, RecordedAtrium } from "./pod-kit/recorded-atrium.js";

// brick 7eb9686f — A3's pass-through client (C6.1, C6.2, C7.2; A-8, A-9). The real CLI runs in an AGENT
// POD (the product's own test seam) against lane X1's recorded atrium. Every guarantee has a negative
// row: an input right in every respect but the one the clause protects.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

async function withAtrium(script: AtriumScript, run: (atrium: RecordedAtrium) => Promise<void>) {
  const atrium = await startRecordedAtrium(script);
  try {
    await run(atrium);
  } finally {
    await atrium.close();
  }
}

/** Compress the call-home budget: honoured only under NODE_TEST_CONTEXT (held by pod-call-home.test.ts). */
const FAST = {
  ACPX_CALL_HOME_BUDGET_MS: "1500",
  ACPX_CALL_HOME_RETRY_MS: "100",
  ACPX_CALL_HOME_ANSWER_TIMEOUT_MS: "1500",
};

function callsOf(atrium: RecordedAtrium) {
  return atrium.requests.filter((r) => r.route === "call");
}

// ─── the request: what a passed-through command carries ──────────────────────────────────────────

test("a create in an agent pod passes through: argv, stdin bytes, --record-id, caller, inherit, deadline — and NO cwd (A-9)", async () => {
  const { home } = agentPodHome();
  const work = tmpDir("acpx-a3-work-");
  const brief = path.join(work, "brief.md");
  fs.writeFileSync(brief, "the brief\n");
  await withAtrium(
    { calls: [{ answer: { exit: 0, stdout: '{"id":"x"}\n', stderr: "note\n" } }] },
    async (atrium) => {
      const r = await runCli(
        ["sessions", "new", "--name", "child", "--prompt-file", "brief.md"],
        agentPodEnv(home, atrium.url, {
          ACPX_SUBSCRIPTION: "sub7",
          ATRIUM_OS: "/os/x",
          ACPX_NOT_ON_THE_LIST: "must-not-travel",
          PORT: "3456",
          ACPX_PARENT_SESSION_URL: "https://atrium.example/?session=parent-1",
        }),
        { cwd: work },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '{"id":"x"}\n', "the pod prints the server's stdout verbatim");
      assert.equal(r.stderr, "note\n", "and its stderr");
      const [call] = callsOf(atrium);
      assert.ok(call?.body, "one call reached the pass-through route");
      const body = call.body;
      assert.equal(body.contract, 1);
      assert.match(String(body.call_id), UUID);
      // A-9: the pass-through carries no cwd, whatever directory the caller stands in.
      assert.equal("cwd" in body, false, "no cwd key");
      const argv = body.argv as string[];
      assert.deepEqual(argv.slice(0, 6), [
        "sessions",
        "new",
        "--name",
        "child",
        "--prompt-file",
        "-",
      ]);
      assert.equal(argv[6], "--record-id");
      assert.match(argv[7] ?? "", UUID, "a record id the client chose (C6.2 at most once)");
      assert.equal(
        argv.includes("brief.md"),
        false,
        "the file argument travelled as bytes, not a path",
      );
      assert.equal(call.stdin, "the brief\n", "stdin_b64 holds the file's content");
      assert.deepEqual(body.inherit, { ACPX_SUBSCRIPTION: "sub7", ATRIUM_OS: "/os/x" });
      assert.deepEqual(body.caller, {
        session_url: `https://atrium.example/?session=${POD_SESSION}`,
        seat_url: "https://atrium.example/?seat=11111111-1111-4111-8111-111111111111",
        record_id: POD_SESSION,
        parent_session_url: "https://atrium.example/?session=parent-1",
      });
      assert.equal(body.admission_class, "spawn");
      assert.equal(body.deadline_ms, 60_000);
      assert.equal(
        JSON.stringify(body).includes("must-not-travel"),
        false,
        "nothing else of the caller's environment travels",
      );
      assert.equal(JSON.stringify(body).includes("3456"), false);
    },
  );
});

test("the caller's own --record-id is kept, not replaced; a control-store command and a record command about ANOTHER session pass through", async () => {
  const { home } = agentPodHome();
  await withAtrium({}, async (atrium) => {
    const env = agentPodEnv(home, atrium.url);
    const mine = "dddddddd-0000-4000-8000-0000000000d1";
    assert.equal((await runCli(["sessions", "new", "--record-id", mine], env)).status, 0);
    assert.equal(
      (await runCli(["seats", "rename", "11111111-1111-4111-8111-111111111111", "x"], env)).status,
      0,
    );
    assert.equal(
      (await runCli(["sessions", "set-metadata", "--session-id", OTHER_SESSION, "--key", "k"], env))
        .status,
      0,
    );
    const argvs = callsOf(atrium).map((c) => c.body?.argv as string[]);
    assert.equal(argvs.length, 3);
    assert.deepEqual(argvs[0]?.filter((a) => a === "--record-id").length, 1, "not added twice");
    assert.equal(argvs[0]?.[argvs[0].indexOf("--record-id") + 1], mine);
    assert.equal(argvs[1]?.[0], "seats", "control-store: no record id minted");
    assert.equal(argvs[1]?.includes("--record-id"), false);
    assert.equal(argvs[2]?.[0], "sessions");
    assert.equal(argvs[2]?.includes("--record-id"), false);
    // Negative: the pod's OWN session is local (class record, own pod) — it does not pass through.
  });
});

test("a record command about the pod's OWN session does NOT pass through (the near-miss of the row above)", async () => {
  const { home } = agentPodHome();
  await withAtrium({}, async (atrium) => {
    // It runs locally and fails for lack of a record: the point is that atrium was never called.
    await runCli(
      ["sessions", "set-metadata", "--session-id", POD_SESSION, "--key", "k"],
      agentPodEnv(home, atrium.url),
    );
    assert.equal(callsOf(atrium).length, 0);
  });
});

// ─── no direct path: away, unknown, refusals ─────────────────────────────────────────────────────

test("A-8 atrium_away: a create with atrium away for the whole budget exits 75, retries, and writes NOTHING locally", async () => {
  const { home } = agentPodHome();
  const before = snapshot(home);
  await withAtrium({ phases: [{ mode: "away" }] }, async (atrium) => {
    const r = await runCli(
      ["sessions", "new", "--name", "child"],
      agentPodEnv(home, atrium.url, FAST),
    );
    assert.equal(r.status, 75, r.stderr);
    const [line1, line2] = r.stderr.trim().split("\n");
    assert.match(
      line1 ?? "",
      /^acpx: REFUSED reason=atrium_away nothing_started=true protocol=1 retry_after_s=60 waited_s=\d+$/u,
    );
    assert.ok(line2, "a second line carries the plain sentence");
    assert.equal(r.stdout, "");
    const calls = callsOf(atrium);
    assert.ok(calls.length >= 3, `it retried for the budget (${calls.length} attempts)`);
    assert.ok(
      calls.every((c) => c.outcome === "away"),
      "every attempt met the forwarder's 503",
    );
    assert.ok(r.ms >= 1400, `it waited the (compressed) budget, ${r.ms} ms`);
    // The SAME record id on every attempt: a lost answer would be found, not duplicated.
    const ids = new Set(calls.map((c) => JSON.stringify(c.body?.argv).slice(-60)));
    assert.equal(ids.size, 1);
  });
  assert.deepEqual(snapshot(home), before, "no local fallback create: the state home is unchanged");
});

test("the same failure with the connection REFUSED (no forwarder answering at all) is atrium_away too", async () => {
  const { home } = agentPodHome();
  const atrium = await startRecordedAtrium({});
  const url = atrium.url;
  await atrium.close();
  const r = await runCli(["sessions", "new", "--name", "child"], agentPodEnv(home, url, FAST));
  assert.equal(r.status, 75, r.stderr);
  assert.match(r.stderr, /^acpx: REFUSED reason=atrium_away nothing_started=true/u);
});

test("away for a short window, then back: the SAME command completes (the retry), one call accepted", async () => {
  const { home } = agentPodHome();
  await withAtrium(
    { phases: [{ mode: "away", forRequests: 3 }, { mode: "normal" }] },
    async (atrium) => {
      const r = await runCli(
        ["seats", "rename", "11111111-1111-4111-8111-111111111111", "x"],
        agentPodEnv(home, atrium.url, { ...FAST, ACPX_CALL_HOME_BUDGET_MS: "20000" }),
      );
      assert.equal(r.status, 0, r.stderr);
      const calls = callsOf(atrium);
      assert.equal(calls.length, 4);
      assert.deepEqual(
        calls.map((c) => c.outcome),
        ["away", "away", "away", "answered"],
      );
    },
  );
});

test("A-8 CALL_HOME outcome=unknown: a sent call whose answer never comes is exit 1, ONE request, never re-sent (deadline)", async () => {
  const { home } = agentPodHome();
  await withAtrium({ phases: [{ mode: "hang" }] }, async (atrium) => {
    const r = await runCli(
      ["sessions", "new", "--name", "child"],
      agentPodEnv(home, atrium.url, {
        ...FAST,
        ACPX_CALL_HOME_ANSWER_TIMEOUT_MS: "700",
        ACPX_CALL_HOME_BUDGET_MS: "20000",
      }),
    );
    assert.equal(r.status, 1, r.stderr);
    const calls = callsOf(atrium);
    assert.equal(calls.length, 1, "at most once: the unanswered request is not sent again");
    const line1 = r.stderr.trim().split("\n")[0] ?? "";
    assert.equal(
      line1,
      `acpx: CALL_HOME outcome=unknown reason=deadline call_id=${String(calls[0]?.callId)}`,
    );
    assert.match(
      r.stderr,
      /--record-id [0-9a-f-]{36} --created-by-call [0-9a-f-]{36}/u,
      "the printed retry carries both ids",
    );
  });
});

test("CALL_HOME outcome=unknown reason=connection: the connection broke after the request was sent — one request", async () => {
  const { home } = agentPodHome();
  await withAtrium({ calls: [{ answer: { exit: 0 }, loseAnswer: true }] }, async (atrium) => {
    const r = await runCli(
      ["sessions", "new", "--name", "child"],
      agentPodEnv(home, atrium.url, { ...FAST, ACPX_CALL_HOME_BUDGET_MS: "20000" }),
    );
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^acpx: CALL_HOME outcome=unknown reason=connection call_id=/u);
    assert.equal(callsOf(atrium).length, 1);
  });
});

test("a 403 is FINAL — exit 2, ONE request, no retry; a 400 class-not-passable is refused the same way", async () => {
  const { home } = agentPodHome();
  for (const [status, error] of [
    [403, "caller-mismatch"],
    [400, "class-not-passable"],
  ] as const) {
    await withAtrium({ calls: [{ answer: { status, body: { error } } }] }, async (atrium) => {
      const r = await runCli(
        ["sessions", "new", "--name", "child"],
        agentPodEnv(home, atrium.url, { ...FAST, ACPX_CALL_HOME_BUDGET_MS: "20000" }),
      );
      assert.equal(r.status, 2, r.stderr);
      assert.match(
        r.stderr.split("\n")[0] ?? "",
        new RegExp(
          `^acpx: REFUSED reason=pass_through_refused nothing_started=true protocol=1 status=${status} error=${error}`,
          "u",
        ),
      );
      assert.equal(callsOf(atrium).length, 1, `status ${status} was not retried`);
    });
  }
});

test("--format json: the refusal is one JSON object on stdout with error.data.reason (and --json-strict keeps stderr empty)", async () => {
  const { home } = agentPodHome();
  await withAtrium({ phases: [{ mode: "away" }] }, async (atrium) => {
    const env = agentPodEnv(home, atrium.url, FAST);
    const json = await runCli(["--format", "json", "sessions", "new", "--name", "c"], env);
    assert.equal(json.status, 75);
    const parsed = JSON.parse(json.stdout.trim()) as { error: { data: Record<string, unknown> } };
    assert.equal(parsed.error.data.reason, "atrium_away");
    assert.equal(parsed.error.data.nothing_started, true);
    const strict = await runCli(
      ["--json-strict", "--format", "json", "sessions", "new", "--name", "c"],
      env,
    );
    assert.equal(strict.status, 75);
    assert.equal(strict.stderr, "", "json-strict: machine-clean stderr");
    assert.equal(
      (JSON.parse(strict.stdout.trim()) as { error: { data: Record<string, unknown> } }).error.data
        .reason,
      "atrium_away",
    );
  });
});

// ─── a routed command is never routed twice (A-8) ────────────────────────────────────────────────

test("A-8 routed_twice: ACPX_ROUTED=1 and a command that would pass through — refused, exit 2, atrium never called", async () => {
  const { home } = agentPodHome();
  await withAtrium({}, async (atrium) => {
    const r = await runCli(
      ["sessions", "new", "--name", "c"],
      agentPodEnv(home, atrium.url, { ACPX_ROUTED: "1" }),
    );
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stderr.split("\n")[0], "acpx: REFUSED reason=routed_twice");
    assert.equal(atrium.requests.length, 0, "not one request");
    // The near-miss: the same command without the marker DOES pass through.
    const again = await runCli(["sessions", "new", "--name", "c"], agentPodEnv(home, atrium.url));
    assert.equal(again.status, 0, again.stderr);
    assert.equal(callsOf(atrium).length, 1);
  });
});

// ─── the builder: its limits and rewrites ────────────────────────────────────────────────────────

function input(argv: string[], over: Partial<PassThroughInput> = {}): PassThroughInput {
  let n = 0;
  return {
    argv,
    commandPath: "sessions new",
    commandClass: "create",
    env: {},
    cwd: "/workspace/projects/x",
    readFile: (file) => Buffer.from(`file:${file}`),
    readStdin: () => Buffer.from("from-stdin"),
    mintId: () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, "0")}`,
    ...over,
  };
}

test("a prompt file is read in the CALLER's pod relative to its cwd, and becomes '-' + stdin_b64", () => {
  const call = buildPassThroughCall(input(["sessions", "new", "--prompt-file", "b.md"]));
  assert.deepEqual(call.body.argv, [
    "sessions",
    "new",
    "--prompt-file",
    "-",
    "--record-id",
    "00000000-0000-4000-8000-000000000001",
    "--created-by-call",
    "00000000-0000-4000-8000-000000000002",
  ]);
  assert.equal(
    call.body.call_id,
    "00000000-0000-4000-8000-000000000002",
    "the request's call_id IS the created-by call (F-1)",
  );
  assert.equal(
    Buffer.from(call.body.stdin_b64 as string, "base64").toString(),
    "file:/workspace/projects/x/b.md",
  );
  const inline = buildPassThroughCall(input(["sessions", "new", "--prompt-file=b.md"]));
  assert.deepEqual((inline.body.argv as string[]).slice(0, 3), [
    "sessions",
    "new",
    "--prompt-file=-",
  ]);
  const fromStdin = buildPassThroughCall(input(["sessions", "new", "--prompt-file", "-"]));
  assert.equal(
    Buffer.from(fromStdin.body.stdin_b64 as string, "base64").toString(),
    "from-stdin",
    "'-' already means the caller's stdin",
  );
});

test("the 8 MiB limit: exactly at it passes, one byte over is refused before anything is sent", () => {
  const atLimit = buildPassThroughCall(
    input(["sessions", "new", "--prompt-file", "-"], {
      readStdin: () => Buffer.alloc(MAX_STDIN_BYTES, 97),
    }),
  );
  assert.ok(atLimit.body.stdin_b64);
  assert.throws(
    () =>
      buildPassThroughCall(
        input(["sessions", "new", "--prompt-file", "-"], {
          readStdin: () => Buffer.alloc(MAX_STDIN_BYTES + 1, 97),
        }),
      ),
    PassThroughUsageError,
  );
});

test("an unreadable file is a refusal before the send; two stdin files cannot both travel", () => {
  assert.throws(
    () =>
      buildPassThroughCall(
        input(["sessions", "new", "--prompt-file", "gone.md"], {
          readFile: () => {
            throw new Error("ENOENT");
          },
        }),
      ),
    /could not read gone\.md/u,
  );
  assert.throws(
    () =>
      buildPassThroughCall(input(["sessions", "new", "--prompt-file", "a", "--prompt-file", "b"])),
    /only one can travel/u,
  );
});

test("--brief (handover) stays a PATH the successor reads: made absolute against the caller's cwd, never bytes", () => {
  const call = buildPassThroughCall(
    input(["sessions", "handover", "--brief", "notes/b.md"], {
      commandPath: "sessions handover",
    }),
  );
  assert.deepEqual(call.body.argv, [
    "sessions",
    "handover",
    "--brief",
    "/workspace/projects/x/notes/b.md",
  ]);
  assert.equal("stdin_b64" in call.body, false);
  assert.equal(call.recordId, undefined, "handover has no --record-id (reported)");
});

test("--brief outside /wisdom and /workspace is refused as brief_not_shared — a pod-local path is a dead pointer", async () => {
  for (const brief of [
    "/tmp/b.md",
    "/home/node/b.md",
    "/workspace/../tmp/b.md",
    "/workspacex/b.md",
  ]) {
    assert.throws(
      () =>
        buildPassThroughCall(
          input(["sessions", "handover", "--brief", brief], { commandPath: "sessions handover" }),
        ),
      (error: unknown) =>
        error instanceof PassThroughUsageError && error.reason === "brief_not_shared",
      brief,
    );
  }
  // Near-miss: under /wisdom is accepted too.
  const ok = buildPassThroughCall(
    input(["sessions", "handover", "--brief", "/wisdom/Bricks/x/b.md"], {
      commandPath: "sessions handover",
    }),
  );
  assert.deepEqual(ok.body.argv, ["sessions", "handover", "--brief", "/wisdom/Bricks/x/b.md"]);
  // End to end: the named line, exit 2, atrium never called.
  const { home } = agentPodHome();
  await withAtrium({}, async (atrium) => {
    const r = await runCli(
      ["sessions", "handover", "--brief", "/tmp/b.md"],
      agentPodEnv(home, atrium.url),
    );
    assert.equal(r.status, 2, r.stderr);
    assert.equal(
      r.stderr.split("\n")[0],
      "acpx: REFUSED reason=brief_not_shared nothing_started=true protocol=1",
    );
    assert.equal(atrium.requests.length, 0);
  });
});

test("--record-id goes BEFORE a `--` terminator, and only creates that take one get it", () => {
  const call = buildPassThroughCall(input(["sessions", "new", "--", "--weird"]));
  assert.deepEqual(call.body.argv, [
    "sessions",
    "new",
    "--record-id",
    "00000000-0000-4000-8000-000000000001",
    "--created-by-call",
    "00000000-0000-4000-8000-000000000002",
    "--",
    "--weird",
  ]);
  const store = buildPassThroughCall(
    input(["seats", "rename", "s", "n"], {
      commandPath: "seats rename",
      commandClass: "control-store",
    }),
  );
  assert.equal(store.recordId, undefined);
  assert.deepEqual(store.body.argv, ["seats", "rename", "s", "n"]);
});

test("a caller with no identity sends no fabricated fields; the record id falls back to the session URL", () => {
  const none = buildPassThroughCall(
    input(["seats", "rename", "s", "n"], { commandClass: "control-store" }),
  );
  assert.deepEqual(none.body.caller, {});
  const fromUrl = buildPassThroughCall(
    input(["seats", "rename", "s", "n"], {
      commandClass: "control-store",
      env: { ACPX_SESSION_URL: "https://a/?session=s-1" },
    }),
  );
  assert.deepEqual(fromUrl.body.caller, {
    session_url: "https://a/?session=s-1",
    record_id: "s-1",
  });
});

// ─── discovering checks: a NEW command is sorted, never silently missed ──────────────────────────

test("every create path is sorted into 'takes --record-id' or 'has none' — and the first list's paths really take it", () => {
  const creates = Object.entries(COMMAND_TABLE)
    .filter(([, e]) => e.class === "create")
    .map(([p]) => p);
  assert.ok(creates.length >= 4, "the table has creates");
  const sorted = new Set([...RECORD_ID_CREATE_PATHS, ...NO_RECORD_ID_CREATE_PATHS]);
  assert.deepEqual(
    creates.filter((p) => !sorted.has(p)),
    [],
    "a create path nobody sorted: say whether it takes --record-id (pass-through-branch.ts)",
  );
  for (const p of RECORD_ID_CREATE_PATHS) {
    assert.ok(
      COMMAND_GRAMMAR[p]?.valueFlags.includes("--record-id"),
      `${p} is listed as taking --record-id but its grammar has none`,
    );
  }
  for (const p of NO_RECORD_ID_CREATE_PATHS) {
    assert.equal(
      COMMAND_GRAMMAR[p]?.valueFlags.includes("--record-id"),
      false,
      `${p} takes --record-id now: move it to RECORD_ID_CREATE_PATHS`,
    );
  }
});

test("the file-valued flags the client rewrites are flags the grammar really has", () => {
  const all = new Set(Object.values(COMMAND_GRAMMAR).flatMap((n) => n.valueFlags));
  for (const flag of [...STDIN_FILE_FLAGS, ...ABSOLUTIZED_PATH_FLAGS]) {
    assert.ok(all.has(flag), `${flag} is rewritten by the pass-through but no command has it`);
  }
});

/**
 * Value flags of a PASSED-THROUGH command (create, control-store, record, owner-if-pod) that name a
 * file or a path and are neither carried as bytes nor made absolute. They travel verbatim: valid when
 * the value is an absolute path the control pod can read, an error there otherwise. A NEW such flag
 * fails this test until someone decides — the list is the decision, not a place to hide one.
 */
const VERBATIM_PATH_FLAGS: Readonly<Record<string, string>> = {
  "--backup-dir": "sessions repair-account-seam: an operator's directory on the control pod",
  "--exclude-ids": "sessions archive: the scheduler's file on the control pod (control-pod only)",
  "--manifest-out": "sessions archive: control-pod only",
  "--to": "sessions archive: control-pod only",
  "--cat": "sessions archive: control-pod only",
  "--input-file": "flow run: local, never passed",
  "--output": "sessions export: class read, never passed",
  "--batch-file": "prompt: atrium's own delivery, refused by the message-route branch",
  "--filter-cwd": "sessions list: a filter value, not a file",
  "--sessions-dir": "agent-folders migrate: an operator's directory on the control pod",
  "--manifest": "transcripts dedup: an operator's manifest file on the control pod",
};

test("no passed-through command grows an UNDECIDED path-valued flag (discovering, over the grammar)", () => {
  const passable = new Set(["create", "control-store", "record", "owner-if-pod"]);
  const pathLike = /(file|path|dir|brief|output|manifest|^--to$|^--cat$)/u;
  const undecided: string[] = [];
  for (const [commandPath, node] of Object.entries(COMMAND_GRAMMAR)) {
    const entry = COMMAND_TABLE[commandPath];
    if (!entry || !passable.has(entry.class)) {
      continue;
    }
    for (const flag of node.valueFlags) {
      const decided =
        STDIN_FILE_FLAGS.includes(flag) ||
        ABSOLUTIZED_PATH_FLAGS.includes(flag) ||
        flag in VERBATIM_PATH_FLAGS;
      if (pathLike.test(flag) && !decided) {
        undecided.push(`${commandPath} ${flag}`);
      }
    }
  }
  assert.deepEqual(undecided, [], "decide how each travels (pass-through-branch.ts) and list it");
});
