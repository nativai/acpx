import fs from "node:fs/promises";
import type { Command } from "commander";
import {
  readAcpxUiInternalOriginSources,
  resolveAtriumLocalOrigin,
} from "../acp/acpx-ui-internal-origin.js";
import type { ArchiveIndexEntry } from "../session/archive/archive-index.js";
import {
  createAtriumReaderProbe,
  runCompressSweep,
  runDecompressSweep,
  type CompressRunResult,
  type DecompressRunResult,
} from "../session/archive/compress-sweep.js";
import { isArchivedFileCorrupt } from "../session/archive/compressed.js";
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
  listArchivedOrphans,
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
import { catArchivedFile, thawArchivedSession, thawErrorJson } from "../session/archive/thaw.js";
import { sessionBaseDir } from "../session/persistence/repository.js";
import { seatArchiveReportLines } from "../session/persistence/seat-archive.js";

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
  apply?: boolean;
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
  // brick 1861b06d — `acpx-archive-zst/v1`
  compress?: boolean;
  decompress?: boolean | string[];
  all?: boolean;
  thaw?: string;
  to?: string;
  cat?: string;
  initialize?: boolean;
  maxBytes?: string;
  paceMbps?: string;
  skipReaderCheck?: boolean;
  manifestOut?: string;
  deep?: boolean;
};

/** Where `/data/runtime/info.json` lives on a box (CONCEPTION §3.13 pre-flight). */
const RUNTIME_INFO_PATH = "/data/runtime/info.json";

const BYTE_UNITS: Record<string, number> = {
  "": 1,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

/** A byte count, or a number with a BINARY suffix (`100M`, `4GiB`; K/KB/KiB all = 1024). */
export function parseByteSize(value: string | undefined, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  const match = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(value.trim());
  const unit = match ? BYTE_UNITS[match[2].toLowerCase()] : undefined;
  if (!match || unit === undefined) {
    throw new ArchiveRefusal(
      `${label} must be a byte count or a number with K/M/G/T (binary) suffix, got '${value}'`,
      "bad-argument",
    );
  }
  return Math.floor(Number(match[1]) * unit);
}

function parsePositiveNumber(value: string | undefined, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ArchiveRefusal(`${label} must be a positive number, got '${value}'`, "bad-argument");
  }
  return parsed;
}

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
  // ⚠️ THE BOX-LOCAL ATRIUM, NOT `resolveAcpxUiBaseUrl` (the public mTLS host, on which
  // every probe died in the TLS handshake and read as "unavailable") — see
  // `resolveAtriumLocalOrigin`.
  const origin = resolveAtriumLocalOrigin(process.env, readAcpxUiInternalOriginSources());
  return {
    primary: createHttpLivenessProbe(origin),
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
  if (flags.thaw != null) {
    return await runThawVerb(flags);
  }
  if (flags.cat != null) {
    return await runCatVerb(flags);
  }
  const context = createContext(sessionBaseDir(), flags.wave ?? wavePrefixFor(flags));
  warnIfDetached(context);
  const flagVerb = flagVerbFor(flags);
  if (flagVerb) {
    return await flagVerb(context, flags, command);
  }
  // ⚠️ EVERY READ-ONLY VERB HAS ALREADY RETURNED ABOVE, and that ordering is what
  // scopes the intent gate correctly. `--status`, `--list`, `--list-orphans`,
  // `--verify`, `--repair` and `--reindex` are FLAGS ON THIS SAME COMMAND, not
  // sub-commands, so a gate placed in `dispatchArchive` would refuse all of them.
  // None is dry-run-able, so none has an intent to state. (`--compress` and
  // `--decompress` ARE dry-run-able and state their own intent — `sweepIntent`.)
  return await runArchiveVerb(context, flags, command);
}

function wavePrefixFor(flags: SessionsArchiveFlags): string {
  if (flags.compress) {
    return "compress";
  }
  return flags.decompress ? "decompress" : "cli";
}

type FlagVerb = (
  context: ArchiveContext,
  flags: SessionsArchiveFlags,
  command: Command,
) => Promise<number>;

/** The flag-verbs, in precedence order — the first flag set wins. */
function flagVerbFor(flags: SessionsArchiveFlags): FlagVerb | undefined {
  const verbs: [boolean, FlagVerb][] = [
    [flags.status === true, runStatusVerb],
    [flags.list === true || flags.listOrphans === true, runListVerb],
    [flags.verify === true, runVerifyVerb],
    [flags.repair === true, runRepairVerb],
    [flags.reindex === true, runReindexVerb],
    [flags.compress === true, runCompressVerb],
    [flags.decompress != null && flags.decompress !== false, runDecompressVerb],
  ];
  return verbs.find(([enabled]) => enabled)?.[1];
}

// ────────────────────────────────────────────────────────────────────────────────

/**
 * Declare the three intent options on a command, in the order that makes them work.
 *
 * ⚠️ THIS EXISTS SO THE TEST PARSES THROUGH THE SAME DECLARATION THE PRODUCT USES.
 * A test that rebuilds these options by hand is a REPLICA, and a replica cannot
 * notice the product drifting away from it — which is precisely how the acpx-ui
 * test that missed this P0 failed: it asserted against a fake and encoded the
 * defect as its success condition. Single declaration, two callers, no drift.
 *
 * ⚠️ `--no-dry-run` MUST BE DECLARED FIRST AND NO TYPE CHECK CATCHES IT IF YOU
 * SWAP THEM. Measured against the pinned commander 14.0.3: with this order a bare
 * invocation parses `dryRun: true` with source `"default"`; declared the other way
 * the value is `undefined`, and every `=== true` read downstream silently flips.
 * `resolveRunIntent` reads the SOURCE rather than the value precisely because the
 * value cannot distinguish a bare run from an explicit `--dry-run`.
 */
export function addArchiveRunIntentOptions(command: Command): Command {
  return command
    .option("--no-dry-run", "Exact synonym of --apply, kept for compatibility")
    .option("--dry-run", "Preview the plan and move nothing. Must be stated explicitly.")
    .option("--apply", "Actually move the selected files. Must be stated explicitly.");
}

export type RunIntent = "dry-run" | "apply" | "unstated" | "contradictory";

/**
 * Resolve what the caller ASKED FOR, refusing to guess when they did not say.
 *
 * 🛑 `flags.dryRun` ALONE CANNOT ANSWER THIS, AND A FIX THAT TRIES IS ITSELF A
 * SILENT NO-OP. A bare invocation and an explicit `--dry-run` BOTH parse to
 * `dryRun: true`, because `--no-dry-run` is declared first (see the load-bearing
 * ordering note in `command-registration.ts`). The only thing that separates them
 * is WHERE the value came from, which is why `command` is read here and is no
 * longer the unused parameter it used to be.
 *
 * ⚠️ THE KEY IS camelCase. Measured on the pinned commander 14.0.3:
 * `getOptionValueSource("dryRun")` returns `"default"` for a bare run and `"cli"`
 * for an explicit one, while the kebab form `getOptionValueSource("dry-run")`
 * returns `undefined` for BOTH. Using the kebab spelling would make every
 * invocation look unstated — this whole guard reduced to a constant, which is the
 * same class of defect it exists to prevent.
 */
export function resolveRunIntent(flags: SessionsArchiveFlags, command: Command): RunIntent {
  // `"cli"` means the user typed it; `"default"` means commander supplied it.
  const stated = command.getOptionValueSource?.("dryRun") === "cli";
  const dryStated = stated && flags.dryRun === true;
  // `--apply` and `--no-dry-run` are exact synonyms. The second is kept because it
  // is the spelling already measured working end to end; the first is the one to
  // write, because a double negative in a scheduler's log is unreadable.
  const applyStated = flags.apply === true || (stated && flags.dryRun === false);

  if (applyStated) {
    return dryStated ? "contradictory" : "apply";
  }
  return dryStated ? "dry-run" : "unstated";
}

/**
 * ⚠️ THIS MESSAGE IS A PRIMARY UX SURFACE, NOT AN ERROR STRING. It is the first
 * thing every human and every agent meets on this verb from now on, and a
 * diagnostic that misdescribes the situation costs more than the bug it reports.
 * Name BOTH flags, say which does what, and keep both lines copy-pasteable.
 */
const UNSTATED_INTENT_MESSAGE = [
  "`acpx sessions archive` needs you to state what you want; it will not guess.",
  "  preview (moves nothing):  acpx sessions archive --dry-run",
  "  actually move files:      acpx sessions archive --apply",
  "Silence used to mean a dry run. It now means neither, so a caller cannot omit",
  "the intent and get a plausible wrong answer. (`--no-dry-run` still means --apply.)",
].join("\n");

async function runArchiveVerb(
  context: ArchiveContext,
  flags: SessionsArchiveFlags,
  command: Command,
): Promise<number> {
  const intent = resolveRunIntent(flags, command);
  if (intent === "unstated") {
    throw new ArchiveRefusal(UNSTATED_INTENT_MESSAGE, "intent-unstated");
  }
  if (intent === "contradictory") {
    throw new ArchiveRefusal(
      "--apply and --dry-run were both given. A contradiction is as ambiguous as silence; pass exactly one.",
      "intent-contradictory",
    );
  }

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
    // Resolved from the STATED intent, never from a default — see resolveRunIntent.
    dryRun: intent === "dry-run",
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
    seatArchive: result.seatArchive,
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
  if (result.seatArchive) {
    lines.push(...seatArchiveReportLines(result.seatArchive).map((line) => `  ${line}`));
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
  // ⚠️ THIS BRANCH IS THE WHOLE FLAG, AND ITS ABSENCE WAS A LIE RATHER THAN A GAP.
  // `--list-orphans` was declared and routed here but never read, so it fell
  // through to the shard-index list below — which by design contains every id
  // EXCEPT an orphan. It exited 0 with well-formed output that named no orphan
  // ever, while `--status` actively advertised it ("use --list-orphans for ids").
  // Exit 0 + plausible + wrong is the worst ratio of confidence to correctness
  // this tool can produce.
  if (flags.listOrphans) {
    return await runListOrphansVerb(context, flags);
  }
  const { entries, shards, warnings } = await listArchived(context, {
    month: flags.month,
    limit: parseCount(flags.limit, "--limit"),
  });
  if (flags.json) {
    writeJson({ shards, entries, warnings });
  } else {
    writeArchivedListText(entries, warnings);
  }
  return warnings.length > 0 ? ARCHIVE_EXIT_PROBLEMS : ARCHIVE_EXIT_OK;
}

function writeArchivedListText(
  entries: readonly ArchiveIndexEntry[],
  warnings: readonly string[],
): void {
  for (const entry of entries) {
    const state = entry.closed === true ? "closed" : "open";
    process.stdout.write(
      `${entry.archivedAt}  ${entry.id}  ${entry.reason}  ${state}  ${entry.name ?? ""}\n`,
    );
  }
  for (const warning of warnings) {
    process.stderr.write(`[acpx] ⚠ ${warning}\n`);
  }
}

/**
 * `--list-orphans` — the ids behind `--status`'s orphan count.
 *
 * Ids only: an orphan has no record, so there is no name, kind, cwd or closed
 * state to show. The one action available on one is `acpx sessions restore <id>`,
 * which takes exact ids — so the text form is one bare id per line and pipes
 * straight into it.
 */
async function runListOrphansVerb(
  context: ArchiveContext,
  flags: SessionsArchiveFlags,
): Promise<number> {
  const { orphans, totalIds, files, bytes } = await listArchivedOrphans(context, {
    limit: parseCount(flags.limit, "--limit"),
  });
  if (flags.json) {
    writeJson({ ids: orphans.map((orphan) => orphan.id), totalIds, files, bytes });
    return ARCHIVE_EXIT_OK;
  }
  for (const orphan of orphans) {
    process.stdout.write(`${orphan.id}\n`);
  }
  // On stderr so stdout stays a clean id list for a pipe.
  process.stderr.write(
    `[acpx] ${orphans.length} of ${totalIds} orphan id(s); ${files} files / ${formatBytes(bytes)} total\n`,
  );
  return ARCHIVE_EXIT_OK;
}

async function runVerifyVerb(
  context: ArchiveContext,
  flags: SessionsArchiveFlags,
): Promise<number> {
  const deep = flags.deep === true;
  const report = await verifyArchive(context, { deep });
  const { checked, problems, corrupt, deepChecked } = report;
  if (flags.json) {
    writeJson({ checked, problems, ...(deep ? { deepChecked, corrupt } : {}) });
  } else {
    writeVerifyText(report, deep);
  }
  return problems.length > 0 || corrupt.length > 0 ? ARCHIVE_EXIT_PROBLEMS : ARCHIVE_EXIT_OK;
}

function writeVerifyText(report: Awaited<ReturnType<typeof verifyArchive>>, deep: boolean): void {
  const lines = [`verified ${report.checked} files from MANIFEST.tsv`];
  for (const problem of report.problems) {
    const label = problem.found === "neither" ? "LOST" : "MISPLACED";
    lines.push(
      `  ${label} ${problem.file} (id ${problem.id}): expected ${problem.expected}, found ${problem.found}`,
    );
  }
  if (deep) {
    lines.push(`decoded ${report.deepChecked} .zst files`);
  }
  for (const entry of report.corrupt) {
    lines.push(`  CORRUPT ${entry.file}.zst (${entry.check})`);
  }
  if (report.problems.length === 0 && report.corrupt.length === 0) {
    lines.push(`  no problems`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

// ────────────────────────────────────────────────────────────────────────────────
// brick 1861b06d — `acpx-archive-zst/v1` (cli-contract.md)
// ────────────────────────────────────────────────────────────────────────────────

/**
 * `--thaw <id> --to <dir>`. ⚠️ `--json` PUTS ONE DOCUMENT ON STDOUT ON SUCCESS AND ON
 * EVERY FAILURE — atrium parses stdout to tell "corrupt" from "too large" from "the
 * archive changed under me", and a refusal that only spoke on stderr would read to it
 * as an unexplained exit 2.
 */
async function runThawVerb(flags: SessionsArchiveFlags): Promise<number> {
  const id = flags.thaw ?? "";
  const to = flags.to ?? "";
  const hotDir = sessionBaseDir();
  const context = createContext(hotDir, "thaw");
  try {
    if (!flags.to) {
      throw new ArchiveRefusal("--thaw needs --to <empty dir>", "bad-argument");
    }
    const result = await thawArchivedSession({
      id,
      to,
      hotDir,
      archiveDir: context.archiveDir,
      maxBytes: parseByteSize(flags.maxBytes, "--max-bytes"),
    });
    if (flags.json) {
      writeJson(result);
    } else {
      process.stdout.write(
        `thawed ${result.files.length} files (${formatBytes(result.logicalBytes)}) of ${id} into ${result.to}\n`,
      );
    }
    return ARCHIVE_EXIT_OK;
  } catch (error) {
    if (!isThawFailure(error)) {
      throw error;
    }
    if (flags.json) {
      writeJson(thawErrorJson(id, to, error));
    }
    process.stderr.write(`[acpx] thaw refused: ${error.message}\n`);
    return ARCHIVE_EXIT_REFUSED;
  }
}

function isThawFailure(error: unknown): error is Error & { code?: string } {
  return (
    error instanceof ArchiveRefusal ||
    isArchivedFileCorrupt(error) ||
    (error as { code?: unknown } | undefined)?.code === "zstd-unavailable"
  );
}

/** `--cat <file>`: verified logical bytes to stdout; exit 2 on corruption or absence. */
async function runCatVerb(flags: SessionsArchiveFlags): Promise<number> {
  const context = createContext(sessionBaseDir(), "cat");
  try {
    const bytes = await catArchivedFile(context.archiveDir, flags.cat ?? "");
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
    return ARCHIVE_EXIT_OK;
  } catch (error) {
    if (!isThawFailure(error)) {
      throw error;
    }
    process.stderr.write(`[acpx] ${error.message}\n`);
    return ARCHIVE_EXIT_REFUSED;
  }
}

function sweepIntent(flags: SessionsArchiveFlags, command: Command): "dry-run" | "apply" {
  const intent = resolveRunIntent(flags, command);
  if (intent === "unstated") {
    throw new ArchiveRefusal(
      "`--compress` / `--decompress` need an explicit intent: --dry-run (writes nothing) or --apply.",
      "intent-unstated",
    );
  }
  if (intent === "contradictory") {
    throw new ArchiveRefusal(
      "--apply and --dry-run were both given; pass exactly one.",
      "intent-contradictory",
    );
  }
  return intent;
}

function sweepExitCode(result: CompressRunResult | DecompressRunResult): number {
  if (result.outcome !== "applied" && result.outcome !== "dry-run") {
    return ARCHIVE_EXIT_REFUSED;
  }
  const corrupt = result.action === "decompress" ? result.corrupt.length : 0;
  const problems =
    result.failures.length + result.quarantined.length + result.conflicts.length + corrupt;
  return problems > 0 ? ARCHIVE_EXIT_PROBLEMS : ARCHIVE_EXIT_OK;
}

function refusalEnvelope(
  action: "compress" | "decompress",
  context: ArchiveContext,
  refusal: ArchiveRefusal,
): unknown {
  return {
    action,
    outcome: "refused",
    applied: false,
    archiveDir: context.archiveDir,
    wave: context.wave,
    at: context.at,
    error: { code: refusal.code, message: refusal.message },
  };
}

async function runCompressVerb(
  context: ArchiveContext,
  flags: SessionsArchiveFlags,
  command: Command,
): Promise<number> {
  let result: CompressRunResult;
  try {
    const intent = sweepIntent(flags, command);
    result = await runCompressSweep({
      context,
      apply: intent === "apply",
      initialize: flags.initialize === true,
      maxBytes: parseByteSize(flags.maxBytes, "--max-bytes"),
      limit: parseCount(flags.limit, "--limit"),
      paceMbps: parsePositiveNumber(flags.paceMbps, "--pace-mbps"),
      skipReaderCheck: flags.skipReaderCheck === true,
      manifestOut: flags.manifestOut,
      readerProbe: createAtriumReaderProbe(
        resolveAtriumLocalOrigin(process.env, readAcpxUiInternalOriginSources()),
      ),
      runtimeInfoPath: RUNTIME_INFO_PATH,
    });
  } catch (error) {
    if (error instanceof ArchiveRefusal && flags.json) {
      writeJson(refusalEnvelope("compress", context, error));
    }
    throw error;
  }
  writeSweepResult(result, flags);
  return sweepExitCode(result);
}

async function runDecompressVerb(
  context: ArchiveContext,
  flags: SessionsArchiveFlags,
  command: Command,
): Promise<number> {
  let result: DecompressRunResult;
  try {
    const intent = sweepIntent(flags, command);
    const ids = Array.isArray(flags.decompress) ? flags.decompress : [];
    if (ids.length > 0 === (flags.all === true)) {
      throw new ArchiveRefusal(
        "--decompress needs exactly one of: <id...> or --all",
        "bad-argument",
      );
    }
    result = await runDecompressSweep({
      context,
      ids: flags.all ? "all" : ids,
      apply: intent === "apply",
    });
  } catch (error) {
    if (error instanceof ArchiveRefusal && flags.json) {
      writeJson(refusalEnvelope("decompress", context, error));
    }
    throw error;
  }
  writeSweepResult(result, flags);
  return sweepExitCode(result);
}

function writeSweepResult(
  result: CompressRunResult | DecompressRunResult,
  flags: SessionsArchiveFlags,
): void {
  if (result.error) {
    process.stderr.write(`[acpx] ${result.action} ${result.outcome}: ${result.error.message}\n`);
  }
  for (const warning of result.warnings) {
    process.stderr.write(`[acpx] ⚠ ${warning}\n`);
  }
  if (flags.json) {
    writeJson(result);
    return;
  }
  process.stdout.write(`${sweepTextLines(result).join("\n")}\n`);
}

function sweepTextLines(result: CompressRunResult | DecompressRunResult): string[] {
  const lines = [
    `[${result.outcome.toUpperCase()}] ${result.action} wave ${result.wave}`,
    `  archive: ${result.archiveDir}`,
  ];
  if (result.action === "compress") {
    lines.push(
      `  eligible: ${result.eligible.files} files / ${formatBytes(result.eligible.logicalBytes)}; selected ${result.selected}${result.budget.exhausted ? " (budget reached)" : ""}`,
      `  compressed: ${result.compressed.length} files, ${formatBytes(result.bytesBefore)} -> ${formatBytes(result.bytesAfter)}`,
    );
    if (result.estimate) {
      lines.push(
        `  estimate: ratio ${result.estimate.ratio.toFixed(3)} -> ~${formatBytes(result.estimate.projectedZstBytes)} on disk`,
      );
    }
    lines.push(
      `  skipped ${result.skipped.length} · aborted ${result.aborted.length} · resolved ${result.resolved.length}`,
    );
  } else {
    lines.push(
      `  selected: ${result.selected.files} .zst files / ${formatBytes(result.selected.logicalBytes)} logical`,
      `  decompressed: ${result.decompressed.length} · resolved ${result.resolved.length} · corrupt ${result.corrupt.length}`,
    );
  }
  for (const entry of [...result.quarantined, ...result.conflicts]) {
    lines.push(`  QUARANTINED ${entry.file}: ${entry.reason}`);
  }
  for (const failure of result.failures) {
    lines.push(`  FAILED ${failure.file}: ${failure.error}`);
  }
  return lines;
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
    const problems = result.skipped.length + result.failures.length;
    process.exitCode = problems > 0 ? ARCHIVE_EXIT_PROBLEMS : ARCHIVE_EXIT_OK;
  } catch (error) {
    const refusal = asRestoreRefusal(error);
    if (!refusal) {
      throw error;
    }
    if (flags.json) {
      writeJson({ refused: true, error: { code: refusal.code, message: refusal.message } });
    }
    process.stderr.write(`[acpx] refused: ${refusal.message}\n`);
    process.exitCode = ARCHIVE_EXIT_REFUSED;
  }
}

function asRestoreRefusal(error: unknown): ArchiveRefusal | undefined {
  if (error instanceof ArchiveRefusal) {
    return error;
  }
  if ((error as { code?: unknown } | undefined)?.code === "zstd-unavailable") {
    return new ArchiveRefusal((error as Error).message, "zstd-unavailable");
  }
  return undefined;
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
  for (const failure of result.failures) {
    process.stdout.write(`FAILED ${failure.id} ${failure.file}: ${failure.error} — run --repair\n`);
  }
  if (result.seatArchive) {
    for (const line of seatArchiveReportLines(result.seatArchive)) {
      process.stdout.write(`${line}\n`);
    }
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
