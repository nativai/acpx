import type { SessionMessage, SessionRecord } from "../types.js";
import { writeSessionRecordAtBoundary } from "./persistence.js";

/**
 * ONE WRITER for *"this diagnostic must reach the operator on BOTH legs — the terminal AND
 * the session stream"*, which two contracts now require and neither had:
 *
 * - **ratification item 8 as ruled 2026-09-28** — a seat-row mint failure at a CLI creation
 *   path *"reaches the operator's terminal (stderr + the stream), never a silent catch"*;
 * - **Cluster A requirement 3** — the `seat-mirror-divergence` line goes to the session
 *   stream *"so it is on the record"*.
 *
 * Both were **stderr-only** until this module existed (the test-engineer's F8). A terminal
 * line survives exactly as long as the scrollback of whoever happened to be watching; the
 * stream is the only durable half, and for the divergence line the durable half IS the
 * contract — the whole design stores no counter and expects history to be reconstructed
 * from these lines.
 *
 * 🛑 **WHY THIS IS NOT IN `seat-store.ts`.** The store BUILDS its diagnostic strings and
 * returns them; it has no session context and must not acquire one. Plumbing a record or a
 * session id into the store to let it write a stream would give the store a second reason to
 * touch session state — and the store's single-writer discipline is the one property the
 * seat design rests on. **The stream write belongs at the CALL SITE, where a session exists.**
 *
 * 🔑 **THE ORDER OF THE TWO LEGS IS LOAD-BEARING.** The terminal leg goes FIRST because it
 * cannot be lost: synchronous, no lock, no outbox. The stream leg is a record write, so it
 * can fail for exactly the reasons the operation being diagnosed just failed for — and if it
 * went first, its failure would take the diagnostic down with it, leaving the operator with
 * a silent degraded state, which is the outcome both contracts exist to prevent.
 */
export async function reportOperatorDiagnostic(
  record: SessionRecord,
  diagnostic: string,
): Promise<void> {
  // LEG 1 — the terminal. Never conditional, never deferred.
  process.stderr.write(`${diagnostic}\n`);
  // LEG 2 — the stream.
  record.messages.push(buildDiagnosticMessage(diagnostic));
  try {
    await writeSessionRecordAtBoundary(record);
  } catch (error) {
    // 🛑 NOT A BARE `.catch(() => {})` — the ruling forbids one, and for a good reason: a
    // swallowed failure here means the durable half is missing while everything reports
    // success. It must still not THROW: the operation being diagnosed has already completed
    // (the session exists, the flip landed), so failing it over an undeliverable WARNING
    // would reintroduce the dependency these contracts remove. "Must not throw" is not
    // "must not tell".
    process.stderr.write(
      `[acpx] the diagnostic above could NOT be written to the session stream ` +
        `(session=${record.acpxRecordId}): ${error instanceof Error ? error.message : String(error)}\n` +
        `        It reached this terminal and nowhere else — it is NOT on the record.\n`,
    );
  }
}

function buildDiagnosticMessage(diagnostic: string): SessionMessage {
  return {
    Agent: {
      content: [{ Text: diagnostic }],
      tool_results: {},
      // A system breadcrumb, not a model turn — the same reason the model-guard mirror marks
      // its own (brick://de3645c6): unmarked, it counts as irreplaceable history in the
      // resume→session/new fallback gate, and a fresh session whose first prompt hits a
      // missing transcript becomes permanently unpromptable. **A warning must never be able
      // to cost the session it is warning about.**
      synthetic: true,
    },
  };
}
