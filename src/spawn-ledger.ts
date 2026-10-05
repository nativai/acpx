import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isSqliteExperimentalWarning } from "./models/ui-prefs-store.js";

/**
 * The spawn ledger: the durable record of brick-trigger auto-spawns (runs, fenced attempts, the
 * child each attempt launched, its queued initial prompt) plus the ownership guard that keeps a
 * revoked or foreign attempt from writing a spawn-owned session record.
 *
 * It is ONLY for spawn-owned records (`metadata.spawn_key`). An ordinary session write never opens
 * it — `openSpawnLedgerForRecord` returns undefined for those. Until 2026-10-05 this module was the
 * "brick outbox" and also carried a session→brick projection and a drain/maintenance gate; both
 * were deleted (brick 750d674d — the projection had delivered nothing since 2026-09-15 and its
 * write lock was held ~97% of the time on devbox, brick 7d717c8a).
 *
 * acpx-ui loads this module dynamically through `acpx __spawn-ledger-module` and checks
 * `SPAWN_LEDGER_API_VERSION`; change the surface only in lockstep with acpx-ui `server/brickOutbox.ts`.
 */

type SqliteModule = { DatabaseSync: new (path: string) => DatabaseSync };
let sqliteModule: SqliteModule | undefined;

/**
 * node:sqlite must NOT load at CLI-module time: importing it emits an
 * ExperimentalWarning on stderr, and --version/--help/non-writing commands
 * promise clean stderr. The module is required lazily, on first SpawnLedger
 * construction — i.e. only on a path that actually opens the ledger. The
 * filter installed around the require drops exactly the one SQLite
 * ExperimentalWarning (name+message matched by the shared, tested predicate
 * in ui-prefs-store) and is removed immediately; every other warning flows
 * to the original handler. NEVER widen this to --no-warnings or
 * removeAllListeners — the ui-prefs-store comment explains the blast radius.
 */
function requireSqlite(): SqliteModule {
  if (sqliteModule) {
    return sqliteModule;
  }
  const original = process.emitWarning.bind(process);
  const filtered = (warning: unknown, ...rest: unknown[]): void => {
    if (isSqliteExperimentalWarning(warning, rest)) {
      return;
    }
    (original as (...args: unknown[]) => void)(warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    sqliteModule = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

export const SPAWN_LEDGER_API_VERSION = 2;

export type SpawnAttemptState =
  | "reserved"
  | "launched"
  | "published"
  | "adopted"
  | "revoked"
  | "cancelled"
  | "orphaned";

export interface SpawnReservation {
  run_id: string;
  fence: number;
  trigger_id: string;
  parent_brick_id: string;
  child_brick_id: string;
  target_record_id: string;
}

export interface SpawnAttempt extends SpawnReservation {
  idempotency_key: string;
  state: SpawnAttemptState;
  revoked_at: string | null;
  session_url: string | null;
  reserved_at: string;
  settled_at: string | null;
  last_error: string | null;
}

export interface SpawnRun {
  run_id: string;
  trigger_id: string;
  parent_brick_id: string;
  child_brick_id: string;
  adopted_fence: number | null;
  ack_confirmed_at: string | null;
  receipt_conflict: string | null;
  terminal_state: string | null;
  session_id: string | null;
  session_url: string | null;
  updated_at: string;
}

export interface SpawnTransitionEvidence {
  child_started?: boolean;
  child_gone?: boolean;
  higher_fence?: number;
  session_url?: string;
  reason?: string;
}

export interface CentralRunReceipt {
  status: "spawned" | "failed" | "cancelled" | "skipped" | "conflict";
  session_id?: string;
  session_url?: string;
}

export type DiskRecord = Record<string, unknown> & { metadata?: Record<string, string> };

export class SpawnLedgerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SpawnLedgerError";
  }
}

/**
 * The ledger for a record write, or undefined when the record is not spawn-owned or does not live
 * in this HOME's canonical session directory. Ordinary session writes therefore never open SQLite.
 */
export function openSpawnLedgerForRecord(
  metadata: Record<string, string> | undefined,
  directory = path.join(os.homedir(), ".acpx", "sessions"),
): SpawnLedger | undefined {
  if (!metadata?.spawn_key || !isCanonicalSessionDirectory(directory)) {
    return undefined;
  }
  return new SpawnLedger();
}

function isCanonicalSessionDirectory(directory: string): boolean {
  const actual = fs.realpathSync(directory);
  let canonical: string;
  try {
    canonical = fs.realpathSync(path.join(os.homedir(), ".acpx", "sessions"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return false;
  }
  return actual === canonical;
}

const BUSY_ERROR_PATTERN = /database is locked|SQLITE_BUSY/;

function isBusyAcquisitionError(error: unknown): boolean {
  return error instanceof Error && BUSY_ERROR_PATTERN.test(error.message);
}

/** Synchronous sleep via Atomics.wait — the retry loop owns the waiting, no timers. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LEDGER_RETRY_BUDGET_MS = 4_000;
const LEDGER_RETRY_CAP_MS = 250;

/**
 * Retry `op` on SQLITE_BUSY only, jittered exponential backoff (10-25 ms start,
 * 250 ms cap) inside a 4 s budget; every other failure propagates immediately.
 * Measured busy sites: BEGIN IMMEDIATE acquisition and the constructor's PRAGMA
 * exec (journal_mode=WAL re-assertion hits a concurrent writer's lock).
 */
function retryOnBusy<T>(op: () => T): T {
  const started = Date.now();
  let delay = 10 + Math.floor(Math.random() * 16); // jittered 10-25 ms start
  for (;;) {
    try {
      return op();
    } catch (error) {
      const waited = Date.now() - started;
      if (!isBusyAcquisitionError(error) || waited >= LEDGER_RETRY_BUDGET_MS) {
        throw error; // translate() maps an exhausted busy to outbox-busy
      }
      sleepSync(Math.min(LEDGER_RETRY_CAP_MS, delay));
      delay = Math.min(
        LEDGER_RETRY_CAP_MS,
        Math.ceil(delay * 1.7) + Math.floor(Math.random() * 25),
      );
    }
  }
}

/**
 * `retryOnBusy` with the SAME budget and backoff, but waiting with a timer instead of
 * `Atomics.wait`, so a contender yields the event loop instead of freezing it (brick eb4c8d06).
 * Every async record writer (the repository and the public file store) must take this path: a
 * frozen loop in a queue owner stalls everything else that owner is doing, and a same-process
 * holder that needs the loop to reach COMMIT cannot get it.
 * `test/spawn-ledger-async-wait.test.ts` goes red if an async caller waits synchronously again.
 */
async function retryOnBusyAsync<T>(op: () => T): Promise<T> {
  const started = Date.now();
  let delay = 10 + Math.floor(Math.random() * 16);
  for (;;) {
    try {
      return op();
    } catch (error) {
      const waited = Date.now() - started;
      if (!isBusyAcquisitionError(error) || waited >= LEDGER_RETRY_BUDGET_MS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(LEDGER_RETRY_CAP_MS, delay)));
      delay = Math.min(
        LEDGER_RETRY_CAP_MS,
        Math.ceil(delay * 1.7) + Math.floor(Math.random() * 25),
      );
    }
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS spawn_run (
 run_id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, parent_brick_id TEXT NOT NULL,
 child_brick_id TEXT NOT NULL, adopted_fence INTEGER, ack_confirmed_at TEXT,
 receipt_conflict TEXT, terminal_state TEXT, session_id TEXT, session_url TEXT,
 updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS spawn_attempt (
 run_id TEXT NOT NULL, fence INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
 target_record_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('reserved','launched','published','adopted','revoked','cancelled','orphaned')),
 revoked_at TEXT, session_url TEXT, reserved_at TEXT NOT NULL, settled_at TEXT, last_error TEXT,
 PRIMARY KEY(run_id,fence));
CREATE INDEX IF NOT EXISTS idx_attempt_open ON spawn_attempt(state)
 WHERE state IN ('reserved','launched','published');
`;

/**
 * The deleted projection's tables and meta rows, dropped by any open that finds them: an acpx or
 * acpx-ui process still running the pre-ledger code during a deploy re-creates the (empty) tables
 * with `CREATE TABLE IF NOT EXISTS`, and the next open here drops them again.
 *
 * ⚠️ DO NOT "FINISH" THIS MIGRATION BY BUMPING `schema_version` TO "2". It looks like the proper
 * schema-version migration and it is an outage: the pre-ledger code refuses to open any outbox
 * whose `schema_version` is not "1", and it opened the outbox on EVERY session write — so every
 * still-running old queue owner on the box would fail every record persist until it was recycled.
 * The spawn tables' shape is unchanged, so "1" stays true for them.
 * `test/spawn-ledger.test.ts` asserts the stored version stays "1" after the drop.
 */
const RETIRED_TABLES = ["outbox", "projection_head", "session_revision"] as const;
const RETIRED_META_WHERE =
  "key IN ('drain','admission_frontier','projection_identity') OR key LIKE 'publication:%'";

function now(): string {
  return new Date().toISOString();
}
function sameChildIdentity(
  left: { boot: string | null; start: string | null },
  right: { boot: string; start: string },
): boolean {
  return left.boot === right.boot && left.start === right.start;
}
function assertUuid(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new SpawnLedgerError("invalid-record-id", "record id must be a lowercase UUID");
  }
}
export function spawnIdempotencyKey(runId: string, fence: number): string {
  return createHash("sha256").update(`acpx-spawn:${runId}:${fence}`).digest("hex").slice(0, 32);
}

/**
 * The instance id this HOME admits — the only identity a ledger living under this HOME may carry.
 *
 * ⚠️ TAKES NO ARGUMENT, AND THAT IS THE WHOLE POINT. `SpawnLedger`'s constructor derives `dbPath`
 * from `os.homedir()`; this derives the admitted id from the same `os.homedir()`. Both sides of the
 * comparison therefore come from the environment the process is actually running in, and a caller
 * cannot make them agree by handing one of them in.
 *
 * A missing / unreadable `instance.json` is a REFUSAL, not a permit: this HOME has not been
 * admitted, so nothing may bind a ledger under it (brick 42b4fb28). Production never reaches this
 * state, because acpx-ui mints the record before it starts the trigger owner.
 */
function admittedInstanceId(): string {
  const home = os.homedir();
  const file = path.join(home, ".acpx", "instance.json");
  let identity: { instance_id?: unknown; home?: unknown };
  try {
    identity = JSON.parse(fs.readFileSync(file, "utf8")) as typeof identity;
  } catch (error) {
    throw new SpawnLedgerError(
      "outbox-home-unadmitted",
      `this HOME has no admitted instance identity at ${file}, so nothing may bind a spawn ledger under it: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof identity.instance_id !== "string" ||
    !/^i-[0-9a-f]{12}$/.test(identity.instance_id) ||
    typeof identity.home !== "string" ||
    path.resolve(identity.home) !== path.resolve(home)
  ) {
    throw new SpawnLedgerError(
      "instance-identity-moved",
      "the spawn ledger requires this HOME's admitted instance identity",
    );
  }
  return identity.instance_id;
}

function metadataValue(record: DiskRecord | undefined, key: string): string | undefined {
  return record?.metadata?.[key];
}
function recordOwnsAttempt(record: DiskRecord | undefined, attempt: SpawnAttempt): boolean {
  if (!record) {
    return false;
  }
  return (
    metadataValue(record, "spawn_key") === attempt.idempotency_key &&
    record.acpx_record_id === attempt.target_record_id
  );
}
function receiptConflicts(run: SpawnRun, receipt: CentralRunReceipt): boolean {
  return Boolean(
    receipt.status === "spawned" && run.session_id && receipt.session_id !== run.session_id,
  );
}
function assertRecordIdentity(
  id: string,
  writer: DiskRecord,
  current: DiskRecord | undefined,
): void {
  if (writer.acpx_record_id !== id) {
    throw new SpawnLedgerError("record-ownership", "record id does not own destination");
  }
  if (!current) {
    return;
  }
  if (current.acpx_record_id !== id) {
    throw new SpawnLedgerError("record-ownership", "existing record id differs");
  }
  if (metadataValue(current, "spawn_key") !== metadataValue(writer, "spawn_key")) {
    throw new SpawnLedgerError("record-ownership", "destination belongs to another spawn attempt");
  }
  // acp_session_id is protected on reserved destinations: a delayed child must not rebind a
  // record an attempt owns.
  if (metadataValue(current, "spawn_key") && current.acp_session_id !== writer.acp_session_id) {
    throw new SpawnLedgerError("record-ownership", "destination belongs to another ACP session");
  }
}
/** `spawn_state` belongs to the spawn reservation; a record writer that did not load it must not drop it. */
function preserveSpawnState(result: DiskRecord, current: DiskRecord | undefined): void {
  if (metadataValue(current, "spawn_key")) {
    result.metadata = {
      ...result.metadata,
      spawn_state: metadataValue(current, "spawn_state") ?? "pending",
    };
  }
}
interface TransitionContext {
  owned: boolean;
  unadopted: boolean;
  fence: number;
  evidence: SpawnTransitionEvidence;
}
const SPAWN_TRANSITIONS: Record<string, (context: TransitionContext) => boolean> = {
  "reserved:launched": (context) => context.evidence.child_started === true,
  "reserved:revoked": () => true,
  "reserved:cancelled": () => true,
  "launched:revoked": () => true,
  "launched:published": (context) => context.owned && context.unadopted,
  "published:revoked": (context) => (context.evidence.higher_fence ?? 0) > context.fence,
  "published:adopted": (context) => context.owned && context.unadopted,
  "revoked:cancelled": (context) => context.evidence.child_gone === true,
  "revoked:orphaned": (context) => context.owned && !context.unadopted,
  "revoked:adopted": (context) => context.owned && context.unadopted,
};

/** Atomic file replacement with the directory entry persisted before SQLite commits. */
function writeRecordAtomic(file: string, record: DiskRecord): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

export class SpawnLedger {
  readonly dbPath: string;
  readonly sessionsDir: string;
  private readonly db: DatabaseSync;
  /** Open only inside `bindIdentity`, after its check has passed. See `setMeta`. */
  private admittingIdentity = false;

  constructor() {
    const directory = path.join(os.homedir(), ".acpx");
    fs.mkdirSync(directory, { recursive: true });
    this.sessionsDir = path.join(directory, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    // The file keeps its pre-ledger name: renaming a live WAL database while old-code processes
    // still hold it open across a deploy is not safe.
    this.dbPath = path.join(directory, "brick-outbox.db");
    this.db = new (requireSqlite().DatabaseSync)(this.dbPath);
    try {
      // busy_timeout=0: every busy site is retried by retryOnBusy, so the loop owns the waiting
      // and the budget accounting stays exact.
      this.db.exec("PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;");
      // ⚠️ OPENING IS READ-ONLY UNLESS THE SCHEMA NEEDS WORK. The pre-ledger constructor re-asserted
      // journal_mode and ran CREATE/setMeta under BEGIN IMMEDIATE on every open, so merely opening
      // took the box-wide write lock (brick 7d717c8a). WAL is persistent in the file; set it once.
      const mode = retryOnBusy(() => this.db.prepare("PRAGMA journal_mode").get());
      if (String(mode?.journal_mode) !== "wal") {
        retryOnBusy(() => this.db.exec("PRAGMA journal_mode=WAL"));
      }
      if (!retryOnBusy(() => this.schemaCurrent())) {
        this.locked(() => this.migrateSchema());
      }
    } catch (error) {
      this.db.close();
      throw this.translate(error);
    }
  }

  /** Read-only: the spawn schema exists at version "1" and nothing retired is left behind. */
  private schemaCurrent(): boolean {
    const names = new Set(
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')")
        .all()
        .map((row) => String(row.name)),
    );
    const required = ["meta", "spawn_run", "spawn_attempt", "idx_attempt_open"];
    if (!required.every((name) => names.has(name))) {
      return false;
    }
    if (RETIRED_TABLES.some((name) => names.has(name)) || this.meta("schema_version") !== "1") {
      return false;
    }
    return !this.db.prepare(`SELECT 1 FROM meta WHERE ${RETIRED_META_WHERE} LIMIT 1`).get();
  }

  private migrateSchema(): void {
    const exists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
      .get();
    const version = exists ? this.meta("schema_version") : null;
    if (version !== null && version !== "1") {
      throw new SpawnLedgerError(
        "outbox-schema-version",
        `unsupported spawn ledger version ${version}`,
      );
    }
    this.db.exec(SCHEMA);
    for (const table of RETIRED_TABLES) {
      this.db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    this.db.prepare(`DELETE FROM meta WHERE ${RETIRED_META_WHERE}`).run();
    this.setMeta("schema_version", "1");
  }

  close(): void {
    this.db.close();
  }

  /**
   * ⚠️ THE ONLY WRITER of the ledger's `instance_id` meta row — and therefore the only place the
   * HOME check has to live. DO NOT ADD A SECOND WRITE OF THAT ROW ANYWHERE ELSE: on 2026-09-15
   * an acpx-ui test bound a fixture identity into devbox's real store and every session-mutating
   * operation on the box failed for ~80 minutes (bricks 507a1c38 / 42b4fb28).
   * `test/spawn-ledger.test.ts` enumerates the occurrences and goes red on a second writer.
   *
   * The refusal is ABSENCE-PROOF: `admittedInstanceId()` derives the admitted id from
   * `os.homedir()` and throws when it cannot.
   */
  bindIdentity(identity: { instance_id: string }): void {
    // Read once: a getter could answer the check and the write differently.
    const instanceId = identity.instance_id;
    this.locked(() => {
      const previous = this.meta("instance_id");
      if (previous && previous !== instanceId) {
        throw new SpawnLedgerError(
          "outbox-instance-mismatch",
          "spawn ledger belongs to another instance",
        );
      }
      const admitted = admittedInstanceId();
      if (instanceId !== admitted) {
        throw new SpawnLedgerError(
          "outbox-foreign-bind",
          `refusing to bind ${instanceId} into ${this.dbPath}: ${path.join(os.homedir(), ".acpx", "instance.json")} admits ${admitted}. A spawn ledger under a HOME may only carry that HOME's own instance identity — mint an isolated HOME for this process instead of writing into the box's own (brick 42b4fb28).`,
        );
      }
      this.admittingIdentity = true;
      try {
        this.setMeta("instance_id", instanceId);
      } finally {
        this.admittingIdentity = false;
      }
    });
  }

  /**
   * The instance-mismatch detector, for spawn-owned records only: a ledger bound to one instance
   * must not keep writing records after `instance.json` was re-minted under it.
   */
  private assertBoundToThisInstance(): void {
    const bound = this.meta("instance_id");
    if (!bound) {
      return;
    }
    const admitted = admittedInstanceId();
    if (bound !== admitted) {
      throw new SpawnLedgerError(
        "outbox-instance-mismatch",
        `${this.dbPath} is bound to instance ${bound}, but ${path.join(os.homedir(), ".acpx", "instance.json")} now ` +
          `reports ${admitted} — every spawn-owned record write on this HOME will keep failing until ` +
          `the stale binding is cleared (brick 7d03eca1). Back up ${this.dbPath}, confirm the mismatch ` +
          `by reading its \`meta\` table, then run \`DELETE FROM meta WHERE key='instance_id'\`; the ` +
          `trigger owner re-binds the live identity on its next start.`,
      );
    }
  }

  listSpawnAttempts(runId: string): SpawnAttempt[] {
    return this.db
      .prepare(`SELECT a.*,r.trigger_id,r.parent_brick_id,r.child_brick_id
      FROM spawn_attempt a JOIN spawn_run r USING(run_id) WHERE run_id=? ORDER BY fence`)
      .all(runId) as unknown as SpawnAttempt[];
  }

  queueInitialPrompt(runId: string, payload: Record<string, unknown>): string {
    return this.locked(() => {
      if (!this.getSpawnRun(runId)) {
        throw new Error("unknown spawn run");
      }
      const key = `initial_prompt:${runId}`;
      const existing = this.meta(key);
      if (existing) {
        return (JSON.parse(existing) as { delivery_id: string }).delivery_id;
      }
      const deliveryId = randomUUID();
      this.setMeta(
        key,
        JSON.stringify({ run_id: runId, delivery_id: deliveryId, payload, released_at: null }),
      );
      return deliveryId;
    });
  }

  pendingInitialPrompts(
    limit = 256,
    afterRunId = "",
  ): Array<{ run_id: string; delivery_id: string; payload: Record<string, unknown> }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
      throw new Error("invalid prompt batch");
    }
    return this.db
      .prepare(`SELECT m.value FROM meta m JOIN spawn_run r ON m.key='initial_prompt:'||r.run_id
      WHERE r.adopted_fence IS NOT NULL AND json_extract(m.value,'$.released_at') IS NULL AND r.run_id>?
      ORDER BY r.run_id LIMIT ?`)
      .all(afterRunId, limit)
      .map(
        (row) =>
          JSON.parse(String(row.value)) as {
            run_id: string;
            delivery_id: string;
            payload: Record<string, unknown>;
          },
      );
  }

  async releaseInitialPrompt(
    runId: string,
    submit: (payload: Record<string, unknown>, deliveryId: string) => Promise<void>,
  ): Promise<void> {
    const encoded = this.meta(`initial_prompt:${runId}`);
    if (!encoded) {
      return;
    }
    const item = JSON.parse(encoded) as {
      delivery_id: string;
      payload: Record<string, unknown>;
      released_at: string | null;
    };
    if (item.released_at) {
      return;
    }
    const run = this.getSpawnRun(runId);
    if (!run || run.adopted_fence === null) {
      throw new Error("initial prompt requires adopted run");
    }
    if (run.receipt_conflict) {
      throw new Error("initial prompt refused for receipt-conflict orphan");
    }
    // The existing delivery store deduplicates this persisted id; a lost return may safely retry.
    await submit(item.payload, item.delivery_id);
    this.locked(() => {
      this.setMeta(`initial_prompt:${runId}`, JSON.stringify({ ...item, released_at: now() }));
    });
  }

  recordSpawnChild(runId: string, fence: number, pid: number): SpawnAttempt {
    if (!Number.isSafeInteger(pid) || pid < 1) {
      throw new Error("invalid child pid");
    }
    let identity: { boot: string | null; start: string | null } = { boot: null, start: null };
    try {
      identity = this.childIdentity(pid);
    } catch {
      /* Incomplete identity stays unknown. */
    }
    return this.locked(() => {
      const attempt = this.getSpawnAttempt(runId, fence);
      if (!attempt || attempt.state !== "reserved") {
        throw new Error("child must start from reserved");
      }
      this.setMeta(`spawn_child:${runId}:${fence}`, JSON.stringify({ pid, ...identity }));
      this.db
        .prepare("UPDATE spawn_attempt SET state='launched' WHERE run_id=? AND fence=?")
        .run(runId, fence);
      return this.getSpawnAttempt(runId, fence)!;
    });
  }

  private childIdentity(pid: number): { boot: string; start: string } {
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (!boot || !fields[19]) {
      throw new Error("child identity unavailable");
    }
    return { boot, start: fields[19] };
  }

  spawnChildLiveness(runId: string, fence: number): "alive" | "gone" | "unknown" {
    const encoded = this.meta(`spawn_child:${runId}:${fence}`);
    if (!encoded) {
      return "unknown";
    }
    const saved = JSON.parse(encoded) as { pid: number; boot: string | null; start: string | null };
    if (!saved.boot || !saved.start) {
      return "unknown";
    }
    try {
      const current = this.childIdentity(saved.pid);
      return sameChildIdentity(saved, current) ? "alive" : "gone";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return "unknown";
      }
      try {
        // A readable proc mount plus an absent exact PID distinguishes death from an unavailable sensor.
        this.childIdentity(process.pid);
        return "gone";
      } catch {
        return "unknown";
      }
    }
  }

  private translate(error: unknown): unknown {
    if (isBusyAcquisitionError(error)) {
      return new SpawnLedgerError(
        "outbox-busy",
        "session write refused: outbox-busy; retry the operation",
      );
    }
    return error;
  }

  private locked<T>(action: () => T): T {
    return this.commitOrRollback(
      () =>
        retryOnBusy(() => {
          this.db.exec("BEGIN IMMEDIATE");
        }),
      action,
    );
  }

  /** `locked()` for async callers: the lock is acquired with a yielding wait, the action stays synchronous. */
  private async lockedAsync<T>(action: () => T): Promise<T> {
    try {
      await retryOnBusyAsync(() => {
        this.db.exec("BEGIN IMMEDIATE");
      });
    } catch (error) {
      throw this.translate(error);
    }
    return this.commitOrRollback(() => undefined, action);
  }

  private commitOrRollback<T>(begin: () => void, action: () => T): T {
    let acquired = false;
    try {
      begin();
      acquired = true;
      const result = action();
      if (result instanceof Promise) {
        throw new Error("spawn ledger transaction requires synchronous action");
      }
      this.db.exec("COMMIT");
      acquired = false;
      return result;
    } catch (error) {
      if (acquired) {
        this.db.exec("ROLLBACK");
      }
      throw this.translate(error);
    }
  }

  private meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return row ? String(row.value) : null;
  }
  private setMeta(key: string, value: string): void {
    // `instance_id` decides which instance this ledger belongs to, so it must have been checked
    // against this HOME's instance.json first — `bindIdentity` is the only caller allowed to open
    // this door, and only after the check passes. Brick 42b4fb28.
    if (!this.admittingIdentity && key === "instance_id") {
      throw new SpawnLedgerError(
        "outbox-identity-meta-bypass",
        `meta.${key} decides which instance owns ${this.dbPath} and may only be written through bindIdentity(), which checks it against this HOME's instance.json (brick 42b4fb28)`,
      );
    }
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  recordPath(id: string): string {
    if (!id) {
      throw new SpawnLedgerError("invalid-record-id", "local record id is required");
    }
    return path.join(this.sessionsDir, `${encodeURIComponent(id)}.json`);
  }
  readRecord(id: string): DiskRecord | undefined {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.recordPath(id), "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid record image");
      }
      return value as DiskRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  /** The spawn_key ownership check: only a live attempt's own destination may be written. */
  private assertSpawnOwnership(id: string, writer: DiskRecord, current: DiskRecord | undefined) {
    assertRecordIdentity(id, writer, current);
    const key = writer.metadata?.spawn_key;
    if (!key) {
      return;
    }
    const attempt = this.db.prepare("SELECT * FROM spawn_attempt WHERE idempotency_key=?").get(key);
    if (!attempt || attempt.target_record_id !== id) {
      throw new SpawnLedgerError("record-ownership", "spawn key does not own reserved destination");
    }
    if (!["launched", "published", "adopted"].includes(String(attempt.state))) {
      throw new SpawnLedgerError(
        "spawn-revoked",
        `spawn attempt is ${String(attempt.state)}; write refused`,
      );
    }
  }

  /** Callback must not yield while holding the lock. */
  writeOwnedRecord(
    id: string,
    writer: DiskRecord,
    build: (current: DiskRecord | undefined) => DiskRecord,
  ): DiskRecord {
    return this.locked(() => {
      const current = this.readRecord(id);
      this.assertSpawnOwnership(id, writer, current);
      const result = build(current);
      this.assertSpawnOwnership(id, result, current);
      preserveSpawnState(result, current);
      writeRecordAtomic(this.recordPath(id), result);
      return result;
    });
  }

  /** Persists a spawn-owned session record under the ledger's write lock and ownership guard. */
  saveRecord(record: DiskRecord): DiskRecord {
    return this.locked(() => this.saveRecordLocked(record));
  }
  /** `saveRecord` for async callers — identical, but waits for the lock without blocking the loop. */
  async saveRecordAsync(record: DiskRecord): Promise<DiskRecord> {
    return await this.lockedAsync(() => this.saveRecordLocked(record));
  }
  private saveRecordLocked(record: DiskRecord): DiskRecord {
    if (metadataValue(record, "spawn_key")) {
      this.assertBoundToThisInstance();
    }
    const id = String(record.acpx_record_id);
    const current = this.readRecord(id);
    this.assertSpawnOwnership(id, record, current);
    preserveSpawnState(record, current);
    writeRecordAtomic(this.recordPath(id), record);
    return record;
  }

  reserveSpawn(input: SpawnReservation): SpawnAttempt {
    assertUuid(input.target_record_id);
    if (!Number.isSafeInteger(input.fence) || input.fence < 1) {
      throw new Error("invalid spawn fence");
    }
    return this.locked(() => {
      const run = this.getSpawnRun(input.run_id);
      if (run?.adopted_fence !== null && run?.adopted_fence !== undefined) {
        throw new Error("spawn run already adopted");
      }
      const existing = this.getSpawnAttempt(input.run_id, input.fence);
      if (existing) {
        if (existing.target_record_id !== input.target_record_id) {
          throw new Error("reservation destination conflict");
        }
        return existing;
      }
      const newer = this.db
        .prepare("SELECT fence FROM spawn_attempt WHERE run_id=? AND fence>=?")
        .get(input.run_id, input.fence);
      if (newer) {
        throw new Error("spawn fence superseded");
      }
      const timestamp = now();
      this.db
        .prepare(`INSERT INTO spawn_run(run_id,trigger_id,parent_brick_id,child_brick_id,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(run_id) DO NOTHING`)
        .run(
          input.run_id,
          input.trigger_id,
          input.parent_brick_id,
          input.child_brick_id,
          timestamp,
        );
      this.db
        .prepare(`UPDATE spawn_attempt SET state='revoked',revoked_at=?
        WHERE run_id=? AND fence<? AND state IN ('reserved','launched','published')`)
        .run(timestamp, input.run_id, input.fence);
      this.db
        .prepare(`INSERT INTO spawn_attempt(run_id,fence,idempotency_key,target_record_id,state,reserved_at)
        VALUES(?,?,?,?,'reserved',?)`)
        .run(
          input.run_id,
          input.fence,
          spawnIdempotencyKey(input.run_id, input.fence),
          input.target_record_id,
          timestamp,
        );
      return this.getSpawnAttempt(input.run_id, input.fence)!;
    });
  }
  getSpawnRun(runId: string): SpawnRun | undefined {
    return this.db.prepare("SELECT * FROM spawn_run WHERE run_id=?").get(runId) as unknown as
      | SpawnRun
      | undefined;
  }
  listSpawnRuns(limit = 256, afterRunId = ""): SpawnRun[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
      throw new Error("invalid run batch");
    }
    return this.db
      .prepare("SELECT * FROM spawn_run WHERE run_id>? ORDER BY run_id LIMIT ?")
      .all(afterRunId, limit) as unknown as SpawnRun[];
  }
  getSpawnAttempt(runId: string, fence: number): SpawnAttempt | undefined {
    return this.db
      .prepare(`SELECT a.*,r.trigger_id,r.parent_brick_id,r.child_brick_id
      FROM spawn_attempt a JOIN spawn_run r USING(run_id) WHERE run_id=? AND fence=?`)
      .get(runId, fence) as unknown as SpawnAttempt | undefined;
  }
  getSpawnAttemptByKey(key: string): SpawnAttempt | undefined {
    return this.db
      .prepare(`SELECT a.*,r.trigger_id,r.parent_brick_id,r.child_brick_id
      FROM spawn_attempt a JOIN spawn_run r USING(run_id) WHERE idempotency_key=?`)
      .get(key) as unknown as SpawnAttempt | undefined;
  }
  transitionSpawn(
    runId: string,
    fence: number,
    next: SpawnAttemptState,
    evidence: SpawnTransitionEvidence = {},
  ): SpawnAttempt {
    return this.locked(() => {
      const attempt = this.getSpawnAttempt(runId, fence);
      const run = this.getSpawnRun(runId);
      if (!attempt || !run) {
        throw new Error("unknown spawn attempt");
      }
      const record = this.readRecord(attempt.target_record_id);
      const owned = recordOwnsAttempt(record, attempt);
      const unadopted = run.adopted_fence === null;
      const edge = `${attempt.state}:${next}`;
      const allowed = SPAWN_TRANSITIONS[edge]?.({ owned, unadopted, fence, evidence });
      if (!allowed) {
        throw new SpawnLedgerError(
          "invalid-spawn-transition",
          `forbidden spawn transition ${edge}`,
        );
      }
      this.persistAttemptTransition(attempt, record, next, evidence);
      return this.getSpawnAttempt(runId, fence)!;
    });
  }
  private persistAttemptTransition(
    attempt: SpawnAttempt,
    record: DiskRecord | undefined,
    next: SpawnAttemptState,
    evidence: SpawnTransitionEvidence,
  ): void {
    const timestamp = now();
    if (record && ["published", "adopted", "orphaned"].includes(next)) {
      record.metadata = {
        ...record.metadata,
        spawn_state: next === "orphaned" ? "orphaned" : "published",
      };
      writeRecordAtomic(this.recordPath(attempt.target_record_id), record);
    }
    this.updateAttemptRow(attempt, next, evidence, timestamp);
    if (next === "adopted") {
      this.adoptAttempt(attempt, evidence.session_url ?? attempt.session_url, timestamp);
    }
  }
  private updateAttemptRow(
    attempt: SpawnAttempt,
    next: SpawnAttemptState,
    evidence: SpawnTransitionEvidence,
    timestamp: string,
  ): void {
    this.db
      .prepare(`UPDATE spawn_attempt SET state=?,revoked_at=?,settled_at=?,session_url=COALESCE(?,session_url),last_error=?
        WHERE run_id=? AND fence=?`)
      .run(
        next,
        next === "revoked" ? timestamp : attempt.revoked_at,
        ["adopted", "revoked", "cancelled", "orphaned"].includes(next) ? timestamp : null,
        evidence.session_url ?? null,
        evidence.reason ?? null,
        attempt.run_id,
        attempt.fence,
      );
  }
  private adoptAttempt(attempt: SpawnAttempt, url: string | null, timestamp: string): void {
    const changed = this.db
      .prepare(`UPDATE spawn_run SET adopted_fence=?,session_id=?,session_url=?,updated_at=?
          WHERE run_id=? AND adopted_fence IS NULL`)
      .run(attempt.fence, attempt.target_record_id, url, timestamp, attempt.run_id);
    if (Number(changed.changes) !== 1) {
      throw new Error("spawn run adoption conflict");
    }
  }
  confirmSpawnReceipt(runId: string, receipt: CentralRunReceipt): SpawnRun {
    return this.locked(() => {
      const run = this.getSpawnRun(runId);
      if (!run) {
        throw new Error("unknown spawn run");
      }
      if (!["spawned", "failed", "cancelled", "skipped", "conflict"].includes(receipt.status)) {
        throw new Error("receipt is not terminal");
      }
      if (receipt.status === "spawned" && !receipt.session_id) {
        throw new Error("spawned receipt lacks session id");
      }
      const timestamp = now();
      const observation = this.observeReceiptConflict(run, receipt, timestamp);
      this.db
        .prepare(
          `UPDATE spawn_run SET ack_confirmed_at=?,terminal_state=?,receipt_conflict=?,updated_at=? WHERE run_id=?`,
        )
        .run(timestamp, receipt.status, observation, timestamp, runId);
      return this.getSpawnRun(runId)!;
    });
  }
  private observeReceiptConflict(
    run: SpawnRun,
    receipt: CentralRunReceipt,
    timestamp: string,
  ): string | null {
    if (!receiptConflicts(run, receipt)) {
      return run.receipt_conflict;
    }
    const observation = JSON.stringify({
      central_session_id: receipt.session_id,
      local_adopted_session_id: run.session_id,
      observed_at: timestamp,
    });
    const record = this.readRecord(run.session_id!);
    if (record) {
      const winner =
        run.adopted_fence === null
          ? undefined
          : this.getSpawnAttempt(run.run_id, run.adopted_fence);
      if (!winner || metadataValue(record, "spawn_key") !== winner.idempotency_key) {
        throw new Error("receipt destination ownership conflict");
      }
      record.metadata = { ...record.metadata, spawn_state: "orphaned" };
      writeRecordAtomic(this.recordPath(run.session_id!), record);
    }
    process.stderr.write(`[acpx] receipt-conflict ${observation}\n`);
    return observation;
  }
}
