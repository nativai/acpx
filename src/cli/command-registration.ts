import { Command, Option } from "commander";
import { DEFAULT_HISTORY_LIMIT } from "../session/persistence.js";
import { registerAgentsCommand } from "./agents-command.js";
import {
  handleCancel,
  handleExec,
  handlePrompt,
  handleSessionsClose,
  handleSessionsCopy,
  handleSessionsEnsure,
  handleSessionsExport,
  handleSessionsHistory,
  handleSessionsImport,
  handleSessionsList,
  handleSessionsNew,
  handleSessionsOwnerStatus,
  handleSessionsPrune,
  handleSessionsRecover,
  handleSessionsRepairAccountSeam,
  handleSessionsSetMetadata,
  handleSessionsShow,
  handleSessionsTemplate,
  handleSessionsTemplates,
  handleSessionsTemplatesMigrateSlugs,
  handleSessionsTemplatesRollback,
  handleListOutputStyles,
  handleSetConfigOption,
  handleSetMode,
  parseHistoryLimit,
} from "./command-handlers.js";
import { registerConfigCommand } from "./config-command.js";
import type { ResolvedAcpxConfig } from "./config.js";
import {
  addSessionIdentityOptions,
  addPromptInputOption,
  addSessionNameOption,
  addSessionOption,
  parseDaysOlderThan,
  parseDrainTimeoutMs,
  parseForkAtIndex,
  parseMessageId,
  parseMetadataEntry,
  parseNonEmptyValue,
  parsePruneBeforeDate,
  parseSessionName,
  type PromptFlags,
  type SessionsCloseFlags,
  type SessionsCopyFlags,
  type SessionsExportFlags,
  type SessionsHistoryFlags,
  type SessionsImportFlags,
  type SessionsListFlags,
  type SessionsNewFlags,
  type SessionsOwnerStatusFlags,
  type SessionsPruneFlags,
  type SessionsTemplateFlags,
  type StatusFlags,
} from "./flags.js";
import { registerModelsCommand } from "./models-command.js";
import { registerProfilesCommand } from "./profiles-command.js";
import { registerProvidersCommand } from "./providers-command.js";
import { DEFAULT_CLOSE_DRAIN_TIMEOUT_MS } from "./session/contracts.js";
import { registerStatusCommand } from "./status-command.js";
import { registerSubscriptionsCommand } from "./subscriptions-command.js";

type FlowRunFlags = {
  inputJson?: string;
  inputFile?: string;
  defaultAgent?: string;
};

type SharedSubcommandDescriptions = {
  prompt: string;
  exec: string;
  cancel: string;
  setMode: string;
  setConfig: string;
  outputStyles: string;
  status: string;
};

class LocalAttributeOption extends Option {
  constructor(
    flags: string,
    description: string,
    private readonly localAttributeName: string,
  ) {
    super(flags, description);
  }

  override attributeName(): string {
    return this.localAttributeName;
  }
}

function addSessionsListOptions(command: Command): Command {
  return command
    .option("--local", "List local acpx session records instead of agent protocol sessions")
    .option("--cursor <cursor>", "Opaque ACP session/list cursor", (value: string) =>
      parseNonEmptyValue("Cursor", value),
    )
    .option("--filter-cwd <dir>", "Filter agent sessions by working directory", (value: string) =>
      parseNonEmptyValue("Filter cwd", value),
    );
}

export function registerSessionsCommand(
  parent: Command,
  explicitAgentName: string | undefined,
  config: ResolvedAcpxConfig,
): void {
  const sessionsCommand = parent
    .command("sessions")
    .description("List, ensure, create, or close sessions for this agent");
  addSessionsListOptions(sessionsCommand);

  sessionsCommand.action(async function (this: Command, flags: SessionsListFlags) {
    await handleSessionsList(explicitAgentName, flags, this, config);
  });

  addSessionsListOptions(sessionsCommand.command("list"))
    .description("List sessions")
    .action(async function (this: Command, flags: SessionsListFlags) {
      await handleSessionsList(explicitAgentName, flags, this, config);
    });

  const templatesCommand = sessionsCommand
    .command("templates")
    .description("List saved templates for this agent (subcommands: rollback, migrate-slugs)")
    .action(async function (this: Command, flags: SessionsListFlags) {
      await handleSessionsTemplates(explicitAgentName, flags, this, config);
    });

  templatesCommand
    .command("rollback")
    .description(
      "Retract a template slug's latest version (default: soft-retract, reversible; --delete hard-removes)",
    )
    .argument("<slug>", "Template slug to roll back", (value: string) =>
      parseNonEmptyValue("Template slug", value),
    )
    .option(
      "--delete",
      "Hard-delete the latest version (record + sidecars + index entry) instead of soft-retracting it",
    )
    .action(async function (this: Command, slug: string, flags: { delete?: boolean }) {
      await handleSessionsTemplatesRollback(slug, flags, this, config);
    });

  templatesCommand
    .command("migrate-slugs")
    .description(
      "Backfill slug+version on existing templates (idempotent; disambiguates name collisions)",
    )
    .option("--dry-run", "Preview slug/version assignments without writing records")
    .action(async function (this: Command, flags: { dryRun?: boolean }) {
      await handleSessionsTemplatesMigrateSlugs(flags, this, config);
    });

  sessionsCommand
    .command("repair-account-seam")
    .description(
      "Clear Claude-family profile / account_switch from NON-Claude session records that the " +
        "account seam wedged (idempotent; backs up every record it rewrites)",
    )
    .option("--dry-run", "List what would be repaired and write nothing")
    .option(
      "--backup-dir <dir>",
      "Where to copy each record before rewriting it. Default: " +
        "<root>/.acpx/backups/account-seam-repair-<ts>, where <root> is $ACPX_STATE_HOME when " +
        "that is set and $HOME otherwise — i.e. the HOME OF THE PROCESS THAT RAN THE SWEEP, " +
        "which under an isolated HOME is NOT your own. The run prints the directory it actually " +
        "used; read that, not this.",
      (value: string) => parseNonEmptyValue("Backup dir", value),
    )
    // ⚠️ THIS HELP TEXT IS A BUG FIX, NOT DOCUMENTATION POLISH. On 2026-09-04 TWO
    // independent readers each concluded that a real, correct, fully-evidenced
    // production sweep had NEVER RUN — because they looked in ~/.acpx/backups,
    // found nothing, and the backups were elsewhere. The sweep was fine; its
    // findability was not. Two readers making the identical wrong inference is a
    // design signal, not two mistakes.
    //
    // MEASURED ON THIS BOX 2026-09-04, which is why the wording below says $HOME
    // rather than "~": `/home/node/.acpx/backups` DOES NOT EXIST, while
    // `/workspace/hp/home/.acpx/backups/account-seam-repair-<ts>` holds three
    // real backup sets. `defaultBackupDir()` resolves
    // `process.env.ACPX_STATE_HOME || os.homedir()`, and `os.homedir()` honours
    // $HOME — so under any isolated HOME (every rig, every sandboxed slot) the
    // old "(default: ~/.acpx/backups/…)" was simply false, and "~" is precisely
    // the token a reader resolves against their OWN home.
    // https://acpx.devbox.nativai.de/?brick=27cdb9fa
    .addHelpText(
      "after",
      [
        "",
        "Backups:",
        "  Every rewritten record is copied to the backup dir FIRST, and the copy is read back",
        "  and compared before the rewrite — so a backup that did not land fails the record",
        "  loudly instead of leaving it unrecoverable. The run prints `backups: <dir>`; that",
        "  line is authoritative, the default above is only where it will be when you pass no flag.",
        "",
        "Restoring a record from a backup — a HAND COPY, and know what it does not give you:",
        "    acpx sessions owner-status <record-id>      # MUST show no live owner first",
        "    cp <backup-dir>/<urlencoded-record-id>.json <sessions-dir>/",
        "  where <sessions-dir> is $ACPX_STATE_HOME/.acpx/sessions (or ~/.acpx/sessions), and the",
        "  file name is the record id URL-encoded — the backup already carries the right name.",
        "  ⚠️ THE SWEEP'S TWO SAFETY PROPERTIES DO NOT COME WITH THAT cp, AND THERE IS NO",
        "  RESTORE MODE THAT WOULD GIVE THEM TO YOU. When the sweep writes a record it writes",
        "  ATOMICALLY (unique tmp file + rename, so no reader ever sees a partial record) and it",
        "  REFUSES any record with a live queue owner. A cp is neither: it can be read half-written,",
        "  and against a live owner it will be silently overwritten by that owner's next checkpoint",
        "  — the restore looks like it worked and is gone minutes later. Hence the owner-status",
        "  check first; it is the only guard you get.",
      ].join("\n"),
    )
    .action(async function (this: Command, flags: { dryRun?: boolean; backupDir?: string }) {
      await handleSessionsRepairAccountSeam(flags, this, config);
    });

  sessionsCommand
    .command("template")
    .description("Mark/unmark a session as a reusable template (default: --enable)")
    .argument(
      "<id>",
      "Session id (acpx record id, ACP session id, or unique suffix)",
      (value: string) => parseNonEmptyValue("Session id", value),
    )
    .option("--enable", "Mark the session as a template (also closes it); the default action")
    .option("--disable", "Clear the template marker (leaves the session closed as-is)")
    .option(
      "--auto-prompt <text>",
      "Prompt auto-sent on every spawn from this template (empty string clears it). " +
        "Stored plaintext — do not put secrets here.",
    )
    .option(
      "--slug <slug>",
      "Explicit template slug for --enable (canonicalized; default is slugify(name)). " +
        "Use when the target slug differs from the session name's slug (e.g. a refresh).",
    )
    .action(async function (this: Command, id: string, flags: SessionsTemplateFlags) {
      await handleSessionsTemplate(explicitAgentName, id, flags, this, config);
    });

  sessionsCommand
    .command("new")
    .description("Create a new session for current cwd (optionally from a template)")
    .option("-s, --name <name>", "Session name", parseSessionName)
    .option("--resume-session <id>", "Resume existing ACP session id", (value: string) =>
      parseNonEmptyValue("Resume session id", value),
    )
    .option(
      "--parent-session-url <url>",
      "Record the spawning session's acpx-ui URL as parent (UUID parsed from ?session=). Mirrors the agent identity URL — the same URL humans paste in a browser and that agents POST to.",
      (value: string) => parseNonEmptyValue("Parent session URL", value),
    )
    .option(
      "--parent-id <uuid>",
      "Record the spawning session's acpxRecordId as parent_session_id (falls back to ACPX_SESSION_URL env). Use --parent-session-url for the URL form.",
      (value: string) => parseNonEmptyValue("Parent session id", value),
    )
    .option(
      "--metadata <key=value>",
      "Set a metadata entry on the session (repeatable; e.g. --metadata task_folder=/abs/path)",
      parseMetadataEntry,
    )
    .option(
      "--brick <ref>",
      "Link the session to a brick (full uuid, uuid8, slug, or slug__uuid8; non-uuid refs resolve via the brick CLI). Stored as metadata.brick; reaches the agent as $ACPX_BRICK / $ACPX_BRICK_PATH.",
      (value: string) => parseNonEmptyValue("Brick ref", value),
    )
    .option("--no-brick", "Do not link, and do not inherit the spawning session's brick.")
    .option(
      "--from-template <id>",
      "Instantiate from a saved template (acpx record id, ACP session id, or unique suffix). " +
        "Inherits the template's agent type + context; the new session is a normal open session. " +
        "Combine with --cwd to place it elsewhere and -s to name it.",
      (value: string) => parseNonEmptyValue("Template id", value),
    )
    .option(
      "--prompt <text>",
      "With --from-template: override the template's stored auto-prompt with this text " +
        "(auto-fired into the new session). Ignored without --from-template.",
    )
    .option(
      "--no-prompt",
      "With --from-template: do not auto-fire the template's stored auto-prompt (create a pure copy).",
    )
    .action(async function (this: Command, flags: SessionsNewFlags) {
      await handleSessionsNew(explicitAgentName, flags, this, config);
    });

  sessionsCommand
    .command("ensure")
    .description("Ensure a session exists for current cwd or ancestor")
    .option("-s, --name <name>", "Session name", parseSessionName)
    .option("--resume-session <id>", "Resume existing ACP session id", (value: string) =>
      parseNonEmptyValue("Resume session id", value),
    )
    .option(
      "--parent-session-url <url>",
      "Record the spawning session's acpx-ui URL as parent when creating (UUID parsed from ?session=; ignored when an existing session is reused).",
      (value: string) => parseNonEmptyValue("Parent session URL", value),
    )
    .option(
      "--parent-id <uuid>",
      "Record the spawning session's acpxRecordId as parent_session_id when creating (falls back to ACPX_SESSION_URL env; ignored when an existing session is reused). Use --parent-session-url for the URL form.",
      (value: string) => parseNonEmptyValue("Parent session id", value),
    )
    .option(
      "--metadata <key=value>",
      "Set or merge a metadata entry (repeatable; merges into existing session metadata, per-key overwrite)",
      parseMetadataEntry,
    )
    .option(
      "--brick <ref>",
      "Link the session to a brick (full uuid, uuid8, slug, or slug__uuid8; non-uuid refs resolve via the brick CLI). Stored as metadata.brick; reaches the agent as $ACPX_BRICK / $ACPX_BRICK_PATH.",
      (value: string) => parseNonEmptyValue("Brick ref", value),
    )
    .option("--no-brick", "Do not link, and do not inherit the spawning session's brick.")
    .action(async function (this: Command, flags: SessionsNewFlags) {
      await handleSessionsEnsure(explicitAgentName, flags, this, config);
    });

  const closeCommand = sessionsCommand
    .command("close")
    .description("Close session for current cwd")
    .argument("[name]", "Session name", parseSessionName)
    // D1 (brick://53437107) — the close-drain barrier's surface. Defaults keep a
    // close of an idle worker indistinguishable from before.
    .option(
      "--drain-timeout <ms>",
      `How long to wait for an in-flight turn to end before terminalizing the rest of the queue owner's custody (default ${DEFAULT_CLOSE_DRAIN_TIMEOUT_MS})`,
      parseDrainTimeoutMs,
    )
    .option(
      "--no-drain",
      "Skip the close-drain barrier and terminate the queue owner immediately (the pre-barrier behaviour, chosen explicitly)",
    )
    .option(
      "--fail-on-undelivered",
      "Exit 3 instead of 0 when the close found undelivered messages in the queue owner's custody",
    );
  addSessionIdentityOptions(closeCommand);
  closeCommand.action(async function (
    this: Command,
    name: string | undefined,
    flags: SessionsCloseFlags,
  ) {
    await handleSessionsClose(explicitAgentName, name, flags, this, config);
  });

  sessionsCommand
    .command("copy")
    .alias("fork")
    .description("Copy/fork a session with the source agent type")
    .requiredOption(
      "--from <id>",
      "Source session id (acpx record id, ACP session id, or unique suffix)",
      (value: string) => parseNonEmptyValue("Source session id", value),
    )
    .option(
      "--at-index <n>",
      "Truncate the copy at acpx message index N (omit = full copy)",
      parseForkAtIndex,
    )
    .option("-s, --name <name>", "Name for the copied session", parseSessionName)
    .option(
      "--parent-session-url <url>",
      "Record the spawning session's acpx-ui URL as parent (UUID parsed from ?session=; falls back to ACPX_SESSION_URL env). Roots the copy/fork under its spawner in addition to its fork origin.",
      (value: string) => parseNonEmptyValue("Parent session URL", value),
    )
    .option(
      "--parent-id <uuid>",
      "Record the spawning session's acpxRecordId as parent_session_id (falls back to ACPX_SESSION_URL env). Use --parent-session-url for the URL form.",
      (value: string) => parseNonEmptyValue("Parent session id", value),
    )
    .option(
      "--metadata <key=value>",
      "Set a metadata entry on the copied session (repeatable)",
      parseMetadataEntry,
    )
    .option(
      "--brick <ref>",
      "Link the copied session to a brick (full uuid, uuid8, slug, or slug__uuid8; non-uuid refs resolve via the brick CLI). Stored as metadata.brick; reaches the agent as $ACPX_BRICK / $ACPX_BRICK_PATH.",
      (value: string) => parseNonEmptyValue("Brick ref", value),
    )
    .option("--no-brick", "Do not link, and do not inherit the spawning session's brick.")
    .option("--ephemeral", "Mark the copy as a by-the-way ephemeral side-thread")
    .option(
      "--prompt <text>",
      "Prompt to enqueue into the copied session immediately after creation (non-blocking)",
      (value: string) => parseNonEmptyValue("Prompt", value),
    )
    .option(
      "--prompt-file <path>",
      "Read prompt handoff from file path (use - for stdin) and enqueue it after creation (non-blocking)",
      (value: string) => parseNonEmptyValue("Prompt file", value),
    )
    .action(async function (this: Command, flags: SessionsCopyFlags) {
      await handleSessionsCopy(explicitAgentName, flags, this, config);
    });

  sessionsCommand
    .command("recover")
    .description(
      "Force-restart a wedged session: SIGKILL its queue-owner process group and clear the lease so the next prompt cold-respawns a fresh owner. Idempotent (no owner = success).",
    )
    .argument(
      "<id>",
      "Session id (acpx record id, ACP session id, or unique suffix)",
      (value: string) => parseNonEmptyValue("Session id", value),
    )
    .action(async function (this: Command, id: string) {
      await handleSessionsRecover(explicitAgentName, id, this, config);
    });

  sessionsCommand
    .command("owner-status")
    .description(
      "Print read-only queue-owner state as JSON. Use --all for a bounded scan of open local sessions.",
    )
    .argument(
      "[id]",
      "Session id (acpx record id, ACP session id, or unique suffix). Omit only with --all.",
      (value: string) => parseNonEmptyValue("Session id", value),
    )
    .option("--all", "Scan all open local sessions. Read-only; does not recover leases.")
    .option(
      "--descendants-of <id>",
      "Scan transitive local descendants of a parent/root session. Read-only; does not recover leases.",
      (value: string) => parseNonEmptyValue("Parent session id", value),
    )
    .action(async function (
      this: Command,
      id: string | undefined,
      flags: SessionsOwnerStatusFlags,
    ) {
      await handleSessionsOwnerStatus(id, flags);
    });

  const showCommand = sessionsCommand
    .command("show")
    .description("Show session metadata for current cwd")
    .argument("[name]", "Session name", parseSessionName);
  addSessionIdentityOptions(showCommand);
  showCommand.action(async function (this: Command, name: string | undefined, flags: StatusFlags) {
    await handleSessionsShow(explicitAgentName, name, flags, this, config);
  });

  const setMetadataCommand = sessionsCommand
    .command("set-metadata")
    .description(
      "Set/update a metadata entry on this cwd's session in place (e.g. task_folder) — no agent connection. task_folder must be absolute; $ACPX_TASK_FOLDER reaches the agent on its next prompt/exec turn, not the in-flight one",
    )
    .argument("<key>", "Metadata key", (value: string) => parseNonEmptyValue("Metadata key", value))
    .argument("<value>", "Metadata value", (value: string) =>
      parseNonEmptyValue("Metadata value", value),
    );
  addSessionNameOption(setMetadataCommand);
  setMetadataCommand.action(async function (
    this: Command,
    key: string,
    value: string,
    flags: StatusFlags,
  ) {
    await handleSessionsSetMetadata(explicitAgentName, key, value, flags, this, config);
  });

  const historyCommand = sessionsCommand
    .command("history")
    .description("Show recent session history entries")
    .argument("[name]", "Session name", parseSessionName)
    .option(
      "--limit <count>",
      `Maximum number of entries to show (default: ${DEFAULT_HISTORY_LIMIT})`,
      parseHistoryLimit,
      DEFAULT_HISTORY_LIMIT,
    );
  addSessionIdentityOptions(historyCommand);
  historyCommand.action(async function (
    this: Command,
    name: string | undefined,
    flags: SessionsHistoryFlags,
  ) {
    await handleSessionsHistory(explicitAgentName, name, flags, this, config);
  });

  const readCommand = sessionsCommand
    .command("read")
    .description("Read full session history")
    .argument("[name]", "Session name", parseSessionName)
    .option(
      "--tail <count>",
      "Show only the last N entries instead of all history",
      parseHistoryLimit,
    );
  addSessionIdentityOptions(readCommand);
  readCommand.action(async function (
    this: Command,
    name: string | undefined,
    flags: { tail?: number } & StatusFlags,
  ) {
    await handleSessionsHistory(
      explicitAgentName,
      name,
      {
        limit: flags.tail ?? 0,
        session: flags.session,
        sessionId: flags.sessionId,
        sessionUrl: flags.sessionUrl,
      },
      this,
      config,
    );
  });

  const exportCommand = sessionsCommand
    .command("export")
    .description("Export a portable session archive")
    .argument("[name]", "Session name", parseSessionName)
    .requiredOption("--output <path>", "Output archive path", (value: string) =>
      parseNonEmptyValue("Output path", value),
    )
    .addOption(
      new LocalAttributeOption("--cwd <cwd>", "Session cwd to export", "sourceCwd").argParser(
        (value: string) => parseNonEmptyValue("Session cwd", value),
      ),
    );
  addSessionIdentityOptions(exportCommand);
  exportCommand.action(async function (
    this: Command,
    name: string | undefined,
    flags: SessionsExportFlags,
  ) {
    await handleSessionsExport(explicitAgentName, name, flags, this, config);
  });

  sessionsCommand
    .command("import")
    .description("Import a portable session archive")
    .argument("<archive-path>", "Archive path", (value: string) =>
      parseNonEmptyValue("Archive path", value),
    )
    .option("--name <name>", "Imported session name", parseSessionName)
    .addOption(
      new LocalAttributeOption("--cwd <cwd>", "Imported session cwd", "destinationCwd").argParser(
        (value: string) => parseNonEmptyValue("Imported session cwd", value),
      ),
    )
    .action(async function (this: Command, archivePath: string, flags: SessionsImportFlags) {
      await handleSessionsImport(explicitAgentName, archivePath, flags, this, config);
    });

  sessionsCommand
    .command("prune")
    .description(
      "Delete closed sessions: removes each session's record AND its messages sidecar (after which its transcript cannot be rebuilt). Requires a scope — session ids, --cwd, --whole-box, --older-than or --before — unless --dry-run. Template blueprints are skipped.",
    )
    .argument(
      "[ids...]",
      "Session ids to prune (acpx record id, ACP session id, or unique suffix). All must resolve to closed sessions or nothing is deleted.",
    )
    .option("--dry-run", "Preview what would be pruned without deleting anything (needs no scope)")
    .option("--cwd", "Prune closed sessions whose cwd is the current directory")
    .option(
      "--whole-box",
      "Prune EVERY closed session for this agent on this box (the box-wide sweep; cannot be combined with ids or --cwd)",
    )
    .option("--before <date>", "Prune sessions closed before this date", parsePruneBeforeDate)
    .option("--older-than <days>", "Prune sessions closed more than N days ago", parseDaysOlderThan)
    // ⚠️ THIS BOUNDS THE CONFIG-DIR SWEEP, NOT THE SESSION SELECTION. It exists
    // because the sweep's `rootDir` was, until now, a function parameter no CLI
    // path could supply: this handler's signature took none, so
    // `params.rootDir ?? tmpdir()` resolved the REAL SHARED `/tmp` from every
    // invocation, in every HOME — an isolated HOME does not scope it. That made
    // the fleet safety rule ("prune only with an explicit root") impossible to
    // comply with, which is the whole of brick 0bac6a00.
    //
    // ⚠️ THE DEFAULT STAYS `tmpdir()` ON PURPOSE (CONCEPTION §4): every directory
    // that has actually leaked is at `/tmp/acpx-<harness>-<id>`, so a default
    // pointed anywhere else would give a clean, cheap, truthful census over an
    // empty root while the entire backlog sat invisible one level up.
    .option(
      "--config-dir-root <path>",
      "Bound the post-prune harness config-dir sweep to this directory instead of the system temp dir. Does NOT affect which sessions are pruned. Also settable as ACPX_HARNESS_CONFIG_DIR_ROOT; the flag wins.",
      (value: string) => parseNonEmptyValue("Config dir root", value),
    )
    // ⚠️ DECLARATION ORDER IS LOAD-BEARING. `--no-include-history` MUST be
    // registered FIRST, and no type check catches it if you swap them.
    //
    // Measured against the pinned Commander 14.0.3
    // (brick 401a6216 conception/evidence/commander-probe.txt):
    //
    //   declared                          bare        --include-history  --no-include-history
    //   --include-history then --no-...    {} (!!)     true               false
    //   only --no-include-history          true        ERROR unknown      false
    //   --no-... then --include-history    true        true               false
    //
    // Only the third gives all three required behaviours. The natural order —
    // affirmative first — leaves the default UNDEFINED, which a core reading
    // `=== true` silently treats as "keep stranding": the flip would look
    // shipped and do nothing.
    //
    // ⚠️ THIS ORDER AND `!== false` IN THE HANDLER ARE **REDUNDANT, NOT
    // COMPLEMENTARY**. The conception (§4.2.1) called them "belt and braces,
    // both required"; that is FALSE and the correction is measured, not argued.
    // Mutating each alone and running the whole behavioural suite:
    //
    //   swap these two .option() calls          -> 0 behavioural reds
    //   handler `!== false` becomes `=== true`  -> 0 reds
    //   BOTH mutated together                   -> 6 reds (T-F1 and others)
    //
    // Because: swapped + `!== false` parses `undefined`, and
    // `undefined !== false` is true, so streams still get deleted. Correct order
    // + `=== true` parses `true`, and `true === true`, so streams still get
    // deleted. Only swapped + `=== true` gives `undefined === true` -> false ->
    // SILENT STRANDING, with no test to catch it.
    //
    // So EITHER ONE ALONE YIELDS CORRECT BEHAVIOUR, and **no behavioural test
    // can catch a swap here while the handler reads `!== false`**. Do not remove
    // this order believing the handler covers you, and do not remove the
    // handler's `!== false` believing this order covers you — each is true only
    // while the other stands. Removing both strands every stream silently.
    // The only pin that exists is at the PARSE layer: the test "rider 2: a bare
    // prune parses includeHistory as true, not undefined"
    // (test/deletion-manifest.test.ts), which is what reds if these two are
    // swapped. A source-text check for the order was considered and rejected —
    // a convention check is not a control.
    .option(
      "--no-include-history",
      "Keep each session's event stream files (.stream.*) and its timestamp sidecar. They are then unreachable: prune selects off the record index, so once the record is gone no later prune can reclaim them.",
    )
    .option(
      "--include-history",
      "Also delete event stream files (.stream.*). This is the default; the flag is accepted so existing invocations keep working.",
    )
    .option(
      "--include-templates",
      "Also delete template blueprints (breaks every session spawned from their slug)",
    )
    .action(async function (this: Command, ids: string[], flags: SessionsPruneFlags) {
      await handleSessionsPrune(explicitAgentName, ids, flags, this, config);
    });
}

export function registerSharedAgentSubcommands(
  parent: Command,
  explicitAgentName: string | undefined,
  config: ResolvedAcpxConfig,
  descriptions: SharedSubcommandDescriptions,
): void {
  const promptCommand = parent
    .command("prompt")
    .description(descriptions.prompt)
    .argument("[prompt...]", "Prompt text")
    .showHelpAfterError();
  addSessionOption(promptCommand);
  addPromptInputOption(promptCommand);
  promptCommand.option(
    "--message-id <uuid>",
    "External prompt message identity to forward through ACP",
    parseMessageId,
  );
  promptCommand.action(async function (this: Command, promptParts: string[], flags: PromptFlags) {
    await handlePrompt(explicitAgentName, promptParts, flags, this, config);
  });

  const execCommand = parent
    .command("exec")
    .description(descriptions.exec)
    .argument("[prompt...]", "Prompt text")
    .showHelpAfterError();
  addPromptInputOption(execCommand);
  execCommand.action(async function (this: Command, promptParts: string[], flags) {
    await handleExec(explicitAgentName, promptParts, flags, this, config);
  });

  const cancelCommand = parent.command("cancel").description(descriptions.cancel);
  addSessionNameOption(cancelCommand);
  cancelCommand.action(async function (this: Command, flags: StatusFlags) {
    await handleCancel(explicitAgentName, flags, this, config);
  });

  const setModeCommand = parent
    .command("set-mode")
    .description(descriptions.setMode)
    .argument("<mode>", "Mode id", (value: string) => parseNonEmptyValue("Mode", value));
  addSessionNameOption(setModeCommand);
  setModeCommand.action(async function (this: Command, modeId: string, flags: StatusFlags) {
    await handleSetMode(explicitAgentName, modeId, flags, this, config);
  });

  const setConfigCommand = parent
    .command("set")
    .description(descriptions.setConfig)
    .argument("<key>", "Config option id", (value: string) =>
      parseNonEmptyValue("Config option key", value),
    )
    .argument("<value>", "Config option value", (value: string) =>
      parseNonEmptyValue("Config option value", value),
    );
  addSessionNameOption(setConfigCommand);
  setConfigCommand.action(async function (
    this: Command,
    key: string,
    value: string,
    flags: StatusFlags,
  ) {
    await handleSetConfigOption(explicitAgentName, key, value, flags, this, config);
  });

  // brick://874fee67 §4.2 #40 — enumeration for acpx-ui's create dialog, where
  // no session exists yet. Read-only: it opens a transient ACP session, reads the
  // adapter's advertised style list from the initialize handshake, and closes.
  // No prompt, no tokens, no record written.
  const outputStylesCommand = parent
    .command("output-styles")
    .description(descriptions.outputStyles);
  addSessionNameOption(outputStylesCommand);
  outputStylesCommand.action(async function (this: Command, flags: StatusFlags) {
    await handleListOutputStyles(explicitAgentName, flags, this, config);
  });

  registerStatusCommand(parent, explicitAgentName, config, descriptions.status);
}

export function registerAgentCommand(
  program: Command,
  agentName: string,
  config: ResolvedAcpxConfig,
): void {
  const agentCommand = program
    .command(agentName)
    .description(`Use ${agentName} agent`)
    .argument("[prompt...]", "Prompt text")
    .enablePositionalOptions()
    .passThroughOptions()
    .showHelpAfterError();

  addSessionOption(agentCommand);
  addPromptInputOption(agentCommand);
  agentCommand.action(async function (this: Command, promptParts: string[], flags: PromptFlags) {
    await handlePrompt(agentName, promptParts, flags, this, config);
  });

  registerSharedAgentSubcommands(agentCommand, agentName, config, {
    prompt: "Prompt using persistent session",
    exec: "One-shot prompt without saved session",
    cancel: "Cooperatively cancel current in-flight prompt",
    setMode: "Set session mode",
    setConfig:
      "Set session config option (special keys: `model`, `subscription` <id> — switch the Claude subscription in place; `profile` <id> — move the session to a different credential profile, SDK sub1↔sub2 or bridge1↔bridge2; `outputStyle` <name> — set the Claude Code output style, accepted even mid-turn and bound when the turn ends)",
    outputStyles:
      "List the output styles this agent offers (pass --session-id to read a session's own advertised list instead of opening a transient one)",
    status: "Show local status of current session agent process",
  });

  registerSessionsCommand(agentCommand, agentName, config);
  registerSubscriptionsCommand(agentCommand, config);
  registerProfilesCommand(agentCommand, config);
}

export function registerFlowCommand(program: Command, config: ResolvedAcpxConfig): void {
  const flowCommand = program
    .command("flow")
    .description("Run multi-step ACP workflows from flow files");

  flowCommand
    .command("run")
    .description("Run a flow file")
    .argument("<file>", "Flow module path")
    .option("--input-json <json>", "Flow input as JSON")
    .option("--input-file <path>", "Read flow input JSON from file")
    .option(
      "--default-agent <name>",
      "Default agent profile for ACP nodes without profile",
      (value: string) => parseNonEmptyValue("Default agent", value),
    )
    .action(async function (this: Command, file: string, flags: FlowRunFlags) {
      const { handleFlowRun } = await import("../flows/cli.js");
      await handleFlowRun(file, flags, this, config);
    });
}

export function registerDefaultCommands(program: Command, config: ResolvedAcpxConfig): void {
  registerSharedAgentSubcommands(program, undefined, config, {
    prompt: `Prompt using ${config.defaultAgent} by default`,
    exec: `One-shot prompt using ${config.defaultAgent} by default`,
    cancel: `Cancel active prompt for ${config.defaultAgent} by default`,
    setMode: `Set session mode for ${config.defaultAgent} by default`,
    setConfig: `Set session config option for ${config.defaultAgent} by default (special keys: \`model\`, \`subscription\` <id>, \`profile\` <id> — move the session's credential, SDK sub1↔sub2 or bridge1↔bridge2; \`outputStyle\` <name>)`,
    outputStyles: `List the output styles ${config.defaultAgent} offers`,
    status: `Show local status for ${config.defaultAgent} by default`,
  });

  registerSessionsCommand(program, undefined, config);
  registerSubscriptionsCommand(program, config);
  registerProfilesCommand(program, config);
  registerAgentsCommand(program, config);
  registerModelsCommand(program, config);
  registerProvidersCommand(program, config);
  registerConfigCommand(program, config);
  registerFlowCommand(program, config);
}
