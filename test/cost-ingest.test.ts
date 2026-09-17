import assert from "node:assert/strict";
import test from "node:test";
import type { CostUnit, UnitRates } from "../src/models/cost-provenance.js";
import { assertPersistedKeyPolicy } from "../src/persisted-key-policy.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import { rememberSessionCost } from "../src/session/cost-ingest.js";
import type { SessionAcpxState } from "../src/types.js";

// brick://5026423b — the ingest caller `cost-provenance.ts` shipped without.
//
// The module was merged as a pure function with ZERO callers and `measuredFree`
// declared, consumed, and never assigned. These rows drive the caller that now
// exists; the derivation itself is pinned in `pi-models-store.test.ts` and is NOT
// re-tested here.

const PRICED: UnitRates = {
  in_per_m: 0.95,
  out_per_m: 4,
  cache_read_per_m: 0.16,
  cache_write_per_m: 0,
  measured_free: false,
};
const FREE: UnitRates = {
  in_per_m: 0,
  out_per_m: 0,
  cache_read_per_m: 0,
  cache_write_per_m: 0,
  measured_free: true,
};

function state(modelId = "openrouter/moonshotai/kimi-k2.6"): SessionAcpxState {
  return { current_model_id: modelId } as SessionAcpxState;
}

test("5026423b THE RULE: a ZERO adapter figure beside NON-ZERO tokens is never `reported`", () => {
  // ⚠️ THE ROW THE WHOLE BRICK EXISTS FOR, and the exact shape measured on pi
  // 2026-09-08: `cost.amount 0` alongside 7,838 in / 68 out. A harness handed a
  // catalogue entry with zeroed rates computes 0 and reports it TRUTHFULLY. If
  // ingest trusted that as `reported`, a confident $0.00 would ship on a session
  // that was never priced — Daniel's original bug, returning through the one
  // provenance whose contract is "trust the adapter".
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 7838, output: 68, cacheRead: 0, cacheWrite: 0, reportedAmount: 0 },
    () => PRICED,
  );
  assert.notEqual(acpx.cost?.provenance, "reported", "a zero adapter figure was trusted");
  assert.equal(acpx.cost?.provenance, "computed");
  assert.ok((acpx.cost?.amount ?? 0) > 0, "real tokens at real rates must not price to zero");
});

test("5026423b: an unpriceable model is `unpriced` with a NULL amount — never $0.00", () => {
  // The other half of the same rule: no catalogue row ⇒ no price. `amount: null`
  // is what stops a consumer rendering it as free.
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 7838, output: 68, cacheRead: 0, cacheWrite: 0, reportedAmount: 0 },
    () => null,
  );
  assert.equal(acpx.cost?.provenance, "unpriced");
  assert.equal(acpx.cost?.amount, null, "an unpriced figure must carry null, never 0");
  assert.deepEqual(acpx.cost?.coverage, { unit: "message", priced: 0, total: 1 });
});

test("5026423b: `measuredFree` is ASSIGNED — a row quoting zero yields `free`, absence never does", () => {
  // The field the brick reports as never written anywhere in src. Two-sided: the
  // discrimination is one-directional and only a POSITIVE zero row may reach
  // `free`.
  const free = state();
  rememberSessionCost(free, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, () => FREE);
  assert.equal(free.cost?.provenance, "free");
  assert.equal(free.cost?.amount, 0, "a measured-free figure is a real zero");

  const absent = state();
  rememberSessionCost(absent, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, () => null);
  assert.equal(absent.cost?.provenance, "unpriced", "absence of a row must never read as free");
});

test("5026423b: `reported` is admitted for a NON-ZERO adapter figure with no units", () => {
  // The positive arm — a harness that gives a total and no token breakdown
  // (claude / claude-pty). Without this the rule above would read as "never
  // trust the adapter", which is not what it says.
  const acpx = state();
  rememberSessionCost(acpx, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reportedAmount: 6.44,
  });
  assert.equal(acpx.cost?.provenance, "reported");
  assert.equal(acpx.cost?.amount, 6.44);
  assert.equal(acpx.cost?.coverage, null, "no units ⇒ not decomposable by construction");
});

test("5026423b: units accumulate PER MESSAGE and coverage counts them", () => {
  // One unit per assistant message_end, not per turn — a turn holds several.
  const acpx = state();
  for (const input of [100, 200, 300]) {
    rememberSessionCost(acpx, { input, output: 10, cacheRead: 0, cacheWrite: 0 }, () => PRICED);
  }
  assert.equal(acpx.cost_units?.length, 3);
  assert.deepEqual(acpx.cost?.coverage, { unit: "message", priced: 3, total: 3 });
});

test("5026423b: a mid-session model switch prices each unit at ITS OWN rates", () => {
  // Why the unit is `message` and not `model`: a cumulative counter summed across
  // a switch attributes one model's tokens to the other.
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    () => PRICED,
  );
  const afterFirst = acpx.cost?.amount ?? 0;
  rememberSessionCost(
    acpx,
    { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    () => FREE,
  );
  assert.equal(afterFirst, 0.95, "first unit priced at the priced model's rate");
  assert.equal(
    acpx.cost?.amount,
    0.95,
    "the free unit added nothing — it was not re-priced at 0.95",
  );
  assert.equal(acpx.cost?.provenance, "computed", "a partial free must NOT collapse to `free`");
});

test("5026423b ⚠️ THE ALLOWLIST LEG: cost and cost_units survive cloneSessionAcpxState", () => {
  // 🛑 THE ROW THAT CATCHES THE FAILURE THIS CODEBASE HAS ALREADY HAD THREE TIMES.
  // `cloneSessionAcpxState` is a field-by-field allowlist the turn path re-bases
  // `record.acpx` off. A field missing from it is present at `sessions new` and
  // NULL AFTER ONE PROMPT, with typecheck, lint and the entire unit suite green —
  // `applied_output_style` (874fee67), `served` (07dd62c9) and `depth_projection`
  // were all lost exactly that way. Asserted as a PROPERTY of the clone, not as a
  // source-text check.
  const acpx = state();
  rememberSessionCost(acpx, { input: 500, output: 20, cacheRead: 0, cacheWrite: 0 }, () => PRICED);
  assert.ok(acpx.cost, "control: the fixture must have a cost before the clone");

  const cloned = cloneSessionAcpxState(acpx);
  assert.deepEqual(cloned?.cost, acpx.cost, "the cost figure did not survive the per-turn clone");
  assert.deepEqual(
    cloned?.cost_units,
    acpx.cost_units,
    "the units did not survive the per-turn clone",
  );

  // And it is a COPY, not a shared reference — a later mutation of the clone must
  // not reach back into the record the turn path is still holding.
  cloned.cost.amount = 999;
  assert.notEqual(acpx.cost?.amount, 999, "the clone aliased the original instead of copying it");
});

// ---------------------------------------------------------------------------
// 🛑 THE ROW THAT WOULD HAVE CAUGHT MY OWN GAP.
//
// Every row above hands `rememberSessionCost` a synthetic `UsageObservation`, so
// they all pass while the EXTRACTION from the real `usage_update` envelope is
// wrong or unwired — which is exactly the shape of failure this brick is about
// (a pure function with no caller, green tests, nothing persisted). The envelope
// below is COPIED VERBATIM off the wire from a real pi turn on 2026-09-08, and it
// is driven through `recordSessionUpdate`, the entry point the runtime calls —
// not through the helper.
// ---------------------------------------------------------------------------

test("5026423b THE WIRE: a REAL pi usage_update envelope lands a cost through recordSessionUpdate", async () => {
  const { createSessionConversation, recordSessionUpdate } =
    await import("../src/session/conversation-model.js");
  const conversation = createSessionConversation();
  const acpx = { current_model_id: "openrouter/moonshotai/kimi-k2.6" } as SessionAcpxState;

  // Verbatim from `~/.acpx/sessions/<id>.stream.ndjson`, session 01a081b5.
  const notification = {
    sessionId: "01a081b5-5254-7c68-855f-f12efa0d0bb3",
    update: {
      sessionUpdate: "usage_update",
      used: 7927,
      size: 262144,
      cost: { amount: 0.00386535, currency: "USD" },
      _meta: {
        piAcp: {
          message: {
            input: 3161,
            output: 26,
            reasoning: 21,
            cacheRead: 4740,
            cacheWrite: 0,
            totalTokens: 7927,
            costUsd: 0.00386535,
          },
        },
      },
    },
  } as unknown as Parameters<typeof recordSessionUpdate>[2];

  const out = recordSessionUpdate(conversation, acpx, notification, "2026-09-08T00:00:00.000Z", {
    promptEverSubmitted: true,
  });

  assert.equal(
    out.cost_units?.length,
    1,
    "the real envelope produced no unit — the extraction is wrong or unwired",
  );
  const unit = out.cost_units[0];
  assert.deepEqual(
    {
      input: unit.input,
      output: unit.output,
      cacheRead: unit.cache_read,
      cacheWrite: unit.cache_write,
    },
    { input: 3161, output: 26, cacheRead: 4740, cacheWrite: 0 },
    "the per-message deltas were not read off `_meta.piAcp.message`",
  );
  // ⚠️ `used` is the CONTEXT FILL (7,927), not an input delta. If the extractor
  // ever reads it as one, this is the assertion that says so.
  assert.notEqual(unit.input, 7927, "`used` was read as an input delta — it is the context level");
  // `reasoning` is not billed as output; folding it in would over-charge every
  // reasoning model. Reconciled against the catalogue on a real session.
  assert.equal(unit.output, 26, "`reasoning` was folded into `output`");
  assert.ok(out.cost, "no cost figure was produced from a real envelope");
});

test("5026423b DRIFT PIN: the leaf rate derivation agrees with `deriveBilling` on real rows", async () => {
  // 🛑 `cost-ingest.ts` derives rates itself instead of importing `deriveBilling`.
  // The reason originally recorded here — that the import killed the update in the
  // bundled build — was measured and DISPROVEN (brick://48aca560; the real cause
  // was camelCase keys in the persisted payload). The duplication stays because it
  // is cheap and pinned, not because the import is forbidden; THIS row is what
  // stops it becoming drift, whichever way that choice later goes.
  //
  // Driven off the box's real catalogue rows rather than invented pricing, so it
  // covers the shapes that actually occur — including `-1` (variable) and rows
  // quoting zero.
  const { deriveBilling } = await import("../src/models/catalogue.js");
  const { readOpenRouterCacheSync, defaultCatalogueCachePath } =
    await import("../src/models/openrouter-catalogue.js");
  const { lookupUnitRates } = await import("../src/session/cost-ingest.js");

  const snapshot = readOpenRouterCacheSync(defaultCatalogueCachePath());
  if (!snapshot || snapshot.models.length === 0) {
    // A cold cache cannot make this row pass vacuously — say so and skip loudly.
    assert.ok(true, "SKIPPED: no OpenRouter catalogue on this box to compare against");
    return;
  }

  let compared = 0;
  for (const row of snapshot.models.slice(0, 120)) {
    const billing = deriveBilling(row);
    const mine = lookupUnitRates(row.id);
    assert.ok(mine, `${row.id}: the leaf lookup found no row for a model the cache holds`);
    assert.deepEqual(
      {
        i: mine.in_per_m,
        o: mine.out_per_m,
        cr: mine.cache_read_per_m,
        cw: mine.cache_write_per_m,
      },
      {
        i: billing.inPerM,
        o: billing.outPerM,
        cr: billing.cacheReadPerM,
        cw: billing.cacheWritePerM,
      },
      `${row.id}: leaf rates disagree with deriveBilling`,
    );
    assert.equal(
      mine.measured_free,
      billing.kind === "free",
      `${row.id}: measuredFree disagrees with deriveBilling's free kind`,
    );
    compared += 1;
  }
  assert.ok(
    compared > 50,
    `population control: only ${compared} rows compared — this row proved little`,
  );
});

// ─── brick 19693941: per-unit stamping (ts / model / cost_usd) ────────────────

const FIXED = new Date("2026-09-09T14:03:02.125Z");
const clock = (): Date => FIXED;

/**
 * The session's units, asserted present.
 *
 * ⚠️ THIS EXISTS BECAUSE THE REPO'S TWO CHECKERS CONTRADICT EACH OTHER ON
 * `acpx.cost_units!`. `tsgo` under `tsconfig.test.json` rejects the bare access
 * (`TS18048: 'acpx.cost_units' is possibly 'undefined'`) so the `!` is REQUIRED;
 * `oxlint --type-aware` rejects the `!` (`no-unnecessary-type-assertion`) so it is
 * FORBIDDEN. The baseline lives with the oxlint error in this very file — tsc wins
 * there because it blocks the build while lint does not.
 *
 * `assert.ok` is declared `asserts value`, so this narrows for tsc with no assertion
 * operator anywhere: both checkers are satisfied instead of one being overruled.
 * Do not "simplify" this back to `acpx.cost_units!` — that re-picks a side.
 */
function unitsOf(acpx: SessionAcpxState): CostUnit[] {
  const units = acpx.cost_units;
  assert.ok(units, "expected rememberSessionCost to have written cost_units");
  return units;
}

test("19693941: every new unit is stamped with ts, model and its own cost_usd", () => {
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 3692, output: 24, cacheRead: 6854, cacheWrite: 0 },
    () => PRICED,
    clock,
  );
  const unit = unitsOf(acpx)[0];
  assert.equal(unit.ts, "2026-09-09T14:03:02.125Z");
  assert.equal(unit.model, "openrouter/moonshotai/kimi-k2.6");
  // 3692×0.95 + 24×4 + 6854×0.16, per million — the real devbox session 01a082bf.
  assert.equal(unit.cost_usd, (3692 * 0.95 + 24 * 4 + 6854 * 0.16) / 1_000_000);
  // And that figure IS the session total for a one-unit session.
  assert.equal(acpx.cost!.amount, unit.cost_usd);
});

test("19693941 THE INVARIANT: the non-null cost_usd values SUM to cost.amount", () => {
  // ⚠️ This is what makes stamping `cost_usd` safe rather than a second opinion. A
  // consumer emitting one row per unit must land on the same total the session
  // figure states; if these two could drift, per-turn rows would silently disagree
  // with the session they belong to. Mixed priced/unpriced on purpose — the
  // unpriceable unit must contribute to NEITHER side.
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 6810, output: 226, cacheRead: 1088, cacheWrite: 0 },
    () => PRICED,
    clock,
  );
  rememberSessionCost(
    acpx,
    { input: 260, output: 321, cacheRead: 7872, cacheWrite: 0 },
    () => PRICED,
    clock,
  );
  rememberSessionCost(
    acpx,
    { input: 500, output: 50, cacheRead: 0, cacheWrite: 0 },
    () => null,
    clock,
  );

  const units = unitsOf(acpx);
  assert.equal(units.length, 3);
  const summed = units.reduce((a, u) => a + (u.cost_usd ?? 0), 0);
  assert.equal(summed, acpx.cost!.amount, "per-unit prices must reconcile with the session figure");
  assert.equal(acpx.cost!.provenance, "computed");
  assert.deepEqual(acpx.cost!.coverage, { unit: "message", priced: 2, total: 3 });
  assert.equal(units[2].cost_usd, null, "an unpriceable unit stamps null, never 0");
});

test("19693941: an unpriceable unit is still stamped with ts and model", () => {
  // Absence of a price must not cost us the ability to PLACE the unit: a consumer
  // still needs to emit a flagged row for it, at the right time, on the right model.
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    () => null,
    clock,
  );
  const unit = unitsOf(acpx)[0];
  assert.equal(unit.cost_usd, null);
  assert.equal(unit.rates, null);
  assert.equal(unit.ts, "2026-09-09T14:03:02.125Z");
  assert.equal(unit.model, "openrouter/moonshotai/kimi-k2.6");
});

test("19693941: a MODEL SWITCH mid-session is attributed per unit, not session-wide", () => {
  // The reason `model` is stamped on the unit rather than read from the session: a
  // session-level model would retroactively relabel every unit before the switch.
  const acpx = state("openrouter/z-ai/glm-5.3-flash");
  rememberSessionCost(
    acpx,
    { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    () => PRICED,
    clock,
  );
  acpx.current_model_id = "openrouter/moonshotai/kimi-k2.6";
  rememberSessionCost(
    acpx,
    { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 },
    () => PRICED,
    clock,
  );
  assert.equal(unitsOf(acpx)[0].model, "openrouter/z-ai/glm-5.3-flash");
  assert.equal(unitsOf(acpx)[1].model, "openrouter/moonshotai/kimi-k2.6");
});

test("19693941: a session with no current model stamps model null, not a guess", () => {
  const acpx = {} as SessionAcpxState;
  rememberSessionCost(
    acpx,
    { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
    () => PRICED,
    clock,
  );
  assert.equal(unitsOf(acpx)[0].model, null);
  assert.equal(unitsOf(acpx)[0].cost_usd, null, "no model ⇒ no rates ⇒ unpriceable");
});

test("19693941: a free model stamps cost_usd 0 — measured free, not absent", () => {
  // The measured-free asymmetry must survive stamping: 0 here means a catalogue row
  // QUOTED zero, which is categorically different from `null` (no row at all).
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
    () => FREE,
    clock,
  );
  assert.equal(unitsOf(acpx)[0].cost_usd, 0);
  assert.equal(acpx.cost!.provenance, "free");
});

test("19693941: the stamped keys satisfy the PERSISTED KEY POLICY", () => {
  // ⚠️ THE TRAP THIS TEST EXISTS FOR (brick://48aca560): a non-snake_case key on an
  // object under `acpx.cost_units` makes `assertPersistedKeyPolicy` throw INSIDE the
  // session-record write, before `fs.writeFile` — and the failure is not "cost is
  // missing", it is the WHOLE RECORD silently not being written, taking unrelated
  // shipped fields with it, with a green suite. These three keys are new on that
  // exact object, so they are checked through the real policy, not by eye.
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
    () => PRICED,
    clock,
  );
  assert.doesNotThrow(() => assertPersistedKeyPolicy({ acpx }));
  // The billed path's key (brick ccef550f) rides the same object — checked
  // through the real policy too, not by eye.
  const billed = state();
  rememberSessionCost(
    billed,
    { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, billedAmount: 0.01 },
    () => PRICED,
    clock,
  );
  assert.doesNotThrow(() => assertPersistedKeyPolicy({ acpx: billed }));
  // Control: the policy must actually be capable of rejecting, or the line above
  // proves nothing (a guard that cannot fail is not a guard).
  assert.throws(
    () => assertPersistedKeyPolicy({ acpx: { cost_units: [{ costUsd: 1 }] } }),
    /Persisted key policy violation/,
  );
});

test("19693941: stamping is ADDITIVE — a pre-change unit without the fields still prices", () => {
  // Units written before this change can never gain stamps, and `parse.ts` passes
  // the array through verbatim, so the derivation must keep working over a mixed
  // array. A consumer tells the two apart by `ts` being absent — never by a default.
  const acpx = state();
  acpx.cost_units = [{ input: 100, output: 10, cache_read: 0, cache_write: 0, rates: PRICED }];
  rememberSessionCost(
    acpx,
    { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 },
    () => PRICED,
    clock,
  );
  const units = unitsOf(acpx);
  assert.equal(units.length, 2);
  assert.equal(units[0].ts, undefined, "the legacy unit stays unstamped");
  assert.equal(units[1].ts, "2026-09-09T14:03:02.125Z");
  assert.equal(acpx.cost!.coverage!.total, 2, "both units still count toward coverage");
  assert.equal(acpx.cost!.provenance, "computed");
});

// ─── brick ccef550f: the billed path ────────────────────────────────────────
//
// The catalogue's single list row is ONE serving endpoint's price; OpenRouter
// routes across providers at materially different tiers, so the computed figure
// under-prices what was actually charged (measured 2026-09-17: $0.3365 computed
// vs $0.904 billed on one session). When the adapter hands us its own non-zero
// per-message figure beside real tokens, THAT is recorded verbatim with the
// `cost_source: "adapter"` marker. The zero-figure guard — the 2026-09-08
// zeroed-catalogue landmine — is KEPT, at the right granularity.

test("ccef550f THE BILLED RULE: a NON-ZERO per-message figure beside tokens is recorded verbatim", () => {
  const acpx = state();
  // Deliberately WIDER than the catalogue: the whole point is that the adapter
  // figure must win, not average in. priceUnit would say 0.95 for these tokens.
  rememberSessionCost(
    acpx,
    { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, billedAmount: 2.5 },
    () => PRICED,
    clock,
  );
  const unit = unitsOf(acpx)[0];
  assert.equal(unit.cost_usd, 2.5, "the catalogue figure must not replace the billed one");
  assert.equal(unit.cost_source, "adapter", "a billed unit must carry the adapter marker");
  assert.equal(acpx.cost!.amount, 2.5);
  assert.equal(acpx.cost!.provenance, "reported");
  assert.deepEqual(acpx.cost!.coverage, { unit: "message", priced: 1, total: 1 });
  // The rates stay stamped: they are still the record of what the catalogue
  // SAID, which is what makes the billed-vs-computed gap auditable later.
  assert.deepEqual(unit.rates, PRICED);
});

test("ccef550f THE GUARD, KEPT: a ZERO billed figure beside NON-ZERO tokens falls back to the catalogue", () => {
  // The 2026-09-08 shape, now arriving as billedAmount: a harness with a zeroed
  // catalogue row reports 0 TRUTHFULLY beside real tokens. Zero goes to the
  // catalogue path exactly as if no figure had arrived — this row is why the
  // guard could be refined rather than deleted.
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 7838, output: 68, cacheRead: 0, cacheWrite: 0, billedAmount: 0 },
    () => PRICED,
    clock,
  );
  const unit = unitsOf(acpx)[0];
  assert.equal(unit.cost_usd, (7838 * 0.95 + 68 * 4) / 1_000_000, "priced from the catalogue");
  assert.equal(unit.cost_source, undefined, "no adapter marker on a catalogue-priced unit");
  assert.equal(acpx.cost!.provenance, "computed");

  // Same on the unpriced arm: no row + zero figure stays honestly unpriced.
  const absent = state();
  rememberSessionCost(
    absent,
    { input: 7838, output: 68, cacheRead: 0, cacheWrite: 0, billedAmount: 0 },
    () => null,
    clock,
  );
  assert.equal(absent.cost!.provenance, "unpriced");
  assert.equal(absent.cost!.amount, null);
});

test("ccef550f: a billed unit prices even with a COLD catalogue (rates null)", () => {
  // A billed figure owes the catalogue nothing — the cold-cache flap that made
  // ingest resolve rates eagerly (see this module's header) must not downgrade
  // an as-billed number to `unpriced`.
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 5000, output: 50, cacheRead: 0, cacheWrite: 0, billedAmount: 0.017 },
    () => null,
    clock,
  );
  const unit = unitsOf(acpx)[0];
  assert.equal(unit.cost_usd, 0.017);
  assert.equal(unit.rates, null);
  assert.equal(acpx.cost!.provenance, "reported");
  assert.deepEqual(acpx.cost!.coverage, { unit: "message", priced: 1, total: 1 });
});

test("ccef550f THE INVARIANT, billed arm: the adapter figures SUM to cost.amount", () => {
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, billedAmount: 0.01 },
    () => PRICED,
    clock,
  );
  rememberSessionCost(
    acpx,
    { input: 2000, output: 20, cacheRead: 0, cacheWrite: 0, billedAmount: 0.02 },
    () => PRICED,
    clock,
  );
  const units = unitsOf(acpx);
  assert.equal(units.length, 2);
  const summed = units.reduce((a, u) => a + (u.cost_usd ?? 0), 0);
  assert.equal(summed, acpx.cost!.amount, "per-unit billed prices must reconcile with the figure");
  assert.equal(summed, 0.03);
  assert.equal(acpx.cost!.provenance, "reported");
});

test("ccef550f: MIXED billed + catalogue units read `computed`, never `reported`", () => {
  // `reported` claims adapter trust for the whole figure; a session that mixed
  // billed units with catalogue-estimated ones (model switch to a model whose
  // adapter carries no per-message cost) must not borrow that trust.
  const acpx = state();
  rememberSessionCost(
    acpx,
    { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, billedAmount: 0.01 },
    () => PRICED,
    clock,
  );
  rememberSessionCost(
    acpx,
    { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    () => PRICED,
    clock,
  );
  assert.equal(acpx.cost!.amount, 0.01 + 0.95);
  assert.equal(acpx.cost!.provenance, "computed");
  assert.deepEqual(acpx.cost!.coverage, { unit: "message", priced: 2, total: 2 });
});

test("ccef550f: a billed figure with NO units contributes nothing (no-units is the claude shape)", () => {
  // The no-units branch prices `reportedAmount` — the harness's SESSION total.
  // A per-message figure has no meaning there (and pi, the only adapter that
  // sends one, never reaches this branch: its updates always carry the counts).
  const acpx = state();
  rememberSessionCost(acpx, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    billedAmount: 0.5,
  });
  assert.equal(acpx.cost, undefined, "nothing was written from an orphaned per-message figure");
  assert.equal(acpx.cost_units, undefined);
});

test("ccef550f THE WIRE: the real envelope's message.costUsd lands as the billed unit through recordSessionUpdate", async () => {
  // Same verbatim envelope shape as the 5026423b row above (real pi turn,
  // session 01a081b5) — but now asserting the BILLED leg: `costUsd` rides
  // `_meta.piAcp.message` beside the counts, and that is what must be stamped.
  const { createSessionConversation, recordSessionUpdate } =
    await import("../src/session/conversation-model.js");
  const conversation = createSessionConversation();
  const acpx = { current_model_id: "openrouter/moonshotai/kimi-k2.6" } as SessionAcpxState;

  const notification = {
    sessionId: "01a081b5-5254-7c68-855f-f12efa0d0bb3",
    update: {
      sessionUpdate: "usage_update",
      used: 7927,
      size: 262144,
      cost: { amount: 0.00386535, currency: "USD" },
      _meta: {
        piAcp: {
          message: {
            input: 3161,
            output: 26,
            reasoning: 21,
            cacheRead: 4740,
            cacheWrite: 0,
            totalTokens: 7927,
            costUsd: 0.00386535,
          },
        },
      },
    },
  } as unknown as Parameters<typeof recordSessionUpdate>[2];

  const out = recordSessionUpdate(conversation, acpx, notification, "2026-09-17T00:00:00.000Z", {
    promptEverSubmitted: true,
  });

  const unit = out.cost_units?.[0];
  assert.ok(unit, "the envelope produced no unit");
  assert.equal(unit.cost_source, "adapter", "the per-message figure was not taken as billed");
  assert.equal(
    unit.cost_usd,
    0.00386535,
    "the unit must carry the wire figure, not a catalogue price",
  );
  assert.equal(out.cost?.provenance, "reported");
  assert.equal(out.cost?.amount, 0.00386535);
});
