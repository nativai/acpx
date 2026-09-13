import { withTimeout } from "../../async-control.js";
import {
  withConnectedSession,
  type FullConnectedSessionController,
  type WithConnectedSessionOptions,
  type WithConnectedSessionResult,
} from "../../runtime/engine/connected-session.js";
import { applyDepthAsMode, applyDepthOutcomeToRecord } from "../../session/depth-application.js";
import {
  setCurrentModelId,
  setDesiredConfigOption,
  setDesiredModeId,
  setDesiredModelId,
  setDesiredModelSource,
  setModelSetMethodUnsupported,
} from "../../session/mode-preference.js";
import { advertisedDepthLadderFromConfigOptions } from "../../session/model-application.js";
import { assertRecordModelSupported } from "../../session/model-application.js";
import { resolveSessionRecord, writeSessionRecord } from "../../session/persistence.js";
import type {
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  SessionSetConfigOptionResult,
  SessionSetDepthResult,
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

export type RunSessionSetDepthDirectOptions = {
  sessionRecordId: string;
  requested: string;
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

/**
 * Direct (no-owner) apply of a live thinking-depth request on a `mode`-mechanism
 * harness (brick a3c65f0f).
 *
 * The projection runs HERE, not at the caller: this connection's advertisement is
 * the only CURRENT ladder (`client.getAdvertisedConfigOptions()`, folded forward on
 * every pushed `config_option_update` — including the one a model change pushes).
 * The record's stored `config_options` describes the last PERSISTED connect, and a
 * `session/new` `modes` block describes whichever model was default at creation;
 * either can be a ladder the session no longer sits on. The outcome is persisted
 * through the shared writer (`applyDepthOutcomeToRecord`) so both live arms leave
 * identical record state; `withConnectedSession` saves the mutated record itself.
 */
export async function runSessionSetDepthDirect(
  options: RunSessionSetDepthDirectOptions,
): Promise<SessionSetDepthResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
      const modes = advertisedDepthLadderFromConfigOptions(client.getAdvertisedConfigOptions());
      const projection = await applyDepthAsMode({
        client,
        sessionId,
        requested: options.requested,
        modes,
        timeoutMs: options.timeoutMs,
        verbose: options.verbose,
      });
      applyDepthOutcomeToRecord(record, projection);
      return projection;
    }),
  );

  return {
    record: result.record,
    projection: result.value,
    resumed: result.resumed,
    loadError: result.loadError,
  };
}

export async function runSessionSetModelDirect(
  options: RunSessionSetModelDirectOptions,
): Promise<SessionSetModelResult> {
  const result = await withConnectedSession(
    buildDirectConnectedSessionOptions(options, async ({ client, sessionId, record }) => {
      assertRecordModelSupported({
        record,
        requestedModel: options.modelId,
        context: "apply",
      });
      try {
        await withTimeout(client.setSessionModel(sessionId, options.modelId), options.timeoutMs);
        // UP as well as DOWN: a set that succeeds clears a previously learned
        // refusal, so a restored adapter is not permanently hidden.
        setModelSetMethodUnsupported(record, false);
      } catch (error) {
        // ⚠️ PERSIST THE LEARNED FACT BEFORE RE-THROWING. This is the verb path
        // the UI drives, and it is where the adapter's `-32601` is first seen with
        // a record in hand. Without the write the fact dies with the process and
        // the next session offers the same control that has already been proven
        // impossible. The write is best-effort: failing to record a capability
        // must never replace the user's real error with a bookkeeping one.
        if (client.modelSetMethodIsUnsupported) {
          setModelSetMethodUnsupported(record, true);
          await writeSessionRecord(record).catch(() => {});
        }
        throw error;
      }
      setDesiredModelId(record, options.modelId);
      setCurrentModelId(record, options.modelId);
      // brick://5bac5564 R5: an explicit acpx-level `set model` → provenance "explicit".
      setDesiredModelSource(record, "explicit");
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
