import assert from "node:assert/strict";
import test from "node:test";
import type { AtriumExchange } from "../src/pod/atrium-exchange.js";
import {
  atriumAwayFailure,
  callHome,
  callHomeAnswerTimeoutMs,
  callHomeBudgetMs,
  callHomeUnknownFailure,
  CALL_HOME_BUDGET_MS,
  type CallHomeParams,
} from "../src/pod/call-home.js";

// brick 7eb9686f — C6.1's call-home budget and C7.2's two names (A-8). The loop is driven with an
// INJECTED CLOCK and SLEEPER, so 600 s costs nothing and the production constant is what is tested.

const away: AtriumExchange = { kind: "response", status: 503, body: { error: "atrium-away" } };
const refused: AtriumExchange = { kind: "connect-failure", reason: "ECONNREFUSED" };
const ok: AtriumExchange = { kind: "response", status: 200, body: { exit: 0 } };

/** A fake time: `sleep` advances it, and nothing else does. */
function fakeTime() {
  let t = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

function scripted(exchanges: AtriumExchange[]): {
  send: () => Promise<AtriumExchange>;
  sent: () => number;
} {
  let n = 0;
  return {
    send: async () => exchanges[Math.min(n++, exchanges.length - 1)],
    sent: () => n,
  };
}

function drive(exchanges: AtriumExchange[], extra: Partial<CallHomeParams> = {}) {
  const time = fakeTime();
  const script = scripted(exchanges);
  const promise = callHome({
    send: script.send,
    now: time.now,
    sleep: time.sleep,
    env: {},
    ...extra,
  });
  return { promise, time, script };
}

test("the budget is 600 s — the constant of C6.1, not a number a caller can pick", () => {
  assert.equal(CALL_HOME_BUDGET_MS, 600_000);
  assert.equal(callHomeBudgetMs({}), 600_000);
});

test("A-8 atrium_away: a 503 for the WHOLE budget ends 'away' after 600 s of waiting, nothing accepted", async () => {
  const { promise, time, script } = drive([away]);
  const outcome = await promise;
  assert.equal(outcome.kind, "away");
  assert.ok(outcome.kind === "away" && outcome.waitedMs >= 600_000, "it waited the whole budget");
  assert.ok(outcome.kind === "away" && outcome.waitedMs < 610_000, "and no longer");
  assert.ok(script.sent() > 100, `retried with back-off, not once (${script.sent()} attempts)`);
  assert.ok(Math.max(...time.slept) <= 5_000, "never sleeps past the back-off cap");
});

test("a failed CONNECTION and a 503 are treated alike (C6.1): mixed, they run the same budget", async () => {
  const { promise } = drive([refused, away, refused, away]);
  const outcome = await promise;
  assert.equal(outcome.kind, "away");
});

test("a 503's Retry-After is honoured as the pause, in place of the back-off", async () => {
  const { promise, time } = drive([{ ...away, retryAfterS: 5 } as AtriumExchange, ok]);
  await promise;
  assert.deepEqual(time.slept, [5_000]);
});

test("away, then atrium answers: the retry delivers (exit path of 'a control-pod restart')", async () => {
  const { promise, script } = drive([away, away, refused, ok]);
  const outcome = await promise;
  assert.equal(outcome.kind, "answered");
  assert.equal(script.sent(), 4);
});

test("a 403 is FINAL: answered at once, never retried (a refusal is a security signal)", async () => {
  const forbidden: AtriumExchange = {
    kind: "response",
    status: 403,
    body: { error: "caller-mismatch" },
  };
  const { promise, script } = drive([forbidden, ok]);
  const outcome = await promise;
  assert.equal(outcome.kind === "answered" && outcome.status, 403);
  assert.equal(script.sent(), 1, "one request");
  // Another 4xx and a 500 are answers too: only a 503 and a failed connection are retried.
  for (const status of [400, 404, 500]) {
    const r = drive([{ kind: "response", status, body: {} }, ok]);
    const o = await r.promise;
    assert.equal(o.kind === "answered" && o.status, status);
    assert.equal(r.script.sent(), 1, `status ${status}`);
  }
});

test("A-8 CALL_HOME unknown: a SENT request with no answer is never re-sent — deadline vs connection", async () => {
  const noAnswer: AtriumExchange = { kind: "no-answer", reason: "no answer in time" };
  const broke: AtriumExchange = { kind: "no-answer", reason: "socket hang up" };
  const a = drive([noAnswer, ok]);
  assert.deepEqual(await a.promise, { kind: "unknown", reason: "deadline", attempts: 1 });
  assert.equal(a.script.sent(), 1, "at most once: one request on the wire");
  const b = drive([broke, ok]);
  assert.deepEqual(await b.promise, { kind: "unknown", reason: "connection", attempts: 1 });
  assert.equal(b.script.sent(), 1);
});

test("an idempotent send (settle): an unanswered send atrium does not know is sent AGAIN; one it knows ends", async () => {
  const noAnswer: AtriumExchange = { kind: "no-answer", reason: "no answer in time" };
  let asked = 0;
  const unknownToAtrium = drive([noAnswer, noAnswer, ok], {
    settle: async () => {
      asked += 1;
      return { kind: "retry" };
    },
  });
  assert.equal((await unknownToAtrium.promise).kind, "answered");
  assert.equal(unknownToAtrium.script.sent(), 3);
  assert.equal(asked, 2);
  const known = drive([noAnswer, ok], {
    settle: async () => ({ kind: "answered", status: 200, body: { delivery_id: "d" } }),
  });
  const outcome = await known.promise;
  assert.equal(outcome.kind === "answered" && outcome.status, 200);
  assert.equal(known.script.sent(), 1, "atrium had it: not sent again");
  // And with the answer never known for the whole budget it is 'away', never 'unknown' or 'ok'.
  const never = drive([noAnswer], { settle: async () => ({ kind: "retry" }) });
  assert.equal((await never.promise).kind, "away");
});

// ─── the test-only compression: honoured ONLY under a NON-EMPTY NODE_TEST_CONTEXT ──────────────────

test("the budget override is honoured only under a NON-EMPTY NODE_TEST_CONTEXT (negative: unset, empty)", () => {
  const knob = { ACPX_CALL_HOME_BUDGET_MS: "1500" };
  assert.equal(callHomeBudgetMs({ ...knob, NODE_TEST_CONTEXT: "child" }), 1500, "the seam works");
  assert.equal(callHomeBudgetMs({ ...knob }), 600_000, "unset: production budget");
  assert.equal(
    callHomeBudgetMs({ ...knob, NODE_TEST_CONTEXT: "" }),
    600_000,
    "empty: production budget",
  );
  assert.equal(
    callHomeBudgetMs({ ACPX_CALL_HOME_BUDGET_MS: "0", NODE_TEST_CONTEXT: "child" }),
    600_000,
    "a zero or junk value is ignored too",
  );
  // The answer-timeout and retry-interval knobs follow the same rule.
  const ans = { ACPX_CALL_HOME_ANSWER_TIMEOUT_MS: "200" };
  assert.equal(callHomeAnswerTimeoutMs(60_000, { ...ans, NODE_TEST_CONTEXT: "x" }), 200);
  assert.equal(callHomeAnswerTimeoutMs(60_000, ans), 75_000, "deadline + 15 s slack in production");
});

test("the retry-interval seam compresses the pause only under NODE_TEST_CONTEXT", async () => {
  const seam = drive([away, ok], {
    env: { ACPX_CALL_HOME_RETRY_MS: "50", NODE_TEST_CONTEXT: "c" },
  });
  await seam.promise;
  assert.deepEqual(seam.time.slept, [50]);
  const prod = drive([away, ok], { env: { ACPX_CALL_HOME_RETRY_MS: "50" } });
  await prod.promise;
  assert.deepEqual(prod.time.slept, [1_000], "unset context: the real back-off");
});

// ─── the words ──────────────────────────────────────────────────────────────────────────────────

test("C7.2 wording: atrium_away is exit 75 with the contract's token line; unknown is exit 1", () => {
  const a = atriumAwayFailure(601_400);
  assert.equal(a.exitCode, 75);
  assert.equal(
    a.lines[0],
    "acpx: REFUSED reason=atrium_away nothing_started=true protocol=1 retry_after_s=60 waited_s=601",
  );
  const u = callHomeUnknownFailure("deadline", "call-1");
  assert.equal(u.exitCode, 1);
  assert.equal(u.lines[0], "acpx: CALL_HOME outcome=unknown reason=deadline call_id=call-1");
  assert.equal(
    callHomeUnknownFailure("connection", "c2", "rec-9").lines[1].includes("--record-id rec-9"),
    true,
    "a minted record id is named, so a repeat can use it",
  );
  const json = JSON.parse(a.json) as { error: { data: Record<string, unknown> } };
  assert.equal(json.error.data.reason, "atrium_away");
  assert.equal(json.error.data.tokenLine, a.lines[0]);
});
