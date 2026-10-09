import { TimeoutError, withTimeout } from "../../async-control.js";
import { hasAgentReplyAfterPrompt } from "../../session/conversation-model.js";
import type { PromptInput, RunPromptResult, SessionConversation } from "../../types.js";

const SESSION_REPLY_IDLE_MS = 1_000;
const SESSION_REPLY_DRAIN_TIMEOUT_MS = 5_000;

type PromptTurnClient = {
  prompt: (
    sessionId: string,
    prompt: PromptInput | string,
    options?: { messageId?: string; turnContext?: boolean; promptId?: string },
  ) => Promise<{ stopReason: RunPromptResult["stopReason"]; _meta?: unknown }>;
  waitForSessionUpdatesIdle?: (options?: { idleMs?: number; timeoutMs?: number }) => Promise<void>;
};

/**
 * brick 4ec33f59 — the failure a HARD-FAILED turn reports OUT OF BAND.
 *
 * The ACP wire `StopReason` union has no `"error"` member — it is
 * `end_turn | max_tokens | max_turn_requests | refusal | cancelled`. So an
 * adapter whose turn failed hard CANNOT say so in the stop reason: it must stop
 * `end_turn` and state the failure elsewhere. The nativai `pi-acp` fork states
 * it on `_meta.piAcp.turnError` (18 occurrences in the deployed bundle).
 *
 * Without this read the failure reaches nobody: the turn settles `completed`,
 * the delivery terminal carries `EMPTY_DELIVERY_ERROR`, and acpx-ui renders a
 * CLEAN SUCCESS for a turn that failed. acpx-ui's receiving half is already
 * deployed (`32a8f11b`) and carries a NON-EMPTY message to the sender's
 * transcript bubble — it is inert until this value arrives.
 *
 * Same shape and discipline as `advertisedServedEffort`'s read of the sibling
 * `_meta.piAcp.servedEffort`: absent, empty or ill-typed ⇒ `undefined`, never a
 * substituted value. **The emptiness check is load-bearing, not defensive
 * tidiness — see the caller in `cli/session/runtime.ts`.**
 */
export function turnErrorFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const value = (meta as { piAcp?: { turnError?: unknown } }).piAcp?.turnError;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * brick ddd76838 — the STEER-ACK the adapter reports OUT OF BAND.
 *
 * The nativai `pi-acp` fork acks a mid-turn steer with an instant `end_turn`
 * PLUS `_meta.piAcp.steered` (the machine contract that prevents auto-resends).
 * Without reading that flag here, the delivery terminal records a bare
 * `end_turn` and an observer cannot tell an absorbed steer from a completed
 * turn of its own. Same shape and discipline as {@link turnErrorFromMeta}:
 * absent / ill-typed ⇒ `false`, never a substituted value.
 */
export function steeredFromMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== "object") {
    return false;
  }
  return (meta as { piAcp?: { steered?: unknown } }).piAcp?.steered === true;
}

/**
 * Wait for late `session/update` notifications to go quiet, best effort.
 *
 * Both legs of {@link runPromptTurn} drain identically — the success leg keeps its
 * stop reason if the drain times out, the timeout leg falls back to the prompt
 * error — so a single call site is what keeps the two from drifting apart. The
 * `.catch` is deliberately empty in both: a drain that times out is not itself a
 * failure of the turn.
 */
async function drainLateSessionUpdates(client: PromptTurnClient): Promise<void> {
  await client
    .waitForSessionUpdatesIdle?.({
      idleMs: SESSION_REPLY_IDLE_MS,
      timeoutMs: SESSION_REPLY_DRAIN_TIMEOUT_MS,
    })
    .catch(() => {});
}

type RpcTurnResult = {
  stopReason: RunPromptResult["stopReason"];
  source: "rpc";
  turnError?: string;
  steered?: boolean;
};

/**
 * The success leg of {@link runPromptTurn}, after the `session/prompt` response arrived: report it to
 * `onPromptResponse` FIRST (synchronously, brick 570d2570 C3), then drain late updates, then read the out-of-band
 * flags. Its own function so `runPromptTurn` stays inside the complexity budget.
 */
async function settleRpcResponse(
  params: {
    client: PromptTurnClient;
    onPromptResponse?: (response: {
      stopReason: RunPromptResult["stopReason"];
      _meta?: unknown;
    }) => void;
  },
  response: { stopReason: RunPromptResult["stopReason"]; _meta?: unknown },
): Promise<RpcTurnResult> {
  params.onPromptResponse?.(response);
  await drainLateSessionUpdates(params.client);
  const turnError = turnErrorFromMeta(response._meta);
  const steered = steeredFromMeta(response._meta);
  return {
    stopReason: response.stopReason,
    source: "rpc",
    ...(turnError !== undefined ? { turnError } : {}),
    ...(steered ? { steered: true } : {}),
  };
}

export async function runPromptTurn(params: {
  client: PromptTurnClient;
  sessionId: string;
  prompt: PromptInput | string;
  timeoutMs?: number;
  conversation: SessionConversation;
  promptMessageId?: string;
  messageId?: string;
  /** brick a147982f — forwarded as `AcpPromptOptions.promptId` (`_claude/promptId`). */
  promptId?: string;
  onPromptStarted?: () => Promise<void> | void;
  /**
   * brick 570d2570 (C3) — called SYNCHRONOUSLY the moment the `session/prompt` response arrives, BEFORE the
   * late-update drain below (which waits for >=1 s of quiet). The runtime records the turn's own end here, so a
   * session close landing during the drain writes that turn's `done` instead of the close's code.
   * ⚠️ Do not move this call below `drainLateSessionUpdates`: that is exactly the second in which the test-engineer
   * measured a finished turn getting the close's code (570d2570 VERIFICATION C3).
   */
  onPromptResponse?: (response: {
    stopReason: RunPromptResult["stopReason"];
    _meta?: unknown;
  }) => void;
}): Promise<{
  stopReason: RunPromptResult["stopReason"];
  source: "rpc" | "session";
  turnError?: string;
  steered?: boolean;
}> {
  try {
    // ⚠️ THE ONLY PLACE IN THE CODEBASE THAT OPTS INTO PER-TURN CONTEXT INJECTION
    // (`src/acp/turn-context.ts`). `runPromptTurn` IS the new-turn path: both the main
    // sequential queue turn and the engine runtime turn reach this line, so one flag covers
    // both. Every other `AcpClient.prompt` caller is excluded by not being touched —
    // specifically the MID-TURN INJECTED prompt (which would double-inject inside a single
    // turn, framing a steer as a fresh turn) and the `runOnce` one-shot path (whose single
    // turn has no previous turn for a delta to be relative to).
    // If a new new-turn path ever appears that does not route through here, it goes
    // UNDECORATED — the deliberate, safe failure direction.
    const promptPromise = params.client.prompt(params.sessionId, params.prompt, {
      messageId: params.messageId,
      turnContext: true,
      promptId: params.promptId,
    });
    await params.onPromptStarted?.();
    return await settleRpcResponse(params, await withTimeout(promptPromise, params.timeoutMs));
  } catch (error) {
    if (!(error instanceof TimeoutError) || !params.promptMessageId) {
      throw error;
    }

    await drainLateSessionUpdates(params.client);

    if (hasAgentReplyAfterPrompt(params.conversation, params.promptMessageId)) {
      return {
        stopReason: "end_turn",
        source: "session",
      };
    }

    throw error;
  }
}
