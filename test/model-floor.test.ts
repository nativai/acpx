import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { transcriptCwdHash } from "../src/config/subscription-transcript.js";
import {
  belowFloorEpisodeOpen,
  captureServedState,
  clearFloorBreadcrumbs,
  deriveServedEffort,
  evaluateModelFloor,
  floorHardEnabled,
  modelFamily,
  pinnedEffortFloor,
  pinnedModelFloor,
  readLastServedModel,
  servedModelMatchesFloor,
  setFloorParked,
  setServedState,
  stampServedBelowFloor,
} from "../src/session/model-floor.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome } from "./runtime-test-helpers.js";

// ─── modelFamily / servedModelMatchesFloor ──────────────────────────────────

test("modelFamily normalizes aliases and full ids to a family token", () => {
  assert.equal(modelFamily("fable"), "fable");
  assert.equal(modelFamily("claude-fable-5"), "fable");
  assert.equal(modelFamily("opus"), "opus");
  assert.equal(modelFamily("claude-opus-4-8"), "opus");
  assert.equal(modelFamily("sonnet[1m]"), "sonnet"); // context hint stripped
  assert.equal(modelFamily("claude-sonnet-4-6"), "sonnet");
  assert.equal(modelFamily("haiku"), "haiku");
  assert.equal(modelFamily("some-unknown-model"), "some-unknown-model");
  assert.equal(modelFamily(undefined), undefined);
  assert.equal(modelFamily(""), undefined);
});

test("servedModelMatchesFloor matches by family (alias vs full id)", () => {
  assert.equal(servedModelMatchesFloor("fable", "claude-fable-5"), true);
  assert.equal(servedModelMatchesFloor("opus", "claude-opus-4-8"), true);
  assert.equal(servedModelMatchesFloor("fable", "claude-sonnet-4-6"), false);
  assert.equal(servedModelMatchesFloor("fable", undefined), false);
  assert.equal(servedModelMatchesFloor(undefined, "claude-fable-5"), false);
});

// ─── evaluateModelFloor ─────────────────────────────────────────────────────

test("evaluateModelFloor: same family is at-floor", () => {
  const e = evaluateModelFloor({
    pinnedModel: "fable",
    pinnedEffort: "max",
    servedModel: "claude-fable-5",
  });
  assert.equal(e.status, "at-floor");
});

test("evaluateModelFloor: model downgrade is below-floor (reason model), the incident case", () => {
  const e = evaluateModelFloor({
    pinnedModel: "fable",
    pinnedEffort: "max",
    servedModel: "claude-sonnet-4-6",
  });
  assert.equal(e.status, "below-floor");
  assert.equal(e.reason, "model");
});

test("evaluateModelFloor: same model, served effort below pin is below-floor (reason effort)", () => {
  const e = evaluateModelFloor({
    pinnedModel: "opus",
    pinnedEffort: "max",
    servedModel: "claude-opus-4-8",
    servedEffort: "high",
  });
  assert.equal(e.status, "below-floor");
  assert.equal(e.reason, "effort");
});

test("evaluateModelFloor: unreadable served model is unknown (never a false below-floor)", () => {
  const e = evaluateModelFloor({ pinnedModel: "fable", servedModel: undefined });
  assert.equal(e.status, "unknown");
});

test("evaluateModelFloor: a MORE expensive off-pin serve is flagged below-floor, not silently accepted", () => {
  // This case was previously named "a theoretical NOT-LOWER family (never
  // happens — harness only downgrades)". It happens: live acpx session record
  // b80f2910 (2026-09-01) was pinned `sonnet` and served `claude-fable-5-1`,
  // and got filed as below-floor. So `below-floor` means "off pin", direction
  // unknown — acpx has no capability rank and cannot claim a direction.
  // The ASSERTION is unchanged and deliberate (brick 8a54201e): flagging an
  // off-pin serve is safer than silently accepting a session being served the
  // most expensive model it never asked for.
  const e = evaluateModelFloor({ pinnedModel: "sonnet", servedModel: "claude-opus-4-8" });
  assert.equal(e.status, "below-floor");
  assert.equal(e.reason, "model");
});

// ─── deriveServedEffort (effort follows model) ──────────────────────────────

test("deriveServedEffort: max pin authored down to high under sonnet; unchanged under fable", () => {
  assert.equal(deriveServedEffort("max", "claude-sonnet-4-6"), "high");
  assert.equal(deriveServedEffort("max", "claude-fable-5"), "max");
  assert.equal(deriveServedEffort(undefined, "claude-sonnet-4-6"), undefined);
});

// ─── record accessors ───────────────────────────────────────────────────────

test("pinned/floor-hard accessors read session_options", () => {
  const record = makeSessionRecord({
    acpxRecordId: "r",
    acpSessionId: "s",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: {
      session_options: { model: "fable", effort: "max", floor_hard: true },
      desired_config_options: { effort: "max" },
    },
  });
  assert.equal(pinnedModelFloor(record), "fable");
  assert.equal(pinnedEffortFloor(record), "max");
  assert.equal(floorHardEnabled(record), true);
});

test("floorHardEnabled false when absent", () => {
  const record = makeSessionRecord({
    acpxRecordId: "r",
    acpSessionId: "s",
    agentCommand: "codex --acp",
    cwd: "/workspace",
    acpx: { session_options: { model: "fable" } },
  });
  assert.equal(floorHardEnabled(record), false);
  assert.equal(pinnedEffortFloor(record), undefined);
});

// ─── stamping helpers ───────────────────────────────────────────────────────

test("setServedState stamps the served block without touching the pin", () => {
  const record = baseRecord();
  setServedState(record, {
    model: "claude-sonnet-4-6",
    effort: "high",
    source: "claude-transcript",
  });
  assert.equal(record.acpx?.served?.model, "claude-sonnet-4-6");
  assert.equal(record.acpx?.served?.effort, "high");
  assert.ok(record.acpx?.served?.at);
  // Pin untouched.
  assert.equal(record.acpx?.session_options?.model, "fable");
});

test("stampServedBelowFloor / belowFloorEpisodeOpen / clearFloorBreadcrumbs", () => {
  const record = baseRecord();
  assert.equal(belowFloorEpisodeOpen(record), false);
  stampServedBelowFloor(record, {
    status: "below-floor",
    reason: "model",
    pinnedModel: "fable",
    pinnedEffort: "max",
    servedModel: "claude-sonnet-4-6",
    servedEffort: "high",
  });
  assert.equal(belowFloorEpisodeOpen(record), true);
  assert.equal(record.acpx?.served_below_floor?.served_model, "claude-sonnet-4-6");
  setFloorParked(record, "claude-sonnet-4-6");
  assert.equal(record.acpx?.floor_parked?.observed_model, "claude-sonnet-4-6");
  // clearFloorBreadcrumbs reports it cleared a live episode.
  assert.equal(clearFloorBreadcrumbs(record), true);
  assert.equal(record.acpx?.served_below_floor, undefined);
  assert.equal(record.acpx?.floor_parked, undefined);
  // Idempotent: nothing left to clear.
  assert.equal(clearFloorBreadcrumbs(record), false);
});

// ─── readLastServedModel (real transcript tail) ─────────────────────────────

test("readLastServedModel returns the LAST assistant.message.model from the transcript", async () => {
  await withTempHome("acpx-floor-", async (home) => {
    const record = claudeRecord();
    await writeTranscript(home, record, [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "assistant", message: { role: "assistant", model: "claude-fable-5", content: [] } },
      { type: "user", message: { role: "user", content: "again" } },
      {
        type: "assistant",
        message: { role: "assistant", model: "claude-sonnet-4-6", content: [] },
      },
    ]);
    assert.equal(await readLastServedModel(record), "claude-sonnet-4-6");
  });
});

test("readLastServedModel is a no-op for a non-Claude adapter", async () => {
  await withTempHome("acpx-floor-", async (home) => {
    const record = makeSessionRecord({
      acpxRecordId: "codex-rec",
      acpSessionId: "codex-sid",
      agentCommand: "codex --acp",
      cwd: "/workspace",
    });
    // Even if a transcript existed, a codex agentCommand short-circuits.
    await writeTranscript(home, record, [
      { type: "assistant", message: { role: "assistant", model: "gpt-x", content: [] } },
    ]);
    assert.equal(await readLastServedModel(record), undefined);
  });
});

test("readLastServedModel returns undefined when the transcript is absent", async () => {
  await withTempHome("acpx-floor-", async () => {
    assert.equal(await readLastServedModel(claudeRecord()), undefined);
  });
});

test("captureServedState stamps served model + derived effort from the transcript", async () => {
  await withTempHome("acpx-floor-", async (home) => {
    const record = claudeRecord();
    await writeTranscript(home, record, [
      {
        type: "assistant",
        message: { role: "assistant", model: "claude-sonnet-4-6", content: [] },
      },
    ]);
    const served = await captureServedState(record);
    assert.equal(served, "claude-sonnet-4-6");
    assert.equal(record.acpx?.served?.model, "claude-sonnet-4-6");
    // pinned max authored down to high under the served sonnet.
    assert.equal(record.acpx?.served?.effort, "high");
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function baseRecord(): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "r",
    acpSessionId: "s",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: {
      session_options: { model: "fable", effort: "max" },
      desired_config_options: { effort: "max" },
    },
  });
}

function claudeRecord(): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "claude-rec",
    acpSessionId: "claude-sid-abc",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace/proj",
    acpx: {
      session_options: { model: "fable", effort: "max" },
      desired_config_options: { effort: "max" },
    },
  });
}

async function writeTranscript(
  home: string,
  record: SessionRecord,
  entries: unknown[],
): Promise<void> {
  // rawClaudeConfigDir(home) = <home>/.claude ; layout projects/<cwdHash>/<acpSessionId>.jsonl
  const dir = path.join(home, ".claude", "projects", transcriptCwdHash(record.cwd));
  await fs.mkdir(dir, { recursive: true });
  const jsonl = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await fs.writeFile(path.join(dir, `${record.acpSessionId}.jsonl`), jsonl, "utf8");
}
