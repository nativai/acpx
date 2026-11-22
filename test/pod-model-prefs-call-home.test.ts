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
