import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  addRecord,
  agentPodEnv,
  agentPodHome,
  OTHER_SESSION,
  runCli,
  tmpDir,
} from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";
import type { AtriumScript, RecordedAtrium } from "./pod-kit/recorded-atrium.js";

// brick 7eb9686f — A3's message route: a prompt for ANOTHER session from an agent pod reaches atrium's
// message queue or fails after the call-home budget (C6.1, C7.2); atrium.json routes nothing; the
// owner-tree and "its agent is running" shortcuts never take a direct path. The real CLI, an agent
// pod (the product's test seam), lane X1's recorded atrium.

const OTHER_ACP = "dddddddd-5555-4666-8777-888888888888";

async function withAtrium(script: AtriumScript, run: (atrium: RecordedAtrium) => Promise<void>) {
  const atrium = await startRecordedAtrium(script);
  try {
    await run(atrium);
  } finally {
    await atrium.close();
  }
}

const FAST = {
  ACPX_CALL_HOME_BUDGET_MS: "1500",
  ACPX_CALL_HOME_RETRY_MS: "100",
  ACPX_ROUTED_PROMPT_ANSWER_TIMEOUT_MS: "600",
};

async function podWithOther() {
  const pod = agentPodHome();
  await addRecord(pod.home, OTHER_SESSION, OTHER_ACP);
  return pod;
}

const messages = (atrium: RecordedAtrium) =>
  atrium.requests.filter((r) => r.route === "session_message" || r.route === "seat_message");

/**
 * The token line of a refusal. A text-mode prompt prints its session banner first, as every prompt
 * does today (the wake gate's refusal also follows it); the machine token is the first `acpx:` line.
 */
function tokenLine(stderr: string): string {
  return stderr.split("\n").find((line) => line.startsWith("acpx: ")) ?? "";
}

/** Whatever a started bridge or owner leaves in the state home. */
function ownersStarted(home: string): string[] {
  const queues = path.join(home, ".acpx", "queues");
  return fs.existsSync(queues) ? fs.readdirSync(queues) : [];
}

test("a prompt for another session is POSTed to atrium's message route and prints [sent]; no owner starts here", async () => {
  const { home } = await podWithOther();
  await withAtrium({}, async (atrium) => {
    const r = await runCli(
      ["prompt", "--session-id", OTHER_SESSION, "--no-wait", "hello there"],
      agentPodEnv(home, atrium.url, FAST),
    );
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /\[sent\] delivery /u);
    const [m] = messages(atrium);
    assert.equal(m?.route, "session_message");
    assert.equal(m?.target, OTHER_SESSION);
    assert.equal(m?.body?.text, "hello there");
    assert.match(String(m?.body?.delivery_id), /^[0-9a-f-]{36}$/u);
    assert.deepEqual(
      ownersStarted(home),
      [],
      "no owner, no lease: nothing runs for another session in this pod",
    );
  });
});

test("wait mode (the default) is routed too — never the direct stream a running recipient would get", async () => {
  const { home } = await podWithOther();
  await withAtrium({}, async (atrium) => {
    const r = await runCli(
      ["prompt", "--session-id", OTHER_SESSION, "hello"],
      agentPodEnv(home, atrium.url, FAST),
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(messages(atrium).length, 1);
    // O-2: the reason is that the prompt CROSSES PODS — never "the recipient had no running agent".
    assert.match(
      r.stderr,
      /this prompt crosses pods, so it went to atrium's message queue and was not waited for/u,
    );
    assert.doesNotMatch(r.stderr, /had no running agent/u);
  });
});

test("NG-K5.5 (a): atrium refusing connections for the whole budget — exit 75 atrium_away, nothing queued, no owner", async () => {
  const { home } = await podWithOther();
  const atrium = await startRecordedAtrium({});
  const url = atrium.url;
  await atrium.close();
  const r = await runCli(
    ["prompt", "--session-id", OTHER_SESSION, "--no-wait", "hi"],
    agentPodEnv(home, url, FAST),
  );
  assert.equal(r.status, 75, r.stderr);
  assert.match(
    tokenLine(r.stderr),
    /^acpx: REFUSED reason=atrium_away nothing_started=true protocol=1 retry_after_s=60 waited_s=\d+$/u,
  );
  assert.deepEqual(ownersStarted(home), [], "no direct delivery, no local owner");
});

test("NG-K5.5 (b): a POST that gets no answer whose delivery atrium does not know — retried, then atrium_away; never direct", async () => {
  const { home } = await podWithOther();
  await withAtrium({ phases: [{ mode: "hang" }] }, async (atrium) => {
    const r = await runCli(
      ["prompt", "--session-id", OTHER_SESSION, "--no-wait", "hi"],
      agentPodEnv(home, atrium.url, FAST),
    );
    assert.equal(r.status, 75, r.stderr);
    assert.match(tokenLine(r.stderr), /^acpx: REFUSED reason=atrium_away/u);
    const posts = atrium.requests.filter(
      (q) => q.method === "POST" && q.route === "session_message",
    );
    assert.ok(posts.length >= 2, `it sent again (${posts.length} POSTs)`);
    assert.equal(
      new Set(posts.map((p) => p.body?.delivery_id)).size,
      1,
      "with the SAME delivery_id (idempotent)",
    );
    assert.deepEqual(ownersStarted(home), []);
  });
});

test("the 503 (away) window shorter than the budget: the SAME prompt is delivered by the retry, once", async () => {
  const { home } = await podWithOther();
  await withAtrium(
    { phases: [{ mode: "away", forRequests: 2 }, { mode: "normal" }] },
    async (atrium) => {
      const r = await runCli(
        ["prompt", "--session-id", OTHER_SESSION, "--no-wait", "hi"],
        agentPodEnv(home, atrium.url, { ...FAST, ACPX_CALL_HOME_BUDGET_MS: "20000" }),
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /\[sent\] delivery /u);
      assert.equal(
        atrium.requests.filter((q) => q.route === "session_message" && q.outcome === "answered")
          .length,
        1,
        "accepted once",
      );
    },
  );
});

test("a refusal from atrium (a 403) is FINAL for a prompt too — one request, a loud failure, no retry", async () => {
  const { home } = await podWithOther();
  await withAtrium(
    { messages: { default: { status: 403, body: { error: "caller-mismatch" } } } },
    async (atrium) => {
      const r = await runCli(
        ["prompt", "--session-id", OTHER_SESSION, "--no-wait", "hi"],
        agentPodEnv(home, atrium.url, { ...FAST, ACPX_CALL_HOME_BUDGET_MS: "20000" }),
      );
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /403/u);
      assert.equal(messages(atrium).length, 1);
    },
  );
});

test("atrium.json routes NOTHING in an agent pod: a planted one pointing at another atrium is never called", async () => {
  const { home } = await podWithOther();
  await withAtrium({}, async (real) => {
    await withAtrium({}, async (decoy) => {
      const acpx = path.join(home, ".acpx");
      fs.mkdirSync(acpx, { recursive: true });
      fs.writeFileSync(
        path.join(acpx, "atrium.json"),
        JSON.stringify({
          schema: 1,
          internalUrl: decoy.url,
          writer: "w",
          features: ["message-content", "message-delivery-id", "message-task-options"],
          writtenAt: new Date().toISOString(),
        }),
      );
      const r = await runCli(
        ["prompt", "--session-id", OTHER_SESSION, "--no-wait", "hi"],
        agentPodEnv(home, real.url, FAST),
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(messages(real).length, 1, "the origin ladder's atrium got it");
      assert.equal(decoy.requests.length, 0, "atrium.json's atrium got nothing");
    });
  });
});

test("--seat addresses the seat route; a person at the pod's shell (no agent identity) is routed too", async () => {
  const { home } = await podWithOther();
  const seat = "44444444-4444-4444-8444-444444444444";
  fs.writeFileSync(
    path.join(home, ".acpx", "sessions", "seats.json"),
    JSON.stringify({
      [seat]: {
        seat_id: seat,
        created_at: "2026-11-21T10:00:00.000Z",
        active_holder_id: OTHER_SESSION,
        next_ordinal: 2,
        closed_at: null,
      },
    }),
  );
  await withAtrium({}, async (atrium) => {
    const env = agentPodEnv(home, atrium.url, {
      ...FAST,
      ACPX_SESSION_URL: undefined,
      ACPX_SEAT_URL: undefined,
      ACPX_SESSION_RECORD_ID: undefined,
    });
    const r = await runCli(["prompt", "--seat", seat, "--no-wait", "hi"], env);
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
    const [m] = messages(atrium);
    assert.equal(m?.route, "seat_message");
    assert.equal(m?.target, seat);
    assert.equal(m?.headers["x-source-session"], "anonymous");
  });
});

test("A-8 routed_twice: ACPX_ROUTED=1 and a prompt for another session — refused, atrium never called", async () => {
  const { home } = await podWithOther();
  await withAtrium({}, async (atrium) => {
    const r = await runCli(
      ["prompt", "--session-id", OTHER_SESSION, "--no-wait", "hi"],
      agentPodEnv(home, atrium.url, { ...FAST, ACPX_ROUTED: "1" }),
    );
    assert.equal(r.status, 2, r.stderr);
    assert.equal(tokenLine(r.stderr), "acpx: REFUSED reason=routed_twice");
    assert.equal(atrium.requests.length, 0);
  });
});

test("atrium's own delivery options (--message-id, --batch-file) are not routable from another pod", async () => {
  const { home } = await podWithOther();
  await withAtrium({}, async (atrium) => {
    for (const extra of [["--message-id", "m1"], ["--message-id=m1"]]) {
      const r = await runCli(
        ["prompt", "--session-id", OTHER_SESSION, "--no-wait", ...extra, "hi"],
        agentPodEnv(home, atrium.url, FAST),
      );
      assert.equal(r.status, 2, r.stderr);
      assert.match(
        tokenLine(r.stderr),
        /^acpx: REFUSED reason=prompt_option_not_routable nothing_started=true protocol=1 option=--message-id$/u,
      );
    }
    assert.equal(atrium.requests.length, 0);
  });
});

test("readAtriumJson answers nothing in an agent pod — and answers in the control pod (the positive control)", () => {
  const routing = fileURLToPath(new URL("../src/cli/prompt-routing.js", import.meta.url));
  const probe = (home: string, podFile: boolean) => {
    const acpx = path.join(home, ".acpx");
    fs.mkdirSync(acpx, { recursive: true });
    fs.writeFileSync(
      path.join(acpx, "atrium.json"),
      JSON.stringify({
        schema: 1,
        internalUrl: "http://127.0.0.1:3456",
        writer: "w",
        features: ["message-content", "message-delivery-id", "message-task-options"],
        writtenAt: new Date().toISOString(),
      }),
    );
    if (podFile) {
      fs.writeFileSync(path.join(home, ".nv-agent"), "ag-0123456789abcdef01234567\n");
    }
    const code = `const m = await import(${JSON.stringify(routing)}); console.log(JSON.stringify(m.readAtriumJson() ?? null));`;
    return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: agentPodEnv(home, "http://127.0.0.1:1"),
      encoding: "utf8",
      timeout: 30_000,
    }).stdout.trim();
  };
  assert.equal(probe(tmpDir(), true), "null", "agent pod: atrium.json routes nothing");
  assert.match(
    probe(tmpDir(), false),
    /"internalUrl":"http:\/\/127\.0\.0\.1:3456"/u,
    "control pod: it is read",
  );
});

test("O-4: a prompt's call-home wait prints progress lines on stderr — and none under --json-strict", async () => {
  const { home } = await podWithOther();
  await withAtrium({ phases: [{ mode: "away" }] }, async (atrium) => {
    const env = agentPodEnv(home, atrium.url, {
      ...FAST,
      ACPX_CALL_HOME_PROGRESS_MS: "300",
    });
    const text = await runCli(["prompt", "--session-id", OTHER_SESSION, "--no-wait", "hi"], env);
    assert.equal(text.status, 75, text.stderr);
    assert.match(
      text.stderr,
      /^acpx: still waiting for atrium \(attempt \d+, \d+ s of the \d+ s call-home budget left\)/mu,
    );
    const strict = await runCli(
      [
        "--json-strict",
        "--format",
        "json",
        "prompt",
        "--session-id",
        OTHER_SESSION,
        "--no-wait",
        "hi",
      ],
      env,
    );
    assert.equal(strict.status, 75, strict.stderr);
    assert.doesNotMatch(strict.stderr, /still waiting/u);
  });
});
