import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { afterEach } from "node:test";
import { createFileSessionStore } from "../src/runtime/public/file-session-store.js";
import { parseSessionRecord } from "../src/session/persistence/parse.js";
import { writeSessionRecordWithLifecycle } from "../src/session/persistence/repository.js";
import {
  SpawnLedger,
  openSpawnLedgerForRecord,
  spawnIdempotencyKey,
  type DiskRecord,
} from "../src/spawn-ledger.js";

// Every test runs under its own throwaway HOME: the ledger derives its database and the admitted
// instance identity from os.homedir(), and must never touch the box's real ~/.acpx.
const ROOT = "/workspace/spawn-ledger-selftest";
const ORIGINAL_HOME = process.env.HOME;
let home = "";

function freshHome(label: string): string {
  fs.mkdirSync(ROOT, { recursive: true });
  home = fs.mkdtempSync(path.join(ROOT, `${label}-`));
  process.env.HOME = home;
  fs.mkdirSync(path.join(home, ".acpx", "sessions"), { recursive: true });
  return home;
}
afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (home.startsWith(`${ROOT}/`)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
  home = "";
});

const dbFile = () => path.join(home, ".acpx", "brick-outbox.db");
function admit(instanceId: string): void {
  fs.writeFileSync(
    path.join(home, ".acpx", "instance.json"),
    JSON.stringify({ instance_id: instanceId, home }),
  );
}
const RECORD_ID = "11111111-1111-4111-8111-111111111111";
function diskRecord(metadata: Record<string, string>, id = RECORD_ID): DiskRecord {
  return {
    schema: "acpx.session.v1",
    kind: "session",
    acpx_record_id: id,
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
function reserve(ledger: SpawnLedger, runId = "run-1", target = RECORD_ID) {
  return ledger.reserveSpawn({
    run_id: runId,
    fence: 1,
    trigger_id: "trigger-1",
    parent_brick_id: "22222222-2222-4222-8222-222222222222",
    child_brick_id: "33333333-3333-4333-8333-333333333333",
    target_record_id: target,
  });
}
function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

// The pre-ledger ("brick outbox") schema, verbatim as acpx main shipped it before 2026-10-05.
const OLD_SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE session_revision (session_id TEXT PRIMARY KEY, projection_epoch INTEGER NOT NULL,
 last_revision INTEGER NOT NULL, history_id TEXT NOT NULL);
CREATE TABLE outbox (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, brick_id TEXT NOT NULL,
 op TEXT NOT NULL CHECK(op IN ('upsert','tombstone')), revision INTEGER NOT NULL,
 projection_epoch INTEGER NOT NULL, payload TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','applied','acknowledged','superseded','abandoned')),
 prepared_at TEXT NOT NULL, applied_at TEXT, acknowledged_at TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE UNIQUE INDEX idx_outbox_rev ON outbox(session_id,projection_epoch,revision);
CREATE INDEX idx_outbox_open ON outbox(state) WHERE state IN ('prepared','applied');
CREATE TABLE projection_head (session_id TEXT PRIMARY KEY, brick_id TEXT, op TEXT NOT NULL,
 projection_epoch INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
 acked_epoch INTEGER, acked_revision INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE spawn_run (run_id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, parent_brick_id TEXT NOT NULL,
 child_brick_id TEXT NOT NULL, adopted_fence INTEGER, ack_confirmed_at TEXT,
 receipt_conflict TEXT, terminal_state TEXT, session_id TEXT, session_url TEXT, updated_at TEXT NOT NULL);
CREATE TABLE spawn_attempt (run_id TEXT NOT NULL, fence INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
 target_record_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('reserved','launched','published','adopted','revoked','cancelled','orphaned')),
 revoked_at TEXT, session_url TEXT, reserved_at TEXT NOT NULL, settled_at TEXT, last_error TEXT,
 PRIMARY KEY(run_id,fence));
CREATE INDEX idx_attempt_open ON spawn_attempt(state) WHERE state IN ('reserved','launched','published');
`;
function seedOldOutbox(): void {
  const db = new DatabaseSync(dbFile());
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(OLD_SCHEMA);
  const now = new Date().toISOString();
  const outbox = db.prepare(
    "INSERT INTO outbox(id,session_id,brick_id,op,revision,projection_epoch,payload,state,prepared_at) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  for (let revision = 1; revision <= 50; revision++) {
    outbox.run(`intent-${revision}`, RECORD_ID, "b", "upsert", revision, 0, "{}", "applied", now);
  }
  db.prepare("INSERT INTO session_revision VALUES(?,?,?,?)").run(RECORD_ID, 0, 50, "H");
  db.prepare(
    "INSERT INTO projection_head(session_id,brick_id,op,projection_epoch,revision,payload,updated_at) VALUES(?,?,?,?,?,?,?)",
  ).run(RECORD_ID, "b", "upsert", 0, 50, "{}", now);
  db.prepare(
    "INSERT INTO spawn_run(run_id,trigger_id,parent_brick_id,child_brick_id,updated_at) VALUES(?,?,?,?,?)",
  ).run("run-old", "t", "p", "c", now);
  db.prepare(
    "INSERT INTO spawn_attempt(run_id,fence,idempotency_key,target_record_id,state,reserved_at) VALUES(?,?,?,?,?,?)",
  ).run("run-old", 1, "key-old", "44444444-4444-4444-8444-444444444444", "launched", now);
  const meta = db.prepare("INSERT INTO meta VALUES(?,?)");
  for (const [key, value] of [
    ["schema_version", "1"],
    ["instance_id", "i-111111111111"],
    ["projection_identity", "{}"],
    ["drain", '{"cutover_id":"x"}'],
    ["admission_frontier", "[]"],
    ["publication:intent-1", "{}"],
    [
      "initial_prompt:run-old",
      '{"run_id":"run-old","delivery_id":"d","payload":{},"released_at":null}',
    ],
    ["spawn_child:run-old:1", '{"pid":1,"boot":null,"start":null}'],
  ]) {
    meta.run(key, value);
  }
  db.close();
}
function tableNames(): string[] {
  const db = new DatabaseSync(dbFile());
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => String(row.name));
  } finally {
    db.close();
  }
}
function metaRows(): Record<string, string> {
  const db = new DatabaseSync(dbFile());
  try {
    return Object.fromEntries(
      db
        .prepare("SELECT key,value FROM meta ORDER BY key")
        .all()
        .map((row) => [String(row.key), String(row.value)]),
    );
  } finally {
    db.close();
  }
}

test("migration drops the projection tables of a live old-schema db with rows and keeps the spawn rows", () => {
  freshHome("migrate");
  seedOldOutbox();
  // A concurrent reader holding a snapshot — the shape of a live WAL db on first open.
  const reader = new DatabaseSync(dbFile());
  reader.exec("BEGIN");
  assert.equal(Number(reader.prepare("SELECT COUNT(*) AS n FROM outbox").get()!.n), 50);
  const ledger = new SpawnLedger();
  reader.exec("COMMIT");
  reader.close();
  try {
    assert.deepEqual(tableNames(), ["meta", "spawn_attempt", "spawn_run"]);
    assert.deepEqual(Object.keys(metaRows()), [
      "initial_prompt:run-old",
      "instance_id",
      "schema_version",
      "spawn_child:run-old:1",
    ]);
    // ⚠️ The version must stay "1": the pre-ledger code refuses any other value on every
    // session write, so bumping it would fail every still-running old queue owner.
    assert.equal(metaRows().schema_version, "1");
    assert.equal(ledger.getSpawnRun("run-old")?.trigger_id, "t");
    assert.equal(ledger.getSpawnAttemptByKey("key-old")?.state, "launched");
  } finally {
    ledger.close();
  }
  // An old-code process re-creating its (empty) tables during the deploy skew: dropped again.
  const old = new DatabaseSync(dbFile());
  old.exec("CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY)");
  old.close();
  new SpawnLedger().close();
  assert.deepEqual(tableNames(), ["meta", "spawn_attempt", "spawn_run"]);
});

test("opening a current ledger takes no write lock; only a needed migration does", async () => {
  freshHome("open");
  new SpawnLedger().close();
  const holder = new DatabaseSync(dbFile());
  holder.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
  try {
    const started = Date.now();
    const ledger = new SpawnLedger();
    ledger.close();
    assert.ok(Date.now() - started < 1000, "a current schema must open without waiting");
    // Negative control: a retired table left behind needs the write lock, so the same open
    // under the same live holder must fail busy.
    holder.exec("CREATE TABLE outbox (id TEXT PRIMARY KEY)");
    holder.exec("COMMIT");
    holder.exec("BEGIN IMMEDIATE");
    assert.throws(
      () => new SpawnLedger(),
      (error) => codeOf(error) === "outbox-busy",
    );
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
});

test("a spawn reservation round-trips through launch, publication, adoption and receipt", async () => {
  freshHome("roundtrip");
  admit("i-111111111111");
  const ledger = new SpawnLedger();
  try {
    ledger.bindIdentity({ instance_id: "i-111111111111" });
    const attempt = reserve(ledger);
    assert.equal(attempt.state, "reserved");
    assert.equal(attempt.idempotency_key, spawnIdempotencyKey("run-1", 1));
    assert.deepEqual(reserve(ledger), attempt, "reservation is idempotent");
    assert.equal(ledger.getSpawnAttemptByKey(attempt.idempotency_key)?.target_record_id, RECORD_ID);
    assert.equal(ledger.listSpawnAttempts("run-1").length, 1);
    assert.equal(ledger.listSpawnRuns().length, 1);

    assert.equal(ledger.recordSpawnChild("run-1", 1, process.pid).state, "launched");
    assert.equal(ledger.spawnChildLiveness("run-1", 1), "alive");

    const metadata = { spawn_key: attempt.idempotency_key, spawn_state: "pending" };
    ledger.saveRecord(diskRecord(metadata));
    // A writer that did not load spawn_state must not drop it.
    const { spawn_state: _dropped, ...withoutState } = metadata;
    const writer = diskRecord(withoutState);
    ledger.writeOwnedRecord(RECORD_ID, writer, () => writer);
    assert.equal(ledger.readRecord(RECORD_ID)?.metadata?.spawn_state, "pending");

    const url = `https://atrium.example.invalid/?session=${RECORD_ID}`;
    assert.equal(
      ledger.transitionSpawn("run-1", 1, "published", { session_url: url }).session_url,
      url,
    );
    assert.equal(ledger.readRecord(RECORD_ID)?.metadata?.spawn_state, "published");
    assert.equal(ledger.transitionSpawn("run-1", 1, "adopted").state, "adopted");
    const run = ledger.getSpawnRun("run-1")!;
    assert.equal(run.adopted_fence, 1);
    assert.equal(run.session_id, RECORD_ID);
    assert.equal(run.session_url, url);

    const deliveryId = ledger.queueInitialPrompt("run-1", { text: "queued" });
    assert.equal(ledger.queueInitialPrompt("run-1", { text: "queued" }), deliveryId);
    assert.deepEqual(
      ledger.pendingInitialPrompts().map((item) => item.delivery_id),
      [deliveryId],
    );
    let submitted = 0;
    await ledger.releaseInitialPrompt("run-1", async (_payload, id) => {
      assert.equal(id, deliveryId);
      submitted++;
    });
    await ledger.releaseInitialPrompt("run-1", async () => {
      submitted++;
    });
    assert.equal(submitted, 1);
    assert.equal(ledger.pendingInitialPrompts().length, 0);

    const receipt = ledger.confirmSpawnReceipt("run-1", {
      status: "spawned",
      session_id: RECORD_ID,
    });
    assert.ok(receipt.ack_confirmed_at);
    assert.equal(receipt.receipt_conflict, null);
  } finally {
    ledger.close();
  }
});

test("the spawn_key ownership check refuses foreign, rebinding and revoked writers", () => {
  freshHome("ownership");
  const ledger = new SpawnLedger();
  try {
    const attempt = reserve(ledger);
    ledger.recordSpawnChild("run-1", 1, process.pid);
    const owned = diskRecord({ spawn_key: attempt.idempotency_key, spawn_state: "pending" });
    ledger.saveRecord(owned);
    assert.throws(
      () => ledger.saveRecord({ ...owned, acp_session_id: "rebound" }),
      /belongs to another ACP session/,
    );
    assert.throws(
      () => ledger.saveRecord(diskRecord({ spawn_key: "someone-else" })),
      (error) => codeOf(error) === "record-ownership",
    );
    assert.throws(
      () =>
        ledger.saveRecord(
          diskRecord({ spawn_key: "unreserved" }, "55555555-5555-4555-8555-555555555555"),
        ),
      /does not own reserved destination/,
    );
    ledger.transitionSpawn("run-1", 1, "revoked");
    assert.throws(
      () => ledger.saveRecord(owned),
      (error) => codeOf(error) === "spawn-revoked",
    );
    assert.throws(
      () => ledger.transitionSpawn("run-1", 1, "published"),
      (error) => codeOf(error) === "invalid-spawn-transition",
    );
    assert.throws(() => ledger.transitionSpawn("run-1", 1, "cancelled"), /forbidden/);
    assert.equal(
      ledger.transitionSpawn("run-1", 1, "cancelled", { child_gone: true }).state,
      "cancelled",
    );
  } finally {
    ledger.close();
  }
});

test("a conflicting central receipt orphans the locally adopted record", () => {
  freshHome("receipt");
  const ledger = new SpawnLedger();
  try {
    const attempt = reserve(ledger);
    ledger.recordSpawnChild("run-1", 1, process.pid);
    ledger.saveRecord(diskRecord({ spawn_key: attempt.idempotency_key }));
    ledger.transitionSpawn("run-1", 1, "published", { session_url: "https://x.invalid/" });
    ledger.transitionSpawn("run-1", 1, "adopted");
    const run = ledger.confirmSpawnReceipt("run-1", {
      status: "spawned",
      session_id: "66666666-6666-4666-8666-666666666666",
    });
    assert.ok(run.receipt_conflict);
    assert.equal(ledger.readRecord(RECORD_ID)?.metadata?.spawn_state, "orphaned");
  } finally {
    ledger.close();
  }
});

test("bindIdentity is the only instance_id writer and refuses an unadmitted or foreign identity", () => {
  freshHome("bind");
  const ledger = new SpawnLedger();
  try {
    assert.throws(
      () => ledger.bindIdentity({ instance_id: "i-111111111111" }),
      (error) => codeOf(error) === "outbox-home-unadmitted",
    );
    admit("i-111111111111");
    assert.throws(
      () => ledger.bindIdentity({ instance_id: "i-222222222222" }),
      (error) => codeOf(error) === "outbox-foreign-bind",
    );
    assert.equal(metaRows().instance_id, undefined, "a refused bind writes nothing");
    ledger.bindIdentity({ instance_id: "i-111111111111" });
    assert.equal(metaRows().instance_id, "i-111111111111");
  } finally {
    ledger.close();
  }
  // By construction: exactly one write of the identity row exists in src/, inside bindIdentity.
  const writers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (file.endsWith(".ts")) {
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(/setMeta\(\s*["'`]instance_id/g)) {
          writers.push(`${file}@${match.index}`);
        }
      }
    }
  };
  walk(path.resolve("src"));
  assert.equal(writers.length, 1, writers.join("\n"));
  const source = fs.readFileSync(path.resolve("src/spawn-ledger.ts"), "utf8");
  const at = Number(writers[0].split("@")[1]);
  assert.ok(
    at > source.indexOf("bindIdentity(identity") &&
      at < source.indexOf("private assertBoundToThisInstance"),
    "the instance_id writer must sit inside bindIdentity",
  );
});

test("the instance-mismatch detector refuses spawn-owned writes after instance.json was re-minted", () => {
  freshHome("mismatch");
  admit("i-111111111111");
  const ledger = new SpawnLedger();
  try {
    ledger.bindIdentity({ instance_id: "i-111111111111" });
    const attempt = reserve(ledger);
    ledger.recordSpawnChild("run-1", 1, process.pid);
    const owned = diskRecord({ spawn_key: attempt.idempotency_key });
    ledger.saveRecord(owned);
    admit("i-333333333333");
    assert.throws(
      () => ledger.saveRecord(owned),
      (error) => codeOf(error) === "outbox-instance-mismatch",
    );
  } finally {
    ledger.close();
  }
});

test("no ordinary session write opens the spawn ledger database", async () => {
  freshHome("ordinary");
  const sessions = path.join(home, ".acpx", "sessions");
  const ordinary = parseSessionRecord(
    diskRecord({ brick: "22222222-2222-4222-8222-222222222222" }),
  );
  assert.ok(ordinary);
  const store = createFileSessionStore({ stateDir: path.join(home, ".acpx") });
  await store.save(ordinary);
  ordinary.name = "second write";
  await writeSessionRecordWithLifecycle(ordinary);
  assert.equal(openSpawnLedgerForRecord(undefined, sessions), undefined);
  assert.equal(openSpawnLedgerForRecord({ brick: "b" }, sessions), undefined);
  assert.equal((await store.load(RECORD_ID))?.name, "second write");
  assert.equal(
    fs.existsSync(dbFile()),
    false,
    "an ordinary write must not create or open the ledger",
  );
  // Positive control: a spawn-owned record on the same path DOES go through the ledger, which
  // refuses it because no reservation owns the destination.
  const spawnOwned = parseSessionRecord(
    diskRecord({ spawn_key: "unreserved" }, "77777777-7777-4777-8777-777777777777"),
  );
  assert.ok(spawnOwned);
  await assert.rejects(store.save(spawnOwned), /does not own reserved destination/);
  assert.equal(fs.existsSync(dbFile()), true);
});

test("a live lock holder keeps a contender busy beyond 5 s; its death releases the lock", async () => {
  freshHome("lock");
  const ledger = new SpawnLedger();
  const marker = path.join(home, "holder-acted");
  const holder = fork("test/fixtures/spawn-ledger-lock-holder.mjs", [ledger.dbPath, marker], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exit = new Promise((resolve) => holder.once("exit", resolve));
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(marker) && Date.now() < deadline && holder.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(marker), "EXAMINED NOTHING: the holder never took the lock");
    assert.throws(
      () => reserve(ledger),
      (error) => codeOf(error) === "outbox-busy",
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(holder.exitCode, null);
    assert.throws(
      () => reserve(ledger),
      (error) => codeOf(error) === "outbox-busy",
    );
    holder.kill("SIGKILL");
    await exit;
    assert.equal(reserve(ledger).state, "reserved");
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill("SIGKILL");
      await exit;
    }
    ledger.close();
  }
});

for (const scenario of ["positive", "revoked"]) {
  test(`brick-trigger spawn through the real CLI: ${scenario}`, () => {
    fs.mkdirSync(ROOT, { recursive: true });
    const childHome = fs.mkdtempSync(path.join(ROOT, `real-${scenario}-`));
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "test/fixtures/spawn-ledger-real-child.ts", scenario],
        {
          cwd: process.cwd(),
          env: { PATH: process.env.PATH, HOME: childHome },
          encoding: "utf8",
          // A cold CLI start is load-bound: at load ~76 on 8 cores (2026-10-05) one positive run
          // took 26 s and one starved past 30 s, against a sub-second warm run. Not the thing
          // under test, so the budget is generous.
          timeout: 90_000,
        },
      );
      assert.ok(result.stdout.includes("ACTORS=1"), `EXAMINED NOTHING: ${result.stderr}`);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /PHASES=2/);
    } finally {
      fs.rmSync(childHome, { recursive: true, force: true });
    }
  });
}
