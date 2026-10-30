import fs from "node:fs/promises";
import path from "node:path";
import {
  ARCHIVE_ZST_FORMAT,
  ArchivedFileCorrupt,
  compressibleFamilyOf,
  logicalFileSet,
  readArchivedFileVerified,
  resolveArchivedFile,
  setMtime,
  statArchivedFile,
  type TranscriptFamily,
} from "./compressed.js";
import { claimArchiveFileSets, recordFileNameFor } from "./identity.js";
import { ArchiveRefusal } from "./move.js";
import { encodeSessionSafeId } from "./safe-id.js";

/**
 * `acpx sessions archive --thaw <id> --to <dir>` — atrium's archived peek (CONCEPTION
 * §3.9, cli-contract.md §1). Copies the record and the four transcript families into a
 * caller-owned EMPTY directory as plain files with their mtimes; `.zst` decompressed
 * and verified. Read-only towards the archive: no lock, never unlinks there.
 *
 * ⚠️ ALL OR NOTHING. A thaw that fails after writing started removes every file it
 * wrote, so the caller never assembles a transcript from a partial copy — the exact
 * "partial history, 200 OK" failure the mandate forbids.
 */

export type ThawFamily = TranscriptFamily | "record";

export type ThawResult = {
  action: "thaw";
  format: typeof ARCHIVE_ZST_FORMAT;
  status: "thawed";
  id: string;
  safeId: string;
  archiveDir: string;
  to: string;
  files: {
    file: string;
    family: ThawFamily;
    form: "plain" | "zst";
    bytes: number;
    mtime: string;
  }[];
  logicalBytes: number;
  maxBytes: number | null;
};

/** A thaw refusal: `code` is the contract's `error.code`; extra fields ride along. */
export class ThawRefusal extends ArchiveRefusal {
  constructor(
    message: string,
    code: string,
    readonly extra: Record<string, string | number> = {},
  ) {
    super(message, code);
  }
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** `--to` must exist, be an EMPTY directory, and lie outside both the hot and archive dir. */
export async function assertThawTarget(
  to: string,
  hotDir: string,
  archiveDir: string,
): Promise<string> {
  let stat;
  try {
    stat = await fs.stat(to);
  } catch {
    throw new ThawRefusal(
      `--to ${to} does not exist (the caller creates it, e.g. with mkdtemp)`,
      "bad-argument",
    );
  }
  if (!stat.isDirectory()) {
    throw new ThawRefusal(`--to ${to} is not a directory`, "bad-argument");
  }
  const real = await realpathOrSelf(to);
  for (const forbidden of [hotDir, archiveDir]) {
    const realForbidden = await realpathOrSelf(forbidden);
    if (isInside(real, realForbidden) || isInside(realForbidden, real)) {
      throw new ThawRefusal(
        `--to ${to} overlaps ${forbidden}; a thaw never writes into the hot or archive dir`,
        "bad-argument",
      );
    }
  }
  if ((await fs.readdir(to)).length > 0) {
    throw new ThawRefusal(`--to ${to} is not empty`, "bad-argument");
  }
  return real;
}

function thawFamilyOf(safeId: string, logical: string): ThawFamily | undefined {
  return logical === recordFileNameFor(safeId) ? "record" : compressibleFamilyOf(safeId, logical);
}

type PlannedThaw = { file: string; family: ThawFamily; logicalBytes: number };

async function planThaw(archiveDir: string, safeId: string): Promise<PlannedThaw[]> {
  const fileSets = claimArchiveFileSets(await fs.readdir(archiveDir));
  const onDisk = fileSets.get(safeId);
  if (!onDisk || onDisk.length === 0) {
    throw new ThawRefusal(`the archive holds no file of ${safeId}`, "not-in-archive");
  }
  const planned: PlannedThaw[] = [];
  for (const file of logicalFileSet(safeId, onDisk)) {
    const family = thawFamilyOf(safeId, file);
    if (family === undefined) {
      continue;
    }
    const stat = await statArchivedFile(archiveDir, file);
    if (!stat) {
      throw new ThawRefusal(`${file} vanished from the archive while thawing`, "archive-changed", {
        file,
      });
    }
    planned.push({ file, family, logicalBytes: stat.logicalBytes });
  }
  if (planned.length === 0) {
    throw new ThawRefusal(
      `the archive holds no record or transcript file of ${safeId}`,
      "not-in-archive",
    );
  }
  return planned;
}

async function removeWritten(to: string, written: readonly string[]): Promise<void> {
  for (const file of written) {
    await fs.unlink(path.join(to, file)).catch(() => undefined);
  }
}

export async function thawArchivedSession(params: {
  id: string;
  to: string;
  hotDir: string;
  archiveDir: string;
  maxBytes?: number;
}): Promise<ThawResult> {
  const safeId = encodeSessionSafeId(params.id);
  const to = await assertThawTarget(params.to, params.hotDir, params.archiveDir);
  const planned = await planThaw(params.archiveDir, safeId);
  const logicalBytes = planned.reduce((sum, entry) => sum + entry.logicalBytes, 0);
  if (params.maxBytes != null && logicalBytes > params.maxBytes) {
    throw new ThawRefusal(
      `${safeId} is ${logicalBytes} logical bytes, over --max-bytes ${params.maxBytes} — restore it to view`,
      "too-large",
      { logicalBytes, maxBytes: params.maxBytes },
    );
  }
  const written: string[] = [];
  const files: ThawResult["files"] = [];
  try {
    for (const entry of planned) {
      const read = await readArchivedFileVerified(params.archiveDir, entry.file);
      if (!read) {
        throw new ThawRefusal(
          `${entry.file} vanished from the archive while thawing`,
          "archive-changed",
          { file: entry.file },
        );
      }
      const target = path.join(to, entry.file);
      await fs.writeFile(target, read.bytes, { flag: "wx", mode: 0o600 });
      written.push(entry.file);
      await setMtime(target, read.mtimeMs);
      files.push({
        file: entry.file,
        family: entry.family,
        form: read.form,
        bytes: read.bytes.length,
        mtime: new Date(read.mtimeMs).toISOString(),
      });
    }
  } catch (error) {
    await removeWritten(to, written);
    throw error;
  }
  return {
    action: "thaw",
    format: ARCHIVE_ZST_FORMAT,
    status: "thawed",
    id: params.id,
    safeId,
    archiveDir: params.archiveDir,
    to,
    files,
    logicalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    maxBytes: params.maxBytes ?? null,
  };
}

/** The contract's failure envelope for a thaw. */
export function thawErrorJson(id: string, to: string, error: Error & { code?: string }): unknown {
  const extra =
    error instanceof ThawRefusal
      ? error.extra
      : error instanceof ArchivedFileCorrupt
        ? { file: path.basename(error.file).replace(/\.zst$/, ""), check: error.check }
        : {};
  return {
    action: "thaw",
    format: ARCHIVE_ZST_FORMAT,
    status: "refused",
    id,
    to,
    error: { code: error.code ?? "error", message: error.message, ...extra },
  };
}

/**
 * `--cat <name>` — the verified logical bytes of ONE archive file, by its archive NAME.
 * A `.zst` suffix is accepted and stripped (the logical name is what is read).
 *
 * ⚠️ NAMES ONLY, NEVER PATHS (TE, 2026-10-29): a slash-bearing argument used to resolve
 * against the cwd and an absolute one was read as-is (`--cat /etc/hostname` printed it),
 * and `--cat ''` died with EISDIR. Anything that is not a plain file name of a session
 * file (`<id>.<suffix>`: no `/`, no `..`, not hidden, non-empty) is refused, exit 2.
 */
export async function catArchivedFile(archiveDir: string, name: string): Promise<Buffer> {
  const logical = assertArchiveFileName(name).replace(/\.zst$/, "");
  const resolved = await resolveArchivedFile(archiveDir, logical);
  if (resolved.form !== "absent" && !(await fs.stat(resolved.path)).isFile()) {
    throw new ArchiveRefusal(`--cat ${name}: ${logical} is not a regular file`, "bad-argument");
  }
  const read = await readArchivedFileVerified(archiveDir, logical);
  if (!read) {
    throw new ArchiveRefusal(`${path.join(archiveDir, logical)} is absent in both forms`, "absent");
  }
  return read.bytes;
}

/** A session file NAME in the archive dir: `<id>.<suffix>`, nothing that walks a path. */
export function assertArchiveFileName(name: string): string {
  const reason =
    name.length === 0
      ? "is empty"
      : /[/\\]/.test(name) || name.includes("\u0000")
        ? "contains a path separator — pass an archive file NAME, not a path"
        : name.startsWith(".")
          ? "is a hidden name or a relative path component"
          : !name.includes(".")
            ? "is not a session file name (<id>.<suffix>)"
            : undefined;
  if (reason) {
    throw new ArchiveRefusal(`--cat '${name}' ${reason}`, "bad-argument");
  }
  return name;
}
