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
 * byway, the caller is an agent, the caller is not the target itself, and `--allow-byway` is
 * absent. Anything else — a human shell, atrium's own close, a plain child — returns
 * `undefined` and the close proceeds unchanged.
 *
 * It is evaluated by the HANDLER, never inside `closeSession()`, so acpx's own internal closes
 * (template enable, handover) are untouched.
 */
export function bywayCloseRefusal(
  target: SessionRecord,
  allowByway: boolean,
  env: NodeJS.ProcessEnv = process.env,
): BywayCloseRefusal | undefined {
  if (allowByway || !isBywaySessionRecord(target) || !callerIsAgent(env)) {
    return undefined;
  }
  if (callerIsTarget(target, env)) {
    return undefined;
  }
  const sourceSessionId = bywaySourceSessionId(target);
  const message =
    `Refused: ${target.acpxRecordId} is a by-the-way side-thread — a human's side conversation ` +
    `opened from session ${sourceSessionId ?? "(unknown)"}${firstQuestionClause(target)}. ` +
    "It is not your child and not yours to close; leave it open — the human closes it from " +
    "atrium. Only if the human explicitly asked you to close this side-thread, re-run with " +
    "--allow-byway.";
  return { code: BYWAY_CLOSE_REFUSED, message, sessionId: target.acpxRecordId, sourceSessionId };
}
