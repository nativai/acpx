/**
 * THE STORED SHAPE OF A SESSION COST FIGURE — provenance (HOW it was derived)
 * and coverage (HOW MUCH of the session it covers), on two orthogonal axes.
 *
 * Brick 6253611b, Layer 2. **This module is INERT: it defines and derives the
 * shape, and nothing reads it yet.** Layer 3 (acpx-ui) renders it.
 *
 * ## Why two axes and not one
 *
 * Daniel's bug was a rendered quantity that did not carry the confidence of its
 * own derivation: pi reported `cost 0` for a session that really cost money, and
 * `$0` is indistinguishable from a genuinely free session. A fifth provenance
 * state would conflate *how* a number was reached with *how much* of the session
 * it accounts for, and the two fail independently.
 *
 * ## 🛑 `free` vs `unpriced` — the distinction the whole render depends on
 *
 * - **`free`** — the catalogue row EXISTS and quotes zero. A **measured** zero.
 *   `$0.00` is the correct thing to show.
 * - **`unpriced`** — **no price exists**: no catalogue row, a `variable` row, or
 *   a cold cache. **Must never render as `$0.00`.**
 *
 * ⚠️ **There IS a path where the source cannot tell them apart, and it is closed
 * here rather than left to the renderer:** when acpx's OpenRouter cache is cold,
 * every model looks price-less and would collapse into "zero". So the rule is
 * one-directional — **`free` requires a POSITIVE row quoting zero; the ABSENCE of
 * a row is always `unpriced`, never `free`.** A cold cache degrades to
 * "unknown", which is honest, instead of to "free", which is a fabricated fact.
 *
 * ## `coverage: null` means exactly ONE thing
 *
 * **"Not decomposable by construction"** — the harness handed us a single
 * cumulative total with no units to count (claude and claude-pty both
 * report `cost` and no token breakdown). **"We did not check" can never produce
 * `null`**: every derivation that has units emits counts, so a `null` from a
 * unit-bearing source would be a bug, not a state.
 *
 * ## The unit is `message`, and that is a deliberate correction
 *
 * ⚠️ **Neither `turn` nor `model` is accurate for the only harness that gives us
 * units.** pi emits one `usage_update` per assistant `message_end`, each carrying
 * a per-message delta; a turn can contain several, and a session can switch
 * models mid-flight (measured: one production session ran `kimi-k2.6` then
 * `qwen/qwen3.8-flash`), so a per-model total cannot be summed from a cumulative
 * counter without attributing one model's tokens to another. **The unit that is
 * actually summed is the usage event, i.e. the assistant message.** Naming it
 * `turn` would be a plausible label for a different quantity — exactly the
 * failure mode that produced the `modelId` composition bug.
 */

/** HOW the figure was derived. */
export type CostProvenance =
  /** The adapter reported a total; acpx passed it through untouched. */
  | "reported"
  /** acpx priced token counts from its own catalogue by the determining id. */
  | "computed"
  /** Every unit's catalogue row exists and quotes zero — a MEASURED zero. */
  | "free"
  /** No price exists for at least the whole figure. NEVER render as `$0.00`. */
  | "unpriced";

/**
 * HOW MUCH of the session the figure accounts for. Counts, never a boolean: a
 * partial total is a LOWER BOUND and renders as one ("≥ $4.10, 2 of 3 messages
 * priced"). **Nulling a partially real number is forbidden** — that under-claims
 * exactly as badly as a zero over-claims, and both hide what was known.
 */
export type CostCoverage = {
  /** What `priced`/`total` count. See the header on why this is `message`. */
  unit: "message";
  priced: number;
  total: number;
};

export type SessionCostFigure = {
  /** `null` ONLY when provenance is `unpriced` and nothing at all could be priced. */
  amount: number | null;
  currency: string;
  provenance: CostProvenance;
  /** `null` ⇔ not decomposable by construction. See the header. */
  coverage: CostCoverage | null;
};

/**
 * Per-1M USD rates for one model, as `ModelBilling` states them.
 *
 * ⚠️ snake_case BECAUSE THIS IS PERSISTED, AND IT IS NOT COSMETIC. `UnitRates`
 * and {@link CostUnit} are stored verbatim under `acpx.cost_units` — there is no
 * serializer mapping in between — so a camelCase key here makes
 * `assertPersistedKeyPolicy` throw inside the session-record write, before
 * `fs.writeFile`. The first shape of this type did exactly that, and the result
 * was not "cost is missing": the whole record stopped being written, silently,
 * taking `context_window_size` — an unrelated shipped field — with it, with no
 * exception and a green suite. brick://48aca560 has the measurement.
 *
 * The IN-MEMORY inputs stay camelCase (`UsageObservation` in
 * `src/session/cost-ingest.ts`), matching how `SessionRecord` works: camelCase
 * in memory, snake_case on disk. The line is "does this object reach the record".
 */
export type UnitRates = {
  in_per_m: number | null;
  out_per_m: number | null;
  cache_read_per_m: number | null;
  cache_write_per_m: number | null;
  /** True only when a catalogue row EXISTS and quotes zero (see the header). */
  measured_free: boolean;
};

/**
 * One priceable usage event: token counts plus the rates in force for it.
 *
 * ## The three stamped fields (brick 19693941) — and why they are OPTIONAL
 *
 * `ts` / `model` / `cost_usd` are stamped at ingest so a consumer can place a unit
 * on a time axis and attribute it, which is what lets acpx-ui emit ONE ROW PER TURN
 * for pi instead of one cumulative row per session at close. That is not a
 * cosmetic upgrade: a cumulative total emitted twice SUMS, which is the reopen
 * over-report (brick ff878c28); **a per-turn row is an immutable delta, so emitting
 * it twice is the same row, not a second one.** The defect closes by construction.
 *
 * ⚠️ THEY ARE OPTIONAL BECAUSE UNITS WRITTEN BEFORE THIS CHANGE DO NOT HAVE THEM,
 * AND THOSE UNITS CAN NEVER GAIN THEM. `parse.ts` passes the array through
 * verbatim, so a pre-change record round-trips with unstamped units forever. A
 * consumer must therefore treat "no `ts`" as *unplaceable in time* and must NOT
 * substitute a default — any default is an invented timestamp. acpx-ui handles that
 * set explicitly (its pre-migration remainder row).
 *
 * ⚠️ snake_case, like every key here, and for the reason on {@link UnitRates}:
 * these keys reach the session record verbatim.
 */
export type CostUnit = {
  input: number;
  output: number;
  /** Informational subset of output; excluded from priceUnit arithmetic. */
  reasoning?: number;
  cache_read: number;
  cache_write: number;
  /** `null` ⇔ no catalogue row was found ⇒ this unit is unpriceable. */
  rates: UnitRates | null;
  /**
   * ISO-8601 instant the usage event was observed. Absent on units written before
   * brick 19693941 — see the header; absence means "cannot be placed in time".
   */
  ts?: string;
  /**
   * The model in force for THIS unit. `null` when the session had no current
   * model. Stored per unit because a session can switch models mid-flight, so a
   * session-level model would misattribute every unit before the switch.
   */
  model?: string | null;
  /**
   * This unit's own price in USD, from {@link priceUnit} — `null` ⇔ unpriceable.
   *
   * ⚠️ STAMPED HERE SO THE PRICING RULE STAYS IN ONE PLACE. A consumer that needs
   * a per-unit cost would otherwise have to re-implement `priceUnit` — including
   * the `-1` VARIABLE marker, the measured-free asymmetry, and
   * `cacheRateMissingWhereItMatters` — in another repo, where it would drift out of
   * agreement silently. The invariant that keeps this honest: the non-null
   * `cost_usd` values sum to `deriveCostFigure(units).amount` whenever provenance
   * is `computed`, and `cost-ingest.test.ts` pins exactly that.
   */
  cost_usd?: number | null;
  /**
   * The provider that ACTUALLY SERVED this message, verbatim from OpenRouter's
   * response (`"Modal"`), or `null` (brick 4c272cab §8).
   *
   * 🛑 **`null` MEANS "NOT RECORDED" AND NOTHING ELSE. IT IS NEVER THE PROVIDER
   * THE BOX PREFERRED.** A preference is a preference: the named provider is
   * routinely unavailable — measured, BaseTen and Crusoe were both hard-429 for
   * an afternoon while a correct policy was in force — so substituting the
   * policy's first choice would make the routing feature UN-FALSIFIABLE, because
   * the record would then agree with the preference by construction, including
   * on every turn where the preference did not hold.
   *
   * Populated on the Claude/OpenRouter shim path, where acpx owns the proxy and
   * sees the real response. `null` on every non-OpenRouter path, and `null` ON
   * THE pi PATH AT INGEST TIME even when the turn is ultimately attributed: pi
   * talks to OpenRouter directly, so the unit is stamped with a
   * {@link CostUnit.response_id} and the provider is resolved ~10 s later, by
   * which time this unit is already on disk. **Read `acpx.last_turn_provider`,
   * not this field, for "who served the most recent turn" on pi.**
   */
  provider_name?: string | null;
  /** The provider's own, un-normalised finish reason; `null` = not recorded. */
  native_finish_reason?: string | null;
  /**
   * OpenRouter's generation id for the response this unit priced, or `null`
   * (brick 77054e85).
   *
   * ⚠️ **A HANDLE, NOT AN ANSWER, AND NOT BACKFILLED.** It says which generation
   * produced the unit — enough for a human or a later tool to ask
   * `/api/v1/generation?id=` — but the lazy resolver writes its answer to
   * `acpx.last_turn_provider` only, never back onto historical units. So a unit
   * routinely carries `response_id` beside `provider_name: null`, and that pair
   * means "identified, resolved elsewhere", not "unresolvable".
   */
  response_id?: string | null;
};

/**
 * An unquoted cache rate is NOT a zero rate; but a session with no cached tokens
 * is unaffected by it, so only charge the absence when it would actually matter.
 */
function cacheRateMissingWhereItMatters(unit: CostUnit, rates: UnitRates): boolean {
  return (
    (unit.cache_read > 0 && rates.cache_read_per_m === null) ||
    (unit.cache_write > 0 && rates.cache_write_per_m === null)
  );
}

/**
 * One unit's price in USD, or `null` when it cannot be priced.
 *
 * Exported (brick 19693941) so `cost-ingest` can stamp each unit's own
 * `cost_usd` at the moment it resolves that unit's rates. ⚠️ This is the ONLY
 * implementation of the per-unit pricing rule — the `-1` VARIABLE marker, the
 * measured-free asymmetry and the missing-cache-rate refusal all live here. Do not
 * re-derive it elsewhere, in this repo or another: the whole point of stamping
 * `cost_usd` is that no consumer has to.
 */
export function priceUnit(unit: CostUnit): number | null {
  const r = unit.rates;
  if (!r) {
    return null;
  }
  if (r.in_per_m === null || r.out_per_m === null) {
    return null;
  }
  if (cacheRateMissingWhereItMatters(unit, r)) {
    return null;
  }
  return (
    (r.in_per_m * unit.input +
      r.out_per_m * unit.output +
      (r.cache_read_per_m ?? 0) * unit.cache_read +
      (r.cache_write_per_m ?? 0) * unit.cache_write) /
    1_000_000
  );
}

/**
 * The figure for a harness that reported its own total and gave no units.
 * Coverage is `null` **by construction**, which is the only way `null` arises.
 */
export function reportedCost(amount: number, currency = "USD"): SessionCostFigure {
  return { amount, currency, provenance: "reported", coverage: null };
}

/**
 * The figure for a harness that gave token counts. Prices every unit it can and
 * reports honestly how many it could.
 *
 * `free` is asserted only when **every** unit is measured-free — a partial
 * `free` would silently absorb the missing entries, which is the same collapse
 * this brick exists to remove, one level up.
 */
export function deriveCostFigure(units: CostUnit[], currency = "USD"): SessionCostFigure {
  if (units.length === 0) {
    return { amount: null, currency, provenance: "unpriced", coverage: null };
  }
  let sum = 0;
  let priced = 0;
  for (const unit of units) {
    const usd = priceUnit(unit);
    if (usd === null) {
      continue;
    }
    sum += usd;
    priced += 1;
  }
  const coverage: CostCoverage = { unit: "message", priced, total: units.length };

  if (priced === 0) {
    // Nothing could be priced. The counts still ship: "0 of 3" is information,
    // and it is what distinguishes this from a source with no units at all.
    return { amount: null, currency, provenance: "unpriced", coverage };
  }
  if (priced === units.length && units.every((unit) => unit.rates?.measured_free === true)) {
    return { amount: 0, currency, provenance: "free", coverage };
  }
  return { amount: sum, currency, provenance: "computed", coverage };
}
