import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sessionArchiveDirFor } from "../archive/paths.js";
import { encodeSessionSafeId } from "../archive/safe-id.js";
import {
  parseSeatFromPersisted,
  readSeatStore,
  SEAT_STORE_NO_CHANGE,
  seatToPersisted,
  withSeatStoreWrite,
  type SeatRecord,
} from "./seat-store.js";

/**
 * A SEAT IS ARCHIVED WITH ITS ACTIVE HOLDER — brick `87497c17`, Daniel's Option A
 * (2026-10-07T07:22:00Z).
 *
 * The retention wave moves a session record into the archive tier; a seat whose ACTIVE
 * holder it was then names a record that is no longer hot (DANGLING). This module moves
 * such a seat's ROW out of `seats.json` into a ledger, and back when the holder returns.
 *
 * ## The ledger is a SUBDIRECTORY of the sessions dir — never a file beside the records
 *
 * `~/.acpx/sessions/seat-archive/<seat-id>.json`, the row exactly as the seat store
 * serialises it (`seatToPersisted`) plus `holder_id`, `archived_at` and `wave`.
 * 🛑 NOT a file in the sessions dir: every deny-list enumerator there (`session-dir-files.ts`)
 * reads an unknown `.json` as a session record. 🛑 NOT inside the archive dir: that is a
 * frozen contract both repos enumerate, and acpx-ui's shard rewrite drops unknown keys.
 * A subdirectory is skipped by every enumerator (they all filter `isFile()`), exactly like
 * acpx-ui's `seat-briefs/`.
 *
 * ## The row is never in NEITHER place
 *
 * At every instant a seat's row is in `seats.json`, in the ledger, or (transiently) in
 * both. Folding writes the ledger file BEFORE the row is removed; unfolding re-inserts the
 * row BEFORE the ledger file is deleted. A run killed between the two leaves the row in
 * both places, and the next run — any caller — finishes it (the both-present rules below).
 *
 * ## ONE `seats.json` write per run
 *
 * Every `seats.json` change makes acpx-ui rebuild its whole session hub, so a wave that
 * folds 123 seats must not write the store 123 times. All removals and re-insertions of a
 * run are decided against the store read fresh INSIDE the hold, and land in one write.
 */

/** The ledger's directory name inside `SESSIONS_DIR`. */
export const SEAT_ARCHIVE_DIR = "seat-archive";

export function seatArchiveDir(sessionDir: string): string {
  return path.join(sessionDir, SEAT_ARCHIVE_DIR);
}

function ledgerFile(sessionDir: string, seatId: string): string {
  return path.join(seatArchiveDir(sessionDir), `${seatId}.json`);
}

/** One parsed ledger file. `raw` is the file exactly as read, for the dropped-row report. */
export type SeatArchiveLedgerEntry = {
  row: SeatRecord;
  holderId: string;
  archivedAt: string;
  wave: string;
  raw: Record<string, unknown>;
};

export type SeatArchiveMove = { seatId: string; holderId: string; name: string | undefined };

export type SeatArchiveReconcileResult = {
  dryRun: boolean;
  /** Rows moved from `seats.json` to the ledger (dry run: would be). */
  folded: SeatArchiveMove[];
  /** Rows moved back from the ledger to `seats.json` (dry run: would be). */
  unfolded: SeatArchiveMove[];
  /** Rows whose holder is archived and whose seat is STARRED: left in place, reported.
   * The archiver's star guard should have kept such a holder hot (brick 42ee6cb4). */
  starred: SeatArchiveMove[];
  /** Ledger files deleted because the hot row stands (a finished unfold, a moved pointer,
   * an interrupted fold whose holder came back). `differs` = the dropped ledger row was not
   * the row that stays, which is worth an operator's eye. */
  dropped: { seatId: string; holderId: string; differs: boolean; ledger: unknown }[];
  /** Ledger files that do not parse, and other conditions that left a seat untouched. */
  problems: string[];
  /** 0 or 1 — the run's `seats.json` writes. */
  seatStoreWrites: number;
};

export type SeatArchiveReconcileOptions = {
  sessionDir: string;
  /** Defaults to the archive tier beside `sessionDir`. */
  archiveDir?: string;
  /** Restrict the run to these holders (restore, the one-holder verb). Omitted ⇒ every seat. */
  holderIds?: ReadonlySet<string>;
  dryRun: boolean;
  /** Dry run of a wave: holders the wave WOULD archive, read as archived. */
  assumeArchived?: ReadonlySet<string>;
  at: string;
  wave: string;
};

function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function parseLedgerEntry(raw: unknown): SeatArchiveLedgerEntry | undefined {
  const row = parseSeatFromPersisted(raw);
  if (!row) {
    return undefined;
  }
  const fields = raw as Record<string, unknown>;
  if (typeof fields.holder_id !== "string" || fields.holder_id.length === 0) {
    return undefined;
  }
  return {
    row,
    holderId: fields.holder_id,
    archivedAt: typeof fields.archived_at === "string" ? fields.archived_at : "",
    wave: typeof fields.wave === "string" ? fields.wave : "",
    raw: fields,
  };
}

export type SeatArchiveLedger = {
  entries: Map<string, SeatArchiveLedgerEntry>;
  /**
   * Seat ids whose ledger file EXISTS and does not parse (outside damage — every write is temp +
   * rename). 🛑 STILL ARCHIVED: the file is the seat's only copy, so every reader that skips a
   * ledger seat (the backfill) must skip these too, or it re-mints the seat from a retired holder.
   */
  unreadable: string[];
  problems: string[];
};

/**
 * Every ledger entry, keyed by seat id. A file that does not parse is NAMED in `problems`
 * and `unreadable`, and never deleted: it may be the only copy of a seat row.
 */
export async function readSeatArchiveLedger(sessionDir: string): Promise<SeatArchiveLedger> {
  const entries = new Map<string, SeatArchiveLedgerEntry>();
  const unreadable: string[] = [];
  const problems: string[] = [];
  let files: string[];
  try {
    files = await fs.readdir(seatArchiveDir(sessionDir));
  } catch (error) {
    if (isAbsent(error)) {
      return { entries, unreadable, problems };
    }
    throw error;
  }
  for (const file of files.filter((name) => name.endsWith(".json")).toSorted()) {
    const seatId = file.slice(0, -".json".length);
    let entry: SeatArchiveLedgerEntry | undefined;
    try {
      entry = parseLedgerEntry(
        JSON.parse(await fs.readFile(path.join(seatArchiveDir(sessionDir), file), "utf8")),
      );
    } catch (error) {
      if (isAbsent(error)) {
        continue;
      }
      entry = undefined;
    }
    if (!entry || entry.row.seatId !== seatId) {
      unreadable.push(seatId);
      problems.push(unreadableLedgerMessage(seatId, path.join(seatArchiveDir(sessionDir), file)));
      continue;
    }
    entries.set(seatId, entry);
  }
  return { entries, unreadable, problems };
}

function unreadableLedgerMessage(seatId: string, file: string): string {
  return (
    `seat ${seatId} is ARCHIVED, but its ledger file ${file} does not parse — it is the seat's ` +
    `only copy, so nothing re-mints or deletes it. Repair it by hand (or restore it from a backup).`
  );
}

/**
 * The refusal text for a seat that is in the ledger, or `undefined` when it is not — shared by
 * every refusal of a missing seat (`--seat`/`?seat=`/`--parent-seat` and the `seats` verbs), so
 * they cannot drift. A ledger file that exists and does not parse is still an archived seat.
 */
export async function archivedSeatRefusal(
  sessionDir: string,
  seatId: string,
): Promise<string | undefined> {
  const file = ledgerFile(sessionDir, seatId);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  let entry: SeatArchiveLedgerEntry | undefined;
  try {
    entry = parseLedgerEntry(JSON.parse(text));
  } catch {
    entry = undefined;
  }
  return entry ? archivedSeatMessage(seatId, entry) : unreadableLedgerMessage(seatId, file);
}

function archivedSeatMessage(seatId: string, entry: SeatArchiveLedgerEntry): string {
  return (
    `seat ${seatId}${entry.row.name ? ` (${JSON.stringify(entry.row.name)})` : ""} is ARCHIVED ` +
    `with its active holder ${entry.holderId} (moved to the archive tier${
      entry.archivedAt ? ` at ${entry.archivedAt}` : ""
    }). Restore the holder and the seat comes back with it: ` +
    `\`acpx sessions restore ${entry.holderId}\`.`
  );
}

async function writeLedgerFile(
  sessionDir: string,
  row: SeatRecord,
  at: string,
  wave: string,
): Promise<void> {
  const target = ledgerFile(sessionDir, row.seatId);
  const payload = {
    ...seatToPersisted(row),
    holder_id: row.activeHolderId,
    archived_at: at,
    wave,
  };
  const temp = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(payload)}\n`, "utf8");
  await fs.rename(temp, target);
}

async function deleteLedgerFile(sessionDir: string, seatId: string): Promise<void> {
  await fs.rm(ledgerFile(sessionDir, seatId), { force: true });
}

type HolderState = "hot" | "archived" | "gone";

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (isAbsent(error)) {
      return false;
    }
    throw error;
  }
}

/** Where a holder's record FILE is. Hot wins: a record in both places is hot. */
async function holderStateOf(
  hotFiles: ReadonlySet<string>,
  archiveDir: string,
  holderId: string,
  assumeArchived?: ReadonlySet<string>,
): Promise<HolderState> {
  if (assumeArchived?.has(holderId) === true) {
    return "archived";
  }
  const file = `${encodeSessionSafeId(holderId)}.json`;
  if (hotFiles.has(file)) {
    return "hot";
  }
  return (await fileExists(path.join(archiveDir, file))) ? "archived" : "gone";
}

function moveOf(row: SeatRecord, holderId: string): SeatArchiveMove {
  return { seatId: row.seatId, holderId, name: row.name };
}

function inScope(holderIds: ReadonlySet<string> | undefined, holderId: string | null): boolean {
  return holderIds === undefined || (holderId !== null && holderIds.has(holderId));
}

type Plan = {
  /** Rows to fold, as read — the compare-and-delete pointer is `activeHolderId`. */
  folds: SeatRecord[];
  /** Ledger rows to put back. */
  unfolds: SeatArchiveLedgerEntry[];
  starred: SeatArchiveMove[];
  /** Ledger entries beside a row that stays. */
  beside: SeatArchiveLedgerEntry[];
};

type PlanInputs = {
  options: SeatArchiveReconcileOptions;
  archiveDir: string;
  hotFiles: ReadonlySet<string>;
};

/** A row whose active holder is archived: fold it, or — starred — report it. */
async function planRow(inputs: PlanInputs, row: SeatRecord, plan: Plan): Promise<void> {
  const holderId = row.activeHolderId;
  if (holderId === null || !inScope(inputs.options.holderIds, holderId)) {
    return;
  }
  const state = await holderStateOf(
    inputs.hotFiles,
    inputs.archiveDir,
    holderId,
    inputs.options.assumeArchived,
  );
  if (state !== "archived") {
    return;
  }
  if (row.favorite === true) {
    plan.starred.push(moveOf(row, holderId));
    return;
  }
  plan.folds.push(row);
}

/** A ledger entry: beside a standing row, back to a hot holder, or left archived. */
async function planLedgerEntry(
  inputs: PlanInputs,
  entry: SeatArchiveLedgerEntry,
  seats: ReadonlyMap<string, SeatRecord>,
  plan: Plan,
): Promise<void> {
  if (seats.has(entry.row.seatId)) {
    plan.beside.push(entry);
    return;
  }
  if ((await holderStateOf(inputs.hotFiles, inputs.archiveDir, entry.holderId)) === "hot") {
    plan.unfolds.push(entry);
  }
  // Ledger only, holder still archived (or gone): the archived state. Nothing to do.
}

async function planReconcile(
  inputs: PlanInputs,
  seats: ReadonlyMap<string, SeatRecord>,
  ledger: ReadonlyMap<string, SeatArchiveLedgerEntry>,
): Promise<Plan> {
  const plan: Plan = { folds: [], unfolds: [], starred: [], beside: [] };
  for (const row of seats.values()) {
    await planRow(inputs, row, plan);
  }
  const folding = new Set(plan.folds.map((row) => row.seatId));
  for (const [seatId, entry] of ledger) {
    if (inScope(inputs.options.holderIds, entry.holderId) && !folding.has(seatId)) {
      await planLedgerEntry(inputs, entry, seats, plan);
    }
  }
  return plan;
}

function emptyResult(dryRun: boolean): SeatArchiveReconcileResult {
  return {
    dryRun,
    folded: [],
    unfolded: [],
    starred: [],
    dropped: [],
    problems: [],
    seatStoreWrites: 0,
  };
}

function droppedOf(
  entry: SeatArchiveLedgerEntry,
  standing: SeatRecord | undefined,
): SeatArchiveReconcileResult["dropped"][number] {
  const differs =
    standing === undefined ||
    JSON.stringify(seatToPersisted(standing)) !== JSON.stringify(seatToPersisted(entry.row));
  return { seatId: entry.row.seatId, holderId: entry.holderId, differs, ledger: entry.raw };
}

type HoldOutcome = {
  removed: SeatRecord[];
  /** Fold candidates whose row is still present but must stay (pointer moved, starred since). */
  keptRows: SeatRecord[];
  inserted: SeatArchiveLedgerEntry[];
  /** Ledger entries beside a row that stands at write time — the row stays, the ledger goes. */
  presentRows: { entry: SeatArchiveLedgerEntry; standing: SeatRecord }[];
  malformed: string[];
};

/** Compare-and-delete: only a row whose pointer is still the folded one, and still unstarred. */
function holdFolds(seats: Map<string, SeatRecord>, folds: readonly SeatRecord[], out: HoldOutcome) {
  for (const fold of folds) {
    const fresh = seats.get(fold.seatId);
    if (!fresh) {
      continue; // already gone: its ledger file must stay
    }
    if (fresh.activeHolderId === fold.activeHolderId && fresh.favorite !== true) {
      seats.delete(fold.seatId);
      out.removed.push(fresh);
    } else {
      out.keptRows.push(fresh);
    }
  }
}

/** Insert-if-absent — `backfillSeatRow`'s rule, for every unfold of the run in one write. */
function holdUnfolds(
  seats: Map<string, SeatRecord>,
  malformedSeatIds: readonly string[],
  unfolds: readonly SeatArchiveLedgerEntry[],
  out: HoldOutcome,
) {
  for (const entry of unfolds) {
    const seatId = entry.row.seatId;
    const standing = seats.get(seatId);
    if (malformedSeatIds.includes(seatId)) {
      out.malformed.push(seatId);
    } else if (standing) {
      out.presentRows.push({ entry, standing });
    } else {
      seats.set(seatId, entry.row);
      out.inserted.push(entry);
    }
  }
}

function holdBeside(
  seats: ReadonlyMap<string, SeatRecord>,
  beside: readonly SeatArchiveLedgerEntry[],
  out: HoldOutcome,
) {
  for (const entry of beside) {
    const standing = seats.get(entry.row.seatId);
    // Gone since the plan (a concurrent fold): its ledger file is now the only copy.
    if (standing) {
      out.presentRows.push({ entry, standing });
    }
  }
}

/**
 * THE ONE WRITE. Decided against the store read fresh inside the hold:
 * - a fold removes the row only if its pointer is the one the ledger file was written
 *   from and it is still not starred (the `reapHolderlessSeats` compare);
 * - an unfold inserts the ledger row only where no row exists (`backfillSeatRow`'s
 *   insert-if-absent, for many seats in one write).
 * A row that is already gone is left alone — its ledger file must then stay.
 */
async function applyInOneWrite(
  sessionDir: string,
  plan: Plan,
): Promise<{ outcome: HoldOutcome; wrote: boolean }> {
  return await withSeatStoreWrite(sessionDir, (store) => {
    const seats = new Map(store.seats);
    const outcome: HoldOutcome = {
      removed: [],
      keptRows: [],
      inserted: [],
      presentRows: [],
      malformed: [],
    };
    holdFolds(seats, plan.folds, outcome);
    holdUnfolds(seats, store.malformedSeatIds, plan.unfolds, outcome);
    holdBeside(seats, plan.beside, outcome);
    const wrote = outcome.removed.length > 0 || outcome.inserted.length > 0;
    return {
      mutation: wrote ? ({ kind: "write", seats } as const) : SEAT_STORE_NO_CHANGE,
      result: { outcome, wrote },
    };
  });
}

/** Step 3: only now may a ledger file go — each one beside a row that stands in `seats.json`. */
async function finishAfterWrite(
  sessionDir: string,
  storePath: string,
  outcome: HoldOutcome,
  result: SeatArchiveReconcileResult,
): Promise<void> {
  result.folded = outcome.removed.map((row) => moveOf(row, row.activeHolderId ?? ""));
  result.unfolded = outcome.inserted.map((entry) => moveOf(entry.row, entry.holderId));
  for (const seatId of [
    ...outcome.keptRows.map((row) => row.seatId),
    ...outcome.inserted.map((entry) => entry.row.seatId),
  ]) {
    await deleteLedgerFile(sessionDir, seatId);
  }
  for (const { entry, standing } of outcome.presentRows) {
    await deleteLedgerFile(sessionDir, entry.row.seatId);
    result.dropped.push(droppedOf(entry, standing));
  }
  for (const seatId of outcome.malformed) {
    result.problems.push(
      `seat ${seatId}: its row in ${storePath} is malformed, so its ledger row was not restored`,
    );
  }
}

function previewInto(
  plan: Plan,
  seats: ReadonlyMap<string, SeatRecord>,
  result: SeatArchiveReconcileResult,
): SeatArchiveReconcileResult {
  result.folded = plan.folds.map((row) => moveOf(row, row.activeHolderId ?? ""));
  result.unfolded = plan.unfolds.map((entry) => moveOf(entry.row, entry.holderId));
  result.dropped = plan.beside.map((entry) => droppedOf(entry, seats.get(entry.row.seatId)));
  return result;
}

async function applyPlan(
  options: SeatArchiveReconcileOptions,
  storePath: string,
  plan: Plan,
  result: SeatArchiveReconcileResult,
): Promise<SeatArchiveReconcileResult> {
  const { sessionDir } = options;
  if (plan.folds.length + plan.unfolds.length + plan.beside.length === 0) {
    return result;
  }
  // 1. The ledger file of every fold lands BEFORE its row can leave `seats.json`.
  await fs.mkdir(seatArchiveDir(sessionDir), { recursive: true });
  for (const row of plan.folds) {
    await writeLedgerFile(sessionDir, row, options.at, options.wave);
  }
  // 2. One write: every removal and every re-insertion of this run.
  const { outcome, wrote } = await applyInOneWrite(sessionDir, plan);
  result.seatStoreWrites = wrote ? 1 : 0;
  // 3. The ledger files that the write made redundant.
  await finishAfterWrite(sessionDir, storePath, outcome, result);
  // 4. F2 — a holder restored INSIDE this run's plan→write window is hot again while its seat
  //    was just folded. Read again now, AFTER the write: a restore that moved its files before
  //    this read is caught here; one that moves them after it runs its own reconcile after this
  //    write, which unfolds. No ordering leaves the seat in the ledger behind a hot holder.
  await unfoldRacedHolders(options, outcome.removed, result);
  return result;
}

async function unfoldRacedHolders(
  options: SeatArchiveReconcileOptions,
  removed: readonly SeatRecord[],
  result: SeatArchiveReconcileResult,
): Promise<void> {
  const hotFiles = new Set(await fs.readdir(options.sessionDir));
  const raced = removed
    .map((row) => row.activeHolderId ?? "")
    .filter((holderId) => hotFiles.has(`${encodeSessionSafeId(holderId)}.json`));
  if (raced.length === 0) {
    return;
  }
  const again = await reconcileSeatArchive({
    ...options,
    holderIds: new Set(raced),
    assumeArchived: undefined,
  });
  const back = new Set(again.unfolded.map((seat) => seat.seatId));
  result.folded = result.folded.filter((seat) => !back.has(seat.seatId));
  result.unfolded.push(...again.unfolded);
  result.problems.push(...again.problems);
  result.seatStoreWrites += again.seatStoreWrites;
}

/**
 * THE RECONCILE — idempotent, per seat id in `seats.json` ∪ ledger:
 *
 * | seen | action |
 * |---|---|
 * | row, holder archived, not starred | ledger file, THEN remove the row if its pointer is unchanged; pointer moved ⇒ delete the ledger file |
 * | row, holder archived, starred | leave it; report it by name |
 * | ledger only, holder hot again | re-insert the row, THEN delete the ledger file |
 * | row and ledger, holder hot or vacant | keep the row, delete the ledger file, report the dropped row if it differs |
 * | ledger only, holder still archived | nothing — the archived state |
 *
 * A dry run reads everything and writes nothing.
 */
export async function reconcileSeatArchive(
  options: SeatArchiveReconcileOptions,
): Promise<SeatArchiveReconcileResult> {
  const { sessionDir } = options;
  const result = emptyResult(options.dryRun);
  const store = await readSeatStore(sessionDir);
  if (store.fileState === "malformed" || store.fileState === "unreadable") {
    result.problems.push(
      `seat store ${store.storePath} is ${store.fileState}: no seat was folded or restored`,
    );
    return result;
  }
  const ledger = await readSeatArchiveLedger(sessionDir);
  result.problems.push(...ledger.problems);
  const inputs: PlanInputs = {
    options,
    archiveDir: options.archiveDir ?? sessionArchiveDirFor(sessionDir),
    hotFiles: new Set(await fs.readdir(sessionDir)),
  };
  const plan = await planReconcile(inputs, store.seats, ledger.entries);
  result.starred = plan.starred;
  if (options.dryRun) {
    return previewInto(plan, store.seats, result);
  }
  return await applyPlan(options, store.storePath, plan, result);
}

/** One line per reported seat, for the text renderers of every caller. */
export function seatArchiveReportLines(result: SeatArchiveReconcileResult): string[] {
  const verb = result.dryRun ? "would " : "";
  const lines = [
    `seats ${verb}archived with their holder: ${result.folded.length}; ${verb}restored: ${result.unfolded.length}; seat-store writes: ${result.seatStoreWrites}`,
  ];
  const label = (move: SeatArchiveMove) =>
    `${move.seatId} ${JSON.stringify(move.name ?? "")} holder ${move.holderId}`;
  for (const move of result.starred) {
    lines.push(
      `⚠ STARRED seat kept, its active holder is archived (the star guard did not hold): ${label(move)}`,
    );
  }
  for (const dropped of result.dropped.filter((entry) => entry.differs)) {
    lines.push(
      `dropped ledger row for ${dropped.seatId} (the row in seats.json stands): ${JSON.stringify(dropped.ledger)}`,
    );
  }
  for (const problem of result.problems) {
    lines.push(`⚠ ${problem}`);
  }
  return lines;
}
