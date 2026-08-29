import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { OutputStyleNotSupportedError, OutputStyleUnknownError } from "../errors.js";
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
  return (
    normalizeOutputStyle(desiredOutputStyle(record)) !==
    normalizeOutputStyle(appliedOutputStyle(record))
  );
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

/** The advertised `outputStyle` config option, or undefined when the agent never
 *  advertised one. Support is derived from THIS and nothing else — never from
 *  the agent name, which would call a claude session on a not-yet-updated
 *  adapter "supported" and hand the user a control that does nothing. */
export function findAdvertisedOutputStyleOption(
  advertised: SessionConfigOption[] | undefined,
): SessionConfigOption | undefined {
  return (advertised ?? []).find((option) => option.id === OUTPUT_STYLE_CONFIG_ID);
}

/**
 * The styles an agent actually offers, from its own advertisement.
 *
 * ⚠️ NEVER hardcode this list. The built-ins measured on this box are `default`,
 * `Proactive`, `Explanatory`, `Learning` — FOUR, not the five the public doc
 * lists (`Concise` is absent at claude 2.1.239 despite the doc's stated version
 * gate). Custom and house styles appear here too. Any static list is wrong today
 * and wrong differently after the next CLI bump.
 */
export function availableOutputStyles(advertised: SessionConfigOption[] | undefined): string[] {
  const option = findAdvertisedOutputStyleOption(advertised);
  if (!option || option.type !== "select") {
    return [];
  }
  // A malformed/older adapter can advertise a select option with `options`
  // absent; treat that as "no known values" rather than throwing.
  return (option.options ?? []).flatMap((entry) => ("value" in entry ? [entry.value] : []));
}

/**
 * Refuse a style this session's agent does not offer — **the AC-5 defence, and
 * the criterion most likely to be skipped because it tests something Claude Code
 * itself does not do.**
 *
 * Claude Code performs NO validation of `outputStyle`: a bogus name is accepted
 * and echoed back as the session's active style, so every surface — the record,
 * the header, `acpx status` — would then claim a style the session does not
 * have. Validation is ours or it does not exist.
 *
 * Validating against the RECORD's advertisement rather than a live ACP
 * round-trip is deliberate: it works with no owner running (the cold case a
 * `set` on an idle session takes), and it needs no adapter call.
 *
 * A session that advertises the option but no value list is accepted rather than
 * refused — an empty list means "this adapter did not tell us", not "no styles
 * exist", and refusing everything on that basis would break a working feature.
 */
export function assertOutputStyleAdvertised(
  advertised: SessionConfigOption[] | undefined,
  outputStyle: string,
  agentLabel: string,
): void {
  if (!findAdvertisedOutputStyleOption(advertised)) {
    throw new OutputStyleNotSupportedError(agentLabel);
  }
  const available = availableOutputStyles(advertised);
  if (available.length === 0) {
    return;
  }
  // Exact match only — no case folding, no slugging. `default` is lowercase
  // while `Proactive`/`Explanatory`/`Learning` are capitalised, and custom style
  // names may contain spaces.
  if (!available.includes(outputStyle.trim())) {
    throw new OutputStyleUnknownError(outputStyle, available);
  }
}

/**
 * Drop a requested output style the session's agent does not support, BEFORE any
 * of it reaches the record (brick://874fee67 F3).
 *
 * ⚠️ THIS IS THE SINGLE GATE, and it has to be a strip rather than a per-write
 * check. The shipped bug: `persistRequestedOutputStyle` was gated, but
 * `persistSessionOptions` and `stampAppliedOutputStyle` each wrote from the raw
 * requested options and ran either side of it — so `acpx sessions new
 * --output-style X` against CODEX printed *"ignoring for agent codex"* and then
 * persisted `output_style: X` **and** `applied_output_style: X` anyway. It said
 * one thing to the operator and recorded another.
 *
 * That mattered far beyond untidiness because of WHICH field it corrupted:
 * `applied_output_style` is defined as "the style the current live query was
 * built with", and the design tells the UI to label its chip from it precisely
 * because it is OUR OWN ACTION RECORD rather than an untrustworthy harness
 * readback. On that path it asserted an action that never happened, with
 * `pending: false` claiming the state was settled — the one field designed to
 * stop the control lying was the one telling the lie.
 *
 * Stripping at the source makes every downstream write consistent BY
 * CONSTRUCTION: persist, validate and stamp all read the same already-filtered
 * value, so no future write site can miss a gate that no longer exists per-site.
 *
 * NOT stripped, deliberately: `applied_output_style: "default"` on an unstyled
 * session of any agent. That is the spec's stamp-unconditionally rule and is
 * correct — only a non-default, provably-never-applied value is the defect.
 */
export function withSupportedOutputStyleOnly<T extends { outputStyle?: string }>(
  options: T | undefined,
  advertised: SessionConfigOption[] | undefined,
): T | undefined {
  if (!options?.outputStyle || findAdvertisedOutputStyleOption(advertised)) {
    return options;
  }
  const { outputStyle: _dropped, ...rest } = options;
  return rest as T;
}

/** Record-backed wrapper over {@link assertOutputStyleAdvertised} — the form the
 *  `set` verb uses, because it works with NO owner running (the cold case a set
 *  on an idle session takes) and needs no adapter round-trip. One validator, two
 *  entry points: the creation flag has its advertised list in hand already. */
export function assertOutputStyleSupportedForRecord(
  record: SessionRecord,
  outputStyle: string,
): void {
  assertOutputStyleAdvertised(
    record.acpx?.config_options,
    outputStyle,
    record.agentName ?? record.agentCommand,
  );
}
