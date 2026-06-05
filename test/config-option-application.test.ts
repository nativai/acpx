import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  advertisesConfigOption,
  applyExecReasoningEffort,
  applyRequestedConfigOptionsIfAdvertised,
  persistAndApplyRequestedEffort,
} from "../src/session/config-option-application.js";
import { getDesiredConfigOptions } from "../src/session/mode-preference.js";
import type { SessionRecord } from "../src/types.js";

const OPUS_EFFORT_LEVELS = ["default", "low", "medium", "high", "xhigh", "max"];

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

test("applyRequestedConfigOptionsIfAdvertised: no set when the level is unsupported", async () => {
  const client = mockClient();
  await applyRequestedConfigOptionsIfAdvertised({
    client,
    sessionId: "s1",
    record: recordWithDesired({ effort: "ultra" }),
    advertised: [effortOption("high", ["default", "low", "high"])],
  });
  assert.equal(client.calls.length, 0);
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
