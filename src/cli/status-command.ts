import { Command } from "commander";
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
import { outputStyleChangePending } from "../session/output-style.js";
import { findSession, resolveGlobalSessionByName } from "../session/persistence.js";
import type { SessionRecord } from "../types.js";
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
  const payload = createStatusPayload(record, health, statusState);
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

function createStatusPayload(
  record: SessionRecord,
  health: Awaited<ReturnType<typeof probeQueueOwnerHealth>>,
  statusState: SessionStatusState,
): StatusPayload {
  const running = isRunningStatus(statusState);
  const acpx = statusAcpxFields(record);
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

function statusCredential(record: SessionRecord): StatusCredentialPayload | null {
  const options = record.acpx?.session_options;
  const profileId = options?.profile?.trim();
  if (profileId) {
    return profileStatusCredential(profileId);
  }
  const subscriptionId = options?.subscription?.trim();
  return subscriptionId ? subscriptionStatusCredential(subscriptionId) : null;
}

function statusAcpxFields(record: SessionRecord): {
  model: string | null;
  mode: string | null;
  availableModels: string[] | null;
  reasoningEffort: string | null;
  reasoningEffortLive: string | null;
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
} {
  const acpx = record.acpx;
  if (!acpx) {
    return {
      model: null,
      mode: null,
      availableModels: null,
      reasoningEffort: null,
      reasoningEffortLive: null,
      outputStyle: null,
      outputStyleApplied: null,
      outputStylePending: false,
      autoFailover: true,
      autoSubscription: true,
      fableDegradeOk: false,
    };
  }
  return {
    model: optionalStatusString(acpx.current_model_id),
    mode: optionalStatusString(acpx.current_mode_id),
    availableModels: optionalStatusStringList(acpx.available_models),
    // Intent (the authoritative per-session signal) + the adapter's advertised
    // live value. NOTE: on the deployed claude adapter the live snapshot is the
    // model default and may not track a per-session set — prefer the intent.
    reasoningEffort: desiredEffort(acpx),
    reasoningEffortLive: liveEffortCurrentValue(acpx),
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
