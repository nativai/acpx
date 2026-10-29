import { createHash, randomBytes, type Hash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { getAcpxVersion } from "../version.js";

// The ONLY place acpx removes a Claude transcript file (brick 81433524, CONCEPTION
// §2.2). Two proofs, used by every remover — the port (D1), the queue owner's exit
// (D2) and `acpx transcripts dedup`:
//
//   - `proveRedundantAndUnlink` removes a copy that is a BYTE-PREFIX of a kept copy
//     (the witness). Every byte of it sits at the same offset in the witness.
//   - `reduceToExitTail` (Option T) removes a copy that is a prefix of the witness
//     plus ONE block of Claude Code's own exit metadata. The block is written
//     byte-exactly into a small `<id>.exit-tail-<ISO>.acpx` file first, whose header
//     makes the original rebuildable bit for bit (`acpx transcripts restore`).
//
// Both prove through file descriptors, scan /proc for a writer, re-check that
// nothing moved, and make the witness durable (fdatasync) before the unlink. Any
// doubt keeps the file: every failure below is a `kept` with a reason, never a throw.
//
// ⚠️ NEVER CALL EITHER WITH AN ACTIVE PATH AS THE CANDIDATE. The callers enforce it
// (the port's candidate is its own private sidecar; the owner exit and the verb skip
// the record's active path). A deletion that changes what the session RESUMES from
// loses its context without losing a byte — the 08ac840f failure.

/**
 * The record types Claude Code (2.1.310) appends at exit ("exit re-stamp") and on
 * resume ("resume re-append"); its own loader treats every one as last-wins.
 * CONCEPTION F10. `queue-operation` is NOT here: it is timestamped and can carry a
 * prompt. An unknown future type is not here either, so such a copy is KEPT — the
 * safe direction. Re-check this list when the bundled Claude Code version moves
 * (strings: `reAppendSessionMetadata`, `Hgt`, `relocateSessionTranscript`).
 */
export const EXIT_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "last-prompt",
  "custom-title",
  "ai-title",
  "tag",
  "relocated",
  "agent-name",
  "agent-color",
  "agent-setting",
  "mode",
  "permission-mode",
  "isolation-latch",
  "dev-mods",
  "atis-latch",
  "cost-state",
]);

/** An exit block larger than this is not reduced (measured blocks: 1–2 lines, ≈ 0.6 KiB). */
export const EXIT_BLOCK_MAX_BYTES = 64 * 1024;
const TAIL_CHECK_BYTES = 64 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const O_ACCMODE = 3;
const NEWLINE = 0x0a;

export type ReducedBy = "port" | "owner-exit" | "transcripts-dedup";

export type DedupTraceEvent =
  | { kind: "read"; file: "candidate" | "witness"; bytes: number }
  | { kind: "witness-datasync" }
  | { kind: "tail-file-synced"; path: string }
  | { kind: "unlink"; path: string };

export type DedupHooks = {
  /** Where to scan for writers. Tests point it at a missing dir to prove the fail-closed path. */
  procRoot?: string;
  trace?: (event: DedupTraceEvent) => void;
  /** Test seam: runs after the full compare, immediately before the final re-check. */
  beforeRecheck?: () => Promise<void> | void;
  /** Test seam: runs once the exit-tail file is durable, before the candidate is re-verified. */
  afterTailFileWritten?: () => Promise<void> | void;
};

export type DedupOutcome =
  | { action: "removed"; bytes: number; sha256: string }
  | {
      action: "reduced";
      bytes: number;
      sha256: string;
      prefixBytes: number;
      tailFile: string;
      tailFileBytes: number;
      reusedTailFile: boolean;
    }
  | { action: "kept"; reason: string };

/** Line 1 of an exit-tail file. snake_case: a persisted convention (CONCEPTION §4.3). */
export type ExitTailHeader = {
  acpx_exit_tail: 1;
  session_id: string;
  original_path: string;
  original_size: number;
  original_mtime_ms: number;
  original_sha256: string;
  prefix_bytes: number;
  prefix_sha256: string;
  tail_bytes: number;
  tail_sha256: string;
  witness_path: string;
  witness_size: number;
  reduced_at: string;
  reduced_by: ReducedBy;
  acpx_version: string;
};

type OpenedFile = {
  path: string;
  handle: FileHandle;
  dev: bigint;
  ino: bigint;
  size: number;
  mtimeNs: bigint;
  mtimeMs: number;
};

type OpenedPair = { candidate: OpenedFile; witness: OpenedFile };

const kept = (reason: string): DedupOutcome => ({ action: "kept", reason });

/**
 * Remove `candidatePath` when it is a byte-prefix of `witnessPath` (equal size only
 * with `allowEqual`). CONCEPTION §2.2 steps 1–7.
 */
export async function proveRedundantAndUnlink(
  candidatePath: string,
  witnessPath: string,
  options: { allowEqual: boolean; hooks?: DedupHooks },
): Promise<DedupOutcome> {
  return await withOpenedPair(candidatePath, witnessPath, async (pair) => {
    return await proveOpened(pair, options.allowEqual, options.hooks);
  });
}

/**
 * Option T: remove `candidatePath` when it equals `witness[0..L) + T`, T an exit
 * block, after writing T byte-exactly into an exit-tail file beside it.
 */
export async function reduceToExitTail(
  candidatePath: string,
  witnessPath: string,
  options: { reducedBy: ReducedBy; hooks?: DedupHooks },
): Promise<DedupOutcome> {
  return await withOpenedPair(candidatePath, witnessPath, async (pair) => {
    return await reduceOpened(pair, options.reducedBy, options.hooks);
  });
}

/** The prefix proof, then — for a longer or divergent copy — the exit-tail reduction. */
export async function removeRedundantCopy(
  candidatePath: string,
  witnessPath: string,
  options: { reducedBy: ReducedBy; hooks?: DedupHooks },
): Promise<{ outcome: DedupOutcome; reasons: string[] }> {
  const proved = await proveRedundantAndUnlink(candidatePath, witnessPath, {
    allowEqual: true,
    hooks: options.hooks,
  });
  if (proved.action !== "kept" || !reductionMayApply(proved.reason)) {
    return { outcome: proved, reasons: proved.action === "kept" ? [proved.reason] : [] };
  }
  const reduced = await reduceToExitTail(candidatePath, witnessPath, options);
  const reasons = reduced.action === "kept" ? [proved.reason, reduced.reason] : [];
  return { outcome: reduced, reasons };
}

/** Only a longer or divergent copy can be an exit-tail shape; every other keep is final. */
function reductionMayApply(reason: string): boolean {
  return reason === "longer-than-witness" || reason.startsWith("divergent-");
}

async function withOpenedPair(
  candidatePath: string,
  witnessPath: string,
  run: (pair: OpenedPair) => Promise<DedupOutcome>,
): Promise<DedupOutcome> {
  let pair: OpenedPair | undefined;
  try {
    const opened = await openPair(candidatePath, witnessPath);
    if (typeof opened === "string") {
      return kept(opened);
    }
    pair = opened;
    return await run(pair);
  } catch (error) {
    return kept(`error:${errorCode(error)}`);
  } finally {
    await pair?.candidate.handle.close().catch(() => {});
    await pair?.witness.handle.close().catch(() => {});
  }
}

async function openPair(candidatePath: string, witnessPath: string): Promise<OpenedPair | string> {
  const candidate = await openRegular(candidatePath);
  if (typeof candidate === "string") {
    return candidate === "missing" ? "candidate-missing" : candidate;
  }
  const witness = await openRegular(witnessPath);
  if (typeof witness === "string") {
    await candidate.handle.close();
    return witness === "missing" ? "witness-missing" : witness;
  }
  const mismatch = pairMismatch(candidate, witness);
  if (mismatch) {
    await candidate.handle.close();
    await witness.handle.close();
    return mismatch;
  }
  return { candidate, witness };
}

function pairMismatch(candidate: OpenedFile, witness: OpenedFile): string | undefined {
  if (candidate.dev !== witness.dev) {
    return "different-device";
  }
  // A hard link (or the same path twice) is never its own witness.
  return candidate.ino === witness.ino ? "same-file" : undefined;
}

async function openRegular(filePath: string): Promise<OpenedFile | string> {
  const linkStat = await lstatOrUndefined(filePath);
  if (!linkStat) {
    return "missing";
  }
  if (!linkStat.isFile()) {
    return "not-regular";
  }
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const info = await handle.stat({ bigint: true });
  if (info.dev !== linkStat.dev || info.ino !== linkStat.ino) {
    await handle.close();
    return "path-replaced";
  }
  return {
    path: filePath,
    handle,
    dev: info.dev,
    ino: info.ino,
    size: Number(info.size),
    mtimeNs: info.mtimeNs,
    mtimeMs: Number(info.mtimeNs / 1_000_000n),
  };
}

async function proveOpened(
  pair: OpenedPair,
  allowEqual: boolean,
  hooks: DedupHooks | undefined,
): Promise<DedupOutcome> {
  const { candidate, witness } = pair;
  const sizeReason = prefixSizeReason(candidate.size, witness.size, allowEqual);
  if (sizeReason) {
    return kept(sizeReason);
  }
  const tailLength = Math.min(TAIL_CHECK_BYTES, candidate.size);
  const tailStart = candidate.size - tailLength;
  if ((await firstMismatch(pair, tailStart, candidate.size, undefined, hooks)) >= 0) {
    return kept("divergent-tail");
  }
  const writer = await writerScanReason(candidate, hooks);
  if (writer) {
    return kept(writer);
  }
  const hash = createHash("sha256");
  const mismatch = await firstMismatch(pair, 0, candidate.size, hash, hooks);
  if (mismatch >= 0) {
    return kept(`divergent-at:${mismatch}`);
  }
  const failed = await finalizeRemoval(pair, candidate.size, hooks);
  return failed
    ? kept(failed)
    : { action: "removed", bytes: candidate.size, sha256: hash.digest("hex") };
}

function prefixSizeReason(
  candidateSize: number,
  witnessSize: number,
  allowEqual: boolean,
): string | undefined {
  if (candidateSize > witnessSize) {
    return "longer-than-witness";
  }
  return candidateSize === witnessSize && !allowEqual ? "equal-not-allowed" : undefined;
}

async function reduceOpened(
  pair: OpenedPair,
  reducedBy: ReducedBy,
  hooks: DedupHooks | undefined,
): Promise<DedupOutcome> {
  const located = await locateExitTail(pair, hooks);
  if (typeof located === "string") {
    return kept(located);
  }
  const { prefixBytes, tail } = located;
  const digest = await hashCandidate(pair.candidate, prefixBytes, hooks);
  const header = buildExitTailHeader(pair, prefixBytes, tail, digest, reducedBy);
  let written: { path: string; bytes: number; reused: boolean };
  try {
    written = await writeOrReuseExitTailFile(header, tail, hooks);
    await hooks?.afterTailFileWritten?.();
  } catch (error) {
    // The candidate is untouched; a tail file that did get written still restores to it.
    return kept(`tail-file-failed:${errorCode(error)}`);
  }
  const verify = await verifyReconstruction(pair, prefixBytes, tail, digest.original, hooks);
  if (verify) {
    return kept(verify);
  }
  const failed = await finalizeRemoval(pair, prefixBytes, hooks);
  if (failed) {
    return kept(failed);
  }
  return {
    action: "reduced",
    bytes: pair.candidate.size,
    sha256: digest.original,
    prefixBytes,
    tailFile: written.path,
    tailFileBytes: written.bytes,
    reusedTailFile: written.reused,
  };
}

/**
 * Find L — the last line boundary of the candidate at or before its byte-LCP with
 * the witness — and the tail T = candidate[L..). T must be an exit block.
 */
async function locateExitTail(
  pair: OpenedPair,
  hooks: DedupHooks | undefined,
): Promise<{ prefixBytes: number; tail: Buffer } | string> {
  const early = await exitTailPrecheck(pair, hooks);
  if (early) {
    return early;
  }
  const writer = await writerScanReason(pair.candidate, hooks);
  if (writer) {
    return writer;
  }
  const { candidate, witness } = pair;
  const limit = Math.min(candidate.size, witness.size);
  const mismatch = await firstMismatch(pair, 0, limit, undefined, hooks);
  const lcp = mismatch >= 0 ? mismatch : limit;
  if (lcp >= candidate.size) {
    // A byte-prefix: the prefix proof's case, not a reduction.
    return "tail-not-exit-block:empty";
  }
  const prefixBytes = await lastLineBoundaryAtOrBefore(candidate, lcp);
  if (prefixBytes === undefined) {
    return "tail-not-exit-block:too-big";
  }
  const tail = await readAt(candidate.handle, prefixBytes, candidate.size - prefixBytes);
  const reason = classifyExitBlock(tail);
  return reason ? `tail-not-exit-block:${reason}` : { prefixBytes, tail };
}

/**
 * Cheap rejects before any full read: the last line must itself be an exit-block
 * line (it is always part of T), and the bytes before the last 64 KiB must match
 * the witness (otherwise T would be larger than the cap).
 */
async function exitTailPrecheck(
  pair: OpenedPair,
  hooks: DedupHooks | undefined,
): Promise<string | undefined> {
  const { candidate, witness } = pair;
  if (candidate.size === 0) {
    return "tail-not-exit-block:empty";
  }
  const lastLine = await readLastLine(candidate);
  if (typeof lastLine !== "string") {
    return `tail-not-exit-block:${lastLine.reason}`;
  }
  const lineReason = classifyExitLine(lastLine);
  if (lineReason) {
    return `tail-not-exit-block:${lineReason}`;
  }
  const mustMatchTo = candidate.size - EXIT_BLOCK_MAX_BYTES;
  if (mustMatchTo <= 0) {
    return undefined;
  }
  if (witness.size < mustMatchTo) {
    return "tail-not-exit-block:too-big";
  }
  const from = Math.max(0, mustMatchTo - TAIL_CHECK_BYTES);
  const sample = await firstMismatch(pair, from, mustMatchTo, undefined, hooks);
  return sample >= 0 ? "tail-not-exit-block:too-big" : undefined;
}

async function readLastLine(file: OpenedFile): Promise<string | { reason: string }> {
  const windowLength = Math.min(file.size, EXIT_BLOCK_MAX_BYTES + 1);
  const window = await readAt(file.handle, file.size - windowLength, windowLength);
  if (window.at(-1) !== NEWLINE) {
    return { reason: "partial" };
  }
  const previous = window.lastIndexOf(NEWLINE, -2);
  if (previous < 0 && windowLength < file.size) {
    return { reason: "too-big" };
  }
  return window.subarray(previous + 1, -1).toString("utf8");
}

async function lastLineBoundaryAtOrBefore(
  file: OpenedFile,
  lcp: number,
): Promise<number | undefined> {
  const earliest = Math.max(0, file.size - EXIT_BLOCK_MAX_BYTES);
  if (lcp < earliest) {
    return undefined;
  }
  if (lcp === 0) {
    return 0;
  }
  const from = Math.max(0, earliest - 1);
  const window = await readAt(file.handle, from, lcp - from);
  const index = window.lastIndexOf(NEWLINE);
  if (index >= 0) {
    return from + index + 1;
  }
  return from === 0 ? 0 : undefined;
}

/**
 * Why `block` is NOT an exit block, or `undefined` when it is one: a non-empty run
 * of complete lines, each a JSON object with no `uuid` and no `timestamp`, whose
 * `type` is in `EXIT_BLOCK_TYPES`, at most `EXIT_BLOCK_MAX_BYTES` long.
 */
export function classifyExitBlock(block: Buffer): string | undefined {
  if (block.length === 0) {
    return "empty";
  }
  if (block.length > EXIT_BLOCK_MAX_BYTES) {
    return "too-big";
  }
  if (block.at(-1) !== NEWLINE) {
    return "partial";
  }
  for (const line of block.subarray(0, -1).toString("utf8").split("\n")) {
    const reason = classifyExitLine(line);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

export function classifyExitLine(line: string): string | undefined {
  const parsed = parseJsonObject(line);
  if (!parsed) {
    return "not-json";
  }
  if ("uuid" in parsed) {
    return "uuid";
  }
  if ("timestamp" in parsed) {
    return "timestamp";
  }
  const type = (parsed as { type?: unknown }).type;
  return typeof type === "string" && EXIT_BLOCK_TYPES.has(type) ? undefined : "type";
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function hashCandidate(
  file: OpenedFile,
  prefixBytes: number,
  hooks: DedupHooks | undefined,
): Promise<{ prefix: string; original: string }> {
  const prefix = createHash("sha256");
  const original = createHash("sha256");
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    const chunk = await readAt(file.handle, offset, Math.min(CHUNK_BYTES, file.size - offset));
    hooks?.trace?.({ kind: "read", file: "candidate", bytes: chunk.length });
    original.update(chunk);
    if (offset < prefixBytes) {
      prefix.update(chunk.subarray(0, Math.min(chunk.length, prefixBytes - offset)));
    }
  }
  return { prefix: prefix.digest("hex"), original: original.digest("hex") };
}

function buildExitTailHeader(
  pair: OpenedPair,
  prefixBytes: number,
  tail: Buffer,
  digest: { prefix: string; original: string },
  reducedBy: ReducedBy,
): ExitTailHeader {
  return {
    acpx_exit_tail: 1,
    session_id: sessionIdFromTranscriptName(path.basename(pair.candidate.path)),
    original_path: pair.candidate.path,
    original_size: pair.candidate.size,
    original_mtime_ms: pair.candidate.mtimeMs,
    original_sha256: digest.original,
    prefix_bytes: prefixBytes,
    prefix_sha256: digest.prefix,
    tail_bytes: tail.length,
    tail_sha256: createHash("sha256").update(tail).digest("hex"),
    witness_path: pair.witness.path,
    witness_size: pair.witness.size,
    reduced_at: new Date().toISOString(),
    reduced_by: reducedBy,
    acpx_version: getAcpxVersion(),
  };
}

/** Pass 3: the candidate is still exactly witness[0..L) + T, with the hash in the header. */
async function verifyReconstruction(
  pair: OpenedPair,
  prefixBytes: number,
  tail: Buffer,
  originalSha256: string,
  hooks: DedupHooks | undefined,
): Promise<string | undefined> {
  const size = Number((await pair.candidate.handle.stat({ bigint: true })).size);
  if (size !== prefixBytes + tail.length) {
    return "changed-during-verify";
  }
  const hash = createHash("sha256");
  if ((await firstMismatch(pair, 0, prefixBytes, hash, hooks)) >= 0) {
    return "changed-during-verify";
  }
  const reread = await readAt(pair.candidate.handle, prefixBytes, tail.length);
  hash.update(reread);
  if (!reread.equals(tail) || hash.digest("hex") !== originalSha256) {
    return "changed-during-verify";
  }
  return undefined;
}

/**
 * The common ending of both proofs: the witness is made durable BEFORE the unlink,
 * then everything is re-checked in the last µs before it — the candidate's size and
 * mtime (an append during the verify), the path still naming the inode we proved
 * (a rename onto it), and the witness still at its path and at least as long as the
 * bytes we relied on.
 */
async function finalizeRemoval(
  pair: OpenedPair,
  witnessBytesRelied: number,
  hooks: DedupHooks | undefined,
): Promise<string | undefined> {
  await hooks?.beforeRecheck?.();
  await pair.witness.handle.datasync();
  emit(hooks, { kind: "witness-datasync" });
  const changed = await recheckPair(pair, witnessBytesRelied);
  if (changed) {
    return changed;
  }
  try {
    await fs.unlink(pair.candidate.path);
  } catch (error) {
    return `unlink-failed:${errorCode(error)}`;
  }
  emit(hooks, { kind: "unlink", path: pair.candidate.path });
  return undefined;
}

function emit(hooks: DedupHooks | undefined, event: DedupTraceEvent): void {
  hooks?.trace?.(event);
}

async function recheckPair(
  pair: OpenedPair,
  witnessBytesRelied: number,
): Promise<string | undefined> {
  return (
    (await recheckCandidate(pair.candidate)) ??
    (await recheckWitness(pair.witness, witnessBytesRelied))
  );
}

async function recheckCandidate(candidate: OpenedFile): Promise<string | undefined> {
  const now = await candidate.handle.stat({ bigint: true });
  if (Number(now.size) !== candidate.size || now.mtimeNs !== candidate.mtimeNs) {
    return "changed-during-verify";
  }
  return (await stillAtPath(candidate)) ? undefined : "path-replaced";
}

async function recheckWitness(
  witness: OpenedFile,
  witnessBytesRelied: number,
): Promise<string | undefined> {
  if (!(await stillAtPath(witness))) {
    return "witness-missing";
  }
  const now = await witness.handle.stat({ bigint: true });
  return Number(now.size) < witnessBytesRelied ? "witness-changed" : undefined;
}

async function stillAtPath(file: OpenedFile): Promise<boolean> {
  const atPath = await lstatOrUndefined(file.path);
  return atPath !== undefined && atPath.dev === file.dev && atPath.ino === file.ino;
}

/**
 * First offset in [from, to) where candidate and witness differ, or -1. Reads both
 * through their fds in 1 MiB chunks; feeds the candidate's bytes to `hash`.
 */
async function firstMismatch(
  pair: OpenedPair,
  from: number,
  to: number,
  hash: Hash | undefined,
  hooks: DedupHooks | undefined,
): Promise<number> {
  for (let offset = from; offset < to; offset += CHUNK_BYTES) {
    const length = Math.min(CHUNK_BYTES, to - offset);
    const ours = await readAt(pair.candidate.handle, offset, length);
    const theirs = await readAt(pair.witness.handle, offset, length);
    hooks?.trace?.({ kind: "read", file: "candidate", bytes: ours.length });
    hooks?.trace?.({ kind: "read", file: "witness", bytes: theirs.length });
    hash?.update(ours);
    const differs = firstDifference(ours, theirs, length);
    if (differs >= 0) {
      return offset + differs;
    }
  }
  return -1;
}

function firstDifference(ours: Buffer, theirs: Buffer, length: number): number {
  if (ours.length === length && theirs.length === length && ours.equals(theirs)) {
    return -1;
  }
  const common = Math.min(ours.length, theirs.length);
  for (let index = 0; index < common; index++) {
    if (ours[index] !== theirs[index]) {
      return index;
    }
  }
  return common;
}

export async function readAt(handle: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
    if (bytesRead === 0) {
      break;
    }
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

async function writerScanReason(
  file: OpenedFile,
  hooks: DedupHooks | undefined,
): Promise<string | undefined> {
  const verdict = await writerHoldsOpen(file, hooks?.procRoot);
  if (verdict === "none") {
    return undefined;
  }
  return verdict === "writer" ? "writer-holds-open" : "no-proc";
}

/**
 * Does any process hold `target` open for WRITING? Walks `/proc/<pid>/fd/*`, stats
 * each link and, on a (dev, ino) match, reads the open flags from `fdinfo`. Readers
 * (atrium cost, usage ingest) do not block a removal.
 *
 * `/proc` missing or unreadable → `no-proc` (fail closed). A single pid whose `fd`
 * dir is unreadable is SKIPPED: on devbox those are non-dumpable processes
 * (`sudo`, `sshd`, a `node` started through sudo — 4 of 86 measured 2026-10-29),
 * while every `claude` process, the only writer of these files, is readable
 * (11 of 11). Failing closed on them would disable every removal on the box.
 */
export async function writerHoldsOpen(
  target: { dev: bigint; ino: bigint },
  procRoot = "/proc",
): Promise<"writer" | "none" | "no-proc"> {
  let entries: string[];
  try {
    entries = await fs.readdir(procRoot);
  } catch {
    return "no-proc";
  }
  const pids = entries.filter((name) => /^\d+$/.test(name));
  if (pids.length === 0) {
    return "no-proc";
  }
  for (const pid of pids) {
    if (await processHoldsWriter(path.join(procRoot, pid), target)) {
      return "writer";
    }
  }
  return "none";
}

async function processHoldsWriter(
  pidDir: string,
  target: { dev: bigint; ino: bigint },
): Promise<boolean> {
  let fds: string[];
  try {
    fds = await fs.readdir(path.join(pidDir, "fd"));
  } catch {
    return false;
  }
  for (const fd of fds) {
    const info = await fs.stat(path.join(pidDir, "fd", fd), { bigint: true }).catch(() => null);
    if (info && info.dev === target.dev && info.ino === target.ino) {
      if (await fdIsWriter(path.join(pidDir, "fdinfo", fd))) {
        return true;
      }
    }
  }
  return false;
}

async function fdIsWriter(fdinfoPath: string): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(fdinfoPath, "utf8");
  } catch {
    // The fd closed between the stat and this read: no writer any more.
    return false;
  }
  const match = /^flags:\s*([0-7]+)/m.exec(text);
  if (!match) {
    return true;
  }
  return (Number.parseInt(match[1], 8) & O_ACCMODE) !== fsConstants.O_RDONLY;
}

// ---------------------------------------------------------------------------
// The exit-tail file: `<id>.exit-tail-<UTC ISO, ':'→'-'>[-n].acpx` beside the copy
// it replaces. Line 1 is the JSON header, then T verbatim. It does not end in
// `.jsonl`, so Claude Code's picker, acpx's probes and every acpx-ui reader skip it.
// Never removed automatically.
// ---------------------------------------------------------------------------

export const EXIT_TAIL_SUFFIX = ".acpx";

export function isExitTailFileName(name: string): boolean {
  return /^[^.]+\.exit-tail-.+\.acpx$/.test(name);
}

/** The session id a transcript-family file name belongs to (everything before the first `.`). */
export function sessionIdFromTranscriptName(name: string): string {
  const dot = name.indexOf(".");
  return dot >= 0 ? name.slice(0, dot) : name;
}

async function writeOrReuseExitTailFile(
  header: ExitTailHeader,
  tail: Buffer,
  hooks: DedupHooks | undefined,
): Promise<{ path: string; bytes: number; reused: boolean }> {
  const dir = path.dirname(header.original_path);
  const existing = await findMatchingExitTailFile(dir, header);
  if (existing) {
    return { ...existing, reused: true };
  }
  const body = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, "utf8"), tail]);
  const temp = path.join(
    dir,
    `.${header.session_id}.exit-tail-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    await writeDurably(temp, body);
    const finalPath = await linkNoReplace(temp, dir, header.session_id);
    await syncDirectory(dir);
    hooks?.trace?.({ kind: "tail-file-synced", path: finalPath });
    return { path: finalPath, bytes: body.length, reused: false };
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/**
 * A previous run may have written the tail file and then failed before the unlink
 * (TEST-PLAN A16). Reuse it instead of writing a second one.
 */
async function findMatchingExitTailFile(
  dir: string,
  header: ExitTailHeader,
): Promise<{ path: string; bytes: number } | undefined> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    if (!isExitTailFileName(name) || sessionIdFromTranscriptName(name) !== header.session_id) {
      continue;
    }
    const filePath = path.join(dir, name);
    const other = await readExitTailHeader(filePath).catch(() => undefined);
    if (other && sameReduction(other.header, header)) {
      return { path: filePath, bytes: other.fileBytes };
    }
  }
  return undefined;
}

function sameReduction(a: ExitTailHeader, b: ExitTailHeader): boolean {
  return (
    a.original_sha256 === b.original_sha256 &&
    a.prefix_bytes === b.prefix_bytes &&
    a.prefix_sha256 === b.prefix_sha256 &&
    a.tail_sha256 === b.tail_sha256
  );
}

async function writeDurably(filePath: string, body: Buffer): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function linkNoReplace(temp: string, dir: string, sessionId: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/:/g, "-");
  for (let suffix = 0; ; suffix++) {
    const name = `${sessionId}.exit-tail-${stamp}${suffix === 0 ? "" : `-${suffix}`}${EXIT_TAIL_SUFFIX}`;
    const finalPath = path.join(dir, name);
    try {
      await fs.link(temp, finalPath);
      return finalPath;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
    }
  }
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const HEADER_STRING_KEYS = [
  "session_id",
  "original_path",
  "original_sha256",
  "prefix_sha256",
  "tail_sha256",
  "witness_path",
  "reduced_at",
  "reduced_by",
  "acpx_version",
] as const;
const HEADER_NUMBER_KEYS = [
  "original_size",
  "original_mtime_ms",
  "prefix_bytes",
  "tail_bytes",
  "witness_size",
] as const;

export function parseExitTailHeader(line: string): ExitTailHeader | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.acpx_exit_tail !== 1) {
    return undefined;
  }
  const stringsOk = HEADER_STRING_KEYS.every((key) => typeof record[key] === "string");
  const numbersOk = HEADER_NUMBER_KEYS.every((key) => Number.isFinite(record[key]));
  return stringsOk && numbersOk ? (parsed as ExitTailHeader) : undefined;
}

/** Header + the raw tail bytes of an exit-tail file, the tail checked against its hash. */
export async function readExitTailFile(
  filePath: string,
): Promise<{ header: ExitTailHeader; tail: Buffer }> {
  const body = await fs.readFile(filePath);
  const newline = body.indexOf(NEWLINE);
  const header = newline >= 0 ? parseExitTailHeader(body.subarray(0, newline).toString()) : null;
  if (!header) {
    throw new Error(`${filePath}: not an acpx exit-tail file (header-invalid)`);
  }
  const tail = body.subarray(newline + 1);
  const tailSha = createHash("sha256").update(tail).digest("hex");
  if (tail.length !== header.tail_bytes || tailSha !== header.tail_sha256) {
    throw new Error(`${filePath}: tail bytes do not match the header (tail-hash-mismatch)`);
  }
  return { header, tail };
}

async function readExitTailHeader(
  filePath: string,
): Promise<{ header: ExitTailHeader; fileBytes: number } | undefined> {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const head = await readAt(handle, 0, Math.min(size, 64 * 1024));
    const newline = head.indexOf(NEWLINE);
    const header = newline >= 0 ? parseExitTailHeader(head.subarray(0, newline).toString()) : null;
    return header ? { header, fileBytes: size } : undefined;
  } finally {
    await handle.close();
  }
}

async function lstatOrUndefined(filePath: string) {
  try {
    return await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "unknown";
}
