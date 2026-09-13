import type { TurnAttribution } from "../acp/openrouter-attribution.js";
import {
  type CostUnit,
  deriveCostFigure,
  priceUnit,
  reportedCost,
  type SessionCostFigure,
  type UnitRates,
} from "../models/cost-provenance.js";
import {
  defaultCatalogueCachePath,
  type OpenRouterRawModel,
  readOpenRouterCacheSync,
} from "../models/openrouter-catalogue.js";
import type { SessionAcpxState } from "../types.js";

/**
 * THE INGEST CALLER `cost-provenance.ts` SHIPPED WITHOUT (brick 5026423b).
 *
 * `deriveCostFigure` and `reportedCost` were merged as a pure module with **zero
 * callers**, and `measuredFree` was declared and consumed but never assigned
 * anywhere in `src`. So nothing ever produced a cost figure and nothing persisted
 * one — "inert until read" was meant to mean *stored but not rendered*; what
 * shipped was *not stored at all*.
 *
 * ## ⚠️ RATES ARE RESOLVED AT INGEST AND PERSISTED WITH THE UNIT, DELIBERATELY
 *
 * The alternative — persist token counts, price them at read time — looks tidier
 * and is wrong here. **A cold catalogue cache makes every model look price-less**
 * (`cost-provenance.ts`'s own warning), so a session that was correctly `computed`
 * would silently re-read as `unpriced` the first time the cache was cold, and back
 * again later. A cost figure that flaps with cache weather is worse than one that
 * is merely stale. Resolving once, at the moment the tokens are observed, makes
 * the figure reproducible.
 *
 * ⇒ The stored unit therefore carries its own rates, and `deriveCostFigure`
 * remains the ONLY place the provenance rules live — this module resolves inputs
 * and never re-implements the derivation.
 *
 * ## ⚠️ ONE UNIT PER ASSISTANT MESSAGE, NOT PER TURN AND NOT PER MODEL
 *
 * pi emits one `usage_update` per assistant `message_end`. A turn holds several,
 * and a session can switch models mid-flight, so the model in force is captured
 * PER UNIT. Summing a cumulative counter across a model switch would attribute one
 * model's tokens to another — the reason `CostCoverage.unit` is `message`.
 */

/** What one usage event contributes, as observed. `null` rates ⇔ unpriceable. */
export type UsageObservation = {
  /** Actual model for this request; session model is only a legacy fallback. */
  model?: string;
  input: number;
  output: number;
  /** Informational subset of output, never an additional billable counter. */
  reasoning?: number;
  cacheRead: number;
  cacheWrite: number;
  /** The adapter's OWN figure for the session so far, when it reports one. */
  reportedAmount?: number | null;
  /**
   * Who SERVED this message, when the path can observe it (brick 4c272cab §8).
   * Absent ⇒ the unit records `null`, which means "not recorded" and must never
   * be filled in with the provider the box merely preferred.
   */
  attribution?: TurnAttribution;
};

type RateLookup = (modelId: string) => UnitRates | null;

/**
 * Per-1M rates for a model id, or `null` when the catalogue has no row for it.
 *
 * ⚠️ **ABSENCE IS NEVER ZERO.** `null` here means "no row", which
 * `deriveCostFigure` turns into `unpriced`; a row that genuinely quotes zero
 * returns rates with `measuredFree: true`, which is the only path to `free`. That
 * asymmetry is the whole discrimination and it must not be collapsed — a missing
 * row priced as 0 is how a confident `$0.00` reaches a user who was in fact
 * charged.
 */
export function lookupUnitRates(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): UnitRates | null {
  const snapshot = readOpenRouterCacheSync(defaultCatalogueCachePath(env));
  // ⚠️ TRY THE ID AS GIVEN BEFORE STRIPPING, AND THE ORDER IS THE FIX.
  // `openrouter/` is usually a SELECTOR prefix (`openrouter/z-ai/glm-5.3-flash` →
  // the row `z-ai/glm-5.3-flash`), but it is also a real VENDOR: the row
  // `openrouter/auto-beta` IS its own id. Stripping unconditionally makes every
  // openrouter-vendor model unfindable, which prices a real session as `unpriced`
  // — caught by the drift pin against the live catalogue, not reasoned about.
  const row =
    snapshot?.models.find((model) => model.id === modelId) ??
    (modelId.startsWith("openrouter/")
      ? snapshot?.models.find((model) => model.id === modelId.slice("openrouter/".length))
      : undefined);
  if (!row) {
    return null;
  }
  return ratesFromPricing(row.pricing);
}

/**
 * Fold one observation into the session's persisted cost state.
 *
 * ## 🛑 THE `reported` RULE — this function DEFINES it, it does not inherit it
 *
 * `deriveCostFigure` emits only `unpriced`, `free` and `computed`; `reported` had
 * no producer anywhere in the tree, so the ingest is where its contract is set:
 *
 *   - **A zero adapter figure beside NON-ZERO tokens is NEVER `reported`.** It
 *     goes to the unit path, which answers `computed` when a catalogue price
 *     exists and `unpriced` when none does.
 *   - `reported` requires a non-zero adapter figure, or a zero with zero tokens.
 *
 * **Why this is the load-bearing rule and not a nicety:** a harness handed a
 * fabricated catalogue entry with zeroed rates computes `cost.total = 0` and
 * reports it TRUTHFULLY — measured on pi, 2026-09-08: `cost.amount 0` beside
 * 7,906 real tokens. If ingest trusted that as `reported`, Daniel's original bug
 * would return through the one provenance whose contract is "trust the adapter":
 * a confident `$0.00` on a session that was never priced.
 */
export function rememberSessionCost(
  acpx: SessionAcpxState,
  observation: UsageObservation,
  lookupRates: RateLookup = (modelId) => lookupUnitRates(modelId),
  /** Clock seam — a test must be able to pin the stamped `ts` (brick 19693941). */
  now: () => Date = () => new Date(),
): void {
  const tokens = observation.input + observation.output;
  const reported = observation.reportedAmount;

  const hasUnits = tokens > 0 || observation.cacheRead > 0 || observation.cacheWrite > 0;
  if (!hasUnits) {
    // No units to price. An adapter figure is all there is — and a ZERO with zero
    // tokens is a legitimate `reported` zero (nothing happened), which is the one
    // zero the rule above admits.
    if (typeof reported === "number") {
      acpx.cost = reportedCost(reported);
    }
    return;
  }

  const units = [
    ...(acpx.cost_units ?? []),
    stampedUnit(acpx.current_model_id, observation, lookupRates, now),
  ];
  acpx.cost_units = units;
  acpx.cost = deriveCostFigure(units);
}

/**
 * One fully-stamped unit: counts, the rates in force, and the three fields brick
 * 19693941 added (`ts` / `model` / `cost_usd`).
 *
 * Split out of `rememberSessionCost` to keep that function under the repo's
 * complexity ceiling of 8 — the stamping pushed it to 10. Extracting was the right
 * remedy rather than raising the ceiling: the two jobs really are separate (decide
 * whether there is anything to price, vs. build the priced artefact), and the
 * pre-commit hook refusing the commit is what forced the question.
 *
 * brick 19693941 — the stamps let a consumer place a unit in time, attribute it,
 * and price it without re-deriving any of those. `ts` is what unlocks ONE ROW PER
 * TURN downstream; without it a consumer can only emit one cumulative row at
 * session close, and a cumulative row emitted twice SUMS (brick ff878c28).
 */
function stampedUnit(
  modelId: string | undefined,
  observation: UsageObservation,
  lookupRates: RateLookup,
  now: () => Date,
): CostUnit {
  modelId = observation.model ?? modelId;
  // ⚠️ `ts` IS THE OBSERVATION TIME, NOT THE TURN'S START OR THE RECORD'S
  // `last_used_at`. This function runs on the `usage_update` that reports the
  // message, so "now" is the truthful instant for it — and it is the only instant
  // available: pi's wire block (`_meta.piAcp.message`) carries no timestamp of its
  // own (measured: its keys are cacheRead, cacheWrite, costUsd, input, output,
  // reasoning, totalTokens). Deriving it from the record's `last_used_at` instead
  // would stamp every unit of a turn with the same moving value.
  //
  // 🛑 `cost_usd` IS THE COMPUTED FIGURE FROM `priceUnit`. IT IS **NOT** THE WIRE'S
  // `costUsd`, AND THE TWO SHARE A NAME WHILE HAVING OPPOSITE PROVENANCE.
  //
  // pi's per-message block carries its own `costUsd` — measured, it is right there
  // beside the counts (`cacheRead, cacheWrite, costUsd, input, output, reasoning,
  // totalTokens`). Reading it instead of computing looks like an obvious
  // simplification: same name, same units, one less call. **It is the defect this
  // module's `reported` rule exists to refuse.** A harness whose catalogue row
  // quotes zeroed rates computes zero and reports it TRUTHFULLY — measured on pi
  // 2026-09-08: `cost.amount 0` beside 7,906 real tokens. Taking the wire value
  // would put a confident `$0.00` on a session that was never priced, through the
  // one field a reader is least likely to doubt.
  //
  // ⇒ If you are here to "simplify this to the adapter's own number", that is the
  // bug. `priceUnit` is the only source, and `cost-ingest.test.ts` pins that the
  // non-null `cost_usd` values sum to `cost.amount` on the computed path.
  const priceable: CostUnit = {
    input: observation.input,
    output: observation.output,
    // camelCase observation in, snake_case unit out — the unit is persisted
    // verbatim under `acpx.cost_units` (brick://48aca560).
    cache_read: observation.cacheRead,
    cache_write: observation.cacheWrite,
    rates: modelId ? lookupRates(modelId) : null,
  };
  return {
    ...priceable,
    reasoning: observation.reasoning,
    ts: now().toISOString(),
    model: modelId ?? null,
    cost_usd: priceUnit(priceable),
    ...attributionFields(observation.attribution),
  };
}

/**
 * The three attribution stamps on a unit, all `null` when the path observed none.
 *
 * ⚠️ `?? null`, NOT a fallback to anything else. The absent case is recorded as
 * absent — see `CostUnit.provider_name` for why a "sensible default" here (the
 * preferred provider) would make the routing feature un-falsifiable.
 *
 * brick 77054e85 — on the pi path `response_id` is the ONLY one of the three the
 * unit can carry: the names are resolved ~10 s later, onto `last_turn_provider`,
 * long after this unit is written. Stamping the id is what leaves the turn
 * identifiable at all. (Split out so {@link stampedUnit} stays under the repo's
 * complexity ceiling of 8 — the third stamp pushed it to 9.)
 */
function attributionFields(
  attribution: TurnAttribution | undefined,
): Pick<CostUnit, "provider_name" | "native_finish_reason" | "response_id"> {
  return {
    provider_name: attribution?.provider_name ?? null,
    native_finish_reason: attribution?.native_finish_reason ?? null,
    response_id: attribution?.response_id ?? null,
  };
}

/** Re-derive from the persisted units — used after a cold resume, where the
 *  figure must not restart from zero. The units carry their own rates, so this
 *  cannot disagree with what ingest computed. */
export function costFigureFromUnits(acpx: SessionAcpxState): SessionCostFigure | undefined {
  const units = acpx.cost_units;
  return units && units.length > 0 ? deriveCostFigure(units) : undefined;
}

/**
 * ⚠️ DERIVED HERE RATHER THAN VIA `deriveBilling` — AND THE ORIGINAL REASON GIVEN
 * FOR THAT WAS WRONG. Corrected 2026-09-08 (brick://48aca560); left in place
 * because the duplication is cheap and pinned, not because the bundle forbids
 * the import.
 *
 * This comment used to blame *the import edge*: adding `models/catalogue.ts` (and
 * with it the capability chain) was said to produce "a circular initialisation in
 * the bundled build" that silently killed the whole `usage_update`. The
 * OBSERVATION was real and is reproduced below; the EXPLANATION was not, and it
 * was never verified:
 *
 *     deployed build   : context_window_size 262144   ✓
 *     with the branch  : context_window_size null     ✗   (a PRE-EXISTING field)
 *
 * Measured on the two actual builds: `conversation-model` sits in the same output
 * chunk in both, NO module is duplicated across chunks in either, and the chunk
 * import graph is edge-for-edge identical. There is no second module instance and
 * no cycle. The real cause was this module's own PAYLOAD — `CostUnit`/`UnitRates`
 * carried camelCase keys, `assertPersistedKeyPolicy` threw inside the record
 * write before `fs.writeFile`, and `LiveSessionCheckpoint` swallowed the throw,
 * so the record silently froze at its pre-turn state. Hence the snake_case keys
 * on those types; see the comment on `UnitRates`.
 *
 * The one part of the old note that stands: the unit suite was green throughout,
 * because nothing in it drove a cost-bearing record through the write path.
 *
 * 🛑 THE DUPLICATION IS PINNED, NOT TRUSTED. `cost-ingest.test.ts` asserts this
 * agrees with `deriveBilling` on the real catalogue rows, so the two cannot drift
 * apart silently. Collapsing it back into an import is now a legitimate option —
 * if you take it, keep that drift pin pointed at whatever replaces this.
 */
/** No usable rate on any axis — OpenRouter's `-1` VARIABLE marker. */
const UNQUOTED_RATES: UnitRates = {
  in_per_m: null,
  out_per_m: null,
  cache_read_per_m: null,
  cache_write_per_m: null,
  measured_free: false,
};

/** The four quoted per-1M rates, still in the module's camelCase working vocabulary. */
type QuotedRates = {
  inPerM: number | null;
  outPerM: number | null;
  cacheReadPerM: number | null;
  cacheWritePerM: number | null;
};

function quotedRates(pricing: OpenRouterRawModel["pricing"]): QuotedRates {
  return {
    inPerM: perMillion(pricing?.prompt),
    outPerM: perMillion(pricing?.completion),
    cacheReadPerM: perMillion(pricing?.input_cache_read),
    cacheWritePerM: perMillion(pricing?.input_cache_write),
  };
}

/**
 * ⚠️ ON THE FREE BRANCH, UNQUOTED CACHE RATES ARE ZERO — mirroring `deriveBilling`.
 * Leaving them `null` here is not conservative, it is WRONG: `priceUnit` refuses a
 * unit whose cache_read is non-zero with a null cache rate, so a genuinely free
 * model that used cached tokens would come back `unpriced` instead of `free` — the
 * exact conflation this brick removes, inverted. (Caught by the drift pin against a
 * real row, `inclusionai/ling-3.0-flash-sante:free`, which quotes 0/0 and no cache
 * rates.)
 */
function freeRates(quoted: QuotedRates): UnitRates {
  return {
    in_per_m: 0,
    out_per_m: 0,
    cache_read_per_m: quoted.cacheReadPerM ?? 0,
    cache_write_per_m: quoted.cacheWritePerM ?? 0,
    measured_free: true,
  };
}

function ratesFromPricing(pricing: OpenRouterRawModel["pricing"]): UnitRates {
  // `-1` is OpenRouter's VARIABLE marker — a price that exists but is not quoted.
  // It is not zero and it is not free; it is unpriceable, which `deriveCostFigure`
  // turns into `unpriced`.
  if (pricing?.prompt === "-1") {
    return { ...UNQUOTED_RATES };
  }
  const quoted = quotedRates(pricing);
  // A MEASURED zero: the row QUOTES zero on both billed axes. An unquoted rate is
  // `null`, never 0, so absence of a ROW can never reach `free`.
  if (quoted.inPerM === 0 && (quoted.outPerM ?? 0) === 0) {
    return freeRates(quoted);
  }
  // Locals stay camelCase; the returned object is PERSISTED, so its keys are
  // snake_case. The mapping is explicit rather than shorthand precisely so the
  // two namings cannot be collapsed back together by accident (brick://48aca560).
  return {
    in_per_m: quoted.inPerM,
    out_per_m: quoted.outPerM,
    cache_read_per_m: quoted.cacheReadPerM,
    cache_write_per_m: quoted.cacheWritePerM,
    // Reached only when the free branch above did NOT fire.
    measured_free: false,
  };
}

/** USD-per-token (OpenRouter's unit) → USD per 1M, which is what `UnitRates` states. */
function perMillion(rate: string | number | null | undefined): number | null {
  const value = typeof rate === "string" ? Number.parseFloat(rate) : rate;
  return typeof value === "number" && Number.isFinite(value) ? value * 1_000_000 : null;
}
