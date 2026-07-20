import type { OutputErrorAcpPayload, OutputErrorCode, OutputErrorOrigin } from "./types.js";

type AcpxErrorOptions = ErrorOptions & {
  outputCode?: OutputErrorCode;
  detailCode?: string;
  origin?: OutputErrorOrigin;
  retryable?: boolean;
  acp?: OutputErrorAcpPayload;
  outputAlreadyEmitted?: boolean;
};

export class AcpxOperationalError extends Error {
  readonly outputCode?: OutputErrorCode;
  readonly detailCode?: string;
  readonly origin?: OutputErrorOrigin;
  readonly retryable?: boolean;
  readonly acp?: OutputErrorAcpPayload;
  readonly outputAlreadyEmitted?: boolean;

  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.outputCode = options?.outputCode;
    this.detailCode = options?.detailCode;
    this.origin = options?.origin;
    this.retryable = options?.retryable;
    this.acp = options?.acp;
    this.outputAlreadyEmitted = options?.outputAlreadyEmitted;
  }
}

export class SessionNotFoundError extends AcpxOperationalError {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.sessionId = sessionId;
  }
}

export class SessionResolutionError extends AcpxOperationalError {}

export class SessionClosedError extends AcpxOperationalError {
  readonly sessionId: string;
  readonly sessionName: string | undefined;

  constructor(sessionId: string, sessionName: string | undefined) {
    const label = sessionName ?? sessionId;
    super(
      `Session '${label}' is closed. Reopen it in acpx-ui (Reopen button), or deliver a message to its session URL to reopen-and-deliver before sending CLI prompts.`,
      {
        outputCode: "RUNTIME",
        detailCode: "SESSION_CLOSED",
        origin: "runtime",
      },
    );
    this.sessionId = sessionId;
    this.sessionName = sessionName;
  }
}

export class AgentSpawnError extends AcpxOperationalError {
  readonly agentCommand: string;

  constructor(agentCommand: string, cause?: unknown) {
    super(`Failed to spawn agent command: ${agentCommand}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.agentCommand = agentCommand;
  }
}

export class AgentStartupError extends AcpxOperationalError {
  readonly agentCommand: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrSummary?: string;

  constructor(params: {
    agentCommand: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderrSummary?: string;
    cause?: unknown;
  }) {
    const exitSummary = `exit=${params.exitCode ?? "null"}, signal=${params.signal ?? "null"}`;
    const stderrSuffix =
      typeof params.stderrSummary === "string" && params.stderrSummary.trim().length > 0
        ? `: ${params.stderrSummary.trim()}`
        : "";
    super(`ACP agent exited before initialize completed (${exitSummary})${stderrSuffix}`, {
      cause: params.cause instanceof Error ? params.cause : undefined,
      outputCode: "RUNTIME",
      detailCode: "AGENT_STARTUP_FAILED",
      origin: "acp",
    });
    this.agentCommand = params.agentCommand;
    this.exitCode = params.exitCode;
    this.signal = params.signal;
    this.stderrSummary = params.stderrSummary?.trim() || undefined;
  }
}

export class AgentDisconnectedError extends AcpxOperationalError {
  readonly reason: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    reason: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    options?: AcpxErrorOptions,
  ) {
    super(
      `ACP agent disconnected during request (${reason}, exit=${exitCode ?? "null"}, signal=${signal ?? "null"})`,
      {
        outputCode: "RUNTIME",
        detailCode: "AGENT_DISCONNECTED",
        origin: "acp",
        ...options,
      },
    );
    this.reason = reason;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export class UnsupportedPromptContentError extends AcpxOperationalError {
  constructor(message: string) {
    super(message, {
      outputCode: "USAGE",
      detailCode: "UNSUPPORTED_PROMPT_CONTENT",
      origin: "acp",
    });
  }
}

export class SessionResumeRequiredError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_RESUME_REQUIRED",
      origin: "acp",
      retryable: true,
      ...options,
    });
  }
}

export class SessionOwnerRestoreError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_OWNER_RESTORE_FAILED",
      origin: "runtime",
      retryable: false,
      ...options,
    });
  }
}

export class GeminiAcpStartupTimeoutError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "TIMEOUT",
      detailCode: "GEMINI_ACP_STARTUP_TIMEOUT",
      origin: "acp",
      ...options,
    });
  }
}

// A subscription id was requested that is not in the registry. Usage error.
export class SubscriptionUnknownError extends AcpxOperationalError {
  constructor(id: string, knownIds?: readonly string[]) {
    const known =
      knownIds && knownIds.length > 0
        ? ` Known subscription ids: ${knownIds.join(", ")}.`
        : " Known subscription ids: none.";
    super(
      `subscription "${id}" not found in registry (~/.acpx/subscriptions/registry.json).${known}`,
      {
        outputCode: "USAGE",
        detailCode: "SUBSCRIPTION_UNKNOWN",
        origin: "cli",
      },
    );
  }
}

// A subscription/profile was requested while it is user-locked. Locks are not
// quota exhaustion: they are operator intent and must render with lock-specific
// recovery UI.
export class SubscriptionLockedError extends AcpxOperationalError {
  readonly subscriptionId: string;

  constructor(
    id: string,
    options?: { origin?: "cli" | "runtime"; outputCode?: "USAGE" | "RUNTIME" },
  ) {
    super(
      `subscription "${id}" is locked. Unlock it or select a different subscription before starting another turn.`,
      {
        outputCode: options?.outputCode ?? "USAGE",
        detailCode: "subscription-locked",
        origin: options?.origin ?? "cli",
      },
    );
    this.subscriptionId = id;
  }
}

export class SubscriptionChangeRequiresSwitchError extends AcpxOperationalError {
  constructor(params: {
    sessionLabel: string;
    currentSubscription?: string;
    requestedSubscription: string;
    switchCommand: string;
  }) {
    const current = params.currentSubscription
      ? `"${params.currentSubscription}"`
      : "no recorded subscription";
    super(
      `Cannot apply --subscription "${params.requestedSubscription}" to existing session ${params.sessionLabel}: current subscription is ${current}. Use \`${params.switchCommand}\` to switch the session before prompting; no prompt was sent.`,
      {
        outputCode: "USAGE",
        detailCode: "SUBSCRIPTION_CHANGE_REQUIRES_SWITCH",
        origin: "cli",
      },
    );
  }
}

// Every registered subscription is dead (401) or maxed (≥ threshold) — there is
// nothing to fail over to. Terminal turn error; the record's selection is left
// unchanged so a later turn re-probes and auto-recovers when a window resets.
// `code` (OutputErrorCode) is a closed set, so the cross-repo contract string
// lives in detailCode = "all-subscriptions-exhausted" (acpx-ui maps it to its
// "all subscriptions exhausted" notice).
export class AllSubscriptionsExhaustedError extends AcpxOperationalError {
  constructor(statuses: string) {
    super(`All subscriptions are exhausted or unavailable. ${statuses}`, {
      outputCode: "RUNTIME",
      detailCode: "all-subscriptions-exhausted",
      origin: "runtime",
    });
  }
}

// Every Fable-eligible subscription rejects claude-fable-5 with 429 while the
// unified 5h/7d windows are HEALTHY (the per-model "fallback" cap). A SEPARATE
// terminal condition from AllSubscriptionsExhaustedError, whose unified-window
// premise is FALSE here. detailCode 'fable-share-exhausted' is the cross-repo
// contract string; normalizeOutputError reads outputCode+detailCode off the
// AcpxOperationalError base, so it flows through the SAME builder + persist mirror
// as the existing terminal errors with ZERO persist-path changes. Record
// selection is left unchanged so a later turn re-probes and auto-recovers when
// the Fable-share window resets. Only ever thrown when isFableModel(sessionModel).
export class FableShareExhaustedError extends AcpxOperationalError {
  constructor(statuses: string) {
    super(
      `Fable-share limit reached on all subscriptions (per-model fallback cap; ` +
        `unified 5h/7d windows are healthy). ${statuses} — switch to a non-Fable ` +
        `model (e.g. \`--model opus\` / \`sessions set-model opus\`) or wait for the ` +
        `Fable-share window to reset (this Fable-share limit is intermittent — a ` +
        `later turn may succeed).`,
      {
        outputCode: "RUNTIME",
        detailCode: "fable-share-exhausted",
        origin: "runtime",
      },
    );
  }
}

// Every same-family subscription target is locked by operator action. Distinct
// from exhausted/quota so retry-exhausted semantics remain untouched.
export class AllSubscriptionsLockedError extends AcpxOperationalError {
  constructor(statuses: string) {
    super(`All compatible subscriptions are locked. ${statuses}`, {
      outputCode: "RUNTIME",
      detailCode: "all-subscriptions-locked",
      origin: "runtime",
    });
  }
}

// A claude-home (PTY bridge) turn failed because the bridge's Claude login is
// gated/expired and no sibling bridge has a usable login. NOT quota — detailCode
// 'auth-gated' so acpx-ui renders the existing AuthGatedBanner (keyed on
// lastError.code === 'auth-gated'), never the exhausted/quota one. Sibling of
// AllSubscriptionsExhaustedError; the record's selection is left unchanged so a
// later turn re-probes and auto-recovers once the login is refreshed.
export class BridgeAuthGatedError extends AcpxOperationalError {
  constructor(statuses: string) {
    super(`Claude bridge needs an interactive login on this box. ${statuses}`, {
      outputCode: "RUNTIME",
      detailCode: "auth-gated",
      origin: "runtime",
    });
  }
}

// A manual subscription switch was requested while a turn is in flight on the
// live queue owner. Refused (not queued) — switching mid-stream would tear the
// client down. acpx-ui maps the "turn-in-flight" detailCode to a 409.
export class SubscriptionTurnInFlightError extends AcpxOperationalError {
  constructor(sessionName?: string) {
    const label = sessionName ? ` '${sessionName}'` : "";
    super(
      `Cannot switch subscription while a turn is in flight on session${label}; wait for the current turn to finish (turn-in-flight).`,
      {
        outputCode: "USAGE",
        detailCode: "TURN_IN_FLIGHT",
        origin: "queue",
      },
    );
  }
}

// `set profile <id>` names a profile not in the registry. Sibling of
// SubscriptionUnknownError for the unified credential-move path.
export class ProfileUnknownError extends AcpxOperationalError {
  constructor(id: string, knownIds?: readonly string[]) {
    const known =
      knownIds && knownIds.length > 0
        ? ` Known profile ids: ${knownIds.join(", ")}.`
        : " Known profile ids: none.";
    super(`profile "${id}" not found in registry (~/.acpx/subscriptions/registry.json).${known}`, {
      outputCode: "USAGE",
      detailCode: "PROFILE_UNKNOWN",
      origin: "cli",
    });
  }
}

// A `set profile` move was requested across credential classes (e.g. an SDK
// subscription session → a claude-pty bridge profile, or → an openrouter API-key
// profile). The auth layer requires a move to stay within the session's
// adapter/authMode class (claude-home⟺claude-pty vs subscription⟺SDK), so the
// move is refused before it can wedge the next turn's auth.
export class ProfileClassMismatchError extends AcpxOperationalError {
  constructor(params: {
    targetId: string;
    targetAuthMode: string;
    currentId: string;
    currentAuthMode: string;
  }) {
    super(
      `Cannot move session to profile "${params.targetId}" (authMode "${params.targetAuthMode}"): ` +
        `the session's current credential "${params.currentId}" is authMode "${params.currentAuthMode}". ` +
        `A move must stay within the same credential class (subscription↔subscription or claude-home↔claude-home).`,
      {
        outputCode: "USAGE",
        detailCode: "PROFILE_CLASS_MISMATCH",
        origin: "cli",
      },
    );
  }
}

// A manual profile move was requested while a turn is in flight on the live
// queue owner. Refused (not queued) — moving mid-stream would tear the client
// down. Shares the "TURN_IN_FLIGHT" detailCode with the subscription path so
// acpx-ui maps it to the same 409.
export class ProfileTurnInFlightError extends AcpxOperationalError {
  constructor(sessionName?: string) {
    const label = sessionName ? ` '${sessionName}'` : "";
    super(
      `Cannot move the session to a different credential while a turn is in flight on session${label}; wait for the current turn to finish (turn-in-flight).`,
      {
        outputCode: "USAGE",
        detailCode: "TURN_IN_FLIGHT",
        origin: "queue",
      },
    );
  }
}

// A manual `set model` (CLI verb, recycle path) was requested while a turn is in
// flight on the live queue owner. Refused (not queued) — recycling the owner
// would SIGKILL the live turn. Shares the "TURN_IN_FLIGHT" detailCode with the
// subscription/profile paths so acpx-ui maps it to the same 409.
export class ModelTurnInFlightError extends AcpxOperationalError {
  constructor(sessionName?: string) {
    const label = sessionName ? ` '${sessionName}'` : "";
    super(
      `Cannot change the model while a turn is in flight on session${label}; wait for the current turn to finish (turn-in-flight).`,
      {
        outputCode: "USAGE",
        detailCode: "TURN_IN_FLIGHT",
        origin: "queue",
      },
    );
  }
}

// A manual `set <configId>` (CLI verb, recycle path — e.g. thinking depth via
// `set effort`) was requested while a turn is in flight on the live queue owner.
// Refused for the same reason as ModelTurnInFlightError; same 409 contract.
export class ConfigOptionTurnInFlightError extends AcpxOperationalError {
  constructor(configId: string, sessionName?: string) {
    const label = sessionName ? ` '${sessionName}'` : "";
    super(
      `Cannot change config option "${configId}" while a turn is in flight on session${label}; wait for the current turn to finish (turn-in-flight).`,
      {
        outputCode: "USAGE",
        detailCode: "TURN_IN_FLIGHT",
        origin: "queue",
      },
    );
  }
}

export class SessionModeReplayError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_MODE_REPLAY_FAILED",
      origin: "acp",
      ...options,
    });
  }
}

export class SessionModelReplayError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_MODEL_REPLAY_FAILED",
      origin: "acp",
      ...options,
    });
  }
}

export class SessionConfigOptionReplayError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "SESSION_CONFIG_OPTION_REPLAY_FAILED",
      origin: "acp",
      ...options,
    });
  }
}

export class ClaudeAcpSessionCreateTimeoutError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "TIMEOUT",
      detailCode: "CLAUDE_ACP_SESSION_CREATE_TIMEOUT",
      origin: "acp",
      ...options,
    });
  }
}

export class CopilotAcpUnsupportedError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "COPILOT_ACP_UNSUPPORTED",
      origin: "acp",
      ...options,
    });
  }
}

export class AuthPolicyError extends AcpxOperationalError {
  constructor(message: string, options?: AcpxErrorOptions) {
    super(message, {
      outputCode: "RUNTIME",
      detailCode: "AUTH_REQUIRED",
      origin: "acp",
      ...options,
    });
  }
}

export class QueueConnectionError extends AcpxOperationalError {}

export class QueueProtocolError extends AcpxOperationalError {}

export class PermissionDeniedError extends AcpxOperationalError {}

export class PermissionPromptUnavailableError extends AcpxOperationalError {
  constructor() {
    super("Permission prompt unavailable in non-interactive mode");
  }
}
