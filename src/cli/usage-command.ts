import { Command, InvalidArgumentError } from "commander";
import { agentKindFromCommand, agentNameFromCommand } from "../agent-registry.js";
import { collectCodexQuota, type CodexQuotaWindow } from "../config/codex-usage.js";
import {
  getSubscriptionsUsage,
  type SubscriptionUsage,
  type SubscriptionUsageWindow,
} from "../config/subscription-usage.js";
import {
  findSubscription,
  type SubscriptionEntry,
  type SubscriptionRegistry,
} from "../config/subscriptions.js";
import {
  AcpxOperationalError,
  SessionNotFoundError,
  SessionResolutionError,
  SubscriptionUnknownError,
} from "../errors.js";
import { listSessions, resolveSessionRecord } from "../session/persistence.js";
import type { OutputErrorCode, OutputFormat, SessionRecord } from "../types.js";
import { parseSessionIdFromUrl } from "./command-handlers.js";
import type { ResolvedAcpxConfig } from "./config.js";
import { parseOutputFormat, resolveGlobalFlags } from "./flags.js";
import {
  formatPercent,
  renderSubscriptionsUsageQuiet,
  renderUsageText,
} from "./subscriptions-command.js";

// `acpx usage` — session-centric limit-usage. Resolves the target session → its
// subscription (claude) or its account-global ChatGPT quota (codex) → reports
// the same 5h/7d windows `subscriptions usage` reports (shared 5-min probe
// cache, so the numbers are identical within a window). Agent kind is classified
// from the session RECORD, never the env (a codex session also carries
// ACPX_SUBSCRIPTION) — that guard is what keeps a codex session from ever
// reporting Claude numbers. See agentKindFromCommand for the why.

type ClaudeSource =
  | "session-record"
  | "env"
  | "registry-default"
  | "registry-default-no-session"
  | "explicit-subscription";

type SessionInfo = {
  id: string;
  name: string | null;
  agent: string;
};

type ClaudeWindowJson = {
  utilization: number;
  percentUsed: number;
  reset: string | null;
};

export type ClaudeUsageResult = {
  kind: "claude-subscription";
  session: SessionInfo | null;
  subscription: { id: string; label: string };
  source: ClaudeSource;
  fiveHour: ClaudeWindowJson | null;
  sevenDay: ClaudeWindowJson | null;
  error?: string;
};

type CodexWindowJson = {
  usedPercent: number;
  resetsAt: string;
  windowMinutes: number;
  elapsed: boolean;
};

export type CodexUsageResult = {
  kind: "codex-quota";
  session: SessionInfo | null;
  source: "codex-cli-rollout";
  scope: "account-global";
  planType: string | null;
  capturedAt: string | null;
  ageSeconds: number | null;
  fiveHour: CodexWindowJson | null;
  weekly: CodexWindowJson | null;
  notes: string[];
};

export type NotApplicableResult = {
  kind: "not-applicable";
  session: SessionInfo | null;
  message: string;
};

export type AllSubscriptionsResult = {
  kind: "all-subscriptions";
  subscriptions: SubscriptionUsage[];
};

export type UsageResult =
  | ClaudeUsageResult
  | CodexUsageResult
  | NotApplicableResult
  | AllSubscriptionsResult;

export type UsageFlags = {
  session?: string;
  subscription?: string;
  all?: boolean;
};

function envSubscription(): string | undefined {
  const raw = process.env.ACPX_SUBSCRIPTION?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function noSubscriptionResolvable(): AcpxOperationalError {
  return new AcpxOperationalError(
    "no subscription resolvable for this session; register one or set a default — see `acpx subscriptions list`",
    { outputCode: "USAGE", origin: "cli" },
  );
}

// ---- target resolution ---------------------------------------------------

// `--session <value>` per OQ4: URL → id → name. Name is tried ONLY when id
// resolution raises not-found (an ambiguous suffix is a real error, surfaced).
async function resolveSessionTarget(value: string): Promise<SessionRecord> {
  const fromUrl = parseSessionIdFromUrl(value);
  if (fromUrl) {
    return await resolveSessionRecord(fromUrl);
  }
  try {
    return await resolveSessionRecord(value);
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return await resolveSessionByName(value);
    }
    throw err;
  }
}

async function resolveSessionByName(name: string): Promise<SessionRecord> {
  const matches = (await listSessions()).filter((record) => record.name === name);
  if (matches.length === 0) {
    throw new SessionNotFoundError(name);
  }
  if (matches.length > 1) {
    const candidates = matches.map((r) => `  ${r.acpxRecordId}  (${r.cwd})`).join("\n");
    throw new SessionResolutionError(
      `multiple sessions named "${name}"; pass an id instead:\n${candidates}`,
    );
  }
  return matches[0];
}

// A subagent record has an empty agentCommand and inherits the parent's agent
// kind + subscription — classify and resolve from the parent record when present.
async function effectiveRecordForKind(record: SessionRecord): Promise<SessionRecord> {
  const isSubagent = record.kind === "subagent" || record.agentCommand.trim() === "";
  if (isSubagent && record.parentSessionId) {
    try {
      return await resolveSessionRecord(record.parentSessionId);
    } catch {
      // parent pruned — fall back to the subagent record (empty cmd → "other").
    }
  }
  return record;
}

// ---- claude branch -------------------------------------------------------

function toClaudeWindow(window: SubscriptionUsageWindow | null): ClaudeWindowJson | null {
  if (!window) {
    return null;
  }
  return {
    utilization: window.utilization,
    percentUsed: round1(window.utilization * 100),
    reset: window.reset,
  };
}

function claudeResultFromUsage(
  usage: SubscriptionUsage,
  entry: SubscriptionEntry,
  session: SessionInfo | null,
  source: ClaudeSource,
): ClaudeUsageResult {
  return {
    kind: "claude-subscription",
    session,
    subscription: { id: entry.id, label: entry.label },
    source,
    fiveHour: toClaudeWindow(usage.fiveHour),
    sevenDay: toClaudeWindow(usage.sevenDay),
    ...(usage.error !== undefined ? { error: usage.error } : {}),
  };
}

async function claudeResultForSubscription(
  subId: string,
  registry: SubscriptionRegistry,
  session: SessionInfo | null,
  source: ClaudeSource,
): Promise<ClaudeUsageResult> {
  const entry = findSubscription(subId, registry);
  if (!entry) {
    // The record names a subscription the registry no longer knows. The command
    // worked; the sub is just gone — surface it in the payload, exit 0.
    return {
      kind: "claude-subscription",
      session,
      subscription: { id: subId, label: subId },
      source,
      fiveHour: null,
      sevenDay: null,
      error: `subscription "${subId}" not in registry`,
    };
  }
  const [usage] = await getSubscriptionsUsage([entry]);
  return claudeResultFromUsage(usage, entry, session, source);
}

// ---- codex / not-applicable branches -------------------------------------

function toCodexWindow(window: CodexQuotaWindow | null): CodexWindowJson | null {
  if (!window) {
    return null;
  }
  return {
    usedPercent: window.usedPercent,
    resetsAt: window.resetsAt,
    windowMinutes: window.windowMinutes,
    elapsed: window.elapsed,
  };
}

function codexResult(session: SessionInfo | null): CodexUsageResult {
  const quota = collectCodexQuota();
  return {
    kind: "codex-quota",
    session,
    source: "codex-cli-rollout",
    scope: "account-global",
    planType: quota.planType,
    capturedAt: quota.capturedAt,
    ageSeconds: quota.ageSeconds,
    fiveHour: toCodexWindow(quota.primary),
    weekly: toCodexWindow(quota.secondary),
    notes: quota.notes,
  };
}

function notApplicableResult(session: SessionInfo | null): NotApplicableResult {
  const agent = session?.agent ?? "unknown";
  return {
    kind: "not-applicable",
    session,
    message: `Agent "${agent}" has no CLI-exposed limit usage. Claude-subscription limits apply only to claude sessions; Codex quota only to codex sessions.`,
  };
}

// ---- orchestration -------------------------------------------------------

// Resolve a claude session's subscription id + its `source` label from the
// record selection (?? env, when allowed ?? registry default). Throws when
// nothing resolves.
function resolveClaudeSubscription(
  recordSub: string | undefined,
  registry: SubscriptionRegistry,
  allowEnvFallback: boolean,
): { subId: string; source: ClaudeSource } {
  const envSub = allowEnvFallback ? envSubscription() : undefined;
  if (recordSub) {
    return { subId: recordSub, source: "session-record" };
  }
  if (envSub) {
    return { subId: envSub, source: "env" };
  }
  if (registry.default) {
    return { subId: registry.default, source: "registry-default" };
  }
  throw noSubscriptionResolvable();
}

async function resolveForRecord(
  record: SessionRecord,
  config: ResolvedAcpxConfig,
  options: { allowEnvFallback: boolean },
): Promise<UsageResult> {
  const registry = config.subscriptions;
  const effective = await effectiveRecordForKind(record);
  const kind = agentKindFromCommand(effective.agentCommand);
  const session: SessionInfo = {
    id: record.acpxRecordId,
    name: record.name ?? null,
    agent: kind === "other" ? agentNameFromCommand(effective.agentCommand, config.agents) : kind,
  };

  if (kind === "codex") {
    return codexResult(session);
  }
  if (kind === "other") {
    return notApplicableResult(session);
  }

  const { subId, source } = resolveClaudeSubscription(
    effective.acpx?.session_options?.subscription,
    registry,
    options.allowEnvFallback,
  );
  return await claudeResultForSubscription(subId, registry, session, source);
}

async function resolveWithoutRecord(registry: SubscriptionRegistry): Promise<UsageResult> {
  const envSub = envSubscription();
  let subId: string;
  let source: ClaudeSource;
  if (envSub) {
    subId = envSub;
    source = "env";
  } else if (registry.default) {
    subId = registry.default;
    source = "registry-default-no-session";
  } else {
    throw noSubscriptionResolvable();
  }
  return await claudeResultForSubscription(subId, registry, null, source);
}

async function resolveUsage(flags: UsageFlags, config: ResolvedAcpxConfig): Promise<UsageResult> {
  const registry = config.subscriptions;

  if (flags.all) {
    return {
      kind: "all-subscriptions",
      subscriptions: await getSubscriptionsUsage(registry.subscriptions),
    };
  }

  if (flags.subscription !== undefined) {
    const entry = findSubscription(flags.subscription, registry);
    if (!entry) {
      throw new SubscriptionUnknownError(flags.subscription);
    }
    const [usage] = await getSubscriptionsUsage([entry]);
    return claudeResultFromUsage(usage, entry, null, "explicit-subscription");
  }

  if (flags.session !== undefined) {
    const record = await resolveSessionTarget(flags.session);
    return await resolveForRecord(record, config, { allowEnvFallback: false });
  }

  // Current session: id from ACPX_SESSION_URL → record (record-first), else env.
  const sessionId = parseSessionIdFromUrl(process.env.ACPX_SESSION_URL);
  if (sessionId) {
    let record: SessionRecord | undefined;
    try {
      record = await resolveSessionRecord(sessionId);
    } catch {
      record = undefined;
    }
    if (record) {
      return await resolveForRecord(record, config, { allowEnvFallback: true });
    }
  }
  return await resolveWithoutRecord(registry);
}

// ---- rendering -----------------------------------------------------------

function resetSuffix(reset: string | null): string {
  return reset ? ` (resets ${reset})` : "";
}

function claudeContext(result: ClaudeUsageResult): string {
  if (result.session) {
    return `[session: ${result.session.name ?? result.session.id} · source: ${result.source}]`;
  }
  return `[source: ${result.source} · no active session record]`;
}

function renderClaudeText(result: ClaudeUsageResult): string {
  const sub = `${result.subscription.id} (${result.subscription.label})`;
  if (result.error && !result.fiveHour && !result.sevenDay) {
    return `usage: ${sub}  ERROR: ${result.error}  ${claudeContext(result)}\n`;
  }
  const five = `5h ${formatPercent(result.fiveHour)}${resetSuffix(result.fiveHour?.reset ?? null)}`;
  const seven = `7d ${formatPercent(result.sevenDay)}${resetSuffix(result.sevenDay?.reset ?? null)}`;
  return `usage: ${sub}  ${five}  ${seven}  ${claudeContext(result)}\n`;
}

function humanizeAge(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  return `${Math.floor(seconds / 86_400)}d`;
}

function codexPercent(window: CodexWindowJson | null): string {
  if (!window) {
    return "-";
  }
  return `${window.usedPercent.toFixed(1)}%${window.elapsed ? " (elapsed)" : ""}`;
}

function codexWindowText(label: string, window: CodexWindowJson | null): string {
  return `${label} ${codexPercent(window)}${resetSuffix(window?.resetsAt ?? null)}`;
}

function codexSessionSuffix(result: CodexUsageResult): string {
  return result.session ? ` · session: ${result.session.name ?? result.session.id}` : "";
}

function renderCodexText(result: CodexUsageResult): string {
  const sessionSuffix = codexSessionSuffix(result);
  if (!result.fiveHour && !result.weekly) {
    return `codex quota: no snapshot yet — run a Codex turn${sessionSuffix}\n`;
  }
  const age =
    result.ageSeconds != null
      ? `snapshot ${humanizeAge(result.ageSeconds)} old`
      : "no snapshot age";
  const five = codexWindowText("5h", result.fiveHour);
  const weekly = codexWindowText("weekly", result.weekly);
  return `usage: codex quota (account-global)  ${five}  ${weekly}  [${age}${sessionSuffix}]\n`;
}

function percentBare(window: ClaudeWindowJson | null): string {
  return window ? (window.utilization * 100).toFixed(1) : "-";
}

function codexPercentBare(window: CodexWindowJson | null): string {
  return window ? window.usedPercent.toFixed(1) : "-";
}

function formatClaude(result: ClaudeUsageResult, format: OutputFormat): string {
  if (format === "quiet") {
    return `${result.subscription.id}\t${percentBare(result.fiveHour)}\t${percentBare(result.sevenDay)}\n`;
  }
  return renderClaudeText(result);
}

function formatCodex(result: CodexUsageResult, format: OutputFormat): string {
  if (format === "quiet") {
    return `codex\t${codexPercentBare(result.fiveHour)}\t${codexPercentBare(result.weekly)}\n`;
  }
  return renderCodexText(result);
}

function formatAll(result: AllSubscriptionsResult, format: OutputFormat): string {
  return format === "quiet"
    ? renderSubscriptionsUsageQuiet(result.subscriptions)
    : renderUsageText(result.subscriptions);
}

function formatNotApplicable(result: NotApplicableResult, format: OutputFormat): string {
  return format === "quiet"
    ? `${result.session?.agent ?? "unknown"}\tn/a\tn/a\n`
    : `${result.message}\n`;
}

// Pure: render a result to its output string (no I/O), so the formatting — the
// kind discrimination, the bare-number single-session quiet vs the `%` `--all`
// quiet, the text lines — is unit-testable without a live backend.
export function formatUsageResult(result: UsageResult, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result)}\n`;
  }
  if (result.kind === "all-subscriptions") {
    return formatAll(result, format);
  }
  if (result.kind === "claude-subscription") {
    return formatClaude(result, format);
  }
  if (result.kind === "codex-quota") {
    return formatCodex(result, format);
  }
  return formatNotApplicable(result, format);
}

function emitResult(result: UsageResult, format: OutputFormat): void {
  process.stdout.write(formatUsageResult(result, format));
}

// ---- error path ----------------------------------------------------------

// Pure: map a resolution failure to its agent-facing JSON/text message + exit-
// code class. Throws non-AcpxOperationalErrors back to the caller (the top-level
// handler deals with the unexpected).
export function describeUsageError(err: unknown): {
  jsonError: string;
  textMessage: string;
  outputCode: OutputErrorCode;
} {
  if (err instanceof SessionNotFoundError) {
    return {
      jsonError: "session not found",
      textMessage: `session not found: ${err.sessionId}`,
      outputCode: "NO_SESSION",
    };
  }
  if (err instanceof SessionResolutionError || err instanceof SubscriptionUnknownError) {
    return { jsonError: err.message, textMessage: err.message, outputCode: "USAGE" };
  }
  if (err instanceof AcpxOperationalError) {
    return {
      jsonError: err.message,
      textMessage: err.message,
      outputCode: err.outputCode ?? "RUNTIME",
    };
  }
  throw err;
}

// Emit a resolution failure. The JSON shape is the documented
// `{kind:"error", error, query}`; text/quiet write the message to stderr. Throws
// with outputAlreadyEmitted so the top-level CLI handler only assigns the exit
// code (no double-emit).
function failUsage(err: unknown, format: OutputFormat, query: string | undefined): never {
  const { jsonError, textMessage, outputCode } = describeUsageError(err);

  if (format === "json") {
    const payload: { kind: "error"; error: string; query?: string } = {
      kind: "error",
      error: jsonError,
    };
    if (query !== undefined) {
      payload.query = query;
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`${textMessage}\n`);
  }

  throw new AcpxOperationalError(textMessage, {
    outputCode,
    origin: "cli",
    outputAlreadyEmitted: true,
  });
}

function readUsageFlags(command: Command): UsageFlags {
  const opts = command.optsWithGlobals() as Record<string, unknown>;
  const session = typeof opts.session === "string" ? opts.session : undefined;
  const subscription = typeof opts.subscription === "string" ? opts.subscription : undefined;
  return { session, subscription, all: opts.all === true };
}

export function assertSingleSelector(flags: UsageFlags): void {
  const selected = [
    flags.session !== undefined,
    flags.subscription !== undefined,
    flags.all === true,
  ].filter(Boolean).length;
  if (selected > 1) {
    throw new InvalidArgumentError("Use only one of --session, --subscription, or --all");
  }
}

async function handleUsage(command: Command, config: ResolvedAcpxConfig): Promise<void> {
  const flags = readUsageFlags(command);
  // Flag conflicts use the existing InvalidArgumentError idiom (→ usage error),
  // raised before the resolution try so it surfaces like every other CLI misuse.
  assertSingleSelector(flags);
  const { format } = resolveGlobalFlags(command, config);

  try {
    const result = await resolveUsage(flags, config);
    emitResult(result, format);
  } catch (err) {
    failUsage(err, format, flags.session ?? flags.subscription);
  }
}

export function registerUsageCommand(parent: Command, config: ResolvedAcpxConfig): void {
  parent
    .command("usage")
    .description(
      "Limit usage for the current or another session (claude → 5h/7d subscription; codex → ChatGPT quota)",
    )
    .option(
      "-s, --session <id|url|name>",
      "Report usage for another session (acpx id, acpx-ui URL, or exact name) instead of the current one",
    )
    .option(
      "--subscription <id>",
      "Report usage for a registered Claude subscription directly (claude only)",
    )
    .option(
      "--all",
      "Report usage for every registered Claude subscription (same view as `subscriptions usage`)",
    )
    .option("--format <fmt>", "Output format: text, json, quiet", parseOutputFormat)
    .action(async function (this: Command) {
      await handleUsage(this, config);
    });
}
