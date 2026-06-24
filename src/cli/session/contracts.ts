import type { AcpClient } from "../../acp/client.js";
import type { SubscriptionLookupOptions } from "../../config/subscriptions.js";
import type { SessionAgentOptions } from "../../runtime/engine/session-options.js";
import type {
  AcpJsonRpcMessage,
  AcpMessageDirection,
  AuthPolicy,
  ClientOperation,
  McpServer,
  NonInteractivePermissionPolicy,
  OutputErrorEmissionPolicy,
  OutputFormatter,
  PermissionEscalationEvent,
  PermissionMode,
  PermissionPolicy,
  PromptInput,
  AgentSessionListResult,
  SessionNotification,
  SessionResumePolicy,
  SessionRecord,
} from "../../types.js";

type TimedRunOptions = {
  timeoutMs?: number;
};

export const DEFAULT_QUEUE_OWNER_TTL_MS = 900_000;

export function normalizeQueueOwnerTtlMs(ttlMs: number | undefined): number {
  if (ttlMs == null) {
    return DEFAULT_QUEUE_OWNER_TTL_MS;
  }

  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    return DEFAULT_QUEUE_OWNER_TTL_MS;
  }

  // 0 means keep alive forever (no TTL)
  return Math.round(ttlMs);
}

export type RunOnceOptions = {
  agentCommand: string;
  agentName?: string;
  cwd: string;
  prompt: PromptInput;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  outputFormatter: OutputFormatter;
  onAcpMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onClientOperation?: (operation: ClientOperation) => void;
  onPermissionEscalation?: (event: PermissionEscalationEvent) => void;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  sessionOptions?: SessionAgentOptions;
  promptRetries?: number;
} & TimedRunOptions;

export type SessionCreateOptions = {
  agentCommand: string;
  agentName?: string;
  cwd: string;
  name?: string;
  resumeSessionId?: string;
  forkFromSessionId?: string;
  forkAtMessageIndex?: number;
  parentSessionId?: string;
  /** Full parent acpx-ui URL (host+id) for cross-machine lineage. (FW-19) */
  parentSessionUrl?: string;
  metadata?: Record<string, string>;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  verbose?: boolean;
  sessionOptions?: SessionAgentOptions;
  desiredConfigOptions?: Record<string, string>;
} & TimedRunOptions;

export type SessionSendOptions = {
  sessionId: string;
  prompt: PromptInput;
  resumePolicy?: SessionResumePolicy;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  permissionModeExplicit?: boolean;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  outputFormatter: OutputFormatter;
  onAcpMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onClientOperation?: (operation: ClientOperation) => void;
  onPermissionEscalation?: (event: PermissionEscalationEvent) => void;
  errorEmissionPolicy?: OutputErrorEmissionPolicy;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  waitForCompletion?: boolean;
  messageId?: string;
  ttlMs?: number;
  maxQueueDepth?: number;
  client?: AcpClient;
  promptRetries?: number;
  sessionOptions?: SessionAgentOptions;
} & TimedRunOptions;

export type SessionEnsureOptions = {
  agentCommand: string;
  agentName?: string;
  cwd: string;
  name?: string;
  resumeSessionId?: string;
  parentSessionId?: string;
  /** Full parent acpx-ui URL (host+id) for cross-machine lineage. (FW-19) */
  parentSessionUrl?: string;
  metadata?: Record<string, string>;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  verbose?: boolean;
  walkBoundary?: string;
  sessionOptions?: SessionAgentOptions;
} & TimedRunOptions;

export type SessionListOptions = {
  agentCommand: string;
  agentName?: string;
  cwd: string;
  cursor?: string;
  filterCwd?: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionListResult = AgentSessionListResult | undefined;

export type SessionCancelOptions = {
  sessionId: string;
  verbose?: boolean;
};

export type SessionCancelResult = {
  sessionId: string;
  cancelled: boolean;
};

export type SessionSetModeOptions = {
  sessionId: string;
  modeId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  verbose?: boolean;
} & TimedRunOptions;

export type SessionSetModelOptions = {
  sessionId: string;
  modelId: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  verbose?: boolean;
  /**
   * CLI-verb path only: when set, a live idle queue owner is recycled after the
   * desired model is persisted so the change binds on the next turn (the next
   * prompt cold-resumes and replays it — mirrors `set profile`). Defaults off so
   * internal/replay callers (e.g. ensureSession) never recycle; they already
   * cold-reconnect. See setSessionModel.
   */
  recycleOwner?: boolean;
  /** Only used for the turn-in-flight error message on the recycle path. */
  sessionName?: string;
} & TimedRunOptions;

export type SessionSetConfigOptionOptions = {
  sessionId: string;
  configId: string;
  value: string;
  mcpServers?: McpServer[];
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  verbose?: boolean;
  /**
   * CLI-verb path only: when set, a live idle queue owner is recycled after the
   * desired value is persisted so the change binds on the next turn (mirrors
   * `set profile`). Defaults off so internal/replay callers never recycle. Used
   * by the CLI `set effort` handler. See setSessionConfigOption.
   */
  recycleOwner?: boolean;
  /** Only used for the turn-in-flight error message on the recycle path. */
  sessionName?: string;
} & TimedRunOptions;

export type SessionCreateWithClientResult = {
  record: SessionRecord;
  client: AcpClient;
};

export type SessionSetSubscriptionOptions = {
  sessionId: string;
  subscriptionId: string;
  /** Used only for the turn-in-flight error message. */
  sessionName?: string;
  verbose?: boolean;
  /** Test override for the registry/home lookup. */
  loadOpts?: SubscriptionLookupOptions;
};

export type SessionSetSubscriptionResult = {
  record: SessionRecord;
  from?: string;
  to: string;
  transcriptCopied: boolean;
  /** True when a live queue owner existed and was restarted to bind the switch. */
  ownerRestarted: boolean;
};

export type SessionSetProfileOptions = {
  sessionId: string;
  profileId: string;
  /** Used only for the turn-in-flight error message. */
  sessionName?: string;
  verbose?: boolean;
  /** Test override for the registry/home lookup. */
  loadOpts?: SubscriptionLookupOptions;
};

export type SessionSetProfileResult = {
  record: SessionRecord;
  from?: string;
  to: string;
  transcriptCopied: boolean;
  /** True when a live queue owner existed and was restarted to bind the move. */
  ownerRestarted: boolean;
};

export type { SessionAgentOptions };
