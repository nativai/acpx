import assert from "node:assert/strict";
import test from "node:test";
import { applyConfigOptionsToRecord } from "../src/session/config-options.js";
import { cloneSessionAcpxState } from "../src/session/conversation-model.js";
import {
  mergeLatestDurableAcpxPreferences,
  setDesiredModelId,
} from "../src/session/mode-preference.js";
import type { SessionAcpxState, SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// TE Finding #3 (the CLONE leg of the serialize/parse/clone triad, brick://07dd62c9):
// serialize=whole-object (fine), parse=fixed (F#1), but the field-by-field CLONE
// rebuild (cloneSessionAcpxState / cloneSessionOptions) never learned the new
// fields — so they were stripped on the clone path that runs on EVERY turn
// (savePromptSuccess re-merge) AND on sessions-new/reconnect (applyConfigOptionsTo-
// Record). These tests drive the REAL transformation functions (not direct floor-fn
// calls, which is why the class kept slipping past the gate).

function pinnedAcpx(): SessionAcpxState {
  return {
    current_model_id: "fable",
    session_options: {
      model: "fable",
      effort: "max",
      auto_failover: false,
      floor_hard: true,
      profile: "sub6",
    },
    desired_config_options: { effort: "max" },
    served: {
      model: "claude-sonnet-4-6",
      effort: "high",
      at: "2026-07-20T12:00:00.000Z",
      source: "claude-transcript",
    },
    served_below_floor: {
      served_model: "claude-sonnet-4-6",
      pinned_model: "fable",
      pinned_effort: "max",
      at: "2026-07-20T12:00:00.000Z",
    },
    floor_parked: {
      at: "2026-07-20T12:00:00.000Z",
      reason: "model-floor-unmet",
      observed_model: "claude-sonnet-4-6",
    },
  };
}

test("cloneSessionAcpxState preserves floor_hard + served + served_below_floor + floor_parked", () => {
  const cloned = cloneSessionAcpxState(pinnedAcpx());
  assert.equal(cloned?.session_options?.floor_hard, true);
  assert.equal(cloned?.session_options?.auto_failover, false); // control
  assert.equal(cloned?.served?.model, "claude-sonnet-4-6");
  assert.equal(cloned?.served?.effort, "high");
  assert.equal(cloned?.served_below_floor?.pinned_model, "fable");
  assert.equal(cloned?.floor_parked?.reason, "model-floor-unmet");
});

test("cloneSessionAcpxState DEEP-clones served/breadcrumbs (mutating the clone leaves the source intact)", () => {
  const source = pinnedAcpx();
  const cloned = cloneSessionAcpxState(source);
  // Mutate the clone's nested objects; the source must not change (no shared refs).
  cloned!.served!.model = "claude-fable-5";
  cloned!.floor_parked!.reason = "cleared";
  cloned!.session_options!.floor_hard = false;
  assert.equal(source.served?.model, "claude-sonnet-4-6");
  assert.equal(source.floor_parked?.reason, "model-floor-unmet");
  assert.equal(source.session_options?.floor_hard, true);
});

test("cloneSessionAcpxState does not fabricate the floor fields when absent (no undefined own-keys)", () => {
  const cloned = cloneSessionAcpxState({ session_options: { model: "fable" } });
  assert.equal(cloned?.served, undefined);
  assert.equal(cloned?.served_below_floor, undefined);
  assert.equal(cloned?.floor_parked, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(cloned?.session_options ?? {}, "floor_hard"));
});

test("applyConfigOptionsToRecord (sessions-new / reconnect / every-turn clone path) preserves floor_hard + served", () => {
  const record = makeSessionRecord({
    acpxRecordId: "apply-cfg-rec",
    acpSessionId: "apply-cfg-sid",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: pinnedAcpx(),
  });
  // Apply an advertised config-option set — this clones acpx via cloneSessionAcpxState.
  applyConfigOptionsToRecord(record, { configOptions: [] });
  assert.equal(record.acpx?.session_options?.floor_hard, true);
  assert.equal(record.acpx?.served?.model, "claude-sonnet-4-6");
  assert.equal(record.acpx?.served_below_floor?.pinned_model, "fable");
  assert.equal(record.acpx?.floor_parked?.reason, "model-floor-unmet");
  // config_options was applied (proves the clone path actually ran).
  assert.ok(Array.isArray(record.acpx?.config_options));
});

test("mergeLatestDurableAcpxPreferences (savePromptSuccess re-merge) preserves a just-stamped served + floor_hard", () => {
  // pending = the in-turn record that just got `served` stamped by captureServedState.
  const pending = pinnedAcpx();
  // latest = what is on disk (durable intent only; no served block).
  const latest: SessionAcpxState = {
    session_options: { model: "fable", effort: "max", auto_failover: false, floor_hard: true },
    desired_config_options: { effort: "max" },
  };
  const merged = mergeLatestDurableAcpxPreferences(pending, latest);
  // The runtime finally then CLONES the merge result — mirror that.
  const cloned = cloneSessionAcpxState(merged);
  assert.equal(cloned?.served?.model, "claude-sonnet-4-6");
  assert.equal(cloned?.floor_parked?.reason, "model-floor-unmet");
  assert.equal(cloned?.session_options?.floor_hard, true);
});

test("setDesiredModelId keeps floor_hard when the model is CLEARED (guard was model-only)", () => {
  const record: SessionRecord = makeSessionRecord({
    acpxRecordId: "set-model-rec",
    acpSessionId: "set-model-sid",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: { session_options: { floor_hard: true, auto_failover: false } },
  });
  // Clearing the model must NOT delete the whole session_options block.
  setDesiredModelId(record, undefined);
  assert.equal(record.acpx?.session_options?.floor_hard, true);
  assert.equal(record.acpx?.session_options?.auto_failover, false);
});
