import fs from "node:fs/promises";
import { fsyncDir } from "./compressed.js";
import { compressionDir, compressionJournalPath } from "./paths.js";

/**
 * `COMPRESSION/journal.tsv` (amendment §H.6) — the audit trail of every compression
 * event. ⚠️ AN AUDIT TRAIL, NOT A SOURCE OF TRUTH: no reader consults it to verify a
 * file (the footer is self-contained), so a lost or damaged journal never makes a file
 * unreadable. The only thing read back from it is the `skip` set, so a file judged
 * incompressible is not re-tried every night.
 */

export const COMPRESSION_JOURNAL_HEADER =
  "at\twave\taction\tfile\tlogical_bytes\tlogical_sha256\tzst_bytes\tzst_sha256\tverified\tdetail";
const COLUMNS = 10;

export type CompressionJournalAction =
  | "begin"
  | "compress"
  | "skip"
  | "abort"
  | "fail"
  | "resolve-both"
  | "quarantine"
  | "decompress";

const ACTIONS: ReadonlySet<string> = new Set([
  "begin",
  "compress",
  "skip",
  "abort",
  "fail",
  "resolve-both",
  "quarantine",
  "decompress",
]);

export type CompressionJournalRow = {
  at: string;
  wave: string;
  action: CompressionJournalAction;
  file: string;
  logicalBytes?: number;
  logicalSha256?: string;
  zstBytes?: number;
  zstSha256?: string;
  verified?: boolean;
  detail?: string;
};

function clean(value: string | undefined): string {
  return (value ?? "").replace(/[\t\r\n]/g, " ");
}

export function serializeJournalRow(row: CompressionJournalRow): string {
  return [
    row.at,
    row.wave,
    row.action,
    row.file,
    row.logicalBytes == null ? "" : String(row.logicalBytes),
    row.logicalSha256 ?? "",
    row.zstBytes == null ? "" : String(row.zstBytes),
    row.zstSha256 ?? "",
    row.verified == null ? "" : row.verified ? "1" : "0",
    clean(row.detail),
  ].join("\t");
}

function parseOptionalInt(value: string): number | undefined {
  return value.length === 0 ? undefined : Number(value);
}

/** Rows with ≠ 10 columns or an unknown action are skipped (forward compatible). */
export function parseJournal(payload: string): CompressionJournalRow[] {
  const rows: CompressionJournalRow[] = [];
  for (const line of payload.split("\n").slice(1)) {
    const cells = line.split("\t");
    if (cells.length !== COLUMNS || !ACTIONS.has(cells[2])) {
      continue;
    }
    rows.push({
      at: cells[0],
      wave: cells[1],
      action: cells[2] as CompressionJournalAction,
      file: cells[3],
      logicalBytes: parseOptionalInt(cells[4]),
      logicalSha256: cells[5] || undefined,
      zstBytes: parseOptionalInt(cells[6]),
      zstSha256: cells[7] || undefined,
      verified: cells[8] === "" ? undefined : cells[8] === "1",
      detail: cells[9] || undefined,
    });
  }
  return rows;
}

export async function readCompressionJournal(archiveDir: string): Promise<CompressionJournalRow[]> {
  try {
    return parseJournal(await fs.readFile(compressionJournalPath(archiveDir), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** The header, written ONCE with O_CREAT|O_EXCL; an existing journal is left alone. */
export async function ensureCompressionJournal(archiveDir: string): Promise<void> {
  try {
    const handle = await fs.open(compressionJournalPath(archiveDir), "wx", 0o644);
    try {
      await handle.writeFile(`${COMPRESSION_JOURNAL_HEADER}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsyncDir(compressionDir(archiveDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

/** Append-only writer: one `write(2)` + fsync per row (a `begin` must be durable before the temp). */
export class CompressionJournalWriter {
  private constructor(
    private readonly handle: fs.FileHandle,
    readonly at: string,
    readonly wave: string,
  ) {}

  static async open(
    archiveDir: string,
    at: string,
    wave: string,
  ): Promise<CompressionJournalWriter> {
    await ensureCompressionJournal(archiveDir);
    const handle = await fs.open(compressionJournalPath(archiveDir), "a");
    return new CompressionJournalWriter(handle, at, wave);
  }

  /**
   * Every row THIS writer appended, in order — what `--manifest-out` lists. ⚠️ Not a
   * filter of the journal by wave: two runs that share a wave id (an operator reusing
   * `--wave`) would otherwise mix their rows (TE, 2026-10-29).
   */
  readonly written: CompressionJournalRow[] = [];

  async append(row: Omit<CompressionJournalRow, "at" | "wave">): Promise<void> {
    const full = { ...row, at: new Date().toISOString(), wave: this.wave };
    await this.handle.write(`${serializeJournalRow(full)}\n`);
    await this.handle.sync();
    this.written.push(full);
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}
