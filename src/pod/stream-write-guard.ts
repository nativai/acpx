import { createHash } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readQueueOwnerLeaseFile, type LeaseFile } from "../cli/queue/lease-store.js";
import { incrementPerfCounter } from "../perf-metrics.js";
import { safeSessionId, sessionBaseDir, sessionEventActivePath } from "../session/event-log.js";
import { proveDeath } from "./death-proof.js";
import { lockHostPlace, type PodRef } from "./identity.js";
import { localProofScope, localProofScopeSync, type ProofScope } from "./proof-scope.js";

/**
 * A-80 / C10 "One writer" (CONTRACTS-r4; bricks ce139c8a, 766c4dd7): WHILE A SESSION'S POD EXISTS, ONLY
 * PROCESSES IN THAT POD APPEND TO ITS STREAM AND OWNER LOG. Two NFS clients appending one file lose lines
 * (X-NFS: 2000 written, 1598 read back, 25 corrupt, 427 lost), so a control-role host appends to either only
 * after C3.3 has proven the session's pod gone, checked immediately before the write. Otherwise the line goes
 * to the marker sidecar `<id>.markers.ndjson` (C5) and the attempt is logged `pod_foreign_write` and counted.
 *
 *   not a control-role host                    → `here` (an agent pod writes its own files; a rig is a rig)
 *   the session's lease names no pod           → `here` (a home session: one machine, today's behaviour)
 *   the lease names a pod, C3.3 says `gone`    → `here`
 *   the lease names a pod, `exists`/`unknown`  → sidecar
 *   the lease cannot be read                   → sidecar (fail closed)
 *
 * The decision of "does a lease name a pod" is A-67's `localProofScope` (the lease decides, in or out of pod
 * mode) — called, not re-derived. The label lookup of `agent-pod-lookup.ts` is NOT a proof here: it has no node
 * check, and a pod gone from a partitioned (NotReady) node can still be writing.
 *
 * ⚠️ A SYNCHRONOUS CALLER CANNOT ASK THE API SERVER, so it never proves `gone`: on a control-role host a
 * session whose lease names a pod diverts to the sidecar (`no-sync-proof`). The only sync callers are owner exit
 * paths, which in pod mode run in the pod.
 *
 * ⚠️ THE RAW APPEND TO AN OWNER LOG LIVES ONLY HERE (`appendOwnerLogLine`), so a call anywhere else cannot be
 * holding the proof. The stream's raw appends live only in `session/events.ts` behind these verdicts. Both are
 * held by the scans of `test/stream-appender-helper.test.ts` (63.4 / 80.1) and the rows of
 * `test/pod-a80-foreign-write.test.ts`.
 */

export type ForeignWriteWhy = "pod-exists" | "pod-unknown" | "pod-unreadable" | "no-sync-proof";
export type StreamWriteVerdict = { write: "here" } | { write: "sidecar"; why: ForeignWriteWhy };
/** Which of a session's files the diverted line was meant for. */
export type ForeignWriteFile = "stream" | "owner-log";

export const FOREIGN_WRITE_COUNTER = "session.pod_foreign_write";
/** The active stream's content print covers its first bytes up to this many (acpx-ui `PRINT_BYTES`). */
const PRINT_BYTES = 4096;
/** A waiting appender proves again when its last proof is older than this (C3.3 is asked at most this often). */
export const REPROVE_AFTER_MS = 1_000;

const HERE: StreamWriteVerdict = { write: "here" };

function divert(why: ForeignWriteWhy): StreamWriteVerdict {
  return { write: "sidecar", why };
}

/** The pod a lease names, whichever way the lease store could read it. */
function podOfLease(lease: LeaseFile): PodRef | undefined {
  if (lease.kind === "ok") {
    return lease.record.pod;
  }
  return lease.kind === "unparsable" &&
    lease.shape.kind === "schema" &&
    lease.shape.pod.kind === "pod"
    ? lease.shape.pod.pod
    : undefined;
}

function verdictOfScope(scope: ProofScope): StreamWriteVerdict | undefined {
  if (scope.local) {
    return HERE;
  }
  return scope.reason === "session-in-pod" ? undefined : divert("pod-unreadable");
}

/** Where may THIS process write the session's stream and owner log now? Asked immediately before the write. */
export async function streamWriteVerdict(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StreamWriteVerdict> {
  if (lockHostPlace(env) !== "control") {
    return HERE;
  }
  const decided = verdictOfScope(await localProofScope(sessionId, env));
  if (decided) {
    return decided;
  }
  const pod = podOfLease(await readQueueOwnerLeaseFile(sessionId));
  if (!pod) {
    return divert("pod-unreadable"); // the lease changed under us, or has no readable pod: fail closed
  }
  const answer = await proveDeath(pod, { env });
  if (answer === "gone") {
    return HERE;
  }
  return divert(answer === "exists" ? "pod-exists" : "pod-unknown");
}

/** The synchronous twin: `here` only where no lease names a pod; it can never prove a death. */
export function streamWriteVerdictSync(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): StreamWriteVerdict {
  if (lockHostPlace(env) !== "control") {
    return HERE;
  }
  return verdictOfScope(localProofScopeSync(sessionId, env)) ?? divert("no-sync-proof");
}

// ---- the sidecar (C5) ------------------------------------------------------------------------------------

export function markersPath(sessionId: string): string {
  return path.join(sessionBaseDir(), `${safeSessionId(sessionId)}.markers.ndjson`);
}

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

type Position = { offset: number; ino?: number; fp?: string };

/** The position triple of the ACTIVE stream now, measured on ONE fd (acpx-ui `streamPositionNow`). */
function streamPositionNow(sessionId: string): Position {
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

type Marker = Record<string, unknown>;

/** The JSON objects of a stream text (one per line); a line that is no JSON object is kept, wrapped — never dropped. */
function markersOfText(text: string): Marker[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): Marker => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Marker;
        }
      } catch {
        // fall through to the wrapper
      }
      return { jsonrpc: "2.0", method: "acpx/unparsable_line", params: { line } };
    });
}

function ownerLogMarker(line: string): Marker {
  return {
    jsonrpc: "2.0",
    method: "acpx/owner_log",
    params: { line: line.replace(/\n$/, "") },
  };
}

/**
 * Diverts `markers` to the session's sidecar: one line per marker, in order, each `{v,ts,offset,ino,fp,marker}`
 * exactly as atrium's `appendStreamMarker` writes it. One writing machine (the control pod), so lines never
 * interleave. Logs ONE `pod_foreign_write` line and counts one per call. Throws on a failed append: every
 * caller is best-effort, and nothing is ever written into the stream instead.
 */
function appendSidecar(
  sessionId: string,
  markers: Marker[],
  file: ForeignWriteFile,
  why: ForeignWriteWhy,
): void {
  const position = streamPositionNow(sessionId);
  const ts = new Date().toISOString();
  const text = markers
    .map(
      (marker) =>
        `${JSON.stringify({
          v: 1,
          ts,
          offset: position.offset,
          ...(position.ino !== undefined && position.fp !== undefined
            ? { ino: position.ino, fp: position.fp }
            : {}),
          marker,
        })}\n`,
    )
    .join("");
  mkdirSync(sessionBaseDir(), { recursive: true });
  appendFileSync(markersPath(sessionId), text, "utf8");
  incrementPerfCounter(FOREIGN_WRITE_COUNTER);
  process.stderr.write(
    `[acpx] pod_foreign_write session=${sessionId} file=${file} why=${why} lines=${markers.length} ` +
      `sidecar=${markersPath(sessionId)}\n`,
  );
}

/** A stream text (one or more lines) that a control-role host may not write into the pod's stream. */
export function divertStreamText(sessionId: string, text: string, why: ForeignWriteWhy): void {
  appendSidecar(sessionId, markersOfText(text), "stream", why);
}

/** Frames that a control-role host may not write into the pod's stream. */
export function divertStreamMessages(
  sessionId: string,
  messages: readonly object[],
  why: ForeignWriteWhy,
): void {
  appendSidecar(sessionId, messages as Marker[], "stream", why);
}

/** One owner-log line: appended to `logPath` where the proof allows, else diverted to the sidecar. */
export async function appendOwnerLogLine(
  sessionId: string,
  logPath: string,
  line: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const verdict = await streamWriteVerdict(sessionId, env);
  if (verdict.write === "sidecar") {
    appendSidecar(sessionId, [ownerLogMarker(line)], "owner-log", verdict.why);
    return;
  }
  await fs.appendFile(logPath, line);
}
