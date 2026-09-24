import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { applyRequestedModelIfAdvertised } from "../src/session/model-application.js";

// The model-apply dispatcher's SURVIVING arms.
//
// ⚠️ THE `config-option` MODEL ARM AND ITS ROWS WERE REMOVED WITH THE LAST
// HARNESS THAT DECLARED IT. What that arm had to do — validate against the
// advertised `model` option BEFORE persisting anything, or a `set model` reports
// success and leaves the session unrecoverable — is recorded in brick://2b02ccd3,
// not here. Re-adding the arm means re-adding its rows.

const CLAUDE = "node /opt/claude-agent-acp/dist/index.js";
const CODEX = "node /opt/codex-acp/dist/index.js";

type Wire = { kind: "set_model" | "set_config_option"; configId?: string; value: string };

function mockClient(refreshed?: SessionConfigOption[]): {
  wire: Wire[];
  setSessionModel: (sessionId: string, modelId: string) => Promise<void>;
  setSessionConfigOption: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<{ configOptions?: SessionConfigOption[] }>;
} {
  const wire: Wire[] = [];
  return {
    wire,
    setSessionModel(_sessionId, modelId) {
      wire.push({ kind: "set_model", value: modelId });
      return Promise.resolve();
    },
    setSessionConfigOption(_sessionId, configId, value) {
      wire.push({ kind: "set_config_option", configId, value });
      return Promise.resolve(refreshed ? { configOptions: refreshed } : {});
    },
  };
}

function selectOption(
  id: string,
  values: string[],
  currentValue = "zzz-current",
): SessionConfigOption {
  return {
    id,
    name: id,
    type: "select",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  } as unknown as SessionConfigOption;
}

// ── The guardrail: claude and codex are untouched ────────────────────────────

test("a set-model harness keeps the session/new advertisement (no refreshed options)", async () => {
  // The `?? sessionResult.configOptions` fallback at every call site depends on
  // this being undefined. If a set-model apply ever started returning options,
  // callers would silently switch source. Pinned in both directions below.
  for (const agentCommand of [CLAUDE, CODEX]) {
    const client = mockClient();
    const outcome = await applyRequestedModelIfAdvertised({
      client,
      sessionId: "ses_1",
      requestedModel: "probe-model",
      models: {
        currentModelId: "something-else",
        availableModels: [{ modelId: "probe-model", name: "probe" }],
      } as never,
      advertisedConfigOptions: [selectOption("effort", ["low", "high"])],
      agentCommand,
    });
    assert.equal(outcome.applied, true, agentCommand);
    assert.equal(
      outcome.refreshedConfigOptions,
      undefined,
      `${agentCommand}: a set-model apply must not invent refreshed options`,
    );
    assert.deepEqual(
      client.wire,
      [{ kind: "set_model", value: "probe-model" }],
      `${agentCommand}: must still use session/set_model, and must NOT touch set_config_option`,
    );
  }
});

test("claude and codex outcomes are boolean-equivalent to the pre-B3 return", async () => {
  // WS-core's requirement: prove the widened return did not change what these
  // two harnesses DO. Each case states the boolean the old signature returned.
  const cases: Array<{ what: string; models: unknown; requested: string; expected: boolean }> = [
    {
      what: "no model requested -> false",
      models: { currentModelId: "a", availableModels: [{ modelId: "a", name: "a" }] },
      requested: "",
      expected: false,
    },
    {
      what: "already at the requested model -> true, no wire call",
      models: { currentModelId: "a", availableModels: [{ modelId: "a", name: "a" }] },
      requested: "a",
      expected: true,
    },
    {
      what: "a real switch -> true",
      models: { currentModelId: "a", availableModels: [{ modelId: "b", name: "b" }] },
      requested: "b",
      expected: true,
    },
  ];
  for (const agentCommand of [CLAUDE, CODEX]) {
    for (const testCase of cases) {
      const client = mockClient();
      const outcome = await applyRequestedModelIfAdvertised({
        client,
        sessionId: "ses_1",
        requestedModel: testCase.requested,
        models: testCase.models as never,
        agentCommand,
      });
      assert.equal(outcome.applied, testCase.expected, `${agentCommand}: ${testCase.what}`);
    }
  }
});

test("the always-truthy trap: an unapplied outcome is still an object", async () => {
  // The defect this pins actually happened, at src/runtime/engine/manager.ts:726 —
  // `if (requestedModelApplied)` on the widened return is ALWAYS TRUE, and the
  // compiler cannot catch it (an inferred const in a truthiness test is legal TS).
  // Unfixed it stamped current_model_id on sessions whose model was never applied,
  // on claude and codex too. This row states the hazard as an executable fact so a
  // future caller reading `.applied` is not relying on a comment.
  const client = mockClient();
  const outcome = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "ses_1",
    requestedModel: undefined,
    models: undefined,
    agentCommand: CLAUDE,
  });
  assert.equal(outcome.applied, false);
  assert.ok(outcome, "the outcome object is truthy even when nothing was applied");
  assert.deepEqual(client.wire, []);
});

test("codex applies and returns the effective id from its live advertised ladder", async () => {
  const client = mockClient();
  const outcome = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "ses_new_family",
    requestedModel: "gpt-7-nova",
    reasoningEffort: "max",
    models: {
      currentModelId: "gpt-7-nova[low]",
      availableModels: [
        { modelId: "gpt-7-nova[low]", name: "Nova low" },
        { modelId: "gpt-7-nova[max]", name: "Nova max" },
      ],
    } as never,
    agentCommand: CODEX,
  });
  assert.deepEqual(outcome, { applied: true, effectiveModelId: "gpt-7-nova[max]" });
  assert.deepEqual(client.wire, [{ kind: "set_model", value: "gpt-7-nova[max]" }]);
});
