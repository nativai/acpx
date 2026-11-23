import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installReadEvidenceOnly } from "../src/pod/armed-guards.js";
import {
  armTargetVerdict,
  disarmTargetVerdictForTests,
  toldEvents,
} from "../src/pod/target-verdict.js";
import { judgeChild, type ChildResult } from "../src/pod/verdict-child.js";
import { resolveSessionRecord } from "../src/session/persistence.js";
import { serializeSessionRecordForDisk } from "../src/session/persistence/serialize.js";
import { konsiqPair, peopleDocument } from "./people-test-helpers.js";
import {
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

// K5 — a routed command answers as if it ran locally — BY CONSTRUCTION (brick 46b827ba; the spike is FINDINGS.md there).
// In an agent pod a command about a session atrium cannot find (or finds twice) is answered by acpx's REAL local path,
// run in a child the Node permission model has made read-only, with atrium's verdict armed. So the control pod's answer
// is the pod's by definition — and these rows MEASURE it, never state it: every parity row runs the same line on the
// control pod (a plain home) in the same test and compares exit code, stdout and stderr byte for byte.
// The published guarantee is "FAILS CLOSED TO THE DOOR'S REFUSAL": every way the child can be untrustworthy ends in
// `pass_through_refused`, never in a wrong "not found" (the fail-closed rows below, built from injection seams and
// fixtures, never by mutating product code).

/** The id nobody has. */
const GHOST = "eeeeeeee-0000-4000-8000-0000000000ee";
/** A parent that exists in every home (set-parent checks its parent before its target). */
const PARENT = "dddddddd-0000-4000-8000-0000000000dd";
const SEAT = "11111111-1111-4111-8111-1111111111aa";
const FAST = { ACPX_CALL_HOME_BUDGET_MS: "20000" };
const URL_OF = (id: string): string => `https://atrium.example/?session=${id}`;

async function withAtrium(script: AtriumScript, run: (atrium: RecordedAtrium) => Promise<void>) {
  const atrium = await startRecordedAtrium(script);
  try {
    await run(atrium);
  } finally {
    await atrium.close();
  }
}

const callsOf = (atrium: RecordedAtrium) => atrium.requests.filter((r) => r.route === "call");

type Format = "text" | "json" | "quiet";

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

type Rigged = {
  control: ChildRun;
  pod: ChildRun;
  calls: number;
  written: string[];
  bodies: unknown[];
  /** The three temp homes (control, pod, atrium's copy) — to normalise them out of a comparison. */
  homes: string[];
};

/**
 * A store every home starts from, WITH its index built (a real box has one: its first-run "full session-index rebuild"
 * note is not part of any answer): the seeded records, a people file, and `sessions reindex`.
 */
let templatePromise: Promise<string> | undefined;
function templateHome(): Promise<string> {
  templatePromise ??= (async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-a52-template-"));
    await seedStore(home, STORE);
    const { brammertz, laatz } = await konsiqPair();
    await fs.writeFile(
      path.join(home, ".acpx", "people.json"),
      peopleDocument([brammertz, laatz]),
      "utf8",
    );
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      ACPX_STATE_HOME: home,
      NODE_TEST_CONTEXT: "child",
    };
    const reindexed = await runCli(["sessions", "reindex"], env, { cwd: home });
    assert.equal(reindexed.status, 0, reindexed.stderr);
    return home;
  })();
  return templatePromise;
}

async function copyOfTemplate(into?: string): Promise<string> {
  const home = into ?? (await fs.mkdtemp(path.join(os.tmpdir(), "acpx-a52-home-")));
  await fs.cp(path.join(await templateHome(), ".acpx"), path.join(home, ".acpx"), {
    recursive: true,
  });
  return home;
}

type Hooks = {
  /** Change the control pod's home before the run (the same file in both homes keeps a comparison fair). */
  control?: (home: string) => Promise<void>;
  /** Change the pod's own home before the run (a record the pod can see and atrium cannot). */
  pod?: (home: string) => Promise<void>;
  /** Change the store atrium's resolver reads before the run. */
  atriumStore?: (home: string) => Promise<void>;
};

/** The same command on the control pod (a plain home) and in a pod whose atrium reads a copy of the same store. */
async function bothAnswer(
  argv: string[],
  format: Format,
  atriumScript: AtriumScript = {},
  classify?: Parameters<typeof startRecordedAtrium>[1] extends infer O
    ? O extends { classify?: infer C }
      ? C
      : never
    : never,
  hooks: Hooks = {},
): Promise<Rigged> {
  const controlHome = await copyOfTemplate();
  await hooks.control?.(controlHome);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: controlHome,
    ACPX_STATE_HOME: controlHome,
    NODE_TEST_CONTEXT: "child",
  };
  const args = format === "text" ? argv : ["--format", format, ...argv];
  const control = await runCli(args, env, { cwd: controlHome });
  const storeCopy = await copyOfTemplate();
  await hooks.atriumStore?.(storeCopy);
  const { home } = agentPodHome();
  await copyOfTemplate(home);
  await hooks.pod?.(home);
  const before = snapshot(home);
  const atrium = await startRecordedAtrium(
    { stateHome: storeCopy, ...atriumScript },
    classify ? { classify } : {},
  );
  try {
    // the pod runs in ITS home: a relative path or a usage text names the caller's cwd, as on the control pod
    const pod = await runCli(args, agentPodEnv(home, atrium.url, FAST), { cwd: home });
    return {
      control,
      pod,
      calls: callsOf(atrium).length,
      written: snapshot(home).filter((f) => !before.includes(f)),
      bodies: callsOf(atrium).map((c) => c.body),
      homes: [controlHome, home, storeCopy],
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

test("52.4 mixed versions: (a) an atrium given a classification WITHOUT targetError says `target-unresolved` for an AMBIGUOUS value — the pod's own read disagrees, so the door's refusal, not a false not-found; (b) atrium's `target-ambiguous` for a form whose own resolution says otherwise — the pod prints its own (the control pod's) answer, never atrium's sentence", async () => {
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
  // Against an atrium that does not know A-52 an ambiguous value is `target-unresolved`. The pod's child resolves FOR REAL,
  // finds the ambiguity, and so DISAGREES with the verdict: the door's refusal, never a "Session not found" (R2-F4 closed).
  assert.equal(older.pod.status, 2, older.pod.stderr);
  assert.match(older.pod.stderr.split("\n")[0] ?? "", /detail=target-unresolved$/u);
  assert.doesNotMatch(older.pod.stderr + older.pod.stdout, /Session not found|fresh session/u);
  // (b) atrium claims `ambiguous` for a `--seat`: the child's OWN resolution says what the control pod says for that seat
  // (not in the store), which is the pod's answer by construction — atrium's sentence is never printed.
  const seat = await bothAnswer(["claude", "status", "--seat", SEAT], "text", {}, async () => ({
    kind: "classified",
    path: "status",
    class: "owner-if-pod",
    help: false,
    targetSessionId: null,
    targetError: { kind: "ambiguous", message: "Session id is ambiguous: x" },
  }));
  assert.equal(seat.pod.status, seat.control.status, seat.pod.stderr);
  assert.equal(normalise(seat.pod.stderr, seat.homes), normalise(seat.control.stderr, seat.homes));
  assert.doesNotMatch(
    seat.pod.stderr,
    /ambiguous: x/u,
    "atrium's sentence is never printed when the pod's own read says otherwise",
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

// ---- the corpus: every line, control pod vs agent pod, byte for byte ------------------------------------------------

type Expect = "parity" | "os-relative" | "lookup-failed" | "registry";
type Line = { argv: string[]; expect?: Expect };
const U = URL_OF;
const CORPUS: Line[] = [
  // the thirteen verbs, one selector form each, and the forms the TE drove
  { argv: ["claude", "cancel", "--session-id", GHOST] },
  { argv: ["claude", "cancel", "--session-url", U(GHOST)] },
  { argv: ["claude", "status", "--session-id", GHOST] },
  { argv: ["claude", "status", "--session-url", U(GHOST)] },
  { argv: ["codex", "status", "--session-id", GHOST] },
  { argv: ["claude", "set-mode", "plan", "--session-id", GHOST] },
  { argv: ["claude", "set", "effort", "low", "--session-id", GHOST] },
  { argv: ["claude", "set", "effort", "low", "--session-url", U(GHOST)] },
  { argv: ["sessions", "close", "--session-id", GHOST] },
  { argv: ["sessions", "close", "--session-url", U(GHOST)] },
  { argv: ["sessions", "reopen", GHOST] },
  { argv: ["sessions", "recover", GHOST] },
  { argv: ["sessions", "owner-status", GHOST] },
  { argv: ["sessions", "set-os", GHOST, "default"] },
  { argv: ["sessions", "set-os", GHOST, "default", "--dry-run"] },
  { argv: ["sessions", "set-metadata", "k", "v", "--session-id", GHOST] },
  { argv: ["sessions", "set-metadata", "k", "v", "--session-url", U(GHOST)] },
  { argv: ["sessions", "set-parent", "--session-id", GHOST, "--parent-id", PARENT] },
  { argv: ["sessions", "set-parent", "--children-of", GHOST, "--parent-id", PARENT] },
  {
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
  },
  {
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
  },
  { argv: ["people", "set-owner", "<P>", "--session", GHOST] },
  { argv: ["people", "set-owner", "<P>", "--session", U(GHOST)] },
  { argv: ["claude", "status", "--session-url", `https://atrium.example/?session=%20${GHOST}%20`] },
  // A-52: two records match
  { argv: ["claude", "cancel", "--session-id", "ab12"] },
  { argv: ["sessions", "set-os", "ab12", "default"] },
  { argv: ["claude", "status", "--session-id", "acp-shared-by-two"] },
  { argv: ["sessions", "set-parent", "--children-of", "444444444444", "--parent-id", PARENT] },
  // the verbs' own pre-resolve refusals (R2-F1, R3-F1)
  { argv: ["sessions", "set-parent", "--session-id", GHOST] },
  { argv: ["sessions", "set-parent", "--session-id", GHOST, "--parent-id", ""] },
  { argv: ["sessions", "set-os", GHOST, "relative/os"], expect: "os-relative" },
  { argv: ["sessions", "set-metadata", "", "v", "--session-id", GHOST] },
  { argv: ["sessions", "set-metadata", "k", "", "--session-id", GHOST] },
  { argv: ["sessions", "set-metadata", "principal_id", "x", "--session-id", GHOST] },
  { argv: ["sessions", "set-metadata", "atrium_os_x", "x", "--session-id", GHOST] },
  { argv: ["sessions", "set-metadata", "brick", "notuuid", "--session-id", GHOST] },
  {
    argv: ["claude", "set", "subscription", "nosuchsub", "--session-id", GHOST],
    expect: "registry",
  },
  { argv: ["claude", "set", "profile", "nosuch", "--session-id", GHOST], expect: "registry" },
  { argv: ["claude", "set", "auto-failover", "maybe", "--session-id", GHOST] },
  { argv: ["claude", "set", "auto-subscription", "bad", "--session-id", GHOST] },
  { argv: ["claude", "set", "fable-degrade", "bad", "--session-id", GHOST] },
  { argv: ["claude", "set", "", "v", "--session-id", GHOST] },
  { argv: ["claude", "set", "k", "", "--session-id", GHOST] },
  { argv: ["claude", "set-mode", "", "--session-id", GHOST] },
  { argv: ["claude", "set-mode", "  ", "--session-id", GHOST] },
  // R3-F2/F3: empty and padded selectors
  { argv: ["claude", "status", "--session-id", ""] },
  { argv: ["claude", "status", "--session-id="] },
  { argv: ["claude", "status", "--session-url", ""] },
  { argv: ["claude", "status", "--session-id", "   "] },
  { argv: ["claude", "status", "--session-id", `  ${GHOST}  `] },
  // usage errors the control pod's commander refuses first
  { argv: ["claude", "status", "--session-id", GHOST, "--format", "json"] },
  { argv: ["--json-strict", "claude", "status", "--session-id", GHOST] },
  { argv: ["--format", "bogus", "claude", "status", "--session-id", GHOST] },
  { argv: ["sessions", "set-os", GHOST] },
  { argv: ["claude", "status", "extra", "--session-id", GHOST] },
  { argv: ["--timeout", "abc", "claude", "status", "--session-id", GHOST] },
  { argv: ["sessions", "set-parent", "--children-of", GHOST, "--parent-id", PARENT, "--unset"] },
  { argv: ["sessions", "set-os", GHOST, "default", "--dry-run=true"] },
  {
    argv: ["sessions", "set-metadata", "k", "v", "--session-id", GHOST, "--session-url", U(GHOST)],
  },
  // program-level and leaf --format together, json-strict on owner-status
  {
    argv: [
      "--format",
      "text",
      "sessions",
      "set-parent",
      "--children-of",
      GHOST,
      "--parent-id",
      PARENT,
      "--format",
      "json",
    ],
  },
  {
    argv: [
      "--format",
      "json",
      "sessions",
      "set-parent",
      "--children-of",
      GHOST,
      "--parent-id",
      PARENT,
      "--format",
      "quiet",
    ],
  },
  { argv: ["--json-strict", "sessions", "owner-status", GHOST] },
  { argv: ["--format", "text", "--json-strict", "sessions", "owner-status", GHOST] },
  { argv: ["--format", "quiet", "--json-strict", "sessions", "owner-status", GHOST] },
  // no selector at all (an explicit agent, the agent-less form, `sessions close`)
  { argv: ["claude", "status"] },
  { argv: ["claude", "cancel"] },
  { argv: ["claude", "set-mode", "plan"] },
  { argv: ["claude", "set", "effort", "low"] },
  { argv: ["status"] },
  { argv: ["sessions", "close"] },
  { argv: ["claude", "sessions", "close"] },
  { argv: ["claude", "sessions", "set-metadata", "k", "v"] },
  // seats, positional names, `-s`, `--`, the agent-less verbs
  { argv: ["claude", "status", "--seat", SEAT] },
  { argv: ["claude", "status", "--session-url", `https://atrium.example/?seat=${SEAT}`] },
  {
    argv: [
      "claude",
      "status",
      "--session-url",
      `https://atrium.example/?seat=${SEAT}&session=${GHOST}`,
    ],
    expect: "lookup-failed",
  },
  { argv: ["claude", "status", "-s", GHOST] },
  { argv: ["sessions", "close", GHOST] },
  { argv: ["sessions", "set-os", "--", GHOST, "default"] },
  { argv: ["status", "--session-id", GHOST] },
  { argv: ["cancel", "--session-url", U(GHOST)] },
];

/** The homes' random names and the seat store's path are not part of an answer. */
const normalise = (text: string, homes: string[]): string =>
  homes.reduce((t, home) => t.replaceAll(home, "<HOME>"), text);

/** Runs `lines` through `bothAnswer` with a few in flight at once (each line has homes of its own). */
async function inParallel<T>(
  items: T[],
  width: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        await work(item);
      }
    }),
  );
}

for (const format of ["text", "json", "quiet"] as const) {
  test(`corpus (${format}): ${CORPUS.length} command lines about a session nobody can find — the agent pod answers exactly as the control pod does (exit code, stdout, stderr), calls home once and writes nothing`, async () => {
    const { brammertz } = await konsiqPair();
    const mismatches: string[] = [];
    await inParallel(CORPUS, 4, async (line) => {
      if (line.argv[0]?.startsWith("-") && format !== "text") {
        return; // a line that starts with program options carries its own format
      }
      const argv = line.argv.map((a) => (a === "<P>" ? brammertz.id : a));
      const rigged = await bothAnswer(argv, format);
      const name = `${line.expect ?? "parity"}: ${argv.join(" ").replaceAll(GHOST, "<G>")}`;
      if (rigged.calls !== (line.expect === "os-relative" ? 0 : 1)) {
        mismatches.push(`${name}: ${rigged.calls} calls home`);
      }
      if (rigged.written.length > 0) {
        mismatches.push(`${name}: the pod wrote ${rigged.written.join(",")}`);
      }
      const same = (a: ChildRun, b: ChildRun): boolean =>
        a.status === b.status &&
        normalise(a.stdout, rigged.homes) === normalise(b.stdout, rigged.homes) &&
        normalise(a.stderr, rigged.homes) === normalise(b.stderr, rigged.homes);
      const { control, pod } = rigged;
      if (line.expect === "os-relative") {
        // EXPECTED difference: the pod's OWN placement guard (`os_not_shared`, before any call home) refuses a path that
        // cannot be shared; the control pod's validator says `not under /workspace/ …`. Both exit 2; nothing is called home.
        const ok =
          control.status === 2 &&
          pod.status === 2 &&
          /not under \/workspace\//u.test(control.stderr + control.stdout) &&
          /os_not_shared/u.test(pod.stderr + pod.stdout);
        if (!ok || rigged.calls !== 0) {
          mismatches.push(
            `${name}: control ${control.status} pod ${pod.status} calls ${rigged.calls}`,
          );
        }
      } else if (line.expect === "registry") {
        // EXPECTED difference (TE F8): the refusal comes from the POD's view of registry.json, not the box's; the pod does not
        // relay it — the door's refusal. The control pod's own answer is a usage refusal about the registry (exit 2).
        const ok =
          control.status === 2 &&
          pod.status === 2 &&
          /not found in registry/u.test(control.stderr + control.stdout) &&
          /pass_through_refused/u.test(pod.stderr + pod.stdout) &&
          !/not found in registry/u.test(pod.stderr + pod.stdout);
        if (!ok) {
          mismatches.push(`${name}: control ${control.status} pod ${pod.status}`);
        }
      } else if (line.expect === "lookup-failed") {
        // EXPECTED difference (A-52): atrium answers `target-lookup-failed` for a URL naming both ?seat= and ?session=, which
        // keeps the door's refusal BY DESIGN (a failed lookup is never shown as a not-found); the control pod's usage error is exit 2.
        const ok =
          control.status === 2 &&
          pod.status === 2 &&
          /names both \?seat= and \?session=/u.test(control.stderr + control.stdout) &&
          /target-lookup-failed/u.test(pod.stderr + pod.stdout);
        if (!ok) {
          mismatches.push(`${name}: control ${control.status} pod ${pod.status}`);
        }
      } else if (!same(control, pod)) {
        mismatches.push(
          `${name}\n  control: ${control.status} out=${JSON.stringify(normalise(control.stdout, rigged.homes))} err=${JSON.stringify(normalise(control.stderr, rigged.homes))}\n  pod:     ${pod.status} out=${JSON.stringify(normalise(pod.stdout, rigged.homes))} err=${JSON.stringify(normalise(pod.stderr, rigged.homes))}`,
        );
      } else if (/pass_through_refused/u.test(pod.stderr + pod.stdout)) {
        mismatches.push(`${name}: a parity line printed the door's refusal`);
      }
    });
    assert.deepEqual(mismatches, []);
  });
}

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

// ---- FAILS CLOSED to the door's refusal (the published guarantee) — injection seams and fixtures, no product mutation ----
// The pod's child must be believed only when it confirmed it is read-only and ended in an answer. Each row below makes
// the child untrustworthy in one way and asserts the pod prints THE DOOR'S refusal and never a "Session not found".

const STILL_REFUSED_TARGET =
  /^acpx: REFUSED reason=pass_through_refused nothing_started=true protocol=1 status=400 error=class-not-passable detail=target-unresolved$/u;

function assertDoorRefusal(run: ChildRun, label: string): void {
  assert.equal(run.status, 2, `${label}: ${run.stderr}`);
  assert.match(run.stderr.split("\n")[0] ?? "", STILL_REFUSED_TARGET, label);
  assert.doesNotMatch(run.stdout + run.stderr, /Session not found|fresh session/u, label);
}

const VERDICT_MODULE = pathToFileURL(
  fileURLToPath(new URL("../src/pod/target-verdict.js", import.meta.url)),
).href;

const GUARDS_MODULE = pathToFileURL(
  fileURLToPath(new URL("../src/pod/armed-guards.js", import.meta.url)),
).href;

/**
 * A fixture child: arms and confirms read-only EXACTLY as the real one does (`cli.ts`'s `armedVerdictRun`: arm, open the
 * side channel, install the guards, tell `readonly`, report its end) unless told not to, then behaves in one way.
 */
function fixtureSource(body: string): string {
  return `import fs from "node:fs";
import cp from "node:child_process";
import net from "node:net";
const m = await import(${JSON.stringify(VERDICT_MODULE)});
const g = await import(${JSON.stringify(GUARDS_MODULE)});
if (!process.env.FIXTURE_NO_CONFIRM && m.isReadOnlyProcess()) {
  m.armTargetVerdict({ values: ["x"], kind: "not-found" });
  m.openSideChannel();
  g.installArmedGuards();
  process.on("exit", (code) => m.tellExit(code));
  m.tellParent("readonly");
}
const sessionNotFound = "Session not found: x\\n";
${body}
`;
}

const FIXTURES: Record<string, { source: string; env?: NodeJS.ProcessEnv; why: string }> = {
  writes: {
    why: "a child that WRITES a file (the error printed)",
    source: fixtureSource(
      `try { fs.writeFileSync(process.env.FIXTURE_FILE, "x"); } catch (e) { process.stderr.write(e.code + ": " + e.message + "\\n"); }\nprocess.stderr.write(sessionNotFound); process.exit(4);`,
    ),
  },
  "writes, swallowed": {
    why: "a child that tries to WRITE and swallows the denial: only the guard's event says so",
    source: fixtureSource(
      `try { fs.writeFileSync(process.env.FIXTURE_FILE, "x"); } catch {}\nprocess.stderr.write(sessionNotFound); process.exit(4);`,
    ),
  },
  "writes through a promise, swallowed": {
    why: "a child that tries a promises-API mkdir and swallows the denial",
    source: fixtureSource(
      `await fs.promises.mkdir(process.env.FIXTURE_FILE + "-dir").catch(() => {});\nprocess.stderr.write(sessionNotFound); process.exit(4);`,
    ),
  },
  "writes through a stream, swallowed": {
    why: "a child that opens a write STREAM and swallows its error",
    source: fixtureSource(
      `const w = fs.createWriteStream(process.env.FIXTURE_FILE); w.on("error", () => {}); await new Promise((r) => setTimeout(r, 200));\nprocess.stderr.write(sessionNotFound); process.exit(4);`,
    ),
  },
  spawns: {
    why: "a child that SPAWNS a process (the error printed)",
    source: fixtureSource(
      `try { cp.spawnSync("true"); } catch (e) { process.stderr.write(e.code + ": " + e.message + "\\n"); }\nprocess.stderr.write(sessionNotFound); process.exit(4);`,
    ),
  },
  "spawns, swallowed": {
    why: "a child that tries to SPAWN and swallows the denial",
    source: fixtureSource(
      `try { cp.spawnSync("true"); } catch {}\nprocess.stderr.write(sessionNotFound); process.exit(4);`,
    ),
  },
  connects: {
    why: "a child that CONNECTS (to the recorded atrium itself), swallowed",
    source: fixtureSource(
      `try { await fetch(process.env.FIXTURE_URL + "/api/acpx/call", { method: "POST", body: "{}" }); } catch {}\nprocess.stderr.write(sessionNotFound); process.exit(4);`,
    ),
  },
  listens: {
    why: "a child that LISTENS on a port, swallowed (TE F4)",
    source: fixtureSource(
      `try { net.createServer().listen(0, "127.0.0.1"); } catch {}\nprocess.stderr.write(sessionNotFound); process.exit(4);`,
    ),
  },
  hangs: {
    why: "a child that HANGS",
    source: fixtureSource(`setInterval(() => {}, 1000);`),
    env: { ACPX_POD_VERDICT_TIMEOUT_MS: "500" },
  },
  crashes: {
    why: "a child that is KILLED (a crash)",
    source: fixtureSource(`process.kill(process.pid, "SIGKILL");`),
  },
  "exits non-zero, silent, without reporting its end": {
    why: "a child that exits non-zero, says nothing, and never reports its own normal end",
    source: fixtureSource(`process.removeAllListeners("exit"); process.exit(5);`),
  },
  "exits zero": {
    why: "a child that SUCCEEDS (an armed run about a missing session cannot)",
    source: fixtureSource(
      `m.tellParent("verdict"); process.stderr.write(sessionNotFound); process.exit(0);`,
    ),
  },
  "does not confirm read-only": {
    why: "a child that never confirms it is read-only, however plausible its answer",
    source: fixtureSource(`process.stderr.write(sessionNotFound); process.exit(4);`),
    env: { FIXTURE_NO_CONFIRM: "1" },
  },
};

async function runWithFixture(
  source: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ run: ChildRun; requests: number; file: string; wroteIt: boolean }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fixture-child-"));
  const entry = path.join(dir, "child.mjs");
  const file = path.join(dir, "must-not-exist");
  await fs.writeFile(entry, source);
  const { home } = agentPodHome();
  const atrium = await startRecordedAtrium({});
  try {
    const run = await runCli(
      ["claude", "status", "--session-id", GHOST],
      agentPodEnv(home, atrium.url, {
        ...FAST,
        ACPX_POD_VERDICT_CHILD_ENTRY: entry,
        FIXTURE_URL: atrium.url,
        FIXTURE_FILE: file,
        ...extraEnv,
      }),
      { cwd: home },
    );
    const wroteIt = await fs.stat(file).then(
      () => true,
      () => false,
    );
    return { run, requests: atrium.requests.length, file, wroteIt };
  } finally {
    await atrium.close();
  }
}

test("fail closed (b) CONTROL: a well-behaved fixture child IS relayed — so the fixtures above are valid, and their refusals are the guards' doing", async () => {
  const good = await runWithFixture(
    fixtureSource(`process.stderr.write(sessionNotFound); process.exit(4);`),
  );
  assert.equal(good.run.status, 4, good.run.stderr);
  assert.match(good.run.stderr, /Session not found: x/u);
});

test("fail closed (b): a child that writes, spawns, connects, hangs, is killed, exits non-zero silently, exits zero, or never confirms read-only ends in the door's refusal — never a not-found", async () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    const { run, requests, wroteIt } = await runWithFixture(fixture.source, fixture.env);
    assertDoorRefusal(run, `${name} (${fixture.why})`);
    assert.equal(requests, 1, `${name}: only the parent's call reached atrium`);
    assert.equal(wroteIt, false, `${name}: nothing was written`);
  }
});

test("fail closed (b), the network: the barrier in the armed child refuses a connection and tells the parent — measured on a REAL child under the permission model", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-fixture-net-"));
  const script = path.join(dir, "probe.mjs");
  await fs.writeFile(
    script,
    `const m = await import(${JSON.stringify(VERDICT_MODULE)});
const g = await import(${JSON.stringify(GUARDS_MODULE)});
m.armTargetVerdict({ values: ["x"], kind: "not-found" });
m.openSideChannel();
g.installArmedGuards();
const outcomes = [];
for (const attempt of [() => fetch("http://127.0.0.1:9/"), async () => (await import("node:net")).connect(9, "127.0.0.1"), async () => (await import("node:net")).createServer().listen(0, "127.0.0.1")]) {
  try { await attempt(); outcomes.push("connected"); } catch (e) { outcomes.push(e.code ?? e.cause?.code ?? "refused"); }
}
process.stdout.write(JSON.stringify(outcomes));
`,
  );
  const events = await new Promise<{ out: string; side: string }>((resolve) => {
    const child = spawn(process.execPath, ["--permission", "--allow-fs-read=*", script], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    let out = "";
    let side = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
    (child.stdio[3] as NodeJS.ReadableStream).on("data", (c: Buffer) => (side += c.toString()));
    child.on("close", () => resolve({ out, side }));
  });
  const outcomes = JSON.parse(events.out) as string[];
  assert.equal(outcomes.length, 3);
  assert.ok(!outcomes.includes("connected"), `a connection was made: ${events.out}`);
  assert.match(events.side, /"event":"network"/u, "the parent was told");
  const verdict = judgeChild({
    status: 4,
    signal: null,
    stdout: "",
    stderr: "Session not found: x\n",
    events: events.side + '{"event":"readonly"}\n',
  });
  assert.equal(verdict.relay, false, "a network attempt is never relayed");
});

/** The pod run with the REAL CLI as the verdict child (no fixture entry), under test-seam flags. */
async function runWithRealChild(
  flags: string | ((home: string) => string),
  extraEnv: (home: string) => NodeJS.ProcessEnv = () => ({}),
): Promise<{ run: ChildRun; requests: number; home: string }> {
  const { home } = agentPodHome();
  await fs.mkdir(path.join(home, ".acpx", "sessions"), { recursive: true }); // a real pod's home has its store
  const atrium = await startRecordedAtrium({});
  try {
    const run = await runCli(
      ["claude", "status", "--session-id", GHOST],
      agentPodEnv(home, atrium.url, {
        ...FAST,
        ACPX_POD_VERDICT_CHILD_FLAGS: typeof flags === "function" ? flags(home) : flags,
        ...extraEnv(home),
      }),
      { cwd: home },
    );
    return { run, requests: atrium.requests.length, home };
  } finally {
    await atrium.close();
  }
}

test("fail closed (a): a Node without the permission model, or with it refused, ends in the door's refusal", async () => {
  const noModel = await runWithRealChild("none");
  assertDoorRefusal(
    noModel.run,
    "no permission model at all (the real CLI as the child, ordinary flags)",
  );
  assert.equal(
    noModel.requests,
    1,
    "the unconfined child did not call home again (ACPX_ROUTED guards the loop)",
  );
  const writeGranted = await runWithRealChild("--permission --allow-fs-read=* --allow-fs-write=*");
  assertDoorRefusal(
    writeGranted.run,
    "the model on but a write granted: not read-only, never believed",
  );
  const childGranted = await runWithRealChild(
    "--permission --allow-fs-read=* --allow-child-process",
  );
  assertDoorRefusal(childGranted.run, "the model on but a child process granted");
  const cannotRead = await runWithRealChild("--permission");
  assertDoorRefusal(
    cannotRead.run,
    "the model on with no read access: the child cannot even start",
  );
  // CONTROL: the default flags are the read-only model, and that child is believed
  const believed = await runWithRealChild("--permission --allow-fs-read=*");
  assert.equal(believed.run.status, 4, believed.run.stderr);
  assert.match(believed.run.stderr, /Session not found: /u);
});

const confirmed = '{"event":"readonly"}\n';
const exited = (code: number): string => `{"event":"exit","code":${code}}\n`;
const result = (over: Partial<ChildResult>): ChildResult => ({
  status: 4,
  signal: null,
  stdout: "",
  stderr: "Session not found: x\n",
  events: `${confirmed}{"event":"verdict"}\n${exited(4)}`,
  ...over,
});

test("judgeChild: the relay rule, case by case — only a confirmed, finished, non-zero, undenied, agreeing child that reports its own normal end is relayed", () => {
  const cases: Array<[string, ChildResult, string | undefined]> = [
    ["a good answer", result({}), undefined],
    [
      "a usage error (the verdict never fired, but acpx's own exit path ended it)",
      result({
        events: `${confirmed}${exited(1)}`,
        stderr: "error: unknown option '--x'\n",
        status: 1,
      }),
      undefined,
    ],
    [
      "a SILENT answer (set-parent --format quiet prints nothing; the exit is the answer)",
      result({ stderr: "", events: `${confirmed}{"event":"verdict"}\n${exited(2)}`, status: 2 }),
      undefined,
    ],
    ["a spawn error / timeout", result({ error: "ETIMEDOUT", status: null }), "child-ETIMEDOUT"],
    ["killed by a signal", result({ status: null, signal: "SIGKILL" }), "child-signal"],
    [
      "not confirmed read-only",
      result({ events: `{"event":"verdict"}\n${exited(4)}` }),
      "not-confirmed-read-only",
    ],
    [
      "a network attempt",
      result({ events: `${confirmed}{"event":"network"}\n${exited(4)}` }),
      "network",
    ],
    [
      "the pod's own read disagreed",
      result({ events: `${confirmed}{"event":"differs"}\n${exited(4)}` }),
      "pod-view-differs",
    ],
    ["it ended 0", result({ status: 0, events: `${confirmed}${exited(0)}` }), "child-succeeded"],
    [
      "a write was denied",
      result({ stderr: "ERR_ACCESS_DENIED: Access to this API has been restricted\n" }),
      "denied",
    ],
    [
      "an uncaught exception",
      result({ events: `${confirmed}{"event":"crashed"}\n${exited(1)}`, status: 1 }),
      "crashed",
    ],
    [
      "non-zero, but never reported its own end",
      result({ events: confirmed, stderr: "", status: 5 }),
      "no-normal-end",
    ],
    [
      "an end that disagrees with the code it left with",
      result({ events: `${confirmed}${exited(1)}` }),
      "no-normal-end",
    ],
    [
      "garbage on the side channel only",
      result({ events: "not json\n" }),
      "not-confirmed-read-only",
    ],
  ];
  for (const [name, input, why] of cases) {
    const judged = judgeChild(input);
    if (why === undefined) {
      assert.equal(judged.relay, true, name);
    } else {
      assert.deepEqual(judged, { relay: false, why }, name);
    }
  }
});

// ---- a CONFIGURED non-built-in agent (R2-I1 of the lows-r3 TE): the sentence names the agent, as on the control pod ----

const withConfiguredAgent = async (home: string): Promise<void> => {
  await fs.writeFile(
    path.join(home, ".acpx", "config.json"),
    JSON.stringify({ agents: { myagent: { command: "node /opt/myagent/index.js" } } }),
  );
};

for (const format of ["text", "json", "quiet"] as const) {
  test(`configured non-built-in agent (${format}): \`acpx myagent status\` in a pod gives the control pod's answer — the no-selector sentence names \`acpx myagent sessions new\`; by construction, with no copy of the sentence in the pod`, async () => {
    for (const argv of [
      ["myagent", "status"],
      ["myagent", "status", "--session-id", GHOST],
    ]) {
      const rigged = await bothAnswer(argv, format, {}, undefined, {
        control: withConfiguredAgent,
        pod: withConfiguredAgent,
      });
      assert.equal(rigged.control.status, 4, rigged.control.stderr + rigged.control.stdout);
      assert.equal(rigged.pod.status, rigged.control.status, rigged.pod.stderr);
      assert.equal(
        normalise(rigged.pod.stdout, rigged.homes),
        normalise(rigged.control.stdout, rigged.homes),
      );
      assert.equal(
        normalise(rigged.pod.stderr, rigged.homes),
        normalise(rigged.control.stderr, rigged.homes),
      );
      if (argv.length === 2 && format !== "json") {
        assert.match(
          rigged.pod.stderr,
          /Create one: acpx myagent sessions new/u,
          "the configured agent is named",
        );
      }
      assert.equal(rigged.calls, 1);
    }
  });
}

// ---- fail closed (c): the pod's own read differs from the control pod's -----------------------------------------------

async function writeRecordIn(home: string, id: string): Promise<void> {
  await seedStore(home, [{ id, acp: `acp-${id.slice(0, 8)}` }]);
}

test("fail closed (c): atrium says `not found` but the POD's own read finds the record (a record that just landed) — the door's refusal, the command never runs", async () => {
  const rigged = await bothAnswer(
    ["claude", "status", "--session-id", GHOST],
    "text",
    {},
    undefined,
    {
      pod: (home) => writeRecordIn(home, GHOST),
    },
  );
  assertDoorRefusal(rigged.pod, "the pod sees the record");
  assert.deepEqual(rigged.written, [], "and it wrote nothing");
});

test("fail closed (c): atrium says AMBIGUOUS but the pod's own read finds one record — the door's refusal, atrium's sentence never printed", async () => {
  const rigged = await bothAnswer(
    ["claude", "cancel", "--session-id", "ab12"],
    "text",
    {},
    undefined,
    {
      pod: async (home) => {
        await fs.rm(path.join(home, ".acpx", "sessions", `${SUFFIX_B}.json`));
        await fs.rm(path.join(home, ".acpx", "sessions", "index.json"), { force: true });
      },
    },
  );
  assert.equal(rigged.pod.status, 2, rigged.pod.stderr);
  assert.match(rigged.pod.stderr.split("\n")[0] ?? "", /detail=target-ambiguous$/u);
  assert.doesNotMatch(rigged.pod.stderr + rigged.pod.stdout, /ambiguous: ab12|Session not found/u);
});

/** A record file in the pod's home that cannot be parsed, in the shapes a write in flight leaves. */
const UNREADABLE: Array<[string, string]> = [
  ["truncated", '{"acpxRecordId":"eeeeeeee-0000-4000'],
  ["empty", ""],
  ["partial JSON", '{"acpxRecordId": '],
  ["not a record", "[]"],
];

test("fail closed (c), the selector is an ID and `<id>.json` exists but does not parse (truncated, empty, partial, not a record): the door's refusal — a record that EXISTS is being written, so a not-found is wrong in that instant", async () => {
  for (const [shape, text] of UNREADABLE) {
    const rigged = await bothAnswer(
      ["claude", "status", "--session-id", GHOST],
      "text",
      {},
      undefined,
      {
        pod: (home) => fs.writeFile(path.join(home, ".acpx", "sessions", `${GHOST}.json`), text),
      },
    );
    assertDoorRefusal(rigged.pod, `${shape}: the id's own file`);
    assert.deepEqual(rigged.written, [], `${shape}: nothing written`);
  }
});

test("fail closed (c), the selector is a NAME (a suffix) and ANY record in the scanned set does not parse: the door's refusal, since it cannot be ruled out as the target", async () => {
  for (const [shape, text] of UNREADABLE) {
    const rigged = await bothAnswer(
      ["claude", "status", "--session-id", "zz99"],
      "text",
      {},
      undefined,
      {
        pod: (home) =>
          fs.writeFile(
            path.join(home, ".acpx", "sessions", "99999999-0000-4000-8000-0000000000aa.json"),
            text,
          ),
      },
    );
    assertDoorRefusal(rigged.pod, `${shape}: an unrelated file, a suffix selector`);
  }
});

test("fail closed (c), an UNPARSABLE INDEX beside good records follows the same rule", async () => {
  for (const [shape, text] of UNREADABLE.slice(0, 3)) {
    const rigged = await bothAnswer(
      ["claude", "status", "--session-id", GHOST],
      "text",
      {},
      undefined,
      {
        pod: (home) => fs.writeFile(path.join(home, ".acpx", "sessions", "index.json"), text),
      },
    );
    assertDoorRefusal(rigged.pod, `${shape}: index.json`);
  }
});

test("fail closed (c) TWINS: the same lines with every record well-formed relay the control pod's not-found — id, suffix and a rewritten-but-valid index", async () => {
  for (const argv of [
    ["claude", "status", "--session-id", GHOST],
    ["claude", "status", "--session-id", "zz99"],
  ]) {
    const rigged = await bothAnswer(argv, "text", {}, undefined, {
      // an unrelated WELL-FORMED record the pod can see and the control pod cannot: it changes nothing about the answer
      pod: (home) => writeRecordIn(home, "99999999-0000-4000-8000-0000000000aa"),
    });
    assert.equal(rigged.pod.status, 4, rigged.pod.stderr);
    assert.match(rigged.pod.stderr, /Session not found: /u);
    assert.equal(rigged.control.status, 4);
    assert.doesNotMatch(rigged.pod.stderr, /pass_through_refused/u);
  }
  const index = await bothAnswer(
    ["claude", "status", "--session-id", GHOST],
    "text",
    {},
    undefined,
    {
      pod: async (home) => {
        const file = path.join(home, ".acpx", "sessions", "index.json");
        await fs.writeFile(file, JSON.stringify(JSON.parse(await fs.readFile(file, "utf8"))));
      },
    },
  );
  assert.equal(index.pod.status, 4, index.pod.stderr);
});

test("fail closed (c): with an unreadable record the lookup READ, even an ambiguity is not relayed — any taint at the reads withholds the answer; the well-formed twin relays it", async () => {
  const rigged = await bothAnswer(
    ["claude", "cancel", "--session-id", "ab12"],
    "text",
    {},
    undefined,
    {
      pod: (home) =>
        fs.writeFile(
          path.join(home, ".acpx", "sessions", "99999999-0000-4000-8000-0000000000aa.json"),
          "{",
        ),
    },
  );
  assert.equal(rigged.pod.status, 2, rigged.pod.stderr);
  assert.match(rigged.pod.stderr.split("\n")[0] ?? "", /detail=target-ambiguous$/u);
  assert.doesNotMatch(rigged.pod.stderr + rigged.pod.stdout, /ambiguous: ab12|Session not found/u);
  const twin = await bothAnswer(["claude", "cancel", "--session-id", "ab12"], "text");
  assert.equal(twin.pod.status, 1, twin.pod.stderr);
  assert.match(twin.pod.stderr, /Session id is ambiguous: ab12/u);
});

// ---- the seam: the verdict variable opens no way round the door ---------------------------------------------------------

test("seam: a NORMAL process given the verdict variable still routes through the door and does NOT honour the verdict", async () => {
  const { home } = agentPodHome();
  const atrium = await startRecordedAtrium({
    resolveTargetAs: OTHER_SESSION,
    calls: [{ answer: { exit: 0, stdout: "answered by atrium, through the door\n", stderr: "" } }],
  });
  try {
    const run = await runCli(
      ["claude", "status", "--session-id", GHOST],
      agentPodEnv(home, atrium.url, {
        ...FAST,
        ACPX_POD_TARGET_VERDICT: JSON.stringify({ values: [GHOST], kind: "not-found" }),
      }),
      { cwd: home },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "answered by atrium, through the door\n");
    assert.equal(callsOf(atrium).length, 1, "it went through the door");
    assert.doesNotMatch(
      run.stdout + run.stderr,
      /Session not found/u,
      "the verdict was not honoured",
    );
  } finally {
    await atrium.close();
  }
});

test("seam: outside a pod too, an ordinary process given the verdict variable behaves exactly as without it", async () => {
  const home = await copyOfTemplate();
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    ACPX_STATE_HOME: home,
    NODE_TEST_CONTEXT: "child",
  };
  const argv = ["sessions", "owner-status", SUFFIX_A];
  const plain = await runCli(argv, env, { cwd: home });
  const armed = await runCli(
    argv,
    { ...env, ACPX_POD_TARGET_VERDICT: JSON.stringify({ values: [SUFFIX_A], kind: "not-found" }) },
    { cwd: home },
  );
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(armed.status, plain.status);
  assert.equal(armed.stdout, plain.stdout);
  assert.equal(armed.stderr, plain.stderr);
});

// ---- ensureSessionDir: a stat before the mkdir changes nothing off the pod path ---------------------------------------

async function withStateHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const saved = { HOME: process.env.HOME, ACPX_STATE_HOME: process.env.ACPX_STATE_HOME };
  process.env.HOME = home;
  process.env.ACPX_STATE_HOME = home;
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test("ensureSessionDir: an EXISTING sessions dir is left untouched (contents and mtime), a MISSING one is still created, a FILE in the way still fails in mkdir", async () => {
  const existing = await copyOfTemplate(); // a store WITH its index: resolving a missing id writes nothing
  const stamp = async (): Promise<string> =>
    JSON.stringify(
      await Promise.all(
        (await fs.readdir(path.join(existing, ".acpx", "sessions")))
          .toSorted()
          .map(async (name) => {
            const stat = await fs.stat(path.join(existing, ".acpx", "sessions", name));
            return [name, stat.size, stat.mtimeMs];
          }),
      ),
    );
  const before = await stamp();
  await withStateHome(existing, async () => {
    await assert.rejects(resolveSessionRecord("nobody"), (e: Error) => e.name !== "TypeError");
  });
  assert.equal(await stamp(), before, "an existing directory and everything in it are untouched");

  const missing = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-esd-missing-"));
  await withStateHome(missing, async () => {
    await assert.rejects(resolveSessionRecord("nobody"));
  });
  assert.equal(
    (await fs.stat(path.join(missing, ".acpx", "sessions"))).isDirectory(),
    true,
    "a missing dir is created, as before",
  );

  const inTheWay = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-esd-file-"));
  await fs.mkdir(path.join(inTheWay, ".acpx"), { recursive: true });
  await fs.writeFile(path.join(inTheWay, ".acpx", "sessions"), "i am a file");
  await withStateHome(inTheWay, async () => {
    await assert.rejects(resolveSessionRecord("nobody"), (e: NodeJS.ErrnoException) =>
      ["EEXIST", "ENOTDIR"].includes(String(e.code)),
    );
  });
});

// ======== K5 round 4, fix round 1 (the TE's FAIL: F2) and F1, F3, F4, F5, F6, F8 =======================================

const HOLDER = "88888888-0000-4000-8000-0000000000e8";
const SEAT_OF_HOLDER = "22222222-2222-4222-8222-2222222222bb";

async function seatStoreWith(home: string, holder: string | null): Promise<void> {
  await seedStore(home, [{ id: HOLDER, acp: "acp-holder" }]);
  await fs.writeFile(
    path.join(home, ".acpx", "sessions", "seats.json"),
    JSON.stringify({
      [SEAT_OF_HOLDER]: {
        seat_id: SEAT_OF_HOLDER,
        created_at: "2026-11-01T00:00:00.000Z",
        active_holder_id: holder,
        next_ordinal: 2,
        closed_at: null,
      },
    }),
  );
}

const truncate = (home: string, id: string): Promise<void> =>
  fs.writeFile(path.join(home, ".acpx", "sessions", `${id}.json`), '{"acpxRecordId":"8888');

test("F2 (seat's HOLDER mid-write): `status --seat` and `--session-url ?seat=` whose holder's record is truncated end in the door's refusal — never `Session not found: <holder>`", async () => {
  for (const argv of [
    ["claude", "status", "--seat", SEAT_OF_HOLDER],
    ["claude", "status", "--session-url", `https://atrium.example/?seat=${SEAT_OF_HOLDER}`],
  ]) {
    const rigged = await bothAnswer(argv, "text", {}, undefined, {
      pod: async (home) => {
        await seatStoreWith(home, HOLDER);
        await truncate(home, HOLDER);
      },
    });
    assertDoorRefusal(rigged.pod, `${argv.join(" ")}: the holder's record is mid-write`);
  }
  // TWIN: the holder's record whole — the child finds it, so atrium's not-found is contradicted: still the door's refusal
  const whole = await bothAnswer(
    ["claude", "status", "--seat", SEAT_OF_HOLDER],
    "text",
    {},
    undefined,
    {
      pod: (home) => seatStoreWith(home, HOLDER),
    },
  );
  assertDoorRefusal(whole.pod, "the holder is whole: the pod's own read contradicts atrium");
  // TWIN: the seat is nowhere in the pod's store — the seat's own not-found (exit 4), byte-equal to the control's
  const none = await bothAnswer(["claude", "status", "--seat", SEAT_OF_HOLDER], "text");
  assert.equal(none.pod.status, none.control.status, none.pod.stderr);
  assert.equal(normalise(none.pod.stderr, none.homes), normalise(none.control.stderr, none.homes));
});

test("F2 (a seat file that cannot be read): a truncated seats.json is never read as 'no such seat' — the door's refusal", async () => {
  const rigged = await bothAnswer(
    ["claude", "status", "--seat", SEAT_OF_HOLDER],
    "text",
    {},
    undefined,
    {
      pod: (home) => fs.writeFile(path.join(home, ".acpx", "sessions", "seats.json"), '{"2222'),
    },
  );
  assertDoorRefusal(rigged.pod, "seats.json mid-write");
});

test("F2 (set-parent's PARENT mid-write): `--parent-id <target>` whose record is truncated ends in the door's refusal — never `PARENT_NOT_FOUND`", async () => {
  const rigged = await bothAnswer(
    ["sessions", "set-parent", "--session-id", GHOST, "--parent-id", PARENT],
    "text",
    {},
    undefined,
    { pod: (home) => truncate(home, PARENT) },
  );
  assertDoorRefusal(rigged.pod, "the parent is mid-write");
  // TWIN: the parent whole — the true answer about the GHOST session, byte-equal to the control
  const whole = await bothAnswer(
    ["sessions", "set-parent", "--session-id", GHOST, "--parent-id", PARENT],
    "text",
  );
  assert.equal(whole.pod.status, whole.control.status, whole.pod.stderr);
  assert.equal(
    normalise(whole.pod.stderr, whole.homes),
    normalise(whole.control.stderr, whole.homes),
  );
});

test("F3: an armed process whose own read FOUND the record (or could not read it) never prints `Session not found` — a neutral 'differs' sentence, the parent told", async () => {
  const home = await copyOfTemplate();
  const plain = {
    PATH: process.env.PATH,
    HOME: home,
    ACPX_STATE_HOME: home,
    NODE_TEST_CONTEXT: "child",
  };
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const armed = (id: string): Promise<{ status: number | null; out: string; side: string }> =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["--permission", "--allow-fs-read=*", cli, "claude", "status", "--session-id", id],
        {
          env: {
            ...plain,
            ACPX_POD_TARGET_VERDICT: JSON.stringify({ values: [id], kind: "not-found" }),
          },
          stdio: ["ignore", "pipe", "pipe", "pipe"],
        },
      );
      let out = "";
      let side = "";
      child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
      child.stderr?.on("data", (c: Buffer) => (out += c.toString()));
      (child.stdio[3] as NodeJS.ReadableStream).on("data", (c: Buffer) => (side += c.toString()));
      child.on("close", (status) => resolve({ status, out, side }));
    });
  const found = await armed(POD_OWN); // the record EXISTS in this home
  assert.doesNotMatch(found.out, /Session not found/u, found.out);
  assert.match(found.side, /"event":"differs"/u);
  assert.match(found.out, /this pod's own read of the session store differs/u);
  await fs.writeFile(path.join(home, ".acpx", "sessions", `${SAME_TAIL}.json`), "{");
  const unreadable = await armed(SAME_TAIL);
  assert.doesNotMatch(unreadable.out, /Session not found/u, unreadable.out);
  assert.match(unreadable.side, /"event":"differs"/u);
  // CONTROL: an id that is really absent, in a store that reads cleanly elsewhere, IS a not-found (the verdict agrees)
  const home2 = await copyOfTemplate();
  const clean = await new Promise<{ out: string; side: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--permission", "--allow-fs-read=*", cli, "claude", "status", "--session-id", GHOST],
      {
        env: {
          PATH: process.env.PATH,
          HOME: home2,
          ACPX_STATE_HOME: home2,
          NODE_TEST_CONTEXT: "child",
          ACPX_POD_TARGET_VERDICT: JSON.stringify({ values: [GHOST], kind: "not-found" }),
        },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
    let out = "";
    let side = "";
    child.stderr?.on("data", (c: Buffer) => (out += c.toString()));
    (child.stdio[3] as NodeJS.ReadableStream).on("data", (c: Buffer) => (side += c.toString()));
    child.on("close", () => resolve({ out, side }));
  });
  assert.match(clean.out, /Session not found: /u);
  assert.doesNotMatch(clean.side, /"event":"differs"/u);
});

test('F5: a denial the handler PRINTS by message or SWALLOWS never reaches the answer — `people set-owner <p> --session ""` in the pod shape, and set-parent in a pod home with no `.acpx/sessions`, end in the door\'s refusal', async () => {
  const { brammertz } = await konsiqPair();
  // the pod's own ACPX_SESSION_URL names its own session (as in every agent pod): the empty --session falls back to it, and the owner WRITE is denied
  const owner = await bothAnswer(["people", "set-owner", brammertz.id, "--session", ""], "text");
  assert.notEqual(owner.pod.status, 0);
  assert.doesNotMatch(
    owner.pod.stdout + owner.pod.stderr,
    /Access to this API has been restricted/u,
  );
  assertDoorRefusal(owner.pod, 'people set-owner --session "" in the pod shape');
  for (const argv of [
    ["sessions", "set-parent", "--children-of", GHOST, "--parent-id", PARENT],
    ["sessions", "set-parent", "--session-id", GHOST, "--parent-id", PARENT],
  ]) {
    const none = await bothAnswer(argv, "text", {}, undefined, {
      pod: (home) => fs.rm(path.join(home, ".acpx"), { recursive: true, force: true }),
    });
    assert.doesNotMatch(
      none.pod.stdout + none.pod.stderr,
      /Access to this API has been restricted/u,
    );
    assertDoorRefusal(none.pod, `${argv.join(" ")} with no .acpx at all`);
  }
});

test("F8: a registry refusal (`set subscription|profile <unknown>`) is the POD's view of registry.json — the door's refusal, never relayed as the answer; with the SAME registry on both sides the line proceeds to the session lookup and is byte-equal", async () => {
  for (const argv of [
    ["claude", "set", "subscription", "alias-a", "--session-id", GHOST],
    ["claude", "set", "profile", "alias-a", "--session-id", GHOST],
  ]) {
    const registryOnControlOnly = await bothAnswer(argv, "text", {}, undefined, {
      control: async (home) => {
        await fs.mkdir(path.join(home, ".acpx", "subscriptions"), { recursive: true });
        await fs.writeFile(
          path.join(home, ".acpx", "subscriptions", "registry.json"),
          JSON.stringify({
            version: 3,
            subscriptions: [{ id: "alias-a", label: "A", configDir: "/tmp/alias-a" }],
            profiles: [{ id: "alias-a", subscriptionId: "alias-a" }],
          }),
        );
      },
    });
    assert.equal(registryOnControlOnly.pod.status, 2, registryOnControlOnly.pod.stderr);
    assert.match(registryOnControlOnly.pod.stderr.split("\n")[0] ?? "", /pass_through_refused/u);
    assert.doesNotMatch(
      registryOnControlOnly.pod.stderr + registryOnControlOnly.pod.stdout,
      /not found in registry/u,
    );
  }
});

test("F6: with the pod home's index MISSING the armed child prints the rebuild note ONCE, as the control pod does (it rebuilds in memory on every load and may not persist)", async () => {
  const noIndex = (home: string): Promise<void> =>
    fs.rm(path.join(home, ".acpx", "sessions", "index.json"), { force: true });
  for (const argv of [
    ["sessions", "set-parent", "--children-of", GHOST, "--parent-id", PARENT],
    ["claude", "status", "--session-id", GHOST],
  ]) {
    const rigged = await bothAnswer(argv, "text", {}, undefined, {
      control: noIndex,
      pod: noIndex,
    });
    const notes = (text: string): number =>
      text.split("\n").filter((l) => l.startsWith("[acpx] full session-index rebuild")).length;
    assert.equal(notes(rigged.control.stderr), 1, "the measure: the control pod says it once");
    assert.equal(notes(rigged.pod.stderr), 1, `${argv.join(" ")}: ${rigged.pod.stderr}`);
    assert.equal(rigged.pod.status, rigged.control.status);
  }
});

// ---- F1: the child cannot be handed a write grant --------------------------------------------------------------------

test("F1: a path-scoped write grant, wasi or addons given to the child by FLAGS keep the door's refusal; the child's own check (not just the path-less `has('fs.write')`) is what refuses", async () => {
  const grants: Array<[string, (home: string) => string]> = [
    [
      "a write grant on the store",
      (home) =>
        `--permission --allow-fs-read=* --allow-fs-write=${path.join(home, ".acpx", "sessions")}`,
    ],
    [
      "a write grant on the state home",
      (home) => `--permission --allow-fs-read=* --allow-fs-write=${path.join(home, ".acpx")}`,
    ],
    [
      "a write grant on the home",
      (home) => `--permission --allow-fs-read=* --allow-fs-write=${home}`,
    ],
    [
      "a write grant on the working directory's parent",
      (home) => `--permission --allow-fs-read=* --allow-fs-write=${path.dirname(home)}`,
    ],
    ["wasi", () => "--permission --allow-fs-read=* --allow-wasi"],
    ["addons", () => "--permission --allow-fs-read=* --allow-addons"],
  ];
  for (const [name, flags] of grants) {
    const { run } = await runWithRealChild(flags);
    assertDoorRefusal(run, name);
  }
});

test("F1: the same grants reaching the child through NODE_OPTIONS (the parent's own removal defeated by a test seam) are refused by the CHILD's own checks; and in the ordinary path NODE_OPTIONS is REMOVED from the child", async () => {
  const viaOptions: Array<[string, (home: string) => string]> = [
    [
      "a write grant on the store",
      (home) => `--allow-fs-write=${path.join(home, ".acpx", "sessions")}`,
    ],
    ["wasi", () => "--allow-wasi"],
    ["addons", () => "--allow-addons"],
    ["write everywhere", () => "--allow-fs-write=*"],
  ];
  for (const [name, options] of viaOptions) {
    const { run } = await runWithRealChild("--permission --allow-fs-read=*", (home) => ({
      ACPX_POD_VERDICT_CHILD_NODE_OPTIONS: options(home),
    }));
    assertDoorRefusal(run, `${name} through NODE_OPTIONS`);
  }
  // the ordinary path: the pod's NODE_OPTIONS never reaches the child. (A pod environment that itself carried an
  // `--allow-*` option could not even start acpx — Node refuses it without `--permission` — so the carried value here
  // is a harmless one, and a well-behaved fixture child reports what it was given.)
  const seen = await runWithFixture(
    fixtureSource(
      `process.stderr.write("NODE_OPTIONS=" + (process.env.NODE_OPTIONS ?? "<removed>") + "\\n" + sessionNotFound); process.exit(4);`,
    ),
    { NODE_OPTIONS: "--max-old-space-size=300" },
  );
  assert.equal(seen.run.status, 4, seen.run.stderr);
  assert.match(
    seen.run.stderr,
    /NODE_OPTIONS=<removed>/u,
    "the child's environment has no NODE_OPTIONS",
  );
});

// ---- F2: the REAL race — a non-atomic writer against armed lookups, in process ------------------------------------

const RACE_TARGET = "77777777-0000-4000-8000-0000000000c7";
const RACE_ACP = "acp-race-target";
const RACE_SELECTORS: Array<[string, string]> = [
  ["id", RACE_TARGET],
  ["suffix", "0000000000c7"],
  ["ACP id", RACE_ACP],
];
const RACE_LOOKUPS = 500;

const WRITER_SOURCE = `import fs from "node:fs";
const [file, text] = process.argv.slice(2);
process.on("SIGTERM", () => process.exit(0));
for (;;) { fs.writeFileSync(file, text); }
`;

/** One selector, `RACE_LOOKUPS` armed lookups against a record rewritten NON-ATOMICALLY, never settling; the number relayed as not-found. */
async function raceRelays(
  selector: string,
  evidence: boolean,
  cap = RACE_LOOKUPS,
): Promise<{ wrong: number; lookups: number; writerStarted: boolean }> {
  const home = await copyOfTemplate();
  await seedStore(home, [{ id: RACE_TARGET, acp: RACE_ACP }]);
  const index = await runCli(
    ["sessions", "reindex"],
    { PATH: process.env.PATH, HOME: home, ACPX_STATE_HOME: home, NODE_TEST_CONTEXT: "child" },
    { cwd: home },
  );
  assert.equal(index.status, 0, index.stderr);
  const file = path.join(home, ".acpx", "sessions", `${RACE_TARGET}.json`);
  const whole = await fs.readFile(file, "utf8");
  const script = path.join(home, "writer.mjs");
  await fs.writeFile(script, WRITER_SOURCE);
  const writer = spawn(process.execPath, [script, file, whole], { stdio: "ignore" });
  const restore = evidence ? installReadEvidenceOnly() : () => undefined;
  let wrong = 0;
  let lookups = 0;
  try {
    await withStateHome(home, async () => {
      for (; lookups < cap; lookups += 1) {
        disarmTargetVerdictForTests();
        armTargetVerdict({ values: [selector], kind: "not-found" });
        await resolveSessionRecord(selector).catch(() => undefined);
        const told = toldEvents();
        if (told.has("verdict") && !told.has("differs")) {
          wrong += 1; // a not-found the child would have CONFIRMED, for a record that exists throughout
        }
        if (!evidence && wrong > 0) {
          lookups += 1;
          break;
        }
      }
    });
  } finally {
    restore();
    disarmTargetVerdictForTests();
    writer.kill("SIGKILL");
  }
  return { wrong, lookups, writerStarted: writer.pid !== undefined };
}

test(`F2 (the real race): ${RACE_LOOKUPS} armed lookups per selector kind against a non-atomic writer loop — ZERO wrong not-founds with the read evidence`, async () => {
  for (const [kind, selector] of RACE_SELECTORS) {
    const armedRun = await raceRelays(selector, true);
    assert.equal(armedRun.writerStarted, true);
    assert.equal(armedRun.lookups, RACE_LOOKUPS, kind);
    assert.equal(
      armedRun.wrong,
      0,
      `${kind}: ${armedRun.wrong} of ${armedRun.lookups} relayed a not-found for a record that exists`,
    );
  }
});

test("F2 (the race can fail): the SAME loop WITHOUT the read evidence relays a wrong not-found — the suffix selector, TE-measured at 21–29 %, within a few thousand lookups", async () => {
  const control = await raceRelays("0000000000c7", false, 4000);
  assert.ok(
    control.wrong > 0,
    `no wrong not-found in ${control.lookups} lookups without the evidence: the race does not bite here, so the row above proves nothing`,
  );
});
