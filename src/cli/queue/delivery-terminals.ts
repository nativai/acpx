import type { DeliveryEventError } from "../../session/delivery-events.js";

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
