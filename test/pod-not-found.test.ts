import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyArgv, COMMAND_TABLE } from "../src/pod/command-classes.js";
import { NOT_FOUND_VERBS } from "../src/pod/not-found-answer.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { konsiqPair, peopleDocument } from "./people-test-helpers.js";
import {
  addRecord,
  agentPodEnv,
  agentPodHome,
  OTHER_SESSION,
  runCli,
  snapshot,
  type ChildRun,
} from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";
import type { AtriumScript, RecordedAtrium } from "./pod-kit/recorded-atrium.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// Block "pod not-found" (brick 75956474, X1 TE round 2 P1; rule K5 — a routed command answers as if it ran
// locally). In an agent pod a command about a session nobody can find is refused by atrium with
// `400 class-not-passable` + `target-unresolved` (the recorded atrium does exactly that when it has no
// `resolveTargetAs`: the real one's behaviour, not a scripted world). The pod must answer what the CONTROL
// POD answers for the SAME command — and the control pod's answer is MEASURED HERE, in the same test, by
// running the same verb in a plain (non-pod) home: nothing below hard-codes a not-found text or exit code.

/** The id nobody has. */
const GHOST = "eeeeeeee-0000-4000-8000-0000000000ee";
/** A parent that exists in the control home (set-parent checks its parent before its target). */
const PARENT = "dddddddd-0000-4000-8000-0000000000dd";
const FAST = { ACPX_CALL_HOME_BUDGET_MS: "20000" };

async function withAtrium(script: AtriumScript, run: (atrium: RecordedAtrium) => Promise<void>) {
  const atrium = await startRecordedAtrium(script);
  try {
    await run(atrium);
  } finally {
    await atrium.close();
  }
}

const callsOf = (atrium: RecordedAtrium) => atrium.requests.filter((r) => r.route === "call");

/** Each verb that takes a session id, and one invocation per selector form the table maps. */
type Form = { name: string; argv: string[]; person?: true; parent?: true };
const FORMS: Form[] = [
  ...["cancel", "status"].flatMap((verb) => [
    { name: `${verb} --session-id`, argv: ["claude", verb, "--session-id", GHOST] },
    {
      name: `${verb} --session-url`,
      argv: ["claude", verb, "--session-url", `https://atrium.example/?session=${GHOST}`],
    },
  ]),
  { name: "set-mode --session-id", argv: ["claude", "set-mode", "plan", "--session-id", GHOST] },
  { name: "set --session-id", argv: ["claude", "set", "effort", "low", "--session-id", GHOST] },
  { name: "sessions close --session-id", argv: ["sessions", "close", "--session-id", GHOST] },
  { name: "sessions reopen <id>", argv: ["sessions", "reopen", GHOST] },
  { name: "sessions recover <id>", argv: ["sessions", "recover", GHOST] },
  { name: "sessions owner-status <id>", argv: ["sessions", "owner-status", GHOST] },
  { name: "sessions set-os <id>", argv: ["sessions", "set-os", GHOST, "default"] },
  {
    name: "sessions set-metadata --session-id",
    argv: ["sessions", "set-metadata", "k", "v", "--session-id", GHOST],
  },
  {
    name: "sessions set-parent --session-id",
    argv: ["sessions", "set-parent", "--session-id", GHOST, "--parent-id", PARENT],
    parent: true,
  },
  {
    name: "sessions set-parent --children-of",
    argv: ["sessions", "set-parent", "--children-of", GHOST, "--parent-id", PARENT],
    parent: true,
  },
  {
    name: "people set-owner --session",
    argv: ["people", "set-owner", "<person>", "--session", GHOST],
    person: true,
  },
];

/** The CONTROL POD's answer: the same verb, not in a pod, in a warmed home that holds what the verb needs. */
async function controlAnswer(form: Form, format: "text" | "json"): Promise<ChildRun> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-nf-control-"));
  await fs.mkdir(path.join(home, ".acpx", "sessions"), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    ACPX_STATE_HOME: home,
    NODE_TEST_CONTEXT: "child",
  };
  let argv = form.argv;
  if (form.parent) {
    const record = makeSessionRecord({
      acpxRecordId: PARENT,
      acpSessionId: "acp-parent",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: home,
    });
    await fs.writeFile(
      path.join(home, ".acpx", "sessions", `${PARENT}.json`),
      `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
    );
  }
  if (form.person) {
    const { brammertz, laatz } = await konsiqPair();
    await fs.writeFile(
      path.join(home, ".acpx", "people.json"),
      peopleDocument([brammertz, laatz]),
      "utf8",
    );
    argv = argv.map((a) => (a === "<person>" ? brammertz.id : a));
  }
  const args = format === "json" ? ["--format", "json", ...argv] : argv;
  // The first command in a fresh home rebuilds the index and says so; the control pod's index exists. The verb
  // refuses and writes nothing, so run it once to build the index and measure the second.
  await runCli(args, env, { cwd: home });
  return await runCli(args, env, { cwd: home });
}

/** The same verb in an agent pod whose atrium cannot resolve the target (as the real one). */
async function podAnswer(
  form: Form,
  format: "text" | "json",
): Promise<{ run: ChildRun; calls: number; written: string[] }> {
  const { home } = agentPodHome();
  await addRecord(home, OTHER_SESSION, "bbbbbbbb-0000-4000-8000-0000000000b4");
  let argv = form.argv;
  if (form.person) {
    const { brammertz, laatz } = await konsiqPair();
    await fs.mkdir(path.join(home, ".acpx"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".acpx", "people.json"),
      peopleDocument([brammertz, laatz]),
      "utf8",
    );
    argv = argv.map((a) => (a === "<person>" ? brammertz.id : a));
  }
  const before = snapshot(home);
  let result: { run: ChildRun; calls: number; written: string[] } | undefined;
  await withAtrium({}, async (atrium) => {
    const run = await runCli(
      format === "json" ? ["--format", "json", ...argv] : argv,
      agentPodEnv(home, atrium.url, FAST),
    );
    result = {
      run,
      calls: callsOf(atrium).length,
      written: snapshot(home).filter((f) => !before.includes(f)),
    };
  });
  assert.ok(result);
  return result;
}

for (const format of ["text", "json"] as const) {
  test(`K5 (${format}): in an agent pod EVERY passable verb that takes a session id answers an unknown session as the control pod does — exit code and text`, async () => {
    const mismatches: string[] = [];
    for (const form of FORMS) {
      const control = await controlAnswer(form, format);
      assert.notEqual(
        control.status,
        0,
        `${form.name}: the control must refuse (it is the measure)`,
      );
      const pod = await podAnswer(form, format);
      assert.equal(pod.calls, 1, `${form.name}: the call went home once`);
      assert.deepEqual(pod.written, [], `${form.name}: the pod wrote nothing`);
      if (
        pod.run.status !== control.status ||
        pod.run.stdout !== control.stdout ||
        pod.run.stderr !== control.stderr
      ) {
        mismatches.push(
          `${form.name}\n  control: exit ${control.status} out=${JSON.stringify(control.stdout)} err=${JSON.stringify(control.stderr)}\n  pod:     exit ${pod.run.status} out=${JSON.stringify(pod.run.stdout)} err=${JSON.stringify(pod.run.stderr)}`,
        );
      }
      // the rule is "no policy refusal for a typo"
      assert.doesNotMatch(pod.run.stderr + pod.run.stdout, /pass_through_refused/u, form.name);
    }
    assert.deepEqual(mismatches, []);
  });
}

test("K5: the table names exactly the verbs the forms drive (a new mapped verb with no row is red) and each is a classified command", () => {
  const driven = new Set(
    FORMS.map((f) => (f.argv[0] === "claude" ? f.argv[1] : f.argv.slice(0, 2).join(" "))),
  );
  assert.deepEqual([...driven].toSorted(), Object.keys(NOT_FOUND_VERBS).toSorted());
  for (const verb of Object.keys(NOT_FOUND_VERBS)) {
    assert.ok(COMMAND_TABLE[verb], `${verb} is a classified command`);
  }
  // classification of one form carries the target the mapping reads
  const c = classifyArgv(["sessions", "set-os", GHOST, "default"], {
    builtInAgents: ["claude"],
  });
  assert.equal(c.kind === "classified" && c.target?.value, GHOST);
});

// ---- the negatives: every OTHER refusal, and every shape that is not a plain not-found locally, stays as it was ----

/**
 * `resolveTargetAs` makes the kit's atrium RESOLVE the target, so the scripted answer is what it says — except in
 * the rows that script `target-unresolved` itself, where the kit's own refusal is the real one.
 */
async function podRefusal(argv: string[], script: AtriumScript): Promise<ChildRun> {
  const { home } = agentPodHome();
  let run: ChildRun | undefined;
  await withAtrium({ resolveTargetAs: OTHER_SESSION, ...script }, async (atrium) => {
    run = await runCli(argv, agentPodEnv(home, atrium.url, FAST));
  });
  assert.ok(run);
  return run;
}

const STILL_REFUSED =
  /^acpx: REFUSED reason=pass_through_refused nothing_started=true protocol=1 status=400 error=class-not-passable detail=/u;

test("K5 negative: every other class-not-passable reason keeps the door's refusal (exit 2, the token)", async () => {
  for (const reason of [
    "own-session",
    "no-caller",
    "file-argument",
    "table-unavailable",
    "class",
  ]) {
    const run = await podRefusal(["sessions", "set-os", GHOST, "default"], {
      calls: [{ answer: { status: 400, body: { error: "class-not-passable", reason } } }],
    });
    assert.equal(run.status, 2, `${reason}: ${run.stderr}`);
    assert.match(run.stderr.split("\n")[0] ?? "", STILL_REFUSED, reason);
    assert.match(run.stderr.split("\n")[0] ?? "", new RegExp(`detail=${reason}$`, "u"));
  }
  // and a 403 / another 400 error word are not "unresolved" either
  const forbidden = await podRefusal(["sessions", "set-os", GHOST, "default"], {
    calls: [{ answer: { status: 403, body: { error: "caller-mismatch" } } }],
  });
  assert.equal(forbidden.status, 2);
  assert.match(forbidden.stderr, /status=403 error=caller-mismatch/u);
  const wrongWord = await podRefusal(["sessions", "set-os", GHOST, "default"], {
    calls: [
      { answer: { status: 400, body: { error: "bad-request", reason: "target-unresolved" } } },
    ],
  });
  assert.equal(wrongWord.status, 2);
  assert.match(wrongWord.stderr, /error=bad-request detail=target-unresolved/u);
});

test("K5 negative: a shape the control pod does NOT answer as a plain not-found keeps the refusal — a name where an id belongs, a seat, -s", async () => {
  const unresolved = {
    calls: [
      {
        answer: { status: 400, body: { error: "class-not-passable", reason: "target-unresolved" } },
      },
    ],
  };
  for (const argv of [
    ["sessions", "close", GHOST], // a positional NAME: refused locally as a usage error (exit 2)
    ["claude", "status", "--seat", GHOST], // a seat has its own wording locally
    ["claude", "status", "-s", GHOST], // `-s` no longer selects a session
  ]) {
    const run = await podRefusal(argv, unresolved);
    assert.equal(run.status, 2, `${argv.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr.split("\n")[0] ?? "", STILL_REFUSED, argv.join(" "));
    assert.match(run.stderr.split("\n")[0] ?? "", /detail=target-unresolved$/u);
  }
});

test("K5 negative: two selectors name the session (a conflict) — not mapped; the control pod's resolver refuses that line itself", async () => {
  const run = await podRefusal(
    [
      "sessions",
      "set-metadata",
      "k",
      "v",
      "--session-id",
      GHOST,
      "--session-url",
      `https://atrium.example/?session=${GHOST}`,
    ],
    {
      calls: [
        {
          answer: {
            status: 400,
            body: { error: "class-not-passable", reason: "target-unresolved" },
          },
        },
      ],
    },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr.split("\n")[0] ?? "", STILL_REFUSED);
});

test("K5 control: a session atrium CAN resolve is passed through and answers as the control pod does (the mapping touches nothing else)", async () => {
  const { home } = agentPodHome();
  await withAtrium(
    {
      calls: [
        { answer: { exit: 4, stdout: "", stderr: "Session not found: from-the-control-pod\n" } },
      ],
      resolveTargetAs: OTHER_SESSION,
    },
    async (atrium) => {
      const run = await runCli(
        ["sessions", "set-os", GHOST, "default"],
        agentPodEnv(home, atrium.url, FAST),
      );
      assert.equal(run.status, 4);
      assert.equal(
        run.stderr,
        "Session not found: from-the-control-pod\n",
        "the control pod's own answer, verbatim",
      );
    },
  );
});
