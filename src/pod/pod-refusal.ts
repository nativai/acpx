import { capacityRefusal } from "../capacity/admission.js";
import { AcpxOperationalError, CapacityRefusedError } from "../errors.js";

/**
 * C7.2 — the two refusal lines of the pod plane, in the wire format every capacity refusal has:
 * exit 75, first stderr line the machine token, second line one plain sentence. Atrium's
 * `capacityRefusalToken.ts` reads the first line: its shape is public.
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
  wake: string;
  sessionId?: string;
  seatId?: string | null;
}): CapacityRefusedError {
  const retryAfterS = podStartingRetryAfterS(input.phase);
  const tokenLine =
    `acpx: REFUSED reason=pod_starting nothing_started=true protocol=1 ` +
    `retry_after_s=${retryAfterS} phase=${input.phase} wake=${input.wake}`;
  const sentence =
    `acpx: the session's agent pod ${PHASE_SENTENCE[input.phase]}. Nothing was run; the message is ` +
    `delivered when the pod is ready — retry in ${retryAfterS} s.`;
  return new CapacityRefusedError({
    tokenLine,
    sentence,
    detail: {
      reason: "pod_starting",
      nothingStarted: true,
      retryAfterS,
      queuedAhead: 0,
      message: sentence,
      wake: { sessionId: input.sessionId ?? input.wake, seatId: input.seatId ?? null },
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
  const sentence =
    `acpx: no agent pod can be started on this box now (${input.live} of ${input.cap} in use; ` +
    `${input.why}). Nothing was started; it is delivered when room frees — retry in ` +
    `${AGENT_CAP_RETRY_AFTER_S} s.`;
  return new CapacityRefusedError({
    tokenLine,
    sentence,
    detail: {
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

/** The existing line, for "the broker or the API server did not answer" (C2 table). */
export function admissionBusyRefusal(): CapacityRefusedError {
  return capacityRefusal("admission_busy");
}

/**
 * Exit 1; the FIRST stderr line is `acpx: ROUTED outcome=… call_id=…` (C2) — the atrium server
 * reads `outcome=unknown` as "retry with the same message id". `stderrLine` keeps it on stderr in
 * json mode too, as `CapacityRefusedError` does.
 */
export class RoutedCallError extends AcpxOperationalError {
  readonly stderrLine: string;
  readonly outcome: "not_run" | "unknown";
  readonly reason: string;
  readonly callId: string;

  constructor(params: { outcome: "not_run" | "unknown"; reason: string; callId: string }) {
    const line = `acpx: ROUTED outcome=${params.outcome} reason=${params.reason} call_id=${params.callId}`;
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
  }
}
