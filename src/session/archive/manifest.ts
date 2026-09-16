import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { archiveManifestPath } from "./paths.js";

/**
 * `MANIFEST.tsv` — the append-only journal of every archive and restore.
 * Format adopted VERBATIM from the landed one-off (formats §3); the product
 * appends to the same file and never migrates, rewrites or re-headers it.
 */

/** Byte-exact, and frozen. 14 tab-separated columns. */
export const ARCHIVE_MANIFEST_HEADER =
  "at\twave\taction\tid\treason\tclosed\tclosed_at\tlast_used_at\tkind\tname\tbrick\tfile\tbytes\tmtime";

export const ARCHIVE_MANIFEST_COLUMNS = 14;

export type ArchiveManifestAction = "archive" | "restore";

export type ArchiveManifestRow = {
  at: string;
  wave: string;
  action: ArchiveManifestAction;
  id: string;
  reason: string;
  closed: string;
  closedAt: string;
  lastUsedAt: string;
  kind: string;
  name: string;
  brick: string;
  /** Basename, VERBATIM and unescaped — a restore reads this back as a path. */
  file: string;
  bytes: number;
  mtime: string;
};

/**
 * The one escaping rule, normative (formats §3.3). Lossy by design: the manifest
 * is an audit trail, not a source of record metadata — the shard index carries
 * the faithful values.
 *
 * ⚠️ NEVER APPLIED TO COLUMN 12 (`file`). A restore renames by that exact string,
 * so escaping it would silently break restore — which is why a hostile filename is
 * a REFUSAL (`hostile-filename`) and not an escaping problem.
 */
export function cleanManifestText(value: string | undefined | null): string {
  // ⚠️ TYPED `string | undefined | null`, NOT `unknown`, DELIBERATELY. The
  // normative rule (formats §3.3) is written as `String(s ?? '')` — JS, where the
  // coercion is free. In TypeScript an `unknown` parameter makes `String(value)`
  // silently stringify an object as `[object Object]` INTO A TAB-SEPARATED AUDIT
  // COLUMN, which is both useless and, for a value containing a tab, corrupting.
  // Narrowing the type moves that from a runtime accident to a compile error at
  // the call site. Behaviour for every value the product actually passes —
  // strings and absent fields — is identical to the normative rule.
  return (value ?? "").replace(/[\t\r\n]+/g, " ").slice(0, 120);
}

export function serializeManifestRow(row: ArchiveManifestRow): string {
  return [
    row.at,
    row.wave,
    row.action,
    cleanManifestText(row.id),
    cleanManifestText(row.reason),
    row.closed,
    row.closedAt,
    row.lastUsedAt,
    cleanManifestText(row.kind),
    cleanManifestText(row.name),
    cleanManifestText(row.brick),
    row.file,
    String(row.bytes),
    row.mtime,
  ].join("\t");
}

/**
 * `"ax"` is `O_CREAT|O_EXCL`: it succeeds exactly once for a given path, ever, so
 * concurrent first-writers cannot double-header. `EEXIST` is the expected outcome
 * on every run but the first. This is the `writeManifestHeaderOnce` protocol from
 * `persistence/deletion-manifest.ts` and the ONE concurrency property this module
 * claims.
 */
async function writeManifestHeaderOnce(manifestPath: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await fs.open(manifestPath, "ax");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw error;
  }
  try {
    await handle.write(`${ARCHIVE_MANIFEST_HEADER}\n`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * One open `O_APPEND` fd for the whole run; one `write(2)` per ID (~6 rows,
 * ~1.5 KB), never one per file and never one for the run.
 *
 * ⚠️ WRITE-AHEAD, AND THIS IS THE ONE BEHAVIOURAL CHANGE FROM THE ONE-OFF. The
 * reference implementation appends rows AFTER the renames and buffers 500 rows in
 * memory. A crash mid-run then leaves files in the archive with NO manifest row —
 * the audit trail is the first thing lost, in the only scenario it exists for, and
 * `--repair` has nothing to fold. Call `appendIdBlock` and await it BEFORE the
 * first rename of that id.
 *
 * A row therefore asserts "this move was authorised and begun", never
 * "completed" — the same doctrine as acpx's deletion manifest `phase: "begin"`.
 * There is no completion record and there must not be one: the authority on what
 * actually happened is the FILESYSTEM, and it is unambiguous because filenames are
 * unique across the two directories.
 *
 * Honest bound, following `deletion-manifest.ts`'s own discipline: line-level
 * `O_APPEND` atomicity is a practical property of this filesystem, not a POSIX
 * guarantee at any size. Rows are self-identifying by (`at`, `wave`, `id`,
 * `file`), so whole-line interleaving between concurrent writers is harmless; the
 * only concurrency property CLAIMED here is the `"ax"` header race.
 */
export class ArchiveManifestWriter {
  private constructor(
    private readonly handle: FileHandle,
    readonly at: string,
    readonly wave: string,
  ) {}

  static async open(archiveDir: string, at: string, wave: string): Promise<ArchiveManifestWriter> {
    const manifestPath = archiveManifestPath(archiveDir);
    await writeManifestHeaderOnce(manifestPath);
    const handle = await fs.open(manifestPath, "a");
    return new ArchiveManifestWriter(handle, at, wave);
  }

  async appendIdBlock(rows: readonly ArchiveManifestRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.handle.write(rows.map((row) => `${serializeManifestRow(row)}\n`).join(""));
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }
}

export type ManifestFoldEntry = {
  file: string;
  action: ArchiveManifestAction;
  id: string;
  at: string;
  wave: string;
  reason: string;
  /** Column 7, as it stood AT ARCHIVE TIME. Empty on a restore row. */
  closedAt: string;
  /** Column 8, as it stood AT ARCHIVE TIME. Empty on a restore row. */
  lastUsedAt: string;
};

/** The immutable end-of-life anchor for one id — see `firstArchiveById`. */
export type ManifestEndOfLife = { closedAt: string; lastUsedAt: string; at: string };

/**
 * 🛑 THIS STRUCTURE HOLDS **TWO FOLDS OVER ONE FILE IN OPPOSITE DIRECTIONS**. Pin
 * the distinction or it WILL be got backwards — the two answer different questions
 * about different keys:
 *
 * | Question | Key | Rows | Direction |
 * |---|---|---|---|
 * | **residency** — where is this FILE now? | file | BOTH actions | **LAST** row wins |
 * | **end-of-life** — when did this SESSION end? | id | `archive` rows ONLY | **FIRST** row wins |
 */
export type ManifestFold = {
  /** RESIDENCY: current expected side of every file, LAST row in file order wins. */
  lastByFile: Map<string, ManifestFoldEntry>;
  /** The LAST `archive` row per id, for `archivedAt` recovery during a reindex. */
  lastArchivedAtById: Map<string, string>;
  /**
   * END-OF-LIFE: the FIRST `archive` row per id, and never overwritten.
   *
   * ⚠️ FIRST-WINS IS THE WHOLE POINT, AND LATEST-WINS IS THE DEFECT IT FIXES.
   * `closed_at` is a live lifecycle field, so a restore-to-consult followed by a
   * legitimate re-close RE-STAMPS it — and retention keyed on the current value
   * therefore measures "when did someone last CLOSE this", not "when did this
   * session END". A session consulted periodically would never return to the
   * archive at all. First-wins makes this value IMMUTABLE ONCE WRITTEN, which
   * converts retention from a deferrable clock into a monotone one; latest-wins
   * would re-set the clock on every archive → restore → re-close cycle, i.e. the
   * same defect one level up and harder to see.
   */
  firstArchiveById: Map<string, ManifestEndOfLife>;
  /** The LAST `restore` row per id — drives the restore grace period. */
  lastRestoredAtById: Map<string, string>;
  totalRows: number;
  /** Rows skipped: wrong column count, or a truncated final line. */
  skippedRows: number;
  /** True when the manifest file does not exist at all. */
  absent: boolean;
};

/**
 * Fold the manifest to "where should each file be right now".
 *
 * Readers MUST tolerate rows with ≠14 columns (skip, count), unknown `reason` and
 * `wave` values (pass through), and a truncated final line (skip). Readers MUST
 * NOT assume rows for one id are contiguous, nor that `at` is monotonically
 * non-decreasing — concurrent runs interleave whole lines. Hence "last row in FILE
 * ORDER", not "greatest `at`".
 */
export async function foldArchiveManifest(archiveDir: string): Promise<ManifestFold> {
  const fold: ManifestFold = {
    lastByFile: new Map(),
    lastArchivedAtById: new Map(),
    firstArchiveById: new Map(),
    lastRestoredAtById: new Map(),
    totalRows: 0,
    skippedRows: 0,
    absent: false,
  };

  let payload: string;
  try {
    payload = await fs.readFile(archiveManifestPath(archiveDir), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      fold.absent = true;
      return fold;
    }
    throw error;
  }

  const lines = payload.split("\n");
  // A file that does not end in "\n" has a partial final line; a file that does
  // ends with an empty element. Both are handled by `parseManifestLine` returning
  // undefined on a wrong column count, so no special-casing is needed beyond
  // skipping the empty string.
  if (lines[0] === ARCHIVE_MANIFEST_HEADER) {
    lines.shift();
  }
  for (const line of lines) {
    const entry = line.length === 0 ? undefined : parseManifestLine(line);
    if (!entry) {
      fold.skippedRows += line.length === 0 ? 0 : 1;
      continue;
    }
    fold.totalRows += 1;
    foldRow(fold, entry);
  }

  return fold;
}

function foldRow(fold: ManifestFold, entry: ManifestFoldEntry): void {
  // RESIDENCY — "current state of a FILE = its LAST ROW IN FILE ORDER"
  // (formats §3.5), not the row with the greatest `at`. Concurrent runs interleave
  // whole lines and `at` is NOT monotonic across the file, so sorting by `at`
  // would resolve an archive/restore pair the wrong way round.
  fold.lastByFile.set(entry.file, entry);
  if (entry.action === "restore") {
    fold.lastArchivedAtById.delete(entry.id);
    fold.lastRestoredAtById.set(entry.id, entry.at);
    return;
  }
  fold.lastArchivedAtById.set(entry.id, entry.at);
  // END-OF-LIFE — FIRST archive row per id, written once and never overwritten.
  // The opposite direction from every other fold in this function; see the table
  // on `ManifestFold`.
  if (!fold.firstArchiveById.has(entry.id)) {
    fold.firstArchiveById.set(entry.id, {
      closedAt: entry.closedAt,
      lastUsedAt: entry.lastUsedAt,
      at: entry.at,
    });
  }
}

function parseManifestLine(line: string): ManifestFoldEntry | undefined {
  const columns = line.split("\t");
  if (columns.length !== ARCHIVE_MANIFEST_COLUMNS) {
    return undefined;
  }
  const action = columns[2];
  // formats §3.2: `archive` | `restore`, exactly these two, forever. An unknown
  // action is skipped rather than guessed at — folding it into either branch
  // would move files on the strength of a value no writer in this product emits.
  if (action !== "archive" && action !== "restore") {
    return undefined;
  }
  return {
    file: columns[11],
    action,
    id: columns[3],
    at: columns[0],
    wave: columns[1],
    reason: columns[4],
    closedAt: columns[6],
    lastUsedAt: columns[7],
  };
}
