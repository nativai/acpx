import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalogue } from "../src/models/catalogue.js";
import type { ModelCatalogue } from "../src/models/types.js";
import { resolveSessionModelLadder } from "../src/session/model-ladder.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// ─── Provenance ───────────────────────────────────────────────────────────────
//
// The OpenRouter `reasoning` shapes below are copied VERBATIM from this box's
// real, warm `~/.acpx/models-cache.json` (fetchedAt 2026-09-17T14:28:40.716Z),
// not invented — same discipline `models-command.test.ts`'s own fixtures
// already use (its `deepseek/deepseek-v4-pro` row is the identical real shape).
// The claude/codex native rows are NEVER faked here: `buildCatalogue`'s default
// `nativeModels` is `harnessNativeModels()`, acpx's OWN production ladder table
// (`claudeEffortCeiling`/`codexEffortCeiling`) — so the sonnet-caps-at-"high"
// assertion below is exercising real production logic, not a test's opinion of
// it.
const META = { fetchedAt: "2026-09-17T14:28:40.716Z", stale: false, error: null };

function realCatalogue(): ModelCatalogue {
  return buildCatalogue(
    [
      // z-ai/glm-5.3-flash — real ladder (measured live, 2026-09-17).
      {
        id: "z-ai/glm-5.3-flash",
        name: "Z.AI: GLM 5.3 Flash",
        supported_parameters: ["tools"],
        reasoning: {
          mandatory: true,
          default_enabled: true,
          supported_efforts: ["max", "high", "low"],
          default_effort: "max",
        },
      },
      // moonshotai/kimi-k2.6 — a REAL, MEASURED gap: `reasoning` is present but
      // carries no `supported_efforts` at all, so this row is `kind: "boolean"`,
      // not a ladder — even though this exact model was a live pi session's
      // pinned model on 2026-09-08 with a depth_projection ladder of 5 rungs
      // (from pi's OWN live capability advertisement, a different, non-static
      // source `model-ladder.ts` deliberately does not consult). This is the
      // measured limitation the brief's report flags: the catalogue-ceiling can
      // legitimately disagree with a specific harness's live advertisement for
      // the same model, and this module reports "no ladder" honestly rather
      // than inventing one.
      {
        id: "moonshotai/kimi-k2.6",
        name: "MoonshotAI: Kimi K2.6",
        supported_parameters: ["tools"],
        reasoning: { mandatory: false, default_enabled: true },
      },
      {
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek: DeepSeek V4 Pro",
        supported_parameters: ["tools"],
        reasoning: {
          mandatory: false,
          supported_efforts: ["xhigh", "high"],
          default_effort: "high",
        },
      },
    ],
    META,
  );
}

function record(agentCommand: string, model: string): ReturnType<typeof makeSessionRecord> {
  return makeSessionRecord({
    acpxRecordId: `rec-${model}`,
    acpSessionId: `sid-${model}`,
    agentCommand,
    cwd: "/workspace/projects/temp/te-ladder",
    acpx: { session_options: { model } },
  });
}

const withRealCatalogue = { loadCatalogue: () => Promise.resolve(realCatalogue()) };

test("a claude session pinned to a bare alias reports the model's REAL ceiling, not the generic union", async () => {
  // The parent session's own live finding: claude-subscription:sonnet's
  // config_options advertises [default,low,medium,high,xhigh,max] (the generic
  // union) but sonnet's actual catalogue row caps at "high" — verified live via
  // `acpx models show claude-subscription:sonnet --json`.
  const rec = record("node /opt/claude-agent-acp/dist/index.js", "sonnet");
  const ladder = await resolveSessionModelLadder(rec, withRealCatalogue);
  assert.deepEqual(ladder.levels, ["low", "medium", "high"]);
  assert.equal(ladder.note, null);
});

test("a claude session pinned to opus/fable reaches the top rung (max)", async () => {
  const rec = record("node /opt/claude-agent-acp/dist/index.js", "opus");
  const ladder = await resolveSessionModelLadder(rec, withRealCatalogue);
  assert.deepEqual(ladder.levels, ["low", "medium", "high", "xhigh", "max"]);
});

test("a codex session pinned to a bracketed model id resolves the bare family's ceiling", async () => {
  const rec = record("node /opt/codex-acp/dist/index.js", "gpt-5.5[xhigh]");
  rec.acpx = {
    ...rec.acpx,
    current_model_id: "gpt-5.5[xhigh]",
    available_models: ["gpt-5.5[low]", "gpt-5.5[medium]", "gpt-5.5[high]", "gpt-5.5[xhigh]"],
  };
  const ladder = await resolveSessionModelLadder(rec, withRealCatalogue);
  assert.deepEqual(ladder.levels, ["low", "medium", "high", "xhigh"]);
});

test("a pi session pinned to an OpenRouter model WITH a real ladder resolves it", async () => {
  const rec = record("npx pi-acp@0.0.33", "openrouter/z-ai/glm-5.3-flash");
  const ladder = await resolveSessionModelLadder(rec, withRealCatalogue);
  assert.deepEqual(ladder.levels, ["low", "high", "max"]);
});

test("a pi session pinned to an OpenRouter model whose catalogue entry has NO ladder is honestly unresolved", async () => {
  // The measured gap documented above: kimi-k2.6's `reasoning` has no
  // `supported_efforts`, so this must report "no ladder", never guess one from
  // pi's separate depth_projection.
  const rec = record("npx pi-acp@0.0.33", "openrouter/moonshotai/kimi-k2.6");
  const ladder = await resolveSessionModelLadder(rec, withRealCatalogue);
  assert.equal(ladder.levels, null);
  assert.match(ladder.note ?? "", /no depth ladder/);
});

test("an unpinned session (no session_options.model) reports no ceiling, never a guess", async () => {
  const rec = makeSessionRecord({
    acpxRecordId: "rec-unpinned",
    acpSessionId: "sid-unpinned",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace/projects/temp/te-ladder",
    acpx: {},
  });
  const ladder = await resolveSessionModelLadder(rec, withRealCatalogue);
  assert.equal(ladder.levels, null);
  assert.equal(ladder.note, "no pinned model");
});

test("opencode (an agent command acpx does not classify at all) is reported as unmeasured, not guessed", async () => {
  const rec = record("npx -y opencode-ai@1.18.28 acp", "openrouter/z-ai/glm-5.3-flash");
  const ladder = await resolveSessionModelLadder(rec, withRealCatalogue);
  assert.equal(ladder.levels, null);
  assert.match(ladder.note ?? "", /harness not classified/);
});

test("a cold catalogue cache (no OpenRouter rows loaded at all) is reported distinctly from an unmeasured harness", async () => {
  const rec = record("node /opt/claude-agent-acp/dist/index.js", "sonnet");
  const cold = { loadCatalogue: () => Promise.resolve(buildCatalogue([], META)) };
  const ladder = await resolveSessionModelLadder(rec, cold);
  assert.equal(ladder.levels, null);
  assert.equal(ladder.note, "model catalogue cache is cold");
});
