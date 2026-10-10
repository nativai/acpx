import type { ConsumptionKind } from "../../session/delivery-consumption.js";
import type { DeliveryEventError, DeliveryPhase } from "../../session/delivery-events.js";

// The owner-exit delivery vocabulary — the WIRE CONTRACT between acpx and
// acpx-ui (brick://53437107 DESIGN §4.1 / KD-3). Three codes, one cause each:
//
//   QUEUE_OWNER_SHUTDOWN         owner exiting while the session is still OPEN
//                                (idle-memory release, TTL, deploy-staleness,
//                                crash, external kill). Never reached the model
//                                → RETRYABLE; acpx-ui re-drives it.
//   SESSION_CLOSED_UNDELIVERED   owner draining because the session is CLOSING.
//                                Never reached the model → DEFINITIVE; the
//                                sender is notified and it is never auto-retried
//                                (a close-caused loss must not be re-driven into
//                                a session that must stay shut — brick://8f3aaa73).
//   ABSORBED_TURN_NEVER_ENDED    injected, containing turn never settled. MAY
//                                have reached the model → never auto-resend.
//
// The overloaded single code was *the* class-C defect: acpx minted it believing
// acpx-ui would re-drive, acpx-ui buried it as a definitive give-up, and 48/48
// items permanently failed. Splitting the cause is what reconciles the two.
//
// These constants, their exact texts, and the quiesce rejection below are
// mirrored in `test/fixtures/delivery-contract.fixture.json`, which acpx-ui
// vendors byte-identically. Change one and the paired suites go red — that is
// the point (TESTER-PLAN L3.1).
export const QUEUE_OWNER_SHUTDOWN_DETAIL_CODE = "QUEUE_OWNER_SHUTDOWN";
export const SESSION_CLOSED_UNDELIVERED_DETAIL_CODE = "SESSION_CLOSED_UNDELIVERED";
export const ABSORBED_TURN_NEVER_ENDED_DETAIL_CODE = "ABSORBED_TURN_NEVER_ENDED";

// Byte-identical to the text this code has carried since C4/G3 — 48 fleet items
// and acpx-ui's substring backstops key off it. Do not reword.
export const QUEUE_OWNER_SHUTDOWN_MESSAGE = "Queue owner shut down before the message was accepted";

// Contains the lower-case substring `session closed`, which is what acpx-ui's
// `isDefinitiveGiveUp` matches (`reason.includes('session closed')`). Deliberately
// distinct from acpx-ui's own invented `session closed before delivery completed`
// so an owner-WITNESSED terminal stays forensically separable from an
// acpx-ui-INFERRED one (DESIGN §5.3 / corollary C-3).
export const SESSION_CLOSED_UNDELIVERED_MESSAGE =
  "session closed before the message reached the agent — it was never delivered";

export const ABSORBED_TURN_NEVER_ENDED_MESSAGE =
  "delivery outcome unknown — the message may have been processed";

// 71fdcaf2 (S5.4) — the OWNER-witnessed terminal for a delivery whose turn a session CLOSE cancelled. It is
// written when a delivery's turn is CANCELLED while this owner is draining for a session close: the message reached
// the agent, the turn never settled, and the sender must be told "outcome unknown — do not resend". Before this it
// ended a code-less `cancelled`, and acpx-ui's sender notice fires only on `failed` + a code.
//
// ⚠️ A DISTINCT CODE FROM acpx-ui's `SESSION_CLOSED_ACCEPTED_UNSETTLED`, ON PURPOSE (DESIGN corollary C-3): that
// one is what acpx-ui INFERS for an owner that died without writing a terminal; this one is what the owner
// WITNESSED. They must stay separable by code, forever, or the residual-rate metric (DESIGN §5.3) cannot tell
// "the system that lost it said so" from "we guessed afterwards". acpx-ui classifies both identically.
// Contains the lower-case substring `session closed` (acpx-ui's pre-code backstop).
export const SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE = "SESSION_CLOSED_TURN_CANCELLED";
// ONE line on purpose: test/delivery-contract-single-source.test.ts (T11c) finds a contracted message by a verbatim
// substring, and says itself that it cannot see one reassembled by concatenation.
export const SESSION_CLOSED_TURN_CANCELLED_MESSAGE =
  "session closed while the accepted turn was running — the turn was cancelled; outcome unknown, the message may have been processed";
// brick a147982f (X5) — the C1 turn watchdog's tier-1 cancel stopped a turn that was STILL PRODUCING
// OUTPUT after the signal that armed it. The message reached the agent and part of the work may have
// happened, so it is `failed` and not resend-safe: same family as the runtime's TURN_RESPONSE_TIMEOUT. A
// tier-1 cancel that only settled an already-ended turn is NOT this — that one is a `done` carrying
// `recoveredBy: "turn-watchdog"`. Not in test/fixtures/delivery-contract.fixture.json, deliberately: that
// fixture contracts the owner-exit and turn-start terminals only. Must not contain `session closed`.
// ONE line on purpose (T11c finds contracted messages by verbatim substring).
export const TURN_WATCHDOG_CANCELLED_DETAIL_CODE = "TURN_WATCHDOG_CANCELLED";
export const TURN_WATCHDOG_CANCELLED_MESSAGE =
  "the turn watchdog stopped this turn while the agent was still working — part of the work may have happened; check the transcript before re-sending";
// brick://b8e251eb — the owner ACCEPTED the task but its turn never started
// (a non-transient failure before the prompt was submitted). Never reached the
// model → a resend is safe; DEFINITIVE, because the failure is not known to clear
// on its own, so acpx-ui must not auto re-drive it for its whole retry ceiling.
// Contracted in the fixture's `turnStartTerminals`. The emitted message is this
// text as a PREFIX: `${QUEUE_TURN_START_FAILED_MESSAGE}: <ErrorClass>: <detail>`.
// It must not contain `session closed` / `session is closed`, which would make
// acpx-ui's substring backstops classify it as a close.
export const QUEUE_TURN_START_FAILED_DETAIL_CODE = "QUEUE_TURN_START_FAILED";
export const QUEUE_TURN_START_FAILED_MESSAGE =
  "the turn never started — the message did not reach the agent";

// Why the owner is writing an exit terminal. `session-close` is reachable only
// through the drain verb, which carries `reason:'session-close'`; every other
// death — including the signal path — is `owner-exit`.
//
// THE INVARIANT, STATED HONESTLY: the `owner-exit` default is correct whenever the
// owner WAS TOLD the session is closing, and the quiesce flag guarantees it was
// told on every path except one — `--no-drain`, where the operator has explicitly
// opted out of telling it (DESIGN §12 E5 covers the rest).
//
// `--no-drain` IS THE BOUNDARY OF THAT INVARIANT, NOT A COUNTEREXAMPLE TO BE
// ELIMINATED. On that path the owner is killed from outside and the session record
// STILL SAYS OPEN — `closeSession` stamps `closed:true` AFTER it terminates the
// owner — so `QUEUE_OWNER_SHUTDOWN` (owner exiting, session open, retryable) is
// what the owner actually witnessed. Emitting `SESSION_CLOSED_UNDELIVERED` there
// would be the owner asserting a fact nobody told it and that its own view of the
// record contradicts, which is the same fabrication this whole program exists to
// remove (see `warnUndeliveredCustody` for the same rule applied to CLI output).
//
// It is also the SAFE direction to be wrong in: retryable causes a re-drive that
// meets the closed-record refusal (`runtime.ts`), gets an honest definitive
// terminal, and self-corrects at the cost of one wasted retry. The opposite error
// would bury a message that was still deliverable.
//
// DO NOT "FIX" THIS BY SETTING THE CAUSE ON THE CLI SIDE. It is POSSIBLE — and it
// is still wrong. Those are two separate claims and only the second one matters.
//
// POSSIBLE, because a second live channel does reach the owner on exactly this
// path: `closeSession` calls `tryCloseSessionOnRunningOwner` unconditionally,
// right after the drain's early return, and the owner handles `close_session` as
// a control verb (`ipc-server.ts`) before anything terminates it. That verb
// carries no cause today, but it could be taught to.
//   (An earlier revision of this comment said "impossible". It was wrong, and
//   falsifiable in one grep. A do-not-change comment whose stated reason a reader
//   can disprove invites discarding the whole comment — including the part that
//   is load-bearing and correct. Hence this rewrite.)
//
// WRONG, because reachability was never the constraint — honest reporting is.
// `drainCause` records what the owner WITNESSED. Setting it from the CLI on a
// path where nobody told the owner anything would make it assert a cause it did
// not observe and that its own view of the record contradicts. The only verb that
// legitimately tells it is the drain, which is exactly what `--no-drain` opts out
// of. If you want the owner to report a close, TELL it — do not have someone else
// write the answer on its behalf.
export type OwnerExitCause = "session-close" | "owner-exit";

export function ownerExitDeliveryError(cause: OwnerExitCause): DeliveryEventError {
  return cause === "session-close"
    ? {
        code: 0,
        message: SESSION_CLOSED_UNDELIVERED_MESSAGE,
        detailCode: SESSION_CLOSED_UNDELIVERED_DETAIL_CODE,
      }
    : {
        code: 0,
        message: QUEUE_OWNER_SHUTDOWN_MESSAGE,
        detailCode: QUEUE_OWNER_SHUTDOWN_DETAIL_CODE,
      };
}

// KD-4 — the quiesce rejection a `submit_prompt` gets at a draining owner.
//
// The wording is NOT cosmetic. acpx-ui's `isTerminalEnqueueFailure` lower-cases
// the failure text and substring-matches `session is closed`, so ALREADY-DEPLOYED
// acpx-ui classifies this rejection as terminal with zero acpx-ui changes — which
// is the whole reason acpx can ship the barrier first. Reword it and that
// classification silently reverts to "retry a dying owner forever".
export const QUEUE_OWNER_CLOSING_DETAIL_CODE = "QUEUE_OWNER_CLOSING";
export const QUEUE_OWNER_CLOSING_MESSAGE =
  "Session is closed — the queue owner is draining for close and is not accepting new messages.";

// brick e09628a1 (R-CONSUMED, CONCEPTION §5) — the NON-FAILING NOTE on a `done` written at a cut for a message
// the model had already consumed (`src/session/delivery-consumption.ts`). Its `detailCode` keeps the code the
// cut would otherwise have written, so the stream still says what cut the turn (crash census, C-3 forensics);
// acpx-ui stores the message as `attempt.error` on a `done` and never reads it as a failure (4ec33f59).
// Contracted in `test/fixtures/delivery-consumption.fixture.json` (`note.prefix`), which acpx-ui vendors.
// Neither the prefix nor any cause below may contain `session closed` / `session is closed`: acpx-ui's
// substring backstops would read the note as a close.
export const CONSUMED_BEFORE_CUT_NOTE = "consumed by the model before its turn was cut";
export const CONSUMED_CUT_BY_OWNER_EXIT = "the queue owner exited while the turn was still open";
export const CONSUMED_CUT_BY_SESSION_CLOSE = "the session was closed mid-turn";
export const CONSUMED_CUT_BY_CANCEL = "the turn was cancelled";
export const CONSUMED_CUT_BY_TURN_ERROR = "the turn ended with an error";

export function consumedBeforeCutNote(cause: string, detailCode: string): DeliveryEventError {
  return { code: 0, message: `${CONSUMED_BEFORE_CUT_NOTE}: ${cause}`, detailCode };
}

/**
 * The note for a cut delivery the model already CONSUMED — write `done` / `consumed_before_cut` with it — or
 * `undefined`: write the cut's own terminal unchanged (CONCEPTION §5.2).
 *
 *  - Only a cut (`failed` / `cancelled`) of a CONSUMED message changes; a `done` is the turn's own end.
 *  - A steer flips on every cut: its delivery never depended on the containing turn finishing.
 *  - A MAIN prompt flips ONLY while the owner is draining for a session close. ⚠️ DO NOT widen this to every
 *    cut "for symmetry": a watchdog cut, an owner death or an adapter crash leaves the session open with
 *    nobody continuing the work, and the failed outcome-unknown record and its sender notice are what tell a
 *    delegating sender its report is never coming (a147982f). `test/delivery-consumption.test.ts` pins it.
 */
type ConsumedCutInput = {
  kind: ConsumptionKind | undefined;
  consumed: boolean;
  phase: Exclude<DeliveryPhase, "accepted">;
  error?: DeliveryEventError;
  closeDrainActive: boolean;
};

function consumedCutFlips(input: ConsumedCutInput): boolean {
  const cut = input.phase === "failed" || input.phase === "cancelled";
  if (!input.consumed || !cut || input.kind === undefined) {
    return false;
  }
  return input.kind === "steer" || input.closeDrainActive;
}

// The cut the runtime's choke point turns into SESSION_CLOSED_TURN_CANCELLED: a cancel, or a watchdog cut,
// while the owner drains for a session close.
function isCloseCancel(input: ConsumedCutInput): boolean {
  const watchdogCut = input.error?.detailCode === TURN_WATCHDOG_CANCELLED_DETAIL_CODE;
  return input.closeDrainActive && (input.phase === "cancelled" || watchdogCut);
}

function consumedCutCause(input: ConsumedCutInput): { cause: string; detailCode: string } {
  if (isCloseCancel(input)) {
    return {
      cause: CONSUMED_CUT_BY_SESSION_CLOSE,
      detailCode: SESSION_CLOSED_TURN_CANCELLED_DETAIL_CODE,
    };
  }
  if (input.phase === "cancelled") {
    return { cause: CONSUMED_CUT_BY_CANCEL, detailCode: "" };
  }
  const code = input.error?.detailCode ?? "";
  return {
    cause: code ? `${CONSUMED_CUT_BY_TURN_ERROR} (${code})` : CONSUMED_CUT_BY_TURN_ERROR,
    detailCode: code,
  };
}

export function consumedCutNote(input: ConsumedCutInput): DeliveryEventError | undefined {
  if (!consumedCutFlips(input)) {
    return undefined;
  }
  const { cause, detailCode } = consumedCutCause(input);
  return consumedBeforeCutNote(cause, detailCode);
}
