import assert from "node:assert/strict";
import test from "node:test";
import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import { AGENT_REGISTRY } from "../src/agent-registry.js";
import { persistAndApplyRequestedEffort } from "../src/session/config-option-application.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord } from "./runtime-test-helpers.js";

// B3 deliverable 2 — `persistAndApplyRequestedEffort` dispatches on the harness's
// DEPTH MECHANISM, and the outcome is recorded on every arm.
//
// THE INVARIANT UNDER TEST: a depth request is never silently dropped. Before B3
// this function returned with no error and no persist when `effort` was not
// advertised, so a request that never reached the harness was indistinguishable
// in the record from one that did.

function client(): {
  configCalls: Array<{ configId: string; value: string }>;
  modeCalls: string[];
  setSessionConfigOption: (
    s: string,
    configId: string,
    value: string,
  ) => Promise<{ configOptions?: SessionConfigOption[] }>;
  setSessionMode: (s: string, modeId: string) => Promise<void>;
} {
  const configCalls: Array<{ configId: string; value: string }> = [];
  const modeCalls: string[] = [];
  return {
    configCalls,
    modeCalls,
    setSessionConfigOption(_s, configId, value) {
      configCalls.push({ configId, value });
      return Promise.resolve({});
    },
    setSessionMode(_s, modeId) {
      modeCalls.push(modeId);
      return Promise.resolve();
    },
  };
}

function recordFor(agentCommand: string): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: "rec-dispatch",
    acpSessionId: "rec-dispatch-acp",
    agentCommand,
    cwd: "/workspace/projects/temp",
  });
}

function effortOption(values: string[]): SessionConfigOption {
  return {
    id: "effort",
    name: "effort",
    type: "select",
    currentValue: "zzz",
    options: values.map((value) => ({ value, name: value })),
  } as unknown as SessionConfigOption;
}

const PI_MODES = {
  currentModeId: "medium",
  availableModes: ["off", "minimal", "low", "medium", "high", "xhigh"].map((id) => ({
    id,
    name: id,
  })),
} as unknown as SessionModeState;

test("pi takes the MODE arm — set_mode, never set_config_option", async () => {
  const c = client();
  const record = recordFor(AGENT_REGISTRY.pi);
  await persistAndApplyRequestedEffort({
    client: c,
    sessionId: "ses_pi",
    record,
    reasoningEffort: "high",
    advertised: undefined, // I2 R8/R11 — pi advertises configOptions: null
    modes: PI_MODES,
    agentCommand: AGENT_REGISTRY.pi,
  });
  assert.deepEqual(c.modeCalls, ["high"]);
  assert.deepEqual(c.configCalls, [], "the mode arm must not touch the config-option wire");
  assert.equal(record.acpx?.depth_projection?.outcome, "exact");
});

test("BEFORE B3 THIS WAS THE SILENT DROP: pi with configOptions null did nothing", async () => {
  // The pre-B3 gate was `advertisesConfigOption(advertised, "effort")`, which is
  // false for pi forever. This row is the regression pin: if the mode arm is ever
  // removed, the wire goes silent again AND the record says nothing.
  const c = client();
  const record = recordFor(AGENT_REGISTRY.pi);
  await persistAndApplyRequestedEffort({
    client: c,
    sessionId: "ses_pi",
    record,
    reasoningEffort: "xhigh",
    advertised: undefined,
    modes: PI_MODES,
    agentCommand: AGENT_REGISTRY.pi,
  });
  assert.equal(c.modeCalls.length, 1, "the request must REACH pi");
  assert.ok(record.acpx?.depth_projection, "and the outcome must be recorded");
});

test("an unavailable depth request is RECORDED, not silently dropped", async () => {
  // opencode whose current model does not reason: no `effort` advertised. The
  // early return is still correct — there is nothing to send — but it must no
  // longer be SILENT.
  const c = client();
  const record = recordFor(AGENT_REGISTRY.opencode);
  await persistAndApplyRequestedEffort({
    client: c,
    sessionId: "ses_oc",
    record,
    reasoningEffort: "high",
    advertised: [], // the non-reasoning default model advertises no effort
    agentCommand: AGENT_REGISTRY.opencode,
  });
  assert.deepEqual(c.configCalls, [], "nothing can be sent — there is no option");
  assert.equal(
    record.acpx?.depth_projection?.outcome,
    "unavailable",
    "THE SILENT DROP: the request vanished with no record of it",
  );
  assert.equal(record.acpx?.depth_projection?.requested, "high");
  assert.ok(record.acpx?.depth_projection?.reason, "an unavailable outcome must say why");
});

test("opencode WITH an advertised effort takes the config-option arm and applies", async () => {
  // The positive control for the row above: the same harness, the same call, one
  // difference — the option is advertised. Without this, "recorded unavailable"
  // could be what happens on every opencode session.
  const c = client();
  const record = recordFor(AGENT_REGISTRY.opencode);
  await persistAndApplyRequestedEffort({
    client: c,
    sessionId: "ses_oc",
    record,
    reasoningEffort: "high",
    advertised: [effortOption(["low", "high", "max"])],
    agentCommand: AGENT_REGISTRY.opencode,
  });
  assert.deepEqual(c.configCalls, [{ configId: "effort", value: "high" }]);
  assert.deepEqual(c.modeCalls, [], "the config-option arm must not touch the mode wire");
});

test("GUARDRAIL: claude and claude-pty take the UNCHANGED generic path", async () => {
  for (const id of ["claude", "claude-pty"] as const) {
    const c = client();
    const record = recordFor(AGENT_REGISTRY[id]);
    await persistAndApplyRequestedEffort({
      client: c,
      sessionId: "ses_c",
      record,
      reasoningEffort: "high",
      advertised: [effortOption(["low", "medium", "high", "xhigh", "max"])],
      agentCommand: AGENT_REGISTRY[id],
    });
    // Same wire as before B3: one set_config_option, no mode call.
    assert.deepEqual(c.configCalls, [{ configId: "effort", value: "high" }], id);
    assert.deepEqual(c.modeCalls, [], id);
    // And no depth_projection breadcrumb — the Claude family's `served` block
    // belongs to the transcript producer.
    assert.equal(record.acpx?.depth_projection, undefined, `${id}: record was touched`);
    assert.equal(record.acpx?.served, undefined, `${id}: served was touched`);
    // The durable intent is still persisted exactly as before.
    assert.equal(record.acpx?.desired_config_options?.effort, "high", id);
  }
});

test("GUARDRAIL: codex depth is a no-op and acpx adds no bracket parsing", async () => {
  // Codex depth is fused into the model id and acpx treats the id as opaque.
  // The depth CONTROL cannot move it, so nothing may go on either wire.
  const c = client();
  const record = recordFor(AGENT_REGISTRY.codex);
  await persistAndApplyRequestedEffort({
    client: c,
    sessionId: "ses_cx",
    record,
    reasoningEffort: "high",
    advertised: [], // MAP §3.1 — codex advertises no `effort` option at all
    agentCommand: AGENT_REGISTRY.codex,
  });
  assert.deepEqual(c.configCalls, []);
  assert.deepEqual(c.modeCalls, []);
  // It IS recorded as unavailable rather than silently dropped — codex is not
  // Claude-family, so the breadcrumb applies and the user can see why.
  assert.equal(record.acpx?.depth_projection?.outcome, "unavailable");
});

test("no depth requested -> nothing happens anywhere, on every harness", async () => {
  for (const id of ["claude", "claude-pty", "codex", "opencode", "pi"] as const) {
    const c = client();
    const record = recordFor(AGENT_REGISTRY[id]);
    const before = JSON.stringify(record);
    await persistAndApplyRequestedEffort({
      client: c,
      sessionId: "ses",
      record,
      reasoningEffort: undefined,
      advertised: [effortOption(["low", "high"])],
      modes: PI_MODES,
      agentCommand: AGENT_REGISTRY[id],
    });
    assert.deepEqual(c.configCalls, [], id);
    assert.deepEqual(c.modeCalls, [], id);
    assert.equal(JSON.stringify(record), before, `${id}: record changed with no request`);
  }
});
