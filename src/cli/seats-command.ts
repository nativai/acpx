import type { Command } from "commander";
import { describeAbandonedRecordSweep } from "../session/abandoned-record-sweep.js";
import { sessionBaseDir } from "../session/persistence.js";
import {
  countStaleSeatIndexEntries,
  runSeatBackfill,
  type SeatBackfillReport,
} from "../session/seat-backfill.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";

/**
 * `acpx seats backfill` — mint a seat for every hot-tier session record that lacks
 * one, enrich its index entry, and give every distinct seat a row in `seats.json`.
 *
 * ⚠️ **A NEW TOP-LEVEL VERB NEEDS TWO REGISTRATIONS.** This one, and `"seats"` in
 * `TOP_LEVEL_VERBS` (`src/cli-core.ts`) — IN THE SAME COMMIT. Register only here and
 * `configurePublicCli` absorbs the token as an AGENT NAME instead, so `acpx seats
 * backfill` becomes a prompt delivery in a session-bearing cwd rather than an error.
 * `test/top-level-verbs.test.ts` enumerates what this function registers and goes red
 * if the set is not updated.
 *
 * 🛑 **THE VERB IS THE MECHANISM, NOT PACKAGING** (conception ruling 2026-09-29).
 * A standalone script would be a SECOND writer of `seats.json` and a second
 * implementation of the row shape; both are exactly what `SEAT-STORE.md`
 * ratification item 2 forbids, and a bulk writer that touches every row is the case
 * that rule exists for. Living inside acpx also makes the ratified rollout order —
 * acpx to every box first, then acpx-ui, then the per-box backfill — enforced BY
 * CONSTRUCTION: this verb cannot run on a box whose acpx predates the store.
 *
 * **Operator use is B12a's, not this file's:** `acpx seats backfill --apply`, once
 * per box, after that box's acpx refresh.
 */
function renderVerifyText(sessionDir: string, stale: number): string {
  return (
    `seat index verify: ${stale} stale index ${stale === 1 ? "entry" : "entries"} ` +
    `(record carries seat_id, index entry lacks seatId) in ${sessionDir}\n`
  );
}

/** The counts every run prints, dry or applied, in the ruling's own headline order:
 * N seats / M index entries / K errors. */
function headlineLines(report: SeatBackfillReport): string[] {
  const repaired =
    report.rowsRepaired > 0 ? ` (row-less seats repaired: ${report.rowsRepaired})` : "";
  return [
    `seat backfill (${report.apply ? "applied" : "DRY RUN — nothing was written"}) — ${report.sessionDir}`,
    `  records scanned:      ${report.recordsScanned}`,
    `  seats:                ${report.seats}${repaired}`,
    `  records seated:       ${report.recordsSeated}`,
    `  index entries:        ${report.indexEntries}`,
    `  errors:               ${report.errors.length}`,
  ];
}

function detailLines(report: SeatBackfillReport): string[] {
  const lines: string[] = [];
  if (report.recordsWithoutIndexEntry > 0) {
    // Reported, never fabricated: adding an entry is a MEMBERSHIP change, which is
    // reconcile's job and not this verb's.
    lines.push(
      `  ⚠ records with no index entry (left to reconcile): ${report.recordsWithoutIndexEntry}`,
    );
  }
  if (report.backupSuffix !== undefined) {
    lines.push(`  rollback copies:      ${report.backups.length} × *${report.backupSuffix}`);
  }
  if (report.staleIndexEntries > 0 || report.apply) {
    lines.push(`  stale index entries:  ${report.staleIndexEntries}`);
  }
  for (const error of report.errors) {
    lines.push(`  ✗ ${error.file} [${error.stage}] ${error.code ?? ""} ${error.message}`);
  }
  lines.push(`  elapsed:              ${report.elapsedMs} ms`);
  return lines;
}

function renderText(report: SeatBackfillReport): string {
  const lines = [
    // The sweep FIRST, because it runs first — the log order is the run order.
    describeAbandonedRecordSweep(report.sweep)
      .replace(/^\[acpx] /, "")
      .trimEnd(),
    ...headlineLines(report),
    ...detailLines(report),
  ];
  return `${lines.join("\n")}\n`;
}

async function handleSeatsBackfill(
  command: Command,
  config: ResolvedAcpxConfig,
  flags: { apply?: boolean; verify?: boolean },
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  const sessionDir = sessionBaseDir();
  const apply = flags.apply === true;
  const verify = flags.verify === true;

  // `--verify` ALONE is the standalone counter B12b runs per box: read-only, no
  // plan, no refusal on a sick store. With `--apply` it measures the result, which
  // is the acceptance the brick asks for ("after --apply, zero index entries whose
  // record carries seat_id but whose entry lacks it").
  if (verify && !apply) {
    const stale = await countStaleSeatIndexEntries(sessionDir);
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ sessionDir, staleIndexEntries: stale })}\n`);
      return;
    }
    if (format === "quiet") {
      process.stdout.write(`${stale}\n`);
      return;
    }
    process.stdout.write(renderVerifyText(sessionDir, stale));
    return;
  }

  const report = await runSeatBackfill({ sessionDir, apply });
  if (verify) {
    report.staleIndexEntries = await countStaleSeatIndexEntries(sessionDir);
  }

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  if (format === "quiet") {
    process.stdout.write(`${report.seats} ${report.indexEntries} ${report.errors.length}\n`);
    return;
  }
  process.stdout.write(renderText(report));
}

export function registerSeatsCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const seatsCommand = parent
    .command("seats")
    .description("Seat maintenance — the seat store beside the session records.");

  seatsCommand
    .command("backfill")
    .description(
      "Mint a seat for every hot-tier session record that lacks one: the seat_id onto the " +
        "record, the seat field group onto its index entry, and one row per distinct seat in " +
        "seats.json. DRY RUN BY DEFAULT — --apply is the only writer.",
    )
    .option("--apply", "Write. Without it this is a dry run that touches nothing.")
    .option(
      "--verify",
      "Count index entries whose record carries seat_id but whose entry lacks seatId. Alone: a read-only count. With --apply: measured after the run.",
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .addHelpText(
      "after",
      `
WHAT IT WRITES, PER RECORD, IN THIS ORDER — and the order is the point.
  1. the RECORD      seat_id + holder_ordinal + holder_active
  2. the INDEX ENTRY the same field group, through the shared projection helper
  3. the SEAT ROW    one row per distinct seat_id, through the single writer
  An index entry therefore never claims a seat the record lacks — and a record whose
  write fails takes its own index and row legs with it, rather than half-landing.

IDEMPOTENT. A second --apply reports 0 and leaves seats.json byte-identical. A dry
run writes nothing at all. Records that already carry a seat, and index entries that
already agree with their record, are left BYTE-IDENTICAL.

ROLLBACK. --apply first copies the index, seats.json and every record it is about to
touch aside as <file>.bak-mig-<TS>. Restoring those copies over the originals returns
the store to its exact pre-apply state.

IT REFUSES rather than overwriting:
  - a seats.json that exists and does not parse, or cannot be read. It CANNOT repair
    corruption; quarantine the file first (the error prints the step).
  - an index.json that exists and fails readSessionIndex's all-or-nothing contract.
Neither refusal writes anything, including the rollback copies.

NO EXCLUSIONS. Template and subagent records get seats too.

THE ABANDONED-RECORD SWEEP RUNS FIRST and is REPORT-ONLY here — it names the open
records with no live owner; closing one is \`sessions close\`'s job, not this verb's.
`,
    )
    .action(async function (this: Command, flags: { apply?: boolean; verify?: boolean }) {
      await handleSeatsBackfill(this, config, flags);
    });
}
