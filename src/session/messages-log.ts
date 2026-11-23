import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SessionAgentContent,
  SessionMessage,
  SessionMessagesLogState,
  SessionRecord,
  SessionToolResultContent,
  SessionUserContent,
} from "../types.js";
import { markLoadedInlineEntries, setLoggedMessageCount } from "./messages-log-bookkeeping.js";

export const MESSAGES_LOG_COMPACT_BYTES = 32 * 1024 * 1024;

const MAX_RUNTIME_MESSAGES = 200;
const TAIL_READ_CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

export function messagesLogFileName(acpxRecordId: string): string {
  return `${encodeURIComponent(acpxRecordId)}.messages.ndjson`;
}

export function messagesLogPath(sessionDir: string, acpxRecordId: string): string {
  return path.join(sessionDir, messagesLogFileName(acpxRecordId));
}

export function messagesLogStalePath(logPath: string): string {
  return `${logPath}.stale`;
}

function warn(message: string): void {
  process.stderr.write(`[acpx] warning: ${message}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

// eslint-disable-next-line complexity -- mirrors persisted message image validation without exporting parser internals
function isSessionMessageImage(raw: unknown): boolean {
  const record = isRecord(raw) ? raw : undefined;
  if (!record || typeof record.source !== "string") {
    return false;
  }

  if (record.size === undefined || record.size === null) {
    return true;
  }

  const size = isRecord(record.size) ? record.size : undefined;
  return !!size && isFiniteNumber(size.width) && isFiniteNumber(size.height);
}

function isSessionMessageAudio(raw: unknown): boolean {
  const record = isRecord(raw) ? raw : undefined;
  return !!record && typeof record.source === "string" && typeof record.mime_type === "string";
}

// eslint-disable-next-line complexity -- mirrors the persisted conversation validator for log-line validation
function isUserContent(raw: unknown): raw is SessionUserContent {
  const record = isRecord(raw) ? raw : undefined;
  if (!record) {
    return false;
  }

  if (typeof record.Text === "string") {
    return true;
  }

  if (record.Mention !== undefined) {
    const mention = isRecord(record.Mention) ? record.Mention : undefined;
    return !!mention && typeof mention.uri === "string" && typeof mention.content === "string";
  }

  if (record.Image !== undefined) {
    return isSessionMessageImage(record.Image);
  }

  if (record.Audio !== undefined) {
    return isSessionMessageAudio(record.Audio);
  }

  return false;
}

function isThinkingContent(raw: unknown): boolean {
  const thinking = isRecord(raw) ? raw : undefined;
  return !!thinking && typeof thinking.text === "string" && isOptionalString(thinking.signature);
}

function isToolUse(raw: unknown): boolean {
  const record = isRecord(raw) ? raw : undefined;
  return (
    !!record &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.raw_input === "string" &&
    hasOwn(record, "input") &&
    typeof record.is_input_complete === "boolean" &&
    isOptionalString(record.thought_signature)
  );
}

function isToolResultContent(raw: unknown): raw is SessionToolResultContent {
  const record = isRecord(raw) ? raw : undefined;
  if (!record) {
    return false;
  }

  if (typeof record.Text === "string") {
    return true;
  }

  if (record.Image !== undefined) {
    return isSessionMessageImage(record.Image);
  }

  return false;
}

function isToolResult(raw: unknown): boolean {
  const record = isRecord(raw) ? raw : undefined;
  return (
    !!record &&
    typeof record.tool_use_id === "string" &&
    typeof record.tool_name === "string" &&
    typeof record.is_error === "boolean" &&
    isToolResultContent(record.content)
  );
}

function isAgentContent(raw: unknown): raw is SessionAgentContent {
  const record = isRecord(raw) ? raw : undefined;
  if (!record) {
    return false;
  }

  if (typeof record.Text === "string") {
    return true;
  }

  if (record.Thinking !== undefined) {
    return isThinkingContent(record.Thinking);
  }

  if (typeof record.RedactedThinking === "string") {
    return true;
  }

  if (record.ToolUse !== undefined) {
    return isToolUse(record.ToolUse);
  }

  return false;
}

// eslint-disable-next-line complexity -- one local type guard keeps the log module self-contained
function isSessionMessage(raw: unknown): raw is SessionMessage {
  if (raw === "Resume") {
    return true;
  }

  const record = isRecord(raw) ? raw : undefined;
  if (!record) {
    return false;
  }

  if (record.User !== undefined) {
    const user = isRecord(record.User) ? record.User : undefined;
    return (
      !!user &&
      typeof user.id === "string" &&
      // Durable byway-fork provenance: recognized + preserved across the
      // messages_log round-trip; never stripped.
      isOptionalString(user.claude_uuid) &&
      Array.isArray(user.content) &&
      user.content.every((entry) => isUserContent(entry))
    );
  }

  if (record.Agent !== undefined) {
    const agent = isRecord(record.Agent) ? record.Agent : undefined;
    if (
      !agent ||
      !isOptionalString(agent.claude_uuid) ||
      !Array.isArray(agent.content) ||
      !agent.content.every(isAgentContent)
    ) {
      return false;
    }
    const toolResults = isRecord(agent.tool_results) ? agent.tool_results : undefined;
    return !!toolResults && Object.values(toolResults).every(isToolResult);
  }

  return false;
}

function parseMessageLine(line: Buffer): SessionMessage | undefined {
  if (line.length === 0) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(line.toString("utf8"));
    return isSessionMessage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function splitBufferLines(buffer: Buffer): Buffer[] {
  const lines: Buffer[] = [];
  let start = 0;
  for (;;) {
    const next = buffer.indexOf(NEWLINE, start);
    if (next === -1) {
      lines.push(buffer.subarray(start));
      return lines;
    }
    lines.push(buffer.subarray(start, next));
    start = next + 1;
  }
}

function parseCompleteMessageLines(buffer: Buffer): {
  messages: SessionMessage[];
  bytes: number;
} {
  const lastNewline = buffer.lastIndexOf(NEWLINE);
  if (lastNewline === -1) {
    return { messages: [], bytes: 0 };
  }

  const complete = buffer.subarray(0, lastNewline + 1);
  const messages: SessionMessage[] = [];
  for (const line of splitBufferLines(complete)) {
    if (line.length === 0) {
      continue;
    }
    const message = parseMessageLine(line);
    if (!message) {
      warn("ignoring malformed messages log line");
      continue;
    }
    messages.push(message);
  }
  return { messages, bytes: complete.length };
}

async function readFileRange(filePath: string, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  if (length === 0) {
    return buffer;
  }

  const handle = await fs.open(filePath, "r");
  try {
    await handle.read(buffer, 0, length, start);
    return buffer;
  } finally {
    await handle.close();
  }
}

// eslint-disable-next-line complexity -- backward chunk scanning has several corruption/limit exits
async function readMessagesLogTail(
  logPath: string,
  endByte: number,
  maxMessages: number,
): Promise<SessionMessage[]> {
  if (maxMessages <= 0 || endByte <= 0) {
    return [];
  }

  const messagesFromTail: SessionMessage[] = [];
  const handle = await fs.open(logPath, "r");
  let carry = Buffer.alloc(0);
  let position = endByte;

  try {
    while (position > 0 && messagesFromTail.length < maxMessages) {
      const chunkLength = Math.min(TAIL_READ_CHUNK_BYTES, position);
      position -= chunkLength;
      const chunk = Buffer.alloc(chunkLength);
      await handle.read(chunk, 0, chunkLength, position);
      const combined = Buffer.concat([chunk, carry]);
      const firstNewline = combined.indexOf(NEWLINE);

      if (firstNewline === -1) {
        carry = combined;
        continue;
      }

      carry = combined.subarray(0, firstNewline);
      const complete = combined.subarray(firstNewline + 1);
      const lines = splitBufferLines(complete);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (messagesFromTail.length >= maxMessages) {
          break;
        }
        const line = lines[index];
        if (line.length === 0) {
          continue;
        }
        const message = parseMessageLine(line);
        if (!message) {
          warn("ignoring malformed messages log line");
          continue;
        }
        messagesFromTail.push(message);
      }
    }

    if (position === 0 && carry.length > 0 && messagesFromTail.length < maxMessages) {
      const message = parseMessageLine(carry);
      if (message) {
        messagesFromTail.push(message);
      } else {
        warn("ignoring malformed messages log line");
      }
    }
  } finally {
    await handle.close();
  }

  return messagesFromTail.toReversed();
}

/**
 * Every entry of the log up to `endByte`, in order, each with the raw line it was
 * read from — the FULL history `readMessagesLogTail` windows. Positions count
 * parsed entries only: an empty or malformed line is skipped exactly as the tail
 * reader skips it, so entry `i` here is the entry the tail reader would also
 * place at `i`. A missing file is an empty log. (brick 0dc53ac9, `--at-log-index`)
 */
export async function readMessagesLogEntries(
  logPath: string,
  endByte: number,
): Promise<{ messages: SessionMessage[]; rawLines: string[] }> {
  let buffer: Buffer;
  try {
    // Clamped to the file: a watermark past EOF (hydration warns and reads the
    // available tail) must not read zero-filled bytes as a line.
    const stat = await fs.stat(logPath);
    buffer = await readFileRange(logPath, 0, Math.min(endByte, stat.size));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { messages: [], rawLines: [] };
    }
    throw error;
  }
  return messagesLogEntriesFromBuffer(buffer, endByte);
}

/**
 * `readMessagesLogEntries` over bytes already in memory — an ARCHIVED log's verified
 * logical bytes (plain or `.zst`, brick 1861b06d). Same parsing, same positions.
 */
export function messagesLogEntriesFromBuffer(
  log: Buffer,
  endByte: number,
): { messages: SessionMessage[]; rawLines: string[] } {
  const buffer = log.subarray(0, Math.min(endByte, log.length));
  const messages: SessionMessage[] = [];
  const rawLines: string[] = [];
  for (const line of splitBufferLines(buffer)) {
    if (line.length === 0) {
      continue;
    }
    const message = parseMessageLine(line);
    if (!message) {
      warn("ignoring malformed messages log line");
      continue;
    }
    messages.push(message);
    rawLines.push(line.toString("utf8"));
  }
  return { messages, rawLines };
}

/** The last `maxMessages` parseable entries of `log[0, endByte)` — the in-memory twin of `readMessagesLogTail`. */
function messagesLogTailFromBuffer(
  log: Buffer,
  endByte: number,
  maxMessages: number,
): SessionMessage[] {
  if (maxMessages <= 0 || endByte <= 0) {
    return [];
  }
  const lines = splitBufferLines(log.subarray(0, Math.min(endByte, log.length)));
  const fromTail: SessionMessage[] = [];
  for (let index = lines.length - 1; index >= 0 && fromTail.length < maxMessages; index -= 1) {
    if (lines[index].length === 0) {
      continue;
    }
    const message = parseMessageLine(lines[index]);
    if (message) {
      fromTail.push(message);
    } else {
      warn("ignoring malformed messages log line");
    }
  }
  return fromTail.toReversed();
}

type MessagesLogReader = {
  size: number;
  range(start: number, end: number): Promise<Buffer>;
  tail(endByte: number, maxMessages: number): Promise<SessionMessage[]>;
};

async function hydrateFromLogReader(
  record: SessionRecord,
  logState: SessionMessagesLogState,
  reader: MessagesLogReader,
): Promise<SessionRecord> {
  let inlineMessages = record.messages;
  let effectiveBytes = Math.min(logState.bytes, reader.size);
  let effectiveCount = logState.count;

  if (logState.bytes > reader.size) {
    warn(`messages log shorter than watermark for ${record.acpxRecordId}; using available tail`);
  } else if (reader.size > logState.bytes) {
    const delta = await reader.range(logState.bytes, reader.size);
    const completeDelta = parseCompleteMessageLines(delta);
    if (completeDelta.messages.length > 0) {
      inlineMessages = inlineMessages.slice(
        Math.min(completeDelta.messages.length, inlineMessages.length),
      );
      effectiveCount += completeDelta.messages.length;
      effectiveBytes = logState.bytes + completeDelta.bytes;
      record.messagesLog = {
        ...logState,
        count: effectiveCount,
        bytes: effectiveBytes,
      };
    }
  }

  const neededFromLog = Math.max(0, MAX_RUNTIME_MESSAGES - inlineMessages.length);
  const logTailLimit = Math.min(neededFromLog, effectiveCount);
  const logTail = await reader.tail(effectiveBytes, logTailLimit);
  record.messages = [...logTail, ...inlineMessages];
  setLoggedMessageCount(record, logTail.length);
  // C3.5 (i): the inline entries came from disk, so they are their publisher's, not this copy's.
  markLoadedInlineEntries(inlineMessages);
  return record;
}

export async function hydrateSessionMessagesFromLog(
  record: SessionRecord,
  logPath: string,
): Promise<SessionRecord> {
  const logState = record.messagesLog;
  if (!logState) {
    setLoggedMessageCount(record, 0);
    return record;
  }

  let stat;
  try {
    stat = await fs.stat(logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      warn(`messages log missing for ${record.acpxRecordId}; using inline messages only`);
      setLoggedMessageCount(record, 0);
      return record;
    }
    throw error;
  }
  return await hydrateFromLogReader(record, logState, {
    size: stat.size,
    range: async (start, end) => await readFileRange(logPath, start, end),
    tail: async (endByte, maxMessages) => await readMessagesLogTail(logPath, endByte, maxMessages),
  });
}

/**
 * Hydrate an ARCHIVED record from its log's VERIFIED logical bytes (brick 1861b06d,
 * reader A1). `undefined` = the log is genuinely absent in both forms — today's
 * "missing" warning path. A CORRUPT log never reaches here: the caller's verified read
 * throws `ArchivedFileCorrupt` first, so corruption can never read as empty history.
 */
export async function hydrateSessionMessagesFromBuffer(
  record: SessionRecord,
  log: Buffer | undefined,
): Promise<SessionRecord> {
  const logState = record.messagesLog;
  if (!logState) {
    setLoggedMessageCount(record, 0);
    return record;
  }
  if (!log) {
    warn(`messages log missing for ${record.acpxRecordId}; using inline messages only`);
    setLoggedMessageCount(record, 0);
    return record;
  }
  return await hydrateFromLogReader(record, logState, {
    size: log.length,
    range: async (start, end) => log.subarray(start, end),
    tail: async (endByte, maxMessages) => messagesLogTailFromBuffer(log, endByte, maxMessages),
  });
}

export async function prepareMessagesLogForBoundary(
  record: SessionRecord,
  logPath: string,
): Promise<void> {
  if (!record.messagesLog) {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.rm(messagesLogStalePath(logPath), { force: true });
    await fs
      .rename(logPath, messagesLogStalePath(logPath))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    return;
  }

  try {
    await fs.stat(logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    warn(`messages log missing for ${record.acpxRecordId}; starting a fresh log at next boundary`);
    record.messagesLog = undefined;
    setLoggedMessageCount(record, 0);
  }
}

// A zero-message record never converges to split form on its own: it has
// nothing to append, so `appendFinalizedMessagesToLog` returns at its
// `messages.length === 0` guard without ever setting `messagesLog`, and the
// record is re-serialized in pre-split form on every boundary write, forever.
// (The `markAllMessagesLogged` call in writeMessagesLogBoundary is not what
// sets the pointer — it only moves the logged-count WeakMap, and on an empty
// record it is a no-op — so this is the level the fix has to sit at.)
//
// BOTH halves are required. Writing the pointer alone would not converge, it
// would oscillate: `prepareMessagesLogForBoundary` above self-heals a pointer
// whose log file is missing by warning and clearing it back to undefined, so
// the next boundary write would undo this one and emit a warning per write.
export async function initializeEmptyMessagesLog(
  record: SessionRecord,
  logPath: string,
): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  // Unconditional create-empty is safe here and not a clobber: the only caller
  // reaches this after `prepareMessagesLogForBoundary` has already renamed any
  // pre-existing log aside to `.stale` on exactly this `!messagesLog` branch.
  await fs.writeFile(logPath, "");
  record.messagesLog = { v: 1, count: 0, base_index: 0, bytes: 0 };
  setLoggedMessageCount(record, 0);
}

export async function clearMissingMessagesLogPointerForWrite(
  record: SessionRecord,
  logPath: string,
): Promise<void> {
  if (!record.messagesLog) {
    return;
  }

  try {
    await fs.stat(logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    warn(`messages log missing for ${record.acpxRecordId}; writing inline messages only`);
    record.messagesLog = undefined;
    setLoggedMessageCount(record, 0);
  }
}

export function resolveMessagesLogCompactBytes(): number {
  const raw = process.env.ACPX_MESSAGES_LOG_COMPACT_BYTES ?? process.env.MESSAGES_LOG_COMPACT_BYTES;
  if (!raw) {
    return MESSAGES_LOG_COMPACT_BYTES;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MESSAGES_LOG_COMPACT_BYTES;
}

export type MeasuredAppend = {
  /** The log's pointer as measured under the lock: at a line boundary, past every complete line. */
  state: SessionMessagesLogState;
  /** Complete lines found past the published watermark and adopted into it (a writer that died after its append). */
  adopted: number;
};

const EMPTY_LOG_STATE: SessionMessagesLogState = { v: 1, count: 0, base_index: 0, bytes: 0 };

async function readHandleRange(handle: fs.FileHandle, start: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  let filled = 0;
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, start + filled);
    if (bytesRead === 0) {
      return buffer.subarray(0, filled);
    }
    filled += bytesRead;
  }
  return buffer;
}

/** The nearest line boundary at or before `position`: a pointer never stands inside a line. */
async function lineBoundaryAtOrBefore(handle: fs.FileHandle, position: number): Promise<number> {
  let end = position;
  while (end > 0) {
    const from = Math.max(0, end - TAIL_READ_CHUNK_BYTES);
    const chunk = await readHandleRange(handle, from, end);
    if (end === position && chunk.at(-1) === NEWLINE) {
      return position;
    }
    const lastNewline = chunk.lastIndexOf(NEWLINE);
    if (lastNewline !== -1) {
      return from + lastNewline + 1;
    }
    end = from;
  }
  return 0;
}

/**
 * C3.5 (i): append `messages` at the log's MEASURED end — never at a writer's remembered watermark.
 * The caller holds the record's lock, so this is the only writer. `published` is the pointer on disk.
 *
 * - Complete lines past the published watermark are adopted into the pointer, the way a reader adopts
 *   them (`hydrateFromLogReader`): a writer that died after its append left them.
 * - An incomplete tail (bytes after the last newline) is cut back to that newline. **A complete line
 *   is never cut.** The old truncate to the writer's in-memory watermark was P0 of the c917d9c9 probe:
 *   it erased whatever another writer had appended after this writer read.
 * - The entries go at the measured end by position, so a network mount's cached size never places
 *   them, and the file is closed before the caller releases the lock.
 */
export async function appendAtMeasuredEnd(
  logPath: string,
  published: SessionMessagesLogState | undefined,
  messages: readonly SessionMessage[],
): Promise<MeasuredAppend> {
  const base = published ?? EMPTY_LOG_STATE;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const handle = await fs.open(logPath, fsConstants.O_RDWR | fsConstants.O_CREAT, 0o666);
  try {
    const size = (await handle.stat()).size;
    if (base.bytes > size) {
      warn(`messages log shorter than watermark for ${logPath}; measuring from its own end`);
    }
    // A pointer inside a line (a torn watermark an older build published) is moved back to the line.
    const start = await lineBoundaryAtOrBefore(handle, Math.min(base.bytes, size));
    const past = await readHandleRange(handle, start, size);
    const complete = parseCompleteMessageLines(past);
    const end = start + complete.bytes;
    if (size > end) {
      await handle.truncate(end);
    }
    let written = 0;
    if (messages.length > 0) {
      const payload = Buffer.from(`${messages.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      while (written < payload.length) {
        written += (await handle.write(payload, written, payload.length - written, end + written))
          .bytesWritten;
      }
    }
    const adopted = start >= base.bytes ? complete.messages.length : 0;
    return {
      adopted,
      state: {
        ...base,
        count: base.count + adopted + messages.length,
        bytes: end + written,
      },
    };
  } finally {
    await handle.close();
  }
}

export async function appendFinalizedMessagesToLog(
  record: SessionRecord,
  logPath: string,
  messages: readonly SessionMessage[],
): Promise<SessionMessagesLogState | undefined> {
  if (messages.length === 0) {
    return record.messagesLog;
  }
  record.messagesLog = (await appendAtMeasuredEnd(logPath, record.messagesLog, messages)).state;
  return record.messagesLog;
}

/** The raw lines of the last `maxMessages` parseable entries of `log[0, endByte)`, oldest first. */
async function readMessagesLogTailLines(
  logPath: string,
  endByte: number,
  maxMessages: number,
): Promise<Buffer[]> {
  const handle = await fs.open(logPath, "r");
  try {
    const kept: Buffer[] = [];
    let carry: Buffer = Buffer.alloc(0);
    let position = endByte;
    while (position > 0 && kept.length < maxMessages) {
      const from = Math.max(0, position - TAIL_READ_CHUNK_BYTES);
      const lines = splitBufferLines(
        Buffer.concat([await readHandleRange(handle, from, position), carry]),
      );
      position = from;
      // The first piece may be the end of a line that starts before this chunk: carry it back.
      carry = position > 0 ? (lines.shift() ?? Buffer.alloc(0)) : Buffer.alloc(0);
      keepParseableLinesNewestFirst(lines, kept, maxMessages);
    }
    return kept.toReversed();
  } finally {
    await handle.close();
  }
}

function keepParseableLinesNewestFirst(lines: Buffer[], kept: Buffer[], maxMessages: number): void {
  for (let index = lines.length - 1; index >= 0 && kept.length < maxMessages; index -= 1) {
    if (lines[index].length === 0) {
      continue;
    }
    if (parseMessageLine(lines[index])) {
      kept.push(lines[index]);
    } else {
      warn("ignoring malformed messages log line");
    }
  }
}

/**
 * Compaction above `thresholdBytes`, in the same lock span as the append (C3.5 (i)). It keeps the
 * last entries AS THEY ARE IN THE FILE — the runtime trim's count of complete lines, read from disk —
 * never a rewrite from a writer's memory: an entry another writer appended after this writer read is
 * in the kept tail. `base_index` advances by the lines dropped.
 */
export async function compactMessagesLog(
  record: SessionRecord,
  logPath: string,
  thresholdBytes = MESSAGES_LOG_COMPACT_BYTES,
): Promise<boolean> {
  let stat;
  try {
    stat = await fs.stat(logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  if (stat.size <= thresholdBytes) {
    return false;
  }

  const previous = record.messagesLog ?? EMPTY_LOG_STATE;
  const kept = await readMessagesLogTailLines(logPath, previous.bytes, MAX_RUNTIME_MESSAGES);
  const newline = Buffer.from("\n");
  const payload = Buffer.concat(kept.flatMap((line) => [line, newline]));
  // Unique per call, not per millisecond — same collision as the record write
  // in persistence/repository.ts, and on the SAME call path (writeSessionRecord
  // calls this immediately before writing the record), so fixing only one of
  // the two would leave the reproducer alive.
  const tempFile = `${logPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tempFile, payload);
  await fs.rename(tempFile, logPath);

  const dropped = Math.max(0, previous.count - kept.length);
  record.messagesLog = {
    v: 1,
    count: kept.length,
    base_index: previous.base_index + dropped,
    bytes: payload.length,
  };
  return true;
}
