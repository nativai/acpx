import type {
  AgentCapabilities,
  AnyMessage,
  McpServer,
  RequestPermissionRequest,
  SessionNotification,
  SessionConfigOption,
  SessionInfo,
  SetSessionConfigOptionResponse,
  StopReason,
  ToolKind,
} from "@agentclientprotocol/sdk";
export type { McpServer, SessionNotification } from "@agentclientprotocol/sdk";
import type { EffectiveAccountMetadata } from "./acp/auth-env.js";
import type { PromptInput } from "./prompt-content.js";

export type AcpPermissionRequest = {
  sessionId: string;
  raw: RequestPermissionRequest;
  inferredKind: ToolKind | undefined;
};

export type AcpPermissionDecision =
  | { outcome: "allow_once" }
  | { outcome: "allow_always" }
  | { outcome: "reject_once" }
  | { outcome: "reject_always" }
  | { outcome: "cancel" };

export const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1,
  USAGE: 2,
  TIMEOUT: 3,
  NO_SESSION: 4,
  PERMISSION_DENIED: 5,
  INTERRUPTED: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export const OUTPUT_FORMATS = ["text", "json", "quiet"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

// Claude thinking-depth vocabulary for the `--reasoning-effort` spawn flag. The
// value lands on the record as `acpx.desired_config_options.effort`; creation
// then maps it onto the child model's advertised/safe `effort` levels before any
// live config mutation.
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const PERMISSION_MODES = ["approve-all", "approve-reads", "deny-all"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const AUTH_POLICIES = ["skip", "fail"] as const;
export type AuthPolicy = (typeof AUTH_POLICIES)[number];

export const NON_INTERACTIVE_PERMISSION_POLICIES = ["deny", "fail"] as const;
export type NonInteractivePermissionPolicy = (typeof NON_INTERACTIVE_PERMISSION_POLICIES)[number];

export const PERMISSION_POLICY_ACTIONS = ["approve", "deny", "escalate"] as const;
export type PermissionPolicyAction = (typeof PERMISSION_POLICY_ACTIONS)[number];

export type PermissionPolicy = {
  autoApprove?: string[];
  autoDeny?: string[];
  escalate?: string[];
  defaultAction?: PermissionPolicyAction;
};

export type PermissionEscalationEvent = {
  type: "permission_escalation";
  sessionId: string;
  toolCallId: string;
  toolName?: string;
  toolTitle: string;
  toolInput?: unknown;
  toolKind?: ToolKind;
  action: "escalate";
  matchedRule?: string;
  message: string;
  timestamp: string;
};

export const SESSION_RESUME_POLICIES = ["allow-new", "same-session-only"] as const;
export type SessionResumePolicy = (typeof SESSION_RESUME_POLICIES)[number];

export const OUTPUT_STREAMS = ["prompt", "control"] as const;
export type OutputStream = (typeof OUTPUT_STREAMS)[number];
export type AcpJsonRpcMessage = AnyMessage;
export type AcpMessageDirection = "outbound" | "inbound";

export const OUTPUT_ERROR_CODES = [
  "NO_SESSION",
  "TIMEOUT",
  "PERMISSION_DENIED",
  "PERMISSION_PROMPT_UNAVAILABLE",
  "RUNTIME",
  "USAGE",
] as const;
export type OutputErrorCode = (typeof OUTPUT_ERROR_CODES)[number];

export const OUTPUT_ERROR_ORIGINS = ["cli", "runtime", "queue", "acp"] as const;
export type OutputErrorOrigin = (typeof OUTPUT_ERROR_ORIGINS)[number];

export const QUEUE_ERROR_DETAIL_CODES = [
  "QUEUE_OWNER_CLOSED",
  "QUEUE_OWNER_SHUTTING_DOWN",
  "QUEUE_OWNER_OVERLOADED",
  "QUEUE_OWNER_GENERATION_MISMATCH",
  "QUEUE_REQUEST_INVALID",
  "QUEUE_REQUEST_PAYLOAD_INVALID_JSON",
  "QUEUE_ACK_MISSING",
  "QUEUE_DISCONNECTED_BEFORE_ACK",
  "QUEUE_DISCONNECTED_BEFORE_COMPLETION",
  "QUEUE_PROTOCOL_INVALID_JSON",
  "QUEUE_PROTOCOL_MALFORMED_MESSAGE",
  "QUEUE_PROTOCOL_UNEXPECTED_RESPONSE",
  "QUEUE_NOT_ACCEPTING_REQUESTS",
  "QUEUE_CONTROL_REQUEST_FAILED",
  "QUEUE_RUNTIME_PROMPT_FAILED",
] as const;
export type QueueErrorDetailCode = (typeof QUEUE_ERROR_DETAIL_CODES)[number];

export type OutputErrorAcpPayload = {
  code: number;
  message: string;
  data?: unknown;
};

export type PermissionStats = {
  requested: number;
  approved: number;
  denied: number;
  cancelled: number;
};

export type ClientOperationMethod =
  | "fs/read_text_file"
  | "fs/write_text_file"
  | "terminal/create"
  | "terminal/output"
  | "terminal/wait_for_exit"
  | "terminal/kill"
  | "terminal/release";

export type ClientOperationStatus = "running" | "completed" | "failed";

export type ClientOperation = {
  method: ClientOperationMethod;
  status: ClientOperationStatus;
  summary: string;
  details?: string;
  timestamp: string;
};

export type SessionEventLog = {
  active_path: string;
  segment_count: number;
  max_segment_bytes: number;
  max_segments: number;
  last_write_at?: string;
  last_write_error?: string | null;
};

export type PerfMetricSummary = {
  count: number;
  totalMs: number;
  maxMs: number;
};

export type PerfMetricsSnapshot = {
  counters: Record<string, number>;
  timings: Record<string, PerfMetricSummary>;
  gauges: Record<string, number>;
};

export type OutputFormatterContext = {
  sessionId: string;
};

export type OutputPolicy = {
  format: OutputFormat;
  jsonStrict: boolean;
  suppressReads: boolean;
  suppressNonJsonStderr: boolean;
  queueErrorAlreadyEmitted: boolean;
  suppressSdkConsoleErrors: boolean;
};

export type OutputErrorEmissionPolicy = {
  queueErrorAlreadyEmitted: boolean;
};

export interface OutputFormatter {
  setContext(context: OutputFormatterContext): void;
  onAcpMessage(message: AcpJsonRpcMessage): void;
  onError(params: {
    code: OutputErrorCode;
    detailCode?: string;
    origin?: OutputErrorOrigin;
    message: string;
    retryable?: boolean;
    acp?: OutputErrorAcpPayload;
    effectiveAccount?: EffectiveAccountMetadata;
    timestamp?: string;
  }): void;
  onPermissionEscalation(event: PermissionEscalationEvent): void;
  flush(): void;
}

export type AcpClientOptions = {
  agentCommand: string;
  cwd: string;
  mcpServers?: McpServer[];
  permissionMode: PermissionMode;
  nonInteractivePermissions?: NonInteractivePermissionPolicy;
  permissionPolicy?: PermissionPolicy;
  authCredentials?: Record<string, string>;
  authPolicy?: AuthPolicy;
  terminal?: boolean;
  suppressSdkConsoleErrors?: boolean;
  verbose?: boolean;
  sessionContext?: {
    acpxRecordId: string;
    sessionName?: string | null;
    parentSessionId?: string | null;
    /** Full parent acpx-ui URL (host+id) for cross-machine lineage. (FW-19) */
    parentSessionUrl?: string | null;
    taskFolder?: string | null;
    brick?: string | null;
    brickPath?: string | null;
    agentFolder?: string | null;
    subscriptionId?: string | null;
    /** Profile id from session_options.profile — takes priority over subscriptionId. */
    profileId?: string | null;
    /**
     * Per-session reasoning effort override for openrouter profiles. Overrides
     * the profile's default reasoningEffort. Validated against the profile's
     * valid effort set inside applyProfileAuth.
     */
    reasoningEffort?: string | null;
  };
  sessionOptions?: {
    model?: string;
    allowedTools?: string[];
    maxTurns?: number;
    systemPrompt?: string | { append: string };
    subscription?: string;
    profile?: string;
  };
  onAcpMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  onAcpOutputMessage?: (direction: AcpMessageDirection, message: AcpJsonRpcMessage) => void;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onClientOperation?: (operation: ClientOperation) => void;
  onPermissionEscalation?: (event: PermissionEscalationEvent) => void;
  onPermissionRequest?: (
    req: AcpPermissionRequest,
    ctx: { signal: AbortSignal },
  ) => Promise<AcpPermissionDecision | undefined>;
};

export const SESSION_RECORD_SCHEMA = "acpx.session.v1" as const;
export type SessionMessageImage = {
  source: string;
  size?: {
    width: number;
    height: number;
  } | null;
};

export type SessionMessageAudio = {
  source: string;
  mime_type: string;
};

export type SessionUserContent =
  | {
      Text: string;
    }
  | {
      Mention: {
        uri: string;
        content: string;
      };
    }
  | {
      Image: SessionMessageImage;
    }
  | {
      Audio: SessionMessageAudio;
    };

export type SessionToolUse = {
  id: string;
  name: string;
  raw_input: string;
  input: unknown;
  is_input_complete: boolean;
  thought_signature?: string | null;
};

export type SessionToolResultContent =
  | {
      Text: string;
    }
  | {
      Image: SessionMessageImage;
    };

export type SessionToolResult = {
  tool_use_id: string;
  tool_name: string;
  is_error: boolean;
  content: SessionToolResultContent;
  output?: unknown;
};

export type SessionAgentContent =
  | {
      Text: string;
    }
  | {
      Thinking: {
        text: string;
        signature?: string | null;
      };
    }
  | {
      RedactedThinking: string;
    }
  | {
      ToolUse: SessionToolUse;
    };

export type SessionUserMessage = {
  id: string;
  content: SessionUserContent[];
  /**
   * Claude transcript record uuid this messages_log entry corresponds to
   * (durable byway-fork provenance). Stamped from the steer ack
   * `_meta.steerBoundaryUuid`, or inherited from the immediately preceding
   * entry as a deterministic fallback. Absent on the very first User entry
   * (no predecessor) → fork falls back to the legacy index path.
   */
  claudeUuid?: string;
};

/**
 * Structured terminal-turn-error marker (FIX-A). When a turn ends in a terminal
 * error (all-subscriptions-exhausted / auth-gated / turn-ending rate_limit /
 * future kinds), acpx mirrors it into the conversation as a synthetic Agent
 * message so a child that dies on such an error AND its spawner are TOLD in
 * `.messages.ndjson` (not only `.stream.ndjson`, which is human/UI-only). This
 * marker carries the normalized cross-repo `detail_code` so an agent reading
 * `messages.ndjson` can classify the failure programmatically; the human-readable
 * message is also rendered as an Agent `Text` block ("⚠ turn failed: <message>").
 *
 * Snake_case throughout — the persisted-key policy (`persisted-key-policy.ts`)
 * requires it, and the class-agnostic mirror maps `normalizeOutputError`'s camelCase
 * fields onto these keys once at the write site.
 */
export type SessionTerminalError = {
  message: string;
  detail_code?: string;
  output_code?: string;
  origin?: string;
  retryable?: boolean;
};

export type SessionAgentMessage = {
  content: SessionAgentContent[];
  tool_results: Record<string, SessionToolResult>;
  reasoning_details?: unknown;
  /**
   * Claude transcript record uuid of the last record streamed into this
   * entry (durable byway-fork provenance). Stamped last-wins from
   * `update._meta.claudeUuid`.
   */
  claudeUuid?: string;
  /**
   * Present only on a synthetic terminal-error entry (FIX-A). Absent on every
   * normal streamed Agent turn.
   */
  terminal_error?: SessionTerminalError;
};

export type SessionMessage =
  | {
      User: SessionUserMessage;
    }
  | {
      Agent: SessionAgentMessage;
    }
  | "Resume";

export type SessionTokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type AgentProgressPhase = "thinking" | "responding" | "tool_calling" | "idle";

export type AgentProgressTokens = {
  reasoning?: number;
  output?: number;
  input?: number;
  total?: number;
};

export type AgentProgress = {
  phase: AgentProgressPhase;
  label?: string;
  tokens?: AgentProgressTokens;
  final?: boolean;
  source?: string;
};

export type SessionConversation = {
  title?: string | null;
  messages: SessionMessage[];
  updated_at: string;
  cumulative_token_usage: SessionTokenUsage;
  request_token_usage: Record<string, SessionTokenUsage>;
};

export type SessionMessagesLogState = {
  v: 1;
  count: number;
  base_index: number;
  bytes: number;
};

export type SessionOwnerOptions = {
  permission_mode: PermissionMode;
  non_interactive_permissions?: NonInteractivePermissionPolicy;
  auth_policy?: AuthPolicy;
  terminal?: boolean;
};

export type SessionAcpxState = {
  reset_on_next_ensure?: boolean;
  current_mode_id?: string;
  desired_mode_id?: string;
  desired_config_options?: Record<string, string>;
  current_model_id?: string;
  /** Fix A (brick 92a994a0): the context-window size (in tokens) the adapter
   *  last reported for `context_window_model_id`, round-tripped back to the
   *  adapter on resume as `_meta.claudeCode.contextWindowSizeHint` so a restored
   *  session reports the correct window from its first post-resume usage_update
   *  instead of re-guessing 200k. Tagged with the observing model so a model
   *  switch invalidates it: a resume only injects the hint while the tag still
   *  matches `current_model_id`, never carrying a stale 1M across a 1M→200k
   *  switch. */
  context_window_size?: number;
  context_window_model_id?: string;
  available_models?: string[];
  available_commands?: string[];
  progress?: AgentProgress;
  config_options?: SessionConfigOption[];
  owner_options?: SessionOwnerOptions;
  /**
   * Per-turn SERVED truth (brick://07dd62c9): the model the harness/API actually
   * served for the last turn — the last `assistant.message.model` in the Claude
   * transcript — plus the effort that the served model implies, and when it was
   * observed. LIVE observation, deliberately kept SEPARATE from the desired pin
   * (`current_model_id` / `session_options.model`): under load the API can serve
   * a cheaper model than the pin, and this field records that fact without ever
   * mutating the pin. Absent for non-Claude agents (no transcript model) and
   * until the first post-turn capture. `effort` is DERIVED from the served model
   * (effort follows model — see config-option-application), not an independent
   * observation; `source` labels where `model` came from.
   */
  served?: {
    model?: string;
    effort?: string;
    at?: string;
    source?: string;
  };
  /**
   * Breadcrumb stamped when a turn was served below the pinned floor
   * (brick://07dd62c9). Records the observed served model/effort alongside the
   * pinned floor + when, so the dip is auditable after the fact. Auto-CLEARED on
   * the next at-floor serve. The desired pin is NEVER mutated by this.
   */
  served_below_floor?: {
    served_model?: string;
    served_effort?: string;
    pinned_model?: string;
    pinned_effort?: string;
    at: string;
  };
  /**
   * Set under `--floor-hard` when a below-floor turn was refused/quarantined and
   * bounded auto-retry did not recover (brick://07dd62c9). The session awaits an
   * at-floor serve (auto-clears) or a parent/operator ack. Distinct from the
   * `served_below_floor` audit breadcrumb: this one drives the parked state +
   * debounced parent notification.
   */
  floor_parked?: {
    at: string;
    reason: string;
    observed_model?: string;
  };
  session_options?: {
    model?: string;
    allowed_tools?: string[];
    max_turns?: number;
    system_prompt?: string | { append: string };
    subscription?: string;
    /** Profile id selected via `--profile <id>`. Takes priority over `subscription`. */
    profile?: string;
    /**
     * Requested Claude thinking depth (the `effort` config option), persisted as
     * the durable end-to-end contract field. Carries the value requested via
     * `--reasoning-effort` so it survives cold-resume (the claude-pty bridge reads
     * `session_options.effort` when reconstructing source state from the acpx
     * record). Kept alongside `acpx.desired_config_options.effort`, which remains
     * the live-config / reconnect-reapply field. Opaque string (an advertised
     * effort level), validated at the flag boundary.
     */
    effort?: string;
    /**
     * Per-session automatic credential/subscription failover policy. Absent
     * means enabled (the historical behavior); only explicit false opts out.
     */
    auto_failover?: boolean;
    /**
     * Per-session hard model-floor policy (brick://07dd62c9). When true, a turn
     * that is served below the pinned model floor is NOT silently accepted: it is
     * refused pre-turn when knowably-down and quarantined behind a loud terminal
     * post-serve. Absent/false = the default "detect + surface + accept" mode.
     * Durable per-session policy, carried forward across owner respawns by
     * `carryForwardPinnedFloor` (same shape as `auto_failover`).
     */
    floor_hard?: boolean;
    /**
     * Breadcrumb recorded when a session's subscription is changed in place
     * (manual switch or auto-failover). Drives the acpx-ui badge/notice and
     * survives restart. `from` is '' / undefined when the prior selection was
     * the registry default or raw global (no explicit sub).
     */
    subscription_switch?: {
      from?: string;
      to: string;
      reason: "manual" | "failover" | "locked";
      at: string;
    };
    /**
     * Breadcrumb recorded when the provider-domain seam switches the unified
     * profile/account selection. W5 keeps this separate from the legacy
     * subscription breadcrumb so Wave 4 can converge without writing
     * session_options.subscription.
     */
    account_switch?: {
      fromProfile?: string;
      toProfile: string;
      fromAccount?: string;
      toAccount: string;
      /** Physically effective source account at the time the switch was decided. */
      effectiveAccount?: string;
      effectiveProfile?: string;
      effectiveAuthMode?: string;
      effectiveAnchor?: string;
      effectiveResolutionMethod?: "path" | "selection";
      reason: "manual" | "failover" | "locked";
      at: string;
    };
    /**
     * Latest best-effort OS harness provisioning warning for this session.
     * Provisioning must never fail the spawn; this breadcrumb makes degraded
     * harness state visible to operators.
     */
    provisioning_warning?: {
      at: string;
      profileId?: string;
      authMode?: string;
      adapter?: string;
      anchor?: string;
      message: string;
    };
  };
};

export type SubagentRef = {
  acpxRecordId: string;
  name: string;
  color?: string;
  spawnedAt: string;
  claudeJsonlPath?: string;
};

export type SessionImportedFrom = {
  recordId: string;
  cwdOriginal: string;
  exportedBy: string;
  exportedAt: string;
};

/**
 * acpx-ui-owned passthrough. acpx-ui marks a session as a reusable template by
 * writing this block into the record (and flipping `closed`). The daemon does
 * not author it, but parses + re-serializes it untouched so a daemon rewrite of
 * a template session no longer drops the flag, and so `toSessionIndexEntry` can
 * project `templateEnabled`/`templateCreatedAt` into the index sidecar (lets
 * acpx-ui's hot rebuild path skip the per-session record read). All fields
 * optional — acpx-ui owns the schema.
 */
export type SessionTemplateState = {
  enabled?: boolean;
  created_at?: string;
  source_session_id?: string;
  /** Literal prompt text auto-sent on every spawn from this template. Absent or
   *  empty ⇒ no auto-prompt (pure copy). Stored plaintext — do not put secrets here. */
  auto_prompt?: string;
  /** Stable human handle for the template; lowercase kebab (canonical slugify,
   *  see template-slug.ts Appendix A). Global across the store — one slug = one
   *  logical template. Read-side derives `slug ?? slugify(name)` so slug-less
   *  records still group/resolve. acpx is the sole author (W13-01). */
  slug?: string;
  /** Monotonic version within a slug, assigned `max(existing for slug)+1` at
   *  mark-time. Latest-wins resolution picks the max-version enabled record
   *  (see template-slug.ts Appendix B). A refresh always sorts latest because
   *  the new version is derived from existing data, not the wall clock. */
  version?: number;
};

export type SessionRecord = {
  schema: typeof SESSION_RECORD_SCHEMA;
  acpxRecordId: string;
  acpSessionId: string;
  agentSessionId?: string;
  /** Stable acpx agent name; preferred over mutable agentCommand for routing. */
  agentName?: string;
  agentCommand: string;
  cwd: string;
  name?: string;
  createdAt: string;
  lastUsedAt: string;
  lastSeq: number;
  lastRequestId?: string;
  eventLog: SessionEventLog;
  closed?: boolean;
  closedAt?: string;
  favorite?: boolean;
  favoritedAt?: string;
  pid?: number;
  agentStartedAt?: string;
  lastPromptAt?: string;
  lastAgentExitCode?: number | null;
  lastAgentExitSignal?: NodeJS.Signals | null;
  lastAgentExitAt?: string;
  lastAgentDisconnectReason?: string;
  /** True when the last disconnect happened mid-turn (a prompt was active) — the
   * signal that tells a mid-turn death apart from a routine idle TTL-reap (both
   * otherwise serialize as connection_close/null/null). */
  lastAgentUnexpectedDuringPrompt?: boolean;
  protocolVersion?: number;
  agentCapabilities?: AgentCapabilities;
  title?: string | null;
  messages: SessionMessage[];
  messagesLog?: SessionMessagesLogState;
  updated_at: string;
  cumulative_token_usage: SessionTokenUsage;
  request_token_usage: Record<string, SessionTokenUsage>;
  acpx?: SessionAcpxState;
  kind?: "session" | "subagent";
  parentSessionId?: string;
  forkedFromSessionId?: string;
  forkedAtMessageIndex?: number;
  subagents?: SubagentRef[];
  metadata?: Record<string, string>;
  importedFrom?: SessionImportedFrom;
  /** acpx-ui-owned template marker; daemon round-trips it untouched. */
  template?: SessionTemplateState;
};

export type RunPromptResult = {
  stopReason: StopReason;
  permissionStats: PermissionStats;
  sessionId: string;
};

export type SessionSendResult = RunPromptResult & {
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

export type SessionSetModeResult = {
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
};

export type SessionSetConfigOptionResult = {
  record: SessionRecord;
  response: SetSessionConfigOptionResponse;
  resumed: boolean;
  loadError?: string;
  /** True when a live queue owner existed and was recycled to bind the change. */
  ownerRestarted?: boolean;
};

export type SessionSetModelResult = {
  record: SessionRecord;
  resumed: boolean;
  loadError?: string;
  /** True when a live queue owner existed and was recycled to bind the change. */
  ownerRestarted?: boolean;
};

export type SessionEnsureResult = {
  record: SessionRecord;
  created: boolean;
};

export type AgentSessionListResult = {
  _meta?: {
    [key: string]: unknown;
  } | null;
  source: "agent";
  sessions: SessionInfo[];
  cursor?: string;
  cwd?: string;
  nextCursor?: string | null;
};

export type SessionEnqueueResult = {
  queued: true;
  sessionId: string;
  requestId: string;
};

export type SessionSendOutcome = SessionSendResult | SessionEnqueueResult;
export type { PromptInput };
