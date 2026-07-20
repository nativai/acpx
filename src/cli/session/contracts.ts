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

// W13-24-14 Phase 2 — memory-release idle timeout (ms). The accumulated-idle
// threshold after which a provably-idle, provably-done owner is gracefully
// released to free its ~287 MB; the next prompt cold-respawns WITH context
// (reliable post Phase 1). Daniel's decided default is 30 min; tune per box via
// the ACPX_OWNER_IDLE_RELEASE_MS env var (milliseconds). Mirrors the
// DEFAULT_QUEUE_OWNER_TTL_MS / normalizeQueueOwnerTtlMs pair above.
export const DEFAULT_OWNER_IDLE_RELEASE_MS = 1_800_000; // 30 min

export function normalizeOwnerIdleReleaseMs(value: number | undefined): number {
  if (value == null) {
    return DEFAULT_OWNER_IDLE_RELEASE_MS;
  }

  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_OWNER_IDLE_RELEASE_MS;
  }

  // 0 is a valid value: it disables ONLY the memory-release path (the
  // deploy-staleness recycle still works). Invalid/negative/unset → default.
  return Math.round(value);
}

// brick c92f6bdc, Fix A — the hard cap on how long live background process-group
// work may keep a voluntary idle-release warm. The work-aware gate keeps an owner
// warm while a model-backgrounded job runs; this cap ensures a hung/leaked job
// cannot pin an owner warm FOREVER. Once background work has been observed idle for
// this long, release proceeds (→ graceful drain) with a logged warning naming the
// surviving pids — never a silent kill. Default 2 h: comfortably clears legitimate
// long jobs (a full suite ≈ 20 min; builds/matrices ≤ ~1 h) while bounding a leak's
// ~287 MB/owner cost; symmetric with acpx-ui's 2 h delivery retry ceiling. Tune per
// box via ACPX_MAX_BACKGROUND_GRACE_MS (ms). Mirrors the pairs above.
export const DEFAULT_MAX_BACKGROUND_GRACE_MS = 7_200_000; // 2 h

export function normalizeMaxBackgroundGraceMs(value: number | undefined): number {
  if (value == null) {
    return DEFAULT_MAX_BACKGROUND_GRACE_MS;
  }

  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_MAX_BACKGROUND_GRACE_MS;
  }

  // 0 is a valid value: it DISABLES the cap (unbounded warm while work runs) for an
  // operator who prefers `--ttl`-style protection. `--ttl 0` remains the absolute
  // opt-out regardless. Invalid/negative/unset → the 2 h default.
  return Math.round(value);
}

// brick c92f6bdc, Fix A — the grace given to live process-group members (a
// backgrounded job + the exiting adapter) to finish / checkpoint after SIGTERM,
// before the final orphan-backstop group-SIGKILL, on the VOLUNTARY self-teardown
// path (closeQueueOwnerRuntime). PROCESS_EXIT_GRACE_MS (1.5 s) is too short to let
// a job checkpoint; 10 s is the recommended default. Tune via
// ACPX_OWNER_DRAIN_GRACE_MS (ms). Mirrors the pairs above.
export const DEFAULT_OWNER_DRAIN_GRACE_MS = 10_000; // 10 s

export function normalizeOwnerDrainGraceMs(value: number | undefined): number {
  if (value == null) {
    return DEFAULT_OWNER_DRAIN_GRACE_MS;
  }

  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_OWNER_DRAIN_GRACE_MS;
  }

  // 0 is a valid value: it restores the LEGACY immediate group-SIGKILL (no SIGTERM
  // drain wait) — a clean rollback lever. Invalid/negative/unset → the 10 s default.
  return Math.round(value);
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

export type SessionSetAutoFailoverOptions = {
  sessionId: string;
  autoFailover: boolean;
  /** Used only for the turn-in-flight error message. */
  sessionName?: string;
};

export type SessionSetAutoFailoverResult = {
  record: SessionRecord;
  autoFailover: boolean;
};

export type { SessionAgentOptions };
