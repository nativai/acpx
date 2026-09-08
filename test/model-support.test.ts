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

// bricks 8320bedc / a82f6833 — THE `!models` REFUSAL MUST DESCRIBE A RESPONSE,
// NOT A CAPABILITY.
//
// It read "the ACP agent did not advertise model support", which is a claim about
// the ADAPTER. pi-acp's `unstable_forkSession` omitted `models` while its own
// `session/new` and `session/load` returned it, so the sentence was false about an
// adapter that implements `session/set_model` and serves OpenRouter models on every
// turn — and it sent an investigation at the wrong repo for an hour while Daniel
// could not fork a pi session. This is the executable half of the carrier comment
// at `src/acp/model-support.ts`: the capability claim must stay out, the
// response-scoped wording must stay in.
test("the no-catalogue refusal blames the RESPONSE, not the agent (8320bedc)", () => {
  for (const context of ["apply", "replay"] as const) {
    let thrown: unknown;
    try {
      assertRequestedModelSupported({
        requestedModel: "openrouter/z-ai/glm-5.3-flash",
        models: undefined,
        context,
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof RequestedModelUnsupportedError, `${context} must still refuse`);

    assert.doesNotMatch(
      thrown.message,
      /agent did not advertise model support/,
      `${context}: the capability claim must not come back — it was false about pi-acp`,
    );
    assert.match(
      thrown.message,
      /this session carries no ACP `models` advertisement/,
      `${context}: the refusal must state what was actually observed`,
    );
    // All three candidate seams are named, because which one produced the
    // `undefined` is not knowable at that function.
    for (const seam of ["session/new", "session/load", "session/fork"]) {
      assert.ok(thrown.message.includes(seam), `${context}: message must name ${seam}`);
    }
    // And it must still say what a working setup needs.
    assert.match(
      thrown.message,
      /session\/set_model/,
      `${context}: keep the actionable requirement`,
    );
  }
});
