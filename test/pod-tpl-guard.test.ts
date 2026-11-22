import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { COMMAND_TABLE } from "../src/pod/command-classes.js";
import { routeFor } from "../src/pod/placement-step.js";
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
  "sessions reopen": { prepare: async () => ["sessions", "reopen", POD_SESSION] },
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
    await withAtrium({}, async (atrium) => {
      const r = await runCli(argv, agentPodEnv(home, atrium.url));
      assert.doesNotMatch(r.stderr, GUARD, `${commandPath}: ${r.stderr}`);
      assert.equal(r.status, 0, `${commandPath} did not reach its write: ${r.stderr}`);
      assert.equal(callsOf(atrium).length, 0, `${commandPath} stayed local`);
    });
  }
});
