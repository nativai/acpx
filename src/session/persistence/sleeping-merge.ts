import type { SessionAcpxState, SessionRecord } from "../../types.js";
import { namesAgentSession } from "../sleeping.js";

/**
 * `acpx.sleeping` only ever goes ONE way: a sleeping create writes it onto a brand-new record, the
 * first wake's materialisation deletes it (`finishSleepingMaterialisation`), and nothing sets it on
 * a record that is already on disk. So a record on disk WITHOUT it has been woken, and a write that
 * still carries it is a stale copy putting it back (brick://56d160be).
 *
 * ⚠️ WHY THE WRITER AND NOT THE TURN. The turn's live checkpoint assigns `record.acpx = <the turn's
 * own `acpxState`, cloned when the turn loaded the record>` (`mergeLatestDurablePreferences`,
 * cli/session/runtime.ts) and writes it. `acpxState` is only re-based from `record.acpx` AFTER the
 * connect (which materialises, then deletes the flag on `record.acpx`) and the prompt-model apply,
 * so a checkpoint firing in between — or any turn that fails in between — writes the pre-wake copy:
 * `acp_session_id` set AND `sleeping` present, which the list and `status` read as "Sleeping" for a
 * session that has run. Reproduced on dev 25f39d84 with the real claude adapter.
 *
 * ⚠️ NOT A BASELINE-DIFF LIKE `durable-options-merge.ts`, ON PURPOSE. The materialisation's own
 * write re-captures that baseline (flag absent), so the stale copy that follows reads as a
 * DELIBERATE change and would win. Disk is the authority instead: no deliberate writer ever sets
 * the flag on a persisted record, so there is nothing a disk-wins rule could suppress.
 *
 * ⚠️ ONLY A WRITE THAT NAMES AN AGENT SESSION LOSES THE FLAG (`acpSessionId !== ""`): that pair is
 * the stray this rule exists for. A stale write carrying `acpSessionId: ""` is a record read BEFORE
 * the wake (a `sessions close` landing mid-wake writes one back); `sleeping` + `""` is the
 * consistent "never ran" state the next wake materialises, while `""` WITHOUT `sleeping` is a
 * state no path handles — the connect reconnects session id `""` and every later prompt fails
 * SESSION_MODEL_REPLAY_FAILED, permanently (TE finding, brick 56d160be Block 8). Do NOT widen the
 * rule to drop the flag from every write: `test/sleeping-flag-writer.test.ts` row 7 goes red.
 *
 * No file on disk (the sleeping create's first write) ⇒ the record is written verbatim. Mutates
 * `record.acpx` IN PLACE: the turn keeps its own reference to that object, and a replacement would
 * leave its later checkpoints carrying the stale copy.
 */
export function dropStaleSleepingForPersist(
  record: SessionRecord,
  persisted: { acpx?: SessionAcpxState } | undefined,
): void {
  if (
    !persisted ||
    persisted.acpx?.sleeping !== undefined ||
    !namesAgentSession(record.acpSessionId)
  ) {
    return;
  }
  if (record.acpx?.sleeping !== undefined) {
    delete record.acpx.sleeping;
  }
}
