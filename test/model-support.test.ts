import assert from "node:assert/strict";
import test from "node:test";
import type { SessionModelState } from "@agentclientprotocol/sdk";
import { normalizeOutputError } from "../src/acp/error-normalization.js";
import { OUTPUT_ERROR_JSONRPC_CODES, buildJsonRpcErrorResponse } from "../src/acp/jsonrpc-error.js";
import {
  RequestedModelUnsupportedError,
  assertRequestedModelSupported,
} from "../src/acp/model-support.js";
import { AcpxOperationalError } from "../src/errors.js";

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

// de290ae4: an unadvertised model/effort is a USER input error, not a runtime
// fault. It must normalize to USAGE (-32602) with a stable detailCode so acpx-ui
// renders a friendly "pick another" notice instead of a scary -32603 RUNTIME
// internal-error card (the reported symptom).
test("RequestedModelUnsupportedError is a USAGE-classified AcpxOperationalError", () => {
  const error = new RequestedModelUnsupportedError('Cannot apply --model "gpt-5.6-luna[ultra]": …');
  assert.ok(error instanceof AcpxOperationalError, "must be operational, not a plain Error");
  assert.equal(error.outputCode, "USAGE");
  assert.equal(error.detailCode, "MODEL_NOT_ADVERTISED");
  assert.equal(error.origin, "cli");
  assert.equal(error.name, "RequestedModelUnsupportedError");
});

test("an unadvertised codex effort normalizes to USAGE, not RUNTIME (de290ae4)", () => {
  let thrown: unknown;
  try {
    assertRequestedModelSupported({
      requestedModel: "gpt-5.6-luna[ultra]",
      models: {
        currentModelId: "gpt-5.6-luna[medium]",
        availableModels: [
          { modelId: "gpt-5.6-luna[low]", name: "luna low" },
          { modelId: "gpt-5.6-luna[medium]", name: "luna medium" },
          { modelId: "gpt-5.6-luna[max]", name: "luna max" },
        ],
      },
      context: "apply",
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof RequestedModelUnsupportedError, "luna[ultra] must be rejected");

  const normalized = normalizeOutputError(thrown, { origin: "cli" });
  assert.equal(normalized.code, "USAGE");
  assert.notEqual(normalized.code, "RUNTIME");
  assert.equal(normalized.detailCode, "MODEL_NOT_ADVERTISED");

  // And the JSON-RPC envelope carries -32602 (USAGE), never -32603 (RUNTIME).
  const response = buildJsonRpcErrorResponse({
    outputCode: normalized.code,
    detailCode: normalized.detailCode,
    origin: normalized.origin,
    message: normalized.message,
  });
  assert.equal(response.error.code, OUTPUT_ERROR_JSONRPC_CODES.USAGE);
  assert.equal(response.error.code, -32602);
});
