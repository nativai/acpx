import { NO_ANSWER_IN_TIME, type AtriumExchange } from "./atrium-exchange.js";
import type { OutputMode } from "./command-classes.js";
import { podMode, thisPodFile } from "./placement.js";

/**
 * The call-home client of an agent pod (CONTRACTS-r4 C6.1, C7.2; brick 7eb9686f). Node builtins and
 * `atrium-exchange.ts` only: it runs from `src/cli.ts`'s light graph, before acpx loads the world.
 *
 * C6.1: a client in an agent pod treats the forwarder's `503 {"error":"atrium-away"}` and a failed
 * connection ALIKE — retry with back-off for the call-home budget, 600 s (a control-pod restart
 * leaves devbox without atrium for ~300 s, G12.28) — then fail loudly. No client falls back to a
 * local owner or a local create. A `403` is final: a refusal is a security signal, never retried.
 *
 * At most once (C6.2): a request that was SENT is never re-sent by this loop. The only retried
 * exchanges are the ones where nothing was accepted (no connection, or a 503), plus — when the
 * caller proves the request idempotent by an id and offers a `settle` question — a send whose answer
 * never came and which atrium says it does not know.
 */

/** The call-home budget (C6.1). One named constant. */
export const CALL_HOME_BUDGET_MS = 600_000;
/** The back-off between attempts: a 503 carries its own `Retry-After` (5 s). */
const RETRY_START_MS = 1_000;
const RETRY_CAP_MS = 5_000;
/** What the answer wait adds to the call's own deadline (the server's child may use all of it). */
const ANSWER_SLACK_MS = 15_000;
/** The pass-through's own deadline, the contract's maximum (C6.2). */
export const PASS_THROUGH_DEADLINE_MS = 60_000;

/**
 * ⚠️ THE ONLY WAY TO COMPRESS THE BUDGET, and honoured ONLY under a NON-EMPTY `NODE_TEST_CONTEXT`
 * (`node --test` sets it; `""` does not count — the same rule as the `ACPX_POD_TEST_HOME` seam). In
 * production the budget is {@link CALL_HOME_BUDGET_MS}, whatever the environment says. Held by
 * `test/pod-call-home.test.ts` ("the budget override is honoured only under NODE_TEST_CONTEXT").
 */
function testOverride(env: NodeJS.ProcessEnv, name: string): number | undefined {
  if ((env.NODE_TEST_CONTEXT ?? "") === "") {
    return undefined;
  }
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function callHomeBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return testOverride(env, "ACPX_CALL_HOME_BUDGET_MS") ?? CALL_HOME_BUDGET_MS;
}

/** The pause between attempts, test-compressible the same way. */
function retryIntervalMs(env: NodeJS.ProcessEnv, attempt: number, retryAfterS?: number): number {
  const fixed = testOverride(env, "ACPX_CALL_HOME_RETRY_MS");
  if (fixed !== undefined) {
    return fixed;
  }
  return retryAfterS === undefined
    ? Math.min(RETRY_START_MS * 2 ** Math.min(attempt, 8), RETRY_CAP_MS)
    : retryAfterS * 1000;
}

export function callHomeAnswerTimeoutMs(
  deadlineMs: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return testOverride(env, "ACPX_CALL_HOME_ANSWER_TIMEOUT_MS") ?? deadlineMs + ANSWER_SLACK_MS;
}

export type CallHomeOutcome =
  /** Atrium answered with anything but a 503 (a 403 and a 4xx included — the caller reports it). */
  | { kind: "answered"; status: number; body: unknown; attempts: number }
  /** Nothing was accepted for the whole budget: nothing started (C7.2 `atrium_away`). */
  | { kind: "away"; waitedMs: number; attempts: number }
  /** The request was sent and its answer never came (C7.2 `CALL_HOME outcome=unknown`). */
  | { kind: "unknown"; reason: "deadline" | "connection"; attempts: number };

/** What `settle` says about a send whose answer never came. */
export type Settled = { kind: "answered"; status: number; body: unknown } | { kind: "retry" };

export type CallHomeParams = {
  /** One attempt: the POST (or whatever this call is). */
  send: () => Promise<AtriumExchange>;
  /**
   * ONLY for a send idempotent by an id the caller minted (a message's `delivery_id`): called after a
   * `no-answer`; `answered` ends the call with that answer, `retry` sends again. Absent: a
   * `no-answer` is `unknown` and is never re-sent.
   */
  settle?: () => Promise<Settled>;
  budgetMs?: number;
  /** Injectable clock and sleeper: a unit test compresses 600 s to nothing without touching env. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Step = { kind: "done"; outcome: CallHomeOutcome } | { kind: "retry"; retryAfterS?: number };

/** What one exchange means for the loop: an answer ends it, nothing-accepted retries, a sent-and-silent send is unknown. */
async function stepOf(
  exchange: AtriumExchange,
  params: CallHomeParams,
  attempts: number,
): Promise<Step> {
  const answered = (status: number, body: unknown): Step => ({
    kind: "done",
    outcome: { kind: "answered", status, body, attempts },
  });
  if (exchange.kind === "response") {
    return exchange.status === 503
      ? {
          kind: "retry",
          ...(exchange.retryAfterS === undefined ? {} : { retryAfterS: exchange.retryAfterS }),
        }
      : answered(exchange.status, exchange.body);
  }
  if (exchange.kind === "connect-failure") {
    return { kind: "retry" };
  }
  if (!params.settle) {
    const reason = exchange.reason === NO_ANSWER_IN_TIME ? "deadline" : "connection";
    return { kind: "done", outcome: { kind: "unknown", reason, attempts } };
  }
  const settled = await params.settle();
  return settled.kind === "answered" ? answered(settled.status, settled.body) : { kind: "retry" };
}

export async function callHome(params: CallHomeParams): Promise<CallHomeOutcome> {
  const env = params.env ?? process.env;
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? realSleep;
  const budgetMs = params.budgetMs ?? callHomeBudgetMs(env);
  const startedAt = now();
  for (let attempts = 1; ; attempts += 1) {
    const step = await stepOf(await params.send(), params, attempts);
    if (step.kind === "done") {
      return step.outcome;
    }
    const elapsed = now() - startedAt;
    if (elapsed >= budgetMs) {
      return { kind: "away", waitedMs: elapsed, attempts };
    }
    await sleep(Math.min(retryIntervalMs(env, attempts - 1, step.retryAfterS), budgetMs - elapsed));
  }
}

// ─── where a process is ────────────────────────────────────────────────────────────────────────

/**
 * In an agent pod, in pod mode. `atrium.json` routes NOTHING there (CONTRACTS-r4 C6, brick 7eb9686f):
 * the file says where THIS state home's atrium listens, and an agent pod's state home is not a place
 * that file may steer from; the door is atrium's port 3456 by the origin ladder (`call-home` below).
 */
export function inAgentPod(): boolean {
  return podMode().mode === "pod" && thisPodFile().kind !== "absent";
}

let callHomeMode = false;

/**
 * Set by the `message-route` branch before acpx loads its world: the prompt path then goes to atrium
 * or fails — never to a local owner. ⚠️ Nothing resets it: the process runs one command.
 */
export function enterCallHomeMode(): void {
  callHomeMode = true;
}

export function inCallHomeMode(): boolean {
  return callHomeMode;
}

// ─── the words (C7.2) ──────────────────────────────────────────────────────────────────────────

export type CallHomeFailure = { exitCode: number; lines: [string, string]; json: string };

/** The `retry_after_s` of an `atrium_away` refusal: C7.2 fixes it at 60. */
const AWAY_RETRY_AFTER_S = 60;
const UNKNOWN_EXIT_CODE = 1;
export const ATRIUM_AWAY_EXIT_CODE = 75;

function jsonRpcError(
  code: number,
  acpxCode: string,
  tokenLine: string,
  message: string,
  fields: Record<string, string | number | boolean>,
  detailCode: string,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: {
      code,
      message,
      data: { acpxCode, detailCode, origin: "cli", retryable: false, tokenLine, ...fields },
    },
  });
}

/** `acpx: REFUSED reason=atrium_away …` — exit 75, nothing started. */
export function atriumAwayFailure(waitedMs: number): CallHomeFailure {
  const waitedS = Math.round(waitedMs / 1000);
  const tokenLine = `acpx: REFUSED reason=atrium_away nothing_started=true protocol=1 retry_after_s=${AWAY_RETRY_AFTER_S} waited_s=${waitedS}`;
  const sentence = `atrium did not answer for ${waitedS} s (the call-home budget); nothing was started, nothing was created or queued, and nothing runs locally in an agent pod. Repeat the command once atrium answers.`;
  return {
    exitCode: ATRIUM_AWAY_EXIT_CODE,
    lines: [tokenLine, sentence],
    // C7.2's refusal family: -32602 / USAGE, as every `acpx: REFUSED` line of the placement step.
    json: jsonRpcError(
      -32602,
      "USAGE",
      tokenLine,
      `${tokenLine}\n${sentence}`,
      {
        reason: "atrium_away",
        nothing_started: true,
        protocol: 1,
        retry_after_s: AWAY_RETRY_AFTER_S,
        waited_s: waitedS,
      },
      "atrium-away",
    ),
  };
}

/**
 * A refusal BY THE DOOR (a 4xx: `400 class-not-passable`, `403 caller-mismatch`, …): final, never
 * retried, nothing started. Not a C7.2 name — the contract names none for it — so it is
 * `reason=pass_through_refused` with the status and atrium's own `error` word (reported to the stream).
 */
export function doorRefusedFailure(
  status: number,
  errorWord: unknown,
  detail: unknown,
): CallHomeFailure {
  const error = typeof errorWord === "string" ? errorWord : `http-${status}`;
  const extra = typeof detail === "string" ? ` detail=${detail}` : "";
  const tokenLine = `acpx: REFUSED reason=pass_through_refused nothing_started=true protocol=1 status=${status} error=${error}${extra}`;
  const sentence = `atrium refused the passed-through command (HTTP ${status} ${error}); nothing was started and nothing runs locally in an agent pod.`;
  return {
    exitCode: 2,
    lines: [tokenLine, sentence],
    json: jsonRpcError(
      -32602,
      "USAGE",
      tokenLine,
      `${tokenLine}\n${sentence}`,
      { reason: "pass_through_refused", nothing_started: true, protocol: 1, status, error },
      "pass-through-refused",
    ),
  };
}

/** `acpx: CALL_HOME outcome=unknown …` — exit 1; the caller repeats it with the same ids. */
export function callHomeUnknownFailure(
  reason: "deadline" | "connection",
  callId: string,
  /** The record id a create was sent under (the client minted it): a repeat names it. */
  recordId?: string,
): CallHomeFailure {
  const tokenLine = `acpx: CALL_HOME outcome=unknown reason=${reason} call_id=${callId}`;
  const sentence =
    "the call was sent to atrium and its answer never came, so it may or may not have run; repeat the command with the same record id or call id and atrium finds what the first attempt made" +
    (recordId === undefined ? "." : ` (this call created under --record-id ${recordId}).`);
  return {
    exitCode: UNKNOWN_EXIT_CODE,
    lines: [tokenLine, sentence],
    json: jsonRpcError(
      -32603,
      "RUNTIME",
      tokenLine,
      `${tokenLine}\n${sentence}`,
      {
        outcome: "unknown",
        reason,
        call_id: callId,
        ...(recordId === undefined ? {} : { record_id: recordId }),
      },
      "call-home-unknown",
    ),
  };
}

/** Text: both lines on stderr. JSON: the error on stdout AND line 1 on stderr. `--json-strict`: stdout only. */
export function emitCallHomeFailure(
  failure: CallHomeFailure,
  output: OutputMode,
  write: (line: string) => void,
  writeStdout: (line: string) => void,
): void {
  if (output !== "text") {
    writeStdout(failure.json);
  }
  const stderr = output === "text" ? failure.lines : output === "json" ? [failure.lines[0]] : [];
  for (const line of stderr) {
    write(line);
  }
}
