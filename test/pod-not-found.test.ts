import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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

const URL_OF = (id: string): string => `https://atrium.example/?session=${id}`;

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
  {
    name: "set-mode --session-url",
    argv: ["claude", "set-mode", "plan", "--session-url", URL_OF(GHOST)],
  },
  { name: "set --session-id", argv: ["claude", "set", "effort", "low", "--session-id", GHOST] },
  {
    name: "set --session-url",
    argv: ["claude", "set", "effort", "low", "--session-url", URL_OF(GHOST)],
  },
  { name: "sessions close --session-id", argv: ["sessions", "close", "--session-id", GHOST] },
  {
    name: "sessions close --session-url",
    argv: ["sessions", "close", "--session-url", URL_OF(GHOST)],
  },
  {
    name: "sessions set-os <id> --dry-run",
    argv: ["sessions", "set-os", GHOST, "default", "--dry-run"],
  },
  // K5 TE F3: the id is named as the control pod names it — padded, as given
  {
    name: "status --session-url (padded id)",
    argv: ["claude", "status", "--session-url", `https://atrium.example/?session=%20${GHOST}%20`],
  },
  { name: "sessions reopen <id>", argv: ["sessions", "reopen", GHOST] },
  { name: "sessions recover <id>", argv: ["sessions", "recover", GHOST] },
  { name: "sessions owner-status <id>", argv: ["sessions", "owner-status", GHOST] },
  { name: "sessions set-os <id>", argv: ["sessions", "set-os", GHOST, "default"] },
  {
    name: "sessions set-metadata --session-id",
    argv: ["sessions", "set-metadata", "k", "v", "--session-id", GHOST],
  },
  {
    name: "sessions set-metadata --session-url",
    argv: ["sessions", "set-metadata", "k", "v", "--session-url", URL_OF(GHOST)],
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
  // K5 round 3, R2-F2: a leaf `--format` too — with a program-level one (the loop's) the PROGRAM-level wins
  {
    name: "sessions set-parent --children-of … --format json (leaf)",
    argv: [
      "sessions",
      "set-parent",
      "--children-of",
      GHOST,
      "--parent-id",
      PARENT,
      "--format",
      "json",
    ],
    parent: true,
  },
  {
    name: "sessions set-parent --session-id … --format text (leaf)",
    argv: [
      "sessions",
      "set-parent",
      "--session-id",
      GHOST,
      "--parent-id",
      PARENT,
      "--format",
      "text",
    ],
    parent: true,
  },
  {
    name: "people set-owner --session",
    argv: ["people", "set-owner", "<person>", "--session", GHOST],
    person: true,
  },
];

/** The CONTROL POD's answer: the same verb, not in a pod, in a warmed home that holds what the verb needs. */
type Format = "text" | "json" | "quiet";

async function controlAnswer(form: Form, format: Format): Promise<ChildRun> {
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
  const args = format === "text" ? argv : ["--format", format, ...argv];
  // The first command in a fresh home rebuilds the index and says so; the control pod's index exists. The verb
  // refuses and writes nothing, so run it once to build the index and measure the second.
  await runCli(args, env, { cwd: home });
  return await runCli(args, env, { cwd: home });
}

/** The same verb in an agent pod whose atrium cannot resolve the target (as the real one). */
async function podAnswer(
  form: Form,
  format: Format,
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
      format === "text" ? argv : ["--format", format, ...argv],
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

for (const format of ["text", "json", "quiet"] as const) {
  test(`K5 (${format}): in an agent pod EVERY passable verb that takes a session id answers an unknown session as the control pod does — exit code and text`, async () => {
    const mismatches: string[] = [];
    for (const form of FORMS) {
      const control = await controlAnswer(form, format);
      assert.equal(
        control.status,
        4,
        `${form.name}: the measure is a not-found (${control.stderr})`,
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

/** `<verb>|<selector>`: the pair a form drives, as the classifier reads it. */
function pairOf(argv: string[]): string {
  const c = classifyArgv(
    argv.map((a) => (a === "<person>" ? "p-someone" : a)),
    {
      builtInAgents: ["claude"],
    },
  );
  assert.equal(c.kind, "classified", argv.join(" "));
  if (c.kind !== "classified") {
    return "";
  }
  const how = c.target ? (c.target.via === "operand" ? "operand" : c.target.flag) : "none";
  return `${c.path}|${how}`;
}

test("K5 (F4): the table and the rows agree PER SELECTOR — every (verb, selector flag or operand) the table maps has a row, and no row drives an unmapped one", () => {
  const mapped: string[] = [];
  for (const [verb, v] of Object.entries(NOT_FOUND_VERBS)) {
    mapped.push(...v.flags.map((flag) => `${verb}|${flag}`));
    if (v.operand) {
      mapped.push(`${verb}|operand`);
    }
  }
  const sortedMapped = mapped.toSorted((a, b) => a.localeCompare(b));
  mapped.toSorted((a, b) => a.localeCompare(b));
  const driven = [...new Set(FORMS.map((f) => pairOf(f.argv)))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  assert.deepEqual(driven, sortedMapped);
  for (const verb of Object.keys(NOT_FOUND_VERBS)) {
    assert.ok(COMMAND_TABLE[verb], `${verb} is a classified command`);
  }
  // NEGATIVE: a flag added to a mapped verb with no row is a pair the rows do not drive
  const widened = [...sortedMapped, "cancel|--seat"].toSorted((a, b) => a.localeCompare(b));
  assert.notDeepEqual(driven, widened);
});

/** The real commander registration: the verbs' own options and arguments, to hold the table against. */
async function realCommand(pathWords: string[]) {
  const { Command } = await import("commander");
  const { configurePublicCli } = await import("../src/cli-public.js");
  const { registerAgentCommand, registerDefaultCommands } =
    await import("../src/cli/command-registration.js");
  const { addGlobalFlags } = await import("../src/cli/flags.js");
  const program = new Command().enablePositionalOptions();
  addGlobalFlags(program);
  configurePublicCli({
    program,
    argv: [],
    config: {
      defaultAgent: "claude",
      ttlMs: 900_000,
      queueMaxDepth: 16,
      format: "text",
      agents: {},
      auth: {},
      disableExec: false,
      mcpServers: [],
      subscriptions: { version: 3, subscriptions: [], profiles: [] },
    } as never,
    requestedJsonStrict: false,
    topLevelVerbs: new Set(),
    listBuiltInAgents: () => ["claude"],
    detectAgentToken: () => ({ hasAgentOverride: false }),
    registerAgentCommand,
    registerDefaultCommands,
    handlePromptAction: async () => {},
  });
  return pathWords.reduce((command, word) => {
    const next = command.commands.find((c) => c.name() === word);
    assert.ok(next, `no command ${word}`);
    return next;
  }, program);
}

test("K5 (F1c): the table's options and operand counts are the REAL registration's (each listed option exists with that kind; the operand range equals commander's)", async () => {
  for (const [verb, v] of Object.entries(NOT_FOUND_VERBS)) {
    const words = verb.includes(" ") ? verb.split(" ") : ["claude", verb];
    const command = await realCommand(words);
    const takesValue = (flag: string) =>
      command.options.some((o) => o.long === flag && (o.required || o.optional));
    const isBoolean = (flag: string) =>
      command.options.some((o) => o.long === flag && !o.required && !o.optional);
    for (const flag of v.values) {
      assert.ok(takesValue(flag), `${verb}: ${flag} is a value option`);
    }
    for (const flag of v.booleans) {
      assert.ok(isBoolean(flag), `${verb}: ${flag} is a boolean option`);
    }
    if (v.leafFormat) {
      assert.ok(takesValue("--format"), `${verb} declares its own --format`);
    }
    const required = command.registeredArguments.filter((a) => a.required).length;
    const max = command.registeredArguments.some((a) => a.variadic)
      ? Infinity
      : command.registeredArguments.length;
    // the table's range is the part of commander's that the mapped shapes use: never wider
    assert.ok(
      v.operands[0] >= required && v.operands[1] <= max,
      `${verb}: operands ${v.operands.join("..")} within ${required}..${String(max)}`,
    );
  }
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

// ---- K5 TE F1b, F1c, F5: lines the control pod does NOT answer as a not-found keep the refusal ----------------
// Each is measured on the control pod IN THE TEST (it is the evidence that the control pod refuses first, with its
// own exit code and wording, so a "Session not found" from the pod would be a false answer).

type Refused = { name: string; form: Form; controlExit: number; control: RegExp };
const SEAT = "11111111-1111-4111-8111-1111111111aa";
const REFUSED_LINES: Refused[] = [
  {
    name: "F1b: --session-url naming both ?seat= and ?session= (usage, exit 2)",
    form: {
      name: "both",
      argv: [
        "claude",
        "status",
        "--session-url",
        `https://atrium.example/?seat=${SEAT}&session=${GHOST}`,
      ],
    },
    controlExit: 2,
    control: /names both \?seat= and \?session=/u,
  },
  {
    name: "F1c: an unknown option (`set-parent --unset`, exit 1)",
    form: {
      name: "unset",
      argv: ["sessions", "set-parent", "--children-of", GHOST, "--parent-id", PARENT, "--unset"],
      parent: true,
    },
    controlExit: 1,
    control: /unknown option/u,
  },
  {
    // exit 2, not 1, since brick bfbb74e3 (N1): the line asks for JSON (`--format json`), and in json mode a usage
    // error on a subcommand is the top level's USAGE document (exit 2) instead of commander's silent exit 1.
    name: "F1c: a leaf `--format` on a verb that declares none (usage, exit 2, the JSON USAGE document)",
    form: {
      name: "leaf-format",
      argv: ["claude", "status", "--session-id", GHOST, "--format", "json"],
    },
    controlExit: 2,
    control: /unknown option/u,
  },
  {
    name: "F1c: --json-strict without --format json (usage, exit 2)",
    form: {
      name: "json-strict",
      argv: ["--json-strict", "claude", "status", "--session-id", GHOST],
    },
    controlExit: 2,
    control: /--json-strict requires --format json/u,
  },
  {
    name: "F1c: an invalid --format value (usage, exit 2)",
    form: {
      name: "bad-format",
      argv: ["--format", "bogus", "claude", "status", "--session-id", GHOST],
    },
    controlExit: 2,
    control: /format/iu,
  },
  {
    name: "F1c: a missing operand (`set-os <id>` without the choice, exit 1)",
    form: { name: "missing-operand", argv: ["sessions", "set-os", GHOST] },
    controlExit: 1,
    control: /missing required argument/u,
  },
  {
    name: "F1c: an extra operand (exit 1)",
    form: { name: "extra-operand", argv: ["claude", "status", "extra", "--session-id", GHOST] },
    controlExit: 1,
    control: /too many arguments/u,
  },
  {
    name: "F1c: a program option the pod cannot validate (`--timeout abc`, usage)",
    form: {
      name: "bad-timeout",
      argv: ["--timeout", "abc", "claude", "status", "--session-id", GHOST],
    },
    controlExit: 2,
    control: /timeout/iu,
  },
  {
    name: "F5 (named limit): a ?seat=-only URL — the control pod answers a seat's own not-found (exit 4), the pod keeps the refusal (exit 2)",
    form: {
      name: "seat-url",
      argv: ["claude", "status", "--session-url", `https://atrium.example/?seat=${SEAT}`],
    },
    controlExit: 4,
    control: /seat/iu,
  },
  {
    name: "F5 (named limit): `--seat <unknown>` — control exit 4 with the seat's wording, pod exit 2",
    form: { name: "seat", argv: ["claude", "status", "--seat", SEAT] },
    controlExit: 4,
    control: /seat/iu,
  },
  {
    name: "F5 (named limit): the AGENT-LESS no-selector form names the config's default agent, which the pod does not read — control exit 4, pod exit 2",
    form: { name: "none-agentless", argv: ["status"] },
    controlExit: 4,
    control: /No acpx session found/u,
  },
  {
    name: "F5 (named limit): `sessions close` with no selector — the default agent again, control exit 4, pod exit 2",
    form: { name: "none-close", argv: ["sessions", "close"] },
    controlExit: 4,
    control: /No acpx session found/u,
  },
  {
    name: "R2-F1: set-parent with NO parent flag (usage, exit 2, before any session lookup)",
    form: { name: "no-parent-flag", argv: ["sessions", "set-parent", "--session-id", GHOST] },
    controlExit: 2,
    control: /set-parent requires exactly one of/u,
  },
  {
    name: "R2-F1: set-parent with an EMPTY --parent-id (PARENT_DETACH_UNSUPPORTED, exit 2)",
    form: {
      name: "empty-parent",
      argv: ["sessions", "set-parent", "--session-id", GHOST, "--parent-id", ""],
    },
    controlExit: 2,
    control: /PARENT_DETACH_UNSUPPORTED/u,
  },
  {
    name: "R2-F1: set-os with a RELATIVE OS choice (refused before the session is looked up, exit 2)",
    form: { name: "relative-os", argv: ["sessions", "set-os", GHOST, "relative/os"] },
    controlExit: 2,
    control: /not under \/workspace\/ or \/opt\/atrium-os\//u,
  },
  {
    name: "R2-F1: set-metadata with an EMPTY key (commander's argument parser, exit 1)",
    form: { name: "empty-key", argv: ["sessions", "set-metadata", "", "v", "--session-id", GHOST] },
    controlExit: 1,
    control: /Metadata key must not be empty/u,
  },
  {
    name: "R2-F1: set-metadata with an EMPTY value (exit 1)",
    form: {
      name: "empty-value",
      argv: ["sessions", "set-metadata", "k", "", "--session-id", GHOST],
    },
    controlExit: 1,
    control: /Metadata value must not be empty/u,
  },
  {
    name: "R2-F3 (named limit): `--dry-run=true` on a boolean option — commander refuses it (exit 1); both refuse, the codes differ",
    form: {
      name: "dry-run-value",
      argv: ["sessions", "set-os", GHOST, "default", "--dry-run=true"],
    },
    controlExit: 1,
    control: /dry-run/u,
  },
];

test("K5 negative (F1b, F1c, F5): a line the control pod refuses BEFORE it resolves — or answers in a seat's own words — keeps the door's refusal in the pod, never a `Session not found`", async () => {
  for (const refused of REFUSED_LINES) {
    const control = await controlAnswer(refused.form, "text");
    assert.equal(control.status, refused.controlExit, `${refused.name}: control ${control.stderr}`);
    assert.match(
      control.stderr + control.stdout,
      refused.control,
      `${refused.name}: the control's wording`,
    );
    if (refused.controlExit !== 4) {
      assert.doesNotMatch(
        control.stderr,
        /^Session not found/mu,
        `${refused.name}: not a not-found on the control pod`,
      );
    }
    const pod = await podAnswer(refused.form, "text");
    assert.equal(pod.run.status, 2, `${refused.name}: ${pod.run.stderr}`);
    // `--json-strict` keeps stderr empty: the refusal is the JSON on stdout
    assert.match(
      pod.run.stderr + pod.run.stdout,
      /acpx: REFUSED reason=pass_through_refused /u,
      refused.name,
    );
    assert.doesNotMatch(pod.run.stderr + pod.run.stdout, /Session not found/u, refused.name);
  }
});

// ---- A-52 (rows 52.1–52.5, F1a): an ambiguous target is `target-ambiguous`; `target-unresolved` means ONLY no match ----
// The recorded atrium gets a REAL `stateHome`, so its resolver is acpx's own and ambiguity actually happens; the
// control pod is a plain home holding the SAME records. Nothing below hard-codes the control pod's answer.

type Seeded = { id: string; acp: string };
const SUFFIX_A = "11111111-0000-4000-8000-00000000ab12";
const SUFFIX_B = "22222222-0000-4000-8000-00000000ab12";
const SHARED_ACP = "acp-shared-by-two";
const POD_OWN = "aaaaaaaa-1111-4222-8333-444444444444"; // agentPodHome()'s own session
const SAME_TAIL = "bbbbbbbb-0000-4000-8000-444444444444"; // shares its last 12 characters with POD_OWN

async function seedStore(home: string, records: Seeded[]): Promise<void> {
  await fs.mkdir(path.join(home, ".acpx", "sessions"), { recursive: true });
  for (const r of records) {
    const record = makeSessionRecord({
      acpxRecordId: r.id,
      acpSessionId: r.acp,
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: home,
    });
    await fs.writeFile(
      path.join(home, ".acpx", "sessions", `${r.id}.json`),
      `${JSON.stringify(serializeSessionRecordForDisk(record))}\n`,
    );
  }
}

const STORE: Seeded[] = [
  { id: SUFFIX_A, acp: "acp-a1" },
  { id: SUFFIX_B, acp: "acp-b1" },
  { id: "33333333-0000-4000-8000-0000000000b1", acp: SHARED_ACP },
  { id: "44444444-0000-4000-8000-0000000000b2", acp: SHARED_ACP },
  { id: POD_OWN, acp: "acp-own" },
  { id: SAME_TAIL, acp: "acp-same-tail" },
  { id: PARENT, acp: "acp-parent" },
];

/** The same command on the control pod (a plain home with STORE) and in a pod whose atrium reads a copy of it. */
async function bothAnswer(
  argv: string[],
  format: Format,
  atriumScript: AtriumScript = {},
  classify?: Parameters<typeof startRecordedAtrium>[1] extends infer O
    ? O extends { classify?: infer C }
      ? C
      : never
    : never,
): Promise<{
  control: ChildRun;
  pod: ChildRun;
  calls: number;
  written: string[];
  bodies: unknown[];
}> {
  const controlHome = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-a52-control-"));
  await seedStore(controlHome, STORE);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: controlHome,
    ACPX_STATE_HOME: controlHome,
    NODE_TEST_CONTEXT: "child",
  };
  const args = format === "text" ? argv : ["--format", format, ...argv];
  await runCli(args, env, { cwd: controlHome }); // builds the control's index; measure the second
  const control = await runCli(args, env, { cwd: controlHome });
  const storeCopy = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-a52-atrium-"));
  await seedStore(storeCopy, STORE);
  const { home } = agentPodHome();
  await seedStore(home, STORE);
  const before = snapshot(home);
  const atrium = await startRecordedAtrium(
    { stateHome: storeCopy, ...atriumScript },
    classify ? { classify } : {},
  );
  try {
    const pod = await runCli(args, agentPodEnv(home, atrium.url, FAST));
    return {
      control,
      pod,
      calls: callsOf(atrium).length,
      written: snapshot(home).filter((f) => !before.includes(f)),
      bodies: callsOf(atrium).map((c) => c.body),
    };
  } finally {
    await atrium.close();
  }
}

const AMBIGUOUS_FORMS: Array<{ name: string; argv: string[] }> = [
  { name: "cancel --session-id <suffix>", argv: ["claude", "cancel", "--session-id", "ab12"] },
  { name: "sessions set-os <suffix> default", argv: ["sessions", "set-os", "ab12", "default"] },
];

for (const format of ["text", "json", "quiet"] as const) {
  test(`52.1 (${format}): a suffix shared by two records — the pod prints the control pod's answer byte for byte (exit 1), never "Session not found", never exit 4, never the "fresh session" hint`, async () => {
    for (const form of AMBIGUOUS_FORMS) {
      const { control, pod, calls, written } = await bothAnswer(form.argv, format);
      assert.equal(
        control.status,
        1,
        `${form.name}: the measure is ambiguity, exit 1 (${control.stderr}${control.stdout})`,
      );
      assert.match(control.stderr + control.stdout, /Session id is ambiguous: ab12/u);
      assert.equal(pod.status, control.status, `${form.name}: ${pod.stderr}`);
      assert.equal(pod.stdout, control.stdout, form.name);
      assert.equal(pod.stderr, control.stderr, form.name);
      assert.doesNotMatch(
        pod.stderr + pod.stdout,
        /Session not found|fresh session|pass_through_refused/u,
        form.name,
      );
      assert.equal(calls, 1, `${form.name}: one call home`);
      assert.deepEqual(written, [], `${form.name}: nothing written`);
    }
  });
}

test("52.1 controls: a UNIQUE suffix passes and runs; an UNKNOWN suffix is `target-unresolved` → exit 4 (K5)", async () => {
  const unique = await bothAnswer(["claude", "cancel", "--session-id", "0000000000b1"], "text", {
    calls: [{ answer: { exit: 0, stdout: "cancelled\n", stderr: "" } }],
  });
  assert.equal(unique.pod.status, 0, unique.pod.stderr);
  assert.equal(
    unique.pod.stdout,
    "cancelled\n",
    "the control pod's answer, verbatim: the call was passed",
  );
  const unknown = await bothAnswer(["claude", "cancel", "--session-id", "fffffff0ff99"], "text");
  assert.equal(unknown.control.status, 4);
  assert.equal(unknown.pod.status, 4);
  assert.equal(unknown.pod.stderr, unknown.control.stderr);
});

test("52.2: an exact id shared by two records is `Multiple sessions match id: <a>` — its sentence comes from `message`, not a copy of the suffix one", async () => {
  const { control, pod } = await bothAnswer(
    ["claude", "status", "--session-id", SHARED_ACP],
    "text",
  );
  assert.equal(control.status, 1, control.stderr);
  assert.match(control.stderr, new RegExp(`^Multiple sessions match id: ${SHARED_ACP}\\n`, "u"));
  assert.equal(pod.status, control.status);
  assert.equal(pod.stderr, control.stderr);
  assert.doesNotMatch(
    pod.stderr,
    /Session id is ambiguous/u,
    "never the suffix sentence in its place",
  );
  // CONTROL: one record with that id passes
  const one = await bothAnswer(["claude", "status", "--session-id", "acp-a1"], "text", {
    calls: [{ answer: { exit: 0, stdout: "status ok\n", stderr: "" } }],
  });
  assert.equal(one.pod.stdout, "status ok\n");
});

test("52.3: a lookup that FAILS is `target-lookup-failed`, never rendered as not found — the pod keeps the door's refusal (exit 2)", async () => {
  // (b) a --session-url naming both ?seat= and ?session= (the F1b shape) — the gate's resolver refuses it as usage
  const both = await bothAnswer(
    ["claude", "status", "--session-url", `https://atrium.example/?seat=${SEAT}&session=${GHOST}`],
    "text",
  );
  assert.equal(both.pod.status, 2, both.pod.stderr);
  assert.match(
    both.pod.stderr.split("\n")[0] ?? "",
    /^acpx: REFUSED reason=pass_through_refused .*error=class-not-passable detail=target-lookup-failed$/u,
  );
  assert.doesNotMatch(both.pod.stderr + both.pod.stdout, /Session not found/u);
  // (a) a sessions store that cannot be read: `.acpx` is a FILE where the directory should be
  const broken = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-a52-broken-"));
  await fs.writeFile(path.join(broken, ".acpx"), "not a directory");
  const { home } = agentPodHome();
  const atrium = await startRecordedAtrium({ stateHome: broken });
  try {
    const run = await runCli(
      ["claude", "cancel", "--session-id", GHOST],
      agentPodEnv(home, atrium.url, FAST),
    );
    assert.equal(run.status, 2, run.stderr);
    assert.doesNotMatch(run.stderr, /Session not found/u);
    assert.match(run.stderr.split("\n")[0] ?? "", /detail=target-(lookup-failed|unresolved)$/u);
  } finally {
    await atrium.close();
  }
  // CONTROL: a readable store and an unknown id → target-unresolved, exit 4
  const ok = await bothAnswer(["claude", "cancel", "--session-id", "fffffff0ff99"], "text");
  assert.equal(ok.pod.status, 4);
});

test("52.4 mixed versions: (a) an atrium given a classification WITHOUT targetError answers `target-unresolved` as before A-52; (b) the pod given `target-ambiguous` for a form K5 does not map keeps the door's refusal naming the reason", async () => {
  // (a) the classification an acpx before A-52 returns for an ambiguous value: null id, no targetError
  const older = await bothAnswer(
    ["claude", "cancel", "--session-id", "ab12"],
    "text",
    {},
    async () => ({
      kind: "classified",
      path: "cancel",
      class: "owner-if-pod",
      help: false,
      targetSessionId: null,
    }),
  );
  assert.equal(older.pod.status, 4, older.pod.stderr);
  assert.match(
    older.pod.stderr,
    /^Session not found: ab12\n/u,
    "the pre-A-52 answer: target-unresolved",
  );
  // (b) `--seat` is a form K5 does not map: atrium says ambiguous, the pod refuses by name
  const seat = await bothAnswer(["claude", "status", "--seat", SEAT], "text", {}, async () => ({
    kind: "classified",
    path: "status",
    class: "owner-if-pod",
    help: false,
    targetSessionId: null,
    targetError: { kind: "ambiguous", message: "Session id is ambiguous: x" },
  }));
  assert.equal(seat.pod.status, 2, seat.pod.stderr);
  assert.match(seat.pod.stderr.split("\n")[0] ?? "", /detail=target-ambiguous$/u);
  assert.doesNotMatch(
    seat.pod.stderr,
    /ambiguous: x/u,
    "an unmapped form never prints atrium's sentence",
  );
});

test("52.5 order: an ambiguous --children-of value that matches the caller's own session and one other is `target-ambiguous`, not `own-session` — the control pod's own error, exit 1", async () => {
  const argv = ["sessions", "set-parent", "--children-of", "444444444444", "--parent-id", PARENT];
  const { control, pod, calls } = await bothAnswer(argv, "text");
  assert.equal(control.status, 1, control.stderr);
  assert.match(control.stderr, /Session id is ambiguous: 444444444444/u);
  assert.equal(pod.status, control.status, pod.stderr);
  assert.equal(pod.stderr, control.stderr);
  assert.doesNotMatch(
    pod.stderr,
    /own-session|class-not-passable/u,
    "never judged to be the caller's own session",
  );
  assert.equal(calls, 1);
  // CONTROL: the caller's own FULL id is `own-session` (A-47)
  const own = await bothAnswer(
    ["sessions", "set-parent", "--children-of", POD_OWN, "--parent-id", PARENT],
    "text",
  );
  assert.equal(own.pod.status, 2, own.pod.stderr);
  assert.match(own.pod.stderr.split("\n")[0] ?? "", /detail=own-session$/u);
});

// ---- A-52, acpx's half: `classifyCall` carries WHY there is no id, additively ----------------------------------

async function classifyIn(home: string, argv: string[]): Promise<Record<string, unknown>> {
  const module = pathToFileURL(
    fileURLToPath(new URL("../src/pod/command-classes.js", import.meta.url)),
  ).href;
  const script = `const m = await import(${JSON.stringify(module)}); const argv = JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify(await m.classifyCall(argv, { builtInAgents: ["claude"] })));`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    ACPX_STATE_HOME: home,
    NODE_TEST_CONTEXT: "child",
  };
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, JSON.stringify(argv)],
      { env },
    );
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });
  return JSON.parse(out) as Record<string, unknown>;
}

test("A-52 classifyCall: `targetError` is present EXACTLY when `targetSessionId` is null on a target class; the id stays a record id or null", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-a52-classify-"));
  await seedStore(home, STORE);
  const at = (argv: string[]) => classifyIn(home, argv);

  const resolved = await at(["claude", "cancel", "--session-id", "0000000000b1"]);
  assert.equal(resolved.targetSessionId, "33333333-0000-4000-8000-0000000000b1");
  assert.equal("targetError" in resolved, false, "resolved: no targetError");

  const ambiguous = await at(["claude", "cancel", "--session-id", "ab12"]);
  assert.equal(ambiguous.targetSessionId, null);
  assert.deepEqual(ambiguous.targetError, {
    kind: "ambiguous",
    message: "Session id is ambiguous: ab12",
  });

  const exact = await at(["claude", "status", "--session-id", SHARED_ACP]);
  assert.deepEqual(exact.targetError, {
    kind: "ambiguous",
    message: `Multiple sessions match id: ${SHARED_ACP}`,
  });

  const missing = await at(["claude", "cancel", "--session-id", "fffffff0ff99"]);
  assert.equal(missing.targetSessionId, null);
  assert.deepEqual(missing.targetError, { kind: "not-found" });

  const seat = await at(["claude", "status", "--seat", SEAT]);
  assert.deepEqual(
    seat.targetError,
    { kind: "not-found" },
    "a seat's NoSessionError is a not-found",
  );

  const noSelector = await at(["claude", "status"]);
  assert.deepEqual(noSelector.targetError, { kind: "not-found" }, "no selector is a not-found");

  const usage = await at([
    "claude",
    "status",
    "--session-url",
    `https://atrium.example/?seat=${SEAT}&session=${GHOST}`,
  ]);
  assert.equal(usage.targetSessionId, null);
  assert.equal(
    (usage.targetError as { kind: string }).kind,
    "failed",
    "a selector refused as usage is a failed lookup",
  );
  assert.match(
    String((usage.targetError as { message?: string }).message),
    /names both \?seat= and \?session=/u,
  );

  // a class that does not depend on the target is not resolved at all: neither field
  const create = await at(["sessions", "new"]);
  assert.equal("targetSessionId" in create, false);
  assert.equal("targetError" in create, false);
});

test("A-52 resolveTargetRecordId keeps its type (an id or null) for the routed path, whatever the outcome", async () => {
  const { resolveTargetRecordId } = await import("../src/pod/target-resolver.js");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-a52-routed-"));
  await seedStore(home, STORE);
  const saved = { HOME: process.env.HOME, ACPX_STATE_HOME: process.env.ACPX_STATE_HOME };
  process.env.HOME = home;
  process.env.ACPX_STATE_HOME = home;
  try {
    assert.equal(
      await resolveTargetRecordId({ via: "flag", flag: "--session-id", value: SUFFIX_A }),
      SUFFIX_A,
    );
    assert.equal(
      await resolveTargetRecordId({ via: "flag", flag: "--session-id", value: "ab12" }),
      null,
    );
    assert.equal(
      await resolveTargetRecordId({ via: "flag", flag: "--session-id", value: "fffffff0ff99" }),
      null,
    );
    assert.equal(await resolveTargetRecordId(undefined), null);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

// ---- K5 round 3 (R2-F3, F5): shapes the control pod RESOLVES, once refused, now mapped — parity, measured ------------
// Each argv is given whole (no `--format` is prefixed): the first row needs a bare program-level `--json-strict`.

const EXTRA_FORMS: Form[] = [
  {
    name: "owner-status <id> with a bare program-level --json-strict (JSON not-found, exit 4)",
    argv: ["--json-strict", "sessions", "owner-status", GHOST],
  },
  {
    name: "set-os with `--` before the operands",
    argv: ["sessions", "set-os", "--", GHOST, "default"],
  },
  { name: "the agent-less `acpx status --session-id`", argv: ["status", "--session-id", GHOST] },
  {
    name: "the agent-less `acpx cancel --session-url`",
    argv: ["cancel", "--session-url", URL_OF(GHOST)],
  },
  // F5 (my call: MAPPED for an explicit agent): no selector → `No acpx session found: no session id was given …`
  { name: "claude cancel — no selector", argv: ["claude", "cancel"] },
  { name: "claude status — no selector", argv: ["claude", "status"] },
  { name: "claude set-mode plan — no selector", argv: ["claude", "set-mode", "plan"] },
  { name: "claude set effort low — no selector", argv: ["claude", "set", "effort", "low"] },
  {
    name: "codex status — no selector (the agent is named in the sentence)",
    argv: ["codex", "status"],
  },
  {
    name: "--format json claude status — no selector",
    argv: ["--format", "json", "claude", "status"],
  },
  {
    name: "--format quiet claude status — no selector",
    argv: ["--format", "quiet", "claude", "status"],
  },
];

test("K5 round 3: forms the control pod resolves — `--`, the agent-less verbs, a bare --json-strict on owner-status, and NO selector with an explicit agent — answer as the control pod does, byte for byte", async () => {
  const mismatches: string[] = [];
  for (const form of EXTRA_FORMS) {
    const control = await controlAnswer(form, "text");
    assert.equal(
      control.status,
      4,
      `${form.name}: the measure is a not-found (${control.stderr}${control.stdout})`,
    );
    const pod = await podAnswer(form, "text");
    assert.equal(pod.calls, 1, `${form.name}: one call home`);
    assert.deepEqual(pod.written, [], `${form.name}: nothing written`);
    if (
      pod.run.status !== control.status ||
      pod.run.stdout !== control.stdout ||
      pod.run.stderr !== control.stderr
    ) {
      mismatches.push(
        `${form.name}\n  control: exit ${control.status} out=${JSON.stringify(control.stdout)} err=${JSON.stringify(control.stderr)}\n  pod:     exit ${pod.run.status} out=${JSON.stringify(pod.run.stdout)} err=${JSON.stringify(pod.run.stderr)}`,
      );
    }
  }
  assert.deepEqual(mismatches, []);
});

test("K5 round 3 (R2-F2): with BOTH a program-level and a leaf `--format` the program-level one decides, as on the control pod — all nine pairs, measured", async () => {
  const formats = ["text", "json", "quiet"];
  const mismatches: string[] = [];
  for (const top of formats) {
    for (const leaf of formats) {
      const form: Form = {
        name: `top ${top} / leaf ${leaf}`,
        argv: [
          "--format",
          top,
          "sessions",
          "set-parent",
          "--children-of",
          GHOST,
          "--parent-id",
          PARENT,
          "--format",
          leaf,
        ],
        parent: true,
      };
      const control = await controlAnswer(form, "text");
      assert.equal(control.status, 4, `${form.name}: ${control.stderr}`);
      const pod = await podAnswer(form, "text");
      if (
        pod.run.status !== control.status ||
        pod.run.stdout !== control.stdout ||
        pod.run.stderr !== control.stderr
      ) {
        mismatches.push(
          `${form.name}: control out=${JSON.stringify(control.stdout)} err=${JSON.stringify(control.stderr)} | pod out=${JSON.stringify(pod.run.stdout)} err=${JSON.stringify(pod.run.stderr)}`,
        );
      }
    }
  }
  assert.deepEqual(mismatches, []);
});
