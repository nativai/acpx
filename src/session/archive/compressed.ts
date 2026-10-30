import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

/**
 * `acpx-archive-zst/v1` — THE ONLY IMPLEMENTATION of the compressed archived-file
 * format (amendment §H, brick 1861b06d). Every reader of the archive goes through
 * this module: acpx's readers in process, atrium through the CLI (`--thaw`,
 * `restore`), agents through `--cat`. There is no second decoder anywhere.
 *
 * ```
 * [ exactly ONE zstd frame of the logical bytes ]
 * [ footer: skippable frame, 56 B: u32le 0x184D2A5E · u32le 48 · "ACPXZST1" · u64le size · sha256 ]
 * ```
 *
 * 🛑 "THE DECODER DID NOT THROW" PROVES NOTHING ON NODE 22, AND EVERY CHECK BELOW
 * EXISTS BECAUSE OF A MEASURED SILENT FAILURE (measurements.md §5): a truncated frame
 * decodes to a PREFIX with no error; empty input decodes to 0 bytes; a skippable frame
 * IN FRONT yields 0 bytes; a SECOND frame is silently ignored. So a read is valid only
 * when (1) the footer is intact, (2) the bytes before it are EXACTLY one well-formed
 * frame — walked by hand, `zstdFrameLength` — and (3) the decoded bytes have the
 * footer's length AND sha256. Removing any one of the three re-opens a measured hole;
 * `test/archive-compressed.test.ts` carries one golden vector per hole.
 */

export const ARCHIVE_ZST_FORMAT = "acpx-archive-zst/v1";
export const ZST_SUFFIX = ".zst";
export const FOOTER_BYTES = 56;
const FOOTER_MAGIC = 0x184d2a5e;
const FOOTER_FRAME_SIZE = 48;
const FOOTER_TAG = "ACPXZST1";
const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const WINDOW_LOG = 27;
const COMPRESSION_LEVEL = 9;

/** Below this a file stays plain (amendment §H.1). */
export const MIN_COMPRESS_BYTES = 4096;
/** The result (incl. footer) must be at most this fraction of the logical size. */
export const MAX_COMPRESSED_RATIO = 0.9;
/** CONCEPTION §3.6 step 1: the largest archived file today is 67.2 MB. */
export const MAX_COMPRESS_INPUT_BYTES = 256 * 1024 * 1024;

export type CorruptCheck = "footer" | "frame" | "size" | "hash";

/**
 * A `.zst` that failed verification. ⚠️ NEVER CAUGHT AS "ABSENT": a corrupt file is
 * a loud error naming the file and the failed check — never empty history, never a
 * plain fallback, never a deletion (amendment §H.3 rule 5).
 */
export class ArchivedFileCorrupt extends Error {
  readonly code = "ARCHIVED_FILE_CORRUPT";
  constructor(
    readonly file: string,
    readonly check: CorruptCheck,
    detail?: string,
  ) {
    super(`ARCHIVED_FILE_CORRUPT ${file} (${check})${detail ? `: ${detail}` : ""}`);
    this.name = "ArchivedFileCorrupt";
  }
}

export function isArchivedFileCorrupt(error: unknown): error is ArchivedFileCorrupt {
  return error instanceof ArchivedFileCorrupt;
}

/** This node has no working zstd — a downgrade. NEVER reported as "file absent". */
export class ZstdUnavailable extends Error {
  readonly code = "zstd-unavailable";
  constructor(detail: string) {
    super(
      `zstd is unavailable in this node (${process.version}): ${detail}. Archived .zst files cannot be read or written by this build; nothing was treated as absent.`,
    );
    this.name = "ZstdUnavailable";
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// families and names
// ────────────────────────────────────────────────────────────────────────────────

export type TranscriptFamily = "stream" | "stream-segment" | "messages" | "timestamps";

/**
 * The four compressible families (amendment §H.1) — and nothing else, by
 * construction: anything this returns `undefined` for MUST stay plain. `<id>.json`
 * is NEVER compressible (record presence is the archived-vs-orphan verdict, the
 * byway sweep's destruction guard and seat residency — amendment §A).
 */
export function compressibleFamilyOf(
  safeId: string,
  logicalName: string,
): TranscriptFamily | undefined {
  if (!logicalName.startsWith(`${safeId}.`)) {
    return undefined;
  }
  const rest = logicalName.slice(safeId.length);
  if (rest === ".stream.ndjson") {
    return "stream";
  }
  if (rest === ".messages.ndjson") {
    return "messages";
  }
  if (rest === ".timestamps.ndjson") {
    return "timestamps";
  }
  return /^\.stream\.[1-9]\d*\.ndjson$/.test(rest) ? "stream-segment" : undefined;
}

/** `x.zst` → `x`; anything else is already a logical name. */
export function logicalNameOf(fileName: string): string {
  return fileName.endsWith(ZST_SUFFIX) ? fileName.slice(0, -ZST_SUFFIX.length) : fileName;
}

export function zstNameFor(logicalName: string): string {
  return `${logicalName}${ZST_SUFFIX}`;
}

/**
 * The logical names of one id's on-disk file set: `.zst` forms of a compressible
 * family map to their logical name, everything else is itself. Both forms present
 * collapse to ONE logical name (plain wins at read time, §H.4).
 */
export function logicalFileSet(safeId: string, onDisk: readonly string[]): string[] {
  const logical = new Set<string>();
  for (const file of onDisk) {
    const candidate = logicalNameOf(file);
    if (file !== candidate && compressibleFamilyOf(safeId, candidate) !== undefined) {
      logical.add(candidate);
    } else {
      logical.add(file);
    }
  }
  return [...logical].toSorted();
}

// ────────────────────────────────────────────────────────────────────────────────
// self-test
// ────────────────────────────────────────────────────────────────────────────────

let selfTestPassed = false;

/**
 * Refuse loudly on a node without a working zstd (CONCEPTION §3.1). Runs once per
 * process, on first use: a round trip through the real encoder and the real verifier.
 */
export function assertZstdAvailable(): void {
  if (selfTestPassed) {
    return;
  }
  if (
    typeof zlib.zstdCompressSync !== "function" ||
    typeof zlib.zstdDecompressSync !== "function"
  ) {
    throw new ZstdUnavailable("zlib.zstdCompressSync/zstdDecompressSync are missing");
  }
  const probe = Buffer.from(`${ARCHIVE_ZST_FORMAT} self-test\n`.repeat(64));
  let decoded: Buffer;
  try {
    decoded = decodeArchiveZst(encodeArchiveZst(probe), "<self-test>");
  } catch (error) {
    throw new ZstdUnavailable(`self-test round trip failed: ${(error as Error).message}`);
  }
  if (!decoded.equals(probe)) {
    throw new ZstdUnavailable("self-test round trip returned different bytes");
  }
  selfTestPassed = true;
}

// ────────────────────────────────────────────────────────────────────────────────
// encode / decode (pure)
// ────────────────────────────────────────────────────────────────────────────────

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function buildFooter(logical: Buffer): Buffer {
  const footer = Buffer.alloc(FOOTER_BYTES);
  footer.writeUInt32LE(FOOTER_MAGIC, 0);
  footer.writeUInt32LE(FOOTER_FRAME_SIZE, 4);
  footer.write(FOOTER_TAG, 8, "ascii");
  footer.writeBigUInt64LE(BigInt(logical.length), 16);
  createHash("sha256").update(logical).digest().copy(footer, 24);
  return footer;
}

/** One frame + footer. One-shot compression ⇒ exactly one frame (verified on read). */
export function encodeArchiveZst(logical: Buffer): Buffer {
  const { constants } = zlib;
  const frame = zlib.zstdCompressSync(logical, {
    params: {
      [constants.ZSTD_c_compressionLevel]: COMPRESSION_LEVEL,
      [constants.ZSTD_c_enableLongDistanceMatching]: 1,
      [constants.ZSTD_c_windowLog]: WINDOW_LOG,
      [constants.ZSTD_c_checksumFlag]: 1,
      [constants.ZSTD_c_contentSizeFlag]: 1,
    },
  });
  return Buffer.concat([frame, buildFooter(logical)]);
}

export type FooterFields = { logicalBytes: number; sha256: string };

/** Check 1: the last 56 bytes are an ACPXZST1 footer. */
export function parseFooter(data: Buffer, file: string): FooterFields {
  if (data.length < FOOTER_BYTES) {
    throw new ArchivedFileCorrupt(
      file,
      "footer",
      `${data.length} bytes is shorter than the ${FOOTER_BYTES}-byte footer`,
    );
  }
  const footer = data.subarray(data.length - FOOTER_BYTES);
  if (
    footer.readUInt32LE(0) !== FOOTER_MAGIC ||
    footer.readUInt32LE(4) !== FOOTER_FRAME_SIZE ||
    footer.toString("ascii", 8, 16) !== FOOTER_TAG
  ) {
    throw new ArchivedFileCorrupt(file, "footer", "no ACPXZST1 footer in the last 56 bytes");
  }
  const size = footer.readBigUInt64LE(16);
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchivedFileCorrupt(file, "footer", "logical size out of range");
  }
  return { logicalBytes: Number(size), sha256: footer.subarray(24, 56).toString("hex") };
}

const FCS_FIELD_BYTES = [0, 2, 4, 8] as const;
const DID_FIELD_BYTES = [0, 1, 2, 4] as const;

/**
 * Check 2: the byte length of the zstd frame starting at offset 0, walked from its
 * header and block headers (RFC 8878 §3.1.1). `undefined` when the bytes are not a
 * well-formed frame or run past the end.
 *
 * ⚠️ DO NOT REPLACE THIS WITH "DECODE AND SEE IF IT THREW". node decodes a frame
 * followed by a second frame to the FIRST frame's bytes, and a skippable frame in
 * front to ZERO bytes, both without an error; only an explicit structural walk can
 * tell "exactly one frame" from "a frame plus something".
 */
export function zstdFrameLength(data: Buffer): number | undefined {
  const header = frameHeader(data);
  if (!header) {
    return undefined;
  }
  const end = walkBlocks(data, header.length);
  if (end === undefined) {
    return undefined;
  }
  const total = end + (header.checksum ? 4 : 0);
  return total <= data.length ? total : undefined;
}

/** Magic + frame header descriptor (+ window, dictionary id, content size fields). */
function frameHeader(data: Buffer): { length: number; checksum: boolean } | undefined {
  if (data.length < 6 || data.readUInt32LE(0) !== ZSTD_FRAME_MAGIC) {
    return undefined;
  }
  const descriptor = data[4];
  if ((descriptor >> 3) & 1) {
    return undefined; // reserved bit
  }
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const fcsBytes = fcsFlag === 0 ? singleSegment : FCS_FIELD_BYTES[fcsFlag];
  const windowBytes = 1 - singleSegment;
  return {
    length: 5 + windowBytes + DID_FIELD_BYTES[descriptor & 3] + fcsBytes,
    checksum: ((descriptor >> 2) & 1) === 1,
  };
}

/** Walk 3-byte block headers to the end of the LAST block; `undefined` past EOF / reserved type. */
function walkBlocks(data: Buffer, start: number): number | undefined {
  let offset = start;
  for (;;) {
    if (offset + 3 > data.length) {
      return undefined;
    }
    const header = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
    const type = (header >> 1) & 3;
    if (type === 3) {
      return undefined;
    }
    // RLE blocks carry ONE byte whatever their (regenerated) size says.
    offset += 3 + (type === 1 ? 1 : header >>> 3);
    if (offset > data.length) {
      return undefined;
    }
    if (header & 1) {
      return offset;
    }
  }
}

/** The full verified read of a `.zst` file's bytes (amendment §H.3). */
export function decodeArchiveZst(data: Buffer, file: string): Buffer {
  const footer = parseFooter(data, file);
  const frameRegion = data.subarray(0, data.length - FOOTER_BYTES);
  if (zstdFrameLength(frameRegion) !== frameRegion.length) {
    throw new ArchivedFileCorrupt(
      file,
      "frame",
      "the bytes before the footer are not exactly one zstd frame",
    );
  }
  let decoded: Buffer;
  try {
    decoded = zlib.zstdDecompressSync(frameRegion, {
      params: { [zlib.constants.ZSTD_d_windowLogMax]: WINDOW_LOG },
      maxOutputLength: Math.max(1, footer.logicalBytes),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_BUFFER_TOO_LARGE") {
      throw new ArchivedFileCorrupt(file, "size", "decodes to more bytes than the footer states");
    }
    throw new ArchivedFileCorrupt(file, "frame", (error as Error).message);
  }
  if (decoded.length !== footer.logicalBytes) {
    throw new ArchivedFileCorrupt(
      file,
      "size",
      `decoded ${decoded.length} bytes, footer states ${footer.logicalBytes}`,
    );
  }
  if (sha256Hex(decoded) !== footer.sha256) {
    throw new ArchivedFileCorrupt(
      file,
      "hash",
      "sha256 of the decoded bytes differs from the footer",
    );
  }
  return decoded;
}

// ────────────────────────────────────────────────────────────────────────────────
// resolution and verified reads
// ────────────────────────────────────────────────────────────────────────────────

export type ResolvedArchivedFile =
  | { form: "plain"; path: string }
  | { form: "zst"; path: string }
  | { form: "absent" };

async function isPresent(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * §H.4: plain → plain; else `.zst` → zst; else absent. ⚠️ PLAIN WINS when both exist
 * — it is either identical (an interrupted commit) or newer (a race).
 */
export async function resolveArchivedFile(
  dir: string,
  logicalName: string,
): Promise<ResolvedArchivedFile> {
  const plain = path.join(dir, logicalName);
  if (await isPresent(plain)) {
    return { form: "plain", path: plain };
  }
  const zst = path.join(dir, zstNameFor(logicalName));
  if (await isPresent(zst)) {
    return { form: "zst", path: zst };
  }
  return { form: "absent" };
}

/** Residency (amendment §D): `<file>` or `<file>.zst`. A naming rule — no decoding. */
export async function archivedFileExists(dir: string, logicalName: string): Promise<boolean> {
  return (await resolveArchivedFile(dir, logicalName)).form !== "absent";
}

export type VerifiedArchivedFile = {
  bytes: Buffer;
  form: "plain" | "zst";
  mtimeMs: number;
};

/**
 * The verified logical bytes of one archived file, or `undefined` when it is absent in
 * both forms. Corrupt ⇒ throws `ArchivedFileCorrupt` — NEVER `undefined`.
 *
 * ⚠️ RE-RESOLVES ONCE ON ENOENT (§H.4). A sweep can unlink the plain between our
 * resolve and our open (its `.zst` then exists), and a restore can move either form
 * away; without the retry the first race reads as "absent", i.e. silent empty history.
 */
export async function readArchivedFileVerified(
  dir: string,
  logicalName: string,
): Promise<VerifiedArchivedFile | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resolved = await resolveArchivedFile(dir, logicalName);
    if (resolved.form === "absent") {
      return undefined;
    }
    try {
      const handle = await fs.open(resolved.path, "r");
      try {
        const stat = await handle.stat();
        const data = await handle.readFile();
        if (resolved.form === "plain") {
          return { bytes: data, form: "plain", mtimeMs: stat.mtimeMs };
        }
        assertZstdAvailable();
        return { bytes: decodeArchiveZst(data, resolved.path), form: "zst", mtimeMs: stat.mtimeMs };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt === 1) {
        throw error;
      }
    }
  }
  return undefined;
}

export type ArchivedFileStat = {
  form: "plain" | "zst";
  path: string;
  logicalBytes: number;
  diskBytes: number;
  mtimeMs: number;
};

/**
 * Logical size without decoding: a plain file's size, or a `.zst` footer's length
 * (footer validated, frame NOT decoded — use `readArchivedFileVerified` to trust the
 * content). `undefined` when absent in both forms.
 */
export async function statArchivedFile(
  dir: string,
  logicalName: string,
): Promise<ArchivedFileStat | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const resolved = await resolveArchivedFile(dir, logicalName);
    if (resolved.form === "absent") {
      return undefined;
    }
    try {
      const stat = await fs.stat(resolved.path);
      if (resolved.form === "plain") {
        return {
          form: "plain",
          path: resolved.path,
          logicalBytes: stat.size,
          diskBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }
      const footer = parseFooter(await readTail(resolved.path, FOOTER_BYTES), resolved.path);
      return {
        form: "zst",
        path: resolved.path,
        logicalBytes: footer.logicalBytes,
        diskBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || attempt === 1) {
        throw error;
      }
    }
  }
  return undefined;
}

async function readTail(filePath: string, length: number): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const take = Math.min(size, length);
    const buffer = Buffer.alloc(take);
    await handle.read(buffer, 0, take, size - take);
    return buffer;
  } finally {
    await handle.close();
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// durable write helpers
// ────────────────────────────────────────────────────────────────────────────────

export async function fsyncDir(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Write `data` to a NEW file (`wx`) and fsync it. */
export async function writeNewFileSynced(target: string, data: Buffer): Promise<void> {
  const handle = await fs.open(target, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Give `target` the mtime `mtimeMs`, exact to the MICROSECOND.
 *
 * ⚠️ NOT `utimes(target, ms / 1000, ms / 1000)`. node passes float seconds and libuv
 * TRUNCATES them to a timespec; a double near 1.8e9 s carries ~0.24 µs of error, so a
 * plain `…123 ms` came back as `…122.999 ms` (measured). Rounding to whole µs and adding
 * half a µs makes the truncation land on the intended microsecond.
 */
export async function setMtime(target: string, mtimeMs: number): Promise<void> {
  const seconds = (Math.round(mtimeMs * 1000) + 0.5) / 1e6;
  await fs.utimes(target, seconds, seconds);
}

export function stagingTempName(stagingDir: string, logicalName: string): string {
  return path.join(
    stagingDir,
    `${logicalName}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

async function unlinkQuietly(target: string): Promise<void> {
  await fs.unlink(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────────
// the writer protocol — compress one file (CONCEPTION §3.6)
// ────────────────────────────────────────────────────────────────────────────────

export type CompressJournal = {
  /** Called BEFORE the staging temp is created (one write + fsync). */
  begin(file: string, logicalBytes: number, logicalSha256: string): Promise<void>;
};

export type CompressOutcome =
  | {
      status: "compressed";
      logicalBytes: number;
      logicalSha256: string;
      zstBytes: number;
      zstSha256: string;
      mtimeMs: number;
    }
  | { status: "skipped"; reason: "small" | "ratio"; logicalBytes: number; mtimeMs: number }
  | { status: "aborted"; reason: "changed-during-compress" | "vanished"; detail?: string }
  | {
      status: "failed";
      error: string;
      detail?: string;
      logicalBytes?: number;
      logicalSha256?: string;
    }
  | { status: "both-forms" };

/** Test-only crash seam, inert unless set (CONCEPTION §3.12): SIGKILL after step N. */
function crashSeam(step: number): void {
  if (process.env.ACPX_ARCHIVE_COMPRESS_CRASH_AFTER === String(step)) {
    process.kill(process.pid, "SIGKILL");
  }
}

/**
 * Test-only seam for AC-2's writer side, inert unless set: flip one byte of the staged
 * temp so step 5's verify-from-disk has to catch it.
 */
async function corruptStagedForTest(temp: string): Promise<void> {
  if (process.env.ACPX_ARCHIVE_COMPRESS_FLIP_STAGED !== "1") {
    return;
  }
  const handle = await fs.open(temp, "r+");
  try {
    const one = Buffer.alloc(1);
    await handle.read(one, 0, 1, 8);
    one[0] ^= 0xff;
    await handle.write(one, 0, 1, 8);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

type PlainIdentity = { dev: number; ino: number; size: number; mtimeMs: number; mode: number };

function identityOf(stat: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  mode: number;
}): PlainIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: permissionBits(stat.mode),
  };
}

/**
 * The permission bits of a file — carried by the `.zst` FILE (not the footer) and handed
 * back on decompression. ⚠️ Without this, a decompressed file kept the staging temp's
 * 0600 where the original was 0644 (TE, 2026-10-29); `writeNewFileSynced` creates 0600
 * on purpose, so the mode must be set explicitly after the fact.
 */
export function permissionBits(mode: number): number {
  return mode & 0o7777;
}

function sameIdentity(a: PlainIdentity, b: PlainIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function errnoOf(error: unknown, fallback: string): string {
  return (error as NodeJS.ErrnoException).code ?? fallback;
}

type ReadPlain =
  | { ok: true; identity: PlainIdentity; logical: Buffer }
  | { ok: false; outcome: CompressOutcome };

/** Steps 1-2: open + fstat (regular, ≤ 256 MiB), read fully, and re-check the size. */
async function readPlainForCompress(plainPath: string): Promise<ReadPlain> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(plainPath, "r");
  } catch (error) {
    if (errnoOf(error, "") === "ENOENT") {
      return { ok: false, outcome: { status: "aborted", reason: "vanished" } };
    }
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return { ok: false, outcome: { status: "failed", error: "not-a-regular-file" } };
    }
    if (stat.size > MAX_COMPRESS_INPUT_BYTES) {
      const detail = `${stat.size} bytes > ${MAX_COMPRESS_INPUT_BYTES}`;
      return { ok: false, outcome: { status: "failed", error: "too-large", detail } };
    }
    const logical = await handle.readFile();
    if (logical.length !== stat.size) {
      const detail = "size changed while reading";
      return {
        ok: false,
        outcome: { status: "aborted", reason: "changed-during-compress", detail },
      };
    }
    return { ok: true, identity: identityOf(stat), logical };
  } finally {
    await handle.close();
  }
}

/** Steps 4-6: write-ahead `begin`, staging temp (wx + fsync), verify FROM DISK, mtime. */
async function stageCompressed(
  temp: string,
  encoded: Buffer,
  logical: Buffer,
  logicalSha256: string,
  plain: PlainIdentity,
): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
  try {
    await writeNewFileSynced(temp, encoded);
  } catch (error) {
    await unlinkQuietly(temp);
    return { ok: false, error: errnoOf(error, "write-failed"), detail: (error as Error).message };
  }
  await corruptStagedForTest(temp);
  crashSeam(4);
  try {
    // The same verifier every reader uses — not a comparison against `encoded`.
    const decoded = decodeArchiveZst(await fs.readFile(temp), temp);
    if (decoded.length !== logical.length || sha256Hex(decoded) !== logicalSha256) {
      throw new ArchivedFileCorrupt(temp, "hash", "staged file decodes to different bytes");
    }
  } catch (error) {
    await unlinkQuietly(temp);
    return { ok: false, error: "verify-failed", detail: (error as Error).message };
  }
  crashSeam(5);
  await fs.chmod(temp, plain.mode);
  await setMtime(temp, plain.mtimeMs);
  return { ok: true };
}

/**
 * Steps 8-9: retire the plain — but only if it is still the file we read. Gone or
 * changed ⇒ a concurrent restore (or writer) owns it: drop OUR `.zst`, the plain is
 * authoritative.
 */
async function retirePlain(
  dir: string,
  plainPath: string,
  zstPath: string,
  identity: PlainIdentity,
): Promise<CompressOutcome | undefined> {
  const dropOurs = async (detail: string): Promise<CompressOutcome> => {
    await unlinkQuietly(zstPath);
    await fsyncDir(dir);
    return { status: "aborted", reason: "changed-during-compress", detail };
  };
  let current: PlainIdentity | undefined;
  try {
    current = identityOf(await fs.lstat(plainPath));
  } catch (error) {
    if (errnoOf(error, "") !== "ENOENT") {
      throw error;
    }
  }
  if (!current || !sameIdentity(current, identity)) {
    return await dropOurs(current ? "plain changed" : "plain moved away");
  }
  crashSeam(8);
  try {
    await fs.unlink(plainPath);
  } catch (error) {
    if (errnoOf(error, "") === "ENOENT") {
      return await dropOurs("plain moved away before unlink");
    }
    throw error;
  }
  await fsyncDir(dir);
  crashSeam(9);
  return undefined;
}

/** Before any work: too small to be worth it, or a `.zst` is already beside the plain. */
async function earlyOutcome(
  logical: Buffer,
  identity: PlainIdentity,
  zstPath: string,
): Promise<CompressOutcome | undefined> {
  if (logical.length < MIN_COMPRESS_BYTES) {
    return {
      status: "skipped",
      reason: "small",
      logicalBytes: logical.length,
      mtimeMs: identity.mtimeMs,
    };
  }
  return (await isPresent(zstPath)) ? { status: "both-forms" } : undefined;
}

/**
 * Compress `<dir>/<logical>` into `<dir>/<logical>.zst` and unlink the plain — the
 * nine steps of CONCEPTION §3.6.
 *
 * 🛑 THE PLAIN IS UNLINKED ONLY AFTER A `.zst` HAS BEEN COMMITTED AND VERIFIED FROM
 * DISK, AND ONLY IF THE PLAIN IS STILL THE FILE WE READ. A crash anywhere leaves either
 * the plain alone (+ a staging temp the next sweep removes) or both forms, identical.
 * A concurrent restore that moved the plain away makes us drop OUR `.zst` (steps 8-9),
 * so the outcome is always exactly one complete copy.
 */
export async function compressArchivedFile(params: {
  dir: string;
  logicalName: string;
  stagingDir: string;
  journal: CompressJournal;
}): Promise<CompressOutcome> {
  const { dir, logicalName, stagingDir } = params;
  const plainPath = path.join(dir, logicalName);
  const zstPath = path.join(dir, zstNameFor(logicalName));

  const read = await readPlainForCompress(plainPath);
  if (!read.ok) {
    return read.outcome;
  }
  const { identity, logical } = read;
  const early = await earlyOutcome(logical, identity, zstPath);
  if (early) {
    return early;
  }

  // Step 3: compress (one-shot ⇒ one frame) + footer.
  assertZstdAvailable();
  const encoded = encodeArchiveZst(logical);
  if (encoded.length > logical.length * MAX_COMPRESSED_RATIO) {
    return {
      status: "skipped",
      reason: "ratio",
      logicalBytes: logical.length,
      mtimeMs: identity.mtimeMs,
    };
  }
  const logicalSha256 = sha256Hex(logical);
  const sizes = { logicalBytes: logical.length, logicalSha256 };

  await params.journal.begin(logicalName, logical.length, logicalSha256);
  const temp = stagingTempName(stagingDir, logicalName);
  const staged = await stageCompressed(temp, encoded, logical, logicalSha256, identity);
  if (!staged.ok) {
    return { status: "failed", error: staged.error, detail: staged.detail, ...sizes };
  }

  // Step 7: commit by link (no-clobber), unlink the temp, fsync the dir.
  try {
    await fs.link(temp, zstPath);
  } catch (error) {
    await unlinkQuietly(temp);
    if (errnoOf(error, "") === "EEXIST") {
      return { status: "both-forms" };
    }
    return {
      status: "failed",
      error: errnoOf(error, "link-failed"),
      detail: (error as Error).message,
      ...sizes,
    };
  }
  await unlinkQuietly(temp);
  await fsyncDir(dir);
  crashSeam(7);

  const retired = await retirePlain(dir, plainPath, zstPath, identity);
  if (retired) {
    return retired;
  }
  return {
    status: "compressed",
    ...sizes,
    zstBytes: encoded.length,
    zstSha256: sha256Hex(encoded),
    mtimeMs: identity.mtimeMs,
  };
}

// ────────────────────────────────────────────────────────────────────────────────
// decompress one file (restore, rollback)
// ────────────────────────────────────────────────────────────────────────────────

export type StagedPlain = {
  temp: string;
  logicalBytes: number;
  logicalSha256: string;
  mtimeMs: number;
};

/**
 * Decode + verify a `.zst` into a staging temp (fsync, re-read + hash, mtime). Nothing
 * outside `stagingDir` is touched; the caller commits with `commitStagedPlain`.
 * Corrupt ⇒ throws `ArchivedFileCorrupt` and leaves no temp.
 */
export async function stageDecompressed(
  zstPath: string,
  logicalName: string,
  stagingDir: string,
): Promise<StagedPlain> {
  assertZstdAvailable();
  const handle = await fs.open(zstPath, "r");
  let data: Buffer;
  let mtimeMs: number;
  let mode: number;
  try {
    const stat = await handle.stat();
    mtimeMs = stat.mtimeMs;
    mode = permissionBits(stat.mode);
    data = await handle.readFile();
  } finally {
    await handle.close();
  }
  const logical = decodeArchiveZst(data, zstPath);
  const logicalSha256 = sha256Hex(logical);
  const temp = stagingTempName(stagingDir, logicalName);
  try {
    await writeNewFileSynced(temp, logical);
    const reread = await fs.readFile(temp);
    if (reread.length !== logical.length || sha256Hex(reread) !== logicalSha256) {
      throw new ArchivedFileCorrupt(temp, "hash", "staged plain re-read differs");
    }
    // The `.zst` carries the original's mode (see `permissionBits`); give it back.
    await fs.chmod(temp, mode);
    await setMtime(temp, mtimeMs);
  } catch (error) {
    await unlinkQuietly(temp);
    throw error;
  }
  return { temp, logicalBytes: logical.length, logicalSha256, mtimeMs };
}

/**
 * Link a staged plain to `dest` (no-clobber), fsync, then unlink the source `.zst`
 * and the temp. ⚠️ THE `.zst` IS UNLINKED ONLY AFTER ITS VERIFIED PLAIN IS LINKED —
 * a crash in between leaves both forms, identical, which `--repair` resolves.
 * `EEXIST` ⇒ throws with code `EEXIST` and touches nothing but the temp.
 */
export async function commitStagedPlain(
  staged: StagedPlain,
  dest: string,
  zstPath: string,
): Promise<void> {
  try {
    await fs.link(staged.temp, dest);
  } finally {
    await unlinkQuietly(staged.temp);
  }
  await fsyncDir(path.dirname(dest));
  await unlinkQuietly(zstPath);
  await fsyncDir(path.dirname(zstPath));
}

export async function discardStaged(staged: StagedPlain): Promise<void> {
  await unlinkQuietly(staged.temp);
}
