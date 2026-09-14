import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type {
  CentralRunReceipt,
  LocalDrainInventory,
  ProjectionTuple,
  SpawnAttempt,
  SpawnAttemptState,
  SpawnReservation,
  SpawnRun,
  SpawnTransitionEvidence,
} from "./brick-outbox-types.js";
export type * from "./brick-outbox-types.js";

export const BRICK_OUTBOX_API_VERSION = 1;
export const BRICK_OUTBOX_CANONICAL_WRITER_VERSION = 1;
export function requiresBrickOutbox(metadata: Record<string, string> | undefined): boolean {
  return ["brick", "spawn_key", "brick_projection_revision"].some((key) =>
    Boolean(metadata?.[key]),
  );
}
export function openRecordOutbox(
  _metadata: Record<string, string> | undefined,
  directory = path.join(os.homedir(), ".acpx", "sessions"),
): BrickOutbox | undefined {
  if (!isCanonicalSessionDirectory(directory)) {return undefined;}
  // C0 §1.4/§7.1: exclusion applies to canonical writers even before projection binding.
  // Opening unconditionally removes the existence-check race with a concurrent drain entry.
  return new BrickOutbox();
}
export function isCanonicalSessionDirectory(directory: string): boolean {
  const actual = fs.realpathSync(directory);
  let canonical: string;
  try {
    canonical = fs.realpathSync(path.join(os.homedir(), ".acpx", "sessions"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
    return false;
  }
  return actual === canonical;
}
export type DiskRecord = Record<string, unknown> & { metadata?: Record<string, string> };
export type OutboxState = "prepared" | "applied" | "acknowledged" | "superseded" | "abandoned";
export interface ProjectionPayload {
  session_id: string;
  brick_id: string;
  instance_id: string;
  box: string | null;
  session_url: string;
  name: string | null;
  agent_type: string | null;
  closed: boolean;
  last_used_at: string | null;
  revision: number;
  projection_epoch: number;
  history_id: string;
  source: "index";
  record_recovery?: { recovery_kind: "first-record"; record_image: DiskRecord };
}
export interface OutboxIntent {
  id: string;
  session_id: string;
  brick_id: string;
  op: "upsert" | "tombstone";
  revision: number;
  projection_epoch: number;
  payload: string;
  state: OutboxState;
  prepared_at: string;
  applied_at: string | null;
  acknowledged_at: string | null;
  attempts: number;
  last_error: string | null;
}
export interface ProjectionIdentity {
  instance_id: string;
  box: string | null;
  session_url: string;
  agent_type: string | null;
}
export type ProjectionTransport = (
  method: "GET" | "POST",
  route: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

export class OutboxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OutboxError";
  }
}

const ATTEMPT_STATES: SpawnAttemptState[] = [
  "reserved",
  "launched",
  "published",
  "adopted",
  "revoked",
  "cancelled",
  "orphaned",
];
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS session_revision (
 session_id TEXT PRIMARY KEY, projection_epoch INTEGER NOT NULL,
 last_revision INTEGER NOT NULL, history_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL, brick_id TEXT NOT NULL,
 op TEXT NOT NULL CHECK(op IN ('upsert','tombstone')), revision INTEGER NOT NULL,
 projection_epoch INTEGER NOT NULL, payload TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','applied','acknowledged','superseded','abandoned')),
 prepared_at TEXT NOT NULL, applied_at TEXT, acknowledged_at TEXT,
 attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_rev ON outbox(session_id,projection_epoch,revision);
CREATE INDEX IF NOT EXISTS idx_outbox_open ON outbox(state) WHERE state IN ('prepared','applied');
CREATE TABLE IF NOT EXISTS projection_head (
 session_id TEXT PRIMARY KEY, brick_id TEXT, op TEXT NOT NULL,
 projection_epoch INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
 acked_epoch INTEGER, acked_revision INTEGER, updated_at TEXT NOT NULL);
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

function now(): string {
  return new Date().toISOString();
}
function synchronousResult<T>(value: T): T {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    throw new OutboxError("outbox-async-callback", "outbox gate requires a synchronous callback");
  }
  return value;
}
function publicationErrorDisposition(error: unknown, comparison: number): "abandoned" {
  const refused = error instanceof OutboxError && error.code === "invalid-spawn-transition";
  if (comparison < 0 && refused) {
    return "abandoned";
  }
  throw error;
}
function assertBatchLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
    throw new Error("batch must be 1..256");
  }
}
function sameChildIdentity(
  left: { boot: string | null; start: string | null },
  right: { boot: string; start: string },
): boolean {
  return left.boot === right.boot && left.start === right.start;
}
function assertUuid(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new OutboxError("invalid-record-id", "record id must be a lowercase UUID");
  }
}
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function compare(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0);
}
function tuple(record: DiskRecord | undefined): [number, number] {
  const encoded = record?.metadata?.brick_projection_revision;
  if (!encoded) {
    return [-1, -1];
  }
  if (!/^\d+:\d+$/.test(encoded)) {
    throw new OutboxError("invalid-projection-revision", "invalid record projection tuple");
  }
  const [epoch, revision] = encoded.split(":").map(Number);
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(revision)) {
    throw new OutboxError("invalid-projection-revision", "unsafe record projection tuple");
  }
  return [epoch!, revision!];
}
function historyId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString("hex")}`);
  let result = "";
  for (let i = 0; i < 26; i++) {
    result = alphabet[Number(value & 31n)] + result;
    value >>= 5n;
  }
  return result;
}
export function spawnIdempotencyKey(runId: string, fence: number): string {
  return createHash("sha256").update(`acpx-spawn:${runId}:${fence}`).digest("hex").slice(0, 32);
}

function readLocalIdentity(): { instance_id: string; home: string } {
  const home = os.homedir();
  const identity = JSON.parse(
    fs.readFileSync(path.join(home, ".acpx", "instance.json"), "utf8"),
  ) as {
    instance_id: string;
    home: string;
  };
  if (
    !/^i-[0-9a-f]{12}$/.test(identity.instance_id) ||
    path.resolve(identity.home) !== path.resolve(home)
  ) {
    throw new OutboxError(
      "instance-identity-moved",
      "projection requires this HOME's admitted instance identity",
    );
  }
  return identity;
}
function projectionAgentType(record: DiskRecord): string | null {
  const command = String(record.agent_command ?? "").trim();
  const matches: Array<[string, RegExp]> = [
    [
      "claude-pty",
      /(?:^|[\s/])(?:claude-pty-acp(?:@|[\s/]|$)|acp-server-transcript(?:@|[\s/.]|$))/,
    ],
    ["claude", /(?:^|[\s/])claude-agent-acp(?:@|[\s/]|$)|^claude(?: |$)/],
    ["codex", /(?:^|[\s/])codex-acp(?:@|[\s/]|$)|^codex(?: |$)/],
    ["pi", /(?:^|[\s/])pi-acp(?:@|[\s/]|$)/],
  ];
  return matches.find(([, pattern]) => pattern.test(command))?.[0] ?? null;
}
export function projectionIdentity(
  record: DiskRecord,
  bound?: { instance_id: string; box: string; public_base_url: string },
): ProjectionIdentity {
  const identity = readLocalIdentity();
  const base =
    bound?.public_base_url ?? process.env.ACPX_UI_BASE_URL ?? process.env.ACPX_SESSION_URL;
  if (!base) {
    throw new OutboxError("instance-url-missing", "projection requires ACPX_UI_BASE_URL");
  }
  const url = new URL(base);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set("session", String(record.acpx_record_id));
  return {
    instance_id: identity.instance_id,
    box: bound?.box ?? process.env.ACPX_BOX ?? null,
    session_url: url.href,
    agent_type: projectionAgentType(record),
  };
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
function projectionReplyAcknowledges(
  status: number,
  body: { code?: string; results?: Array<{ outbox_id: string; disposition: string }> },
  id: string,
): boolean {
  if (status === 409) {
    return body.code === "stale-revision";
  }
  if (status !== 200) {
    return false;
  }
  const result = body.results?.find((item) => item.outbox_id === id);
  return Boolean(
    result && ["applied", "already-current", "superseded"].includes(result.disposition),
  );
}
function assertRecordIdentity(
  id: string,
  writer: DiskRecord,
  current: DiskRecord | undefined,
): void {
  if (writer.acpx_record_id !== id) {
    throw new OutboxError("record-ownership", "record id does not own destination");
  }
  if (!current) {
    return;
  }
  if (current.acpx_record_id !== id) {
    throw new OutboxError("record-ownership", "existing record id differs");
  }
  if (metadataValue(current, "spawn_key") !== metadataValue(writer, "spawn_key")) {
    throw new OutboxError("record-ownership", "destination belongs to another spawn attempt");
  }
  if (current.acp_session_id !== writer.acp_session_id) {
    throw new OutboxError("record-ownership", "destination belongs to another ACP session");
  }
}
function preserveProjectionMetadata(result: DiskRecord, current: DiskRecord | undefined): void {
  if (metadataValue(current, "spawn_key")) {
    result.metadata = {
      ...result.metadata,
      spawn_state: metadataValue(current, "spawn_state") ?? "pending",
    };
  }
  const revision = metadataValue(current, "brick_projection_revision");
  if (!revision) {
    return;
  }
  result.metadata = { ...result.metadata, brick_projection_revision: revision };
  const brick = metadataValue(current, "brick");
  if (brick) {
    result.metadata.brick = brick;
  } else {
    delete result.metadata.brick;
  }
}
function preserveStaleProjectionMetadata(
  record: DiskRecord,
  current: DiskRecord | undefined,
): void {
  const currentRevision = metadataValue(current, "brick_projection_revision");
  if (currentRevision && metadataValue(record, "brick_projection_revision") !== currentRevision) {
    preserveProjectionMetadata(record, current);
  }
}
function assertDeletionSnapshot(expected: DiskRecord, current: DiskRecord | undefined): void {
  if (!current) {return;}
  const fields = ["closed", "closed_at", "last_used_at", "updated_at", "template"];
  for (const key of fields) {
    const before = JSON.parse(JSON.stringify(expected[key] ?? null));
    const after = JSON.parse(JSON.stringify(current[key] ?? null));
    if (!isDeepStrictEqual(before, after))
      {throw new OutboxError("record-changed", "record changed since deletion selection; retry");}
  }
  if (
    metadataValue(expected, "brick_projection_revision") !==
    metadataValue(current, "brick_projection_revision")
  ) {
    throw new OutboxError(
      "record-changed",
      "record projection changed since deletion selection; retry",
    );
  }
}
interface TransitionContext {
  owned: boolean;
  unadopted: boolean;
  fence: number;
  evidence: SpawnTransitionEvidence;
}
type Publication = { run_id: string; fence: number; next: "published" | "adopted" };
function applyIntentFields(
  updated: DiskRecord,
  intent: OutboxIntent,
  payload: ProjectionPayload,
  publication: Publication | undefined,
): void {
  updated.metadata = {
    ...updated.metadata,
    brick_projection_revision: `${intent.projection_epoch}:${intent.revision}`,
  };
  if (publication) {
    updated.metadata.spawn_state = "published";
  }
  if (intent.op === "upsert") {
    updated.metadata.brick = intent.brick_id;
  } else {
    delete updated.metadata.brick;
  }
  updated.name = payload.name;
  updated.closed = payload.closed;
  if (payload.last_used_at !== null) {
    updated.last_used_at = payload.last_used_at;
  }
}
function unpublishedRecord(record: DiskRecord): boolean {
  return Boolean(
    metadataValue(record, "spawn_key") && metadataValue(record, "spawn_state") !== "published",
  );
}
function makeProjectionPayload(
  id: string,
  brick: string,
  record: DiskRecord,
  current: DiskRecord | undefined,
  identity: ProjectionIdentity,
  epoch: number,
  revision: number,
  history: string,
): ProjectionPayload {
  const payload: ProjectionPayload = {
    ...identity,
    session_id: id,
    brick_id: brick,
    name: stringOrNull(record.name),
    closed: record.closed === true,
    last_used_at: stringOrNull(record.last_used_at),
    projection_epoch: epoch,
    revision,
    history_id: history,
    source: "index",
  };
  if (!current && !metadataValue(record, "spawn_key")) {
    payload.record_recovery = { recovery_kind: "first-record", record_image: record };
  }
  return payload;
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
function needsPublication(
  record: DiskRecord | undefined,
  attempt: SpawnAttempt | undefined,
  next: SpawnAttemptState,
): boolean {
  if (!metadataValue(record, "brick")) {
    return false;
  }
  if (next === "published") {
    return true;
  }
  return next === "adopted" && attempt?.state === "revoked";
}

/** Atomic file replacement with the directory entry persisted before SQLite commits T2. */
export function writeRecordAtomic(file: string, record: DiskRecord): void {
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

export class BrickOutbox {
  readonly dbPath: string;
  readonly sessionsDir: string;
  private readonly db: DatabaseSync;
  private userGateDepth = 0;

  constructor() {
    const directory = path.join(os.homedir(), ".acpx");
    fs.mkdirSync(directory, { recursive: true });
    this.sessionsDir = path.join(directory, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.dbPath = path.join(directory, "brick-outbox.db");
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.locked(() => {
        const exists = this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
          .get();
        const version = exists ? this.meta("schema_version") : null;
        if (version !== null && version !== "1") {
          throw new OutboxError("outbox-schema-version", `unsupported outbox version ${version}`);
        }
        this.db.exec(SCHEMA);
        this.setMeta("schema_version", "1");
      });
    } catch (error) {
      this.db.close();
      throw this.translate(error);
    }
  }

  close(): void {
    this.db.close();
  }
  isBound(): boolean {
    return this.meta("projection_identity") !== null;
  }
  withUserMutationGate<T>(action: () => T): T {
    if (this.userGateDepth > 0) {
      this.refuseDrain();
      return synchronousResult(action());
    }
    return this.locked(() => {
      this.refuseDrain();
      this.userGateDepth++;
      try {
        return synchronousResult(action());
      } finally {
        this.userGateDepth--;
      }
    });
  }

  exitDrainWithMutationGate<T>(expectedCutoverId: string, reopen: () => T): T {
    return this.locked(() => {
      const encoded = this.meta("drain");
      if (
        !encoded ||
        (JSON.parse(encoded) as { cutover_id?: string }).cutover_id !== expectedCutoverId
      ) {
        throw new OutboxError(
          "outbox-drain-owner",
          "drain does not belong to the expected cutover",
        );
      }
      this.db.prepare("DELETE FROM meta WHERE key IN ('drain','admission_frontier')").run();
      this.userGateDepth++;
      try {
        return synchronousResult(reopen());
      } finally {
        this.userGateDepth--;
      }
    });
  }

  bindIdentity(identity: { instance_id: string; box: string; public_base_url: string }): void {
    this.locked(() => {
      const previous = this.meta("instance_id");
      if (previous && previous !== identity.instance_id) {
        throw new OutboxError("outbox-instance-mismatch", "outbox belongs to another instance");
      }
      this.setMeta("instance_id", identity.instance_id);
      this.setMeta("projection_identity", JSON.stringify(identity));
    });
  }
  identityForRecord(record: DiskRecord): ProjectionIdentity {
    const encoded = this.meta("projection_identity");
    if (!encoded) {
      return projectionIdentity(record);
    }
    const bound = JSON.parse(encoded) as {
      instance_id: string;
      box: string;
      public_base_url: string;
    };
    const basic = projectionIdentity(record, bound);
    if (bound.instance_id !== basic.instance_id) {
      throw new OutboxError(
        "outbox-instance-mismatch",
        "identity binding differs from instance.json",
      );
    }
    const url = new URL(bound.public_base_url);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    url.searchParams.set("session", String(record.acpx_record_id));
    return { ...basic, box: bound.box, session_url: url.href };
  }

  async deliverPending(
    send: ProjectionTransport,
    cutoverEpoch: number,
    limit = 256,
  ): Promise<number> {
    let delivered = 0;
    for (const row of this.pending(limit)) {
      let intent = row;
      if (intent.state === "prepared") {
        try {
          intent = this.applyProjection(intent.id);
        } catch (error) {
          if (this.getIntent(intent.id)?.state === "abandoned") {
            continue;
          }
          throw error;
        }
      }
      if (intent.state !== "applied") {
        continue;
      }
      delivered += await this.deliverIntent(send, cutoverEpoch, intent);
    }
    await this.acknowledgePrefix(send);
    return delivered;
  }
  private async deliverIntent(
    send: ProjectionTransport,
    cutoverEpoch: number,
    intent: OutboxIntent,
  ): Promise<number> {
    const payload = JSON.parse(intent.payload) as ProjectionPayload;
    delete payload.record_recovery;
    try {
      const response = await send("POST", "/api/bricks/session-links/deliver", {
        cutover_epoch: cutoverEpoch,
        items: [
          {
            outbox_id: intent.id,
            session_id: intent.session_id,
            brick_id: intent.brick_id,
            op: intent.op,
            projection_epoch: intent.projection_epoch,
            revision: intent.revision,
            history_id: payload.history_id,
            payload,
          },
        ],
      });
      return this.handleProjectionReply(intent, response);
    } catch (error) {
      this.recordDeliveryFailure(intent.id, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  private handleProjectionReply(
    intent: OutboxIntent,
    response: { status: number; body: unknown },
  ): number {
    const body = response.body as {
      code?: string;
      stored?: { projection_epoch: number };
      results?: Array<{ outbox_id: string; disposition: string }>;
    };
    if (response.status === 409 && body.code === "revision-regression") {
      this.repairProjectionHistory(
        intent.session_id,
        body.stored?.projection_epoch ?? intent.projection_epoch,
      );
      return 0;
    }
    if (projectionReplyAcknowledges(response.status, body, intent.id)) {
      this.acknowledge(intent.id);
      return 1;
    }
    throw new OutboxError(
      body.code ?? "projection-protocol-error",
      `projection delivery HTTP ${response.status}: ${body.code ?? "missing disposition"}`,
    );
  }
  private async acknowledgePrefix(send: ProjectionTransport): Promise<void> {
    const highWater = this.inventory().dispositioned_prefix;
    if (highWater.length) {
      const abandoned = this.db
        .prepare(
          "SELECT session_id,projection_epoch,revision FROM outbox WHERE state IN ('abandoned','superseded') ORDER BY session_id,projection_epoch,revision",
        )
        .all();
      const groups = new Map<
        string,
        { session_id: string; projection_epoch: number; revisions: number[] }
      >();
      for (const row of abandoned) {
        const key = `${String(row.session_id)}:${String(row.projection_epoch)}`;
        const group = groups.get(key) ?? {
          session_id: String(row.session_id),
          projection_epoch: Number(row.projection_epoch),
          revisions: [],
        };
        group.revisions.push(Number(row.revision));
        groups.set(key, group);
      }
      const ack = await send("POST", "/api/bricks/session-links/ack", {
        instance_id: this.meta("instance_id"),
        high_water: highWater,
        abandoned: [...groups.values()],
      });
      if (ack.status !== 200) {
        throw new OutboxError(
          "projection-ack-failed",
          `projection prefix acknowledgement HTTP ${ack.status}`,
        );
      }
    }
  }

  repairProjectionHistory(sessionId: string, serviceEpoch: number): OutboxIntent {
    return this.locked(() => {
      this.refuseDrain();
      const head = this.db
        .prepare("SELECT * FROM projection_head WHERE session_id=?")
        .get(sessionId);
      if (!head) {
        throw new OutboxError(
          "projection-head-missing",
          "cannot repair history without the durable head",
        );
      }
      const counter = this.db
        .prepare("SELECT * FROM session_revision WHERE session_id=?")
        .get(sessionId);
      const epoch =
        Math.max(serviceEpoch, Number(counter?.projection_epoch ?? head.projection_epoch)) + 1;
      const history = historyId();
      const payload = {
        ...(JSON.parse(String(head.payload)) as ProjectionPayload),
        projection_epoch: epoch,
        revision: 1,
        history_id: history,
      };
      const id = randomUUID();
      this.db
        .prepare(`INSERT INTO session_revision VALUES(?,?,1,?) ON CONFLICT(session_id)
        DO UPDATE SET projection_epoch=excluded.projection_epoch,last_revision=1,history_id=excluded.history_id`)
        .run(sessionId, epoch, history);
      this.db
        .prepare(
          "UPDATE outbox SET state='superseded' WHERE session_id=? AND state IN ('prepared','applied')",
        )
        .run(sessionId);
      this.db
        .prepare(`INSERT INTO outbox(id,session_id,brick_id,op,revision,projection_epoch,payload,state,prepared_at)
        VALUES(?,?,?,?,1,?,?,'prepared',?)`)
        .run(
          id,
          sessionId,
          payload.brick_id,
          String(head.op),
          epoch,
          JSON.stringify(payload),
          now(),
        );
      return this.getIntent(id)!;
    });
  }

  reconcileProjectionHeads(
    rows: ProjectionTuple[],
    afterSessionId = "",
    limit = 256,
  ): { examined: number; last_session_id: string | null; prepared: number } {
    assertBatchLimit(limit);
    const remote = new Map(rows.map((row) => [row.session_id, row]));
    const heads = this.db
      .prepare("SELECT * FROM projection_head WHERE session_id>? ORDER BY session_id LIMIT ?")
      .all(afterSessionId, limit);
    let prepared = 0;
    for (const head of heads) {
      const sid = String(head.session_id),
        stored = remote.get(sid);
      if (
        stored &&
        compare(
          [stored.projection_epoch, stored.revision],
          [Number(head.projection_epoch), Number(head.revision)],
        ) >= 0
      ) {
        continue;
      }
      prepared += this.reprepareHead(head);
    }
    return {
      examined: heads.length,
      last_session_id: heads.length ? String(heads[heads.length - 1]!.session_id) : null,
      prepared,
    };
  }
  private reprepareHead(head: Record<string, unknown>): number {
    const sid = String(head.session_id);
    const payload = JSON.parse(String(head.payload)) as ProjectionPayload;
    const record = this.readRecord(sid);
    if (!record) {
      throw new OutboxError(
        "record-missing-for-update",
        "head reconciliation requires its exact session record",
      );
    }
    record.metadata = { ...record.metadata };
    if (head.op === "tombstone") {
      delete record.metadata.brick;
    } else {
      record.metadata.brick = payload.brick_id;
    }
    const intent = this.prepareProjection(sid, record, payload);
    if (!intent) {
      return 0;
    }
    this.applyProjection(intent.id);
    return 1;
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
    if (error instanceof Error && /database is locked|SQLITE_BUSY/.test(error.message)) {
      return new OutboxError(
        "outbox-busy",
        "session write refused: outbox-busy; retry the operation",
      );
    }
    return error;
  }

  private locked<T>(action: () => T): T {
    let acquired = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      acquired = true;
      const result = action();
      if (result instanceof Promise) {
        throw new Error("outbox transaction requires synchronous action");
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
    this.db
      .prepare(
        "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  private refuseDrain(): void {
    const marker = this.meta("drain");
    if (marker) {
      throw new OutboxError("maintenance", `maintenance window ${marker}; retry after it`);
    }
  }
  recordPath(id: string): string {
    if (!id) {throw new OutboxError("invalid-record-id", "local record id is required");}
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

  private assertOwnership(id: string, writer: DiskRecord, current: DiskRecord | undefined): void {
    assertRecordIdentity(id, writer, current);
    const key = writer.metadata?.spawn_key;
    if (!key) {
      return;
    }
    const attempt = this.db.prepare("SELECT * FROM spawn_attempt WHERE idempotency_key=?").get(key);
    if (!attempt || attempt.target_record_id !== id) {
      throw new OutboxError("record-ownership", "spawn key does not own reserved destination");
    }
    if (!["launched", "published", "adopted"].includes(String(attempt.state))) {
      throw new OutboxError(
        "spawn-revoked",
        `spawn attempt is ${String(attempt.state)}; write refused`,
      );
    }
  }

  async withOwnedSidecarWrite<T>(
    id: string,
    writer: DiskRecord,
    action: (current: DiskRecord | undefined) => Promise<T>,
  ): Promise<T> {
    return this.withAsyncMutation(async () => {
      const current = this.readRecord(id);
      this.assertOwnership(id, writer, current);
      return action(current);
    });
  }

  async withRecordDeletion<T>(
    id: string,
    expected: DiskRecord,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.withAsyncMutation(async () => {
      const current = this.readRecord(id);
      assertRecordIdentity(id, expected, current);
      assertDeletionSnapshot(expected, current);
      return action();
    });
  }

  private async withAsyncMutation<T>(action: () => Promise<T>): Promise<T> {
    let acquired = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      acquired = true;
      this.refuseDrain();
      const result = await action();
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

  /** Used for ordinary record/sidecar updates; callback must not yield while holding the lock. */
  writeOwnedRecord(
    id: string,
    writer: DiskRecord,
    build: (current: DiskRecord | undefined) => DiskRecord,
  ): DiskRecord {
    return this.locked(() => {
      this.refuseDrain();
      const current = this.readRecord(id);
      this.assertOwnership(id, writer, current);
      const result = build(current);
      this.assertOwnership(id, result, current);
      preserveProjectionMetadata(result, current);
      writeRecordAtomic(this.recordPath(id), result);
      return result;
    });
  }
  saveRecord(record: DiskRecord): DiskRecord {
    const id = String(record.acpx_record_id);
    if (
      unpublishedRecord(record) ||
      (!this.isBound() &&
        !metadataValue(record, "brick_projection_revision") &&
        !metadataValue(record, "spawn_key"))
    ) {
      return this.writeOwnedRecord(id, record, () => record);
    }
    const intent = this.prepareProjection(id, record, this.identityForRecord(record));
    if (!intent) {
      return this.writeOwnedRecord(id, record, () => record);
    }
    this.applyProjection(intent.id, (current) => ({
      ...record,
      metadata: { ...current.metadata, ...record.metadata },
    }));
    return this.readRecord(id)!;
  }

  prepareProjection(
    id: string,
    record: DiskRecord,
    identity: ProjectionIdentity,
    publication?: Publication,
  ): OutboxIntent | undefined {
    return this.locked(() => {
      this.refuseDrain();
      const current = this.readRecord(id);
      if (publication) {
        this.assertPublicationEligible(publication, current, id);
      } else {
        this.assertOwnership(id, record, current);
      }
      preserveStaleProjectionMetadata(record, current);
      if (unpublishedRecord(record)) {
        return undefined;
      }
      const brick = metadataValue(record, "brick") || metadataValue(current, "brick");
      if (!brick) {
        return undefined;
      }
      assertUuid(id);
      assertUuid(brick);
      this.checkProjectionInstance(identity.instance_id);
      const { epoch, revision, history } = this.nextProjectionCounter(id, current);
      const payload = makeProjectionPayload(
        id,
        brick,
        record,
        current,
        identity,
        epoch,
        revision,
        history,
      );
      const intentId = randomUUID();
      this.db
        .prepare(`INSERT INTO session_revision VALUES(?,?,?,?) ON CONFLICT(session_id)
        DO UPDATE SET projection_epoch=excluded.projection_epoch,last_revision=excluded.last_revision,history_id=excluded.history_id`)
        .run(id, epoch, revision, history);
      this.db
        .prepare(`INSERT INTO outbox(id,session_id,brick_id,op,revision,projection_epoch,payload,state,prepared_at)
        VALUES(?,?,?,?,?,?,?,'prepared',?)`)
        .run(
          intentId,
          id,
          brick,
          metadataValue(record, "brick") ? "upsert" : "tombstone",
          revision,
          epoch,
          JSON.stringify(payload),
          now(),
        );
      if (publication) {
        this.setMeta(`publication:${intentId}`, JSON.stringify(publication));
      }
      return this.getIntent(intentId)!;
    });
  }
  private checkProjectionInstance(id: string): void {
    const stored = this.meta("instance_id");
    if (stored && stored !== id) {
      throw new OutboxError("outbox-instance-mismatch", "outbox belongs to another instance");
    }
    this.setMeta("instance_id", id);
  }
  private nextProjectionCounter(
    id: string,
    current: DiskRecord | undefined,
  ): { epoch: number; revision: number; history: string } {
    const counter = this.db.prepare("SELECT * FROM session_revision WHERE session_id=?").get(id);
    const epoch = counter ? Number(counter.projection_epoch) : Math.max(0, tuple(current)[0] + 1);
    const revision = counter ? Number(counter.last_revision) + 1 : 1;
    if (!Number.isSafeInteger(revision)) {
      throw new OutboxError("revision-exhausted", "projection revision exhausted");
    }
    return { epoch, revision, history: counter ? String(counter.history_id) : historyId() };
  }
  private assertPublicationEligible(
    publication: Publication,
    current: DiskRecord | undefined,
    id: string,
  ): void {
    const attempt = this.getSpawnAttempt(publication.run_id, publication.fence);
    const run = this.getSpawnRun(publication.run_id);
    const fail = () => {
      throw new OutboxError(
        "invalid-spawn-transition",
        "publication reservation is no longer eligible",
      );
    };
    if (!attempt || !run) {
      return fail();
    }
    const checks = [
      run.adopted_fence === null,
      attempt.target_record_id === id,
      metadataValue(current, "spawn_key") === attempt.idempotency_key,
      attempt.state === (publication.next === "published" ? "launched" : "revoked"),
    ];
    if (!checks.every(Boolean)) {
      fail();
    }
  }

  getIntent(id: string): OutboxIntent | undefined {
    return this.db.prepare("SELECT * FROM outbox WHERE id=?").get(id) as unknown as
      | OutboxIntent
      | undefined;
  }
  pending(limit = 256): OutboxIntent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
      throw new Error("outbox batch must be 1..256");
    }
    return this.db
      .prepare(`SELECT * FROM outbox WHERE state IN ('prepared','applied')
      ORDER BY session_id,projection_epoch,revision LIMIT ?`)
      .all(limit) as unknown as OutboxIntent[];
  }
  applyProjection(intentId: string, build?: (current: DiskRecord) => DiskRecord): OutboxIntent {
    const result = this.locked(() => {
      const intent = this.getIntent(intentId);
      if (!intent) {
        throw new Error("unknown outbox intent");
      }
      if (intent.state !== "prepared") {
        return intent;
      }
      const payload = JSON.parse(intent.payload) as ProjectionPayload;
      const publicationJson = this.meta(`publication:${intentId}`);
      const publication = publicationJson
        ? (JSON.parse(publicationJson) as Publication)
        : undefined;
      const current = this.readRecord(intent.session_id);
      const disposition = this.applicationDisposition(intent, current, publication);
      if (disposition === "superseded" || disposition === "abandoned") {
        this.setIntentState(intentId, disposition);
        return this.getIntent(intentId)!;
      }
      if (disposition === "apply") {
        this.applyIntentRecord(intent, payload, current, publication, build);
      }
      this.commitProjectionHead(intent);
      this.commitPublication(publication, intent, payload);
      return this.getIntent(intentId)!;
    });
    if (result.state === "abandoned") {
      throw new OutboxError(
        "maintenance",
        "maintenance or revocation; prepared intent abandoned; retry after it",
      );
    }
    return result;
  }
  private applicationDisposition(
    intent: OutboxIntent,
    current: DiskRecord | undefined,
    publication: Publication | undefined,
  ): "apply" | "complete" | "superseded" | "abandoned" {
    const comparison = compare(tuple(current), [intent.projection_epoch, intent.revision]);
    if (comparison > 0) {
      return "superseded";
    }
    if (comparison < 0 && this.meta("drain")) {
      return "abandoned";
    }
    if (publication) {
      try {
        this.assertPublicationEligible(publication, current, intent.session_id);
      } catch (error) {
        return publicationErrorDisposition(error, comparison);
      }
    }
    return comparison < 0 ? "apply" : "complete";
  }
  private applyIntentRecord(
    intent: OutboxIntent,
    payload: ProjectionPayload,
    current: DiskRecord | undefined,
    publication: Publication | undefined,
    build?: (current: DiskRecord) => DiskRecord,
  ): void {
    const source = current ?? payload.record_recovery?.record_image;
    if (!source) {
      throw new OutboxError("record-missing-for-update", "fatal: record-missing-for-update");
    }
    const updated = build ? build(source) : structuredClone(source);
    if (!publication) {
      this.assertOwnership(intent.session_id, updated, current);
    }
    applyIntentFields(updated, intent, payload, publication);
    writeRecordAtomic(this.recordPath(intent.session_id), updated);
  }
  private commitProjectionHead(intent: OutboxIntent): void {
    this.db
      .prepare(`INSERT INTO projection_head(session_id,brick_id,op,projection_epoch,revision,payload,updated_at)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET brick_id=excluded.brick_id,
        op=excluded.op,projection_epoch=excluded.projection_epoch,revision=excluded.revision,
        payload=excluded.payload,updated_at=excluded.updated_at`)
      .run(
        intent.session_id,
        intent.op === "tombstone" ? null : intent.brick_id,
        intent.op,
        intent.projection_epoch,
        intent.revision,
        intent.payload,
        now(),
      );
    this.db
      .prepare("UPDATE outbox SET state='applied',applied_at=? WHERE id=?")
      .run(now(), intent.id);
  }
  private commitPublication(
    publication: Publication | undefined,
    intent: OutboxIntent,
    payload: ProjectionPayload,
  ): void {
    if (publication) {
      this.db
        .prepare(
          "UPDATE spawn_attempt SET state=?,session_url=?,settled_at=? WHERE run_id=? AND fence=?",
        )
        .run(
          publication.next,
          payload.session_url,
          publication.next === "adopted" ? now() : null,
          publication.run_id,
          publication.fence,
        );
      if (publication.next === "adopted") {
        this.db
          .prepare(
            "UPDATE spawn_run SET adopted_fence=?,session_id=?,session_url=?,updated_at=? WHERE run_id=? AND adopted_fence IS NULL",
          )
          .run(
            publication.fence,
            intent.session_id,
            payload.session_url,
            now(),
            publication.run_id,
          );
      }
    }
  }
  private setIntentState(id: string, state: OutboxState): void {
    this.db.prepare("UPDATE outbox SET state=? WHERE id=?").run(state, id);
  }
  acknowledge(intentId: string): void {
    this.locked(() => {
      const intent = this.getIntent(intentId);
      if (!intent || !["applied", "acknowledged"].includes(intent.state)) {
        throw new Error("intent is not deliverable");
      }
      this.db
        .prepare("UPDATE outbox SET state='acknowledged',acknowledged_at=? WHERE id=?")
        .run(now(), intentId);
      this.db
        .prepare(`UPDATE projection_head SET acked_epoch=?,acked_revision=? WHERE session_id=?
        AND (acked_epoch IS NULL OR acked_epoch<? OR (acked_epoch=? AND acked_revision<?))`)
        .run(
          intent.projection_epoch,
          intent.revision,
          intent.session_id,
          intent.projection_epoch,
          intent.projection_epoch,
          intent.revision,
        );
    });
  }
  recordDeliveryFailure(intentId: string, reason: string): void {
    this.locked(() => {
      this.db
        .prepare(
          "UPDATE outbox SET attempts=attempts+1,last_error=? WHERE id=? AND state='applied'",
        )
        .run(reason, intentId);
    });
  }

  reserveSpawn(input: SpawnReservation): SpawnAttempt {
    assertUuid(input.target_record_id);
    if (!Number.isSafeInteger(input.fence) || input.fence < 1) {
      throw new Error("invalid spawn fence");
    }
    return this.locked(() => {
      this.refuseDrain();
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
    const candidate = this.getSpawnAttempt(runId, fence);
    const source = candidate ? this.readRecord(candidate.target_record_id) : undefined;
    if (needsPublication(source, candidate, next)) {
      const image = { ...source!, metadata: { ...source!.metadata, spawn_state: "published" } };
      const intent = this.prepareProjection(
        candidate!.target_record_id,
        image,
        this.identityForRecord(image),
        { run_id: runId, fence, next: next as "published" | "adopted" },
      );
      if (!intent) {
        throw new Error("publication did not prepare its projection");
      }
      this.applyProjection(intent.id);
      return this.getSpawnAttempt(runId, fence)!;
    }
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
        throw new OutboxError("invalid-spawn-transition", `forbidden spawn transition ${edge}`);
      }
      if (next === "published") {
        this.refuseDrain();
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
  setDrain(cutoverId: string | null): void {
    this.locked(() => {
      if (cutoverId === null) {
        this.db.prepare("DELETE FROM meta WHERE key IN ('drain','admission_frontier')").run();
        return;
      }
      const existing = this.meta("drain");
      if (existing) {
        if ((JSON.parse(existing) as { cutover_id: string }).cutover_id !== cutoverId) {
          throw new Error("another drain owns the outbox");
        }
        return;
      }
      this.setMeta("drain", JSON.stringify({ cutover_id: cutoverId, entered_at: now() }));
      this.setMeta(
        "admission_frontier",
        JSON.stringify(
          this.db
            .prepare(`SELECT session_id,projection_epoch,MAX(revision) AS revision
        FROM outbox WHERE state IN ('prepared','applied') GROUP BY session_id,projection_epoch`)
            .all(),
        ),
      );
    });
  }
  inventory(): LocalDrainInventory {
    const counts = Object.fromEntries(ATTEMPT_STATES.map((state) => [state, 0])) as Record<
      SpawnAttemptState,
      number
    >;
    for (const row of this.db
      .prepare("SELECT state,COUNT(*) AS n FROM spawn_attempt GROUP BY state")
      .all()) {
      counts[String(row.state) as SpawnAttemptState] = Number(row.n);
    }
    const pending = this.db
      .prepare(
        "SELECT COUNT(*) AS n,MIN(prepared_at) AS oldest FROM outbox WHERE state IN ('prepared','applied')",
      )
      .get()!;
    const highWater: ProjectionTuple[] = [];
    for (const counter of this.db
      .prepare("SELECT * FROM session_revision ORDER BY session_id")
      .all()) {
      const firstOpen = this.db
        .prepare(
          `SELECT MIN(revision) AS r FROM outbox WHERE session_id=? AND projection_epoch=? AND state IN ('prepared','applied')`,
        )
        .get(String(counter.session_id), Number(counter.projection_epoch));
      const revision =
        firstOpen?.r == null ? Number(counter.last_revision) : Number(firstOpen.r) - 1;
      if (revision > 0) {
        highWater.push({
          session_id: String(counter.session_id),
          projection_epoch: Number(counter.projection_epoch),
          revision,
        });
      }
    }
    const drain = this.meta("drain");
    return {
      outbox_depth: Number(pending.n),
      oldest_unacknowledged: stringOrNull(pending.oldest),
      projection_heads: Number(
        this.db.prepare("SELECT COUNT(*) AS n FROM projection_head").get()!.n,
      ),
      high_water: this.acknowledgedFrontier(highWater),
      dispositioned_prefix: highWater,
      attempts: counts,
      admission_frontier: JSON.parse(this.meta("admission_frontier") ?? "[]") as ProjectionTuple[],
      runs: {
        adopted_without_ack_confirmation: Number(
          this.db
            .prepare(
              "SELECT COUNT(*) AS n FROM spawn_run WHERE adopted_fence IS NOT NULL AND ack_confirmed_at IS NULL",
            )
            .get()!.n,
        ),
      },
      drain: drain ? (JSON.parse(drain) as LocalDrainInventory["drain"]) : null,
    };
  }
  private acknowledgedFrontier(prefix: ProjectionTuple[]): ProjectionTuple[] {
    return prefix.flatMap((point) => {
      const row = this.db
        .prepare(`SELECT MAX(revision) AS revision FROM (
        SELECT revision FROM outbox WHERE session_id=? AND projection_epoch=? AND state='acknowledged'
        UNION ALL SELECT acked_revision AS revision FROM projection_head WHERE session_id=? AND acked_epoch=?
      ) WHERE revision<=?`)
        .get(
          point.session_id,
          point.projection_epoch,
          point.session_id,
          point.projection_epoch,
          point.revision,
        );
      return row?.revision == null ? [] : [{ ...point, revision: Number(row.revision) }];
    });
  }
}
