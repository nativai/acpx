import assert from "node:assert/strict";
import test from "node:test";
import { ModelFloorUnmetError } from "../src/errors.js";
import { sessionHasRealAgentTurn } from "../src/runtime/engine/lifecycle.js";
import { enforceModelFloorPostServe } from "../src/session/model-floor-enforce.js";
import type { SessionRecord } from "../src/types.js";
import { makeSessionRecord, withTempHome, writeSessionRecordFile } from "./runtime-test-helpers.js";

// The post-serve floor check is the SINGLE shared code path (brick://07dd62c9 §5b).
// Non-hard warns+ACCEPTS; --floor-hard refuses (accept:false → the caller throws,
// quarantining the served-down content). The desired pin is NEVER mutated.

function pinnedRecord(overrides: {
  floorHard?: boolean;
  acpxRecordId?: string;
  belowFloorOpen?: boolean;
}): SessionRecord {
  return makeSessionRecord({
    acpxRecordId: overrides.acpxRecordId ?? "floor-rec",
    acpSessionId: "floor-sid",
    agentCommand: "node /opt/claude-agent-acp/dist/index.js",
    cwd: "/workspace",
    acpx: {
      session_options: {
        model: "fable",
        effort: "max",
        ...(overrides.floorHard ? { floor_hard: true } : {}),
      },
      desired_config_options: { effort: "max" },
      ...(overrides.belowFloorOpen
        ? { served_below_floor: { pinned_model: "fable", at: "2026-01-01T00:00:00.000Z" } }
        : {}),
    },
  });
}

test("no pinned model → accept (nothing to enforce)", async () => {
  await withTempHome("acpx-enf-", async (home) => {
    const record = makeSessionRecord({
      acpxRecordId: "no-pin",
      acpSessionId: "s",
      agentCommand: "node /opt/claude-agent-acp/dist/index.js",
      cwd: "/workspace",
      acpx: { desired_config_options: { effort: "max" } },
    });
    await writeSessionRecordFile(home, record);
    const verdict = await enforceModelFloorPostServe(record, { servedModel: "claude-sonnet-4-6" });
    assert.equal(verdict.accept, true);
  });
});

test("at-floor serve → accept and AUTO-RECOVER (clears an open below-floor episode)", async () => {
  await withTempHome("acpx-enf-", async (home) => {
    const record = pinnedRecord({ belowFloorOpen: true });
    await writeSessionRecordFile(home, record);
    const verdict = await enforceModelFloorPostServe(record, { servedModel: "claude-fable-5" });
    assert.equal(verdict.accept, true);
    assert.ok(verdict.accept && verdict.recovered);
    assert.equal(record.acpx?.served_below_floor, undefined);
  });
});

test("below-floor, DEFAULT mode → ACCEPT + breadcrumb + session-visible warning; pin unchanged", async () => {
  await withTempHome("acpx-enf-", async (home) => {
    const record = pinnedRecord({});
    await writeSessionRecordFile(home, record);
    const before = record.messages.length;
    const verdict = await enforceModelFloorPostServe(record, { servedModel: "claude-sonnet-4-6" });
    assert.equal(verdict.accept, true); // visibility only — work is accepted
    assert.equal(record.acpx?.served_below_floor?.served_model, "claude-sonnet-4-6");
    // A session/parent-visible warning was mirrored into the conversation.
    assert.equal(record.messages.length, before + 1);
    const warn = record.messages.at(-1);
    // brick://c327efb5 reworded this: acpx has no capability rank, so "below" was
    // an unsupportable claim (a turn served MORE expensive than the pin was filed
    // as below-floor). The record KEY `served_below_floor` keeps its name.
    assert.ok(JSON.stringify(warn).includes("does not match the pinned floor"));
    // The warning is a synthetic breadcrumb, not a real model turn — it must not
    // block the resume→session/new fallback gate (brick://de3645c6 / brick://509b4ee1).
    assert.ok(typeof warn === "object" && warn !== null && "Agent" in warn);
    assert.equal(warn.Agent.synthetic, true);
    assert.equal(sessionHasRealAgentTurn(record), false);
    // Desired pin is NEVER mutated.
    assert.equal(record.acpx?.session_options?.model, "fable");
    assert.equal(record.acpx?.session_options?.effort, "max");
  });
});

test("below-floor, DEFAULT mode: warning is DEBOUNCED to once per episode", async () => {
  await withTempHome("acpx-enf-", async (home) => {
    const record = pinnedRecord({});
    await writeSessionRecordFile(home, record);
    await enforceModelFloorPostServe(record, { servedModel: "claude-sonnet-4-6" });
    const afterFirst = record.messages.length;
    // Second consecutive below-floor turn in the same episode → no new warning.
    await enforceModelFloorPostServe(record, { servedModel: "claude-sonnet-4-6" });
    assert.equal(record.messages.length, afterFirst);
  });
});

test("below-floor, --floor-hard → NOT accepted: loud ModelFloorUnmetError, quarantine, park, pin unchanged", async () => {
  await withTempHome("acpx-enf-", async (home) => {
    const record = pinnedRecord({ floorHard: true });
    await writeSessionRecordFile(home, record);
    const before = record.messages.length;
    const verdict = await enforceModelFloorPostServe(record, { servedModel: "claude-sonnet-4-6" });
    assert.equal(verdict.accept, false);
    assert.ok(!verdict.accept && verdict.error instanceof ModelFloorUnmetError);
    assert.equal(!verdict.accept && verdict.error.detailCode, "model-floor-unmet");
    // Breadcrumb + park stamped.
    assert.equal(record.acpx?.served_below_floor?.served_model, "claude-sonnet-4-6");
    assert.equal(record.acpx?.floor_parked?.reason, "model-floor-unmet");
    // Terminal mirrored to messages (agent + parent visible).
    assert.equal(record.messages.length, before + 1);
    assert.ok(JSON.stringify(record.messages.at(-1)).includes("Model floor not met"));
    // The desired pin is UNCHANGED on the record object.
    assert.equal(record.acpx?.session_options?.model, "fable");
    assert.equal(record.acpx?.session_options?.effort, "max");
  });
});

test("--floor-hard at-floor serve → accept and clear the park (auto-recover)", async () => {
  await withTempHome("acpx-enf-", async (home) => {
    const record = pinnedRecord({ floorHard: true });
    record.acpx!.floor_parked = { at: "2026-01-01T00:00:00.000Z", reason: "model-floor-unmet" };
    record.acpx!.served_below_floor = { pinned_model: "fable", at: "2026-01-01T00:00:00.000Z" };
    await writeSessionRecordFile(home, record);
    const verdict = await enforceModelFloorPostServe(record, { servedModel: "claude-fable-5" });
    assert.equal(verdict.accept, true);
    assert.equal(record.acpx?.floor_parked, undefined);
    assert.equal(record.acpx?.served_below_floor, undefined);
  });
});

test("unreadable served model → accept (do not fail a legitimate turn on a transient read miss)", async () => {
  await withTempHome("acpx-enf-", async (home) => {
    const record = pinnedRecord({ floorHard: true });
    await writeSessionRecordFile(home, record);
    const verdict = await enforceModelFloorPostServe(record, { servedModel: undefined });
    assert.equal(verdict.accept, true);
    assert.equal(record.acpx?.served_below_floor, undefined);
  });
});
