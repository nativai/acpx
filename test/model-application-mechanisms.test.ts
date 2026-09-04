import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { RequestedModelUnsupportedError } from "../src/acp/model-support.js";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { applyRequestedModelIfAdvertised } from "../src/session/model-application.js";

// B3 deliverables 1 + 3 — the config-option model arm (FINDINGS-opencode D2) and
// the post-model re-read of advertised config options (CONCEPTION §5.2).

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

const MODEL_OPTION = selectOption("model", ["openrouter/z-ai/glm-5.3-flash", "openrouter/other"]);

// ── The config-option arm ────────────────────────────────────────────────────

test("opencode routes the model through session/set_config_option, not set_model", async () => {
  const client = mockClient();
  const outcome = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "ses_1",
    requestedModel: "openrouter/z-ai/glm-5.3-flash",
    models: undefined, // I1 R5/R11 — OpenCode advertises NO ACP models array
    advertisedConfigOptions: [MODEL_OPTION],
    agentCommand: AGENT_REGISTRY.opencode,
  });
  assert.equal(outcome.applied, true);
  assert.deepEqual(client.wire, [
    {
      kind: "set_config_option",
      configId: "model",
      value: "openrouter/z-ai/glm-5.3-flash",
    },
  ]);
});

test("the pre-B3 generic path THREW on exactly this shape — the regression pin", async () => {
  // models: undefined + a non-claude agent is what `assertRequestedModelSupported`
  // rejects ("the ACP agent did not advertise model support"). That throw is what
  // made `acpx opencode set model` brick the session. If a future refactor sends
  // opencode back down the generic arm, this row is what catches it.
  const client = mockClient();
  await assert.rejects(
    async () =>
      await applyRequestedModelIfAdvertised({
        client,
        sessionId: "ses_1",
        requestedModel: "openrouter/z-ai/glm-5.3-flash",
        models: undefined,
        advertisedConfigOptions: [MODEL_OPTION],
        // An agent command the descriptor does NOT classify — so it takes the
        // generic arm, proving the arm choice is what saves opencode.
        agentCommand: "some-unknown-adapter --acp",
      }),
    RequestedModelUnsupportedError,
  );
  assert.deepEqual(client.wire, [], "nothing may be sent when the model is refused");
});

test("an unadvertised model is REFUSED before anything is sent (D2 cannot return)", async () => {
  const client = mockClient();
  await assert.rejects(
    async () =>
      await applyRequestedModelIfAdvertised({
        client,
        sessionId: "ses_1",
        requestedModel: "openrouter/not-in-the-bundled-catalogue",
        models: undefined,
        advertisedConfigOptions: [MODEL_OPTION],
        agentCommand: AGENT_REGISTRY.opencode,
      }),
    (error: unknown) => {
      assert.ok(error instanceof RequestedModelUnsupportedError);
      assert.match(error.message, /did not advertise that model/);
      assert.match(error.message, /Nothing was written/);
      return true;
    },
  );
  // THE point of D2's fix: no wire call, so nothing to persist and nothing to
  // replay on the next reconnect.
  assert.deepEqual(client.wire, []);
});

test("a config-option session that advertises no model option is refused, not crashed", async () => {
  const client = mockClient();
  await assert.rejects(
    async () =>
      await applyRequestedModelIfAdvertised({
        client,
        sessionId: "ses_1",
        requestedModel: "openrouter/z-ai/glm-5.3-flash",
        models: undefined,
        advertisedConfigOptions: [selectOption("effort", ["low", "high"])],
        agentCommand: AGENT_REGISTRY.opencode,
      }),
    RequestedModelUnsupportedError,
  );
  assert.deepEqual(client.wire, []);
});

// ── Deliverable 3: the post-model re-read ────────────────────────────────────

test("THE RE-READ: effort absent at session/new, present after the model is applied", async () => {
  // ⚠️ THIS IS THE TEST CONCEPTION §5.2 SAYS EVERY NAIVE VERSION GETS WRONG.
  // It starts from a NON-REASONING default (no `effort` advertised anywhere in
  // the session/new snapshot), then switches to a reasoning model. A test that
  // pinned a reasoning model at creation would pass without the re-read existing.
  const sessionNewSnapshot = [MODEL_OPTION]; // no `effort` — the default model does not reason
  const afterModelSwitch = [MODEL_OPTION, selectOption("effort", ["low", "high", "max"])];

  const client = mockClient(afterModelSwitch);
  const outcome = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "ses_1",
    requestedModel: "openrouter/z-ai/glm-5.3-flash",
    models: undefined,
    advertisedConfigOptions: sessionNewSnapshot,
    agentCommand: AGENT_REGISTRY.opencode,
  });

  // The snapshot the caller started with genuinely lacks `effort` — proving the
  // probe entered the shape the trap lives in, rather than a convenient one.
  assert.equal(
    sessionNewSnapshot.some((option) => option.id === "effort"),
    false,
    "the fixture must START without effort or this test proves nothing",
  );
  assert.ok(outcome.refreshedConfigOptions, "the set response's refreshed options were dropped");
  assert.equal(
    outcome.refreshedConfigOptions?.some((option) => option.id === "effort"),
    true,
    "effort must be visible AFTER the model is applied — this is the whole re-read",
  );
});

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
