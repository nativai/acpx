import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireIdentityFileLock,
  releaseIdentityFileLock,
} from "../persistence/identity-file-lock.js";
import {
  buildArchiveIndexEntry,
  listArchiveIndexShardKeys,
  mutateArchiveIndexShard,
  readArchiveIndexShard,
  withArchiveIndexLock,
  type ArchiveIndexEntry,
} from "./archive-index.js";
import {
  ARCHIVE_ZST_FORMAT,
  assertZstdAvailable,
  commitStagedPlain,
  compressArchivedFile,
  compressibleFamilyOf,
  decodeArchiveZst,
  discardStaged,
  encodeArchiveZst,
  fsyncDir,
  isArchivedFileCorrupt,
  MIN_COMPRESS_BYTES,
  sha256Hex,
  stageDecompressed,
  zstNameFor,
  type CompressOutcome,
  type TranscriptFamily,
} from "./compressed.js";
import {
  CompressionJournalWriter,
  readCompressionJournal,
  serializeJournalRow,
  COMPRESSION_JOURNAL_HEADER,
} from "./compression-journal.js";
import {
  claimArchiveFileSets,
  claimFileSets,
  isHostileFileName,
  recordFileNameFor,
} from "./identity.js";
import { foldArchiveManifest, type ManifestFold } from "./manifest.js";
import { ArchiveRefusal, statFileSet } from "./move.js";
import {
  compressionDir,
  compressionLockPath,
  compressionQuarantineDir,
  compressionRunsDir,
  compressionStagingDir,
} from "./paths.js";
import { encodeSessionSafeId } from "./safe-id.js";

/**
 * `acpx sessions archive --compress` / `--decompress` (CONCEPTION §3.5, §3.6, §3.13).
 *
 * ⚠️ WHAT THIS MODULE EVER UNLINKS (Daniel's no-deletion rule, CONCEPTION §7): a plain
 * only after its verified `.zst` exists (compression); a `.zst` only after its verified
 * plain exists (decompression / both-forms resolution); its own staging temps. It never
 * deletes the last copy of anything, and `COMPRESSION/quarantine/` is never deleted by
 * any code.
 */

const GIB = 1024 ** 3;
const STAGING_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const LOCK_WAIT_MS = 1000;
const ESTIMATE_SAMPLE_BYTES = 200 * 1024 * 1024;

export type SweepContext = {
  hotDir: string;
  archiveDir: string;
  at: string;
  wave: string;
};

export type FamilyTotals = Record<TranscriptFamily, { files: number; logicalBytes: number }>;

export type CompressCandidate = {
  file: string;
  safeId: string;
  family: TranscriptFamily;
  logicalBytes: number;
  mtimeMs: number;
};

export type CompressSelection = {
  candidates: CompressCandidate[];
  bothForms: { file: string; safeId: string }[];
  small: number;
  previouslySkipped: string[];
};

export type SweepOutcome =
  | "applied"
  | "dry-run"
  | "compression-not-initialized"
  | "lock-held"
  | "refused";

export type CompressRunResult = {
  action: "compress";
  format: typeof ARCHIVE_ZST_FORMAT;
  outcome: SweepOutcome;
  applied: boolean;
  initialized: boolean;
  archiveDir: string;
  wave: string;
  at: string;
  eligible: {
    files: number;
    logicalBytes: number;
    byFamily: FamilyTotals;
    largestFile: { file: string; logicalBytes: number } | null;
  };
  selected: number;
  budget: { maxBytes: number | null; limit: number | null; exhausted: boolean };
  compressed: {
    file: string;
    logicalBytes: number;
    logicalSha256: string;
    zstBytes: number;
    zstSha256: string;
  }[];
  skipped: { file: string; reason: "ratio" | "previously-skipped" }[];
  aborted: { file: string; reason: string }[];
  resolved: { file: string; action: "resolve-both" }[];
  quarantined: { file: string; reason: string; check?: string }[];
  conflicts: { file: string; reason: string }[];
  failures: { file: string; error: string; detail?: string }[];
  stagingRemoved: number;
  shardsRewritten: string[];
  bytesBefore: number;
  bytesAfter: number;
  estimate: {
    sampleBytes: number;
    sampleZstBytes: number;
    ratio: number;
    projectedZstBytes: number;
  } | null;
  freeBytes: number | null;
  warnings: string[];
  error?: { code: string; message: string };
};

export type ReaderProbe = () => Promise<{ ok: true } | { ok: false; detail: string }>;

export type CompressSweepOptions = {
  context: SweepContext;
  apply: boolean;
  initialize: boolean;
  maxBytes?: number;
  limit?: number;
  paceMbps?: number;
  skipReaderCheck: boolean;
  manifestOut?: string;
  readerProbe: ReaderProbe;
  runtimeInfoPath: string;
};

function emptyFamilies(): FamilyTotals {
  return {
    stream: { files: 0, logicalBytes: 0 },
    "stream-segment": { files: 0, logicalBytes: 0 },
    messages: { files: 0, logicalBytes: 0 },
    timestamps: { files: 0, logicalBytes: 0 },
  };
}

function emptyResult(
  context: SweepContext,
  options: { maxBytes?: number; limit?: number },
): CompressRunResult {
  return {
    action: "compress",
    format: ARCHIVE_ZST_FORMAT,
    outcome: "refused",
    applied: false,
    initialized: false,
    archiveDir: context.archiveDir,
    wave: context.wave,
    at: context.at,
    eligible: { files: 0, logicalBytes: 0, byFamily: emptyFamilies(), largestFile: null },
    selected: 0,
    budget: { maxBytes: options.maxBytes ?? null, limit: options.limit ?? null, exhausted: false },
    compressed: [],
    skipped: [],
    aborted: [],
    resolved: [],
    quarantined: [],
    conflicts: [],
    failures: [],
    stagingRemoved: 0,
    shardsRewritten: [],
    bytesBefore: 0,
    bytesAfter: 0,
    estimate: null,
    freeBytes: null,
    warnings: [],
  };
}

/** A refusal that still carries the sweep envelope (the scheduler parses stdout). */
export class SweepRefusal extends ArchiveRefusal {
  constructor(
    message: string,
    code: string,
    readonly outcome: SweepOutcome,
  ) {
    super(message, code);
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function freeBytesAt(dir: string): Promise<number> {
  const stat = await fs.statfs(dir);
  return stat.bavail * stat.bsize;
}

function renice(warnings: string[]): void {
  try {
    os.setPriority(19);
  } catch (error) {
    warnings.push(`could not renice to 19 (${(error as Error).message})`);
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// selection
// ────────────────────────────────────────────────────────────────────────────────

/** `skip` rows keyed by file, carrying the size+mtime they were judged at. */
function previouslySkippedKeys(
  rows: Awaited<ReturnType<typeof readCompressionJournal>>,
): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row.action === "skip" && row.logicalBytes != null && row.detail) {
      const mtime = /mtimeMs=(\d+)/.exec(row.detail)?.[1];
      if (mtime) {
        keys.add(`${row.file}\0${row.logicalBytes}\0${mtime}`);
      }
    }
  }
  return keys;
}

/** Ids with ANY file in the hot dir — their archived files are never compressed. */
async function idsPresentInHot(
  hotDir: string,
  archiveIds: ReadonlySet<string>,
): Promise<Set<string>> {
  let hotFiles: string[];
  try {
    hotFiles = await fs.readdir(hotDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Set();
    }
    throw error;
  }
  return new Set(claimFileSets(hotFiles, archiveIds).claimed.keys());
}

/**
 * ⚠️ NEVER A FILE AN INTERRUPTED RESTORE LEFT BEHIND (CONCEPTION §3.5): its last
 * MANIFEST row must be `archive` (or there is none — the pre-manifest era). A file
 * whose last row is `restore` belongs to `--repair`, and compressing it would race the
 * repair that moves it to the hot dir.
 */
function manifestAllows(fold: ManifestFold, file: string): boolean {
  const last = fold.lastByFile.get(file);
  return last == null || last.action === "archive";
}

type ArchiveScan = { fileSets: Map<string, string[]>; hotIds: Set<string>; fold: ManifestFold };

async function scanArchive(context: SweepContext): Promise<ArchiveScan> {
  const fileSets = claimArchiveFileSets(await fs.readdir(context.archiveDir));
  const hotIds = await idsPresentInHot(context.hotDir, new Set(fileSets.keys()));
  const fold = await foldArchiveManifest(context.archiveDir);
  return { fileSets, hotIds, fold };
}

async function classifyFile(
  context: SweepContext,
  safeId: string,
  file: string,
  files: ReadonlySet<string>,
  skips: ReadonlySet<string>,
  selection: CompressSelection,
): Promise<void> {
  const family = compressibleFamilyOf(safeId, file);
  if (family === undefined || isHostileFileName(file)) {
    return;
  }
  if (files.has(zstNameFor(file))) {
    selection.bothForms.push({ file, safeId });
    return;
  }
  const [stat] = await statFileSet(context.archiveDir, [file]);
  if (!stat) {
    return;
  }
  if (stat.bytes < MIN_COMPRESS_BYTES) {
    selection.small += 1;
    return;
  }
  if (skips.has(`${file}\0${stat.bytes}\0${Math.floor(stat.mtimeMs)}`)) {
    selection.previouslySkipped.push(file);
    return;
  }
  selection.candidates.push({
    file,
    safeId,
    family,
    logicalBytes: stat.bytes,
    mtimeMs: stat.mtimeMs,
  });
}

export async function selectCompressible(context: SweepContext): Promise<CompressSelection> {
  const { fileSets, hotIds, fold } = await scanArchive(context);
  const skips = previouslySkippedKeys(await readCompressionJournal(context.archiveDir));
  const selection: CompressSelection = {
    candidates: [],
    bothForms: [],
    small: 0,
    previouslySkipped: [],
  };
  for (const [safeId, files] of fileSets) {
    if (hotIds.has(safeId)) {
      continue;
    }
    const fileSet = new Set(files);
    for (const file of files) {
      if (manifestAllows(fold, file)) {
        await classifyFile(context, safeId, file, fileSet, skips, selection);
      }
    }
  }
  selection.candidates.sort((a, b) => a.file.localeCompare(b.file));
  return selection;
}

function summarizeEligible(
  result: CompressRunResult,
  candidates: readonly CompressCandidate[],
): void {
  const byFamily = emptyFamilies();
  let largest: CompressCandidate | undefined;
  for (const candidate of candidates) {
    byFamily[candidate.family].files += 1;
    byFamily[candidate.family].logicalBytes += candidate.logicalBytes;
    if (!largest || candidate.logicalBytes > largest.logicalBytes) {
      largest = candidate;
    }
  }
  result.eligible = {
    files: candidates.length,
    logicalBytes: candidates.reduce((sum, candidate) => sum + candidate.logicalBytes, 0),
    byFamily,
    largestFile: largest ? { file: largest.file, logicalBytes: largest.logicalBytes } : null,
  };
}

/** Budget: stop BEFORE the file that would exceed `--max-bytes`, or after `--limit` files. */
function applyBudget(
  candidates: readonly CompressCandidate[],
  maxBytes: number | undefined,
  limit: number | undefined,
): { selected: CompressCandidate[]; exhausted: boolean } {
  const selected: CompressCandidate[] = [];
  let used = 0;
  for (const candidate of candidates) {
    if (limit != null && selected.length >= limit) {
      return { selected, exhausted: true };
    }
    if (maxBytes != null && used + candidate.logicalBytes > maxBytes) {
      return { selected, exhausted: true };
    }
    used += candidate.logicalBytes;
    selected.push(candidate);
  }
  return { selected, exhausted: false };
}

/** Size-weighted systematic sample, compressed in memory with the real encoder. */
export function estimateCompression(
  candidates: readonly CompressCandidate[],
  readSample: (candidate: CompressCandidate) => Promise<Buffer | undefined>,
): Promise<CompressRunResult["estimate"]> {
  return (async () => {
    const total = candidates.reduce((sum, candidate) => sum + candidate.logicalBytes, 0);
    if (total === 0) {
      return null;
    }
    const picks = pickSizeWeighted(candidates, total);
    let sampleBytes = 0;
    let sampleZstBytes = 0;
    for (const candidate of picks) {
      const data = await readSample(candidate);
      if (data) {
        sampleBytes += data.length;
        sampleZstBytes += encodeArchiveZst(data).length;
      }
    }
    if (sampleBytes === 0) {
      return null;
    }
    const ratio = sampleZstBytes / sampleBytes;
    return { sampleBytes, sampleZstBytes, ratio, projectedZstBytes: Math.round(total * ratio) };
  })();
}

function pickSizeWeighted(
  candidates: readonly CompressCandidate[],
  total: number,
): CompressCandidate[] {
  if (total <= ESTIMATE_SAMPLE_BYTES) {
    return [...candidates];
  }
  // Points every `step` logical bytes; a file is picked when a point falls inside it.
  const points = Math.max(1, Math.round(ESTIMATE_SAMPLE_BYTES / (total / candidates.length)));
  const step = total / points;
  const picks: CompressCandidate[] = [];
  let cursor = step / 2;
  let offset = 0;
  let pickedBytes = 0;
  for (const candidate of candidates) {
    const end = offset + candidate.logicalBytes;
    if (cursor < end && pickedBytes < ESTIMATE_SAMPLE_BYTES) {
      picks.push(candidate);
      pickedBytes += candidate.logicalBytes;
      while (cursor < end) {
        cursor += step;
      }
    }
    offset = end;
  }
  return picks;
}

// ────────────────────────────────────────────────────────────────────────────────
// pre-flight
// ────────────────────────────────────────────────────────────────────────────────

/**
 * `/data/runtime/info.json` must show `state: "ok"` for acpx and acpx-ui (§3.13).
 * Absent (a rig, a workbench) ⇒ not a refusal; the caller records a warning.
 */
export async function checkRuntimeInfo(
  infoPath: string,
): Promise<{ ok: true; absent: boolean } | { ok: false; detail: string }> {
  let payload: string;
  try {
    payload = await fs.readFile(infoPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, absent: true };
    }
    return {
      ok: false,
      detail: `${infoPath} unreadable (${(error as NodeJS.ErrnoException).code ?? "read-failed"})`,
    };
  }
  let info: Record<string, { state?: unknown } | undefined>;
  try {
    info = JSON.parse(payload) as Record<string, { state?: unknown } | undefined>;
  } catch {
    return { ok: false, detail: `${infoPath} is not JSON` };
  }
  const bad = ["acpx", "acpx-ui"].filter((component) => info[component]?.state !== "ok");
  return bad.length === 0
    ? { ok: true, absent: false }
    : { ok: false, detail: `${bad.join(", ")} not in state "ok" in ${infoPath}` };
}

/**
 * The atrium capability probe (§3.13): `GET <origin>/api/sessions/archived/stats?capability=1`
 * must answer a JSON object with `compression: "zst-v1"`. An HTML body is atrium's SPA
 * catch-all — the route is absent on that build — so it counts as "no capability"; an
 * old atrium ignores `?capability=1` and answers without the field, i.e. also "no".
 *
 * ⚠️ `origin` IS THE BOX-LOCAL ATRIUM (`resolveAtriumLocalOrigin`), NEVER the public
 * mTLS host — from the control pod that one fails in the TLS handshake, and every
 * nightly sweep would refuse. The 30 s budget is for a cold OLD build that still
 * aggregates the whole archive before answering (measured 6–20 s on devbox).
 */
export function createAtriumReaderProbe(origin: string, timeoutMs = 30_000): ReaderProbe {
  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetch(
        `${origin.replace(/\/$/, "")}/api/sessions/archived/stats?capability=1`,
        {
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        return { ok: false, detail: `stats route answered HTTP ${response.status}` };
      }
      const body = (await response.json().catch(() => undefined)) as
        | { compression?: unknown }
        | undefined;
      return body?.compression === "zst-v1"
        ? { ok: true }
        : { ok: false, detail: 'stats route does not advertise compression: "zst-v1"' };
    } catch (error) {
      return { ok: false, detail: `stats route unreachable (${(error as Error).message})` };
    } finally {
      clearTimeout(timer);
    }
  };
}

async function preflightReaders(options: CompressSweepOptions, warnings: string[]): Promise<void> {
  if (options.skipReaderCheck) {
    warnings.push("reader capability check SKIPPED (--skip-reader-check)");
    return;
  }
  const probe = await options.readerProbe();
  if (!probe.ok) {
    throw new SweepRefusal(
      `atrium on this box cannot read .zst archives: ${probe.detail}. Refusing to compress (pass --skip-reader-check to override, logged).`,
      "reader-capability-missing",
      "refused",
    );
  }
  const runtime = await checkRuntimeInfo(options.runtimeInfoPath);
  if (!runtime.ok) {
    throw new SweepRefusal(`runtime not ok: ${runtime.detail}`, "runtime-not-ok", "refused");
  }
  if (runtime.absent) {
    warnings.push(`${options.runtimeInfoPath} absent — runtime state check skipped`);
  }
}

async function preflightBase(context: SweepContext, initialize: boolean): Promise<void> {
  if (!(await directoryExists(context.archiveDir))) {
    throw new SweepRefusal(
      `no archive directory at ${context.archiveDir}`,
      "no-archive",
      "refused",
    );
  }
  assertZstdAvailable();
  if (!initialize && !(await directoryExists(compressionDir(context.archiveDir)))) {
    throw new SweepRefusal(
      `compression is not initialised on this box: ${compressionDir(context.archiveDir)} does not exist. The first compression of a box is an operator run with --initialize; the nightly sweep never initialises.`,
      "compression-not-initialized",
      "compression-not-initialized",
    );
  }
}

async function preflightSpace(archiveDir: string, largest: number): Promise<number> {
  const free = await freeBytesAt(archiveDir);
  const needed = Math.max(GIB, 2 * largest);
  if (free < needed) {
    throw new SweepRefusal(
      `free space ${free} B < ${needed} B (max(1 GiB, 2 × largest selected file))`,
      "insufficient-space",
      "refused",
    );
  }
  return free;
}

// ────────────────────────────────────────────────────────────────────────────────
// lock + directories
// ────────────────────────────────────────────────────────────────────────────────

export async function initializeCompressionDirs(archiveDir: string): Promise<void> {
  await fs.mkdir(compressionStagingDir(archiveDir), { recursive: true });
  await fs.mkdir(compressionQuarantineDir(archiveDir), { recursive: true });
  await fs.mkdir(compressionRunsDir(archiveDir), { recursive: true });
}

/**
 * The sweep-vs-sweep lock (`COMPRESSION/.lock`, the index-lock protocol). Waits at most
 * ~1 s, then refuses with `lock-held` — a second sweep never queues behind a 30-minute
 * one. Readers and restores take no lock (§3.6).
 */
export async function withCompressionLock<T>(archiveDir: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = compressionLockPath(archiveDir);
  const content = await acquireIdentityFileLock(lockPath, {
    label: "compression lock",
    budgetMs: LOCK_WAIT_MS,
    staleMs: 6 * 60 * 60 * 1000,
    legacyBody: () => ({ pid: process.pid, ts: new Date().toISOString() }),
    makeTimeoutError: (lock, holder) =>
      new SweepRefusal(
        `another compression sweep holds ${lock} (${holder})`,
        "lock-held",
        "lock-held",
      ),
  });
  try {
    return await fn();
  } finally {
    await releaseIdentityFileLock(lockPath, content);
  }
}

async function removeStaleStaging(archiveDir: string, nowMs: number): Promise<number> {
  const dir = compressionStagingDir(archiveDir);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const target = path.join(dir, name);
    try {
      const stat = await fs.stat(target);
      if (stat.isFile() && nowMs - stat.mtimeMs > STAGING_TEMP_MAX_AGE_MS) {
        await fs.unlink(target);
        removed += 1;
      }
    } catch {
      // raced with its owner — not ours to report
    }
  }
  return removed;
}

// ────────────────────────────────────────────────────────────────────────────────
// both forms (§3.6) — readers use the plain; the sweep resolves
// ────────────────────────────────────────────────────────────────────────────────

export type BothFormsVerdict =
  | { verdict: "identical" }
  | { verdict: "corrupt"; check: string }
  | { verdict: "differs" };

export async function compareBothForms(
  dir: string,
  logicalName: string,
): Promise<BothFormsVerdict> {
  const zstPath = path.join(dir, zstNameFor(logicalName));
  const [plain, zst] = await Promise.all([
    fs.readFile(path.join(dir, logicalName)),
    fs.readFile(zstPath),
  ]);
  try {
    const decoded = decodeArchiveZst(zst, zstPath);
    return sha256Hex(decoded) === sha256Hex(plain)
      ? { verdict: "identical" }
      : { verdict: "differs" };
  } catch (error) {
    if (isArchivedFileCorrupt(error)) {
      return { verdict: "corrupt", check: error.check };
    }
    throw error;
  }
}

/** Move a `.zst` aside. ⚠️ NEVER DELETED BY ANY CODE — quarantine is permanent. */
export async function quarantineZst(archiveDir: string, logicalName: string): Promise<string> {
  const dir = compressionQuarantineDir(archiveDir);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const target = path.join(dir, `${zstNameFor(logicalName)}.${stamp}.${process.pid}`);
  await fs.rename(path.join(archiveDir, zstNameFor(logicalName)), target);
  return target;
}

async function resolveBothForms(
  context: SweepContext,
  journal: CompressionJournalWriter,
  file: string,
  result: CompressRunResult,
): Promise<boolean> {
  let verdict: BothFormsVerdict;
  try {
    verdict = await compareBothForms(context.archiveDir, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false; // one form moved meanwhile (a restore) — nothing left to resolve
    }
    throw error;
  }
  if (verdict.verdict === "identical") {
    // Finishing an interrupted commit: the verified .zst already holds these bytes.
    await fs.unlink(path.join(context.archiveDir, file)).catch(() => undefined);
    await fsyncDir(context.archiveDir);
    await journal.append({
      action: "resolve-both",
      file,
      verified: true,
      detail: "identical; plain unlinked",
    });
    result.resolved.push({ file, action: "resolve-both" });
    return true;
  }
  const target = await quarantineZst(context.archiveDir, file);
  const detail =
    verdict.verdict === "corrupt"
      ? `corrupt (${verdict.check})`
      : "conflict: .zst differs from plain";
  await journal.append({
    action: "quarantine",
    file,
    verified: false,
    detail: `${detail}; plain kept; -> ${path.basename(target)}`,
  });
  if (verdict.verdict === "corrupt") {
    result.quarantined.push({ file, reason: "zst-corrupt-plain-kept", check: verdict.check });
  } else {
    result.conflicts.push({ file, reason: "zst-differs-from-plain" });
  }
  return true;
}

// ────────────────────────────────────────────────────────────────────────────────
// the compression run
// ────────────────────────────────────────────────────────────────────────────────

async function stillEligible(
  context: SweepContext,
  candidate: CompressCandidate,
): Promise<boolean> {
  for (const name of [recordFileNameFor(candidate.safeId), candidate.file]) {
    try {
      await fs.access(path.join(context.hotDir, name));
      return false;
    } catch {
      // absent from the hot dir — the happy path
    }
  }
  return true;
}

function withDetail(head: string, detail: string | undefined): string {
  return detail ? `${head}: ${detail}` : head;
}

type OutcomeOf<S extends CompressOutcome["status"]> = Extract<CompressOutcome, { status: S }>;

async function journalCompressed(
  journal: CompressionJournalWriter,
  file: string,
  outcome: OutcomeOf<"compressed">,
  result: CompressRunResult,
): Promise<void> {
  const row = {
    file,
    logicalBytes: outcome.logicalBytes,
    logicalSha256: outcome.logicalSha256,
    zstBytes: outcome.zstBytes,
    zstSha256: outcome.zstSha256,
  };
  await journal.append({ action: "compress", ...row, verified: true });
  result.compressed.push(row);
  result.bytesBefore += outcome.logicalBytes;
  result.bytesAfter += outcome.zstBytes;
}

async function journalSkipped(
  journal: CompressionJournalWriter,
  file: string,
  outcome: OutcomeOf<"skipped">,
  result: CompressRunResult,
): Promise<void> {
  // `small` is counted at selection, not journalled; `ratio` is journalled with the
  // size+mtime it was judged at, so it is never re-tried while the file is unchanged.
  if (outcome.reason !== "ratio") {
    return;
  }
  const detail = `ratio mtimeMs=${Math.floor(outcome.mtimeMs)}`;
  await journal.append({ action: "skip", file, logicalBytes: outcome.logicalBytes, detail });
  result.skipped.push({ file, reason: "ratio" });
}

async function journalAborted(
  journal: CompressionJournalWriter,
  file: string,
  outcome: OutcomeOf<"aborted">,
  result: CompressRunResult,
): Promise<void> {
  await journal.append({
    action: "abort",
    file,
    detail: withDetail(outcome.reason, outcome.detail),
  });
  result.aborted.push({ file, reason: "changed-during-compress" });
}

async function journalFailed(
  journal: CompressionJournalWriter,
  file: string,
  outcome: OutcomeOf<"failed">,
  result: CompressRunResult,
): Promise<void> {
  await journal.append({
    action: "fail",
    file,
    logicalBytes: outcome.logicalBytes,
    logicalSha256: outcome.logicalSha256,
    verified: false,
    detail: withDetail(outcome.error, outcome.detail),
  });
  result.failures.push({ file, error: outcome.error, detail: outcome.detail });
}

async function journalOutcome(
  journal: CompressionJournalWriter,
  candidate: CompressCandidate,
  outcome: CompressOutcome,
  result: CompressRunResult,
): Promise<void> {
  const file = candidate.file;
  if (outcome.status === "compressed") {
    await journalCompressed(journal, file, outcome, result);
  } else if (outcome.status === "skipped") {
    await journalSkipped(journal, file, outcome, result);
  } else if (outcome.status === "aborted") {
    await journalAborted(journal, file, outcome, result);
  } else if (outcome.status === "failed") {
    await journalFailed(journal, file, outcome, result);
  }
  // `both-forms` is journalled by `resolveBothForms`.
}

async function pace(
  startedMs: number,
  bytesDone: number,
  paceMbps: number | undefined,
): Promise<void> {
  if (!paceMbps || paceMbps <= 0) {
    return;
  }
  const dueMs = (bytesDone / (paceMbps * 1024 * 1024)) * 1000;
  const waitMs = dueMs - (Date.now() - startedMs);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function compressSelected(
  context: SweepContext,
  journal: CompressionJournalWriter,
  selected: readonly CompressCandidate[],
  options: CompressSweepOptions,
  result: CompressRunResult,
  touchedIds: Set<string>,
): Promise<void> {
  const startedMs = Date.now();
  let bytesDone = 0;
  for (const candidate of selected) {
    if (!(await stillEligible(context, candidate))) {
      await journal.append({
        action: "abort",
        file: candidate.file,
        detail: "no-longer-eligible: the id has a file in the hot dir",
      });
      result.aborted.push({ file: candidate.file, reason: "no-longer-eligible" });
      continue;
    }
    const outcome = await compressArchivedFile({
      dir: context.archiveDir,
      logicalName: candidate.file,
      stagingDir: compressionStagingDir(context.archiveDir),
      journal: {
        begin: async (file, logicalBytes, logicalSha256) =>
          await journal.append({ action: "begin", file, logicalBytes, logicalSha256 }),
      },
    });
    if (outcome.status === "both-forms") {
      await resolveBothForms(context, journal, candidate.file, result);
    }
    await journalOutcome(journal, candidate, outcome, result);
    if (outcome.status === "compressed" || outcome.status === "both-forms") {
      touchedIds.add(candidate.safeId);
    }
    if (outcome.status === "failed" && outcome.error === "ENOSPC") {
      result.warnings.push("disk full — the run stopped; every plain is untouched");
      return;
    }
    bytesDone += candidate.logicalBytes;
    await pace(startedMs, bytesDone, options.paceMbps);
  }
}

export async function runCompressSweep(options: CompressSweepOptions): Promise<CompressRunResult> {
  const { context } = options;
  const result = emptyResult(context, options);
  renice(result.warnings);
  try {
    if (!options.apply) {
      return await compressDryRun(options, result);
    }
    await preflightBase(context, options.initialize);
    await preflightReaders(options, result.warnings);
    const preview = await selectCompressible(context);
    const budgeted = applyBudget(preview.candidates, options.maxBytes, options.limit);
    const largest = budgeted.selected.reduce((max, c) => Math.max(max, c.logicalBytes), 0);
    result.freeBytes = await preflightSpace(context.archiveDir, largest);
    // Every refusal is behind us: only now may `--initialize` create COMPRESSION/
    // (which arms the nightly sweep on this box), so a refused run writes nothing.
    result.initialized = !(await directoryExists(compressionDir(context.archiveDir)));
    await initializeCompressionDirs(context.archiveDir);
    await withCompressionLock(
      context.archiveDir,
      async () => await compressUnderLock(options, result),
    );
    return result;
  } catch (error) {
    const refusal = asSweepRefusal(error);
    if (refusal) {
      return refusedResult(result, refusal);
    }
    throw error;
  }
}

function refusedResult(result: CompressRunResult, refusal: SweepRefusal): CompressRunResult {
  result.outcome = refusal.outcome;
  result.applied = false;
  result.error = { code: refusal.code, message: refusal.message };
  return result;
}

async function compressUnderLock(
  options: CompressSweepOptions,
  result: CompressRunResult,
): Promise<void> {
  const { context } = options;
  result.stagingRemoved = await removeStaleStaging(context.archiveDir, Date.now());
  const selection = await selectCompressible(context);
  summarizeEligible(result, selection.candidates);
  const budgeted = applyBudget(selection.candidates, options.maxBytes, options.limit);
  result.selected = budgeted.selected.length;
  result.budget.exhausted = budgeted.exhausted;
  for (const file of selection.previouslySkipped) {
    result.skipped.push({ file, reason: "previously-skipped" });
  }
  const touchedIds = new Set<string>();
  const journal = await CompressionJournalWriter.open(context.archiveDir, context.at, context.wave);
  try {
    for (const both of selection.bothForms) {
      if (await resolveBothForms(context, journal, both.file, result)) {
        touchedIds.add(both.safeId);
      }
    }
    await compressSelected(context, journal, budgeted.selected, options, result, touchedIds);
  } finally {
    await journal.close();
  }
  result.shardsRewritten = await rewriteShardBytes(context, touchedIds, result.warnings);
  await rewriteArchiveReadme(context.archiveDir, result.warnings);
  result.applied = true;
  result.outcome = "applied";
  await writeRunRecord(context, result);
  if (options.manifestOut) {
    await writeManifestOut(context, options.manifestOut);
  }
}

async function compressDryRun(
  options: CompressSweepOptions,
  result: CompressRunResult,
): Promise<CompressRunResult> {
  const { context } = options;
  if (!(await directoryExists(context.archiveDir))) {
    throw new SweepRefusal(
      `no archive directory at ${context.archiveDir}`,
      "no-archive",
      "refused",
    );
  }
  assertZstdAvailable();
  const selection = await selectCompressible(context);
  summarizeEligible(result, selection.candidates);
  const budgeted = applyBudget(selection.candidates, options.maxBytes, options.limit);
  result.selected = budgeted.selected.length;
  result.budget.exhausted = budgeted.exhausted;
  for (const file of selection.previouslySkipped) {
    result.skipped.push({ file, reason: "previously-skipped" });
  }
  result.freeBytes = await freeBytesAt(context.archiveDir);
  result.estimate = await estimateCompression(selection.candidates, async (candidate) => {
    try {
      return await fs.readFile(path.join(context.archiveDir, candidate.file));
    } catch {
      return undefined;
    }
  });
  if (!(await directoryExists(compressionDir(context.archiveDir)))) {
    result.warnings.push(
      "compression is not initialised on this box: an --apply needs --initialize (operator run)",
    );
  }
  result.outcome = "dry-run";
  return result;
}

// ────────────────────────────────────────────────────────────────────────────────
// shard bytes, README, run record, manifest-out
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Amendment §E: a shard's `bytes` is ON-DISK bytes, so a sweep rewrites `bytes` of
 * every id it touched — otherwise a rebuild (on-disk) and the live shard (plain sizes
 * written by the wave) disagree and 428f8588's AC-11 breaks.
 */
export async function rewriteShardBytes(
  context: SweepContext,
  touchedSafeIds: ReadonlySet<string>,
  warnings: string[],
): Promise<string[]> {
  if (touchedSafeIds.size === 0) {
    return [];
  }
  const fileSets = claimArchiveFileSets(await fs.readdir(context.archiveDir));
  const rewritten: string[] = [];
  await withArchiveIndexLock(context.archiveDir, async () => {
    for (const shardKey of await listArchiveIndexShardKeys(context.archiveDir)) {
      const read = await readArchiveIndexShard(context.archiveDir, shardKey);
      if (read.status !== "ok") {
        continue;
      }
      const upsert = await updatedEntries(context, read.shard.entries, touchedSafeIds, fileSets);
      if (upsert.length > 0) {
        await mutateArchiveIndexShard(
          context.archiveDir,
          shardKey,
          { upsert },
          context.at,
          (message) => warnings.push(message),
        );
        rewritten.push(shardKey);
      }
    }
  });
  return rewritten;
}

async function updatedEntries(
  context: SweepContext,
  entries: readonly ArchiveIndexEntry[],
  touchedSafeIds: ReadonlySet<string>,
  fileSets: ReadonlyMap<string, string[]>,
): Promise<ArchiveIndexEntry[]> {
  const upsert: ArchiveIndexEntry[] = [];
  for (const entry of entries) {
    const safeId = encodeSessionSafeId(entry.id);
    if (!touchedSafeIds.has(safeId)) {
      continue;
    }
    const stats = await statFileSet(context.archiveDir, fileSets.get(safeId) ?? []);
    const bytes = stats.reduce((sum, stat) => sum + stat.bytes, 0);
    if (bytes !== entry.bytes) {
      upsert.push(buildArchiveIndexEntry({ ...entry, bytes }));
    }
  }
  return upsert;
}

const ARCHIVE_README = `# ~/.acpx/sessions-archive — the cold tier of acpx sessions

Written by acpx (\`${ARCHIVE_ZST_FORMAT}\`). Do not edit by hand.

- Archived sessions are moved here by \`acpx sessions archive\` (a rename; nothing is deleted).
- Transcript files (\`<id>.stream.ndjson\`, \`<id>.stream.<N>.ndjson\`, \`<id>.messages.ndjson\`,
  \`<id>.timestamps.ndjson\`) may be stored compressed as \`<name>.zst\` (one zstd frame + a 56-byte
  integrity footer). Records (\`<id>.json\`) are never compressed.
- Read one file:      \`acpx sessions archive --cat <name>\`   (verified bytes; never grep a .zst)
- Bring a session back: \`acpx sessions restore <id>\`         (decompresses, verified, mtime kept)
- Check everything:   \`acpx sessions archive --verify --deep\`
- Rollback of compression: \`acpx sessions archive --decompress --all --apply\`
- \`COMPRESSION/\` holds the compression journal, lock, staging and quarantine (never delete quarantine).
- The 2026-09 one-off tool \`session-archive.mjs\` is RETIRED — do not use it: it does not understand .zst.
`;

export async function rewriteArchiveReadme(archiveDir: string, warnings: string[]): Promise<void> {
  const target = path.join(archiveDir, "README.md");
  try {
    const current = await fs.readFile(target, "utf8").catch(() => "");
    if (current === ARCHIVE_README) {
      return;
    }
    const temp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temp, ARCHIVE_README, "utf8");
    await fs.rename(temp, target);
  } catch (error) {
    warnings.push(`README.md not rewritten (${(error as Error).message})`);
  }
}

async function writeRunRecord(
  context: SweepContext,
  result: CompressRunResult | DecompressRunResult,
): Promise<void> {
  const target = path.join(compressionRunsDir(context.archiveDir), `${context.wave}.json`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(result, undefined, 2)}\n`, "utf8");
}

/** `--manifest-out`: this wave's journal rows (names, sizes, hashes — no content). */
async function writeManifestOut(context: SweepContext, target: string): Promise<void> {
  const rows = (await readCompressionJournal(context.archiveDir)).filter(
    (row) => row.wave === context.wave,
  );
  const payload = [COMPRESSION_JOURNAL_HEADER, ...rows.map((row) => serializeJournalRow(row))].join(
    "\n",
  );
  await fs.writeFile(target, `${payload}\n`, "utf8");
}

// ────────────────────────────────────────────────────────────────────────────────
// decompress (rollback primitive)
// ────────────────────────────────────────────────────────────────────────────────

export type DecompressRunResult = {
  action: "decompress";
  format: typeof ARCHIVE_ZST_FORMAT;
  outcome: "applied" | "dry-run" | "lock-held" | "refused";
  applied: boolean;
  archiveDir: string;
  wave: string;
  at: string;
  selected: { files: number; logicalBytes: number };
  decompressed: { file: string; logicalBytes: number; logicalSha256: string }[];
  resolved: { file: string; action: "resolve-both" }[];
  quarantined: { file: string; reason: string; check?: string }[];
  conflicts: { file: string; reason: string }[];
  corrupt: { file: string; check: string }[];
  failures: { file: string; error: string; detail?: string }[];
  shardsRewritten: string[];
  freeBytes: number | null;
  warnings: string[];
  error?: { code: string; message: string };
};

type ZstTarget = { logical: string; safeId: string; logicalBytes: number; hasPlain: boolean };

async function listZstTargets(
  context: SweepContext,
  ids: readonly string[] | "all",
): Promise<ZstTarget[]> {
  const fileSets = claimArchiveFileSets(await fs.readdir(context.archiveDir));
  const wanted = ids === "all" ? undefined : new Set(ids.map((id) => encodeSessionSafeId(id)));
  const targets: ZstTarget[] = [];
  for (const [safeId, files] of fileSets) {
    if (wanted && !wanted.has(safeId)) {
      continue;
    }
    const names = new Set(files);
    for (const file of files) {
      const logical = file.slice(0, -".zst".length);
      if (!file.endsWith(".zst") || compressibleFamilyOf(safeId, logical) === undefined) {
        continue;
      }
      const footerBytes = await zstLogicalBytes(path.join(context.archiveDir, file));
      targets.push({ logical, safeId, logicalBytes: footerBytes, hasPlain: names.has(logical) });
    }
  }
  return targets.toSorted((a, b) => a.logical.localeCompare(b.logical));
}

async function zstLogicalBytes(zstPath: string): Promise<number> {
  const handle = await fs.open(zstPath, "r");
  try {
    const { size } = await handle.stat();
    const tail = Buffer.alloc(Math.min(size, 56));
    await handle.read(tail, 0, tail.length, size - tail.length);
    return tail.length === 56 ? Number(tail.readBigUInt64LE(16)) : 0;
  } finally {
    await handle.close();
  }
}

function emptyDecompressResult(context: SweepContext): DecompressRunResult {
  return {
    action: "decompress",
    format: ARCHIVE_ZST_FORMAT,
    outcome: "refused",
    applied: false,
    archiveDir: context.archiveDir,
    wave: context.wave,
    at: context.at,
    selected: { files: 0, logicalBytes: 0 },
    decompressed: [],
    resolved: [],
    quarantined: [],
    conflicts: [],
    corrupt: [],
    failures: [],
    shardsRewritten: [],
    freeBytes: null,
    warnings: [],
  };
}

/** A refusal-class error as the sweep envelope's outcome + error, or `undefined`. */
function asSweepRefusal(error: unknown): SweepRefusal | undefined {
  if (error instanceof SweepRefusal) {
    return error;
  }
  if (error instanceof ArchiveRefusal) {
    return new SweepRefusal(error.message, error.code, "refused");
  }
  if ((error as { code?: unknown } | undefined)?.code === "zstd-unavailable") {
    return new SweepRefusal((error as Error).message, "zstd-unavailable", "refused");
  }
  return undefined;
}

export async function runDecompressSweep(options: {
  context: SweepContext;
  ids: readonly string[] | "all";
  apply: boolean;
}): Promise<DecompressRunResult> {
  const result = emptyDecompressResult(options.context);
  renice(result.warnings);
  try {
    await decompressSweepBody(options, result);
    return result;
  } catch (error) {
    const refusal = asSweepRefusal(error);
    if (!refusal) {
      throw error;
    }
    result.outcome = refusal.outcome === "lock-held" ? "lock-held" : "refused";
    result.error = { code: refusal.code, message: refusal.message };
    return result;
  }
}

async function decompressSweepBody(
  options: { context: SweepContext; ids: readonly string[] | "all"; apply: boolean },
  result: DecompressRunResult,
): Promise<void> {
  const { context } = options;
  if (!(await directoryExists(context.archiveDir))) {
    throw new SweepRefusal(
      `no archive directory at ${context.archiveDir}`,
      "no-archive",
      "refused",
    );
  }
  assertZstdAvailable();
  const targets = await listZstTargets(context, options.ids);
  const logicalBytes = targets.reduce((sum, target) => sum + target.logicalBytes, 0);
  result.selected = { files: targets.length, logicalBytes };
  const freeBytes = await freeBytesAt(context.archiveDir);
  result.freeBytes = freeBytes;
  if (!options.apply || targets.length === 0) {
    result.applied = options.apply;
    result.outcome = options.apply ? "applied" : "dry-run";
    return;
  }
  const needed = logicalBytes + GIB;
  if (freeBytes < needed) {
    throw new SweepRefusal(
      `free space ${freeBytes} B < ${needed} B (logical bytes to decompress + 1 GiB)`,
      "insufficient-space",
      "refused",
    );
  }
  await initializeCompressionDirs(context.archiveDir);
  await withCompressionLock(
    context.archiveDir,
    async () => await decompressUnderLock(context, targets, result),
  );
}

async function decompressUnderLock(
  context: SweepContext,
  targets: readonly ZstTarget[],
  result: DecompressRunResult,
): Promise<void> {
  const touched = new Set<string>();
  const journal = await CompressionJournalWriter.open(context.archiveDir, context.at, context.wave);
  const asCompress = emptyResult(context, {});
  try {
    for (const target of targets) {
      if (target.hasPlain) {
        await resolveBothForms(context, journal, target.logical, asCompress);
        touched.add(target.safeId);
        continue;
      }
      if (await decompressOne(context, journal, target, result)) {
        touched.add(target.safeId);
      }
    }
  } finally {
    await journal.close();
  }
  result.resolved.push(...asCompress.resolved);
  result.quarantined.push(...asCompress.quarantined);
  result.conflicts.push(...asCompress.conflicts);
  result.shardsRewritten = await rewriteShardBytes(context, touched, result.warnings);
  result.applied = true;
  result.outcome = "applied";
  await writeRunRecord(context, result);
}

async function decompressOne(
  context: SweepContext,
  journal: CompressionJournalWriter,
  target: ZstTarget,
  result: DecompressRunResult,
): Promise<boolean> {
  const zstPath = path.join(context.archiveDir, zstNameFor(target.logical));
  let staged;
  try {
    staged = await stageDecompressed(
      zstPath,
      target.logical,
      compressionStagingDir(context.archiveDir),
    );
  } catch (error) {
    if (isArchivedFileCorrupt(error)) {
      result.corrupt.push({ file: target.logical, check: error.check });
      await journal.append({
        action: "fail",
        file: target.logical,
        verified: false,
        detail: `decompress refused: corrupt (${error.check}); .zst left in place`,
      });
      return false;
    }
    result.failures.push({
      file: target.logical,
      error: (error as NodeJS.ErrnoException).code ?? "read-failed",
      detail: (error as Error).message,
    });
    return false;
  }
  try {
    await commitStagedPlain(staged, path.join(context.archiveDir, target.logical), zstPath);
  } catch (error) {
    await discardStaged(staged);
    result.failures.push({
      file: target.logical,
      error: (error as NodeJS.ErrnoException).code ?? "link-failed",
      detail: (error as Error).message,
    });
    return false;
  }
  await journal.append({
    action: "decompress",
    file: target.logical,
    logicalBytes: staged.logicalBytes,
    logicalSha256: staged.logicalSha256,
    verified: true,
  });
  result.decompressed.push({
    file: target.logical,
    logicalBytes: staged.logicalBytes,
    logicalSha256: staged.logicalSha256,
  });
  return true;
}
