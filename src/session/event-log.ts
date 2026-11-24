import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEventLog } from "../types.js";

export const DEFAULT_EVENT_SEGMENT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_EVENT_MAX_SEGMENTS = 5;

export function sessionBaseDir(): string {
  return path.join(process.env.ACPX_STATE_HOME || os.homedir(), ".acpx", "sessions");
}

export function safeSessionId(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

export function sessionEventActivePath(sessionId: string): string {
  return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.stream.ndjson`);
}

export function sessionEventSegmentPath(sessionId: string, segment: number): string {
  return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.stream.${segment}.ndjson`);
}

export function sessionEventLockPath(sessionId: string): string {
  return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.stream.lock`);
}

export function defaultSessionEventLog(sessionId: string): SessionEventLog {
  return {
    active_path: sessionEventActivePath(sessionId),
    segment_count: DEFAULT_EVENT_MAX_SEGMENTS,
    max_segment_bytes: DEFAULT_EVENT_SEGMENT_MAX_BYTES,
    max_segments: DEFAULT_EVENT_MAX_SEGMENTS,
    last_write_at: undefined,
    last_write_error: null,
  };
}

/** The active stream's content print covers its first bytes up to this many (acpx-ui `PRINT_BYTES`). */
const PRINT_BYTES = 4096;

/** `<len>:<first 24 hex of sha256>` of the first up-to-4096 bytes of an open file (acpx-ui `printOfFd`). */
function printOfFd(fd: number, size: number): string {
  const wanted = Math.min(PRINT_BYTES, size);
  const buffer = Buffer.alloc(wanted);
  let read = 0;
  while (read < wanted) {
    const got = readSync(fd, buffer, read, wanted - read, read);
    if (got <= 0) {
      break;
    }
    read += got;
  }
  return `${read}:${createHash("sha256").update(buffer.subarray(0, read)).digest("hex").slice(0, 24)}`;
}

export type StreamPosition = { offset: number; ino?: number; fp?: string };

/** The position triple of the ACTIVE stream now, measured on ONE fd (acpx-ui `streamPositionNow`). */
export function streamPositionNow(sessionId: string): StreamPosition {
  let fd: number;
  try {
    fd = openSync(sessionEventActivePath(sessionId), "r");
  } catch {
    return { offset: 0 };
  }
  try {
    const st = fstatSync(fd);
    return st.size === 0
      ? { offset: 0 }
      : { offset: st.size, ino: st.ino, fp: printOfFd(fd, st.size) };
  } finally {
    closeSync(fd);
  }
}
