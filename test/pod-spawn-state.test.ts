import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
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
function adoptedAgentPod(options: { adopt?: boolean; controlPod?: boolean } = {}): Fixture {
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
  // From here on this home is an agent pod, and it has no ledger database at all — unless `controlPod`: the
  // control pod with pod mode OFF (every brick-trigger-spawned session's checkpoint today), ledger kept.
  if (options.controlPod !== true) {
    fs.writeFileSync(path.join(home, ".nv-agent"), "ag-spawnstate\n");
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(path.join(home, ".acpx", `brick-outbox.db${suffix}`), { force: true });
    }
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
    // O2-a: resource pressure that passes is retried, not "fix the deploy"
    "EMFILE",
    "ENFILE",
    "ENOMEM",
  ]) {
    const read = readSpawnStateFile("/x/id.spawn-state", failing(code));
    assert.ok(!read.ok && read.refusal.code === "spawn-state-missing", code);
  }
  // O2-a: ENOTCONN on Linux is a dead FUSE/socket mount — it does NOT clear by itself, so "retry" would be
  // the wrong advice; it is the not-retried refusal an operator reads.
  for (const code of ["ENOTCONN", "EACCES", "EISDIR", ""]) {
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

// ---- O2-b: the same transient mapping on EVERY read of the pod write path ------------------------------------

/** Runs `run` with `fs.readFileSync` failing with `code` for paths ending in `suffix` (the writer's own reads). */
async function withReadFailure<T>(suffix: string, code: string, run: () => Promise<T>): Promise<T> {
  const real = fs.readFileSync;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof target === "string" && target.endsWith(suffix)) {
      throw Object.assign(new Error(`${code}: read failed`), { code });
    }
    return (real as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.readFileSync;
  try {
    return await run();
  } finally {
    fs.readFileSync = real;
  }
}

const TRANSIENT = [
  "EIO",
  "ESTALE",
  "ETIMEDOUT",
  "EAGAIN",
  "EBUSY",
  "EINTR",
  "EMFILE",
  "ENFILE",
  "ENOMEM",
];

for (const [what, suffix] of [
  ["the spawn-state file", ".spawn-state"],
  ["instance.json", "instance.json"],
  ["the session record", `${ID}.json`],
] as const) {
  test(`O2-b: a transient read error on ${what} is the RETRIED spawn-state-missing, never final or a raw errno — and a permanent one is not`, async () => {
    const f = adoptedAgentPod();
    const before = f.recordBytes();
    for (const code of TRANSIENT) {
      await withReadFailure(suffix, code, async () => {
        await assert.rejects(podWrite(f), refusedWith("spawn-state-missing"), code);
      });
    }
    assert.equal(f.recordBytes(), before, "a refused write leaves the record as it was");
    // negative: an error that does not heal is NOT relabelled retried. instance.json: the final refusal it
    // always was; the spawn-state file: unsupported; the record: the raw error, as before.
    const permanent: Record<string, (error: unknown) => boolean> = {
      ".spawn-state": refusedWith("spawn-state-unsupported"),
      "instance.json": refusedWith("outbox-home-unadmitted"),
      [`${ID}.json`]: (error) => (error as { code?: string }).code === "EACCES",
    };
    await withReadFailure(suffix, "EACCES", async () => {
      await assert.rejects(podWrite(f), permanent[suffix]);
    });
    // twin: with no failure injected the same write goes through
    await podWrite(f);
  });
}

test("O2-b: ENOENT keeps its meaning on each read — no instance.json is the FINAL outbox-home-unadmitted, no record is a first write", async () => {
  const f = adoptedAgentPod();
  fs.rmSync(path.join(f.home, ".acpx", "instance.json"));
  await refuses(f, "outbox-home-unadmitted");
});

// ---- brick 20d6bce2 (F-6, F-7, F-8): the OTHER reads on the pod write path, through writeSessionRecord ---------

function podDeps(): void {
  const pod = { name: "ag-spawnstate", uid: "uid-ss", node: "node-a", namespace: "ns" };
  setPodLockDepsForTests({ ownPod: () => pod, lockPod: () => pod });
}

/** Runs `run` with `fs.realpathSync` failing with `code` for paths ending in `suffix`. */
async function withRealpathFailure<T>(
  suffix: string,
  code: string,
  run: () => Promise<T>,
): Promise<T> {
  const real = fs.realpathSync;
  const patched = ((target: fs.PathLike, ...rest: unknown[]) => {
    if (typeof target === "string" && target.endsWith(suffix)) {
      throw Object.assign(new Error(`${code}: realpath failed`), { code });
    }
    return (real as (...args: unknown[]) => unknown)(target, ...rest);
  }) as typeof fs.realpathSync;
  patched.native = real.native;
  fs.realpathSync = patched;
  try {
    return await run();
  } finally {
    fs.realpathSync = real;
  }
}

/** Runs `run` with `fs/promises.writeFile` (the lock file's own create) failing with `code` for `.lock.…tmp` paths. */
async function withLockCreateFailure<T>(code: string, run: () => Promise<T>): Promise<T> {
  const real = fsp.writeFile;
  fsp.writeFile = ((target: unknown, ...rest: unknown[]) => {
    if (typeof target === "string" && /\.lock\.[^/]*\.tmp$/u.test(target)) {
      return Promise.reject(Object.assign(new Error(`${code}: open failed`), { code }));
    }
    return (real as (...args: unknown[]) => Promise<void>)(target, ...rest);
  }) as typeof fsp.writeFile;
  try {
    return await run();
  } finally {
    fsp.writeFile = real;
  }
}

function parsedRecord(f: Fixture) {
  const parsed = parseSessionRecord(JSON.parse(f.recordBytes()));
  assert.ok(parsed, "the control pod's record parses");
  return parsed;
}

test("F-6: a transient read of the QUEUE LEASE on an owner rebind is the RETRIED spawn-state-missing, not the final record-ownership — through writeSessionRecord", async () => {
  const f = adoptedAgentPod();
  podDeps();
  holdOwnLease();
  const rebound = { ...parsedRecord(f), acpSessionId: "fresh-after-resume-miss" };
  const before = f.recordBytes();
  for (const code of TRANSIENT) {
    await withReadFailure(path.basename(queueLockFilePath(ID)), code, async () => {
      await assert.rejects(writeSessionRecord(rebound), refusedWith("spawn-state-missing"), code);
    });
  }
  assert.equal(f.recordBytes(), before, "nothing written");
  // negative: a permanent error keeps its old meaning (the lease is not provably ours: final)
  await withReadFailure(path.basename(queueLockFilePath(ID)), "EACCES", async () => {
    await assert.rejects(writeSessionRecord(rebound), refusedWith("record-ownership"));
  });
  // twin: the lease reads, names this process, and the rebind goes through
  await writeSessionRecord(rebound);
  assert.equal(
    (JSON.parse(f.recordBytes()) as DiskRecord).acp_session_id,
    "fresh-after-resume-miss",
  );
});

test("F-7: a transient error on realpath(sessions directory) is the RETRIED spawn-state-missing, not a raw errno — through writeSessionRecord", async () => {
  const f = adoptedAgentPod();
  podDeps();
  const record = { ...parsedRecord(f), lastRequestId: "after realpath" };
  const before = f.recordBytes();
  for (const code of TRANSIENT) {
    await withRealpathFailure(path.join(".acpx", "sessions"), code, async () => {
      await assert.rejects(writeSessionRecord(record), refusedWith("spawn-state-missing"), code);
    });
  }
  assert.equal(f.recordBytes(), before);
  // negative: a permanent error is not relabelled (raw, as before)
  await withRealpathFailure(path.join(".acpx", "sessions"), "EACCES", async () => {
    await assert.rejects(
      writeSessionRecord(record),
      (error) => (error as { code?: string }).code === "EACCES",
    );
  });
  await writeSessionRecord(record);
  assert.equal((JSON.parse(f.recordBytes()) as DiskRecord).last_request_id, "after realpath");
});

test("F-8: fd exhaustion (or a mount's hiccup) TAKING the record lock is the RETRIED record-lock-unavailable, not a raw errno — nothing written", async () => {
  const f = adoptedAgentPod();
  podDeps();
  const record = { ...parsedRecord(f), lastRequestId: "after lock" };
  const before = f.recordBytes();
  const unavailable = (error: unknown) =>
    (error as { code?: string }).code === "record-lock-unavailable" &&
    /could not be taken just now/u.test((error as Error).message);
  for (const code of TRANSIENT) {
    await withLockCreateFailure(code, async () => {
      await assert.rejects(writeSessionRecord(record), unavailable, code);
    });
  }
  assert.equal(f.recordBytes(), before, "nothing written");
  // negative: a permanent error taking the lock is NOT relabelled
  await withLockCreateFailure("EACCES", async () => {
    await assert.rejects(
      writeSessionRecord(record),
      (error) => (error as { code?: string }).code === "EACCES",
    );
  });
  // twin: with no failure the write goes through, and no lock file is left behind
  await writeSessionRecord(record);
  assert.equal((JSON.parse(f.recordBytes()) as DiskRecord).last_request_id, "after lock");
  assert.deepEqual(
    fs.readdirSync(f.sessions).filter((name) => name.includes(".lock")),
    [],
  );
});

// ---- F-19: the lease is read ONLY when the write rebinds the ACP id ------------------------------------------

const LEASE_NAME = () => path.basename(queueLockFilePath(ID));
const LEASE_ERRNOS = [...TRANSIENT, "EACCES"];

test("F-19 (pod writer): an ORDINARY adopted checkpoint — no rebind — still WRITES under any lease-read errno", async () => {
  const f = adoptedAgentPod();
  for (const code of LEASE_ERRNOS) {
    await withReadFailure(LEASE_NAME(), code, async () => {
      await podWrite(f, { ...f.record, last_request_id: `ordinary ${code}` });
    });
    assert.equal((JSON.parse(f.recordBytes()) as DiskRecord).last_request_id, `ordinary ${code}`);
  }
});

test("F-19 (writeSessionRecord, pod mode OFF — a brick-trigger-spawned session's checkpoint on the control pod, through the SQLite ledger): an ordinary adopted checkpoint still WRITES under any lease-read errno", async () => {
  const f = adoptedAgentPod({ controlPod: true });
  const parsed = parsedRecord(f);
  for (const code of LEASE_ERRNOS) {
    await withReadFailure(LEASE_NAME(), code, async () => {
      await writeSessionRecord({ ...parsed, lastRequestId: `control ${code}` });
    });
    assert.equal((JSON.parse(f.recordBytes()) as DiskRecord).last_request_id, `control ${code}`);
  }
});

test("F-19 (SpawnLedger.saveRecord, atrium's in-process writer): an ordinary adopted checkpoint still WRITES; a REBIND under a transient lease errno is the retried refusal (F-6 on this writer too)", async () => {
  const f = adoptedAgentPod({ controlPod: true });
  const ledger = new SpawnLedger();
  try {
    for (const code of LEASE_ERRNOS) {
      await withReadFailure(LEASE_NAME(), code, async () => {
        ledger.saveRecord({ ...f.record, last_request_id: `in-process ${code}` });
      });
      assert.equal(
        (JSON.parse(f.recordBytes()) as DiskRecord).last_request_id,
        `in-process ${code}`,
      );
    }
    const rebound = {
      ...(JSON.parse(f.recordBytes()) as DiskRecord),
      acp_session_id: "fresh-after-resume-miss",
    };
    const before = f.recordBytes();
    for (const code of TRANSIENT) {
      await withReadFailure(LEASE_NAME(), code, async () => {
        assert.throws(() => ledger.saveRecord(rebound), refusedWith("spawn-state-missing"), code);
      });
    }
    assert.equal(f.recordBytes(), before);
    // a permanent errno on a rebind keeps its old meaning; with no failure and the lease held, it lands
    await withReadFailure(LEASE_NAME(), "EACCES", async () => {
      assert.throws(() => ledger.saveRecord(rebound), refusedWith("record-ownership"));
    });
    holdOwnLease();
    ledger.saveRecord(rebound);
    assert.equal(
      (JSON.parse(f.recordBytes()) as DiskRecord).acp_session_id,
      "fresh-after-resume-miss",
    );
  } finally {
    ledger.close();
  }
});

// ---- brick 83cd5b52 (F-20): the committed rows round 2 left out ----------------------------------------------

/** `fs/promises.link` failing with `code` for the lock's own link (`<record>.json.lock` as the target). */
async function withLockLinkFailure<T>(code: string, run: () => Promise<T>): Promise<T> {
  const real = fsp.link;
  fsp.link = ((_existing: unknown, target: unknown, ...rest: unknown[]) => {
    if (typeof target === "string" && target.endsWith(".json.lock")) {
      return Promise.reject(Object.assign(new Error(`${code}: link failed`), { code }));
    }
    return (real as (...args: unknown[]) => Promise<void>)(_existing, target, ...rest);
  }) as typeof fsp.link;
  try {
    return await run();
  } finally {
    fsp.link = real;
  }
}

test("F-20 / F-7: the SECOND realpath ALONE (the canonical sessions dir, while the writer's own dir resolves fine) is the retried refusal; ENOENT there is still 'not canonical'", async () => {
  const f = adoptedAgentPod();
  const elsewhere = path.join(f.home, "elsewhere-sessions");
  fs.mkdirSync(elsewhere);
  const metadata = { spawn_key: f.key };
  const canonical = path.join(".acpx", "sessions");
  for (const code of TRANSIENT) {
    await withRealpathFailure(canonical, code, async () => {
      assert.throws(
        () => openSpawnLedgerForRecord(metadata, elsewhere),
        refusedWith("spawn-state-missing"),
        code,
      );
    });
  }
  // negative: the canonical dir MISSING is "not this HOME's sessions directory" — undefined, not a refusal
  await withRealpathFailure(canonical, "ENOENT", async () => {
    assert.equal(openSpawnLedgerForRecord(metadata, elsewhere), undefined);
  });
  // negative: a permanent errno on the canonical side is not relabelled
  await withRealpathFailure(canonical, "EACCES", async () => {
    assert.throws(
      () => openSpawnLedgerForRecord(metadata, elsewhere),
      (error) => (error as { code?: string }).code === "EACCES",
    );
  });
  // twin: with no failure a directory that is not the canonical one is simply not spawn-owned here
  assert.equal(openSpawnLedgerForRecord(metadata, elsewhere), undefined);
});

test("F-20 / F-8: the lock's LINK step failing (a mount's hiccup, fd pressure) is the retried record-lock-unavailable — nothing written, no temp file left", async () => {
  const f = adoptedAgentPod();
  podDeps();
  const record = { ...parsedRecord(f), lastRequestId: "after link" };
  const before = f.recordBytes();
  for (const code of TRANSIENT) {
    await withLockLinkFailure(code, async () => {
      await assert.rejects(
        writeSessionRecord(record),
        (error) => (error as { code?: string }).code === "record-lock-unavailable",
        code,
      );
    });
    assert.deepEqual(
      fs.readdirSync(f.sessions).filter((name) => name.includes(".lock")),
      [],
      `no lock temp file left behind after ${code}`,
    );
  }
  assert.equal(f.recordBytes(), before, "nothing written");
  // negative: a permanent errno on link is not relabelled
  await withLockLinkFailure("EACCES", async () => {
    await assert.rejects(
      writeSessionRecord(record),
      (error) => (error as { code?: string }).code === "EACCES",
    );
  });
  await writeSessionRecord(record);
  assert.equal((JSON.parse(f.recordBytes()) as DiskRecord).last_request_id, "after link");
});

test("F-20 / F-8: REAL fd exhaustion (a child under `ulimit -n`, the kernel's own EMFILE) while taking the record lock is the retried record-lock-unavailable — not a raw errno, nothing written", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-emfile-"));
  roots.push(dir);
  const recordFile = path.join(dir, `${ID}.json`);
  fs.writeFileSync(recordFile, "{}\n");
  const lockModule = new URL("../src/session/persistence/record-file-lock.js", import.meta.url)
    .href;
  const script = `
    import fs from "node:fs";
    const { withRecordFileLock } = await import(${JSON.stringify(lockModule)});
    const hold = [];
    if (process.env.EXHAUST === "1") {
      try { for (;;) hold.push(fs.openSync("/dev/null", "r")); } catch (error) { if (error.code !== "EMFILE") throw error; }
    }
    let outcome;
    try { await withRecordFileLock(${JSON.stringify(recordFile)}, async () => undefined); outcome = { ok: true }; }
    catch (error) { outcome = { ok: false, code: error.code, message: String(error.message) }; }
    process.stdout.write(JSON.stringify({ ...outcome, held: hold.length }));
  `;
  const run = (exhaust: boolean) => {
    const child = spawnSync(
      "sh",
      [
        "-c",
        `ulimit -n 64 && exec node --input-type=module -e '${script.replaceAll("'", "'\\''")}'`,
      ],
      {
        env: { ...process.env, EXHAUST: exhaust ? "1" : "0" },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as {
      ok: boolean;
      code?: string;
      message?: string;
      held: number;
    };
  };
  const exhausted = run(true);
  assert.ok(exhausted.held > 0, "positive control: the child really did run out of descriptors");
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.code, "record-lock-unavailable", JSON.stringify(exhausted));
  assert.match(String(exhausted.message), /\(EMFILE\)/u, "and it names the errno");
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes(".lock")),
    [],
    "no lock temp file left",
  );
  // twin: the same child with descriptors to spare takes the lock
  assert.deepEqual(run(false), { ok: true, held: 0 });
});
