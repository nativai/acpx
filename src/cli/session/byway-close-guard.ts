import { isBywaySessionRecord } from "../../session/byway.js";
import type { SessionRecord } from "../../types.js";
import { resolveLedgerCaller } from "../message-ledger.js";

export const BYWAY_CLOSE_REFUSED = "BYWAY_CLOSE_REFUSED";

/**
 * The variables acpx sets on every AGENT it runs — and EXACTLY the set atrium strips before it
 * spawns acpx (`isCallerIdentityVar`, acpx-ui `server/promptChildEnv.ts`). That symmetry is the
 * whole mechanism: atrium's own UI close (`runAcpx` → `sessions close --session-id`) reaches this
 * guard with none of them and is never refused, with no flag and no server change (D5/D7).
 *
 * ⚠️ DO NOT REPLACE THIS WITH `resolveLedgerCaller() !== undefined`. That needs a PARSEABLE session
 * id, so an agent whose `ACPX_SESSION_URL` is in an odd form — or which carries only
 * `ACPX_SEAT_URL` — would read as a human and the guard would fail OPEN. Presence of ANY of the
 * three is an agent. Both shapes are negative cases in `test/byway-guard.test.ts`.
 */
const AGENT_IDENTITY_VARS = [
  "ACPX_SESSION_URL",
  "ACPX_SESSION_RECORD_ID",
  "ACPX_SEAT_URL",
] as const;

const FIRST_QUESTION_CHARS = 80;

export type BywayCloseRefusal = {
  code: typeof BYWAY_CLOSE_REFUSED;
  message: string;
  sessionId: string;
  sourceSessionId: string | null;
};

function callerIsAgent(env: NodeJS.ProcessEnv): boolean {
  return AGENT_IDENTITY_VARS.some((name) => (env[name]?.trim() ?? "") !== "");
}

/** A byway may close ITSELF (context succession inside a long byway) — by session or by seat. */
function callerIsTarget(target: SessionRecord, env: NodeJS.ProcessEnv): boolean {
  const caller = resolveLedgerCaller(env);
  if (!caller) {
    return false;
  }
  return (
    caller.session === target.acpxRecordId ||
    (caller.seat !== null && target.seatId !== undefined && caller.seat === target.seatId)
  );
}

function bywaySourceSessionId(target: SessionRecord): string | null {
  return (
    target.metadata?.byway_parent ?? target.parentSessionId ?? target.forkedFromSessionId ?? null
  );
}

function firstQuestionClause(target: SessionRecord): string {
  const question = target.metadata?.byway_first_question?.replace(/\s+/g, " ").trim();
  if (!question) {
    return "";
  }
  const clamped =
    question.length > FIRST_QUESTION_CHARS
      ? `${question.slice(0, FIRST_QUESTION_CHARS - 1)}…`
      : question;
  return ` (${JSON.stringify(clamped)})`;
}

/**
 * `sessions close`'s byway guard (brick 6867bbfc D6). Refuses when ALL hold: the target is a
 * byway, the caller is an agent, and the caller is not the target itself. Anything else —
 * atrium's own close, a plain child — returns `undefined` and the close proceeds unchanged.
 *
 * ⚠️ THERE IS NO OVERRIDE, AND DO NOT ADD ONE. The first version had `--allow-byway`; an agent
 * that read it in the usage-error help used it on the FIRST order from another agent to "close
 * your idle children" and closed a human's byway (verification of brick 6867bbfc, AC2b — the
 * conception's E6 risk, materialised). Any flag an agent can read is a flag agents use. The
 * refusal text, the `--help` and the docs therefore name no way for an agent to close one; the
 * human closes it (or promotes it, after which it is no longer a byway) in atrium. Pinned in
 * `test/byway-guard.test.ts`: `--allow-byway` is an unknown option, and `sessions close --help`
 * never mentions byways.
 *
 * It is evaluated by the HANDLER, never inside `closeSession()`, so acpx's own internal closes
 * (template enable, handover) are untouched.
 */
export function bywayCloseRefusal(
  target: SessionRecord,
  env: NodeJS.ProcessEnv = process.env,
): BywayCloseRefusal | undefined {
  if (!isBywaySessionRecord(target) || !callerIsAgent(env)) {
    return undefined;
  }
  if (callerIsTarget(target, env)) {
    return undefined;
  }
  const sourceSessionId = bywaySourceSessionId(target);
  const message =
    `Refused: ${target.acpxRecordId} is a by-the-way side-thread — a human's side conversation ` +
    `opened from session ${sourceSessionId ?? "(unknown)"}${firstQuestionClause(target)}. ` +
    "It is not your child, and agents cannot close it. Leave it open: if the human wants it " +
    "closed, they close it in atrium themselves (or promote it there first, after which it is " +
    "an ordinary session).";
  return { code: BYWAY_CLOSE_REFUSED, message, sessionId: target.acpxRecordId, sourceSessionId };
}
