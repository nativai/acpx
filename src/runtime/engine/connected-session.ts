import type { SetSessionConfigOptionResponse } from "@agentclientprotocol/sdk";
import { AcpClient } from "../../acp/client.js";
import { withInterrupt } from "../../async-control.js";
import { resolveAndEnsureAgentFolder } from "../../cli/session/agent-folder.js";
import { resolveExistingBrickPath } from "../../cli/session/brick-link.js";
import {
  persistSessionOwnerOptions,
  resolveSessionOwnerOptions,
  ownerOptionsToInput,
} from "../../session/owner-options.js";
import { absolutePath, isoNow } from "../../session/persistence.js";
import type {
  AcpPermissionDecision,
  AcpPermissionRequest,
  AuthPolicy,
  McpServer,
  NonInteractivePermissionPolicy,
  PermissionMode,
  SessionRecord,
  SessionResumePolicy,
} from "../../types.js";
import { bindRecordToDefaultAccount } from "./default-account-binding.js";
import { applyLifecycleSnapshotToRecord } from "./lifecycle.js";
import { connectAndLoadSession, type ConnectedSessionController } from "./reconnect.js";
import { sessionOptionsFromRecord } from "./session-options.js";

export type FullConnectedSessionController = ConnectedSessionController & {
  setSessionModel: (modelId: string) => Promise<void>;
  setSessionConfigOption: (
    configId: string,
    value: string,
  ) => Promise<SetSessionConfigOptionResponse>;
};

type ConnectedSessionContext = {
  record: SessionRecord;
  client: AcpClient;
  activeController: FullConnectedSessionController;
  sessionId: string;
  resumed: boolean;
  loadError?: string;
};

export type WithConnectedSessionOptions<T> = {
  sessionRecordId: string;
  loadRecord: (sessionRecordId: string) => Promise<SessionRecord>;
  saveRecord: (record: SessionRecord) => Promise<void>;
  createClient?: (options: ConstructorParameters<typeof AcpClient>[0]) => AcpClient;
  mcpServers?: McpServer[];
  permissionMode?: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  onPermissionRequest?: (
    req: AcpPermissionRequest,
    ctx: { signal: AbortSignal },
  ) => Promise<AcpPermissionDecision | undefined>;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  resumePolicy?: SessionResumePolicy;
  timeoutMs?: number;
  verbose?: boolean;
  onClientAvailable?: (controller: FullConnectedSessionController) => void;
  onClientClosed?: () => void;
  onConnectedRecord?: (record: SessionRecord) => void;
  onInterrupt?: (params: { client: AcpClient; record: SessionRecord }) => Promise<void>;
  run: (context: ConnectedSessionContext) => Promise<T>;
};

export type WithConnectedSessionResult<T> = {
  value: T;
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

function createActiveSessionController(params: {
  client: AcpClient;
  getActiveSessionId: () => string;
}): FullConnectedSessionController {
  const getActiveSessionId = () => params.getActiveSessionId();
  return {
    hasActivePrompt: () => params.client.hasActivePrompt(),
    requestCancelActivePrompt: async () => await params.client.requestCancelActivePrompt(),
    setSessionMode: async (modeId: string) => {
      await params.client.setSessionMode(getActiveSessionId(), modeId);
    },
    setSessionModel: async (modelId: string) => {
      await params.client.setSessionModel(getActiveSessionId(), modelId);
    },
    setSessionConfigOption: async (configId: string, value: string) => {
      return await params.client.setSessionConfigOption(getActiveSessionId(), configId, value);
    },
  };
}

// eslint-disable-next-line complexity -- fork integration function; intentionally over budget, refactor would risk verified merge semantics
export async function withConnectedSession<T>(
  options: WithConnectedSessionOptions<T>,
): Promise<WithConnectedSessionResult<T>> {
  const record = await options.loadRecord(options.sessionRecordId);
  if (bindRecordToDefaultAccount(record)) {
    await options.saveRecord(record);
  }
  const ownerOptions = resolveSessionOwnerOptions(record, {
    permissionMode: options.permissionMode ?? "approve-reads",
    nonInteractivePermissions: options.nonInteractivePermissions,
    authPolicy: options.authPolicy,
    terminal: options.terminal,
  });
  persistSessionOwnerOptions(record, ownerOptionsToInput(ownerOptions));
  const brick = record.metadata?.brick?.trim() || null;
  const brickPath = brick ? resolveExistingBrickPath(brick) : null;
  const client =
    options.createClient?.({
      agentCommand: record.agentCommand,
      cwd: absolutePath(record.cwd),
      mcpServers: options.mcpServers,
      permissionMode: ownerOptions.permission_mode,
      nonInteractivePermissions: ownerOptions.non_interactive_permissions,
      onPermissionRequest: options.onPermissionRequest,
      authCredentials: options.authCredentials,
      authPolicy: ownerOptions.auth_policy,
      terminal: ownerOptions.terminal,
      verbose: options.verbose,
      sessionContext: {
        acpxRecordId: record.acpxRecordId,
        sessionName: record.name ?? null,
        parentSessionId: record.parentSessionId ?? null,
        parentSessionUrl: record.parentSessionUrl ?? null,
        taskFolder: record.metadata?.task_folder ?? null,
        brick,
        brickPath,
        agentFolder: resolveAndEnsureAgentFolder(record, brickPath),
        subscriptionId: record.acpx?.session_options?.subscription ?? null,
        profileId: record.acpx?.session_options?.profile ?? null,
      },
      sessionOptions: sessionOptionsFromRecord(record),
    }) ??
    new AcpClient({
      agentCommand: record.agentCommand,
      cwd: absolutePath(record.cwd),
      mcpServers: options.mcpServers,
      permissionMode: ownerOptions.permission_mode,
      nonInteractivePermissions: ownerOptions.non_interactive_permissions,
      onPermissionRequest: options.onPermissionRequest,
      authCredentials: options.authCredentials,
      authPolicy: ownerOptions.auth_policy,
      terminal: ownerOptions.terminal,
      verbose: options.verbose,
      sessionContext: {
        acpxRecordId: record.acpxRecordId,
        sessionName: record.name ?? null,
        parentSessionId: record.parentSessionId ?? null,
        parentSessionUrl: record.parentSessionUrl ?? null,
        taskFolder: record.metadata?.task_folder ?? null,
        brick,
        brickPath,
        agentFolder: resolveAndEnsureAgentFolder(record, brickPath),
        subscriptionId: record.acpx?.session_options?.subscription ?? null,
        profileId: record.acpx?.session_options?.profile ?? null,
      },
      sessionOptions: sessionOptionsFromRecord(record),
    });
  let activeSessionIdForControl = record.acpSessionId;
  let notifiedClientAvailable = false;
  const activeController = createActiveSessionController({
    client,
    getActiveSessionId: () => activeSessionIdForControl,
  });

  try {
    return await withInterrupt(
      async () => {
        const { sessionId, resumed, loadError } = await connectAndLoadSession({
          client,
          record,
          resumePolicy: options.resumePolicy,
          timeoutMs: options.timeoutMs,
          verbose: options.verbose,
          activeController,
          onClientAvailable: (controller) => {
            options.onClientAvailable?.(controller as FullConnectedSessionController);
            notifiedClientAvailable = true;
          },
          onConnectedRecord: options.onConnectedRecord,
          onSessionIdResolved: (sessionIdValue) => {
            activeSessionIdForControl = sessionIdValue;
          },
        });

        const value = await options.run({
          record,
          client,
          activeController,
          sessionId,
          resumed,
          loadError,
        });

        const now = isoNow();
        record.lastUsedAt = now;
        record.closed = false;
        record.closedAt = undefined;
        record.protocolVersion = client.initializeResult?.protocolVersion;
        record.agentCapabilities = client.initializeResult?.agentCapabilities;
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        await options.saveRecord(record);

        return {
          value,
          record,
          resumed,
          loadError,
        };
      },
      async () => {
        if (options.onInterrupt) {
          await options.onInterrupt({ client, record });
        } else {
          await client.cancelActivePrompt(2_500);
        }
        applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
        record.lastUsedAt = isoNow();
        await options.saveRecord(record).catch(() => {
          // best effort while process is being interrupted
        });
        await client.close();
      },
    );
  } finally {
    if (notifiedClientAvailable) {
      options.onClientClosed?.();
    }
    await client.close();
    applyLifecycleSnapshotToRecord(record, client.getAgentLifecycleSnapshot());
    await options.saveRecord(record).catch(() => {
      // best effort on close
    });
  }
}
