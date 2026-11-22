import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { callHomeBudgetMs, CALL_HOME_BUDGET_MS } from "../src/pod/call-home.js";
import { agentPodEnv, agentPodHome, runCli, snapshot } from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";
import type { AtriumScript, RecordedAtrium } from "./pod-kit/recorded-atrium.js";

// block A7 / C1.2 rule 5: the model preferences (`ui-prefs.db`, SQLite) are a control-store matter —
// the verbs that read or write them are PASSED THROUGH from an agent pod (call-home, C6.1/C6.2) and
// never open a database there. The real CLI runs in an agent pod (the product's own seam) against
// lane X1's recorded atrium.

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
  ACPX_CALL_HOME_ANSWER_TIMEOUT_MS: "1500",
};

const callsOf = (atrium: RecordedAtrium) => atrium.requests.filter((r) => r.route === "call");

function prefsFiles(home: string): string[] {
  const dir = path.join(home, ".acpx");
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((name) => name.startsWith("ui-prefs"))
    : [];
}

const VERBS: readonly { argv: string[]; answer: string }[] = [
  { argv: ["models", "fav", "--format", "json"], answer: '{"favorites":[]}\n' },
  { argv: ["models", "fav", "add", "openrouter:acme/model-1"], answer: "starred\n" },
  { argv: ["models", "fav", "rm", "openrouter:acme/model-1"], answer: "unstarred\n" },
  {
    argv: ["models", "last-used", "--format", "json"],
    answer: '{"lastUsedModelKey":{},"entries":[]}\n',
  },
  {
    argv: ["models", "last-used", "set", "--agent", "claude", "openrouter:acme/model-1"],
    answer: "set\n",
  },
];

for (const verb of VERBS) {
  test(`${verb.argv.slice(0, 3).join(" ")}: passed through from an agent pod, answered by the control pod, no database opened there`, async () => {
    const { home } = agentPodHome();
    await withAtrium(
      { calls: [{ answer: { exit: 0, stdout: verb.answer, stderr: "" } }] },
      async (atrium) => {
        const r = await runCli(verb.argv, agentPodEnv(home, atrium.url));
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, verb.answer, "the pod prints the control pod's stdout verbatim");
        const calls = callsOf(atrium);
        assert.equal(calls.length, 1, "exactly one call home");
        assert.deepEqual(calls[0]?.body?.argv, verb.argv, "the argv travels as typed");
      },
    );
    assert.deepEqual(prefsFiles(home), [], "no preferences database in the pod's state home");
  });
}

test("NEGATIVE: atrium away for the whole budget ⇒ atrium_away (75) and NO local fallback to the database", async () => {
  const { home } = agentPodHome();
  const before = snapshot(home);
  await withAtrium({ phases: [{ mode: "away" }] }, async (atrium) => {
    const r = await runCli(
      ["models", "fav", "add", "openrouter:acme/model-1"],
      agentPodEnv(home, atrium.url, FAST),
    );
    assert.equal(r.status, 75, r.stderr);
    assert.match(r.stderr, /^acpx: REFUSED reason=atrium_away nothing_started=true/u);
    assert.equal(r.stdout, "");
  });
  assert.deepEqual(prefsFiles(home), []);
  assert.deepEqual(snapshot(home), before, "the pod's state home is unchanged");
});

test("NEGATIVE: `models list` is the catalogue, still local in a pod — it shows no stars, says so once, and opens no database", async () => {
  const { home } = agentPodHome();
  await withAtrium({}, async (atrium) => {
    const r = await runCli(["models", "list", "--format", "json"], agentPodEnv(home, atrium.url));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(callsOf(atrium).length, 0, "not passed through");
    assert.equal(
      r.stderr.split("\n").filter((line) => line.includes("favorites are kept on the control pod"))
        .length,
      1,
      "one plain note",
    );
    assert.doesNotThrow(() => JSON.parse(r.stdout), "the catalogue itself is intact");
  });
  assert.deepEqual(prefsFiles(home), []);
});

// ---- the "hang": `models fav` with atrium unreachable is NOT unbounded — it ends at the call-home budget ----
//
// brick 74cd1715: the TE saw `models fav` wait more than 60 s with atrium unreachable and read it as a hang.
// It is the contract (C6.1): the pod client retries for the 600 s call-home budget, saying so on stderr
// ("still waiting for atrium … the command is not lost"), then fails with the NAMED refusal, exit 75. A
// real 600 s run ended there (see verification/PLAN.md); these rows time the same path with the budget
// compressed (honoured only under NODE_TEST_CONTEXT) and pin the constant.

test("the call-home budget is the contract's 600 s, and only a test context may compress it", () => {
  assert.equal(CALL_HOME_BUDGET_MS, 600_000);
  assert.equal(
    callHomeBudgetMs({ ACPX_CALL_HOME_BUDGET_MS: "1500" }),
    600_000,
    "no test context ⇒ no override",
  );
  assert.equal(
    callHomeBudgetMs({ ACPX_CALL_HOME_BUDGET_MS: "1500", NODE_TEST_CONTEXT: "child" }),
    1500,
  );
});

for (const argv of [
  ["models", "fav"],
  ["models", "last-used"],
] as const) {
  test(`\`${argv.join(" ")}\` in an agent pod with NOTHING listening ends at the call-home deadline with atrium_away (75), not later and not never`, async () => {
    const { home } = agentPodHome();
    const budgetMs = 2500;
    // 127.0.0.1:1 refuses at once: every attempt fails fast, so only the budget can end the wait
    const env = agentPodEnv(home, "http://127.0.0.1:1", {
      ACPX_CALL_HOME_BUDGET_MS: String(budgetMs),
      ACPX_CALL_HOME_RETRY_MS: "100",
    });
    const r = await runCli([...argv], env);
    assert.equal(r.status, 75, r.stderr);
    assert.match(r.stderr, /^acpx: REFUSED reason=atrium_away nothing_started=true/mu);
    assert.equal(r.stdout, "");
    assert.ok(r.ms >= budgetMs - 200, `it waited the budget, not less: ${r.ms} ms`);
    assert.ok(r.ms <= budgetMs + 8000, `and ended at it (no unbounded wait): ${r.ms} ms`);
    assert.deepEqual(prefsFiles(home), []);
  });
}

// ---- brick 20d6bce2: A-53 (the token is found by its head), F-11, F-12, F-13 ----------------------------------

const TOKEN_HEAD = /^acpx: (REFUSED|ROUTED|CALL_HOME) /u;
const PROGRESS = /^\[acpx\] still waiting for atrium/u;
/** Budget and progress interval compressed (honoured only under NODE_TEST_CONTEXT) so two progress lines are written. */
const WAITING = {
  ACPX_CALL_HOME_BUDGET_MS: "3500",
  ACPX_CALL_HOME_RETRY_MS: "100",
  ACPX_CALL_HOME_PROGRESS_MS: "400",
};

test("A-53 / row 53.1: in text mode the token follows >= 2 progress lines and is found by its head — never by its place", async () => {
  const { home } = agentPodHome();
  await withAtrium({ phases: [{ mode: "away" }] }, async (atrium) => {
    const r = await runCli(["models", "fav"], agentPodEnv(home, atrium.url, WAITING));
    assert.equal(r.status, 75, r.stderr);
    const lines = r.stderr.trimEnd().split("\n");
    const progress = lines.filter((line) => PROGRESS.test(line));
    assert.ok(progress.length >= 2, `at least two progress lines: ${r.stderr}`);
    // the token: the first line that begins with the head the exit code names (75 ⇒ REFUSED)
    const at = lines.findIndex((line) => line.startsWith("acpx: REFUSED "));
    assert.match(
      lines[at] ?? "",
      /^acpx: REFUSED reason=atrium_away nothing_started=true protocol=1 retry_after_s=60 waited_s=\d+$/u,
    );
    assert.match(
      lines[at + 1] ?? "",
      /^atrium did not answer for \d+ s/u,
      "the sentence is the next line",
    );
    // it is the ONLY line with a token head, and nothing before it has one
    assert.deepEqual(
      lines.filter((line) => TOKEN_HEAD.test(line)),
      [lines[at]],
    );
    assert.equal(
      lines.slice(0, at).some((line) => TOKEN_HEAD.test(line)),
      false,
    );
    // the progress lines come BEFORE the token and are not dropped to put it first; the row does not claim line 1
    assert.ok(at >= 2, `the token is after the progress lines (index ${at})`);
    assert.ok(
      lines.slice(0, at).every((line) => PROGRESS.test(line)),
      "only progress precedes it",
    );
  });
});

test("A-53 / 53.1 under --json-strict: stdout holds only the JSON whose error.data.tokenLine is that token; stderr is empty (F-11's ruling)", async () => {
  const { home } = agentPodHome();
  await withAtrium({ phases: [{ mode: "away" }] }, async (atrium) => {
    const strict = await runCli(
      ["--format", "json", "--json-strict", "models", "fav"],
      agentPodEnv(home, atrium.url, WAITING),
    );
    assert.equal(strict.status, 75, strict.stderr);
    // F-11, RULED: strict JSON is silent for the whole wait. The shipped `--json-strict` contract is EMPTY stderr and
    // stdout only the document; C7.2/A-53 keep progress lines in TEXT mode ("ruling them out would make the wait
    // silent" is about text); atrium's own routed prompt skips them under strict too. The refusal is ONE JSON
    // document at the budget, with retry_after_s — a strict caller bounds its own wait.
    assert.equal(
      strict.stderr,
      "",
      "no progress lines, no token line: stderr is empty under --json-strict",
    );
    const doc = JSON.parse(strict.stdout) as { error: { data: Record<string, unknown> } };
    assert.match(
      String(doc.error.data.tokenLine),
      /^acpx: REFUSED reason=atrium_away nothing_started=true protocol=1 retry_after_s=60 waited_s=\d+$/u,
    );
    // twin: plain --format json (not strict) DOES say what it is doing, on stderr, and still puts the doc on stdout
    const plain = await runCli(
      ["--format", "json", "models", "fav"],
      agentPodEnv(home, atrium.url, WAITING),
    );
    assert.equal(plain.status, 75, plain.stderr);
    assert.ok(
      plain.stderr.split("\n").some((line) => PROGRESS.test(line)),
      plain.stderr,
    );
    assert.doesNotThrow(() => JSON.parse(plain.stdout));
  });
});

test("F-12: atrium_away's JSON says retryable:true beside retry_after_s=60; a door refusal stays retryable:false", async () => {
  const { home } = agentPodHome();
  await withAtrium({ phases: [{ mode: "away" }] }, async (atrium) => {
    const r = await runCli(
      ["--format", "json", "--json-strict", "models", "fav"],
      agentPodEnv(home, atrium.url, { ...WAITING, ACPX_CALL_HOME_BUDGET_MS: "1200" }),
    );
    const data = (JSON.parse(r.stdout) as { error: { data: Record<string, unknown> } }).error.data;
    assert.equal(data.retry_after_s, 60);
    assert.equal(data.retryable, true, "the token says retry in 60 s; the JSON must agree");
  });
  // negative: a refusal BY the door is final, so `retryable` is false
  const { atriumAwayFailure, doorRefusedFailure } = await import("../src/pod/call-home.js");
  const refused = JSON.parse(doorRefusedFailure(403, "caller-mismatch", undefined).json) as {
    error: { data: Record<string, unknown> };
  };
  assert.equal(refused.error.data.retryable, false);
  assert.equal(
    (JSON.parse(atriumAwayFailure(1000).json) as { error: { data: { retryable: boolean } } }).error
      .data.retryable,
    true,
  );
});

test("F-13: CALL_HOME outcome=unknown advises a plain repeat for a read / idempotent verb — and keeps 'check first' for one that is not", async () => {
  const { home } = agentPodHome();
  const unknown = async (argv: string[]) => {
    let out: Awaited<ReturnType<typeof runCli>> | undefined;
    await withAtrium({ phases: [{ mode: "hang" }] }, async (atrium) => {
      out = await runCli(
        argv,
        agentPodEnv(home, atrium.url, {
          ...FAST,
          ACPX_CALL_HOME_ANSWER_TIMEOUT_MS: "700",
          ACPX_CALL_HOME_BUDGET_MS: "20000",
          ACPX_CALL_HOME_PROGRESS_MS: "100000",
        }),
      );
    });
    assert.ok(out);
    return out;
  };
  for (const argv of [
    ["models", "fav"],
    ["models", "fav", "add", "openrouter:acme/model-1"],
    ["models", "last-used"],
  ]) {
    const r = await unknown(argv);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^acpx: CALL_HOME outcome=unknown reason=deadline call_id=/mu);
    assert.match(r.stderr, /running it again is harmless: repeat it\./u, argv.join(" "));
    assert.doesNotMatch(
      r.stderr,
      /may apply twice|seats show|sessions show|do not simply run it again/u,
      argv.join(" "),
    );
  }
  // negative: a control-store verb the table does NOT mark repeatSafe keeps the old advice
  const other = await unknown(["seats", "rename", "11111111-1111-4111-8111-111111111111", "x"]);
  assert.equal(other.status, 1, other.stderr);
  assert.match(other.stderr, /may apply twice/u);
  assert.doesNotMatch(other.stderr, /harmless/u);
  // and the JSON says so: retryable follows the advice
  const json = await unknown(["--format", "json", "--json-strict", "models", "fav"]);
  const data = (JSON.parse(json.stdout) as { error: { data: Record<string, unknown> } }).error.data;
  assert.equal(data.retryable, true);
  assert.equal(data.repeat_safe, true);
  const jsonOther = await unknown([
    "--format",
    "json",
    "--json-strict",
    "seats",
    "rename",
    "11111111-1111-4111-8111-111111111111",
    "x",
  ]);
  const otherData = (JSON.parse(jsonOther.stdout) as { error: { data: Record<string, unknown> } })
    .error.data;
  assert.equal(otherData.retryable, false);
  assert.equal(typeof otherData.check, "string");
});
