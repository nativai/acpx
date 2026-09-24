import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { harnessIdForAgentCommand } from "../src/acp/harness-capabilities.js";
import {
  resolveGenericEffortLadder,
  resolveReasoningEffort,
  resolveServedAndFloor,
  statusAcpxFields,
} from "../src/cli/status-command.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

/** A minimal, valid `select` config option — real records always carry `name`
 *  and `options`; only the fields the derivation under test reads vary here. */
function selectOption(params: {
  id: string;
  category?: string;
  currentValue: string;
  values?: string[];
}): SessionConfigOption {
  return {
    id: params.id,
    name: params.id,
    category: params.category,
    type: "select",
    currentValue: params.currentValue,
    options: (params.values ?? []).map((value) => ({ name: value, value })),
  };
}

// ─── Provenance ───────────────────────────────────────────────────────────────
//
// Every `acpx` block below is copied VERBATIM (session_options,
// current_model_id, desired_config_options, config_options, depth_projection,
// served) from a REAL session record on this box's live store
// (~/.acpx/sessions/*.json), sampled 2026-09-17 — per this project's own house
// rule against synthetic agent-command/session-record fixtures
// (Projects/acpx/PROJECT.md's NUL-byte/adapter-keyed-predicate note). Record
// ids are named in each test so they can be re-found later if closed.

function record(overrides: {
  acpxRecordId: string;
  agentCommand: string;
  acpx: NonNullable<SessionRecord["acpx"]>;
}): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: overrides.acpxRecordId,
    acpSessionId: `sid-${overrides.acpxRecordId}`,
    agentCommand: overrides.agentCommand,
    cwd: "/workspace/projects/temp/te-status-effort",
    acpx: overrides.acpx,
  });
}

// ─── reasoningEffort — per-harness derivation (item 1) ───────────────────────

test("pi record 01a08176-40fa (requested xhigh, projected to medium) reports the SERVED effort, not the request", () => {
  const rec = record({
    acpxRecordId: "01a08176-40fa-7f43-acac-61eb38012da6",
    agentCommand: "node /opt/pi-acp/dist/index.js",
    acpx: {
      session_options: {
        model: "openrouter/moonshotai/kimi-k2.6",
        effort: "xhigh",
        model_source: "explicit",
      },
      current_model_id: "openrouter/moonshotai/kimi-k2.6",
      desired_config_options: { effort: "xhigh" },
      depth_projection: {
        requested: "xhigh",
        outcome: "projected",
        served: "medium",
        reason:
          '"xhigh" is not on this model\'s ladder (off, minimal, low, medium, high) — projected by position to "medium"',
      },
      served: { effort: "medium", at: "2026-09-08T14:40:07.742Z", source: "depth-projection" },
    },
  });
  const harness = harnessIdForAgentCommand(rec.agentCommand);
  assert.equal(harness, "pi");
  assert.equal(resolveReasoningEffort(rec, harness), "medium");
});

test("codex record 019edbeb-53e3 (bracketed model id, no desired_config_options) reports the bracket effort", () => {
  const rec = record({
    acpxRecordId: "019edbeb-53e3-7a83-a3d0-ab305b914d2a",
    agentCommand: "node /opt/codex-acp/dist/index.js",
    acpx: {
      session_options: { model: "gpt-5.5[xhigh]" },
      current_model_id: "gpt-5.5[xhigh]",
    },
  });
  const harness = harnessIdForAgentCommand(rec.agentCommand);
  assert.equal(harness, "codex");
  // Before this brief: statusAcpxFields's old `desiredEffort` read
  // `desired_config_options.effort`, which is `null` on every codex record —
  // reproducing the conception's own measured defect (`reasoningEffort: "-"`).
  assert.equal(resolveReasoningEffort(rec, harness), "xhigh");
});

test("claude-pty record 407c1e4d falls through the removed capability descriptor", () => {
  const rec = record({
    acpxRecordId: "407c1e4d-5104-48eb-b497-c103b8cebb69",
    agentCommand: "node /opt/claude-pty-acp/dist/index.js",
    acpx: {
      session_options: { model: "opus", profile: "bridge2", effort: "max" },
      current_model_id: "opus",
      desired_config_options: { effort: "max" },
      config_options: [
        selectOption({ id: "effort", category: "thought_level", currentValue: "high" }),
      ],
    },
  });
  const harness = harnessIdForAgentCommand(rec.agentCommand);
  assert.equal(harness, undefined);
  assert.equal(resolveReasoningEffort(rec, harness), "max");
});

test("opencode record ses_f8409620 (an unmeasured harness) reports null, matching acpx-ui's explicit undefined for it", () => {
  const rec = record({
    acpxRecordId: "ses_f8409620effesINUtucxrQwXM0",
    agentCommand: "npx -y opencode-ai@1.18.28 acp",
    acpx: {
      session_options: { model: "openrouter/z-ai/glm-5.3-flash", model_source: "explicit" },
      current_model_id: "openrouter/z-ai/glm-5.3-flash",
      config_options: [
        selectOption({
          id: "model",
          category: "model",
          currentValue: "openrouter/z-ai/glm-5.3-flash",
        }),
        selectOption({ id: "effort", category: "thought_level", currentValue: "low" }),
        selectOption({ id: "mode", category: "mode", currentValue: "build" }),
      ],
    },
  });
  const harness = harnessIdForAgentCommand(rec.agentCommand);
  assert.equal(harness, undefined, "opencode is not one of acpx's classified adapter kinds");
  assert.equal(resolveReasoningEffort(rec, harness), null);
});

// ─── effortLadder — the generic per-harness union (item 3, unchanged source) ──

test('pi record 01a08176-40fa\'s generic ladder is read from the thought_level config option, excluding "default"', () => {
  const rec = record({
    acpxRecordId: "01a08176-40fa-7f43-acac-61eb38012da6",
    agentCommand: "node /opt/pi-acp/dist/index.js",
    acpx: {
      config_options: [
        selectOption({
          id: "model",
          category: "model",
          currentValue: "openrouter/moonshotai/kimi-k2.6",
        }),
        selectOption({
          id: "thought_level",
          category: "thought_level",
          currentValue: "medium",
          values: ["off", "minimal", "low", "medium", "high"],
        }),
      ],
    },
  });
  assert.deepEqual(resolveGenericEffortLadder(rec.acpx!), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
});

test("a codex record's generic ladder is null — codex advertises no depth config option at all", () => {
  const rec = record({
    acpxRecordId: "019edbeb-53e3-7a83-a3d0-ab305b914d2a",
    agentCommand: "node /opt/codex-acp/dist/index.js",
    acpx: { session_options: { model: "gpt-5.5[xhigh]" } },
  });
  assert.equal(resolveGenericEffortLadder(rec.acpx!), null);
});

// ─── served / floorOk / floorNote — wiring model-floor.ts (item 2) ───────────

test("claude record 01f120de-0ed9 (pin opus, served claude-sonnet-5) is BELOW floor", () => {
  const rec = record({
    acpxRecordId: "01f120de-0ed9-403a-8a28-1ff2cb95c8e6",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    acpx: {
      session_options: { model: "opus", profile: "sub7", effort: "high", model_source: "explicit" },
      current_model_id: "opus",
      desired_config_options: { effort: "high" },
      served: {
        model: "claude-sonnet-5",
        effort: "high",
        at: "2026-09-03T20:38:41.314Z",
        source: "claude-transcript",
      },
    },
  });
  const harness = harnessIdForAgentCommand(rec.agentCommand);
  const result = resolveServedAndFloor(rec, harness);
  assert.deepEqual(result.served, {
    model: "claude-sonnet-5",
    effort: "high",
    at: "2026-09-03T20:38:41.314Z",
  });
  assert.equal(result.floorOk, false);
  assert.match(result.floorNote ?? "", /does not match pinned opus/);
});

test("claude record 006f1c6f-ae8d (pin sonnet, served claude-sonnet-5) is AT floor", () => {
  const rec = record({
    acpxRecordId: "006f1c6f-ae8d-4a23-9f95-1999692c7924",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    acpx: {
      session_options: {
        model: "sonnet",
        profile: "sub5",
        effort: "medium",
        model_source: "inherited",
      },
      current_model_id: "sonnet",
      desired_config_options: { effort: "medium" },
      served: {
        model: "claude-sonnet-5",
        effort: "medium",
        at: "2026-09-16T20:05:19.640Z",
        source: "claude-transcript",
      },
    },
  });
  const harness = harnessIdForAgentCommand(rec.agentCommand);
  const result = resolveServedAndFloor(rec, harness);
  assert.equal(result.floorOk, true);
  assert.equal(result.floorNote, null);
});

test("claude record 01a14b21-d9e6 (session_options.model genuinely unset, UI Default row) reports floorOk UNKNOWN, never false", () => {
  // model_source: "default" is exactly the marker the UI's Default row writes
  // (147 of 1083 sampled claude records carry it with no session_options.model
  // at all) — acceptance criterion #4.
  const rec = record({
    acpxRecordId: "01a14b21-d9e6-4486-b631-6d1772a140ab",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    acpx: {
      session_options: { profile: "sub10", effort: "max", model_source: "default" },
      current_model_id: "default",
      desired_config_options: { effort: "max" },
      served: {
        model: "claude-opus-5",
        effort: "max",
        at: "2026-09-06T00:55:45.893Z",
        source: "claude-transcript",
      },
    },
  });
  const harness = harnessIdForAgentCommand(rec.agentCommand);
  const result = resolveServedAndFloor(rec, harness);
  assert.equal(result.floorOk, null, "must be null/not-asserted, never a literal false");
  assert.match(result.floorNote ?? "", /no pinned model/);
  // The served OBSERVATION itself is still reported — floor non-assertion does
  // not mean "we saw nothing served".
  assert.deepEqual(result.served, {
    model: "claude-opus-5",
    effort: "max",
    at: "2026-09-06T00:55:45.893Z",
  });
});

test("a pi record with NO served block reports floorOk unknown, not below-floor", () => {
  // pi's `acpx.served` carries EFFORT ONLY (recordDepthOutcome never observes a
  // served MODEL for pi — see model-ladder.ts's module doc) — reconstructed
  // from real pi record shapes that never set `.served.model`.
  const rec = record({
    acpxRecordId: "rec-pi-no-served-model",
    agentCommand: "node /opt/pi-acp/dist/index.js",
    acpx: {
      session_options: { model: "openrouter/z-ai/glm-5.3-flash", effort: "high" },
      current_model_id: "openrouter/z-ai/glm-5.3-flash",
    },
  });
  const harness = harnessIdForAgentCommand(rec.agentCommand);
  const result = resolveServedAndFloor(rec, harness);
  assert.equal(result.floorOk, null);
  assert.equal(result.served, null);
});

test("a codex record with a pin reports floorOk unknown with an explicit codex-specific note", () => {
  const rec = record({
    acpxRecordId: "019edbeb-53e3-7a83-a3d0-ab305b914d2a",
    agentCommand: "node /opt/codex-acp/dist/index.js",
    acpx: { session_options: { model: "gpt-5.5[xhigh]" }, current_model_id: "gpt-5.5[xhigh]" },
  });
  const harness = harnessIdForAgentCommand(rec.agentCommand);
  const result = resolveServedAndFloor(rec, harness);
  assert.equal(result.floorOk, null);
  assert.match(result.floorNote ?? "", /not evaluated for codex/);
});

test("status groups the exact Codex advertisement and does not claim account allowance", async () => {
  const rec = record({
    acpxRecordId: "codex-live-catalogue",
    agentCommand: "node /opt/codex-acp/dist/index.js",
    acpx: {
      session_options: { model: "gpt-7-nova[max]" },
      current_model_id: "gpt-7-nova[max]",
      available_models: ["gpt-7-nova[low]", "gpt-7-nova[max]"],
    },
  });
  const result = await statusAcpxFields(rec);
  assert.deepEqual(result.advertisedModelCatalogue, {
    source: "acp",
    availability: "adapter-advertised",
    accountAllowed: null,
    models: [
      {
        family: "gpt-7-nova",
        efforts: ["low", "max"],
        modelIds: ["gpt-7-nova[low]", "gpt-7-nova[max]"],
      },
    ],
  });
  assert.deepEqual(result.effortCeiling, ["low", "max"]);
});
