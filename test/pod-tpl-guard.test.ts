import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { classifyArgv, COMMAND_TABLE } from "../src/pod/command-classes.js";
import { ownTargetRecordId } from "../src/pod/own-target.js";
import { routeFor } from "../src/pod/placement-step.js";
import { agentPodName } from "../src/pod/placement.js";
import { konsiqPair, peopleDocument } from "./people-test-helpers.js";
import {
  addRecord,
  agentPodEnv,
  agentPodHome,
  OTHER_SESSION,
  POD_SESSION,
  runCli,
} from "./pod-a3-helpers.js";
import { startRecordedAtrium } from "./pod-kit/recorded-atrium.js";
import type { AtriumScript, RecordedAtrium } from "./pod-kit/recorded-atrium.js";
import { makeSessionRecord, writeSessionRecordFile } from "./runtime-test-helpers.js";

// brick 3fda4443 — `acpx sessions template <own id>` in an agent pod tripped `pod_foreign_write
// file=index`: marking a template assigns the slug's next VERSION from every entry of the box's index,
// under the index lock — a box-wide read-modify-write, not a write of the pod's own record. It is a
// control-store verb: from a pod it passes through to the control pod (C1.2, A-8).

const GUARD = /reason=pod_foreign_write/u;

async function withAtrium(script: AtriumScript, run: (atrium: RecordedAtrium) => Promise<void>) {
  const atrium = await startRecordedAtrium(script);
  try {
    await run(atrium);
  } finally {
    await atrium.close();
  }
}

const callsOf = (atrium: RecordedAtrium) => atrium.requests.filter((r) => r.route === "call");

test("`sessions template <own id>` in an agent pod passes through to the control pod and trips no guard", async () => {
  const { home } = agentPodHome();
  await addRecord(home, POD_SESSION, "bbbbbbbb-0000-4000-8000-0000000000b1");
  await withAtrium(
    { calls: [{ answer: { exit: 0, stdout: "templated\n", stderr: "" } }] },
    async (atrium) => {
      const r = await runCli(
        ["sessions", "template", POD_SESSION, "--slug", "tpl"],
        agentPodEnv(home, atrium.url),
      );
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, GUARD);
      assert.equal(r.stdout, "templated\n", "the control pod's answer, verbatim");
      const calls = callsOf(atrium);
      assert.equal(calls.length, 1, "one call home");
      assert.deepEqual(calls[0]?.body?.argv, [
        "sessions",
        "template",
        POD_SESSION,
        "--slug",
        "tpl",
      ]);
    },
  );
});

test("the class: `sessions template` is control-store, and passes through in BOTH agent-pod places (own id or another)", () => {
  const entry = COMMAND_TABLE["sessions template"];
  assert.equal(entry?.class, "control-store");
  for (const place of ["own-pod", "other-pod"] as const) {
    assert.notEqual(routeFor(entry.class, place).kind, "local", place);
  }
});

// ---- the conformance row: no classified command that stays local on the pod's OWN id trips the guard ----

/**
 * One invocation per `record`-class path, about the pod's own session — the class that runs locally on
 * its own pod and writes its record. DISCOVERED: the paths come from the real class table, and a path
 * with no entry here fails the first assertion, so a new `record` command cannot slip in unexercised.
 * Each invocation is set up to REACH ITS WRITE (the test asserts exit 0): a verb that stopped at a usage
 * error or an unknown operand would pass the guard check vacuously.
 */
type OwnIdCase = {
  /** Seeds what the verb needs beside the pod's own record, returning the argv. */
  prepare: (home: string) => Promise<string[]>;
};
const OWN_ID_CASES: Readonly<Record<string, OwnIdCase>> = {
  "sessions reopen": {
    // Seeded CLOSED (T1): reopening an OPEN record writes nothing, so the row would pass without reaching a write.
    prepare: async (home) => {
      await writeSessionRecordFile(
        home,
        makeSessionRecord({
          acpxRecordId: POD_SESSION,
          acpSessionId: "bbbbbbbb-0000-4000-8000-0000000000b2",
          agentCommand: "agent",
          cwd: home,
          closed: true,
          closedAt: "2026-11-01T00:00:00.000Z",
        }),
      );
      return ["sessions", "reopen", POD_SESSION];
    },
  },
  "sessions set-metadata": {
    prepare: async () => ["sessions", "set-metadata", "--session-id", POD_SESSION, "k", "v"],
  },
  "sessions set-os": { prepare: async () => ["sessions", "set-os", POD_SESSION, "default"] },
  "sessions set-parent": {
    prepare: async (home) => {
      await addRecord(home, OTHER_SESSION, "bbbbbbbb-0000-4000-8000-0000000000b3");
      return ["sessions", "set-parent", "--session-id", POD_SESSION, "--parent-id", OTHER_SESSION];
    },
  },
  "people set-owner": {
    prepare: async (home) => {
      const { brammertz, laatz } = await konsiqPair();
      await fs.mkdir(path.join(home, ".acpx"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".acpx", "people.json"),
        peopleDocument([brammertz, laatz]),
        "utf8",
      );
      return ["people", "set-owner", brammertz.id, "--session", POD_SESSION];
    },
  },
};

const recordPaths = (): string[] =>
  Object.entries(COMMAND_TABLE)
    .filter(([, entry]) => entry.class === "record")
    .map(([commandPath]) => commandPath)
    .toSorted();

test("A-8 conformance: every `record`-class command has an own-id invocation here (a fresh one is flagged)", () => {
  assert.deepEqual(recordPaths(), Object.keys(OWN_ID_CASES).toSorted());
  // negative: the discovery flags a path the table lacks (the check is not a list of what it checks)
  const fresh = [...recordPaths(), "sessions brand-new-record-verb"].toSorted();
  assert.notDeepEqual(fresh, Object.keys(OWN_ID_CASES).toSorted());
});

test("A-8 conformance: no `record`-class command about the pod's OWN id trips pod_foreign_write — and each reached its write", async () => {
  for (const commandPath of recordPaths()) {
    const testCase = OWN_ID_CASES[commandPath];
    assert.ok(testCase, commandPath);
    const { home } = agentPodHome();
    await addRecord(home, POD_SESSION, "bbbbbbbb-0000-4000-8000-0000000000b2");
    const argv = await testCase.prepare(home);
    const ownRecord = path.join(home, ".acpx", "sessions", `${POD_SESSION}.json`);
    const before = await fs.readFile(ownRecord, "utf8");
    await withAtrium({}, async (atrium) => {
      const r = await runCli(argv, agentPodEnv(home, atrium.url));
      assert.doesNotMatch(r.stderr, GUARD, `${commandPath}: ${r.stderr}`);
      assert.equal(r.status, 0, `${commandPath} did not reach its write: ${r.stderr}`);
      assert.equal(callsOf(atrium).length, 0, `${commandPath} stayed local`);
    });
    // T1: the exit code alone passes a verb that stopped before its write — the own record's BYTES must have moved.
    // (`people set-owner` writes the person's owner onto the session record, so it moves it too.)
    assert.notEqual(
      await fs.readFile(ownRecord, "utf8"),
      before,
      `${commandPath}: the pod's own record was not written — the row is vacuous`,
    );
  }
});

// ---- T3 (brick c2b7358d): `sessions set-parent --children-of <id>` from an agent pod ----

test("T3: `--children-of` SELECTS its target in the class table", () => {
  const classified = classifyArgv(
    ["sessions", "set-parent", "--children-of", OTHER_SESSION, "--parent-id", POD_SESSION],
    {
      builtInAgents: ["claude"],
    },
  );
  assert.equal(classified.kind, "classified");
  if (classified.kind === "classified") {
    assert.equal(classified.class, "record");
    assert.deepEqual(classified.target, {
      via: "flag",
      flag: "--children-of",
      value: OTHER_SESSION,
    });
  }
  // The negative that was the bug: before, no selector was named, so atrium could not resolve a target at all.
  assert.deepEqual(
    COMMAND_TABLE["sessions set-parent"]?.target?.flags.includes("--children-of"),
    true,
  );
});

test("T3: from a pod `--children-of` is NEVER own — not even when the parent is the pod's own session — while `--session-id <own>` still is", async () => {
  const { home, podName } = agentPodHome();
  await addRecord(home, POD_SESSION, "bbbbbbbb-0000-4000-8000-0000000000b2");
  const sessionsDir = path.join(home, ".acpx", "sessions");
  assert.equal(podName, agentPodName(POD_SESSION));
  const target = (flag: string) => ({ via: "flag" as const, flag, value: POD_SESSION });
  assert.equal(ownTargetRecordId(target("--children-of"), podName, sessionsDir), null);
  // The control: the same value under `--session-id` IS the pod's own record.
  assert.equal(ownTargetRecordId(target("--session-id"), podName, sessionsDir), POD_SESSION);
});

test("T3 on the real CLI in an agent pod: `set-parent --children-of <other parent>` passes through to atrium verbatim, writes nothing locally and trips no guard; with the pod's OWN session as the parent atrium refuses it by name (own-session) — neither local nor passed; an unresolvable parent is refused by name", async () => {
  // (1) another parent: passed through, answered by atrium.
  const { home } = agentPodHome();
  await addRecord(home, POD_SESSION, "bbbbbbbb-0000-4000-8000-0000000000b2");
  await addRecord(home, OTHER_SESSION, "bbbbbbbb-0000-4000-8000-0000000000b3");
  const ownRecord = path.join(home, ".acpx", "sessions", `${POD_SESSION}.json`);
  const before = await fs.readFile(ownRecord, "utf8");
  await withAtrium(
    {
      resolveTargetAs: OTHER_SESSION,
      calls: [{ answer: { exit: 0, stdout: "rewrote 2\n", stderr: "" } }],
    },
    async (atrium) => {
      const argv = [
        "sessions",
        "set-parent",
        "--children-of",
        OTHER_SESSION,
        "--parent-id",
        POD_SESSION,
      ];
      const r = await runCli(argv, agentPodEnv(home, atrium.url));
      assert.doesNotMatch(r.stderr, GUARD, r.stderr);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, "rewrote 2\n", "atrium's answer, verbatim");
      const [call] = callsOf(atrium);
      assert.deepEqual(call?.body?.argv, argv);
      assert.equal(callsOf(atrium).length, 1);
    },
  );
  assert.equal(await fs.readFile(ownRecord, "utf8"), before, "nothing was written in the pod");
  // (2) the pod's OWN session as the parent: it writes OTHER sessions' records, so acpx never runs it locally;
  // atrium refuses a passed-through command about the caller's own session (`own-session`). A named refusal, not a
  // guard trip and not a write — reported as a limit (brick c2b7358d).
  await withAtrium({ resolveTargetAs: POD_SESSION }, async (atrium) => {
    const r = await runCli(
      ["sessions", "set-parent", "--children-of", POD_SESSION, "--parent-id", OTHER_SESSION],
      agentPodEnv(home, atrium.url),
    );
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stderr, GUARD, r.stderr);
    assert.match(r.stderr, /class-not-passable detail=own-session/u, r.stderr);
  });
  assert.equal(await fs.readFile(ownRecord, "utf8"), before, "and nothing was written");
  // (3) Unresolvable parent (the kit's atrium resolves nothing without `resolveTargetAs`): it answers what the control
  // pod answers (K5, brick 75956474) — `set-parent: SESSION_NOT_FOUND: --children-of refers to unknown session`, exit 4,
  // a not-found and not a policy refusal — and nothing runs. The control's wording is measured in
  // `test/pod-not-found.test.ts` ("sessions set-parent --children-of"), which compares the whole answer.
  await withAtrium(
    { calls: [{ answer: { exit: 0, stdout: "must-not-run\n", stderr: "" } }] },
    async (atrium) => {
      const r = await runCli(
        [
          "sessions",
          "set-parent",
          "--children-of",
          "cccccccc-0000-4000-8000-0000000000ee",
          "--parent-id",
          POD_SESSION,
        ],
        agentPodEnv(home, atrium.url),
      );
      assert.equal(r.status, 4, r.stderr);
      assert.match(
        r.stderr,
        /^set-parent: SESSION_NOT_FOUND: --children-of refers to unknown session: cccccccc-0000-4000-8000-0000000000ee\n/u,
        r.stderr,
      );
      assert.doesNotMatch(r.stderr, /pass_through_refused|class-not-passable/u);
      assert.equal(r.stdout.includes("must-not-run"), false);
    },
  );
});

// ---- T2 (brick c2b7358d): every class that runs LOCALLY on the pod's own id, not only `record` ----

/**
 * The classes whose own-pod route is LOCAL (`routeFor(class, "own-pod")`): they run in the pod on the pod's own id
 * and must never trip the foreign-write guard (A-8). Measured when this row was written: none does — this pins it.
 * DISCOVERED like the `record` row: the paths come from the real class table, and a path with neither an invocation
 * nor a named exemption fails the first assertion, so a new command cannot slip in unexercised. An invocation is
 * not asked to SUCCEED (a read of nothing may exit non-zero); it is asked not to trip the guard and not to leave
 * the pod (no passed-through call).
 */
const LOCAL_ON_OWN_ID = ["read", "owner-ensure", "owner-if-pod", "one-shot", "local"] as const;
const NONE = "00000000-0000-4000-8000-00000000000a";

const OWN_ID_INVOCATIONS: Readonly<Record<string, string[]>> = {
  // read
  "sessions templates": ["sessions", "templates"],
  "sessions show": ["sessions", "show", "--session-id", POD_SESSION],
  "sessions history": ["sessions", "history", "--session-id", POD_SESSION],
  "sessions read": ["sessions", "read", "--session-id", POD_SESSION],
  "sessions export": ["sessions", "export", "--session-id", POD_SESSION, "--output", "export.json"],
  "seats show": ["seats", "show", NONE],
  "seats list": ["seats", "list"],
  subscriptions: ["subscriptions"],
  "subscriptions list": ["subscriptions", "list"],
  "subscriptions usage": ["subscriptions", "usage"],
  "subscriptions ceiling show": ["subscriptions", "ceiling", "show"],
  profiles: ["profiles"],
  "profiles list": ["profiles", "list"],
  "profiles show": ["profiles", "show", "nosuch"],
  agents: ["agents"],
  "agents list": ["agents", "list"],
  "agents show": ["agents", "show", "claude"],
  models: ["models"],
  "models list": ["models", "list"],
  "models show": ["models", "show", "claude-subscription:opus"],
  "providers list": ["providers", "list"],
  "people list": ["people", "list"],
  "people resolve": ["people", "resolve", "nobody"],
  "people principal": ["people", "principal", "--session", POD_SESSION],
  config: ["config"],
  "config show": ["config", "show"],
  // owner-if-pod, about the pod's own session
  cancel: ["cancel", "--session-id", POD_SESSION],
  "set-mode": ["set-mode", "--session-id", POD_SESSION, "default"],
  set: ["set", "--session-id", POD_SESSION, "model", "opus"],
  status: ["status", "--session-id", POD_SESSION],
  "sessions close": ["sessions", "close", "--session-id", POD_SESSION],
  "sessions recover": ["sessions", "recover", POD_SESSION],
  "sessions owner-status": ["sessions", "owner-status", POD_SESSION],
  // one-shot: the forms that answer from records and start no adapter
  "output-styles": ["output-styles", "--session-id", POD_SESSION],
  sessions: ["sessions", "--local"],
  "sessions list": ["sessions", "list", "--local"],
  // local: groups print their help
  seats: ["seats"],
  "agent-folders": ["agent-folders"],
  transcripts: ["transcripts"],
  "subscriptions ceiling": ["subscriptions", "ceiling"],
  providers: ["providers"],
  people: ["people"],
  governor: ["governor"],
  box: ["box"],
  flow: ["flow"],
  help: ["seats", "help"],
};

/** Paths that cannot be driven here, each with the reason — and where the own-id rule for them is held instead. */
const OWN_UNHELD =
  "A-8's no-pod_foreign_write property for this verb in its OWN pod is NOT held on agent-pods yet — " +
  "a prompt starts the pod's owner and an adapter, which this rig cannot drive; pod-owner-guard.test.ts holds the " +
  "owner-ENTRY guard (a different property), not this one. A9's test/pod-wake-own-pod.test.ts (sentinel adapter) " +
  "will hold it once A9 lands; until then the row is open.";
const OWN_ID_EXEMPT: Readonly<Record<string, string>> = {
  "": `bare \`acpx <text>\` is a prompt. ${OWN_UNHELD}`,
  prompt: OWN_UNHELD,
  "<agent>": `the same prompt, through the agent form. ${OWN_UNHELD}`,
  exec: "spawns an adapter for a one-shot",
  "model-catalogue": "spawns an adapter unless a record answers (held by pod-a10-probes.test.ts)",
  "flow run": "runs ACP nodes: spawns an adapter",
  "models endpoints":
    "an HTTP fetch from a vendor; it writes a cache file under ~/.acpx/endpoints (not a guarded file)",
  "governor status": "reads the box's process table (control-pod machinery)",
  "governor scan": "walks the box's process table (control-pod machinery)",
  "capacity run-build": "starts a build",
};

/**
 * What each invocation must DO for the row to mean anything (brick 27b28c68, L-T2-1): an invocation that dies
 * before its body — a flag commander does not know, a usage error — passes "no guard, no call" while exercising
 * nothing. So each names the exit status it reaches and, for a non-zero or silent one, a line that only the BODY
 * prints (`reached`); `writes` marks the verbs that write the pod's own record (its bytes must move — and for every
 * other invocation they must NOT).
 */
type OwnIdOutcome = {
  status: number;
  /** A line only the body prints (searched in stdout + stderr). EVERY row names one — status 0 alone is not proof (F-2). */
  reached: RegExp;
  /** A group's (or `help`'s) own usage: the only rows allowed to print `Usage: acpx …` on stdout. */
  group?: true;
  writes?: true;
};
const USAGE = (group: string): RegExp => new RegExp(`Usage: acpx ${group} \\[options\\]`, "u");
const POD_ID = new RegExp(POD_SESSION, "u");
const OWN_ID_OUTCOMES: Readonly<Record<string, OwnIdOutcome>> = {
  "sessions templates": { status: 0, reached: /No sessions/u },
  "sessions show": { status: 0, reached: new RegExp(`id: ${POD_SESSION}`, "u") },
  "sessions history": { status: 0, reached: /\(0\/0 shown\)/u },
  "sessions read": { status: 0, reached: /\(0\/0 shown\)/u },
  "sessions export": { status: 0, reached: /exported session to export\.json/u },
  "seats show": { status: 1, reached: /SEAT_ROW_MISSING/u },
  // `seats list` of an empty box prints nothing; the line below is the index load its body does first.
  "seats list": { status: 0, reached: /full session-index rebuild/u },
  subscriptions: { status: 0, reached: /No subscriptions registered/u },
  "subscriptions list": { status: 0, reached: /No subscriptions registered/u },
  "subscriptions usage": { status: 0, reached: /No subscriptions registered/u },
  "subscriptions ceiling show": { status: 0, reached: /Registry default: /u },
  profiles: { status: 0, reached: /No profiles registered/u },
  "profiles list": { status: 0, reached: /No profiles registered/u },
  "profiles show": { status: 1, reached: /profile "nosuch" not found/u },
  agents: { status: 0, reached: /Harness capabilities, declared in acpx/u },
  "agents list": { status: 0, reached: /Harness capabilities, declared in acpx/u },
  "agents show": { status: 0, reached: /claude {2}\(claude\)/u },
  models: { status: 0, reached: /ON YOUR SUBSCRIPTION/u },
  "models list": { status: 0, reached: /ON YOUR SUBSCRIPTION/u },
  "models show": { status: 0, reached: /key {9}claude-subscription:opus/u },
  "providers list": { status: 0, reached: /no box provider credentials/u },
  "people list": { status: 0, reached: /no people are registered/u },
  "people resolve": { status: 3, reached: /no person matches/u },
  "people principal": { status: 6, reached: /not recorded/u },
  config: { status: 0, reached: /"/u },
  "config show": { status: 0, reached: /"/u },
  cancel: { status: 0, reached: /nothing to cancel/u },
  "set-mode": { status: 1, reached: /Failed to spawn agent command/u, writes: true },
  set: { status: 1, reached: /Failed to spawn agent command/u, writes: true },
  status: { status: 0, reached: new RegExp(`session: ${POD_SESSION}`, "u") },
  "sessions close": { status: 0, reached: POD_ID, writes: true },
  "sessions recover": { status: 0, reached: /no queue owner found/u },
  "sessions owner-status": { status: 0, reached: /"ownerFound":false/u },
  "output-styles": { status: 0, reached: /does not support output styles/u },
  sessions: { status: 0, reached: /No sessions/u },
  "sessions list": { status: 0, reached: /No sessions/u },
  seats: { status: 1, reached: USAGE("seats"), group: true },
  "agent-folders": { status: 1, reached: USAGE("agent-folders"), group: true },
  transcripts: { status: 1, reached: USAGE("transcripts"), group: true },
  "subscriptions ceiling": { status: 1, reached: USAGE("subscriptions ceiling"), group: true },
  providers: { status: 0, reached: /no box provider credentials/u },
  people: { status: 2, reached: USAGE("people"), group: true },
  governor: { status: 1, reached: USAGE("governor"), group: true },
  box: { status: 1, reached: USAGE("box"), group: true },
  flow: { status: 1, reached: USAGE("flow"), group: true },
  help: { status: 0, reached: USAGE("seats"), group: true },
};

const ownIdPaths = (): string[] =>
  Object.entries(COMMAND_TABLE)
    .filter(([, entry]) => (LOCAL_ON_OWN_ID as readonly string[]).includes(entry.class))
    .map(([commandPath]) => commandPath)
    .toSorted();

test("T2 conformance: every command of a locally-running class has an own-id invocation or a named exemption (a fresh one is flagged)", () => {
  const known = [...Object.keys(OWN_ID_INVOCATIONS), ...Object.keys(OWN_ID_EXEMPT)].toSorted();
  assert.deepEqual(ownIdPaths(), known);
  assert.deepEqual(
    Object.keys(OWN_ID_EXEMPT).filter(
      (commandPath) => OWN_ID_INVOCATIONS[commandPath] !== undefined,
    ),
    [],
    "a path is driven or exempt, not both",
  );
  assert.deepEqual(
    Object.keys(OWN_ID_OUTCOMES).toSorted(),
    Object.keys(OWN_ID_INVOCATIONS).toSorted(),
    "every invocation says what it must reach",
  );
  const fresh = [...ownIdPaths(), "sessions brand-new-read-verb"].toSorted();
  assert.notDeepEqual(fresh, known, "the discovery flags a path the registry lacks");
  // the classes really are the ones that run locally on the own pod (the premise of this row)
  for (const cls of LOCAL_ON_OWN_ID) {
    assert.equal(routeFor(cls, "own-pod", cls === "one-shot").kind, "local", cls);
  }
});

test("T2 conformance: no command of a locally-running class about the pod's OWN id trips pod_foreign_write or leaves the pod — and each REACHES ITS BODY (its exit status, a body-only line, the own record moved or not)", async () => {
  for (const [commandPath, argv] of Object.entries(OWN_ID_INVOCATIONS)) {
    const outcome = OWN_ID_OUTCOMES[commandPath];
    assert.ok(outcome, commandPath);
    const { home } = agentPodHome();
    await addRecord(home, POD_SESSION, "bbbbbbbb-0000-4000-8000-0000000000b2");
    const ownRecord = path.join(home, ".acpx", "sessions", `${POD_SESSION}.json`);
    const before = await fs.readFile(ownRecord, "utf8");
    await withAtrium({}, async (atrium) => {
      // F-5 (a): the admission ledger where PRODUCTION puts it — under the pod's canonical home — not the suite's /tmp
      // seam (`scripts/run-tests.mjs` sets `ACPX_ADMISSION_DIR` for the whole run, which hides a verb that writes the
      // box-wide ledger from an agent pod: K1, A9's 582e4292).
      const env = agentPodEnv(home, atrium.url, {
        ACPX_ADMISSION_DIR: path.join(home, ".acpx", "admission"),
      });
      const r = await runCli(argv, env, { cwd: home, timeoutMs: 60_000 });
      const said = `${r.stdout}\n${r.stderr}`;
      assert.notEqual(r.status, null, `${commandPath}: answered, not killed`);
      assert.doesNotMatch(said, GUARD, `${commandPath}: ${said}`);
      assert.equal(callsOf(atrium).length, 0, `${commandPath} stayed in the pod`);
      // The body, not the front door: commander's refusal of an unknown flag or a missing operand is not it.
      assert.doesNotMatch(
        r.stderr,
        /unknown option|unknown command|missing required argument|too many arguments/u,
        `${commandPath} died at commander before its body: ${r.stderr}`,
      );
      assert.equal(r.status, outcome.status, `${commandPath}: ${said}`);
      assert.match(said, outcome.reached, `${commandPath} did not print what only its body prints`);
      // F-2: `--help` is the one commander exit that is 0. A non-group path that printed its usage on stdout stopped
      // at the front door (a group, and `help`, print theirs by design).
      if (outcome.group !== true) {
        assert.doesNotMatch(
          r.stdout,
          /^Usage: acpx /mu,
          `${commandPath} printed its usage instead of running`,
        );
      }
    });
    const after = await fs.readFile(ownRecord, "utf8");
    assert.equal(
      after !== before,
      outcome.writes === true,
      `${commandPath}: the own record ${outcome.writes === true ? "must have been written" : "must be untouched"}`,
    );
  }
});
