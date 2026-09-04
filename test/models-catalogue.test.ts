import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCatalogue,
  countModels,
  decorateFavorites,
  deriveBilling,
  deriveVendor,
  unavailableReasonsFor,
} from "../src/models/catalogue.js";
import { deriveDepthDescriptor, toCanonicalLadder } from "../src/models/depth.js";
import { harnessNativeModels } from "../src/models/harness-models.js";
import {
  fetchOpenRouterModels,
  loadOpenRouterCatalogue,
} from "../src/models/openrouter-catalogue.js";
import type { OpenRouterRawModel, OpenRouterSnapshot } from "../src/models/openrouter-catalogue.js";

// A REAL catalogue, recorded 2026-09-04T00:10:56Z. The counts asserted against
// it are exact on purpose: when the live roster drifts, the live test below
// changes its NUMBER while this one stays green, which is how a drift reads as
// a drift rather than as a red.
// Resolved from cwd, not from import.meta.dirname: the suite runs the COMPILED
// tests out of dist-test/, where the fixture folder does not exist.
const FIXTURE_PATH = path.resolve(process.cwd(), "test/fixtures/openrouter-models-2026-09-04.json");

function fixture(): OpenRouterSnapshot {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as OpenRouterSnapshot;
}

const META = { fetchedAt: "2026-09-04T00:10:56.992Z", stale: false, error: null };

// ── Depth derivation (C4 §7.2 rule 1) ────────────────────────────────────────

test("depth: a supported_efforts ladder derives kind=ladder in canonical order", () => {
  const depth = deriveDepthDescriptor({
    // Deliberately out of order, exactly as OpenRouter reports it.
    supported_efforts: ["xhigh", "high", "medium", "low", "minimal"],
    default_effort: "medium",
    mandatory: false,
  });
  assert.equal(depth.kind, "ladder");
  assert.deepEqual(depth.kind === "ladder" ? depth.levels : [], [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.equal(depth.kind === "ladder" ? depth.default : "", "medium");
  assert.equal(depth.kind === "ladder" ? depth.mandatory : true, false);
});

test("depth: mandatory is carried through — 97 live models have no off rung", () => {
  const depth = deriveDepthDescriptor({ supported_efforts: ["high", "max"], mandatory: true });
  assert.equal(depth.kind === "ladder" ? depth.mandatory : false, true);
});

test("depth: a reasoning object with no ladder degrades to a boolean, not to a fake ladder", () => {
  const on = deriveDepthDescriptor({ mandatory: false, default_enabled: true });
  assert.deepEqual(on, { kind: "boolean", defaultEnabled: true, mandatory: false });
  const off = deriveDepthDescriptor({ supported_efforts: [], default_enabled: false });
  assert.deepEqual(off, { kind: "boolean", defaultEnabled: false, mandatory: false });
});

/**
 * ⚠️ THREE STATES, NOT TWO. Absent `default_enabled` is NOT `false`: upstream
 * distinguishes them, so the payload must too, or phase 2's depth switch renders
 * a preselected "Off" on 109 live models where OpenRouter says nothing.
 */
test("depth: an ABSENT default_enabled stays null — it is not collapsed to false", () => {
  const silent = deriveDepthDescriptor({ mandatory: false });
  assert.deepEqual(silent, { kind: "boolean", defaultEnabled: null, mandatory: false });
  // The three states are mutually distinguishable, which is the whole property.
  const states = [
    deriveDepthDescriptor({ mandatory: false }),
    deriveDepthDescriptor({ mandatory: false, default_enabled: false }),
    deriveDepthDescriptor({ mandatory: false, default_enabled: true }),
  ].map((depth) => (depth.kind === "boolean" ? depth.defaultEnabled : "wrong-kind"));
  assert.deepEqual(states, [null, false, true]);
  assert.equal(new Set(states).size, 3);
});

test("depth: the recorded roster carries all THREE boolean states, in the measured proportions", () => {
  const catalogue = buildCatalogue(fixture().models, META);
  const booleans = catalogue.models.filter((model) => model.depth.kind === "boolean");
  const count = (value: boolean | null) =>
    booleans.filter(
      (model) => model.depth.kind === "boolean" && model.depth.defaultEnabled === value,
    ).length;
  // Measured on the recorded 2026-09-04 roster: 146 boolean rows, 109 silent.
  assert.equal(booleans.length, 146);
  assert.equal(count(null), 109);
  assert.equal(count(false), 7);
  assert.equal(count(true), 30);
  assert.equal(count(null) + count(false) + count(true), booleans.length);
});

test("depth: no reasoning object at all derives kind=none", () => {
  assert.deepEqual(deriveDepthDescriptor(undefined), { kind: "none" });
});

test("depth: a default_effort outside the model's own ladder is not echoed back", () => {
  // Trusting it would make the picker preselect a rung the model rejects.
  const depth = deriveDepthDescriptor({ supported_efforts: ["high"], default_effort: "max" });
  assert.equal(depth.kind === "ladder" ? depth.default : "unset", null);
});

test("depth: the canonical order is total over all eight tokens, ultra included", () => {
  assert.deepEqual(
    toCanonicalLadder(["ultra", "none", "max", "minimal", "high", "low", "medium", "xhigh"]),
    ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  );
  // A token the vocabulary cannot order is dropped, never appended at an end.
  assert.deepEqual(toCanonicalLadder(["high", "turbo"]), ["high"]);
});

// ── Selectability, on the recorded roster ────────────────────────────────────

test("selectability: the three rules reproduce the recorded 426 → 292 / 134 split", () => {
  const models = fixture().models;
  const batch = models.filter((m) => m.id.endsWith(":batch")).length;
  const noTools = models.filter((m) => !(m.supported_parameters ?? []).includes("tools")).length;
  const variable = models.filter((m) => m.pricing?.prompt === "-1").length;
  assert.equal(models.length, 426);
  assert.equal(batch, 66);
  assert.equal(noTools, 67);
  assert.equal(variable, 5);

  const catalogue = buildCatalogue(models, META);
  assert.deepEqual(catalogue.counts.openRouter, { total: 426, selectable: 292, unavailable: 134 });
  // The arithmetic closes — this is the property, the numbers are the observation.
  assert.equal(
    catalogue.counts.openRouter.total - catalogue.counts.openRouter.unavailable,
    catalogue.counts.openRouter.selectable,
  );
});

test("selectability: each rule names itself, and a row can carry two reasons", () => {
  const batchNoTools: OpenRouterRawModel = { id: "vendor/x:batch", supported_parameters: [] };
  const reasons = unavailableReasonsFor(batchNoTools).map((r) => r.reason);
  assert.deepEqual(reasons, ["batch-endpoint", "no-tool-calling"]);
  assert.deepEqual(unavailableReasonsFor({ id: "vendor/y", supported_parameters: ["tools"] }), []);
  assert.deepEqual(
    unavailableReasonsFor({
      id: "openrouter/auto",
      supported_parameters: ["tools"],
      pricing: { prompt: "-1", completion: "-1" },
    }).map((r) => r.reason),
    ["variable-price"],
  );
});

test("selectability: an unavailable model is annotated, never dropped from the list", () => {
  const catalogue = buildCatalogue(fixture().models, META);
  const batchRow = catalogue.models.find((m) => m.id.endsWith(":batch"));
  assert.ok(batchRow, "a :batch row must still be present in the payload");
  assert.equal(batchRow.selectable, false);
  assert.ok(batchRow.unavailableReasons.length > 0);
});

// ── The other server-side derivations ────────────────────────────────────────

test("billing: prices are USD per 1M, and the variable routers are marked as such", () => {
  assert.deepEqual(
    deriveBilling({ id: "a/b", pricing: { prompt: "0.000003", completion: "0.000015" } }),
    {
      kind: "metered",
      inPerM: 3,
      outPerM: 15,
      account: "openrouter",
    },
  );
  assert.equal(deriveBilling({ id: "a/b", pricing: { prompt: "-1" } }).kind, "variable");
  assert.equal(
    deriveBilling({ id: "a/b:free", pricing: { prompt: "0", completion: "0" } }).kind,
    "free",
  );
});

test("vendor: the id prefix, with the alias tilde stripped", () => {
  assert.equal(deriveVendor("moonshotai/kimi-k3"), "moonshotai");
  assert.equal(deriveVendor("~anthropic/claude-latest"), "anthropic");
});

test("equivalentTo: rows sharing a canonical_slug point at each other, and never at themselves", () => {
  const catalogue = buildCatalogue(
    [
      { id: "a/x", canonical_slug: "same", supported_parameters: ["tools"] },
      { id: "a/x:batch", canonical_slug: "same", supported_parameters: ["tools"] },
      { id: "a/y", canonical_slug: "other", supported_parameters: ["tools"] },
    ],
    META,
  );
  const first = catalogue.models.find((m) => m.id === "a/x");
  assert.deepEqual(first?.equivalentTo, ["openrouter:a/x:batch"]);
  assert.deepEqual(catalogue.models.find((m) => m.id === "a/y")?.equivalentTo, []);
});

test("badges: free, alias and batch are derived from the row itself", () => {
  const catalogue = buildCatalogue(
    [
      {
        id: "a/x:free",
        supported_parameters: ["tools"],
        pricing: { prompt: "0", completion: "0" },
      },
      { id: "~a/x-latest", alias_target: "a/x-0913", supported_parameters: ["tools"] },
    ],
    META,
  );
  const free = catalogue.models.find((m) => m.id === "a/x:free");
  const alias = catalogue.models.find((m) => m.id === "~a/x-latest");
  assert.ok(free?.badges.includes("free"));
  assert.ok(alias?.badges.includes("alias"));
  assert.deepEqual(alias?.aliasTarget, { id: "a/x-0913", name: null });
});

// ── One list, all sources ────────────────────────────────────────────────────

test("merge: harness-native rows are in the SAME array, with the same descriptor shape", () => {
  const catalogue = buildCatalogue(fixture().models, META);
  const opus = catalogue.models.find((m) => m.key === "claude-subscription:opus");
  assert.ok(opus, "the subscription models must be in the one list");
  assert.equal(opus.depth.kind, "ladder");
  assert.deepEqual(opus.depth.kind === "ladder" ? opus.depth.levels : [], [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  // Sonnet's ceiling is lower than Opus's — a per-model fact, not a per-harness one.
  const sonnet = catalogue.models.find((m) => m.key === "claude-subscription:sonnet");
  assert.deepEqual(sonnet?.depth.kind === "ladder" ? sonnet.depth.levels : [], [
    "low",
    "medium",
    "high",
  ]);
});

test("merge: codex families are mandatory-depth, because a bare family is rejected", () => {
  const sol = harnessNativeModels().find((m) => m.key === "chatgpt:gpt-5.6-sol");
  assert.equal(sol?.depth.kind === "ladder" ? sol.depth.mandatory : false, true);
  assert.equal(sol?.depth.kind === "ladder" ? sol.depth.default : null, "medium");
  // Sol reaches ultra; the 5.4 tier stops at xhigh.
  assert.ok(sol?.depth.kind === "ladder" && sol.depth.levels.includes("ultra"));
  const mini = harnessNativeModels().find((m) => m.key === "chatgpt:gpt-5.4-mini");
  assert.ok(mini?.depth.kind === "ladder" && !mini.depth.levels.includes("ultra"));
});

test("merge: one id under two sources is two rows with two keys (C5 D2)", () => {
  const rows = harnessNativeModels().filter((m) => m.id === "opus");
  assert.deepEqual(rows.map((m) => m.key).toSorted(), [
    "claude-home:opus",
    "claude-pty:opus",
    "claude-subscription:opus",
  ]);
});

// ── The availability join ────────────────────────────────────────────────────

test("availability: an EMPTY capability table yields an empty map, never a guess", () => {
  const catalogue = buildCatalogue(fixture().models.slice(0, 5), META, { capabilities: [] });
  for (const model of catalogue.models) {
    assert.deepEqual(model.availability, {}, `${model.key} must not invent an availability`);
  }
});

test("availability: with a table it is a JOIN of selectability and the agent's capability", () => {
  const capabilities = [
    { id: "claude", acceptsArbitraryModelIds: true },
    { id: "codex", acceptsArbitraryModelIds: false },
  ];
  const catalogue = buildCatalogue(
    [
      { id: "a/x", supported_parameters: ["tools"] },
      { id: "a/y:batch", supported_parameters: ["tools"] },
    ],
    META,
    { capabilities },
  );

  const open = catalogue.models.find((m) => m.id === "a/x");
  assert.deepEqual(open?.availability.claude, { ok: true });
  assert.equal(open?.availability.codex?.ok, false);
  assert.equal(open?.availability.codex?.reason, "agent-fixed-backend");

  // A model no session can stream from is unavailable for EVERY agent type,
  // and the reason is the catalogue's, not the harness's.
  const batch = catalogue.models.find((m) => m.id === "a/y:batch");
  assert.equal(batch?.availability.claude?.ok, false);
  assert.equal(batch?.availability.claude?.reason, "batch-endpoint");

  // A harness-native row is available to its own agent type and no other.
  const opus = catalogue.models.find((m) => m.key === "claude-subscription:opus");
  assert.equal(opus?.availability.claude?.ok, true);
  assert.equal(opus?.availability.codex?.ok, false);
  assert.equal(opus?.availability.codex?.reason, "other-harness");
});

// ── Counts and favorites decoration ──────────────────────────────────────────

test("counts: computed from the rows in hand, both overall and for OpenRouter alone", () => {
  const models = buildCatalogue(fixture().models, META).models;
  const counts = countModels(models);
  assert.equal(counts.total, models.length);
  assert.equal(counts.selectable + counts.unavailable, counts.total);
  assert.equal(counts.openRouter.total, 426);
  assert.equal(counts.total - counts.openRouter.total, harnessNativeModels().length);
});

test("favorites decoration stamps the star onto the row a caller draws", () => {
  const catalogue = buildCatalogue([{ id: "a/x", supported_parameters: ["tools"] }], META);
  const decorated = decorateFavorites(catalogue, [
    { key: "openrouter:a/x", favoritedAt: "2026-08-14T09:12:03.000Z" },
  ]);
  const row = decorated.models.find((m) => m.key === "openrouter:a/x");
  assert.equal(row?.favorite, true);
  assert.equal(row?.favoritedAt, "2026-08-14T09:12:03.000Z");
  // Untouched rows keep their honest default.
  assert.equal(decorated.models.find((m) => m.source !== "openrouter")?.favorite, false);
});

// ── Cache behaviour ──────────────────────────────────────────────────────────

function tempCachePath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "acpx-models-")), name);
}

test("cache: a fresh cache is served without any fetch", async () => {
  const cachePath = tempCachePath("cache.json");
  fs.writeFileSync(
    cachePath,
    JSON.stringify({ fetchedAt: new Date().toISOString(), models: [{ id: "a/x" }] }),
  );
  let fetched = 0;
  const result = await loadOpenRouterCatalogue({
    cachePath,
    fetchModels: async () => {
      fetched += 1;
      return { fetchedAt: new Date().toISOString(), models: [] };
    },
  });
  assert.equal(fetched, 0);
  assert.equal(result.stale, false);
  assert.equal(result.snapshot?.models.length, 1);
});

test("cache: a failed refresh serves the STALE cache plus the error, never emptiness", async () => {
  const cachePath = tempCachePath("cache.json");
  fs.writeFileSync(
    cachePath,
    JSON.stringify({ fetchedAt: "2020-01-01T00:00:00.000Z", models: [{ id: "a/x" }] }),
  );
  const result = await loadOpenRouterCatalogue({
    cachePath,
    fetchModels: () => Promise.reject(new Error("upstream is down")),
  });
  assert.equal(result.snapshot?.models.length, 1);
  assert.equal(result.stale, true);
  assert.match(result.error ?? "", /upstream is down/);
});

test("cache: a failed refresh with NO cache still yields the harness-native models", async () => {
  const cachePath = tempCachePath("missing.json");
  const result = await loadOpenRouterCatalogue({
    cachePath,
    fetchModels: () => Promise.reject(new Error("dns")),
  });
  assert.equal(result.snapshot, null);
  const catalogue = buildCatalogue([], { fetchedAt: META.fetchedAt, stale: false, error: "dns" });
  assert.equal(catalogue.models.length, harnessNativeModels().length);
  assert.ok(catalogue.models.length > 0, "the subscription path is never blocked on a third party");
});

test("cache: the write is atomic — no .tmp file is left behind, and the JSON round-trips", async () => {
  const cachePath = tempCachePath("cache.json");
  await loadOpenRouterCatalogue({
    cachePath,
    fetchModels: async () => ({ fetchedAt: "2026-09-04T00:00:00.000Z", models: [{ id: "a/x" }] }),
  });
  const dir = path.dirname(cachePath);
  assert.deepEqual(fs.readdirSync(dir), ["cache.json"]);
  const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8")) as OpenRouterSnapshot;
  assert.equal(parsed.models[0]?.id, "a/x");
});

test("cache: a corrupt cache file reads as a COLD cache, not as a crash", async () => {
  const cachePath = tempCachePath("cache.json");
  fs.writeFileSync(cachePath, "{ this is not json");
  const result = await loadOpenRouterCatalogue({
    cachePath,
    offline: true,
  });
  assert.equal(result.snapshot, null);
});

test("cache: offline never fetches, even with an empty cache", async () => {
  const cachePath = tempCachePath("missing.json");
  let fetched = 0;
  const result = await loadOpenRouterCatalogue({
    cachePath,
    offline: true,
    fetchModels: async () => {
      fetched += 1;
      return { fetchedAt: new Date().toISOString(), models: [] };
    },
  });
  assert.equal(fetched, 0);
  assert.equal(result.snapshot, null);
});

// ── The live roster ──────────────────────────────────────────────────────────

test("live: the derivation rules close on the CURRENT OpenRouter roster", async (t) => {
  let snapshot: OpenRouterSnapshot;
  try {
    snapshot = await fetchOpenRouterModels();
  } catch (error) {
    // A network outage is not a defect in this code; it is an absence of a
    // measurement. Skipping says so instead of pretending it passed.
    t.skip(`could not reach OpenRouter: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const catalogue = buildCatalogue(snapshot.models, {
    fetchedAt: snapshot.fetchedAt,
    stale: false,
    error: null,
  });
  const counts = catalogue.counts.openRouter;
  // The numbers move as the roster moves; the ARITHMETIC is the invariant.
  assert.equal(counts.total, snapshot.models.length);
  assert.equal(counts.selectable + counts.unavailable, counts.total);
  assert.ok(counts.total > 300, `implausibly small roster: ${counts.total}`);
  assert.ok(counts.selectable > 200, `implausibly few selectable: ${counts.selectable}`);
  // Every row carries a derived descriptor — none ships the raw OpenRouter shape.
  for (const model of catalogue.models) {
    assert.ok(["ladder", "boolean", "none"].includes(model.depth.kind));
  }
  t.diagnostic(
    `live roster at ${snapshot.fetchedAt}: total=${counts.total} selectable=${counts.selectable} unavailable=${counts.unavailable}`,
  );
});
