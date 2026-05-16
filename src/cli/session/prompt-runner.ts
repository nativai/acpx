import { withTimeout } from "../../async-control.js";
import {
  withConnectedSession,
  type FullConnectedSessionController,
  type WithConnectedSessionOptions,
  type WithConnectedSessionResult,
} from "../../runtime/engine/connected-session.js";
import {
  setCurrentModelId,
  setDesiredConfigOption,
  setDesiredModeId,
  setDesiredModelId,
} from "../../session/mode-preference.js";
import { resolveSessionRecord, writeSessionRecord } from "../../session/persistence.js";
import type {
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  SessionSetConfigOptionResult,
  SessionSetModelResult,
  SessionSetModeResult,
} from "../../types.js";
import type { QueueOwnerActiveSessionController } from "../queue/owner-turn-controller.js";

export type ActiveSessionController = QueueOwnerActiveSessionController;

export type RunSessionSetModeDirectOptions = {
  sessionRecordId: string;
  modeId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

export type RunSessionSetConfigOptionDirectOptions = {
  sessionRecordId: string;
  configId: string;
  value: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

export type RunSessionSetModelDirectOptions = {
  sessionRecordId: string;
  modelId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

type DirectConnectedSessionOptions = {
  sessionRecordId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: ActiveSessionController) => void;
  onClientClosed?: () => void;
};

function buildDirectConnectedSessionOptions<T>(
  options: DirectConnectedSessionOptions,
  run: WithConnectedSessionOptions<T>["run"],
): WithConnectedSessionOptions<T> {
  return {
    sessionRecordId: options.sessionRecordId,
    loadRecord: resolveSessionRecord,
    saveRecord: writeSessionRecord,
    mcpServers: options.mcpServers,
    nonInteractivePermissions: options.nonInteractivePermissions,
    authCredentials: options.authCredentials,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
    onClientAvailable: (controller: FullConnectedSessionController) => {
      options.onClientAvailable?.(controller);
    },
    onClientClosed: options.onClientClosed,
    run,
  };
}

function toSessionMutationResult(
  result: Pick<WithConnectedSessionResult<unknown>, "record" | "resumed" | "loadError">,
): Pick<SessionSetModeResult, "record" | "resumed" | "loadError"> {
  return {
    record: result.record,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}

export async function runSessionSetModeDirect(
  options: RunSessionSetModeDirectOptions,
): Promise<SessionSetModeResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
      await withTimeout(client.setSessionMode(sessionId, options.modeId), options.timeoutMs);
      setDesiredModeId(record, options.modeId);
    }),
  );

  return toSessionMutationResult(result);
}

export async function runSessionSetModelDirect(
  options: RunSessionSetModelDirectOptions,
): Promise<SessionSetModelResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
      await withTimeout(client.setSessionModel(sessionId, options.modelId), options.timeoutMs);
      setDesiredModelId(record, options.modelId);
      setCurrentModelId(record, options.modelId);
    }),
  );

  return toSessionMutationResult(result);
}

export async function runSessionSetConfigOptionDirect(
  options: RunSessionSetConfigOptionDirectOptions,
): Promise<SessionSetConfigOptionResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
      const response = await withTimeout(
        client.setSessionConfigOption(sessionId, options.configId, options.value),
        options.timeoutMs,
      );
      if (options.configId === "mode") {
        setDesiredModeId(record, options.value);
      } else {
        setDesiredConfigOption(record, options.configId, options.value);
      }
      return response;
    }),
  );

  return {
    record: result.record,
    response: result.value,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}
