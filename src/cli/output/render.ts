import path from "node:path";
import { resolveAcpxUiBaseUrl } from "../../acp/auth-env.js";
import { consumeAutoSubscriptionSelection } from "../../runtime/engine/auto-subscription.js";
import { normalizeRuntimeSessionId } from "../../session/runtime-session-id.js";
import type { AgentSessionListResult, OutputFormat, SessionRecord } from "../../types.js";
import { probeQueueOwnerHealth } from "../queue/ipc.js";
import type {
  SessionCloseDrainReport,
  SessionCloseRecordState,
} from "../session/session-control.js";
import { emitJsonResult } from "./json-output.js";

// The created child's own acpx-ui URL (this box's base + ?session=<id>) — so a
// spawning agent gets the child's address directly. Reuses the box-base resolver
// the rest of the CLI uses (env override → PID-1 env → hostmap cache). UNDEFINED
// when this box's host is unknown: printing `undefined/?session=…` would be a
// fabricated address, and a missing one is the honest answer (the resolver has
// already warned, naming the knob to set).
function composeSessionUrl(record: SessionRecord): string | undefined {
  return composeSessionUrlForId(record.acpxRecordId);
}

function composeSessionUrlForId(acpxRecordId: string): string | undefined {
  const base = resolveAcpxUiBaseUrl(process.env);
  return base ? `${base}/?session=${acpxRecordId}` : undefined;
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

/**
 * `sessions list` TEXT rows: `<id>[ [closed]]\t<cwd>\t<lastUsedAt>[\tseat <seat8> <name>]`.
 * The seat column (hole #7) is APPENDED so the existing positional columns keep their
 * places for any `cut -f` reader; it appears when the caller supplies `seatLabel`.
 */
export function printSessionsByFormat(
  sessions: SessionRecord[],
  format: OutputFormat,
  seatLabel?: (session: SessionRecord) => string,
): void {
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
    const seatColumn = seatLabel ? `\t${seatLabel(session)}` : "";
    process.stdout.write(
      `${session.acpxRecordId}${closedMarker}\t${session.cwd}\t${session.lastUsedAt}${seatColumn}\n`,
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

// brick 1bfb95ed deliverable 4: the printed outcome of a close must be what
// `sessions close` RE-READ off `<id>.json` after writing, never its own write
// call's exit status — the gap that let an operator trust a close which had,
// elsewhere and later, silently reverted. `null` means the key was ABSENT on
// disk, distinct from a present `false` (see `RawRecordFieldState`); a
// non-boolean raw value prints as-is, which is itself a finding.
function recordClosedStateForJson(state: SessionCloseRecordState): Record<string, unknown> {
  if (state.status === "read_failed") {
    return { recordReadBackFailed: true, recordReadBackError: state.error };
  }
  return {
    recordClosed: state.closed.present ? state.closed.value : null,
    recordClosedAt: state.closedAt.present ? state.closedAt.value : null,
  };
}

function formatRawFieldForText(field: { present: boolean; value?: unknown }): string {
  return field.present ? String(field.value) : "(absent)";
}

export function printClosedSessionByFormat(
  record: SessionRecord,
  drain: SessionCloseDrainReport,
  recordClosedState: SessionCloseRecordState,
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
      ...recordClosedStateForJson(recordClosedState),
    })
  ) {
    return;
  }

  if (format === "quiet") {
    return;
  }

  process.stdout.write(`${record.acpxRecordId}\n`);
  if (recordClosedState.status === "read_failed") {
    process.stderr.write(
      `[acpx] closed ${record.acpxRecordId}, but could not read the record back to verify: ${recordClosedState.error}\n`,
    );
    return;
  }
  process.stdout.write(
    `closed: ${formatRawFieldForText(recordClosedState.closed)} (read back from record)\n`,
  );
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

// Brick 9956d212 (3) — the seat id is what the operator must hand `sessions activate`; it was
// reachable only through a follow-up `sessions show`. A record with no `seatId` (pre-Seat) is
// its own seat and has nothing to name here.
function resolveSeatUrl(seatId: string | undefined): string | undefined {
  const base = seatId ? resolveAcpxUiBaseUrl(process.env) : undefined;
  return base ? `${base}/?seat=${seatId}` : undefined;
}

function newSessionSeatJson(record: SessionRecord, seatUrl: string | undefined) {
  if (!record.seatId) {
    return {};
  }
  return {
    seatId: record.seatId,
    holderActive: record.holderActive === true,
    ...(seatUrl ? { seatUrl } : {}),
  };
}

// STDERR, after the banner (which names the seat — `printCreatedSessionBanner`): stdout stays
// the bare record id, which `ID=$(acpx sessions new)` consumers capture.
function printNewSessionSeatLines(record: SessionRecord): void {
  const seatId = record.seatId;
  if (!seatId) {
    return;
  }
  if (record.holderActive === false) {
    process.stderr.write(
      `prepared into seat ${seatId} — NOT active; activate with: ` +
        `acpx sessions activate ${seatId} ${record.acpxRecordId}\n`,
    );
  }
}

// L3 (brick 4e58b35c) — `sessions new` no longer evicts the occupant of an
// already-occupied (cwd, name) slot (command-handlers.ts, handleSessionsNew),
// so there is never anything to report as replaced. `replacedSessionId` is
// deleted from the result shape outright rather than left always-undefined:
// a census across acpx (src + test), acpx-ui (origin/dev, origin/master), and
// the wisdom Skills scripts found no code consumer of this field (the sole
// hit was a now-corrected doc line in Skills/acpx/SKILL.md describing the
// deleted eviction as expected behaviour).
export function printNewSessionByFormat(record: SessionRecord, format: OutputFormat): void {
  const subscriptionSelection = consumeAutoSubscriptionSelection();
  const seatUrl = resolveSeatUrl(record.seatId);
  if (
    emitJsonResult(format, {
      action: "session_ensured",
      created: true,
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      sessionUrl: composeSessionUrl(record),
      ...newSessionSeatJson(record, seatUrl),
      ...(subscriptionSelection ? { subscriptionSelection } : {}),
    })
  ) {
    return;
  }

  process.stdout.write(`${record.acpxRecordId}\n`);
  if (format !== "quiet") {
    printNewSessionSeatLines(record);
  }
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
      sourceSessionId: source.acpxRecordId,
      forkedFromSessionId: record.forkedFromSessionId,
      // EFFECTIVE index. `forkedAtMessageIndexRequested` rides beside it only on
      // a mismatch, so a consumer that reads one field is already correct and a
      // consumer that reads both learns the fork moved.
      forkedAtMessageIndex: record.forkedAtMessageIndex,
      ...(record.forkedAtMessageIndexRequested === undefined
        ? {}
        : { forkedAtMessageIndexRequested: record.forkedAtMessageIndexRequested }),
      ephemeral: record.metadata?.byway === "1",
      sessionUrl: composeSessionUrl(record),
      // F6 — a copy/fork mints a NEW seat; its address is that seat, not the source's.
      ...newSessionSeatJson(record, resolveSeatUrl(record.seatId)),
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
  // ⚠️ THE CLI MUST SAY WHERE THE FORK ACTUALLY LANDED. Recording the effective
  // index without printing it leaves the user reading the number they typed
  // (WS-core's acceptance condition on 276594c2: the honesty is end-to-end, not
  // merely declared in the descriptor). Only on a mismatch — a fork that landed
  // where it was asked to has nothing to report.
  if (record.forkedAtMessageIndexRequested !== undefined) {
    process.stderr.write(
      `[acpx] fork landed at message ${record.forkedAtMessageIndex}, not the requested ` +
        `${record.forkedAtMessageIndexRequested}: this agent truncates at turn boundaries, ` +
        `so the request was snapped down to the nearest one.\n`,
    );
  }
}

// brick://16712ece — `sessions reopen`. `reopened:false` is the idempotent
// "already open" outcome, not a failure, and must stay distinguishable from a
// real revive so a script can tell whether it changed anything.
export function printReopenedSessionByFormat(
  record: SessionRecord,
  reopened: boolean,
  format: OutputFormat,
): void {
  if (
    emitJsonResult(format, {
      action: "session_reopened",
      reopened,
      acpxRecordId: record.acpxRecordId,
      acpxSessionId: record.acpSessionId,
      agentSessionId: record.agentSessionId,
      closed: record.closed === true,
    })
  ) {
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${record.acpxRecordId}\n`);
    return;
  }

  const action = reopened ? "reopened" : "already open";
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
    return `[acpx] session ${record.acpxRecordId} · ${normalizedSessionCwd} (routed from ${routedFrom})${agentSuffix}`;
  }

  return `[acpx] session ${record.acpxRecordId} · ${normalizedSessionCwd}${agentSuffix}`;
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

/**
 * brick://c327efb5 — SURFACE a served-vs-pinned model mismatch at the point of use.
 *
 * The detection half already worked: `enforceModelFloorPostServe` evaluates every
 * turn and persists `acpx.served_below_floor` on the record. What was missing is
 * this line. The only other surfaces were `.messages.ndjson` (acpx-ui / the parent
 * agent) and a `logFloor` stderr write gated on `--verbose` — and that one is
 * written by the QUEUE OWNER process, so it never reaches the user's terminal even
 * with the flag. Net effect: a user asked for model X, was served model Y, and read
 * `[done] end_turn` + exit 0 with nothing to indicate it.
 *
 * ⚠️ DO NOT gate this on `--verbose`. "Only visible if you already suspected it"
 * is precisely the silence this exists to remove; a wrong-model answer must be
 * visible to a user who had no reason to look.
 *
 * Deliberately NOT debounced per below-floor episode, unlike the `.messages.ndjson`
 * mirror. That mirror is read once per session by a parent agent, so debouncing it
 * avoids repetition; this line is read by whoever ran THIS command. Debouncing
 * across turns would mean the user whose turn happens to be the second of an
 * episode sees nothing — the exact failure being fixed.
 *
 * Cannot fire on ordinary alias resolution (pin `opus` served `claude-opus-5`) or
 * on an unreadable served model: `evaluateModelFloor` classifies those `at-floor`
 * and `unknown`, and only a `below-floor` verdict stamps the breadcrumb this reads.
 * A breadcrumb still present means the below-floor episode is still open — it is
 * auto-cleared by the next at-floor serve.
 */
/**
 * Whether human-facing `[acpx] …` stderr notices are suppressed for this output
 * policy: `quiet` prints nothing, and STRICT json must not interleave non-JSON.
 * Plain `--format json` still gets them — they go to stderr, so stdout stays
 * machine-parseable either way.
 *
 * The same rule is inlined in `printPromptSessionBanner` /
 * `printCreatedSessionBanner` above; those are left as they are rather than
 * refactored in on this brick's diff. Keep all three in agreement.
 */
function stderrNoticesSuppressed(format: OutputFormat, jsonStrict: boolean): boolean {
  return format === "quiet" || (jsonStrict && format === "json");
}

/** ` (effort max→high)` when the dip also authored effort down; empty otherwise. */
function formatFloorEffortNote(pinned: string | undefined, served: string | undefined): string {
  if (!pinned || !served || pinned === served) {
    return "";
  }
  return ` (effort ${pinned}→${served})`;
}

export function printServedBelowFloorWarning(
  record: SessionRecord,
  format: OutputFormat,
  jsonStrict = false,
): void {
  if (stderrNoticesSuppressed(format, jsonStrict)) {
    return;
  }

  const below = record.acpx?.served_below_floor;
  if (!below?.pinned_model) {
    return;
  }

  const served = below.served_model ?? "unknown";
  const effortNote = formatFloorEffortNote(below.pinned_effort, below.served_effort);
  process.stderr.write(
    `[acpx] ⚠ served-model mismatch: this turn was served "${served}" but the session is ` +
      `pinned to "${below.pinned_model}"${effortNote}. The answer above came from ${served}. ` +
      `Re-pin with \`acpx claude set model ${below.pinned_model} --session-id ${record.acpxRecordId}\`, ` +
      `or use --floor-hard to refuse a mismatched turn instead of accepting it.\n`,
  );
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

  // SEAT FIRST (hole #5): the seat is the address to hand out — it survives a handover; the
  // session lines below name this one holder.
  if (record.seatId) {
    const seatUrl = resolveSeatUrl(record.seatId);
    if (seatUrl) {
      process.stderr.write(`[acpx] seat url: ${seatUrl}\n`);
    }
    process.stderr.write(`[acpx] seat: ${record.seatId}\n`);
  }
  process.stderr.write(`[acpx] created session ${record.acpxRecordId}\n`);
  process.stderr.write(`[acpx] agent: ${agentName}\n`);
  process.stderr.write(`[acpx] cwd: ${record.cwd}\n`);
  const url = composeSessionUrl(record);
  if (url) {
    process.stderr.write(`[acpx] url: ${url}\n`);
  }
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
  auditEntries: number;
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
      matches: { acpxRecordId: string; lastUsedAt: string }[];
    }
  | { reason: "session_open"; agentName: string; sessionId: string }
  | {
      reason: "audit_write_failed";
      agentName: string;
      manifestPath: string;
      cause: string;
      /** The errno-specific recovery sentence, from `manifestFailureRemedy`.
       *  Carried on the refusal rather than rebuilt here so the prune and
       *  rollback verbs render identical advice for an identical fault. */
      remedy: string;
    };

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
  if (refusal.reason === "audit_write_failed") {
    // Five status lines, every one carrying the token, bracketing one `cause:`
    // data line.
    //
    // ⚠️ THE LAST LINE IS LOAD-BEARING, NOT COSMETIC. Aborting the prune is only
    // humane if the operator has a way out, so the remedy has to be advice that
    // ACTUALLY RECOVERS THEM. It used to be hard-coded ENOSPC advice ("free a
    // few bytes") for every failure; a test-engineer executed that from the
    // refused state and measured rc=1 with nothing recovered. It now branches on
    // the real errno via `manifestFailureRemedy`, shared with the rollback path
    // so the two verbs cannot disagree about the same fault, and it is tested BY
    // EXECUTION rather than by inspection. Abort stands; only the remedy changed.
    //
    // Why this refusal exists at all: the write is an APPEND, so it usually
    // succeeds even with zero free blocks (it lands inside the last allocated
    // one). The alternative to refusing is that on the box's unhealthiest day
    // prune silently destroys sessions with no record of what it took — the
    // exact incident this whole change exists to prevent, under a new trigger.
    return (
      `acpx sessions prune: could not record this deletion — nothing was pruned.\n` +
      `prune writes one line per deleted session to ${refusal.manifestPath}\n` +
      `before deleting anything, so a prune that cannot be recorded does not run.\n` +
      `  cause: ${refusal.cause}\n` +
      `${refusal.remedy}\n`
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
      .map((match) => `  ${match.acpxRecordId}\t${match.lastUsedAt}\n`)
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
    includeHistory: boolean;
  },
  format: OutputFormat,
): void {
  if (format !== "text" || plan.count === 0) {
    return;
  }
  process.stdout.write(
    `${formatPrunePlanLine(plan.count, plan.agentName, plan.scope, plan.includeHistory)}\n`,
  );
  if (plan.strandedStreamFiles > 0) {
    process.stdout.write(
      formatStrandedStreamNote(plan.strandedStreamFiles, plan.strandedStreamBytes),
    );
  }
}

/**
 * The stranding note, rendered by ONE function for BOTH call sites — the
 * pre-flight (real run) and the dry-run result block. Two copies of this text
 * would drift, and the two renderings would then disagree about what a preview
 * is previewing. M-D2 changes one call site and must red both tests.
 *
 * The wording INVERTS from what shipped, because the meaning inverted: this is
 * no longer a warning that the default is stranding, it is a confirmation of a
 * deliberate `--no-include-history`.
 *
 * ⚠️ Both physical lines carry the `prune` token. A wrapped line is TWO lines to
 * a filter, so a message whose token sits only on line 1 delivers a headless
 * fragment into the operator's pipe.
 */
export function formatStrandedStreamNote(files: number, bytes: number): string {
  const noun = `${files} stream file${files === 1 ? "" : "s"}`;
  return (
    `  note: prune is keeping ${noun} (${formatBytes(bytes)}) — you passed --no-include-history, so\n` +
    `        prune leaves them unreachable and no later prune can reclaim them.\n`
  );
}

function formatPrunePlanLine(
  count: number,
  agent: string,
  scope: PruneScope,
  includeHistory: boolean,
): string {
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
  //
  // The parenthetical names what is actually DESTROYED, and it changes with the
  // history tier — the number that belongs at a destructive decision point is
  // WHAT will be destroyed, not how much space it frees. (No byte total here
  // deliberately: totalling stream bytes would need a `stat` per stream file on
  // the destructive path, re-importing the cost the stream index exists to
  // remove. The summary line afterwards already reports `freed X`.)
  const contents = includeHistory
    ? "record + messages sidecar + event stream each"
    : "record + messages sidecar each; event streams kept";
  const parenthetical = scope.wholeBox ? `(--whole-box; ${contents})` : `(${contents})`;
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
  printPrunedRecordLines(result.pruned);
  printDryRunStrandingNote(result);
}

function printPrunedRecordLines(pruned: SessionRecord[]): void {
  for (const record of pruned) {
    process.stdout.write(`  ${record.acpxRecordId}\t${record.closedAt ?? record.lastUsedAt}\n`);
  }
}

/**
 * e6f0ff53 finding 1. A text `--dry-run` used to print ZERO stranding lines
 * while JSON reported them, because `printPrunePlan` is suppressed entirely on
 * dry runs — so the operator deciding whether to run the real thing was the one
 * person shown none of what it would strand.
 *
 * ⚠️ AFTER the listing, not before, and that is deliberate. On a real run the
 * note must precede the irreversible act; on a preview nothing is irreversible,
 * and placing it last makes it the REMEDY LINE BELOW THE DATA BLOCK — the
 * structure the token rule requires (a data block introduced by a surviving
 * count line and followed by a surviving remedy line). Above the
 * `[DRY RUN] Would prune N` line it would state a consequence ahead of its
 * count. T-D1 pins the ordering, not just the presence.
 */
function printDryRunStrandingNote(result: PruneRenderResult): void {
  if (result.dryRun && result.strandedStreamFiles > 0) {
    process.stdout.write(
      formatStrandedStreamNote(result.strandedStreamFiles, result.strandedStreamBytes),
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
    // Additive. The machine half of the same disclosure the text path gets: it
    // lets a scripted consumer assert the audit actually happened, rather than
    // trusting that it did. 0 on a dry run.
    auditEntries: result.auditEntries,
  });
}

/** The slug a `--from-template` call would actually have asked for (the stored
 *  slug; a slug-less template resolves by id). */
function templateSkipSlug(record: SessionRecord): string {
  return record.template?.slug ?? record.acpxRecordId;
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
