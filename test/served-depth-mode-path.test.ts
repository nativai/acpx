import assert from "node:assert/strict";
import test from "node:test";
import type { SessionModeState } from "@agentclientprotocol/sdk";
import { applyDepthAsMode } from "../src/session/depth-application.js";
import { advertisedServedEffort } from "../src/session/depth-projection.js";

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
// 🛑 AND THE FIRST VERSION OF THIS FILE ASSERTED A FACT THAT IS FALSE (B5, brick
// f13fdceb, measured 2026-09-04 against pi 0.84.4). It encoded pi's collapse as a
// FROZEN, MODEL-INDEPENDENT table — `off/minimal/low → low`, `medium/high →
// high`, `xhigh/max → max` — and tested the production table against a hand-copy
// of itself. The collapse is per MODEL, declared in each catalogue entry's
// `thinkingLevelMap`, and **not one of the 374 models in pi 0.84.4's OpenRouter
// catalogue has that shape**: 185 carry no map at all (every rung distinct), and
// the rest vary. So the "honest record" this file was written to produce was a
// different wrong answer wearing a measurement's clothes.
//
// ⚠️ WHAT REPLACED IT: acpx reads the served value out of the agent's OWN
// advertisement (`_meta.piAcp.servedEffort` on each advertised mode — the nativai
// `pi-acp` fork states it per model, `null` meaning no reasoning parameter is
// sent at all). When the adapter does not say, acpx folds in NOTHING and records
// no served value. A gap is a gap; an invented served value is a lie that reads
// like a measurement.

const PI_ADVERTISED = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * `served` maps an advertised mode id to what the agent says it will SEND.
 * Omit it entirely to model an adapter that advertises no `_meta` at all — an
 * upstream `pi-acp`, which is the case that must fold in nothing.
 */
function modes(
  currentModeId: string,
  served?: Record<string, string | null>,
  ids = PI_ADVERTISED,
): SessionModeState {
  return {
    currentModeId,
    availableModes: ids.map((id) => ({
      id,
      name: `Thinking: ${id}`,
      description: null,
      ...(served && id in served ? { _meta: { piAcp: { servedEffort: served[id] } } } : {}),
    })),
  } as unknown as SessionModeState;
}

/** The shape measured for `~google/gemini-flash-latest` in pi 0.84.4. */
const GEMINI_FLASH: Record<string, string | null> = {
  off: null,
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
};

/** A model that collapses, in the shape the old frozen table assumed. */
const COLLAPSING: Record<string, string | null> = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
};

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

test("F-14/mode: a collapsed rung is recorded as PROJECTED, not exact", async () => {
  // hp-te2's row, verbatim: recorded {"requested":"minimal","outcome":"exact",
  // "served":"minimal"} while the wire carried {"effort":"low"}.
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "minimal",
    modes: modes("high", COLLAPSING),
    harness: "pi",
  });

  assert.deepEqual(c.sent, ["minimal"], "control: the advertised rung must still be SENT");
  assert.equal(p.kind, "projected", `recorded ${p.kind} for a level the agent says it collapses`);
  assert.equal(p.value, "low");
  assert.match(String(p.reason), /serves as effort "low"/);
});

test("F-14/mode: a rung the model sends NOTHING for does not claim to have been served", async () => {
  // The most consequential rung, and on this real model shape it is not only
  // `off`: `xhigh` — the TOP advertised rung — also sends no reasoning parameter.
  for (const rung of ["off", "xhigh"]) {
    const c = client();
    const p = await applyDepthAsMode({
      client: c,
      sessionId: "s1",
      requested: rung,
      modes: modes("high", GEMINI_FLASH),
      harness: "pi",
    });
    assert.equal(p.kind, "projected", `"${rung}" was recorded as served exactly`);
    assert.equal(p.value, "none");
    assert.match(String(p.reason), /NO reasoning parameter/);
  }
});

test("F-14/mode: a rung the model serves as itself KEEPS its exact — B3-04's PASS still stands", async () => {
  // The two-sided control, and it is load-bearing for the programme: B3-04
  // passed using `high`. A fix that downgraded everything would invalidate a
  // banked result.
  for (const spec of [COLLAPSING, GEMINI_FLASH]) {
    const c = client();
    const p = await applyDepthAsMode({
      client: c,
      sessionId: "s1",
      requested: "high",
      modes: modes("low", spec),
      harness: "pi",
    });
    assert.deepEqual(c.sent, ["high"]);
    assert.equal(p.kind, "exact", "a genuinely served rung lost its exact");
    assert.equal(p.value, "high");
  }
});

test("F-14/mode REGRESSION: a model with NO collapse keeps every rung exact", async () => {
  // ⚠️ THE ROW THAT WOULD HAVE CAUGHT THE SHIPPED DEFECT. 185 of pi 0.84.4's 374
  // OpenRouter models carry no `thinkingLevelMap` at all — every rung passes
  // through untouched. The frozen table recorded `minimal` as served `low` on
  // those models too, which was simply false.
  const passthrough = Object.fromEntries(PI_ADVERTISED.map((id) => [id, id]));
  for (const rung of PI_ADVERTISED) {
    const p = await applyDepthAsMode({
      client: client(),
      sessionId: "s1",
      requested: rung,
      modes: modes("high", passthrough),
      harness: "pi",
    });
    // `off` has its own outcome kind (the ladder advertises an off rung, so the
    // request is honoured rather than projected) — what matters here is that
    // NOTHING was downgraded and the served value is the rung itself.
    assert.equal(
      p.kind,
      rung === "off" ? "off" : "exact",
      `"${rung}" was downgraded on a model that serves it exactly`,
    );
    assert.equal(p.value, rung);
  }
});

test("F-14/mode: an adapter that advertises no served value gets NOTHING folded in", async () => {
  // Upstream `pi-acp`. The old code substituted a table here; substituting
  // anything is the defect. The projection stands on its own, unembellished.
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "minimal",
    modes: modes("high"),
    harness: "pi",
  });
  assert.deepEqual(c.sent, ["minimal"]);
  assert.equal(p.kind, "exact", "a served value was invented for an adapter that said nothing");
  assert.equal(p.value, "minimal");
  assert.equal(
    advertisedServedEffort(modes("high"), "minimal"),
    undefined,
    "control: the reader must report 'did not say', not a guess",
  );
});

test("F-14/mode: the collapse applies even when NO set is sent", async () => {
  // The agent already advertises the mode as current, so acpx sends nothing. The
  // mode is the agent's own word — but the collapse is unchanged by that, so this
  // arm must be downgraded identically. A fix applied only to the send path would
  // leave a second route to a false `exact`.
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "minimal",
    modes: modes("minimal", COLLAPSING),
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
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "max",
    modes: modes("low", COLLAPSING),
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
  // claim acpx cannot make, because it never sent what was asked for.
  const c = client();
  const p = await applyDepthAsMode({
    client: c,
    sessionId: "s1",
    requested: "max",
    modes: modes("low", { low: "low", xhigh: "max" }, ["low", "xhigh"]),
    harness: "pi",
  });
  assert.deepEqual(c.sent, ["xhigh"], "control: the alignment this row exists for did not occur");
  assert.equal(p.value, "max", "control: the collapse must land back on the request");
  assert.equal(p.kind, "projected", "a collapse landing on the request was UPGRADED to exact");
});

test("F-14/mode ORACLE: every recorded served value is one the AGENT declared", async () => {
  // The per-rung regression, with the ADVERTISEMENT as the oracle — the same
  // shape as the opencode oracle, against the writer that actually ran for pi,
  // and now against a source that cannot go stale the way a frozen table did.
  const declared = new Set<string>(["none", ...Object.values(COLLAPSING).map((v) => v ?? "none")]);
  const rungs = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const seen: Record<string, string> = {};
  let checked = 0;

  for (const rung of rungs) {
    const p = await applyDepthAsMode({
      client: client(),
      sessionId: "s1",
      requested: rung,
      modes: modes("low", COLLAPSING),
      harness: "pi",
    });
    checked += 1;
    seen[rung] = `${p.kind}/${String(p.value)}`;
    if (p.kind === "exact") {
      assert.equal(p.value, rung, `${rung}: exact must mean the REQUESTED rung is served`);
      assert.equal(
        COLLAPSING[rung],
        rung,
        `${rung}: recorded exact although the agent declared it serves "${String(COLLAPSING[rung])}"`,
      );
    }
    if (p.value !== undefined) {
      assert.ok(
        declared.has(p.value),
        `${rung}: recorded served="${p.value}", which the agent never declared (${JSON.stringify(seen)})`,
      );
    }
  }

  // ⚠️ POPULATION FIRST — 0 rungs would satisfy every assertion above vacuously.
  assert.equal(checked, rungs.length, `only ${checked} of ${rungs.length} rungs were exercised`);
  const exacts = Object.values(seen).filter((v) => v.startsWith("exact")).length;
  // Two-sided: neither "everything exact" (the defect) nor "nothing exact" (a fix
  // that just stopped saying it).
  assert.ok(
    exacts > 0,
    `no rung kept its exact — the fix downgrades everything: ${JSON.stringify(seen)}`,
  );
  assert.ok(
    exacts < rungs.length,
    `every rung was exact — the collapse is not being folded in: ${JSON.stringify(seen)}`,
  );
});

test("F-14/mode GUARDRAIL: pi's `_meta` vocabulary is NOT read for another harness", async () => {
  // `_meta.piAcp` is pi-acp's own namespace. Reading it from another agent's
  // advertisement would attribute pi's semantics to something that never agreed
  // to them — and it would look exactly like a correct record.
  const p = await applyDepthAsMode({
    client: client(),
    sessionId: "s1",
    requested: "minimal",
    modes: modes("high", COLLAPSING),
    harness: "opencode",
  });
  assert.equal(p.kind, "exact", "pi's advertised collapse was applied to a different harness");
  assert.equal(p.value, "minimal");

  // And with no harness named at all, nothing is folded in either.
  const p2 = await applyDepthAsMode({
    client: client(),
    sessionId: "s1",
    requested: "minimal",
    modes: modes("high", COLLAPSING),
  });
  assert.equal(p2.kind, "exact", "an unnamed harness inherited pi's collapse");
});

test("advertisedServedEffort: reads the agent's word, and distinguishes null from silence", async () => {
  const advertised = modes("low", GEMINI_FLASH);
  assert.equal(advertisedServedEffort(advertised, "low"), "low");
  assert.equal(advertisedServedEffort(advertised, "off"), null, "null = sends no reasoning");
  assert.equal(
    advertisedServedEffort(advertised, "not-a-rung"),
    undefined,
    "a rung that is not advertised has no declared value",
  );
  assert.equal(
    advertisedServedEffort(modes("low"), "low"),
    undefined,
    "an adapter that advertises no _meta said nothing — never a guess",
  );
});
