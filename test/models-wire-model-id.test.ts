/**
 * `availability.<agent>.modelId` — the WIRE ID — and the honest reason split.
 *
 * Brick c4da2ff2 problem 1. The defect this pins: the picker sent the catalogue
 * row's bare `id` to a harness that advertises a prefixed one, and the user was
 * shown their own model inside the refusal.
 *
 * Everything here is keyed on the SUPPORT KIND or on the DESCRIPTOR, never on a
 * harness NAME — a per-harness expectations table is the thing that goes stale
 * silently, and re-encoding one in the test would re-create the defect one layer
 * up.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HARNESS_IDS, listHarnessCapabilities } from "../src/acp/harness-capabilities.js";
import type { ArbitraryModelSupport } from "../src/acp/harness-capabilities.js";
import {
  readHarnessCapabilities,
  setHarnessCapabilitiesForTesting,
} from "../src/models/capability-source.js";
import type { AvailabilityCapability } from "../src/models/capability-source.js";
import { buildCatalogue } from "../src/models/catalogue.js";
import { harnessNativeModels } from "../src/models/harness-models.js";
import { composeEffectiveModelId, parseModelRef } from "../src/models/model-slug-validation.js";
import type { OpenRouterSnapshot } from "../src/models/openrouter-catalogue.js";
import type { DepthDescriptor } from "../src/models/types.js";
import { deriveWireModelId } from "../src/models/wire-model-id.js";

const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/openrouter-models-2026-09-04.json");

function fixture(): OpenRouterSnapshot {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as OpenRouterSnapshot;
}

const META = { fetchedAt: "2026-09-04T00:10:56.992Z", stale: false, error: null };

function capability(over: Partial<AvailabilityCapability> = {}): AvailabilityCapability {
  return {
    id: "synthetic",
    acceptsArbitraryModelIds: true,
    arbitraryModelSupport: "native",
    idForm: "bare",
    depthFusedIntoId: false,
    ...over,
  };
}

test.afterEach(() => {
  setHarnessCapabilitiesForTesting(null);
});

// ── The composition itself ───────────────────────────────────────────────────

test("the wire id is <prefix> + id + <bracket>, and every term is DECLARED", () => {
  const openRouterRow = {
    id: "qwen/qwen3.8-max-0902",
    source: "openrouter" as const,
    depth: { kind: "none" } as const,
  };

  // The exact row Daniel picked on staging, and the exact string pi advertises.
  assert.equal(
    deriveWireModelId({ row: openRouterRow, idForm: "source-prefixed", depthFusedIntoId: false }),
    "openrouter/qwen/qwen3.8-max-0902",
  );
  // Same row, a harness that does NOT prefix — the id goes verbatim.
  assert.equal(
    deriveWireModelId({ row: openRouterRow, idForm: "bare", depthFusedIntoId: false }),
    "qwen/qwen3.8-max-0902",
  );

  // codex's shape: no prefix, the rung fused in from the row's OWN ladder.
  const codexRow = {
    id: "gpt-5.6-sol",
    source: "chatgpt" as const,
    depth: {
      kind: "ladder",
      levels: ["low", "medium", "high"],
      default: "medium",
      mandatory: true,
    } satisfies DepthDescriptor,
  };
  assert.equal(
    deriveWireModelId({ row: codexRow, idForm: "bare", depthFusedIntoId: true }),
    "gpt-5.6-sol[medium]",
  );
  // The SAME row on a harness that does not fuse depth keeps the bare family —
  // so the bracket follows the descriptor's depth mechanism, not the row.
  assert.equal(
    deriveWireModelId({ row: codexRow, idForm: "bare", depthFusedIntoId: false }),
    "gpt-5.6-sol",
  );
});

test("a fused-depth harness with NO default rung yields null, never a bare id", () => {
  // A bare family is REFUSED by codex, so guessing here would ship a string that
  // fails at the adapter. The absence must be reported, not papered over.
  assert.equal(
    deriveWireModelId({
      row: { id: "some-family", source: "chatgpt", depth: { kind: "none" } },
      idForm: "bare",
      depthFusedIntoId: true,
    }),
    null,
  );
  // The control that proves the null above is about the LADDER and not about
  // the row: give the same row a ladder with a default and an id appears.
  assert.equal(
    deriveWireModelId({
      row: {
        id: "some-family",
        source: "chatgpt",
        depth: { kind: "ladder", levels: ["low"], default: "low", mandatory: true },
      },
      idForm: "bare",
      depthFusedIntoId: true,
    }),
    "some-family[low]",
  );
});

test("the wire id AGREES with what `sessions new` would actually spawn", () => {
  // The two functions answer neighbouring questions (see wire-model-id.ts), and
  // "neighbouring" is precisely where a silent divergence lives. Pinned rather
  // than assumed: with no effort requested, the id the picker is told to send
  // must be the id the spawn path composes.
  const catalogue = buildCatalogue([], META, { capabilities: readHarnessCapabilities() });
  const fused = new Map(readHarnessCapabilities().map((row) => [row.id, row.depthFusedIntoId]));

  let checked = 0;
  for (const model of catalogue.models) {
    for (const id of HARNESS_IDS) {
      const availability = model.availability[id];
      if (!availability?.ok || availability.modelId === undefined) {
        continue;
      }
      const spawned = composeEffectiveModelId({
        model,
        ref: parseModelRef(model.key),
        reasoningEffort: undefined,
        depthFusedIntoId: fused.get(id) === true,
      });
      assert.equal(availability.modelId, spawned, `${model.key}/${id}`);
      checked += 1;
    }
  }
  // The subject-witness: a vacuous loop would pass this test silently. Count
  // native rows only when they target a declared capability harness: the model
  // catalogue intentionally retains Claude-PTY credential-source rows after
  // Claude-PTY left HARNESS_IDS.
  const declaredHarnessIds = new Set<string>(HARNESS_IDS);
  const declaredNativeModels = harnessNativeModels().filter((model) =>
    model.agentTypes.some((id) => declaredHarnessIds.has(id)),
  );
  assert.ok(
    checked >= declaredNativeModels.length,
    `only ${checked} declared (model, agent) seats checked`,
  );
});

// ── The field on the payload ─────────────────────────────────────────────────

test("`modelId` is present EXACTLY when `ok` — on every seat of the live table", () => {
  const catalogue = buildCatalogue(fixture().models, META);
  let ok = 0;
  let denied = 0;
  for (const model of catalogue.models) {
    for (const id of HARNESS_IDS) {
      const availability = model.availability[id];
      assert.ok(availability, `${model.key}/${id}`);
      if (availability.ok) {
        assert.equal(
          typeof availability.modelId,
          "string",
          `${model.key}/${id} must carry a wire id`,
        );
        assert.notEqual(availability.modelId, "", `${model.key}/${id}`);
        ok += 1;
      } else {
        assert.equal(
          availability.modelId,
          undefined,
          `${model.key}/${id}: a refused model has no id to send`,
        );
        denied += 1;
      }
    }
  }
  // Both arms must have been exercised — a table that was all-ok or all-denied
  // would pass the loop above while proving only half of "exactly when".
  assert.ok(ok > 0 && denied > 0, `ok=${ok} denied=${denied}: both arms must fire`);
});

test("a source-prefixed harness gets the PREFIXED id and a bare one does not — same row", () => {
  // The whole point of keying on the (model, agent) pair: one row, two answers.
  const rows = fixture().models.slice(0, 40);
  const catalogue = buildCatalogue(rows, META, {
    capabilities: [
      capability({ id: "prefixing", idForm: "source-prefixed" }),
      capability({ id: "baring", idForm: "bare" }),
    ],
    nativeModels: [],
  });
  const model = catalogue.models.find((row) => row.selectable);
  assert.ok(model, "the fixture slice must contain a selectable row");
  assert.equal(model.availability.prefixing?.modelId, `${model.source}/${model.id}`);
  assert.equal(model.availability.baring?.modelId, model.id);
  assert.notEqual(
    model.availability.prefixing?.modelId,
    model.availability.baring?.modelId,
    "if the two agreed, this test could not tell the id-form apart",
  );
});

// ── The honest reason split ──────────────────────────────────────────────────

test("`agent-fixed-backend` is reserved for `none` — the ONLY permanent denial", () => {
  const rows = fixture().models.slice(0, 20);
  const kinds: ArbitraryModelSupport[] = ["none", "via-shim", "provisioned", "native"];
  const catalogue = buildCatalogue(rows, META, {
    capabilities: kinds.map((kind) =>
      capability({ id: `k-${kind}`, arbitraryModelSupport: kind, acceptsArbitraryModelIds: false }),
    ),
    nativeModels: [],
  });
  const model = catalogue.models.find((row) => row.selectable);
  assert.ok(model, "the fixture slice must contain a selectable row");

  assert.equal(model.availability["k-none"]?.reason, "agent-fixed-backend");
  for (const kind of kinds.filter((k) => k !== "none")) {
    assert.equal(
      model.availability[`k-${kind}`]?.reason,
      "acpx-not-wired",
      `${kind} is OUR gap, not a fact about the harness's backend`,
    );
  }
});

test("each non-`none` kind states its OWN gap — one sentence cannot cover three", () => {
  const rows = fixture().models.slice(0, 20);
  const kinds: ArbitraryModelSupport[] = ["via-shim", "provisioned", "native"];
  const catalogue = buildCatalogue(rows, META, {
    capabilities: kinds.map((kind) =>
      capability({ id: `k-${kind}`, arbitraryModelSupport: kind, acceptsArbitraryModelIds: false }),
    ),
    nativeModels: [],
  });
  const model = catalogue.models.find((row) => row.selectable);
  assert.ok(model, "the fixture slice must contain a selectable row");

  const messages = kinds.map((kind) => model.availability[`k-${kind}`]?.message ?? "");
  assert.equal(new Set(messages).size, kinds.length, "each kind must name its own mechanism");
  assert.match(messages[0] ?? "", /shim/, "via-shim must name the shim");
  assert.match(messages[1] ?? "", /provision/, "provisioned must name provisioning");
});

test("the reason FOLLOWS the kind — flipping a harness's kind moves its reason, with no edit here", () => {
  // The property the brief asked for: a harness that changes support kind cannot
  // silently keep a reason that has stopped being true. Same harness id, same
  // row, two kinds, two reasons.
  const rows = fixture().models.slice(0, 20);
  const asFixed = buildCatalogue(rows, META, {
    capabilities: [
      capability({ id: "h", arbitraryModelSupport: "none", acceptsArbitraryModelIds: false }),
    ],
    nativeModels: [],
  });
  const asShim = buildCatalogue(rows, META, {
    capabilities: [
      capability({ id: "h", arbitraryModelSupport: "via-shim", acceptsArbitraryModelIds: false }),
    ],
    nativeModels: [],
  });
  const key = asFixed.models.find((row) => row.selectable)?.key;
  assert.ok(key);
  assert.equal(
    asFixed.models.find((r) => r.key === key)?.availability.h?.reason,
    "agent-fixed-backend",
  );
  assert.equal(asShim.models.find((r) => r.key === key)?.availability.h?.reason, "acpx-not-wired");
});

test("claude is NOT reported as a fixed backend — the correctness fix, on the real table", () => {
  // The specific falsehood this lane removed: claude's `arbitraryModelSupport`
  // is `via-shim`, a shim exists and the `openrouter-deepseek [claude/openrouter]`
  // profile exists — what is missing is acpx's picker→shim wiring. Reported as
  // `agent-fixed-backend` it misled every consumer of the payload.
  //
  // Written against the DERIVATION, not against the value: the assertion is
  // "whatever kind claude declares, the reason matches that kind", so wiring the
  // shim later moves this test instead of breaking it.
  const claude = listHarnessCapabilities().find((row) => row.id === "claude");
  assert.ok(claude);
  const catalogue = buildCatalogue(fixture().models, META);
  const openRouter = catalogue.models.find((row) => row.source === "openrouter" && row.selectable);
  assert.ok(openRouter);

  const availability = openRouter.availability.claude;
  assert.ok(availability);
  if (availability.ok) {
    // The shim got wired; there is no denial to check and the wire id must exist.
    assert.equal(typeof availability.modelId, "string");
    return;
  }
  assert.notEqual(
    claude.arbitraryModelSupport,
    "none",
    "if claude ever declares `none` this test stops guarding anything — re-derive it",
  );
  assert.equal(availability.reason, "acpx-not-wired");
});
