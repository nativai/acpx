import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { Command } from "commander";
import { harnessIdForAgentCommand } from "../acp/harness-capabilities.js";
import {
  findProfile,
  isSubscriptionProfileLocked,
  loadProfileRegistry,
} from "../config/profiles.js";
import {
  findSubscription,
  isSubscriptionLocked,
  loadSubscriptionRegistry,
} from "../config/subscriptions.js";
import {
  evaluateModelFloor,
  type ModelFloorEvaluation,
  pinnedEffortFloor,
  pinnedModelFloor,
} from "../session/model-floor.js";
import { resolveSessionModelLadder } from "../session/model-ladder.js";
import { outputStyleChangePending } from "../session/output-style.js";
import { findSession, resolveGlobalSessionByName } from "../session/persistence.js";
import type { SessionAcpxState, SessionRecord } from "../types.js";
import type { ResolvedAcpxConfig } from "./config.js";
import {
  addSessionNameOption,
  resolveAgentInvocation,
  resolveGlobalFlags,
  type StatusFlags,
} from "./flags.js";
import { emitJsonResult } from "./output/json-output.js";
import { agentSessionIdPayload } from "./output/render.js";
import { probeQueueOwnerHealth } from "./queue/ipc.js";
import { resolveExplicitSessionRecord, resolveSessionTargetSelector } from "./session-selector.js";

type SessionStatusState = "running" | "idle" | "dead";

function formatUptime(startedAt: string | undefined): string | undefined {
  if (!startedAt) {
    return undefined;
  }

  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) {
    return undefined;
  }

  const elapsedMs = Math.max(0, Date.now() - startedMs);
  const seconds = Math.floor(elapsedMs / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remSeconds = seconds % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${remSeconds.toString().padStart(2, "0")}`;
}

function resolveStatusState(
  record: { lastAgentExitCode?: number | null; lastAgentExitSignal?: NodeJS.Signals | null },
  health: Awaited<ReturnType<typeof probeQueueOwnerHealth>>,
): SessionStatusState {
  if (health.healthy) {
    return "running";
  }

  if (health.hasLease) {
    return "dead";
  }

  if (record.lastAgentExitSignal || (record.lastAgentExitCode ?? 0) !== 0) {
    return "dead";
  }

  return "idle";
}

function statusSummary(state: SessionStatusState): string {
  switch (state) {
    case "running":
      return "queue owner healthy";
    case "idle":
      return "session idle; queue owner will start on next prompt";
    case "dead":
      return "queue owner unavailable";
  }
  return "queue owner unavailable";
}

export async function handleStatus(
  explicitAgentName: string | undefined,
  flags: StatusFlags,
  command: Command,
  config: ResolvedAcpxConfig,
): Promise<void> {
  const globalFlags = resolveGlobalFlags(command, config);
  const agent = resolveAgentInvocation(explicitAgentName, globalFlags, config);
  const selector = resolveSessionTargetSelector({ flags, command });
  const explicitRecord = await resolveExplicitSessionRecord(selector);
  const localRecord =
    explicitRecord ??
    (await findSession({
      agentCommand: agent.agentCommand,
      agentName: agent.agentName,
      cwd: agent.cwd,
      name: selector.name,
    }));
  const record =
    localRecord ??
    (selector.name === undefined
      ? undefined
      : await resolveGlobalSessionByName({
          agentCommand: agent.agentCommand,
          agentName: agent.agentName,
          name: selector.name,
        }));

  if (!record) {
    printMissingStatus(globalFlags.format, agent.agentCommand);
    return;
  }

  await printSessionStatus(record, globalFlags.format);
}

function printMissingStatus(format: ResolvedAcpxConfig["format"], agentCommand: string): void {
  if (
    emitJsonResult(format, {
      action: "status_snapshot",
      status: "no-session",
      summary: "no active session",
    })
  ) {
    return;
  }

  if (format === "quiet") {
    process.stdout.write("no-session\n");
    return;
  }

  process.stdout.write("session: -\n");
  process.stdout.write(`agent: ${agentCommand}\n`);
  process.stdout.write("pid: -\n");
  process.stdout.write("status: no-session\n");
  process.stdout.write("model: -\n");
  process.stdout.write("availableModels: -\n");
  process.stdout.write("mode: -\n");
  process.stdout.write("reasoningEffort: -\n");
  process.stdout.write("reasoningEffortLive: -\n");
  process.stdout.write("effortLadder: -\n");
  process.stdout.write("effortCeiling: -\n");
  process.stdout.write("served: -\n");
  process.stdout.write("floorOk: -\n");
  process.stdout.write("outputStyleDesired: -\n");
  process.stdout.write("outputStyleApplied: -\n");
  process.stdout.write("uptime: -\n");
  process.stdout.write("lastPromptTime: -\n");
}

async function printSessionStatus(
  record: SessionRecord,
  format: ResolvedAcpxConfig["format"],
): Promise<void> {
  const health = await probeQueueOwnerHealth(record.acpxRecordId);
  const statusState = resolveStatusState(record, health);
  const payload = await createStatusPayload(record, health, statusState);
  const running = isRunningStatus(statusState);
  const dead = isDeadStatus(statusState);

  if (emitStatusJson(format, record, payload, statusState, running, dead)) {
    return;
  }

  if (format === "quiet") {
    process.stdout.write(`${payload.status}\n`);
    return;
  }

  printTextStatus(payload, dead);
}

async function createStatusPayload(
  record: SessionRecord,
  health: Awaited<ReturnType<typeof probeQueueOwnerHealth>>,
  statusState: SessionStatusState,
): Promise<StatusPayload> {
  const running = isRunningStatus(statusState);
  const acpx = await statusAcpxFields(record);
  return {
    sessionId: record.acpxRecordId,
    agentCommand: record.agentCommand,
    pid: statusPid(health),
    status: statusState,
    model: acpx.model,
    mode: acpx.mode,
    availableModels: acpx.availableModels,
    reasoningEffort: acpx.reasoningEffort,
    reasoningEffortLive: acpx.reasoningEffortLive,
    effortLadder: acpx.effortLadder,
    effortCeiling: acpx.effortCeiling,
    effortCeilingNote: acpx.effortCeilingNote,
    served: acpx.served,
    floorOk: acpx.floorOk,
    floorNote: acpx.floorNote,
    outputStyle: acpx.outputStyle,
    outputStyleApplied: acpx.outputStyleApplied,
    outputStylePending: acpx.outputStylePending,
    autoFailover: acpx.autoFailover,
    autoSubscription: acpx.autoSubscription,
    fableDegradeOk: acpx.fableDegradeOk,
    credential: statusCredential(record),
    uptime: running ? optionalStatusString(formatUptime(record.agentStartedAt)) : null,
    lastPromptTime: optionalStatusString(record.lastPromptAt),
    exitCode: running ? null : optionalStatusNumber(record.lastAgentExitCode),
    signal: running ? null : optionalStatusSignal(record.lastAgentExitSignal),
    ...agentSessionIdPayload(record.agentSessionId),
  };
}

type StatusCredentialPayload = {
  id: string;
  kind: "profile" | "subscription";
  locked: boolean;
  lockedAt?: string;
};

function profileStatusCredential(profileId: string): StatusCredentialPayload | null {
  const registry = loadProfileRegistry();
  const profile = findProfile(profileId, registry);
  if (!profile) {
    return null;
  }
  return {
    id: profile.id,
    kind: "profile",
    locked: isSubscriptionProfileLocked(profile, registry),
    ...(profile.authMode === "subscription" && profile.lockedAt !== undefined
      ? { lockedAt: profile.lockedAt }
      : {}),
  };
}

function subscriptionStatusCredential(subscriptionId: string): StatusCredentialPayload | null {
  const registry = loadSubscriptionRegistry();
  const subscription = findSubscription(subscriptionId, registry);
  if (!subscription) {
    return null;
  }
  return {
    id: subscription.id,
    kind: "subscription",
    locked: isSubscriptionLocked(subscription, registry),
    ...(subscription.lockedAt !== undefined ? { lockedAt: subscription.lockedAt } : {}),
  };
}

// brick://874fee67 — DESIRED and APPLIED are printed as two separate lines on
// purpose. Collapsing them into one would hide precisely the state this feature
// has to be honest about: a change that is persisted but not yet in force,
// because the query the agent is running was built with the old style.
function printOutputStyleStatus(payload: {
  outputStyle: string | null;
  outputStyleApplied: string | null;
  outputStylePending: boolean;
}): void {
  process.stdout.write(`outputStyleDesired: ${orDash(payload.outputStyle)}\n`);
  process.stdout.write(
    `outputStyleApplied: ${orDash(payload.outputStyleApplied)}${
      payload.outputStylePending ? " (pending: restarts at the end of this turn)" : ""
    }\n`,
  );
}

function printEffortCeilingAndFloorStatus(payload: {
  effortLadder: string[] | null;
  effortCeiling: string[] | null;
  effortCeilingNote: string | null;
  served: StatusServedPayload | null;
  floorOk: boolean | null;
  floorNote: string | null;
}): void {
  process.stdout.write(`effortLadder: ${listOrDash(payload.effortLadder)}\n`);
  const ceilingNote = payload.effortCeiling
    ? ""
    : ` (${payload.effortCeilingNote ?? "unresolved"})`;
  process.stdout.write(`effortCeiling: ${listOrDash(payload.effortCeiling)}${ceilingNote}\n`);
  process.stdout.write(`served: ${formatServedText(payload.served)}\n`);
  const floorOkText = payload.floorOk === null ? "unknown" : payload.floorOk ? "yes" : "no";
  const floorNoteText = payload.floorNote ? ` (${payload.floorNote})` : "";
  process.stdout.write(`floorOk: ${floorOkText}${floorNoteText}\n`);
}

function formatServedText(served: StatusServedPayload | null): string {
  if (!served) {
    return "-";
  }
  const at = served.at ? ` (at ${served.at})` : "";
  return `model=${orDash(served.model)} effort=${orDash(served.effort)}${at}`;
}

function statusCredential(record: SessionRecord): StatusCredentialPayload | null {
  const options = record.acpx?.session_options;
  const profileId = options?.profile?.trim();
  if (profileId) {
    return profileStatusCredential(profileId);
  }
  const subscriptionId = options?.subscription?.trim();
  return subscriptionId ? subscriptionStatusCredential(subscriptionId) : null;
}

type StatusServedPayload = { model: string | null; effort: string | null; at: string | null };

export async function statusAcpxFields(record: SessionRecord): Promise<{
  model: string | null;
  mode: string | null;
  availableModels: string[] | null;
  reasoningEffort: string | null;
  reasoningEffortLive: string | null;
  // The generic per-harness UNION `config_options` advertises — every rung ANY
  // model this harness can run might offer, read the way whoami.sh's record
  // path already did (config_options[category=="thought_level" or
  // id=="effort"].options[].value, excluding the "default" placeholder).
  // ⚠️ NOT the pinned model's own ceiling — a claude session's config_options
  // advertises [default,low,medium,high,xhigh,max] regardless of whether the
  // PINNED model (e.g. sonnet) can actually serve xhigh/max. See
  // `effortCeiling` for the model-specific, catalogue-backed answer; prefer
  // that one for a "--require LEVEL is even reachable" check and use this only
  // as a fallback when the catalogue cannot resolve the pin.
  effortLadder: string[] | null;
  // The PINNED model's own real depth ceiling, from the model catalogue
  // (`model-ladder.ts`) — authoritative for "can this session's model ever
  // reach LEVEL", unlike `effortLadder` above. `null` (with `effortCeilingNote`
  // explaining why) when unresolvable: no pin, an unmeasured harness, a cold
  // catalogue cache, or candidate rows that disagree on their ladder.
  effortCeiling: string[] | null;
  effortCeilingNote: string | null;
  // Per-turn SERVED truth vs. the pinned floor (model-floor.ts, wired here for
  // the first time — brick 3c018a4b Move A). `served` is `null` when nothing
  // has been observed yet for this harness (see `floorNote`); `floorOk` is
  // `null` — NEVER `false` — whenever the floor cannot be asserted (no pin, or
  // no served observation for this harness), matching
  // `enforceModelFloorPostServe`'s own "no pin, no check" behavior.
  served: StatusServedPayload | null;
  floorOk: boolean | null;
  floorNote: string | null;
  // brick://874fee67. THREE values, and they must stay three distinct names:
  //   outputStyle        — DESIRED (what was asked for)
  //   outputStyleApplied — APPLIED (what the live query was actually BUILT with).
  //                        OUR action record; this is what a UI labels a chip from.
  //   outputStylePending — derived: desired !== applied, i.e. a change is waiting
  //                        for the owner to recycle.
  // There is deliberately no "outputStyleLive" sibling to reasoningEffortLive:
  // the harness readback is unvalidated inbound and disconnected from behaviour
  // outbound, so surfacing it beside these would invite exactly the confusion
  // the separate names exist to prevent.
  outputStyle: string | null;
  outputStyleApplied: string | null;
  outputStylePending: boolean;
  autoFailover: boolean;
  autoSubscription: boolean;
  fableDegradeOk: boolean;
}> {
  const acpx = record.acpx;
  if (!acpx) {
    return {
      model: null,
      mode: null,
      availableModels: null,
      reasoningEffort: null,
      reasoningEffortLive: null,
      effortLadder: null,
      effortCeiling: null,
      effortCeilingNote: "no pinned model",
      served: null,
      floorOk: null,
      floorNote: "no pinned model — floor not asserted",
      outputStyle: null,
      outputStyleApplied: null,
      outputStylePending: false,
      autoFailover: true,
      autoSubscription: true,
      fableDegradeOk: false,
    };
  }
  const harness = harnessIdForAgentCommand(record.agentCommand);
  const ceiling = await resolveSessionModelLadder(record);
  const { served, floorOk, floorNote } = resolveServedAndFloor(record, harness);
  return {
    model: optionalStatusString(acpx.current_model_id),
    mode: optionalStatusString(acpx.current_mode_id),
    availableModels: optionalStatusStringList(acpx.available_models),
    // Intent (the authoritative per-session signal) + the adapter's advertised
    // live value. NOTE: on the deployed claude adapter the live snapshot is the
    // model default and may not track a per-session set — prefer the intent.
    reasoningEffort: resolveReasoningEffort(record, harness),
    reasoningEffortLive: liveEffortCurrentValue(acpx),
    effortLadder: resolveGenericEffortLadder(acpx),
    effortCeiling: ceiling.levels,
    effortCeilingNote: ceiling.note,
    served,
    floorOk,
    floorNote,
    outputStyle: optionalStatusString(acpx.session_options?.output_style),
    outputStyleApplied: optionalStatusString(acpx.applied_output_style),
    // The ONE shared predicate — never re-derived inline here (brick://67d2fd2f).
    outputStylePending: outputStyleChangePending(record),
    autoFailover: autoFailoverStatus(acpx),
    autoSubscription: autoSubscriptionStatus(acpx),
    fableDegradeOk: fableDegradeStatus(acpx),
  };
}

function desiredEffort(acpx: NonNullable<SessionRecord["acpx"]>): string | null {
  return acpx.desired_config_options?.effort ?? null;
}

/**
 * `reasoningEffort` per-harness derivation (brick 3c018a4b Move A item 1),
 * ported verbatim from acpx-ui's `extractEffortLevel`
 * (`acpx-ui/server/index.ts:2862-2922`) so the two answer the same question
 * the same way instead of drifting independently:
 *  - codex fuses the effort into the model id (`gpt-5.5[xhigh]`) — parse the
 *    bracket off the DESIRED model id (`session_options.model`), preferring it
 *    over the possibly-stale advertised `current_model_id` for the same reason
 *    `extractModel` does (a live re-sync can transiently re-advertise a stale
 *    id and make a just-changed depth appear to revert).
 *  - pi's SERVED depth (`depth_projection.served`) beats the requested token
 *    (`session_options.effort`) — the projection records what pi actually
 *    applied, including a position-projected collapse (`xhigh`/`max` -> e.g.
 *    `medium`), so the requested value alone would echo a wish, not the truth.
 *  - claude / claude-pty / anything else (incl. opencode, unmeasured by this
 *    concept — CONTENT.md) — UNCHANGED: `desired_config_options.effort`. An
 *    opencode record never sets that field, so it naturally reports `null`
 *    here, matching acpx-ui's explicit `undefined` for the same harness.
 */
export function resolveReasoningEffort(
  record: SessionRecord,
  harness: string | undefined,
): string | null {
  const acpx = record.acpx;
  if (!acpx) {
    return null;
  }
  if (harness === "codex") {
    return resolveCodexReasoningEffort(acpx);
  }
  if (harness === "pi") {
    return resolvePiReasoningEffort(acpx);
  }
  return desiredEffort(acpx);
}

function resolveCodexReasoningEffort(acpx: NonNullable<SessionRecord["acpx"]>): string | null {
  const modelId = codexEffortSourceModelId(acpx);
  if (!modelId) {
    return null;
  }
  const match = /\[([^\]]+)\]\s*$/.exec(modelId);
  const value = match?.[1]?.trim().toLowerCase();
  return value || null;
}

function resolvePiReasoningEffort(acpx: NonNullable<SessionRecord["acpx"]>): string | null {
  const served = normalizedEffortToken(acpx.depth_projection?.served);
  const requested = normalizedEffortToken(acpx.session_options?.effort);
  const value = served || requested;
  return !value || value === "default" ? null : value;
}

function normalizedEffortToken(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** codex's `extractModel` precedence: DESIRED model wins over a possibly-stale advertised id. */
function codexEffortSourceModelId(acpx: NonNullable<SessionRecord["acpx"]>): string | null {
  const desired = acpx.session_options?.model;
  if (typeof desired === "string" && desired.trim().length > 0) {
    return desired.trim();
  }
  const advertised = acpx.current_model_id;
  return typeof advertised === "string" && advertised.trim().length > 0 ? advertised.trim() : null;
}

/**
 * The generic per-harness ladder union, read exactly the way whoami.sh's
 * record path already does it (`config_options[category=="thought_level" or
 * id=="effort"].options[].value`, excluding the `"default"` placeholder). See
 * the field's own doc comment on `statusAcpxFields`'s return type for why this
 * is NOT the same question `effortCeiling` answers.
 */
export function resolveGenericEffortLadder(acpx: SessionAcpxState): string[] | null {
  const option = (acpx.config_options ?? []).find(
    (entry: SessionConfigOption) => entry.category === "thought_level" || entry.id === "effort",
  );
  if (!option || option.type !== "select") {
    return null;
  }
  const values = option.options
    .map((entry) => ("value" in entry ? entry.value : undefined))
    .filter((value): value is string => typeof value === "string" && value !== "default");
  return values.length > 0 ? values : null;
}

/**
 * The `served`/`floorOk`/`floorNote` triple (brick 3c018a4b Move A item 2),
 * wiring the existing, tested `model-floor.ts` against the in-memory record —
 * no new alias-resolution logic, no new I/O.
 *
 * Per-harness served observation (types.ts's own `acpx.served` doc table):
 *  - claude: `acpx.served` is populated post-turn from the Claude transcript
 *    (`captureServedState`) with BOTH `model` and `effort`.
 *  - pi: `acpx.served` is populated by `recordDepthOutcome`
 *    (`depth-application.ts`) with `effort` ONLY — pi's provisioning writes
 *    exactly the requested model id before spawn, so acpx never independently
 *    observes a served MODEL for it the way it does for claude's soft
 *    downgrades. `servedModel` is therefore left `undefined` for pi, which
 *    makes `evaluateModelFloor` report `"unknown"` (never a false `at-floor`
 *    or `below-floor` on data acpx does not have).
 *  - claude-pty: never populated (`captureServedState` is gated on the
 *    `claude-agent-acp` SDK adapter specifically) — reports `"unknown"`.
 *  - codex: never populated — `recordDepthOutcome`'s own comment states this
 *    is a MEASURED baseline (codex's depth request always lands in its
 *    "unavailable" outcome, since depth is fused into the model id rather than
 *    a live mode/config-option apply). Reported as "not evaluated for codex"
 *    rather than silently falling through to a generic `"unknown"`, so a
 *    reader can tell "this harness isn't wired for this" from "no serve yet".
 */
export function resolveServedAndFloor(
  record: SessionRecord,
  harness: string | undefined,
): { served: StatusServedPayload | null; floorOk: boolean | null; floorNote: string | null } {
  const servedBlock = record.acpx?.served;
  const served = buildServedPayload(servedBlock);

  const pinnedModel = pinnedModelFloor(record);
  if (!pinnedModel) {
    return { served, floorOk: null, floorNote: "no pinned model — floor not asserted" };
  }

  const evaluation = evaluateModelFloor({
    pinnedModel,
    pinnedEffort: pinnedEffortFloor(record),
    servedModel: servedBlock?.model,
    servedEffort: servedBlock?.effort,
  });

  const { floorOk, floorNote } = floorVerdictFromEvaluation(evaluation, harness);
  return { served, floorOk, floorNote };
}

function buildServedPayload(
  servedBlock: NonNullable<SessionRecord["acpx"]>["served"],
): StatusServedPayload | null {
  const model = servedBlock?.model;
  const effort = servedBlock?.effort;
  const hasObservation = model !== undefined || effort !== undefined;
  if (!hasObservation) {
    return null;
  }
  return {
    model: optionalStatusString(model),
    effort: optionalStatusString(effort),
    at: optionalStatusString(servedBlock?.at),
  };
}

function floorVerdictFromEvaluation(
  evaluation: ModelFloorEvaluation,
  harness: string | undefined,
): { floorOk: boolean | null; floorNote: string | null } {
  if (evaluation.status === "unknown") {
    return { floorOk: null, floorNote: unknownFloorNote(harness) };
  }
  const floorOk = evaluation.status === "at-floor";
  return { floorOk, floorNote: floorOk ? null : belowFloorNote(evaluation) };
}

function unknownFloorNote(harness: string | undefined): string {
  return harness === "codex"
    ? "not evaluated for codex — no served observation is captured for this harness"
    : "served model not observed yet — floor not asserted";
}

function belowFloorNote(evaluation: ModelFloorEvaluation): string {
  const reasonNote = evaluation.reason === "effort" ? " (effort below pin)" : "";
  return `served ${evaluation.servedModel ?? "?"} does not match pinned ${evaluation.pinnedModel}${reasonNote}`;
}

function liveEffortCurrentValue(acpx: NonNullable<SessionRecord["acpx"]>): string | null {
  const option = acpx.config_options?.find((entry) => entry.id === "effort");
  return option && option.type === "select" ? option.currentValue : null;
}

function autoFailoverStatus(acpx: NonNullable<SessionRecord["acpx"]>): boolean {
  return acpx.session_options?.auto_failover !== false;
}

// brick://4d517be2 — autonomous selection: absent means ON (default). Degrade: absent
// means OFF (opt-in).
function autoSubscriptionStatus(acpx: NonNullable<SessionRecord["acpx"]>): boolean {
  return acpx.session_options?.auto_subscription !== false;
}

function fableDegradeStatus(acpx: NonNullable<SessionRecord["acpx"]>): boolean {
  return acpx.session_options?.fable_degrade_ok === true;
}

function statusPid(health: Awaited<ReturnType<typeof probeQueueOwnerHealth>>): number | null {
  if (health.pidAlive) {
    return health.pid ?? null;
  }
  return null;
}

function optionalStatusString(value: string | undefined | null): string | null {
  return value ?? null;
}

function optionalStatusStringList(value: string[] | undefined | null): string[] | null {
  return value ?? null;
}

function optionalStatusNumber(value: number | undefined | null): number | null {
  return value ?? null;
}

function optionalStatusSignal(value: NodeJS.Signals | undefined | null): NodeJS.Signals | null {
  return value ?? null;
}

function isRunningStatus(status: SessionStatusState): boolean {
  return status === "running";
}

function isDeadStatus(status: SessionStatusState): boolean {
  return status === "dead";
}

type StatusPayload = {
  sessionId: string;
  agentCommand: string;
  pid: number | null;
  status: SessionStatusState;
  model: string | null;
  mode: string | null;
  availableModels: string[] | null;
  reasoningEffort: string | null;
  reasoningEffortLive: string | null;
  effortLadder: string[] | null;
  effortCeiling: string[] | null;
  effortCeilingNote: string | null;
  served: StatusServedPayload | null;
  floorOk: boolean | null;
  floorNote: string | null;
  outputStyle: string | null;
  outputStyleApplied: string | null;
  outputStylePending: boolean;
  autoFailover: boolean;
  autoSubscription: boolean;
  fableDegradeOk: boolean;
  credential: StatusCredentialPayload | null;
  uptime: string | null;
  lastPromptTime: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  agentSessionId?: string;
};

function emitStatusJson(
  format: ResolvedAcpxConfig["format"],
  record: SessionRecord,
  payload: StatusPayload,
  statusState: SessionStatusState,
  running: boolean,
  dead: boolean,
): boolean {
  return emitJsonResult(format, statusJsonPayload(record, payload, statusState, running, dead));
}

function statusJsonPayload(
  record: SessionRecord,
  payload: StatusPayload,
  statusState: SessionStatusState,
  running: boolean,
  dead: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    action: "status_snapshot",
    status: running ? "alive" : statusState,
    summary: statusSummary(statusState),
    acpxRecordId: record.acpxRecordId,
    acpxSessionId: record.acpSessionId,
    agentSessionId: record.agentSessionId,
  };
  assignDefinedJsonField(result, "pid", payload.pid);
  assignDefinedJsonField(result, "model", payload.model);
  assignDefinedJsonField(result, "mode", payload.mode);
  assignDefinedJsonField(result, "availableModels", payload.availableModels);
  assignDefinedJsonField(result, "reasoningEffort", payload.reasoningEffort);
  assignDefinedJsonField(result, "reasoningEffortLive", payload.reasoningEffortLive);
  assignDefinedJsonField(result, "effortLadder", payload.effortLadder);
  assignDefinedJsonField(result, "effortCeiling", payload.effortCeiling);
  assignDefinedJsonField(result, "effortCeilingNote", payload.effortCeilingNote);
  assignDefinedJsonField(result, "served", payload.served);
  // `floorOk` is a tri-state encoded as key-absence: omitted (unknown/not
  // asserted) vs. `true` (at-floor) vs. `false` (below-floor) — never emit a
  // literal `false` for "not asserted" (acceptance criterion #4).
  assignDefinedJsonField(result, "floorOk", payload.floorOk);
  assignDefinedJsonField(result, "floorNote", payload.floorNote);
  assignDefinedJsonField(result, "outputStyleDesired", payload.outputStyle);
  assignDefinedJsonField(result, "outputStyleApplied", payload.outputStyleApplied);
  assignDefinedJsonField(result, "outputStylePending", payload.outputStylePending);
  assignDefinedJsonField(result, "autoFailover", payload.autoFailover);
  assignDefinedJsonField(result, "autoSubscription", payload.autoSubscription);
  assignDefinedJsonField(result, "fableDegradeOk", payload.fableDegradeOk);
  assignDefinedJsonField(result, "credential", payload.credential);
  assignDefinedJsonField(result, "uptime", payload.uptime);
  assignDefinedJsonField(result, "lastPromptTime", payload.lastPromptTime);
  if (dead) {
    assignDefinedJsonField(result, "exitCode", payload.exitCode);
    assignDefinedJsonField(result, "signal", payload.signal);
  }
  return result;
}

function assignDefinedJsonField(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== null && value !== undefined) {
    target[key] = value;
  }
}

function orDash(value: string | number | null): string {
  return value == null ? "-" : String(value);
}

function listOrDash(value: string[] | null): string {
  return value && value.length > 0 ? value.join(", ") : "-";
}

function printTextStatus(payload: StatusPayload, dead: boolean): void {
  process.stdout.write(`session: ${payload.sessionId}\n`);
  if ("agentSessionId" in payload) {
    process.stdout.write(`agentSessionId: ${payload.agentSessionId}\n`);
  }
  process.stdout.write(`agent: ${payload.agentCommand}\n`);
  process.stdout.write(`pid: ${orDash(payload.pid)}\n`);
  process.stdout.write(`status: ${payload.status}\n`);
  process.stdout.write(`model: ${orDash(payload.model)}\n`);
  process.stdout.write(`availableModels: ${listOrDash(payload.availableModels)}\n`);
  process.stdout.write(`mode: ${orDash(payload.mode)}\n`);
  process.stdout.write(`reasoningEffort: ${orDash(payload.reasoningEffort)}\n`);
  process.stdout.write(`reasoningEffortLive: ${orDash(payload.reasoningEffortLive)}\n`);
  printEffortCeilingAndFloorStatus(payload);
  printOutputStyleStatus(payload);
  process.stdout.write(`autoFailover: ${payload.autoFailover ? "on" : "off"}\n`);
  process.stdout.write(`autoSubscription: ${payload.autoSubscription ? "on" : "off"}\n`);
  process.stdout.write(`fableDegradeOk: ${payload.fableDegradeOk ? "on" : "off"}\n`);
  process.stdout.write(
    `credentialLocked: ${
      payload.credential ? (payload.credential.locked ? "locked" : "unlocked") : "-"
    }\n`,
  );
  process.stdout.write(`uptime: ${orDash(payload.uptime)}\n`);
  process.stdout.write(`lastPromptTime: ${orDash(payload.lastPromptTime)}\n`);
  if (dead) {
    printDeadStatusDetails(payload);
  }
}

function printDeadStatusDetails(payload: StatusPayload): void {
  process.stdout.write(`exitCode: ${payload.exitCode ?? "-"}\n`);
  process.stdout.write(`signal: ${payload.signal ?? "-"}\n`);
}

export function registerStatusCommand(
  parent: Command,
  explicitAgentName: string | undefined,
  config: ResolvedAcpxConfig,
  description: string,
): void {
  const statusCommand = parent.command("status").description(description);
  addSessionNameOption(statusCommand);
  statusCommand.action(async function (this: Command, flags: StatusFlags) {
    await handleStatus(explicitAgentName, flags, this, config);
  });
}
