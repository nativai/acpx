import assert from "node:assert/strict";
import test from "node:test";
import type { SessionModeState } from "@agentclientprotocol/sdk";
import { applyDepthAsMode } from "../src/session/depth-application.js";
import { piWireDepthValue } from "../src/session/depth-projection.js";

// F-14, SECOND WRITER (brick 06ae06c1 as corrected) — the MODE path must obey the
// same rule as the config-option arm: `exact` requires positive evidence that the
// agent serves the requested level.
//
// ⚠️ WHY THIS FILE EXISTS SEPARATELY FROM served-effort-from-wire.test.ts. The
// brick's original diagnosis attributed hp-te2's pi rows to
// `config-option-application.ts:339`. It cannot have produced them: pi's depth
// mechanism is `mode`, so `persistAndApplyRequestedEffort` returns from its mode
// arm above that line — verified at hp-te2's own build `1f59ebdf` — and pi's
// config option is `thought_level`, not `effort`, besides. hp-te2's TABLE was
// right; the code it pointed at was not the code that produced it. THIS is the
// writer that ran.
//
// ⚠️ THE FACT THAT MAKES AN HONEST RECORD POSSIBLE AT ALL: pi advertises SIX
// rungs (off/minimal/low/medium/high/xhigh) and serves THREE. acpx already KNEW
// this — it printed "Pi collapses off/minimal/low to {effort: low}" under
// --verbose in the same run in which it recorded `outcome:"exact"`,
// `served:"minimal"`. Two surfaces of one process contradicting each other, with
// the trusted one wrong.
//
// ⚠️ WHAT IS NOT FIXED HERE, DELIBERATELY: pi ADVERTISING six rungs while
// serving three. The advertisement is a genuine wire artifact — the agent said
// those are its modes — so acpx cannot correct it. That is brick f13fdceb (B5).
// This file only stops acpx recording `exact` for a level it knows is collapsed.

const PI_ADVERTISED = ["off", "minimal", "low", "medium", "high", "xhigh"];

function modes(currentModeId: string, ids = PI_ADVERTISED): SessionModeState {
  return {
    currentModeId,
    availableModes: ids.map((id) => ({ id, name: `Thinking: ${id}`, description: null })),
  } as unknown as SessionModeState;
}

function client(): { sent: string[]; setSessionMode: (s: string, m: string) => Promise<void> } {
  const sent: string[] = [];
  return {
    sent,
    setSessionMode(_sessionId, modeId) {
      sent.push(modeId);
      return Promise.resolve();
    },
  };
}

test("F-14/mode: `minimal` is recorded as PROJECTED to low, not exact", async () => {
  // hp-te2's row, verbatim: recorded {"requested":"minimal","outcome":"exact",
  // "served":"minimal"} while the wire carried {"effort":"low"}.
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "minimal",
    modes: modes("high"),
    harness: "pi",
  });

  assert.deepEqual(c.sent, ["minimal"], "control: the advertised rung must still be SENT");
  assert.equal(p.kind, "projected", `recorded ${p.kind} for a level pi collapses`);
  assert.equal(p.value, "low");
  assert.match(String(p.reason), /collapses to "low"/);
});

test("F-14/mode: `off` does not claim reasoning was disabled", async () => {
  // The most consequential rung: pi advertises `off`, and sends {"effort":"low"}
  // for it. Recording `exact` here asserts reasoning is off on a session that is
  // still reasoning.
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "off",
    modes: modes("high"),
    harness: "pi",
  });
  assert.equal(p.kind, "projected", "`off` was recorded as served exactly");
  assert.equal(p.value, "low");
});

test("F-14/mode: `high` KEEPS its exact — B3-04's PASS still stands", async () => {
  // The two-sided control, and it is load-bearing for the programme: B3-04
  // passed using `high`, which IS a wire value (pi collapses medium/high → high).
  // A fix that downgraded everything would invalidate a banked result.
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "high",
    modes: modes("low"),
    harness: "pi",
  });
  assert.deepEqual(c.sent, ["high"]);
  assert.equal(p.kind, "exact", "a genuinely served rung lost its exact");
  assert.equal(p.value, "high");
});

test("F-14/mode: `low` keeps its exact too", async () => {
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "low",
    modes: modes("high"),
    harness: "pi",
  });
  assert.equal(p.kind, "exact");
  assert.equal(p.value, "low");
});

test("F-14/mode: the collapse applies even when NO set is sent", async () => {
  // The agent already advertises the mode as current, so acpx sends nothing. The
  // mode is the agent's own word — but the wire collapse is unchanged by that, so
  // this arm must be downgraded identically. A fix applied only to the send path
  // would leave a second route to a false `exact`.
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "minimal",
    modes: modes("minimal"),
    harness: "pi",
  });
  assert.deepEqual(c.sent, [], "control: nothing should have been sent");
  assert.equal(p.kind, "projected", "the no-send arm still claims exact");
  assert.equal(p.value, "low");
});

test("F-14/mode: `max` off the advertised ladder stays projected", async () => {
  // `max` is not among pi's advertised modes, so the projection-by-position layer
  // moves it — to `high`, not `xhigh`: the canonical vocabulary has SEVEN rungs
  // and `max` is index 5, so `round(5/6 × 5) = 4` and pi's ladder[4] is `high`.
  // (I expected `xhigh` here and the test caught me, not the code.)
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "max",
    modes: modes("low"),
    harness: "pi",
  });
  assert.deepEqual(c.sent, ["high"], "control: acpx must have had to move the request");
  assert.equal(p.kind, "projected");
  assert.equal(p.value, "high");
});

test("F-14/mode: a projection is never UPGRADED, even when the collapse lands on the request", async () => {
  // ⚠️ THE LADDER HERE IS SYNTHETIC, and deliberately so. The hazard is real —
  // acpx sends X, the harness collapses X back to exactly what was requested, and
  // a naive "served === requested ⇒ exact" would UPGRADE a projection into a
  // claim acpx cannot make, because it never sent what was asked for. Pi's own
  // 6-rung ladder happens not to produce that alignment, so isolating the
  // invariant needs a ladder that does. Two rungs put `max` (canonical index 5)
  // at `round(5/6 × 1) = 1` → `xhigh`, which pi collapses back to `max`.
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "max",
    modes: modes("low", ["low", "xhigh"]),
    harness: "pi",
  });
  assert.deepEqual(c.sent, ["xhigh"], "control: the alignment this row exists for did not occur");
  assert.equal(p.value, "max", "control: the collapse must land back on the request");
  assert.equal(p.kind, "projected", "a collapse landing on the request was UPGRADED to exact");
});

test("F-14/mode ORACLE: every rung recorded `exact` IS on pi's three-value wire ladder", async () => {
  // The per-rung regression, with the WIRE ladder as the oracle — the same shape
  // as the opencode oracle, against the writer that actually ran for pi.
  const wireLadder = new Set(["low", "high", "max"]);
  const rungs = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const seen: Record<string, string> = {};
  let checked = 0;

  for (const rung of rungs) {
    const c = client();
    const p = await applyDepthAsMode({
      client: c,
      sessionId: "s1",
      requested: rung,
      modes: modes("low"),
      harness: "pi",
    });
    checked += 1;
    seen[rung] = `${p.kind}/${String(p.value)}`;
    if (p.kind === "exact") {
      assert.ok(
        wireLadder.has(String(p.value)),
        `${rung}: recorded exact with served="${String(p.value)}", NOT on pi's wire ladder low/high/max`,
      );
      assert.equal(p.value, rung, `${rung}: exact must mean the REQUESTED rung is served`);
    }
    // Whatever the outcome, a recorded served value must be something pi serves.
    if (p.value !== undefined) {
      assert.ok(
        wireLadder.has(p.value),
        `${rung}: recorded served="${p.value}", which pi does not serve (${JSON.stringify(seen)})`,
      );
    }
  }

  // ⚠️ POPULATION FIRST — 0 rungs would satisfy every assertion above vacuously.
  assert.equal(checked, rungs.length, `only ${checked} of ${rungs.length} rungs were exercised`);
  const exacts = Object.values(seen).filter((v) => v.startsWith("exact")).length;
  // Two-sided: neither "everything exact" (the defect) nor "nothing exact" (a
  // fix that just stopped saying it).
  assert.ok(
    exacts > 0,
    `no rung kept its exact — the fix downgrades everything: ${JSON.stringify(seen)}`,
  );
  assert.ok(
    exacts < rungs.length,
    `every rung was exact — the collapse is not being folded in: ${JSON.stringify(seen)}`,
  );
});

test("F-14/mode GUARDRAIL: the collapse table is NOT applied to another harness", async () => {
  // The table is pi's measurement. `mode` is pi's mechanism alone today, but an
  // ungated table would silently attribute pi's collapse to the next harness that
  // adopts the mode selector — and it would look exactly like a correct record.
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "minimal",
    modes: modes("high"),
    harness: "opencode",
  });
  assert.equal(p.kind, "exact", "pi's wire collapse was applied to a different harness");
  assert.equal(p.value, "minimal");

  // And with no harness named at all, nothing is folded in either.
  const p2 = await applyDepthAsMode({
    client: client(),
    sessionId: "s1",
    requested: "minimal",
    modes: modes("high"),
  });
  assert.equal(p2.kind, "exact", "an unnamed harness inherited pi's collapse");
});

test("F-14/mode: the collapse table and its human description cannot disagree", async () => {
  // They are one source of truth now. Before, the message was a separate ladder
  // of string literals — two hand-maintained copies of one measurement, which is
  // how a description keeps claiming something the code stopped doing.
  assert.equal(piWireDepthValue("off"), "low");
  assert.equal(piWireDepthValue("minimal"), "low");
  assert.equal(piWireDepthValue("low"), "low");
  assert.equal(piWireDepthValue("medium"), "high");
  assert.equal(piWireDepthValue("high"), "high");
  assert.equal(piWireDepthValue("xhigh"), "max");
  assert.equal(piWireDepthValue("max"), "max");
  assert.equal(
    piWireDepthValue("nonsense-zzz9"),
    undefined,
    "an unmeasured rung must not be guessed",
  );
});
