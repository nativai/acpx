import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
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
  judgeLockHolder,
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
/**
 * The appender's wait on a LIVE foreign writer that has left a partial line (brick 3f33cc2d): async, the
 * tail may stay unchanged this long before the writer is judged frozen; sync, the whole wait is capped
 * at this (the sync callers are exit paths: `PROCESS_EXIT_GRACE_MS` is 1.5 s). `ACPX_TEST_STREAM_APPEND_STALL_MS`
 * replaces both under `NODE_TEST_CONTEXT` only (`streamAppendTimingForTest`).
 */
export const STREAM_APPEND_STALL_MS = 5_000;
export const STREAM_APPEND_SYNC_MAX_WAIT_MS = 1_000;
const STREAM_APPEND_POLL_MS = 25;

/** Raw bodies of the stream locks THIS process holds: a partial tail under one of them is not another writer's. */
const heldStreamLocks = new Set<string>();
/** Active files this process is writing in parts right now, with the lines other appenders of this process queued. */
const multiPartInFlight = new Map<string, string[]>();

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
 * the last — so a large flush shows on another machine as a growing partial line, never as a hole.
 *
 * ⚠️ For exactly the span of a multi-part flush this process is "mid-line" on `filePath`: it is listed in
 * `multiPartInFlight`, and every line another appender of THIS process hands to `appendStreamText[Sync]`
 * meanwhile is queued there, never written between the parts (brick 3f33cc2d). The queue goes out right
 * after the last part, on the same handle; after a failed part, or at process exit, with the closing
 * newline of the line that will never be finished.
 */
export async function appendInParts(
  filePath: string,
  data: Buffer,
  partBytes: number = STREAM_WRITE_PART_BYTES,
): Promise<void> {
  const handle = await fs.open(filePath, "a");
  const multiPart = data.length > partBytes;
  const queued: string[] = [];
  if (multiPart) {
    multiPartInFlight.set(filePath, queued);
    registerExitDrain();
  }
  let completed = false;
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
    completed = true;
  } finally {
    if (multiPart) {
      multiPartInFlight.delete(filePath);
    }
    try {
      if (completed && queued.length > 0) {
        const rest = Buffer.from(queued.join(""), "utf8");
        for (let at = 0; at < rest.length; ) {
          at += (await handle.write(rest, at, rest.length - at, null)).bytesWritten;
        }
      }
    } finally {
      await handle.close();
    }
    if (!completed && queued.length > 0) {
      appendClosingTailSync(filePath, queued.join(""));
    }
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

/**
 * ⚠️ ONE RULE FOR EVERY APPENDER TO THE STREAM: A LINE IS APPENDED ONLY AT A LINE BOUNDARY (brick 3f33cc2d,
 * the eef0805f TE's F1). The lockless appenders (`acpx/received`, delivery terminals, `acpx/refused`, the
 * background-task chip clear) used to `appendFile` blind: after a dead writer they fused onto its partial
 * line and were lost; and they could land BETWEEN the parts of a live writer's multi-part flush, tearing
 * that frame. They cannot take the stream lock: the owner's own writer holds it for its whole life (a wait
 * on ourselves, 20 s) and the sync callers are exit paths. So, in the active file:
 *   1. the tail ends in a newline, or the file is empty or missing → ONE write of the text;
 *   2. the tail is mid-line and its writer is DEAD (no lock file, a holder `judgeLockHolder` calls
 *      breakable, or a lock THIS process holds with no multi-part write of its own in flight) → ONE write of
 *      "\n" + the text: the partial line stays one damaged line, the closing newline rides in the same write;
 *   3. this process's own multi-part flush is in flight → the text is QUEUED behind it (`appendInParts`);
 *   4. another process holds the lock and is live or unjudgeable → it may be between parts: WAIT for the tail
 *      to end in a newline; if it does not grow for the stall time (sync: the hard cap) the holder is frozen,
 *      not writing, and rule 2 applies.
 * `SessionEventWriter.open` closes a dead predecessor's tail at acquisition, so "live holder + partial tail"
 * can only mean rule 3 or 4. Rows in `test/stream-appenders.test.ts`.
 */
type AppendStep = "written" | "queued" | "wait";

function streamAppendTimingForTest(env: NodeJS.ProcessEnv = process.env): number | undefined {
  if ((env.NODE_TEST_CONTEXT ?? "") === "") {
    return undefined;
  }
  const raw = env.ACPX_TEST_STREAM_APPEND_STALL_MS;
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function writeAllSync(fd: number, data: Buffer): void {
  for (let at = 0; at < data.length; ) {
    at += writeSync(fd, data, at, data.length - at);
  }
}

/** Does the stream's last writer still live? `dead`: nobody can be finishing the partial tail. */
function tailWriterIsDead(sessionId: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(eventsLockPath(sessionId), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  if (heldStreamLocks.has(raw)) {
    return true;
  }
  let body: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
  } catch {
    body = undefined;
  }
  return judgeLockHolder(body) === "breakable";
}

function appendStepSync(sessionId: string, text: string, force: boolean): AppendStep {
  const active = activeEventPath(sessionId);
  const queue = multiPartInFlight.get(active);
  if (queue) {
    queue.push(text);
    return "queued";
  }
  const fd = openSync(active, "a+");
  try {
    const { size } = fstatSync(fd);
    let midLine = false;
    if (size > 0) {
      const last = Buffer.alloc(1);
      midLine = readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    }
    if (midLine && !force && !tailWriterIsDead(sessionId)) {
      return "wait";
    }
    writeAllSync(fd, Buffer.from(midLine ? `\n${text}` : text, "utf8"));
    return "written";
  } finally {
    closeSync(fd);
  }
}

function sizeOrZero(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The synchronous appender (exit paths and CLI terminals). Waits at most `STREAM_APPEND_SYNC_MAX_WAIT_MS`. */
export function appendStreamTextSync(sessionId: string, text: string): void {
  const cap = streamAppendTimingForTest() ?? STREAM_APPEND_SYNC_MAX_WAIT_MS;
  const startedAt = Date.now();
  while (appendStepSync(sessionId, text, Date.now() - startedAt >= cap) === "wait") {
    sleepSync(STREAM_APPEND_POLL_MS);
  }
}

/** The asynchronous appender: the same rule, waiting without blocking the loop. */
export async function appendStreamText(sessionId: string, text: string): Promise<void> {
  const stallMs = streamAppendTimingForTest() ?? STREAM_APPEND_STALL_MS;
  const active = activeEventPath(sessionId);
  const startedAt = Date.now();
  let lastSize = -1;
  let lastGrowthAt = startedAt;
  for (;;) {
    const now = Date.now();
    const size = sizeOrZero(active);
    if (size !== lastSize) {
      lastSize = size;
      lastGrowthAt = now;
    }
    const frozen = now - lastGrowthAt >= stallMs || now - startedAt >= STREAM_LOCK_BUDGET_MS;
    if (appendStepSync(sessionId, text, frozen) !== "wait") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, STREAM_APPEND_POLL_MS));
  }
}

/** A line that follows a writer which will never finish its own: close the tail if it is mid-line, then append. */
function appendClosingTailSync(filePath: string, text: string): void {
  const fd = openSync(filePath, "a+");
  try {
    const { size } = fstatSync(fd);
    const last = Buffer.alloc(1);
    const midLine = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    writeAllSync(fd, Buffer.from(midLine ? `\n${text}` : text, "utf8"));
  } finally {
    closeSync(fd);
  }
}

let exitDrainRegistered = false;
function registerExitDrain(): void {
  if (exitDrainRegistered) {
    return;
  }
  exitDrainRegistered = true;
  process.once("exit", () => {
    for (const [filePath, queued] of multiPartInFlight) {
      if (queued.length > 0) {
        try {
          appendClosingTailSync(filePath, queued.join(""));
        } catch {
          // Best effort: the process is leaving.
        }
      }
    }
  });
}

/** Closes a dead writer's partial line with ONE newline (a clean, empty or missing tail is left alone). */
async function closeDeadTail(filePath: string): Promise<void> {
  if (await endsMidLine(filePath)) {
    await fs.appendFile(filePath, "\n", "utf8");
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
  const content = await acquireIdentityFileLock(lockPath, { ...STREAM_LOCK_POLICY, budgetMs });
  heldStreamLocks.add(content);
  return { filePath: lockPath, content };
}

async function releaseEventsLock(lock: LockHandle): Promise<void> {
  // Compare-and-delete: a writer whose lock was taken over must not delete its successor's.
  heldStreamLocks.delete(lock.content);
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
    // ⚠️ AT ACQUISITION, under the lock just taken (the previous holder is released or proven dead, so no
    // live multi-part write exists): a dead predecessor's partial line is closed with ONE newline NOW, not
    // at the first append. From here on, a partial tail under a live holder can only be that holder's own
    // in-flight part, which is what lets the lockless appenders (`appendStreamText`) tell the two apart.
    try {
      await closeDeadTail(activeEventPath(record.acpxRecordId));
    } catch (error) {
      await releaseEventsLock(lock);
      throw error;
    }
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
   * One write per flush (C10). A dead writer's partial tail was already closed at `open` (see there), so
   * every byte this writer writes starts at a line boundary and ends in a newline.
   */
  private async appendActive(lines: Buffer): Promise<void> {
    await appendInParts(this.activePath, lines);
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

/** Damaged lines already reported by this process, `<file>:<byte offset>`: a re-read of the same file stays quiet. */
const reportedDamagedLines = new Set<string>();

/**
 * Parses one stream file's text the way every acpx reader does, and COUNTS AND LOGS what it skips (C10, A-63):
 * an unparsable line is a writer's partial line, or a frame a frozen writer's appender ended. It is skipped,
 * never silently: a stderr line names the file, how many lines and the byte offset of each new one, and the
 * `session.events.damaged_line` perf counter counts them. A line is reported once per process.
 */
export function parseStreamPayload(payload: string, filePath: string): AcpJsonRpcMessage[] {
  const events: AcpJsonRpcMessage[] = [];
  const fresh: number[] = [];
  let damaged = 0;
  let offset = 0;
  for (const line of payload.split("\n")) {
    const lineOffset = offset;
    offset += Buffer.byteLength(line, "utf8") + 1;
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isAcpJsonRpcMessage(parsed)) {
        events.push(parsed);
      }
    } catch {
      damaged += 1;
      incrementPerfCounter("session.events.damaged_line");
      if (!reportedDamagedLines.has(`${filePath}:${lineOffset}`)) {
        reportedDamagedLines.add(`${filePath}:${lineOffset}`);
        fresh.push(lineOffset);
      }
    }
  }
  if (fresh.length > 0) {
    process.stderr.write(
      `[acpx] stream file ${filePath}: skipped ${damaged} damaged line(s) ` +
        `(unparsable, a writer's partial line); new at byte offset ${fresh.join(", ")}\n`,
    );
  }
  return events;
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
    events.push(...parseStreamPayload(await fs.readFile(filePath, "utf8"), filePath));
  }

  return events;
}
