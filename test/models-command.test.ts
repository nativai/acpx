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

/**
 * ⚠️ AMBIGUITY IS ABOUT THE BILL. The case D2 protects against is the same
 * weights reached through two doors that cost DIFFERENT money — `opus` on plan
 * versus metered on OpenRouter. Two rows of the same billing kind are NOT that
 * case, and treating them as one was a measured regression (see the next test).
 */
test("SHAPE 2 — an id served on plan AND metered exits USAGE listing both, guessing neither", () => {
  const catalogue = buildCatalogue(
    [
      {
        id: "opus",
        name: "Opus, metered",
        supported_parameters: ["tools"],
        pricing: { prompt: "0.000005", completion: "0.000025" },
      },
    ],
    META,
  );
  const error = caught(() => validateModelSelection(catalogue, { model: "opus" }));
  assert.equal(error.outputCode, "USAGE");
  assert.equal(error.detailCode, "MODEL_SLUG_AMBIGUOUS");
  assert.match(error.message, /claude-subscription:opus/);
  assert.match(error.message, /openrouter:opus/);
  // Both bills are shown, so the caller can see what the choice costs.
  assert.match(error.message, /on plan/);
  assert.match(error.message, /\$5 \/ \$25/);
  // It refuses to guess rather than picking the cheaper or the first.
  assert.doesNotMatch(error.message, /using claude-subscription/);
});

/**
 * REGRESSION GUARD — measured 2026-09-04T00:27Z against the deployed CLI.
 * `acpx claude sessions new --model sonnet` works today. `sonnet` is a row under
 * BOTH claude-subscription and claude-home, so a naive "more than one source ⇒
 * ambiguous" rule exited 2 on it. Those two are the same plan class reached
 * through a different credential, and the credential is what --profile /
 * --subscription select; --model has never meant a source.
 */
test("a bare native alias on its own agent is NOT ambiguous — the deployed CLI accepts it", () => {
  const catalogue = catalogueWith();
  for (const model of ["sonnet", "opus", "haiku", "fable", "default"]) {
    const resolved = validateModelSelection(catalogue, { model, agentName: "claude" });
    assert.ok(resolved, `--model ${model} must not be refused for a claude session`);
    assert.equal(resolved.id, model);
  }
  // And the agent type is what excludes another harness's rows from the question.
  assert.equal(
    validateModelSelection(catalogue, { model: "opus", agentName: "claude" })?.source,
    "claude-subscription",
  );
  assert.equal(
    validateModelSelection(catalogue, { model: "opus", agentName: "claude-pty" })?.source,
    "claude-pty",
  );
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

// ── The two AVAILABILITY shapes (S2) ─────────────────────────────────────────
//
// Every case below was a MEASURED pass-then-fail-downstream at a5ba50fe
// (brick://db554b05 `reports/MEASUREMENT.md`). The point of these shapes is not
// that acpx refuses more — the create already failed — but that the refusal
// moves from the adapter, where on claude it surfaces as an unclassified
// `-32603 Internal error`, to the CLI boundary, where it says what to do next.

test("SHAPE 4 — an id that belongs to ANOTHER harness is not an unknown slug", () => {
  // MEASURED P3: `acpx --model gpt-5.6-luna claude sessions new` was ACCEPTED by
  // validation and then died in claude-agent-acp 0.39.0.
  const error = caught(() =>
    validateModelSelection(catalogueWith(), { model: "gpt-5.6-luna", agentName: "claude" }),
  );
  assert.equal(error.outputCode, "USAGE"); // → exit 2
  assert.equal(error.detailCode, "MODEL_NOT_REACHABLE_FROM_AGENT");
  // It must NOT claim the slug is absent — that is the lie shape 1 would tell.
  assert.doesNotMatch(error.message, /not in this box's model catalogue/);
  assert.match(error.message, /belongs to: codex/);
  assert.match(error.message, /acpx models --agent claude/);
});

test("SHAPE 4 — and the same in the other direction, which is what the deleted fallback hid", () => {
  // MEASURED C2: `--model sonnet` was accepted on a CODEX session. The old
  // `reachable.length > 0 ? reachable : byId` re-admitted exactly this.
  const error = caught(() =>
    validateModelSelection(catalogueWith(), { model: "sonnet", agentName: "codex" }),
  );
  assert.equal(error.detailCode, "MODEL_NOT_REACHABLE_FROM_AGENT");
  assert.match(error.message, /belongs to: claude/);
});

test("SHAPE 5 — an OpenRouter row is refused for an agent that cannot take an arbitrary id", () => {
  // MEASURED P1: `--model z-ai/glm-5.3` on claude reached the adapter and came
  // back as `-32603 Internal error`, "not a recognized model id. Run /model…".
  const error = caught(() =>
    validateModelSelection(catalogueWith(), {
      model: "moonshotai/kimi-k3",
      agentName: "claude",
    }),
  );
  assert.equal(error.outputCode, "USAGE");
  assert.equal(error.detailCode, "MODEL_NOT_AVAILABLE_FOR_AGENT");
  assert.match(error.message, /arbitrary model id/);
  assert.match(error.message, /acpx models --agent claude/);
});

test("SHAPE 5 — a row the CATALOGUE blocks is refused with the catalogue's own reason", () => {
  // MEASURED P4: a `:batch` row passed validation, because nothing read
  // `selectable`. `acpx models` had been annotating it "a session cannot stream
  // from it" the whole time.
  const catalogue = buildCatalogue(
    [{ id: "vendor/m:batch", name: "Batch M", supported_parameters: ["tools"] }],
    META,
  );
  const error = caught(() =>
    validateModelSelection(catalogue, { model: "vendor/m:batch", agentName: "claude" }),
  );
  assert.equal(error.detailCode, "MODEL_NOT_SELECTABLE");
  assert.match(error.message, /a session cannot stream from it/);
});

test("SHAPE 5 — the selectability check does NOT depend on a capability table", () => {
  // The ordering inside assertModelAvailable is the subject. With an empty
  // table every `availability` map is `{}`, so the per-agent check stands aside
  // — and a batch endpoint must STILL be refused, because selectability is a
  // catalogue fact that never goes missing.
  const catalogue = buildCatalogue(
    [{ id: "vendor/m:batch", name: "Batch M", supported_parameters: ["tools"] }],
    META,
    { capabilities: [] },
  );
  const error = caught(() =>
    validateModelSelection(catalogue, { model: "vendor/m:batch", agentName: "claude" }),
  );
  assert.equal(error.detailCode, "MODEL_NOT_SELECTABLE");
});

test("ABSENCE OF A TABLE IS NOT UNAVAILABILITY — an OpenRouter row still passes", () => {
  // The guardrail on shape 5, and the reason it is `undefined`-tolerant: with no
  // capability table acpx cannot answer the per-agent question, and refusing on
  // ignorance would block creates that work today. Same rule
  // `isAvailableForAgent` follows.
  const catalogue = buildCatalogue(
    [{ id: "vendor/ok", name: "OK", supported_parameters: ["tools"] }],
    META,
    { capabilities: [] },
  );
  const resolved = validateModelSelection(catalogue, {
    model: "vendor/ok",
    agentName: "claude",
  });
  assert.equal(resolved?.key, "openrouter:vendor/ok");
});

test("S2 GUARDRAIL — every native alias a claude session really serves still validates", () => {
  // The six ids claude-agent-acp 0.39.0 advertised on the MEASURED probe
  // session, minus the bracket form parseModelRef strips. If S2 ever refuses one
  // of these it has broken the only class of create that works today.
  const catalogue = catalogueWith();
  for (const model of ["default", "opus", "opus[1m]", "sonnet", "haiku", "fable"]) {
    assert.ok(
      validateModelSelection(catalogue, { model, agentName: "claude" }),
      `--model ${model} must still validate for a claude session`,
    );
  }
  // And codex's own families stay reachable from codex.
  assert.ok(validateModelSelection(catalogue, { model: "gpt-5.6-sol", agentName: "codex" }));
  assert.ok(validateModelSelection(catalogue, { model: "gpt-5.6-sol[high]", agentName: "codex" }));
});

// ── The cold-cache rule ──────────────────────────────────────────────────────

test("COLD CACHE: an unrecognised id passes through rather than blocking the create", () => {
  // Only the harness-native rows are present — exactly what a box with no
  // fetched catalogue has. An id acpx cannot judge must not be refused.
  const coldCatalogue = buildCatalogue([], META);
  assert.equal(validateModelSelection(coldCatalogue, { model: "moonshotai/kimi-k3" }), null);
});

test("COLD CACHE: a slug acpx DOES know is still validated", () => {
  // Knowing less never means checking less about what IS known: with only the
  // native rows loaded, an effort outside a native ladder is still refused.
  const coldCatalogue = buildCatalogue([], META);
  const error = caught(() =>
    validateModelSelection(coldCatalogue, {
      model: "sonnet",
      reasoningEffort: "max",
      agentName: "claude",
    }),
  );
  assert.equal(error.detailCode, "MODEL_EFFORT_OUT_OF_LADDER");
  assert.match(error.message, /low, medium, high/);
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

test("CLI: a search NAMES a model, so an unavailable match is shown with its reason", () => {
  // C5 D4: silently dropping a model the user typed the exact name of teaches
  // them the picker is broken. `--all` governs the unsearched list, not this.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-models-cli-"));
  fs.mkdirSync(path.join(home, ".acpx"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".acpx", "models-cache.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      models: [
        { id: "vendor/only-batch:batch", name: "Only Batch", supported_parameters: ["tools"] },
      ],
    }),
  );
  const result = runCli(["models", "--search", "only-batch"], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /only-batch/);
  assert.match(result.stdout, /batch endpoint/);
  assert.doesNotMatch(result.stdout, /No model matches/);

  // The unsearched list still hides it by default, and --all reveals it.
  assert.doesNotMatch(runCli(["models"], home).stdout, /only-batch/);
  assert.match(runCli(["models", "--all"], home).stdout, /only-batch/);
});

/**
 * ⚠️ THE ONLY CASE D2 ACTUALLY CARES ABOUT, AND IT IS UNREACHABLE ON THE LIVE
 * ROSTER — SO IT IS CONSTRUCTED HERE.
 *
 * Native ids are bare (`opus`, `sonnet`); OpenRouter ids are namespaced
 * (`anthropic/claude-opus-5`), so no id collides across a billing-kind boundary
 * on today's catalogue. An error shape with no test that can reach it is not
 * shipped, it is hoped for — so this pins the plan-versus-metered refusal by
 * pointing ACPX_MODELS_CACHE at a hand-written roster carrying a metered row
 * whose id is exactly `opus`.
 */
test("CLI: a metered OpenRouter row colliding with a plan id refuses, showing both bills", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-models-cli-"));
  fs.mkdirSync(path.join(home, ".acpx"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".acpx", "models-cache.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      models: [
        {
          id: "opus",
          name: "Opus, metered through OpenRouter",
          supported_parameters: ["tools"],
          pricing: { prompt: "0.000005", completion: "0.000025" },
        },
      ],
    }),
  );

  // The create path: the same weights through two doors that cost different
  // money, so acpx refuses rather than picking one.
  const create = spawnSync(
    process.execPath,
    [CLI, "--cwd", home, "--model", "opus", "claude", "sessions", "new", "--name", "probe"],
    { encoding: "utf8", env: { ...process.env, ACPX_STATE_HOME: home }, cwd: os.tmpdir() },
  );
  assert.equal(create.status, 2, `expected USAGE(2), got ${create.status}: ${create.stderr}`);
  assert.match(create.stderr, /claude-subscription:opus/);
  assert.match(create.stderr, /openrouter:opus/);
  assert.match(create.stderr, /on plan/);
  assert.match(create.stderr, /\$5 \/ \$25/);
  // No session was created, and nothing guessed on the caller's behalf.
  assert.doesNotMatch(create.stderr, /using claude-subscription/);

  // And with the same roster, a NON-colliding native alias still creates — the
  // refusal is scoped to the collision, not to bare ids in general.
  const sonnet = runCli(["models", "show", "claude-subscription:sonnet"], home);
  assert.equal(sonnet.status, 0, sonnet.stderr);
});

/**
 * The box label is USER-VISIBLE and must be STABLE. On a dev box `os.hostname()`
 * is the ephemeral pod name — it changes on every pod restart, and a favorites
 * line stamped with it reads as "my favorites moved" after an event that changed
 * nothing. The repo already ruled on this at
 * `src/session/persistence/deletion-manifest.ts:260` ("acpx calls os.hostname()
 * nowhere in src/, which is itself the tell").
 */
test("CLI: the box label is the stable acpx-ui host, never the ephemeral pod hostname", () => {
  const home = stateHome();
  const podHostname = os.hostname();
  const lines = [
    runCli(["models", "fav"], home).stdout,
    runCli(["models", "last-used"], home).stdout,
    runCli(["models", "fav", "add", "openrouter:moonshotai/kimi-k3"], home).stdout,
  ];
  for (const line of lines) {
    assert.doesNotMatch(line, new RegExp(podHostname), `leaked the pod hostname: ${line}`);
    assert.match(line, /acpx\./, `expected a stable acpx-ui host, got: ${line}`);
  }

  // And the resolver is honoured, so the label follows the BOX rather than the
  // pod. A fresh state home, because the label only appears in the empty state.
  const overridden = spawnSync(process.execPath, [CLI, "models", "fav"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ACPX_STATE_HOME: stateHome(),
      ACPX_UI_BASE_URL: "https://acpx.konsiq.example",
    },
    cwd: os.tmpdir(),
  });
  assert.match(overridden.stdout, /acpx\.konsiq\.example/);
});

test("CLI: `models show` reports an unstated boolean default as unstated, not as off", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acpx-models-cli-"));
  fs.mkdirSync(path.join(home, ".acpx"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".acpx", "models-cache.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      models: [
        // Exactly the shape 109 live rows have: a reasoning object, no ladder,
        // and NO default_enabled.
        { id: "vendor/silent", name: "Silent", supported_parameters: ["tools"], reasoning: {} },
      ],
    }),
  );
  const show = runCli(["models", "show", "openrouter:vendor/silent"], home);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /on\/off only/);
  assert.match(show.stdout, /not stated upstream/);
  assert.doesNotMatch(show.stdout, /depth dflt {2}off/);

  const payload = JSON.parse(runCli(["models", "--json"], home).stdout) as ModelCatalogue;
  const silent = payload.models.find((model) => model.id === "vendor/silent");
  assert.equal(silent?.depth.kind === "boolean" ? silent.depth.defaultEnabled : "wrong", null);
});
