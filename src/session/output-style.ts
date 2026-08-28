import type { SessionRecord } from "../types.js";

/**
 * Claude Code output style — the per-session setting that rewrites the agent's
 * system prompt to set role, tone and default response format.
 * brick://874fee67 · design brick://4d16ab8b · turn-boundary addendum §2.
 *
 * ## The three inversions (R-6) — output style is NOT `effort`, at three points
 *
 * Nearly every site of this feature is a faithful copy of the `effort`
 * implementation. At exactly three points it must do the OPPOSITE, and each is a
 * one-line divergence inside a long copy-paste sweep — so an implementer (or
 * reviewer) following the precedent *correctly* introduces all three defects:
 *
 * 1. **NEVER APPLY LIVE.** There is deliberately no `applyOutputStyleToSdk` and
 *    no `applyFlagSettings({outputStyle})` anywhere. Measured: the harness's
 *    config layer and its per-turn style reminder are LIVE, but the SYSTEM
 *    PROMPT is FROZEN for the life of a query. Moving the live config therefore
 *    leaves the model *told it is operating in style X while never having seen
 *    X's instructions* — strictly worse than a no-op, because the reminder says
 *    "follow the specific guidelines for this style" for guidelines it does not
 *    have. A new live-apply function in a diff is THE DEFECT, not the missing
 *    piece. The style reaches Claude Code only through the adapter's CREATION
 *    settings — at spawn and at resume.
 * 2. **CLEARING WRITES THE LITERAL `"default"`, NEVER `null`.**
 *    `applyFlagSettings({outputStyle:null})` does clear a style that was set via
 *    `applyFlagSettings`, but CANNOT clear one set at creation — create-time
 *    settings and live settings occupy different slots in the flag tier
 *    (measured). Every style we set arrives create-time, so `null` could never
 *    have worked for us. `"default"` is itself an advertised id, so setting it
 *    is an ordinary set. The adapter's effort code uses the `null`-clears idiom;
 *    copying it verbatim ships a silently broken "revert to default".
 * 3. **CONFIRMATION COMES FROM THE RESUME, NEVER FROM READING THE STYLE BACK.**
 *    The harness readback lies in both directions: it does not validate the name
 *    on the way in (a bogus style is accepted and echoed back as active), and it
 *    is disconnected from behaviour on the way out. A "did the style take?" check
 *    that reads `output_style` is a confident wrong answer both ways. The
 *    trustworthy signal is that a fresh query was BUILT with the value — which is
 *    exactly what {@link appliedOutputStyle} records.
 */

/** The ACP config-option id. Matches the SDK settings key exactly, so the
 *  adapter needs no mapping table. Safe because acpx's `normalizeModeId` trims
 *  only — it never lowercases, so this camelCase id survives. */
export const OUTPUT_STYLE_CONFIG_ID = "outputStyle";

/** The harness's own id for "no style" — a real, advertised id, not a sentinel
 *  of ours. Note the casing: `default` is lowercase while `Proactive` /
 *  `Explanatory` / `Learning` are capitalised, so nothing here may case-fold. */
export const OUTPUT_STYLE_DEFAULT_ID = "default";

/**
 * Collapse the two spellings of "no explicit style" — absent and the literal
 * `"default"` — onto one value, so they compare equal.
 *
 * This is deliberately the ONLY normalization applied to a style anywhere: the
 * identifier is the style file's `name:` frontmatter, which may contain spaces
 * ("Nativai Probe Shared") and is not uniformly cased. Lowercasing or slugifying
 * here would break custom and house styles at one end or the built-ins at the
 * other.
 */
export function normalizeOutputStyle(value: string | undefined): string {
  return (value ?? OUTPUT_STYLE_DEFAULT_ID).trim();
}

/** What the user/agent asked for — the durable intent, written by the setter. */
export function desiredOutputStyle(record: SessionRecord): string | undefined {
  return record.acpx?.session_options?.output_style;
}

/** What the session's CURRENT LIVE QUERY was actually built with — written by
 *  the owner at the moment it hands the resolved options to the adapter. */
export function appliedOutputStyle(record: SessionRecord): string | undefined {
  return record.acpx?.applied_output_style;
}

/**
 * **The one predicate.** A style change is pending ⟺ the desired style differs
 * from the style the live query was built with.
 *
 * `pending` is DERIVED from two durable values, never remembered as a flag and
 * never signalled to the owner over IPC. That is the whole point:
 *
 * - An in-memory flag (or an IPC message setting one) has a live path to the
 *   worst failure — the message is lost, the record says the new style, the
 *   owner keeps running the old one, nothing recycles, and **the change is
 *   silently forgotten while looking exactly like success.** The owner's socket
 *   can genuinely go missing mid-life (there is a repair path for it), the owner
 *   can be unreachable, and the send can race a respawn.
 * - This comparison has no such path. Forgetting would require desired and
 *   applied to AGREE while the query was built with something else — and
 *   `applied` is written by the same code that builds the query, at the moment it
 *   builds it. A lost message, a lost socket or a dead process can only make the
 *   recycle LATE, never make the change vanish. An owner that dies IS the recycle.
 *
 * It also gets the change-back case right for free: applied=A, set B, set A again
 * before the boundary → desired === applied → pending clears itself and **no
 * recycle happens**. An intent-queue implementation performs a pointless recycle
 * there; that difference is how a reviewer tells the two models apart.
 *
 * ⚠️ Do not re-implement this comparison at a call site. brick://67d2fd2f is
 * exactly this class: a derived predicate written out separately per site
 * diverges, and the divergence surfaces only in the one state where the two
 * expressions disagree — which is the state nobody tests.
 */
export function outputStyleChangePending(record: SessionRecord): boolean {
  return normalizeOutputStyle(desiredOutputStyle(record)) !==
    normalizeOutputStyle(appliedOutputStyle(record));
}

/**
 * Record the style the query we just built was handed. Call this AFTER the
 * `session/new` / `session/load` / `session/resume` call succeeds, in the record
 * write that already follows it.
 *
 * Two rules, both load-bearing:
 * - **After success, never before.** A failed create must not claim an applied style.
 * - **Unconditionally, including for the default.** Leaving it absent on a live
 *   session makes "no style" indistinguishable from "unknown", and
 *   {@link outputStyleChangePending} would then report a pending change on every
 *   unstyled session — a recycle per turn, forever.
 */
export function stampAppliedOutputStyle(
  record: SessionRecord,
  outputStyle: string | undefined,
): void {
  record.acpx = {
    ...record.acpx,
    applied_output_style: normalizeOutputStyle(outputStyle),
  };
}
