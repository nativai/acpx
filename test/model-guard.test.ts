import assert from "node:assert/strict";
import test from "node:test";
import {
  NON_FABLE_DEFAULT_MODEL,
  guardImplicitFable,
  guardServedModel,
  pickNonFableDefault,
  resolveSpawnModelSource,
} from "../src/session/model-guard.js";

// ---------------------------------------------------------------------------
// R4 — guardImplicitFable truth table (brick://5bac5564)
// ---------------------------------------------------------------------------

test("guardImplicitFable: implicit Fable (inherited, no explicit) → forced non-Fable", () => {
  const r = guardImplicitFable({
    resolvedModel: "fable",
    explicitModel: undefined,
    source: "inherited",
  });
  assert.equal(r.model, NON_FABLE_DEFAULT_MODEL);
  assert.equal(r.source, "guard-forced");
  assert.equal(r.forced, true);
  assert.equal(r.blocked, "fable");
});

test("guardImplicitFable: explicit Fable is PRESERVED (never forced)", () => {
  const r = guardImplicitFable({
    resolvedModel: "fable",
    explicitModel: "fable",
    source: "explicit",
  });
  assert.equal(r.model, "fable");
  assert.equal(r.source, "explicit");
  assert.equal(r.forced, false);
  assert.equal(r.blocked, undefined);
});

test("guardImplicitFable: a non-Fable resolution is untouched", () => {
  const r = guardImplicitFable({
    resolvedModel: "opus",
    explicitModel: undefined,
    source: "inherited",
  });
  assert.equal(r.model, "opus");
  assert.equal(r.source, "inherited");
  assert.equal(r.forced, false);
});

test("guardImplicitFable: alias / case variants all caught as implicit Fable", () => {
  for (const fable of ["claude-fable-5", "FABLE", "claude-fable-5[1m]", "Claude-Fable-5"]) {
    const r = guardImplicitFable({
      resolvedModel: fable,
      explicitModel: undefined,
      source: "inherited",
    });
    assert.equal(r.forced, true, `${fable} should be forced`);
    assert.equal(r.model, NON_FABLE_DEFAULT_MODEL);
    assert.equal(r.blocked, fable);
  }
});

test("guardImplicitFable: explicit Fable alias/case variants are all preserved", () => {
  for (const fable of ["claude-fable-5", "FABLE", "claude-fable-5[1m]"]) {
    const r = guardImplicitFable({
      resolvedModel: fable,
      explicitModel: fable,
      source: "explicit",
    });
    assert.equal(r.forced, false, `explicit ${fable} must be preserved`);
    assert.equal(r.model, fable);
  }
});

test('guardImplicitFable: the "default" alias is NOT caught by the string-guard (documented edge)', () => {
  // isFableModel("default") === false — the string-guard cannot see a profile
  // whose `default` resolves to Fable server-side. Q2/Layer-A close this by
  // forcing a concrete non-Fable pin on implicit spawns; here we assert the
  // string-guard's own behavior so the edge stays visible (RCA §4 Layer-B edge).
  const r = guardImplicitFable({
    resolvedModel: "default",
    explicitModel: undefined,
    source: "default",
  });
  assert.equal(r.forced, false);
  assert.equal(r.model, "default");
});

test("guardImplicitFable: prefers a concrete advertised non-Fable model over the alias", () => {
  const r = guardImplicitFable({
    resolvedModel: "fable",
    explicitModel: undefined,
    source: "inherited",
    availableModels: ["default", "fable", "claude-opus-4-8", "claude-sonnet-4-6"],
  });
  assert.equal(r.model, "claude-opus-4-8");
  assert.equal(r.forced, true);
});

test("guardImplicitFable: undefined resolution is a no-op", () => {
  const r = guardImplicitFable({
    resolvedModel: undefined,
    explicitModel: undefined,
    source: "default",
  });
  assert.equal(r.model, undefined);
  assert.equal(r.forced, false);
});

// ---------------------------------------------------------------------------
// pickNonFableDefault
// ---------------------------------------------------------------------------

test("pickNonFableDefault: skips fable AND the bare `default` alias, returns first concrete", () => {
  assert.equal(
    pickNonFableDefault(["default", "fable", "claude-opus-4-8", "claude-sonnet-4-6"]),
    "claude-opus-4-8",
  );
});

test("pickNonFableDefault: undefined / all-fable / only-default → undefined", () => {
  assert.equal(pickNonFableDefault(undefined), undefined);
  assert.equal(pickNonFableDefault(["fable", "claude-fable-5"]), undefined);
  assert.equal(pickNonFableDefault(["default"]), undefined);
});

// ---------------------------------------------------------------------------
// resolveSpawnModelSource
// ---------------------------------------------------------------------------

test("resolveSpawnModelSource: explicit > inherited > default", () => {
  assert.equal(resolveSpawnModelSource("opus", "fable"), "explicit");
  assert.equal(resolveSpawnModelSource(undefined, "fable"), "inherited");
  assert.equal(resolveSpawnModelSource(undefined, undefined), "default");
  assert.equal(resolveSpawnModelSource("  ", undefined), "default"); // whitespace-only is not explicit
});

// ---------------------------------------------------------------------------
// guardServedModel — apply-tier belt + grandfather-legacy (HoD Q4)
// ---------------------------------------------------------------------------

test("guardServedModel: Fable pin with non-explicit provenance → forced", () => {
  const r = guardServedModel({ requestedModel: "fable", modelSource: "inherited" });
  assert.equal(r.model, NON_FABLE_DEFAULT_MODEL);
  assert.equal(r.forced, true);
  assert.equal(r.blocked, "fable");
});

test("guardServedModel: GRANDFATHER — absent provenance (legacy) is NEVER forced", () => {
  const r = guardServedModel({ requestedModel: "fable", modelSource: undefined });
  assert.equal(r.model, "fable");
  assert.equal(r.forced, false);
});

test("guardServedModel: explicit Fable provenance is preserved", () => {
  const r = guardServedModel({ requestedModel: "fable", modelSource: "explicit" });
  assert.equal(r.model, "fable");
  assert.equal(r.forced, false);
});

test("guardServedModel: guard-forced provenance on a Fable pin still forces (belt idempotent)", () => {
  const r = guardServedModel({ requestedModel: "fable", modelSource: "guard-forced" });
  assert.equal(r.forced, true);
  assert.equal(r.model, NON_FABLE_DEFAULT_MODEL);
});

test("guardServedModel: a non-Fable pin is untouched regardless of provenance", () => {
  for (const src of [undefined, "inherited", "explicit", "guard-forced", "default"]) {
    const r = guardServedModel({ requestedModel: "opus", modelSource: src });
    assert.equal(r.forced, false);
    assert.equal(r.model, "opus");
  }
});
