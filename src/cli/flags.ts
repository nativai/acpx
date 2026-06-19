import path from "node:path";
import { InvalidArgumentError } from "commander";
import type { Command } from "commander";
import {
  DEFAULT_AGENT_NAME,
  resolveAgentCommand as resolveAgentCommandFromRegistry,
} from "../agent-registry.js";
import type { SystemPromptOption } from "../runtime/engine/session-options.js";
import { DEFAULT_QUEUE_OWNER_TTL_MS } from "../session/session.js";
import {
  AUTH_POLICIES,
  NON_INTERACTIVE_PERMISSION_POLICIES,
  OUTPUT_FORMATS,
  REASONING_EFFORTS,
  type AuthPolicy,
  type NonInteractivePermissionPolicy,
  type OutputFormat,
  type OutputPolicy,
  type PermissionMode,
} from "../types.js";
import type { ResolvedAcpxConfig } from "./config.js";

export type PermissionFlags = {
  approveAll?: boolean;
  approveReads?: boolean;
  denyAll?: boolean;
};

export function hasExplicitPermissionModeFlag(flags: PermissionFlags): boolean {
  return flags.approveAll === true || flags.approveReads === true || flags.denyAll === true;
}

export type GlobalFlags = PermissionFlags & {
  agent?: string;
  cwd: string;
  authPolicy?: AuthPolicy;
  nonInteractivePermissions: NonInteractivePermissionPolicy;
  jsonStrict?: boolean;
  suppressReads?: boolean;
  terminal?: boolean;
  timeout?: number;
  ttl: number;
  // The idle TTL the caller explicitly requested with --ttl, in ms; undefined
  // for a plain prompt.
  ttlExplicitMs?: number;
  verbose?: boolean;
  format: OutputFormat;
  model?: string;
  // Opaque string at parse time — validated against the profile's valid set at
  // execution time (subscription: low/medium/high/xhigh/max; openrouter:
  // minimal/low/medium/high). Typed as string (not ReasoningEffort) because OR
  // profiles add 'minimal' which is outside Claude's set.
  reasoningEffort?: string;
  subscription?: string;
  /** Profile id from `--profile <id>` — stored as session_options.profile. */
  profile?: string;
  allowedTools?: string[];
  maxTurns?: number;
  systemPrompt?: SystemPromptOption;
  promptRetries?: number;
  permissionPolicy?: string;
};

export type SessionSelectorFlags = {
  session?: string;
  sessionId?: string;
  sessionUrl?: string;
};

export type PromptFlags = SessionSelectorFlags & {
  wait?: boolean;
  file?: string;
  messageId?: string;
};

export type ExecFlags = {
  file?: string;
};

export type SessionsNewFlags = {
  name?: string;
  resumeSession?: string;
  parentId?: string;
  parentSessionUrl?: string;
  metadata?: Record<string, string>;
  fromTemplate?: string;
  // --from-template auto-fire (ignored outside the --from-template path). Commander
  // couples `--prompt <text>` and `--no-prompt` onto this one property:
  //   string  → override the template's stored auto_prompt with this text
  //   false   → --no-prompt: suppress any auto-prompt
  //   true / undefined → use the template's auto_prompt (the default)
  prompt?: string | boolean;
};

export type SessionsCopyFlags = {
  from: string;
  atIndex?: number;
  name?: string;
  parentId?: string;
  parentSessionUrl?: string;
  metadata?: Record<string, string>;
  ephemeral?: boolean;
  prompt?: string;
  promptFile?: string;
};

export type SessionsTemplateFlags = {
  enable?: boolean;
  disable?: boolean;
  // Prompt auto-sent on every spawn from this template. Present (incl. "") sets it
  // (empty clears); absent preserves any existing value.
  autoPrompt?: string;
};

export type SessionsHistoryFlags = SessionSelectorFlags & {
  limit: number;
};

export type SessionsListFlags = {
  cursor?: string;
  filterCwd?: string;
  local?: boolean;
};

export type SessionsOwnerStatusFlags = {
  all?: boolean;
  descendantsOf?: string;
};

export type SessionsExportFlags = SessionSelectorFlags & {
  output: string;
  sourceCwd?: string;
};

export type SessionsImportFlags = {
  name?: string;
  destinationCwd?: string;
};

export type StatusFlags = SessionSelectorFlags;

export type SessionsPruneFlags = {
  dryRun?: boolean;
  before?: Date;
  olderThan?: number;
  includeHistory?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOption(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOption(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringArrayOption(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function nonEmptyStringOption(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseOutputFormat(value: string): OutputFormat {
  if (!OUTPUT_FORMATS.includes(value as OutputFormat)) {
    throw new InvalidArgumentError(
      `Invalid format "${value}". Expected one of: ${OUTPUT_FORMATS.join(", ")}`,
    );
  }
  return value as OutputFormat;
}

export function parseAuthPolicy(value: string): AuthPolicy {
  if (!AUTH_POLICIES.includes(value as AuthPolicy)) {
    throw new InvalidArgumentError(
      `Invalid auth policy "${value}". Expected one of: ${AUTH_POLICIES.join(", ")}`,
    );
  }
  return value as AuthPolicy;
}

// Union of all valid effort values across all profile types. Profile-specific
// validation (e.g. 'xhigh' rejected for openrouter) happens at execution time
// inside applyProfileAuth where the profile is known.
const ALL_KNOWN_EFFORTS = ["minimal", ...REASONING_EFFORTS] as const;

export function parseReasoningEffort(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!(ALL_KNOWN_EFFORTS as readonly string[]).includes(normalized)) {
    throw new InvalidArgumentError(
      `Invalid reasoning effort "${value}". ` +
        `Claude profiles: ${REASONING_EFFORTS.join(", ")}. ` +
        `OpenRouter profiles: minimal, low, medium, high.`,
    );
  }
  return normalized;
}

export function parseNonInteractivePermissionPolicy(value: string): NonInteractivePermissionPolicy {
  if (!NON_INTERACTIVE_PERMISSION_POLICIES.includes(value as NonInteractivePermissionPolicy)) {
    throw new InvalidArgumentError(
      `Invalid non-interactive permission policy "${value}". Expected one of: ${NON_INTERACTIVE_PERMISSION_POLICIES.join(", ")}`,
    );
  }
  return value as NonInteractivePermissionPolicy;
}

export function parseTimeoutSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Timeout must be a positive number of seconds");
  }
  return Math.round(parsed * 1000);
}

export function parseTtlSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError("TTL must be a non-negative number of seconds");
  }
  return Math.round(parsed * 1000);
}

export function parseSessionName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError("Session name must not be empty");
  }
  return trimmed;
}

export function parseNonEmptyValue(label: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InvalidArgumentError(`${label} must not be empty`);
  }
  return trimmed;
}

export function parseMessageId(value: string): string {
  const parsed = parseNonEmptyValue("Message id", value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new InvalidArgumentError("--message-id must be a UUID");
  }
  return parsed;
}

export function parseHistoryLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Limit must be a positive integer");
  }
  return parsed;
}

export function parseForkAtIndex(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("--at-index must be a non-negative integer");
  }
  return parsed;
}

export function parseDaysOlderThan(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("--older-than must be a positive integer number of days");
  }
  return parsed;
}

export function parseMetadataEntry(
  value: string,
  previous: Record<string, string> | undefined,
): Record<string, string> {
  const eqIndex = value.indexOf("=");
  if (eqIndex < 0) {
    throw new InvalidArgumentError(`--metadata expects key=value (got: ${JSON.stringify(value)})`);
  }
  const key = value.slice(0, eqIndex).trim();
  if (key.length === 0) {
    throw new InvalidArgumentError(
      `--metadata key must not be empty (got: ${JSON.stringify(value)})`,
    );
  }
  const rawValue = value.slice(eqIndex + 1);
  return { ...previous, [key]: rawValue };
}

export function parsePruneBeforeDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidArgumentError(
      `--before must be a valid date (e.g. 2026-01-01 or 2026-01-01T00:00:00Z)`,
    );
  }
  return date;
}

export function parseAllowedTools(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const items = trimmed.split(",").map((item) => item.trim());
  if (items.some((item) => item.length === 0)) {
    throw new InvalidArgumentError(
      "Allowed tools must be a comma-separated list without empty entries",
    );
  }

  return items;
}

export function parseMaxTurns(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("Max turns must be a positive integer");
  }
  return parsed;
}

export function resolveSystemPromptFlag(opts: {
  systemPrompt?: unknown;
  appendSystemPrompt?: unknown;
}): SystemPromptOption | undefined {
  const replace = nonEmptyStringOption(opts.systemPrompt);
  const append = nonEmptyStringOption(opts.appendSystemPrompt);

  if (replace !== undefined && append !== undefined) {
    throw new InvalidArgumentError("Use only one of --system-prompt or --append-system-prompt");
  }
  if (replace !== undefined) {
    return replace;
  }
  if (append !== undefined) {
    return { append };
  }
  return undefined;
}

export function parsePromptRetries(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError("Prompt retries must be a non-negative integer");
  }
  return parsed;
}

export function resolvePermissionMode(
  flags: PermissionFlags,
  defaultMode: PermissionMode,
): PermissionMode {
  const selected = [flags.approveAll, flags.approveReads, flags.denyAll].filter(Boolean).length;

  if (selected > 1) {
    throw new InvalidArgumentError(
      "Use only one permission mode: --approve-all, --approve-reads, or --deny-all",
    );
  }

  if (flags.approveAll) {
    return "approve-all";
  }
  if (flags.approveReads) {
    return "approve-reads";
  }
  if (flags.denyAll) {
    return "deny-all";
  }

  return defaultMode;
}

export function addGlobalFlags(command: Command): Command {
  return command
    .option("--agent <command>", "Raw ACP agent command (escape hatch)")
    .option("--cwd <dir>", "Working directory", process.cwd())
    .option(
      "--auth-policy <policy>",
      "Authentication policy: skip or fail when auth is required",
      parseAuthPolicy,
    )
    .option("--approve-all", "Auto-approve all permission requests")
    .option("--approve-reads", "Auto-approve read/search requests and prompt for writes")
    .option("--deny-all", "Deny all permission requests")
    .option(
      "--non-interactive-permissions <policy>",
      "When prompting is unavailable: deny or fail",
      parseNonInteractivePermissionPolicy,
    )
    .option(
      "--permission-policy <json-or-file>",
      "Permission policy JSON or path (autoApprove, autoDeny, escalate, defaultAction)",
    )
    .option("--policy <json-or-file>", "Alias for --permission-policy")
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .option("--suppress-reads", "Suppress raw read-file contents in output")
    .option("--model <id>", "Agent model id")
    .option(
      "--reasoning-effort <level>",
      "Thinking depth: Claude profiles accept low/medium/high/xhigh/max; " +
        "OpenRouter profiles with reasoningSupported accept minimal/low/medium/high. " +
        "Overrides the profile's default reasoningEffort. " +
        "Out-of-range values for the active profile are rejected with a clear error. " +
        "(Ignored by codex — set codex depth via --model '<model>[depth]'.)",
      parseReasoningEffort,
    )
    .option(
      "--subscription <id>",
      "Claude subscription id from the subscriptions registry (sets CLAUDE_CONFIG_DIR per session)",
    )
    .option(
      "--profile <id>",
      "Profile id from the profiles registry (supports subscription and openrouter auth modes)",
    )
    .option(
      "--allowed-tools <list>",
      'Allowed tool names as a comma-separated list (use "" for no tools)',
      parseAllowedTools,
    )
    .option("--max-turns <count>", "Maximum turns for the session", parseMaxTurns)
    .option(
      "--system-prompt <text>",
      "Replace the agent system prompt (claude-agent-acp via ACP _meta.systemPrompt)",
      (value: string) => parseNonEmptyValue("System prompt", value),
    )
    .option(
      "--append-system-prompt <text>",
      "Append text to the agent system prompt (claude-agent-acp via ACP _meta.systemPrompt.append)",
      (value: string) => parseNonEmptyValue("Append system prompt", value),
    )
    .option(
      "--prompt-retries <count>",
      "Retry failed prompt turns on transient errors (default: 0)",
      parsePromptRetries,
    )
    .option(
      "--json-strict",
      "Strict JSON mode: requires --format json and suppresses non-JSON stderr output",
    )
    .option("--no-terminal", "Do not advertise ACP terminal capability")
    .option("--timeout <seconds>", "Maximum time to wait for agent response", parseTimeoutSeconds)
    .option(
      "--ttl <seconds>",
      "Queue owner idle TTL before shutdown (0 = keep alive forever) (default: 900)",
      parseTtlSeconds,
    )
    .option("--verbose", "Enable verbose debug logs");
}

export function addSessionIdentityOptions(command: Command): Command {
  return command
    .option(
      "--session-id <id>",
      "Resolve a session globally by acpx record id, ACP session id, or unique suffix",
      (value: string) => parseNonEmptyValue("Session id", value),
    )
    .option(
      "--session-url <url>",
      "Resolve a session globally from an acpx-ui URL containing ?session=<id>",
      (value: string) => parseNonEmptyValue("Session URL", value),
    );
}

export function addSessionOption(command: Command): Command {
  return addSessionIdentityOptions(
    command.option(
      "-s, --session <name>",
      "Use named session instead of cwd default",
      parseSessionName,
    ),
  ).option(
    "--no-wait",
    "Queue prompt and return immediately when another prompt is already running",
  );
}

export function addSessionNameOption(command: Command): Command {
  return addSessionIdentityOptions(
    command.option(
      "-s, --session <name>",
      "Use named session instead of cwd default",
      parseSessionName,
    ),
  );
}

export function resolveSessionNameFromFlags(
  flags: SessionSelectorFlags,
  command: Command,
): string | undefined {
  const directSession = parseOptionalSessionName(flags.session);
  if (directSession !== undefined) {
    return directSession;
  }

  // Commander parses options on the parent command when flags appear before the
  // subcommand (e.g. `acpx codex -s foo cancel`). Use optsWithGlobals() so
  // subcommands can still access those values.
  const allOpts = asRecord(
    (command as unknown as { optsWithGlobals?: () => unknown }).optsWithGlobals?.(),
  );
  const globalSession = parseOptionalSessionName(allOpts?.session);
  if (globalSession !== undefined) {
    return globalSession;
  }

  const parentOpts = asRecord(command.parent?.opts?.() as unknown);
  return parseOptionalSessionName(parentOpts?.session);
}

export function resolveSessionSelectorFromFlags(
  flags: SessionSelectorFlags,
  command: Command,
): SessionSelectorFlags {
  return {
    session: resolveSessionNameFromFlags(flags, command),
    sessionId: resolveStringFlagFromScopes("Session id", "sessionId", flags, command),
    sessionUrl: resolveStringFlagFromScopes("Session URL", "sessionUrl", flags, command),
  };
}

function parseOptionalSessionName(value: unknown): string | undefined {
  const session = stringOption(value);
  return session === undefined ? undefined : parseSessionName(session);
}

function resolveStringFlagFromScopes(
  label: string,
  optionName: string,
  flags: SessionSelectorFlags,
  command: Command,
): string | undefined {
  return (
    parseOptionalNonEmptyFlag(label, asRecord(flags)?.[optionName]) ??
    resolveStringFlagFromCommandScopes(label, optionName, command)
  );
}

function resolveStringFlagFromCommandScopes(
  label: string,
  optionName: string,
  command: Command,
): string | undefined {
  const allOpts = asRecord(
    (command as unknown as { optsWithGlobals?: () => unknown }).optsWithGlobals?.(),
  );
  const globalValue = parseOptionalNonEmptyFlag(label, allOpts?.[optionName]);

  const parentOpts = asRecord(command.parent?.opts?.() as unknown);
  return globalValue ?? parseOptionalNonEmptyFlag(label, parentOpts?.[optionName]);
}

function parseOptionalNonEmptyFlag(label: string, value: unknown): string | undefined {
  const stringValue = stringOption(value);
  return stringValue === undefined ? undefined : parseNonEmptyValue(label, stringValue);
}

export function addPromptInputOption(command: Command): Command {
  return command.option("-f, --file <path>", "Read prompt text from file path (use - for stdin)");
}

export function resolveGlobalFlags(command: Command, config: ResolvedAcpxConfig): GlobalFlags {
  const opts = asRecord(command.optsWithGlobals() as unknown) ?? {};
  const format = parseOutputFormat(stringOption(opts.format) ?? config.format ?? "text");
  const jsonStrict = opts.jsonStrict === true;
  const verbose = opts.verbose === true;
  assertOutputFlagCompatibility(format, jsonStrict, verbose);

  return {
    agent: stringOption(opts.agent),
    cwd: resolveCwdOption(opts.cwd),
    authPolicy: resolveAuthPolicy(opts.authPolicy, config),
    nonInteractivePermissions: resolveNonInteractivePermissions(
      opts.nonInteractivePermissions,
      config,
    ),
    permissionPolicy: resolvePermissionPolicyOption(opts),
    jsonStrict,
    suppressReads: opts.suppressReads === true,
    terminal: resolveTerminalOption(opts.terminal),
    timeout: resolveTimeoutOption(opts.timeout, config),
    ttl: resolveTtlOption(opts, config),
    ttlExplicitMs: resolveExplicitTtlMs(opts),
    verbose,
    format,
    model: resolveModelOption(opts.model),
    reasoningEffort: resolveReasoningEffortOption(opts.reasoningEffort),
    subscription: resolveSubscriptionOption(opts.subscription),
    profile: resolveProfileOption(opts.profile),
    allowedTools: stringArrayOption(opts.allowedTools),
    maxTurns: numberOption(opts.maxTurns),
    systemPrompt: resolveSystemPromptFlag(opts),
    promptRetries: numberOption(opts.promptRetries),
    approveAll: opts.approveAll ? true : undefined,
    approveReads: opts.approveReads ? true : undefined,
    denyAll: opts.denyAll ? true : undefined,
  };
}

function resolveCwdOption(value: unknown): string {
  return stringOption(value) ?? process.cwd();
}

function resolveAuthPolicy(optsValue: unknown, config: ResolvedAcpxConfig): AuthPolicy {
  const value = stringOption(optsValue);
  return value === undefined ? config.authPolicy : parseAuthPolicy(value);
}

function resolveNonInteractivePermissions(
  optsValue: unknown,
  config: ResolvedAcpxConfig,
): NonInteractivePermissionPolicy {
  const value = stringOption(optsValue);
  return value === undefined
    ? config.nonInteractivePermissions
    : parseNonInteractivePermissionPolicy(value);
}

function resolvePermissionPolicyOption(opts: Record<string, unknown>): string | undefined {
  const primary = stringOption(opts.permissionPolicy);
  const alias = stringOption(opts.policy);
  if (primary !== undefined && alias !== undefined && primary !== alias) {
    throw new InvalidArgumentError(
      "Use only one permission policy flag: --permission-policy or --policy",
    );
  }
  return primary ?? alias;
}

function resolveTerminalOption(value: unknown): boolean | undefined {
  return value === false ? false : undefined;
}

function resolveTimeoutOption(value: unknown, config: ResolvedAcpxConfig): number | undefined {
  return numberOption(value) ?? config.timeoutMs;
}

// The idle TTL the caller explicitly requested (ms), or undefined for a plain prompt.
function resolveExplicitTtlMs(opts: { ttl?: unknown }): number | undefined {
  return numberOption(opts.ttl);
}

function resolveTtlOption(opts: { ttl?: unknown }, config: ResolvedAcpxConfig): number {
  return resolveExplicitTtlMs(opts) ?? config.ttlMs ?? DEFAULT_QUEUE_OWNER_TTL_MS;
}

function assertOutputFlagCompatibility(
  format: OutputFormat,
  jsonStrict: boolean,
  verbose: boolean,
): void {
  if (jsonStrict && format !== "json") {
    throw new InvalidArgumentError("--json-strict requires --format json");
  }

  if (jsonStrict && verbose) {
    throw new InvalidArgumentError("--json-strict cannot be combined with --verbose");
  }
}

function resolveModelOption(value: unknown): string | undefined {
  const model = stringOption(value);
  return model === undefined ? undefined : parseNonEmptyValue("Model", model);
}

function resolveSubscriptionOption(value: unknown): string | undefined {
  const subscription = stringOption(value);
  return subscription === undefined ? undefined : parseNonEmptyValue("Subscription", subscription);
}

function resolveProfileOption(value: unknown): string | undefined {
  const profile = stringOption(value);
  return profile === undefined ? undefined : parseNonEmptyValue("Profile", profile);
}

// Commander already runs parseReasoningEffort via the option parser, so the
// value reaching here is validated; re-validate defensively (cheap, and guards
// any path that reads the option without the parser attached).
function resolveReasoningEffortOption(value: unknown): string | undefined {
  return typeof value === "string" ? parseReasoningEffort(value) : undefined;
}

export function resolveOutputPolicy(format: OutputFormat, jsonStrict: boolean): OutputPolicy {
  return {
    format,
    jsonStrict,
    suppressReads: false,
    suppressNonJsonStderr: jsonStrict,
    queueErrorAlreadyEmitted: format !== "quiet",
    suppressSdkConsoleErrors: jsonStrict,
  };
}

export function resolveAgentInvocation(
  explicitAgentName: string | undefined,
  globalFlags: GlobalFlags,
  config: ResolvedAcpxConfig,
): {
  agentName: string;
  agentCommand: string;
  cwd: string;
} {
  const override = globalFlags.agent?.trim();
  if (override && explicitAgentName) {
    throw new InvalidArgumentError("Do not combine positional agent with --agent override");
  }

  const agentName = explicitAgentName ?? config.defaultAgent ?? DEFAULT_AGENT_NAME;
  const agentCommand =
    override && override.length > 0
      ? override
      : resolveAgentCommandFromRegistry(agentName, config.agents);

  return {
    agentName,
    agentCommand,
    cwd: path.resolve(globalFlags.cwd),
  };
}
