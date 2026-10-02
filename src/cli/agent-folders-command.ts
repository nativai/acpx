import type { Command } from "commander";
import { sessionBaseDir } from "../session/persistence.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";
import {
  migrateAgentFolders,
  type AgentFolderMigrationAction,
  type AgentFolderMigrationReport,
} from "./session/agent-folders-migrate.js";
import { brickPoolDir } from "./session/brick-link.js";

/**
 * `acpx agent-folders migrate` — C7 (brick 09197f03), the filesystem half of the seat-keyed workspace.
 * What it moves, and why it is keyed on the directory's own shape: `session/agent-folders-migrate.ts`.
 *
 * ⚠️ A NEW TOP-LEVEL VERB NEEDS TWO REGISTRATIONS. This one, and `"agent-folders"` in `TOP_LEVEL_VERBS`
 * (`src/cli-core.ts`) — IN THE SAME COMMIT. Register only here and `configurePublicCli` absorbs the token
 * as an AGENT NAME: `acpx agent-folders bogus` becomes a prompt delivery in a session-bearing cwd instead
 * of an error. `test/top-level-verbs.test.ts` enumerates what `registerDefaultCommands` registers, and
 * `test/agent-folders-migrate.test.ts` drives the real CLI with a bogus subverb.
 */

type MigrateFlags = { apply?: boolean; pool?: string; sessionsDir?: string };

function renderAction(action: AgentFolderMigrationAction, applied: boolean): string {
  const linked = action.link === true ? (applied ? " + linked" : " + link") : "";
  if (action.action === "move") {
    return `  ${applied ? "moved" : "move"}  ${action.from} -> ${action.to}${linked}`;
  }
  return `  ${applied ? "removed" : "remove"} (empty)  ${action.from}${linked}`;
}

function renderText(report: AgentFolderMigrationReport): string {
  const { counts } = report;
  const applied = report.mode === "apply";
  const lines = [
    `agent-folders migrate (${applied ? "APPLIED" : "DRY RUN — nothing was changed; re-run with --apply"})`,
    `  pool:     ${report.pool}`,
    `  sessions: ${report.sessionsDir}`,
    `  ${applied ? "moved" : "would move"} ${counts.moved} · ${applied ? "removed" : "would remove"} ${counts.removedEmpty} empty · ` +
      `untouched: seat-less ${counts.untouchedSeatless}, unresolved ${counts.unresolved}, ` +
      `ambiguous ${counts.ambiguous}, other ${counts.other} · already seat-keyed ${counts.alreadyC7} · ` +
      `${applied ? "linked" : "would link"} ${counts.linked} (already linked ${counts.alreadyLinked})`,
    ...report.actions.map((action) => renderAction(action, applied)),
    ...report.errors.map((error) => `  ERROR  ${error.from}: ${error.message}`),
  ];
  return `${lines.join("\n")}\n`;
}

async function handleMigrate(
  flags: MigrateFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const { format } = resolveGlobalFlags(command, config);
  const report = await migrateAgentFolders({
    pool: flags.pool ?? brickPoolDir(),
    sessionsDir: flags.sessionsDir ?? sessionBaseDir(),
    apply: flags.apply === true,
  });
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else if (format === "quiet") {
    const { moved, removedEmpty } = report.counts;
    process.stdout.write(`${moved} ${removedEmpty} ${report.errors.length}\n`);
  } else {
    process.stdout.write(renderText(report));
  }
  if (report.errors.length > 0) {
    process.exitCode = 1;
  }
}

export function registerAgentFoldersCommand(parent: Command, config: ResolvedAcpxConfig): void {
  const agentFolders = parent
    .command("agent-folders")
    .description(
      "Agent workspace folders under a brick (<brick>/agents/): carry the folders sessions already " +
        "wrote into the seat-keyed layout <brick>/agents/<seat8>/holders/<session8>/.",
    );

  agentFolders
    .command("migrate")
    .description(
      "Move seated sessions' agent folders (full-uuid, <name>-<id8> and bare <id8> forms) into the " +
        "seat-keyed path; remove empty ones; leave seat-less, unresolved and ambiguous alone. " +
        "DRY RUN unless --apply.",
    )
    .option("--apply", "Actually move/remove (the default is a dry run that changes nothing)")
    .option("--pool <dir>", "The brick pool to walk (default: the box's brick pool)")
    .option(
      "--sessions-dir <dir>",
      "The session store to resolve directories against (default: acpx's own)",
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command, flags: MigrateFlags) {
      await handleMigrate(flags, this, config);
    });
}
