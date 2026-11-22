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
      : `acpx: the session's agent pod ${PHASE_SENTENCE[input.phase]}. Nothing was run; the message ` +
        `stays queued and is delivered when the pod is ready.`;
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
      ...(input.wake === undefined
        ? {}
        : { wake: { sessionId: input.sessionId ?? input.wake, seatId: input.seatId ?? null } }),
      pod: { phase: input.phase },
    },
  });
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
  const state = `${input.live} of ${input.cap} in use; ${input.why}`;
  // `waiting-line` is a CREATE's refusal only (C7.2): no message waits and nothing was created.
  const sentence =
    input.why === "waiting-line"
      ? `acpx: the box's line of sessions waiting for a pod is full (${state}). Nothing was created; try again in a minute.`
      : input.wake === undefined
        ? `acpx: the box's utility pod cannot be started now (${state}). Nothing was started; this is not available right now.`
        : `acpx: no agent pod can be started on this box now (${state}). Nothing was started; the message stays queued until room frees.`;
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
      "Nothing was started; the message stays queued and is delivered when they answer.";
  return new CapacityRefusedError({
    tokenLine: base.stderrLine,
    sentence,
    detail: { ...base.capacityRefusal, tokenLine: base.stderrLine, message: sentence },
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
