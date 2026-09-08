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

/** One priceable usage event: token counts plus the rates in force for it. */
export type CostUnit = {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** `null` ⇔ no catalogue row was found ⇒ this unit is unpriceable. */
  rates: UnitRates | null;
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

function priceUnit(unit: CostUnit): number | null {
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
