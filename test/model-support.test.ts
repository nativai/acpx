import assert from "node:assert/strict";
import test from "node:test";
import type { SessionModelState } from "@agentclientprotocol/sdk";
import {
  RequestedModelUnsupportedError,
  assertRequestedModelSupported,
} from "../src/acp/model-support.js";

// The adapter advertises only BASE model ids (never the `[1m]` context-window variants).
// This mirrors the live prod specimen b94c0828 (brick bbdbd56d).
const BASE_ADVERTISED: SessionModelState = {
  currentModelId: "default",
  availableModels: [
    { modelId: "default", name: "default" },
    { modelId: "claude-fable-5", name: "claude-fable-5" },
    { modelId: "sonnet", name: "sonnet" },
    { modelId: "haiku", name: "haiku" },
    { modelId: "fable", name: "fable" },
    { modelId: "opus", name: "opus" },
  ],
};

test("assertRequestedModelSupported accepts a [1m] context-alias when its base is advertised", () => {
  for (const context of ["apply", "replay"] as const) {
    for (const requestedModel of ["sonnet[1m]", "opus[1m]"]) {
      assert.doesNotThrow(
        () =>
          assertRequestedModelSupported({
            requestedModel,
            models: BASE_ADVERTISED,
            context,
          }),
        `${requestedModel} (${context}) should pass when base is advertised`,
      );
    }
  }
});

test("assertRequestedModelSupported still accepts an exact advertised id", () => {
  assert.doesNotThrow(() =>
    assertRequestedModelSupported({
      requestedModel: "sonnet",
      models: BASE_ADVERTISED,
      context: "replay",
    }),
  );
});

test("assertRequestedModelSupported still rejects a genuinely-unknown model", () => {
  for (const context of ["apply", "replay"] as const) {
    assert.throws(
      () =>
        assertRequestedModelSupported({
          requestedModel: "gpt-9",
          models: BASE_ADVERTISED,
          context,
        }),
      RequestedModelUnsupportedError,
      `gpt-9 (${context}) has no advertised base and must still throw`,
    );
  }
});

test("assertRequestedModelSupported rejects a [1m] alias whose base is NOT advertised", () => {
  // Stripping the hint must not smuggle in an unadvertised base.
  assert.throws(
    () =>
      assertRequestedModelSupported({
        requestedModel: "gpt-9[1m]",
        models: BASE_ADVERTISED,
        context: "replay",
      }),
    RequestedModelUnsupportedError,
  );
});
