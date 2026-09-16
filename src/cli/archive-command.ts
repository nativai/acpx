import fs from "node:fs/promises";
import type { Command } from "commander";
import { resolveAcpxUiBaseUrl } from "../acp/auth-env.js";
import {
  createHttpLivenessProbe,
  loadWakeupLiveness,
  type LivenessGateOptions,
} from "../session/archive/liveness.js";
import { ArchiveRefusal } from "../session/archive/move.js";
import {
  applyArchiveRun,
  archiveStatus,
  createContext,
  directoryExists,
  listArchived,
  planArchiveRun,
  reindexArchive,
  repairArchive,
  runRestore,
  verifyArchive,
  type ArchiveContext,
  type ArchiveRunResult,
} from "../session/archive/operations.js";
import { isDetachedArchiveDir } from "../session/archive/paths.js";
import { resolveBoundaries, type ArchivePlan } from "../session/archive/retention.js";
import { sessionBaseDir } from "../session/persistence/repository.js";

/**
 * `acpx sessions archive` / `acpx sessions restore`.
 *
 * ⚠️ `acpx sessions prune` IS NOT THE MECHANISM AND IS NOT CHANGED BY THIS FILE.
 * Archiving MOVES; prune DELETES. They stay separate verbs with separate manifests
 * (`MANIFEST.tsv` vs `deletions.ndjson`), and nothing here ever unlinks.
 *
 * Exit codes (BRIEF §7.2): 0 ok · 1 completed with reported problems · 2 refused
 * before acting.
 */

export const ARCHIVE_EXIT_OK = 0;
export const ARCHIVE_EXIT_PROBLEMS = 1;
export const ARCHIVE_EXIT_REFUSED = 2;

export type SessionsArchiveFlags = {
  dryRun?: boolean;
  closedBefore?: string;
  staleBefore?: string;
  subagentsBefore?: string;
  orphans?: boolean;
  quietMinutes?: string;
  restoreGraceDays?: string;
  limit?: string;
  ids?: string[];
  json?: boolean;
  allowFirstRun?: boolean;
  status?: boolean;
  list?: boolean;
  listOrphans?: boolean;
  month?: string;
  verify?: boolean;
  repair?: boolean;
  reindex?: boolean;
  wave?: string;
  excludeIds?: string;
};

/** `N` (days) or `YYYY-MM-DD`. Anything else is a refusal, not a silent default. */
function parseBoundary(value: string | undefined, label: string): number | string | undefined {
  if (value == null) {
    return undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) {
    throw new ArchiveRefusal(
      `${label} must be a day count or YYYY-MM-DD, got '${value}'`,
      "bad-argument",
    );
  }
  return days;
}

function parseCount(value: string | undefined, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ArchiveRefusal(
      `${label} must be a non-negative integer, got '${value}'`,
      "bad-argument",
    );
  }
  return parsed;
}

function warnIfDetached(context: ArchiveContext): void {
  if (!isDetachedArchiveDir(context.hotDir, context.archiveDir)) {
    return;
  }
  // ⚠️ REQUIRED BY BRIEF §7.1 IN BOTH REPOS. `ACPX_SESSIONS_ARCHIVE_DIR` set alone
  // while acpx and acpx-ui resolve DIFFERENT hot dirs makes the two share ONE
  // archive while having two hot dirs. That is a genuine footgun and it is silent
  // — this line is the only thing that makes it visible.
  process.stderr.write(
    `[acpx] warning: archive dir ${context.archiveDir} is not a sibling of the hot dir ${context.hotDir} (ACPX_SESSIONS_ARCHIVE_DIR is set). acpx and acpx-ui may disagree about which archive they are using.\n`,
  );
}

async function buildLiveness(
  context: ArchiveContext,
  excludeIdsFile: string | undefined,
): Promise<LivenessGateOptions> {
  const baseUrl = resolveAcpxUiBaseUrl(process.env);
  return {
    primary: baseUrl ? createHttpLivenessProbe(baseUrl) : undefined,
    wakeups: await loadWakeupLiveness(context.hotDir),
    excludedIds: await readExcludeIdsFile(excludeIdsFile),
  };
}

/**
 * `--exclude-ids <file>`, one id per line — the acpx-ui scheduler's channel for
 * live-state it alone can see. Blank lines and `#` comments are ignored.
 *
 * ⚠️ AN UNREADABLE FILE IS A REFUSAL, NOT AN EMPTY SET. The caller asked for these
 * ids to be protected; proceeding with none of them protected is the one outcome
 * that is worse than not running at all, and it would look like a successful run.
 *
 * ⚠️ IDS ARE OPAQUE AND MAY CONTAIN ANY SEPARATOR, so this is line-delimited and
 * deliberately not split on commas or any in-line character.
 */
async function readExcludeIdsFile(file: string | undefined): Promise<Set<string> | undefined> {
  if (file == null) {
    return undefined;
  }
  let payload: string;
  try {
    payload = await fs.readFile(file, "utf8");
  } catch (error) {
    throw new ArchiveRefusal(
      `--exclude-ids ${file} could not be read (${(error as NodeJS.ErrnoException).code ?? "read-failed"}) — refusing rather than running with no live-state exclusions`,
      "bad-argument",
    );
  }
  const ids = new Set<string>();
  for (const line of payload.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#")) {
      ids.add(trimmed);
    }
  }
  return ids;
}

export async function handleSessionsArchive(
  flags: SessionsArchiveFlags,
  command: Command,
): Promise<void> {
  try {
    process.exitCode = await dispatchArchive(flags, command);
  } catch (error) {
    if (error instanceof ArchiveRefusal) {
      process.stderr.write(`[acpx] refused: ${error.message}\n`);
      process.exitCode = ARCHIVE_EXIT_REFUSED;
      return;
    }
    throw error;
  }
}

async function dispatchArchive(flags: SessionsArchiveFlags, command: Command): Promise<number> {
  void command;
  const context = createContext(sessionBaseDir(), flags.wave ?? "cli");
  warnIfDetached(context);

  if (flags.status) {
    return await runStatusVerb(context, flags);
  }
  if (flags.list || flags.listOrphans) {
    return await runListVerb(context, flags);
  }
  if (flags.verify) {
    return await runVerifyVerb(context, flags);
  }
  if (flags.repair) {
    return await runRepairVerb(context, flags);
  }
  if (flags.reindex) {
    return await runReindexVerb(context, flags);
  }
  return await runArchiveVerb(context, flags);
}

// ────────────────────────────────────────────────────────────────────────────────

async function runArchiveVerb(
  context: ArchiveContext,
  flags: SessionsArchiveFlags,
): Promise<number> {
  const boundaries = resolveBoundaries(context.nowMs, {
    closedBefore: parseBoundary(flags.closedBefore, "--closed-before"),
    staleBefore: parseBoundary(flags.staleBefore, "--stale-before"),
    subagentsBefore: parseBoundary(flags.subagentsBefore, "--subagents-before"),
    quietMinutes: parseCount(flags.quietMinutes, "--quiet-minutes"),
    restoreGraceDays: parseCount(flags.restoreGraceDays, "--restore-grace-days"),
  });

  const plan = await planArchiveRun(context, boundaries, {
    // ⚠️ Orphans are opt-in for a manual run. They are the PLURALITY of the corpus
    // (48.5% of archived ids), so sweeping them by default would make a casual
    // `acpx sessions archive` a far larger act than it reads as.
    includeOrphans: flags.orphans === true,
    explicitIds: flags.ids,
    limit: parseCount(flags.limit, "--limit"),
    liveness: await buildLiveness(context, flags.excludeIds),
  });

  const result = await applyArchiveRun({
    context,
    boundaries,
    plan,
    // ⚠️ DRY RUN IS THE DEFAULT-SAFE PATH AND MUST PRINT THE FULL PLAN — it is the
    // operator's ONLY review surface before an irreversible-looking bulk move.
    dryRun: flags.dryRun === true,
    allowFirstRun: flags.allowFirstRun === true || process.env.ACPX_ARCHIVE_ALLOW_FIRST_RUN === "1",
  });

  if (flags.json) {
    writeJson(archiveRunJson(context, result));
  } else {
    writeArchiveRunText(context, result);
  }
  return archiveExitCode(result);
}

function archiveExitCode(result: ArchiveRunResult): number {
  if (result.failures.length > 0) {
    return ARCHIVE_EXIT_PROBLEMS;
  }
  return ARCHIVE_EXIT_OK;
}

function planSummary(plan: ArchivePlan): Record<string, number> {
  const byTier: Record<string, number> = {};
  for (const entry of plan.selected) {
    byTier[entry.tier] = (byTier[entry.tier] ?? 0) + 1;
  }
  return byTier;
}

function blockerSummary(plan: ArchivePlan): Record<string, number> {
  const byBlocker: Record<string, number> = {};
  for (const entry of plan.blocked) {
    byBlocker[entry.blocker] = (byBlocker[entry.blocker] ?? 0) + 1;
  }
  return byBlocker;
}

function archiveRunJson(context: ArchiveContext, result: ArchiveRunResult): unknown {
  return {
    hotDir: context.hotDir,
    archiveDir: context.archiveDir,
    at: context.at,
    wave: context.wave,
    applied: result.applied,
    firstRunGated: result.firstRunGated,
    selected: result.plan.selected.length,
    // The per-id plan. Counts alone are a summary; this is the reviewable artifact
    // — and the only form a checker can diff against an expectation per id.
    plan: result.plan.selected.map((entry) => ({
      id: entry.candidate.id,
      reason: entry.reason,
      tier: entry.tier,
      files: entry.candidate.files.length,
      bytes: entry.candidate.bytes,
    })),
    blockedIds: result.plan.blocked.map((entry) => ({
      id: entry.candidate.id,
      blocker: entry.blocker,
      detail: entry.detail,
    })),
    byTier: planSummary(result.plan),
    blocked: blockerSummary(result.plan),
    droppedAnchors: result.plan.droppedAnchors,
    orphanAggregate: result.plan.orphanAggregate,
    livenessDegraded: result.plan.livenessDegraded,
    // Emitted for acpx-ui's 3-consecutive-run tripwire; see `ArchivePlan`.
    touchedRecentlyIds: result.plan.touchedRecentlyIds,
    moved: result.moved.map((entry) => ({
      id: entry.id,
      reason: entry.reason,
      files: entry.files.length,
      bytes: entry.bytes,
    })),
    skippedAtApply: result.skippedAtApply,
    failures: result.failures,
    indexReconciled: result.indexReconciled,
    warnings: result.warnings,
  };
}

function writeArchiveRunText(context: ArchiveContext, result: ArchiveRunResult): void {
  const lines: string[] = [];
  const mode = result.applied ? "APPLIED" : result.firstRunGated ? "FIRST-RUN DRY RUN" : "DRY RUN";
  lines.push(`[${mode}] wave ${context.wave}`);
  lines.push(`  hot:     ${context.hotDir}`);
  lines.push(`  archive: ${context.archiveDir}`);
  lines.push(`  selected: ${result.plan.selected.length} ids`);
  for (const [tier, count] of Object.entries(planSummary(result.plan))) {
    lines.push(`    ${tier.padEnd(12)} ${count}`);
  }
  appendBlockedLines(lines, result);
  appendPlanNotes(lines, result);
  if (result.applied) {
    appendAppliedLines(lines, result);
  }
  for (const warning of result.warnings) {
    lines.push(`  ⚠ ${warning}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function appendBlockedLines(lines: string[], result: ArchiveRunResult): void {
  const blocked = Object.entries(blockerSummary(result.plan));
  if (blocked.length === 0) {
    return;
  }
  lines.push(`  blocked:`);
  for (const [blocker, count] of blocked) {
    lines.push(`    ${blocker.padEnd(28)} ${count}`);
  }
}

function appendPlanNotes(lines: string[], result: ArchiveRunResult): void {
  const { droppedAnchors, orphanAggregate, livenessDegraded } = result.plan;
  if (droppedAnchors.length > 0) {
    lines.push(`  dropped anchors (a byway/subagent could not move): ${droppedAnchors.length}`);
    for (const dropped of droppedAnchors.slice(0, 10)) {
      lines.push(`    ${dropped.anchorId} <- ${dropped.companionId} (${dropped.companionBlocker})`);
    }
  }
  if (orphanAggregate.ids > 0) {
    // ⚠️ AGGREGATE, NEVER A LIST. An orphan has no record and therefore no name,
    // cwd, agent or brick — 1,792 metadata-less rows is not a list anyone can use.
    lines.push(
      `  orphan sidecars: ${orphanAggregate.ids} ids / ${orphanAggregate.files} files / ${formatBytes(orphanAggregate.bytes)} (use --list-orphans for ids)`,
    );
  }
  if (livenessDegraded) {
    lines.push(
      `  ⚠ liveness DEGRADED: the wakeups store exists but could not be read, so every id was treated as LIVE and nothing was selected. This is the guard failing closed, not a no-op run.`,
    );
  }
}

function appendAppliedLines(lines: string[], result: ArchiveRunResult): void {
  const files = result.moved.reduce((sum, entry) => sum + entry.files.length, 0);
  const bytes = result.moved.reduce((sum, entry) => sum + entry.bytes, 0);
  lines.push(`  moved: ${result.moved.length} ids / ${files} files / ${formatBytes(bytes)}`);
  // ⚠️ THIS LINE IS A CORRECTION, NOT A DISCLAIMER. A byte total next to the word
  // "archived" reads as a disk win and is not one: every move is a same-device
  // rename(2), so the figure above is what MOVED, never what was freed.
  lines.push(
    `  ⚠ this freed ZERO bytes of disk — every move is a same-device rename(2). It bounds acpx-ui's memory and CPU only.`,
  );
  if (result.skippedAtApply.length > 0) {
    lines.push(
      `  skipped at apply time (re-validated against the live record): ${result.skippedAtApply.length}`,
    );
    for (const skipped of result.skippedAtApply.slice(0, 10)) {
      lines.push(
        `    ${skipped.id} ${skipped.reason}${skipped.detail ? ` (${skipped.detail})` : ""}`,
      );
    }
  }
  if (result.failures.length > 0) {
    lines.push(`  FAILURES: ${result.failures.length}`);
    for (const failure of result.failures) {
      lines.push(`    ${failure.id} ${failure.file}: ${failure.error}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────────

async function runStatusVerb(
  context: ArchiveContext,
  flags: SessionsArchiveFlags,
): Promise<number> {
  const status = await archiveStatus(context);
  if (flags.json) {
    writeJson(status);
    return ARCHIVE_EXIT_OK;
  }
  const lines = [
    `hot:     ${status.hotDir}`,
    `  ${status.hot.files} files / ${formatBytes(status.hot.bytes)}`,
    `archive: ${status.archiveDir}${status.archiveExists ? "" : " (does not exist yet)"}`,
    `  ${status.archive.ids} ids / ${status.archive.files} files / ${formatBytes(status.archive.bytes)}`,
    `  orphan-sidecar ids (no record, no index entry): ${status.orphans.ids}`,
    `manifest: ${status.manifest.absent ? "absent" : `${status.manifest.rows} rows`}${status.manifest.skippedRows > 0 ? ` (${status.manifest.skippedRows} malformed rows skipped)` : ""}`,
    `shards:   ${status.shards.length > 0 ? status.shards.join(", ") : "none — run --reindex"}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return ARCHIVE_EXIT_OK;
}

async function runListVerb(context: ArchiveContext, flags: SessionsArchiveFlags): Promise<number> {
  if (!(await directoryExists(context.archiveDir))) {
    throw new ArchiveRefusal(`no archive directory at ${context.archiveDir}`, "no-archive");
  }
  const { entries, shards, warnings } = await listArchived(context, {
    month: flags.month,
    limit: parseCount(flags.limit, "--limit"),
  });
  if (flags.json) {
    writeJson({ shards, entries, warnings });
  } else {
    for (const entry of entries) {
      process.stdout.write(
        `${entry.archivedAt}  ${entry.id}  ${entry.reason}  ${entry.closed === true ? "closed" : "open"}  ${entry.name ?? ""}\n`,
      );
    }
    for (const warning of warnings) {
      process.stderr.write(`[acpx] ⚠ ${warning}\n`);
    }
  }
  return warnings.length > 0 ? ARCHIVE_EXIT_PROBLEMS : ARCHIVE_EXIT_OK;
}

async function runVerifyVerb(
  context: ArchiveContext,
  flags: SessionsArchiveFlags,
): Promise<number> {
  const { checked, problems } = await verifyArchive(context);
  if (flags.json) {
    writeJson({ checked, problems });
  } else {
    process.stdout.write(`verified ${checked} files from MANIFEST.tsv\n`);
    for (const problem of problems) {
      process.stdout.write(
        `  ${problem.found === "neither" ? "LOST" : "MISPLACED"} ${problem.file} (id ${problem.id}): expected ${problem.expected}, found ${problem.found}\n`,
      );
    }
    if (problems.length === 0) {
      process.stdout.write(`  no problems\n`);
    }
  }
  return problems.length > 0 ? ARCHIVE_EXIT_PROBLEMS : ARCHIVE_EXIT_OK;
}

async function runRepairVerb(
  context: ArchiveContext,
  flags: SessionsArchiveFlags,
): Promise<number> {
  const result = await repairArchive(context);
  if (flags.json) {
    writeJson(result);
  } else {
    process.stdout.write(`repaired ${result.completed.length} interrupted renames\n`);
    for (const entry of result.completed) {
      process.stdout.write(`  ${entry.file} -> ${entry.direction}\n`);
    }
    for (const lost of result.lost) {
      process.stdout.write(
        `  LOST ${lost} — named in MANIFEST.tsv, present in neither directory\n`,
      );
    }
    for (const warning of result.warnings) {
      process.stderr.write(`[acpx] ⚠ ${warning}\n`);
    }
  }
  return result.lost.length > 0 ? ARCHIVE_EXIT_PROBLEMS : ARCHIVE_EXIT_OK;
}

async function runReindexVerb(
  context: ArchiveContext,
  flags: SessionsArchiveFlags,
): Promise<number> {
  if (!(await directoryExists(context.archiveDir))) {
    throw new ArchiveRefusal(`no archive directory at ${context.archiveDir}`, "no-archive");
  }
  const warnings: string[] = [];
  const { months, entries } = await reindexArchive(context, { month: flags.month, warnings });
  if (flags.json) {
    writeJson({ months, entries, warnings });
  } else {
    process.stdout.write(
      `reindexed ${entries} entries across ${months.length} shard(s): ${months.join(", ")}\n`,
    );
    for (const warning of warnings) {
      process.stderr.write(`[acpx] ⚠ ${warning}\n`);
    }
  }
  return ARCHIVE_EXIT_OK;
}

// ────────────────────────────────────────────────────────────────────────────────

export async function handleSessionsRestore(
  ids: string[],
  flags: { json?: boolean },
): Promise<void> {
  const context = createContext(sessionBaseDir(), "restore");
  warnIfDetached(context);
  try {
    const result = await runRestore(context, ids);
    if (flags.json) {
      writeJson(result);
    } else {
      writeRestoreText(result);
    }
    process.exitCode = result.skipped.length > 0 ? ARCHIVE_EXIT_PROBLEMS : ARCHIVE_EXIT_OK;
  } catch (error) {
    if (error instanceof ArchiveRefusal) {
      process.stderr.write(`[acpx] refused: ${error.message}\n`);
      process.exitCode = ARCHIVE_EXIT_REFUSED;
      return;
    }
    throw error;
  }
}

function writeRestoreText(result: Awaited<ReturnType<typeof runRestore>>): void {
  for (const entry of result.restored) {
    process.stdout.write(
      `restored ${entry.id} (${entry.files.length} files, ${formatBytes(entry.bytes)})\n`,
    );
  }
  for (const skipped of result.skipped) {
    process.stdout.write(
      `skipped ${skipped.id}: ${skipped.reason}${skipped.detail ? ` (${skipped.detail})` : ""}\n`,
    );
  }
  for (const warning of result.warnings) {
    // The byway-anchor warning lives here and is the one a user must not miss.
    process.stderr.write(`[acpx] ⚠ ${warning}\n`);
  }
}

function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, undefined, 2)}\n`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
