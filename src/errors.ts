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
      `Session '${label}' is closed. Reopen with \`acpx sessions reopen <name>\` (or via the UI) before sending prompts.`,
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
  constructor(id: string) {
    super(`subscription "${id}" not found in registry (~/.acpx/subscriptions/registry.json)`, {
      outputCode: "USAGE",
      detailCode: "SUBSCRIPTION_UNKNOWN",
      origin: "cli",
    });
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
