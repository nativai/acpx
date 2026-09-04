import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isClaudeFamilyAgent } from "../acp/agent-command.js";
import type { SessionRecord } from "../types.js";
import { listSessions, sessionBaseDir, writeSessionRecord } from "./persistence.js";

/**
 * THE ONE-SHOT SWEEP for records the account/subscription seam already wedged
 * (CONCEPTION §5.5; brick https://acpx.devbox.nativai.de/?brick=07bc257a).
 *
 * The gate in `runtime/engine/failover.ts` + `runtime/engine/account-seam.ts` +
 * `runtime/engine/reconnect.ts` stops NEW damage. It does not free the sessions
 * that are already broken: a non-Claude record that already carries
 * `session_options.profile` is refused at spawn by
 * `assertCodexProfileCompatibility` (a Claude subscription profile on a codex
 * adapter), and one that already carries `session_options.account_switch` was,
 * before the resume gate landed, refused at every resume for want of a Claude
 * SDK transcript it can never have. The conception is explicit that gating the
 * writer alone *"leaves already-wedged records unrecoverable"* — this is the
 * other half.
 *
 * ## Why this is a repair and not a migration
 *
 * It clears {@link CLEARED_FIELDS} — and only those — from records that should
 * never have had them, identified by the same {@link isClaudeFamilyAgent}
 * predicate the gates use, so the review of what it WILL do checks the same
 * logic it then runs. It is **idempotent** (a second run finds nothing because
 * the first removed the only thing it looks for), **re-runnable**, and **backs
 * up every file it touches, reading the backup back, before touching it**.
 *
 * ## What it deliberately does NOT do
 *
 * - It does not touch a record whose `agent_command` is **empty** — subagent
 *   records carry none (`persistence/parse.ts`: *"agent_command is required for
 *   regular sessions but absent for subagents"*), so "not Claude family" there
 *   means "not stated", not "not Claude". They are counted and reported as
 *   skipped rather than silently swept.
 * - **It does not clear `auto_failover`**, which CONCEPTION §5.5 also lists as
 *   Claude-family. That field currently carries the fleet's
 *   `set auto-failover off` workaround — the only thing keeping opencode and pi
 *   sessions alive until this gate deploys — so clearing it would re-wedge
 *   exactly the sessions this sweep exists to free (WS-core, 2026-09-04).
 * - It does not clear `auto_subscription`, which was not observed on any record
 *   in the measured wedged population. This sweep does not widen to fields
 *   nobody has seen.
 * - It does not touch a record with a **live queue owner**: those are skipped and
 *   listed, never waited on.
 * - It does not touch a Claude-family record at all, for any reason.
 */

/**
 * The Claude-family fields this sweep CLEARS from a non-Claude record.
 *
 * `subscription` is in scope on WS-core's ruling (2026-09-04): CONCEPTION §5.5
 * lists it Claude-family-only, and leaving a known-meaningless Claude-family
 * field on a non-Claude record is exactly the state that produced this bug. It
 * being inert today is what makes clearing it SAFE, not what makes it
 * unnecessary — a future code path could read it without an adapter gate.
 */
const CLEARED_FIELDS = ["profile", "account_switch", "subscription"] as const;

type ClearedField = (typeof CLEARED_FIELDS)[number];

/** One record the sweep considered, and what it decided about it. */
export interface AccountSeamRepairEntry {
  acpxRecordId: string;
  agentCommand: string;
  /** Which of {@link CLEARED_FIELDS} were present before the repair. */
  cleared: ClearedField[];
  /**
   * `auto_failover` was present and was DELIBERATELY LEFT. It is Claude-family
   * by §5.5, but the fleet's `acpx <agent> set auto-failover off` workaround is
   * what keeps opencode and pi sessions alive until this fix ships — stripping it
   * would re-wedge the very sessions this sweep exists to free (WS-core,
   * 2026-09-04). It stops mattering once the gate is deployed; it is not this
   * sweep's job to decide that moment.
   */
  retainedAutoFailover: boolean;
  /**
   * `auto_subscription` was present and left alone: it was not measured on any
   * record in the wedged population, and this sweep does not widen to fields
   * nobody has seen.
   */
  retainedAutoSubscription: boolean;
  /** Absolute path of the backup taken before the write; absent in dry-run. */
  backupPath?: string;
}

export interface AccountSeamRepairResult {
  /** Every record the sweep read. */
  scanned: number;
  /** Claude-family records, left untouched by construction. */
  skippedClaudeFamily: number;
  /** Records with no `agent_command` (subagents); deliberately not swept. */
  skippedUnknownAgent: number;
  /** Non-Claude records that carried neither field — nothing to do. */
  alreadyClean: number;
  /** Non-Claude records that carried at least one cleared field. */
  repaired: AccountSeamRepairEntry[];
  /**
   * Records that WOULD have been repaired but have a live queue owner. Listed,
   * never waited on, and safe to pick up on a later run.
   */
  skippedBusy: AccountSeamRepairEntry[];
  /** Records that matched but could not be written; the sweep continues past them. */
  failures: Array<{ acpxRecordId: string; error: string }>;
  /** Where the backups went; absent in dry-run. */
  backupDir?: string;
  dryRun: boolean;
}

export interface AccountSeamRepairOptions {
  /** Report what would change and write nothing. */
  dryRun?: boolean;
  /**
   * Where to copy each record's raw JSON before rewriting it. Defaults to a
   * timestamped directory under `~/.acpx/backups/`. Created if absent.
   */
  backupDir?: string;
  /** Seam for tests; defaults to the real store. */
  loadRecords?: () => Promise<SessionRecord[]>;
  /** Seam for tests; defaults to the real store writer. */
  saveRecord?: (record: SessionRecord) => Promise<void>;
  /** Seam for tests; defaults to `~/.acpx/sessions`. */
  storeDir?: () => string;
  /**
   * Whether a record is currently owned by a live queue owner or has a turn in
   * flight. Defaults to a real lease read.
   *
   * ⚠️ THE DEFAULT MUST STAY SAFE. If something re-reads a half-written record
   * mid-turn, the sweep has corrupted a LIVE session rather than repaired a dead
   * one. A busy record is skipped and listed, never waited on.
   */
  isRecordBusy?: (record: SessionRecord) => Promise<boolean>;
}

/**
 * The real lease read, imported lazily so this module — which lives under
 * `src/session/` — does not take a static dependency on the CLI's queue layer.
 */
async function defaultIsRecordBusy(record: SessionRecord): Promise<boolean> {
  const { readQueueOwnerLiveness } = await import("../cli/queue/ipc.js");
  // A LIVE OWNER ALONE IS ENOUGH TO SKIP — deliberately, and not only an
  // in-flight turn. An idle owner still holds the record open and rewrites it on
  // its own schedule (checkpoints, lifecycle, model replay), so a repair written
  // underneath it can simply be overwritten, or worse, interleave. The sweep is
  // for records nothing is currently driving; a skipped record is listed and can
  // be swept on a later run once its owner is gone.
  const liveness = await readQueueOwnerLiveness(record.acpxRecordId);
  return liveness.alive;
}

function defaultBackupDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(
    process.env.ACPX_STATE_HOME || os.homedir(),
    ".acpx",
    "backups",
    `account-seam-repair-${stamp}`,
  );
}

/**
 * The record's own file, by the same rule `repository.ts` uses to write it
 * (`encodeURIComponent(acpxRecordId) + ".json"`). Kept next to the sweep rather
 * than exported from the repository so the sweep cannot silently drift onto a
 * different naming rule than the one the store actually uses — the backup is
 * verified to exist and to be non-empty before the write, so a drift fails
 * loudly on the first record instead of producing empty backups for all of them.
 */
function recordFilePath(storeDir: string, acpxRecordId: string): string {
  return path.join(storeDir, `${encodeURIComponent(acpxRecordId)}.json`);
}

async function backupRecordFile(
  storeDir: string,
  backupDir: string,
  acpxRecordId: string,
): Promise<string> {
  const source = recordFilePath(storeDir, acpxRecordId);
  const payload = await fs.readFile(source, "utf8");
  if (payload.trim().length === 0) {
    throw new Error(`refusing to repair ${acpxRecordId}: its record file is empty (${source})`);
  }
  await fs.mkdir(backupDir, { recursive: true });
  const destination = path.join(backupDir, path.basename(source));
  await fs.writeFile(destination, payload, "utf8");
  // Verify the backup by reading it back: a write that reported success and
  // produced nothing would leave the repair unrecoverable, which is the one
  // failure this whole step exists to prevent.
  const verified = await fs.readFile(destination, "utf8");
  if (verified !== payload) {
    throw new Error(`refusing to repair ${acpxRecordId}: backup at ${destination} does not match`);
  }
  return destination;
}

/**
 * One record's verdict: an entry to repair, or the bucket it was counted into.
 * Split out so the sweep loop itself stays inside the lint complexity budget and,
 * more usefully, so the classification can be read in one place.
 */
type RecordVerdict =
  | { kind: "skip-claude-family" }
  | { kind: "skip-unknown-agent" }
  | { kind: "already-clean" }
  | { kind: "repair"; entry: AccountSeamRepairEntry };

function classifyRecord(record: SessionRecord): RecordVerdict {
  const agentCommand = record.agentCommand.trim();
  if (agentCommand.length === 0) {
    return { kind: "skip-unknown-agent" };
  }
  if (isClaudeFamilyAgent(agentCommand)) {
    return { kind: "skip-claude-family" };
  }
  const options: Record<string, unknown> = record.acpx?.session_options ?? {};
  const entry: AccountSeamRepairEntry = {
    acpxRecordId: record.acpxRecordId,
    agentCommand,
    cleared: CLEARED_FIELDS.filter((field) => options[field] !== undefined),
    retainedAutoFailover: options.auto_failover !== undefined,
    retainedAutoSubscription: options.auto_subscription !== undefined,
  };
  if (entry.cleared.length === 0) {
    return { kind: "already-clean" };
  }
  return { kind: "repair", entry };
}

/** Verdict kinds that are pure counters, mapped to the field each increments. */
const SKIP_COUNTERS = {
  "skip-unknown-agent": "skippedUnknownAgent",
  "skip-claude-family": "skippedClaudeFamily",
  "already-clean": "alreadyClean",
} as const;

/**
 * Clear {@link CLEARED_FIELDS} in place. Nothing else in `session_options` is
 * touched — `auto_failover` and `auto_subscription` in particular are retained
 * on purpose (see {@link AccountSeamRepairEntry}).
 */
function clearSeamFields(record: SessionRecord): void {
  const acpx = record.acpx ?? {};
  const nextOptions: Record<string, unknown> = { ...acpx.session_options };
  for (const field of CLEARED_FIELDS) {
    delete nextOptions[field];
  }
  record.acpx = { ...acpx, session_options: nextOptions as typeof acpx.session_options };
}

/**
 * Run (or preview) the sweep. Never throws for a single bad record: a failure is
 * collected in `failures` and the sweep continues, so one unreadable file cannot
 * strand the rest of the store.
 */
type SweepConfig = {
  dryRun: boolean;
  storeDir: string;
  /** Empty string in a dry run: nothing is written, so nothing is backed up. */
  backupDir: string;
  loadRecords: () => Promise<SessionRecord[]>;
  save: (record: SessionRecord) => Promise<void>;
  isRecordBusy: (record: SessionRecord) => Promise<boolean>;
};

function resolveSweepConfig(options: AccountSeamRepairOptions): SweepConfig {
  const dryRun = options.dryRun === true;
  return {
    dryRun,
    storeDir: (options.storeDir ?? sessionBaseDir)(),
    backupDir: dryRun ? "" : (options.backupDir ?? defaultBackupDir()),
    loadRecords: options.loadRecords ?? listSessions,
    save: options.saveRecord ?? writeSessionRecord,
    isRecordBusy: options.isRecordBusy ?? defaultIsRecordBusy,
  };
}

export async function repairAccountSeamRecords(
  options: AccountSeamRepairOptions = {},
): Promise<AccountSeamRepairResult> {
  const config = resolveSweepConfig(options);
  const records = await config.loadRecords();

  const result: AccountSeamRepairResult = {
    scanned: records.length,
    skippedClaudeFamily: 0,
    skippedUnknownAgent: 0,
    alreadyClean: 0,
    repaired: [],
    skippedBusy: [],
    failures: [],
    ...(config.dryRun ? {} : { backupDir: config.backupDir }),
    dryRun: config.dryRun,
  };

  for (const record of records) {
    const verdict = classifyRecord(record);
    if (verdict.kind !== "repair") {
      result[SKIP_COUNTERS[verdict.kind]] += 1;
      continue;
    }
    // The liveness check runs in the DRY RUN TOO, so the listing reviewed before
    // the write is the same population the write will touch — a listing that
    // included a busy record would be reviewed against a set the sweep then
    // silently narrows.
    if (await config.isRecordBusy(record)) {
      result.skippedBusy.push(verdict.entry);
      continue;
    }
    if (config.dryRun) {
      result.repaired.push(verdict.entry);
      continue;
    }
    await applyRepair(record, verdict.entry, config, result);
  }

  return result;
}

/**
 * Back up, then clear, then write — in that order, and the order is the safety
 * property. A backup failure aborts THIS record before any mutation and is
 * reported; the sweep moves on to the next.
 */
async function applyRepair(
  record: SessionRecord,
  entry: AccountSeamRepairEntry,
  config: SweepConfig,
  result: AccountSeamRepairResult,
): Promise<void> {
  try {
    entry.backupPath = await backupRecordFile(
      config.storeDir,
      config.backupDir,
      record.acpxRecordId,
    );
    clearSeamFields(record);
    // ⚠️ The write itself is ATOMIC by construction, not by anything added here:
    // `writeSessionRecord` → `writeSessionRecordInternal` writes
    // `<file>.<pid>.<ts>.<uuid>.tmp` and `fs.rename`s it over the target
    // (`session/persistence/repository.ts`). A partial record cannot be observed.
    // Do not "improve" this by writing the file directly.
    await config.save(record);
    result.repaired.push(entry);
  } catch (error) {
    result.failures.push({
      acpxRecordId: record.acpxRecordId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function formatRepairEntry(entry: AccountSeamRepairEntry): string {
  return `  ${entry.acpxRecordId}  [${entry.agentCommand}]  ${entry.cleared.join(", ")}`;
}

/**
 * PER-FIELD counts, not just a record count (WS-core, 2026-09-04): a sweep that
 * reports "56 records repaired" cannot be audited field by field, and the two
 * fields it deliberately did NOT clear are exactly the ones a reader would
 * otherwise assume it had.
 */
function formatFieldCounts(result: AccountSeamRepairResult): string[] {
  const cleared = CLEARED_FIELDS.map(
    (field) =>
      `${field} cleared: ${result.repaired.filter((e) => e.cleared.includes(field)).length}`,
  );
  const retainedFailover = result.repaired.filter((e) => e.retainedAutoFailover).length;
  const retainedSubscription = result.repaired.filter((e) => e.retainedAutoSubscription).length;
  return [
    `  fields: ${cleared.join(", ")}`,
    `  auto_failover DELIBERATELY RETAINED on ${retainedFailover} record(s) — it is Claude-family ` +
      `by CONCEPTION §5.5, but it is also the "set auto-failover off" workaround keeping opencode ` +
      `and pi sessions alive; clearing it would re-wedge the sessions this sweep frees.`,
    `  auto_subscription left alone on ${retainedSubscription} record(s) — not part of the measured ` +
      `wedged population; this sweep does not widen to fields nobody has seen.`,
  ];
}

/**
 * Human-readable summary. States what it SKIPPED as well as what it changed,
 * unconditionally — a sweep that reports only its successes cannot be told apart
 * from a sweep that examined nothing.
 */
export function formatAccountSeamRepairResult(result: AccountSeamRepairResult): string {
  const verb = result.dryRun ? "would repair" : "repaired";
  const lines: string[] = [
    `scanned ${result.scanned} record(s): ${verb} ${result.repaired.length}, ` +
      `already clean ${result.alreadyClean}, skipped ${result.skippedClaudeFamily} Claude-family, ` +
      `skipped ${result.skippedUnknownAgent} with no agent command (subagents), ` +
      `skipped ${result.skippedBusy.length} with a live queue owner`,
    ...(result.backupDir ? [`backups: ${result.backupDir}`] : []),
    ...result.repaired.map(formatRepairEntry),
    ...formatFieldCounts(result),
    ...(result.skippedBusy.length > 0
      ? [
          `  SKIPPED (live owner — re-run later, never waited on):`,
          ...result.skippedBusy.map(formatRepairEntry),
        ]
      : []),
    ...result.failures.map((failure) => `  FAILED ${failure.acpxRecordId}: ${failure.error}`),
  ];
  if (result.repaired.length === 0 && result.failures.length === 0) {
    lines.push("nothing to repair.");
  }
  return lines.join("\n");
}
