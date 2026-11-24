import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { findProcessTableReaders } from "./pod-source-scan.js";

// Block A11 / A-67 row 67.5 (the process-table check): every file of `src/` that reads this host's
// process table — `/proc`, `kill(pid, 0)`, or one of the census / liveness helpers — either asks
// `localProofScope` (a session verdict) or is on the REVIEWED list below with the reason it needs no
// scope. The scan finds its subjects; nothing is registered. ⚠️ A NEW READER IS RED UNTIL IT IS EITHER
// SCOPED OR REVIEWED HERE — adding it to the list is a judgement a reviewer must be able to read.

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

const OWN_PROCESS =
  "reads this process's or its container's own facts, not a verdict about a session";
const CAPACITY =
  "accounts for THIS machine's memory and processes (capacity, governor); acts on this host's own processes and passes no verdict about a session's record";
const PRIMITIVE =
  "primitive: answers for the reader's own pid namespace; its callers are scoped or listed";
const C3 = "lock-holder or lease judgement: C3.2 / C3.3 rules, not the A-67 bullet";
const OWN_TREE =
  "runs inside the session's own owner, so in the session's own pod; judges its own group or tasks";

export const REVIEWED: Record<string, string> = {
  "acp/auth-env.ts": `PID 1's environ for pod facts: ${OWN_PROCESS}`,
  "acp/client-process.ts": `WSL detection: ${OWN_PROCESS}`,
  "acp/terminal-manager.ts": "probes the terminals THIS process started (its own children)",
  "capacity/build.ts": CAPACITY,
  "capacity/cgroup.ts": CAPACITY,
  "capacity/governor/classify.ts": CAPACITY,
  "capacity/governor/main.ts": CAPACITY,
  "capacity/governor/notify.ts": CAPACITY,
  "capacity/governor/run.ts": CAPACITY,
  "capacity/governor/scan.ts": CAPACITY,
  "capacity/governor/status.ts": CAPACITY,
  "capacity/leases.ts": CAPACITY,
  "capacity/ledger.ts": `boot identity from /proc/1/stat: ${OWN_PROCESS}`,
  "capacity/owners.ts": CAPACITY,
  "capacity/reading.ts": CAPACITY,
  "capacity/run-build.ts": CAPACITY,
  "cli/governor-command.ts": CAPACITY,
  "cli/prompt-routing.ts":
    "capacity admission's owner-tree check: a lease scan and this host's own tree (R12)",
  "cli/queue/ipc.ts": C3,
  "cli/queue/lease-store.ts": C3,
  "cli/session/owner-exit-transcript-reap.ts": OWN_TREE,
  "cli/session/owner-task-reap.ts": OWN_TREE,
  "cli/session/queue-owner-runtime.ts": `/proc/self/stat: ${OWN_PROCESS}`,
  "cli/session/session-control.ts": `walks this process's own parent chain: ${OWN_PROCESS}`,
  "pod/placement.ts": `PID 1's environ for pod facts (A-26): ${OWN_PROCESS}`,
  "process-identity.ts": PRIMITIVE,
  "process-liveness.ts": PRIMITIVE,
  "process-population.ts": `${PRIMITIVE}; its only caller, the seat backfill, hands it to a scoped sweep`,
  "process-tree-reap.ts":
    "reaps the calling owner's own process group and descendants by birth identity",
  "runtime/engine/reconnect.ts":
    "the public runtime library reconnects an adapter THIS process started; home-only",
  "session/persistence/record-file-lock.ts": C3,
  "session/seat-backfill.ts":
    "passes the census to sweepAbandonedSessionRecords, which scopes every record before a verdict",
  "session/session.ts": "re-export of isProcessAlive only",
  "spawn-ledger.ts":
    "control-pod-only ledger of spawns on this host (A7); pid proofs about its own spawns",
};

test("every reader of this host's process table is scoped or reviewed — and the reviewed list is not stale", () => {
  const { scoped, unscoped } = findProcessTableReaders(SRC_ROOT);
  assert.deepEqual(
    unscoped.filter((file) => REVIEWED[file] === undefined),
    [],
    "a new reader of the process table: ask localProofScope, or review it into REVIEWED with a reason",
  );
  assert.deepEqual(
    Object.keys(REVIEWED).filter((file) => !unscoped.includes(file)),
    [],
    "a REVIEWED entry that no longer reads the process table, or that has become scoped: remove it",
  );
  assert.deepEqual(
    scoped,
    [
      "cli/transcripts-dedup.ts",
      "config/transcript-dedup.ts",
      "session/abandoned-record-sweep.ts",
      "session/archive/liveness.ts",
      "session/export.ts",
    ],
    "the scoped sites",
  );
});

test("the scan is RED on a planted /proc walk and a planted kill(pid, 0), clean once scoped; a comment is not a reader", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a11-procscan-"));
  fs.writeFileSync(
    path.join(root, "walk.ts"),
    'import fs from "node:fs";\nfs.readdirSync("/proc");\n',
  );
  fs.writeFileSync(
    path.join(root, "probe.ts"),
    "export const alive = (pid: number) => process.kill(pid, 0);\n",
  );
  fs.writeFileSync(path.join(root, "census.ts"), "const scan = scanLiveProcesses();\n");
  fs.writeFileSync(
    path.join(root, "scoped.ts"),
    'const scope = await localProofScope(id);\nfs.readdirSync("/proc");\n',
  );
  fs.writeFileSync(
    path.join(root, "comment.ts"),
    "// walks /proc and calls kill(pid, 0)\nexport const x = 1;\n",
  );
  const { scoped, unscoped } = findProcessTableReaders(root);
  assert.deepEqual(unscoped, ["census.ts", "probe.ts", "walk.ts"]);
  assert.deepEqual(scoped, ["scoped.ts"]);
});
