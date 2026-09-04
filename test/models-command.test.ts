import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCatalogue } from "../src/models/catalogue.js";
import {
  ModelSlugError,
  parseModelRef,
  validateModelSelection,
  validateSessionModelFlags,
} from "../src/models/model-slug-validation.js";
import type { ModelCatalogue } from "../src/models/types.js";

const META = { fetchedAt: "2026-09-04T00:00:00.000Z", stale: false, error: null };

/** node:assert's `throws` returns void, so the thrown value is captured here. */
function caught(fn: () => unknown): ModelSlugError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ModelSlugError, `expected a ModelSlugError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected the call to throw, and it did not");
}

function catalogueWith(): ModelCatalogue {
  return buildCatalogue(
    [
      {
        id: "moonshotai/kimi-k3",
        name: "MoonshotAI: Kimi K3",
        supported_parameters: ["tools"],
        reasoning: { supported_efforts: ["low", "high", "max"], default_effort: "max" },
      },
      {
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek: DeepSeek V4 Pro",
        supported_parameters: ["tools"],
        reasoning: { supported_efforts: ["high", "xhigh"], default_effort: "high" },
      },
      { id: "mistralai/large-3", name: "Mistral Large 3", supported_parameters: ["tools"] },
    ],
    META,
  );
}

// ── Reference parsing ────────────────────────────────────────────────────────

test("parse: only a KNOWN source prefix splits — an OpenRouter :free suffix is part of the id", () => {
  assert.deepEqual(parseModelRef("openrouter:z-ai/glm-5.3"), {
    source: "openrouter",
    id: "z-ai/glm-5.3",
    bracket: null,
    raw: "openrouter:z-ai/glm-5.3",
  });
  const free = parseModelRef("deepseek/v4:free");
  assert.equal(free.source, null);
  assert.equal(free.id, "deepseek/v4:free");
});

test("parse: a trailing [bracket] is stripped — codex fuses the effort into the id", () => {
  const codex = parseModelRef("gpt-5.6-sol[high]");
  assert.equal(codex.id, "gpt-5.6-sol");
  assert.equal(codex.bracket, "high");
  // The Claude context-window hint takes the same shape.
  assert.equal(parseModelRef("sonnet[1m]").id, "sonnet");
});

// ── The three error shapes (C5 §6) ───────────────────────────────────────────

test("SHAPE 1 — an unknown slug exits USAGE, names the nearest matches and the search verb", () => {
  const error = caught(() => validateModelSelection(catalogueWith(), { model: "kimi-k3" }));
  assert.equal(error.outputCode, "USAGE"); // → exit 2
  assert.equal(error.detailCode, "MODEL_SLUG_UNKNOWN");
  assert.match(error.message, /moonshotai\/kimi-k3/);
  assert.match(error.message, /acpx models --search/);
});

test("SHAPE 1 — a typo still finds its target, because a typo shares no whole token", () => {
  const error = caught(() =>
    validateModelSelection(catalogueWith(), { model: "deepsek/deepseek-v4-pro" }),
  );
  assert.match(error.message, /deepseek\/deepseek-v4-pro/);
});

test("SHAPE 2 — an id under two sources exits USAGE listing BOTH keys with their billing", () => {
  const error = caught(() => validateModelSelection(catalogueWith(), { model: "opus" }));
  assert.equal(error.outputCode, "USAGE");
  assert.equal(error.detailCode, "MODEL_SLUG_AMBIGUOUS");
  assert.match(error.message, /claude-subscription:opus/);
  assert.match(error.message, /claude-home:opus/);
  // It refuses to guess rather than picking the cheaper or the first.
  assert.doesNotMatch(error.message, /using claude-subscription/);
});

test("SHAPE 2 — naming the source resolves it, and the create proceeds", () => {
  const model = validateModelSelection(catalogueWith(), { model: "claude-subscription:opus" });
  assert.equal(model?.key, "claude-subscription:opus");
});

test("SHAPE 3 — an effort outside the ladder exits USAGE and prints THAT model's ladder", () => {
  const error = caught(() =>
    validateModelSelection(catalogueWith(), {
      model: "deepseek/deepseek-v4-pro",
      reasoningEffort: "max",
    }),
  );
  assert.equal(error.outputCode, "USAGE");
  assert.equal(error.detailCode, "MODEL_EFFORT_OUT_OF_LADDER");
  assert.match(error.message, /high, xhigh/);
  assert.match(error.message, /default: high/);
});

test("SHAPE 3 — a model with NO ladder says so rather than printing an empty list", () => {
  const error = caught(() =>
    validateModelSelection(catalogueWith(), {
      model: "mistralai/large-3",
      reasoningEffort: "high",
    }),
  );
  assert.match(error.message, /does not accept a reasoning setting/);
});

test("an effort INSIDE the ladder passes, and so does the `default` sentinel", () => {
  const catalogue = catalogueWith();
  assert.ok(
    validateModelSelection(catalogue, {
      model: "deepseek/deepseek-v4-pro",
      reasoningEffort: "xhigh",
    }),
  );
  assert.ok(
    validateModelSelection(catalogue, {
      model: "deepseek/deepseek-v4-pro",
      reasoningEffort: "default",
    }),
  );
});

test("the existing Claude and Codex model ids still validate — no regression", () => {
  const catalogue = catalogueWith();
  for (const model of [
    "claude-subscription:sonnet",
    "claude-subscription:fable",
    "chatgpt:gpt-5.6-sol",
  ]) {
    assert.ok(validateModelSelection(catalogue, { model }), `${model} must remain valid`);
  }
  // Codex's fused `family[effort]` id validates on its base family.
  assert.ok(validateModelSelection(catalogue, { model: "chatgpt:gpt-5.6-sol[high]" }));
});

// ── The cold-cache rule ──────────────────────────────────────────────────────

test("COLD CACHE: an unrecognised id passes through rather than blocking the create", () => {
  // Only the harness-native rows are present — exactly what a box with no
  // fetched catalogue has. An id acpx cannot judge must not be refused.
  const coldCatalogue = buildCatalogue([], META);
  assert.equal(validateModelSelection(coldCatalogue, { model: "moonshotai/kimi-k3" }), null);
});

test("COLD CACHE: a slug acpx DOES know is still validated", () => {
  const coldCatalogue = buildCatalogue([], META);
  assert.throws(
    () => validateModelSelection(coldCatalogue, { model: "opus" }),
    ModelSlugError,
    "knowing less never means checking less about what IS known",
  );
});

test("validation is skipped for the raw --agent escape hatch and for unenumerated harnesses", async () => {
  // Neither of these may throw: acpx cannot judge a model id for a harness whose
  // catalogue it does not hold, and refusing on ignorance breaks a working create.
  await validateSessionModelFlags({
    agentName: "gemini",
    hasRawAgentOverride: false,
    model: "gemini-3-pro",
    reasoningEffort: undefined,
  });
  await validateSessionModelFlags({
    agentName: "claude",
    hasRawAgentOverride: true,
    model: "whatever-the-custom-server-takes",
    reasoningEffort: undefined,
  });
});

// ── The CLI itself, against the built artifact ───────────────────────────────

const CLI = path.resolve(process.cwd(), "dist/cli.js");

function runCli(args: string[], stateHome: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ACPX_STATE_HOME: stateHome },
    cwd: os.tmpdir(),
  });
}

function stateHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-models-cli-"));
  // Seed the catalogue cache so the CLI never depends on the network here.
  fs.mkdirSync(path.join(dir, ".acpx"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".acpx", "models-cache.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      models: [
        {
          id: "moonshotai/kimi-k3",
          name: "MoonshotAI: Kimi K3",
          supported_parameters: ["tools"],
          context_length: 1_048_576,
          pricing: { prompt: "0.000003", completion: "0.000015" },
          reasoning: { supported_efforts: ["low", "high", "max"], default_effort: "max" },
        },
      ],
    }),
  );
  return dir;
}

/**
 * THE NEGATIVE CONTROL. Before `acpx models` existed, this token fell through to
 * the AGENT registry: `acpx models list` printed "No acpx session found" (rc 4
 * in a session-free cwd) and in a session-bearing cwd would have been sent as a
 * PROMPT. An exit-code assertion alone would have passed against that. So every
 * check below asserts on CONTENT, and this string is the thing that must be
 * absent.
 */
const FELL_THROUGH_TO_AGENT = "No acpx session found";

test("CLI: `models` is reached as a real command, not as an agent name", () => {
  const home = stateHome();
  const result = runCli(["models"], home);
  assert.equal(result.stdout.includes(FELL_THROUGH_TO_AGENT), false, result.stdout);
  assert.equal(result.stderr.includes(FELL_THROUGH_TO_AGENT), false, result.stderr);
  assert.match(result.stdout, /MoonshotAI: Kimi K3/);
  assert.match(result.stdout, /selectable/);
});

test("CLI: every subcommand is reached, not just the bare noun", () => {
  const home = stateHome();
  for (const args of [
    ["models", "list"],
    ["models", "fav"],
    ["models", "last-used"],
  ]) {
    const result = runCli(args, home);
    assert.equal(
      (result.stdout + result.stderr).includes(FELL_THROUGH_TO_AGENT),
      false,
      `${args.join(" ")} fell through to the agent registry`,
    );
    assert.equal(result.status, 0, `${args.join(" ")} → ${result.stderr}`);
  }
  // And a WRITE verb, the one that would otherwise become a delivery.
  const write = runCli(["models", "fav", "add", "openrouter:moonshotai/kimi-k3"], stateHome());
  assert.match(write.stdout, /starred openrouter:moonshotai\/kimi-k3/);
});

test("CLI: a mistyped subverb fails LOUDLY with the valid set — it never becomes a prompt", () => {
  const result = runCli(["models", "last-usd", "set", "claude", "openrouter:a/x"], stateHome());
  assert.notEqual(result.status, 0);
  assert.equal((result.stdout + result.stderr).includes(FELL_THROUGH_TO_AGENT), false);
  assert.match(result.stderr, /too many arguments/);
  // The valid set is printed, so the typo is self-correcting.
  assert.match(result.stderr, /last-used/);
  assert.match(result.stderr, /fav/);
});

test("CLI: --json stdout is strictly parseable and stderr is clean", () => {
  const result = runCli(["models", "--json"], stateHome());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "", `stderr must stay machine-clean: ${result.stderr}`);
  const payload = JSON.parse(result.stdout) as ModelCatalogue;
  assert.ok(Array.isArray(payload.models));
  assert.ok(payload.models.some((model) => model.id === "moonshotai/kimi-k3"));
  // The envelope the acpx-ui lane reads.
  assert.equal(typeof payload.fetchedAt, "string");
  assert.equal(payload.counts.selectable + payload.counts.unavailable, payload.counts.total);
});

test("CLI: `models show` prints the model's LADDER and its DEFAULT (Daniel's requirement)", () => {
  const result = runCli(["models", "show", "moonshotai/kimi-k3"], stateHome());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /depths\s+low, high, max/);
  assert.match(result.stdout, /depth dflt\s+max/);
});

test("CLI: `models show` says something honest for a model with no ladder at all", () => {
  const result = runCli(["models", "show", "claude-subscription:opus"], stateHome());
  assert.match(result.stdout, /depths\s+low, medium, high, xhigh, max/);
  // A native ladder has no statically-known default; it says so instead of inventing one.
  assert.match(result.stdout, /depth dflt\s+the harness's own default/);
});

test("CLI: favorites round-trip through the store, and the star lands on the list", () => {
  const home = stateHome();
  assert.match(runCli(["models", "fav"], home).stdout, /No favorite models/);
  runCli(["models", "fav", "add", "openrouter:moonshotai/kimi-k3"], home);
  assert.match(runCli(["models", "fav"], home).stdout, /openrouter:moonshotai\/kimi-k3/);
  assert.match(runCli(["models"], home).stdout, /FAVORITES/);
  // Idempotent: starring twice is still one favorite.
  runCli(["models", "fav", "add", "openrouter:moonshotai/kimi-k3"], home);
  const favorites = runCli(["models", "fav", "--json"], home);
  assert.equal((JSON.parse(favorites.stdout) as { favorites: unknown[] }).favorites.length, 1);
  runCli(["models", "fav", "rm", "openrouter:moonshotai/kimi-k3"], home);
  assert.match(runCli(["models", "fav"], home).stdout, /No favorite models/);
});

test("CLI: `models fav add` on an ambiguous bare id exits 2 rather than guessing", () => {
  const result = runCli(["models", "fav", "add", "opus"], stateHome());
  assert.equal(result.status, 2);
  assert.match(result.stderr, /claude-subscription:opus/);
  assert.match(result.stderr, /claude-home:opus/);
});

test("CLI: `last-used` reads an EMPTY map without erroring, then round-trips a write", () => {
  const home = stateHome();
  const empty = runCli(["models", "last-used", "--json"], home);
  assert.equal(empty.status, 0);
  assert.deepEqual(JSON.parse(empty.stdout), { lastUsedModelKey: {}, entries: [] });

  runCli(["models", "last-used", "set", "claude", "openrouter:moonshotai/kimi-k3"], home);
  const after = runCli(["models", "last-used", "--json"], home);
  assert.deepEqual(
    (JSON.parse(after.stdout) as { lastUsedModelKey: Record<string, string> }).lastUsedModelKey,
    { claude: "openrouter:moonshotai/kimi-k3" },
  );

  // A malformed key fails loudly with the shape spelled out.
  const bad = runCli(["models", "last-used", "set", "claude", "kimi-k3"], home);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /<source>:<id>/);
});

test("CLI: the search flag uses the same matcher, and reports how many of how many", () => {
  const result = runCli(["models", "--search", "kimi"], stateHome());
  assert.match(result.stdout, /moonshotai\/kimi-k3/);
  assert.match(result.stdout, /1 of \d+/);
  const miss = runCli(["models", "--search", "zzzznotamodel"], stateHome());
  assert.match(miss.stdout, /No model matches/);
});

test("CLI: --format json is the long form of --json, on every verb that emits", () => {
  const home = stateHome();
  // Parity with the sibling `acpx agents` verb: "--json is shorthand for
  // --format json". A user who learns one verb has learned the other.
  const long = runCli(["models", "--format", "json"], home);
  const short = runCli(["models", "--json"], home);
  assert.equal(long.status, 0, long.stderr);
  const a = JSON.parse(long.stdout) as ModelCatalogue;
  const b = JSON.parse(short.stdout) as ModelCatalogue;
  assert.deepEqual(
    a.models.map((m) => m.key),
    b.models.map((m) => m.key),
  );

  assert.doesNotThrow(() =>
    JSON.parse(
      runCli(["models", "show", "openrouter:moonshotai/kimi-k3", "--format", "json"], home).stdout,
    ),
  );
  assert.doesNotThrow(() => JSON.parse(runCli(["models", "fav", "--format", "json"], home).stdout));
  assert.doesNotThrow(() =>
    JSON.parse(runCli(["models", "last-used", "--format", "json"], home).stdout),
  );

  // An unknown format fails loudly rather than silently falling back to text.
  const bad = runCli(["models", "--format", "yaml"], home);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Expected one of: text, json/);
});
