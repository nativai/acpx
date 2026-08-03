import { Command, Option } from "commander";
import { DEFAULT_HISTORY_LIMIT } from "../session/persistence.js";
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
  handleSessionsSetMetadata,
  handleSessionsShow,
  handleSessionsTemplate,
  handleSessionsTemplates,
  handleSessionsTemplatesMigrateSlugs,
  handleSessionsTemplatesRollback,
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
import { registerProfilesCommand } from "./profiles-command.js";
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
    .description("Delete closed sessions and free disk space")
    .option("--dry-run", "Preview what would be pruned without deleting anything")
    .option("--before <date>", "Prune sessions closed before this date", parsePruneBeforeDate)
    .option("--older-than <days>", "Prune sessions closed more than N days ago", parseDaysOlderThan)
    .option("--include-history", "Also delete event stream files (.stream.ndjson)")
    .action(async function (this: Command, flags: SessionsPruneFlags) {
      await handleSessionsPrune(explicitAgentName, flags, this, config);
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
      "Set session config option (special keys: `model`, `subscription` <id> — switch the Claude subscription in place; `profile` <id> — move the session to a different credential profile, SDK sub1↔sub2 or bridge1↔bridge2)",
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
    setConfig: `Set session config option for ${config.defaultAgent} by default (special keys: \`model\`, \`subscription\` <id>, \`profile\` <id> — move the session's credential, SDK sub1↔sub2 or bridge1↔bridge2)`,
    status: `Show local status for ${config.defaultAgent} by default`,
  });

  registerSessionsCommand(program, undefined, config);
  registerSubscriptionsCommand(program, config);
  registerProfilesCommand(program, config);
  registerConfigCommand(program, config);
  registerFlowCommand(program, config);
}
