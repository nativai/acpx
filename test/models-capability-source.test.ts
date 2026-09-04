import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HARNESS_IDS, listHarnessCapabilities } from "../src/acp/harness-capabilities.js";
import {
  readHarnessCapabilities,
  setHarnessCapabilitiesForTesting,
} from "../src/models/capability-source.js";
import { buildCatalogue } from "../src/models/catalogue.js";
import { harnessNativeModels } from "../src/models/harness-models.js";
import { isAvailableForAgent } from "../src/models/matcher.js";
import type { OpenRouterSnapshot } from "../src/models/openrouter-catalogue.js";

// Same fixture and resolution rule as models-catalogue.test.ts: from cwd, not
// import.meta.dirname, because the suite runs the COMPILED tests out of
// dist-test/ where the fixture folder does not exist.
const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/openrouter-models-2026-09-04.json");

function fixture(): OpenRouterSnapshot {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as OpenRouterSnapshot;
}

const META = { fetchedAt: "2026-09-04T00:10:56.992Z", stale: false, error: null };

test.afterEach(() => {
  setHarnessCapabilitiesForTesting(null);
});

// ── The wiring itself ────────────────────────────────────────────────────────

test("production reads the REAL harness table, not an empty one", () => {
  const table = readHarnessCapabilities();
  assert.deepEqual(
    table.map((row) => row.id),
    [...HARNESS_IDS],
    "every declared harness must reach the availability join, in HARNESS_IDS order",
  );
  // The negative this replaces: an empty table is what shipped at a5ba50fe and
  // it is indistinguishable, downstream, from "this box has no harnesses".
  assert.notEqual(table.length, 0);
});

test("the projection is EXACT — restoring `return listHarnessCapabilities()` goes red", () => {
  // Structural, not textual: it asks what the returned OBJECTS carry, so a
  // leftover import or comment cannot keep it green. The full §8 struct has
  // many more fields (fork, primerChannel, usageReporting, …), so handing it
  // through unprojected fails here even though it type-checks.
  for (const row of readHarnessCapabilities()) {
    assert.deepEqual(
      Object.keys(row).toSorted(),
      ["acceptsArbitraryModelIds", "id"],
      `${row.id}: the catalogue must see exactly the two fields the join reads`,
    );
  }
  // The control that proves the assertion above can distinguish the two: the
  // unprojected rows really do carry more, so the check is not vacuous.
  const unprojected = listHarnessCapabilities()[0];
  assert.ok(
    Object.keys(unprojected ?? {}).length > 2,
    "the §8 struct must be wider than the projection, or this test proves nothing",
  );
});

test("the test seam still overrides, and null restores the REAL table", () => {
  setHarnessCapabilitiesForTesting([{ id: "synthetic", acceptsArbitraryModelIds: true }]);
  assert.deepEqual(
    readHarnessCapabilities().map((row) => row.id),
    ["synthetic"],
  );
  setHarnessCapabilitiesForTesting(null);
  assert.deepEqual(
    readHarnessCapabilities().map((row) => row.id),
    [...HARNESS_IDS],
  );
});

// ── What the wiring changes downstream ───────────────────────────────────────

test("with NO capabilities option, every row now carries a per-agent availability", () => {
  // `buildCatalogue` defaults to `readHarnessCapabilities()`. Before the wiring
  // this produced a 0-key map on all 453 live rows (brick://db554b05
  // reports/MEASUREMENT.md) — and `isAvailableForAgent` reads a 0-key map as
  // "no table yet, so OFFER IT", which is how the OpenRouter band reached a
  // claude session that can serve six ids.
  const catalogue = buildCatalogue(fixture().models, META);
  for (const model of catalogue.models) {
    assert.deepEqual(
      Object.keys(model.availability).toSorted(),
      [...HARNESS_IDS].toSorted(),
      `${model.key} must answer for every harness`,
    );
  }
});

test("OpenRouter is locked for EVERY agent while no harness routes an arbitrary id", () => {
  // The PREDICTED state, not a regression (program TEST-PLAN §4.0, G3-BAND-01):
  // ARBITRARY_MODEL_SUPPORT_ROUTED_BY_ACPX is deliberately empty, so every
  // harness derives acceptsArbitraryModelIds:false and the whole OpenRouter
  // band renders locked. This test is written to FOLLOW that derivation rather
  // than to pin the current answer: when a harness starts routing `provisioned`
  // or `via-shim`, the expectation moves with it instead of going red.
  const catalogue = buildCatalogue(fixture().models, META);
  const capabilities = new Map(readHarnessCapabilities().map((row) => [row.id, row]));

  for (const model of catalogue.models.filter((row) => row.source === "openrouter")) {
    for (const id of HARNESS_IDS) {
      const availability = model.availability[id];
      assert.ok(availability, `${model.key}/${id}`);
      if (!model.selectable) {
        // A catalogue-level block outranks the harness question, and the reason
        // is the catalogue's own.
        assert.equal(availability.ok, false, `${model.key}/${id}`);
        assert.equal(availability.reason, model.unavailableReasons[0]?.reason);
        continue;
      }
      const expected = capabilities.get(id)?.acceptsArbitraryModelIds === true;
      assert.equal(availability.ok, expected, `${model.key}/${id}`);
      if (!expected) {
        assert.equal(availability.reason, "agent-fixed-backend", `${model.key}/${id}`);
      }
    }
  }
});

test("a harness-native row stays available to EXACTLY its own agent types", () => {
  // The first of the two things WS-picker named as a genuine finding if it
  // moved: lighting the join must not make a native row unavailable to the
  // harness that spawns it.
  const catalogue = buildCatalogue(fixture().models, META);
  for (const native of harnessNativeModels()) {
    const model = catalogue.models.find((row) => row.key === native.key);
    assert.ok(model, native.key);
    for (const id of HARNESS_IDS) {
      const expected = native.agentTypes.includes(id);
      assert.equal(model.availability[id]?.ok, expected, `${native.key}/${id}`);
      if (!expected) {
        assert.equal(model.availability[id]?.reason, "other-harness", `${native.key}/${id}`);
      }
    }
    assert.equal(
      isAvailableForAgent(model, native.agentTypes[0]),
      true,
      `${native.key} must stay reachable from its own agent type`,
    );
  }
});

test("SELECTABILITY is catalogue-facts-only and does not move with the descriptor", () => {
  // The second finding-if-it-moves. `selectable` and the counts derive from the
  // raw roster alone; the descriptor annotates per agent and must not feed back
  // into them. Compared against an EMPTY table rather than against a recorded
  // number, so the roster may drift without touching this test.
  const withTable = buildCatalogue(fixture().models, META);
  const withoutTable = buildCatalogue(fixture().models, META, { capabilities: [] });

  assert.deepEqual(withTable.counts, withoutTable.counts);
  assert.deepEqual(
    withTable.models.map((model) => `${model.key}:${model.selectable}`),
    withoutTable.models.map((model) => `${model.key}:${model.selectable}`),
  );
  // And the control: the two catalogues DO differ, on availability alone — so
  // the equality above is a real invariance, not two identical builds.
  assert.notDeepEqual(
    withTable.models.map((model) => Object.keys(model.availability).length),
    withoutTable.models.map((model) => Object.keys(model.availability).length),
  );
});
