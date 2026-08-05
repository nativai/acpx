import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  SessionAgentContent,
  SessionConversation,
  SessionMessage,
  SessionMessagesLogState,
  SessionRecord,
  SessionToolResultContent,
  SessionUserContent,
} from "../types.js";
import { trimConversationForRuntime } from "./conversation-model.js";
import { markAllMessagesLogged, setLoggedMessageCount } from "./messages-log-bookkeeping.js";

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
      isOptionalString(user.claudeUuid) &&
      Array.isArray(user.content) &&
      user.content.every((entry) => isUserContent(entry))
    );
  }

  if (record.Agent !== undefined) {
    const agent = isRecord(record.Agent) ? record.Agent : undefined;
    if (
      !agent ||
      !isOptionalString(agent.claudeUuid) ||
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

  let inlineMessages = record.messages;
  let effectiveBytes = Math.min(logState.bytes, stat.size);
  let effectiveCount = logState.count;

  if (logState.bytes > stat.size) {
    warn(`messages log shorter than watermark for ${record.acpxRecordId}; using available tail`);
  } else if (stat.size > logState.bytes) {
    const delta = await readFileRange(logPath, logState.bytes, stat.size);
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
  const logTail = await readMessagesLogTail(logPath, effectiveBytes, logTailLimit);
  record.messages = [...logTail, ...inlineMessages];
  setLoggedMessageCount(record, logTail.length);
  return record;
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

export async function appendFinalizedMessagesToLog(
  record: SessionRecord,
  logPath: string,
  messages: readonly SessionMessage[],
): Promise<SessionMessagesLogState | undefined> {
  if (messages.length === 0) {
    return record.messagesLog;
  }

  const current = record.messagesLog ?? {
    v: 1,
    count: 0,
    base_index: 0,
    bytes: 0,
  };
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.truncate(logPath, current.bytes).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });

  const payload = Buffer.from(`${messages.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const handle = await fs.open(logPath, "a");
  try {
    await handle.write(payload, 0, payload.length);
  } finally {
    await handle.close();
  }

  record.messagesLog = {
    ...current,
    count: current.count + messages.length,
    bytes: current.bytes + payload.length,
  };
  return record.messagesLog;
}

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

  const previous = record.messagesLog ?? {
    v: 1,
    count: 0,
    base_index: 0,
    bytes: 0,
  };
  const conversation: SessionConversation = {
    title: record.title,
    messages: structuredClone(record.messages),
    updated_at: record.updated_at,
    cumulative_token_usage: record.cumulative_token_usage,
    request_token_usage: record.request_token_usage,
  };
  trimConversationForRuntime(conversation);
  const kept = conversation.messages;
  const payload = Buffer.from(
    kept.length === 0 ? "" : `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  // Unique per call, not per millisecond — same collision as the record write
  // in persistence/repository.ts, and on the SAME call path (writeSessionRecord
  // calls this immediately before writing the record), so fixing only one of
  // the two would leave the reproducer alive.
  const tempFile = `${logPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(tempFile, payload);
  await fs.rename(tempFile, logPath);

  const dropped = Math.max(0, previous.count - kept.length);
  record.messages = kept;
  record.messagesLog = {
    v: 1,
    count: kept.length,
    base_index: previous.base_index + dropped,
    bytes: payload.length,
  };
  markAllMessagesLogged(record);
  return true;
}
