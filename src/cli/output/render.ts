import path from "node:path";
import { resolveAcpxUiBaseUrl } from "../../acp/auth-env.js";
import { consumeAutoSubscriptionSelection } from "../../runtime/engine/auto-subscription.js";
import { effectiveTemplateSlug } from "../../session/persistence/template-slug.js";
import { normalizeRuntimeSessionId } from "../../session/runtime-session-id.js";
import type { AgentSessionListResult, OutputFormat, SessionRecord } from "../../types.js";
import { probeQueueOwnerHealth } from "../queue/ipc.js";
import type { SessionCloseDrainReport } from "../session/session-control.js";
import { emitJsonResult } from "./json-output.js";

function formatSessionLabel(record: SessionRecord): string {
  return record.name ?? "cwd";
}

// The created child's own acpx-ui URL (this box's base + ?session=<id>) — so a
// spawning agent gets the child's address directly. Reuses the box-base resolver
// the rest of the CLI uses (env override → namespace-derived → devbox default).
function composeSessionUrl(record: SessionRecord): string {
  return `${resolveAcpxUiBaseUrl(process.env)}/?session=${record.acpxRecordId}`;
}

function formatRoutedFrom(sessionCwd: string, currentCwd: string): string | undefined {
  const relative = path.relative(sessionCwd, currentCwd);
  if (!relative || relative === ".") {
    return undefined;
  }
  return relative.startsWith(".") ? relative : `.${path.sep}${relative}`;
}

type SessionConnectionStatus = "connected" | "needs reconnect";

/**
 * Maps queue-owner health into the prompt banner's connection segment.
 *
 * Three-state, keyed on `hasLease` so a benign cold spawn is not reported as a
 * fault:
 * - `healthy`                  → "connected"
 * - `!healthy && hasLease`     → "needs reconnect" (genuinely wedged owner)
 * - `!healthy && !hasLease`    → null (cold spawn — no owner yet, omit segment)
 */
export function classifyConnectionStatus(health: {
  healthy: boolean;
  hasLease: boolean;
}): SessionConnectionStatus | null {
  if (health.healthy) {
    return "connected";
  }
  return health.hasLease ? "needs reconnect" : null;
}

async function resolveSessionConnectionStatus(
  record: SessionRecord,
): Promise<SessionConnectionStatus | null> {
  const health = await probeQueueOwnerHealth(record.acpxRecordId);
  return classifyConnectionStatus(health);
}

export function printSessionsByFormat(sessions: SessionRecord[], format: OutputFormat): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(sessions)}\n`);
    return;
  }

  if (format === "quiet") {
    printQuietSessions(sessions);
    return;
  }

  if (sessions.length === 0) {
    process.stdout.write("No sessions\n");
    return;
  }

  for (const session of sessions) {
    const closedMarker = session.closed ? " [closed]" : "";
    process.stdout.write(
      `${session.acpxRecordId}${closedMarker}\t${session.name ?? "-"}\t${session.cwd}\t${session.lastUsedAt}\n`,
    );
  }
}

function printQuietSessions(sessions: SessionRecord[]): void {
  for (const session of sessions) {
    const closedMarker = session.closed ? " [closed]" : "";
    process.stdout.write(`${session.acpxRecordId}${closedMarker}\n`);
  }
}

export function printAgentSessionsByFormat(
  result: AgentSessionListResult,
  format: OutputFormat,
): void {
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (format === "quiet") {
    printQuietAgentSessions(result);
    return;
  }

  printTextAgentSessions(result);
}

function printQuietAgentSessions(result: AgentSessionListResult): void {
  for (const session of result.sessions) {
    process.stdout.write(`${session.sessionId}\n`);
  }
}

function printTextAgentSessions(result: AgentSessionListResult): void {
  if (result.sessions.length === 0) {
    process.stdout.write("No sessions\n");
  } else {
    for (const session of result.sessions) {
      const title = session.title ?? "-";
      const updatedAt = session.updatedAt ?? "-";
      const meta = session._meta ? JSON.stringify(session._meta) : "-";
      process.stdout.write(
        `${session.sessionId}\t${title}\t${session.cwd}\t${updatedAt}\t${meta}\n`,
      );
    }
  }

  if (result.nextCursor) {
    process.stdout.write(`Next cursor: ${result.nextCursor}\n`);
  }
}

export function printClosedSessionByFormat(
  record: SessionRecord,
  drain: SessionCloseDrainReport,
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "session_closed",
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      // D1 (brick://53437107). `reachedOwner:false` with `attempted:true` is the
      // honest shape for an owner already gone or too old to know the verb — a
      // caller must be able to tell "nothing was in flight" from "we could not
      // ask". `turnSettled` is omitted rather than guessed when we never reached
      // the owner.
      drain: {
        attempted: drain.attempted,
        reachedOwner: drain.reachedOwner,
        ...(drain.turnSettled !== undefined ? { turnSettled: drain.turnSettled } : {}),
        undelivered: drain.undelivered,
      },
    })
  ) {
    return;
  }

  if (format === "quiet") {
    return;
  }

  process.stdout.write(`${record.acpxRecordId}\n`);
}

/**
 * The loud, greppable block a closing agent sees when it lost custody
 * (DESIGN §2.4). STDERR, always — including under `--format json`, whose consumer
 * reads stdout — because the whole defect was that this loss was SILENT.
 *
 * EVERY LINE HERE STATES ONLY WHAT acpx WITNESSED. That constraint is not
 * stylistic: this program exists because acpx-ui invented a terminal it never
 * observed and stamped it with a borrowed timestamp, and corollary C-3 requires
 * invented and witnessed outcomes to stay distinguishable forever. A warning that
 * fabricated detail would reproduce the defect inside the feature meant to fix it.
 *
 * So this block deliberately does NOT say:
 *   - WHO sent the message. That lives only in acpx-ui's delivery sidecar, which
 *     acpx has no reader for and must never learn one (KD-1).
 *   - that the sender HAS BEEN NOTIFIED. acpx cannot observe acpx-ui's downstream
 *     behaviour, and for a plain CLI `prompt` submission (DESIGN §12 E10) there is
 *     no sidecar row and so no sender to notify at all — the claim would not
 *     merely be unwitnessed, it would be false.
 *
 * What acpx does know is the part that decides what the agent does next: these
 * never reached the model, so resending is safe.
 */
export function warnUndeliveredCustody(sessionLabel: string, drain: SessionCloseDrainReport): void {
  const count = drain.undelivered.length;
  if (count === 0) {
    return;
  }
  const lines = [
    `⚠️  acpx: closed ${sessionLabel} while its queue owner still held ${count} undelivered message${
      count === 1 ? "" : "s"
    }.`,
  ];
  for (const item of drain.undelivered) {
    lines.push(`    NOT delivered: ${item.messageId ?? `(request ${item.requestId})`}`);
  }
  lines.push(
    `    ${count === 1 ? "It" : "They"} never reached the agent, so ${
      count === 1 ? "it is" : "they are"
    } safe to resend.`,
    `    acpx cannot see who sent ${count === 1 ? "it" : "them"}; ask acpx-ui for a delivery's sender and status.`,
  );
  process.stderr.write(`${lines.join("\n")}\n`);
}

export function printNewSessionByFormat(
  record: SessionRecord,
  replaced: SessionRecord | undefined,
  format: OutputFormat,
): void {
  const subscriptionSelection = consumeAutoSubscriptionSelection();
  if (
    emitJsonResult(format, {
      action: "session_ensured",
      created: true,
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      name: record.name,
      replacedSessionId: replaced?.acpxRecordId,
      sessionUrl: composeSessionUrl(record),
      ...(subscriptionSelection ? { subscriptionSelection } : {}),
    })
  ) {
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${record.acpxRecordId}\n`);
    return;
  }

  if (replaced) {
    process.stdout.write(`${record.acpxRecordId}\t(replaced ${replaced.acpxRecordId})\n`);
    return;
  }

  process.stdout.write(`${record.acpxRecordId}\n`);
}

export function printCopiedSessionByFormat(
  record: SessionRecord,
  source: SessionRecord,
  format: OutputFormat,
): void {
  const subscriptionSelection = consumeAutoSubscriptionSelection();
  if (
    emitJsonResult(format, {
      action: "session_copied",
      created: true,
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      name: record.name,
      sourceSessionId: source.acpxRecordId,
      forkedFromSessionId: record.forkedFromSessionId,
      forkedAtMessageIndex: record.forkedAtMessageIndex,
      ephemeral: record.metadata?.byway === "1",
      sessionUrl: composeSessionUrl(record),
      ...(subscriptionSelection ? { subscriptionSelection } : {}),
    })
  ) {
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${record.acpxRecordId}\n`);
    return;
  }

  process.stdout.write(`${record.acpxRecordId}\n`);
}

export function printEnsuredSessionByFormat(
  record: SessionRecord,
  created: boolean,
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "session_ensured",
      created,
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      name: record.name,
    })
  ) {
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${record.acpxRecordId}\n`);
    return;
  }

  const action = created ? "created" : "existing";
  process.stdout.write(`${record.acpxRecordId}\t(${action})\n`);
}

export function printQueuedPromptByFormat(
  result: {
    sessionId: string;
    requestId: string;
  },
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "prompt_queued",
      acpxRecordId: result.sessionId,
      requestId: result.requestId,
    })
  ) {
    return;
  }

  if (format === "quiet") {
    return;
  }

  process.stdout.write(`[queued] ${result.requestId}\n`);
}

export function formatPromptSessionBannerLine(
  record: SessionRecord,
  currentCwd: string,
  connectionStatus: SessionConnectionStatus | null = null,
): string {
  const label = formatSessionLabel(record);
  const normalizedSessionCwd = path.resolve(record.cwd);
  const normalizedCurrentCwd = path.resolve(currentCwd);
  const routedFrom =
    normalizedSessionCwd === normalizedCurrentCwd
      ? undefined
      : formatRoutedFrom(normalizedSessionCwd, normalizedCurrentCwd);

  // On a cold spawn (no queue owner yet) there is no health verdict to assert,
  // so omit the `· agent <status>` segment entirely — the banner is pure identity.
  const agentSuffix = connectionStatus === null ? "" : ` · agent ${connectionStatus}`;

  if (routedFrom) {
    return `[acpx] session ${label} (${record.acpxRecordId}) · ${normalizedSessionCwd} (routed from ${routedFrom})${agentSuffix}`;
  }

  return `[acpx] session ${label} (${record.acpxRecordId}) · ${normalizedSessionCwd}${agentSuffix}`;
}

export async function printPromptSessionBanner(
  record: SessionRecord,
  currentCwd: string,
  format: OutputFormat,
  jsonStrict = false,
): Promise<void> {
  if (format === "quiet" || (jsonStrict && format === "json")) {
    return;
  }

  const status = await resolveSessionConnectionStatus(record);
  process.stderr.write(`${formatPromptSessionBannerLine(record, currentCwd, status)}\n`);
}

export function printCreatedSessionBanner(
  record: SessionRecord,
  agentName: string,
  format: OutputFormat,
  jsonStrict = false,
): void {
  if (format === "quiet" || (jsonStrict && format === "json")) {
    return;
  }

  const label = formatSessionLabel(record);
  process.stderr.write(`[acpx] created session ${label} (${record.acpxRecordId})\n`);
  process.stderr.write(`[acpx] agent: ${agentName}\n`);
  process.stderr.write(`[acpx] cwd: ${record.cwd}\n`);
  process.stderr.write(`[acpx] url: ${composeSessionUrl(record)}\n`);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) {
    return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  }
  if (bytes >= 1_048_576) {
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

type PruneRenderResult = {
  pruned: SessionRecord[];
  skippedTemplates: SessionRecord[];
  bytesFreed: number;
  dryRun: boolean;
  strandedStreamFiles: number;
  strandedStreamBytes: number;
};

/** Only the applied keys are present. An object rather than an enum string so a
 *  combination needs no new vocabulary and a future selector is purely additive.
 *  `wholeBox` (not `all`) so a JSON-log sweep carries the same distinctive audit
 *  token as the command line. */
export type PruneScope = {
  wholeBox?: boolean;
  sessionIds?: string[];
  cwd?: string;
  olderThanDays?: number;
  before?: string;
};

/**
 * ⚠️ This text is the CONTROL SURFACE, not a diagnostic. An agent pastes and
 * retries whatever an error suggests, so whatever these lines suggest is what
 * gets run next — a drifted suggestion becomes the new invocation pattern.
 *
 * DO NOT paraphrase, re-flow or "improve" the strings below, and in particular
 * DO NOT move `--whole-box` into the four-command copy-paste block: a refusal
 * whose remedy is the override has built a one-line bypass and is worse than no
 * refusal. Every clause here is pinned by a literal assertion in
 * test/sessions-prune-scope.test.ts (E2 (i)–(iv), the token rule); prose is not
 * type-checked, which is exactly why those tests exist.
 */
export type PruneRefusal =
  | {
      reason: "scope_required";
      agentName: string;
      cwd: string;
      closedCandidates: number;
      closedCandidatesInCwd: number;
    }
  | { reason: "scope_conflict"; agentName: string }
  | { reason: "session_not_found"; agentName: string; sessionId: string }
  | {
      reason: "session_ambiguous";
      agentName: string;
      sessionId: string;
      matches: { acpxRecordId: string; name?: string; lastUsedAt: string }[];
    }
  | { reason: "session_open"; agentName: string; sessionId: string };

/** The scopes the refusal names, echoed into JSON so a machine consumer sees the
 *  same menu the text does. */
const PRUNE_SCOPE_NAMES = ["<ids>", "--cwd", "--whole-box", "--older-than", "--before"];

export function printPruneRefusalByFormat(refusal: PruneRefusal, format: OutputFormat): void {
  if (emitJsonResult(format, pruneRefusalJsonPayload(refusal))) {
    return;
  }
  // stderr under `quiet` too, deliberately: a quiet consumer parses pruned ids
  // off stdout and must never be handed prose there.
  process.stderr.write(renderPruneRefusalText(refusal));
}

function pruneRefusalJsonPayload(refusal: PruneRefusal): Record<string, unknown> {
  const base = { action: "sessions_prune_refused", ...refusal };
  if (refusal.reason === "scope_required") {
    return { ...base, scopes: PRUNE_SCOPE_NAMES };
  }
  if (refusal.reason === "session_ambiguous") {
    return { ...base, matches: refusal.matches.map((match) => match.acpxRecordId) };
  }
  return base;
}

function renderPruneRefusalText(refusal: PruneRefusal): string {
  const agent = refusal.agentName;
  if (refusal.reason === "scope_required") {
    return renderScopeRequiredText(
      refusal.agentName,
      refusal.cwd,
      refusal.closedCandidates,
      refusal.closedCandidatesInCwd,
    );
  }
  if (refusal.reason === "scope_conflict") {
    return (
      "acpx sessions prune: --whole-box cannot be combined with session ids or --cwd — nothing was deleted.\n" +
      "prune --whole-box means the whole box; ids and --cwd mean a specific set. Pick one.\n"
    );
  }
  if (refusal.reason === "session_open") {
    // ⚠️ The command on line 2 must be RUNNABLE, and the trailing comment is
    // load-bearing rather than decoration.
    //
    // The old wording said "close it first, then prune" and the naive paste —
    // `sessions close <id>` — FAILS: that positional is a NAME
    // (command-registration.ts:261) and `--session-id <id>` is what takes an id
    // (flags.ts:539-542). An agent pastes and retries whatever an error
    // suggests, so advice that parses and fails becomes the next invocation.
    //
    // `# then re-run prune` is what lets a `sessions close` line satisfy prune's
    // token rule (dd4cb0e8 §3.3) — a status line is also "what to run instead",
    // and this remedy necessarily names a different verb. It is also the second
    // step the operator actually needs. Dropping it breaks the rule without
    // breaking a compile; T-S2 is what catches that.
    //
    // Pinned by EXECUTION, not inspection, in test/sessions-prune-scope.test.ts
    // (T-S1): the printed command is run verbatim as a subprocess. A check that
    // reads the string rather than running it passes on the very defect this
    // fixes.
    return (
      `acpx sessions prune: '${refusal.sessionId}' is still open — nothing was deleted. Close it, then re-run prune:\n` +
      `  acpx ${agent} sessions close --session-id ${refusal.sessionId}   # then re-run prune\n`
    );
  }
  if (refusal.reason === "session_ambiguous") {
    const count = refusal.matches.length;
    // The match lines are DATA and exempt from the token rule — which is exactly
    // why the line above states the count and the line below states the remedy:
    // an operator whose pipe eats the list still learns how many there were and
    // what to do next.
    const header = `acpx sessions prune: '${refusal.sessionId}' is ambiguous — ${count} closed session${count === 1 ? "" : "s"} match, so prune deleted nothing.\n`;
    const rows = refusal.matches
      .map(
        (match) =>
          `  ${match.acpxRecordId}${match.name ? ` (${match.name})` : ""}\t${match.lastUsedAt}\n`,
      )
      .join("");
    return `${header}${rows}Re-run prune with a longer suffix or the full id.\n`;
  }
  return `acpx sessions prune: no closed ${agent} session matches '${refusal.sessionId}' — nothing was deleted.\n`;
}

function renderScopeRequiredText(
  agent: string,
  cwd: string,
  candidates: number,
  candidatesInCwd: number,
): string {
  // "considers", never "deletes": both counts come off index entries only, so
  // they are an upper bound (the template skip needs fully-loaded records, and
  // this path deliberately loads none of them).
  const cwdComment =
    candidatesInCwd === 0
      ? `# no closed sessions here (${cwd})`
      : `# the ${candidatesInCwd} closed in ${cwd}`;
  return (
    `acpx sessions prune: refusing to run unscoped — nothing was deleted.\n` +
    `\n` +
    `Unscoped, prune considers ALL ${candidates} closed ${agent} sessions on this box, not just this\n` +
    `directory's — and each pruned session loses its record AND its messages sidecar, so\n` +
    `that transcript can never be rebuilt. prune needs a scope; copy one of these:\n` +
    `\n` +
    `  acpx ${agent} sessions prune <id> [<id>...]    # just the ones you name — the usual case\n` +
    `  acpx ${agent} sessions prune --cwd             ${cwdComment}\n` +
    `  acpx ${agent} sessions prune --older-than 30   # retention sweep by age\n` +
    `  acpx ${agent} sessions prune --dry-run         # preview everything (no scope needed)\n` +
    `\n` +
    `prune --whole-box is every closed ${agent} session on this box (${candidates}) — only if you mean it.\n`
  );
}

/** The blast radius, printed BEFORE the first unlink. Text format only — a JSON
 *  or quiet consumer gets the same facts in the result payload, and prose on
 *  their stdout would break the parse. */
export function printPrunePlan(
  plan: {
    count: number;
    agentName: string;
    scope: PruneScope;
    strandedStreamFiles: number;
    strandedStreamBytes: number;
  },
  format: OutputFormat,
): void {
  if (format !== "text" || plan.count === 0) {
    return;
  }
  process.stdout.write(`${formatPrunePlanLine(plan.count, plan.agentName, plan.scope)}\n`);
  if (plan.strandedStreamFiles > 0) {
    const files = `${plan.strandedStreamFiles} stream file${plan.strandedStreamFiles === 1 ? "" : "s"}`;
    // Both physical lines carry the token: a wrapped line is two lines to a
    // filter, so a message whose token sits only on line 1 delivers a headless
    // fragment to the operator's pipe.
    process.stdout.write(
      `  note: prune leaves ${files} (${formatBytes(plan.strandedStreamBytes)}) behind, unreachable — no later prune\n` +
        `        can reclaim them. Add --include-history so prune removes them too.\n`,
    );
  }
}

function formatPrunePlanLine(count: number, agent: string, scope: PruneScope): string {
  const noun = `session${count === 1 ? "" : "s"}`;
  // "named" is claimed ONLY when ids are the only selector. `ids + --cwd` is a
  // UNION (repository.ts:1454-1478), so the old `scope.sessionIds ? …` printed
  // "4 named … sessions in <dir>" when exactly 1 was named — overstating, on the
  // line that precedes an irreversible act, how much of the set the operator
  // actually spelled out. The count itself was and stays exact.
  const namedOnly = scope.sessionIds != null && scope.cwd == null;
  const head = scope.wholeBox
    ? `ALL ${count} closed ${agent} ${noun}`
    : `${count} ${namedOnly ? "named" : "closed"} ${agent} ${noun}`;
  const clauses = prunePlanScopeClauses(scope);
  const tail = clauses.length > 0 ? ` ${clauses.join(" ")}` : "";
  // The --whole-box line echoes the literal flag token so the box-wide sweep
  // leaves a greppable trace even when the command line was built by variable
  // interpolation (E3).
  const parenthetical = scope.wholeBox
    ? "(--whole-box; record + messages sidecar each)"
    : "(record + messages sidecar each)";
  return `Will prune ${head}${tail} ${parenthetical}.`;
}

/** Clause order is fixed: `named` (in the head) → `in <dir>` → age → `on this box`. */
function prunePlanScopeClauses(scope: PruneScope): string[] {
  const clauses: string[] = [];
  if (scope.cwd != null) {
    clauses.push(`in ${scope.cwd}`);
  }
  if (scope.olderThanDays != null) {
    clauses.push(`older than ${scope.olderThanDays} day${scope.olderThanDays === 1 ? "" : "s"}`);
  } else if (scope.before != null) {
    clauses.push(`closed before ${scope.before}`);
  }
  if (scope.wholeBox) {
    clauses.push("on this box");
  }
  return clauses;
}

export function printPruneResultByFormat(
  result: PruneRenderResult,
  format: OutputFormat,
  scope: PruneScope,
): void {
  const count = result.pruned.length;

  if (emitPruneJsonResult(result, format, count, scope)) {
    return;
  }

  if (format === "quiet") {
    printQuietPruneResult(result.pruned);
    return;
  }

  // Before the summary, not after: a run that prunes nothing still has to say it
  // protected a blueprint, and "No sessions pruned" is otherwise the last word.
  printSkippedTemplates(result.skippedTemplates);

  if (count === 0) {
    process.stdout.write(
      result.dryRun ? "[DRY RUN] No sessions to prune\n" : "No sessions pruned\n",
    );
    return;
  }

  process.stdout.write(`${formatPruneSummaryLine(result, count)}\n`);

  for (const record of result.pruned) {
    const label = record.name ? ` (${record.name})` : "";
    process.stdout.write(
      `  ${record.acpxRecordId}${label}\t${record.closedAt ?? record.lastUsedAt}\n`,
    );
  }
}

/**
 * ⚠️ The JSON surface is a CONTRACT and contracts do not move under their
 * consumers. `action`, `dryRun`, `count`, `bytesFreed`, `pruned` and
 * `skippedTemplates` (shape `{acpxRecordId, slug}`, landed with brick a62de399)
 * keep their exact names, types and meanings. `scope`, `strandedStreamFiles`
 * and `strandedStreamBytes` are ADDITIVE, alongside.
 *
 * The division to hold for the whole verb: TEXT is for humans and pipes, so it
 * is free to evolve and the token rule governs it; JSON is for scripts, so it
 * does not move. In particular the token rule does NOT reach in here — do not
 * "make skippedTemplates consistent" with the text line.
 */
function emitPruneJsonResult(
  result: PruneRenderResult,
  format: OutputFormat,
  count: number,
  scope: PruneScope,
): boolean {
  return emitJsonResult(format, {
    action: result.dryRun ? "sessions_prune_dry_run" : "sessions_pruned",
    dryRun: result.dryRun,
    count,
    bytesFreed: result.bytesFreed,
    pruned: result.pruned.map((r) => r.acpxRecordId),
    skippedTemplates: result.skippedTemplates.map((r) => ({
      acpxRecordId: r.acpxRecordId,
      slug: templateSkipSlug(r),
    })),
    scope,
    strandedStreamFiles: result.strandedStreamFiles,
    strandedStreamBytes: result.strandedStreamBytes,
  });
}

/** Same read-side derivation the template resolver uses, so the skip line names
 *  the slug a `--from-template` call would actually have asked for. */
function templateSkipSlug(record: SessionRecord): string {
  return effectiveTemplateSlug(record.template?.slug, record.name) ?? record.acpxRecordId;
}

/**
 * ⚠️ The leading `prune ` is load-bearing, not decoration — the token rule (§3.3).
 * This line's job is to tell the operator a blueprint was PROTECTED, and it is read
 * through pipelines like the one in the 2026-07-24 incident,
 * `… 2>&1 | grep -iE "prune|delet|remov|…" | head`. Without the token the line is
 * dropped and the protection is invisible at exactly the moment it mattered.
 * PREFIXED rather than appended so the token leads and survives a truncating
 * filter. Pinned line-anchored in test/cli.test.ts and
 * test/sessions-prune-scope.test.ts.
 */
function printSkippedTemplates(skippedTemplates: SessionRecord[]): void {
  for (const record of skippedTemplates) {
    process.stdout.write(
      `  prune skipped ${record.acpxRecordId} — template '${templateSkipSlug(record)}'\n`,
    );
  }
}

function printQuietPruneResult(pruned: SessionRecord[]): void {
  for (const record of pruned) {
    process.stdout.write(`${record.acpxRecordId}\n`);
  }
}

function formatPruneSummaryLine(
  result: { bytesFreed: number; dryRun: boolean },
  count: number,
): string {
  const prefix = result.dryRun ? "[DRY RUN] Would prune" : "Pruned";
  const bytesSuffix =
    !result.dryRun && result.bytesFreed > 0 ? `, freed ${formatBytes(result.bytesFreed)}` : "";
  return `${prefix} ${count} session${count === 1 ? "" : "s"}${bytesSuffix}`;
}

export function agentSessionIdPayload(agentSessionId: string | undefined): {
  agentSessionId?: string;
} {
  const normalized = normalizeRuntimeSessionId(agentSessionId);
  if (!normalized) {
    return {};
  }

  return { agentSessionId: normalized };
}
