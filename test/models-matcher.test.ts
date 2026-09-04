import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalogue } from "../src/models/catalogue.js";
import {
  RANK_EXACT_ID,
  RANK_ID_PREFIX,
  RANK_NAME_PREFIX,
  RANK_SUBSTRING,
  RANK_WORD_BOUNDARY,
  bandModels,
  isAvailableForAgent,
  searchModels,
  tokenize,
} from "../src/models/matcher.js";
import type { CatalogueModel } from "../src/models/types.js";

const META = { fetchedAt: "2026-09-04T00:00:00.000Z", stale: false, error: null };

/** A row shaped like the real thing, with only what the matcher reads varied. */
function row(overrides: Partial<CatalogueModel>): CatalogueModel {
  return {
    key: `openrouter:${overrides.id ?? "a/x"}`,
    source: "openrouter",
    id: "a/x",
    name: "A: X",
    vendor: "a",
    description: null,
    contextLength: null,
    tools: true,
    billing: { kind: "metered", inPerM: 1, outPerM: 2, account: "openrouter" },
    depth: { kind: "none" },
    badges: [],
    aliasTarget: null,
    equivalentTo: [],
    createdAt: 1_700_000_000,
    selectable: true,
    unavailableReasons: [],
    availability: {},
    favorite: false,
    favoritedAt: null,
    ...overrides,
  };
}

test("tokenize splits on whitespace and lowercases", () => {
  assert.deepEqual(tokenize("  GPT   Sol "), ["gpt", "sol"]);
  assert.deepEqual(tokenize("   "), []);
});

test("matcher: token-AND — EVERY token must appear, in name, id or vendor", () => {
  const models = [
    row({ id: "openai/gpt-5.6-sol", name: "OpenAI: GPT-5.6 Sol", vendor: "openai" }),
    row({ id: "openai/gpt-5.6-luna", name: "OpenAI: GPT-5.6 Luna", vendor: "openai" }),
    row({ id: "deepseek/v4", name: "DeepSeek V4", vendor: "deepseek" }),
  ];
  assert.deepEqual(
    searchModels(models, "gpt sol").map((m) => m.model.id),
    ["openai/gpt-5.6-sol"],
  );
  // The vendor is part of the haystack, so a vendor name finds its whole band.
  assert.equal(searchModels(models, "openai").length, 2);
  // A token that matches nothing removes the row, however well the others match.
  assert.equal(searchModels(models, "gpt zzz").length, 0);
});

test("matcher: all five ranking tiers are distinguishable", () => {
  const exact = row({ id: "a/x", name: "Zed" });
  const idPrefix = row({ id: "a/xylophone", name: "Zed Two" });
  const namePrefix = row({ id: "b/other", name: "a/x machine" });
  const wordBoundary = row({ id: "c/thing", name: "Thing a/x edition" });
  const substring = row({ id: "d/za/xq", name: "Nothing" });

  const ranked = searchModels([substring, wordBoundary, namePrefix, idPrefix, exact], "a/x");
  assert.deepEqual(
    ranked.map((m) => m.rank),
    [RANK_EXACT_ID, RANK_ID_PREFIX, RANK_NAME_PREFIX, RANK_WORD_BOUNDARY, RANK_SUBSTRING],
  );
  assert.deepEqual(
    ranked.map((m) => m.model.id),
    ["a/x", "a/xylophone", "b/other", "c/thing", "d/za/xq"],
  );
});

test("matcher: ties break by createdAt, newest first", () => {
  const older = row({ id: "a/one", name: "Kimi One", createdAt: 1_000 });
  const newer = row({ id: "a/two", name: "Kimi Two", createdAt: 2_000 });
  assert.deepEqual(
    searchModels([older, newer], "kimi").map((m) => m.model.id),
    ["a/two", "a/one"],
  );
});

test("matcher: favorites are boosted above EVERYTHING, including an exact id match", () => {
  const exact = row({ id: "a/x", name: "Exact" });
  const favorite = row({ id: "z/a/x-thing", key: "openrouter:z/a/x-thing", name: "Favored" });
  const ranked = searchModels([exact, favorite], "a/x", new Set(["openrouter:z/a/x-thing"]));
  assert.deepEqual(
    ranked.map((m) => m.model.id),
    ["z/a/x-thing", "a/x"],
  );
});

test("matcher: unavailable rows rank LAST but are never dropped", () => {
  const blocked = row({
    id: "a/x:batch",
    key: "openrouter:a/x:batch",
    name: "A: X (batch)",
    selectable: false,
    unavailableReasons: [{ reason: "batch-endpoint", message: "batch endpoint" }],
  });
  const fine = row({ id: "a/x-plus", key: "openrouter:a/x-plus", name: "A: X Plus" });
  const ranked = searchModels([blocked, fine], "a/x");
  assert.equal(ranked.length, 2, "an unavailable match must still be returned");
  assert.equal(ranked[1]?.model.id, "a/x:batch");
});

test("matcher: an empty query returns everything, still favorites-first", () => {
  const models = [
    row({ id: "a/one", key: "openrouter:a/one" }),
    row({ id: "a/two", key: "openrouter:a/two" }),
  ];
  const ranked = searchModels(models, "", new Set(["openrouter:a/two"]));
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0]?.model.id, "a/two");
});

// ── Banding ──────────────────────────────────────────────────────────────────

test("banding: ★ Favorites → each harness → OpenRouter by vendor A→Z → Unavailable", () => {
  const catalogue = buildCatalogue(
    [
      { id: "zvendor/m", name: "Z M", supported_parameters: ["tools"], created: 10 },
      { id: "mvendor/m", name: "M M", supported_parameters: ["tools"], created: 10 },
      { id: "avendor/m", name: "A M", supported_parameters: ["tools"], created: 10 },
      { id: "avendor/newer", name: "A Newer", supported_parameters: ["tools"], created: 99 },
      { id: "avendor/blocked:batch", name: "A Blocked", supported_parameters: ["tools"] },
    ],
    META,
  );
  const bands = bandModels(catalogue.models, {
    favoriteKeys: ["openrouter:zvendor/m"],
    includeUnavailable: true,
  });
  const ids = bands.map((band) => band.id);

  assert.equal(ids[0], "favorites");
  assert.equal(ids.at(-1), "unavailable");
  assert.ok(ids.indexOf("source:claude-subscription") < ids.indexOf("vendor:avendor"));
  assert.ok(ids.indexOf("vendor:avendor") < ids.indexOf("vendor:mvendor"));
  // Newest first within a vendor.
  const avendor = bands.find((band) => band.id === "vendor:avendor");
  assert.deepEqual(
    avendor?.models.map((m) => m.id),
    ["avendor/newer", "avendor/m"],
  );
  // A favorited row is not ALSO listed in its vendor band.
  assert.equal(
    bands.find((band) => band.id === "vendor:zvendor"),
    undefined,
  );
});

test("banding: favorites keep the store's most-recently-starred-first order", () => {
  const catalogue = buildCatalogue(
    [
      { id: "a/one", supported_parameters: ["tools"] },
      { id: "a/two", supported_parameters: ["tools"] },
    ],
    META,
  );
  const bands = bandModels(catalogue.models, {
    favoriteKeys: ["openrouter:a/two", "openrouter:a/one"],
  });
  assert.deepEqual(
    bands[0]?.models.map((m) => m.id),
    ["a/two", "a/one"],
  );
});

test("banding: the Unavailable band is hidden by default and never silently drops rows", () => {
  const catalogue = buildCatalogue([{ id: "a/x:batch", supported_parameters: ["tools"] }], META);
  const hidden = bandModels(catalogue.models, { includeUnavailable: false });
  assert.equal(
    hidden.some((band) => band.id === "unavailable"),
    false,
  );
  const shown = bandModels(catalogue.models, { includeUnavailable: true });
  assert.equal(shown.find((band) => band.id === "unavailable")?.models.length, 1);
});

test("availability gate: a harness-native row belongs to its own agent type only", () => {
  const catalogue = buildCatalogue([], META);
  const opus = catalogue.models.find((m) => m.key === "claude-subscription:opus");
  const codexFamily = catalogue.models.find((m) => m.key === "chatgpt:gpt-5.6-sol");
  assert.ok(opus && codexFamily);
  assert.equal(isAvailableForAgent(opus, "claude"), true);
  assert.equal(isAvailableForAgent(opus, "codex"), false);
  assert.equal(isAvailableForAgent(codexFamily, "codex"), true);
  assert.equal(isAvailableForAgent(codexFamily, "claude"), false);
});

test("availability gate: an OpenRouter row with NO capability table stays available", () => {
  // Absence of a capability table is absence of knowledge, not evidence of
  // unavailability — shrinking the list on ignorance is the failure C5 D6 names.
  //
  // ⚠️ `capabilities: []` IS THE SUBJECT OF THIS TEST, NOT BOILERPLATE. Omitting
  // it does not mean "no table": `buildCatalogue` defaults to
  // `readHarnessCapabilities()`, which since S1 returns the REAL table. This
  // test used to omit it and passed only because production had no table wired
  // — so it was quietly asserting a production defect as its own setup, and it
  // is the one test that went red when the accessor was pointed at the table
  // (brick://db554b05). Stating the empty table explicitly is what keeps the
  // property under test — an empty map means "offer it" — separate from
  // whatever production happens to supply.
  const catalogue = buildCatalogue([{ id: "a/x", supported_parameters: ["tools"] }], META, {
    capabilities: [],
  });
  const model = catalogue.models.find((m) => m.id === "a/x");
  assert.ok(model);
  assert.deepEqual(model.availability, {});
  assert.equal(isAvailableForAgent(model, "claude"), true);
});
