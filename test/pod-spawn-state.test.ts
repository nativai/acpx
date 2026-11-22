import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { queueLockFilePath } from "../src/cli/queue/paths.js";
import {
  parseSpawnState,
  readSpawnStateFile,
  SPAWN_STATE_SUFFIX,
  spawnStatePath,
  type SpawnState,
} from "../src/pod/spawn-state.js";
import { getOwnProcessIdentity, serializeProcessBirthIdentity } from "../src/process-identity.js";
import { createFileSessionStore } from "../src/runtime/public/file-session-store.js";
import { writeSessionRecord } from "../src/session/persistence.js";
import { setPodLockDepsForTests } from "../src/session/persistence/identity-file-lock.js";
import { loadOrRebuildSessionIndex } from "../src/session/persistence/index.js";
import { parseSessionRecord } from "../src/session/persistence/parse.js";
import {
  openSpawnLedgerForRecord,
  PodSpawnRecordWriter,
  SpawnLedger,
  type DiskRecord,
} from "../src/spawn-ledger.js";
import { removeTempHomeSync } from "./temp-home.js";

// block A7 / contract C3.4 (A-13): in an agent pod a spawn-owned record is written by the plain locked
// path, and the attempt is checked from `<id>.spawn-state` — never from SQLite. The control side of
// each fixture is the REAL ledger (the file is derived from what it says, as atrium's writer does it);
// the agent pod is the C1.1 test seam (`.nv-agent` in the sandbox + `ACPX_POD_TEST_HOME`).
// Every refusal row has a twin that is well-formed in every other respect and succeeds.

const SAVED = {
  HOME: process.env.HOME,
  ACPX_STATE_HOME: process.env.ACPX_STATE_HOME,
  ACPX_POD_TEST_HOME: process.env.ACPX_POD_TEST_HOME,
};
const ID = "11111111-1111-4111-8111-111111111111";
const INSTANCE = "i-111111111111";
const roots: string[] = [];

test.afterEach(() => {
  setPodLockDepsForTests(undefined);
  for (const [name, value] of Object.entries(SAVED)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  for (const root of roots.splice(0)) {
    removeTempHomeSync(root);
  }
});

type Fixture = {
  home: string;
  sessions: string;
  key: string;
  /** What the control pod's writer would publish for the adopted attempt, from the ledger. */
  published: SpawnState;
  record: DiskRecord;
  writeState: (state: unknown) => void;
  stateFile: string;
  recordFile: string;
  recordBytes: () => string;
};

function diskRecord(home: string, metadata: Record<string, string>): DiskRecord {
  return {
    schema: "acpx.session.v1",
    kind: "session",
    acpx_record_id: ID,
    acp_session_id: "adapter-independent-id",
    agent_command: "node /opt/codex-acp/dist/index.js",
    agent_name: "codex",
    cwd: home,
    created_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_seq: 0,
    messages: [],
    metadata,
    closed: false,
  };
}

/** The control pod's side: a real ledger takes the attempt to `adopted`; then the home becomes an agent pod. */
function adoptedAgentPod(options: { adopt?: boolean } = {}): Fixture {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "acpx-spawnstate-")));
  roots.push(home);
  process.env.HOME = home;
  delete process.env.ACPX_STATE_HOME;
  process.env.ACPX_POD_TEST_HOME = home;
  const sessions = path.join(home, ".acpx", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(
    path.join(home, ".acpx", "instance.json"),
    JSON.stringify({ instance_id: INSTANCE, home }),
  );
  const ledger = new SpawnLedger();
  let key: string;
  let attemptState: SpawnState["state"];
  let adoptedFence: number | null;
  let recordSpawnState: string;
  try {
    ledger.bindIdentity({ instance_id: INSTANCE });
    const attempt = ledger.reserveSpawn({
      run_id: "run-1",
      fence: 1,
      trigger_id: "trigger-1",
      parent_brick_id: "22222222-2222-4222-8222-222222222222",
      child_brick_id: "33333333-3333-4333-8333-333333333333",
      target_record_id: ID,
    });
    key = attempt.idempotency_key;
    ledger.recordSpawnChild("run-1", 1, process.pid);
    ledger.saveRecord(diskRecord(home, { spawn_key: key, spawn_state: "pending" }));
    ledger.transitionSpawn("run-1", 1, "published", { session_url: "https://x.invalid/" });
    if (options.adopt !== false) {
      ledger.transitionSpawn("run-1", 1, "adopted");
    }
    attemptState = ledger.getSpawnAttempt("run-1", 1)!.state;
    adoptedFence = ledger.getSpawnRun("run-1")!.adopted_fence;
    recordSpawnState = ledger.readRecord(ID)!.metadata!.spawn_state!;
  } finally {
    ledger.close();
  }
  const published: SpawnState = {
    v: 1,
    record_id: ID,
    spawn_key: key,
    run_id: "run-1",
    fence: 1,
    state: attemptState,
    adopted_fence: adoptedFence,
    instance_id: INSTANCE,
    record_spawn_state: recordSpawnState,
    receipt_conflict: false,
    published_at: new Date().toISOString(),
  };
  const stateFile = spawnStatePath(sessions, ID);
  const writeState = (state: unknown): void => {
    fs.writeFileSync(stateFile, typeof state === "string" ? state : JSON.stringify(state));
  };
  writeState(published);
  // From here on this home is an agent pod, and it has no ledger database at all.
  fs.writeFileSync(path.join(home, ".nv-agent"), "ag-spawnstate\n");
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(path.join(home, ".acpx", `brick-outbox.db${suffix}`), { force: true });
  }
  const recordFile = path.join(sessions, `${ID}.json`);
  return {
    home,
    sessions,
    key: key!,
    published,
    record: JSON.parse(fs.readFileSync(recordFile, "utf8")) as DiskRecord,
    writeState,
    stateFile,
    recordFile,
    recordBytes: () => fs.readFileSync(recordFile, "utf8"),
  };
}

async function podWrite(f: Fixture, record: DiskRecord = { ...f.record, name: "pod write" }) {
  const writer = openSpawnLedgerForRecord(record.metadata, f.sessions);
  assert.ok(writer instanceof PodSpawnRecordWriter, "an agent pod gets the spawn-state writer");
  try {
    return await writer.saveRecordAsync(record);
  } finally {
    writer.close();
  }
}

const refusedWith = (code: string) => (error: unknown) =>
  (error as { code?: string }).code === code && (error as Error).name === "SpawnLedgerError";

async function refuses(f: Fixture, code: string, record?: DiskRecord) {
  const before = f.recordBytes();
  await assert.rejects(podWrite(f, record), refusedWith(code));
  assert.equal(f.recordBytes(), before, "a refused write leaves the record as it was");
}

function holdOwnLease(pid = process.pid, identity = true): void {
  const own = getOwnProcessIdentity();
  assert.ok(own, "own process identity");
  const file = queueLockFilePath(ID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid,
      sessionId: ID,
      ...(identity ? { processIdentity: serializeProcessBirthIdentity(own) } : {}),
    }),
  );
}

test("an agent pod writes its spawn-owned record from the spawn-state file — with no ledger database anywhere", async () => {
  const f = adoptedAgentPod();
  const written = await podWrite(f);
  assert.equal(written.name, "pod write");
  assert.equal((JSON.parse(f.recordBytes()) as DiskRecord).name, "pod write");
  for (const suffix of ["", "-wal", "-shm"]) {
    assert.equal(
      fs.existsSync(path.join(f.home, ".acpx", `brick-outbox.db${suffix}`)),
      false,
      `the pod opened no database (${suffix || "main file"})`,
    );
  }
});

test("a writer that did not load spawn_state keeps the record's (preserveSpawnState, record only)", async () => {
  const f = adoptedAgentPod();
  const { spawn_state: _dropped, ...withoutState } = f.record.metadata!;
  await podWrite(f, { ...f.record, metadata: withoutState, name: "no spawn_state" });
  assert.equal((JSON.parse(f.recordBytes()) as DiskRecord).metadata?.spawn_state, "published");
});

test("NEGATIVE: no file ⇒ spawn-state-missing (cannot tell never permits)", async () => {
  const f = adoptedAgentPod();
  fs.rmSync(f.stateFile);
  await refuses(f, "spawn-state-missing");
  f.writeState(f.published);
  await podWrite(f);
});

test("NEGATIVE: unreadable, not JSON, an unknown version or a malformed field ⇒ spawn-state-unsupported", async () => {
  const f = adoptedAgentPod();
  for (const bad of [
    "{ not json",
    "[]",
    JSON.stringify({ ...f.published, v: 2 }),
    JSON.stringify({ ...f.published, v: undefined }),
    JSON.stringify({ ...f.published, fence: "1" }),
    JSON.stringify({ ...f.published, state: "unheard-of" }),
    JSON.stringify({ ...f.published, receipt_conflict: undefined }),
    JSON.stringify({ ...f.published, instance_id: undefined }),
  ]) {
    f.writeState(bad);
    await refuses(f, "spawn-state-unsupported");
  }
  // twin: an unknown EXTRA field is additive (contracts rule 2) and does not refuse.
  f.writeState({ ...f.published, a_future_field: { x: 1 } });
  await podWrite(f);
});

test("NEGATIVE: the file older or newer than the record ⇒ spawn-state-stale (no clock compared)", async () => {
  const f = adoptedAgentPod();
  assert.equal(f.published.record_spawn_state, "published");
  f.writeState({ ...f.published, record_spawn_state: "pending" });
  await refuses(f, "spawn-state-stale");
  f.writeState({ ...f.published, record_spawn_state: "orphaned" });
  await refuses(f, "spawn-state-stale");
  f.writeState({ ...f.published, published_at: "1999-01-01T00:00:00.000Z" });
  await podWrite(f); // diagnostics only: the time of the file is never compared
});

test("NEGATIVE: a file naming another record or another attempt ⇒ record-ownership", async () => {
  const f = adoptedAgentPod();
  f.writeState({ ...f.published, record_id: "22222222-2222-4222-8222-222222222222" });
  await refuses(f, "record-ownership");
  f.writeState({ ...f.published, spawn_key: "0".repeat(32) });
  await refuses(f, "record-ownership");
  f.writeState(f.published);
  await podWrite(f);
});

test("NEGATIVE: a different bound instance ⇒ outbox-instance-mismatch; null skips ONLY the instance check", async () => {
  const f = adoptedAgentPod();
  f.writeState({ ...f.published, instance_id: "i-222222222222" });
  await refuses(f, "outbox-instance-mismatch");
  f.writeState({ ...f.published, instance_id: null });
  await podWrite(f);
  // null skips the instance check and nothing else: a revoked attempt and a stale file still refuse.
  f.writeState({ ...f.published, instance_id: null, state: "revoked" });
  await refuses(f, "spawn-revoked");
  f.writeState({ ...f.published, instance_id: null, record_spawn_state: "pending" });
  await refuses(f, "spawn-state-stale");
});

test("NEGATIVE: an attempt that is not launched, published or adopted ⇒ spawn-revoked", async () => {
  const f = adoptedAgentPod();
  for (const state of ["reserved", "revoked", "cancelled", "orphaned"] as const) {
    f.writeState({ ...f.published, state });
    await refuses(f, "spawn-revoked");
  }
  for (const state of ["launched", "published", "adopted"] as const) {
    f.writeState({ ...f.published, state });
    await podWrite(f);
  }
});

test("rebinding acp_session_id: only the adopted attempt's own owner (lease) may — the ledger's rule, read from the file", async () => {
  const f = adoptedAgentPod();
  const rebound = { ...f.record, acp_session_id: "fresh-after-resume-miss" };
  // adopted, but no lease at all: refused.
  await refuses(f, "record-ownership", rebound);
  // adopted, a lease held by ANOTHER process: refused.
  holdOwnLease(process.pid + 1);
  await refuses(f, "record-ownership", rebound);
  // a lease with this pid and NO birth identity (a pid number from another namespace): refused.
  holdOwnLease(process.pid, false);
  await refuses(f, "record-ownership", rebound);
  // lease names this process but the file says published, not adopted: refused.
  holdOwnLease();
  f.writeState({ ...f.published, state: "published", adopted_fence: null });
  await refuses(f, "record-ownership", rebound);
  // adopted by ANOTHER fence: refused.
  f.writeState({ ...f.published, adopted_fence: 2 });
  await refuses(f, "record-ownership", rebound);
  // the twin: adopted, adopted_fence = fence, the lease names this process.
  f.writeState(f.published);
  await podWrite(f, rebound);
  assert.equal(
    (JSON.parse(f.recordBytes()) as DiskRecord).acp_session_id,
    "fresh-after-resume-miss",
  );
});

test("a record that is not spawn-owned never meets the spawn-state file; one that lost its key is refused", async () => {
  const f = adoptedAgentPod();
  fs.rmSync(f.stateFile);
  assert.equal(openSpawnLedgerForRecord({}, f.sessions), undefined);
  assert.equal(openSpawnLedgerForRecord(undefined, f.sessions), undefined);
  // an agent pod's writer cannot be built for a record outside this HOME's canonical directory
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-spawnstate-other-"));
  roots.push(other);
  assert.equal(openSpawnLedgerForRecord({ spawn_key: f.key }, other), undefined);
  const writer = new PodSpawnRecordWriter(f.sessions);
  await assert.rejects(
    writer.saveRecordAsync({ ...f.record, metadata: {} }),
    refusedWith("record-ownership"),
  );
});

test("the same writer serves the real record write path and the public file store", async () => {
  const f = adoptedAgentPod();
  const pod = { name: "ag-spawnstate", uid: "uid-ss", node: "node-a", namespace: "ns" };
  setPodLockDepsForTests({ ownPod: () => pod, lockPod: () => pod });
  const parsed = parseSessionRecord(JSON.parse(f.recordBytes()));
  assert.ok(parsed, "the control pod's record parses");
  await writeSessionRecord({ ...parsed, lastRequestId: "through the repository" });
  assert.equal(
    (JSON.parse(f.recordBytes()) as DiskRecord).last_request_id,
    "through the repository",
  );
  const store = createFileSessionStore({ stateDir: path.join(f.home, ".acpx") });
  await store.save({ ...parsed, lastRequestId: "through the file store" });
  assert.equal(
    (JSON.parse(f.recordBytes()) as DiskRecord).last_request_id,
    "through the file store",
  );
  // …and both refuse alike when the file is gone.
  fs.rmSync(f.stateFile);
  await assert.rejects(
    writeSessionRecord({ ...parsed, lastRequestId: "refused" }),
    refusedWith("spawn-state-missing"),
  );
  await assert.rejects(
    store.save({ ...parsed, lastRequestId: "refused" }),
    refusedWith("spawn-state-missing"),
  );
  assert.equal(
    (JSON.parse(f.recordBytes()) as DiskRecord).last_request_id,
    "through the file store",
  );
});

test("NEGATIVE: the control pod (no place file) still goes through the SQLite ledger", () => {
  const f = adoptedAgentPod();
  fs.rmSync(path.join(f.home, ".nv-agent"));
  const writer = openSpawnLedgerForRecord({ spawn_key: f.key }, f.sessions);
  try {
    assert.ok(writer instanceof SpawnLedger, "the control pod keeps its ledger");
  } finally {
    writer?.close();
  }
});

test("the suffix is not a .json name: the sessions-directory enumerators never take the file for a record (A-13)", async () => {
  const f = adoptedAgentPod();
  assert.equal(SPAWN_STATE_SUFFIX, ".spawn-state");
  assert.equal(path.extname(f.stateFile), ".spawn-state");
  assert.ok(f.stateFile.startsWith(path.join(f.sessions, `${ID}.`)), "it still begins with <id>.");
  const index = await loadOrRebuildSessionIndex(f.sessions);
  assert.deepEqual(
    index.entries.map((entry) => entry.acpxRecordId),
    [ID],
  );
  assert.deepEqual(
    index.files.filter((name) => name.includes("spawn-state")),
    [],
  );
});

test("parseSpawnState: the shape the atrium writer publishes (every field present) parses; a version-1 file missing one field does not", () => {
  const f = adoptedAgentPod();
  assert.equal(parseSpawnState(JSON.stringify(f.published)).ok, true);
  const { published_at: _gone, ...without } = f.published;
  assert.equal(parseSpawnState(JSON.stringify(without)).ok, false);
});

test("O-2: a transient read error (EIO, ESTALE, …) is the RETRIED spawn-state-missing; an error that will not heal stays unsupported", () => {
  const failing = (code: string) => () => {
    throw Object.assign(new Error(`${code}: read failed`), { code });
  };
  for (const code of [
    "ENOENT",
    "EIO",
    "ESTALE",
    "ETIMEDOUT",
    "EAGAIN",
    "EBUSY",
    "EINTR",
    "ENOTCONN",
  ]) {
    const read = readSpawnStateFile("/x/id.spawn-state", failing(code));
    assert.ok(!read.ok && read.refusal.code === "spawn-state-missing", code);
  }
  for (const code of ["EACCES", "EISDIR", "EMFILE", ""]) {
    const read = readSpawnStateFile("/x/id.spawn-state", failing(code));
    assert.ok(!read.ok && read.refusal.code === "spawn-state-unsupported", `not retried: ${code}`);
  }
  // twin: the same seam with a good file reads it
  const f = adoptedAgentPod();
  assert.equal(readSpawnStateFile(f.stateFile, () => JSON.stringify(f.published)).ok, true);
});

test("O-3: a HOME with no instance.json refuses outbox-home-unadmitted; one that moved refuses instance-identity-moved — only when the file names an instance", async () => {
  const f = adoptedAgentPod();
  const instanceFile = path.join(f.home, ".acpx", "instance.json");
  fs.rmSync(instanceFile);
  await refuses(f, "outbox-home-unadmitted");
  fs.writeFileSync(
    instanceFile,
    JSON.stringify({ instance_id: INSTANCE, home: "/somewhere/else" }),
  );
  await refuses(f, "instance-identity-moved");
  // instance_id null skips the instance check, so neither is reached
  f.writeState({ ...f.published, instance_id: null });
  await podWrite(f);
  // twin: the admitted identity is back and the file names it
  fs.writeFileSync(instanceFile, JSON.stringify({ instance_id: INSTANCE, home: f.home }));
  f.writeState(f.published);
  await podWrite(f);
});
