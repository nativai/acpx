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

// D1 (brick://53437107) — how long `sessions close` waits for an in-flight turn
// to end before it terminalizes the rest of the owner's custody. Chosen so that
// closing an idle worker (the overwhelmingly common case) is imperceptible and
// closing a busy one never hangs an orchestrator.
export const DEFAULT_CLOSE_DRAIN_TIMEOUT_MS = 5_000;

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
  /** True when a live queue owner existed and was restarted to bind the change. */
  ownerRestarted?: boolean;
};

// brick://874fee67 — enumerate an agent's output styles (the create-dialog feed).
export type AgentOutputStyleListOptions = {
  agentCommand: string;
  agentName: string;
  cwd: string;
  mcpServers?: SessionCreateOptions["mcpServers"];
  authCredentials?: SessionCreateOptions["authCredentials"];
  authPolicy?: SessionCreateOptions["authPolicy"];
  timeoutMs?: number;
  verbose?: boolean;
  /** When set, read the advertisement off this session's record instead of
   *  opening a transient one — no process spawned. */
  sessionId?: string;
};

export type AgentOutputStyleListResult = {
  /** Derived from the ADVERTISEMENT, never the agent name. */
  supported: boolean;
  /** The agent's currently-active style, per its own advertisement. Diagnostic
   *  only — this is the harness readback, which is unvalidated inbound and
   *  disconnected from behaviour outbound. Never label a UI chip from it. */
  current?: string;
  available: string[];
};

// brick://874fee67 — the per-session Claude Code output style.
export type SessionSetOutputStyleOptions = {
  sessionId: string;
  /** Opaque non-empty style id, or the literal `"default"` to revert. Never null:
   *  a null-shaped clear cannot reach the create-time flag slot our styles arrive
   *  through, so "revert" is an ordinary set of the advertised `"default"` id. */
  outputStyle: string;
  /** Used only for the refusal error message. */
  sessionName?: string;
};

export type SessionSetOutputStyleResult = {
  record: SessionRecord;
  outputStyle: string;
  /** True when a live idle queue owner existed and was recycled immediately, so
   *  the change binds on the next prompt. */
  ownerRestarted?: boolean;
  /**
   * True when the write was ACCEPTED but the recycle was deferred because a turn
   * was in flight. The change is durable and will bind at the turn boundary (or
   * on the idle check); it is NOT lost and it is NOT an error. The style the
   * session is running until then is `record.acpx.applied_output_style`.
   */
  pending?: boolean;
};

// brick://4d517be2 — the autonomous-selection disable knob.
export type SessionSetAutoSubscriptionOptions = {
  sessionId: string;
  autoSubscription: boolean;
  /** Used only for the turn-in-flight error message. */
  sessionName?: string;
};

export type SessionSetAutoSubscriptionResult = {
  record: SessionRecord;
  autoSubscription: boolean;
  /** True when a live queue owner existed and was restarted to bind the change. */
  ownerRestarted?: boolean;
};

// brick://4d517be2 — the fable→opus degrade opt-in.
export type SessionSetFableDegradeOptions = {
  sessionId: string;
  fableDegradeOk: boolean;
  /** Used only for the turn-in-flight error message. */
  sessionName?: string;
};

export type SessionSetFableDegradeResult = {
  record: SessionRecord;
  fableDegradeOk: boolean;
  /** True when a live queue owner existed and was restarted to bind the change. */
  ownerRestarted?: boolean;
};

export type { SessionAgentOptions };
