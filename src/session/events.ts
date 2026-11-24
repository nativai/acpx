import fs, { type FileHandle } from "node:fs/promises";
import { isAcpJsonRpcMessage } from "../acp/jsonrpc.js";
import { incrementPerfCounter, measurePerf } from "../perf-metrics.js";
import { getOwnProcessIdentity } from "../process-identity.js";
import type { AcpJsonRpcMessage, SessionRecord } from "../types.js";
import { DELIVERY_EVENT_METHOD } from "./delivery-events.js";
import {
  DEFAULT_EVENT_MAX_SEGMENTS,
  DEFAULT_EVENT_SEGMENT_MAX_BYTES,
  sessionBaseDir,
  sessionEventActivePath as activeEventPath,
  sessionEventLockPath as eventsLockPath,
  sessionEventSegmentPath as segmentEventPath,
} from "./event-log.js";
import {
  resolveSessionRecord,
  writeSessionRecord,
  writeSessionRecordAtBoundary,
} from "./persistence.js";
import {
  acquireIdentityFileLock,
  assertLockHeld,
  releaseIdentityFileLock,
  type IdentityLockPolicy,
} from "./persistence/identity-file-lock.js";

const EVENT_LOCK_STALE_MS = 15_000;
/** The waiter's budget on the stream lock (A5's primitive; no unbounded wait, no proceed-unlocked). */
export const STREAM_LOCK_BUDGET_MS = 20_000;
/**
 * C10: the largest single write to a stream file. A larger flush is cut into parts of at most this
 * many bytes with a data sync between them, so a reader on another machine sees a growing partial
 * line, never a hole (the spike: a 4 MiB append arrived as four requests, out of order).
 */
export const STREAM_WRITE_PART_BYTES = 1024 * 1024;

// Adapter heartbeats, delivery notifications, and ACPX status chrome are
// persisted to the stream (so the live per-session transcript + debug see them),
// but they are ACTIVITY-NEUTRAL: they must NOT advance
// `event_log.last_write_at` / `lastUsedAt`, or status-only markers during a
// silent turn would reset acpx-ui's wall-clock staleness / wedge-detection clock.
// Only genuine agent output counts as activity.
//
// Scope is strictly this marker METHOD. It deliberately does NOT match the
// `_claude/origin` / `_claude/lastTurnEndReason` `_meta` keys, which ride on REAL
// messages (e.g. the terminal `usage_update`) that MUST keep counting as activity.
export const ACTIVITY_NEUTRAL_EVENT_METHOD = "_claude/sessionStatus";
export const TURN_EVENT_METHOD = "acpx/turn";
export const RECEIVED_EVENT_METHOD = "acpx/received";
// brick a147982f — the C1 watchdog's own record of each tier it reached, written by acpx.
export const TURN_WATCHDOG_EVENT_METHOD = "acpx/turn-watchdog";
// brick a147982f — the claude-agent-acp ext notification that attributes an SDK turn end to one
// `session/prompt` (`_claude/promptId`). It is what arms the Claude watchdog; it is chrome, not
// agent output.
export const CLAUDE_PROMPT_LIFECYCLE_METHOD = "_claude/promptLifecycle";
// brick cec4c064 — claude-agent-acp's live background-task set (async Agent helpers,
// `run_in_background` commands, Monitors), sent whenever it changes. acpx-ui reads it to tell
// a healthy wait on a helper from a stuck turn, so it must never count as the agent's output:
// a membership change is not progress, and counting it would reset the silence clock the
// stalled verdict rests on. (It is not a `session/update`, so the turn watchdog's post-arm
// frame count, `updatesAfterArm`, never counts it either.)
export const CLAUDE_BACKGROUND_TASKS_METHOD = "_claude/backgroundTasks";
export const ACTIVITY_NEUTRAL_EVENT_METHODS = new Set([
  ACTIVITY_NEUTRAL_EVENT_METHOD,
  DELIVERY_EVENT_METHOD,
  TURN_EVENT_METHOD,
  RECEIVED_EVENT_METHOD,
  TURN_WATCHDOG_EVENT_METHOD,
  CLAUDE_PROMPT_LIFECYCLE_METHOD,
  CLAUDE_BACKGROUND_TASKS_METHOD,
]);

export function isActivityNeutralEventMessage(message: AcpJsonRpcMessage): boolean {
  const method = (message as { method?: unknown }).method;
  return typeof method === "string" && ACTIVITY_NEUTRAL_EVENT_METHODS.has(method);
}

async function ensureSessionDir(): Promise<void> {
  await fs.mkdir(sessionBaseDir(), { recursive: true });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function statSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

async function countExistingSegments(sessionId: string, maxSegments: number): Promise<number> {
  let count = 0;

  for (let segment = 1; segment <= maxSegments; segment += 1) {
    if (await pathExists(segmentEventPath(sessionId, segment))) {
      count += 1;
    }
  }

  if (await pathExists(activeEventPath(sessionId))) {
    count += 1;
  }

  return count;
}

async function resolveInitialSegmentCount(
  record: SessionRecord,
  maxSegments: number,
): Promise<number> {
  if (Number.isInteger(record.eventLog.segment_count) && record.eventLog.segment_count > 0) {
    return record.eventLog.segment_count;
  }
  return (await countExistingSegments(record.acpxRecordId, maxSegments)) || 1;
}

async function resolveSessionMaxSegments(sessionId: string): Promise<number> {
  try {
    const record = await resolveSessionRecord(sessionId);
    const configured = record.eventLog.max_segments;
    if (Number.isInteger(configured) && configured > 0) {
      return configured;
    }
  } catch {
    // Fall back to defaults when metadata is unavailable.
  }

  return DEFAULT_EVENT_MAX_SEGMENTS;
}

// Rename that treats a missing source as success — the same ENOENT tolerance
// the overflow unlink in rotateSegments already applies, for the same reason.
//
// Rotators RACE. Two concurrent appendMessages calls can both enter the
// rotation branch, because the size check there reads `activeSizeBytes` state
// that the winner only resets AFTER its `await` — so both call rotateSegments.
// The `pathExists`-then-rename guard this replaces could not close that window:
// both guards resolve before either rename runs, so the loser renamed a file
// the winner had already moved and threw ENOENT. That throw surfaced as a bogus
// `failed` delivery terminal on a prompt that had in fact completed — and
// because the write it aborted WAS the `done` terminal, it also disarmed the
// duplicate-delivery guard, which keys on exactly that `done`
// (hasCompletedDeliveryFor, cli/session/runtime.ts).
//
// Swallowing ENOENT is the CORRECT semantics here, not a workaround: a missing
// source means another rotator already moved it, which is the outcome this call
// wanted. It also covers cross-instance and cross-process rotators, which a
// per-writer lock would not.
async function renameTolerantOfMissingSource(from: string, to: string): Promise<void> {
  await fs.rename(from, to).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });
}

async function rotateSegments(sessionId: string, maxSegments: number): Promise<void> {
  const active = activeEventPath(sessionId);

  const overflow = segmentEventPath(sessionId, maxSegments);
  await fs.unlink(overflow).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  });

  for (let segment = maxSegments - 1; segment >= 1; segment -= 1) {
    await renameTolerantOfMissingSource(
      segmentEventPath(sessionId, segment),
      segmentEventPath(sessionId, segment + 1),
    );
  }

  await renameTolerantOfMissingSource(active, segmentEventPath(sessionId, 1));
}

/**
 * C10's writer rule, one open-append-close: the buffer goes out in ONE write when it fits
 * STREAM_WRITE_PART_BYTES, otherwise in parts of at most that size with a data sync after each part but
 * the last — so a large flush shows on another machine as a growing partial line, never a hole.
 */
export async function appendInParts(
  filePath: string,
  data: Buffer,
  partBytes: number = STREAM_WRITE_PART_BYTES,
): Promise<void> {
  const handle = await fs.open(filePath, "a");
  try {
    for (let from = 0; from < data.length; ) {
      const to = Math.min(data.length, from + partBytes);
      let at = from;
      while (at < to) {
        at += (await handle.write(data, at, to - at, null)).bytesWritten;
      }
      from = to;
      if (from < data.length) {
        await handle.datasync();
        await holdMidLineForTest(filePath);
      }
    }
  } finally {
    await handle.close();
  }
}

/**
 * ⚠️ TEST SEAM, honoured ONLY under a non-empty `NODE_TEST_CONTEXT` (`node --test` sets it; `""` does not
 * count): when `ACPX_TEST_STREAM_HOLD_MID_LINE` names a file, the writer that has just synced a part of
 * a larger flush writes that file (its content is the stream path, so a test sees which file is held)
 * and then waits until a test REMOVES that file. A test either SIGKILLs the process there — a REAL
 * writer dead mid-line, the A8 TE's F1 shape (brick eef0805f) — or removes the file and lets the
 * writer finish its line (brick 3f33cc2d: a LIVE writer between parts while another appender comes).
 * In production the variable is ignored. Held by `test/stream-partial-line.test.ts` ("the hold seam is
 * honoured only under NODE_TEST_CONTEXT") and by the rows of `test/stream-appenders.test.ts`.
 */
export function streamHoldMarkerForTest(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if ((env.NODE_TEST_CONTEXT ?? "") === "") {
    return undefined;
  }
  const marker = env.ACPX_TEST_STREAM_HOLD_MID_LINE;
  return marker === undefined || marker === "" ? undefined : marker;
}

async function holdMidLineForTest(filePath: string): Promise<void> {
  const marker = streamHoldMarkerForTest();
  if (marker === undefined) {
    return;
  }
  await fs.writeFile(marker, filePath, "utf8");
  while (await pathExists(marker)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * True when the file exists and its last byte is not a newline: a writer died mid-line (SIGKILL, OOM,
 * a pod gone) and left a PARTIAL line. A missing or empty file, and one ending in a newline, are not.
 */
export async function endsMidLine(filePath: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return false;
    }
    const last = Buffer.alloc(1);
    const { bytesRead } = await handle.read(last, 0, 1, size - 1);
    return bytesRead === 1 && last[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

export type LockHandle = {
  filePath: string;
  content: string;
};

export const STREAM_LOCK_TIMEOUT_CODE = "stream-lock-timeout";
class StreamLockTimeoutError extends Error {
  readonly code = STREAM_LOCK_TIMEOUT_CODE;
  constructor(
    lockPath: string,
    readonly holder: string,
  ) {
    super(
      `stream lock ${lockPath} is held for over ${STREAM_LOCK_BUDGET_MS} ms by ${holder}; ` +
        `refusing to write the stream without it`,
    );
  }
}

const STREAM_LOCK_POLICY: IdentityLockPolicy = {
  label: "session stream lock",
  budgetMs: STREAM_LOCK_BUDGET_MS,
  staleMs: EVENT_LOCK_STALE_MS,
  pollMaxMs: 100,
  legacyBody: () => ({ pid: process.pid, created_at: new Date().toISOString() }),
  makeTimeoutError: (lockPath, holder) => new StreamLockTimeoutError(lockPath, holder),
};

/**
 * ⚠️ THE STREAM LOCK IS THE PRIMITIVE'S POLICY AND HAS NO RULE OF ITS OWN (A-60, C3.5 (iii)).
 * It used to add R11: a body without `pod` was broken once its `created_at` was 15 s old, even when
 * the primitive judged its holder LIVE. That took a live owner's turn lock (the probe's F4-normal): a
 * flow's turn ran beside the owner and was then erased. Now a holder judged `live` is never broken,
 * by a waiter or by any sweep, at any age; a waiter that cannot break waits the budget and fails with
 * `stream-lock-timeout`, having written nothing. `EVENT_LOCK_STALE_MS` is only the stale age of an
 * `unjudgeable` holder (another pid namespace, a pre-0a body). Rows 60.4, 60.11 and 60.13 go red if
 * an age rule comes back.
 */
export const STREAM_LOCK_IDENTITY_MISSING_CODE = "stream-lock-identity-missing";
class StreamLockIdentityMissingError extends Error {
  readonly code = STREAM_LOCK_IDENTITY_MISSING_CODE;
  constructor() {
    super(
      "this process cannot read its own birth identity, so it takes no session stream lock: " +
        "its holder could not be judged live by a waiter or a sweep",
    );
  }
}

/** The stream lock is A5's primitive (brick 8d85cb47) under the stream policy: pod-aware judging, a bounded wait. */
export async function acquireEventsLock(
  sessionId: string,
  budgetMs: number = STREAM_LOCK_BUDGET_MS,
): Promise<LockHandle> {
  // C3.5 (iii): a body without the holder's birth identity can only be judged by age. No lock without it.
  if (getOwnProcessIdentity() === undefined) {
    throw new StreamLockIdentityMissingError();
  }
  await ensureSessionDir();
  const lockPath = eventsLockPath(sessionId);
  return {
    filePath: lockPath,
    content: await acquireIdentityFileLock(lockPath, { ...STREAM_LOCK_POLICY, budgetMs }),
  };
}

async function releaseEventsLock(lock: LockHandle): Promise<void> {
  // Compare-and-delete: a writer whose lock was taken over must not delete its successor's.
  await releaseIdentityFileLock(lock.filePath, lock.content);
}

type SessionEventWriterOptions = {
  maxSegmentBytes?: number;
  maxSegments?: number;
};

type AppendOptions = {
  checkpoint?: boolean;
};

export class SessionEventWriter {
  private readonly record: SessionRecord;
  private readonly lock: LockHandle;
  private readonly maxSegmentBytes: number;
  private readonly maxSegments: number;
  private activePath: string;
  private activeSizeBytes: number;
  private segmentCount: number;
  /**
   * The file whose tail this writer has already checked. A writer that finds the file it is about to
   * append to ending mid-line closes that line with ONE newline before its first frame (see
   * `appendActive`); after that, and after a rotation hands it a fresh empty file, every byte it writes
   * ends in a newline and there is nothing left to check.
   */
  private tailCheckedPath: string | undefined;
  private closed = false;

  private constructor(
    record: SessionRecord,
    lock: LockHandle,
    options: Required<SessionEventWriterOptions>,
    state: {
      activePath: string;
      activeSizeBytes: number;
      segmentCount: number;
    },
  ) {
    this.record = record;
    this.lock = lock;
    this.maxSegmentBytes = options.maxSegmentBytes;
    this.maxSegments = options.maxSegments;
    this.activePath = state.activePath;
    this.activeSizeBytes = state.activeSizeBytes;
    this.segmentCount = state.segmentCount;
  }

  static async open(
    record: SessionRecord,
    options: SessionEventWriterOptions = {},
  ): Promise<SessionEventWriter> {
    const lock = await acquireEventsLock(record.acpxRecordId);
    const maxSegmentBytes =
      options.maxSegmentBytes ??
      record.eventLog.max_segment_bytes ??
      DEFAULT_EVENT_SEGMENT_MAX_BYTES;
    const maxSegments =
      options.maxSegments ?? record.eventLog.max_segments ?? DEFAULT_EVENT_MAX_SEGMENTS;
    const activePath = activeEventPath(record.acpxRecordId);
    const activeSizeBytes = await statSize(activePath);
    const segmentCount = await resolveInitialSegmentCount(record, maxSegments);
    return new SessionEventWriter(
      record,
      lock,
      {
        maxSegmentBytes,
        maxSegments,
      },
      {
        activePath,
        activeSizeBytes,
        segmentCount,
      },
    );
  }

  getRecord(): SessionRecord {
    return this.record;
  }

  async appendMessage(message: AcpJsonRpcMessage, options: AppendOptions = {}): Promise<void> {
    await this.appendMessages([message], options);
  }

  async appendMessages(messages: AcpJsonRpcMessage[], options: AppendOptions = {}): Promise<void> {
    if (this.closed) {
      throw new Error("SessionEventWriter is closed");
    }

    if (messages.length === 0) {
      return;
    }

    await ensureSessionDir();

    await measurePerf("session.events.append_batch", async () => {
      // Validate the whole batch BEFORE the first byte is written: a bad frame fails the flush, never half of it.
      for (const message of messages) {
        if (!isAcpJsonRpcMessage(message)) {
          throw new Error("Attempted to persist invalid ACP JSON-RPC payload");
        }
      }

      // C10 / A-14: ONE write per flush. The lines bound for the active file are gathered and written
      // together; only a rotation (a different file) ends a group early.
      let group: { message: AcpJsonRpcMessage; line: Buffer }[] = [];
      const writeGroup = async (): Promise<void> => {
        if (group.length === 0) {
          return;
        }
        const written = group;
        group = [];
        // C3.2 A-4: the holder checks its lock immediately before it publishes.
        await assertLockHeld(this.lock.filePath, this.lock.content);
        await this.appendActive(Buffer.concat(written.map((entry) => entry.line)));
        for (const entry of written) {
          this.noteWritten(entry.message);
        }
      };

      for (const message of messages) {
        const line = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
        if (this.activeSizeBytes > 0 && this.activeSizeBytes + line.length > this.maxSegmentBytes) {
          await writeGroup();
          await rotateSegments(this.record.acpxRecordId, this.maxSegments);
          this.activePath = activeEventPath(this.record.acpxRecordId);
          this.activeSizeBytes = 0;
          this.segmentCount = Math.min(this.segmentCount + 1, this.maxSegments);
          incrementPerfCounter("session.events.rotate");
        }
        group.push({ message, line });
        this.activeSizeBytes += line.length;
      }
      await writeGroup();
    });

    if (options.checkpoint === true) {
      await writeSessionRecord(this.record);
    }
  }

  /**
   * ⚠️ A DEAD WRITER'S PARTIAL LINE MUST NOT SWALLOW THIS WRITER'S FIRST FRAME (brick eef0805f; the A8 TE's
   * F1). A writer killed mid-line leaves a tail with no newline; the next append would land on that line
   * and a reader that splits on newline would read both as one damaged line, losing a good frame. So before
   * its FIRST append to a file, under the stream lock it holds, the writer looks at the last byte and, if
   * it is not a newline, puts ONE newline in front of its own bytes: the partial line stays a single damaged
   * line and every good frame stays readable. The newline rides in the SAME write as the frames (C10: one
   * write per flush), and it is added only after a look at the tail — a tail that already ends in a newline
   * gets none (no empty line), an empty or missing file is untouched, and it never cuts a COMPLETE line
   * (C3.5: a complete line is only ever followed, never changed). Rows in `test/stream-partial-line.test.ts`.
   */
  private async appendActive(lines: Buffer): Promise<void> {
    let data = lines;
    if (this.tailCheckedPath !== this.activePath) {
      if (await endsMidLine(this.activePath)) {
        data = Buffer.concat([Buffer.from("\n"), lines]);
        this.activeSizeBytes += 1;
      }
    }
    await appendInParts(this.activePath, data);
    this.tailCheckedPath = this.activePath;
  }

  /** The record's bookkeeping for one frame that is now on disk. */
  private noteWritten(message: AcpJsonRpcMessage): void {
    this.record.lastSeq += 1;
    if (Object.hasOwn(message, "id")) {
      const id = (message as { id?: unknown }).id;
      if (typeof id === "string" || typeof id === "number") {
        this.record.lastRequestId = String(id);
      }
    }
    // Activity-neutral markers (adapter heartbeats) are persisted for the live transcript + debug,
    // but advance neither last_write_at nor lastUsedAt — so a heartbeat during a silent turn can't
    // reset acpx-ui's wedge clock. Structural eventLog fields still track any rotation.
    const neutral = isActivityNeutralEventMessage(message);
    const writeTs = new Date().toISOString();
    if (!neutral) {
      this.record.lastUsedAt = writeTs;
    }
    this.record.eventLog = {
      active_path: this.activePath,
      segment_count: this.segmentCount,
      max_segment_bytes: this.maxSegmentBytes,
      max_segments: this.maxSegments,
      last_write_at: neutral ? this.record.eventLog.last_write_at : writeTs,
      last_write_error: null,
    };
  }

  /** Persist the record. The write merges against the disk image it reads right before its rename. */
  async checkpoint(): Promise<void> {
    if (this.closed) {
      throw new Error("SessionEventWriter is closed");
    }
    await writeSessionRecord(this.record);
  }

  async close(options: AppendOptions = {}): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      if (options.checkpoint !== false) {
        await writeSessionRecordAtBoundary(this.record);
      }
    } finally {
      this.closed = true;
      await releaseEventsLock(this.lock);
    }
  }
}

export async function listSessionEvents(sessionId: string): Promise<AcpJsonRpcMessage[]> {
  const maxSegments = await resolveSessionMaxSegments(sessionId);
  const files: string[] = [];

  for (let segment = maxSegments; segment >= 1; segment -= 1) {
    const filePath = segmentEventPath(sessionId, segment);
    if (await pathExists(filePath)) {
      files.push(filePath);
    }
  }

  const active = activeEventPath(sessionId);
  if (await pathExists(active)) {
    files.push(active);
  }

  const events: AcpJsonRpcMessage[] = [];
  for (const filePath of files) {
    const payload = await fs.readFile(filePath, "utf8");
    const lines = payload.split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isAcpJsonRpcMessage(parsed)) {
          events.push(parsed);
        }
      } catch {
        // Skip malformed lines to keep event listing resilient.
      }
    }
  }

  return events;
}
