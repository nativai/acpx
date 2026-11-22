import fs from "node:fs";
import path from "node:path";

/**
 * The spawn-state file `<sessions>/<id>.spawn-state` — shape v1, READER side (block A7, brick
 * 9289d7c4; contract C3.4 / A-13; writer: atrium S7, `server/spawnStateFile.ts`; shape agreed in
 * `Bricks/33cedd18…/impl/SPAWN-STATE-SHAPE.md`).
 *
 * In an agent pod the owner never opens `brick-outbox.db` (C1.2 rule 5). The checks the ledger's SQLite
 * made on a spawn-owned record's write — the attempt exists and is `launched | published | adopted`,
 * the bound instance, who may rebind the ACP id — read THIS file instead, which the control pod
 * publishes at every ledger transition and before the pod's first wake.
 *
 * ⚠️ NOT A `.json` NAME, AND THAT IS THE POINT (A-13): every `.json` file in the sessions directory is
 * read as a session record, so `<id>.spawn.json` would be taken for a record with id `<id>.spawn`.
 * `test/pod-spawn-state.test.ts` pins the suffix against the enumerators.
 *
 * "CANNOT TELL NEVER PERMITS." A missing, unreadable or unknown-version file refuses the write; so does
 * a file older or newer than the record. Every lagging case ends in a refusal or in less permission,
 * never in more (shape §5a). The two refusals a caller retries alike are `spawn-state-missing` and
 * `spawn-state-stale`; they are kept apart only for the log.
 */

export const SPAWN_STATE_SUFFIX = ".spawn-state";
export const SPAWN_STATE_VERSION = 1;

export type SpawnStateAttemptState =
  | "reserved"
  | "launched"
  | "published"
  | "adopted"
  | "revoked"
  | "cancelled"
  | "orphaned";

export type SpawnState = {
  v: 1;
  record_id: string;
  spawn_key: string;
  run_id: string;
  fence: number;
  state: SpawnStateAttemptState;
  adopted_fence: number | null;
  /** The instance the ledger is bound to, or null (the reader then skips the instance check only). */
  instance_id: string | null;
  record_spawn_state: string;
  receipt_conflict: boolean;
  published_at: string;
};

/** The states in which an attempt may write its destination record (the ledger's own list). */
export const WRITABLE_ATTEMPT_STATES: readonly string[] = ["launched", "published", "adopted"];

const ATTEMPT_STATES: ReadonlySet<string> = new Set([
  "reserved",
  "launched",
  "published",
  "adopted",
  "revoked",
  "cancelled",
  "orphaned",
]);

export type SpawnStateRefusalCode =
  | "spawn-state-missing"
  | "spawn-state-unsupported"
  | "spawn-state-stale"
  | "record-ownership"
  | "outbox-instance-mismatch"
  | "spawn-revoked";

export type SpawnStateRefusal = { code: SpawnStateRefusalCode; message: string };

export function spawnStatePath(sessionsDir: string, recordId: string): string {
  return path.join(sessionsDir, `${encodeURIComponent(recordId)}${SPAWN_STATE_SUFFIX}`);
}

export type SpawnStateRead =
  | { ok: true; state: SpawnState }
  | { ok: false; refusal: SpawnStateRefusal };

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
const isString = (value: unknown): boolean => typeof value === "string";
const isNullable = (check: (value: unknown) => boolean) => (value: unknown) =>
  value === null || check(value);

/** One check per field of shape v1 — every field is required (`null` where the column is null). */
const FIELD_CHECKS: Readonly<Record<Exclude<keyof SpawnState, "v">, (value: unknown) => boolean>> =
  {
    record_id: isString,
    spawn_key: isString,
    run_id: isString,
    fence: isInteger,
    state: (value) => typeof value === "string" && ATTEMPT_STATES.has(value),
    adopted_fence: isNullable(isInteger),
    instance_id: isNullable(isString),
    record_spawn_state: isString,
    receipt_conflict: (value) => typeof value === "boolean",
    published_at: isString,
  };

/** The file's content as shape v1, or the named refusal. */
export function parseSpawnState(raw: string): SpawnStateRead {
  const unsupported = (why: string): SpawnStateRead => ({
    ok: false,
    refusal: { code: "spawn-state-unsupported", message: `spawn-state file unusable: ${why}` },
  });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return unsupported("not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return unsupported("not an object");
  }
  const field = value as Record<string, unknown>;
  if (field.v !== SPAWN_STATE_VERSION) {
    return unsupported(`version ${JSON.stringify(field.v)} is not ${SPAWN_STATE_VERSION}`);
  }
  const bad = Object.entries(FIELD_CHECKS).find(([name, check]) => !check(field[name]));
  return bad
    ? unsupported(`field ${bad[0]} is missing or has the wrong type`)
    : { ok: true, state: field as unknown as SpawnState };
}

/** Reads `<id>.spawn-state`. Absent ⇒ `spawn-state-missing`; anything else unreadable ⇒ unsupported. */
export function readSpawnStateFile(file: string): SpawnStateRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        refusal: {
          code: "spawn-state-missing",
          message: `no spawn-state file at ${file}: the control pod has not published this attempt (retry)`,
        },
      };
    }
    return {
      ok: false,
      refusal: {
        code: "spawn-state-unsupported",
        message: `spawn-state file unreadable: ${(error as Error).message}`,
      },
    };
  }
  return parseSpawnState(raw);
}

/** What the reader needs to know about the write it judges. */
export type SpawnStateJudgement = {
  /** The record id being written (= the writer's `acpx_record_id`). */
  recordId: string;
  /** The writer's `metadata.spawn_key`. */
  writerSpawnKey: string;
  /** The record on disk's `metadata.spawn_state`, as read inside the record lock (`undefined` ⇒ pending). */
  currentSpawnState: string | undefined;
  /** This HOME's admitted instance id — read lazily, only when the file carries one. */
  admittedInstanceId: () => string;
};

/**
 * The reader's rules in the shape's order (§5): the first that fails is the refusal. Pure — no
 * clock is compared, no database opened.
 */
export function judgeSpawnState(
  state: SpawnState,
  judgement: SpawnStateJudgement,
): SpawnStateRefusal | undefined {
  if (state.record_id !== judgement.recordId || state.spawn_key !== judgement.writerSpawnKey) {
    return {
      code: "record-ownership",
      message: "spawn key does not own reserved destination (spawn-state names another attempt)",
    };
  }
  const recorded = judgement.currentSpawnState ?? "pending";
  if (state.record_spawn_state !== recorded) {
    return {
      code: "spawn-state-stale",
      message: `spawn-state says the record is "${state.record_spawn_state}" but it is "${recorded}": the file is older or newer than the record (retry)`,
    };
  }
  if (state.instance_id !== null) {
    const admitted = judgement.admittedInstanceId();
    if (state.instance_id !== admitted) {
      return {
        code: "outbox-instance-mismatch",
        message: `the spawn ledger is bound to instance ${state.instance_id}, but this HOME's instance.json reports ${admitted}`,
      };
    }
  }
  if (!WRITABLE_ATTEMPT_STATES.includes(state.state)) {
    return { code: "spawn-revoked", message: `spawn attempt is ${state.state}; write refused` };
  }
  return undefined;
}

/**
 * Whether the session's own owner may rebind `acp_session_id` (the ledger's `ownerMayRebind`): the
 * attempt is the run's adopted one — and, separately, the caller proves the lease names this process.
 */
export function stateAllowsRebind(state: SpawnState): boolean {
  return state.state === "adopted" && state.adopted_fence === state.fence;
}
