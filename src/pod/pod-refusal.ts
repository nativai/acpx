import { capacityRefusal } from "../capacity/admission.js";
import { AcpxOperationalError, CapacityRefusedError } from "../errors.js";

/**
 * C7.2 — the two refusal lines of the pod plane, in the wire format every capacity refusal has:
 * exit 75, the machine token, and on the next line one plain sentence. Atrium's `capacityRefusalToken.ts`
 * finds the token by its head (`acpx: REFUSED `) and the exit code — never by its place among the stderr
 * lines (A-53): a progress line or a warning may precede it. Its shape is public.
 */

export const POD_STARTING_PHASES = [
  "scheduling",
  "scaling-up",
  "pulling",
  "starting",
  "turnover",
] as const;
export type PodStartingPhase = (typeof POD_STARTING_PHASES)[number];

export const AGENT_CAP_WHYS = [
  "cap",
  "quota",
  "pool-at-maximum",
  "home_full",
  "waiting-line",
] as const;
export type AgentCapWhy = (typeof AGENT_CAP_WHYS)[number];

const AGENT_CAP_RETRY_AFTER_S = 60;

/**
 * The three sentence tails that PROMISE a hold (brick ee9980e3). A promise is true for exactly one caller: atrium's own
 * delivery spawn (`--message-id`), which holds the item on the token line and exit 75. Every other caller of a
 * routed call — a shell on the control pod, an ssh-remote script, a person — has no holder, so
 * {@link withoutQueuePromise} swaps the tail for {@link notQueuedTail} before the refusal is printed.
 */
const POD_STARTING_QUEUED_TAIL = "the message stays queued and is delivered when the pod is ready.";
const AGENT_CAP_QUEUED_TAIL = "the message stays queued until room frees.";
const ADMISSION_BUSY_QUEUED_TAIL = "the message stays queued and is delivered when they answer.";
const QUEUED_TAILS = [
  POD_STARTING_QUEUED_TAIL,
  AGENT_CAP_QUEUED_TAIL,
  ADMISSION_BUSY_QUEUED_TAIL,
] as const;

/** C7.2: 3 for scheduling, starting, turnover; 15 for pulling (a pull took 43 s); 60 for scaling-up. */
export function podStartingRetryAfterS(phase: PodStartingPhase): number {
  if (phase === "pulling") {
    return 15;
  }
  return phase === "scaling-up" ? 60 : 3;
}

const PHASE_SENTENCE: Record<PodStartingPhase, string> = {
  scheduling: "is being placed on a machine",
  "scaling-up": "waits for a machine to be added (about 2 minutes)",
  pulling: "is pulling its image",
  starting: "is starting",
  turnover: "is being replaced by a newer one",
};

export function podStartingRefusal(input: {
  phase: PodStartingPhase;
  /** Absent for a utility pod (A-10): it belongs to no session, so no message waits for it. */
  wake?: string;
  sessionId?: string;
  seatId?: string | null;
}): CapacityRefusedError {
  const retryAfterS = podStartingRetryAfterS(input.phase);
  const tokenLine =
    `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 ` +
    `retry_after_s=${retryAfterS} phase=${input.phase}` +
    (input.wake === undefined ? "" : ` wake=${input.wake}`);
  const sentence =
    input.wake === undefined
      ? `acpx: the box's utility pod ${PHASE_SENTENCE[input.phase]}. Nothing was run; this is not available right now.`
      : `acpx: the session's agent pod ${PHASE_SENTENCE[input.phase]}. Nothing was run; ` +
        POD_STARTING_QUEUED_TAIL;
  return new CapacityRefusedError({
    tokenLine,
    sentence,
    detail: {
      tokenLine,
      reason: "pod_starting",
      nothingStarted: true,
      retryAfterS,
      queuedAhead: 0,
      message: sentence,
      ...(input.wake === undefined ? {} : { queued: true }),
      ...(input.wake === undefined
        ? {}
        : { wake: { sessionId: input.sessionId ?? input.wake, seatId: input.seatId ?? null } }),
      pod: { phase: input.phase },
    },
  });
}

/** The sentence of an `agent_cap` refusal, and whether it promises a hold (a wake, never a create's waiting line). */
function agentCapSentence(input: { live: number; cap: number; why: AgentCapWhy; wake?: string }): {
  sentence: string;
  promisesHold: boolean;
} {
  const state = `${input.live} of ${input.cap} in use; ${input.why}`;
  // `waiting-line` is a CREATE's refusal only (C7.2): no message waits and nothing was created.
  if (input.why === "waiting-line") {
    return {
      sentence: `acpx: the box's line of sessions waiting for a pod is full (${state}). Nothing was created; try again in a minute.`,
      promisesHold: false,
    };
  }
  if (input.wake === undefined) {
    return {
      sentence: `acpx: the box's utility pod cannot be started now (${state}). Nothing was started; this is not available right now.`,
      promisesHold: false,
    };
  }
  return {
    sentence: `acpx: no agent pod can be started on this box now (${state}). Nothing was started; ${AGENT_CAP_QUEUED_TAIL}`,
    promisesHold: true,
  };
}

export function agentCapRefusal(input: {
  live: number;
  cap: number;
  box: string;
  why: AgentCapWhy;
  wake?: string;
  sessionId?: string;
  seatId?: string | null;
}): CapacityRefusedError {
  const tokenLine =
    `acpx: REFUSED reason=agent_cap nothing_started=true protocol=1 ` +
    `retry_after_s=${AGENT_CAP_RETRY_AFTER_S} live=${input.live} cap=${input.cap} ` +
    `box=${input.box} why=${input.why}` +
    (input.wake === undefined ? "" : ` wake=${input.wake}`);
  const { sentence, promisesHold } = agentCapSentence(input);
  return new CapacityRefusedError({
    tokenLine,
    sentence,
    detail: {
      tokenLine,
      reason: "agent_cap",
      nothingStarted: true,
      retryAfterS: AGENT_CAP_RETRY_AFTER_S,
      queuedAhead: 0,
      message: sentence,
      ...(promisesHold ? { queued: true } : {}),
      ...(input.wake === undefined
        ? {}
        : { wake: { sessionId: input.sessionId ?? input.wake, seatId: input.seatId ?? null } }),
      pod: { why: input.why, live: input.live, cap: input.cap, box: input.box },
    },
  });
}

/**
 * The existing token line — byte for byte — for "the broker or the API server did not answer" (C2
 * table), with a sentence that says so: the shared builder's sentence blames the admission lock and
 * says "nothing queued", neither of which is true in the pod plane (TE L-2).
 */
export function admissionBusyRefusal(
  options: { utility?: boolean; queuedAhead?: number } = {},
): CapacityRefusedError {
  // `queued_ahead=` is the real count of items waiting, as on the box (A9 TE K3): the JSON said it already.
  const base = capacityRefusal("admission_busy", undefined, options.queuedAhead ?? 0);
  // A utility pod belongs to no session and no message waits for it (A-10): its sentence says so.
  const sentence = options.utility
    ? "acpx: the broker or the Kubernetes API server did not answer, so the box's utility pod could not be checked or started. " +
      "Nothing was started; this is not available right now."
    : "acpx: the broker or the Kubernetes API server did not answer, so the session's agent pod could not be checked or started. " +
      `Nothing was started; ${ADMISSION_BUSY_QUEUED_TAIL}`;
  return new CapacityRefusedError({
    tokenLine: base.stderrLine,
    sentence,
    detail: {
      ...base.capacityRefusal,
      tokenLine: base.stderrLine,
      message: sentence,
      ...(options.utility ? {} : { queued: true }),
    },
  });
}

/**
 * brick ee9980e3 (C7.2 sentence rule): a refusal whose sentence promises a hold ("the message stays queued …",
 * `detail.queued === true`) is true only when atrium's delivery runner is the caller — it holds the item on
 * the token line and exit 75, under the message id it passed (`--message-id`). For ANY other caller nothing
 * holds the message, so the promise is replaced by the plain fact: NOT queued, NOT sent, how to retry.
 *
 * The TOKEN LINE, the exit code, the reason and every other field are untouched, byte for byte — atrium and
 * scripts parse them. Only the sentence and `detail.message` change, and `detail.queued` becomes `false`.
 * A refusal that promises nothing (a utility pod, the waiting line, a non-capacity error) is returned as it is.
 */
export function withoutQueuePromise(error: unknown, call: { prompt: boolean }): unknown {
  if (!(error instanceof CapacityRefusedError) || error.capacityRefusal.queued !== true) {
    return error;
  }
  const detail = error.capacityRefusal;
  const sentence = error.message.slice(error.stderrLine.length + 1);
  const tail = QUEUED_TAILS.find((candidate) => sentence.endsWith(candidate));
  if (tail === undefined) {
    return error;
  }
  const what = call.prompt ? "message" : "call";
  const retry = detail.retryAfterS;
  const rewritten =
    sentence.slice(0, sentence.length - tail.length) +
    `the ${what} was NOT queued and NOT sent. Run the same command again in about ${retry} s; ` +
    `a message that must wait for room goes through atrium (send-message.sh), which holds it.`;
  return new CapacityRefusedError({
    tokenLine: error.stderrLine,
    sentence: rewritten,
    detail: { ...detail, message: rewritten, queued: false },
  });
}

/**
 * Exit 1; the token is the line beginning `acpx: ROUTED outcome=… call_id=…` (C2, found by its head and the
 * exit code — A-53, not by its place) — the atrium server reads `outcome=unknown` as "retry with the same message id". `stderrLine` keeps it on stderr in
 * json mode too, as `CapacityRefusedError` does.
 */
export class RoutedCallError extends AcpxOperationalError {
  readonly stderrLine: string;
  readonly outcome: "not_run" | "unknown";
  readonly reason: string;
  readonly callId: string;
  readonly tool: string | undefined;

  constructor(params: {
    outcome: "not_run" | "unknown";
    reason: string;
    callId: string;
    /** `release_unresolved` only (C9): the tool whose link could not be resolved. */
    tool?: string;
  }) {
    const tool = params.tool === undefined ? "" : ` tool=${params.tool}`;
    const line = `acpx: ROUTED outcome=${params.outcome} reason=${params.reason}${tool} call_id=${params.callId}`;
    super(line, {
      outputCode: "RUNTIME",
      detailCode: `routed-${params.outcome}`,
      origin: "cli",
      retryable: params.outcome === "unknown",
    });
    this.stderrLine = line;
    this.outcome = params.outcome;
    this.reason = params.reason;
    this.callId = params.callId;
    this.tool = params.tool;
  }
}
