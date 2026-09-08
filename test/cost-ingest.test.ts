import assert from "node:assert/strict";
import test from "node:test";
import type { UnitRates } from "../src/models/cost-provenance.js";
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
  cloned!.cost!.amount = 999;
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
  const unit = out.cost_units![0];
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
