import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
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

function mockClient(responseOptions?: SessionConfigOption[]): {
  calls: Call[];
  setSessionConfigOption: (
    sessionId: string,
    configId: string,
    value: string,
  ) => Promise<{ configOptions?: SessionConfigOption[] }>;
} {
  const calls: Call[] = [];
  return {
    calls,
    setSessionConfigOption(sessionId, configId, value) {
      calls.push({ sessionId, configId, value });
      return Promise.resolve({ configOptions: responseOptions });
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
  assert.equal(normalizeEffortLevelForAdvertisedOption("max", staleOption, "haiku"), "high");
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
  assert.equal(normalizeEffortLevelForModel("future-ultra", "haiku"), "high");
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
