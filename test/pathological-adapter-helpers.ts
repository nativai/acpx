// Reusable scripted "pathological adapter" behaviors that reproduce the proven
// production wire pathologies behind the injected-prompt drain wedge (brick
// 2cd57e11): an adapter that emits its end-of-turn marker but WITHHOLDS the
// JSON-RPC response (the `activePromptResolve` routing hole, RCA §1.2).
//
// From acpx's seat the defect is observable as exactly this: the end-of-turn
// marker (`usage_update` carrying `_meta._claude/lastTurnEndReason`) reaches the
// live session-update tap, yet the `client.prompt()` promise stays unsettled.
// These helpers drive that pattern through the SAME production handler chain the
// C1 watchdog listens on (`client.setEventHandlers({ onSessionUpdate })`), never
// by poking the watchdog directly — a rig that fed the watchdog through a
// shortcut would prove nothing (acpx-ui PROJECT.md, fs.watch P0 lesson).
//
// Factored out of the C-lane tests so the test-engineer's real-process rig can
// reuse the identical scripted behaviors against the real adapter process. See
// TESTER-PLAN.md for the naming/location contract.

import type { AcpClient } from "../src/acp/client.js";
import type { PromptInput } from "../src/prompt-content.js";
import type { SessionNotification } from "../src/types.js";

export const CLAUDE_AGENT_COMMAND = "node /opt/claude-agent-acp/dist/index.js";
export const CODEX_AGENT_COMMAND = "node /opt/codex-acp/dist/index.js";
export const MAIN_PROMPT_TEXT = "main turn prompt";
export const INJECTED_PROMPT_TEXT = "injected mid-turn prompt";

export type PromptResponse = {
  stopReason: "end_turn" | "cancelled" | "max_tokens" | "max_turns";
};

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type CapturedEventHandlers = {
  onSessionUpdate?: (notification: SessionNotification) => void;
  onAcpMessage?: (direction: unknown, message: unknown) => void;
  onAcpOutputMessage?: (direction: unknown, message: unknown) => void;
  onClientOperation?: (operation: unknown) => void;
  onPermissionEscalation?: (event: unknown) => void;
};

export type PromptCall = {
  kind: "main" | "injected";
  messageId?: string;
  /** brick a147982f — the `_claude/promptId` the runtime sent with this prompt, if any. */
  promptId?: string;
};

/**
 * brick a147982f — how the scripted Claude adapter ends a turn (CONCEPTION §6, I-layer):
 *  - `lifecycle`     — the fixed adapter: `sdk_idle` then `completing{reason}`, both carrying
 *                      the guarded prompt's `_claude/promptId`;
 *  - `legacy`        — today's deployed adapter: the `_claude/lastTurnEndReason` `usage_update`
 *                      marker mid-prompt, no lifecycle signal;
 *  - `foreign`       — lifecycle signals carrying ANOTHER prompt's id (an injected/orphaned one);
 *  - `routing-hole`  — `sdk_idle` only: the SDK went idle, the prompt loop never returned;
 *  - `lost-response` — `sdk_idle` + `completing{reason}`, then the response is lost.
 * None of them settles the prompt: the test decides whether and how it responds.
 */
export type ClaudeAdapterEndMode =
  | "lifecycle"
  | "legacy"
  | "foreign"
  | "routing-hole"
  | "lost-response";

export const FOREIGN_PROMPT_ID = "foreign-prompt-0000-4000-8000-000000000000";

/**
 * The adapter's end-of-turn marker: the terminal `usage_update` carrying
 * `_meta._claude/lastTurnEndReason`, constructed exactly as the adapter emits it
 * so the production tap parses it the same way live.
 */
export function turnEndMarkerNotification(
  acpSessionId: string,
  reason = "end_turn",
): SessionNotification {
  return {
    sessionId: acpSessionId,
    update: { sessionUpdate: "usage_update" },
    _meta: { "_claude/lastTurnEndReason": reason },
  } as unknown as SessionNotification;
}

/** brick a147982f — a `_claude/promptLifecycle` ext notification, as the adapter sends it. */
export function promptLifecycleMessage(params: {
  acpSessionId: string;
  promptId: string;
  phase: "sdk_idle" | "completing";
  lastTurnEndReason?: string;
}): unknown {
  return {
    jsonrpc: "2.0",
    method: "_claude/promptLifecycle",
    params: {
      sessionId: params.acpSessionId,
      promptId: params.promptId,
      phase: params.phase,
      ...(params.lastTurnEndReason !== undefined
        ? { lastTurnEndReason: params.lastTurnEndReason }
        : {}),
    },
  };
}

/**
 * The codex-acp end-of-turn marker (493729fc F1): a `session_info_update`
 * carrying `_meta._codex/lastTurnEndReason` on the update level, emitted by the
 * adapter's turn/completed handler — constructed exactly as the adapter emits
 * it so the production tap parses it the same way live.
 */
export function codexTurnEndMarkerNotification(
  acpSessionId: string,
  reason = "end_turn",
): SessionNotification {
  return {
    sessionId: acpSessionId,
    update: {
      sessionUpdate: "session_info_update",
      _meta: { "_codex/lastTurnEndReason": reason },
    },
  } as unknown as SessionNotification;
}

export type PathologicalControl = {
  client: AcpClient;
  promptCalls: PromptCall[];
  /** Resolves once the MAIN prompt has been invoked (the turn is in flight). */
  mainPromptInFlight: Promise<void>;
  /**
   * Push the Claude `_claude/lastTurnEndReason` usage_update marker (today's adapter) through
   * both production taps, wire tap first, as the real client does.
   */
  emitTurnEndMarker: (reason?: string) => void;
  /** brick a147982f — a `session/update` through both taps (wire tap, then session-update tap). */
  emitSessionUpdate: (notification: SessionNotification) => void;
  /** brick a147982f — a `_claude/promptLifecycle` notification through the inbound wire tap. */
  emitPromptLifecycle: (
    phase: "sdk_idle" | "completing",
    options?: { promptId?: string; lastTurnEndReason?: string },
  ) => void;
  /** brick a147982f — the `_claude/promptId` of the latest MAIN prompt (undefined if none sent). */
  mainPromptId: () => string | undefined;
  /** brick cec4c064 — a `_claude/backgroundTasks` notification through the inbound wire tap. */
  emitBackgroundTasks: (tasks: Array<Record<string, unknown>>) => void;
  /** Push the CODEX end-of-turn marker (493729fc F2) through the same tap. */
  emitCodexTurnEndMarker: (reason?: string) => void;
  /** Settle the withheld MAIN prompt (models the adapter finally responding). */
  resolveMainPrompt: (response: PromptResponse) => void;
  rejectMainPrompt: (error: unknown) => void;
  /** How many times the runtime asked to cancel the active prompt (tier-1). */
  cancelCount: () => number;
  /**
   * Configure what `requestCancelActivePrompt()` does. Default: a no-op that
   * does NOT settle the withheld prompt (the "never-respond, ignores cancel"
   * pathology → forces tier-2). Call {@link cancelResolvesPrompt} to make the
   * nudge recover the turn (tier-1 success).
   */
  setCancelBehavior: (fn: () => void) => void;
};

/**
 * Build a Claude-backend AcpClient stub whose MAIN `client.prompt()` withholds
 * its response until the test releases it, exposing controls to drive the wedge
 * pattern. Injected prompts (INJECTED_PROMPT_TEXT) resolve via `onInjectedPrompt`
 * so the same stub also exercises the C3 injected-drain paths.
 */
export function makePathologicalClient(config: {
  acpSessionId: string;
  onInjectedPrompt?: (messageId?: string) => Promise<PromptResponse>;
}): PathologicalControl {
  const handlers: CapturedEventHandlers = {};
  const promptCalls: PromptCall[] = [];
  const mainRelease = createDeferred<PromptResponse>();
  const mainInFlight = createDeferred<void>();
  let cancelCalls = 0;
  let cancelBehavior: () => void = () => {
    // Default: ignore cancel (do not settle the withheld prompt).
  };

  const emitSessionUpdate = (notification: SessionNotification): void => {
    try {
      handlers.onAcpMessage?.("inbound", {
        jsonrpc: "2.0",
        method: "session/update",
        params: notification,
      });
      handlers.onSessionUpdate?.(notification);
    } catch {
      // The real client swallows session-update handler errors (client.ts).
    }
  };

  const emitTurnEndMarker = (reason = "end_turn"): void => {
    emitSessionUpdate(turnEndMarkerNotification(config.acpSessionId, reason));
  };

  let latestMainPromptId: string | undefined;
  const emitPromptLifecycle = (
    phase: "sdk_idle" | "completing",
    options: { promptId?: string; lastTurnEndReason?: string } = {},
  ): void => {
    const promptId = options.promptId ?? latestMainPromptId;
    if (promptId === undefined) {
      // An adapter only signals for a prompt that carried an id.
      return;
    }
    handlers.onAcpMessage?.(
      "inbound",
      promptLifecycleMessage({
        acpSessionId: config.acpSessionId,
        promptId,
        phase,
        lastTurnEndReason: options.lastTurnEndReason,
      }),
    );
  };

  const emitBackgroundTasks = (tasks: Array<Record<string, unknown>>): void => {
    handlers.onAcpMessage?.("inbound", {
      jsonrpc: "2.0",
      method: "_claude/backgroundTasks",
      params: { sessionId: config.acpSessionId, at: new Date().toISOString(), tasks },
    });
  };

  const emitCodexTurnEndMarker = (reason = "end_turn"): void => {
    try {
      handlers.onSessionUpdate?.(codexTurnEndMarkerNotification(config.acpSessionId, reason));
    } catch {
      // The real client swallows session-update handler errors (client.ts).
    }
  };

  const mock = {
    hasReusableSession: () => true,
    supportsLoadSession: () => false,
    supportsResumeSession: () => false,
    start: async () => {},
    getAgentLifecycleSnapshot: () => ({ running: true }),
    getPermissionStats: () => ({ requested: 0, approved: 0, denied: 0, cancelled: 0 }),
    initializeResult: undefined,
    updateRuntimeOptions: () => {},
    setEventHandlers: (next: CapturedEventHandlers) => {
      Object.assign(handlers, next);
    },
    clearEventHandlers: () => {
      for (const key of Object.keys(handlers)) {
        delete (handlers as Record<string, unknown>)[key];
      }
    },
    hasActivePrompt: () => true,
    requestCancelActivePrompt: async () => {
      cancelCalls += 1;
      cancelBehavior();
      return true;
    },
    cancelActivePrompt: async () => {},
    setSessionMode: async () => {},
    setSessionModel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    close: async () => {},
    waitForSessionUpdatesIdle: async () => {},
    getEffectiveAccountMetadata: () => undefined,

    prompt: (
      _sessionId: string,
      input: PromptInput | string,
      options?: { messageId?: string; promptId?: string },
    ): Promise<PromptResponse> => {
      const text = promptText(input);
      if (text === INJECTED_PROMPT_TEXT) {
        promptCalls.push({
          kind: "injected",
          messageId: options?.messageId,
          promptId: options?.promptId,
        });
        return (
          config.onInjectedPrompt?.(options?.messageId) ?? new Promise<PromptResponse>(() => {})
        );
      }
      promptCalls.push({
        kind: "main",
        messageId: options?.messageId,
        promptId: options?.promptId,
      });
      latestMainPromptId = options?.promptId;
      mainInFlight.resolve();
      return mainRelease.promise;
    },
  };

  return {
    client: mock as unknown as AcpClient,
    promptCalls,
    mainPromptInFlight: mainInFlight.promise,
    emitTurnEndMarker,
    emitSessionUpdate,
    emitPromptLifecycle,
    mainPromptId: () => latestMainPromptId,
    emitBackgroundTasks,
    emitCodexTurnEndMarker,
    resolveMainPrompt: (response) => mainRelease.resolve(response),
    rejectMainPrompt: (error) => mainRelease.reject(error),
    cancelCount: () => cancelCalls,
    setCancelBehavior: (fn) => {
      cancelBehavior = fn;
    },
  };
}

/**
 * Tier-1 recoverable adapter: the cancel nudge settles the withheld prompt with
 * `reason`. Models the deployed adapter's `cancel()`, which resolves the
 * withheld/parked prompt so the turn finalizes through the existing paths.
 */
export function cancelResolvesPrompt(
  control: PathologicalControl,
  reason: PromptResponse["stopReason"] = "end_turn",
): void {
  control.setCancelBehavior(() => control.resolveMainPrompt({ stopReason: reason }));
}

/**
 * brick a147982f — emit how the scripted Claude adapter ends its turn in `mode`
 * ({@link ClaudeAdapterEndMode}). The prompt is NOT settled here.
 */
export function emitClaudeTurnEnd(
  control: PathologicalControl,
  mode: ClaudeAdapterEndMode,
  reason = "end_turn",
): void {
  switch (mode) {
    case "legacy":
      control.emitTurnEndMarker(reason);
      return;
    case "foreign":
      control.emitPromptLifecycle("sdk_idle", { promptId: FOREIGN_PROMPT_ID });
      control.emitPromptLifecycle("completing", {
        promptId: FOREIGN_PROMPT_ID,
        lastTurnEndReason: reason,
      });
      return;
    case "routing-hole":
      control.emitPromptLifecycle("sdk_idle");
      return;
    case "lifecycle":
    case "lost-response":
      control.emitPromptLifecycle("sdk_idle");
      control.emitPromptLifecycle("completing", { lastTurnEndReason: reason });
      return;
  }
}

/**
 * "Never respond, ignores cancel" adapter: the withheld prompt is never settled
 * by the cancel nudge, forcing the C1 tier-2 bound. This is the default, exposed
 * as a named no-op so scenarios read intentionally.
 */
export function neverRespondIgnoresCancel(_control: PathologicalControl): void {
  // Intentionally empty: the default cancel behavior already ignores cancel.
}

function promptText(input: PromptInput | string): string {
  if (typeof input === "string") {
    return input;
  }
  return input.map((block) => (block.type === "text" ? block.text : "")).join("");
}
