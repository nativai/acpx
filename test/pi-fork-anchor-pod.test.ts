import "./install-owner-reaper.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadFixture, toJsonl } from "./pi-cut-helpers.js";
import { adapterOps, forkOps, stage } from "./pi-wire-helpers.js";
import { type Fixture, makeBox, readRecord, runCli, startStubAtrium } from "./umq-rig.js";

// brick 4bf088a7 (TEST-PLAN A19, DESIGN Q4 + Q5) — a Pi cut in POD MODE. The record is created
// sleeping with an UNANCHORED cut (Pi has no anchor kind: phase 2), and the first wake forks.
//   Q4: the create runs the proof as a REFUSAL-ONLY pre-check — an unprovable Pi cut never gets a
//       record, and nothing it found is stored.
//   Q5: the wake persists the context shortfall as `metadata.fork_context_end_log_index` and says so
//       on stderr, as the live copy does (a wake has no retry, so it must not be silent).
// The wake path is `forkForSleepingPlan` → `forkCutForSleepingSession` → `AcpClient.forkSession`, the
// SAME Pi branch the live copy takes, so the wire rows of `pi-fork-anchor-wire.test.ts` apply here too.

const INCIDENT = loadFixture("59f799ee");
const RECORD_ID = "6f9a1c2e-0b7d-4c3e-9a8f-1e2d3c4b5a69";
const CALL_ID = "0e1d2c3b-4a59-4687-9a8b-7c6d5e4f3a21";

/** Pod mode through A1's seams (`ACPX_POD_TEST_HOME`, `ACPX_POD_SA_DIR` — honoured under `node --test` only). */
const pod = (f: Fixture, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const sa = path.join(f.root, "serviceaccount");
  fs.mkdirSync(sa, { recursive: true });
  fs.writeFileSync(path.join(sa, "namespace"), "dev-devbox\n");
  return {
    ...f.env,
    ...extra,
    ACPX_PI_BOX_AGENT_DIR: path.join(f.root, "pi-agent"),
    ACPX_OWNER_PLACEMENT: "pod",
    ACPX_POD_TEST_HOME: f.root,
    ACPX_POD_SA_DIR: sa,
    NV_POD_NAME: "dev-server-0",
    NV_POD_UID: "00000000-0000-0000-0000-000000000001",
    NV_NODE_NAME: "node-a",
  };
};

const copyArgs = (agent: string, cwd: string, sourceId: string, n: number): string[] => [
  "--cwd",
  cwd,
  "--agent",
  agent,
  "--approve-all",
  "--format",
  "json",
  "sessions",
  "copy",
  "--from",
  sourceId,
  "--at-log-index",
  String(n),
  "--ephemeral",
  "--record-id",
  RECORD_ID,
  "--created-by-call",
  CALL_ID,
];

async function withAtrium<T>(f: Fixture, run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const stub = await startStubAtrium(() => ({
    status: 202,
    body: { delivery_id: "d-1", to: "x", status: "queued" },
  }));
  try {
    return await run(pod(f, { ACPX_UI_INTERNAL_URL: stub.url }));
  } finally {
    await stub.close();
  }
}

type PlanRecord = {
  acp_session_id: string;
  metadata?: Record<string, string>;
  acpx: { sleeping?: { fork?: { cut?: { harness_anchor?: string; log_index?: number } } } };
};

test("Q4 + Q5 + A19: a Pi cut after a steer creates sleeping with NOTHING pinned, and its WAKE forks at the proved entry and persists the shortfall", async () => {
  const f = makeBox({ requestMib: 4000 });
  const s = await stage(f.root, INCIDENT);
  const created = await withAtrium(f, (env) =>
    runCli(copyArgs(s.agentCommand, s.cwd, s.id, 19), env, f.root),
  );
  assert.equal(created.code, 0, created.stderr);
  const record = readRecord(f, RECORD_ID) as unknown as PlanRecord;
  assert.equal(record.acp_session_id, "", "created sleeping: the adapter was never asked anything");
  assert.deepEqual(
    await adapterOps(s),
    [],
    "no adapter operation at create — the pre-check is files only",
  );
  const cut = record.acpx.sleeping?.fork?.cut;
  assert.equal(cut?.log_index, 19);
  assert.equal(
    cut?.harness_anchor,
    undefined,
    "Pi is not pinnable yet (phase 2): nothing is stored",
  );
  assert.equal(
    record.metadata?.fork_context_end_log_index,
    undefined,
    "the create stores no shortfall: the wake re-proves against the file as it is then",
  );

  const wake = await runCli(
    [
      "--cwd",
      s.cwd,
      "--agent",
      s.agentCommand,
      "--approve-all",
      "--format",
      "json",
      "prompt",
      "--session-id",
      RECORD_ID,
      "after the cut",
    ],
    { ...f.env, ACPX_PI_BOX_AGENT_DIR: path.join(f.root, "pi-agent") },
    f.root,
  );
  assert.equal(wake.code, 0, wake.stderr + wake.stdout);
  const [fork] = await forkOps(s);
  assert.deepEqual(
    fork.meta?.acpx,
    { forkAfterEntryId: "3def8d5c" },
    "the entry id, never an index",
  );
  // The wake runs in the session's queue owner, whose stderr is its owner log — not the CLI's.
  const ownerLog = fs.readFileSync(
    path.join(f.root, ".acpx", "sessions", `${RECORD_ID}.owner.log`),
    "utf8",
  );
  assert.match(
    wake.stderr + ownerLog,
    /agent context ends at log index 18, before the record cut at 19/u,
  );
  const woken = readRecord(f, RECORD_ID) as unknown as PlanRecord;
  assert.equal(woken.metadata?.fork_context_end_log_index, "18", "Q5: persisted at the wake");
  assert.equal(woken.acpx.sleeping, undefined, "and the record is no longer sleeping");
});

test("Q5 negative: a wake whose cut has no shortfall persists no fork_context_end_log_index and prints no warning", async () => {
  const f = makeBox({ requestMib: 4000 });
  const s = await stage(f.root, INCIDENT);
  const created = await withAtrium(f, (env) =>
    runCli(copyArgs(s.agentCommand, s.cwd, s.id, 18), env, f.root),
  );
  assert.equal(created.code, 0, created.stderr);
  const wake = await runCli(
    [
      "--cwd",
      s.cwd,
      "--agent",
      s.agentCommand,
      "--approve-all",
      "--format",
      "json",
      "prompt",
      "--session-id",
      RECORD_ID,
      "x",
    ],
    { ...f.env, ACPX_PI_BOX_AGENT_DIR: path.join(f.root, "pi-agent") },
    f.root,
  );
  assert.equal(wake.code, 0, wake.stderr + wake.stdout);
  const ownerLog = fs.readFileSync(
    path.join(f.root, ".acpx", "sessions", `${RECORD_ID}.owner.log`),
    "utf8",
  );
  assert.doesNotMatch(wake.stderr + ownerLog, /agent context ends at/u);
  const woken = readRecord(f, RECORD_ID) as unknown as PlanRecord;
  assert.equal(woken.metadata?.fork_context_end_log_index, undefined);
});

test("Q4 negative: a Pi cut the proof cannot place is refused at CREATE — no record, no adapter operation", async () => {
  const f = makeBox({ requestMib: 4000 });
  // The pi file has lost the user message the cut anchors on (a file shorter than the record).
  const truncated = toJsonl(INCIDENT.pi.slice(0, 20));
  const s = await stage(f.root, INCIDENT, [], INCIDENT.entries, truncated);
  const run = await withAtrium(f, (env) =>
    runCli(copyArgs(s.agentCommand, s.cwd, s.id, 22), env, f.root),
  );
  assert.notEqual(run.code, 0, run.stdout);
  assert.match(run.stdout + run.stderr, /FORK_CUT_UNRESOLVED/u);
  assert.equal(
    fs.existsSync(path.join(f.root, ".acpx", "sessions", `${RECORD_ID}.json`)),
    false,
    "no record was created",
  );
  assert.deepEqual(await adapterOps(s), [], "and no adapter operation");
});

test("Q4 negative: the pi file of the source being absent is SOURCE_TRANSCRIPT_MISSING at create, not a record that dies at its wake", async () => {
  const f = makeBox({ requestMib: 4000 });
  const s = await stage(f.root, INCIDENT);
  fs.rmSync(s.piFile);
  const run = await withAtrium(f, (env) =>
    runCli(copyArgs(s.agentCommand, s.cwd, s.id, 18), env, f.root),
  );
  assert.notEqual(run.code, 0, run.stdout);
  assert.match(run.stdout + run.stderr, /SOURCE_TRANSCRIPT_MISSING/u);
  assert.equal(fs.existsSync(path.join(f.root, ".acpx", "sessions", `${RECORD_ID}.json`)), false);
});
