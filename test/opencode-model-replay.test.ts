import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { applyRequestedModelIfAdvertised } from "../src/session/model-application.js";

// F-9 (brick 2efdf8b2, re-created by B3 and closed here).
//
// ⚠️ WHAT WENT WRONG, so the shape is not repeated. B0 left
// `canSetModelLive: false` for opencode, so `assertLiveModelChangeRoutable`
// refused a `set model` LOUDLY and wrote nothing — rc=2, session still usable.
// B3 landed a config-option arm on the APPLY path and flipped the routing list,
// which removed that refusal — but left the REPLAY path on the generic check.
// The result was strictly worse than what B0 shipped:
//
//   B0 b1cef176 : set model -> rc=2, nothing written -> NEXT TURN COMPLETES
//   B3 b7c990bc : set model -> rc=0, "model set"     -> NEXT TURN FAILS, 0 chars
//
// ⚠️ AND THE FAILING TURN RETURNED rc=0. The exit code is NOT the evidence; the
// CONTENT is. Every assertion here is on what was sent or refused, never on a
// status.
//
// Root cause at the wire (hp-te2): the OpenCode adapter advertises NO models at
// all — the string "models" occurs ZERO times in its session stream — so
// `assertRequestedModelSupported` threw on every replay.
//
// THE FIX IS STRUCTURAL: apply and replay now go through ONE dispatcher. Two code
// paths asking the same question two ways is what allowed them to diverge.

type Wire = { kind: "set_model" | "set_config_option"; value: string };

function mockClient(): {
  wire: Wire[];
  setSessionModel: (s: string, m: string) => Promise<void>;
  setSessionConfigOption: (
    s: string,
    c: string,
    v: string,
  ) => Promise<{ configOptions?: SessionConfigOption[] }>;
} {
  const wire: Wire[] = [];
  return {
    wire,
    setSessionModel(_s, modelId) {
      wire.push({ kind: "set_model", value: modelId });
      return Promise.resolve();
    },
    setSessionConfigOption(_s, _c, value) {
      wire.push({ kind: "set_config_option", value });
      return Promise.resolve({});
    },
  };
}

/** OpenCode's measured shape: a `model` config option, and NO ACP models array. */
const MODEL_OPTION = [
  {
    id: "model",
    name: "model",
    type: "select",
    currentValue: "openrouter/other",
    options: [
      { value: "openrouter/deepseek/deepseek-v4-pro", name: "deepseek" },
      { value: "openrouter/other", name: "other" },
    ],
  },
] as unknown as SessionConfigOption[];

test("F-9: a REPLAY of a stored model succeeds for opencode — it does not throw", async () => {
  // THE REGRESSION. Before the fix this threw
  // "Cannot replay saved model …: the ACP agent did not advertise model support",
  // which is what killed the next turn after a `set model`.
  const client = mockClient();
  const outcome = await applyRequestedModelIfAdvertised({
    client,
    sessionId: "ses_replay",
    requestedModel: "openrouter/deepseek/deepseek-v4-pro",
    models: undefined, // measured: opencode advertises NO models at all
    advertisedConfigOptions: MODEL_OPTION,
    agentCommand: AGENT_REGISTRY.opencode,
    context: "replay",
  });
  assert.equal(outcome.applied, true, "the replay did not apply the stored model");
  assert.deepEqual(
    client.wire,
    [{ kind: "set_config_option", value: "openrouter/deepseek/deepseek-v4-pro" }],
    "the replay must go through session/set_config_option, never session/set_model",
  );
});

test("F-9: apply and replay take the SAME arm — they cannot diverge again", async () => {
  // The property that makes the fix structural rather than a second patch. Both
  // contexts, same inputs: identical wire, identical outcome.
  const results = [];
  for (const context of ["apply", "replay"] as const) {
    const client = mockClient();
    const outcome = await applyRequestedModelIfAdvertised({
      client,
      sessionId: "ses_x",
      requestedModel: "openrouter/deepseek/deepseek-v4-pro",
      models: undefined,
      advertisedConfigOptions: MODEL_OPTION,
      agentCommand: AGENT_REGISTRY.opencode,
      context,
    });
    results.push({ applied: outcome.applied, wire: client.wire });
  }
  assert.deepEqual(results[0], results[1], "apply and replay behaved differently");
});

test("F-9: a model the session does NOT advertise is refused with NOTHING written", async () => {
  // Outcome (b) of the bar: where the pin cannot be honoured, refuse loudly and
  // write nothing — B0's behaviour, preserved for the case that warrants it.
  const client = mockClient();
  await assert.rejects(
    async () =>
      await applyRequestedModelIfAdvertised({
        client,
        sessionId: "ses_bad",
        requestedModel: "openrouter/not-advertised-zzz9",
        models: undefined,
        advertisedConfigOptions: MODEL_OPTION,
        agentCommand: AGENT_REGISTRY.opencode,
        context: "replay",
      }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /did not advertise that model/);
      assert.match(message, /Nothing was written/);
      return true;
    },
  );
  assert.deepEqual(client.wire, [], "a refused replay must send nothing");
});

test("F-9 GUARDRAIL: claude and codex replays are untouched", async () => {
  for (const agentCommand of [
    "node /opt/claude-agent-acp/dist/index.js",
    "node /opt/codex-acp/dist/index.js",
  ]) {
    const client = mockClient();
    const outcome = await applyRequestedModelIfAdvertised({
      client,
      sessionId: "ses_c",
      requestedModel: "probe-model",
      models: {
        currentModelId: "something-else",
        availableModels: [{ modelId: "probe-model", name: "probe" }],
      } as never,
      advertisedConfigOptions: MODEL_OPTION,
      agentCommand,
      context: "replay",
    });
    assert.equal(outcome.applied, true, agentCommand);
    assert.deepEqual(
      client.wire,
      [{ kind: "set_model", value: "probe-model" }],
      `${agentCommand}: must still replay through session/set_model`,
    );
  }
});
