import { listBuiltInAgents } from "../agent-registry.js";
import { admissionClassDeclared, capacityRefusal } from "../capacity/admission.js";
import { AcpxOperationalError, CapacityRefusedError } from "../errors.js";
import { classifyArgv } from "./command-classes.js";

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
  "unfit",
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
 * A-79 (C7.2 "Whose hold a refusal may promise"): what a refusal's sentence may say after its lead. The builders'
 * DEFAULT promises nothing and names no message (`none`: nothing was run, repeat the command). Two callers add more,
 * through {@link refusalForCaller} and {@link withHoldPromise}: a `prompt` with no holder is told `prompt` (neither
 * queued nor sent, `retry_after_s`, `send-message.sh`), and a caller that DOES hold the message (atrium's delivery
 * spawns, `capacity admit-wake`) gets `hold` — the sentence the refusals had before A-79.
 */
type Promise_ = "none" | "prompt" | "hold";
type PromiseReason = "pod_starting" | "agent_cap" | "admission_busy";
const PROMISES: readonly Promise_[] = ["none", "prompt", "hold"];
const HOLD_TAILS: Record<PromiseReason, string> = {
  pod_starting: "the message stays queued and is delivered when the pod is ready.",
  agent_cap: "the message stays queued until room frees.",
  admission_busy: "the message stays queued and is delivered when they answer.",
};

function tailOf(reason: PromiseReason, promise: Promise_, retryAfterS: number): string {
  if (promise === "hold") {
    return HOLD_TAILS[reason];
  }
  return promise === "prompt"
    ? `the message was NOT queued and NOT sent. Run the same command again in about ${retryAfterS} s; ` +
        `a message that must wait for room goes through atrium (send-message.sh), which holds it.`
    : `repeat the command after about ${retryAfterS} s.`;
}

/**
 * `unfit` (f8078700 C5): the broker answered `too_big` — the pod fits no machine the cluster has now. Held like any
 * start, so atrium's one hold deadline covers it and records the failure where the sender looks; it is NOT final
 * here, because a bigger machine (or a changed request) can heal it. Long, because a wait of seconds does not.
 */
const UNFIT_RETRY_AFTER_S = 300;

/** C7.2: 3 for scheduling, starting, turnover; 15 for pulling (a pull took 43 s); 60 for scaling-up; 300 for unfit. */
export function podStartingRetryAfterS(phase: PodStartingPhase): number {
  if (phase === "unfit") {
    return UNFIT_RETRY_AFTER_S;
  }
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
  unfit: "is too big for any machine the cluster has now",
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
        tailOf("pod_starting", "none", retryAfterS);
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
      ...(input.wake === undefined ? {} : { queued: false }),
      ...(input.wake === undefined
        ? {}
        : { wake: { sessionId: input.sessionId ?? input.wake, seatId: input.seatId ?? null } }),
      pod: { phase: input.phase },
    },
  });
}

/** The sentence of an `agent_cap` refusal, and whether it is a session's (a wake — carries `queued`; never a create's waiting line). */
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
    sentence: `acpx: no agent pod can be started on this box now (${state}). Nothing was started; ${tailOf("agent_cap", "none", AGENT_CAP_RETRY_AFTER_S)}`,
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
      ...(promisesHold ? { queued: false } : {}),
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
      `Nothing was started; ${tailOf("admission_busy", "none", base.capacityRefusal.retryAfterS)}`;
  return new CapacityRefusedError({
    tokenLine: base.stderrLine,
    sentence,
    detail: {
      ...base.capacityRefusal,
      tokenLine: base.stderrLine,
      message: sentence,
      ...(options.utility ? {} : { queued: false }),
    },
  });
}

/**
 * Re-says a session's capacity refusal with another promise. The TOKEN LINE, the exit code, the reason and every
 * other field are untouched, byte for byte — atrium and scripts parse them. Only the sentence, `detail.message` and
 * `detail.queued` change (`queued` is true exactly for `hold`). A refusal that carries no `queued` (a utility
 * pod's, the waiting line's, a non-capacity error) is returned as it is.
 */
function withPromise(error: CapacityRefusedError, promise: Promise_): CapacityRefusedError {
  const detail = error.capacityRefusal;
  const reason = detail.reason as string;
  if (
    detail.queued === undefined ||
    (reason !== "pod_starting" && reason !== "agent_cap" && reason !== "admission_busy")
  ) {
    return error;
  }
  const sentence = error.message.slice(error.stderrLine.length + 1);
  const current = PROMISES.find((candidate) =>
    sentence.endsWith(tailOf(reason, candidate, detail.retryAfterS)),
  );
  if (current === undefined) {
    return error;
  }
  const lead = sentence.slice(
    0,
    sentence.length - tailOf(reason, current, detail.retryAfterS).length,
  );
  const rewritten = lead + tailOf(reason, promise, detail.retryAfterS);
  return new CapacityRefusedError({
    tokenLine: error.stderrLine,
    sentence: rewritten,
    detail: { ...detail, message: rewritten, queued: promise === "hold" },
  });
}

/** `capacity admit-wake` (atrium's pre-admission verb): atrium holds what it is refused, so the hold sentence stands (A-79). */
export function withHoldPromise(error: CapacityRefusedError): CapacityRefusedError {
  return withPromise(error, "hold");
}

/**
 * A-79: whose hold may a refusal promise? Only a `prompt` that carries one of atrium's two marks —
 * `--message-id` (one message) or `--batch-file` (a batch) — WITH the admission class the runner sets
 * (`ACPX_ADMISSION_CLASS`, read once at start): atrium holds that item on the token line and exit 75 and sends it
 * again. A mark passed by hand, without the class, counts for nothing. Every other `prompt` is told: neither
 * queued nor sent, retry after `retry_after_s`, `send-message.sh` holds a message for room. A command that carries
 * no message names none (the builders' default).
 *
 * ONE helper for the two places that print such a refusal: the routed branch's catch (pod mode) and A-16's guard
 * (`turnover-guard.ts`, the switch off). `argv` is the command's own arguments.
 */
export function refusalForCaller(
  error: CapacityRefusedError,
  argv?: readonly string[],
  hasClass?: boolean,
): CapacityRefusedError;
export function refusalForCaller(
  error: unknown,
  argv?: readonly string[],
  hasClass?: boolean,
): unknown;
export function refusalForCaller(
  error: unknown,
  argv: readonly string[] = process.argv.slice(2),
  hasClass: boolean = admissionClassDeclared(),
): unknown {
  if (!(error instanceof CapacityRefusedError)) {
    return error;
  }
  if (!carriesMessage(argv)) {
    return withPromise(error, "none");
  }
  return withPromise(error, hasClass && carriesHoldMark(argv) ? "hold" : "prompt");
}

/** The paths whose command carries a message to a session (`prompt`, and the implicit forms `acpx <agent> <text>`). */
const MESSAGE_PATHS = new Set(["", "<agent>", "prompt"]);

function carriesMessage(argv: readonly string[]): boolean {
  const classified = classifyArgv(argv, { builtInAgents: listBuiltInAgents() });
  return classified.kind === "classified" && MESSAGE_PATHS.has(classified.path);
}

/** `--message-id[=<id>]` or `--batch-file[=<path>]` before any `--`: atrium's two delivery spawn shapes (A-79). */
function carriesHoldMark(argv: readonly string[]): boolean {
  const stop = argv.indexOf("--");
  return argv
    .slice(0, stop >= 0 ? stop : argv.length)
    .some(
      (arg) =>
        arg === "--message-id" ||
        arg.startsWith("--message-id=") ||
        arg === "--batch-file" ||
        arg.startsWith("--batch-file="),
    );
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
