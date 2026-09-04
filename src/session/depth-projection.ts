/**
 * The canonical thinking-depth vocabulary, and the rule that projects a request
 * in it onto whatever ladder a target actually offers (CONCEPTION §6.1, §6.2).
 *
 * ## Why a projection and not a ladder
 *
 * C5 measured, and C4 re-confirmed against the live OpenRouter catalogue, that a
 * fixed ladder cannot work: 425 models, 153 advertising
 * `reasoning.supported_efforts` in **21 distinct shapes** of 2–6 rungs, 145
 * advertising reasoning with no ladder at all, 97 `reasoning.mandatory: true`.
 * acpx's own hardcoded OpenRouter ladder (`["minimal","low","medium","high"]`,
 * `src/config/profiles.ts:24`) matches **none** of the top six shapes.
 *
 * So the canonical rungs are a **request vocabulary**, not a ladder anything is
 * required to implement. The vocabulary itself is not new — it is exactly what
 * acpx-ui's live-switch route already validates — so nothing here introduces a
 * value a consumer has not already seen.
 *
 * ## The invariant that matters more than the arithmetic
 *
 * **A depth request is never silently dropped.** Before B3 it was:
 * `persistAndApplyRequestedEffort` returned with no error and no persist when
 * the option was not advertised. Every function here therefore returns an
 * OUTCOME that names what happened — including `unavailable` and `unroutable` —
 * and no path returns "nothing happened" without saying which nothing it was.
 * The caller's job is to RECORD that outcome; this module's job is to make one
 * impossible to lose.
 */

/**
 * The 7 ordered rungs plus the two sentinels.
 *
 * ⚠️ `default` and `off` are NOT the same value and the distinction is
 * load-bearing: 97 catalogue models are `reasoning.mandatory`, so `off` is
 * **unsatisfiable** for them while `default` always is. Collapsing them would
 * make acpx claim it had disabled reasoning on a model that cannot disable it.
 */
export const CANONICAL_DEPTH_RUNGS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type CanonicalDepthRung = (typeof CANONICAL_DEPTH_RUNGS)[number];

/** Send nothing; the harness's / model's own default applies. Always satisfiable. */
export const DEPTH_DEFAULT = "default";
/** Explicitly disable reasoning. Unsatisfiable for a `reasoning.mandatory` model. */
export const DEPTH_OFF = "off";

export type CanonicalDepthRequest = CanonicalDepthRung | typeof DEPTH_DEFAULT | typeof DEPTH_OFF;

/** The full request vocabulary, in order, for validation and for a UI to render. */
export const CANONICAL_DEPTH_VOCABULARY: readonly CanonicalDepthRequest[] = [
  DEPTH_DEFAULT,
  DEPTH_OFF,
  ...CANONICAL_DEPTH_RUNGS,
];

/** Values a ladder may use to mean "no reasoning". */
const OFF_RUNG_NAMES = new Set(["none", "off", "disabled"]);

export function isCanonicalDepthRequest(value: string): value is CanonicalDepthRequest {
  return (CANONICAL_DEPTH_VOCABULARY as readonly string[]).includes(value.trim());
}

/** Position of a rung on the 7-rung scale, or `undefined` for a sentinel. */
export function canonicalDepthRungIndex(value: string): number | undefined {
  const index = (CANONICAL_DEPTH_RUNGS as readonly string[]).indexOf(value.trim());
  return index < 0 ? undefined : index;
}

/**
 * What a projection did. Every arm is explicit, and every arm that does not send
 * a value still says WHY — that is the "never silently dropped" invariant
 * expressed in the type rather than in a convention.
 *
 *  - `exact`       — the request is a name on the target's ladder; sent verbatim.
 *  - `off`         — the target has an off-rung and the request was `off`.
 *  - `clamped`     — `off` was asked of a ladder with no off-rung; clamped to its
 *                    LOWEST rung. The user asked to disable reasoning and did not
 *                    get that, so this is recorded, never silently treated as
 *                    success.
 *  - `projected`   — no name match; placed by position. Records the substitution.
 *  - `send-nothing`— `default`: the one request that is satisfiable everywhere.
 *  - `unavailable` — the target advertises no reasoning at all. The control must
 *                    render UNAVAILABLE WITH A REASON, never silently absent.
 */
export type DepthProjectionKind =
  | "exact"
  | "off"
  | "clamped"
  | "projected"
  | "send-nothing"
  | "unavailable";

export interface DepthProjection {
  kind: DepthProjectionKind;
  /** The value to send. `undefined` for `send-nothing` and `unavailable`. */
  value?: string;
  /** The canonical request this came from, echoed so a record carries both ends. */
  requested: string;
  /**
   * Human-readable, present whenever the served value is not the requested one
   * (`clamped`, `projected`) or nothing was sent (`unavailable`). This is the
   * string a UI shows beside the control and a record stores as the reason.
   */
  reason?: string;
}

/**
 * Project a canonical request onto an ordered ladder (CONCEPTION §6.2).
 *
 * `ladder` is the target's OWN vocabulary in its own order, weakest first — the
 * ACP mode advertisement for a `mode` harness, the advertised `effort` option's
 * values for a `config-option` one, `reasoning.supported_efforts` for an
 * OpenRouter model. It is deliberately `readonly string[]` and not a canonical
 * type: the whole point is that the target's rungs are NOT ours.
 *
 * The rule, in order:
 *  1. `default` → send nothing.
 *  2. empty ladder → unavailable (with a reason, never silently absent).
 *  3. `off` → an off-rung if the ladder has one, else clamp to the lowest rung
 *     AND record the clamp.
 *  4. exact name match → use it.
 *  5. otherwise project by position: `L[round(i/6 × (|L|−1))]`, and record the
 *     substitution. Deterministic, monotone and total.
 */
export function projectDepthOntoLadder(
  requested: string,
  ladder: readonly string[],
): DepthProjection {
  const request = requested.trim();

  if (request === DEPTH_DEFAULT) {
    return { kind: "send-nothing", requested: request };
  }

  const rungs = ladder.map((rung) => rung.trim()).filter((rung) => rung.length > 0);
  if (rungs.length === 0) {
    return {
      kind: "unavailable",
      requested: request,
      reason:
        "this model advertises no thinking-depth ladder, so a depth request cannot be expressed for it",
    };
  }

  if (request === DEPTH_OFF) {
    const offRung = rungs.find((rung) => OFF_RUNG_NAMES.has(rung.toLowerCase()));
    if (offRung !== undefined) {
      return { kind: "off", value: offRung, requested: request };
    }
    // No off-rung: the request is UNSATISFIABLE. Clamping to the lowest rung is
    // the closest honest action, and recording it is what stops acpx reporting
    // "reasoning disabled" on a model that never disabled it.
    return {
      kind: "clamped",
      value: rungs[0],
      requested: request,
      reason: `"off" is not on this model's ladder (${rungs.join(", ")}) — reasoning cannot be disabled here; clamped to the lowest rung "${rungs[0]}"`,
    };
  }

  if (rungs.includes(request)) {
    return { kind: "exact", value: request, requested: request };
  }

  const index = canonicalDepthRungIndex(request);
  if (index === undefined) {
    // Not a canonical rung and not a sentinel. Do not guess a position for a
    // vocabulary we do not own — say so instead.
    return {
      kind: "unavailable",
      requested: request,
      reason: `"${request}" is not a canonical depth request (${CANONICAL_DEPTH_VOCABULARY.join(" | ")})`,
    };
  }

  const lastRungIndex = CANONICAL_DEPTH_RUNGS.length - 1; // 6
  const projectedIndex = Math.round((index / lastRungIndex) * (rungs.length - 1));
  const value = rungs[projectedIndex];
  return {
    kind: "projected",
    value,
    requested: request,
    reason: `"${request}" is not on this model's ladder (${rungs.join(", ")}) — projected by position to "${value}"`,
  };
}

/**
 * A mode/option the target ADVERTISED and then REJECTED.
 *
 * ⚠️ This exists because Pi advertises a 6-rung mode ladder and then answers
 * `-32602` for `max` (I2 R8). The projection in {@link projectDepthOntoLadder}
 * necessarily runs against what is *advertised*, and here the advertisement is
 * simply wrong — so the rejection is a **projection failure**, recorded as such.
 *
 * ⚠️ DO NOT "improve" this by retrying down the ladder. A silent retry would
 * hand the user a different depth than the one they asked for, with the record
 * showing success — which is the class of silent wrong answer this whole block
 * exists to end. Failing loudly is the correct behaviour and CONCEPTION §6.3
 * says so explicitly.
 */
export function rejectedDepthProjection(
  projection: DepthProjection,
  rejection: string,
): DepthProjection {
  return {
    kind: "unavailable",
    requested: projection.requested,
    reason: `the agent ADVERTISED "${projection.value}" and then rejected it (${rejection}). The advertisement is wrong; acpx does not silently retry a lower rung, because that would serve a depth you did not ask for and record it as success.`,
  };
}

/**
 * Pi's advertised ladder is a 3-VALUE WIRE LADDER, and `off` is not off.
 *
 * Measured at the wire by I2 (R8), through a logging proxy reading the outgoing
 * request body's `reasoning` field:
 *
 * | requested | wire |
 * |---|---|
 * | `off`, `minimal`, `low` | `{"effort":"low"}` |
 * | `medium`, `high`        | `{"effort":"high"}` |
 * | `xhigh`, `max`          | `{"effort":"max"}` |
 *
 * So a Pi session **cannot disable reasoning through the depth control at all**,
 * and six advertised rungs are three distinct behaviours. This function makes
 * that visible instead of letting a UI imply six levels exist. It is a
 * DESCRIPTION of a measured collapse, not a mapping acpx applies — acpx sends
 * the advertised mode id; Pi does the collapsing.
 */
export function describePiWireDepthCollapse(modeId: string): string | undefined {
  const served = piWireDepthValue(modeId);
  if (served === undefined) {
    return undefined;
  }
  if (modeId.trim().toLowerCase() === "off") {
    return `Pi sends {"effort":"${served}"} for "off" — reasoning is NOT disabled (measured at the wire, I2 R8)`;
  }
  const group = PI_WIRE_DEPTH_LADDER.find((entry) => entry.served === served);
  return `Pi collapses ${group?.advertised.join("/") ?? modeId} to {"effort":"${served}"} (measured at the wire, I2 R8)`;
}

/**
 * Pi's WIRE ladder: the value it actually serves for a mode it ADVERTISES.
 *
 * ⚠️ THIS IS WHY A `depth_projection` ON THE MODE PATH CAN BE HONEST AT ALL.
 * Pi advertises SIX rungs (`off/minimal/low/medium/high/xhigh`, read straight
 * out of pi-acp's own dist) and serves THREE. A projection computed against the
 * ADVERTISEMENT therefore reports `exact` for `minimal`, `medium` and `xhigh` —
 * three levels Pi does not serve. The advertisement is a genuine wire artifact
 * (the agent said those are its modes), so acpx cannot fix it; what acpx CAN do
 * is stop recording `exact` for a level it knows is collapsed.
 *
 * ⚠️ IT IS A MEASUREMENT, NOT AN OBSERVATION. acpx does not watch the collapse
 * happen per session — this table is I2 R8's wire measurement, frozen. It is the
 * same shape of fact as the `pi-acp` `session/set_model` capability cell that was
 * TRUE and WENT STALE between 0.0.26 and 0.0.33: correct when written, and
 * capable of being wrong later without anything failing. Re-measure it when the
 * pinned `pi-acp` moves.
 */
const PI_WIRE_DEPTH_LADDER: readonly { advertised: readonly string[]; served: string }[] = [
  { advertised: ["off", "minimal", "low"], served: "low" },
  { advertised: ["medium", "high"], served: "high" },
  { advertised: ["xhigh", "max"], served: "max" },
];

/** What Pi actually serves for `modeId`, or undefined for a rung not measured. */
export function piWireDepthValue(modeId: string): string | undefined {
  const id = modeId.trim().toLowerCase();
  return PI_WIRE_DEPTH_LADDER.find((entry) => entry.advertised.includes(id))?.served;
}
