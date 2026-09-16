import path from "node:path";

/**
 * Where the cold-archive tier lives, per conception `archive-formats.md` §1 and
 * `BRIEF.md` §7.1.
 *
 * ```
 * archiveDir =
 *   1. ACPX_SESSIONS_ARCHIVE_DIR, if set and non-empty  -> path.resolve(it)
 *   2. otherwise: sibling of the hot dir THIS PROCESS resolved —
 *      path.join(dirname(hotDir), basename(hotDir) + "-archive")
 * ```
 *
 * ⚠️ DELIBERATELY A PURE FUNCTION OF `hotDir`, NOT A CALL TO `sessionBaseDir()`.
 * Two reasons, and the second is the load-bearing one:
 *
 * 1. `repository.ts` imports this module for its archived-record fallback leg, so
 *    reaching back into `repository.ts` from here would close an import cycle.
 * 2. acpx and acpx-ui resolve the hot dir DIFFERENTLY and that divergence is
 *    pre-existing and deliberately unfixed (BRIEF §7.1): acpx honours
 *    `ACPX_STATE_HOME` and ignores `ACPX_SESSIONS_DIR`; acpx-ui does the reverse.
 *    Deriving the archive from whatever hot dir the CALLER resolved means the two
 *    sides can never disagree about the archive *more than they already disagree
 *    about the hot dir* — it inherits exactly one failure mode and adds none. A
 *    version of this function that resolved the hot dir itself would hard-code
 *    one side's answer into both.
 */
export function sessionArchiveDirFor(hotDir: string): string {
  const override = process.env.ACPX_SESSIONS_ARCHIVE_DIR;
  if (override != null && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.join(path.dirname(hotDir), `${path.basename(hotDir)}-archive`);
}

/**
 * True when the resolved archive dir is NOT the sibling of the hot dir — i.e.
 * `ACPX_SESSIONS_ARCHIVE_DIR` is pointing somewhere else.
 *
 * BRIEF §7.1 names this the genuine footgun of the override: set it alone while
 * acpx and acpx-ui resolve DIFFERENT hot dirs and the two share ONE archive while
 * having two hot dirs. Both repos must warn about it at startup; this predicate is
 * what they warn on. It is a warning, never a refusal — an operator who means it
 * (a staging box pointing at a read-only copy) must still be able to proceed.
 */
export function isDetachedArchiveDir(hotDir: string, archiveDir: string): boolean {
  const sibling = path.join(path.dirname(hotDir), `${path.basename(hotDir)}-archive`);
  return path.resolve(archiveDir) !== path.resolve(sibling);
}

export function archiveIndexDir(archiveDir: string): string {
  return path.join(archiveDir, ARCHIVE_INDEX_DIR_NAME);
}

export function archiveManifestPath(archiveDir: string): string {
  return path.join(archiveDir, ARCHIVE_MANIFEST_FILE_NAME);
}

export const ARCHIVE_MANIFEST_FILE_NAME = "MANIFEST.tsv";

/**
 * ⚠️ NO `.json` SUFFIX, AND NO `.` AT ALL — both are load-bearing, and the
 * obvious justification for this directory ("directories are skipped anyway") is
 * FALSE. Only acpx's `listSessionRecordFiles` uses `withFileTypes` and excludes
 * directories; every acpx-ui enumeration site filters by filename suffix, so a
 * directory literally named `something.json` WOULD be picked up by them as a
 * record candidate (formats §4.1).
 *
 * Three independent reasons make this name safe, and all three must be carried:
 * (1) nothing in either repo enumerates the ARCHIVE dir at all — the decisive
 * one; (2) no `.json` suffix, so acpx-ui's suffix filters exclude it even if one
 * were pointed here; (3) no `.`, so its id-part is the whole name and it cannot
 * collide with the `<id>.` file-set pattern — and it is on the reserved list
 * besides.
 *
 * COROLLARY THE NEXT EDITOR MUST NOT LOSE: never put a directory in the HOT dir
 * on the assumption that directories are skipped there. They are not, by acpx-ui.
 */
export const ARCHIVE_INDEX_DIR_NAME = "ARCHIVE-INDEX";
