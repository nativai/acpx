import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AcpxOperationalError } from "../errors.js";
import { type LiveProcessScan, scanLiveProcesses } from "../process-population.js";
import type { SessionRecord } from "../types.js";
import {
  type AbandonedRecordSweepResult,
  sweepAbandonedSessionRecords,
} from "./abandoned-record-sweep.js";
import { overlaySessionIndexEntries } from "./persistence/index-overlay.js";
import {
  listSessionRecordFiles,
  readSessionIndex,
  type SessionIndexEntry,
  sessionIndexPath,
} from "./persistence/index.js";
import { parseSessionRecord } from "./persistence/parse.js";
import { writeSessionRecordAuthorizingSeatHolderWithoutIndex } from "./persistence/repository.js";
import { seatFieldsToIndexEntry } from "./persistence/seat-fields.js";
import {
  backfillSeatRow,
  fillSeatBrickLink,
  MalformedSeatRowError,
  migrateSeatFavorite,
  readSeatStore,
  type SeatBrickLink,
  type SeatRecord,
  seatStorePath,
  SeatStoreUnwritableError,
} from "./persistence/seat-store.js";

/**
 * THE SEAT BACKFILL — mint a seat for every hot-tier session record that lacks one.
 *
 * Ruled, not designed here: the conception ruling of 2026-09-29
 * (`Bricks/0d2b83f0-.../rulings/backfill-writer-2026-09-29.md`) and brick
 * `f65262c1`'s amended brief. What this module implements and what it is forbidden
 * to do are both from there; the reasoning below is only about HOW each ruled
 * property is reached in this codebase.
 *
 * ## Three legs, per record, in one order
 *
 * **record → index → seat store**, so *an index entry never claims a seat the record
 * lacks*. Here that ordering is reinforced by the seam rather than merely obeyed:
 * `overlaySessionIndexEntries` projects the entry from **the record as it stands on
 * disk, read inside the index lock** — so the index leg physically cannot invent a
 * seat id the record does not already carry. A record write that throws takes its
 * index leg down with it through the per-record `try`/`catch`, and the entry is left
 * exactly as it was.
 *
 * ## 🛑 `reconcileSessionIndex` IS THE WRONG SEAM AND IT FAILS **GREEN**
 *
 * The reassuringly-named function is a silent no-op for this job, twice over
 * (read at `d50e5bf`): its fast path compares only the **file list** and returns the
 * index unchanged (`index.ts:797-799`), and a backfill changes record *contents*,
 * never the file list — so that path is always the one taken. Even on drift,
 * `reconcileDriftedEntries` only DROPS entries for vanished files and ADDS entries
 * for new ones; it **never re-projects an existing entry** (`index.ts:820-831`),
 * which is exactly what a stale entry needs. An implementer reaching for it gets a
 * clean run, `drift: false`, and zero entries enriched — the cutover-blocking defect
 * reproducing itself inside its own fix. `rebuildSessionIndex` is rejected for the
 * opposite reason: it re-reads all ~1,900 records and rewrites every entry, an
 * unbounded scan and a far wider blast radius than one field group needs.
 *
 * ## Why per-record locking, with its cost stated
 *
 * One `overlaySessionIndexEntries` and one `withSeatStoreWrite` **per record** is
 * O(n²) in bytes written across a run. That shape was priced and accepted by the
 * programme's L0 rather than overlooked: per-record locking is what buys per-record
 * isolation *and* the ruled three-legs-in-order-per-record ordering, and both are
 * ruled properties rather than preferences. A batched seat leg would be a contract
 * change, not an optimisation — do not make it here.
 *
 * ## What it refuses, and why refusal comes BEFORE the first byte
 *
 * A malformed or unreadable `seats.json`, and an `index.json` that exists but fails
 * `readSessionIndex`'s all-or-nothing contract (`index.ts:645-647`). All three are
 * checked in preflight, before any backup is taken and before any record is written:
 * discovering a corrupt store at the first seat write would mean refusing *after*
 * having already rewritten records and the index. The backfill **cannot repair
 * corruption** — `seatStoreUnhealthyMessage` prints the quarantine step — and a
 * confident instruction to do the wrong thing is worse than an error (F1).
 */

/** Which leg a per-record failure happened in. Named, so "it failed" is never the
 * whole diagnosis — a row asserting only that the run failed cannot tell a record
 * write from an index write from a store write. */
export type SeatBackfillStage = "parse" | "backup" | "record" | "index" | "store";

export type SeatBackfillError = {
  file: string;
  acpxRecordId: string | undefined;
  stage: SeatBackfillStage;
  code: string | undefined;
  message: string;
};

export type SeatBackfillReport = {
  /** False for the default dry run. The dry run touches nothing. */
  apply: boolean;
  sessionDir: string;
  /** The abandoned-record sweep, which runs FIRST and is REPORT-ONLY here. */
  sweep: AbandonedRecordSweepResult;
  recordsScanned: number;
  /** Records that need (dry run) or were given (`--apply`) a `seat_id`. */
  recordsSeated: number;
  /** Distinct seats whose row is missing from `seats.json`. The headline count. */
  seats: number;
  /** Index entries needing (dry run) or given (`--apply`) the seat field group. */
  indexEntries: number;
  /**
   * Records the index had no entry for when the run started.
   *
   * ⚠️ THIS FIELD'S DOC COMMENT USED TO CLAIM THE ENTRY WAS "reported, never
   * fabricated — adding an entry is a MEMBERSHIP change and belongs to reconcile,
   * not to this verb." **That was false about the shipped code**, and believing it is
   * what let the defect through: `overlaySessionIndexEntries` reconciles membership,
   * so the entry is created by this verb's own index writes regardless. It was a
   * description of behaviour that does not happen, dressed as a design promise.
   *
   * What is true: the seat group is never invented — every field written is projected
   * from the record on disk — and the entry these records get is the SAME projection
   * reconcile would produce on the next ordinary index load. The count stays because
   * it is worth an operator's attention, not because nothing is written.
   */
  recordsWithoutIndexEntry: number;
  /** Rows minted for a seat a record already carried — AC11 (e)'s "repairs any
   * row-less seat it meets", counted separately because it is the population that
   * exists on a box where B1/B2 already landed. */
  rowsRepaired: number;
  /**
   * D-STAR item 3, THE ONE-TIME MIGRATION: existing seat rows whose on-disk
   * `favorite` disagreed with `any holder's favorite` and were corrected (dry run:
   * would be corrected). **AC4 — re-run touches ZERO rows**: once every seat's
   * on-disk value agrees with its records, this count is `0` and stays `0`, which
   * is what "one-time" means for a migration that runs inside an idempotent verb.
   */
  favoritesMigrated: number;
  /**
   * (d′), brick `9984c510`: existing seat rows whose `brick_id` was ABSENT and
   * were filled (dry run: would be filled) from their active holder's own
   * derived link, marked UNVALIDATED. Never overwrites a PRESENT link (BRK2)
   * — only absent → present is in scope. Same "re-run touches zero" contract
   * as `favoritesMigrated` once every absent link has been filled once.
   */
  brickLinksFilled: number;
  errors: SeatBackfillError[];
  /** The `.bak-mig-<TS>` suffix of this run's pre-apply copies, absent on a dry run. */
  backupSuffix: string | undefined;
  backups: string[];
  /** `--verify`: records carrying `seat_id` whose index entry lacks `seatId`. */
  staleIndexEntries: number;
  elapsedMs: number;
  /** {@link SEAT_BACKFILL_NOTES} — carried on the report so `--format json` gets them
   * too, and so the operator MEETS A DECISION rather than a gap. */
  notes: readonly string[];
};

/**
 * WHAT THE OPERATOR IS TOLD ABOUT THIS RUN THAT THE COUNTS CANNOT SAY.
 *
 * 🛑 **THESE ARE NOT DECORATION. An absence cannot be distinguished from an
 * oversight**, so a decision that shows up as *nothing happening* has to be stated
 * or it reads as a bug — by the operator, and by the next agent to touch this code.
 * Both lines below are RULED outcomes, and both are invisible in the summary counts.
 *
 * Exported so the acceptance row asserts THE SAME STRING the renderer prints: delete
 * a line from the renderer and the row goes red; delete the constant and the row
 * stops compiling. A row that re-spelled the sentence would pass while the operator
 * saw nothing.
 */
export const SEAT_BACKFILL_NOTES = [
  // L17. The apply takes MINUTES at box scale, so the realistic operator failure is
  // Ctrl-C at 90 s because it looks hung. Every artefact is written temp-file +
  // rename, so an interruption tears BETWEEN files and never inside one — and the
  // legs run record → index → row, so what an interruption leaves behind is always
  // a record ahead of its index entry, never an entry claiming a seat that is not on
  // its record. Saying so is what stops a nervous operator from "repairing" it.
  "safe to re-run if interrupted: a killed run leaves no half-written file, and re-running completes the remainder and reports 0 for what is already done",
  // L18. `parent_seat_id` is DELIBERATELY not set (ruled 2026-09-29). Both sides
  // undefined AGREE, so B3's divergence healing sees no divergence and routing keys
  // on `seatId` regardless. The deciding reason is asymmetry of repair: leaving it
  // unset is recoverable by a later pass, while setting it WRONG across every record
  // is not — and this is the one artefact in the design with no recovery path.
  "parent_seat_id is deliberately NOT set by this verb (ruled): it is incompleteness, not a defect — setting it wrong across every record would be unrecoverable, leaving it unset is not",
  // 🛑 THE PRECONDITION, STATED SO AN OPERATOR MEETS IT RATHER THAN DISCOVERS IT.
  // B12a FORBIDS running this against a live box, and the chain is all measurement:
  // the index lock PROCEEDS UNLOCKED after ~2 s of contention BY DESIGN (ratified,
  // `SEAT-STORE.md` item 5); B2b's test-engineer measured the loss cliff at 0 losses
  // with 2/4/6 concurrent writers and the FIRST LOSS AT 8, material from 16 — with
  // every contender exiting rc 0 and empty stderr, so THE LOSS IS SILENT AT THE
  // CALLER; and this run spends minutes doing 1,900 x (whole-index + whole-store
  // rewrite) while a live box writes the index continuously. That is exactly the
  // sustained-contention case in which the ratified give-up drops writes — on the one
  // artefact with no recovery path.
  "run this on a QUIET BOX: B12a forbids backfilling while sessions are live, because the index lock gives up after ~2 s of contention by design and concurrent writers start losing writes SILENTLY",
] as const;

/**
 * The index exists and does not satisfy `readSessionIndex`'s all-or-nothing
 * contract, so the backfill refuses rather than letting `reconcileSessionIndex`
 * silently rebuild the whole store behind it.
 *
 * `AcpxOperationalError`, not a plain `Error` (1dd9ae9a) — its sibling
 * `SeatBackfillSessionDirMissingError` below sets the pattern for this file's own
 * preflight refusals, and this is the second of the two that had no code. Unlike
 * `SeatStoreUnwritableError`, no established code exists for this seam anywhere
 * else, so `SEAT_BACKFILL_INDEX_UNREADABLE` is a NEW constant, on the
 * `SEAT_BACKFILL_*` spelling the sibling already uses — never a second scheme.
 */
export class SeatBackfillIndexUnreadableError extends AcpxOperationalError {
  constructor(readonly filePath: string) {
    super(
      `refusing to backfill: ${filePath} EXISTS but does not parse as a session index. ` +
        `readSessionIndex is ALL-OR-NOTHING — one unparseable entry rejects the whole file — ` +
        `so every index write from here would be built on a full REBUILD of the index from ` +
        `records, which is both an unbounded scan and a far wider change than this verb is ` +
        `allowed to make. Quarantine the file (rename it aside, keeping it), let acpx rebuild ` +
        `the index on the next ordinary read, and run the backfill again.`,
      { outputCode: "RUNTIME", detailCode: "SEAT_BACKFILL_INDEX_UNREADABLE", origin: "cli" },
    );
  }
}

/**
 * The SESSIONS DIRECTORY ITSELF does not exist — distinct from an absent
 * `seats.json`, which is NORMAL and this verb creates on its first `--apply`.
 * With no sessions directory there is nothing to scan (`listSessionRecordFiles`
 * would otherwise fail later with a raw `ENOENT: scandir` from deep inside the
 * run) and nothing to back-fill, so this is refused up front rather than left to
 * surface as an unnamed filesystem error a fresh-box operator cannot act on.
 *
 * `AcpxOperationalError`, not a plain `Error`, so `--format json` carries a
 * stable `data.detailCode` — the same requirement FIX 2 applied to the per-record
 * malformed-row error, here at the top-level refusal instead.
 */
export class SeatBackfillSessionDirMissingError extends AcpxOperationalError {
  constructor(readonly sessionDir: string) {
    super(
      `refusing to backfill: ${sessionDir} does not exist. This is not the same as an ` +
        `absent seats.json — an absent seats.json is normal and this verb creates one. ` +
        `There is no sessions directory here at all, so there is nothing to scan and ` +
        `nothing to back-fill. Check that HOME / ACPX_STATE_HOME point at a real acpx ` +
        `session store before running this verb.`,
      { outputCode: "RUNTIME", detailCode: "SEAT_BACKFILL_SESSION_DIR_MISSING", origin: "cli" },
    );
  }
}

export type SeatBackfillOptions = {
  sessionDir: string;
  apply: boolean;
  /** Injected in tests; the real run takes the box's `/proc` census. */
  liveScan?: LiveProcessScan;
  now?: () => Date;
  newSeatId?: () => string;
};

// ─── The plan, computed before anything is written ──────────────────────────

type RecordPlan = {
  file: string;
  record: SessionRecord;
  seatId: string;
  /** Leg 1 is needed: the record carries no `seat_id` yet. */
  seatsRecord: boolean;
  holderOrdinal: number;
  holderActive: boolean;
  /** Leg 2 is needed: the entry's seat field group disagrees with the record's. */
  enrichesIndex: boolean;
  hasIndexEntry: boolean;
};

type SeatPlan = {
  row: SeatRecord;
  needsRow: boolean;
  fromExistingSeatId: boolean;
  /**
   * True when a row ALREADY EXISTS for this seat and its on-disk `favorite`
   * disagrees with what this run computes from the records — the one-time
   * migration leg (D-STAR item 3) exists for exactly this case. False for a fresh
   * mint: `favorite` travels with the whole row there (`backfillSeatRow`), so
   * there is nothing left for the migration leg to do.
   */
  favoriteNeedsMigration: boolean;
  /**
   * (d′), brick `9984c510`: true when a row ALREADY EXISTS for this seat, its
   * on-disk `brick_id` is ABSENT, and this run's derived `row.brickId` has
   * something to fill it with. False for a fresh mint (the link travels with
   * the whole row there) AND false when the existing row already carries a
   * link, however obtained — BRK2, never overwritten, never reconciled.
   */
  brickLinkNeedsFill: boolean;
};

/**
 * The seat a record belongs to, and the holder fields it will carry.
 *
 * ⚠️ NO EXCLUSIONS (Topic 1, closed): template and subagent records get seats too.
 * A record lacking `seat_id` IS its own seat, so it gets a fresh one; a record that
 * already carries one keeps it, and joins whatever other holders name it.
 */
function planRecordSeat(
  record: SessionRecord,
  newSeatId: () => string,
): { seatId: string; seatsRecord: boolean; holderOrdinal: number; holderActive: boolean } {
  if (typeof record.seatId === "string" && record.seatId.length > 0) {
    return {
      seatId: record.seatId,
      seatsRecord: false,
      holderOrdinal: record.holderOrdinal ?? 1,
      holderActive: record.holderActive === true,
    };
  }
  return {
    seatId: newSeatId(),
    seatsRecord: true,
    holderOrdinal: 1,
    // A closed session's seat is NOBODY HOME, not abolished: the holder mirror
    // reads false and the row's `active_holder_id` is null, while `closed_at`
    // stays null. The two facts are different and must not be collapsed.
    holderActive: record.closed !== true,
  };
}

/** True when the entry's seat field group already says what the record says. An
 * entry that agrees is left BYTE-IDENTICAL — on a box where B1/B2 have landed most
 * entries are already correct, and rewriting them would be pure churn. */
function indexEntryAgrees(
  entry: SessionIndexEntry | undefined,
  plan: { seatId: string; holderOrdinal: number; holderActive: boolean },
): boolean {
  return (
    entry !== undefined &&
    entry.seatId === plan.seatId &&
    entry.holderOrdinal === plan.holderOrdinal &&
    entry.holderActive === plan.holderActive
  );
}

/**
 * The seat's active holder — **the OPEN holder, or `null`** (ruling §5).
 *
 * Deterministic where the ruling is silent: among the seat's OPEN members, the one
 * already flagged `holder_active` wins; failing that, the highest ordinal — the most
 * recent holder — wins. `null` when every member is closed, which is a first-class
 * state and not an absence to be repaired.
 */
function activeHolderFor(members: readonly RecordPlan[]): RecordPlan | undefined {
  const open = members.filter((member) => member.record.closed !== true);
  return (
    open.find((member) => member.holderActive) ??
    open.toSorted((a, b) => b.holderOrdinal - a.holderOrdinal)[0]
  );
}

/** The seat's representative for the copied NAME: its active holder, else its
 * highest-ordinal member. D9 phase (i) writes the name to the seat and leaves it on
 * the record; the seat is authoritative wherever the two disagree. */
function seatNameSource(members: readonly RecordPlan[]): RecordPlan | undefined {
  return (
    activeHolderFor(members) ?? members.toSorted((a, b) => b.holderOrdinal - a.holderOrdinal)[0]
  );
}

function earliestCreatedAt(members: readonly RecordPlan[], fallback: string): string {
  const stamps = members
    .map((member) => member.record.createdAt)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .toSorted();
  return stamps[0] ?? fallback;
}

/**
 * The row for one seat, from every record that names it.
 *
 * 🔑 `nextOrdinal = max(holderOrdinal) + 1` **over that seat's records, never a
 * constant.** Ordinal 1 is already consumed by the founding holder, so a row built
 * with `1` makes the first succession re-issue it — and D4a is explicit that a gap
 * is legal while a REPEAT is a defect. On a box where every seat has exactly one
 * holder a hard-coded `2` passes against live data, which is why this is derived and
 * why the falsifying case has to be a synthetic multi-holder rig.
 *
 * 🛑 `closedAt` is `null` — **PRESENT, never absent.** A backfilled seat reads NOT
 * CLOSED; a closed session's seat is nobody home, not abolished. The store's own
 * parse leg requires the key (`hasValidRequiredSeatFields`), so a row written without
 * it is one the store would reject as malformed.
 */
/**
 * `favorite` — D-STAR, item 3: "seat.favorite = any holder's favorite". `some()`
 * over every member's own per-record star, so a seat whose holders disagree (one
 * `true`, one explicit `false`, one absent) migrates to `true` — the AC2 fixture
 * verbatim. This is also what a FRESH mint needs: a record that already carried a
 * per-record star must not have that history silently dropped to `false` just
 * because its seat row happens to be minted today rather than migrated later.
 */
function favoriteFromHolders(members: readonly RecordPlan[]): boolean {
  return members.some((member) => member.record.favorite === true);
}

/**
 * `brick_id` — item (d), brick `3dff714d`, DECISIONS.md CORRECTION + AMENDMENT.
 * `seats backfill` is a THIRD site of F1's pattern: this function unconditionally
 * returned `undefined` here, same comment as `mintSeatRow` carried before its own
 * fix, and it is pre-existing code (`git show origin/seat/program:…` carries it
 * identically) — not something this brick's edits introduced. Left unfixed, (a)
 * only starts seats from now on and C4 stays false for every seat that predates
 * it, which is the DOMINANT population per F1.
 *
 * Same shape as `name` (`seatNameSource`) — reused directly rather than
 * re-deriving the same representative — **not** the same shape as `favorite`'s
 * `some()`: where holders disagree, the ACTIVE holder's brick wins, not "any
 * holder's". A retired holder's stale brick must not resurrect over the live
 * link; `seatNameSource`'s own fallback (highest ordinal) applies identically
 * when every member is closed.
 */
function brickFromHolders(members: readonly RecordPlan[]): string | undefined {
  return seatNameSource(members)?.record.metadata?.brick?.trim() || undefined;
}

/**
 * Brick `9984c510`, R28 (5) — ALWAYS UNVALIDATED. The backfill promotes the
 * active holder's own derived copy VERBATIM; it validates nothing, so
 * claiming anything else about it would be laundering a ref nobody confirmed
 * exists. Shared by both the fresh-mint row below and the (d′) fill leg
 * (`writeBrickLinkFillLeg`), which derives from this same `SeatRecord.brickId`
 * rather than re-deriving the ref a second time.
 */
function brickLinkFromHolders(members: readonly RecordPlan[]): SeatBrickLink | undefined {
  const ref = brickFromHolders(members);
  return ref === undefined ? undefined : { ref, validated: false };
}

function planSeatRow(seatId: string, members: readonly RecordPlan[], now: string): SeatRecord {
  const holder = activeHolderFor(members);
  return {
    seatId,
    createdAt: earliestCreatedAt(members, now),
    activeHolderId: holder?.record.acpxRecordId ?? null,
    nextOrdinal: Math.max(...members.map((member) => member.holderOrdinal)) + 1,
    closedAt: null,
    name: seatNameSource(members)?.record.name,
    brickId: brickLinkFromHolders(members),
    favorite: favoriteFromHolders(members),
  };
}

// ─── Reading the store ──────────────────────────────────────────────────────

type ScannedRecords = {
  plans: RecordPlan[];
  errors: SeatBackfillError[];
  recordsScanned: number;
  recordsWithoutIndexEntry: number;
  staleIndexEntries: number;
};

async function readRecordFile(
  sessionDir: string,
  file: string,
): Promise<SessionRecord | undefined> {
  try {
    const payload = await fs.readFile(path.join(sessionDir, file), "utf8");
    return parseSessionRecord(JSON.parse(payload)) ?? undefined;
  } catch {
    return undefined;
  }
}

async function scanRecords(
  sessionDir: string,
  entriesByFile: ReadonlyMap<string, SessionIndexEntry>,
  newSeatId: () => string,
): Promise<ScannedRecords> {
  const files = await listSessionRecordFiles(sessionDir);
  const plans: RecordPlan[] = [];
  const errors: SeatBackfillError[] = [];
  let recordsWithoutIndexEntry = 0;
  let staleIndexEntries = 0;

  for (const file of files) {
    const record = await readRecordFile(sessionDir, file);
    if (!record) {
      // Per-record isolation starts here: an unparseable record is reported and the
      // run continues. It is also NOT counted as a seat to mint — nothing can be
      // derived from a record that did not parse.
      errors.push({
        file,
        acpxRecordId: undefined,
        stage: "parse",
        code: undefined,
        message: "record did not parse; skipped",
      });
      continue;
    }
    const entry = entriesByFile.get(file);
    const seat = planRecordSeat(record, newSeatId);
    if (!entry) {
      recordsWithoutIndexEntry += 1;
    }
    if (!seat.seatsRecord && entry !== undefined && entry.seatId === undefined) {
      staleIndexEntries += 1;
    }
    plans.push({
      file,
      record,
      ...seat,
      // 🛑 `entry === undefined` MEANS THE INDEX LEG IS NEEDED **MORE**, NOT LESS —
      // and reading it the other way was a real defect, found by the test-engineer
      // and reproduced on the live population (1 such record on devbox today).
      //
      // This clause used to open `entry !== undefined &&`, which skipped the index
      // leg for a record the index had no entry for. That looked conservative and was
      // the opposite, because THE ENTRY GETS CREATED ANYWAY, by someone else's write:
      // `overlaySessionIndexEntries` calls `reconcileSessionIndex`, which reconciles
      // MEMBERSHIP and adds an entry for every record file the index lacks —
      // projected from that record AS IT STANDS AT THAT MOMENT. So the first
      // enriching record's index write minted an entry for this one, projected BEFORE
      // its `seat_id` was written, and nothing revisited it because its own flag had
      // been fixed to `false` at scan time. End state after ONE `--apply`: record
      // seated, row present, **entry carrying `createdAt` and no `seatId`** — which is
      // exactly the cutover-blocking state this block exists to delete, and which
      // `resolveSeat` TRUSTS and therefore never repairs.
      //
      // ⇒ The membership question is not ours to decide and never was: reconcile adds
      // that entry on any index load. The only question is whether what it leaves
      // behind is CORRECT or STALE, so this leg runs and makes it correct.
      enrichesIndex: entry === undefined || !indexEntryAgrees(entry, seat),
      hasIndexEntry: entry !== undefined,
    });
  }
  return {
    plans,
    errors,
    recordsScanned: plans.length,
    recordsWithoutIndexEntry,
    staleIndexEntries,
  };
}

/**
 * PREFLIGHT — every refusal, before the first byte is written.
 *
 * Returns the index entries keyed by file. Throws `SeatBackfillSessionDirMissingError`
 * for a sessions DIRECTORY that does not exist at all (distinct from an absent
 * `seats.json`, which this verb creates — see that error's own doc comment),
 * `SeatStoreUnwritableError` for a malformed or unreadable `seats.json` (the store's
 * own error, carrying its own `fileState` and quarantine remedy — not a generic
 * throw), and `SeatBackfillIndexUnreadableError` for an index that exists and does
 * not parse. An ABSENT store is not a refusal: creating it is exactly what the first
 * write on a fresh box is for.
 */
async function preflight(sessionDir: string): Promise<Map<string, SessionIndexEntry>> {
  if (!(await pathExists(sessionDir))) {
    throw new SeatBackfillSessionDirMissingError(sessionDir);
  }
  const store = await readSeatStore(sessionDir);
  if (store.fileState === "malformed" || store.fileState === "unreadable") {
    throw new SeatStoreUnwritableError(seatStorePath(sessionDir), store.fileState);
  }
  const index = await readSessionIndex(sessionDir);
  if (!index) {
    const indexPath = sessionIndexPath(sessionDir);
    if (await pathExists(indexPath)) {
      throw new SeatBackfillIndexUnreadableError(indexPath);
    }
    return new Map();
  }
  return new Map(index.entries.map((entry) => [entry.file, entry]));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ─── Rollback copies ────────────────────────────────────────────────────────

/**
 * The pre-apply copies, `.bak-mig-<TS>` beside each original — the record, the
 * index AND `seats.json` (the ruling's amendment names all three).
 *
 * ⚠️ **COPIED, NOT RENAMED, AND THE DIFFERENCE IS OPERATIONAL.** The brief says
 * "rename originals aside"; a rename would leave `index.json` and `seats.json`
 * ABSENT for the length of the run — and every concurrent reader on the box, the
 * running sessions included, resolves through those two files. A copy leaves the
 * originals in place and yields the identical rollback artefact: restoring the three
 * copies over the originals returns the store byte-for-byte to its pre-apply state,
 * which is the property an operator actually needs and the one the acceptance rows
 * assert.
 */
async function copyAside(filePath: string, suffix: string): Promise<string | undefined> {
  if (!(await pathExists(filePath))) {
    return undefined;
  }
  const target = `${filePath}${suffix}`;
  await fs.copyFile(filePath, target);
  return target;
}

function backupSuffixFor(now: Date): string {
  return `.bak-mig-${now.toISOString().replace(/[:.]/g, "")}`;
}

/**
 * The two STORE-WIDE copies — `index.json` and `seats.json`.
 *
 * 🛑 THESE TWO ARE FATAL ON FAILURE AND THE PER-RECORD ONES ARE NOT, and the split
 * is the whole reason this is a separate function. A store-wide copy that cannot be
 * taken means the run has no rollback at all, so it must not start; a single
 * record's copy failing is one record's problem, and aborting the run for it would
 * turn one unbackupable record into a total refusal for the other 1,899.
 * ⚠️ Measured, not theorised: a record whose filename is long enough that
 * `<file><suffix>` exceeds `NAME_MAX` made an earlier version of this function throw
 * from the middle of the run — exit 1, nothing written, no per-record diagnosis.
 */
async function takeStoreBackups(sessionDir: string, suffix: string): Promise<string[]> {
  const made: string[] = [];
  for (const target of [sessionIndexPath(sessionDir), seatStorePath(sessionDir)]) {
    const copy = await copyAside(target, suffix);
    if (copy) {
      made.push(copy);
    }
  }
  return made;
}

// ─── The three legs ─────────────────────────────────────────────────────────

/** Leg 1 — the RECORD. Through the one authorised writer of the seat-holder half:
 * without `authoritative.seatHolder` the write is a silent no-op, because
 * `preserveSeatHolderFieldsForPersist` puts the old (absent) values straight back.
 * It skips the index on purpose — leg 2 is ours. */
async function writeRecordLeg(plan: RecordPlan): Promise<void> {
  plan.record.seatId = plan.seatId;
  plan.record.holderOrdinal = plan.holderOrdinal;
  plan.record.holderActive = plan.holderActive;
  await writeSessionRecordAuthorizingSeatHolderWithoutIndex(plan.record);
}

/**
 * Leg 2 — the INDEX, one entry, through the shared projection helper.
 *
 * `seatFieldsToIndexEntry` is the H-R1-1 helper and the only sanctioned way to spell
 * this field group; a hand-rolled list here would be the second parallel field list
 * that helper exists to have deleted. `overlaySessionIndexEntries` merges it onto the
 * EXISTING entry under the index lock, re-reading the record from disk inside that
 * lock — so a concurrent close, rename or favourite survives, and the entry cannot
 * claim a seat the record does not carry.
 */
async function writeIndexLeg(sessionDir: string, plan: RecordPlan): Promise<void> {
  await overlaySessionIndexEntries(
    sessionDir,
    new Map([[plan.file, { fields: (record: SessionRecord) => seatFieldsToIndexEntry(record) }]]),
  );
}

// ─── The run ────────────────────────────────────────────────────────────────

function groupBySeat(plans: readonly RecordPlan[]): Map<string, RecordPlan[]> {
  const bySeat = new Map<string, RecordPlan[]>();
  for (const plan of plans) {
    const members = bySeat.get(plan.seatId);
    if (members) {
      members.push(plan);
    } else {
      bySeat.set(plan.seatId, [plan]);
    }
  }
  return bySeat;
}

async function planSeats(
  sessionDir: string,
  plans: readonly RecordPlan[],
  now: string,
): Promise<Map<string, SeatPlan>> {
  const store = await readSeatStore(sessionDir);
  const seatPlans = new Map<string, SeatPlan>();
  for (const [seatId, members] of groupBySeat(plans)) {
    const row = planSeatRow(seatId, members, now);
    const existing = store.seats.get(seatId);
    seatPlans.set(seatId, {
      row,
      needsRow: !existing,
      fromExistingSeatId: members.every((member) => !member.seatsRecord),
      favoriteNeedsMigration: existing !== undefined && existing.favorite !== row.favorite,
      brickLinkNeedsFill:
        existing !== undefined && existing.brickId === undefined && row.brickId !== undefined,
    });
  }
  return seatPlans;
}

function errorFor(plan: RecordPlan, stage: SeatBackfillStage, error: unknown): SeatBackfillError {
  return {
    file: plan.file,
    acpxRecordId: plan.record.acpxRecordId,
    stage,
    // `SEAT_ROW_MALFORMED` is the ESTABLISHED code for this condition — B2b already
    // emits it (`src/cli/seats-command.ts:557`) and B2c's `SEAT_CLOSED` is the sibling
    // precedent. Reusing it here, rather than coining a backfill-local name, is what
    // lets a caller (B12b) branch on ONE code for ONE condition instead of two.
    code:
      error instanceof MalformedSeatRowError
        ? "SEAT_ROW_MALFORMED"
        : (error as NodeJS.ErrnoException | undefined)?.code,
    message: error instanceof Error ? error.message : String(error),
  };
}

type ApplyCounts = {
  recordsSeated: number;
  indexEntries: number;
  rowsMinted: Set<string>;
  /** Seats ATTEMPTED by the favorite-migration leg this run — guards against
   * calling it once per member instead of once per seat, same shape as
   * `rowsMinted`. Attempted, not "changed": `favoritesMigrated` below counts the
   * subset that actually flipped a value. */
  favoritesAttempted: Set<string>;
  favoritesMigrated: number;
  /** (d′), brick `9984c510` — same shape as `favoritesAttempted`, one field over. */
  brickLinksAttempted: Set<string>;
  brickLinksFilled: number;
  backups: string[];
};

/**
 * One record, all three legs, in the ruled order, isolated.
 *
 * 🛑 THE `try`/`catch` IS THE ISOLATION AND ITS SCOPE IS THE WHOLE RECORD, not one
 * leg. A record whose leg 1 throws must not have legs 2 and 3 run — that is the
 * ordering invariant expressed as control flow: with no `seat_id` on disk, an index
 * entry claiming one is precisely the state this verb exists to prevent.
 */
/**
 * Leg 3 — the SEAT ROW, through the single writer.
 *
 * Once per distinct seat: the `rowsMinted` guard skips only after a row has actually
 * been written, so a seat whose first member failed earlier is still attempted by its
 * next member. `backfillSeatRow` re-reads the store under the lock and decides
 * present-vs-mint there, so this guard is an optimisation and never the authority.
 */
async function writeSeatLeg(
  sessionDir: string,
  plan: RecordPlan,
  seatPlans: ReadonlyMap<string, SeatPlan>,
  counts: ApplyCounts,
): Promise<void> {
  const seat = seatPlans.get(plan.seatId);
  if (seat?.needsRow !== true || counts.rowsMinted.has(plan.seatId)) {
    return;
  }
  if ((await backfillSeatRow(sessionDir, seat.row)) === "minted") {
    counts.rowsMinted.add(plan.seatId);
  }
}

/**
 * Leg 3½ — THE ONE-TIME `favorite` MIGRATION (D-STAR item 3), for a seat whose row
 * ALREADY EXISTS. A fresh mint (leg 3 above) never reaches here: `needsRow` is
 * mutually exclusive with `favoriteNeedsMigration` by construction (`planSeats`),
 * because a minted row's `favorite` already came from `planSeatRow`.
 *
 * Once per distinct seat, same guard shape as `writeSeatLeg`: `migrateSeatFavorite`
 * re-reads the store under the lock and decides present-vs-match there, so this
 * guard is an optimisation and never the authority.
 */
async function writeFavoriteMigrationLeg(
  sessionDir: string,
  plan: RecordPlan,
  seatPlans: ReadonlyMap<string, SeatPlan>,
  counts: ApplyCounts,
): Promise<void> {
  const seat = seatPlans.get(plan.seatId);
  if (!seat?.favoriteNeedsMigration || counts.favoritesAttempted.has(plan.seatId)) {
    return;
  }
  counts.favoritesAttempted.add(plan.seatId);
  // `seat.row.favorite` is always a concrete boolean here — `planSeatRow` sets it
  // from `favoriteFromHolders`, which never returns `undefined` — but the FIELD's
  // own type is the tri-state `boolean | undefined` every `SeatRecord` carries
  // (a row freshly read from disk may not have migrated yet), so this coerces
  // rather than asserts.
  if (
    (await migrateSeatFavorite(sessionDir, plan.seatId, seat.row.favorite === true)) === "migrated"
  ) {
    counts.favoritesMigrated += 1;
  }
}

/**
 * Leg 3¾ — (d′), brick `9984c510`: FILL an ABSENT seat `brick_id` for a seat
 * whose row ALREADY EXISTS. Mirrors `writeFavoriteMigrationLeg` one field
 * over: `needsRow` is mutually exclusive with `brickLinkNeedsFill` by
 * construction (`planSeats`) — a fresh mint's link travels with the whole
 * row via `writeSeatLeg` instead.
 *
 * Once per distinct seat, same guard shape as the two legs above:
 * `fillSeatBrickLink` re-reads the store under the lock and decides
 * absent-vs-present there, so this guard is an optimisation and never the
 * authority.
 */
async function writeBrickLinkFillLeg(
  sessionDir: string,
  plan: RecordPlan,
  seatPlans: ReadonlyMap<string, SeatPlan>,
  counts: ApplyCounts,
): Promise<void> {
  const seat = seatPlans.get(plan.seatId);
  if (!seat?.brickLinkNeedsFill || counts.brickLinksAttempted.has(plan.seatId)) {
    return;
  }
  counts.brickLinksAttempted.add(plan.seatId);
  if ((await fillSeatBrickLink(sessionDir, plan.seatId, seat.row.brickId?.ref)) === "filled") {
    counts.brickLinksFilled += 1;
  }
}

async function applyRecord(
  sessionDir: string,
  plan: RecordPlan,
  seatPlans: ReadonlyMap<string, SeatPlan>,
  counts: ApplyCounts,
  errors: SeatBackfillError[],
  suffix: string,
): Promise<void> {
  let stage: SeatBackfillStage = "backup";
  try {
    if (plan.seatsRecord) {
      // The record's rollback copy is taken IMMEDIATELY BEFORE its own write, inside
      // this record's isolation — so a record that cannot be backed up is simply not
      // written, and says so, instead of being written with no way back.
      const copy = await copyAside(path.join(sessionDir, plan.file), suffix);
      if (copy) {
        counts.backups.push(copy);
      }
      stage = "record";
      await writeRecordLeg(plan);
      counts.recordsSeated += 1;
    }
    stage = "index";
    if (plan.enrichesIndex) {
      await writeIndexLeg(sessionDir, plan);
      counts.indexEntries += 1;
    }
    stage = "store";
    await writeSeatLeg(sessionDir, plan, seatPlans, counts);
    await writeFavoriteMigrationLeg(sessionDir, plan, seatPlans, counts);
    await writeBrickLinkFillLeg(sessionDir, plan, seatPlans, counts);
  } catch (error) {
    errors.push(errorFor(plan, stage, error));
  }
}

/**
 * Run the backfill. Dry run by default — `apply: false` reads everything, computes
 * every count and writes NOTHING, so the preview and the run cannot disagree about
 * what is going to happen.
 */
export async function runSeatBackfill(options: SeatBackfillOptions): Promise<SeatBackfillReport> {
  const startedAt = Date.now();
  const now = options.now ?? (() => new Date());
  const newSeatId = options.newSeatId ?? randomUUID;
  const sessionDir = options.sessionDir;

  const entriesByFile = await preflight(sessionDir);
  const scanned = await scanRecords(sessionDir, entriesByFile, newSeatId);

  // 🛑 THE SWEEP RUNS FIRST — before a single mint, and its output precedes every
  // mint in the run log. REPORT-ONLY: closing a record is a lifecycle act with its
  // own verb and its own authority, and nothing in the ruling gives this verb that
  // authority. The `closeSession` callback below is a no-op for exactly that reason;
  // `closed` is still populated from the verdicts, so the report says which ids a
  // real sweep WOULD close without this run closing any of them.
  const sweep = await sweepAbandonedSessionRecords({
    records: scanned.plans.map((plan) => plan.record),
    liveScan: options.liveScan ?? scanLiveProcesses(),
    closeSession: async () => undefined,
  });

  const seatPlans = await planSeats(sessionDir, scanned.plans, now().toISOString());
  const seatsNeedingRows = [...seatPlans.values()].filter((seat) => seat.needsRow);
  const errors = [...scanned.errors];

  const base = {
    apply: options.apply,
    sessionDir,
    sweep,
    recordsScanned: scanned.recordsScanned,
    recordsWithoutIndexEntry: scanned.recordsWithoutIndexEntry,
    staleIndexEntries: scanned.staleIndexEntries,
    notes: SEAT_BACKFILL_NOTES,
  };

  if (!options.apply) {
    return {
      ...base,
      recordsSeated: scanned.plans.filter((plan) => plan.seatsRecord).length,
      seats: seatsNeedingRows.length,
      indexEntries: scanned.plans.filter((plan) => plan.enrichesIndex).length,
      rowsRepaired: seatsNeedingRows.filter((seat) => seat.fromExistingSeatId).length,
      favoritesMigrated: [...seatPlans.values()].filter((seat) => seat.favoriteNeedsMigration)
        .length,
      brickLinksFilled: [...seatPlans.values()].filter((seat) => seat.brickLinkNeedsFill).length,
      errors,
      backupSuffix: undefined,
      backups: [],
      elapsedMs: Date.now() - startedAt,
    };
  }

  const suffix = backupSuffixFor(now());
  const counts: ApplyCounts = {
    recordsSeated: 0,
    indexEntries: 0,
    rowsMinted: new Set(),
    favoritesAttempted: new Set(),
    favoritesMigrated: 0,
    brickLinksAttempted: new Set(),
    brickLinksFilled: 0,
    backups: await takeStoreBackups(sessionDir, suffix),
  };
  for (const plan of scanned.plans) {
    await applyRecord(sessionDir, plan, seatPlans, counts, errors, suffix);
  }

  return {
    ...base,
    recordsSeated: counts.recordsSeated,
    seats: counts.rowsMinted.size,
    indexEntries: counts.indexEntries,
    rowsRepaired: [...counts.rowsMinted].filter(
      (seatId) => seatPlans.get(seatId)?.fromExistingSeatId === true,
    ).length,
    favoritesMigrated: counts.favoritesMigrated,
    brickLinksFilled: counts.brickLinksFilled,
    errors,
    backupSuffix: suffix,
    backups: counts.backups,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * `--verify` — the standalone stale counter B12b runs per box.
 *
 * Counts records carrying `seat_id` whose index entry LACKS `seatId`. That is the
 * cutover-blocking state exactly: B3's `resolveSeat` bounds its per-record fallback
 * on `entry.createdAt`, so an entry WITH `createdAt` and WITHOUT `seatId` is TRUSTED
 * and the fallback is skipped — the holder is invisible to the seat scan, and the
 * seat reads VACANT or mail routes to the wrong holder, indefinitely for an idle
 * session. Read-only: it never writes and never refuses on a malformed store,
 * because a counter that cannot run on a sick box is no use for diagnosing one.
 */
export async function countStaleSeatIndexEntries(sessionDir: string): Promise<number> {
  const index = await readSessionIndex(sessionDir);
  if (!index) {
    return 0;
  }
  const entriesByFile = new Map(index.entries.map((entry) => [entry.file, entry]));
  let stale = 0;
  for (const file of await listSessionRecordFiles(sessionDir)) {
    const record = await readRecordFile(sessionDir, file);
    if (!record || typeof record.seatId !== "string" || record.seatId.length === 0) {
      continue;
    }
    if (entriesByFile.get(file)?.seatId === undefined) {
      stale += 1;
    }
  }
  return stale;
}
