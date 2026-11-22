import assert from "node:assert/strict";
import test from "node:test";
import { classifyArgv } from "../src/pod/command-classes.js";
import { RoutedCallError } from "../src/pod/pod-refusal.js";
import {
  routedBranchHandlers,
  type BranchDeps,
  type RoutedRecord,
} from "../src/pod/routed-branches.js";
import { agentPodKey } from "../src/pod/routed-call.js";

// Block A4 (brick 30df3a5b), C2/C4: an EXPLICIT `close` or `recover` whose routed call found the pod
// Ready-but-unreachable (`ROUTED outcome=not_run reason=agent_unreachable`, past the 60 s bound) deletes
// it through the broker with the pod's uid as the precondition, then answers from the record. Nothing
// else deletes a pod because it cannot be reached (A-1).

const SESSION = "11111111-1111-4111-8111-111111111111";
const POD_UID = "33333333-3333-4333-8333-333333333333";
const KEY = agentPodKey(SESSION);
const RECORD: RoutedRecord = {
  acpxRecordId: SESSION,
  agentCommand: "node /opt/claude-agent-acp/dist/index.js",
};

const unreachable = () =>
  new RoutedCallError({ outcome: "not_run", reason: "agent_unreachable", callId: "c1" });

type Rig = {
  deps: BranchDeps;
  deletes: { key: string; uid: string }[];
  failures: unknown[];
};

function rig(options: {
  error?: Error;
  lookup?: Awaited<ReturnType<BranchDeps["lookup"]>>;
  deleteKind?: "deleted" | "refused" | "unavailable";
  withDelete?: boolean;
}): Rig {
  const state: Rig = { deps: undefined as unknown as BranchDeps, deletes: [], failures: [] };
  state.deps = {
    argv: () => [],
    env: { PATH: "/usr/bin" },
    cwd: () => "/workspace",
    isTty: () => false,
    readStdin: async () => "",
    resolveTarget: async () => SESSION,
    loadRecord: async () => RECORD,
    harnessOf: () => "claude",
    lookup: async () => options.lookup ?? { state: "exists", uid: POD_UID, ready: true },
    releases: () => ({ ok: true, releases: { acpx: "r1" } }),
    admissionClass: () => "delivery",
    run: async () => {
      throw options.error ?? unreachable();
    },
    fail: async (error) => {
      state.failures.push(error);
      return 1;
    },
    stderr: () => undefined,
    ...(options.withDelete === false
      ? {}
      : {
          deleteAgent: async (key: string, uid: string) => {
            state.deletes.push({ key, uid });
            return { kind: options.deleteKind ?? "deleted" };
          },
        }),
  };
  return state;
}

function decision(argv: string[]) {
  const classification = classifyArgv(argv, { builtInAgents: ["claude", "pi", "codex"] });
  assert.equal(classification.kind, "classified");
  return {
    kind: "branch" as const,
    branch: "routed-if-pod" as const,
    classification,
    place: "control" as const,
    output: classification.output,
  };
}

const context = { argv: [] as string[], write: () => undefined, writeStdout: () => undefined };

test("close and recover of an unreachable pod DELETE it with the pod's uid, then answer from the record", async () => {
  for (const argv of [
    ["sessions", "close", SESSION],
    ["sessions", "recover", SESSION],
  ]) {
    const r = rig({});
    const result = await routedBranchHandlers(r.deps)["routed-if-pod"](decision(argv), context);
    assert.equal(result, "proceed", `${argv[1]}: answered from the record, locally`);
    assert.deepEqual(r.deletes, [{ key: KEY, uid: POD_UID }]);
    assert.deepEqual(r.failures, []);
  }
});

test("a delete the broker refused (uid_mismatch) or could not make leaves the original failure and the pod alone", async () => {
  for (const kind of ["refused", "unavailable"] as const) {
    const r = rig({ deleteKind: kind });
    const result = await routedBranchHandlers(r.deps)["routed-if-pod"](
      decision(["sessions", "close", SESSION]),
      context,
    );
    assert.equal(
      result,
      1,
      `${kind}: the unreachable failure is shown, the session stays a pod session`,
    );
    assert.equal(r.failures.length, 1);
  }
});

test("negative: no other verb deletes a pod because it cannot be reached — cancel, status, a setting", async () => {
  for (const argv of [
    ["cancel", "--session-id", SESSION],
    ["status", "--session-id", SESSION],
    ["set-mode", "plan", "--session-id", SESSION],
    ["sessions", "owner-status", SESSION],
  ]) {
    const r = rig({});
    const result = await routedBranchHandlers(r.deps)["routed-if-pod"](decision(argv), context);
    assert.equal(result, 1, argv.join(" "));
    assert.deepEqual(r.deletes, [], `${argv.join(" ")} never asks the broker`);
  }
});

test("negative: only agent_unreachable deletes — a deadline, a connection break and a held pod_starting do not", async () => {
  const errors = [
    new RoutedCallError({ outcome: "unknown", reason: "deadline", callId: "c" }),
    new RoutedCallError({ outcome: "unknown", reason: "connection", callId: "c" }),
    new RoutedCallError({ outcome: "not_run", reason: "host_key", callId: "c" }),
    new Error("pod_starting"),
  ];
  for (const error of errors) {
    const r = rig({ error });
    await routedBranchHandlers(r.deps)["routed-if-pod"](
      decision(["sessions", "close", SESSION]),
      context,
    );
    assert.deepEqual(r.deletes, [], error.message);
  }
});

test("negative: a pod that is gone or unknown by the time of the lookup is not deleted", async () => {
  for (const lookup of [{ state: "absent" }, { state: "unknown" }] as const) {
    const r = rig({ lookup });
    await routedBranchHandlers(r.deps)["routed-if-pod"](
      decision(["sessions", "recover", SESSION]),
      context,
    );
    assert.deepEqual(r.deletes, []);
  }
});

test("a caller that supplies no broker delete deletes nothing (the capability is opt-in)", async () => {
  const r = rig({ withDelete: false });
  const result = await routedBranchHandlers(r.deps)["routed-if-pod"](
    decision(["sessions", "close", SESSION]),
    context,
  );
  assert.equal(result, 1);
});
