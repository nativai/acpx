import fs from "node:fs/promises";
import path from "node:path";
import {
  buildArchiveIndexEntry,
  listArchiveIndexShardKeys,
  mutateArchiveIndexShard,
  readArchiveIndexShard,
  shardKeyForArchivedAt,
  withArchiveIndexLock,
  type ArchiveIndexEntry,
} from "./archive-index.js";
import { claimArchiveFileSets, findRecordFile, recordFileNameFor } from "./identity.js";
import { ArchiveManifestWriter, foldArchiveManifest, type ManifestFold } from "./manifest.js";
import {
  ArchiveRefusal,
  assertSameDevice,
  buildArchiveRows,
  buildRestoreRows,
  findClobbers,
  moveFileSet,
  reconcileHotIndex,
  revalidateBeforeApply,
  statFileSet,
} from "./move.js";
import { archiveIndexDir, archiveManifestPath, sessionArchiveDirFor } from "./paths.js";
import { readArchiveRecord, type ArchiveRecordView } from "./record-view.js";
import {
  anchorIdFor,
  buildArchivePlan,
  encodeSessionSafeId,
  EMPTY_MANIFEST_VIEW,
  scanSessionDir,
  type ArchivePlan,
  type ManifestRetentionView,
  type PlannedArchive,
  type RetentionBoundaries,
} from "./retention.js";

/**
 * The verbs: archive, restore, status, list, verify, repair, reindex.
 *
 * ⚠️ NOTHING HERE DELETES. Every move is a `rename(2)`. `acpx sessions prune` is a
 * separate, explicitly-invoked destructive act with its own manifest
 * (`deletions.ndjson`); archiving MOVES, and the two verbs never share a path.
 */

export type ArchiveContext = {
  hotDir: string;
  archiveDir: string;
  nowMs: number;
  at: string;
  wave: string;
};

export function waveToken(prefix: string, nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").slice(0, 13);
  return `${prefix}-${stamp}Z`;
}

export function createContext(
  hotDir: string,
  wavePrefix: string,
  nowMs = Date.now(),
): ArchiveContext {
  return {
    hotDir,
    archiveDir: sessionArchiveDirFor(hotDir),
    nowMs,
    // ⚠️ ONE `at` FOR THE WHOLE RUN, taken once here (formats §3.2 column 1). It
    // is also the `archivedAt` every shard entry of this run carries, which is
    // what makes the shard's sort a total order only once `id` is the tiebreak.
    at: new Date(nowMs).toISOString(),
    wave: waveToken(wavePrefix, nowMs),
  };
}

export async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// archive
// ────────────────────────────────────────────────────────────────────────────────

export type ArchiveRunResult = {
  plan: ArchivePlan;
  applied: boolean;
  /** Set when D2 first-run gating forced a dry run. */
  firstRunGated: boolean;
  moved: { id: string; reason: string; files: string[]; bytes: number }[];
  skippedAtApply: { id: string; reason: string; detail?: string }[];
  failures: { id: string; file: string; error: string }[];
  indexReconciled: boolean;
  warnings: string[];
};

export type ArchiveRunOptions = {
  context: ArchiveContext;
  boundaries: RetentionBoundaries;
  plan: ArchivePlan;
  dryRun: boolean;
  /**
   * D2: the explicit opt-in that lets a FIRST run on a box apply.
   * ⚠️ A PRODUCT BEHAVIOUR, NOT AN OPERATIONAL COURTESY — see `isFirstRun`.
   */
  allowFirstRun: boolean;
};

/**
 * ⚠️ D2 — FIRST-RUN GATING IS A PRODUCT BEHAVIOUR AND MUST REFUSE TO APPLY.
 *
 * On any box where the archive dir does not yet exist, the first run is DRY-RUN
 * ONLY until an explicit opt-in. A first run on an unarchived box may move
 * thousands of ids, and the blast radius of a wrong tier boundary is maximal
 * exactly once. devbox is no longer a first-run box (the one-off created the dir),
 * so this protects THE REST OF THE FLEET — where nobody will be watching.
 *
 * ⚠️ MUST BE ASKED BEFORE ANYTHING CREATES THE DIRECTORY. `assertSameDevice`
 * mkdir's the archive dir, so calling it first would make every box look like a
 * second run and this gate would never fire anywhere.
 */
export async function isFirstRun(archiveDir: string): Promise<boolean> {
  return !(await directoryExists(archiveDir));
}

export async function planArchiveRun(
  context: ArchiveContext,
  boundaries: RetentionBoundaries,
  options: {
    includeOrphans: boolean;
    explicitIds?: readonly string[];
    limit?: number;
    liveness: Parameters<typeof buildArchivePlan>[0]["liveness"];
  },
): Promise<ArchivePlan> {
  const [scan, manifest] = await Promise.all([
    scanSessionDir(context.hotDir),
    loadManifestRetentionView(context),
  ]);
  return await buildArchivePlan({
    candidates: scan.candidates,
    orphans: scan.orphans,
    ignoredFiles: scan.ignoredFiles,
    boundaries,
    includeOrphans: options.includeOrphans,
    explicitIds: options.explicitIds,
    limit: options.limit,
    liveness: options.liveness,
    manifest,
  });
}

/**
 * The A1 end-of-life anchors and restore timestamps, folded once per run.
 *
 * ⚠️ THE COMMON CASE PAYS NOTHING. On a box that has never archived, the manifest
 * does not exist and this returns empty without reading anything — so a first run
 * has no manifest read in front of it at all. Where one does exist it is ONE fold
 * per run (measured today: 14 ms read + 26 ms fold; ~300 ms at a three-year
 * projection), not one per id.
 */
async function loadManifestRetentionView(context: ArchiveContext): Promise<ManifestRetentionView> {
  const fold = await foldArchiveManifest(context.archiveDir);
  if (fold.absent) {
    return EMPTY_MANIFEST_VIEW;
  }
  return {
    endOfLifeById: fold.firstArchiveById,
    lastRestoredAtById: fold.lastRestoredAtById,
  };
}

export async function applyArchiveRun(options: ArchiveRunOptions): Promise<ArchiveRunResult> {
  const { context, plan } = options;
  const result: ArchiveRunResult = {
    plan,
    applied: false,
    firstRunGated: false,
    moved: [],
    skippedAtApply: [],
    failures: [],
    indexReconciled: false,
    warnings: [],
  };

  const firstRun = await isFirstRun(context.archiveDir);
  if (firstRun && !options.allowFirstRun) {
    result.firstRunGated = true;
    result.warnings.push(
      // ⚠️ AN OPERATOR WHO STATED `--apply` AND GOT A DRY RUN WILL REASONABLY THINK
      // THE FLAG IS BROKEN. D2 is doing exactly its job here, but the output has to
      // say SO, and name the second opt-in — otherwise closing one
      // confident-wrong-impression opens another.
      `--apply was honoured, but D2 first-run gating held it: no archive directory exists yet at ${context.archiveDir}, so this is this box's FIRST run and nothing was moved. The plan above is what WOULD move. Re-run with --apply --allow-first-run (or set ACPX_ARCHIVE_ALLOW_FIRST_RUN=1) to apply it.`,
    );
    return result;
  }
  if (options.dryRun) {
    return result;
  }

  await assertSameDevice(context.hotDir, context.archiveDir);

  const writer = await ArchiveManifestWriter.open(context.archiveDir, context.at, context.wave);
  const shardEntries: ArchiveIndexEntry[] = [];
  try {
    for (const planned of plan.selected) {
      const entry = await archiveOneId(context, writer, planned, options.boundaries, result);
      if (entry) {
        shardEntries.push(entry);
      }
    }
  } finally {
    await writer.close();
  }

  await writeShardEntries(context, shardEntries, result.warnings);
  result.indexReconciled = (await reconcileHotIndex(context.hotDir)).drift;
  result.applied = true;
  return result;
}

async function archiveOneId(
  context: ArchiveContext,
  writer: ArchiveManifestWriter,
  planned: PlannedArchive,
  boundaries: RetentionBoundaries,
  result: ArchiveRunResult,
): Promise<ArchiveIndexEntry | undefined> {
  const { candidate } = planned;

  // Steps 1-2 of formats §6: stat, then re-validate against the LIVE record.
  const revalidated = await revalidateBeforeApply(
    context.hotDir,
    candidate.safeId,
    candidate.files,
    candidate.recordStatus === "ok",
    boundaries.quietMs,
    Date.now(),
  );
  if (!revalidated.ok) {
    result.skippedAtApply.push({
      id: candidate.id,
      reason: revalidated.reason,
      detail: revalidated.detail,
    });
    return undefined;
  }

  // Step 3: no-clobber. Never overwrite; skip instead.
  const clobbers = await findClobbers(
    context.archiveDir,
    revalidated.stats.map((stat) => stat.file),
  );
  if (clobbers.length > 0) {
    result.skippedAtApply.push({
      id: candidate.id,
      reason: "already-at-destination",
      detail: clobbers.slice(0, 3).join(", "),
    });
    return undefined;
  }

  // Step 4: WRITE-AHEAD. The row block is on disk before the first rename.
  const rows = buildArchiveRows(
    writer,
    candidate.id,
    planned.reason,
    revalidated.view,
    revalidated.stats,
  );
  await writer.appendIdBlock(rows);

  // Steps 5-6: sidecars, then the record LAST.
  const outcome = await moveFileSet(
    context.hotDir,
    context.archiveDir,
    candidate.safeId,
    revalidated.stats.map((stat) => stat.file),
  );
  for (const failure of outcome.failed) {
    result.failures.push({ id: candidate.id, ...failure });
  }
  const bytes = revalidated.stats.reduce((sum, stat) => sum + stat.bytes, 0);
  result.moved.push({
    id: candidate.id,
    reason: planned.reason,
    files: outcome.moved,
    bytes,
  });

  // ⚠️ ORPHANS GET NO INDEX ENTRY — there is no record to project. They are
  // auditable via MANIFEST.tsv and restorable by id, and surfaced only in
  // aggregate; 1,792 meaningless rows in the archived list is not a list.
  if (!revalidated.view) {
    return undefined;
  }
  return indexEntryFor(context, planned, revalidated.view, outcome.moved.length, bytes);
}

function indexEntryFor(
  context: ArchiveContext,
  planned: PlannedArchive,
  view: ArchiveRecordView,
  files: number,
  bytes: number,
): ArchiveIndexEntry {
  return buildArchiveIndexEntry({
    ...projectIndexFields(view),
    id: planned.candidate.id,
    archivedAt: context.at,
    reason: planned.reason,
    wave: context.wave,
    files,
    bytes,
  });
}

async function writeShardEntries(
  context: ArchiveContext,
  entries: readonly ArchiveIndexEntry[],
  warnings: string[],
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const byShard = groupByShard(entries);
  await withArchiveIndexLock(context.archiveDir, async () => {
    for (const [shardKey, shardEntries] of byShard) {
      await mutateArchiveIndexShard(
        context.archiveDir,
        shardKey,
        { upsert: shardEntries },
        context.at,
        (message) => warnings.push(message),
      );
    }
  });
}

function groupByShard(entries: readonly ArchiveIndexEntry[]): Map<string, ArchiveIndexEntry[]> {
  const byShard = new Map<string, ArchiveIndexEntry[]>();
  for (const entry of entries) {
    const key = shardKeyForArchivedAt(entry.archivedAt);
    const bucket = byShard.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      byShard.set(key, [entry]);
    }
  }
  return byShard;
}

// ────────────────────────────────────────────────────────────────────────────────
// restore
// ────────────────────────────────────────────────────────────────────────────────

export type RestoreResult = {
  restored: { id: string; files: string[]; bytes: number }[];
  skipped: { id: string; reason: string; detail?: string }[];
  warnings: string[];
  indexReconciled: boolean;
};

export async function runRestore(
  context: ArchiveContext,
  ids: readonly string[],
): Promise<RestoreResult> {
  const result: RestoreResult = {
    restored: [],
    skipped: [],
    warnings: [],
    indexReconciled: false,
  };
  if (!(await directoryExists(context.archiveDir))) {
    throw new ArchiveRefusal(
      `no archive directory at ${context.archiveDir} — nothing has been archived on this box`,
      "no-archive",
    );
  }
  await assertSameDevice(context.hotDir, context.archiveDir);

  const archiveFiles = await fs.readdir(context.archiveDir);
  const fileSets = claimArchiveFileSets(archiveFiles);
  const ordered = await orderRestoreSet(context, ids, fileSets, result.warnings);

  const writer = await ArchiveManifestWriter.open(context.archiveDir, context.at, context.wave);
  try {
    for (const safeId of ordered) {
      await restoreOneId(context, writer, safeId, fileSets.get(safeId) ?? [], result);
    }
  } finally {
    await writer.close();
  }

  await removeShardEntries(
    context,
    result.restored.map((entry) => entry.id),
    result.warnings,
  );
  result.indexReconciled = (await reconcileHotIndex(context.hotDir)).drift;
  return result;
}

/**
 * ⚠️ ON RESTORE, ANCHORS GO FIRST — THE EXACT REVERSE OF THE ARCHIVE ORDERING, AND
 * FOR THE SAME REASON.
 *
 * On the way out, the anchor's DEPARTURE arms acpx-ui's 5-minute
 * `sweepOrphanByways` hard-delete, so the anchor must leave last. On the way back,
 * the companion's ARRIVAL is what exposes it to that sweep — a byway sitting in the
 * hot dir whose anchor is still in the archive does not resolve, and is
 * hard-deleted within five minutes. So the anchor must arrive first.
 *
 * 🛑 SPEC GAP, REPORTED UPSTREAM, NOT SILENTLY REINTERPRETED: conception §6.2 and
 * §9.2 specify companion handling for the ARCHIVE direction only. This ordering
 * and the warning below are the conservative mirror. The residual it cannot fix:
 * restoring a byway while deliberately leaving its anchor archived is a request
 * this code cannot make safe, so it warns loudly rather than refusing — refusing
 * would block a legitimate operator, and silence would destroy the byway.
 */
async function orderRestoreSet(
  context: ArchiveContext,
  ids: readonly string[],
  fileSets: ReadonlyMap<string, string[]>,
  warnings: string[],
): Promise<string[]> {
  const safeIds = ids.map((id) => encodeSessionSafeId(id));
  const requested = new Set(safeIds);
  const anchors = new Map<string, string>();

  for (const safeId of safeIds) {
    const files = fileSets.get(safeId);
    if (!files) {
      continue;
    }
    const recordFile = findRecordFile(safeId, files);
    if (!recordFile) {
      continue;
    }
    const read = await readArchiveRecord(context.archiveDir, recordFile);
    if (read.status !== "ok") {
      continue;
    }
    const anchorId = companionAnchorOf(read.view);
    if (anchorId == null) {
      continue;
    }
    anchors.set(safeId, encodeSessionSafeId(anchorId));
    await warnIfAnchorStaysArchived(context, anchorId, requested, warnings, read.view.id ?? safeId);
  }

  return safeIds.toSorted((a, b) => {
    if (anchors.get(b) === a) {
      return -1;
    }
    return anchors.get(a) === b ? 1 : 0;
  });
}

function companionAnchorOf(view: ArchiveRecordView): string | undefined {
  if (!view.isByway && view.kind !== "subagent") {
    return undefined;
  }
  return anchorIdFor(view);
}

async function warnIfAnchorStaysArchived(
  context: ArchiveContext,
  anchorId: string,
  requested: ReadonlySet<string>,
  warnings: string[],
  companionId: string,
): Promise<void> {
  const anchorSafeId = encodeSessionSafeId(anchorId);
  if (requested.has(anchorSafeId)) {
    return;
  }
  const anchorHot = await fileExists(path.join(context.hotDir, recordFileNameFor(anchorSafeId)));
  if (anchorHot) {
    return;
  }
  warnings.push(
    `${companionId} is a byway/subagent of ${anchorId}, which is NOT being restored and is not in the hot dir. acpx-ui's sweepOrphanByways HARD-DELETES a byway whose anchor does not resolve, on a 5-minute cadence. Restore ${anchorId} as well, or expect ${companionId} to be destroyed.`,
  );
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function restoreOneId(
  context: ArchiveContext,
  writer: ArchiveManifestWriter,
  safeId: string,
  files: readonly string[],
  result: RestoreResult,
): Promise<void> {
  if (files.length === 0) {
    result.skipped.push({ id: safeId, reason: "not-in-archive" });
    return;
  }
  const clobbers = await findClobbers(context.hotDir, files);
  if (clobbers.length > 0) {
    result.skipped.push({
      id: safeId,
      reason: "already-in-hot-dir",
      detail: clobbers.slice(0, 3).join(", "),
    });
    return;
  }
  const stats = await statFileSet(context.archiveDir, files);
  if (stats.length === 0) {
    result.skipped.push({ id: safeId, reason: "nothing-to-move" });
    return;
  }

  const id = await resolveRestoredId(context, safeId, files);
  // Write-ahead, same contract as the archive direction.
  await writer.appendIdBlock(buildRestoreRows(writer, id, stats));

  // ⚠️ RECORD LAST HERE TOO. The id becomes visible to every reader the instant
  // `<id>.json` lands, so it must land only once its transcript is already beside
  // it — otherwise the restore has its own truncated-transcript window.
  const outcome = await moveFileSet(
    context.archiveDir,
    context.hotDir,
    safeId,
    stats.map((stat) => stat.file),
  );
  result.restored.push({
    id,
    files: outcome.moved,
    bytes: stats.reduce((sum, stat) => sum + stat.bytes, 0),
  });
}

async function resolveRestoredId(
  context: ArchiveContext,
  safeId: string,
  files: readonly string[],
): Promise<string> {
  const recordFile = findRecordFile(safeId, files);
  if (!recordFile) {
    return safeId;
  }
  const read = await readArchiveRecord(context.archiveDir, recordFile);
  return read.status === "ok" ? (read.view.id ?? safeId) : safeId;
}

async function removeShardEntries(
  context: ArchiveContext,
  ids: readonly string[],
  warnings: string[],
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const shardKeys = await listArchiveIndexShardKeys(context.archiveDir);
  await withArchiveIndexLock(context.archiveDir, async () => {
    for (const shardKey of shardKeys) {
      await mutateArchiveIndexShard(
        context.archiveDir,
        shardKey,
        { remove: ids },
        context.at,
        (message) => warnings.push(message),
      );
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────────
// status / list
// ────────────────────────────────────────────────────────────────────────────────

export type ArchiveStatus = {
  hotDir: string;
  archiveDir: string;
  archiveExists: boolean;
  hot: { files: number; bytes: number };
  archive: { files: number; bytes: number; ids: number };
  orphans: { ids: number };
  manifest: { rows: number; skippedRows: number; absent: boolean };
  shards: string[];
};

export async function archiveStatus(context: ArchiveContext): Promise<ArchiveStatus> {
  const archiveExists = await directoryExists(context.archiveDir);
  const [hot, archive] = await Promise.all([
    measureDir(context.hotDir),
    archiveExists ? measureDir(context.archiveDir) : Promise.resolve({ files: 0, bytes: 0 }),
  ]);
  const fold = archiveExists
    ? await foldArchiveManifest(context.archiveDir)
    : { totalRows: 0, skippedRows: 0, absent: true };
  const fileSets = archiveExists
    ? claimArchiveFileSets(await fs.readdir(context.archiveDir))
    : new Map<string, string[]>();

  const orphanIds = collectOrphanFileSets(fileSets).length;

  return {
    hotDir: context.hotDir,
    archiveDir: context.archiveDir,
    archiveExists,
    hot,
    archive: { ...archive, ids: fileSets.size },
    // ⚠️ AGGREGATE ONLY, NEVER A LIST. An orphan has no record, so no name, cwd,
    // agent or brick — nothing a user could act on. `--list-orphans` exists for an
    // operator who genuinely wants the ids.
    orphans: { ids: orphanIds },
    manifest: { rows: fold.totalRows, skippedRows: fold.skippedRows, absent: fold.absent },
    shards: archiveExists ? await listArchiveIndexShardKeys(context.archiveDir) : [],
  };
}

export type ArchivedOrphan = { id: string; files: string[] };

/**
 * THE orphan test on the archive side: an archived id with NO record file.
 *
 * ⚠️ ONE FUNCTION, TWO CALLERS, ON PURPOSE. `--status` reports the orphan COUNT
 * and `--list-orphans` reports the IDS; if those two derived the population
 * separately they could disagree, and the count is exactly what sends an operator
 * looking for the ids. Orphan membership goes through `findRecordFile` — the same
 * single record-presence predicate the ingest path uses.
 */
function collectOrphanFileSets(fileSets: ReadonlyMap<string, string[]>): ArchivedOrphan[] {
  const orphans: ArchivedOrphan[] = [];
  for (const [safeId, files] of fileSets) {
    if (findRecordFile(safeId, files) == null) {
      orphans.push({ id: safeId, files });
    }
  }
  return orphans.toSorted((a, b) => a.id.localeCompare(b.id));
}

/**
 * The ids behind `--status`'s orphan count.
 *
 * 🛑 THIS CANNOT BE SERVED FROM THE SHARD INDEX, AND THAT IS WHY THE FLAG WAS DEAD.
 * An orphan has no record to project, so by design it gets NO `ARCHIVE-INDEX`
 * entry (formats §4.3). `listArchived` reads the shards — so routing
 * `--list-orphans` through it returned the list of everything that is NOT an
 * orphan, exited 0, and named no orphan ever. It has to read the DIRECTORY.
 *
 * Ids only, deliberately: there is no record, therefore no name, kind, cwd or
 * closed state to table. The one thing an operator can do with an orphan is
 * restore it by exact id, and `acpx sessions restore` takes exactly that — so
 * this output pipes straight into it.
 */
export async function listArchivedOrphans(
  context: ArchiveContext,
  options: { limit?: number } = {},
): Promise<{ orphans: ArchivedOrphan[]; totalIds: number; files: number; bytes: number }> {
  const fileSets = claimArchiveFileSets(await fs.readdir(context.archiveDir));
  const all = collectOrphanFileSets(fileSets);
  const stats = await Promise.all(
    all.map(async (orphan) => await statFileSet(context.archiveDir, orphan.files)),
  );
  return {
    orphans: options.limit == null ? all : all.slice(0, options.limit),
    // ⚠️ The totals cover EVERY orphan, not just the page `--limit` returned —
    // otherwise `--limit 10` would silently redefine what the archive contains.
    totalIds: all.length,
    files: stats.reduce((sum, fileStats) => sum + fileStats.length, 0),
    bytes: stats.reduce(
      (sum, fileStats) => sum + fileStats.reduce((inner, stat) => inner + stat.bytes, 0),
      0,
    ),
  };
}

async function measureDir(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  await Promise.all(
    dirents
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        try {
          const stat = await fs.stat(path.join(dir, entry.name));
          files += 1;
          bytes += stat.size;
        } catch {
          // vanished mid-scan
        }
      }),
  );
  return { files, bytes };
}

export async function listArchived(
  context: ArchiveContext,
  options: { month?: string; limit?: number } = {},
): Promise<{ entries: ArchiveIndexEntry[]; shards: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const shardKeys = options.month
    ? [options.month]
    : await listArchiveIndexShardKeys(context.archiveDir);
  const entries: ArchiveIndexEntry[] = [];
  for (const shardKey of shardKeys) {
    const read = await readArchiveIndexShard(context.archiveDir, shardKey);
    if (read.status === "ok") {
      entries.push(...read.shard.entries);
      continue;
    }
    if (read.status === "corrupt") {
      // ⚠️ DEGRADED, NEVER WRONG. A bad shard costs its own month and nothing
      // else; the other months still serve. The index is a cache — the files are
      // truth — so `--reindex` rebuilds this without data loss.
      warnings.push(
        `shard ${shardKey} unreadable (${read.detail}) — run 'acpx sessions archive --reindex --month ${shardKey}'`,
      );
    }
  }
  const limited = options.limit == null ? entries : entries.slice(0, options.limit);
  return { entries: limited, shards: shardKeys, warnings };
}

// ────────────────────────────────────────────────────────────────────────────────
// verify / repair
// ────────────────────────────────────────────────────────────────────────────────

export type VerifyProblem = {
  file: string;
  id: string;
  expected: "archive" | "hot";
  found: "archive" | "hot" | "neither";
};

export async function verifyArchive(
  context: ArchiveContext,
): Promise<{ checked: number; problems: VerifyProblem[]; fold: ManifestFold }> {
  const fold = await foldArchiveManifest(context.archiveDir);
  const problems: VerifyProblem[] = [];
  for (const entry of fold.lastByFile.values()) {
    const found = await locateFile(context, entry.file);
    const expected = entry.action === "archive" ? "archive" : "hot";
    if (found !== expected) {
      problems.push({ file: entry.file, id: entry.id, expected, found });
    }
  }
  return { checked: fold.lastByFile.size, problems, fold };
}

/**
 * ⚠️ UNAMBIGUOUS BY CONSTRUCTION: filenames are unique across the two
 * directories, so a file named in an `archive` row is in the archive (done), in
 * the hot dir (interrupted), or in neither (LOST — report loudly). No state has to
 * be reconstructed, which is exactly what write-ahead journalling buys.
 */
async function locateFile(
  context: ArchiveContext,
  file: string,
): Promise<"archive" | "hot" | "neither"> {
  if (await fileExists(path.join(context.archiveDir, file))) {
    return "archive";
  }
  return (await fileExists(path.join(context.hotDir, file))) ? "hot" : "neither";
}

export type RepairResult = {
  completed: { file: string; direction: "to-archive" | "to-hot" }[];
  lost: string[];
  indexReconciled: boolean;
  reindexedMonths: string[];
  warnings: string[];
};

/**
 * `--repair` — IDEMPOTENT, AND SAFE TO RUN AT ANY TIME INCLUDING CONCURRENTLY WITH
 * A NORMAL RUN. The per-id no-clobber check and the per-id journal block make the
 * two commute.
 *
 * ⚠️ RUN IT AT ARCHIVER STARTUP, BEFORE ANY NEW WORK. A crash between a companion
 * and its anchor is the one path with real data-loss exposure, and the 5-minute
 * sweep cadence is the window this closes. It is a mitigation, not the primary
 * defence — that is the companions-before-anchors ordering.
 */
export async function repairArchive(context: ArchiveContext): Promise<RepairResult> {
  const result: RepairResult = {
    completed: [],
    lost: [],
    indexReconciled: false,
    reindexedMonths: [],
    warnings: [],
  };
  const fold = await foldArchiveManifest(context.archiveDir);
  if (fold.absent) {
    return result;
  }
  await assertSameDevice(context.hotDir, context.archiveDir);

  const touchedMonths = new Set<string>();
  for (const entry of fold.lastByFile.values()) {
    const found = await locateFile(context, entry.file);
    if (found === "neither") {
      result.lost.push(entry.file);
      continue;
    }
    const target = entry.action === "archive" ? "archive" : "hot";
    if (found === target) {
      continue;
    }
    await completeRename(context, entry.file, target, result);
    touchedMonths.add(shardKeyForArchivedAt(entry.at));
  }

  result.indexReconciled = (await reconcileHotIndex(context.hotDir)).drift;
  for (const month of touchedMonths) {
    await reindexArchive(context, { month, warnings: result.warnings });
    result.reindexedMonths.push(month);
  }
  return result;
}

async function completeRename(
  context: ArchiveContext,
  file: string,
  target: "archive" | "hot",
  result: RepairResult,
): Promise<void> {
  const from = target === "archive" ? context.hotDir : context.archiveDir;
  const to = target === "archive" ? context.archiveDir : context.hotDir;
  try {
    await fs.rename(path.join(from, file), path.join(to, file));
    result.completed.push({ file, direction: target === "archive" ? "to-archive" : "to-hot" });
  } catch (error) {
    result.warnings.push(
      `could not complete ${file} -> ${target}: ${(error as NodeJS.ErrnoException).code ?? "rename-failed"}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// reindex
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild shards from the archive dir itself.
 *
 * ⚠️ THIS IS ALSO THE MIGRATION, AND THAT IS THE POINT (formats §4.6). The one-off
 * left an archive with files and a manifest and NO index. The rebuild path has to
 * exist anyway for corruption recovery, so the first run simply runs it — ONE code
 * path, not a migration plus a recovery path.
 */
export async function reindexArchive(
  context: ArchiveContext,
  options: { month?: string; warnings?: string[] } = {},
): Promise<{ months: string[]; entries: number }> {
  const warnings = options.warnings ?? [];
  const files = await fs.readdir(context.archiveDir);
  const fileSets = claimArchiveFileSets(files);
  const fold = await foldArchiveManifest(context.archiveDir);

  const byShard = new Map<string, ArchiveIndexEntry[]>();
  for (const [safeId, fileSet] of fileSets) {
    const entry = await rebuildEntry(context, safeId, fileSet, fold);
    if (!entry) {
      continue;
    }
    const shardKey = shardKeyForArchivedAt(entry.archivedAt);
    if (options.month != null && shardKey !== options.month) {
      continue;
    }
    const bucket = byShard.get(shardKey);
    if (bucket) {
      bucket.push(entry);
    } else {
      byShard.set(shardKey, [entry]);
    }
  }

  await withArchiveIndexLock(context.archiveDir, async () => {
    await fs.mkdir(archiveIndexDir(context.archiveDir), { recursive: true });
    for (const [shardKey, entries] of byShard) {
      // A full rebuild REPLACES the shard: remove-then-upsert is not enough,
      // because an entry that should no longer exist must not survive.
      await replaceShard(context, shardKey, entries, warnings);
    }
  });

  return {
    months: [...byShard.keys()],
    entries: [...byShard.values()].reduce((sum, entries) => sum + entries.length, 0),
  };
}

async function replaceShard(
  context: ArchiveContext,
  shardKey: string,
  entries: readonly ArchiveIndexEntry[],
  warnings: string[],
): Promise<void> {
  const existing = await readArchiveIndexShard(context.archiveDir, shardKey);
  if (existing.status === "ok") {
    await mutateArchiveIndexShard(
      context.archiveDir,
      shardKey,
      { remove: existing.shard.entries.map((entry) => entry.id), upsert: entries },
      context.at,
      (message) => warnings.push(message),
    );
    return;
  }
  await mutateArchiveIndexShard(
    context.archiveDir,
    shardKey,
    { upsert: entries },
    context.at,
    (message) => warnings.push(message),
  );
}

/**
 * ⚠️ `archivedAt` COMES FROM THE LAST `archive` ROW FOR THIS ID IN `MANIFEST.tsv`,
 * FALLING BACK TO THE RECORD FILE'S MTIME when the manifest has no row — the
 * pre-manifest era, or a file an operator hand-moved. WITHOUT THE FALLBACK THOSE
 * IDS SILENTLY VANISH FROM EVERY LIST: no `archivedAt` means no shard, and a
 * session sitting in the archive that no list can show is indistinguishable from
 * one that was lost.
 *
 * `rename(2)` preserves mtime, so the fallback is meaningful: a file that moved
 * into the archive still carries the mtime it had in the hot dir.
 */
function resolveArchivedAt(
  context: ArchiveContext,
  id: string,
  recordFile: string,
  stats: readonly { file: string; mtimeMs: number }[],
  fold: ManifestFold,
): string {
  const fromManifest = fold.lastArchivedAtById.get(id) ?? fold.lastByFile.get(recordFile)?.at;
  if (fromManifest != null && fromManifest.length > 0) {
    return fromManifest;
  }
  const mtimeMs = stats.find((stat) => stat.file === recordFile)?.mtimeMs ?? context.nowMs;
  return new Date(mtimeMs).toISOString();
}

async function rebuildEntry(
  context: ArchiveContext,
  safeId: string,
  fileSet: readonly string[],
  fold: ManifestFold,
): Promise<ArchiveIndexEntry | undefined> {
  const recordFile = findRecordFile(safeId, fileSet);
  if (!recordFile) {
    // Orphan: no record to project, so no entry — same rule as a live run.
    return undefined;
  }
  const read = await readArchiveRecord(context.archiveDir, recordFile);
  if (read.status !== "ok") {
    return undefined;
  }
  const stats = await statFileSet(context.archiveDir, fileSet);
  const id = read.view.id ?? safeId;
  const manifestRow = fold.lastByFile.get(recordFile);

  return buildArchiveIndexEntry({
    ...projectIndexFields(read.view),
    id,
    archivedAt: resolveArchivedAt(context, id, recordFile, stats, fold),
    reason: manifestRow?.reason ?? "unknown",
    wave: manifestRow?.wave ?? "reindex",
    files: stats.length,
    bytes: stats.reduce((sum, stat) => sum + stat.bytes, 0),
  });
}

/**
 * The record-derived half of a shard entry — shared by the live archive path and
 * the reindex path so the two cannot drift.
 *
 * ⚠️ A REBUILT SHARD MUST BE BYTE-IDENTICAL TO THE ONE THE LIVE RUN WROTE
 * (AC-11), which is only true if both sides project the same fields from the same
 * record. Two independent field lists is exactly how that silently stops holding.
 */
function projectIndexFields(view: ArchiveRecordView): Partial<ArchiveIndexEntry> {
  return {
    kind: view.kind,
    // ⚠️ NOT clean()'ed — the shard carries the faithful, JSON-escaped value.
    // Only MANIFEST.tsv's column 10 is lossy.
    name: view.name,
    cwd: view.cwd,
    agentName: view.agentName,
    brick: view.brick,
    // ⚠️ FAITHFUL, INCLUDING FOR A NOT-CLOSED (T3) ENTRY: archive-in-place means
    // `closed` is whatever it was at archive time, so a T3 entry is archived with
    // `closed:false` and an EMPTY `closedAt`. That is what lets the UI badge it
    // distinctly and warn that restoring returns it open-but-ownerless.
    closed: view.closed,
    closedAt: view.closedAt,
    lastUsedAt: view.lastUsedAt ?? view.updatedAt ?? view.createdAt,
    createdAt: view.createdAt,
    // ⚠️ `lastSeq` IS AN EVENT SEQUENCE, NOT A MESSAGE COUNT — never label it as
    // one. There is deliberately no messageCount: producing one means reading every
    // <id>.messages.ndjson in full (1,668 files, multi-MB each) at archive time.
    lastSeq: view.lastSeq,
  };
}

export { archiveManifestPath, sessionArchiveDirFor };
