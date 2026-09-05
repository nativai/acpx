import os from "node:os";
import path from "node:path";
import { InvalidArgumentError } from "commander";
import type { Command } from "commander";
import {
  DEFAULT_AGENT_NAME,
  resolveAgentCommand as resolveAgentCommandFromRegistry,
} from "../agent-registry.js";
import type { SystemPromptOption } from "../runtime/engine/session-options.js";
import { CANONICAL_DEPTH_VOCABULARY } from "../session/depth-projection.js";
import { DEFAULT_QUEUE_OWNER_TTL_MS } from "../session/session.js";
import {
  AUTH_POLICIES,
  NON_INTERACTIVE_PERMISSION_POLICIES,
  OUTPUT_FORMATS,
  type AuthPolicy,
  type NonInteractivePermissionPolicy,
  type OutputFormat,
  type OutputPolicy,
  enforcePermissionMode,
  isReducingPermissionMode,
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
  /**
   * `--output-style <name>` (brick://874fee67): the Claude Code output style for
   * this session. OPAQUE non-empty string at parse time — the style's `name:`
   * frontmatter, which may contain spaces and is NOT uniformly cased (`default`
   * is lowercase beside `Proactive`/`Explanatory`/`Learning`). Deliberately NOT
   * an enum: custom/house styles are discovered at runtime, so the only valid
   * list is the harness's own `available_output_styles`, checked at the
   * advertised-option boundary — never here.
   */
  outputStyle?: string;
  subscription?: string;
  /** Profile id from `--profile <id>` — stored as session_options.profile. */
  profile?: string;
  allowedTools?: string[];
  maxTurns?: number;
  systemPrompt?: SystemPromptOption;
  promptRetries?: number;
  permissionPolicy?: string;
  /** `--floor-hard` (brick://07dd62c9): refuse/quarantine below-pinned-floor work
   *  instead of the default detect+surface+accept. Durable per-session policy. */
  floorHard?: boolean;
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
  brick?: string | false;
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
  brick?: string | false;
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
  // Explicit template slug on --enable (canonicalized via slugify). Absent ⇒
  // default slug = slugify(name). The refresh skill passes this when the target
  // slug differs from slugify(the candidate's name).
  slug?: string;
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

// D1 (brick://53437107) — `sessions close` flags. `drain` is Commander's
// `--no-drain` boolean: absent/true = the barrier runs, false = today's
// destroy-on-close behaviour, chosen explicitly.
export type SessionsCloseFlags = StatusFlags & {
  drain?: boolean;
  drainTimeout?: number;
  failOnUndelivered?: boolean;
};

export type SessionsPruneFlags = {
  dryRun?: boolean;
  before?: Date;
  olderThan?: number;
  includeHistory?: boolean;
  includeTemplates?: boolean;
  /**
   * `--cwd` is a pure boolean: "sessions whose cwd is the invocation cwd". No
   * value form, deliberately — session ids are a variadic positional, and an
   * optional-value option would swallow the first id (`prune --cwd 4e25443c`
   * would bind cwd="4e25443c" and silently drop the id). See
   * test/sessions-prune-scope.test.ts "binds the id, never --cwd's value".
   */
  cwd?: boolean;
  /** The audit token. Deliberately long and distinctive; no `--all` alias. */
  wholeBox?: boolean;
  /**
   * Where the orphan HARNESS CONFIG DIR sweep looks — NOT a scope on which
   * sessions are pruned.
   *
   * ⚠️ NAMED `--config-dir-root`, NOT `--root-dir`, DELIBERATELY. On a verb that
   * deletes session records, a bare `--root-dir` reads as "prune the store rooted
   * here" — the one misreading that would be destructive. This flag never widens
   * or narrows the set of sessions deleted; it only bounds the directory tree the
   * post-prune config-dir sweep walks.
   */
  configDirRoot?: string;
};

/**
 * `sessions sweep-config-dirs` — the NON-DESTRUCTIVE sweep. Deliberately carries
 * no session-selection flags at all: it deletes no records, so it needs no scope,
 * and adding one would invite the reading that it prunes sessions under a root.
 */
export type SessionsSweepConfigDirsFlags = {
  /** Classify and print every candidate; remove nothing. */
  dryRun?: boolean;
  /** Bound the sweep to this directory instead of the system temp dir. */
  configDirRoot?: string;
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

/**
 * ⚠️ THIS GATE IS HARNESS-AGNOSTIC, SO IT MUST NOT APPLY A HARNESS'S LADDER.
 *
 * `--reasoning-effort` is a GLOBAL flag, parsed before the agent is known — and
 * two harnesses have now proved, from opposite directions, that a ladder fixed
 * here is wrong:
 *
 *   - **codex** widened `ReasoningEffort` from a closed union to an OPEN STRING;
 *     rungs are catalogue-driven per model, and `gpt-6-astra` carries **`ultra`**,
 *     a rung acpx had never seen.
 *   - **pi** advertises six rungs and serves three, so even a "correct" ladder
 *     read from the harness can lie (brick f13fdceb).
 *
 * Measured before this change: of the NINE values in
 * {@link CANONICAL_DEPTH_VOCABULARY}, this parser rejected **three** —
 * `ultra`, and B3's two load-bearing sentinels `default` and `off` — so a valid
 * rung on a catalogue-driven harness, and a request to disable reasoning, both
 * died at acpx's own door before any harness saw them.
 *
 * The vocabulary is now the CANONICAL one, in one place, so the two cannot
 * disagree again. **Narrowing still happens where the harness IS known** —
 * `applyProfileAuth` for profile limits, `projectDepthOntoLadder` for the model's
 * own ladder, and the config-option arm for what the agent advertises. This gate
 * only rejects what is not depth vocabulary at all.
 */
export function parseReasoningEffort(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!(CANONICAL_DEPTH_VOCABULARY as readonly string[]).includes(normalized)) {
    throw new InvalidArgumentError(
      `Invalid reasoning effort "${value}". Expected one of: ` +
        `${CANONICAL_DEPTH_VOCABULARY.join(", ")}. ` +
        `Not every harness or model serves every rung — acpx projects onto what the ` +
        `target actually advertises and records the outcome.`,
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

// D1 (brick://53437107) — `--drain-timeout <ms>`. 0 is legal and meaningful: it
// means "terminalize whatever is queued right now, do not wait out a running
// turn". Negative or non-numeric is a usage error, not a silent fallback.
export function parseDrainTimeoutMs(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError(
      "--drain-timeout must be a non-negative integer number of milliseconds",
    );
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

/**
 * Emitted at most ONCE per process. A user who passes `--deny-all` twice in one
 * pipeline does not need to be told twice, and a repeated warning trains people
 * to filter it — which is how an honest message becomes noise.
 */
let inertPermissionFlagWarned = false;

/** Test seam: `resolvePermissionMode` warns once per process, so tests must reset it. */
export function resetInertPermissionFlagWarning(): void {
  inertPermissionFlagWarned = false;
}

function warnInertPermissionFlag(flag: string): void {
  if (inertPermissionFlagWarned) {
    return;
  }
  inertPermissionFlagWarned = true;
  // NOT suppressed for plain `--format json` — a machine-readable caller is
  // exactly the caller most likely to be relying on a flag that no longer does
  // anything, and stdout stays parseable because this goes to stderr.
  //
  // ⚠️ It IS suppressed for `--json-strict`, and that is a correction rather than
  // a preference: `--json-strict` carries a SHIPPED CONTRACT that stderr is
  // EMPTY (`test/integration.test.ts` asserts `result.stderr.trim() === ""`). I
  // first wrote this warning as unconditional on the reasoning above; that
  // contract is what proved it wrong. A caller who opts into json-strict has
  // explicitly asked for silence, and breaking that for every such consumer is a
  // larger harm than one unseen warning — the flag's inertness is still
  // announced on every other path.
  process.stderr.write(
    `[acpx] ${flag} accepted but inert on this fleet: agents always run with full ` +
      `process permissions — Daniel 2026-09-03\n`,
  );
}

/**
 * Resolve the permission mode from the flags — and then ENFORCE the fleet policy
 * over the result (brick https://acpx.devbox.nativai.de/?brick=a4369a7e).
 *
 * The flags are still fully parsed: combining two is still an error, and each is
 * still recognised. What changed is that a REDUCING selection no longer reduces
 * anything — it is announced as inert and the enforced mode is returned, so the
 * value that flows into the session record, the queue-owner payload and the
 * client is the one the surfaces will actually apply. Returning the requested
 * mode instead would leave a record that disagrees with the behaviour, which is
 * the dishonesty this programme keeps removing.
 *
 * ⚠️ This is the CLI half. It is NOT the guarantee — `AcpClient` enforces the
 * same policy when it stores the mode, so a caller that never goes through this
 * function (a test, a future non-CLI entry point) cannot reduce permissions
 * either. See {@link enforcePermissionMode}.
 */
export function resolvePermissionMode(
  flags: PermissionFlags & { jsonStrict?: boolean },
  defaultMode: PermissionMode,
): PermissionMode {
  const selected = [flags.approveAll, flags.approveReads, flags.denyAll].filter(Boolean).length;

  if (selected > 1) {
    throw new InvalidArgumentError(
      "Use only one permission mode: --approve-all, --approve-reads, or --deny-all",
    );
  }

  if (flags.jsonStrict) {
    // json-strict's empty-stderr contract wins; see warnInertPermissionFlag.
  } else if (flags.approveReads) {
    warnInertPermissionFlag("--approve-reads");
  } else if (flags.denyAll) {
    warnInertPermissionFlag("--deny-all");
  } else if (!flags.approveAll && isReducingPermissionMode(defaultMode)) {
    // A reducing default from config.json / .acpxrc.json is just as inert as a
    // reducing flag, and just as deserving of being told so.
    warnInertPermissionFlag(`defaultPermissions "${defaultMode}"`);
  }

  return enforcePermissionMode(flags.approveAll ? "approve-all" : defaultMode);
}

/**
 * P1 cwd-hardening (RCA Incident 1): a `process.cwd()` that throws when the
 * inherited working directory has been deleted (a reaped worktree) would crash
 * at option-registration time — before any parse — blackholing a delivery/queue
 * spawn. Fall back to os.homedir() (always valid for the running user; acpx's
 * own store/lease/recover anchor). The delivery invocation always passes an
 * explicit --cwd, so this default only guards the crash, never the real cwd.
 */
export function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return os.homedir();
  }
}

export function addGlobalFlags(command: Command): Command {
  return command
    .option("--agent <command>", "Raw ACP agent command (escape hatch)")
    .option("--cwd <dir>", "Working directory", safeCwd())
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
      "--output-style <name>",
      "Claude Code output style for the session (e.g. Explanatory, Learning, or a " +
        "custom/house style name). Sets the agent's role, tone and default response " +
        "format. Durable per-session and inherited by child sessions of the same " +
        "agent type. (Ignored with a warning by agents that do not advertise an " +
        "output-style option, e.g. codex.)",
      (value: string) => parseNonEmptyValue("Output style", value),
    )
    .option(
      "--subscription <id>",
      "Claude subscription id from the subscriptions registry (sets CLAUDE_CONFIG_DIR per session); " +
        "pass 'auto' to let acpx pick the best-available unlocked subscription",
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
      "--floor-hard",
      "Hard model-floor mode: refuse/quarantine a turn served below the pinned " +
        "model floor instead of the default detect+surface+accept. For hard-ruled " +
        "agents where correctness > availability (e.g. max-Opus context-engineers). " +
        "Durable per-session; a below-floor turn is never silently accepted, and " +
        "the session auto-recovers once the pin is served again.",
    )
    .option(
      "--json-strict",
      "Strict JSON mode: requires --format json and suppresses non-JSON stderr output",
    )
    .option("--no-terminal", "Do not advertise ACP terminal capability")
    .option("--timeout <seconds>", "Maximum time to wait for agent response", parseTimeoutSeconds)
    .option(
      "--ttl <seconds>",
      // Since W13-24-10 the owner is NOT shut down at the TTL just for being quiet;
      // this is the idle-CHECK cadence — how often an idle owner re-checks for a
      // deploy-staleness recycle and the idle-memory release. 0 = never recycle or
      // release (the master opt-out). The idle-memory release timeout itself is a
      // separate knob: env ACPX_OWNER_IDLE_RELEASE_MS in ms (default 1800000 = 30
      // min; 0 disables only memory-release, keeping deploy-staleness recycle).
      "Queue owner idle-check cadence in seconds (0 = never recycle/release). Idle-memory release timeout: env ACPX_OWNER_IDLE_RELEASE_MS (ms, default 1800000) (default: 900)",
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
      "Use named session (local first, then one exact global agent match)",
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
      "Use named session (local first, then one exact global agent match)",
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
    outputStyle: resolveOutputStyleOption(opts.outputStyle),
    subscription: resolveSubscriptionOption(opts.subscription),
    profile: resolveProfileOption(opts.profile),
    allowedTools: stringArrayOption(opts.allowedTools),
    maxTurns: numberOption(opts.maxTurns),
    systemPrompt: resolveSystemPromptFlag(opts),
    promptRetries: numberOption(opts.promptRetries),
    floorHard: opts.floorHard === true ? true : undefined,
    approveAll: opts.approveAll ? true : undefined,
    approveReads: opts.approveReads ? true : undefined,
    denyAll: opts.denyAll ? true : undefined,
  };
}

function resolveCwdOption(value: unknown): string {
  return stringOption(value) ?? safeCwd();
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

// The value domain is OPEN (custom + house styles are discovered at runtime), so
// this only enforces non-emptiness. Validation against the real set happens where
// the set actually exists — against the agent's advertised `available_output_styles`
// (brick://874fee67 design §3.1/AC-5). Never lowercase or slugify here.
function resolveOutputStyleOption(value: unknown): string | undefined {
  const outputStyle = stringOption(value);
  return outputStyle === undefined ? undefined : parseNonEmptyValue("Output style", outputStyle);
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
