import fs from "node:fs/promises";
import path from "node:path";
import { withSessionIndexLock } from "../persistence/index-lock.js";
import { reconcileSessionIndex, writeSessionIndex } from "../persistence/index.js";
import { ACTIVE_SIDECAR_SUFFIXES, recordFileNameFor } from "./identity.js";
import type { ArchiveManifestRow, ArchiveManifestWriter } from "./manifest.js";
import { readArchiveRecord, type ArchiveRecordView } from "./record-view.js";

/**
 * The move primitives. Nothing here deletes, ever — `rename(2)` in both
 * directions. Deletion stays `acpx sessions prune`'s separate, explicitly-invoked
 * act with its own manifest.
 */

export class ArchiveRefusal extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ArchiveRefusal";
  }
}

/**
 * ⚠️ REFUSE THE RUN ON A DEVICE MISMATCH — DO NOT FALL BACK TO COPY-THEN-UNLINK.
 * `rename(2)` across devices fails `EXDEV`, and a copy fallback is not atomic and
 * doubles peak disk. A half-copied multi-MB transcript that a crash leaves behind
 * is exactly the state the write-ahead journal exists to make impossible.
 *
 * ⚠️ AND THE ARCHIVE FREES ZERO BYTES BECAUSE OF THIS RULE, BY CONSTRUCTION. On
 * devbox `~/.acpx`, `~/.acpx/sessions`, `~/.acpx/sessions-archive` and
 * `/workspace` are all device 2048 on ONE 133 GB PVC. Every move is a same-device
 * rename, so not one byte is reclaimed. "We archived 8.2 GB" reads as a disk win
 * and is not one — this feature bounds MEMORY AND CPU ONLY, and must never be
 * reported as if it did otherwise.
 */
export async function assertSameDevice(hotDir: string, archiveDir: string): Promise<void> {
  await fs.mkdir(archiveDir, { recursive: true });
  const [hot, archive] = await Promise.all([fs.stat(hotDir), fs.stat(archiveDir)]);
  if (hot.dev !== archive.dev) {
    throw new ArchiveRefusal(
      `archive dir ${archiveDir} (device ${archive.dev}) is not on the same filesystem as ${hotDir} (device ${hot.dev}) — rename(2) cannot cross devices and a copy fallback is not permitted`,
      "cross-device",
    );
  }
}

export type FileStat = { file: string; bytes: number; mtimeMs: number };

export async function statFileSet(dir: string, files: readonly string[]): Promise<FileStat[]> {
  const stats: FileStat[] = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(path.join(dir, file));
      stats.push({ file, bytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Vanished between plan and apply. Not an error: the file is simply not
      // part of this move, and the no-clobber check below decides the rest.
    }
  }
  return stats;
}

/**
 * ⚠️ NO-CLOBBER, BOTH DIRECTIONS. An id whose files already exist at the
 * destination is SKIPPED, never overwritten. This is what makes a restore racing
 * the retention job safe even when the apply-time re-validation loses the race:
 * renames are atomic and the two directions move disjoint sets, so the worst
 * outcome is a PARTIAL move, which `--repair` folds back to a consistent side.
 */
export async function findClobbers(destDir: string, files: readonly string[]): Promise<string[]> {
  const clobbers: string[] = [];
  for (const file of files) {
    try {
      await fs.access(path.join(destDir, file));
      clobbers.push(file);
    } catch {
      // ENOENT is the happy path.
    }
  }
  return clobbers;
}

function isoOrEmpty(value: string | undefined): string {
  return value ?? "";
}

/**
 * Manifest columns 6-11, derived from the record ONCE per id rather than per row —
 * those columns are properties of the RECORD, and one id's rows must not be able
 * to disagree about them.
 *
 * ⚠️ EVERY READ HERE IS snake_case, VIA THE RECORD VIEW. Reading them off the
 * camelCase `SessionRecord` type produces six empty columns that typecheck, on
 * every row, forever — the failure this module's sibling `record-view.ts` exists
 * to prevent.
 */
function recordColumnsFor(
  view: ArchiveRecordView | undefined,
): Pick<ArchiveManifestRow, "closed" | "closedAt" | "lastUsedAt" | "kind" | "name" | "brick"> {
  if (!view) {
    // An orphan has no record: columns 6-11 are empty, by contract.
    return { closed: "", closedAt: "", lastUsedAt: "", kind: "", name: "", brick: "" };
  }
  return {
    closed: String(view.closed),
    closedAt: isoOrEmpty(view.closedAt),
    lastUsedAt: isoOrEmpty(view.lastUsedAt ?? view.updatedAt ?? view.createdAt),
    kind: isoOrEmpty(view.kind),
    name: isoOrEmpty(view.name),
    brick: isoOrEmpty(view.brick),
  };
}

export function buildArchiveRows(
  writer: ArchiveManifestWriter,
  id: string,
  reason: string,
  view: ArchiveRecordView | undefined,
  stats: readonly FileStat[],
): ArchiveManifestRow[] {
  const recordColumns = recordColumnsFor(view);
  return stats.map((stat) => ({
    at: writer.at,
    wave: writer.wave,
    action: "archive" as const,
    id,
    reason,
    ...recordColumns,
    file: stat.file,
    // ⚠️ Taken BEFORE the rename — after it, the source is gone.
    bytes: stat.bytes,
    mtime: new Date(stat.mtimeMs).toISOString(),
  }));
}

export function buildRestoreRows(
  writer: ArchiveManifestWriter,
  id: string,
  stats: readonly FileStat[],
): ArchiveManifestRow[] {
  // On a restore row, `reason` is the literal `restore` and columns 6-11 are
  // empty (formats §3.2).
  return stats.map((stat) => ({
    at: writer.at,
    wave: writer.wave,
    action: "restore" as const,
    id,
    reason: "restore",
    closed: "",
    closedAt: "",
    lastUsedAt: "",
    kind: "",
    name: "",
    brick: "",
    file: stat.file,
    bytes: stat.bytes,
    mtime: new Date(stat.mtimeMs).toISOString(),
  }));
}

export type MoveOutcome =
  | { status: "moved"; files: string[]; bytes: number }
  | { status: "skipped"; reason: string; detail?: string };

/**
 * Move one id's file set, in the order formats §6 fixes.
 *
 * ⚠️ THE RECORD MOVES **LAST**, AND THAT IS LOAD-BEARING. While `<id>.json` is in
 * the hot dir the session is coherent to every reader; the instant it leaves, the
 * id is archived. There is never a window in which both directories hold a record
 * for the same id — which is what lets `--repair` resolve any crash point from the
 * filesystem alone, with no state to reconstruct.
 *
 * A crash mid-sidecar leaves the visible bad state (session listed, transcript
 * truncated) rather than the invisible one (a record pointing at sidecars that
 * moved out from under it).
 */
export async function moveFileSet(
  fromDir: string,
  toDir: string,
  safeId: string,
  files: readonly string[],
): Promise<{ moved: string[]; failed: { file: string; error: string }[] }> {
  const recordFile = recordFileNameFor(safeId);
  const sidecars = files.filter((file) => file !== recordFile);
  const record = files.filter((file) => file === recordFile);

  const moved: string[] = [];
  const failed: { file: string; error: string }[] = [];
  for (const file of [...sidecars, ...record]) {
    try {
      await fs.rename(path.join(fromDir, file), path.join(toDir, file));
      moved.push(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "rename-failed";
      if (code === "ENOENT") {
        // Already moved (a concurrent `--repair`, or a retry). Idempotent by
        // construction: the destination check is what decides, not this.
        continue;
      }
      failed.push({ file, error: code });
    }
  }
  return { moved, failed };
}

export type ApplyRevalidation =
  | { ok: true; view: ArchiveRecordView | undefined; stats: FileStat[] }
  | { ok: false; reason: string; detail?: string };

/**
 * Re-validate ONE id against the LIVE filesystem, immediately before its renames.
 *
 * ⚠️ AGAINST THE LIVE RECORD, NOT AGAINST THE PLAN. This is the difference between
 * a safe run and one acting on a snapshot minutes old, and it is the primary
 * defence against a restore racing the retention job: a just-restored id has files
 * whose mtime is seconds old, so it reads as `touched-recently` here and is
 * skipped.
 *
 * ⚠️ HONEST BOUND ON WHAT THIS RE-READS: the record, the three ACTIVE sidecar
 * names, and every file the plan named. It does NOT re-enumerate the directory per
 * id — that would be an O(hot-dir) readdir per id, ~9,000 entries × ~1,200 ids on
 * the measured corpus. The residual is a file with this id's prefix created after
 * the plan's scan and NOT named by the plan: it is not moved (so nothing is lost),
 * and it does not raise the touched-recently flag. The highest-value member of
 * that class — a delivery sidecar arriving mid-run — IS covered, by the explicit
 * re-stat of the three active suffixes below.
 */
export async function revalidateBeforeApply(
  hotDir: string,
  safeId: string,
  files: readonly string[],
  hadRecord: boolean,
  quietMs: number,
  nowMs: number,
): Promise<ApplyRevalidation> {
  const revalidatedRecord = hadRecord
    ? await revalidateRecord(hotDir, safeId)
    : ({ ok: true, view: undefined } as const);
  if (!revalidatedRecord.ok) {
    return revalidatedRecord;
  }

  const activeSuffix = await findActiveSidecarOnDisk(hotDir, safeId);
  if (activeSuffix) {
    return { ok: false, reason: "active-delivery-sidecar", detail: activeSuffix };
  }

  const view = revalidatedRecord.view;
  const stats = await statFileSet(hotDir, files);
  if (stats.length === 0) {
    return { ok: false, reason: "nothing-to-move" };
  }
  const newestMtimeMs = stats.reduce((max, stat) => Math.max(max, stat.mtimeMs), 0);
  if (nowMs - newestMtimeMs < quietMs) {
    return { ok: false, reason: "touched-recently" };
  }
  return { ok: true, view, stats };
}

async function revalidateRecord(
  hotDir: string,
  safeId: string,
): Promise<{ ok: true; view: ArchiveRecordView } | { ok: false; reason: string; detail?: string }> {
  const read = await readArchiveRecord(hotDir, recordFileNameFor(safeId));
  if (read.status === "unreadable") {
    return { ok: false, reason: "record-unparseable", detail: read.detail };
  }
  if (read.status === "absent") {
    return { ok: false, reason: "record-vanished" };
  }
  if (read.view.hasTemplate) {
    return { ok: false, reason: "template" };
  }
  if (read.view.favorite) {
    return { ok: false, reason: "favorite" };
  }
  return { ok: true, view: read.view };
}

/**
 * Re-stat the three ACTIVE sidecar names directly, rather than re-reading the
 * directory. This is the one member of the "file created since the plan's scan"
 * class that actually matters — a delivery arriving mid-run — and it is why
 * `revalidateBeforeApply` can honestly skip a per-id readdir.
 */
async function findActiveSidecarOnDisk(
  hotDir: string,
  safeId: string,
): Promise<string | undefined> {
  for (const suffix of ACTIVE_SIDECAR_SUFFIXES) {
    try {
      await fs.access(path.join(hotDir, `${safeId}${suffix}`));
      return suffix;
    } catch {
      // absent — the happy path
    }
  }
  return undefined;
}

/**
 * THE GHOST-ROW FIX (formats §5, BRIEF §9.1). Run ONCE per run and once per
 * restore, after all renames — never per id.
 *
 * The one-off does not touch `index.json` at all and relies on acpx's next record
 * write to reconcile. That is why rows linger, and on an IDLE box — no record
 * writes at all — they linger INDEFINITELY, which is precisely the case today's
 * behaviour never heals.
 *
 * ⚠️ THIS IS `reconcileSessionIndex`'s DROP-WITHOUT-READ PATH: it is CALLED, not
 * reimplemented. It returns the reconciled index WITHOUT writing it (membership
 * changes normally persist via the caller's own index write), so the write here is
 * required, not redundant.
 *
 * ⚠️ AND THE ARCHIVER MUST NEVER WRITE ARCHIVED SESSIONS INTO `index.json` IN ANY
 * FORM. `readSessionIndex` rejects the ENTIRE index when any single entry fails
 * `parseIndexEntry`, so a novel entry shape there costs a full-store re-parse of
 * the hot dir — the exact cost this feature exists to remove.
 */
export async function reconcileHotIndex(hotDir: string): Promise<{ drift: boolean }> {
  return await withSessionIndexLock(hotDir, async () => {
    const { index, drift } = await reconcileSessionIndex(hotDir);
    if (drift) {
      await writeSessionIndex(hotDir, index);
    }
    return { drift };
  });
}
