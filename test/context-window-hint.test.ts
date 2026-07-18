import assert from "node:assert/strict";
import test from "node:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  cloneSessionAcpxState,
  createSessionConversation,
  recordSessionUpdate,
  resolveContextWindowHint,
} from "../src/session/conversation-model.js";
import type { SessionAcpxState } from "../src/types.js";

// Fix A (brick 92a994a0): acpx remembers the authoritative context-window size
// the adapter reports per session-model and round-trips it back on resume, so a
// resumed 1M session reports 1M from its first post-resume usage_update instead
// of re-guessing 200k. The model tag invalidates it across a model switch.

function usageUpdate(used: number, size: number): SessionNotification {
  return {
    sessionId: "session-1",
    update: { sessionUpdate: "usage_update", used, size },
  } as SessionNotification;
}

test("usage_update remembers the context-window size tagged with the current model", () => {
  const conversation = createSessionConversation("2026-07-18T10:00:00.000Z");
  const acpx = recordSessionUpdate(
    conversation,
    { current_model_id: "opus" },
    usageUpdate(31125, 1_000_000),
    "2026-07-18T10:00:01.000Z",
  );

  assert.equal(acpx.context_window_size, 1_000_000);
  assert.equal(acpx.context_window_model_id, "opus");
});

test("usage_update does not remember a window while the model is still unknown", () => {
  const conversation = createSessionConversation("2026-07-18T10:00:00.000Z");
  const acpx = recordSessionUpdate(
    conversation,
    undefined,
    usageUpdate(100, 200000),
    "2026-07-18T10:00:01.000Z",
  );

  assert.equal(acpx.context_window_size, undefined);
  assert.equal(acpx.context_window_model_id, undefined);
});

test("a later usage_update overwrites the remembered window (heuristic → authoritative)", () => {
  const conversation = createSessionConversation("2026-07-18T10:00:00.000Z");
  let acpx: SessionAcpxState | undefined = { current_model_id: "opus" };
  // Genuine-first-turn shape: a heuristic 200k mid-stream, then the result's
  // authoritative 1M — the remembered value converges to the authoritative one.
  acpx = recordSessionUpdate(
    conversation,
    acpx,
    usageUpdate(50000, 200000),
    "2026-07-18T10:00:01.000Z",
  );
  assert.equal(acpx.context_window_size, 200000);
  acpx = recordSessionUpdate(
    conversation,
    acpx,
    usageUpdate(173489, 1_000_000),
    "2026-07-18T10:00:02.000Z",
  );
  assert.equal(acpx.context_window_size, 1_000_000);
  assert.equal(acpx.context_window_model_id, "opus");
});

test("resolveContextWindowHint returns the remembered size when the model still matches", () => {
  const acpx: SessionAcpxState = {
    current_model_id: "opus",
    context_window_size: 1_000_000,
    context_window_model_id: "opus",
  };
  assert.equal(resolveContextWindowHint(acpx), 1_000_000);
});

test("resolveContextWindowHint invalidates a stale window after a model switch", () => {
  // The window was learned for a 1M model; the user then switched to a 200k
  // model (current_model_id moved, the tag did not). The stale 1M must NOT be
  // carried forward — the adapter should heuristic-seed the new model instead.
  const acpx: SessionAcpxState = {
    current_model_id: "sonnet",
    context_window_size: 1_000_000,
    context_window_model_id: "opus",
  };
  assert.equal(resolveContextWindowHint(acpx), undefined);
});

test("resolveContextWindowHint returns undefined when nothing was ever remembered", () => {
  assert.equal(resolveContextWindowHint(undefined), undefined);
  assert.equal(resolveContextWindowHint({ current_model_id: "opus" }), undefined);
});

test("resolveContextWindowHint rejects a non-positive remembered size", () => {
  const acpx: SessionAcpxState = {
    current_model_id: "opus",
    context_window_size: 0,
    context_window_model_id: "opus",
  };
  assert.equal(resolveContextWindowHint(acpx), undefined);
});

test("cloneSessionAcpxState preserves the remembered context window (survives the turn checkpoint)", () => {
  const state: SessionAcpxState = {
    current_model_id: "opus",
    context_window_size: 1_000_000,
    context_window_model_id: "opus",
  };
  const cloned = cloneSessionAcpxState(state);
  assert.equal(cloned?.context_window_size, 1_000_000);
  assert.equal(cloned?.context_window_model_id, "opus");
  // Round-trip through resolveContextWindowHint to prove the clone stays usable.
  assert.equal(resolveContextWindowHint(cloned), 1_000_000);
});
