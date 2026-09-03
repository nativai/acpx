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

// ─── helpers ─────────────────────────────────────────────────────────────────

function recordPinned(model: string, opts?: { floorHard?: boolean }): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: `rec-${model}`,
    acpSessionId: `sid-${model}`,
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace/projects/temp/te-fable51",
    acpx: {
      session_options: {
        model,
        effort: "max",
        ...(opts?.floorHard ? { floor_hard: true } : {}),
      },
      desired_config_options: { effort: "max" },
    },
  });
}
