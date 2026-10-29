import type { Command } from "commander";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";

/**
 * `acpx transcripts dedup` / `acpx transcripts restore` — brick 81433524, CONCEPTION
 * §5. The clean-up of Claude transcript copies that already exist on a box, and the
 * bit-exact rebuild of a copy reduced to an exit-tail file. Human-run only.
 *
 * ⚠️ A NEW TOP-LEVEL VERB NEEDS TWO REGISTRATIONS. This one, and `"transcripts"` in
 * `TOP_LEVEL_VERBS` (`src/cli-core.ts`) — IN THE SAME COMMIT. Register only here and
 * `configurePublicCli` absorbs the token as an AGENT NAME: `acpx transcripts bogus`
 * becomes a prompt delivery in a session-bearing cwd instead of an error.
 *
 * ⚠️ The planner module is loaded with a DYNAMIC import inside the actions, and
 * nowhere else: nothing that runs on its own (the port, the owner exit, a timer) can
 * reach it. `test/transcripts-dedup.test.ts` pins the import graph.
 */

type DedupFlags = { apply?: boolean; manifest?: string; session?: string[] };
type RestoreFlags = { to?: string };

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function handleDedup(
  flags: DedupFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  const dedup = await import("./transcripts-dedup.js");
  let report;
  try {
    report = await dedup.runTranscriptsDedup({
      apply: flags.apply === true,
      manifest: flags.manifest,
      sessions: flags.session,
    });
  } catch (error) {
    if (error instanceof dedup.TranscriptsUsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const render =
    format === "json"
      ? dedup.renderDedupJson
      : format === "quiet"
        ? dedup.renderDedupQuiet
        : dedup.renderDedupText;
  process.stdout.write(render(report));
  if (report.recheckFailed > 0) {
    process.exitCode = 1;
  }
}

async function handleRestore(
  tailFile: string,
  flags: RestoreFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  const dedup = await import("./transcripts-dedup.js");
  try {
    const result = await dedup.restoreExitTail(tailFile, { to: flags.to });
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ ...result, status: "restored" })}\n`);
    } else if (format === "quiet") {
      process.stdout.write(`${result.restored}\n`);
    } else {
      process.stdout.write(
        `RESTORED ${result.restored} bytes=${result.bytes} sha256=${result.sha256} ` +
          `witness=${result.witness}${result.transitive ? " (transitive)" : ""}\n`,
      );
    }
  } catch (error) {
    if (!(error instanceof dedup.TranscriptRestoreError)) {
      throw error;
    }
    process.stderr.write(`acpx transcripts restore: ${error.message}\n`);
    process.exitCode = 1;
  }
}

export function registerTranscriptsCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const transcripts = parent
    .command("transcripts")
    .description(
      "Claude transcript copies across subscriptions: remove proven duplicates (dedup), " +
        "rebuild a copy reduced to an exit-tail file (restore).",
    );

  transcripts
    .command("dedup")
    .description(
      "Remove every copy that is a byte-prefix of a kept copy, and reduce every copy that is " +
        "a kept copy's prefix plus a Claude Code exit block to a restorable .acpx tail file. " +
        "Never touches an active copy, a real branch, or a session that is live or written " +
        "in the last hour. DRY RUN unless --apply.",
    )
    .option("--apply", "Actually remove/reduce (the default is a dry run that changes nothing)")
    .option(
      "--manifest <file>",
      "With --apply (required): append one JSON line per action, fsynced before each removal",
    )
    .option("--session <acpSessionId>", "Limit to this session id (repeatable)", collect, [])
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command, flags: DedupFlags) {
      await handleDedup(flags, this, config);
    });

  transcripts
    .command("restore")
    .description(
      "Rebuild the original copy an exit-tail file stands for, bit for bit (sha256-checked), " +
        "at its original path or --to. Never overwrites; keeps the tail file.",
    )
    .argument("<exit-tail-file>", "A <id>.exit-tail-<ISO>.acpx file")
    .option("--to <path>", "Write the rebuilt copy here instead of its original path")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command, tailFile: string, flags: RestoreFlags) {
      await handleRestore(tailFile, flags, this, config);
    });
}
