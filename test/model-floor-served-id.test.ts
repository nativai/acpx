import assert from "node:assert/strict";
import test from "node:test";
import { enforceModelFloorPostServe } from "../src/session/model-floor-enforce.js";
import { evaluateModelFloor } from "../src/session/model-floor.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// ─── Provenance of every model id used below ─────────────────────────────────
//
// Not one of these strings is invented. Each was read off a real wire or a real
// acpx session record during brick 99ff393b's verification (2026-09-01), and the
// evidence is copied into
// /wisdom/Bricks/8a54201e-a9f2-41e9-87bb-fde9c35bb12f/agents/a1d27ea9-6e43-4a47-b909-150962cb9d1a/evidence/:
//
//   claude-fable-5-1  served on adapter 0.3.257  (c5-fable-alias-mine, --model fable)
//   claude-fable-5    served on adapter 0.3.219  (c5-fable-alias-prod, --model fable)
//                     AND still servable by explicit pin under 0.3.257 (c14) — the two
//                     generations COEXIST, which is what makes the pair below reachable.
//   claude-sonnet-5   served on session b2330b79 while pinned claude-fable-5-1
//   sonnet / fable    alias pins as written into acpx.session_options.model
//
// The two `record-*.json` files are verbatim `acpx` blocks from live session
// records still on disk at /home/node/.acpx/sessions/.

// ─── R1 — THE DEFECT (brick 8a54201e) ────────────────────────────────────────

test("R1 concrete pin served an OLDER generation of its own family is below-floor", () => {
  // Both ids are real and both are servable under the current adapter (c14).
  // Before this fix `modelFamily` collapsed both to "fable", so this read
  // at-floor and nothing anywhere observed the downgrade.
  const e = evaluateModelFloor({
    pinnedModel: "claude-fable-5-1",
    pinnedEffort: "max",
    servedModel: "claude-fable-5",
  });
  assert.equal(e.status, "below-floor");
  assert.equal(e.reason, "model");
});

test("R1b the same blind spot is not Fable-specific — any concrete pin is exact", () => {
  const e = evaluateModelFloor({
    pinnedModel: "claude-opus-5",
    servedModel: "claude-opus-4-8",
  });
  assert.equal(e.status, "below-floor");
  assert.equal(e.reason, "model");
});

// ─── R2/R3 — the direction that must NOT false-alarm ─────────────────────────
//
// An ALIAS pin is a family-level request: the user asked for "fable", not for a
// generation. The SAME alias legitimately resolved to BOTH concrete ids within
// one day of each other (0.3.219 -> claude-fable-5, 0.3.257 -> claude-fable-5-1),
// so tightening aliases to exact ids would refuse real turns fleet-wide under
// --floor-hard. These two are the pin that keeps that from happening.

test("R2 alias pin satisfied by the concrete id it resolves to (fable -> 5.1, measured)", () => {
  const e = evaluateModelFloor({ pinnedModel: "fable", servedModel: "claude-fable-5-1" });
  assert.equal(e.status, "at-floor");
});

test("R3 the SAME alias satisfied by the OTHER generation (fable -> 5.0, measured)", () => {
  const e = evaluateModelFloor({ pinnedModel: "fable", servedModel: "claude-fable-5" });
  assert.equal(e.status, "at-floor");
});

test("R3b a context-hint alias pin still resolves to its family", () => {
  const e = evaluateModelFloor({ pinnedModel: "opus[1m]", servedModel: "claude-opus-5" });
  assert.equal(e.status, "at-floor");
});

// ─── R4 — a dated snapshot REFINES a concrete pin, it does not violate it ────

test("R4 concrete pin served a dated snapshot that extends it is at-floor", () => {
  // `claude-haiku-4-5-20251001` is the published dated id for `claude-haiku-4-5`.
  // Exact-string equality would refuse this real turn; component-boundary
  // extension accepts it. Note the asymmetry that keeps R1 caught: 5-1 is NOT an
  // extension of 5, so the R1 shortening is still a violation.
  const e = evaluateModelFloor({
    pinnedModel: "claude-haiku-4-5",
    servedModel: "claude-haiku-4-5-20251001",
  });
  assert.equal(e.status, "at-floor");
});

test("R4b extension must be at a COMPONENT boundary, not any string prefix", () => {
  // "claude-fable-5" is a string prefix of "claude-fable-51x" but not a
  // component-wise one; accepting it would re-open the R1 hole from the side.
  const e = evaluateModelFloor({
    pinnedModel: "claude-fable-5",
    servedModel: "claude-fable-51x",
  });
  assert.equal(e.status, "below-floor");
});

test("R4c a GENERATION BUMP must not ride in through the snapshot clause", () => {
  // R4b does NOT cover this one — `claude-fable-5-1` IS at a component boundary
  // after `claude-fable-5`, so a bare `startsWith(pin + "-")` accepts it and a
  // session pinned to generation 5 is silently served the newer, pricier 5.1.
  // That is the same silent-upgrade acceptance this module refuses when it
  // declines to rank models, arriving through the back door of the snapshot
  // clause. Requiring a DATE-shaped remainder is what separates the two — a
  // generation bump and a dated snapshot are otherwise the same shape.
  // R4 above is this test's other half: both directions are asserted, so the
  // asymmetry is a decision and not a property of `startsWith`.
  const e = evaluateModelFloor({
    pinnedModel: "claude-fable-5",
    servedModel: "claude-fable-5-1",
  });
  assert.equal(e.status, "below-floor");
  assert.equal(e.reason, "model");
});

// ─── N1–N4 — the four surviving mutants an independent test-engineer found ───
//
// My own mutation probe (M1–M4) reproduced by red name, but it only gutted the
// pieces I had thought to gut. A test-engineer ran four more and ALL FOUR
// SURVIVED the suite, then proved each is a real behaviour change rather than an
// equivalent mutant with a differ over 1824 (pin, served) combinations,
// fire-tested both ways. Each case below is that mutant's own witness, so each
// test kills exactly one gap. Verification §G.

test("N1 the date pattern needs its END anchor — a dated component with a suffix is not a snapshot", () => {
  // Mutant: /^\d{8}$/ -> /^\d{8}/  (16 differing combinations, survived the suite)
  const e = evaluateModelFloor({
    pinnedModel: "claude-fable-5",
    servedModel: "claude-fable-5-20251001-v2",
  });
  assert.equal(e.status, "below-floor");
});

test("N2 the date pattern needs its START anchor — a date embedded in a component is not a snapshot", () => {
  // Mutant: /^\d{8}$/ -> /\d{8}/  (38 differing combinations, survived the suite)
  const e = evaluateModelFloor({
    pinnedModel: "claude-fable-5",
    servedModel: "claude-fable-5-v20251001",
  });
  assert.equal(e.status, "below-floor");
});

test("N3 comparison is CASE-INSENSITIVE — an alias pin must not false-alarm on a capitalised served id", () => {
  // Mutant: normalizeModelId drops .toLowerCase()  (133 differing combinations).
  // The worst of the four and the reason all four are worth tests: it breaks the
  // ALIAS direction, which is the fleet-breaking one — 974 of 2813 live records
  // carry an alias pin. `normalizeModelId` is new in this change (the old
  // `modelFamily` lower-cased inline), so its `.toLowerCase()` became
  // load-bearing for BOTH clauses here and nothing asserted it at either ref.
  assert.equal(
    evaluateModelFloor({ pinnedModel: "fable", servedModel: "Claude-Fable-5-1" }).status,
    "at-floor",
  );
  // Load-bearing on the concrete clause too, and on the pin side as well as the
  // served side — so assert both rather than only the witness the mutant named.
  assert.equal(
    evaluateModelFloor({ pinnedModel: "Claude-Fable-5-1", servedModel: "claude-fable-5-1" }).status,
    "at-floor",
  );
  assert.equal(
    evaluateModelFloor({ pinnedModel: "FABLE", servedModel: "claude-fable-5-1" }).status,
    "at-floor",
  );
});

test("N4 the refinement test needs the COMPONENT SEPARATOR — `.` is not a component boundary", () => {
  // Mutant: startsWith(`${pinned}-`) -> startsWith(pinned)  (16 differing combinations)
  const e = evaluateModelFloor({
    pinnedModel: "claude-fable-5-1",
    servedModel: "claude-fable-5-1.20251001",
  });
  assert.equal(e.status, "below-floor");
});

// ─── R5/R6 — the two real session records, end-to-end through the enforce path ─

test("R5 real record b2330b79 (pin claude-fable-5-1, served claude-sonnet-5) is still caught", async () => {
  await withTempHome("acpx-floor-servedid-", async () => {
    const record = recordPinned("claude-fable-5-1", { floorHard: true });
    const verdict = await enforceModelFloorPostServe(record, { servedModel: "claude-sonnet-5" });
    assert.equal(
      verdict.accept,
      false,
      "a cross-family downgrade must stay refused under --floor-hard",
    );
    assert.equal(record.acpx?.served_below_floor?.served_model, "claude-sonnet-5");
    assert.equal(record.acpx?.served_below_floor?.pinned_model, "claude-fable-5-1");
  });
});

test("R6 real record b80f2910 (pin sonnet, served claude-fable-5-1) is surfaced, never silently accepted", async () => {
  await withTempHome("acpx-floor-servedid-", async () => {
    const record = recordPinned("sonnet");
    const verdict = await enforceModelFloorPostServe(record, {
      servedModel: "claude-fable-5-1",
    });
    // Default (non-hard) mode accepts the work but must leave the breadcrumb:
    // acpx has no capability rank, so it cannot call this an upgrade — what it
    // CAN say, and does, is that the served id is not the pinned one. Fable is
    // the most expensive model, so an unrequested Fable serve is exactly the
    // drift that must never pass unrecorded.
    assert.equal(verdict.accept, true);
    assert.equal(record.acpx?.served_below_floor?.served_model, "claude-fable-5-1");
    assert.equal(record.acpx?.served_below_floor?.pinned_model, "sonnet");
  });
});

// ─── R7 — the recovery direction still works after tightening ────────────────

test("R7 an at-floor serve after a mismatch clears the breadcrumb", async () => {
  await withTempHome("acpx-floor-servedid-", async () => {
    const record = recordPinned("claude-fable-5-1");
    await enforceModelFloorPostServe(record, { servedModel: "claude-fable-5" });
    assert.ok(record.acpx?.served_below_floor, "R1 mismatch must open an episode");
    const verdict = await enforceModelFloorPostServe(record, {
      servedModel: "claude-fable-5-1",
    });
    assert.equal(verdict.accept, true);
    assert.equal(verdict.recovered, true);
    assert.equal(record.acpx?.served_below_floor, undefined);
  });
});

// ─── R8/R9 — the `"default"` alias pin (brick 8a54201e's fix left this open;
// brick ac931199 closes it) ───────────────────────────────────────────────────
//
// `session_options.model === "default"` is not an invented fixture value — it
// is exactly what the acpx-ui model picker's "Default (Opus 5, 1M context)" row
// writes, and it is the LITERAL string `modelFamily`/`servedModelMatchesFloor`
// used to compare against the served id before this fix — "default" contains
// none of fable/opus/sonnet/haiku, so it always read as a concrete pin the
// served id could never match. Measured live on this box 2026-09-17: 64 of 70
// sessions pinned literally to `"default"` already carried a stale
// `served_below_floor` breadcrumb from this. Both records below are real, read
// verbatim off `~/.acpx/sessions/` (not hand-built):
//   02d69833-fce5-4a19-983a-0152aa53ec97 — default pin, non-hard, served
//     claude-opus-5 (`acpx.session_options`/`acpx.served` copied below).
//   82dd5bdb-affc-4a72-8cbe-07266278855c — default pin, `floor_hard: true`,
//     served claude-opus-5, and the record on disk carries BOTH
//     `served_below_floor` AND `floor_parked` (reason "model-floor-unmet") —
//     a REAL turn this bug refused under --floor-hard, not a hypothetical.

test('R8 alias pin "default" satisfied by its resolved target (record 02d69833, non-hard)', async () => {
  await withTempHome("acpx-floor-servedid-", async () => {
    const record = recordPinned("default", { effort: "default" });
    const verdict = await enforceModelFloorPostServe(record, {
      servedModel: "claude-opus-5",
      // "default" pin, so `deriveServedEffort` also authors the pin's effort
      // down; only the MODEL axis is under test here.
    });
    assert.equal(verdict.accept, true);
    assert.equal(
      record.acpx?.served_below_floor,
      undefined,
      '"default" pinned + opus served must NOT stamp a false-alarm breadcrumb',
    );
  });
});

test('R9 alias pin "default" under --floor-hard does NOT refuse a turn served the resolved target (record 82dd5bdb)', async () => {
  await withTempHome("acpx-floor-servedid-", async () => {
    // Same shape as the real 82dd5bdb record: default + floor_hard + max effort.
    const record = recordPinned("default", { floorHard: true, effort: "max" });
    const verdict = await enforceModelFloorPostServe(record, { servedModel: "claude-opus-5" });
    assert.equal(
      verdict.accept,
      true,
      'a floor-hard session pinned "default" and served the alias\'s own resolved target must complete the turn, not throw ModelFloorUnmetError',
    );
    assert.equal(
      record.acpx?.floor_parked,
      undefined,
      "must not stamp floor_parked — that is model-floor-enforce's own hard-mode quarantine breadcrumb, and this turn was never below floor",
    );
    assert.equal(record.acpx?.served_below_floor, undefined);
  });
});

test('R10 do-not-regress: alias-to-concrete pin "sonnet" still resolves without going through the alias table (records 6c3d6a29, 3b98a12c)', async () => {
  await withTempHome("acpx-floor-servedid-", async () => {
    const record = recordPinned("sonnet", { effort: "high" });
    const verdict = await enforceModelFloorPostServe(record, { servedModel: "claude-sonnet-5" });
    assert.equal(verdict.accept, true);
    assert.equal(record.acpx?.served_below_floor, undefined);
  });
});

test("R11 do-not-regress: a genuinely UNSET pin is still skipped, never asserted (record 01a14b21)", async () => {
  await withTempHome("acpx-floor-servedid-", async () => {
    const record = makeSessionRecord({
      acpxRecordId: "rec-unset",
      acpSessionId: "sid-unset",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: "/workspace/projects/temp/te-unset",
      acpx: { session_options: {} },
    });
    const verdict = await enforceModelFloorPostServe(record, { servedModel: "claude-opus-5" });
    assert.equal(verdict.accept, true);
    assert.equal(record.acpx?.served_below_floor, undefined);
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function recordPinned(
  model: string,
  opts?: { floorHard?: boolean; effort?: string },
): SessionRecord {
  const effort = opts?.effort ?? "max";
  return makeSessionRecord({
    acpxRecordId: `rec-${model}`,
    acpSessionId: `sid-${model}`,
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace/projects/temp/te-fable51",
    acpx: {
      session_options: {
        model,
        effort,
        ...(opts?.floorHard ? { floor_hard: true } : {}),
      },
      desired_config_options: { effort },
    },
  });
}
