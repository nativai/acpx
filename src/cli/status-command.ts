import { Command } from "commander";
import { findSession } from "../session/persistence.js";
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
  const record =
    explicitRecord ??
    (await findSession({
      agentCommand: agent.agentCommand,
      agentName: agent.agentName,
      cwd: agent.cwd,
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
    uptime: running ? optionalStatusString(formatUptime(record.agentStartedAt)) : null,
    lastPromptTime: optionalStatusString(record.lastPromptAt),
    exitCode: running ? null : optionalStatusNumber(record.lastAgentExitCode),
    signal: running ? null : optionalStatusSignal(record.lastAgentExitSignal),
    ...agentSessionIdPayload(record.agentSessionId),
  };
}

function statusAcpxFields(record: SessionRecord): {
  model: string | null;
  mode: string | null;
  availableModels: string[] | null;
  reasoningEffort: string | null;
  reasoningEffortLive: string | null;
} {
  return {
    model: record.acpx?.current_model_id ?? null,
    mode: record.acpx?.current_mode_id ?? null,
    availableModels: record.acpx?.available_models ?? null,
    // Intent (the authoritative per-session signal) + the adapter's advertised
    // live value. NOTE: on the deployed claude adapter the live snapshot is the
    // model default and may not track a per-session set — prefer the intent.
    reasoningEffort: desiredEffort(record),
    reasoningEffortLive: liveEffortCurrentValue(record),
  };
}

function desiredEffort(record: SessionRecord): string | null {
  return record.acpx?.desired_config_options?.effort ?? null;
}

function liveEffortCurrentValue(record: SessionRecord): string | null {
  const option = record.acpx?.config_options?.find((entry) => entry.id === "effort");
  return option && option.type === "select" ? option.currentValue : null;
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
