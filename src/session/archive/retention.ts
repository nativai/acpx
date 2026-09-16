import fs from "node:fs/promises";
import path from "node:path";
import {
  claimFileSets,
  claimOrphanFileSets,
  encodeSessionSafeId,
  findRecordFile,
  hasActiveSidecar,
  isHostileFileName,
  recordFileNameFor,
} from "./identity.js";
import { evaluateLiveness, type LivenessGateOptions } from "./liveness.js";
import { projectArchiveRecord, recordAgeAnchor, type ArchiveRecordView } from "./record-view.js";

/**
 * The retention predicate and the plan it produces — BRIEF §6.
 */

export type ArchiveTier = "closed" | "subagent" | "stale" | "orphan" | "companion" | "manual";

export type ArchiveBlocker =
  | "template"
  | "favorite"
  | "active-delivery-sidecar"
  | "record-unparseable"
  | "touched-recently"
  | "hostile-filename"
  | "live"
  | "anchor-of-blocked-companion";

export type ArchiveCandidate = {
  /** `$.acpx_record_id` when a record exists; the filename token otherwise. */
  id: string;
  /** `encodeURIComponent(id)` — what the files are actually named after. */
  safeId: string;
  files: string[];
  bytes: number;
  /** Per-file mtimes, so the age anchor can CHOOSE which files count. */
  fileMtimes: ReadonlyMap<string, number>;
  /** `max(mtime)` over the WHOLE file set — the QUIET-WINDOW signal (see below). */
  newestMtimeMs: number;
  record?: ArchiveRecordView;
  recordStatus: "ok" | "absent" | "unreadable";
  recordDetail?: string;
};

export type PlannedArchive = {
  candidate: ArchiveCandidate;
  tier: ArchiveTier;
  reason: string;
};

export type BlockedArchive = {
  candidate: ArchiveCandidate;
  blocker: ArchiveBlocker;
  detail?: string;
};

export type DroppedAnchor = {
  anchorId: string;
  companionId: string;
  companionBlocker: ArchiveBlocker;
};

export type ArchivePlan = {
  /** Ordered: COMPANIONS BEFORE THEIR ANCHORS. See `orderForApply`. */
  selected: PlannedArchive[];
  blocked: BlockedArchive[];
  droppedAnchors: DroppedAnchor[];
  /** Files that are not session files at all (reserved names, non-session JSON). */
  ignoredFiles: string[];
  /** Orphans are reported in AGGREGATE, never listed individually (BRIEF §6.7). */
  orphanAggregate: { ids: number; files: number; bytes: number };
  boundaries: RetentionBoundaries;
  /** True when the wakeups store exists but could not be read — every id is LIVE. */
  livenessDegraded: boolean;
};

export type RetentionBoundaries = {
  closedBeforeMs: number;
  subagentsBeforeMs: number;
  staleBeforeMs: number;
  orphansBeforeMs: number;
  quietMs: number;
  nowMs: number;
};

export const DEFAULT_CLOSED_DAYS = 14;
export const DEFAULT_SUBAGENT_DAYS = 14;
/**
 * ⚠️ 45, NOT 14, AND THE TWO ARE NOT INTERCHANGEABLE. The not-closed histogram has
 * a cliff: `[30,45)` = 47 sessions, then `[45,60)` = 385. 45 sits exactly at it —
 * below the mass of dead sessions, above anything plausibly live. Wiring this tier
 * to the 14 d closed boundary is caught by exactly two rig cohorts
 * (`NOTCLOSED-minus10d`, `NOTCLOSED-minus25d`) and by nothing else.
 */
export const DEFAULT_STALE_DAYS = 45;
export const DEFAULT_ORPHAN_DAYS = 14;
export const DEFAULT_QUIET_MINUTES = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveBoundaries(
  nowMs: number,
  overrides: {
    closedBefore?: number | string;
    subagentsBefore?: number | string;
    staleBefore?: number | string;
    orphansBefore?: number | string;
    quietMinutes?: number;
  } = {},
): RetentionBoundaries {
  return {
    nowMs,
    closedBeforeMs: resolveBoundary(nowMs, overrides.closedBefore, DEFAULT_CLOSED_DAYS),
    subagentsBeforeMs: resolveBoundary(nowMs, overrides.subagentsBefore, DEFAULT_SUBAGENT_DAYS),
    staleBeforeMs: resolveBoundary(nowMs, overrides.staleBefore, DEFAULT_STALE_DAYS),
    orphansBeforeMs: resolveBoundary(nowMs, overrides.orphansBefore, DEFAULT_ORPHAN_DAYS),
    quietMs: (overrides.quietMinutes ?? DEFAULT_QUIET_MINUTES) * 60 * 1000,
  };
}

function resolveBoundary(
  nowMs: number,
  value: number | string | undefined,
  defaultDays: number,
): number {
  if (typeof value === "string") {
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const days = typeof value === "number" ? value : defaultDays;
  return nowMs - days * DAY_MS;
}

export function boundaryDateToken(boundaryMs: number): string {
  return new Date(boundaryMs).toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────────────
// Scanning
// ────────────────────────────────────────────────────────────────────────────────

type ScanTables = {
  files: string[];
  stats: Map<string, { bytes: number; mtimeMs: number }>;
  recordViews: Map<string, ArchiveRecordView>;
  unreadableRecords: Map<string, string>;
};

async function statAllFiles(
  hotDir: string,
  files: readonly string[],
): Promise<Map<string, { bytes: number; mtimeMs: number }>> {
  const stats = new Map<string, { bytes: number; mtimeMs: number }>();
  await Promise.all(
    files.map(async (file) => {
      try {
        const stat = await fs.stat(path.join(hotDir, file));
        stats.set(file, { bytes: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // Vanished between readdir and stat — a live session churning its own
        // sidecars. Absent from `stats` means it contributes no bytes and no
        // mtime; the apply-time re-stat is what actually decides.
      }
    }),
  );
  return stats;
}

/**
 * ⚠️ ENUMERATE IDS FROM RECORDS, NOT FROM FILENAMES (formats §2 C2.3 rule 1).
 * Every `<x>.json` that parses as a session record contributes its filename token
 * as a candidate; nothing else does. This is what gives the longest-prefix
 * claiming rule something authoritative to be longest against — without it the
 * `ID-PREFIX-*` case (one real id a strict prefix of another) has no correct
 * answer available at all, and the longer id's files are archived under the
 * shorter session.
 */
async function readRecordCandidates(
  hotDir: string,
  files: readonly string[],
): Promise<Pick<ScanTables, "recordViews" | "unreadableRecords">> {
  const recordViews = new Map<string, ArchiveRecordView>();
  const unreadableRecords = new Map<string, string>();
  await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const token = file.slice(0, -".json".length);
        if (token.length === 0) {
          return;
        }
        const outcome = await readRecordToken(hotDir, file);
        if (outcome.view) {
          recordViews.set(token, outcome.view);
        } else if (outcome.detail) {
          unreadableRecords.set(token, outcome.detail);
        }
      }),
  );
  return { recordViews, unreadableRecords };
}

async function readRecordToken(
  hotDir: string,
  file: string,
): Promise<{ view?: ArchiveRecordView; detail?: string }> {
  let payload: string;
  try {
    payload = await fs.readFile(path.join(hotDir, file), "utf8");
  } catch (error) {
    return { detail: (error as NodeJS.ErrnoException).code ?? "read-failed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    return { detail: "invalid-json" };
  }
  const view = projectArchiveRecord(parsed);
  // Not a session record (`<id>.delivery.json`, `brick-remote-links.json`): not a
  // candidate id, and not an unreadable record either — it is simply a file that
  // some other id's prefix will claim, or that the reserved rule will ignore.
  return view ? { view } : {};
}

/**
 * A `<token>.json` that is present but unreadable must become a candidate so it
 * can be BLOCKED as `record-unparseable`. Left out, its sidecars fall through to
 * the orphan policy and a session whose record merely failed to parse gets swept
 * as residue — the worst outcome this feature can produce. The ingest shape guard
 * is applied here and ONLY here, because this is the one branch where nothing can
 * tell us whether the file was ever a session record.
 */
function candidateIdsFrom(
  tables: Pick<ScanTables, "recordViews" | "unreadableRecords">,
): Set<string> {
  const candidates = new Set(tables.recordViews.keys());
  for (const token of tables.unreadableRecords.keys()) {
    if (candidates.has(token)) {
      continue;
    }
    const { orphans } = claimOrphanFileSets([recordFileNameFor(token)]);
    if (orphans.has(token)) {
      candidates.add(token);
    }
  }
  return candidates;
}

function makeCandidate(
  safeId: string,
  fileSet: string[],
  view: ArchiveRecordView | undefined,
  status: ArchiveCandidate["recordStatus"],
  stats: ReadonlyMap<string, { bytes: number; mtimeMs: number }>,
  detail?: string,
): ArchiveCandidate {
  let bytes = 0;
  let newestMtimeMs = 0;
  const fileMtimes = new Map<string, number>();
  for (const file of fileSet) {
    const stat = stats.get(file);
    if (!stat) {
      continue;
    }
    bytes += stat.bytes;
    fileMtimes.set(file, stat.mtimeMs);
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
  }
  return {
    id: view?.id ?? decodeSafeIdForDisplay(safeId),
    safeId,
    files: fileSet,
    bytes,
    fileMtimes,
    newestMtimeMs,
    record: view,
    recordStatus: status,
    recordDetail: detail,
  };
}

function decodeSafeIdForDisplay(safeId: string): string {
  try {
    return decodeURIComponent(safeId);
  } catch {
    return safeId;
  }
}

/** Scan a hot dir into candidates, orphans and non-session files. */
export async function scanSessionDir(hotDir: string): Promise<{
  candidates: ArchiveCandidate[];
  orphans: ArchiveCandidate[];
  ignoredFiles: string[];
}> {
  const dirents = await fs.readdir(hotDir, { withFileTypes: true });
  const files = dirents.filter((entry) => entry.isFile()).map((entry) => entry.name);

  const [stats, recordTables] = await Promise.all([
    statAllFiles(hotDir, files),
    readRecordCandidates(hotDir, files),
  ]);

  const { claimed, unclaimed } = claimFileSets(files, candidateIdsFrom(recordTables));
  const { orphans: orphanSets, ignored } = claimOrphanFileSets(unclaimed);

  const candidates: ArchiveCandidate[] = [];
  for (const [safeId, fileSet] of claimed) {
    const view = recordTables.recordViews.get(safeId);
    candidates.push(
      view
        ? makeCandidate(safeId, fileSet, view, "ok", stats)
        : makeCandidate(
            safeId,
            fileSet,
            undefined,
            "unreadable",
            stats,
            recordTables.unreadableRecords.get(safeId) ?? "unreadable",
          ),
    );
  }

  const orphans: ArchiveCandidate[] = [];
  for (const [safeId, fileSet] of orphanSets) {
    // Belt and braces with the claim phase: an orphan is an id with NO record
    // file, and that judgement goes through the one record-presence helper.
    if (findRecordFile(safeId, fileSet) == null) {
      orphans.push(makeCandidate(safeId, fileSet, undefined, "absent", stats));
    } else {
      candidates.push(makeCandidate(safeId, fileSet, undefined, "unreadable", stats, "unreadable"));
    }
  }

  return { candidates, orphans, ignoredFiles: ignored };
}

// ────────────────────────────────────────────────────────────────────────────────
// Blockers and tiers
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Blockers that need no I/O beyond the scan. NEVER archived, at any age
 * (BRIEF §6.3). Order matters only for which reason is reported.
 */
export function staticBlockerFor(
  candidate: ArchiveCandidate,
  boundaries: RetentionBoundaries,
): { blocker: ArchiveBlocker; detail?: string } | undefined {
  if (candidate.files.some(isHostileFileName)) {
    // ⚠️ REFUSE, DO NOT ESCAPE. `MANIFEST.tsv`'s `file` column is the one column
    // that must survive round-trip UNESCAPED, because a restore reads it back as
    // a path. ext4 permits TAB/CR/LF in filenames; escaping them would silently
    // break restore, while refusing is correct and checkable.
    return { blocker: "hostile-filename" };
  }
  if (candidate.recordStatus === "unreadable") {
    // ⚠️ FAIL CLOSED TOWARD PRESERVATION. acpx's own prune doctrine, verbatim:
    // "for a destruction guard the error path IS the guard". A transient EIO
    // reads as "possibly protected, skip this run", never as "safe to move".
    return { blocker: "record-unparseable", detail: candidate.recordDetail };
  }
  const recordBlocker = recordBlockerFor(candidate.record);
  if (recordBlocker) {
    return { blocker: recordBlocker };
  }
  if (hasActiveSidecar(candidate.safeId, candidate.files)) {
    return { blocker: "active-delivery-sidecar" };
  }
  // ⚠️ THE QUIET WINDOW IS A DIFFERENT QUESTION FROM AGE, and it legitimately
  // counts EVERY file including the record: "has anything at all touched this id
  // in the last hour" is exactly what a pre-move quiet period should ask. Do not
  // fold it into `retentionMtimeAnchorMs` — that function answers "was this
  // session USED", which is a claim about the user, not about the process.
  if (boundaries.nowMs - candidate.newestMtimeMs < boundaries.quietMs) {
    return { blocker: "touched-recently" };
  }
  return undefined;
}

function recordBlockerFor(record: ArchiveRecordView | undefined): ArchiveBlocker | undefined {
  if (!record) {
    return undefined;
  }
  if (record.hasTemplate) {
    // ⚠️ PRESENCE, NOT `.enabled`. A soft-retracted blueprint keeps
    // `enabled:false` precisely so it can be rolled back, so testing truthiness
    // archives every retracted template. And `template` is NOT projected into
    // `index.json` at all (0 index entries carry it while the records do), so an
    // implementation reading exclusions from the index misses EVERY blueprint —
    // which is why this reads the record.
    return record.hasTemplate ? "template" : undefined;
  }
  return record.favorite ? "favorite" : undefined;
}

/**
 * 🛑 THE FILE-MTIME LEG OF THE AGE PREDICATE, ISOLATED ON PURPOSE — IT IS UNDER
 * ACTIVE AMENDMENT AND MUST NOT BE INLINED AT ANY CALL SITE.
 *
 * BRIEF §6.4 as written says age is `now − max(mtime over the id's ENTIRE file
 * set)` AND the record field, both past the boundary. Implemented here as written.
 *
 * ⚠️ BUT THE "ENTIRE FILE SET" PART IS MEASURED WRONG, and the measurement is the
 * parent brick's, off the real manifest. Of wave 2's 275 not-closed ids, 170 had
 * some file newer than the cutoff — and the young file was the RECORD `<id>.json`
 * in 167 cases, `.delivery.json` in 7, and a stream/messages/timestamps sidecar in
 * ZERO. Wave 1's closed tier: 122 of 1,060 young, 114 of them via `<id>.json`,
 * again zero via a transcript sidecar. `max(mtime)` is therefore dominated by
 * PRODUCT-SIDE RECORD REWRITES — index projections, cost/usage fields, `served`,
 * favorites, close cascades — on sessions nobody has used for 45-90 days. Taken
 * literally this leg would keep 62% of wave 2 and 12% of wave 1 hot for no
 * user-facing reason, and because those records keep being rewritten they would
 * NEVER age out. It measures "did acpx-ui touch this record", not "was this
 * session used".
 *
 * The two corrections conception is choosing between: restrict this to TRANSCRIPT
 * SIDECARS only (`.stream*`, `.messages.ndjson`, `.timestamps.ndjson`,
 * `.owner.log`, excluding `.json` and `.delivery.json`), or drop the mtime leg
 * entirely and rely on the record field plus the run-time liveness gate. Either
 * way `.delivery.json` will not be a youth signal — it is already an
 * `ACTIVE_SIDECAR_SUFFIX` exclusion, and letting it also make a session look young
 * double-counts one fact through two mechanisms.
 *
 * ⚠️ AND DO NOT DESIGN AGAINST THE RIG'S `AGE-AND-mtime-young` FIXTURE AS IT
 * STANDS: it is built from the RECORD's mtime, i.e. from exactly the signal this
 * note says is invalid. It is being rebuilt from a transcript sidecar mtime.
 *
 * When the amendment lands it is a change to THIS FUNCTION and nothing else.
 */
export function retentionMtimeAnchorMs(candidate: ArchiveCandidate): number | undefined {
  return candidate.newestMtimeMs === 0 ? undefined : candidate.newestMtimeMs;
}

/**
 * The four-tier retention predicate (BRIEF §6.4).
 *
 * ⚠️ AGE IS AN **AND** OVER TWO INDEPENDENT SIGNALS: the file-mtime anchor above,
 * AND — when a record exists — `now − (closed_at ?? last_used_at)`. BOTH must be
 * past the boundary. The rig's `AGE-AND-mtime-young` / `AGE-AND-record-young`
 * cohorts are the only fixtures that isolate the two halves; everywhere else the
 * signals agree by construction, so everywhere else cannot tell a one-signal
 * implementation from a two-signal one.
 */
export function tierFor(
  candidate: ArchiveCandidate,
  boundaries: RetentionBoundaries,
  includeOrphans: boolean,
): { tier: ArchiveTier; reason: string } | undefined {
  const record = candidate.record;
  if (!record) {
    return orphanTierFor(candidate, boundaries, includeOrphans);
  }
  const anchor = recordAgeAnchor(record);
  if (record.closed) {
    return isOldEnough(candidate, anchor, boundaries.closedBeforeMs)
      ? { tier: "closed", reason: `closed-before-${boundaryDateToken(boundaries.closedBeforeMs)}` }
      : undefined;
  }
  if (record.kind === "subagent") {
    return isOldEnough(candidate, anchor, boundaries.subagentsBeforeMs)
      ? {
          tier: "subagent",
          reason: `subagent-unused-before-${boundaryDateToken(boundaries.subagentsBeforeMs)}`,
        }
      : undefined;
  }
  return isOldEnough(candidate, anchor, boundaries.staleBeforeMs)
    ? { tier: "stale", reason: `stale-before-${boundaryDateToken(boundaries.staleBeforeMs)}` }
    : undefined;
}

function orphanTierFor(
  candidate: ArchiveCandidate,
  boundaries: RetentionBoundaries,
  includeOrphans: boolean,
): { tier: ArchiveTier; reason: string } | undefined {
  if (!includeOrphans) {
    return undefined;
  }
  return isOldEnough(candidate, undefined, boundaries.orphansBeforeMs)
    ? { tier: "orphan", reason: "orphan-sidecars" }
    : undefined;
}

function isOldEnough(
  candidate: ArchiveCandidate,
  anchor: string | undefined,
  boundaryMs: number,
): boolean {
  const mtimeAnchorMs = retentionMtimeAnchorMs(candidate);
  if (mtimeAnchorMs != null && mtimeAnchorMs >= boundaryMs) {
    return false;
  }
  if (anchor == null) {
    // No record field to check: an orphan is decided by the mtime leg alone (and
    // an id with no usable mtime at all cannot have its age established either
    // way). A RECORD with no usable timestamp is not old — same direction as
    // `record-unparseable`: unknown age is not old age.
    return candidate.record == null && mtimeAnchorMs != null;
  }
  const anchorMs = Date.parse(anchor);
  return Number.isFinite(anchorMs) && anchorMs < boundaryMs;
}

/**
 * Anchor resolution for a companion — `metadata.byway_parent` FIRST, then
 * `forked_from_session_id`.
 *
 * ⚠️ THE ORDER IS THE CONTRACT, not a preference. It matches acpx-ui's
 * `server/byway.ts` `isOrphanByway`, which is the source of truth for the
 * hard-delete this whole mechanism exists to prevent. In every live specimen the
 * two fields AGREE, so production cannot discriminate the order at all — the rig's
 * `BYWAY-DISAGREE-byway` cohort points them at different parents on purpose, and
 * it is the only thing that can catch a reversed order.
 */
export function anchorIdFor(record: ArchiveRecordView): string | undefined {
  if (record.kind === "subagent") {
    return record.parentSessionId;
  }
  return record.bywayParent ?? record.forkedFromSessionId;
}

// ────────────────────────────────────────────────────────────────────────────────
// Plan
// ────────────────────────────────────────────────────────────────────────────────

export type PlanInput = {
  candidates: ArchiveCandidate[];
  orphans: ArchiveCandidate[];
  ignoredFiles: string[];
  boundaries: RetentionBoundaries;
  includeOrphans: boolean;
  explicitIds?: readonly string[];
  limit?: number;
  liveness: LivenessGateOptions;
};

type PlanState = {
  selected: Map<string, PlannedArchive>;
  blocked: BlockedArchive[];
  blockedIds: Map<string, ArchiveBlocker>;
  byId: Map<string, ArchiveCandidate>;
  companionsOf: Map<string, string[]>;
  droppedAnchors: DroppedAnchor[];
};

function block(
  state: PlanState,
  candidate: ArchiveCandidate,
  blocker: ArchiveBlocker,
  detail?: string,
): void {
  state.blocked.push({ candidate, blocker, detail });
  state.blockedIds.set(candidate.id, blocker);
}

function selectByTier(state: PlanState, input: PlanInput, all: readonly ArchiveCandidate[]): void {
  const explicit = input.explicitIds ? new Set(input.explicitIds) : undefined;
  const requested = explicit
    ? all.filter((candidate) => explicit.has(candidate.id) || explicit.has(candidate.safeId))
    : all;
  for (const candidate of requested) {
    considerCandidate(state, input, candidate, explicit != null);
  }
}

function considerCandidate(
  state: PlanState,
  input: PlanInput,
  candidate: ArchiveCandidate,
  isExplicit: boolean,
): void {
  const staticBlocker = staticBlockerFor(candidate, input.boundaries);
  if (staticBlocker) {
    block(state, candidate, staticBlocker.blocker, staticBlocker.detail);
    return;
  }
  const tier = tierFor(candidate, input.boundaries, input.includeOrphans || isExplicit);
  if (tier) {
    state.selected.set(candidate.id, { candidate, ...tier });
    return;
  }
  if (isExplicit) {
    // ⚠️ An operator naming ids explicitly has asked for THOSE IDS: the TIER
    // predicate is POLICY and is bypassed here. Every BLOCKER above is SAFETY and
    // is NOT bypassed — `--ids` must never be a way to archive a template, a
    // favorite, a live session or an id with an unreadable record. `manual` is not
    // in the reason vocabulary, and readers pass unknown reasons through by
    // contract (formats §3.5).
    state.selected.set(candidate.id, { candidate, tier: "manual", reason: "manual" });
  }
}

function buildCompanionGraph(all: readonly ArchiveCandidate[]): Map<string, string[]> {
  const companionsOf = new Map<string, string[]>();
  for (const candidate of all) {
    const record = candidate.record;
    if (!record || (!record.isByway && record.kind !== "subagent")) {
      continue;
    }
    const anchor = anchorIdFor(record);
    if (anchor == null || anchor === candidate.id) {
      continue;
    }
    const bucket = companionsOf.get(anchor);
    if (bucket) {
      bucket.push(candidate.id);
    } else {
      companionsOf.set(anchor, [candidate.id]);
    }
  }
  return companionsOf;
}

/**
 * Pull a selected id's companions into the same run, to a FIXED POINT — a
 * companion may itself have companions.
 *
 * acpx-ui's `sweepOrphanByways` HARD-DELETES a byway record (record + JSONL) whose
 * anchor no longer resolves on disk, on a 5-minute cadence with NO watermark. So a
 * byway left behind by a moved parent is destroyed, not merely orphaned.
 */
function closeCompanions(state: PlanState, input: PlanInput): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const [anchorId, companionIds] of state.companionsOf) {
      if (!state.selected.has(anchorId)) {
        continue;
      }
      for (const companionId of companionIds) {
        if (pullCompanion(state, input, anchorId, companionId)) {
          changed = true;
        }
      }
    }
  }
}

function pullCompanion(
  state: PlanState,
  input: PlanInput,
  anchorId: string,
  companionId: string,
): boolean {
  if (state.selected.has(companionId) || state.blockedIds.has(companionId)) {
    return false;
  }
  const companion = state.byId.get(companionId);
  if (!companion) {
    return false;
  }
  const staticBlocker = staticBlockerFor(companion, input.boundaries);
  if (staticBlocker) {
    block(state, companion, staticBlocker.blocker, staticBlocker.detail);
    return false;
  }
  const kind = companion.record?.kind === "subagent" ? "subagent" : "byway";
  state.selected.set(companionId, {
    candidate: companion,
    tier: "companion",
    reason: `${kind}-of-${anchorId.slice(0, 8)}`,
  });
  return true;
}

/**
 * ⚠️ THE REVERSE GUARD — THE ONE THAT PREVENTS DATA LOSS. If a selected id anchors
 * a companion that CANNOT move, the ANCHOR is dropped from the run and reported.
 * Archiving it alone would make acpx-ui hard-delete the byway within 5 minutes.
 *
 * Runs to a fixed point, because dropping an anchor can strand ITS anchor.
 */
function applyReverseGuard(state: PlanState): void {
  for (let changed = true; changed; ) {
    changed = false;
    for (const [anchorId, companionIds] of state.companionsOf) {
      if (!state.selected.has(anchorId)) {
        continue;
      }
      const stranded = companionIds.find(
        (companionId) => !state.selected.has(companionId) && state.byId.has(companionId),
      );
      if (stranded == null) {
        continue;
      }
      const anchor = state.byId.get(anchorId);
      if (!anchor) {
        continue;
      }
      const companionBlocker = state.blockedIds.get(stranded) ?? "live";
      state.selected.delete(anchorId);
      block(state, anchor, "anchor-of-blocked-companion", `${stranded} (${companionBlocker})`);
      state.droppedAnchors.push({ anchorId, companionId: stranded, companionBlocker });
      changed = true;
    }
  }
}

async function applyLivenessGate(state: PlanState, input: PlanInput): Promise<void> {
  for (const [id, planned] of Array.from(state.selected)) {
    const verdict = await evaluateLiveness(
      id,
      planned.candidate.safeId,
      planned.candidate.files,
      planned.candidate.record?.pid,
      input.liveness,
    );
    if (verdict.live) {
      state.selected.delete(id);
      block(state, planned.candidate, "live", verdict.signal);
    }
  }
}

export async function buildArchivePlan(input: PlanInput): Promise<ArchivePlan> {
  const all = [...input.candidates, ...input.orphans];
  const state: PlanState = {
    selected: new Map(),
    blocked: [],
    blockedIds: new Map(),
    byId: new Map(all.map((candidate) => [candidate.id, candidate])),
    companionsOf: buildCompanionGraph(all),
    droppedAnchors: [],
  };

  selectByTier(state, input, all);
  closeCompanions(state, input);
  applyReverseGuard(state);
  await applyLivenessGate(state, input);
  // A companion the liveness gate just removed re-arms the reverse guard, so it
  // runs again over the reduced set. Safe and terminating: the gate only ever
  // REMOVES ids, and the guard is idempotent on a set it has already settled.
  applyReverseGuard(state);

  const ordered = orderForApply(Array.from(state.selected.values()), state.companionsOf);
  const selected = input.limit == null ? ordered : ordered.slice(0, input.limit);

  return {
    selected,
    blocked: state.blocked,
    droppedAnchors: state.droppedAnchors,
    ignoredFiles: input.ignoredFiles,
    orphanAggregate: aggregateOrphans(selected),
    boundaries: input.boundaries,
    livenessDegraded: input.liveness.wakeups.status === "unevaluable",
  };
}

function aggregateOrphans(selected: readonly PlannedArchive[]): {
  ids: number;
  files: number;
  bytes: number;
} {
  const aggregate = { ids: 0, files: 0, bytes: 0 };
  for (const planned of selected) {
    if (planned.tier !== "orphan") {
      continue;
    }
    aggregate.ids += 1;
    aggregate.files += planned.candidate.files.length;
    aggregate.bytes += planned.candidate.bytes;
  }
  return aggregate;
}

/**
 * ⚠️ COMPANIONS MOVE BEFORE THEIR ANCHORS, AND THIS ORDERING IS THE PRIMARY
 * DEFENCE, NOT `--repair`.
 *
 * The anchor's DEPARTURE is what arms acpx-ui's 5-minute `sweepOrphanByways`
 * hard-delete, so it must be the last event in the group. A crash between a
 * companion and its anchor then leaves the companion already in the archive beside
 * nothing — inert and restorable. The reverse order leaves a byway hot with a
 * vanished anchor, and it is destroyed within five minutes. `--repair` widens the
 * window; only the ordering closes it.
 */
export function orderForApply(
  planned: readonly PlannedArchive[],
  companionsOf: ReadonlyMap<string, readonly string[]>,
): PlannedArchive[] {
  const byId = new Map(planned.map((entry) => [entry.candidate.id, entry]));
  const emitted = new Set<string>();
  const result: PlannedArchive[] = [];

  const emit = (id: string, seen: Set<string>): void => {
    if (emitted.has(id) || seen.has(id)) {
      return;
    }
    seen.add(id);
    for (const companionId of companionsOf.get(id) ?? []) {
      emit(companionId, seen);
    }
    const entry = byId.get(id);
    if (entry) {
      emitted.add(id);
      result.push(entry);
    }
  };

  for (const entry of planned) {
    emit(entry.candidate.id, new Set());
  }
  return result;
}

export { recordFileNameFor, encodeSessionSafeId };
