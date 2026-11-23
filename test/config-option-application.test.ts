import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { maybeWrapSessionControlError } from "../src/acp/session-control-errors.js";
import {
  advertisesConfigOption,
  applyExecReasoningEffort,
  applyRequestedConfigOptionsIfAdvertised,
  normalizeEffortLevelForAdvertisedOption,
  normalizeEffortLevelForModel,
  persistAndApplyRequestedEffort,
} from "../src/session/config-option-application.js";
import { getDesiredConfigOptions } from "../src/session/mode-preference.js";
import type { SessionRecord } from "../src/types.js";

const OPUS_EFFORT_LEVELS = ["default", "low", "medium", "high", "xhigh", "max"];
const SONNET_EFFORT_LEVELS = ["low", "medium", "high"];

function effortOption(currentValue: string, levels = OPUS_EFFORT_LEVELS): SessionConfigOption {
  return {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue,
    options: levels.map((value) => ({ value, name: value })),
  } as SessionConfigOption;
}

type Call = { sessionId: string; configId: string; value: string };
type ModeCall = { sessionId: string; modeId: string };

// B3: the depth path now dispatches on the harness's depth MECHANISM, so its
// client surface is `ConfigOptionApplyClient & DepthModeApplyClient`. The stub
// carries `setSessionMode` and RECORDS it, so a test can assert that the
// config-option arm never reaches for the mode wire (and vice versa) rather than
// merely that it compiled.
function mockClient(responseOptions?: SessionConfigOption[]): {
  calls: Call[];
  modeCalls: ModeCall[];
  setSessionConfigOption: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<{ configOptions?: SessionConfigOption[] }>;
  setSessionMode: (sessionId: string, modeId: string) => Promise<void>;
} {
  const calls: Call[] = [];
  const modeCalls: ModeCall[] = [];
  return {
    calls,
    modeCalls,
    setSessionConfigOption(sessionId, configId, value) {
      calls.push({ sessionId, configId, value });
      return Promise.resolve({ configOptions: responseOptions });
    },
    setSessionMode(sessionId, modeId) {
      modeCalls.push({ sessionId, modeId });
      return Promise.resolve();
    },
  };
}

function rejectingMockClient(error: Error): ReturnType<typeof mockClient> {
  const calls: Call[] = [];
  const modeCalls: ModeCall[] = [];
  return {
    calls,
    modeCalls,
    setSessionConfigOption(sessionId, configId, value) {
      calls.push({ sessionId, configId, value });
      return Promise.reject(error);
    },
    setSessionMode(sessionId, modeId) {
      modeCalls.push({ sessionId, modeId });
      return Promise.reject(error);
    },
  };
}

function recordWithDesired(desired?: Record<string, string>): SessionRecord {
  return {
    acpx: desired ? { desired_config_options: { ...desired } } : {},
  } as unknown as SessionRecord;
}

test("normalizeEffortLevelForAdvertisedOption: clamps xhigh/max to high for low/medium/high models", () => {
  const option = effortOption("medium", SONNET_EFFORT_LEVELS);
  assert.equal(normalizeEffortLevelForAdvertisedOption("xhigh", option), "high");
  assert.equal(normalizeEffortLevelForAdvertisedOption("max", option), "high");
});

test("normalizeEffortLevelForAdvertisedOption: child model id overrides stale broad advertisements", () => {
  const staleOption = effortOption("high", OPUS_EFFORT_LEVELS);
  assert.equal(normalizeEffortLevelForAdvertisedOption("xhigh", staleOption, "sonnet"), "high");
  for (const legacy of [
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "anthropic/claude-haiku-4.5",
  ]) {
    assert.equal(normalizeEffortLevelForAdvertisedOption("low", staleOption, legacy), "high");
    assert.equal(normalizeEffortLevelForAdvertisedOption("medium", staleOption, legacy), "high");
    assert.equal(normalizeEffortLevelForAdvertisedOption("max", staleOption, legacy), "high");
  }
});

// ⚠️ Carrier for LEGACY_HAIKU_MODEL_ID in config-option-application.ts: widening the
// haiku ladder must not lift the retired 4.x generation, which rejects effort mutation.
test("haiku effort: legacy 3.x/4.x ids stay high-only", () => {
  const option = effortOption("high", OPUS_EFFORT_LEVELS);
  for (const legacy of [
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-3-5-haiku-20241022",
    "claude-3-haiku-20240307",
  ]) {
    for (const level of ["low", "medium", "xhigh", "max"]) {
      assert.equal(normalizeEffortLevelForModel(level, legacy), "high", `${legacy} ${level}`);
      assert.equal(normalizeEffortLevelForAdvertisedOption(level, option, legacy), "high");
    }
  }
});

test("haiku effort: the bare alias and 5.x ids defer to the advertised ladder", () => {
  const option = effortOption("default", OPUS_EFFORT_LEVELS);
  for (const model of ["haiku", "claude-haiku-5-5", "claude-haiku-5-5-20261001"]) {
    assert.equal(normalizeEffortLevelForModel("low", model), undefined, model);
    for (const level of ["default", "low", "medium", "high", "xhigh", "max"]) {
      assert.equal(normalizeEffortLevelForAdvertisedOption(level, option, model), level, model);
    }
  }
});

test("normalizeEffortLevelForAdvertisedOption: passes through supported effort levels", () => {
  assert.equal(normalizeEffortLevelForAdvertisedOption("xhigh", effortOption("high")), "xhigh");
  assert.equal(normalizeEffortLevelForAdvertisedOption("default", effortOption("high")), "default");
  assert.equal(
    normalizeEffortLevelForAdvertisedOption("medium", effortOption("high", SONNET_EFFORT_LEVELS)),
    "medium",
  );
});

test("normalizeEffortLevelForModel: maps compact Claude model efforts without advertised options", () => {
  assert.equal(normalizeEffortLevelForModel("xhigh", "sonnet"), "high");
  assert.equal(normalizeEffortLevelForModel("future-ultra", "claude-haiku-4-5"), "high");
  assert.equal(normalizeEffortLevelForModel("low", "claude-haiku-4-5"), "high");
  assert.equal(normalizeEffortLevelForModel("xhigh", "opus[1m]"), undefined);
});

test("normalizeEffortLevelForAdvertisedOption: unknown source levels fall back to child default", () => {
  assert.equal(
    normalizeEffortLevelForAdvertisedOption(
      "future-ultra",
      effortOption("medium", SONNET_EFFORT_LEVELS),
    ),
    "medium",
  );
  assert.equal(
    normalizeEffortLevelForAdvertisedOption(
      "future-ultra",
      effortOption("medium", [...SONNET_EFFORT_LEVELS, "future-ultra"]),
    ),
    "medium",
  );
});

test("applyRequestedConfigOptionsIfAdvertised: exactly one set when advertised & differing", async () => {
  const client = mockClient();
  const record = recordWithDesired({ effort: "low" });
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record,
    advertised: [effortOption("high")],
  });
  assert.deepEqual(client.calls, [{ sessionId: "s1", configId: "effort", value: "low" }]);
});

test("applyRequestedConfigOptionsIfAdvertised: no set when desired equals currentValue", async () => {
  const client = mockClient();
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record: recordWithDesired({ effort: "high" }),
    advertised: [effortOption("high")],
  });
  assert.equal(client.calls.length, 0);
});

test("applyRequestedConfigOptionsIfAdvertised: no set when nothing is desired", async () => {
  const client = mockClient();
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record: recordWithDesired(),
    advertised: [effortOption("high")],
  });
  assert.equal(client.calls.length, 0);
});

test("applyRequestedConfigOptionsIfAdvertised: maps unsupported known efforts to the nearest advertised level", async () => {
  const client = mockClient();
  const record = recordWithDesired({ effort: "xhigh" });
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record,
    advertised: [effortOption("low", SONNET_EFFORT_LEVELS)],
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, "high");
  assert.deepEqual(client.calls, [{ sessionId: "s1", configId: "effort", value: "high" }]);
});

test("applyRequestedConfigOptionsIfAdvertised: maps stale broad effort advertisements by child model", async () => {
  const client = mockClient();
  const record = recordWithDesired({ effort: "xhigh" });
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record,
    advertised: [effortOption("high", OPUS_EFFORT_LEVELS)],
    modelId: "sonnet",
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, "high");
  assert.equal(client.calls.length, 0);
});

test("applyRequestedConfigOptionsIfAdvertised: keeps Haiku 4.5 at default when advertisement is stale", async () => {
  const client = mockClient();
  const record = recordWithDesired({ effort: "low" });
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record,
    advertised: [effortOption("high", OPUS_EFFORT_LEVELS)],
    modelId: "claude-haiku-4-5",
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, "high");
  assert.equal(client.calls.length, 0);
});

test("applyRequestedConfigOptionsIfAdvertised: Haiku 5.5 gets the effort it asked for", async () => {
  const client = mockClient();
  const record = recordWithDesired({ effort: "xhigh" });
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record,
    advertised: [effortOption("default", OPUS_EFFORT_LEVELS)],
    modelId: "claude-haiku-5-5",
  });
  assert.deepEqual(client.calls, [{ sessionId: "s1", configId: "effort", value: "xhigh" }]);
});

test("applyRequestedConfigOptionsIfAdvertised: rejected effort set falls back to default", async () => {
  const client = rejectingMockClient(new Error("Unknown config option: effort"));
  const record = recordWithDesired({ effort: "low" });
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record,
    advertised: [effortOption("high", OPUS_EFFORT_LEVELS)],
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, "high");
  assert.deepEqual(client.calls, [{ sessionId: "s1", configId: "effort", value: "low" }]);
});

test("applyRequestedConfigOptionsIfAdvertised: unknown effort falls back to the advertised default", async () => {
  const client = mockClient();
  const record = recordWithDesired({ effort: "future-ultra" });
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record,
    advertised: [effortOption("medium", [...SONNET_EFFORT_LEVELS, "future-ultra"])],
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, "medium");
  assert.equal(client.calls.length, 0);
});

test("applyRequestedConfigOptionsIfAdvertised: advertised default effort passes through", async () => {
  const client = mockClient();
  const record = recordWithDesired({ effort: "default" });
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record,
    advertised: [effortOption("high")],
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, "default");
  assert.deepEqual(client.calls, [{ sessionId: "s1", configId: "effort", value: "default" }]);
});

test("applyRequestedConfigOptionsIfAdvertised: no set when the option is not advertised (codex)", async () => {
  const client = mockClient();
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record: recordWithDesired({ effort: "low" }),
    advertised: [],
  });
  assert.equal(client.calls.length, 0);
});

test("applyRequestedConfigOptionsIfAdvertised: captures the set-response options onto the record", async () => {
  const client = mockClient([effortOption("low")]);
  const record = recordWithDesired({ effort: "low" });
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record,
    advertised: [effortOption("high")],
  });
  const live = record.acpx?.config_options?.find((o) => o.id === "effort");
  assert.equal(live && live.type === "select" ? live.currentValue : null, "low");
});

test("advertisesConfigOption: detects the effort option", () => {
  assert.equal(advertisesConfigOption([effortOption("high")], "effort"), true);
  assert.equal(advertisesConfigOption([], "effort"), false);
  assert.equal(advertisesConfigOption(undefined, "effort"), false);
});

test("persistAndApplyRequestedEffort: persists intent and applies when effort is advertised", async () => {
  const client = mockClient();
  const record = recordWithDesired();
  await persistAndApplyRequestedEffort({
    client,
    sessionId: "s1",
    record,
    reasoningEffort: "low",
    advertised: [effortOption("high")],
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, "low");
  assert.deepEqual(client.calls, [{ sessionId: "s1", configId: "effort", value: "low" }]);
});

test("persistAndApplyRequestedEffort: persists mapped effort when the requested level is model-unsupported", async () => {
  const client = mockClient();
  const record = recordWithDesired();
  await persistAndApplyRequestedEffort({
    client,
    sessionId: "s1",
    record,
    reasoningEffort: "max",
    advertised: [effortOption("medium", SONNET_EFFORT_LEVELS)],
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, "high");
  assert.deepEqual(client.calls, [{ sessionId: "s1", configId: "effort", value: "high" }]);
});

test("persistAndApplyRequestedEffort: sends the requested effort on Haiku 5.5 (alias and id)", async () => {
  for (const modelId of ["haiku", "claude-haiku-5-5"]) {
    const client = mockClient();
    const record = recordWithDesired();
    await persistAndApplyRequestedEffort({
      client,
      sessionId: "s1",
      record,
      reasoningEffort: "low",
      advertised: [effortOption("default", OPUS_EFFORT_LEVELS)],
      modelId,
    });
    assert.equal(getDesiredConfigOptions(record.acpx).effort, "low", modelId);
    assert.deepEqual(
      client.calls,
      [{ sessionId: "s1", configId: "effort", value: "low" }],
      modelId,
    );
  }
});

test("persistAndApplyRequestedEffort: maps Haiku 4.5 effort to default without sending rejected set", async () => {
  const client = mockClient();
  const record = recordWithDesired();
  await persistAndApplyRequestedEffort({
    client,
    sessionId: "s1",
    record,
    reasoningEffort: "low",
    advertised: [effortOption("high", OPUS_EFFORT_LEVELS)],
    modelId: "claude-haiku-4-5",
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, "high");
  assert.equal(client.calls.length, 0);
});

test("persistAndApplyRequestedEffort: never writes effort when the agent has no effort option", async () => {
  const client = mockClient();
  const record = recordWithDesired();
  await persistAndApplyRequestedEffort({
    client,
    sessionId: "s1",
    record,
    reasoningEffort: "low",
    advertised: [], // codex advertises no effort option
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, undefined);
  assert.equal(record.acpx?.desired_config_options, undefined);
  assert.equal(client.calls.length, 0);
});

// brick 94d01658 — only the agent refusing the LEVEL may fall back. The shapes below are what
// claude-agent-acp 842fb79 returns, measured on devbox 2026-11-23: the durable-fork failure and a
// level rejection share code -32603 and differ only in text.
const FORK_RESUME_FAILURE = {
  code: -32603,
  message:
    "Internal error: Failed to resume forked session s1 for config op: Claude Code returned an error result: No message found with message.uuid of: 64fb00ed-3af5-4e75-94a4-6304d38d77b1",
};
const LEVEL_REJECTION = {
  code: -32603,
  message: "Internal error",
  data: { details: "Invalid value for config option effort: max" },
};

function rejectingWith(payload: unknown): ReturnType<typeof mockClient> {
  const client = mockClient();
  client.setSessionConfigOption = (sessionId, configId, value) => {
    client.calls.push({ sessionId, configId, value });
    return Promise.reject(payload);
  };
  return client;
}

function recordWithEffort(effort: string): SessionRecord {
  return {
    acpx: { desired_config_options: { effort }, session_options: { effort } },
  } as unknown as SessionRecord;
}

test("persistAndApplyRequestedEffort: a non-rejection error surfaces and leaves the record's effort unchanged", async () => {
  // On the unfixed build every one of these RESOLVED and rewrote the record to the advertised
  // "default" — the call must reject AND the record must still read "high".
  const failures: Array<[string, unknown]> = [
    ["fork resume failure", FORK_RESUME_FAILURE],
    ["session not found", { code: -32002, message: "Resource not found: s1" }],
    // claude-agent-acp 842fb79, probed: a config op on an id it does not hold.
    [
      "adapter Session not found (-32603)",
      { code: -32603, message: "Internal error", data: { details: "Session not found" } },
    ],
    // A -32602 that names a missing session is not a refusal of the value.
    [
      "invalid params naming an unknown session",
      maybeWrapSessionControlError(
        "session/set_config_option",
        { code: -32602, message: "Unknown sessionId: s1" },
        'for "effort"="max"',
      ),
    ],
    ["transport/timeout", new Error("Timed out after 5000ms")],
  ];
  for (const [label, failure] of failures) {
    const record = recordWithEffort("high");
    const client = rejectingWith(failure);
    await assert.rejects(
      persistAndApplyRequestedEffort({
        client,
        sessionId: "s1",
        record,
        reasoningEffort: "max",
        advertised: [effortOption("default", OPUS_EFFORT_LEVELS)],
      }),
      label,
    );
    assert.equal(getDesiredConfigOptions(record.acpx).effort, "high", label);
    assert.equal(record.acpx?.session_options?.effort, "high", label);
    assert.deepEqual(client.calls, [{ sessionId: "s1", configId: "effort", value: "max" }], label);
  }
});

test("persistAndApplyRequestedEffort: the adapter's own level rejection still falls back to the advertised value", async () => {
  const record = recordWithDesired();
  await persistAndApplyRequestedEffort({
    client: rejectingWith(LEVEL_REJECTION),
    sessionId: "s1",
    record,
    reasoningEffort: "max",
    advertised: [effortOption("high", OPUS_EFFORT_LEVELS)],
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, "high");
});

test("persistAndApplyRequestedEffort: every refusal shape the real adapter returns falls back", async () => {
  // Captured from claude-agent-acp 842fb79 at zero turns (brick 94d01658 IMPL §9), each as it reaches
  // this catch — i.e. after acpx's own `maybeWrapSessionControlError`.
  const wrap = (payload: unknown) =>
    maybeWrapSessionControlError("session/set_config_option", payload, 'for "effort"="max"');
  const refusals: Array<[string, unknown]> = [
    [
      "level outside the ladder (-32603 details)",
      wrap({
        code: -32603,
        message: "Internal error",
        data: { details: "Invalid value for config option effort: ultra" },
      }),
    ],
    [
      "schema rejection (-32602 Invalid params)",
      wrap({
        code: -32602,
        message: "Invalid params",
        data: { value: { _errors: ["Invalid input: expected string, received number"] } },
      }),
    ],
    ["older adapter: no effort option", new Error("Unknown config option: effort")],
  ];
  for (const [label, refusal] of refusals) {
    const record = recordWithDesired();
    await persistAndApplyRequestedEffort({
      client: rejectingWith(refusal),
      sessionId: "s1",
      record,
      reasoningEffort: "max",
      advertised: [effortOption("high", OPUS_EFFORT_LEVELS)],
    });
    assert.equal(getDesiredConfigOptions(record.acpx).effort, "high", label);
  }
});

test("persistAndApplyRequestedEffort: deferApply persists the intent and sends nothing", async () => {
  const client = mockClient();
  const record = recordWithDesired();
  await persistAndApplyRequestedEffort({
    client,
    sessionId: "durable-unregistered",
    record,
    reasoningEffort: "max",
    advertised: [effortOption("default", OPUS_EFFORT_LEVELS)],
    deferApply: true,
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, "max");
  assert.equal(record.acpx?.session_options?.effort, "max");
  assert.equal(client.calls.length, 0);
});

test("persistAndApplyRequestedEffort: deferApply records the level the copy's model will serve", async () => {
  const client = mockClient();
  const record = recordWithDesired();
  await persistAndApplyRequestedEffort({
    client,
    sessionId: "durable-unregistered",
    record,
    reasoningEffort: "max",
    // the fork-time advertisement is the broad one; the copy runs sonnet
    advertised: [effortOption("default", OPUS_EFFORT_LEVELS)],
    modelId: "sonnet",
    deferApply: true,
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, "high");
  assert.equal(record.acpx?.session_options?.effort, "high");
  assert.equal(client.calls.length, 0);
});

test("persistAndApplyRequestedEffort: no-op when no effort requested", async () => {
  const client = mockClient();
  const record = recordWithDesired();
  await persistAndApplyRequestedEffort({
    client,
    sessionId: "s1",
    record,
    reasoningEffort: undefined,
    advertised: [effortOption("high")],
  });
  assert.equal(getDesiredConfigOptions(record.acpx).effort, undefined);
  assert.equal(client.calls.length, 0);
});

test("applyExecReasoningEffort: applies live when advertised & differing", async () => {
  const client = mockClient();
  await applyExecReasoningEffort({
    client,
    sessionId: "s1",
    reasoningEffort: "low",
    advertised: [effortOption("high")],
  });
  assert.deepEqual(client.calls, [{ sessionId: "s1", configId: "effort", value: "low" }]);
});

test("applyExecReasoningEffort: maps unsupported known efforts before applying", async () => {
  const client = mockClient();
  await applyExecReasoningEffort({
    client,
    sessionId: "s1",
    reasoningEffort: "xhigh",
    advertised: [effortOption("medium", SONNET_EFFORT_LEVELS)],
  });
  assert.deepEqual(client.calls, [{ sessionId: "s1", configId: "effort", value: "high" }]);
});

test("applyExecReasoningEffort: no-op for codex (no effort advertised) and when unset", async () => {
  const codex = mockClient();
  await applyExecReasoningEffort({
    client: codex,
    sessionId: "s1",
    reasoningEffort: "low",
    advertised: [],
  });
  assert.equal(codex.calls.length, 0);

  const unset = mockClient();
  await applyExecReasoningEffort({
    client: unset,
    sessionId: "s1",
    reasoningEffort: undefined,
    advertised: [effortOption("high")],
  });
  assert.equal(unset.calls.length, 0);
});

// de290ae4 defense-in-depth: a malformed/older adapter can advertise a
// `type:"select"` option with `options` absent. selectableValues() iterates that
// list with `for…of`; over undefined it would throw the raw "… is not iterable"
// TypeError (the exact symptom class from the codex version-skew crash). The
// `?? []` guard turns that into "no selectable values", not a crash.
test("selectableValues tolerates a select option with options undefined (no raw TypeError)", () => {
  const malformed = {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    // options intentionally absent (malformed adapter shape)
  } as unknown as SessionConfigOption;

  assert.doesNotThrow(() => normalizeEffortLevelForAdvertisedOption("high", malformed));
  // With no selectable values and no model context it resolves to "no mapping".
  assert.equal(normalizeEffortLevelForAdvertisedOption("high", malformed), undefined);
});

// A select option whose GROUPED entries carry no nested `options` list must also
// not raw-crash (the inner `for…of` is guarded the same way).
test("selectableValues tolerates a grouped select entry with nested options undefined", () => {
  const grouped = {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [{ name: "group-with-no-options" }],
  } as unknown as SessionConfigOption;

  assert.doesNotThrow(() => normalizeEffortLevelForAdvertisedOption("high", grouped));
});
