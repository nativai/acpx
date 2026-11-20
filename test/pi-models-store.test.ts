import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyHarnessConfigDir } from "../src/acp/harness-config-dir.js";
import {
  PI_KNOWLEDGE_PLACEHOLDER_KEY,
  piKnowledgeCachePath,
  piKeptOverlayPath,
  piKnowledgeReadEnv,
  readAdvertisedViaRpc,
  readPiKeptOpenRouterModels,
  readPiAdvertisedModelIds,
  readReplyLine,
  resetPiKnowledgeMemo,
  PI_INCOMPLETE_KNOWLEDGE_TTL_MS,
  type PiAdvertisedRead,
  type PiRpcSpawn,
  type PiRpcTiming,
} from "../src/acp/pi-model-knowledge.js";
import { deriveBilling } from "../src/models/catalogue.js";
import { deriveCostFigure, reportedCost, type CostUnit } from "../src/models/cost-provenance.js";

// Brick 6253611b — Pi session cost renders as $0.
//
// ROOT CAUSE, proven: `writePiModelsStore` fabricated a catalogue entry with
// `cost {0,0,0,0}` and `contextWindow 128000`; pi merges that store over its
// BUNDLED catalogue BY ID, so the fabricated entry REPLACED pi's real, priced
// one. pi then priced the session at zero, faithfully, from rates we supplied.
//
// ⚠️ THE GUARD THAT WAS MEANT TO PREVENT THIS ASKED THE WRONG QUESTION: it
// consulted only the box's remote-OVERLAY cache. 333 of the 374 models pi
// advertises are BUNDLED, and on every dev box the overlay file does not exist
// at all — so the protection was unreachable for every model. These tests pin
// the corrected question, and the fourth one pins the state the box is ACTUALLY
// in, which is the case that would otherwise rot invisibly.
//
// Hermetic by construction: `ACPX_PI_KNOWLEDGE_CACHE` and `ACPX_MODELS_CACHE`
// are pointed at fixtures, so no `pi` process is spawned and no network is
// touched. A test that silently fell back to a real spawn would be measuring the
// box, not the change.
//
// 🛑 THAT SENTENCE WAS HALF FALSE UNTIL BRICK ff298f02, AND THE FALSE HALF WAS
// INVISIBLE BECAUSE IT PASSED. `ACPX_MODELS_CACHE` was set in the fixture env and
// then ignored: `defaultCatalogueCachePath()` resolved `process.env` and
// `os.homedir()`, so CASE 1 read `/home/node/.acpx/models-cache.json` and passed
// only because that file happened to contain `qwen/qwen3.8-flash`. Measured by
// running this file under three HOMEs: it RED under two of them and green under
// the box's own. A fixture variable that is set but not consulted is worse than
// no fixture at all — it makes the file LOOK hermetic to every later reader.

const PI_COMMAND = "node /opt/pi-acp/dist/index.js";

// Real values, transcribed from OpenRouter's own row for this model
// (`~/.acpx/models-cache.json`, 2026-09-07) and independently confirmed against
// pi's own bundled entry: 0.15 / 0.47 / 0.016 / 0.2 per 1M, ctx 1,000,000,
// max_completion_tokens 131,072. Using a model whose real numbers are KNOWN is
// what lets the assertions below be exact rather than merely "non-zero".
const KNOWN_ID = "qwen/qwen3.8-flash";
const KNOWN_ROW = {
  id: KNOWN_ID,
  name: "Qwen3.8 Flash",
  context_length: 1_000_000,
  top_provider: { context_length: 1_000_000, max_completion_tokens: 131_072 },
  pricing: {
    prompt: "0.00000015",
    completion: "0.00000047",
    input_cache_read: "0.000000016",
    input_cache_write: "0.0000002",
  },
};

type Fixture = { root: string; env: NodeJS.ProcessEnv; home: string };

function fixture(options: {
  piKnows?: string[];
  catalogue?: unknown[];
  boxOverlay?: unknown[];
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-store-test-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });

  const knowledgePath = join(root, "pi-knowledge.json");
  if (options.piKnows) {
    writeFileSync(
      knowledgePath,
      JSON.stringify({ fetchedAt: new Date().toISOString(), ids: options.piKnows }),
    );
  }

  const cataloguePath = join(root, "models-cache.json");
  if (options.catalogue) {
    writeFileSync(
      cataloguePath,
      JSON.stringify({ fetchedAt: new Date().toISOString(), models: options.catalogue }),
    );
  }

  if (options.boxOverlay) {
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models-store.json"),
      JSON.stringify({ openrouter: { lastModified: 1, checkedAt: 1, models: options.boxOverlay } }),
    );
  }

  // The knowledge memo is process-wide and every fixture shares one process.
  // Each fixture has its own cache path, so a collision is unlikely rather than
  // impossible — and "unlikely" is not a property a test should rest on.
  resetPiKnowledgeMemo();

  return {
    root,
    home,
    env: {
      HOME: home,
      ACPX_PI_KNOWLEDGE_CACHE: knowledgePath,
      ACPX_MODELS_CACHE: cataloguePath,
      // Not a real command: if any code path tried to SPAWN pi, this would fail
      // loudly rather than quietly measuring the box's real pi.
      PATH: "/nonexistent-so-a-spawn-cannot-silently-succeed",
    },
  };
}

/**
 * ONE write, both files. The two must be read from the same
 * `applyHarnessConfigDir` call, or the "they cannot disagree" assertion below
 * would be comparing two independent writes and would pass on a real divergence.
 */
function provisioningFor(
  fx: Fixture,
  provisionModelId: string,
): {
  dir: string;
  store: { path: string; json: any } | null;
  config: { path: string; json: any } | null;
} {
  const plan = applyHarnessConfigDir({
    env: fx.env,
    agentCommand: PI_COMMAND,
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    provisionModelId,
    rootDir: join(fx.root, "cfg"),
  });
  assert.ok(plan, "applyHarnessConfigDir must produce a plan for the pi harness");
  const read = (name: string) => {
    const path = join(plan.dir, name);
    return existsSync(path) ? { path, json: JSON.parse(readFileSync(path, "utf8")) } : null;
  };
  return { dir: plan.dir, store: read("models-store.json"), config: read("models.json") };
}

function storeFor(fx: Fixture, provisionModelId: string): { path: string; json: any } | null {
  return provisioningFor(fx, provisionModelId).store;
}

test("CASE 1 — a model acpx CAN price gets pi's REAL rates, window and output cap, never zeros", () => {
  const fx = fixture({ piKnows: [], catalogue: [KNOWN_ROW] });
  try {
    const store = storeFor(fx, `openrouter/${KNOWN_ID}`);
    assert.ok(store, "an entry is required for a model pi does not know");
    const entry = store.json.openrouter.models.find((m: any) => m.id === KNOWN_ID);
    assert.ok(entry, "the provisioned slug must be present");

    // The defect, pinned by its real values rather than by "not zero": a
    // regression that reintroduced ANY of these three literals would be caught.
    //
    // ⚠️ Compared with a tolerance, NOT `deepEqual`. `0.0000002 * 1e6` is
    // `0.19999999999999998` in IEEE-754, and an exact assertion here would be a
    // test that fails on arithmetic rather than on behaviour — the classic way a
    // correct change gets reverted.
    assert.equal(entry.cost.input, 0.15);
    assert.equal(entry.cost.output, 0.47);
    assert.equal(entry.cost.cacheRead, 0.016);
    assert.ok(
      Math.abs(entry.cost.cacheWrite - 0.2) < 1e-12,
      `cacheWrite should be ~0.2, got ${entry.cost.cacheWrite}`,
    );
    assert.equal(
      entry.contextWindow,
      1_000_000,
      "the real window — 128000 caused ~8x early compaction",
    );
    assert.equal(entry.maxTokens, 131_072, "the real output cap — 16384 was an 8x cap for nothing");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("CASE 2 — a model acpx CANNOT price gets a ZERO cost block (pi crashes without one), not a missing one", () => {
  const fx = fixture({ piKnows: [], catalogue: [] });
  try {
    const store = storeFor(fx, "openrouter/vendor/never-heard-of-it");
    assert.ok(store, "an unknown model still needs an entry to be selectable at all");
    const entry = store.json.openrouter.models.find(
      (m: any) => m.id === "vendor/never-heard-of-it",
    );
    assert.ok(entry, "the provisioned slug must be present");

    // MEASURED against pi 0.84.4's own exported `calculateCost`: with `cost`
    // absent it throws `TypeError: Cannot read properties of undefined (reading
    // 'tiers')`, because pi's `?? []` guards a missing `tiers`, not a missing
    // `cost` — and pi's schema marks `cost` OPTIONAL, so the entry validates IN
    // and is then dereferenced. Omitting the block is the intuitive "honest"
    // move and it breaks the first turn of exactly the models nobody tests.
    //
    // The zero is an internal necessity of pi's data model, NOT a claim. That
    // the price is unknown is carried by acpx's own provenance field.
    assert.ok(entry.cost, "cost block MUST exist — pi dereferences it unconditionally");
    assert.deepEqual(entry.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(entry.contextWindow, 128_000, "pi's fallback window, since acpx knows no better");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("CASE 3 — a model PI ALREADY KNOWS produces NO fabricated entry at all", () => {
  // The new behaviour, and nothing else tests it. Writing a "better" entry would
  // still clobber pi's own row and lose its `thinkingLevelMap`; the only correct
  // move is to write nothing.
  const fx = fixture({ piKnows: [KNOWN_ID], catalogue: [KNOWN_ROW] });
  try {
    const store = storeFor(fx, `openrouter/${KNOWN_ID}`);
    assert.equal(
      store,
      null,
      "no models-store.json may be written at all: the file itself is what displaces pi's block",
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("CASE 4 — with the box overlay file ABSENT (the box's ACTUAL state) both rules still hold", () => {
  // ⚠️ THE CASE THAT WOULD ROT SILENTLY. Every real session runs under it: acpx
  // re-points PI_CODING_AGENT_DIR at a per-session dir it deletes at close, so
  // the box's overlay can never become populated. A fixture that accidentally
  // created one would make the other three tests pass for the wrong reason.
  const fx = fixture({ piKnows: [KNOWN_ID], catalogue: [KNOWN_ROW] });
  try {
    assert.equal(
      existsSync(join(fx.home, ".pi", "agent", "models-store.json")),
      false,
      "the fixture must NOT have an overlay — that is the condition under test",
    );
    assert.equal(storeFor(fx, `openrouter/${KNOWN_ID}`), null, "known ⇒ still no file");

    const unknown = storeFor(fx, "openrouter/vendor/never-heard-of-it");
    assert.ok(unknown, "unknown ⇒ still provisioned");
    assert.equal(unknown.json.openrouter.models.length, 1, "and the overlay contributes nothing");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Brick 626f56f5 — a catalogue refresh must not be able to revert provisioning.
//
// `models-store.json` is pi's OWN cache and pi overwrites it: `FileModelsStore.write`
// assigns `current["openrouter"] = entry`, so a refresh replaces the whole block.
// The durable copy therefore lives in `models.json`, which pi only ever reads.
//
// 🛑 THESE TESTS PIN THE FILE'S SHAPE. THEY DO NOT — AND CANNOT — PROVE SURVIVAL.
// A fixture cannot show that a real refresh leaves this layer standing; that was
// measured against a live `pi --mode rpc` process with `checkedAt` aged 5 h, in
// paired arms, and the evidence is in brick 626f56f5 `verification/`. If these
// tests are ever the only thing standing behind the survival claim, the claim is
// unsupported.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one value the provider-wide `baseUrl` override is allowed to be, and the
 * measurement that licenses applying it to EVERY openrouter model.
 *
 * Measured 2026-09-08 against pi 0.84.4's live catalogue (379 openrouter models,
 * read over `pi --mode rpc` → `get_available_models`):
 *
 *   364 × https://openrouter.ai/api/v1     ← already correct; the override is a no-op
 *    15 × https://openrouter.ai/api        ← every `anthropic-messages` row; the bug
 *
 * There is no third value, which is what makes a blanket override safe. **If a
 * future pi serves an openrouter model on some other base URL, this override
 * would rewrite it — re-measure the histogram when the pinned pi version moves.**
 */
const PI_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

test("626f56f5 — models.json is written for EVERY provisioned pi session, store or no store", () => {
  // The `alreadyKnown` path deliberately writes NO models-store.json (CASE 3).
  // The durable layer must still exist there, because the Anthropic repair is
  // needed whether or not acpx also has a slug to add — and on this fleet it is
  // needed ONLY there: the 15 broken rows are not bundled, they arrive with pi's
  // refresh, so the store-side repair has nothing to act on.
  const fx = fixture({ piKnows: [KNOWN_ID], catalogue: [KNOWN_ROW] });
  try {
    const { store, config } = provisioningFor(fx, `openrouter/${KNOWN_ID}`);
    assert.equal(store, null, "known slug ⇒ still no models-store.json (CASE 3 unchanged)");
    assert.ok(config, "…but models.json MUST be written: it carries the Anthropic repair");
    assert.equal(
      config.json.providers.openrouter.baseUrl,
      PI_OPENROUTER_BASE_URL,
      "the repair is a provider-wide baseUrl — modelOverrides cannot express baseUrl at all",
    );
    assert.equal(
      "models" in config.json.providers.openrouter,
      false,
      "a slug pi already knows must NOT be shadowed: pi rebuilds a models.json model " +
        "from the definition alone, so an entry here would lose its thinkingLevelMap",
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("626f56f5 — an arbitrary slug reaches models.json, and the two files cannot disagree", () => {
  const fx = fixture({ piKnows: [], catalogue: [KNOWN_ROW] });
  try {
    const { store, config } = provisioningFor(fx, `openrouter/${KNOWN_ID}`);
    assert.ok(store, "unknown slug ⇒ a store entry, as before");
    assert.ok(config, "…and the durable copy a refresh cannot reach");

    const definitions = config.json.providers.openrouter.models;
    assert.equal(definitions.length, 1, "exactly the provisioned slug, never a whole catalogue");
    const definition = definitions[0];
    assert.equal(definition.id, KNOWN_ID);
    assert.equal(definition.baseUrl, PI_OPENROUTER_BASE_URL);

    // ⚠️ `provider` is NOT a field of pi's ModelDefinitionSchema (pi sets it from
    // the block key). The shape measured working live is the one without it, and
    // an invalid models.json does not fail loudly — `ModelConfig.load` returns an
    // error and pi composes with an EMPTY config, so the whole layer vanishes.
    assert.equal(
      "provider" in definition,
      false,
      "provider must be stripped: it is not in pi's ModelDefinitionSchema",
    );

    // The structural half: both files describe the SAME entry from ONE write, so
    // a change to either writer that lets them drift turns this red.
    const storeEntry = store.json.openrouter.models.find((m: any) => m.id === KNOWN_ID);
    assert.ok(storeEntry, "the store must carry the same slug");
    const { provider, ...storeWithoutProvider } = storeEntry;
    assert.equal(provider, "openrouter", "the store form DOES carry provider — pi's cache shape");
    assert.deepEqual(
      definition,
      storeWithoutProvider,
      "models.json and models-store.json must describe one entry, differing only in `provider`",
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("626f56f5 — an unpriceable slug still gets pi's mandatory zero cost block in models.json", () => {
  // Same necessity as CASE 2, on the new leg: pi dereferences `cost` unconditionally
  // (`calculateCost` throws on a missing block), and `modelFromJson` would otherwise
  // substitute its own zeros anyway. Pinned here so the definition builder cannot be
  // "tidied" into omitting it on this path only.
  const fx = fixture({ piKnows: [], catalogue: [] });
  try {
    const { config } = provisioningFor(fx, "openrouter/vendor/never-heard-of-it");
    assert.ok(config);
    const definition = config.json.providers.openrouter.models[0];
    assert.equal(definition.id, "vendor/never-heard-of-it");
    assert.deepEqual(definition.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(definition.contextWindow, 128_000);
    assert.equal(definition.maxTokens, 16_384);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("pi knowledge: the cache path honours the PASSED env, never the process's own home", () => {
  // Regression for a latent defect: resolving through `homedir()` reads the
  // CURRENT PROCESS's home, so a caller with a scoped env — every unit test
  // here, and any isolated rig — would still have written the REAL ~/.acpx.
  // The same class as the box contamination this brick's lane caused with two
  // un-isolated probes: isolation is per-invocation and fails silently once.
  const scoped = piKnowledgeCachePath({ HOME: "/scoped-home" });
  assert.equal(scoped, "/scoped-home/.acpx/pi-model-knowledge.json");
  assert.equal(
    piKnowledgeCachePath({ ACPX_STATE_HOME: "/state", HOME: "/scoped-home" }),
    "/state/.acpx/pi-model-knowledge.json",
    "ACPX_STATE_HOME still wins, as it does for every other acpx path resolver",
  );
  assert.ok(
    !scoped.startsWith(homedir()),
    "must not resolve into the real home when env is scoped",
  );
});

test("pi knowledge: a failure to ASK is null, and a stale cache beats nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-know-"));
  try {
    const cachePath = join(root, "k.json");
    resetPiKnowledgeMemo();
    assert.equal(
      readPiAdvertisedModelIds({}, { cachePath, readAdvertised: () => null }),
      null,
      "could not ask ⇒ null",
    );

    // A stale cache beats nothing when pi cannot be asked.
    resetPiKnowledgeMemo();
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: new Date(0).toISOString(), ids: ["a/b"] }),
    );
    const stale = readPiAdvertisedModelIds({}, { cachePath, readAdvertised: () => null });
    assert.deepEqual([...(stale ?? [])], ["a/b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Brick d406ec77: the read pi filtered to NOTHING ─────────────────────────
//
// pi's `get_available_models` lists only providers with auth. The read's env lost
// its OpenRouter key, pi answered `[]`, and acpx cached that for 24 h as "pi knows
// nothing" — so every OpenRouter model got a fabricated, map-less entry. An empty
// answer is now a FAILED read, and the read runs with a placeholder key in a
// throwaway agent dir.

test("pi knowledge: an EMPTY answer is null — never cached, never memoised", () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-empty-"));
  try {
    const cachePath = join(root, "k.json");
    const stamp = "/usr/bin/pi:1:2";
    let asks = 0;
    let answer: string[] = [];
    const reader = () => {
      asks += 1;
      return { ids: answer, complete: true };
    };

    resetPiKnowledgeMemo();
    assert.equal(
      readPiAdvertisedModelIds({}, { cachePath, readAdvertised: reader, binaryStamp: stamp }),
      null,
      "pi bundles hundreds of models: an empty answer means it filtered them away",
    );
    assert.equal(existsSync(cachePath), false, "an empty answer must not be cached");

    // Not memoised: the very next call (no memo reset) must ask pi again and
    // get the real answer, instead of replaying the failure.
    answer = ["z-ai/glm-5.3-flash"];
    assert.deepEqual(
      [
        ...(readPiAdvertisedModelIds(
          {},
          { cachePath, readAdvertised: reader, binaryStamp: stamp },
        ) ?? []),
      ],
      ["z-ai/glm-5.3-flash"],
    );
    assert.equal(asks, 2, "the empty answer was memoised — pi was not asked again");

    // Control: a NON-empty answer IS cached and memoised, so the two rows above
    // are not passing on a reader that never caches anything.
    assert.deepEqual((JSON.parse(readFileSync(cachePath, "utf8")) as { ids: string[] }).ids, [
      "z-ai/glm-5.3-flash",
    ]);
    answer = [];
    readPiAdvertisedModelIds({}, { cachePath, readAdvertised: reader, binaryStamp: stamp });
    assert.equal(asks, 2, "a real answer must be memoised");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pi knowledge: a cached `ids: []` is never used — the poisoned 24 h cache retires itself", () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-poison-"));
  try {
    const cachePath = join(root, "k.json");
    const stamp = "/usr/bin/pi:1:2";
    const writeCacheFile = (ids: string[]) =>
      writeFileSync(
        cachePath,
        JSON.stringify({ fetchedAt: new Date().toISOString(), ids, binary: stamp, complete: true }),
      );
    let asks = 0;
    const reader = () => {
      asks += 1;
      return { ids: ["real/one"], complete: true };
    };

    // Fresh, same binary, empty: exactly the cache on all five boxes today.
    writeCacheFile([]);
    resetPiKnowledgeMemo();
    assert.deepEqual(
      [
        ...(readPiAdvertisedModelIds(
          {},
          { cachePath, readAdvertised: reader, binaryStamp: stamp },
        ) ?? []),
      ],
      ["real/one"],
    );
    assert.equal(asks, 1, "a cached empty list was trusted instead of asking pi");

    // ... and when pi cannot be asked, the empty cache is not a fallback either:
    // the answer is "could not establish", never an empty set.
    writeCacheFile([]);
    resetPiKnowledgeMemo();
    assert.equal(
      readPiAdvertisedModelIds({}, { cachePath, readAdvertised: () => null, binaryStamp: stamp }),
      null,
    );
    writeCacheFile([]);
    resetPiKnowledgeMemo();
    assert.equal(
      readPiAdvertisedModelIds({}, { cachePath, readAdvertised: reader, binaryStamp: null }),
      null,
      "no pi on PATH: an empty cache must not read as 'pi knows nothing'",
    );

    // Control: a NON-empty cache with the same stamp is used without asking.
    writeCacheFile(["cached/one"]);
    resetPiKnowledgeMemo();
    asks = 0;
    assert.deepEqual(
      [
        ...(readPiAdvertisedModelIds(
          {},
          { cachePath, readAdvertised: reader, binaryStamp: stamp },
        ) ?? []),
      ],
      ["cached/one"],
    );
    assert.equal(asks, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const REAL_LOOKING_KEY = "sk-or-v1-this-is-the-inherited-real-key";

test("pi knowledge read env: placeholder key, isolated agent dir, no session dir", () => {
  const inherited: NodeJS.ProcessEnv = {
    PATH: "/some/bin",
    HOME: "/home/someone",
    OPENROUTER_API_KEY: REAL_LOOKING_KEY,
    PI_CODING_AGENT_DIR: "/home/someone/.pi/agent",
    PI_CODING_AGENT_SESSION_DIR: "/does/not/exist",
  };
  const before = JSON.stringify(inherited);
  const child = piKnowledgeReadEnv(inherited, "/tmp/isolated");

  assert.equal(child.OPENROUTER_API_KEY, PI_KNOWLEDGE_PLACEHOLDER_KEY);
  assert.equal(child.PI_CODING_AGENT_DIR, "/tmp/isolated");
  assert.equal(
    "PI_CODING_AGENT_SESSION_DIR" in child,
    false,
    "pi would mkdir an inherited session dir outside the throwaway agent dir",
  );
  assert.equal(child.PATH, "/some/bin", "the rest of the env still reaches pi");
  assert.ok(
    !Object.values(child).includes(REAL_LOOKING_KEY),
    "the real key must not reach the read under any name",
  );
  assert.equal(JSON.stringify(inherited), before, "the caller's env must not be mutated");

  // Without any inherited key the placeholder is still supplied: that is the
  // production state (the key lives in auth.json), and the one that read 0 models.
  assert.equal(
    piKnowledgeReadEnv({ PATH: "/some/bin" }, "/tmp/isolated").OPENROUTER_API_KEY,
    PI_KNOWLEDGE_PLACEHOLDER_KEY,
  );
});

const REPLY = '{"type":"response","id":"acpx-knowledge","data":{"models":[{"id":"a/b"}]}}\n';

/** Stand-in pi rows: a short refresh wait, and a deadline well inside the suite's patience. */
const FAST: PiRpcTiming = { refreshWaitMs: 300, deadlineMs: 5_000 };

test("pi knowledge RPC: the spawned pi gets the isolated env, and the temp dir is removed after success", () => {
  // A holder, not a `let`: TS's flow analysis cannot see a closure's assignment.
  const captured: {
    env?: NodeJS.ProcessEnv;
    dirExisted?: boolean;
    command?: string;
    args?: string[];
  } = {};
  const spawn: PiRpcSpawn = (command, args, options) => {
    captured.env = options.env;
    captured.command = command;
    captured.args = args;
    const dir = options.env.PI_CODING_AGENT_DIR ?? "";
    captured.dirExisted = existsSync(dir);
    // What pi itself does with its agent dir, even for this read.
    writeFileSync(join(dir, "auth.json"), "{}");
    mkdirSync(join(dir, "sessions", "--cwd--"), { recursive: true });
    return { stdout: REPLY };
  };

  const ids = readAdvertisedViaRpc(
    "pi",
    {
      OPENROUTER_API_KEY: REAL_LOOKING_KEY,
      PI_CODING_AGENT_DIR: "/home/someone/.pi/agent",
      PI_CODING_AGENT_SESSION_DIR: "/does/not/exist",
    },
    spawn,
  );

  // No refresh marker in this reply ⇒ the answer is the floor, never "complete".
  assert.deepEqual(ids, { ids: ["a/b"], complete: false });
  assert.equal(captured.command, process.execPath, "the read runs the node driver");
  assert.equal(captured.args?.[2], "pi", "the driver must be handed the pi command");
  const seen = captured.env;
  assert.ok(seen, "the spawn was never called");
  const agentDir = seen.PI_CODING_AGENT_DIR ?? "";
  assert.equal(captured.dirExisted, true, "pi must be handed a directory that exists");
  assert.ok(agentDir.startsWith(tmpdir()), `not a temp dir: ${agentDir}`);
  assert.notEqual(agentDir, "/home/someone/.pi/agent", "the box's agent dir leaked into the read");
  assert.equal(seen.OPENROUTER_API_KEY, PI_KNOWLEDGE_PLACEHOLDER_KEY);
  assert.equal("PI_CODING_AGENT_SESSION_DIR" in seen, false);
  assert.ok(!Object.values(seen).includes(REAL_LOOKING_KEY));
  assert.equal(
    existsSync(agentDir),
    false,
    "the temp agent dir (with pi's writes) was left behind",
  );
});

test("pi knowledge RPC: the temp dir is removed on every FAILURE path too, and the read never throws", () => {
  const failures: Array<[string, PiRpcSpawn]> = [
    ["spawn error", () => ({ error: new Error("ENOENT"), stdout: null })],
    ["no reply frame", () => ({ stdout: "garbage\n" })],
    [
      "spawn throws",
      () => {
        throw new Error("boom");
      },
    ],
  ];
  for (const [label, failing] of failures) {
    let agentDir = "";
    const spawn: PiRpcSpawn = (command, args, options) => {
      agentDir = options.env.PI_CODING_AGENT_DIR ?? "";
      writeFileSync(join(agentDir, "auth.json"), "{}");
      return failing(command, args, options);
    };
    assert.equal(readAdvertisedViaRpc("pi", {}, spawn), null, label);
    assert.ok(agentDir.startsWith(tmpdir()), `${label}: spawn was not reached`);
    assert.equal(existsSync(agentDir), false, `${label}: temp agent dir left behind`);
  }
});

test("pi knowledge RPC: a REAL child process sees the placeholder and the isolated dir", () => {
  // The rows above inject the spawn; this one runs the default `spawnSync` against
  // a stand-in `pi` that echoes what it was given back as model ids.
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-fake-"));
  try {
    const fakePi = join(root, "pi");
    writeFileSync(
      fakePi,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        'touch "$PI_CODING_AGENT_DIR/auth.json"',
        'printf \'{"type":"response","id":"acpx-knowledge","data":{"models":[{"id":"%s"},{"id":"%s"},{"id":"session-dir=%s"}]}}\\n\' "$OPENROUTER_API_KEY" "$PI_CODING_AGENT_DIR" "${PI_CODING_AGENT_SESSION_DIR-unset}"',
        "",
      ].join("\n"),
    );
    chmodSync(fakePi, 0o755);

    const read = readAdvertisedViaRpc(
      fakePi,
      {
        PATH: process.env.PATH,
        OPENROUTER_API_KEY: REAL_LOOKING_KEY,
        PI_CODING_AGENT_SESSION_DIR: "/does/not/exist",
      },
      undefined,
      FAST,
    );
    assert.ok(read, "the stand-in pi did not answer");
    const [key, agentDir, sessionDir] = read.ids;
    assert.equal(key, PI_KNOWLEDGE_PLACEHOLDER_KEY);
    assert.ok(agentDir?.startsWith(tmpdir()), `not a temp dir: ${agentDir}`);
    assert.equal(sessionDir, "session-dir=unset");
    assert.equal(existsSync(agentDir ?? ""), false, "the real read left its temp dir behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Brick d406ec77, defect D1: the read waits for pi's OWN refresh ───────────
//
// The first `get_available_models` answers from pi's BUNDLE. On a box whose
// bundle predates a model (deepseek/deepseek-v4.1-flash on the 09-06 build), that
// floor calls the model unknown and acpx fabricates an entry over pi's real one.
// The read now waits for pi to write its refreshed `models-store.json` and KEEPS
// that block; the ids stay the floor. These rows drive the real driver against a
// stand-in pi.

const STAND_IN_PI = [
  "#!/usr/bin/env node",
  'const fs = require("fs"), path = require("path");',
  "const dir = process.env.PI_CODING_AGENT_DIR, mode = process.env.FAKE_PI_MODE;",
  "fs.writeFileSync(process.env.FAKE_PI_INFO, JSON.stringify({ pid: process.pid, dir }));",
  'fs.writeFileSync(path.join(dir, "auth.json"), "{}");',
  "let refreshed = false;",
  'if (mode === "refresh") setTimeout(() => {',
  '  fs.writeFileSync(path.join(dir, "models-store.json"), JSON.stringify({ openrouter: { models: [{ id: "new/model" }] } }));',
  "  refreshed = true;",
  "}, 150);",
  'if (mode === "hang") { setInterval(() => {}, 1000); } else {',
  '  let buf = ""; process.stdin.setEncoding("utf8");',
  '  process.stdin.on("data", (d) => { buf += d; let i;',
  '    while ((i = buf.indexOf("\\n")) >= 0) { const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);',
  '      const ids = refreshed ? ["old/model", "new/model"] : ["old/model"];',
  '      process.stdout.write(JSON.stringify({ type: "response", id: req.id, data: { models: ids.map((id) => ({ id })) } }) + "\\n"); } });',
  '  process.stdin.on("end", () => process.exit(0));',
  "}",
  "",
].join("\n");

function withStandInPi<T>(
  mode: "refresh" | "never" | "hang",
  run: (fakePi: string, env: NodeJS.ProcessEnv, info: () => { pid: number; dir: string }) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-standin-"));
  try {
    const fakePi = join(root, "pi");
    writeFileSync(fakePi, STAND_IN_PI);
    chmodSync(fakePi, 0o755);
    const infoPath = join(root, "info.json");
    const env = { PATH: process.env.PATH, FAKE_PI_MODE: mode, FAKE_PI_INFO: infoPath };
    return run(
      fakePi,
      env,
      () => JSON.parse(readFileSync(infoPath, "utf8")) as { pid: number; dir: string },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const D1_TIMING: PiRpcTiming = { refreshWaitMs: 3_000, deadlineMs: 8_000 };

test("pi knowledge D1: a refresh that lands ⇒ the FLOOR ids plus pi's own refreshed block, complete", () => {
  withStandInPi("refresh", (fakePi, env, info) => {
    const started = Date.now();
    const read = readAdvertisedViaRpc(fakePi, env, undefined, D1_TIMING);
    const elapsed = Date.now() - started;
    assert.deepEqual(read, {
      ids: ["old/model"],
      complete: true,
      openrouter: { models: [{ id: "new/model" }] },
    });
    assert.ok(
      elapsed < D1_TIMING.refreshWaitMs,
      `waited out the cap (${elapsed} ms) instead of the signal`,
    );
    assert.equal(existsSync(info().dir), false, "temp agent dir left behind");
  });
});

test("pi knowledge D1 control: a refresh that never lands ⇒ the FLOOR, no block, incomplete", () => {
  withStandInPi("never", (fakePi, env, info) => {
    const started = Date.now();
    const read = readAdvertisedViaRpc(fakePi, env, undefined, FAST);
    assert.deepEqual(read, { ids: ["old/model"], complete: false });
    assert.ok(Date.now() - started >= FAST.refreshWaitMs, "the read did not wait for the refresh");
    assert.equal(existsSync(info().dir), false, "temp agent dir left behind");
  });
});

test("pi knowledge D1: a pi that HANGS is killed at the deadline — null, no orphan, no temp dir", () => {
  withStandInPi("hang", (fakePi, env, info) => {
    const started = Date.now();
    const read = readAdvertisedViaRpc(fakePi, env, undefined, {
      refreshWaitMs: 200,
      deadlineMs: 1_000,
    });
    const elapsed = Date.now() - started;
    assert.equal(read, null);
    assert.ok(elapsed < 4_000, `the hard bound did not hold: ${elapsed} ms`);
    const { pid, dir } = info();
    assert.throws(() => process.kill(pid, 0), /ESRCH/, `stand-in pi ${pid} survived the read`);
    assert.equal(existsSync(dir), false, "temp agent dir left behind");
  });
});

test("pi knowledge D1: `complete` only when the driver saw the refresh land AND the block is readable", () => {
  const floor = JSON.stringify({
    type: "response",
    id: "acpx-knowledge",
    data: { models: [{ id: "a" }] },
  });
  const marker = (landed: boolean) => JSON.stringify({ type: "acpx-refresh", landed });
  const block = { models: [{ id: "b", thinkingLevelMap: { max: "max" } }] };
  const cases: Array<[string, string[], unknown, unknown]> = [
    [
      "landed, block written",
      [floor, marker(true)],
      { openrouter: block },
      { ids: ["a"], complete: true, openrouter: block },
    ],
    [
      "block written, NOT landed",
      [floor, marker(false)],
      { openrouter: block },
      { ids: ["a"], complete: false },
    ],
    ["landed, no block on disk", [floor, marker(true)], undefined, { ids: ["a"], complete: false }],
    [
      "landed, EMPTY block",
      [floor, marker(true)],
      { openrouter: { models: [] } },
      { ids: ["a"], complete: false },
    ],
    ["nothing answered", [marker(true)], { openrouter: block }, null],
  ];
  for (const [label, lines, store, expected] of cases) {
    const spawn: PiRpcSpawn = (_c, _a, options) => {
      if (store !== undefined) {
        writeFileSync(
          join(options.env.PI_CODING_AGENT_DIR ?? "", "models-store.json"),
          JSON.stringify(store),
        );
      }
      return { stdout: `${lines.join("\n")}\n` };
    };
    assert.deepEqual(readAdvertisedViaRpc("pi", {}, spawn), expected, label);
  }
});

test("pi knowledge D1: an INCOMPLETE answer lives one hour (cache AND memo); a complete one a day", () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-ttl-"));
  try {
    const stamp = "/usr/bin/pi:1:2";
    const t0 = Date.parse("2026-11-20T12:00:00Z");
    const later = t0 + PI_INCOMPLETE_KNOWLEDGE_TTL_MS + 60_000;
    // Still well inside the 24 h a complete answer gets.
    const muchLater = later + PI_INCOMPLETE_KNOWLEDGE_TTL_MS + 60_000;
    for (const complete of [false, true]) {
      const cachePath = join(root, `k-${complete}.json`);
      let asks = 0;
      const reader = () => {
        asks += 1;
        return { ids: ["old/model"], complete };
      };
      resetPiKnowledgeMemo();
      readPiAdvertisedModelIds(
        {},
        { cachePath, readAdvertised: reader, binaryStamp: stamp, now: t0 },
      );
      assert.equal(
        (JSON.parse(readFileSync(cachePath, "utf8")) as { complete?: boolean }).complete,
        complete,
      );
      // Same process (memo NOT reset), just past the short TTL.
      readPiAdvertisedModelIds(
        {},
        { cachePath, readAdvertised: reader, binaryStamp: stamp, now: later },
      );
      // A new process (memo reset), past the short TTL of the cache the second
      // read wrote: now the cache FILE decides, with no memo in the way.
      resetPiKnowledgeMemo();
      readPiAdvertisedModelIds(
        {},
        { cachePath, readAdvertised: reader, binaryStamp: stamp, now: muchLater },
      );
      assert.equal(
        asks,
        complete ? 1 : 3,
        complete
          ? "a complete answer must be reused for the day"
          : "a floor-only answer was reused past its hour",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pi knowledge D1: a cache written BEFORE `complete` existed is re-asked once", () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-legacy-"));
  try {
    const stamp = "/usr/bin/pi:1:2";
    let asks = 0;
    const reader = () => {
      asks += 1;
      return { ids: ["old/model", "new/model"], complete: true };
    };
    for (const legacy of [true, false]) {
      const cachePath = join(root, `k-${legacy}.json`);
      // The floor-only cache the previous build wrote on four boxes: fresh, same binary, no field.
      writeFileSync(
        cachePath,
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          ids: ["old/model"],
          binary: stamp,
          ...(legacy ? {} : { complete: true }),
        }),
      );
      asks = 0;
      resetPiKnowledgeMemo();
      const known = readPiAdvertisedModelIds(
        {},
        { cachePath, readAdvertised: reader, binaryStamp: stamp },
      );
      assert.equal(
        asks,
        legacy ? 1 : 0,
        legacy ? "legacy cache trusted" : "control: complete cache re-asked",
      );
      assert.equal(known?.has("new/model"), legacy);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Brick d406ec77, D1: the KEPT block is the overlay when the box store is empty ──
//
// The rule: the box overlay = the box's own `models-store.json` openrouter block
// when it is non-empty, ELSE pi's own refreshed block that acpx kept from its last
// COMPLETE knowledge read. Everything downstream is unchanged.

const DS_ID = "deepseek/deepseek-v4.1-flash";
/** Shaped like pi's own refreshed row (devbox-staging, 2026-11-20). */
const PI_DS_ENTRY = {
  id: DS_ID,
  name: "DeepSeek: DeepSeek V4.1 Flash",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0.05, output: 0.2, cacheRead: 0.01, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 65_536,
  thinkingLevelMap: {
    off: "none",
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  },
};
const PI_GLM_ENTRY = {
  ...PI_DS_ENTRY,
  id: "z-ai/glm-5.3-flash",
  name: "Z.ai: GLM 5.3 Flash",
  thinkingLevelMap: { low: "low", high: "high", max: "max" },
};

function keep(
  fx: Fixture,
  models: unknown[],
  options: { ageMs?: number; binary?: string } = {},
): void {
  writeFileSync(
    piKeptOverlayPath(fx.env.ACPX_PI_KNOWLEDGE_CACHE as string),
    JSON.stringify({
      fetchedAt: new Date(Date.now() - (options.ageMs ?? 0)).toISOString(),
      binary: options.binary,
      openrouter: { lastModified: 1, checkedAt: 1, models },
    }),
  );
}

const storeEntry = (p: ReturnType<typeof provisioningFor>, id: string) =>
  (p.store?.json.openrouter.models as Array<{ id: string }> | undefined)?.find((m) => m.id === id);
const configEntry = (p: ReturnType<typeof provisioningFor>, id: string) =>
  ((p.config?.json.providers?.openrouter?.models ?? []) as Array<{ id: string }>).find(
    (m) => m.id === id,
  );

test("D1 overlay: EMPTY box store + kept block ⇒ the session store carries PI's entry, map intact, nothing fabricated", () => {
  const withBlock = fixture({ piKnows: ["z-ai/glm-5.3-flash"] });
  const without = fixture({ piKnows: ["z-ai/glm-5.3-flash"] });
  try {
    keep(withBlock, [PI_DS_ENTRY]);
    const kept = provisioningFor(withBlock, `openrouter/${DS_ID}`);
    assert.deepEqual(storeEntry(kept, DS_ID), PI_DS_ENTRY, "pi's own row, byte for byte");
    assert.equal(kept.store?.json.openrouter.models.length, 1, "nothing fabricated beside it");
    assert.equal(configEntry(kept, DS_ID), undefined, "no fabricated models.json definition");

    // Control: no kept block ⇒ today's D1 behaviour — a fabricated, map-less entry
    // in BOTH files (usable model, wrong ladder).
    const fabricated = provisioningFor(without, `openrouter/${DS_ID}`);
    const entry = storeEntry(fabricated, DS_ID) as { thinkingLevelMap?: unknown } | undefined;
    assert.ok(entry, "control: the model must still be provisioned");
    assert.equal(entry.thinkingLevelMap, undefined);
    assert.ok(configEntry(fabricated, DS_ID));
  } finally {
    rmSync(withBlock.root, { recursive: true, force: true });
    rmSync(without.root, { recursive: true, force: true });
  }
});

test("D1 overlay: a NON-EMPTY box store wins — the kept block changes nothing (devbox stays identical)", () => {
  const boxOverlay = [PI_GLM_ENTRY];
  const plain = fixture({ piKnows: ["z-ai/glm-5.3-flash"], boxOverlay });
  const withBlock = fixture({ piKnows: ["z-ai/glm-5.3-flash"], boxOverlay });
  try {
    keep(withBlock, [PI_DS_ENTRY, { ...PI_GLM_ENTRY, name: "KEPT-MARKER" }]);
    for (const model of [DS_ID, "z-ai/glm-5.3-flash"]) {
      const a = provisioningFor(plain, `openrouter/${model}`);
      const b = provisioningFor(withBlock, `openrouter/${model}`);
      assert.deepEqual(b.store?.json.openrouter.models, a.store?.json.openrouter.models, model);
      assert.deepEqual(b.config?.json, a.config?.json, model);
      assert.ok(
        !JSON.stringify(b.store?.json ?? {}).includes("KEPT-MARKER"),
        `${model}: the kept block leaked past a non-empty box store`,
      );
    }
    // The comparison is not vacuous: with the box store, DS is still fabricated.
    const ds = storeEntry(provisioningFor(withBlock, `openrouter/${DS_ID}`), DS_ID) as {
      thinkingLevelMap?: unknown;
    };
    assert.equal(ds.thinkingLevelMap, undefined);
  } finally {
    rmSync(plain.root, { recursive: true, force: true });
    rmSync(withBlock.root, { recursive: true, force: true });
  }
});

test("D1 overlay: a STALE kept block is ignored (floor path); a fresh one is used", () => {
  const stale = fixture({ piKnows: ["z-ai/glm-5.3-flash"] });
  const fresh = fixture({ piKnows: ["z-ai/glm-5.3-flash"] });
  try {
    keep(stale, [PI_DS_ENTRY], { ageMs: 25 * 60 * 60 * 1000 });
    keep(fresh, [PI_DS_ENTRY], { ageMs: 23 * 60 * 60 * 1000 });
    const s1 = storeEntry(provisioningFor(stale, `openrouter/${DS_ID}`), DS_ID) as {
      thinkingLevelMap?: unknown;
    };
    assert.equal(s1.thinkingLevelMap, undefined, "a 25 h old block was used");
    assert.deepEqual(storeEntry(provisioningFor(fresh, `openrouter/${DS_ID}`), DS_ID), PI_DS_ENTRY);
  } finally {
    rmSync(stale.root, { recursive: true, force: true });
    rmSync(fresh.root, { recursive: true, force: true });
  }
});

test("D1 overlay: a kept block from ANOTHER pi binary is ignored; the same binary's is used", () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-kept-bin-"));
  try {
    const cachePath = join(root, "k.json");
    writeFileSync(
      piKeptOverlayPath(cachePath),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        binary: "/usr/bin/pi:1:2",
        openrouter: { models: [PI_DS_ENTRY] },
      }),
    );
    const read = (binaryStamp: string | null) =>
      readPiKeptOpenRouterModels({}, { cachePath, binaryStamp });
    assert.deepEqual(read("/usr/bin/pi:9:9"), [], "a different pi build's block was used");
    assert.deepEqual(read("/usr/bin/pi:1:2"), [PI_DS_ENTRY]);
    assert.deepEqual(read(null), [PI_DS_ENTRY], "no resolvable pi ⇒ freshness alone decides");
    // Beside the knowledge cache, never under a pi agent dir.
    assert.equal(dirname(piKeptOverlayPath(cachePath)), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D1 overlay: a COMPLETE knowledge cache with NO kept block takes the floor path — the model stays usable", () => {
  const fx = fixture({ piKnows: ["z-ai/glm-5.3-flash"] });
  try {
    writeFileSync(
      fx.env.ACPX_PI_KNOWLEDGE_CACHE as string,
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        ids: ["z-ai/glm-5.3-flash"],
        complete: true,
      }),
    );
    const p = provisioningFor(fx, `openrouter/${DS_ID}`);
    assert.ok(
      storeEntry(p, DS_ID),
      "pi will not advertise it without an entry: it must be provisioned",
    );
    assert.ok(configEntry(p, DS_ID));
    // Control: the same cache WITH the block ⇒ pi's entry, nothing fabricated.
    keep(fx, [PI_DS_ENTRY]);
    resetPiKnowledgeMemo();
    const q = provisioningFor(fx, `openrouter/${DS_ID}`);
    assert.deepEqual(storeEntry(q, DS_ID), PI_DS_ENTRY);
    assert.equal(configEntry(q, DS_ID), undefined);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("D1 overlay: an UNKNOWN model is still provisioned on top of the kept block", () => {
  const fx = fixture({ piKnows: ["z-ai/glm-5.3-flash"], catalogue: [KNOWN_ROW] });
  try {
    keep(fx, [PI_DS_ENTRY]);
    const p = provisioningFor(fx, `openrouter/${KNOWN_ID}`);
    const provisioned = storeEntry(p, KNOWN_ID) as { cost: { input: number } } | undefined;
    assert.ok(provisioned, "the unknown model lost its entry");
    assert.equal(provisioned.cost.input, 0.15, "real rates, not zeros");
    assert.ok(configEntry(p, KNOWN_ID), "and its models.json definition");
    assert.deepEqual(storeEntry(p, DS_ID), PI_DS_ENTRY, "the kept rows ride along untouched");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("D1 kept block: a complete read writes it; a FLOOR-ONLY read never overwrites it", () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-kept-write-"));
  try {
    const cachePath = join(root, "k.json");
    const keptPath = piKeptOverlayPath(cachePath);
    const stamp = "/usr/bin/pi:1:2";
    const readWith = (read: PiAdvertisedRead) => {
      rmSync(cachePath, { force: true }); // force a fresh read each time
      resetPiKnowledgeMemo();
      readPiAdvertisedModelIds({}, { cachePath, readAdvertised: () => read, binaryStamp: stamp });
    };
    const keptModels = () =>
      (JSON.parse(readFileSync(keptPath, "utf8")) as { openrouter: { models: unknown[] } })
        .openrouter.models;

    readWith({ ids: ["a"], complete: true, openrouter: { models: [{ id: "x" }] } });
    assert.deepEqual(keptModels(), [{ id: "x" }]);
    assert.equal((JSON.parse(readFileSync(keptPath, "utf8")) as { binary?: string }).binary, stamp);

    readWith({ ids: ["a"], complete: false });
    assert.deepEqual(keptModels(), [{ id: "x" }], "a floor-only read clobbered the kept block");

    // Control: a later COMPLETE read does replace it.
    readWith({ ids: ["a"], complete: true, openrouter: { models: [{ id: "y" }] } });
    assert.deepEqual(keptModels(), [{ id: "y" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pi knowledge: a reply frame with NO models array is 'could not ask', never 'knows nothing'", () => {
  // 🛑 THE REGRESSION THIS PINS. A refactor turned this case into an EMPTY ID
  // LIST, i.e. "pi advertises nothing" — the exact collapse the module exists to
  // prevent, and the one that drives the opposite decision one level up
  // (provision everything vs. provision nothing). It changed no test, because no
  // test reached this line.
  assert.deepEqual(readReplyLine('{"type":"response","id":"acpx-knowledge","data":{}}'), {
    kind: "malformed",
  });
  assert.deepEqual(
    readReplyLine('{"type":"response","id":"acpx-knowledge","data":{"models":"nope"}}'),
    { kind: "malformed" },
  );

  // ... and the three neighbours it must NOT be confused with. Without these the
  // assertion above passes on a classifier that answers "malformed" to everything.
  assert.deepEqual(
    readReplyLine('{"type":"response","id":"acpx-knowledge","data":{"models":[]}}'),
    {
      kind: "ids",
      ids: [],
    },
  );
  assert.deepEqual(
    readReplyLine(
      '{"type":"response","id":"acpx-knowledge","data":{"models":[{"id":"a/b"},{"nope":1}]}}',
    ),
    { kind: "ids", ids: ["a/b"] },
  );
  assert.deepEqual(readReplyLine('{"type":"event","id":"acpx-knowledge"}'), { kind: "other" });
  assert.deepEqual(readReplyLine("not json at all"), { kind: "other" });
  assert.deepEqual(readReplyLine("   "), { kind: "other" });
});

test("pi knowledge: the cache is keyed by the pi BINARY's identity, and a mismatch re-asks", () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-ident-"));
  try {
    const cachePath = join(root, "k.json");
    let asks = 0;
    const reader = () => {
      asks += 1;
      return { ids: ["fresh/from-the-binary"], complete: true };
    };

    // A cold read stamps the cache with the binary it asked.
    resetPiKnowledgeMemo();
    const first = readPiAdvertisedModelIds(
      {},
      { cachePath, readAdvertised: reader, binaryStamp: "/usr/bin/pi:111:222" },
    );
    assert.deepEqual([...(first ?? [])], ["fresh/from-the-binary"]);
    assert.equal(asks, 1);
    assert.equal(
      (JSON.parse(readFileSync(cachePath, "utf8")) as { binary?: string }).binary,
      "/usr/bin/pi:111:222",
      "the cache must record WHICH binary answered, or identity can never be checked",
    );

    // Same binary ⇒ the cache is used and pi is NOT asked again.
    resetPiKnowledgeMemo();
    readPiAdvertisedModelIds(
      {},
      { cachePath, readAdvertised: reader, binaryStamp: "/usr/bin/pi:111:222" },
    );
    assert.equal(asks, 1, "same binary, fresh cache ⇒ no second spawn");

    // A DIFFERENT binary ⇒ the cache is stale however recent it is. This is the
    // direction the 24 h TTL could not express: a pi upgrade was invisible for a
    // day, and a rig's pi and the box's pi shared one answer.
    resetPiKnowledgeMemo();
    readPiAdvertisedModelIds(
      {},
      { cachePath, readAdvertised: reader, binaryStamp: "/usr/bin/pi:999:222" },
    );
    assert.equal(asks, 2, "a different binary must re-ask, TTL notwithstanding");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pi knowledge: NO resolvable pi ⇒ NO spawn is attempted at all, and the memo skips a repeat", () => {
  const root = mkdtempSync(join(tmpdir(), "acpx-pi-nospawn-"));
  try {
    const cachePath = join(root, "k.json");
    let asks = 0;
    const reader = () => {
      asks += 1;
      return { ids: ["should/never-be-reached"], complete: true };
    };

    // `binaryStamp: null` is the "pi is not on PATH" state — the state EVERY box
    // without pi is in. The old code paid a failed spawnSync per session create
    // to learn what a stat answers.
    resetPiKnowledgeMemo();
    assert.equal(
      readPiAdvertisedModelIds({}, { cachePath, readAdvertised: reader, binaryStamp: null }),
      null,
      "no binary and no cache ⇒ could not establish",
    );
    assert.equal(asks, 0, "a spawn was attempted for a pi that does not exist");

    // ... and with a cache present it is used, still without asking.
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: new Date().toISOString(), ids: ["cached/one"] }),
    );
    resetPiKnowledgeMemo();
    assert.deepEqual(
      [
        ...(readPiAdvertisedModelIds(
          {},
          { cachePath, readAdvertised: reader, binaryStamp: null },
        ) ?? []),
      ],
      ["cached/one"],
    );
    assert.equal(asks, 0);

    // The process memo: a SECOND identical read does not even re-read the file.
    // Proven by deleting the file between the two calls — a read that still
    // answers can only have come from the memo.
    rmSync(cachePath, { force: true });
    assert.deepEqual(
      [
        ...(readPiAdvertisedModelIds(
          {},
          { cachePath, readAdvertised: reader, binaryStamp: null },
        ) ?? []),
      ],
      ["cached/one"],
      "the memo did not answer — session creates would re-read the cache file each time",
    );
    // And the control that makes that meaningful: clear the memo and the same
    // call now correctly reports it cannot establish anything.
    resetPiKnowledgeMemo();
    assert.equal(
      readPiAdvertisedModelIds({}, { cachePath, readAdvertised: reader, binaryStamp: null }),
      null,
      "with the memo cleared and the file gone, the answer MUST change",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("billing carries the CACHE rates, and an unquoted rate is null — not zero", () => {
  const priced = deriveBilling(KNOWN_ROW as never);
  assert.equal(priced.kind, "metered");
  assert.equal(priced.cacheReadPerM, 0.016);
  assert.ok(
    Math.abs((priced.cacheWritePerM ?? 0) - 0.2) < 1e-12,
    "IEEE-754: 0.0000002*1e6 ≠ 0.2 exactly",
  );

  const noCacheRates = deriveBilling({
    id: "x/y",
    pricing: { prompt: "0.000001", completion: "0.000002" },
  } as never);
  assert.equal(noCacheRates.cacheReadPerM, null, "unquoted ⇒ null; a null rate is not a free rate");
  assert.equal(noCacheRates.cacheWritePerM, null);
});

// ── Layer 2 (inert): the stored cost shape ───────────────────────────────────

test("cost figure: coverage is COUNTS, and a partial total is kept, never nulled", () => {
  const rates = {
    in_per_m: 1,
    out_per_m: 2,
    cache_read_per_m: 0,
    cache_write_per_m: 0,
    measured_free: false,
  };
  const units: CostUnit[] = [
    { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0, rates },
    { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0, rates: null },
  ];
  const figure = deriveCostFigure(units);
  assert.equal(figure.provenance, "computed");
  assert.equal(figure.amount, 1, "the priced half is REAL and must survive as a lower bound");
  assert.deepEqual(figure.coverage, { unit: "message", priced: 1, total: 2 });
  assert.notEqual(figure.amount, null, "nulling a partially real number destroys information");
});

test("cost figure: `free` requires EVERY unit measured-free, and can never be partial", () => {
  const free = {
    in_per_m: 0,
    out_per_m: 0,
    cache_read_per_m: 0,
    cache_write_per_m: 0,
    measured_free: true,
  };
  const paid = {
    in_per_m: 1,
    out_per_m: 1,
    cache_read_per_m: 0,
    cache_write_per_m: 0,
    measured_free: false,
  };
  const allFree = deriveCostFigure([
    { input: 10, output: 10, cache_read: 0, cache_write: 0, rates: free },
    { input: 10, output: 10, cache_read: 0, cache_write: 0, rates: free },
  ]);
  assert.equal(allFree.provenance, "free");
  assert.equal(allFree.amount, 0, "a MEASURED zero — $0.00 is correct for it");

  const mixed = deriveCostFigure([
    { input: 10, output: 10, cache_read: 0, cache_write: 0, rates: free },
    { input: 1_000_000, output: 0, cache_read: 0, cache_write: 0, rates: paid },
  ]);
  assert.equal(mixed.provenance, "computed", "a partial `free` would absorb the missing entries");
});

test("cost figure: nothing priceable ⇒ `unpriced` with amount null, and it still ships the counts", () => {
  const figure = deriveCostFigure([
    { input: 5, output: 5, cache_read: 0, cache_write: 0, rates: null },
    { input: 5, output: 5, cache_read: 0, cache_write: 0, rates: null },
  ]);
  assert.equal(figure.provenance, "unpriced");
  assert.equal(figure.amount, null, "unpriced must NEVER be rendered as $0.00");
  assert.deepEqual(figure.coverage, { unit: "message", priced: 0, total: 2 });
});

test("cost figure: `coverage: null` arises ONLY from a source with no units", () => {
  // The one meaning of null: "not decomposable by construction". A unit-bearing
  // derivation always emits counts, so a null from one would be a bug.
  assert.deepEqual(reportedCost(6.44), {
    amount: 6.44,
    currency: "USD",
    provenance: "reported",
    coverage: null,
  });
  assert.deepEqual(deriveCostFigure([]), {
    amount: null,
    currency: "USD",
    provenance: "unpriced",
    coverage: null,
  });
});
